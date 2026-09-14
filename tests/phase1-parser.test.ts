/**
 * Phase 1 parser unit + negative/edge-case tests.
 *
 * Exercises the normalization decisions directly (type-code -> kind, required
 * flag, grid rows/choices, ordering, section attachment, routing, fingerprint
 * stability) and the conservative handling of unknown/deferred structures.
 */

import { describe, expect, it } from 'vitest';

import {
  GoogleFormsParseError,
  GOOGLE_FORMS_PARSER_VERSION,
  buildFormSchema,
  parseGoogleFormsHtml,
} from '../src/parser/google-forms.ts';
import { DEFAULT_SECTION_ID, DOMAIN_PROVIDER_ID, FORMS_SCHEMA_VERSION, isUnsupportedQuestion } from '../src/domain/types.ts';

/** Wrap a payload JSON string in minimal responder-page HTML. */
function htmlWithPayload(payloadJson: string): string {
  return `<!doctype html><html><head></head><body><script nonce="x">var FB_PUBLIC_LOAD_DATA_ = ${payloadJson};</script></body></html>`;
}

/** Build a minimal top-level payload from a list of items. */
function payload(items: unknown[], overrides: { title?: string; description?: string; formId?: string } = {}): unknown[] {
  const form: unknown[] = [
    overrides.description ?? '',
    items,
    null,
    null,
    null,
    null,
    null,
    null,
    overrides.title ?? 'Test form',
  ];
  return [null, form, null, null, null, null, null, null, null, null, null, null, null, null, `e/${overrides.formId ?? 'test-form'}`];
}

function sectionItem(id: number, title: string, description = ''): unknown[] {
  return [id, title, description, 6, null];
}

function textItem(id: number, title: string, required = 0): unknown[] {
  return [id, title, null, 0, [[id * 10 + 1, null, required]]];
}

function paragraphItem(id: number, title: string, required = 0): unknown[] {
  return [id, title, null, 1, [[id * 10 + 1, null, required]]];
}

function choiceItem(id: number, title: string, type: 2 | 4, choices: string[], required = 0): unknown[] {
  return [id, title, null, type, [[id * 10 + 1, choices.map((label) => [label, null, null, null, 0]), required]]];
}

function scaleItem(id: number, title: string, minLabel: string, maxLabel: string, steps = 5, required = 0): unknown[] {
  const choices = Array.from({ length: steps }, (_, index) => [String(index + 1)]);
  return [id, title, null, 5, [[id * 10 + 1, choices, required, [minLabel, maxLabel]]]];
}

function gridItem(id: number, title: string, choices: string[], rows: string[], required = 0): unknown[] {
  const group = rows.map((label, index) => [id * 100 + index + 1, choices.map((c) => [c]), required, [label]]);
  return [id, title, null, 7, group];
}

function dateItem(id: number, title: string, includeTime = 0, includeYear = 1): unknown[] {
  return [id, title, null, 9, [[id * 10 + 1, null, 0, null, null, null, null, [includeTime, includeYear]]]];
}

function timeItem(id: number, title: string): unknown[] {
  return [id, title, null, 10, [[id * 10 + 1, null, 0, null, null, null, [0]]]];
}

function itemOfType(id: number, type: number, title = 'q'): unknown[] {
  return [id, title, null, type, [[id * 10 + 1, null, 0]]];
}

