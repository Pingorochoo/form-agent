/**
 * Provider-neutral execution domain models (pure, dependency-free).
 *
 * Phase 5 adds the first controlled browser execution path. These types define
 * the boundary between the deterministic orchestrator (sequencing, policy,
 * consistency, durable state) and the browser execution provider (browser
 * lifecycle, DOM lookup, fill mechanics, submit evidence).
 *
 * No I/O, no Playwright, no DB, no policy logic lives here. The provider must
 * never decide authorization/policy/consistency; it only reports DOM/state
 * evidence, and the orchestrator decides.
 */

import type { FormSection, Question } from './types.ts';
import type { DraftValue } from './draft.ts';
import type { ConsistencyStatus } from './consistency.ts';
import type { CanonicalTarget } from '../policy/target.ts';

/**
 * Bumped whenever the execution-plan contract (fields/identity material)
 * changes in a way that must invalidate a prior plan identity. `planId`
 * incorporates this version so the same form evaluated under a different plan
 * contract yields a different identity.
 *
 * 2.0.0 (Phase 6): the operator-approved plan identity now also commits to the
 * exact approved bundle content (`bundle_sha256`) and provider provenance
 * (`provenance_hash`), so an approved planId can never be reused for different
 * answer/profile/provenance content. Raw values are never identity material —
 * only the content-bound hashes are.
 */
export const EXECUTION_PLAN_VERSION = '2.0.0';

/** Whether the browser-loaded form is currently accepting responses. */
export type AcceptingState = 'accepting' | 'closed' | 'unknown';

/**
 * Terminal execution outcome (P5-R15). `success` requires positive
 * provider-specific confirmation; any post-submit ambiguity becomes
 * `unknown_outcome` unless the provider can prove no submit action occurred.
 */
export type ExecutionOutcome =
  | 'preflight'
  | 'success'
  | 'failed_pre_submit'
  | 'aborted'
  | 'unknown_outcome';

/** Durable receipt machine state (see docs/PHASE_5.md state machine). */
export type ExecutionReceiptState =
  | 'preflight'
  | 'filled'
  | 'submitting'
  | 'success'
  | 'unknown_outcome'
  | 'failed_pre_submit'
  | 'aborted';

/** Runtime structural snapshot captured from the live browser page. */
export interface RuntimeFormSnapshot {
  /** Current responder-page HTML (parsed through the accepted parser). */
  html: string;
  /** The URL the page was loaded from (sanitized for audit). */
  url: string;
}

/**
 * Provider submit evidence (P5-R15). `confirmed` is the ONLY state that maps to
 * `success`; `ambiguous` maps to `unknown_outcome`. Codes never embed raw
 * values/HTML.
 */
export type SubmitEvidence =
  | { state: 'confirmed'; confirmationCode: string }
  | { state: 'ambiguous'; reasonCode: string };

/** A single answered fill item: the schema question + accepted draft value. */
export interface ExecutionFillItem {
  question: Question;
  value: DraftValue;
}

/** Bounded open options handed to an execution provider. */
export interface ExecutionOpenOptions {
  headless: boolean;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  /** Optional Chromium executable path override (empty = bundled default). */
  executablePath?: string;
}

/**
 * Provider-neutral execution boundary (P5-R2).
 *
 * The provider owns browser lifecycle + DOM mechanics; the orchestrator owns
 * sequencing, policy, consistency, durable state, and retry/abort semantics.
 */
export interface ExecutionProvider {
  readonly id: string;
  readonly version: string;
  open(target: CanonicalTarget, options: ExecutionOpenOptions): Promise<ExecutionSession>;
}

export interface ExecutionSession {
  /** Capture the current runtime structural snapshot for the accepted parser. */
  snapshot(): Promise<RuntimeFormSnapshot>;
  /** Report whether the form is currently accepting responses. */
  isAcceptingResponses(): Promise<AcceptingState>;
  /** Establish the current-section mapping of expected questions to DOM. */
  beginSection(questions: Question[]): Promise<void>;
  /** Fill exactly one answered field. */
  fill(item: ExecutionFillItem): Promise<void>;
  /** Verify the browser DOM actually reflects the filled value. */
  verifyFilled(item: ExecutionFillItem): Promise<void>;
  /** Activate "Next" and verify progression to the next expected section. */
  advanceSection(): Promise<void>;
  /**
   * Validate that the final submit control is present and unique BEFORE any
   * durable claim. A missing/ambiguous control must fail here as a controlled
   * pre-submit error (no claim, no rate event) rather than after the claim.
   */
  assertSubmitReady(): Promise<void>;
  /** Perform the single submission attempt and return structured evidence. */
  submitOnce(): Promise<SubmitEvidence>;
  /** Close the session (guaranteed teardown; idempotent). */
  close(): Promise<void>;
}

