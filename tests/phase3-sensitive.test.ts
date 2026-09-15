/**
 * Phase 3 sensitivity-gating tests (P3-R8, P3-R2).
 *
 * Phase 2 sensitivity classification is applied before profile generation and
 * before any generated value is requested for a blocked question. Blocked
 * questions are filtered, not generated then discarded: the provider is never
 * asked about them AND they never contribute a question-answer-like profile
 * trait. Non-sensitive and `synthetic-allowed` questions remain eligible.
 */

import { describe, expect, it } from 'vitest';

import { generateDraft } from '../src/draft/orchestrate.ts';
import { DeterministicReferenceProvider } from '../src/draft/reference.ts';
import { resolveSensitiveRules } from '../src/policy/policy-config.ts';
import type { SensitiveRule } from '../src/policy/sensitive.ts';
import type { DraftProvider } from '../src/draft/provider.ts';
import { makeSchema, textQ } from './support/phase3-schema.ts';
import { singleChoice, linearScale, multiChoiceWithOther } from './support/sample-schema.ts';

function newProvider(): DeterministicReferenceProvider {
  return new DeterministicReferenceProvider();
}

describe('P3-R8 — sensitivity gating before value generation', () => {
  it('never asks the provider about a blocked sensitive question', async () => {
    const schema = makeSchema([
      textQ('q-never', 'What is your full name?'),
      textQ('q-ok', 'How satisfied are you?'),
    ]);

    const delegate = newProvider();
    const asked: string[] = [];
    const spy: DraftProvider = {
      id: 'spy',
      version: '1.0.0',
      interpretForm: (s, seed) => delegate.interpretForm(s, seed),
      buildProfile: (ctx) => delegate.buildProfile(ctx),
      proposeAnswer: (ctx) => {
        asked.push(ctx.question.id);
        return delegate.proposeAnswer(ctx);
      },
    };

    const bundle = await generateDraft({ schema, seed: 's', provider: spy, sensitiveRules: resolveSensitiveRules([]) });

    expect(asked).toEqual(['q-ok']);
    expect(bundle.results.find((r) => r.questionId === 'q-never')?.state.state).toBe('blocked-sensitive');
    expect(bundle.results.find((r) => r.questionId === 'q-ok')?.state.state).toBe('answered');
  });

  it('filters human-reviewed and specific-authorization questions before generation', async () => {
    const custom: SensitiveRule[] = [
      { id: 'hr-rule', pattern: 'review me', category: 'name', mode: 'human-reviewed' },
      { id: 'sa-rule', pattern: 'authorize me', category: 'name', mode: 'specific-authorization' },
    ];
    const schema = makeSchema([
      textQ('q-hr', 'Please review me'),
      textQ('q-sa', 'Please authorize me'),
      textQ('q-ok', 'Plain question'),
    ]);

    const delegate = newProvider();
    const asked: string[] = [];
    const spy: DraftProvider = {
      id: 'spy',
      version: '1.0.0',
      interpretForm: (s, seed) => delegate.interpretForm(s, seed),
      buildProfile: (ctx) => delegate.buildProfile(ctx),
      proposeAnswer: (ctx) => {
        asked.push(ctx.question.id);
        return delegate.proposeAnswer(ctx);
      },
    };

    const bundle = await generateDraft({ schema, seed: 's', provider: spy, sensitiveRules: resolveSensitiveRules(custom) });

    expect(asked).toEqual(['q-ok']);
    expect(bundle.results.find((r) => r.questionId === 'q-hr')?.state.state).toBe('requires-human-review');
    expect(bundle.results.find((r) => r.questionId === 'q-sa')?.state.state).toBe(
      'requires-specific-authorization',
    );
    expect(bundle.results.find((r) => r.questionId === 'q-ok')?.state.state).toBe('answered');
  });

  it('preserves why a value was not generated', async () => {
    const schema = makeSchema([textQ('q-never', 'What is your full name?')]);
    const bundle = await generateDraft({
      schema,
      seed: 's',
      provider: newProvider(),
      sensitiveRules: resolveSensitiveRules([]),
    });
    const result = bundle.results[0];
    expect(result?.state.state).toBe('blocked-sensitive');
    if (result?.state.state === 'blocked-sensitive') {
      expect(result.state.mode).toBe('never');
      expect(result.state.categories).toContain('name');
      expect(result.state.reason).toBeTruthy();
    }
  });
});

