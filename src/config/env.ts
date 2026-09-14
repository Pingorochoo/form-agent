/**
 * Environment variable loading.
 *
 * Precedence: env > config file > defaults. Unknown FORM_AGENT_* variables are
 * reported as warnings (they may belong to a future phase), never hard errors.
 */

import { LOG_LEVELS, type LogLevel } from './schema.ts';

export const KNOWN_FORM_AGENT_ENV = new Set<string>([
  'FORM_AGENT_LLM_PROVIDER',
  'FORM_AGENT_LLM_BASE_URL',
]);

export const KNOWN_LLM_ENV = new Set<string>(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);

export interface EnvConfig {
  logLevel: LogLevel | undefined;
  llmProvider: string | undefined;
  llmBaseUrl: string | undefined;
  openaiApiKey: string | undefined;
  anthropicApiKey: string | undefined;
}

export interface EnvParseResult {
  config: EnvConfig;
  warnings: string[];
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export function parseEnv(env: NodeJS.ProcessEnv = process.env): EnvParseResult {
  const warnings: string[] = [];

  let logLevel: LogLevel | undefined;
  if (env.LOG_LEVEL !== undefined) {
    if (isLogLevel(env.LOG_LEVEL)) {
      logLevel = env.LOG_LEVEL;
    } else {
      warnings.push(`LOG_LEVEL=${env.LOG_LEVEL} ignored (expected one of: ${LOG_LEVELS.join(', ')})`);
    }
  }

  let llmBaseUrl: string | undefined;
  if (env.FORM_AGENT_LLM_BASE_URL !== undefined) {
    try {
      const parsed = new URL(env.FORM_AGENT_LLM_BASE_URL);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('unsupported protocol');
      }
      llmBaseUrl = parsed.href;
    } catch {
      warnings.push(`FORM_AGENT_LLM_BASE_URL ignored: not a valid http(s) URL: ${env.FORM_AGENT_LLM_BASE_URL}`);
    }
  }

  for (const key of Object.keys(env)) {
    if (key.startsWith('FORM_AGENT_') && !KNOWN_FORM_AGENT_ENV.has(key)) {
      warnings.push(`Unknown environment variable ${key} (may belong to a future phase; ignored)`);
    }
  }

  return {
    config: {
      logLevel,
      llmProvider: env.FORM_AGENT_LLM_PROVIDER,
      llmBaseUrl,
      openaiApiKey: env.OPENAI_API_KEY,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
    },
    warnings,
  };
}