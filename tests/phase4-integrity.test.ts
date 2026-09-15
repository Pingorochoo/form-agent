/**
 * Phase 4 integrity + completeness rules (P4-R5, R6).
 *
 * Schema/bundle identity, result-coverage, and kind-mismatch hard-blocks, plus
 * required-unanswered and validation-error hard-blocks. Unknown/untrusted ids
 * are never echoed into issue questionIds.
 */

import { describe, expect, it } from 'vitest';

import { runConsistencyGate } from '../src/consistency/gate.ts';
import { CONSISTENCY_ISSUE_CODES } from '../src/domain/consistency.ts';
import type { DraftBundle, DraftValue, QuestionDraftResult, QuestionDraftState } from '../src/domain/draft.ts';
import { draft } from './support/phase4-draft.ts';
import { makeSchema, singleChoiceQ, textQ } from './support/phase4-schema.ts';

async function singleBundle(): Promise<{ schema: ReturnType<typeof makeSchema>; bundle: DraftBundle }> {
  const schema = makeSchema([textQ('q1', 0, 'How satisfied are you?')]);
  return { schema, bundle: await draft(schema) };
}

describe('P4-R5 — schema/bundle integrity', () => {
  it('fingerprint mismatch hard-blocks', async () => {
    const { schema, bundle } = await singleBundle();
    const report = await runConsistencyGate({ schema, bundle: { ...bundle, fingerprint: 'f'.repeat(64) } });
    expect(report.blocking).toBe(true);
    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.SCHEMA_FINGERPRINT_MISMATCH);
  });

  it('form id mismatch hard-blocks', async () => {
    const { schema, bundle } = await singleBundle();
    const report = await runConsistencyGate({ schema, bundle: { ...bundle, formId: 'other-form' } });
    expect(report.blocking).toBe(true);
    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.FORM_ID_MISMATCH);
  });

  it('profile form id mismatch hard-blocks', async () => {
    const { schema, bundle } = await singleBundle();
    const report = await runConsistencyGate({
      schema,
      bundle: { ...bundle, profile: { ...bundle.profile, formId: 'other-form' } },
    });
    expect(report.blocking).toBe(true);
    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.PROFILE_FORM_MISMATCH);
  });

  it('duplicate draft result ids hard-block', async () => {
    const { schema, bundle } = await singleBundle();
    const report = await runConsistencyGate({ schema, bundle: { ...bundle, results: [...bundle.results, bundle.results[0]!] } });
    const issue = report.issues.find((i) => i.code === CONSISTENCY_ISSUE_CODES.DRAFT_RESULT_COVERAGE_MISMATCH);
    expect(report.blocking).toBe(true);
    expect(issue).toBeDefined();
    expect(issue?.questionIds).toEqual(['q1']);
  });

  it('unknown draft result ids hard-block without echoing the unknown id', async () => {
    const { schema, bundle } = await singleBundle();
    const ghost = {
      questionId: 'VERY_SECRET_PROVIDER_VALUE',
      kind: 'text',
      required: false,
      state: { state: 'answered', value: { kind: 'text', value: 'x' } },
    } as DraftBundle['results'][number];
    const report = await runConsistencyGate({ schema, bundle: { ...bundle, results: [...bundle.results, ghost] } });
    const issue = report.issues.find((i) => i.code === CONSISTENCY_ISSUE_CODES.DRAFT_RESULT_COVERAGE_MISMATCH);
    expect(report.blocking).toBe(true);
    expect(issue).toBeDefined();
    expect(issue?.questionIds).toEqual([]);
    // The sentinel never appears in the structured report, the issue code, or
    // the sanitized issue message.
    expect(JSON.stringify(report)).not.toContain('VERY_SECRET_PROVIDER_VALUE');
    expect(issue?.message).not.toContain('VERY_SECRET_PROVIDER_VALUE');
    expect(issue?.code).not.toContain('VERY_SECRET_PROVIDER_VALUE');
  });

  it('missing schema-question results hard-block', async () => {
    const { schema, bundle } = await singleBundle();
    const report = await runConsistencyGate({ schema, bundle: { ...bundle, results: [] } });
    const issue = report.issues.find((i) => i.code === CONSISTENCY_ISSUE_CODES.DRAFT_RESULT_COVERAGE_MISMATCH);
    expect(report.blocking).toBe(true);
    expect(issue?.questionIds).toEqual(['q1']);
  });

  it('result kind mismatch hard-blocks', async () => {
    const { schema, bundle } = await singleBundle();
    const results = bundle.results.map((r) => (r.questionId === 'q1' ? { ...r, kind: 'paragraph-text' } : r));
    const report = await runConsistencyGate({ schema, bundle: { ...bundle, results } });
    expect(report.blocking).toBe(true);
    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.DRAFT_RESULT_KIND_MISMATCH);
  });
});

describe('P4-R6 — required/completeness and validation-state', () => {
  it('required question with a non-answered state hard-blocks', async () => {
    const schema = makeSchema([textQ('q1', 0, 'How satisfied are you?', 'required')]);
    const bundle = await draft(schema);
    const blockedState: QuestionDraftState = { state: 'blocked-sensitive', categories: ['health'], mode: 'never', reason: 'test' };
    const results = bundle.results.map((r) =>
      r.questionId === 'q1' ? { ...r, state: blockedState } : r,
    );
    const report = await runConsistencyGate({ schema, bundle: { ...bundle, results } });
    expect(report.blocking).toBe(true);
    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.REQUIRED_QUESTION_UNANSWERED);
  });

  it('validation-error state hard-blocks', async () => {
    const schema = makeSchema([textQ('q1', 0, 'How satisfied are you?')]);
    const bundle = await draft(schema);
    const errorState: QuestionDraftState = { state: 'validation-error', reason: 'test' };
    const results = bundle.results.map((r) => (r.questionId === 'q1' ? { ...r, state: errorState } : r));
    const report = await runConsistencyGate({ schema, bundle: { ...bundle, results } });
    expect(report.blocking).toBe(true);
    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.DRAFT_VALIDATION_ERROR);
  });
});