describe('P3-R2 — blocked questions contribute no profile values', () => {
  it('a blocked single-choice question produces no profile trait and no value', async () => {
    const blockedSingle = { ...singleChoice(), id: 'q-choice', title: 'What is your full name?' };
    const schema = makeSchema([blockedSingle, textQ('q-ok', 'Satisfaction')]);
    const delegate = newProvider();
    const asked: string[] = [];
    const spy: DraftProvider = {
      id: 'spy',
      version: '1.0.0',
      interpretForm: (s, seed) => delegate.interpretForm(s, seed),
      buildProfile: (ctx) => delegate.buildProfile(ctx),
      proposeAnswer: (ctx) => {
        asked.push(ctx.question.id);
        return delegate.proposeAnswer(ctx);
      },
    };

    const bundle = await generateDraft({ schema, seed: 's', provider: spy, sensitiveRules: resolveSensitiveRules([]) });

    // The blocked question is never proposed.
    expect(asked).toEqual(['q-ok']);
    // No latent trait derives from the blocked question.
    const tag = bundle.semantics.structuredQuestionTags['q-choice'];
    expect(bundle.profile.latentTraits.some((t) => t.anchor === tag)).toBe(false);
    // The blocked result carries no value.
    const result = bundle.results.find((r) => r.questionId === 'q-choice');
    expect(result?.state.state).toBe('blocked-sensitive');
  });

  it('a blocked linear-scale question produces no profile trait and no value', async () => {
    const blockedScale = { ...linearScale(), id: 'q-scale', title: 'Medical condition scale' };
    const schema = makeSchema([blockedScale, textQ('q-ok', 'Satisfaction')]);
    const delegate = newProvider();
    const asked: string[] = [];
    const spy: DraftProvider = {
      id: 'spy',
      version: '1.0.0',
      interpretForm: (s, seed) => delegate.interpretForm(s, seed),
      buildProfile: (ctx) => delegate.buildProfile(ctx),
      proposeAnswer: (ctx) => {
        asked.push(ctx.question.id);
        return delegate.proposeAnswer(ctx);
      },
    };

    const bundle = await generateDraft({ schema, seed: 's', provider: spy, sensitiveRules: resolveSensitiveRules([]) });

    expect(asked).toEqual(['q-ok']);
    const tag = bundle.semantics.structuredQuestionTags['q-scale'];
    expect(bundle.profile.latentTraits.some((t) => t.anchor === tag)).toBe(false);
    expect(bundle.results.find((r) => r.questionId === 'q-scale')?.state.state).toBe('blocked-sensitive');
  });

  it('a blocked multi-choice question produces no profile trait and no value', async () => {
    const blockedMulti = { ...multiChoiceWithOther(), id: 'q-multi', title: 'Your payment methods' };
    const schema = makeSchema([blockedMulti, textQ('q-ok', 'Satisfaction')]);
    const delegate = newProvider();
    const asked: string[] = [];
    const spy: DraftProvider = {
      id: 'spy',
      version: '1.0.0',
      interpretForm: (s, seed) => delegate.interpretForm(s, seed),
      buildProfile: (ctx) => delegate.buildProfile(ctx),
      proposeAnswer: (ctx) => {
        asked.push(ctx.question.id);
        return delegate.proposeAnswer(ctx);
      },
    };

    const bundle = await generateDraft({ schema, seed: 's', provider: spy, sensitiveRules: resolveSensitiveRules([]) });

    expect(asked).toEqual(['q-ok']);
    const tag = bundle.semantics.structuredQuestionTags['q-multi'];
    expect(bundle.profile.latentTraits.some((t) => t.anchor === tag)).toBe(false);
    expect(bundle.results.find((r) => r.questionId === 'q-multi')?.state.state).toBe('blocked-sensitive');
  });
});
