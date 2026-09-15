/**
 * Stable, machine-readable policy reason codes (P2-R13).
 *
 * These codes are the interface later phases and external tooling consume, so
 * they must not be reworded or renumbered once released. Human-readable text is
 * derived here so callers never parse prose to distinguish failures.
 *
 * Phase 2 only produces *decisions*: no code here sleeps, schedules, paces,
 * submits, or touches the network.
 */

export const POLICY_REASON_CODES = [
  'TARGET_NOT_ALLOWLISTED',
  'REQUIRED_SCOPE_MISSING',
  'AUTHORIZATION_REVOKED',
  'SENSITIVE_FIELD_NEVER',
  'HUMAN_REVIEW_REQUIRED',
  'SPECIFIC_AUTHORIZATION_REQUIRED',
  'SAFETY_MODE_NOT_ELIGIBLE',
  'MIN_DELAY_RATE_GATE',
  'HOURLY_RATE_CAP',
  'DAILY_RATE_CAP',
  'BATCH_PAUSE',
  'CONCURRENT_BATCH_CAP',
] as const;

export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];

/** Stable human-readable explanation for each code. */
export const POLICY_REASON_DESCRIPTIONS: Record<PolicyReasonCode, string> = {
  TARGET_NOT_ALLOWLISTED: 'target is not allowlisted for execution',
  REQUIRED_SCOPE_MISSING: 'requested authorization scope is unavailable or not granted',
  AUTHORIZATION_REVOKED: 'authorization for the target has been revoked',
  SENSITIVE_FIELD_NEVER: 'a sensitive field is blocked by the never policy mode',
  HUMAN_REVIEW_REQUIRED: 'a sensitive field requires human review before execution',
  SPECIFIC_AUTHORIZATION_REQUIRED: 'a sensitive field requires specific authorization',
  SAFETY_MODE_NOT_ELIGIBLE: 'safety mode is not eligible for execution',
  MIN_DELAY_RATE_GATE: 'minimum delay between submissions has not elapsed',
  HOURLY_RATE_CAP: 'per-form hourly submission cap reached',
  DAILY_RATE_CAP: 'per-form daily submission cap reached',
  BATCH_PAUSE: 'required pause between batches has not elapsed',
  CONCURRENT_BATCH_CAP: 'maximum concurrent batches reached',
};

export function policyReasonDescription(code: PolicyReasonCode): string {
  return POLICY_REASON_DESCRIPTIONS[code];
}

export function isPolicyReasonCode(value: string): value is PolicyReasonCode {
  return (POLICY_REASON_CODES as readonly string[]).includes(value);
}
