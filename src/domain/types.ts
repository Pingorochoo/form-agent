/**
 * Provider-neutral domain types for form-agent.
 *
 * This module has zero dependencies (no I/O, no LLM, no DB). Everything the
 * Google Forms DOM parser (Phase 1), the semantic analyzer, the profile
 * generator and the answer layer produce or consume is a plain data type here.
 *
 * Design notes:
 * - Questions carry a `slot` (long-lived, form-relative position). IDs are
 *   structural and come from the parser; AnalysisCache persists by ID.
 * - `FormSchema` is the single persistence unit for structural analysis;
 *   `checksum` is its structural fingerprint.
 * - Structured questions (choice / dropdown / scale / rating / grid) carry
 *   normalized `choices` + aligned `options` so the answer layer can decide
 *   which VALID option fits the profile.
 * - Sections and page routing are first-class (`sections` + the routing graph),
 *   never flattened away; see the Phase 0 notes in docs/phase0.md.
 * - The `satisfies` guards at the bottom are compile-time witnesses that
 *   sample payloads conform; they double as documentation examples.
 */

import type { StructuralFingerprint } from './fingerprint.ts';

export const DOMAIN_PROVIDER_ID = 'google-forms' as const;

/**
 * Bumped whenever the FormSchema/Question shape changes in a way the Phase 1
 * parser (or persisted caches) must notice. Consumers compare this against the
 * DB `schema_version` column to invalidate stale structural caches.
 */
export const FORMS_SCHEMA_VERSION = 2;

/**
 * Implicit section id used when a form has no explicit page breaks. Every form
 * exposes at least one entry in `sections`, so navigation code never has to
 * special-case a sectionless form.
 */
export const DEFAULT_SECTION_ID = '__default__';

export function assertNever(value: never): never {
  throw new Error(`unreachable value: ${String(value)}`);
}

export type FormFieldId = string;
export type Confidence = 'low' | 'medium' | 'high';

/** Build a dotted id from parts; e.g. suffixId(['official-sample', 'q1']). */
export function suffixId(parts: Array<string | number>, join = '.'): string {
  return parts.join(join);
}

/** Join a title thread, dropping empty members. */
export function titleThread(parts: Array<string | undefined>, separator = ' — '): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(separator);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// --- structural types (appended in chunks) ---

/**
 * Structural types.
 *
 * A `FormSchema` is provider-neutral: the Google Forms DOM parser (Phase 1)
 * produces one; everything downstream (fingerprints, caches, semantic
 * analysis, profile generation, answering) consumes it. `slot` is the
 * form-relative, long-lived position (0-based); IDs must be stable across
 * analyses of the same form so that cache lookups and cross-question
 * relationships survive.
 */

export type RequiredMark = 'required' | 'optional';

export interface BaseQuestion {
  id: FormFieldId;
  slot: number;
  title: string;
  titleThread: string;
  kind: QuestionKind;
  required: RequiredMark;
  /** The title this question legitimately uses; may echo a sensitive field. */
  sensitive: boolean;
  /** Quiz-mode scoring, when this form is a quiz and scoring is exposed. */
  quiz?: QuizScoring;
  /** Extra context captured by the parser (retained for rollup/human review). */
  metadata?: Record<string, unknown>;
}

/**
 * The structural question kinds the FormSchema can represent.
 *
 * This list is deliberately a superset of what the MVP can *fill*. Phase 1
 * must classify every real Google Forms item into one of these (or
 * `unsupported`) so an unknown shape is never silently misclassified. Grids
 * are normalized into two explicit kinds (`multiple-choice-grid` = one answer
 * per row, `checkbox-grid` = many answers per row) rather than a runtime
 * `selectionMode` flag, because every downstream consumer branches on kind
 * already; `GridQuestion.selectionMode` re-exposes the same fact read-only for
 * the execution layer.
 */
export type QuestionKind = Question['kind'];

/**
 * One selectable option. `isOther` marks the free-text "Other" affordance that
 * Google appends to choice/checkbox/grid questions. `imageAlt` carries the
 * accessible name when an option is image-backed (no textual label).
 */
export interface ChoiceOption {
  label: string;
  isOther: boolean;
  imageAlt?: string;
}

/**
 * Response-validation metadata. Google only exposes some of this in rendered
 * markup (number bounds, text length, regex pattern) and the rest must be
 * flagged as `discoverable: false` rather than guessed. `kind: 'unknown'`
 * means a validator was detected structurally but its rule could not be read.
 */
export type ResponseValidation =
  | { kind: 'number'; min?: number; max?: number; discoverable: boolean }
  | { kind: 'text-length'; minLength?: number; maxLength?: number; discoverable: boolean }
  | { kind: 'regex'; pattern: string; discoverable: boolean }
  | { kind: 'unknown'; discoverable: false };

