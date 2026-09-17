/**
 * Phase 8 plugin-owned model-visible rendering (Finding D2).
 *
 * Tool `content` and `details` are produced ONLY from a plugin-owned fixed
 * renderer keyed by the VALIDATED operation/category, plus a bounded closed
 * projection of known-safe scalar fields. Arbitrary adapter `message`/`data`
 * never reaches the model.
 *
 * Trusted human review values are delivered separately (same-chat delivery) and
 * are never part of this projection.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function isSafeString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !CONTROL_CHARS.test(value);
}

function isSafeScalar(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  return isSafeString(value, 256);
}

/** Fixed, plugin-owned model-visible text per validated category. */
const CATEGORY_TEXT: Readonly<Record<string, string>> = {
  ok_analyze: 'Analysis complete. No fill or submission occurred.',
  ok_draft: 'Draft generated. No fill or submission occurred.',
  ok_check: 'Consistency check complete. No fill or submission occurred.',
  needs_confirmation:
    'Preflight ready. No fill or submission occurred. A submission approval is required to proceed.',
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
};

export function renderModelText(category: string): string {
  return CATEGORY_TEXT[category] ?? 'Operation failed.';
}

/**
 * Bounded, closed per-operation detail projection. Only stable/runtime-safe
 * scalar fields are exposed; untrusted form text (titles, answer values, raw
 * HTML, provider payloads) is never included.
 */
const OPERATION_DETAIL_KEYS: Readonly<Record<string, readonly string[]>> = {
  analyze: [
    'fingerprint',
    'sectionCount',
    'questionCount',
    'requiredCount',
    'optionalCount',
    'policyAllowed',
    'policyReasons',
    'routing',
  ],
  draft: ['draftId', 'fingerprint', 'providerId', 'providerVersion', 'answeredCount'],
  draft_review: ['draftId', 'fingerprint', 'providerId', 'providerVersion', 'answeredCount'],
  check: ['reportId', 'status', 'hardIssues', 'softIssues', 'issueCodes'],
  preflight: [
    'fingerprint',
    'planId',
    'reportId',
    'consistencyStatus',
    'fillableCount',
    'blockedCount',
    'policyAllowed',
    'policyReasons',
    'accepting',
    'draftId',
    'providerId',
    'providerVersion',
  ],
  metrics: [],
  cancel_pending: [],
  pending_status: [],
  submit_status: [],
  submit_ack: [],
  submit_pending: [],
};

export function projectModelDetails(operation: string, data: unknown): Record<string, unknown> {
  if (!isRecord(data)) return {};
  const keys = OPERATION_DETAIL_KEYS[operation] ?? [];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    if (isSafeScalar(value)) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.length <= 16 && value.every((item) => isSafeString(item, 128))) {
      out[key] = [...value];
    }
  }
  return out;
}
