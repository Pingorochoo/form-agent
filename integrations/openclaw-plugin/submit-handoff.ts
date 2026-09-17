/**
 * Phase 8 trusted submit terminal-handoff decision (Finding N).
 *
 * Pure module (no OpenClaw SDK / adapter import) so the exact fail-closed
 * decision table is unit-testable offline.
 *
 * A favorable submit terminal result may only be surfaced when the TRUSTED
 * durable recovery state proves it for the approved `pendingRef` + `planId`.
 * A raw/malformed/adversarial adapter envelope can never become a terminal
 * result on its own.
 */

import {
  TERMINAL_SUBMIT_CONTRACT,
  terminalDataEquals,
  validateCompletedSubmitResult,
  validateTerminalData,
} from '../../src/openclaw/contracts.ts';

export interface ApprovedIdentity {
  pendingRef: string;
  planId: string;
  targetDisplay: string;
  operator: string;
}

export interface RecoveryViewLike {
  state?: unknown;
  pendingId?: unknown;
  attemptId?: unknown;
  planId?: unknown;
  reason?: unknown;
  result?: unknown;
}

export interface EnvelopeLike {
  category: string;
  status: string;
  formAgentExitCode: number | null;
  data: Record<string, unknown>;
}

export interface AckCallLike {
  ok: boolean;
  envelope?: { data?: Record<string, unknown> } | undefined;
}

export type SubmitDecision =
  | { surface: 'terminal'; category: string; status: string; attemptId: string; replayed: boolean }
  | { surface: 'start_failed' }
  | { surface: 'unknown_outcome'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknown(reason: string): SubmitDecision {
  return { surface: 'unknown_outcome', reason };
}

function identityMatches(recovery: RecoveryViewLike, identity: ApprovedIdentity): boolean {
  return recovery.pendingId === identity.pendingRef && recovery.planId === identity.planId;
}

function storedResultOf(recovery: RecoveryViewLike): Record<string, unknown> | null {
  return isRecord(recovery.result) ? recovery.result : null;
}

/**
 * The trusted completed handoff must bind to the approved identity AND to the
 * adapter envelope's category/status/exit code, with a consistent attemptId and
 * an EXACT closed terminal-data match (Finding Q).
 */
function completedHandoffMatches(
  recovery: RecoveryViewLike,
  identity: ApprovedIdentity,
  envelope: EnvelopeLike,
): string | null {
  if (recovery.state !== 'completed_unambiguous') return null;
  if (!identityMatches(recovery, identity)) return null;
  const result = storedResultOf(recovery);
  if (result === null) return null;
  if (result['category'] !== envelope.category) return null;
  if (result['status'] !== envelope.status) return null;
  if (result['formAgentExitCode'] !== envelope.formAgentExitCode) return null;
  const attemptId = typeof recovery.attemptId === 'string' ? recovery.attemptId : undefined;
  if (attemptId === undefined) return null;
  // ONE shared strict completed-result validator (storage + plugin).
  if (
    !validateCompletedSubmitResult(result, {
      pendingId: identity.pendingRef,
      planId: identity.planId,
      targetDisplay: identity.targetDisplay,
      operator: identity.operator,
      attemptId,
    })
  ) {
    return null;
  }
  if (!validateTerminalData(envelope.category, envelope.data)) return null;
  if (!terminalDataEquals(envelope.category, envelope.data, result['data'])) return null;
  return attemptId;
}

/**
 * Decide the outcome of a DIRECT `submit_pending` adapter envelope. Favorable
 * terminal categories require the trusted durable completed handoff.
 */
export function decideDirectSubmit(
  envelope: EnvelopeLike,
  recovery: RecoveryViewLike | undefined,
  identity: ApprovedIdentity,
): SubmitDecision {
  if (envelope.category === 'submit_start_failed') {
    if (
      recovery !== undefined &&
      recovery.state === 'start_failed' &&
      identityMatches(recovery, identity)
    ) {
      return { surface: 'start_failed' };
    }
    return unknown('start_failed_unproven');
  }

  const terminal = TERMINAL_SUBMIT_CONTRACT.get(envelope.category);
  if (terminal === undefined) {
    if (envelope.category === 'unknown_outcome') return unknown('form_agent_unknown_outcome');
    // Any other category (error/no_pending/...) is not a proven terminal result.
    return unknown('unproven_direct_submit_result');
  }

  if (recovery === undefined) return unknown('no_durable_handoff');
  const attemptId = completedHandoffMatches(recovery, identity, envelope);
  if (attemptId === null) return unknown('durable_handoff_mismatch');
  return { surface: 'terminal', category: envelope.category, status: envelope.status, attemptId, replayed: false };
}

/**
 * Recovered-handoff path: the primary adapter call was missing/malformed/
 * crashed. Replay ONLY the trusted stored completed handoff (or start_failed).
 */
export function decideRecoveredHandoff(
  recovery: RecoveryViewLike | undefined,
  identity: ApprovedIdentity,
): SubmitDecision {
  if (recovery === undefined) return unknown('no_recovery_state');

  if (recovery.state === 'completed_unambiguous') {
    if (!identityMatches(recovery, identity)) return unknown('recovery_identity_mismatch');
    const result = storedResultOf(recovery);
    if (result === null) return unknown('recovery_result_missing');
    const category = result['category'];
    if (typeof category !== 'string') return unknown('recovery_category_missing');
    const contract = TERMINAL_SUBMIT_CONTRACT.get(category);
    if (contract === undefined) return unknown('recovery_category_not_terminal');
    const attemptId =
      typeof recovery.attemptId === 'string'
        ? recovery.attemptId
        : typeof result['attemptId'] === 'string'
          ? (result['attemptId'] as string)
          : undefined;
    if (attemptId === undefined) return unknown('recovery_attempt_missing');
    // ONE shared strict completed-result validator (storage + plugin).
    if (
      !validateCompletedSubmitResult(result, {
        pendingId: identity.pendingRef,
        planId: identity.planId,
        targetDisplay: identity.targetDisplay,
        operator: identity.operator,
        attemptId,
      })
    ) {
      return unknown('recovery_result_invalid');
    }
    return { surface: 'terminal', category, status: contract.status, attemptId, replayed: true };
  }

  if (
    recovery.state === 'start_failed' &&
    identityMatches(recovery, identity)
  ) {
    return { surface: 'start_failed' };
  }

  return unknown('recovery_not_terminal');
}

/**
 * The internal `submit_ack` cleanup succeeded only when the strict client call
 * succeeded and returned exactly `{ acked: true, idempotent: <boolean> }`
 * (Findings Q/E).
 */
export function ackSucceeded(ack: AckCallLike | undefined): boolean {
  if (ack === undefined || !ack.ok || ack.envelope === undefined) return false;
  const data = ack.envelope.data;
  if (!isRecord(data)) return false;
  const keys = Object.keys(data);
  if (keys.length !== 2 || !keys.includes('acked') || !keys.includes('idempotent')) return false;
  return data['acked'] === true && typeof data['idempotent'] === 'boolean';
}
