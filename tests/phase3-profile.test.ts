/**
 * Phase 3 synthetic-profile tests (P3-R5, P3-R6, P3-R12).
 *
 * The profile is generic and schema-derived (never hardcoded to a form
 * category), explicitly marked synthetic, deterministic from the seed, and
 * structurally validated. Profile building receives the sensitivity-filtered
 * eligible-question set (P3-R2).
 */

import { describe, expect, it } from 'vitest';

import { DeterministicReferenceProvider } from '../src/draft/reference.ts';
import { validateSyntheticProfile } from '../src/draft/validate.ts';
import { DraftValidationError } from '../src/draft/errors.ts';
import type { FormSchema } from '../src/domain/types.ts';
import type { SemanticModel } from '../src/domain/semantic.ts';
import type { SyntheticProfile } from '../src/domain/profile.ts';
import { buildObservedFormSchema, buildSectionlessSchema } from './support/sample-schema.ts';

const provider = new DeterministicReferenceProvider();

function buildProfile(schema: FormSchema, semantics: SemanticModel, seed: string): SyntheticProfile {
  return provider.buildProfile({
    schema,
    semantics,
    seed,
    eligibleQuestionIds: new Set(schema.parts.map((q) => q.id)),
  });
}

describe('P3-R5 — generic synthetic profile', () => {
  const schema = buildObservedFormSchema();
  const semantics = provider.interpretForm(schema, 'seed');
  const profile = buildProfile(schema, semantics, 'seed');

  it('is not hardcoded to a specific form category', () => {
    const otherSchema = buildSectionlessSchema();
    const otherSemantics = provider.interpretForm(otherSchema, 'seed');
    const otherProfile = buildProfile(otherSchema, otherSemantics, 'seed');
    expect(otherProfile.formId).toBe(otherSchema.formId);
    const categoryConstants = ['student', 'employee', 'customer', 'patient'];
    for (const fact of [...profile.facts, ...otherProfile.facts]) {
      expect(categoryConstants).not.toContain(fact.value);
    }
  });

  it('represents facts and traits', () => {
    expect(profile.facts.length).toBeGreaterThan(0);
    expect(profile.latentTraits.length).toBeGreaterThan(0);
    for (const fact of profile.facts) {
      expect(typeof fact.key).toBe('string');
      expect(['string', 'number', 'boolean']).toContain(typeof fact.value);
    }
  });

  it('belongs to the accepted form and semantic model', () => {
    expect(profile.formId).toBe(schema.formId);
    expect(profile.semanticModelId).toBe(semantics.metadata?.semanticModelId);
  });

  it('does not derive traits from non-eligible questions', () => {
    const restricted = provider.buildProfile({
      schema,
      semantics,
      seed: 'seed',
      eligibleQuestionIds: new Set<string>(),
    });
    // No scale/choice questions are eligible, so no latent traits are derived.
    expect(restricted.latentTraits).toHaveLength(0);
    expect(restricted.facts.length).toBeGreaterThan(0);
  });
});

describe('P3-R12 — synthetic provenance', () => {
  it('marks the profile explicitly synthetic', () => {
    const schema = buildObservedFormSchema();
    const semantics = provider.interpretForm(schema, 'seed');
    const profile = buildProfile(schema, semantics, 'seed');
    expect(profile.synthetic).toBe(true);
  });

  it('rejects a profile that is not explicitly synthetic', () => {
    const schema = buildObservedFormSchema();
    const semantics = provider.interpretForm(schema, 'seed');
    const profile = buildProfile(schema, semantics, 'seed');
    const forged = { ...profile, synthetic: false };
    expect(() => validateSyntheticProfile(forged, schema, semantics)).toThrow(DraftValidationError);
  });

  it('rejects a profile with a mismatched form id or semantic model id', () => {
    const schema = buildObservedFormSchema();
    const semantics = provider.interpretForm(schema, 'seed');
    const profile = buildProfile(schema, semantics, 'seed');
    expect(() => validateSyntheticProfile({ ...profile, formId: 'other' }, schema, semantics)).toThrow(
      DraftValidationError,
    );
    expect(() =>
      validateSyntheticProfile({ ...profile, semanticModelId: 'other' }, schema, semantics),
    ).toThrow(DraftValidationError);
  });
});

describe('P3-R6 — deterministic seed and profile identity', () => {
  const schema = buildObservedFormSchema();

  it('produces an identical profile for the same form + seed', () => {
    const s1 = provider.interpretForm(schema, 'seed-a');
    const p1 = buildProfile(schema, s1, 'seed-a');
    const s2 = provider.interpretForm(schema, 'seed-a');
    const p2 = buildProfile(schema, s2, 'seed-a');
    expect(p2).toEqual(p1);
  });

  it('produces a distinct profile for a different seed', () => {
    const s1 = provider.interpretForm(schema, 'seed-a');
    const p1 = buildProfile(schema, s1, 'seed-a');
    const s2 = provider.interpretForm(schema, 'seed-b');
    const p2 = buildProfile(schema, s2, 'seed-b');
    expect(p2.profileId).not.toBe(p1.profileId);
    expect(p2).not.toEqual(p1);
  });
});
