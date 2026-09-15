/**
 * Phase 3 draft-orchestration tests (P3-R6, P3-R7, P3-R11, P3-R15).
 *
 * Covers determinism, per-question state coverage, shared whole-form/profile
 * context during answer generation, controlled seed/validation failures,
 * required-question completeness, the async provider boundary, and
 * non-leaking of provider values/errors.
 */

import { describe, expect, it } from 'vitest';

import { generateDraft } from '../src/draft/orchestrate.ts';
import { DeterministicReferenceProvider } from '../src/draft/reference.ts';
import { DraftSeedError, DraftValidationError } from '../src/draft/errors.ts';
import { draftToJson, formatDraftHuman } from '../src/draft/format.ts';
import { BUILTIN_SENSITIVE_RULES } from '../src/policy/sensitive.ts';
import { resolveSensitiveRules } from '../src/policy/policy-config.ts';
import type { DraftProvider } from '../src/draft/provider.ts';
import type { SyntheticProfile } from '../src/domain/profile.ts';
import type { Question } from '../src/domain/types.ts';
import type { DraftValue } from '../src/domain/draft.ts';
import { buildObservedFormSchema, choiceGrid, multiChoiceWithOther, singleChoice } from './support/sample-schema.ts';
import { makeSchema, textQ, unsupportedQ } from './support/phase3-schema.ts';

const RULES = BUILTIN_SENSITIVE_RULES;

function newProvider(): DeterministicReferenceProvider {
  return new DeterministicReferenceProvider();
}

/** A provider that returns a fixed proposal per question. */
function failingProvider(propose: (question: Question) => DraftValue): DraftProvider {
  const delegate = newProvider();
  return {
    id: 'bad',
    version: '1.0.0',
    interpretForm: (s, seed) => delegate.interpretForm(s, seed),
    buildProfile: (ctx) => delegate.buildProfile(ctx),
    proposeAnswer: (ctx) => propose(ctx.question),
  };
}

describe('P3-R6 / P3-R7 — deterministic DraftBundle', () => {
  const schema = buildObservedFormSchema();

  it('is reproducible for the same form + seed + provider contract', async () => {
    const a = await generateDraft({ schema, seed: 'respondent-001', provider: newProvider(), sensitiveRules: RULES });
    const b = await generateDraft({ schema, seed: 'respondent-001', provider: newProvider(), sensitiveRules: RULES });
    expect(b).toEqual(a);
    expect(b.draftId).toBe(a.draftId);
  });

  it('produces a distinct deterministic draft for a different seed', async () => {
    const a = await generateDraft({ schema, seed: 'respondent-001', provider: newProvider(), sensitiveRules: RULES });
    const b = await generateDraft({ schema, seed: 'respondent-002', provider: newProvider(), sensitiveRules: RULES });
    expect(b.draftId).not.toBe(a.draftId);
  });

  it('gives every question an explicit draft state', async () => {
    const bundle = await generateDraft({ schema, seed: 's', provider: newProvider(), sensitiveRules: RULES });
    expect(bundle.results).toHaveLength(schema.parts.length);
    const allowed = new Set([
      'answered',
      'blocked-sensitive',
      'requires-human-review',
      'requires-specific-authorization',
      'unsupported',
      'validation-error',
    ]);
    for (const result of bundle.results) {
      expect(allowed.has(result.state.state)).toBe(true);
    }
  });

  it('throws a controlled error for an empty seed', async () => {
    await expect(generateDraft({ schema, seed: '', provider: newProvider(), sensitiveRules: RULES })).rejects.toThrow(
      DraftSeedError,
    );
    await expect(
      generateDraft({ schema, seed: '   ', provider: newProvider(), sensitiveRules: RULES }),
    ).rejects.toThrow(DraftSeedError);
  });

  it('marks the bundle synthetic with provenance', async () => {
    const bundle = await generateDraft({ schema, seed: 's', provider: newProvider(), sensitiveRules: RULES });
    expect(bundle.synthetic).toBe(true);
    expect(bundle.providerId).toBe('deterministic-reference');
    expect(bundle.providerVersion).toBe('1.0.0');
    expect(bundle.fingerprint).toBe(schema.checksum);
    expect(bundle.seed).toBe('s');
  });
});

