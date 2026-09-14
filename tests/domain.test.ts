/**
 * Domain types + fingerprint tests.
 */

import { describe, expect, it } from 'vitest';

import {
  DOMAIN_PROVIDER_ID,
  OFFICIAL_SAMPLE_FORMS,
  assertNever,
  clamp,
  isChoiceQuestion,
  isFileUploadQuestion,
  isGridQuestion,
  isScaleQuestion,
  isFreeTextQuestion,
  maxChoicesFor,
  otherOpenSlot,
  suffixId,
  titleThread,
} from '../src/domain/types.ts';
import { canonicalJson, jsonFingerprint, structuralFingerprint } from '../src/domain/fingerprint.ts';
import { answerValueKind } from '../src/domain/answer.ts';

describe('domain utils', () => {
  it('suffixId joins parts', () => {
    expect(suffixId(['official-sample', 'q1'])).toBe('official-sample.q1');
    expect(suffixId(['a', 1])).toBe('a.1');
  });

  it('titleThread drops empties', () => {
    expect(titleThread(['Heading', undefined, ''])).toBe('Heading');
    expect(titleThread(['a', 'b'], ' / ')).toBe('a / b');
  });

  it('clamp bounds values', () => {
    expect(clamp(5, 1, 4)).toBe(4);
    expect(clamp(0, 1, 4)).toBe(1);
    expect(clamp(3, 1, 4)).toBe(3);
  });

  it('otherOpenSlot sits below the next whole slot', () => {
    expect(otherOpenSlot(0)).toBe(0.5);
    expect(otherOpenSlot(2)).toBe(2.5);
  });

  it('assertNever throws', () => {
    expect(() => assertNever('boom' as never)).toThrow(/unreachable/);
  });
});

describe('question kind guards', () => {
  const text = OFFICIAL_SAMPLE_FORMS.sampleSingleChoice;
  const scale = OFFICIAL_SAMPLE_FORMS.sampleLinearScale;

  it('classifies structurally', () => {
    expect(isChoiceQuestion(text)).toBe(true);
    expect(isScaleQuestion(scale)).toBe(true);
    expect(isFreeTextQuestion(scale)).toBe(false);
    expect(isGridQuestion(text)).toBe(false);
    expect(isFileUploadQuestion(text)).toBe(false);
  });

  it('maxChoicesFor is sound', () => {
    expect(maxChoicesFor(text)).toBe(1);
    expect(maxChoicesFor(scale)).toBeUndefined();
  });
});

describe('canonicalJson', () => {
  it('is key-order invariant', () => {
    const a = canonicalJson({ b: 1, a: [true, 'x', null] });
    const b = canonicalJson({ a: [true, 'x', null], b: 1 });
    expect(a).toBe(b);
  });

  it('strips undefined, preserves null and -0', () => {
    expect(canonicalJson({ x: undefined, y: null, z: -0 })).toBe('{"y":null,"z":0}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: Infinity })).toThrow(/non-finite/);
  });

  it('rejects Dates with a helpful message', () => {
    expect(() => canonicalJson({ at: new Date() })).toThrow(/ISO string/);
  });

  it('handles nested arrays and objects', () => {
    expect(canonicalJson({ list: [{ k: 2 }, [1, 2]] })).toBe('{"list":[{"k":2},[1,2]]}');
  });
});

describe('structural fingerprint', () => {
  const input = {
    providerId: DOMAIN_PROVIDER_ID,
    formId: 'abc',
    formJson: OFFICIAL_SAMPLE_FORMS.sampleSingleChoice,
    generatorVersion: '0.1.0',
  };

  it('is deterministic and length-stable', () => {
    const a = structuralFingerprint(input);
    const b = structuralFingerprint(input);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('changes when the form changes', () => {
    const changed = structuralFingerprint({
      ...input,
      formJson: OFFICIAL_SAMPLE_FORMS.sampleLinearScale,
    });
    expect(changed).not.toBe(structuralFingerprint(input));
  });

  it('ignores key ordering in the form schema', () => {
    // The object below is sampleSingleChoice with its keys re-ordered; it must
    // therefore produce an identical fingerprint (canonical JSON sorts keys).
    const reordered = structuralFingerprint({
      ...input,
      formJson: {
        otherLabels: [] as string[],
        isOtherOpen: false,
        options: ['Very satisfied', 'Satisfied', 'Neutral', 'Dissatisfied', 'Very dissatisfied'].map(
          (label) => ({ label, isOther: false }),
        ),
        choices: ['Very satisfied', 'Satisfied', 'Neutral', 'Dissatisfied', 'Very dissatisfied'],
        sensitive: false,
        required: 'required',
        kind: 'single-choice',
        titleThread: 'Feedback — How satisfied are you with your current role?',
        title: 'How satisfied are you with your current role?',
        slot: 0,
        id: 'q1',
      },
    });
    expect(reordered).toBe(structuralFingerprint(input));
  });

  it('jsonFingerprint is canonical too', () => {
    const a = jsonFingerprint({ x: 1, y: [2, 3] });
    const b = jsonFingerprint({ y: [2, 3], x: 1 });
    expect(a).toBe(b);
  });
});

describe('answer value model', () => {
  it('classifies kinds', () => {
    expect(answerValueKind('Red')).toBe('text');
    expect(answerValueKind(['a', 'b'])).toBe('multi-choice');
    expect(answerValueKind(4)).toBe('scale');
    expect(answerValueKind({ row1: 'Agree' })).toBe('grid');
    expect(answerValueKind({ row1: ['Mon', 'Tue'] })).toBe('multi-grid');
  });
});