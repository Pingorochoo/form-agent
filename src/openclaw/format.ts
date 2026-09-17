/**
 * Phase 8 rendering helpers (P8-R15, §13).
 *
 * Fixed/bounded status text only. Untrusted form/question/provider strings and
 * review values never enter the model-visible text produced here. Telegram
 * delivery of review values is a separate trusted same-chat step handled by the
 * plugin, which strips those values from the model-visible result.
 */

import type { AnyCategory } from './contracts.ts';

export const APPROVAL_TITLE = 'Approve form submission';
export const APPROVAL_TIMEOUT_MS = 120_000;

/** Maximum rendered approval fields (OpenClaw caps these in the Gateway). */
export const APPROVAL_TITLE_MAX = 80;
export const APPROVAL_DESCRIPTION_MAX = 512;

export const PREFLIGHT_READY_MESSAGE =
  'Preflight ready. No fill or submission occurred. A submission approval is required to proceed.';

const MESSAGES: Record<AnyCategory, string> = {
  ok_analyze: 'Analysis complete. No fill or submission occurred.',
  ok_draft: 'Draft generated. No fill or submission occurred.',
  ok_check: 'Consistency check complete. No fill or submission occurred.',
  needs_confirmation: PREFLIGHT_READY_MESSAGE,
  blocked_check: 'Consistency check blocked. No fill or submission occurred.',
  blocked_preflight: 'Preflight blocked. No pending submission was registered.',
  ok_submit_success: 'Submission confirmed by Form Agent.',
  blocked_submit: 'Submission blocked by Form Agent. No submission occurred.',
  already_claimed: 'Form Agent reports this submission was already claimed.',
  submit_start_failed: 'Submit process could not be started. A new preflight is required.',
  unknown_outcome: 'Submission outcome is unknown. Manual reconciliation is required.',
  ok_metrics: 'Metrics exported.',
  ok_cancelled: 'Pending submission cancelled.',
  ok_pending_status: 'Pending status read.',
  ok_reconciled: 'Unknown outcome reconciled by the operator.',
  no_pending: 'No pending submission to act on.',
  pending_expired: 'Pending submission has expired.',
  pending_replaced: 'Pending submission was replaced; approval fails closed.',
  pending_consumed: 'Pending submission was already consumed.',
  unknown_barrier: 'An unresolved unknown-outcome barrier blocks this request.',
  usage_error: 'Request rejected: invalid arguments.',
  unauthorized: 'Request not authorized.',
  llm_offline: 'LLM provider is offline.',
  llm_connectivity: 'LLM provider connectivity failed.',
  timeout: 'Operation timed out.',
  error: 'Operation failed.',
  submit_denied: 'Submission not approved.',
  submit_approval_timeout: 'Submission approval timed out.',
  submit_approval_unavailable: 'Submission approval is unavailable.',
};

export function categoryMessage(category: AnyCategory): string {
  return MESSAGES[category];
}

/**
 * Render the frozen approval description: FULL canonical `targetDisplay`
 * (≤256) + FULL 64-hex `planId` + a bounded expiry derived from the trusted
 * `expiresAtMs`. By construction this is ≤512 chars and contains no secrets or
 * answer values.
 */
export function renderApprovalDescription(
  targetDisplay: string,
  planId: string,
  expiresAtMs: number,
): string {
  const expiryIso = new Date(expiresAtMs).toISOString();
  return `Submit the approved preflight plan. Target: ${targetDisplay} Plan: ${planId} Expires: ${expiryIso}`;
}

/** True when the rendered title/description fit the frozen Gateway caps. */
export function approvalRenderFits(targetDisplay: string, planId: string, expiresAtMs: number): boolean {
  const description = renderApprovalDescription(targetDisplay, planId, expiresAtMs);
  return APPROVAL_TITLE.length <= APPROVAL_TITLE_MAX && description.length <= APPROVAL_DESCRIPTION_MAX;
}

/**
 * Conservative submission-state text for the model-visible tool result. It is
 * fixed and bounded; it never echoes untrusted strings or review values.
 */
export function submitStateText(category: AnyCategory): string {
  return MESSAGES[category];
}
