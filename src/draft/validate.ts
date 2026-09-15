/**
 * Provider-neutral structural/semantic validation (P3-R4, P3-R10).
 *
 * The semantic/draft provider is never trusted to invent structural
 * identifiers. Every proposal is validated against the real `FormSchema`
 * before it can become an accepted answer or a trusted semantic model.
 *
 * - `validateDraftValue` returns a normalized valid value or a reason (a
 *   structurally invalid proposal is never promoted to `answered`).
 * - `validateSemanticModel` and `validateSyntheticProfile` throw a controlled
 *   `DraftValidationError` when provider output references structural objects
 *   that do not exist, contains duplicate/malformed references, or is missing
 *   required synthetic provenance.
 */

import type { FormSchema, Question } from '../domain/types.ts';
import type { DraftDateValue, DraftTimeValue, DraftValue } from '../domain/draft.ts';
import type { SemanticModel } from '../domain/semantic.ts';
import { DraftValidationError } from './errors.ts';

export type DraftValueValidation =
  | { ok: true; value: DraftValue }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/** Validate the accepted Phase 3 date representation (real calendar). */
export function isValidDateValue(value: unknown): value is DraftDateValue {
  if (!isRecord(value)) return false;
  const { year, month, day } = value as Record<string, unknown>;
  if (!isInteger(year) || !isInteger(month) || !isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  return day <= daysInMonth(year, month);
}

/** Validate the accepted Phase 3 time representation (24-hour clock). */
export function isValidTimeValue(value: unknown): value is DraftTimeValue {
  if (!isRecord(value)) return false;
  const { hour, minute } = value as Record<string, unknown>;
  if (!isInteger(hour) || !isInteger(minute)) return false;
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/**
 * Validate a provider-proposed value against its actual question definition.
 *
 * Deterministic normalization rule for `multi-choice`: duplicate selections
 * are de-duplicated in first-seen order (they never survive validated output);
 * invented choices fail validation outright.
 */
export function validateDraftValue(value: unknown, question: Question): DraftValueValidation {
  if (!isRecord(value)) {
    return { ok: false, reason: 'draft proposal must be an object with a kind discriminator' };
  }
  const kind = value['kind'];
  if (typeof kind !== 'string') {
    return { ok: false, reason: 'draft proposal is missing a string kind discriminator' };
  }
  if (kind !== question.kind) {
    return { ok: false, reason: 'draft proposal kind does not match the question kind' };
  }
  const proposed = value['value'];

  switch (question.kind) {
    case 'text':
    case 'paragraph-text': {
      if (typeof proposed !== 'string' || proposed.trim() === '') {
        return { ok: false, reason: `${question.kind} answer must be a non-empty string` };
      }
      return { ok: true, value: { kind: question.kind, value: proposed } };
    }
    case 'single-choice': {
      if (typeof proposed !== 'string' || !question.choices.includes(proposed)) {
        return { ok: false, reason: 'single-choice answer must be one of the question choices' };
      }
      return { ok: true, value: { kind: 'single-choice', value: proposed } };
    }
    case 'multi-choice': {
      if (!Array.isArray(proposed)) {
        return { ok: false, reason: 'multi-choice answer must be an array of choice labels' };
      }
      if (proposed.length === 0) {
        return { ok: false, reason: 'multi-choice answer must select at least one choice' };
      }
      const selected: string[] = [];
      const seen = new Set<string>();
      for (const item of proposed) {
        if (typeof item !== 'string' || !question.choices.includes(item)) {
          return { ok: false, reason: 'multi-choice answer contains an unknown choice' };
        }
        if (!seen.has(item)) {
          seen.add(item);
          selected.push(item);
        }
      }
      return { ok: true, value: { kind: 'multi-choice', value: selected } };
    }
    case 'linear-scale': {
      if (!isInteger(proposed)) {
        return { ok: false, reason: 'linear-scale answer must be an integer' };
      }
      if (proposed < question.minValue || proposed > question.maxValue) {
        return { ok: false, reason: 'linear-scale answer is outside the accepted range' };
      }
      return { ok: true, value: { kind: 'linear-scale', value: proposed } };
    }
    case 'multiple-choice-grid': {
      if (!isRecord(proposed)) {
        return { ok: false, reason: 'grid answer must be an object mapping row ids to column labels' };
      }
      const entries = Object.entries(proposed);
      if (entries.length === 0) {
        return { ok: false, reason: 'grid answer must not be empty' };
      }
      const rowIds = new Set(question.rows.map((row) => row.id));
      const grid: Record<string, string> = {};
      for (const [rowId, column] of entries) {
        if (!rowIds.has(rowId)) {
          return { ok: false, reason: 'grid answer references an unknown row' };
        }
        if (typeof column !== 'string' || !question.choices.includes(column)) {
          return { ok: false, reason: 'grid answer references an unknown column' };
        }
        grid[rowId] = column;
      }
      if (question.required === 'required' && question.rows.some((row) => grid[row.id] === undefined)) {
        return { ok: false, reason: 'required grid answer must provide a selection for every row' };
      }
      return { ok: true, value: { kind: 'multiple-choice-grid', value: grid } };
    }
    case 'date': {
      if (!isValidDateValue(proposed)) {
        return { ok: false, reason: 'date answer must be {year, month, day} with a valid calendar date' };
      }
      return { ok: true, value: { kind: 'date', value: proposed } };
    }
    case 'time': {
      if (!isValidTimeValue(proposed)) {
        return { ok: false, reason: 'time answer must be {hour, minute} with hour 0-23 and minute 0-59' };
      }
      return { ok: true, value: { kind: 'time', value: proposed } };
    }
    default:
      return { ok: false, reason: 'unsupported question kind' };
  }
}

/**
 * Validate whole-form semantic provider output against the schema (P3-R4).
 *
 * The Phase 3 validator enforces stronger provider-output requirements than the
 * shared domain type (where `sections` is optional): every schema question and
 * every schema section must be represented exactly once, entries must be
 * objects whose embedded id matches their record key, relationships must
 * reference real questions without duplicates, and `structuredQuestionTags`
 * must cover every schema question with non-empty string tags and no unknown
 * ids. All error text is stable and never echoes untrusted provider values.
 */
export function validateSemanticModel(model: unknown, schema: FormSchema): void {
  if (!isRecord(model)) {
    throw new DraftValidationError('semantic provider output must be an object');
  }

  const questions = model['questions'];
  if (!isRecord(questions)) {
    throw new DraftValidationError('semantic model must include a questions record');
  }
  const knownQuestionIds = new Set(Object.keys(schema.questions));
  for (const questionId of knownQuestionIds) {
    if (!(questionId in questions)) {
      throw new DraftValidationError('semantic model is missing a question entry');
    }
  }
  for (const [questionId, entry] of Object.entries(questions)) {
    if (!knownQuestionIds.has(questionId)) {
      throw new DraftValidationError('semantic model references an unknown question id');
    }
    if (!isRecord(entry)) {
      throw new DraftValidationError('semantic question entry must be an object');
    }
    if (entry['questionId'] !== questionId) {
      throw new DraftValidationError('semantic question entry id does not match its record key');
    }
    const relationships = entry['relationships'];
    if (!Array.isArray(relationships)) {
      throw new DraftValidationError('semantic relationships must be an array');
    }
    const seen = new Set<string>();
    for (const rel of relationships) {
      if (!isRecord(rel)) {
        throw new DraftValidationError('semantic relationship must be an object');
      }
      const other = rel['otherQuestionId'];
      if (typeof other !== 'string' || !knownQuestionIds.has(other)) {
        throw new DraftValidationError('semantic relationship references an unknown question id');
      }
      const key = `${String(rel['kind'])}:${other}`;
      if (seen.has(key)) {
        throw new DraftValidationError('duplicate semantic relationship');
      }
      seen.add(key);
    }
  }

  const sections = model['sections'];
  if (!isRecord(sections)) {
    throw new DraftValidationError('semantic model must include a sections record');
  }
  const knownSectionIds = new Set(schema.sections.map((section) => section.id));
  for (const sectionId of knownSectionIds) {
    if (!(sectionId in sections)) {
      throw new DraftValidationError('semantic model is missing a section entry');
    }
  }
  for (const [sectionId, entry] of Object.entries(sections)) {
    if (!knownSectionIds.has(sectionId)) {
      throw new DraftValidationError('semantic model references an unknown section id');
    }
    if (!isRecord(entry)) {
      throw new DraftValidationError('semantic section entry must be an object');
    }
    if (entry['sectionId'] !== sectionId) {
      throw new DraftValidationError('semantic section entry id does not match its record key');
    }
  }

  const tags = model['structuredQuestionTags'];
  if (!isRecord(tags)) {
    throw new DraftValidationError('semantic model must include a structuredQuestionTags record');
  }
  for (const [questionId, tag] of Object.entries(tags)) {
    if (!knownQuestionIds.has(questionId)) {
      throw new DraftValidationError('structuredQuestionTags references an unknown question id');
    }
    if (typeof tag !== 'string' || tag.trim() === '') {
      throw new DraftValidationError('structuredQuestionTags value must be a non-empty string');
    }
  }
  for (const questionId of knownQuestionIds) {
    if (!(questionId in tags)) {
      throw new DraftValidationError('structuredQuestionTags is missing a question entry');
    }
  }
}

/**
 * Validate synthetic-profile provider output (P3-R5, P3-R12). The profile must
 * be explicitly synthetic, belong to the accepted form, and agree with the
 * semantic model it was derived from. Throws `DraftValidationError` otherwise.
 */
export function validateSyntheticProfile(
  profile: unknown,
  schema: FormSchema,
  semantics: SemanticModel,
): void {
  if (!isRecord(profile)) {
    throw new DraftValidationError('profile provider output must be an object');
  }
  if (profile['synthetic'] !== true) {
    throw new DraftValidationError('synthetic profile must be explicitly marked synthetic');
  }
  if (profile['formId'] !== schema.formId) {
    throw new DraftValidationError('synthetic profile formId does not match the accepted schema');
  }
  if (typeof profile['profileId'] !== 'string' || profile['profileId'].trim() === '') {
    throw new DraftValidationError('synthetic profile must include a non-empty profileId');
  }
  const expectedSemanticModelId =
    typeof semantics.metadata?.semanticModelId === 'string' ? semantics.metadata.semanticModelId : undefined;
  if (expectedSemanticModelId !== undefined && profile['semanticModelId'] !== expectedSemanticModelId) {
    throw new DraftValidationError('synthetic profile semanticModelId does not match the semantic model');
  }
}
