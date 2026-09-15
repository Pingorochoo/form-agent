/**
 * Minimal synthetic-schema builders for Phase 3 edge-case tests.
 *
 * Phase 3 uses the accepted sanitized fixture only for integration/regression;
 * synthetic schemas (built here) exercise sensitivity, completeness, and
 * structural-validation edge cases without touching the real form.
 */

import {
  DOMAIN_PROVIDER_ID,
  FORMS_SCHEMA_VERSION,
  type FormSchema,
  type FreeTextQuestion,
  type Question,
  type UnsupportedQuestion,
} from '../../src/domain/types.ts';

export function textQ(
  id: string,
  title: string,
  required: 'required' | 'optional' = 'optional',
): FreeTextQuestion {
  return { id, slot: 0, title, titleThread: title, kind: 'text', required, sensitive: false, inputType: 'string' };
}

export function unsupportedQ(
  id: string,
  title: string,
  required: 'required' | 'optional' = 'optional',
): UnsupportedQuestion {
  return {
    id,
    slot: 0,
    title,
    titleThread: title,
    kind: 'unsupported',
    required,
    sensitive: false,
    rawTypeHint: 'google-form-item-type:99',
    reason: 'unrecognized Google Forms item type',
  };
}

/** Assemble a one-section synthetic schema (flat answer model). */
export function makeSchema(questions: Question[], formId = 'phase3-synthetic'): FormSchema {
  const byId: Record<string, Question> = {};
  const questionSection: Record<string, string> = {};
  for (const q of questions) {
    byId[q.id] = q;
    questionSection[q.id] = 's0';
  }
  return {
    providerId: DOMAIN_PROVIDER_ID,
    formId,
    checksum: '0'.repeat(64),
    schemaVersion: FORMS_SCHEMA_VERSION,
    meta: {
      url: `https://fixtures.local/forms/${formId}`,
      title: 'Phase 3 synthetic schema',
      capturedAt: '2026-01-01T00:00:00.000Z',
      source: 'fixture',
      requiresSignIn: false,
    },
    title: 'Phase 3 synthetic schema',
    parts: questions,
    definitional: [{ type: 'section', id: 's0', title: 'Section', slot: 0 }],
    questions: byId,
    sections: [
      {
        id: 's0',
        slot: 0,
        index: 0,
        title: 'Section',
        questionIds: questions.map((q) => q.id),
        routing: { default: 'submit', conditional: false, rules: [] },
      },
    ],
    questionSection,
    nonQuestionContent: [],
    hasRouting: false,
    terminalSectionIds: ['s0'],
    rowCount: 0,
    fieldCount: questions.length,
    answerModel: 'flat',
  };
}
