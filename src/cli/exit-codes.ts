/**
 * Stable exit-code contract for the form-agent CLI.
 *
 * These codes are **the** interface between the CLI, CI, and OpenClaw/Telegram.
 * Phase 4 (consistency gate) decides which failures map to 3 (hard block)
 * vs warn-and-continue; this module deliberately does NOT encode that
 * distinction.
 *
 * CONTRACT: every code is a POSITIVE integer in the 0-127 range. Negative
 * process exit codes are forbidden — at the OS level a negative value is
 * truncated to an unsigned byte (e.g. -1 becomes 255), so `-1`/`-2` were
 * never portable. The LLM tiers therefore live at 4 and 5, filling the gap
 * between the validation tier (3) and the reserved unknown-command code (127)
 * while keeping their original meanings:
 *
 *   0   success
 *   1   unexpected error / unhandled failure
 *   2   user error: bad usage, bad config, invalid input
 *   3   validation / consistency failure
 *   4   LLM offline / configured model unavailable   (was -1)
 *   5   LLM connectivity check failed               (was -2)
 *   127 unknown command (POSIX shell convention)
 *
 * Codes 6-126 are reserved for future tiers.
 */

export const ExitCodes = {
  SUCCESS: 0,
  /** Unexpected error or unhandled failure (bug, I/O). */
  ERROR: 1,
  /** User error: bad usage, bad config, invalid input. */
  USAGE: 2,
  /** Validation/consistency failure (would-block or error). */
  VALIDATION: 3,
  /** LLM offline / configured model unavailable (formerly -1). */
  LLM_OFFLINE: 4,
  /** LLM connectivity check failed (formerly -2). */
  LLM_CONNECTIVITY: 5,
  /** Unknown command (POSIX shell convention). */
  UNKNOWN_COMMAND: 127,
} as const;

export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];

/**
 * POSIX process exit codes are unsigned bytes: 0-255 at the boundary, but we
 * keep our contract inside 0-127 so the value survives every shell, wrapper
 * and language runtime unchanged. Negative values are a contract violation.
 */
export const EXIT_CODE_MIN = 0;
export const EXIT_CODE_MAX = 127;

export function isValidExitCode(code: number): boolean {
  return Number.isInteger(code) && code >= EXIT_CODE_MIN && code <= EXIT_CODE_MAX;
}

export function describeExitCode(code: number): string {
  switch (code) {
    case ExitCodes.SUCCESS:
      return 'success';
    case ExitCodes.ERROR:
      return 'unexpected error';
    case ExitCodes.USAGE:
      return 'bad usage or configuration';
    case ExitCodes.VALIDATION:
      return 'validation/consistency failure';
    case ExitCodes.UNKNOWN_COMMAND:
      return 'unknown command';
    case ExitCodes.LLM_OFFLINE:
      return 'LLM offline / model unavailable';
    case ExitCodes.LLM_CONNECTIVITY:
      return 'LLM connectivity check failed';
    default:
      return `reserved code ${code}`;
  }
}