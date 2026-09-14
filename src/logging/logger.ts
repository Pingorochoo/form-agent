/**
 * Sensitive-field-aware logger.
 *
 * All log messages pass through redaction before reaching stderr or a file.
 * Fields that are entirely user-supplied (form text, raw payloads) should be
 * passed to `sensitive()` rather than stringified ad-hoc, so policy-level
 * redaction (Phase 2) can re-map them without touching every call site.
 */

import type { AppConfig, LogLevel } from '../config/schema.ts';
import { redactObjectDeep, redactText, type RedactionOptions } from './redact.ts';

export const LOG_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

const LEVEL_WEIGHT: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

export interface LoggerOptions {
  level?: LogLevel;
  redaction?: RedactionOptions;
  sink?: (line: string) => void;
}

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  child(module: string): Logger;
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Redact-and-log a raw user-supplied or sensitive payload. */
  sensitive(message: string, data: unknown, fields?: LogFields): void;
}

export function createLogger(config: AppConfig, options: LoggerOptions = {}): Logger {
  const level = options.level ?? config.log.level;
  const redaction = options.redaction;
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));

  const redactValue = (value: unknown): unknown => {
    if (typeof value === 'string') return redactText(value, redaction).text;
    if (typeof value === 'object' && value !== null) return redactObjectDeep(value);
    return value;
  };

  const formatFields = (fields: LogFields | undefined): string => {
    if (fields === undefined) return '';
    const out: LogFields = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      out[key] = redactValue(value);
    }
    return Object.keys(out).length === 0 ? '' : ` ${JSON.stringify(out)}`;
  };

  const write = (levelName: LogLevel, message: string, fields: LogFields | undefined): void => {
    if (LEVEL_WEIGHT[levelName] < LEVEL_WEIGHT[level]) return;
    sink(`${new Date().toISOString()} ${levelName.toUpperCase()} ${message}${formatFields(fields)}`);
  };

  const makeChild = (module: string): Logger => {
    const prefix = module === '' ? '' : `[${module}] `;
    return {
      child: (sub: string) => makeChild(module === '' ? sub : `${module}.${sub}`),
      trace: (message, fields) => write('trace', `${prefix}${message}`, fields),
      debug: (message, fields) => write('debug', `${prefix}${message}`, fields),
      info: (message, fields) => write('info', `${prefix}${message}`, fields),
      warn: (message, fields) => write('warn', `${prefix}${message}`, fields),
      error: (message, fields) => write('error', `${prefix}${message}`, fields),
      sensitive: (message, data, fields) =>
        write('info', `${prefix}${message}`, { _raw: data, ...fields }),
    };
  };

  return makeChild('');
}

export function fromLevel(value: string): LogLevel | undefined {
  const normalized = value.toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(normalized)) return normalized as LogLevel;
  return undefined;
}