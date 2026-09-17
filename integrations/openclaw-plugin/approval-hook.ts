/**
 * Phase 8 host-mediated submit approval (P8-R10, §6.2).
 *
 * Pure builder for the `before_tool_call` result: it snapshots the SIX trusted
 * fields { pendingRef, principal, planId, targetKey, targetDisplay,
 * expiresAtMs } and requests an approval restricted to EXACTLY
 * ["allow-once", "deny"].
 *
 * All six fields come from trusted runtime context / trusted `pending_status`
 * state — never from model params. `allow-always` is never offered and is
 * rejected defensively if somehow received.
 */

import { canonicalizeTarget } from '../../src/policy/target.ts';
import {
  APPROVAL_DESCRIPTION_MAX,
  APPROVAL_TIMEOUT_MS,
  APPROVAL_TITLE,
  APPROVAL_TITLE_MAX,
  renderApprovalDescription,
} from '../../src/openclaw/format.ts';
import {
  crossCheckHookRequester,
  type HookRequesterContext,
  type PluginDeploymentConfig,
  type PluginPrincipal,
} from './principal.ts';

export interface PendingApprovalView {
  pendingId: string;
  planId: string;
  targetKey: string;
  targetDisplay: string;
  expiresAtMs: number;
  status: string;
}

export interface ApprovalSnapshotParams {
  pendingRef: string;
  principal: { channel: 'telegram'; accountId: string; senderId: string };
  planId: string;
  targetKey: string;
  targetDisplay: string;
  expiresAtMs: number;
}

export interface RequireApproval {
  title: string;
  description: string;
  severity: 'critical';
  allowedDecisions: ['allow-once', 'deny'];
  timeoutMs: number;
}

export type ApprovalDecisionResult =
  | { block: true; blockReason: string }
  | { params: ApprovalSnapshotParams; requireApproval: RequireApproval };

export interface BuildSubmitApprovalInput {
  view: PendingApprovalView | null;
  config: PluginDeploymentConfig;
  toolPrincipal: PluginPrincipal;
  hookRequester: HookRequesterContext | undefined;
  nowMs: number;
  /** Defensively validated; only allow-once/deny are accepted. */
  decisions?: readonly string[];
}

const PLAN_ID_RE = /^[0-9a-f]{64}$/;
const PENDING_REF_RE = /^[0-9a-f]{32}$/;

/** Only `allow-once`/`deny` are ever accepted for submit. */
export function approvalDecisionsAllowed(decisions: readonly string[] | undefined): boolean {
  if (decisions === undefined) return true;
  if (decisions.length === 0) return false;
  return decisions.every((decision) => decision === 'allow-once' || decision === 'deny');
}

function reject(reason: string): ApprovalDecisionResult {
  return { block: true, blockReason: reason };
}

/**
 * Build the frozen approval result. Fails closed on: unauthorized hook
 * requester, missing/terminal pending, expiry, malformed identity, target
 * tampering, and any attempt to offer `allow-always`.
 */
export function buildSubmitApproval(input: BuildSubmitApprovalInput): ApprovalDecisionResult {
  if (!approvalDecisionsAllowed(input.decisions)) {
    return reject('Form Agent submission not authorized.');
  }

  const crossCheck = crossCheckHookRequester(input.config, input.toolPrincipal, input.hookRequester);
  if (!crossCheck.ok) return reject('Form Agent submission not authorized.');

  const view = input.view;
  if (view === null || view.status !== 'pending') {
    return reject('No pending submission to approve.');
  }
  if (!PENDING_REF_RE.test(view.pendingId)) return reject('No pending submission to approve.');
  if (!PLAN_ID_RE.test(view.planId)) return reject('No pending submission to approve.');
  if (!Number.isFinite(view.expiresAtMs) || view.expiresAtMs <= input.nowMs) {
    return reject('No pending submission to approve.');
  }

  // Crypto/state-bound target display: the canonical display must reproduce the
  // stored identity key. (The adapter separately re-checks the third part,
  // `targetArg === targetDisplay`, before returning the approval view.)
  let canonicalKey: string;
  try {
    canonicalKey = canonicalizeTarget(view.targetDisplay).key;
  } catch {
    return reject('No pending submission to approve.');
  }
  if (canonicalKey !== view.targetKey) return reject('No pending submission to approve.');

  const params: ApprovalSnapshotParams = {
    pendingRef: view.pendingId,
    principal: {
      channel: 'telegram',
      accountId: input.config.accountId,
      senderId: input.toolPrincipal.senderId,
    },
    planId: view.planId,
    targetKey: view.targetKey,
    targetDisplay: view.targetDisplay,
    expiresAtMs: view.expiresAtMs,
  };

  const description = renderApprovalDescription(view.targetDisplay, view.planId, view.expiresAtMs);
  if (APPROVAL_TITLE.length > APPROVAL_TITLE_MAX || description.length > APPROVAL_DESCRIPTION_MAX) {
    return reject('No pending submission to approve.');
  }

  return {
    params,
    requireApproval: {
      title: APPROVAL_TITLE,
      description,
      severity: 'critical',
      allowedDecisions: ['allow-once', 'deny'],
      timeoutMs: APPROVAL_TIMEOUT_MS,
    },
  };
}

/**
 * Verify the execution-time snapshot still matches the CURRENT pending record
 * on ALL SIX fields plus current expiry. Any mismatch fails closed.
 */
export function verifyApprovalSnapshot(
  params: ApprovalSnapshotParams,
  current: PendingApprovalView | null,
  config: PluginDeploymentConfig,
  toolSenderId: string,
  nowMs: number,
): { ok: true } | { ok: false; reason: 'mismatch' } {
  if (current === null) return { ok: false, reason: 'mismatch' };
  if (params.principal.channel !== 'telegram') return { ok: false, reason: 'mismatch' };
  if (params.principal.accountId !== config.accountId) return { ok: false, reason: 'mismatch' };
  if (params.principal.senderId !== toolSenderId) return { ok: false, reason: 'mismatch' };
  if (params.pendingRef !== current.pendingId) return { ok: false, reason: 'mismatch' };
  if (params.planId !== current.planId) return { ok: false, reason: 'mismatch' };
  if (params.targetKey !== current.targetKey) return { ok: false, reason: 'mismatch' };
  if (params.targetDisplay !== current.targetDisplay) return { ok: false, reason: 'mismatch' };
  if (params.expiresAtMs !== current.expiresAtMs) return { ok: false, reason: 'mismatch' };
  if (current.status !== 'pending') return { ok: false, reason: 'mismatch' };
  if (nowMs >= params.expiresAtMs) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}
