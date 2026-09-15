/**
 * Controlled Phase 5 execution errors.
 *
 * Every execution failure is surfaced through a typed error carrying a stable
 * machine-readable `code` (never a raw Playwright stack, page HTML, or secret).
 * The orchestrator/provider throw these; the CLI maps them onto the frozen
 * exit-code contract without leaking provider internals.
 */

export type ExecutionErrorCode = string;

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  /** Optional deterministic retry-after ms (rate blocks only). */
  readonly retryAfterMs: number | null;

  constructor(code: ExecutionErrorCode, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A pre-submit failure (maps to exit code 3 or 1, per the CLI contract). */
export class ExecutionPreSubmitError extends ExecutionError {
  constructor(code: ExecutionErrorCode, message: string, retryAfterMs: number | null = null) {
    super(code, message, retryAfterMs);
    this.name = 'ExecutionPreSubmitError';
  }
}

/** A usage/argument error detected before any browser/network activity. */
export class ExecutionUsageError extends ExecutionError {
  constructor(code: ExecutionErrorCode, message: string) {
    super(code, message);
    this.name = 'ExecutionUsageError';
  }
}

/**
 * True when a pre-submit failure is a validation/consistency/policy/fingerprint
 * block (exit code 3) rather than an execution/browser error (exit code 1).
 */
export function isBlockingPreSubmitError(error: unknown): error is ExecutionPreSubmitError {
  return error instanceof ExecutionPreSubmitError;
}

/**
 * Frozen Phase 5 exit-code mapping for execution errors (P5-R20):
 *   2 = usage/config (unsupported target);
 *   3 = policy/consistency/plan/fingerprint/claim validation block;
 *   1 = everything else (browser/execution error; unknown_outcome is a result).
 */
const EXECUTION_USAGE_CODES: ReadonlySet<string> = new Set(['EXECUTION_TARGET_UNSUPPORTED']);

const EXECUTION_BLOCK_CODES: ReadonlySet<string> = new Set([
  'EXECUTION_NOT_AUTHORIZED',
  'FORM_NOT_ACCEPTING_RESPONSES',
  'CONSISTENCY_BLOCKED',
  'EXECUTION_POLICY_BLOCKED',
  'EXECUTION_PLAN_MISMATCH',
  'FORM_CHANGED_BEFORE_SUBMIT',
  'SUBMISSION_ALREADY_CLAIMED',
  // Phase 6 snapshot blocks (missing/corrupt/mismatched/conflicting snapshot).
  'EXECUTION_PLAN_SNAPSHOT_NOT_FOUND',
  'EXECUTION_PLAN_SNAPSHOT_INVALID',
  'EXECUTION_PLAN_SNAPSHOT_MISMATCH',
  'EXECUTION_PLAN_SNAPSHOT_CONFLICT',
]);

export function executionExitCode(code: ExecutionErrorCode): 1 | 2 | 3 {
  if (EXECUTION_USAGE_CODES.has(code)) return 2;
  if (EXECUTION_BLOCK_CODES.has(code)) return 3;
  return 1;
}
