/**
 * Phase 3 structural answer-validation tests (P3-R9, P3-R10).
 *
 * Validates every accepted supported structural kind and rejects
 * provider-invented identifiers, invalid scale bounds, invalid grid rows/columns,
 * invalid calendar dates/times, and unsupported kinds.
 */

import { describe, expect, it } from 'vitest';

import { isValidDateValue, isValidTimeValue, validateDraftValue } from '../src/draft/validate.ts';
import {
  checkboxGrid,
  choiceGrid,
  dateQuestion,
  dropdown,
  fileUpload,
  linearScale,
  multiChoiceWithOther,
  paragraph,
  ratingQuestion,
  shortAnswer,
  singleChoice,
  timeQuestion,
  unsupportedQuestion,
} from './support/sample-schema.ts';

describe('P3-R10 — text / paragraph-text', () => {
  it('accepts a string value', () => {
    expect(validateDraftValue({ kind: 'text', value: 'synthetic answer' }, shortAnswer()).ok).toBe(true);
    expect(validateDraftValue({ kind: 'paragraph-text', value: 'a longer answer' }, paragraph()).ok).toBe(true);
  });

  it('rejects non-string values (no object/array may pass as text)', () => {
    expect(validateDraftValue({ kind: 'text', value: { nested: true } }, shortAnswer()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'text', value: ['x'] }, shortAnswer()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'text', value: 42 }, shortAnswer()).ok).toBe(false);
  });

  it('rejects a kind mismatch', () => {
    expect(validateDraftValue({ kind: 'paragraph-text', value: 'x' }, shortAnswer()).ok).toBe(false);
  });

  it('rejects a missing kind discriminator', () => {
    expect(validateDraftValue({ value: 'x' }, shortAnswer()).ok).toBe(false);
    expect(validateDraftValue('x', shortAnswer()).ok).toBe(false);
  });
});

describe('P3-R10 — single-choice', () => {
  it('accepts a real choice', () => {
    expect(validateDraftValue({ kind: 'single-choice', value: 'Sí' }, singleChoice()).ok).toBe(true);
  });

  it('rejects a provider-invented choice', () => {
    expect(validateDraftValue({ kind: 'single-choice', value: 'Invented' }, singleChoice()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'single-choice', value: 1 }, singleChoice()).ok).toBe(false);
  });
});

describe('P3-R10 — multi-choice', () => {
  it('accepts real choices and de-duplicates', () => {
    const result = validateDraftValue(
      { kind: 'multi-choice', value: ['Trabajo', 'Deporte', 'Trabajo'] },
      multiChoiceWithOther(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toEqual(['Trabajo', 'Deporte']);
  });

  it('rejects a provider-invented choice', () => {
    expect(validateDraftValue({ kind: 'multi-choice', value: ['Trabajo', 'Invented'] }, multiChoiceWithOther()).ok).toBe(false);
  });

  it('rejects a non-array value', () => {
    expect(validateDraftValue({ kind: 'multi-choice', value: 'Trabajo' }, multiChoiceWithOther()).ok).toBe(false);
  });
});

describe('P3-R10 — linear-scale', () => {
  it('accepts an integer inside the real bounds', () => {
    expect(validateDraftValue({ kind: 'linear-scale', value: 1 }, linearScale()).ok).toBe(true);
    expect(validateDraftValue({ kind: 'linear-scale', value: 5 }, linearScale()).ok).toBe(true);
  });

  it('rejects out-of-bounds, non-integer, and non-number values', () => {
    expect(validateDraftValue({ kind: 'linear-scale', value: 6 }, linearScale()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'linear-scale', value: 0 }, linearScale()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'linear-scale', value: 2.5 }, linearScale()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'linear-scale', value: '3' }, linearScale()).ok).toBe(false);
  });
});

