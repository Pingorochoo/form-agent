/**
 * Best-effort execution helper for the Phase 7 observability boundary.
 *
 * Observability must never throw into authoritative business code: warning
 * emission, the null-recorder fallback, and the audit-only DB close are all
 * best-effort. `safeCall` swallows any synchronous failure and deliberately
 * never surfaces the raw exception text.
 */

export function safeCall(fn: (() => void) | undefined): void {
  if (fn === undefined) return;
  try {
    fn();
  } catch {
    // Best-effort only: never rethrow, never leak the raw exception.
  }
}