describe('P3-R2 — async provider boundary', () => {
  it('works with an asynchronous provider without changing orchestration behavior', async () => {
    const schema = buildObservedFormSchema();
    const delegate = newProvider();
    const asyncProvider: DraftProvider = {
      id: 'async-spy',
      version: '1.0.0',
      interpretForm: async (s, seed) => delegate.interpretForm(s, seed),
      buildProfile: async (ctx) => delegate.buildProfile(ctx),
      proposeAnswer: async (ctx) => delegate.proposeAnswer(ctx),
    };

    const bundle = await generateDraft({ schema, seed: 's', provider: asyncProvider, sensitiveRules: RULES });
    const syncBundle = await generateDraft({ schema, seed: 's', provider: newProvider(), sensitiveRules: RULES });

    expect(bundle.results).toEqual(syncBundle.results);
    expect(bundle.profile).toEqual(syncBundle.profile);
    expect(bundle.semantics).toEqual(syncBundle.semantics);
    expect(bundle.results.length).toBe(schema.parts.length);
  });
});

describe('P3-R15 — shared context during drafting', () => {
  it('passes the same semantics/profile to every answer operation', async () => {
    const schema = buildObservedFormSchema();
    const delegate = newProvider();
    const seenProfiles: SyntheticProfile[] = [];
    const seenSemanticsIds: string[] = [];
    const spy: DraftProvider = {
      id: 'spy',
      version: '1.0.0',
      interpretForm: (s, seed) => delegate.interpretForm(s, seed),
      buildProfile: (ctx) => delegate.buildProfile(ctx),
      proposeAnswer: (ctx) => {
        seenProfiles.push(ctx.profile);
        seenSemanticsIds.push(String(ctx.semantics.metadata?.semanticModelId ?? ''));
        return delegate.proposeAnswer(ctx);
      },
    };

    await generateDraft({ schema, seed: 's', provider: spy, sensitiveRules: RULES });

    expect(seenProfiles.length).toBeGreaterThan(0);
    for (const profile of seenProfiles) {
      expect(profile).toBe(seenProfiles[0]);
    }
    for (const id of seenSemanticsIds) {
      expect(id).toBe(seenSemanticsIds[0]);
    }
  });

  it('uses shared profile facts when drafting text answers', async () => {
    const schema = makeSchema([textQ('q-a', 'What do you like?'), textQ('q-b', 'What would you change?')]);
    const bundle = await generateDraft({ schema, seed: 's', provider: newProvider(), sensitiveRules: RULES });
    const role = bundle.profile.facts.find((fact) => fact.key === 'respondent_role')?.value;
    expect(typeof role).toBe('string');
    for (const result of bundle.results) {
      if (result.state.state === 'answered' && result.state.value.kind === 'text') {
        expect(result.state.value.value).toContain(String(role));
      }
    }
  });
});

