/**
 * Phase 3 whole-form semantics tests (P3-R3, P3-R4).
 *
 * The deterministic reference provider derives whole-form semantics from the
 * schema (topic, purpose, audience, section semantics, per-question intent,
 * relationships). Structural references are validated: unknown question ids,
 * unknown section ids, unknown relationship targets, and duplicate
 * relationships are rejected deterministically.
 */

import { describe, expect, it } from 'vitest';

import { DeterministicReferenceProvider } from '../src/draft/reference.ts';
import { validateSemanticModel } from '../src/draft/validate.ts';
import { DraftValidationError } from '../src/draft/errors.ts';
import { buildObservedFormSchema } from './support/sample-schema.ts';
import { makeSchema, textQ } from './support/phase3-schema.ts';

const provider = new DeterministicReferenceProvider();

describe('P3-R3 — whole-form semantic analysis', () => {
  const schema = buildObservedFormSchema();
  const semantics = provider.interpretForm(schema, 'seed-1');

  it('represents topic, purpose, and likely audience', () => {
    expect(typeof semantics.topic).toBe('string');
    expect(typeof semantics.purpose).toBe('string');
    expect(semantics.targetAudience).toBeDefined();
    expect(typeof semantics.targetAudience.domain).toBe('string');
  });

  it('represents per-question intent for every question', () => {
    expect(Object.keys(semantics.questions)).toHaveLength(schema.parts.length);
    for (const q of schema.parts) {
      expect(semantics.questions[q.id]).toBeDefined();
      expect(semantics.questions[q.id]?.semanticAnswer.semanticTag).toBeTruthy();
    }
  });

  it('represents section-level meaning for every section', () => {
    expect(semantics.sections).toBeDefined();
    for (const section of schema.sections) {
      expect(semantics.sections?.[section.id]).toBeDefined();
      expect(semantics.sections?.[section.id]?.meaning).toBeTruthy();
    }
  });

  it('detects relationships when titles repeat deterministically', () => {
    // buildObservedFormSchema has two grids with the identical title, which the
    // provider records as repetition relationships.
    const withRelationships = Object.values(semantics.questions).filter((q) => q.relationships.length > 0);
    expect(withRelationships.length).toBeGreaterThan(0);
    for (const q of withRelationships) {
      for (const rel of q.relationships) {
        expect(schema.questions[rel.otherQuestionId]).toBeDefined();
      }
    }
  });

  it('is schema-derived and not hardcoded to one fixture', () => {
    const other = provider.interpretForm(makeSchema([textQ('q-x', 'A question')]), 'seed-1');
    expect(other.topic).not.toBe(semantics.topic);
  });

  it('is deterministic for the same schema', () => {
    const again = provider.interpretForm(schema, 'seed-1');
    expect(again).toEqual(semantics);
  });
});

describe('P3-R4 — semantic-reference validation', () => {
  const schema = buildObservedFormSchema();

  it('accepts valid provider output', () => {
    expect(() => validateSemanticModel(provider.interpretForm(schema, 's'), schema)).not.toThrow();
  });

  it('rejects an unknown question id', () => {
    const model = provider.interpretForm(schema, 's');
    const sample = Object.values(model.questions)[0];
    if (sample !== undefined) {
      (model.questions as Record<string, unknown>)['bogus-question'] = sample;
    }
    expect(() => validateSemanticModel(model, schema)).toThrow(DraftValidationError);
  });

  it('rejects an unknown section id', () => {
    const model = provider.interpretForm(schema, 's');
    const sample = Object.values(model.sections ?? {})[0];
    if (sample !== undefined) {
      (model.sections as Record<string, unknown>)['bogus-section'] = sample;
    }
    expect(() => validateSemanticModel(model, schema)).toThrow(/unknown section id/);
  });

  it('rejects a relationship that references an unknown question', () => {
    const model = provider.interpretForm(schema, 's');
    const firstId = Object.keys(model.questions)[0];
    if (firstId !== undefined) {
      model.questions[firstId]?.relationships.push({
        kind: 'dependency',
        otherQuestionId: 'bogus-question',
        confidence: 'low',
      });
    }
    expect(() => validateSemanticModel(model, schema)).toThrow(/unknown question id/);
  });

  it('rejects a duplicate relationship', () => {
    const model = provider.interpretForm(schema, 's');
    const id = Object.keys(model.questions).find(
      (key) => (model.questions[key]?.relationships.length ?? 0) > 0,
    );
    expect(id).toBeDefined();
    if (id !== undefined) {
      const entry = model.questions[id];
      if (entry !== undefined && entry.relationships[0] !== undefined) {
        entry.relationships.push({ ...entry.relationships[0] });
      }
    }
    expect(() => validateSemanticModel(model, schema)).toThrow(/duplicate semantic relationship/);
  });

  it('rejects a model that is not an object', () => {
    expect(() => validateSemanticModel(null, schema)).toThrow(DraftValidationError);
    expect(() => validateSemanticModel('nope', schema)).toThrow(DraftValidationError);
  });

  it('does not mutate the accepted schema while validating', () => {
    const before = JSON.stringify(schema);
    const model = provider.interpretForm(schema, 's');
    expect(() => validateSemanticModel(model, schema)).not.toThrow();
    expect(JSON.stringify(schema)).toBe(before);
  });
});

