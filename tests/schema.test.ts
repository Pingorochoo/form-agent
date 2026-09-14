/**
 * FormSchema coverage tests (Phase 0 follow-ups #2 and #3).
 *
 * Verifies that the domain model can structurally represent every question
 * kind and navigation shape Phase 0 requires, and that no kind is silently
 * misclassified.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SECTION_ID,
  FORMS_SCHEMA_VERSION,
  isChoiceQuestion,
  isConsistentChoiceContainer,
  isFileUploadQuestion,
  isFreeTextQuestion,
  isGridQuestion,
  isRatingQuestion,
  isScaleQuestion,
  isUnsupportedQuestion,
  maxChoicesFor,
  reachableSectionIds,
  resolveNavigationTarget,
  sectionOfQuestion,
  type Question,
  type QuestionKind,
} from '../src/domain/types.ts';
import {
  allQuestionKinds,
  buildObservedFormSchema,
  buildRoutedSchema,
  buildSectionlessSchema,
} from './support/sample-schema.ts';

/** Every kind Phase 0 must structurally represent. */
const REQUIRED_KINDS: QuestionKind[] = [
  'text',
  'paragraph-text',
  'single-choice',
  'multi-choice',
  'dropdown',
  'linear-scale',
  'rating',
  'multiple-choice-grid',
  'checkbox-grid',
  'date',
  'time',
  'file-upload',
  'unsupported',
];

describe('FormSchema — question kind coverage', () => {
  const kinds = allQuestionKinds();
  const byKind = new Map(kinds.map((q) => [q.kind, q] as const));

  it('represents every required kind exactly once', () => {
    expect([...byKind.keys()].sort()).toEqual([...REQUIRED_KINDS].sort());
  });

  it('has an explicit rating (not star/smiley split)', () => {
    const rating = byKind.get('rating') as Question;
    expect(isRatingQuestion(rating)).toBe(true);
    expect(isScaleQuestion(rating)).toBe(true);
    expect((rating as { style: string }).style).toBe('star');
    expect((rating as { maxRating: number }).maxRating).toBe(5);
  });

  it('groups grids into two kinds with an explicit selectionMode', () => {
    const choice = byKind.get('multiple-choice-grid') as Question;
    const checkbox = byKind.get('checkbox-grid') as Question;
    expect(isGridQuestion(choice)).toBe(true);
    expect(isGridQuestion(checkbox)).toBe(true);
    expect((choice as { selectionMode: string }).selectionMode).toBe('single');
    expect((checkbox as { selectionMode: string }).selectionMode).toBe('multi');
    expect(maxChoicesFor(choice)).toBe(1);
  });

  it('classifies each kind through the right guard', () => {
    expect(isFreeTextQuestion(byKind.get('text') as Question)).toBe(true);
    expect(isFreeTextQuestion(byKind.get('paragraph-text') as Question)).toBe(true);
    expect(isChoiceQuestion(byKind.get('dropdown') as Question)).toBe(true);
    expect(isChoiceQuestion(byKind.get('multi-choice') as Question)).toBe(true);
    expect(isFileUploadQuestion(byKind.get('file-upload') as Question)).toBe(true);
    expect(isUnsupportedQuestion(byKind.get('unsupported') as Question)).toBe(true);
  });

  it('represents Other/free-text choices with metadata', () => {
    const other = byKind.get('multi-choice') as { isOtherOpen: boolean; otherLabels: string[] };
    expect(other.isOtherOpen).toBe(true);
    expect(other.otherLabels).toEqual(['Otro']);
  });

  it('keeps choices and options aligned (self-check helper)', () => {
    for (const q of kinds) {
      if (isChoiceQuestion(q) || isGridQuestion(q)) {
        expect(isConsistentChoiceContainer(q)).toBe(true);
      }
    }
  });

  it('carries required vs optional and validation/quiz metadata', () => {
    expect(byKind.get('text')?.required).toBe('required');
    expect(byKind.get('rating')?.required).toBe('required');
    expect(byKind.get('single-choice')?.required).toBe('optional');
    const date = byKind.get('date') as { validation?: { kind: string } };
    expect(date.validation?.kind).toBe('text-length');
    const single = byKind.get('single-choice') as { quiz?: { points: number | null } };
    expect(single.quiz?.points).toBe(1);
  });

  it('marks unsupported questions explicitly instead of coercing them', () => {
    const unsupported = byKind.get('unsupported') as { rawTypeHint?: string; reason?: string };
    expect(unsupported.rawTypeHint).toContain('type:99');
    expect(unsupported.reason).toBeDefined();
    expect(isFreeTextQuestion(byKind.get('unsupported') as Question)).toBe(false);
    expect(isChoiceQuestion(byKind.get('unsupported') as Question)).toBe(false);
  });

  it('recognizes file upload as an explicitly unsupported-for-filling type', () => {
    const upload = byKind.get('file-upload') as { supported: boolean; allowedTypes: string[] };
    expect(upload.supported).toBe(false);
    expect(upload.allowedTypes).toEqual(['application/pdf']);
  });
});

