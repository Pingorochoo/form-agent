/**
 * Configuration file discovery, parsing and env merging.
 *
 * Supported formats: JSON, YAML, TypeScript (default-exported or CJS-style
 * module). Looked up in order:
 *   1. --config <path> (explicit)
 *   2. ./config/form-agent.{json,yaml,yml,ts}
 *   3. ./form-agent.config.{json,yaml,yml,ts}
 *
 * Precedence: env > file > defaults.
 *
 * TRUST: JSON and YAML are data-only (parsed then Zod-validated) and remain the
 * preferred formats. A `.ts` config is TRUSTED EXECUTABLE CODE: it is loaded via
 * dynamic `import()`, so it runs with this process's privileges (filesystem,
 * network, credentials, child processes). The loader does not sandbox it. Only
 * point `--config` at `.ts` files you control and have reviewed; never at a file
 * downloaded from an untrusted source.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute, basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { parseEnv } from './env.ts';
import {
  parseConfig,
  type AppConfig,
} from './schema.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const SEARCH_FILE_NAMES = [
  'config/form-agent.json',
  'config/form-agent.yaml',
  'config/form-agent.yml',
  'config/form-agent.ts',
  'form-agent.config.json',
  'form-agent.config.yaml',
  'form-agent.config.yml',
  'form-agent.config.ts',
];

export interface LoadedConfig {
  config: AppConfig;
  /** Absolute path of the config file that was read, or null if none. */
  source: string | null;
  warnings: string[];
}

export function discoverConfigFile(cwd: string, explicitPath?: string): string | null {
  if (explicitPath !== undefined) {
    const full = isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath);
    if (!existsSync(full)) {
      throw new ConfigError(`Config file not found: ${full}`);
    }
    return full;
  }
  for (const name of SEARCH_FILE_NAMES) {
    const full = resolve(cwd, name);
    if (existsSync(full)) return full;
  }
  return null;
}

export async function readConfigFile(path: string): Promise<unknown> {
  const ext = extname(path).toLowerCase();
  const content = readFileSync(path, 'utf8');

  if (ext === '.json') {
    try {
      return JSON.parse(content);
    } catch (err) {
      throw new ConfigError(`Config file ${basename(path)} is not valid JSON: ${errorMessage(err)}`);
    }
  }
  if (ext === '.yaml' || ext === '.yml') {
    try {
      return parseYaml(content);
    } catch (err) {
      throw new ConfigError(`Config file ${basename(path)} is not valid YAML: ${errorMessage(err)}`);
    }
  }
  if (ext === '.ts') {
    try {
      const mod = await import(pathToFileURL(path).href);
      return mod.default ?? mod;
    } catch (err) {
      throw new ConfigError(`Config file ${basename(path)} failed to load: ${errorMessage(err)}`);
    }
  }
  throw new ConfigError(`Unsupported config file extension: ${ext} (expected .json, .yaml, .yml, .ts)`);
}

/** Inject the offline-safe `fake` provider unless the user defined it. */
function ensureFakeProvider(config: AppConfig): AppConfig {
  const providers = config.llm.providers;
  if (providers['fake'] !== undefined) return config;
  return {
    ...config,
    llm: {
      ...config.llm,
      providers: { ...providers, fake: { type: 'fake', enabled: true, allowRemote: false } },
    },
  };
}

/** Apply env overrides (log level, default LLM provider, base URL). */
function mergeEnv(config: AppConfig, env: ReturnType<typeof parseEnv>['config'], warnings: string[]): AppConfig {
  let llm = config.llm;
  if (env.llmProvider !== undefined) {
    llm = { ...llm, defaultProvider: env.llmProvider };
  }
  if (env.llmBaseUrl !== undefined) {
    // Prefer setting baseUrl on the default provider if it exists and is typed
    // openai-compatible; otherwise it is surfaced as a warning (Phase 8 wiring).
    const existing = llm.providers[llm.defaultProvider];
    if (existing !== undefined && existing.type === 'openai-compatible') {
      llm = {
        ...llm,
        providers: { ...llm.providers, [llm.defaultProvider]: { ...existing, baseUrl: env.llmBaseUrl } },
      };
    } else {
      warnings.push(`FORM_AGENT_LLM_BASE_URL set but default provider "${llm.defaultProvider}" is not openai-compatible; ignored`);
    }
  }
  return {
    ...config,
    log: { ...config.log, level: env.logLevel ?? config.log.level },
    llm,
  };
}

export async function loadConfig(options: {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const envResult = parseEnv(options.env ?? process.env);
  const warnings = [...envResult.warnings];

  const path = discoverConfigFile(cwd, options.configPath);
  let fileData: unknown = {};
  let source: string | null = null;
  if (path !== null) {
    fileData = await readConfigFile(path);
    source = path;
  }

  let parsed: AppConfig;
  if (path === null) {
    parsed = parseConfig({});
  } else {
    parsed = parseConfig(fileData);
  }

  parsed = ensureFakeProvider(parsed);
  parsed = mergeEnv(parsed, envResult.config, warnings);

  if (parsed.llm.providers[parsed.llm.defaultProvider] === undefined) {
    throw new ConfigError(
      `defaultProvider "${parsed.llm.defaultProvider}" is not defined in llm.providers ` +
        `(available: ${Object.keys(parsed.llm.providers).join(', ') || '(none)'})`,
    );
  }

  return { config: parsed, source, warnings };
}

/**
 * Resolve an LLM provider configuration including its API key (read from the
 * environment). `defaultProvider` resolution happens against the given config.
 */
export function resolveProviderConfig(
  config: AppConfig,
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): { config: AppConfig['llm']['providers'][string]; apiKey: string | null } {
  const providers = config.llm.providers;
  const provider = providers[providerId];
  if (provider === undefined) {
    throw new ConfigError(`Unknown LLM provider "${providerId}" (available: ${Object.keys(providers).join(', ') || '(none)'})`);
  }
  if (!provider.enabled) {
    throw new ConfigError(`LLM provider "${providerId}" is disabled in configuration`);
  }
  if (provider.type === 'fake') {
    return { config: provider, apiKey: null };
  }
  if (provider.type === 'openai-compatible' && provider.baseUrl === undefined) {
    throw new ConfigError(
      `LLM provider "${providerId}" requires baseUrl (e.g. http://localhost:11434/v1 for Ollama)`,
    );
  }
  let apiKey: string | null = null;
  if (provider.apiKeyEnv !== undefined) {
    const key = env[provider.apiKeyEnv];
    if (key === undefined || key === '') {
      throw new ConfigError(`LLM provider "${providerId}" requires env var ${provider.apiKeyEnv}`);
    }
    apiKey = key;
  }
  return { config: provider, apiKey };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}