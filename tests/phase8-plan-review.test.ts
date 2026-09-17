/**
 * Phase 8 review bridge + three privacy cases (P8-R15, Z / §13.2).
 *
 * Default ops deliver no answer values. Exploratory `draft_review` and exact
 * `preflight --review-answers` carry eligible answered values in the LOCAL
 * adapter→plugin envelope only; the pending record never stores them. The exact
 * review uses the SAME preflight invocation (zero second draft/LLM generation).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { extractReviewValues, stripReviewFields } from '../integrations/openclaw-plugin/pending-client.ts';
import { exitResult, makeAdapter, preflightDoc } from './support/phase8.ts';
import { PRINCIPAL, getPreflightPending, preflightEnvelope } from './support/phase8-preflight.ts';

const ANSWERS = [
  { questionId: 'q1', kind: 'text', value: { kind: 'text', value: 'hello-answer' } },
  { questionId: 'q2', kind: 'single-choice', value: { kind: 'single-choice', value: 'A' } },
];

describe('exact preflight plan review', () => {
  it('omits planReview by default and includes eligible answers when requested', async () => {
    const fixture = makeAdapter();
    fixture.runner.enqueue(exitResult(0, preflightDoc({ answers: ANSWERS })));
    fixture.runner.enqueue(exitResult(0, preflightDoc({ answers: ANSWERS })));

    const without = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(without.data).not.toHaveProperty('planReview');

    const withReview = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'preflight',
      target: 'demo-fixture',
      reviewAnswers: true,
    });
    expect(withReview.data['planReview']).toEqual([
      { questionId: 'q1', kind: 'text', value: { kind: 'text', value: 'hello-answer' } },
      { questionId: 'q2', kind: 'single-choice', value: { kind: 'single-choice', value: 'A' } },
    ]);
    fixture.cleanup();
  });

  it('uses the same preflight invocation (no second draft/LLM generation)', async () => {
    const fixture = makeAdapter();
    fixture.runner.enqueue(exitResult(0, preflightDoc({ answers: ANSWERS })));
    await fixture.adapter.execute(PRINCIPAL, {
      operation: 'preflight',
      target: 'demo-fixture',
      reviewAnswers: true,
    });
    expect(fixture.runner.calls).toHaveLength(1);
    fixture.cleanup();
  });

  it('never stores review values in the pending record or pending shapes', async () => {
    const fixture = await preflightEnvelope();
    // re-run with review answers against the same store (replacement identity).
    fixture.runner.enqueue(exitResult(0, preflightDoc({ answers: ANSWERS })));
    const withReview = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'preflight',
      target: 'demo-fixture',
      reviewAnswers: true,
    });
    expect(withReview.data['planReview']).toBeDefined();
    expect(JSON.stringify(withReview.pending)).not.toContain('hello-answer');

    const dir = join(fixture.dir, 'openclaw-pending');
    for (const file of readdirSync(dir)) {
      const body = readFileSync(join(dir, file), 'utf8');
      expect(body).not.toContain('hello-answer');
      expect(body).not.toContain('"value"');
    }
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    expect(pending).not.toHaveProperty('planReview');
    fixture.cleanup();
  });
});

describe('exploratory draft_review', () => {
  it('carries draftAnswers for answered entries only and is not submission-bound', async () => {
    const fixture = makeAdapter();
    const draftReviewDoc = JSON.stringify({
      synthetic: true,
      seed: 'b'.repeat(32),
      draftId: 'd'.repeat(64),
      provider: { id: 'reference', version: '1.0.0' },
      fingerprint: 'f'.repeat(64),
      form: { id: 'form-1', title: 'Fixture Form' },
      summary: { total: 2, answered: 1, blocked: 1, unsupported: 0, validationErrors: 0, requiredUnanswered: 0, complete: true },
      results: [
        { questionId: 'q1', kind: 'text', state: 'answered', value: { kind: 'text', value: 'hello-answer' } },
        { questionId: 'q2', kind: 'text', state: 'blocked-sensitive', value: { kind: 'text', value: 'SECRET' } },
      ],
    });
    fixture.runner.enqueue(exitResult(0, draftReviewDoc));
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'draft_review', target: 'demo-fixture' });
    expect(envelope.category).toBe('ok_draft');
    expect(envelope.data['draftAnswers']).toEqual([
      { questionId: 'q1', kind: 'text', value: { kind: 'text', value: 'hello-answer' } },
    ]);
    // Exploratory: never registers a pending submission.
    expect(envelope.pending).toBeNull();
    expect(fixture.store.peekRaw(PRINCIPAL)).toBeNull();
    fixture.cleanup();
  });

  it('plain draft carries no review values', async () => {
    const fixture = makeAdapter();
    fixture.runner.enqueue(exitResult(0, preflightDoc()));
    fixture.runner.enqueue(exitResult(0, JSON.stringify({ draftId: 'd'.repeat(64), provider: {}, form: {}, summary: {} })));
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'draft', target: 'demo-fixture' });
    expect(envelope.data).not.toHaveProperty('draftAnswers');
    fixture.cleanup();
  });
});

describe('plugin review bridge', () => {
  it('extractReviewValues labels exact vs exploratory and strips from the final result', () => {
    const exact = extractReviewValues({
      version: '1.0.0',
      operation: 'preflight',
      status: 'ok',
      category: 'needs_confirmation',
      formAgentExitCode: 0,
      message: 'm',
      data: { planReview: [{ questionId: 'q1', kind: 'text', value: 'hello-answer' }] },
      pending: null,
    });
    expect(exact?.kind).toBe('exact');
    expect(exact?.lines.join('\n')).toContain('hello-answer');

    const exploratory = extractReviewValues({
      version: '1.0.0',
      operation: 'draft_review',
      status: 'ok',
      category: 'ok_draft',
      formAgentExitCode: 0,
      message: 'm',
      data: { draftAnswers: [{ questionId: 'q1', kind: 'text', value: 'hello-answer' }] },
      pending: null,
    });
    expect(exploratory?.kind).toBe('exploratory');

    const stripped = stripReviewFields({
      planReview: [{ questionId: 'q1' }],
      draftAnswers: [{ questionId: 'q1' }],
      formTitle: null,
    });
    expect(stripped).not.toHaveProperty('planReview');
    expect(stripped).not.toHaveProperty('draftAnswers');
    expect(stripped).toHaveProperty('formTitle');
  });
});