describe('Finding B — integrity failures do not feed semantic comparison', () => {
  function answered(value: DraftValue): QuestionDraftState {
    return { state: 'answered', value };
  }

  function conflictingDuplicate(
    bundle: DraftBundle,
    value: DraftValue,
  ): { original: QuestionDraftResult; conflicting: QuestionDraftResult } {
    const original = bundle.results[0] as QuestionDraftResult;
    return {
      original,
      conflicting: { ...original, state: answered(value) },
    };
  }

  it('duplicate known ids hard-block but do NOT produce profile/repetition issues', async () => {
    const schema = makeSchema([singleChoiceQ('q1', 0, 'Preferred mode', ['A', 'B', 'C'])]);
    const bundle = await draft(schema);
    const tag = bundle.semantics.structuredQuestionTags['q1'] ?? 'preferred-mode';
    const trait = bundle.profile.latentTraits.find((t) => t.anchor === tag);
    const different = ['A', 'B', 'C'].find((c) => c !== trait?.value) as string;

    const { original, conflicting } = conflictingDuplicate(bundle, { kind: 'single-choice', value: different });
    const report = await runConsistencyGate({
      schema,
      bundle: { ...bundle, results: [original, conflicting] },
    });

    expect(report.blocking).toBe(true);
    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.DRAFT_RESULT_COVERAGE_MISMATCH);
    expect(report.issues.map((i) => i.code)).not.toContain(CONSISTENCY_ISSUE_CODES.PROFILE_TRAIT_MISMATCH);
    expect(report.issues.map((i) => i.code)).not.toContain(CONSISTENCY_ISSUE_CODES.REPETITION_ANSWER_MISMATCH);
    expect(report.issues.map((i) => i.code)).not.toContain(CONSISTENCY_ISSUE_CODES.REPETITION_POSSIBLE_MISMATCH);
  });

  it('reversing the order of duplicate conflicting results does not change the issue set', async () => {
    const schema = makeSchema([singleChoiceQ('q1', 0, 'Preferred mode', ['A', 'B', 'C'])]);
    const bundle = await draft(schema);
    const tag = bundle.semantics.structuredQuestionTags['q1'] ?? 'preferred-mode';
    const trait = bundle.profile.latentTraits.find((t) => t.anchor === tag);
    const different = ['A', 'B', 'C'].find((c) => c !== trait?.value) as string;

    const { original, conflicting } = conflictingDuplicate(bundle, { kind: 'single-choice', value: different });
    const reportA = await runConsistencyGate({
      schema,
      bundle: { ...bundle, results: [original, conflicting] },
    });
    const reportB = await runConsistencyGate({
      schema,
      bundle: { ...bundle, results: [conflicting, original] },
    });

    expect(reportA.issues).toEqual(reportB.issues);
    expect(reportA.reportId).toBe(reportB.reportId);
  });

  it('an integrity failure suppresses speculative profile issues', async () => {
    const schema = makeSchema([singleChoiceQ('q1', 0, 'Preferred mode', ['A', 'B', 'C'])]);
    const bundle = await draft(schema);
    const tag = bundle.semantics.structuredQuestionTags['q1'] ?? 'preferred-mode';
    const trait = bundle.profile.latentTraits.find((t) => t.anchor === tag);
    const different = ['A', 'B', 'C'].find((c) => c !== trait?.value) as string;

    const results = bundle.results.map((r) =>
      r.questionId === 'q1' ? { ...r, state: answered({ kind: 'single-choice', value: different }) } : r,
    );
    const report = await runConsistencyGate({
      schema,
      bundle: { ...bundle, fingerprint: 'f'.repeat(64), results },
    });

    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.SCHEMA_FINGERPRINT_MISMATCH);
    expect(report.issues.map((i) => i.code)).not.toContain(CONSISTENCY_ISSUE_CODES.PROFILE_TRAIT_MISMATCH);
  });

  it('an integrity failure suppresses speculative repetition issues', async () => {
    const schema = makeSchema([textQ('q1', 0, 'Repeated title'), textQ('q2', 1, 'Repeated title')]);
    const bundle = await draft(schema);
    const results = bundle.results.map((r) =>
      r.questionId === 'q2'
        ? { ...r, state: answered({ kind: 'text', value: 'a deliberately different answer' }) }
        : r,
    );
    const report = await runConsistencyGate({
      schema,
      bundle: { ...bundle, fingerprint: 'f'.repeat(64), results },
    });

    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.SCHEMA_FINGERPRINT_MISMATCH);
    expect(report.issues.map((i) => i.code)).not.toContain(CONSISTENCY_ISSUE_CODES.REPETITION_ANSWER_MISMATCH);
    expect(report.issues.map((i) => i.code)).not.toContain(CONSISTENCY_ISSUE_CODES.REPETITION_POSSIBLE_MISMATCH);
  });

  it('an integrity-clean bundle still runs profile and relationship checks', async () => {
    const schema = makeSchema([textQ('q1', 0, 'Repeated title'), textQ('q2', 1, 'Repeated title')]);
    const bundle = await draft(schema);
    const results = bundle.results.map((r) =>
      r.questionId === 'q2'
        ? { ...r, state: answered({ kind: 'text', value: 'a deliberately different answer' }) }
        : r,
    );
    const report = await runConsistencyGate({ schema, bundle: { ...bundle, results } });

    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.REPETITION_ANSWER_MISMATCH);
  });
});
