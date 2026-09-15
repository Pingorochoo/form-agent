/**
 * Synthetic-schema builders for Phase 4 edge-case tests.
 *
 * Phase 4 uses the accepted sanitized fixture only for integration/regression;
 * synthetic schemas (built here) exercise integrity, profile-conformance, and
 * relationship edge cases precisely without touching the real form. Bundles are
 * produced by the accepted deterministic reference provider (`generateDraft`)
 * and then mutated for specific mismatch scenarios — the gate never mutates.
 */

import {
  DOMAIN_PROVIDER_ID,
  FORMS_SCHEMA_VERSION,
  type ChoiceGridQuestion,
  type DateTimeQuestion,
  type FormSchema,
  type FreeTextQuestion,
  type LinearScaleQuestion,
  type MultiChoiceQuestion,
  type Question,
  type SingleChoiceQuestion,
} from '../../src/domain/types.ts';

export const DEFAULT_CHECKSUM = 'a'.repeat(64);
export const OTHER_CHECKSUM = 'b'.repeat(64);

interface BaseFields {
  id: string;
  slot: number;
  title: string;
  titleThread: string;
  required: 'required' | 'optional';
  sensitive: boolean;
}

function base(
  id: string,
  slot: number,
  title: string,
  required: 'required' | 'optional' = 'optional',
): BaseFields {
  return { id, slot, title, titleThread: title, required, sensitive: false };
}

export function textQ(
  id: string,
  slot: number,
  title: string,
  required: 'required' | 'optional' = 'optional',
): FreeTextQuestion {
  return { ...base(id, slot, title, required), kind: 'text', inputType: 'string' };
}

export function singleChoiceQ(
  id: string,
  slot: number,
  title: string,
  choices: string[],
  required: 'required' | 'optional' = 'optional',
): SingleChoiceQuestion {
  return {
    ...base(id, slot, title, required),
    kind: 'single-choice',
    choices,
    options: choices.map((label) => ({ label, isOther: false })),
    isOtherOpen: false,
    otherLabels: [],
  };
}

export function linearScaleQ(
  id: string,
  slot: number,
  title: string,
  required: 'required' | 'optional' = 'optional',
): LinearScaleQuestion {
  return { ...base(id, slot, title, required), kind: 'linear-scale', minLabel: 'Low', maxLabel: 'High', minValue: 1, maxValue: 5 };
}

export function multiChoiceQ(
  id: string,
  slot: number,
  title: string,
  choices: string[],
  required: 'required' | 'optional' = 'optional',
): MultiChoiceQuestion {
  return {
    ...base(id, slot, title, required),
    kind: 'multi-choice',
    choices,
    options: choices.map((label) => ({ label, isOther: false })),
    isOtherOpen: false,
    otherLabels: [],
  };
}

export function gridQ(
  id: string,
  slot: number,
  title: string,
  rows: string[],
  choices: string[],
  required: 'required' | 'optional' = 'optional',
): ChoiceGridQuestion {
  return {
    ...base(id, slot, title, required),
    kind: 'multiple-choice-grid',
    rows: rows.map((label, index) => ({ id: `${id}.r${index + 1}`, label })),
    choices,
    options: choices.map((label) => ({ label, isOther: false })),
    isOtherOpen: false,
    selectionMode: 'single',
  };
}

export function dateQ(
  id: string,
  slot: number,
  title: string,
  required: 'required' | 'optional' = 'optional',
): DateTimeQuestion {
  return {
    ...base(id, slot, title, required),
    kind: 'date',
    includeDate: true,
    includeTime: false,
    includeYear: true,
  };
}

export function timeQ(
  id: string,
  slot: number,
  title: string,
  required: 'required' | 'optional' = 'optional',
): DateTimeQuestion {
  return {
    ...base(id, slot, title, required),
    kind: 'time',
    includeDate: false,
    includeTime: true,
    includeYear: false,
  };
}

export interface SectionSpec {
  id: string;
  title: string;
  questionIds: string[];
}

export interface SchemaOptions {
  formId?: string;
  checksum?: string;
  sections?: SectionSpec[];
}

/** Assemble a synthetic schema; sections default to a single section. */
export function makeSchema(questions: Question[], options: SchemaOptions = {}): FormSchema {
  const formId = options.formId ?? 'phase4-synthetic';
  const checksum = options.checksum ?? DEFAULT_CHECKSUM;
  const sections: SectionSpec[] =
    options.sections ?? [{ id: 's0', title: 'Section', questionIds: questions.map((q) => q.id) }];

  const byId: Record<string, Question> = {};
  const questionSection: Record<string, string> = {};
  for (const q of questions) byId[q.id] = q;
  for (const section of sections) {
    for (const id of section.questionIds) questionSection[id] = section.id;
  }

  return {
    providerId: DOMAIN_PROVIDER_ID,
    formId,
    checksum,
    schemaVersion: FORMS_SCHEMA_VERSION,
    meta: {
      url: `https://fixtures.local/forms/${formId}`,
      title: 'Phase 4 synthetic schema',
      capturedAt: '2026-01-01T00:00:00.000Z',
      source: 'fixture',
      requiresSignIn: false,
    },
    title: 'Phase 4 synthetic schema',
    parts: questions,
    definitional: sections.map((s, index) => ({ type: 'section', id: s.id, title: s.title, slot: index })),
    questions: byId,
    sections: sections.map((s, index) => ({
      id: s.id,
      slot: index,
      index,
      title: s.title,
      questionIds: s.questionIds,
      routing: { default: index === sections.length - 1 ? 'submit' : 'continue', conditional: false, rules: [] },
    })),
    questionSection,
    nonQuestionContent: [],
    hasRouting: false,
    terminalSectionIds: [sections[sections.length - 1]?.id ?? 's0'],
    rowCount: 0,
    fieldCount: questions.length,
    answerModel: sections.length > 1 ? 'multi-section' : 'flat',
  };
}
