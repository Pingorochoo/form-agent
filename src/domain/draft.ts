/**
 * Draft-answer domain models (provider-neutral, pure).
 *
 * Phase 3 drafts data only: it never fetches, submits, or executes a form.
 * A `DraftBundle` is the structured result of the local draft pipeline. It is
 * ephemeral/in-memory or emitted as explicit CLI output — never persisted.
 *
 * These types have zero dependencies (no I/O, no LLM, no DB). The structural
 * `FormSchema` remains authoritative for every identifier and bound referenced
 * here; the draft layer validates provider output against it rather than
 * trusting the provider to invent question/choice/grid identifiers.
 */

import type { FormFieldId } from './types.ts';
import type { SemanticModel } from './semantic.ts';
import type { SyntheticProfile } from './profile.ts';

/**
 * Accepted Phase 3 date representation: an explicit calendar date.
 * `month` is 1-12 and `day` is the day of `month` (validated against the real
 * calendar, including leap years).
 */
export interface DraftDateValue {
  year: number;
  month: number;
  day: number;
}

/** Accepted Phase 3 time representation: 24-hour clock. */
export interface DraftTimeValue {
  hour: number;
  minute: number;
}

/**
 * A proposed/validated draft value for one of the accepted Phase 1 structural
 * kinds. The `kind` discriminator must match the target question's kind.
 *
 * Values reference only real structural objects:
 *   - `single-choice` / `multi-choice` carry choice labels present in the
 *     question's `choices`;
 *   - `linear-scale` carries an integer inside `[minValue, maxValue]`;
 *   - `multiple-choice-grid` maps real row ids to real column labels;
 *   - `date` / `time` carry the calendar/clock representations above.
 */
export type DraftValue =
  | { kind: 'text'; value: string }
  | { kind: 'paragraph-text'; value: string }
  | { kind: 'single-choice'; value: string }
  | { kind: 'multi-choice'; value: string[] }
  | { kind: 'linear-scale'; value: number }
  | { kind: 'multiple-choice-grid'; value: Record<string, string> }
  | { kind: 'date'; value: DraftDateValue }
  | { kind: 'time'; value: DraftTimeValue };

/**
 * Per-question draft state (P3-R7). Every question has exactly one explicit
 * state. A `blocked-*`/`unsupported`/`validation-error` state never carries a
 * generated value — blocked sensitive questions are filtered before any value
 * is requested from a provider.
 */
export type QuestionDraftState =
  | { state: 'answered'; value: DraftValue }
  | { state: 'blocked-sensitive'; categories: string[]; mode: string; reason: string }
  | { state: 'requires-human-review'; categories: string[]; mode: string; reason: string }
  | { state: 'requires-specific-authorization'; categories: string[]; mode: string; reason: string }
  | { state: 'unsupported'; reason: string }
  | { state: 'validation-error'; reason: string };

export interface QuestionDraftResult {
  questionId: FormFieldId;
  /** Structural kind of the question (from the schema, never the provider). */
  kind: string;
  required: boolean;
  state: QuestionDraftState;
}

export interface DraftSummary {
  total: number;
  answered: number;
  /** blocked-sensitive + requires-human-review + requires-specific-authorization. */
  blocked: number;
  unsupported: number;
  validationErrors: number;
  /** Required questions that are not `answered`. */
  requiredUnanswered: number;
  complete: boolean;
}

/**
 * The structured draft result (P3-R7). `synthetic: true` plus `seed`,
 * `providerId`/`providerVersion` and `draftId` make synthetic provenance and
 * the deterministic reference contract explicit (P3-R12, P3-R6).
 */
export interface DraftBundle {
  synthetic: true;
  seed: string;
  /** Stable identity derived from fingerprint + seed + provider contract. */
  draftId: string;
  providerId: string;
  providerVersion: string;
  /** The structural fingerprint of the accepted form. */
  fingerprint: string;
  formId: string;
  formTitle: string;
  semantics: SemanticModel;
  profile: SyntheticProfile;
  /** One result per schema question, in schema order. */
  results: QuestionDraftResult[];
  summary: DraftSummary;
}

export function isAnsweredState(state: QuestionDraftState): state is Extract<QuestionDraftState, { state: 'answered' }> {
  return state.state === 'answered';
}
