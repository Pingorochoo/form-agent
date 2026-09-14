/**
 * Phase 1 golden structural-result test.
 *
 * Asserts the parsed real form against a committed expected-value artifact
 * (`tests/golden/observed-responder.schema.json`). The artifact is a concise,
 * human-reviewable summary: section titles + question ids in order, kind
 * counts, required ids, grid row counts, routing, and terminal path.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseGoogleFormsHtml } from '../src/parser/google-forms.ts';
import { isGridQuestion, type FormSchema } from '../src/domain/types.ts';

const FIXTURE_HTML = readFileSync(
  new URL('../fixtures/archives/observed-responder.html', import.meta.url),
  'utf8',
);
const GOLDEN = JSON.parse(
  readFileSync(new URL('./golden/observed-responder.schema.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

function summarize(schema: FormSchema): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const q of schema.parts) counts[q.kind] = (counts[q.kind] ?? 0) + 1;
  return {
    title: schema.title,
    description: schema.description,
    sections: schema.sections.map((s) => ({ id: s.id, title: s.title, questionIds: s.questionIds })),
    questionOrder: schema.parts.map((q) => q.id),
    kindCounts: counts,
    requiredQuestionIds: schema.parts.filter((q) => q.required === 'required').map((q) => q.id),
    gridRowCounts: schema.parts.filter(isGridQuestion).map((g) => g.rows.length),
    terminalSectionIds: schema.terminalSectionIds,
    hasRouting: schema.hasRouting,
    answerModel: schema.answerModel,
  };
}

describe('golden structural result (observed-responder)', () => {
  const schema = parseGoogleFormsHtml(FIXTURE_HTML, {
    url: 'https://fixtures.local/forms/observed-responder',
    capturedAt: '2026-01-01T00:00:00.000Z',
  });

  it('matches the committed golden summary exactly', () => {
    expect(summarize(schema)).toEqual(GOLDEN);
  });

  // Human-facing spot checks (kept independent of the JSON so a bad artifact
  // cannot silently mask a wrong parse).
  it('has 5 sections, 27 questions, and the documented kind counts', () => {
    expect(schema.sections).toHaveLength(5);
    expect(schema.parts).toHaveLength(27);
    expect((GOLDEN.kindCounts as Record<string, number>)).toEqual({
      text: 8,
      'paragraph-text': 3,
      'single-choice': 1,
      'multi-choice': 3,
      'linear-scale': 5,
      'multiple-choice-grid': 4,
      date: 1,
      time: 2,
    });
  });

  it('is sequential with a single terminal submit section and 4 required questions', () => {
    expect((GOLDEN.hasRouting as boolean)).toBe(false);
    expect((GOLDEN.terminalSectionIds as string[])).toEqual(['1860209072']);
    expect((GOLDEN.requiredQuestionIds as string[])).toHaveLength(4);
  });
});