describe('P3-R4 — malformed / incomplete semantic output is rejected', () => {
  const schema = buildObservedFormSchema();
  const valid = () => provider.interpretForm(schema, 's');

  it('rejects a missing question entry', () => {
    const model = valid();
    const id = Object.keys(model.questions)[0];
    if (id !== undefined) delete model.questions[id];
    expect(() => validateSemanticModel(model, schema)).toThrow(/missing a question entry/);
  });

  it('rejects a primitive question entry', () => {
    const model = valid();
    const id = Object.keys(model.questions)[0];
    if (id !== undefined) (model.questions as Record<string, unknown>)[id] = 'not-an-object';
    expect(() => validateSemanticModel(model, schema)).toThrow(/question entry must be an object/);
  });

  it('rejects a question entry with no relationships property', () => {
    const model = valid();
    const id = Object.keys(model.questions)[0];
    if (id !== undefined) {
      const entry = model.questions[id] as unknown as Record<string, unknown>;
      delete entry['relationships'];
    }
    expect(() => validateSemanticModel(model, schema)).toThrow(/semantic relationships must be an array/);
  });

  it('rejects a question entry whose embedded id does not match its key', () => {
    const model = valid();
    const id = Object.keys(model.questions)[0];
    if (id !== undefined && model.questions[id] !== undefined) {
      model.questions[id].questionId = 'mismatched';
    }
    expect(() => validateSemanticModel(model, schema)).toThrow(/does not match its record key/);
  });

  it('rejects a missing sections record', () => {
    const model = valid();
    delete (model as unknown as Record<string, unknown>)['sections'];
    expect(() => validateSemanticModel(model, schema)).toThrow(/must include a sections record/);
  });

  it('rejects a missing section entry', () => {
    const model = valid();
    const id = schema.sections[0]?.id;
    if (id !== undefined && model.sections !== undefined) delete model.sections[id];
    expect(() => validateSemanticModel(model, schema)).toThrow(/missing a section entry/);
  });

  it('rejects a malformed section entry', () => {
    const model = valid();
    const id = schema.sections[0]?.id;
    if (id !== undefined && model.sections !== undefined) {
      (model.sections as Record<string, unknown>)[id] = 'not-an-object';
    }
    expect(() => validateSemanticModel(model, schema)).toThrow(/section entry must be an object/);
  });

  it('rejects a section entry whose embedded id does not match its key', () => {
    const model = valid();
    const id = schema.sections[0]?.id;
    if (id !== undefined && model.sections?.[id] !== undefined) {
      model.sections[id].sectionId = 'mismatched';
    }
    expect(() => validateSemanticModel(model, schema)).toThrow(/does not match its record key/);
  });

  it('rejects an unknown structuredQuestionTags key', () => {
    const model = valid();
    (model.structuredQuestionTags as Record<string, unknown>)['bogus'] = 'x';
    expect(() => validateSemanticModel(model, schema)).toThrow(/structuredQuestionTags references an unknown question id/);
  });

  it('rejects a missing structuredQuestionTags entry', () => {
    const model = valid();
    const id = Object.keys(model.structuredQuestionTags)[0];
    if (id !== undefined) delete model.structuredQuestionTags[id];
    expect(() => validateSemanticModel(model, schema)).toThrow(/structuredQuestionTags is missing a question entry/);
  });

  it('rejects a non-string structuredQuestionTags value', () => {
    const model = valid();
    const id = Object.keys(model.structuredQuestionTags)[0];
    if (id !== undefined) (model.structuredQuestionTags as Record<string, unknown>)[id] = 123;
    expect(() => validateSemanticModel(model, schema)).toThrow(/non-empty string/);
  });

  it('does not echo untrusted provider ids in validation errors', () => {
    const model = valid();
    const sample = Object.values(model.questions)[0];
    if (sample !== undefined) {
      (model.questions as Record<string, unknown>)['token=VERY_SECRET_TOKEN'] = sample;
    }
    let message = '';
    try {
      validateSemanticModel(model, schema);
    } catch (err) {
      expect(err).toBeInstanceOf(DraftValidationError);
      message = (err as Error).message;
    }
    expect(message).not.toContain('VERY_SECRET_TOKEN');
  });
});
