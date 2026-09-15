/**
 * Stable, secret-safe LLM provider errors (P6-R10, docs/PHASE_6.md §19).
 *
 * Every real-provider failure is surfaced through a typed `LlmProviderError`
 * carrying a stable machine-readable `code`. Error prose never contains an API
 * key, Authorization header, raw prompt, raw response body, or raw exception
 * text that could embed request data. Safe detail (provider id, model label,
 * stage, HTTP status) is carried in structured fields, not raw body echoes.
 *
 * The frozen CLI exit-code contract (4 = LLM offline, 5 = LLM connectivity)
 * is preserved via `llmExitCode()`; no new process exit codes are introduced.
 */

import { ExitCodes } from '../cli/exit-codes.ts';

export const LLM_ERROR_CODES = {
  PROVIDER_CONFIG_INVALID: 'LLM_PROVIDER_CONFIG_INVALID',
  REMOTE_NOT_ALLOWED: 'LLM_REMOTE_NOT_ALLOWED',
  SECRET_MISSING: 'LLM_SECRET_MISSING',
  OFFLINE: 'LLM_OFFLINE',
  TIMEOUT: 'LLM_TIMEOUT',
  HTTP_ERROR: 'LLM_HTTP_ERROR',
  RATE_LIMITED: 'LLM_RATE_LIMITED',
  PROTOCOL_INVALID: 'LLM_PROTOCOL_INVALID',
  RESPONSE_TOO_LARGE: 'LLM_RESPONSE_TOO_LARGE',
  OUTPUT_INVALID: 'LLM_OUTPUT_INVALID',
} as const;

export type LlmErrorCode = (typeof LLM_ERROR_CODES)[keyof typeof LLM_ERROR_CODES];

export class LlmProviderError extends Error {
  readonly code: LlmErrorCode;
  /** Optional safe HTTP status code (never raw body text). */
  readonly status: number | null;

  constructor(code: LlmErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'LlmProviderError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Map a stable LLM error code onto the frozen exit-code contract (P6-R10):
 *   2 = usage/config (config invalid, remote consent, missing secret);
 *   3 = validation (malformed/invalid model output fails closed);
 *   4 = LLM offline (unreachable endpoint);
 *   5 = LLM connectivity (timeout/HTTP/protocol/oversized response).
 */
export function llmExitCode(code: LlmErrorCode): 1 | 2 | 3 | 4 | 5 {
  switch (code) {
    case LLM_ERROR_CODES.PROVIDER_CONFIG_INVALID:
    case LLM_ERROR_CODES.REMOTE_NOT_ALLOWED:
    case LLM_ERROR_CODES.SECRET_MISSING:
      return ExitCodes.USAGE;
    case LLM_ERROR_CODES.OUTPUT_INVALID:
      return ExitCodes.VALIDATION;
    case LLM_ERROR_CODES.OFFLINE:
      return ExitCodes.LLM_OFFLINE;
    case LLM_ERROR_CODES.TIMEOUT:
    case LLM_ERROR_CODES.HTTP_ERROR:
    case LLM_ERROR_CODES.RATE_LIMITED:
    case LLM_ERROR_CODES.PROTOCOL_INVALID:
    case LLM_ERROR_CODES.RESPONSE_TOO_LARGE:
      return ExitCodes.LLM_CONNECTIVITY;
    default:
      return ExitCodes.ERROR;
  }
}
