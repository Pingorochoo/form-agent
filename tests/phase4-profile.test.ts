/**
 * Phase 4 profile<->answer conformance (P4-R7).
 *
 * Hard-checks only direct, unambiguous single-choice / linear-scale latent
 * traits. Multi-choice is intentionally NOT hard-enforced, and ambiguous
 * (disagreeing) traits sharing one anchor are skipped rather than guessed.
 */

import { describe, expect, it } from 'vitest';

import { runConsistencyGate } from '../src/consistency/gate.ts';
import { CONSISTENCY_ISSUE_CODES } from '../src/domain/consistency.ts';
import type { DraftBundle, DraftValue } from '../src/domain/draft.ts';
import { draft } from './support/phase4-draft.ts';
import { linearScaleQ, makeSchema, multiChoiceQ, singleChoiceQ } from './support/phase4-schema.ts';

function answeredResult(bundle: DraftBundle, questionId: string, value: DraftValue): DraftBundle {
  return {
    ...bundle,
    results: bundle.results.map((r) =>
      r.questionId === questionId ? { ...r, state: { state: 'answered', value } } : r,
    ),
  };
}

describe('P4-R7 — single-choice conformance', () => {
  it('direct single-choice profile-trait mismatch hard-blocks', async () => {
    const schema = makeSchema([singleChoiceQ('q1', 0, 'Preferred mode', ['A', 'B', 'C'])]);
    const bundle = await draft(schema);
    const tag = bundle.semantics.structuredQuestionTags['q1'];
    const trait = bundle.profile.latentTraits.find((t) => t.anchor === tag);
    expect(typeof trait?.value).toBe('string');
    const different = ['A', 'B', 'C'].find((c) => c !== trait?.value) as string;

    const report = await runConsistencyGate({
      schema,
      bundle: answeredResult(bundle, 'q1', { kind: 'single-choice', value: different }),
    });
    expect(report.blocking).toBe(true);
    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.PROFILE_TRAIT_MISMATCH);
  });

  it('matching single-choice trait passes', async () => {
    const schema = makeSchema([singleChoiceQ('q1', 0, 'Preferred mode', ['A', 'B', 'C'])]);
    const bundle = await draft(schema);
    const report = await runConsistencyGate({ schema, bundle });
    expect(report.issues.map((i) => i.code)).not.toContain(CONSISTENCY_ISSUE_CODES.PROFILE_TRAIT_MISMATCH);
    expect(report.status).toBe('pass');
  });
});

describe('P4-R7 — linear-scale conformance', () => {
  it('direct linear-scale profile-trait mismatch hard-blocks', async () => {
    const schema = makeSchema([linearScaleQ('q1', 0, 'Satisfaction')]);
    const bundle = await draft(schema);
    const tag = bundle.semantics.structuredQuestionTags['q1'];
    const trait = bundle.profile.latentTraits.find((t) => t.anchor === tag);
    expect(typeof trait?.value).toBe('number');
    const different = [1, 2, 3, 4, 5].find((n) => n !== trait?.value) as number;

    const report = await runConsistencyGate({
      schema,
      bundle: answeredResult(bundle, 'q1', { kind: 'linear-scale', value: different }),
    });
    expect(report.blocking).toBe(true);
    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.PROFILE_TRAIT_MISMATCH);
  });

  it('matching linear-scale trait passes', async () => {
    const schema = makeSchema([linearScaleQ('q1', 0, 'Satisfaction')]);
    const bundle = await draft(schema);
    const report = await runConsistencyGate({ schema, bundle });
    expect(report.issues.map((i) => i.code)).not.toContain(CONSISTENCY_ISSUE_CODES.PROFILE_TRAIT_MISMATCH);
    expect(report.status).toBe('pass');
  });
});

describe('P4-R7 — conservative non-enforcement', () => {
  it('does not hard-enforce multi-choice latent preferences', async () => {
    const schema = makeSchema([multiChoiceQ('q1', 0, 'Select tools', ['A', 'B', 'C'])]);
    const bundle = await draft(schema);
    const tag = bundle.semantics.structuredQuestionTags['q1'];
    const trait = bundle.profile.latentTraits.find((t) => t.anchor === tag);
    // Force an answer that is a real choice but is NOT the latent preference.
    const antiTrait = ['A', 'B', 'C'].find((c) => c !== trait?.value) as string;

    const report = await runConsistencyGate({
      schema,
      bundle: answeredResult(bundle, 'q1', { kind: 'multi-choice', value: [antiTrait] }),
    });
    expect(report.issues.map((i) => i.code)).not.toContain(CONSISTENCY_ISSUE_CODES.PROFILE_TRAIT_MISMATCH);
  });

  it('skips hard conformance when multiple traits share an anchor and disagree', async () => {
    const schema = makeSchema([singleChoiceQ('q1', 0, 'Preferred mode', ['A', 'B', 'C'])]);
    const bundle = await draft(schema);
    const tag = bundle.semantics.structuredQuestionTags['q1'] ?? 'preferred-mode';

    const base = { name: tag, confidence: 'medium' as const, rationale: 'test' };
    const disagreeing = [
      { ...base, anchor: tag, value: 'A' },
      { ...base, anchor: tag, value: 'B' },
    ];

    const report = await runConsistencyGate({
      schema,
      bundle: answeredResult({ ...bundle, profile: { ...bundle.profile, latentTraits: disagreeing } }, 'q1', {
        kind: 'single-choice',
        value: 'B',
      }),
    });
    // The answer matches the second trait; picking the first would falsely block.
    expect(report.issues.map((i) => i.code)).not.toContain(CONSISTENCY_ISSUE_CODES.PROFILE_TRAIT_MISMATCH);
    expect(report.blocking).toBe(false);
  });
});