/**
 * The provider-neutral execution plan (P5-R5).
 *
 * `planId` is derived only from safe stable material (plan version, canonical
 * target key, runtime schema checksum, draft id, consistency report id, provider
 * id/version). Raw answer values, profile values, rate counters, wall-clock
 * time, policy regex bodies, and URL query/userinfo secrets are never identity
 * material.
 */
export interface ExecutionPlan {
  version: string;
  /** Stable deterministic plan identity. */
  planId: string;
  /** Sanitized canonical target key (identity). */
  targetKey: string;
  /** Sanitized canonical target display (audit). */
  targetDisplay: string;
  /** Runtime structural fingerprint (schema.checksum). */
  fingerprint: string;
  draftId: string;
  consistencyReportId: string;
  consistencyStatus: ConsistencyStatus;
  consistencyHardIssues: number;
  consistencySoftIssues: number;
  providerId: string;
  providerVersion: string;
  /** Count of answered/fillable questions. */
  fillableCount: number;
  /** Count of blocked/deferred/unsupported questions (never filled). */
  blockedCount: number;
  /** Whether the full policy gate currently allows execution. */
  policyAllowed: boolean;
  /** Stable policy reason codes (empty when allowed). */
  policyReasons: string[];
}

/**
 * Stable machine-readable execution codes (P5-R15 / docs/PHASE_5.md).
 * Pre-submit failure codes and terminal outcome codes are kept separate so
 * callers never parse prose. No raw values are embedded.
 */
export const EXECUTION_PRE_SUBMIT_CODES = {
  TARGET_UNSUPPORTED: 'EXECUTION_TARGET_UNSUPPORTED',
  NOT_AUTHORIZED: 'EXECUTION_NOT_AUTHORIZED',
  FORM_NOT_ACCEPTING: 'FORM_NOT_ACCEPTING_RESPONSES',
  RUNTIME_SCHEMA_PARSE_FAILED: 'RUNTIME_SCHEMA_PARSE_FAILED',
  CONSISTENCY_BLOCKED: 'CONSISTENCY_BLOCKED',
  POLICY_BLOCKED: 'EXECUTION_POLICY_BLOCKED',
  PLAN_MISMATCH: 'EXECUTION_PLAN_MISMATCH',
  KIND_UNSUPPORTED: 'EXECUTION_KIND_UNSUPPORTED',
  LOCATOR_AMBIGUOUS: 'EXECUTION_LOCATOR_AMBIGUOUS',
  LOCATOR_NOT_FOUND: 'EXECUTION_LOCATOR_NOT_FOUND',
  FILL_VERIFICATION_FAILED: 'EXECUTION_FILL_VERIFICATION_FAILED',
  FLOW_UNEXPECTED: 'EXECUTION_FLOW_UNEXPECTED',
  FORM_CHANGED_BEFORE_SUBMIT: 'FORM_CHANGED_BEFORE_SUBMIT',
  SUBMISSION_ALREADY_CLAIMED: 'SUBMISSION_ALREADY_CLAIMED',
  BROWSER_OPEN_FAILED: 'EXECUTION_BROWSER_OPEN_FAILED',
} as const;

export const EXECUTION_TERMINAL_CODES = {
  SUBMISSION_CONFIRMED: 'SUBMISSION_CONFIRMED',
  SUBMISSION_OUTCOME_UNKNOWN: 'SUBMISSION_OUTCOME_UNKNOWN',
} as const;

/**
 * Stable execution-plan-snapshot reason codes (Phase 6, P6-R17). These are
 * internal block/safety codes, not new process exit codes: they map onto the
 * existing frozen exit-code contract (block -> 3) via `executionExitCode`.
 */
export const EXECUTION_SNAPSHOT_CODES = {
  NOT_FOUND: 'EXECUTION_PLAN_SNAPSHOT_NOT_FOUND',
  INVALID: 'EXECUTION_PLAN_SNAPSHOT_INVALID',
  MISMATCH: 'EXECUTION_PLAN_SNAPSHOT_MISMATCH',
  CONFLICT: 'EXECUTION_PLAN_SNAPSHOT_CONFLICT',
} as const;

export type ExecutionPreSubmitCode =
  (typeof EXECUTION_PRE_SUBMIT_CODES)[keyof typeof EXECUTION_PRE_SUBMIT_CODES];
export type ExecutionTerminalCode =
  (typeof EXECUTION_TERMINAL_CODES)[keyof typeof EXECUTION_TERMINAL_CODES];
export type ExecutionSnapshotCode =
  (typeof EXECUTION_SNAPSHOT_CODES)[keyof typeof EXECUTION_SNAPSHOT_CODES];

/**
 * The sections the orchestrator must walk, in order. Only sequential routing is
 * supported (the accepted structural model); a helper to expose the ordered
 * expected section list for the browser flow.
 */
export function sequentialSections(schema: { sections: FormSection[] }): FormSection[] {
  return [...schema.sections].sort((a, b) => a.index - b.index);
}
