/**
 * Google Forms structural parser (Phase 1).
 *
 * Produces a provider-neutral `FormSchema` from the embedded
 * `FB_PUBLIC_LOAD_DATA_` payload of an authorized responder-page snapshot. It
 * is deterministic and offline: no network, no browser, no LLM, no submission.
 *
 * The payload is an undocumented, version-specific nested-array serialization.
 * The indices relied on here were observed on the authorized fixture and are
 * documented in `src/fixtures/observed-payload.ts`. Deferred/unknown structures
 * are handled conservatively and never guessed at:
 *
 *   - Type codes with a distinct payload value that Phase 1 does not parse
 *     (dropdown = 3, file-upload = 13, rating = 18) and any unknown type code
 *     become `{ kind: 'unsupported' }` with a raw hint.
 *   - Checkbox grids share type code 7 with single-select grids and are NOT
 *     distinguishable from this payload (the per-row role lives in the DOM,
 *     which this parser does not read). Every type-7 item is therefore emitted
 *     as `multiple-choice-grid` / `selectionMode: 'single'` — the only shape
 *     validated by the fixture. Checkbox-grid detection remains deferred.
 *   - Conditional section routing ("go to section based on answer") is deferred
 *     and not parsed. Routing is always emitted as the sequential
 *     `continue`/`submit` chain (`hasRouting === false`) that the fixture
 *     validates; no goToSection payload indices are read.
 *   - A malformed (non-array) payload item is a controlled `GoogleFormsParseError`,
 *     never silently skipped.
 *
 * Payload shape relied on here:
 *   payload  = [null, form, ...]
 *   form     = [description, items, ..., title(at 8), ...]
 *   item     = [id, title, description, type, group, ...]
 *   group[0] = [entryId, choices, requiredFlag, labelOrPlaceholder, ...]
 *     - linear scale: group[0][3] = [minLabel, maxLabel]
 *     - date:         group[0][7] = [includeTime, includeYear]
 *     - grid:         group[0..n] = [rowId, choices, requiredFlag, [rowLabel], ...]
 *   requiredFlag = 1 required, 0 optional
 */

import {
  DEFAULT_SECTION_ID,
  DOMAIN_PROVIDER_ID,
  FORMS_SCHEMA_VERSION,
  isGridQuestion,
  suffixId,
  titleThread,
  type BaseQuestion,
  type ChoiceGridQuestion,
  type ChoiceOption,
  type DateTimeQuestion,
  type FormSchema,
  type FormSchemaMeta,
  type FormSection,
  type FreeTextQuestion,
  type GridRow,
  type LinearScaleQuestion,
  type MultiChoiceQuestion,
  type Question,
  type SectionBreak,
  type SingleChoiceQuestion,
  type UnsupportedQuestion,
} from '../domain/types.ts';
import { structuralFingerprint } from '../domain/fingerprint.ts';
import { extractPayload } from '../fixtures/observed-payload.ts';

/**
 * Version of this parser/analyzer. Stamped into `form_schema.generator_version`
 * and the structural fingerprint so a parser change invalidates persisted
 * caches (see the Phase 0/1 cache design).
 */
export const GOOGLE_FORMS_PARSER_VERSION = '0.1.0';

/** Controlled parse failure (never an accidental TypeError / SyntaxError leak). */
export class GoogleFormsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleFormsParseError';
  }
}

export interface GoogleFormsParseOptions {
  /** Override `meta.url` (defaults to a fixture-style URL derived from formId). */
  url?: string;
  /** Override `meta.capturedAt` (defaults to `new Date().toISOString()`). */
  capturedAt?: string;
  /** Override the form id (defaults to the payload's embedded form path). */
  formId?: string;
}

/** Type codes this phase actually parses (validated against the fixture). */
const SUPPORTED_TYPE_CODES = new Set<number>([0, 1, 2, 4, 5, 7, 9, 10]);

/** Distinct type codes represented in the domain model but deferred (emitted as `unsupported`). */
const DEFERRED_TYPE_LABELS: Readonly<Record<number, string>> = {
  3: 'dropdown',
  13: 'file-upload',
  18: 'rating',
};

/** Type code of the definitional section/page break item. */
const SECTION_BREAK_TYPE = 6;

/** Raw item array (positionally indexed). */
type RawItem = unknown[];

/** Base question fields shared by every normalized kind. */
type QuestionBaseFields = Omit<BaseQuestion, 'kind'>;

interface SectionDraft {
  id: string;
  index: number;
  title: string;
  description: string;
  questionIds: string[];
}

