/**
 * User-configurable sensitivity rules (P2-R8).
 *
 * Loads rule files from `config/policies.d/` using the repository's existing
 * config conventions (data-only JSON and YAML; a `.ts` policy file would be
 * executable code and is intentionally unsupported for policy data). Files are
 * loaded in deterministic (sorted-filename) order; each file contributes an
 * ordered `rules` array. Invalid files fail clearly rather than being ignored.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  BUILTIN_SENSITIVE_RULES,
  isSensitivityCategory,
  isSensitiveMode,
  SensitiveRuleError,
  validateSensitiveRules,
  type SensitiveRule,
} from './sensitive.ts';

export class PolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyConfigError';
  }
}

export const POLICIES_DIR = 'config/policies.d';

export interface LoadedSensitiveRules {
  rules: SensitiveRule[];
  /** Absolute paths of policy files that were read, in load order. */
  sources: string[];
}

interface RawRule {
  id?: unknown;
  pattern?: unknown;
  category?: unknown;
  mode?: unknown;
}

interface RawPolicyFile {
  version?: unknown;
  rules?: unknown;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PolicyConfigError(`policy rule field "${field}" must be a non-empty string`);
  }
  return value;
}

function parseRule(raw: unknown, source: string): SensitiveRule {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PolicyConfigError(`policy file ${source}: each rule must be an object`);
  }
  const entry = raw as RawRule;
  const id = asString(entry.id, 'id');
  const pattern = asString(entry.pattern, 'pattern');
  const category = asString(entry.category, 'category');
  const mode = asString(entry.mode, 'mode');
  if (!isSensitivityCategory(category)) {
    throw new PolicyConfigError(
      `policy file ${source}: rule "${id}" has unknown category "${category}"`,
    );
  }
  if (!isSensitiveMode(mode)) {
    throw new PolicyConfigError(`policy file ${source}: rule "${id}" has unknown mode "${mode}"`);
  }
  return { id, pattern, category, mode };
}

/** Validate an already-parsed policy file object and convert it to rules. */
function parsePolicyData(data: unknown, source: string): SensitiveRule[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new PolicyConfigError(`policy file ${source}: expected an object with a "rules" array`);
  }
  const file = data as RawPolicyFile;
  if (!Array.isArray(file.rules)) {
    throw new PolicyConfigError(`policy file ${source}: "rules" must be an array`);
  }
  return file.rules.map((rule) => parseRule(rule, source));
}

/**
 * Read a policy file into parsed data: JSON is decoded with JSON.parse, YAML
 * with the YAML parser. Both paths feed the same `parsePolicyData` conversion.
 */
function readPolicyData(path: string): unknown {
  const ext = extname(path).toLowerCase();
  const content = readFileSync(path, 'utf8');
  if (ext === '.json') {
    return JSON.parse(content) as unknown;
  }
  if (ext === '.yaml' || ext === '.yml') {
    return parseYaml(content);
  }
  throw new PolicyConfigError(`unsupported policy file extension: ${ext} (expected .json, .yaml, .yml)`);
}

function readPolicyFile(path: string): SensitiveRule[] {
  let data: unknown;
  try {
    data = readPolicyData(path);
  } catch (err) {
    if (err instanceof PolicyConfigError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new PolicyConfigError(`policy file ${path} is invalid: ${detail}`);
  }
  return parsePolicyData(data, path);
}

/**
 * Load custom sensitivity rules from `config/policies.d/` under `cwd`
 * (or an explicit directory). Deterministic: files are read in sorted-filename
 * order and rules preserve their in-file order.
 */
export function loadSensitiveRules(options: { cwd?: string; policiesDir?: string } = {}): LoadedSensitiveRules {
  const base = options.cwd ?? process.cwd();
  const dir = options.policiesDir ?? resolve(base, POLICIES_DIR);
  if (!existsSync(dir)) {
    return { rules: [], sources: [] };
  }
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      const ext = extname(name).toLowerCase();
      return ext === '.json' || ext === '.yaml' || ext === '.yml';
    })
    .sort();

  const rules: SensitiveRule[] = [];
  const sources: string[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    const fileRules = readPolicyFile(path);
    try {
      validateSensitiveRules(fileRules);
    } catch (err) {
      if (err instanceof SensitiveRuleError) {
        throw new PolicyConfigError(`policy file ${path} is invalid: ${err.message}`);
      }
      throw err;
    }
    sources.push(path);
    rules.push(...fileRules);
  }
  return { rules, sources };
}

/** Resolve the full active rule set: built-in taxonomy + custom overrides. */
export function resolveSensitiveRules(custom: SensitiveRule[]): SensitiveRule[] {
  const merged = [...BUILTIN_SENSITIVE_RULES, ...custom];
  validateSensitiveRules(merged);
  return merged;
}
