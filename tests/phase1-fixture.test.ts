/**
 * Phase 1 real-fixture regression tests (P1-R1 .. P1-R13).
 *
 * The archived `observed-responder.html` is the authoritative regression
 * source. These assertions encode the verified facts from
 * `AGENT_HANDOFF.md` / `docs/PHASE_1.md` (which themselves derive from the
 * decoded Phase 0 payload) — not invented markup.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseGoogleFormsHtml } from '../src/parser/google-forms.ts';
import { DOMAIN_PROVIDER_ID, FORMS_SCHEMA_VERSION, isGridQuestion } from '../src/domain/types.ts';
import type { ChoiceGridQuestion, FormSchema } from '../src/domain/types.ts';

const FIXTURE_HTML = readFileSync(
  new URL('../fixtures/archives/observed-responder.html', import.meta.url),
  'utf8',
);

const FIXTURE_URL = 'https://fixtures.local/forms/observed-responder';
const FIXTURE_CAPTURED_AT = '2026-01-01T00:00:00.000Z';

function parseFixture(): FormSchema {
  return parseGoogleFormsHtml(FIXTURE_HTML, { url: FIXTURE_URL, capturedAt: FIXTURE_CAPTURED_AT });
}

const SECTION_TITLES = [
  'Datos generales',
  'Experiencia académica presencial sin título',
  'Experiencia académica virtual',
  'Organización y satisfacción',
  'Comentarios finales',
];

const REQUIRED_IDS = ['1408676108', '783078409', '1992042423', '1834773003'];

describe('P1-R1/R2 — fixture parses with correct metadata', () => {
  it('parses the archived HTML into a FormSchema without a browser or network', () => {
    const schema = parseFixture();
    expect(schema.parts.length).toBeGreaterThan(0);
  });

  it('extracts title, description, form id and meta from the embedded payload', () => {
    const schema = parseFixture();
    expect(schema.title).toBe('Evaluación de experiencia y preferencias del estudiante');
    expect(schema.description).toContain('evaluar la experiencia de los estudiantes');
    expect(schema.formId).toBe('REDACTED_FORM_ID');
    expect(schema.meta.url).toBe(FIXTURE_URL);
    expect(schema.meta.capturedAt).toBe(FIXTURE_CAPTURED_AT);
    expect(schema.meta.source).toBe('fixture');
    expect(schema.meta.requiresSignIn).toBe(false);
    expect(schema.meta.title).toBe(schema.title);
  });
});

describe('P1-R3/R4/R5 — sections, question count and ordering', () => {
  it('detects all 5 sections in document order', () => {
    const schema = parseFixture();
    expect(schema.sections).toHaveLength(5);
    expect(schema.sections.map((s) => s.title)).toEqual(SECTION_TITLES);
    expect(schema.sections.map((s) => s.id)).toEqual([
      '1249846430',
      '336245140',
      '1142924921',
      '21510676',
      '1860209072',
    ]);
  });

  it('detects all 27 questions (parts and questions map agree)', () => {
    const schema = parseFixture();
    expect(schema.parts).toHaveLength(27);
    expect(Object.keys(schema.questions)).toHaveLength(27);
    expect(schema.fieldCount).toBe(27);
  });

  it('preserves payload order without sorting', () => {
    const schema = parseFixture();
    const ids = schema.parts.map((q) => q.id);
    expect(ids[0]).toBe('1768533602');
    expect(ids[26]).toBe('1834773003');
    // Slots are 0..26 in order.
    expect(schema.parts.map((q) => q.slot)).toEqual(Array.from({ length: 27 }, (_, i) => i));
    // No sorting by label/id/kind: the sequence mirrors the payload item order.
    expect(ids).toEqual([
      '1768533602',
      '1307724388',
      '185285285',
      '81510332',
      '1240080904',
      '1363168754',
      '215989038',
      '1680754316',
      '2017386037',
      '516057794',
      '1969726133',
      '176568645',
      '780007956',
      '1161579616',
      '959539122',
      '1890094526',
      '16934429',
      '759854928',
      '1344142663',
      '151469523',
      '370988481',
      '1536986917',
      '1478815747',
      '1408676108',
      '783078409',
      '1992042423',
      '1834773003',
    ]);
  });
});

describe('P1-R6 — section assignment', () => {
  it('assigns every question to exactly one section', () => {
    const schema = parseFixture();
    const seen = new Set<string>();
    for (const section of schema.sections) {
      for (const id of section.questionIds) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
        expect(schema.questionSection[id]).toBe(section.id);
      }
    }
    expect(seen.size).toBe(27);
  });

  it('puts the pre-first-break questions in section 1, and so on', () => {
    const schema = parseFixture();
    expect(schema.sections[0]?.questionIds).toEqual(['1768533602', '1307724388', '185285285', '81510332', '1240080904']);
    expect(schema.sections[4]?.questionIds).toEqual(REQUIRED_IDS);
  });
});

describe('P1-R7/R8 — kinds and required flags', () => {
  it('produces the exact normalized kind counts', () => {
    const schema = parseFixture();
    const counts: Record<string, number> = {};
    for (const q of schema.parts) counts[q.kind] = (counts[q.kind] ?? 0) + 1;
    expect(counts).toEqual({
      text: 8,
      'paragraph-text': 3,
      'single-choice': 1,
      'multi-choice': 3,
      'linear-scale': 5,
      'multiple-choice-grid': 4,
      date: 1,
      time: 2,
    });
    expect(schema.parts.some((q) => q.kind === 'unsupported')).toBe(false);
  });

  it('derives required from the embedded flag, with exactly 4 required questions', () => {
    const schema = parseFixture();
    const required = schema.parts.filter((q) => q.required === 'required');
    expect(required).toHaveLength(4);
    expect(required.map((q) => q.id)).toEqual(REQUIRED_IDS);
    expect(required.map((q) => q.kind)).toEqual(['paragraph-text', 'paragraph-text', 'paragraph-text', 'single-choice']);
    expect(schema.parts.filter((q) => q.required === 'optional')).toHaveLength(23);
  });
});

describe('P1-R9 — multiple-choice-grid structure', () => {
  it('keeps all 4 grids as single-select with rows/choices intact', () => {
    const schema = parseFixture();
    const grids = schema.parts.filter(isGridQuestion) as ChoiceGridQuestion[];
    expect(grids).toHaveLength(4);
    expect(grids.map((g) => g.selectionMode)).toEqual(['single', 'single', 'single', 'single']);
    expect(grids.map((g) => g.rows.length)).toEqual([4, 4, 5, 5]);
    expect(grids.map((g) => g.rows.map((r) => r.id))).toEqual([
      ['1969726133.r1', '1969726133.r2', '1969726133.r3', '1969726133.r4'],
      ['759854928.r1', '759854928.r2', '759854928.r3', '759854928.r4'],
      ['1536986917.r1', '1536986917.r2', '1536986917.r3', '1536986917.r4', '1536986917.r5'],
      ['1478815747.r1', '1478815747.r2', '1478815747.r3', '1478815747.r4', '1478815747.r5'],
    ]);
  });

  it('preserves grid row labels and column choices', () => {
    const schema = parseFixture();
    const grid = schema.parts.find((q) => q.id === '1969726133') as ChoiceGridQuestion;
    expect(grid.rows.map((r) => r.label)).toEqual([
      'Puedo concentrarme durante las clases.',
      'Comprendo las explicaciones del docente.',
      'Participo activamente en clase.',
      'Me siento cómodo trabajando con mis compañeros.',
    ]);
    expect(grid.choices).toEqual([
      'Totalmente en desacuerdo',
      'En desacuerdo',
      'Ni de acuerdo ni en desacuerdo',
      'De acuerdo',
      'Totalmente de acuerdo',
    ]);
    expect(grid.options.map((o) => o.label)).toEqual(grid.choices);
    expect(grid.isOtherOpen).toBe(false);
  });
});

describe('P1-R10/R11 — routing and terminal submit path', () => {
  it('derives continue for non-terminal sections and submit for the last', () => {
    const schema = parseFixture();
    expect(schema.sections.slice(0, -1).map((s) => s.routing.default)).toEqual([
      'continue',
      'continue',
      'continue',
      'continue',
    ]);
    expect(schema.sections[4]?.routing.default).toBe('submit');
    expect(schema.hasRouting).toBe(false);
    expect(schema.terminalSectionIds).toEqual(['1860209072']);
  });
});

describe('P1-R12/R13 — provider-neutral schema and stable fingerprint', () => {
  it('produces a provider-neutral FormSchema with consistent checksum', () => {
    const schema = parseFixture();
    expect(schema.providerId).toBe(DOMAIN_PROVIDER_ID);
    expect(schema.schemaVersion).toBe(FORMS_SCHEMA_VERSION);
    expect(schema.checksum).toHaveLength(64);
    expect(schema.rowCount).toBe(18);
    expect(schema.fieldCount).toBe(27);
    expect(schema.answerModel).toBe('multi-section');
  });

  it('yields an identical checksum on re-parse and a different one on structural change', () => {
    const first = parseFixture().checksum;
    const second = parseFixture().checksum;
    expect(first).toBe(second);

    const changed = parseGoogleFormsHtml(FIXTURE_HTML.replaceAll('Nombre o código del participante', 'Nombre cambiado'), {
      url: FIXTURE_URL,
      capturedAt: FIXTURE_CAPTURED_AT,
    });
    expect(changed.checksum).not.toBe(first);
  });

  it('is insensitive to meta.capturedAt (fingerprint covers structure only)', () => {
    const a = parseGoogleFormsHtml(FIXTURE_HTML, { url: FIXTURE_URL, capturedAt: '2026-01-01T00:00:00.000Z' });
    const b = parseGoogleFormsHtml(FIXTURE_HTML, { url: FIXTURE_URL, capturedAt: '2026-02-02T00:00:00.000Z' });
    expect(a.checksum).toBe(b.checksum);
  });
});