describe('type-code -> kind normalization', () => {
  it('maps every validated type code to its normalized kind', () => {
    const schema = buildFormSchema(
      payload([
        textItem(1, 'a'),
        paragraphItem(2, 'b'),
        choiceItem(3, 'c', 2, ['x', 'y']),
        choiceItem(4, 'd', 4, ['x', 'y']),
        scaleItem(5, 'e', 'low', 'high'),
        gridItem(6, 'f', ['A', 'B'], ['r1', 'r2']),
        dateItem(7, 'g'),
        timeItem(8, 'h'),
      ]),
    );
    expect(schema.parts.map((q) => q.kind)).toEqual([
      'text',
      'paragraph-text',
      'single-choice',
      'multi-choice',
      'linear-scale',
      'multiple-choice-grid',
      'date',
      'time',
    ]);
  });

  it('derives linear-scale bounds from the numeric step labels', () => {
    const schema = buildFormSchema(payload([scaleItem(1, 'scale', 'low', 'high', 5)]));
    const q = schema.parts[0];
    expect(q?.kind).toBe('linear-scale');
    if (q?.kind !== 'linear-scale') throw new Error('expected linear-scale');
    expect(q.minValue).toBe(1);
    expect(q.maxValue).toBe(5);
    expect(q.minLabel).toBe('low');
    expect(q.maxLabel).toBe('high');
  });

  it('maps unknown and deferred type codes to unsupported with a raw hint', () => {
    const schema = buildFormSchema(payload([itemOfType(1, 99), itemOfType(2, 3), itemOfType(3, 18), itemOfType(4, 13)]));
    expect(schema.parts.map((q) => q.kind)).toEqual(['unsupported', 'unsupported', 'unsupported', 'unsupported']);
    const unsupported = schema.parts.filter(isUnsupportedQuestion);
    expect(unsupported.map((q) => q.rawTypeHint)).toEqual([
      'google-form-item-type:99',
      'google-form-item-type:3',
      'google-form-item-type:18',
      'google-form-item-type:13',
    ]);
    expect(unsupported.map((q) => q.reason)).toEqual([
      'unrecognized Google Forms item type',
      'deferred: dropdown is not validated in Phase 1',
      'deferred: rating is not validated in Phase 1',
      'deferred: file-upload is not validated in Phase 1',
    ]);
  });

  it('treats an item with no numeric type code as unsupported', () => {
    const schema = buildFormSchema(payload([[700, 'no type', null, null, null]]));
    const unsupported = schema.parts.filter(isUnsupportedQuestion);
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]?.rawTypeHint).toBe('google-form-item-missing-type');
    expect(unsupported[0]?.reason).toContain('type code');
  });
});

describe('required flag derivation', () => {
  it('reads required from the embedded group flag, not ARIA', () => {
    const schema = buildFormSchema(payload([textItem(1, 'optional'), paragraphItem(2, 'required', 1)]));
    expect(schema.parts.map((q) => q.required)).toEqual(['optional', 'required']);
  });

  it('treats a grid as required when any row is required', () => {
    const schema = buildFormSchema(payload([gridItem(1, 'grid', ['A'], ['r1', 'r2'], 1)]));
    expect(schema.parts[0]?.required).toBe('required');
  });
});

describe('grid row + choice extraction', () => {
  it('preserves row labels in order and derives stable row ids', () => {
    const schema = buildFormSchema(payload([gridItem(42, 'grid', ['Yes', 'No'], ['row a', 'row b', 'row c'])]));
    const grid = schema.parts[0];
    expect(grid?.kind).toBe('multiple-choice-grid');
    if (grid?.kind !== 'multiple-choice-grid') throw new Error('expected grid');
    expect(grid.rows.map((r) => r.label)).toEqual(['row a', 'row b', 'row c']);
    expect(grid.rows.map((r) => r.id)).toEqual(['42.r1', '42.r2', '42.r3']);
    expect(grid.choices).toEqual(['Yes', 'No']);
    expect(grid.selectionMode).toBe('single');
    expect(grid.options.map((o) => o.isOther)).toEqual([false, false]);
  });

  it('handles an empty grid group without crashing', () => {
    const schema = buildFormSchema(payload([[99, 'empty grid', null, 7, []]]));
    const grid = schema.parts[0];
    expect(grid?.kind).toBe('multiple-choice-grid');
    if (grid?.kind !== 'multiple-choice-grid') throw new Error('expected grid');
    expect(grid.rows).toEqual([]);
    expect(grid.choices).toEqual([]);
  });
});

