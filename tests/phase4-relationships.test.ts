/**
 * Phase 4 relationship checks (P4-R8, R9, R10) + canonical comparison.
 *
 * Repetition relations are hard-blocked only under strong deterministic
 * evidence (same section, same kind, high confidence, both answered,
 * comparable); everything weaker only warns. Symmetric A->B / B->A relations
 * are deduplicated. Canonical comparison is deterministic and kind-aware.
 */

import { describe, expect, it } from 'vitest';

import { runConsistencyGate } from '../src/consistency/gate.ts';
import { CONSISTENCY_ISSUE_CODES } from '../src/domain/consistency.ts';
import type { DraftBundle, DraftValue } from '../src/domain/draft.ts';
import { answersEqual } from '../src/consistency/compare.ts';
import { draft } from './support/phase4-draft.ts';
import { makeSchema, singleChoiceQ, textQ } from './support/phase4-schema.ts';

function setAnswer(bundle: DraftBundle, questionId: string, value: DraftValue): DraftBundle {
  return {
    ...bundle,
    results: bundle.results.map((r) =>
      r.questionId === questionId ? { ...r, state: { state: 'answered', value } } : r,
    ),
  };
}

describe('P4-R8/R9 — repetition severity', () => {
  it('strong same-section high-confidence repetition mismatch hard-blocks', async () => {
    const schema = makeSchema([textQ('q1', 0, 'Repeated title'), textQ('q2', 1, 'Repeated title')]);
    const bundle = await draft(schema);
    const tampered = setAnswer(bundle, 'q2', { kind: 'text', value: 'a deliberately different answer' });

    const report = await runConsistencyGate({ schema, bundle: tampered });
    expect(report.blocking).toBe(true);
    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.REPETITION_ANSWER_MISMATCH);
  });

  it('cross-section repetition mismatch only warns', async () => {
    const schema = makeSchema([textQ('q1', 0, 'Repeated title'), textQ('q2', 1, 'Repeated title')], {
      sections: [
        { id: 's1', title: 'One', questionIds: ['q1'] },
        { id: 's2', title: 'Two', questionIds: ['q2'] },
      ],
    });
    const bundle = await draft(schema);
    const tampered = setAnswer(bundle, 'q2', { kind: 'text', value: 'a deliberately different answer' });

    const report = await runConsistencyGate({ schema, bundle: tampered });
    expect(report.hardIssues).toBe(0);
    expect(report.blocking).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.REPETITION_POSSIBLE_MISMATCH);
    expect(report.issues.map((i) => i.code)).not.toContain(CONSISTENCY_ISSUE_CODES.REPETITION_ANSWER_MISMATCH);
  });

  it('differing structural kinds warn instead of coerce/block', async () => {
    const schema = makeSchema([textQ('q1', 0, 'Repeated title'), singleChoiceQ('q2', 1, 'Repeated title', ['A', 'B'])]);
    const bundle = await draft(schema);
    const report = await runConsistencyGate({ schema, bundle });
    expect(report.hardIssues).toBe(0);
    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.RELATIONSHIP_NOT_FULLY_CHECKED);
  });

  it('uncheckable optional relationship warns without block', async () => {
    const schema = makeSchema([textQ('q1', 0, 'Repeated title'), textQ('q2', 1, 'Repeated title')]);
    const bundle = await draft(schema);
    const tampered: DraftBundle = {
      ...bundle,
      results: bundle.results.map((r) =>
        r.questionId === 'q2' ? { ...r, state: { state: 'unsupported', reason: 'test' } } : r,
      ),
    };
    const report = await runConsistencyGate({ schema, bundle: tampered });
    expect(report.hardIssues).toBe(0);
    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.RELATIONSHIP_NOT_FULLY_CHECKED);
  });
});

describe('P4-R10 — symmetric relationship deduplication', () => {
  it('does not emit duplicate issues for A->B and B->A', async () => {
    const schema = makeSchema([textQ('q1', 0, 'Repeated title'), textQ('q2', 1, 'Repeated title')]);
    const bundle = await draft(schema);
    // The reference provider emits both q1->q2 and q2->q1 repetition relations.
    const tampered = setAnswer(bundle, 'q2', { kind: 'text', value: 'a deliberately different answer' });

    const report = await runConsistencyGate({ schema, bundle: tampered });
    const repetitionIssues = report.issues.filter(
      (i) => i.code === CONSISTENCY_ISSUE_CODES.REPETITION_ANSWER_MISMATCH,
    );
    expect(repetitionIssues).toHaveLength(1);
    expect(repetitionIssues[0]?.questionIds).toEqual(['q1', 'q2']);
  });
});