describe('P3-R11 — required-question completeness', () => {
  it('a required blocked-sensitive question makes the bundle incomplete', async () => {
    const schema = makeSchema([textQ('q-name', 'Full name', 'required')]);
    const bundle = await generateDraft({ schema, seed: 's', provider: newProvider(), sensitiveRules: RULES });
    expect(bundle.summary.complete).toBe(false);
    expect(bundle.summary.requiredUnanswered).toBe(1);
    expect(bundle.results[0]?.state.state).toBe('blocked-sensitive');
  });

  it('a required unsupported question makes the bundle incomplete', async () => {
    const schema = makeSchema([unsupportedQ('q-unk', 'Unknown widget', 'required')]);
    const bundle = await generateDraft({ schema, seed: 's', provider: newProvider(), sensitiveRules: RULES });
    expect(bundle.summary.complete).toBe(false);
    expect(bundle.summary.requiredUnanswered).toBe(1);
    expect(bundle.results[0]?.state.state).toBe('unsupported');
  });

  it('all answered required questions make the bundle complete', async () => {
    const schema = makeSchema([textQ('q-ok', 'How satisfied are you?', 'required')]);
    const bundle = await generateDraft({ schema, seed: 's', provider: newProvider(), sensitiveRules: RULES });
    expect(bundle.summary.complete).toBe(true);
    expect(bundle.summary.requiredUnanswered).toBe(0);
  });

  it('a required question with an empty text answer is incomplete', async () => {
    const schema = makeSchema([textQ('q-x', 'Satisfaction', 'required')]);
    const bundle = await generateDraft({
      schema,
      seed: 's',
      provider: failingProvider(() => ({ kind: 'text', value: '   ' })),
      sensitiveRules: RULES,
    });
    expect(bundle.results[0]?.state.state).toBe('validation-error');
    expect(bundle.summary.complete).toBe(false);
  });

  it('a required question with an empty multi-choice answer is incomplete', async () => {
    const schema = makeSchema([{ ...multiChoiceWithOther(), required: 'required' as const }]);
    const bundle = await generateDraft({
      schema,
      seed: 's',
      provider: failingProvider(() => ({ kind: 'multi-choice', value: [] })),
      sensitiveRules: RULES,
    });
    expect(bundle.results[0]?.state.state).toBe('validation-error');
    expect(bundle.summary.complete).toBe(false);
  });

  it('a required question with an empty grid answer is incomplete', async () => {
    const schema = makeSchema([{ ...choiceGrid(), required: 'required' as const }]);
    const bundle = await generateDraft({
      schema,
      seed: 's',
      provider: failingProvider(() => ({ kind: 'multiple-choice-grid', value: {} })),
      sensitiveRules: RULES,
    });
    expect(bundle.results[0]?.state.state).toBe('validation-error');
    expect(bundle.summary.complete).toBe(false);
  });

  it('a required grid with a partial (missing-row) answer is incomplete', async () => {
    const schema = makeSchema([{ ...choiceGrid(), required: 'required' as const }]);
    const bundle = await generateDraft({
      schema,
      seed: 's',
      provider: failingProvider(() => ({ kind: 'multiple-choice-grid', value: { 'q-grid.r1': 'De acuerdo' } })),
      sensitiveRules: RULES,
    });
    expect(bundle.results[0]?.state.state).toBe('validation-error');
    expect(bundle.summary.complete).toBe(false);
  });
});

describe('P3-R7 — structurally invalid proposals are not promoted', () => {
  it('produces a validation-error state instead of answered', async () => {
    const schema = makeSchema([textQ('q-x', 'A single choice?', 'required')]);
    const provider = failingProvider(() => ({ kind: 'single-choice', value: 'not-a-real-choice' }) as DraftValue);
    const bundle = await generateDraft({ schema, seed: 's', provider, sensitiveRules: RULES });
    expect(bundle.results[0]?.state.state).toBe('validation-error');
    expect(bundle.summary.complete).toBe(false);
  });
});

describe('P3-R17 — provider values/errors do not leak', () => {
  it('does not echo an unknown choice value in human/JSON output', async () => {
    const schema = makeSchema([{ ...multiChoiceWithOther(), required: 'optional' as const }]);
    const bundle = await generateDraft({
      schema,
      seed: 's',
      provider: failingProvider(() => ({ kind: 'multi-choice', value: ['VERY_SECRET_PROVIDER_VALUE'] })),
      sensitiveRules: RULES,
    });
    expect(formatDraftHuman(bundle)).not.toContain('VERY_SECRET_PROVIDER_VALUE');
    expect(JSON.stringify(draftToJson(bundle))).not.toContain('VERY_SECRET_PROVIDER_VALUE');
  });

  it('wraps a raw provider exception without echoing its message', async () => {
    const schema = makeSchema([textQ('q-x', 'Satisfaction')]);
    const provider: DraftProvider = {
      id: 'bad',
      version: '1.0.0',
      interpretForm: () => {
        throw new Error('token=VERY_SECRET_TOKEN');
      },
      buildProfile: (ctx) => {
        void ctx;
        return newProvider().buildProfile({
          schema,
          semantics: newProvider().interpretForm(schema, 's'),
          seed: 's',
          eligibleQuestionIds: new Set<string>(),
        });
      },
      proposeAnswer: (ctx) => {
        void ctx;
        return { kind: 'text', value: 'x' };
      },
    };

    let message = '';
    try {
      await generateDraft({ schema, seed: 's', provider, sensitiveRules: RULES });
    } catch (err) {
      expect(err).toBeInstanceOf(DraftValidationError);
      message = (err as Error).message;
    }
    expect(message).toContain('draft provider failed during semantic interpretation');
    expect(message).not.toContain('VERY_SECRET_TOKEN');
  });

  it('wraps a provider-thrown DraftValidationError without echoing its message', async () => {
    const schema = makeSchema([textQ('q-x', 'Satisfaction')]);
    const provider: DraftProvider = {
      id: 'bad',
      version: '1.0.0',
      interpretForm: () => {
        throw new DraftValidationError('token=VERY_SECRET_TOKEN');
      },
      buildProfile: (ctx) => {
        void ctx;
        return newProvider().buildProfile({
          schema,
          semantics: newProvider().interpretForm(schema, 's'),
          seed: 's',
          eligibleQuestionIds: new Set<string>(),
        });
      },
      proposeAnswer: (ctx) => {
        void ctx;
        return { kind: 'text', value: 'x' };
      },
    };

    let message = '';
    try {
      await generateDraft({ schema, seed: 's', provider, sensitiveRules: RULES });
    } catch (err) {
      expect(err).toBeInstanceOf(DraftValidationError);
      message = (err as Error).message;
    }
    expect(message).toContain('draft provider failed during semantic interpretation');
    expect(message).not.toContain('VERY_SECRET_TOKEN');
  });
});