describe('ordering and section attachment', () => {
  it('preserves document order (parts matches item order, no sorting)', () => {
    const schema = buildFormSchema(payload([textItem(3, 'c'), textItem(1, 'a'), textItem(2, 'b')]));
    expect(schema.parts.map((q) => q.id)).toEqual(['3', '1', '2']);
    expect(schema.parts.map((q) => q.slot)).toEqual([0, 1, 2]);
  });

  it('attaches questions to the section opened by the preceding page break', () => {
    const schema = buildFormSchema(
      payload([
        sectionItem(10, 'Section A'),
        textItem(1, 'a'),
        textItem(2, 'b'),
        sectionItem(20, 'Section B'),
        textItem(3, 'c'),
      ]),
    );
    expect(schema.sections.map((s) => s.title)).toEqual(['Section A', 'Section B']);
    expect(schema.sections[0]?.questionIds).toEqual(['1', '2']);
    expect(schema.sections[1]?.questionIds).toEqual(['3']);
    expect(schema.questionSection['1']).toBe('10');
    expect(schema.questionSection['3']).toBe('20');
  });

  it('puts a question before the first page break into an implicit section', () => {
    const schema = buildFormSchema(payload([textItem(1, 'leading'), sectionItem(10, 'Section A'), textItem(2, 'a')]));
    expect(schema.sections[0]?.id).toBe(DEFAULT_SECTION_ID);
    expect(schema.sections[0]?.questionIds).toEqual(['1']);
    expect(schema.sections[1]?.title).toBe('Section A');
  });

  it('produces one implicit section for a sectionless form', () => {
    const schema = buildFormSchema(payload([textItem(1, 'a'), textItem(2, 'b')]));
    expect(schema.sections).toHaveLength(1);
    expect(schema.sections[0]?.id).toBe(DEFAULT_SECTION_ID);
  });

  it('handles duplicate choice labels without deduplicating', () => {
    const schema = buildFormSchema(payload([choiceItem(1, 'dup', 2, ['same', 'same'])]));
    const q = schema.parts[0];
    if (q?.kind !== 'single-choice') throw new Error('expected single-choice');
    expect(q.choices).toEqual(['same', 'same']);
  });
});

describe('routing derivation', () => {
  it('derives continue for non-terminal sections and submit for the terminal section', () => {
    const schema = buildFormSchema(
      payload([sectionItem(10, 'A'), textItem(1, 'a'), sectionItem(20, 'B'), textItem(2, 'b')]),
    );
    expect(schema.sections[0]?.routing.default).toBe('continue');
    expect(schema.sections[1]?.routing.default).toBe('submit');
    expect(schema.terminalSectionIds).toEqual(['20']);
    expect(schema.hasRouting).toBe(false);
  });
});

describe('fingerprint stability', () => {
  it('is deterministic across re-parses', () => {
    const html = htmlWithPayload(JSON.stringify(payload([textItem(1, 'a'), textItem(2, 'b')])));
    const first = parseGoogleFormsHtml(html).checksum;
    const second = parseGoogleFormsHtml(html).checksum;
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
  });

  it('changes when a question is added', () => {
    const base = htmlWithPayload(JSON.stringify(payload([textItem(1, 'a')])));
    const changed = htmlWithPayload(JSON.stringify(payload([textItem(1, 'a'), textItem(2, 'b')])));
    expect(parseGoogleFormsHtml(changed).checksum).not.toBe(parseGoogleFormsHtml(base).checksum);
  });

  it('changes when a section is reordered', () => {
    const base = htmlWithPayload(JSON.stringify(payload([sectionItem(10, 'A'), textItem(1, 'a'), sectionItem(20, 'B'), textItem(2, 'b')])));
    const changed = htmlWithPayload(JSON.stringify(payload([sectionItem(20, 'B'), textItem(2, 'b'), sectionItem(10, 'A'), textItem(1, 'a')])));
    expect(parseGoogleFormsHtml(changed).checksum).not.toBe(parseGoogleFormsHtml(base).checksum);
  });

  it('records the parser generator version as part of the schema identity', () => {
    const schema = parseGoogleFormsHtml(htmlWithPayload(JSON.stringify(payload([textItem(1, 'a')]))));
    expect(schema.schemaVersion).toBe(FORMS_SCHEMA_VERSION);
    expect(GOOGLE_FORMS_PARSER_VERSION).toBeTruthy();
  });
});