describe('Finding C — relationship issue order follows schema order, not array order', () => {
  function reorderRelationships(bundle: DraftBundle): DraftBundle {
    return {
      ...bundle,
      semantics: {
        ...bundle.semantics,
        questions: Object.fromEntries(
          Object.entries(bundle.semantics.questions).map(([id, q]) => [
            id,
            { ...q, relationships: [...q.relationships].reverse() },
          ]),
        ),
      },
    };
  }

  it('orders multiple repetition pairs by schema order and is stable under reordered arrays', async () => {
    const schema = makeSchema([
      textQ('q1', 0, 'Repeated title'),
      textQ('q2', 1, 'Repeated title'),
      textQ('q3', 2, 'Repeated title'),
    ]);
    const bundle = await draft(schema);
    const tampered: DraftBundle = {
      ...bundle,
      results: bundle.results.map((r) => {
        const values: Record<string, string> = { q1: 'answer one', q2: 'answer two', q3: 'answer three' };
        const value = values[r.questionId];
        return value !== undefined
          ? { ...r, state: { state: 'answered', value: { kind: 'text', value } } }
          : r;
      }),
    };

    const report = await runConsistencyGate({ schema, bundle: tampered });
    const mismatches = report.issues.filter((i) => i.code === CONSISTENCY_ISSUE_CODES.REPETITION_ANSWER_MISMATCH);
    // Schema-order: (q1,q2), (q1,q3), (q2,q3).
    expect(mismatches.map((i) => i.questionIds)).toEqual([
      ['q1', 'q2'],
      ['q1', 'q3'],
      ['q2', 'q3'],
    ]);

    const reorderedReport = await runConsistencyGate({ schema, bundle: reorderRelationships(tampered) });
    expect(reorderedReport.issues).toEqual(report.issues);
    expect(reorderedReport.reportId).toBe(report.reportId);
  });
});

describe('P4-R8 — canonical kind-aware comparison', () => {
  it('text: trims and collapses whitespace, preserves case', () => {
    expect(answersEqual({ kind: 'text', value: '  hello   world  ' }, { kind: 'text', value: 'hello world' })).toBe(true);
    expect(answersEqual({ kind: 'text', value: 'Hello' }, { kind: 'text', value: 'hello' })).toBe(false);
  });

  it('single-choice: exact value', () => {
    expect(answersEqual({ kind: 'single-choice', value: 'A' }, { kind: 'single-choice', value: 'A' })).toBe(true);
    expect(answersEqual({ kind: 'single-choice', value: 'A' }, { kind: 'single-choice', value: 'B' })).toBe(false);
  });

  it('multi-choice: set semantics, order-independent', () => {
    expect(
      answersEqual({ kind: 'multi-choice', value: ['A', 'B'] }, { kind: 'multi-choice', value: ['B', 'A'] }),
    ).toBe(true);
    expect(
      answersEqual({ kind: 'multi-choice', value: ['A', 'B'] }, { kind: 'multi-choice', value: ['A', 'C'] }),
    ).toBe(false);
  });

  it('linear-scale: exact integer', () => {
    expect(answersEqual({ kind: 'linear-scale', value: 3 }, { kind: 'linear-scale', value: 3 })).toBe(true);
    expect(answersEqual({ kind: 'linear-scale', value: 3 }, { kind: 'linear-scale', value: 4 })).toBe(false);
  });

  it('grid: exact row->column mapping, order-independent', () => {
    expect(
      answersEqual(
        { kind: 'multiple-choice-grid', value: { r1: 'X', r2: 'Y' } },
        { kind: 'multiple-choice-grid', value: { r2: 'Y', r1: 'X' } },
      ),
    ).toBe(true);
    expect(
      answersEqual(
        { kind: 'multiple-choice-grid', value: { r1: 'X', r2: 'Y' } },
        { kind: 'multiple-choice-grid', value: { r1: 'X', r2: 'Z' } },
      ),
    ).toBe(false);
  });

  it('date/time: exact components', () => {
    expect(answersEqual({ kind: 'date', value: { year: 2020, month: 1, day: 2 } }, { kind: 'date', value: { year: 2020, month: 1, day: 2 } })).toBe(true);
    expect(answersEqual({ kind: 'date', value: { year: 2020, month: 1, day: 2 } }, { kind: 'date', value: { year: 2020, month: 1, day: 3 } })).toBe(false);
    expect(answersEqual({ kind: 'time', value: { hour: 9, minute: 5 } }, { kind: 'time', value: { hour: 9, minute: 5 } })).toBe(true);
    expect(answersEqual({ kind: 'time', value: { hour: 9, minute: 5 } }, { kind: 'time', value: { hour: 9, minute: 6 } })).toBe(false);
  });

  it('never coerces different kinds', () => {
    expect(answersEqual({ kind: 'text', value: '3' }, { kind: 'linear-scale', value: 3 })).toBe(false);
  });
});