describe('P3-R6 — draft/profile identity reflects effective policy', () => {
  it('produces identical ids for the same effective policy', async () => {
    const schema = buildObservedFormSchema();
    const a = await generateDraft({ schema, seed: 's', provider: newProvider(), sensitiveRules: RULES });
    const b = await generateDraft({ schema, seed: 's', provider: newProvider(), sensitiveRules: RULES });
    expect(a.draftId).toBe(b.draftId);
    expect(a.profile.profileId).toBe(b.profile.profileId);
  });

  it('changes profile identity when a choice question becomes blocked', async () => {
    const schema = makeSchema([
      { ...singleChoice(), id: 'q-choice', title: 'Preferred mode' },
      textQ('q-ok', 'Satisfaction'),
    ]);
    const baseline = await generateDraft({ schema, seed: 's', provider: newProvider(), sensitiveRules: RULES });
    const blocked = await generateDraft({
      schema,
      seed: 's',
      provider: newProvider(),
      sensitiveRules: resolveSensitiveRules([{ id: 'block-choice', pattern: 'preferred', category: 'name', mode: 'never' }]),
    });

    expect(baseline.results.find((r) => r.questionId === 'q-choice')?.state.state).toBe('answered');
    expect(blocked.results.find((r) => r.questionId === 'q-choice')?.state.state).toBe('blocked-sensitive');
    expect(blocked.profile.profileId).not.toBe(baseline.profile.profileId);
    expect(blocked.draftId).not.toBe(baseline.draftId);
  });

  it('changes draftId when an effective sensitivity state changes', async () => {
    const schema = makeSchema([textQ('q-x', 'review me field'), textQ('q-ok', 'Satisfaction')]);
    const hr = await generateDraft({
      schema,
      seed: 's',
      provider: newProvider(),
      sensitiveRules: resolveSensitiveRules([{ id: 'hr', pattern: 'review me', category: 'name', mode: 'human-reviewed' }]),
    });
    const sa = await generateDraft({
      schema,
      seed: 's',
      provider: newProvider(),
      sensitiveRules: resolveSensitiveRules([{ id: 'sa', pattern: 'review me', category: 'name', mode: 'specific-authorization' }]),
    });

    expect(hr.results.find((r) => r.questionId === 'q-x')?.state.state).toBe('requires-human-review');
    expect(sa.results.find((r) => r.questionId === 'q-x')?.state.state).toBe('requires-specific-authorization');
    expect(hr.draftId).not.toBe(sa.draftId);
  });

  it('does not embed raw custom policy patterns in identity or output', async () => {
    const sentinel = 'VERY_SECRET_CUSTOM_PATTERN';
    const schema = makeSchema([textQ('q-secret', 'Please classify alpha'), textQ('q-ok', 'Satisfaction')]);
    const bundle = await generateDraft({
      schema,
      seed: 's',
      provider: newProvider(),
      sensitiveRules: resolveSensitiveRules([
        { id: 'secret-rule', pattern: `alpha|${sentinel}`, category: 'name', mode: 'never' },
      ]),
    });
    const json = JSON.stringify(draftToJson(bundle));
    expect(bundle.draftId).not.toContain(sentinel);
    expect(bundle.profile.profileId).not.toContain(sentinel);
    expect(json).not.toContain(sentinel);
    expect(bundle.results.find((r) => r.questionId === 'q-secret')?.state.state).toBe('blocked-sensitive');
  });
});
