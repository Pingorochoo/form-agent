/**
 * Phase 8 operator-only local reconciliation (P8-R14, §11.2a).
 *
 * `reconcile_unknown` is a PRIVILEGED LOCAL OPERATOR ASSERTION — never an
 * OpenClaw tool and never a Telegram command. It only clears the adapter's own
 * orchestration barrier; it never mutates Form Agent receipts/policy/rate/
 * snapshots/metrics and it never invokes Form Agent.
 *
 * It REFUSES when persisted ownership metadata identifies a still-live process
 * (it never kills or retries silently). When ownership metadata is unavailable
 * (crash in the spawn/persist race window), clearing requires the explicit
 * operator assertion after manual checks.
 */

import { PendingError, isPidAlive, type PendingRecord } from './pending.ts';
import type { PendingStore, ReconcileOutcome } from './pending.ts';
import { isResolution, type Resolution } from './contracts.ts';

export { isPidAlive };

/** True when a POSIX process-group id still has members. */
export function isProcessGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err) {
      const code = (err as { code?: unknown }).code;
      return code === 'EPERM';
    }
    return false;
  }
}

/**
 * Default live-child predicate: only explicit numeric ownership metadata can
 * prove liveness. `'unavailable'` (or a missing value) is NOT proof either way,
 * so it does not block the operator assertion.
 */
export function defaultIsLiveChild(record: PendingRecord): boolean {
  if (typeof record.childProcessGroup === 'number' && isProcessGroupAlive(record.childProcessGroup)) {
    return true;
  }
  if (typeof record.childPid === 'number' && isPidAlive(record.childPid)) {
    return true;
  }
  return false;
}

export interface ReconcileUnknownInput {
  store: PendingStore;
  principal: { channel: 'telegram'; accountId: string; senderId: string };
  pendingRef: string;
  resolution: string;
  /** Test seam; defaults to the real process-existence checks. */
  isLive?: (record: PendingRecord) => boolean;
}

export function reconcileUnknown(input: ReconcileUnknownInput): ReconcileOutcome {
  if (!isResolution(input.resolution)) {
    throw new PendingError('NO_PENDING', 'invalid reconciliation resolution');
  }
  const resolution: Resolution = input.resolution;
  const isLive = input.isLive ?? defaultIsLiveChild;
  return input.store.reconcile(input.principal, input.pendingRef, resolution, isLive);
}