interface ChoiceProjection {
  choices: string[];
  options: ChoiceOption[];
  isOtherOpen: boolean;
  otherLabels: string[];
}

/** Normalize a raw choice entry to its label (first tuple member, or a string). */
function choiceLabel(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
  return null;
}

function firstGroup(group: unknown): unknown[] | null {
  if (!Array.isArray(group)) return null;
  const first = group[0];
  return Array.isArray(first) ? first : null;
}

function isRequired(group: unknown, isGrid: boolean): boolean {
  if (isGrid) {
    return Array.isArray(group) && group.some((row) => Array.isArray(row) && row[2] === 1);
  }
  const group0 = firstGroup(group);
  return group0 !== null && group0[2] === 1;
}

function questionTitle(raw: RawItem): string {
  return typeof raw[1] === 'string' ? raw[1].trim() : '';
}

function sectionTitle(raw: RawItem): string {
  return typeof raw[1] === 'string' ? raw[1].trim() : '';
}

function sectionDescription(raw: RawItem): string {
  return typeof raw[2] === 'string' ? raw[2].trim() : '';
}

function formIdFromPayload(payload: unknown[]): string {
  const raw = payload[14];
  if (typeof raw === 'string' && raw.length > 0) {
    const last = raw.split('/').filter(Boolean).pop();
    if (last !== undefined && last.length > 0) return last;
    return raw;
  }
  return 'unknown-form';
}

/** Extract `choices`/`options` from a choice-like group. Other is deferred (never guessed). */
function extractChoices(group: unknown): ChoiceProjection {
  const group0 = firstGroup(group);
  const rawChoices = group0?.[1];
  const labels: string[] = [];
  if (Array.isArray(rawChoices)) {
    for (const entry of rawChoices) {
      const label = choiceLabel(entry);
      if (label !== null) labels.push(label);
    }
  }
  return {
    choices: labels,
    options: labels.map((label) => ({ label, isOther: false })),
    isOtherOpen: false,
    otherLabels: [],
  };
}

function buildBase(
  raw: RawItem,
  slot: number,
  sectionTitleText: string,
  required: boolean,
): QuestionBaseFields {
  const title = questionTitle(raw);
  return {
    id: String(raw[0]),
    slot,
    title,
    titleThread: titleThread([sectionTitleText, title]),
    required: required ? 'required' : 'optional',
    sensitive: false,
  };
}

function buildFreeText(base: QuestionBaseFields, kind: 'text' | 'paragraph-text'): FreeTextQuestion {
  return kind === 'text' ? { ...base, kind, inputType: 'string' } : { ...base, kind };
}

function buildSingleChoice(base: QuestionBaseFields, group: unknown): SingleChoiceQuestion {
  return { ...base, kind: 'single-choice', ...extractChoices(group) };
}

function buildMultiChoice(base: QuestionBaseFields, group: unknown): MultiChoiceQuestion {
  return { ...base, kind: 'multi-choice', ...extractChoices(group) };
}

function buildLinearScale(base: QuestionBaseFields, group: unknown): LinearScaleQuestion {
  const group0 = firstGroup(group);
  const labelTuple = group0?.[3];
  const minLabel = Array.isArray(labelTuple) && typeof labelTuple[0] === 'string' ? labelTuple[0] : '';
  const maxLabel = Array.isArray(labelTuple) && typeof labelTuple[1] === 'string' ? labelTuple[1] : '';
  const { choices } = extractChoices(group);
  // The validated fixture's step labels are the numeric values themselves
  // ("1".."5"), so derive bounds from them instead of assuming a 1-based
  // scale. Fall back to a 1-based range only when no numeric labels exist.
  const numeric = numericStepValues(choices);
  return {
    ...base,
    kind: 'linear-scale',
    minLabel,
    maxLabel,
    minValue: numeric.length > 0 ? Math.min(...numeric) : 1,
    maxValue: numeric.length > 0 ? Math.max(...numeric) : Math.max(choices.length, 1),
  };
}

