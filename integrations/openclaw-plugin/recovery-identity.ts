/**
 * Phase 8 recovery-identity guard (Finding F).
 *
 * `submit_status` recovery is bound to the approved submit's `pendingRef` +
 * `planId`. Before the plugin replays a recovered terminal handoff or acks it,
 * it must independently verify the recovered view (and any stored result it
 * carries) belongs to that exact identity. A mismatched record must never be
 * surfaced as the approved submit's success/block/already_claimed/usage result.
 *
 * Pure module (no OpenClaw SDK import) so it is unit-testable offline.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface ApprovedRecoveryIdentity {
  pendingRef: string;
  planId: string;
}

/** True when a recovered view is bound to the approved pendingRef + planId. */
export function recoveryViewMatchesApproved(view: unknown, expected: ApprovedRecoveryIdentity): boolean {
  if (!isRecord(view)) return false;
  if (view['pendingId'] !== expected.pendingRef) return false;
  if (view['planId'] !== expected.planId) return false;
  const result = view['result'];
  if (result !== undefined) {
    if (!isRecord(result)) return false;
    if (result['pendingId'] !== expected.pendingRef) return false;
    if (result['planId'] !== expected.planId) return false;
  }
  return true;
}

/**
 * True only when a recovered `completed_unambiguous` view is genuinely bound to
 * the approved identity and may therefore be replayed. Anything else (mismatch,
 * missing result binding, non-terminal state) must become `unknown_outcome`.
 */
export function shouldReplayRecoveredTerminal(view: unknown, expected: ApprovedRecoveryIdentity): boolean {
  if (!isRecord(view)) return false;
  if (view['state'] !== 'completed_unambiguous') return false;
  // A replayable handoff must actually carry a result bound to the identity.
  if (!isRecord(view['result'])) return false;
  return recoveryViewMatchesApproved(view, expected);
}
