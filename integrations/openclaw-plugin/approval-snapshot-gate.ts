import type { ApprovalSnapshotParams } from './approval-hook.ts';

const APPROVAL_SNAPSHOT_MAX = 32;
const TOOL_CALL_ID_MAX = 256;

interface ApprovalSnapshotEntry {
  snapshot: ApprovalSnapshotParams;
  state: 'awaiting' | 'approved';
  token: symbol;
}

export function isApprovalToolCallId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= TOOL_CALL_ID_MAX &&
    !value.includes('\0')
  );
}

/**
 * Process-local, host-owned transport for an approved submission snapshot.
 *
 * The model never receives or supplies these values. OpenClaw's host-generated
 * toolCallId binds before_tool_call approval to the matching tool execution.
 */
export class ApprovalSnapshotGate {
  private readonly entries = new Map<string, ApprovalSnapshotEntry>();

  register(
    toolCallId: string,
    snapshot: ApprovalSnapshotParams,
    nowMs: number,
  ): symbol | null {
    this.prune(nowMs);

    if (!isApprovalToolCallId(toolCallId)) return null;
    if (!Number.isFinite(snapshot.expiresAtMs) || snapshot.expiresAtMs <= nowMs) {
      return null;
    }
    if (this.entries.has(toolCallId)) return null;
    if (this.entries.size >= APPROVAL_SNAPSHOT_MAX) return null;

    const token = Symbol(toolCallId);
    this.entries.set(toolCallId, {
      snapshot: {
        ...snapshot,
        principal: { ...snapshot.principal },
      },
      state: 'awaiting',
      token,
    });
    return token;
  }

  /**
   * Only allow-once promotes an awaiting snapshot to executable state.
   * deny/timeout/cancelled/allow-always/unknown all destroy the snapshot.
   */
  resolve(
    toolCallId: string,
    token: symbol,
    resolution: unknown,
    nowMs: number,
  ): void {
    const entry = this.entries.get(toolCallId);
    if (entry === undefined || entry.token !== token) return;

    if (resolution !== 'allow-once' || nowMs >= entry.snapshot.expiresAtMs) {
      this.entries.delete(toolCallId);
      return;
    }

    entry.state = 'approved';
  }

  /**
   * Consume before any submit-side effect. The same host toolCallId can never
   * reuse one approval snapshot.
   */
  consumeApproved(
    toolCallId: string,
    nowMs: number,
  ): ApprovalSnapshotParams | null {
    this.prune(nowMs);

    const entry = this.entries.get(toolCallId);
    if (entry === undefined || entry.state !== 'approved') return null;

    this.entries.delete(toolCallId);
    return entry.snapshot;
  }

  private prune(nowMs: number): void {
    for (const [toolCallId, entry] of this.entries) {
      if (entry.snapshot.expiresAtMs <= nowMs) {
        this.entries.delete(toolCallId);
      }
    }
  }
}