describe('provider-neutral FormSchema invariants', () => {
  it('sets providerId, schema version, answer model and counts', () => {
    const schema = buildFormSchema(
      payload([
        sectionItem(10, 'A'),
        textItem(1, 'a'),
        sectionItem(20, 'B'),
        gridItem(2, 'g', ['x'], ['r1', 'r2', 'r3']),
      ]),
    );
    expect(schema.providerId).toBe(DOMAIN_PROVIDER_ID);
    expect(schema.schemaVersion).toBe(FORMS_SCHEMA_VERSION);
    expect(schema.answerModel).toBe('multi-section');
    expect(schema.fieldCount).toBe(2);
    expect(schema.rowCount).toBe(3);
    expect(schema.nonQuestionContent).toEqual([]);
  });

  it('uses the grid answer model for a single-section form with grids', () => {
    const schema = buildFormSchema(payload([gridItem(2, 'g', ['x'], ['r1', 'r2'])]));
    expect(schema.sections).toHaveLength(1);
    expect(schema.answerModel).toBe('grid');
  });

  it('uses the flat answer model for a single-section form without grids', () => {
    const schema = buildFormSchema(payload([textItem(1, 'a')]));
    expect(schema.sections).toHaveLength(1);
    expect(schema.answerModel).toBe('flat');
  });
});

describe('negative / edge-case inputs (no unhandled errors)', () => {
  it('throws a controlled error when the payload block is missing', () => {
    expect(() => parseGoogleFormsHtml('<!doctype html><html></html>')).toThrow(GoogleFormsParseError);
  });

  it('throws a controlled error on malformed JSON', () => {
    expect(() => parseGoogleFormsHtml(htmlWithPayload('[not valid json'))).toThrow(GoogleFormsParseError);
  });

  it('throws a controlled error on an empty payload', () => {
    expect(() => parseGoogleFormsHtml(htmlWithPayload('[]'))).toThrow(GoogleFormsParseError);
  });

  it('throws a controlled error on truncated HTML', () => {
    const html = htmlWithPayload(JSON.stringify(payload([textItem(1, 'a')])));
    expect(() => parseGoogleFormsHtml(html.slice(0, Math.floor(html.length / 2)))).toThrow(GoogleFormsParseError);
  });

  it('handles a trailing page break with no following questions', () => {
    const schema = buildFormSchema(payload([sectionItem(10, 'A'), textItem(1, 'a'), sectionItem(20, 'B')]));
    expect(schema.sections).toHaveLength(2);
    expect(schema.sections[1]?.questionIds).toEqual([]);
    expect(schema.sections[1]?.routing.default).toBe('submit');
  });

  it('fails in a controlled way on a non-array payload item', () => {
    expect(() => buildFormSchema(payload([textItem(1, 'a'), 'not-an-item', textItem(2, 'b')]))).toThrow(
      GoogleFormsParseError,
    );
  });

  it('leaves no question in unsupported for a fully-supported payload', () => {
    const schema = buildFormSchema(
      payload([
        textItem(1, 'a'),
        paragraphItem(2, 'b'),
        choiceItem(3, 'c', 2, ['x']),
        choiceItem(4, 'd', 4, ['x']),
        scaleItem(5, 'e', '', ''),
        gridItem(6, 'f', ['A'], ['r']),
        dateItem(7, 'g'),
        timeItem(8, 'h'),
      ]),
    );
    expect(schema.parts.some((q) => q.kind === 'unsupported')).toBe(false);
  });
});
