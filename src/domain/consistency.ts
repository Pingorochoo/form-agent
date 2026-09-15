/**
 * Consistency-gate domain models (provider-neutral, pure).
 *
 * Phase 4 evaluates whether an accepted Phase 3 `DraftBundle` is internally
 * coherent enough for a future preview/run consumer. It produces a stable,
 * deterministic, secret-safe `ConsistencyReport`; it never mutates the draft.
 *
 * These types have zero dependencies (no I/O, no LLM, no DB). They are consumed
 * by the deterministic rule engine in `src/consistency/` and formatted by the
 * `check` CLI.
 */

/**
 * Bump whenever the report contract, rule set, or issue-code semantics change
 * in a way that must invalidate a prior report identity. Consumers compare this
 * against `ConsistencyReport.version`; the `reportId` also incorporates it so
 * the same (schema, draft) evaluated under a different gate version yields a
 * different identity.
 */
export const CONSISTENCY_GATE_VERSION = '1.0.0';

/** Hard issues block; soft issues only warn. */
export type ConsistencySeverity = 'hard' | 'soft';

/**
 * Report status:
 *   - `pass`  — no issues at all;
 *   - `warn`  — one or more soft issues and zero hard issues;
 *   - `block` — one or more hard issues.
 */
export type ConsistencyStatus = 'pass' | 'warn' | 'block';

/**
 * A single detected inconsistency. `questionIds` may contain only ids that are
 * validated as real schema question ids — never untrusted/unknown ids and never
 * raw answer/profile values. `message` is a stable, sanitized, value-free
 * explanation.
 */
export interface ConsistencyIssue {
  /** Stable machine-readable issue code (see `CONSISTENCY_ISSUE_CODES`). */
  code: string;
  severity: ConsistencySeverity;
  /** Validated real schema question ids, in schema order. */
  questionIds: string[];
  /** Stable sanitized message; never embeds answer/profile/provider values. */
  message: string;
}

/**
 * The immutable, reproducible result of evaluating the consistency gate.
 *
 * `blocking` is `true` iff `hardIssues > 0`. It is the single field future
 * preview/run consumers should read to decide whether to stop on consistency
 * grounds — and it is NOT an authorization decision (see Phase 2 PolicyEngine).
 */
export interface ConsistencyReport {
  version: string;
  /** Stable identity derived from draft id, fingerprint, gate version, issues. */
  reportId: string;
  draftId: string;
  fingerprint: string;
  status: ConsistencyStatus;
  blocking: boolean;
  hardIssues: number;
  softIssues: number;
  issues: ConsistencyIssue[];
}

/**
 * Stable issue-code baseline. Hard codes block; soft codes warn. Codes never
 * embed raw values.
 */
export const CONSISTENCY_ISSUE_CODES = {
  SCHEMA_FINGERPRINT_MISMATCH: 'SCHEMA_FINGERPRINT_MISMATCH',
  FORM_ID_MISMATCH: 'FORM_ID_MISMATCH',
  PROFILE_FORM_MISMATCH: 'PROFILE_FORM_MISMATCH',
  DRAFT_RESULT_COVERAGE_MISMATCH: 'DRAFT_RESULT_COVERAGE_MISMATCH',
  DRAFT_RESULT_KIND_MISMATCH: 'DRAFT_RESULT_KIND_MISMATCH',
  REQUIRED_QUESTION_UNANSWERED: 'REQUIRED_QUESTION_UNANSWERED',
  DRAFT_VALIDATION_ERROR: 'DRAFT_VALIDATION_ERROR',
  PROFILE_TRAIT_MISMATCH: 'PROFILE_TRAIT_MISMATCH',
  REPETITION_ANSWER_MISMATCH: 'REPETITION_ANSWER_MISMATCH',
  REPETITION_POSSIBLE_MISMATCH: 'REPETITION_POSSIBLE_MISMATCH',
  RELATIONSHIP_NOT_FULLY_CHECKED: 'RELATIONSHIP_NOT_FULLY_CHECKED',
} as const;

export type ConsistencyIssueCode = (typeof CONSISTENCY_ISSUE_CODES)[keyof typeof CONSISTENCY_ISSUE_CODES];