describe('P3-R10 — multiple-choice-grid', () => {
  it('accepts real rows mapped to real columns', () => {
    const result = validateDraftValue(
      { kind: 'multiple-choice-grid', value: { 'q-grid.r1': 'De acuerdo', 'q-grid.r2': 'En desacuerdo' } },
      choiceGrid(),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a provider-invented row', () => {
    expect(
      validateDraftValue({ kind: 'multiple-choice-grid', value: { 'bogus-row': 'De acuerdo' } }, choiceGrid()).ok,
    ).toBe(false);
  });

  it('rejects a provider-invented column', () => {
    expect(
      validateDraftValue({ kind: 'multiple-choice-grid', value: { 'q-grid.r1': 'Invented' } }, choiceGrid()).ok,
    ).toBe(false);
  });

  it('rejects a non-object grid value', () => {
    expect(validateDraftValue({ kind: 'multiple-choice-grid', value: ['De acuerdo'] }, choiceGrid()).ok).toBe(false);
  });
});

describe('P3-R10 — date', () => {
  it('accepts a valid calendar date', () => {
    expect(isValidDateValue({ year: 2024, month: 2, day: 29 })).toBe(true);
    expect(validateDraftValue({ kind: 'date', value: { year: 2024, month: 2, day: 29 } }, dateQuestion()).ok).toBe(true);
  });

  it('rejects invalid calendar dates', () => {
    expect(isValidDateValue({ year: 2023, month: 2, day: 29 })).toBe(false);
    expect(isValidDateValue({ year: 2024, month: 13, day: 1 })).toBe(false);
    expect(isValidDateValue({ year: 2024, month: 4, day: 31 })).toBe(false);
    expect(isValidDateValue({ year: 2024, month: 1, day: 0 })).toBe(false);
    expect(validateDraftValue({ kind: 'date', value: { year: 2023, month: 2, day: 29 } }, dateQuestion()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'date', value: '2024-01-01' }, dateQuestion()).ok).toBe(false);
  });
});

describe('P3-R10 — time', () => {
  it('accepts a valid 24-hour time', () => {
    expect(isValidTimeValue({ hour: 23, minute: 59 })).toBe(true);
    expect(validateDraftValue({ kind: 'time', value: { hour: 12, minute: 30 } }, timeQuestion()).ok).toBe(true);
  });

  it('rejects invalid hour/minute values', () => {
    expect(isValidTimeValue({ hour: 24, minute: 0 })).toBe(false);
    expect(isValidTimeValue({ hour: 0, minute: 60 })).toBe(false);
    expect(isValidTimeValue({ hour: -1, minute: 0 })).toBe(false);
    expect(validateDraftValue({ kind: 'time', value: { hour: 24, minute: 0 } }, timeQuestion()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'time', value: '12:30' }, timeQuestion()).ok).toBe(false);
  });
});

describe('P3-R9 — unsupported structural kinds remain unsupported', () => {
  it('rejects deferred/unsupported kinds during validation', () => {
    expect(validateDraftValue({ kind: 'unsupported', value: 'x' }, unsupportedQuestion()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'dropdown', value: '1' }, dropdown()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'rating', value: 3 }, ratingQuestion()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'checkbox-grid', value: {} }, checkboxGrid()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'file-upload', value: 'x' }, fileUpload()).ok).toBe(false);
  });
});

describe('P3-R11 — empty answers are rejected (completeness)', () => {
  it('rejects empty and whitespace-only text', () => {
    expect(validateDraftValue({ kind: 'text', value: '' }, shortAnswer()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'text', value: '   ' }, shortAnswer()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'paragraph-text', value: '' }, paragraph()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'text', value: 'ok' }, shortAnswer()).ok).toBe(true);
  });

  it('rejects an empty multi-choice selection', () => {
    expect(validateDraftValue({ kind: 'multi-choice', value: [] }, multiChoiceWithOther()).ok).toBe(false);
    expect(validateDraftValue({ kind: 'multi-choice', value: ['Trabajo'] }, multiChoiceWithOther()).ok).toBe(true);
  });

  it('rejects an empty grid object', () => {
    expect(validateDraftValue({ kind: 'multiple-choice-grid', value: {} }, choiceGrid()).ok).toBe(false);
  });

  it('rejects a partial answer for a required grid', () => {
    const requiredGrid = { ...choiceGrid(), required: 'required' as const };
    // Only one of two rows answered.
    expect(
      validateDraftValue({ kind: 'multiple-choice-grid', value: { 'q-grid.r1': 'De acuerdo' } }, requiredGrid).ok,
    ).toBe(false);
    // Full coverage is accepted.
    expect(
      validateDraftValue(
        { kind: 'multiple-choice-grid', value: { 'q-grid.r1': 'De acuerdo', 'q-grid.r2': 'En desacuerdo' } },
        requiredGrid,
      ).ok,
    ).toBe(true);
  });

  it('does not echo proposed values in validation reasons', () => {
    const result = validateDraftValue(
      { kind: 'multi-choice', value: ['VERY_SECRET_PROVIDER_VALUE'] },
      multiChoiceWithOther(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain('VERY_SECRET_PROVIDER_VALUE');
    }
  });
});