/** Quiz-mode scoring metadata, when the form is a quiz and it is exposed. */
export interface QuizScoring {
  points: number | null;
  correctChoices: string[];
  feedbackCorrect?: string;
  feedbackIncorrect?: string;
}

export interface FreeTextQuestion extends BaseQuestion {
  kind: 'text' | 'paragraph-text';
  placeholder?: string;
  inputType?: 'string' | 'email' | 'number' | 'phone' | 'url' | 'custom';
  lengthLimit?: number;
  validation?: ResponseValidation;
  quiz?: QuizScoring;
}

export interface ChoiceContainer {
  /** Human-readable labels, in rendered order. */
  choices: string[];
  /** Richer per-option metadata aligned 1:1 with `choices`. */
  options: ChoiceOption[];
  /** True when at least one option is an "Other" free-text affordance. */
  isOtherOpen: boolean;
  /** Labels of the "Other" affordance(s) (usually a single `Other`/`Otro`). */
  otherLabels: string[];
  validation?: ResponseValidation;
  quiz?: QuizScoring;
}

export interface SingleChoiceQuestion extends BaseQuestion, ChoiceContainer {
  kind: 'single-choice' | 'dropdown';
}

export interface MultiChoiceQuestion extends BaseQuestion, ChoiceContainer {
  kind: 'multi-choice';
  maxChoices?: number;
}

export interface LinearScaleQuestion extends BaseQuestion {
  kind: 'linear-scale';
  minLabel: string;
  maxLabel: string;
  minValue: number;
  maxValue: number;
  validation?: ResponseValidation;
}

/**
 * A single rating question covering both Google representations.
 *
 * `style` distinguishes star (numeric) from smiley/heart (symbolic) rendering.
 * Earlier drafts modelled `star-rating` and `smiley-rating` as separate kinds;
 * they are structurally identical (an ordinal 1..maxRating scale with no
 * endpoint labels), so they are one kind with a `style` discriminator rather
 * than two kinds the parser has to guess between.
 */
export type RatingStyle = 'star' | 'heart' | 'smiley' | 'thumb';

export interface RatingQuestion extends BaseQuestion {
  kind: 'rating';
  style: RatingStyle;
  /** Highest selectable value; ratings are ordinal 1..maxRating. */
  maxRating: number;
  validation?: ResponseValidation;
  quiz?: QuizScoring;
}

export interface GridRow {
  id: string;
  label: string;
}

export interface ChoiceGridQuestion extends BaseQuestion {
  kind: 'multiple-choice-grid' | 'checkbox-grid';
  rows: GridRow[];
  choices: string[];
  /** Aligned 1:1 with `choices`. */
  options: ChoiceOption[];
  isOtherOpen: boolean;
  /** Read-only restatement of the kind: `single` for choice, `multi` for checkbox. */
  selectionMode: 'single' | 'multi';
  /** Per-row "Other" text affordances, keyed by row id. */
  otherPerRow?: Record<string, boolean>;
  validation?: ResponseValidation;
  quiz?: QuizScoring;
}

export interface DateTimeQuestion extends BaseQuestion {
  kind: 'date' | 'time';
  /** Date-only in Google markup; the `time` kind adds a 24h time component. */
  includeDate: boolean;
  includeTime: boolean;
  includeYear: boolean;
  validation?: ResponseValidation;
}

/**
 * File upload (and any structurally sensitive upload-like type). Not fill-able
 * in the MVP; recognized so it is never mistaken for a text field. `supported`
 * is false when the type is deliberately out of scope for filling.
 */
export interface FileUploadQuestion extends BaseQuestion {
  kind: 'file-upload';
  maxFileSizeMb: number;
  maxFiles: number;
  allowedTypes: string[];
  supported: boolean;
}

/**
 * An explicitly unrecognized item. Phase 1 must land every item it cannot
 * classify here (with a raw hint) instead of coercing it into a supported
 * kind. Filling this kind is always a no-op; the analyzer surfaces it.
 */
export interface UnsupportedQuestion extends BaseQuestion {
  kind: 'unsupported';
  /** Best-effort description of the raw structure (e.g. a DOM/type hint). */
  rawTypeHint?: string;
  reason?: string;
}

export type Question =
  | FreeTextQuestion
  | SingleChoiceQuestion
  | MultiChoiceQuestion
  | LinearScaleQuestion
  | RatingQuestion
  | ChoiceGridQuestion
  | DateTimeQuestion
  | FileUploadQuestion
  | UnsupportedQuestion;

