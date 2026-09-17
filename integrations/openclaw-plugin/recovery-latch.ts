/**
 * Phase 8 long-lived hard-recovery latch (Finding B, BB-3).
 *
 * The adapter's per-process `barrierPersistenceFailed` flag dies with the
 * short-lived adapter subprocess. The trusted OpenClaw plugin instance is the
 * only lifetime that spans adapter calls, so it owns a per-principal latch here.
 *
 * This module is deliberately pure (no OpenClaw SDK import) so it is
 * unit-testable offline. There is NO model-callable clear: once latched it
 * survives until the OpenClaw process/session restarts or an operator
 * intervenes.
 */

export interface LatchPrincipal {
  channel: string;
  accountId: string;
  senderId: string;
}

/** Stable per-principal latch key (channel + account + sender). */
export function recoveryPrincipalKey(principal: LatchPrincipal): string {
  return [principal.channel, principal.accountId, principal.senderId].join('\u0000');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * True when a trusted adapter `submit_status` envelope reports that the durable
 * recovery barrier itself could not be persisted (`{ hardRecoveryError: true,
 * persisted: false }`). This is never proof that no submit occurred.
 */
export function envelopeIndicatesHardRecovery(envelope: unknown): boolean {
  if (!isRecord(envelope)) return false;
  if (envelope['category'] !== 'error') return false;
  const data = envelope['data'];
  if (!isRecord(data)) return false;
  return data['hardRecoveryError'] === true && data['persisted'] === false;
}

export interface HardRecoveryBlock {
  blocked: true;
  category: 'unknown_barrier';
  status: 'blocked';
  reason: 'hard_recovery';
  message: string;
}

export const HARD_RECOVERY_MESSAGE =
  'A previous submission could not persist its durable recovery barrier. Operator intervention is required before any new Form Agent operation.';

/**
 * Model-facing/submit operations that must be fenced while the session latch is
 * set. Purely observational reads (analyze/draft/check/metrics) are not fenced;
 * the internal `submit_status` read is never fenced so operator recovery can
 * still inspect state.
 */
export const HARD_RECOVERY_FENCED_OPERATIONS: ReadonlySet<string> = new Set([
  'preflight',
  'cancel_pending',
  'submit_pending',
]);

/**
 * Per-principal latch owned by one long-lived plugin/Gateway instance.
 *
 * `recordFromSubmitStatus` is the ONLY mutator. It never accepts a clear flag
 * or model input, and there is intentionally no public `clear()`.
 */
export class HardRecoveryLatch {
  private readonly latched = new Map<string, number>();

  /** Record a hard recovery from a trusted `submit_status` envelope. */
  recordFromSubmitStatus(principal: LatchPrincipal, envelope: unknown): boolean {
    if (!envelopeIndicatesHardRecovery(envelope)) return false;
    const key = recoveryPrincipalKey(principal);
    if (!this.latched.has(key)) this.latched.set(key, Date.now());
    return true;
  }

  isLatched(principal: LatchPrincipal): boolean {
    return this.latched.has(recoveryPrincipalKey(principal));
  }

  latchedAt(principal: LatchPrincipal): number | undefined {
    return this.latched.get(recoveryPrincipalKey(principal));
  }
}

/** Fail-closed guard result, or null when the operation may proceed. */
export function hardRecoveryBlock(latch: HardRecoveryLatch, principal: LatchPrincipal): HardRecoveryBlock | null {
  if (!latch.isLatched(principal)) return null;
  return {
    blocked: true,
    category: 'unknown_barrier',
    status: 'blocked',
    reason: 'hard_recovery',
    message: HARD_RECOVERY_MESSAGE,
  };
}

/**
 * Gate an adapter operation for a latched principal. Returns the fail-closed
 * result for a fenced operation; null otherwise.
 */
export function guardAdapterOperation(
  latch: HardRecoveryLatch,
  principal: LatchPrincipal,
  operation: string,
): HardRecoveryBlock | null {
  if (!HARD_RECOVERY_FENCED_OPERATIONS.has(operation)) return null;
  return hardRecoveryBlock(latch, principal);
}