describe('FormSchema — sections and routing', () => {
  it('preserves section boundaries, titles and ordering', () => {
    const schema = buildObservedFormSchema();
    expect(schema.sections.map((s) => s.id)).toEqual([
      's-datos',
      's-presencial',
      's-virtual',
      's-organizacion',
      's-final',
    ]);
    expect(schema.sections[0]?.title).toBe('Datos generales');
    expect(schema.sections[0]?.questionIds).toEqual(['q-name', 'q-age', 'q-dob', 'q-cycle', 'q-modality']);
    // Question order is document order across the whole form (no flattening).
    expect(schema.parts.map((q) => q.id)).toEqual([
      'q-name',
      'q-age',
      'q-dob',
      'q-cycle',
      'q-modality',
      'q-hours-in-person',
      'q-values',
      'q-scale-in-person',
      'q-peers',
      'q-in-person-time',
      'q-grid-in-person',
      'q-hours-virtual',
      'q-tools',
      'q-scale-virtual',
      'q-virtual-comms',
      'q-virtual-time',
      'q-virtual-activities',
      'q-grid-virtual',
      'q-sleep',
      'q-activities',
      'q-satisfaction-time',
      'q-priorities',
      'q-satisfaction-factors',
      'q-likes',
      'q-improve',
      'q-change',
      'q-recommend',
    ]);
    // The real form's four single-select grids survive as grids.
    expect(schema.parts.filter(isGridQuestion)).toHaveLength(4);
    expect(schema.parts.filter(isGridQuestion).every((q) => q.selectionMode === 'single')).toBe(true);
  });

  it('maps every question to a section', () => {
    const schema = buildObservedFormSchema();
    for (const q of schema.parts) {
      expect(sectionOfQuestion(schema, q.id)).toBeDefined();
      expect(schema.questionSection[q.id]).toBeDefined();
    }
  });

  it('models terminal sections that lead to submission', () => {
    const schema = buildObservedFormSchema();
    expect(schema.terminalSectionIds).toEqual(['s-final']);
    expect(schema.hasRouting).toBe(false);
    expect(resolveNavigationTarget(schema, 's-final', 'submit')).toBeNull();
  });

  it('resolves normal next-section navigation via continue', () => {
    const schema = buildObservedFormSchema();
    expect(resolveNavigationTarget(schema, 's-datos', 'continue')?.id).toBe('s-presencial');
    expect(resolveNavigationTarget(schema, 's-presencial', 'continue')?.id).toBe('s-virtual');
    expect(resolveNavigationTarget(schema, 's-final', 'continue')).toBeNull();
  });

  it('represents conditional go-to-section routing and terminal branches', () => {
    const schema = buildRoutedSchema();
    expect(schema.hasRouting).toBe(true);
    const modality = schema.sections[0];
    expect(modality?.routing.conditional).toBe(true);
    expect(modality?.routing.rules).toEqual([
      { choiceLabel: 'Sí', target: 's-in-person' },
      { choiceLabel: 'No', target: 's-virtual' },
      { choiceLabel: 'Tal vez', target: 'submit' },
    ]);
    expect(resolveNavigationTarget(schema, 's-modality', 's-virtual')?.id).toBe('s-virtual');
    expect(schema.terminalSectionIds.sort()).toEqual(['s-in-person', 's-virtual']);
  });

  it('computes reachable sections across branching', () => {
    const schema = buildRoutedSchema();
    expect([...reachableSectionIds(schema)].sort()).toEqual(['s-in-person', 's-modality', 's-virtual']);
  });

  it('represents a sectionless form as one implicit section', () => {
    const schema = buildSectionlessSchema();
    expect(schema.sections).toHaveLength(1);
    expect(schema.sections[0]?.id).toBe(DEFAULT_SECTION_ID);
    expect(schema.questionSection['q-name']).toBe(DEFAULT_SECTION_ID);
  });

  it('keeps non-question content structurally', () => {
    const schema = buildObservedFormSchema();
    expect(schema.nonQuestionContent[0]?.type).toBe('text');
    expect(schema.nonQuestionContent[0]?.text).toBe('Bienvenido.');
  });

  it('exposes the finalized schema version', () => {
    expect(buildObservedFormSchema().schemaVersion).toBe(FORMS_SCHEMA_VERSION);
    expect(FORMS_SCHEMA_VERSION).toBe(2);
  });
});