/**
 * A definitional item: a section divider (context) or an inline "Other"
 * open-text field added to a choice/grid question.
 */
export interface SectionBreak {
  type: 'section';
  /** Stable id; matches the corresponding `FormSection.id`. */
  id?: string;
  title: string;
  description?: string;
  slot: number;
}

export interface OtherOpenField {
  type: 'other-open';
  /** Slot as rendered (slotOfChoice + 0.5). */
  slot: number;
  /** Non-negative edge weighted by 0.1 per 0.5 slot step. */
  edgeWeight: number;
  parentQuestionId: FormFieldId;
}

/**
 * Section/page-break and routing model (first-class).
 *
 * Google Forms' page structure is a graph, not a list: each section normally
 * falls through to the next one, but any choice question may declare
 * "go to section based on answer" overrides, and some routes terminate by
 * submitting instead of advancing. Flattening this away loses real navigation
 * semantics, so the schema persists sections plus an explicit routing graph.
 *
 * Navigation is modelled with two sentinels rather than magic numbers:
 *   - `'submit'`   — terminal path: finish and submit.
 *   - `'continue'` — fall through to the next section in document order.
 * The analyzer resolves Google's "restart"/"back" targets into an explicit
 * section id or one of the sentinels; it never stores a raw index.
 */
export type NavigationTarget = string | 'submit' | 'continue';

/** A redirect attached to one answer of a choice question. */
export interface RoutingRule {
  /** The choice label that triggers this redirect. */
  choiceLabel: string;
  target: NavigationTarget;
}

/**
 * How a section advances when no answer-conditional rule fires.
 * `next` = document order; `submit` = terminal; `section` = a fixed jump.
 */
export interface SectionRouting {
  default: NavigationTarget;
  /** Allowed when this section's questions carry `goToSection` overrides. */
  conditional: boolean;
  /** Flattened, question-id-independent list of every redirect in this section. */
  rules: RoutingRule[];
}

export interface FormSection {
  id: string;
  slot: number;
  /** 0-based document position; sections[0] is the first page/header block. */
  index: number;
  title: string;
  description?: string;
  /** Question ids that belong to this section, in rendered order. */
  questionIds: FormFieldId[];
  routing: SectionRouting;
}

/** A non-question structural item that must survive flattening. */
export interface NonQuestionContent {
  type: 'text' | 'image-block' | 'video';
  slot: number;
  /** Section the content item belongs to (undefined when form-level). */
  sectionId?: string;
  title?: string;
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
}

export type Definitional = SectionBreak | OtherOpenField;

export interface FormSchemaMeta {
  url: string;
  title: string;
  description?: string;
  /** ISO-8601; from now() during a live fetch or from the fixture snapshot. */
  capturedAt: string;
  source: 'fixture';
  acceptResponsesUntil?: string;
  requiresSignIn: boolean;
}

export interface FormSchema {
  providerId: typeof DOMAIN_PROVIDER_ID;
  formId: string;
  /** Structural fingerprint produced from this same schema (check consistency). */
  checksum: StructuralFingerprint;
  schemaVersion: number;
  meta: FormSchemaMeta;
  title: string;
  description?: string;
  parts: Question[];
  definitional: Definitional[];
  questions: Record<FormFieldId, Question>;
  /** Sections/page breaks in document order (always >= 1; a sectionless form has one implicit section). */
  sections: FormSection[];
  /** Question id -> owning section id. */
  questionSection: Record<FormFieldId, string>;
  /** Non-question content preserved where structurally relevant. */
  nonQuestionContent: NonQuestionContent[];
  /** True when any section declares answer-conditional routing. */
  hasRouting: boolean;
  /** Terminal section ids whose default path submits (end of form). */
  terminalSectionIds: string[];
  rowCount: number;
  fieldCount: number;
  /** Minimal answer model for non-flattened structured inputs (Phase 3). */
  answerModel: 'flat' | 'grid' | 'multi-section';
}

export interface ResolvedFormSchema {
  schema: FormSchema;
  /** Original raw payload (kept for redaction rollup / debugging). */
  rawPayload?: unknown;
}

/** Slot used for "Other" open fields: slotOfChoice + 0.5. */
export function otherOpenSlot(parentSlot: number): number {
  return parentSlot + 0.5;
}

export function isFreeTextQuestion(q: Question): q is FreeTextQuestion {
  return q.kind === 'text' || q.kind === 'paragraph-text';
}

export function isChoiceQuestion(q: Question): q is SingleChoiceQuestion | MultiChoiceQuestion {
  return q.kind === 'single-choice' || q.kind === 'dropdown' || q.kind === 'multi-choice';
}