/** Parse numeric linear-scale step labels into numbers (empty/NaN labels skipped). */
function numericStepValues(choices: string[]): number[] {
  const values: number[] = [];
  for (const label of choices) {
    if (label.trim() === '') continue;
    const value = Number(label);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

function buildGrid(base: QuestionBaseFields, group: unknown): ChoiceGridQuestion {
  // Type 7 covers both single- and multi-select grids in Google Forms. The
  // payload does not encode the per-row role (that lives in DOM `role=radio`
  // vs `role=checkbox`, which this parser does not read), so selection mode
  // cannot be read from it. Every type-7 item is emitted as
  // `multiple-choice-grid` / `selectionMode: 'single'` — the only shape
  // validated by the fixture. Checkbox-grid detection remains deferred.
  const rows: GridRow[] = [];
  let choices: string[] = [];
  if (Array.isArray(group)) {
    for (let i = 0; i < group.length; i++) {
      const row = group[i];
      if (!Array.isArray(row)) continue;
      const label = choiceLabel(row[3]) ?? '';
      rows.push({ id: suffixId([base.id, `r${i + 1}`]), label });
      if (i === 0 && Array.isArray(row[1])) {
        const rowChoices: string[] = [];
        for (const entry of row[1]) {
          const choice = choiceLabel(entry);
          if (choice !== null) rowChoices.push(choice);
        }
        choices = rowChoices;
      }
    }
  }
  return {
    ...base,
    kind: 'multiple-choice-grid',
    rows,
    choices,
    options: choices.map((label) => ({ label, isOther: false })),
    isOtherOpen: false,
    selectionMode: 'single',
  };
}

function buildDateTime(base: QuestionBaseFields, kind: 'date' | 'time', group: unknown): DateTimeQuestion {
  if (kind === 'date') {
    const group0 = firstGroup(group);
    const flags = group0?.[7];
    const includeTime = Array.isArray(flags) && flags[0] === 1;
    const includeYear = !Array.isArray(flags) || flags[1] === 1;
    return { ...base, kind: 'date', includeDate: true, includeTime, includeYear };
  }
  return { ...base, kind: 'time', includeDate: false, includeTime: true, includeYear: false };
}

function buildUnsupported(base: QuestionBaseFields, rawType: number): UnsupportedQuestion {
  const deferredLabel = DEFERRED_TYPE_LABELS[rawType];
  return {
    ...base,
    kind: 'unsupported',
    rawTypeHint: `google-form-item-type:${rawType}`,
    reason: deferredLabel
      ? `deferred: ${deferredLabel} is not validated in Phase 1`
      : 'unrecognized Google Forms item type',
  };
}

function normalizeQuestion(raw: RawItem, sectionTitleText: string, slot: number): Question {
  const rawType = raw[3];
  if (typeof rawType !== 'number') {
    return {
      ...buildBase(raw, slot, sectionTitleText, false),
      kind: 'unsupported',
      rawTypeHint: 'google-form-item-missing-type',
      reason: 'item has no numeric type code',
    };
  }

  const group = raw[4];
  const isGrid = rawType === 7;
  const required = isRequired(group, isGrid);
  const base = buildBase(raw, slot, sectionTitleText, required);

  if (!SUPPORTED_TYPE_CODES.has(rawType)) {
    return buildUnsupported(base, rawType);
  }

  switch (rawType) {
    case 0:
      return buildFreeText(base, 'text');
    case 1:
      return buildFreeText(base, 'paragraph-text');
    case 2:
      return buildSingleChoice(base, group);
    case 4:
      return buildMultiChoice(base, group);
    case 5:
      return buildLinearScale(base, group);
    case 7:
      return buildGrid(base, group);
    case 9:
      return buildDateTime(base, 'date', group);
    case 10:
      return buildDateTime(base, 'time', group);
    default:
      return buildUnsupported(base, rawType);
  }
}

function deriveAnswerModel(sectionCount: number, hasGrids: boolean): FormSchema['answerModel'] {
  if (sectionCount > 1) return 'multi-section';
  if (hasGrids) return 'grid';
  return 'flat';
}

/**
 * The structural projection that is fingerprinted (and used as the golden
 * fixture). It excludes ephemeral metadata (`meta.url`, `meta.capturedAt`) and
 * the self-referential `checksum` so the fingerprint is stable under re-parse
 * and key re-ordering, while remaining sensitive to any real structural change.
 */
export function structuralProjection(schema: Omit<FormSchema, 'checksum'>): unknown {
  return {
    title: schema.title,
    description: schema.description,
    sections: schema.sections,
    parts: schema.parts,
    questionSection: schema.questionSection,
    definitional: schema.definitional,
    hasRouting: schema.hasRouting,
    terminalSectionIds: schema.terminalSectionIds,
  };
}

function computeChecksum(schema: Omit<FormSchema, 'checksum'>): string {
  return structuralFingerprint({
    providerId: schema.providerId,
    formId: schema.formId,
    formJson: structuralProjection(schema),
    generatorVersion: GOOGLE_FORMS_PARSER_VERSION,
  });
}

function buildSchema(payload: unknown[], options: GoogleFormsParseOptions): Omit<FormSchema, 'checksum'> {
  const form = payload[1];
  if (!Array.isArray(form)) throw new GoogleFormsParseError('payload[1] (form) is not an array');
  const items = form[1];
  if (!Array.isArray(items)) throw new GoogleFormsParseError('form[1] (items) is not an array');

  const description = typeof form[0] === 'string' ? form[0] : '';
  const title = typeof form[8] === 'string' ? form[8] : '';
  const formId = options.formId ?? formIdFromPayload(payload);

  const drafts: SectionDraft[] = [];
  const parts: Question[] = [];
  const definitional: SectionBreak[] = [];

  let current: SectionDraft | null = null;
  let questionSlot = 0;

  const ensureSection = (): SectionDraft => {
    if (current !== null) return current;
    const implicit: SectionDraft = {
      id: DEFAULT_SECTION_ID,
      index: drafts.length,
      title: '',
      description: '',
      questionIds: [],
    };
    drafts.push(implicit);
    current = implicit;
    return implicit;
  };

  for (const [index, raw] of items.entries()) {
    if (!Array.isArray(raw)) {
      throw new GoogleFormsParseError(`form[1][${index}] is not an array (malformed item)`);
    }
    if (raw[3] === SECTION_BREAK_TYPE) {
      const draft: SectionDraft = {
        id: String(raw[0]),
        index: drafts.length,
        title: sectionTitle(raw),
        description: sectionDescription(raw),
        questionIds: [],
      };
      current = draft;
      drafts.push(draft);
      definitional.push({
        type: 'section',
        id: draft.id,
        title: draft.title,
        ...(draft.description !== '' ? { description: draft.description } : {}),
        slot: draft.index,
      });
      continue;
    }
    const section = ensureSection();
    const question = normalizeQuestion(raw, section.title, questionSlot++);
    parts.push(question);
    section.questionIds.push(question.id);
  }

  if (drafts.length === 0) ensureSection();

  // Routing is sequential only: each non-terminal section continues and the
  // final section submits. Conditional ("go to section based on answer")
  // routing is deferred in Phase 1 and not detected (no goToSection payload
  // indices are read), so `hasRouting`/`conditional` are always false here.
  const sections: FormSection[] = drafts.map((draft, index) => ({
    id: draft.id,
    slot: draft.index,
    index: draft.index,
    title: draft.title,
    ...(draft.description !== '' ? { description: draft.description } : {}),
    questionIds: draft.questionIds,
    routing: {
      default: (index === drafts.length - 1 ? 'submit' : 'continue') as FormSection['routing']['default'],
      conditional: false,
      rules: [],
    },
  }));

  const questions: Record<string, Question> = {};
  for (const question of parts) questions[question.id] = question;

  const questionSection: Record<string, string> = {};
  for (const section of sections) {
    for (const questionId of section.questionIds) questionSection[questionId] = section.id;
  }

  const gridRowCount = parts.reduce((sum, question) => sum + (isGridQuestion(question) ? question.rows.length : 0), 0);
  const hasGrids = parts.some(isGridQuestion);

  const meta: FormSchemaMeta = {
    url: options.url ?? `https://fixtures.local/forms/${formId}`,
    title,
    ...(description !== '' ? { description } : {}),
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    source: 'fixture',
    requiresSignIn: false,
  };

  return {
    providerId: DOMAIN_PROVIDER_ID,
    formId,
    schemaVersion: FORMS_SCHEMA_VERSION,
    meta,
    title,
    ...(description !== '' ? { description } : {}),
    parts,
    definitional,
    questions,
    sections,
    questionSection,
    nonQuestionContent: [],
    hasRouting: sections.some((section) => section.routing.conditional),
    terminalSectionIds: sections.filter((section) => section.routing.default === 'submit').map((section) => section.id),
    rowCount: gridRowCount,
    fieldCount: parts.length,
    answerModel: deriveAnswerModel(sections.length, hasGrids),
  };
}

/** Build a `FormSchema` (including checksum) from an extracted payload array. */
export function buildFormSchema(payload: unknown[], options: GoogleFormsParseOptions = {}): FormSchema {
  const schema = buildSchema(payload, options);
  return { ...schema, checksum: computeChecksum(schema) };
}

/** Parse archived responder-page HTML into a provider-neutral `FormSchema`. */
export function parseGoogleFormsHtml(html: string, options: GoogleFormsParseOptions = {}): FormSchema {
  let payload: unknown[];
  try {
    payload = extractPayload(html);
  } catch (err) {
    throw new GoogleFormsParseError(
      err instanceof Error ? err.message : `failed to extract embedded payload: ${String(err)}`,
    );
  }
  return buildFormSchema(payload, options);
}