export function isGridQuestion(q: Question): q is ChoiceGridQuestion {
  return q.kind === 'multiple-choice-grid' || q.kind === 'checkbox-grid';
}

export function isDateOrTimeQuestion(q: Question): q is DateTimeQuestion {
  return q.kind === 'date' || q.kind === 'time';
}

export function isScaleQuestion(q: Question): q is LinearScaleQuestion | RatingQuestion {
  return q.kind === 'linear-scale' || q.kind === 'rating';
}

export function isRatingQuestion(q: Question): q is RatingQuestion {
  return q.kind === 'rating';
}

export function isUnsupportedQuestion(q: Question): q is UnsupportedQuestion {
  return q.kind === 'unsupported';
}

export function isFileUploadQuestion(q: Question): q is FileUploadQuestion {
  return q.kind === 'file-upload';
}

/**
 * Every question is expected to carry the same `options` shape as `choices`.
 * Returns true when the two are consistent (used by schema-validation tests and
 * by the Phase 1 parser as a self-check after classification).
 */
export function isConsistentChoiceContainer(
  q: Pick<ChoiceContainer, 'choices' | 'options' | 'isOtherOpen'>,
): boolean {
  if (q.choices.length !== q.options.length) return false;
  const hasOther = q.options.some((option) => option.isOther);
  return hasOther === q.isOtherOpen;
}

export function maxChoicesFor(question: Question): number | undefined {
  if (question.kind === 'multi-choice') return question.maxChoices ?? question.choices.length;
  if (question.kind === 'checkbox-grid') return question.choices.length;
  if (question.kind === 'multiple-choice-grid') return 1;
  if (isChoiceQuestion(question)) return 1;
  return undefined;
}

// ---------------------------------------------------------------------------
// Section / routing helpers.
// ---------------------------------------------------------------------------

/** The section that owns `questionId`, or undefined when the id is unknown. */
export function sectionOfQuestion(schema: FormSchema, questionId: FormFieldId): FormSection | undefined {
  const sectionId = schema.questionSection[questionId];
  if (sectionId === undefined) return undefined;
  return schema.sections.find((section) => section.id === sectionId);
}

/**
 * Resolve a navigation target to the concrete section it lands on.
 * `'continue'` walks document order; `'submit'` stays unresolved (null).
 */
export function resolveNavigationTarget(
  schema: FormSchema,
  fromSectionId: string,
  target: NavigationTarget,
): FormSection | null {
  if (target === 'submit') return null;
  if (target === 'continue') {
    const index = schema.sections.findIndex((section) => section.id === fromSectionId);
    return schema.sections[index + 1] ?? null;
  }
  return schema.sections.find((section) => section.id === target) ?? null;
}

/** Every section id reachable from the first section along routing edges. */
export function reachableSectionIds(schema: FormSchema): Set<string> {
  const result = new Set<string>();
  const first = schema.sections[0];
  if (first === undefined) return result;
  const queue: string[] = [first.id];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (result.has(id)) continue;
    result.add(id);
    const section = schema.sections.find((candidate) => candidate.id === id);
    if (section === undefined) continue;
    const targets = [section.routing.default, ...section.routing.rules.map((rule) => rule.target)];
    for (const target of targets) {
      const resolved = resolveNavigationTarget(schema, id, target);
      if (resolved !== null && !result.has(resolved.id)) queue.push(resolved.id);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Compile-time witness samples (also used by tests as canonical fixtures).
// ---------------------------------------------------------------------------

const sampleSingleChoice = {
  id: 'q1',
  slot: 0,
  title: 'How satisfied are you with your current role?',
  titleThread: 'Feedback — How satisfied are you with your current role?',
  kind: 'single-choice',
  required: 'required',
  sensitive: false,
  choices: ['Very satisfied', 'Satisfied', 'Neutral', 'Dissatisfied', 'Very dissatisfied'],
  options: ['Very satisfied', 'Satisfied', 'Neutral', 'Dissatisfied', 'Very dissatisfied'].map(
    (label) => ({ label, isOther: false }),
  ),
  isOtherOpen: false,
  otherLabels: [],
} as const satisfies SingleChoiceQuestion;

const sampleLinearScale = {
  id: 'q2',
  slot: 1,
  title: 'Rate your stress level this quarter',
  titleThread: 'Feedback — Rate your stress level this quarter',
  kind: 'linear-scale',
  required: 'optional',
  sensitive: false,
  minLabel: 'Low',
  maxLabel: 'High',
  minValue: 1,
  maxValue: 5,
} as const satisfies LinearScaleQuestion;

export const OFFICIAL_SAMPLE_FORMS = {
  sampleSingleChoice,
  sampleLinearScale,
} as const;