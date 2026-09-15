/**
 * Phase 4 consistency-gate core tests (P4-R2, R3, R4, R11, R12, R13).
 *
 * Covers the async-compatible API, deterministic report identity + ordering,
 * status semantics (pass/warn/block), read-only evaluation, and the guarantee
 * that a consistency PASS is not an authorization decision.
 */

import { describe, expect, it } from 'vitest';

import { runConsistencyGate } from '../src/consistency/gate.ts';
import { CONSISTENCY_GATE_VERSION, CONSISTENCY_ISSUE_CODES } from '../src/domain/consistency.ts';
import type { DraftBundle } from '../src/domain/draft.ts';
import { draft } from './support/phase4-draft.ts';
import { linearScaleQ, makeSchema, singleChoiceQ, textQ } from './support/phase4-schema.ts';

describe('P4-R2 — async-compatible consistency API', () => {
  it('runConsistencyGate returns a Promise<ConsistencyReport>', async () => {
    const schema = makeSchema([textQ('q1', 0, 'How satisfied are you?')]);
    const bundle = await draft(schema);
    const result = runConsistencyGate({ schema, bundle });
    expect(result).toBeInstanceOf(Promise);
    const report = await result;
    expect(report.version).toBe(CONSISTENCY_GATE_VERSION);
    expect(report.draftId).toBe(bundle.draftId);
  });
});

describe('P4-R3 — provider-neutral ConsistencyReport', () => {
  it('exposes stable provenance fields', async () => {
    const schema = makeSchema([textQ('q1', 0, 'What do you think?')]);
    const bundle = await draft(schema);
    const report = await runConsistencyGate({ schema, bundle });

    expect(report.version).toBe(CONSISTENCY_GATE_VERSION);
    expect(typeof report.reportId).toBe('string');
    expect(report.reportId.length).toBeGreaterThan(0);
    expect(report.draftId).toBe(bundle.draftId);
    expect(report.fingerprint).toBe(schema.checksum);
    expect(['pass', 'warn', 'block']).toContain(report.status);
    expect(typeof report.blocking).toBe('boolean');
    expect(report.hardIssues).toBe(0);
    expect(report.softIssues).toBe(0);
    expect(report.issues).toEqual([]);
  });
});

describe('P4-R4 — determinism and stable report identity', () => {
  const schema = makeSchema([
    singleChoiceQ('q1', 0, 'Preferred mode', ['A', 'B', 'C']),
    linearScaleQ('q2', 1, 'Satisfaction'),
  ]);

  it('same schema + same bundle produces identical report and reportId', async () => {
    const bundle = await draft(schema);
    const a = await runConsistencyGate({ schema, bundle });
    const b = await runConsistencyGate({ schema, bundle });
    expect(b).toEqual(a);
    expect(b.reportId).toBe(a.reportId);
    expect(b.issues).toEqual(a.issues);
  });

  it('a different draft yields a different reportId', async () => {
    const bundleA = await draft(schema, 'seed-a');
    const bundleB = await draft(schema, 'seed-b');
    const reportA = await runConsistencyGate({ schema, bundle: bundleA });
    const reportB = await runConsistencyGate({ schema, bundle: bundleB });
    expect(reportB.reportId).not.toBe(reportA.reportId);
  });
});

describe('Finding A — report provenance uses the evaluated schema fingerprint', () => {
  it('report.fingerprint equals schema.checksum on a valid bundle', async () => {
    const schema = makeSchema([textQ('q1', 0, 'How satisfied are you?')]);
    const bundle = await draft(schema);
    const report = await runConsistencyGate({ schema, bundle });
    expect(report.fingerprint).toBe(schema.checksum);
  });

  it('on a fingerprint-mismatched bundle, provenance is schema.checksum (not the stale bundle fingerprint)', async () => {
    const schema = makeSchema([textQ('q1', 0, 'How satisfied are you?')]);
    const bundle = await draft(schema);
    const stale = 'f'.repeat(64);
    const report = await runConsistencyGate({ schema, bundle: { ...bundle, fingerprint: stale } });

    expect(report.blocking).toBe(true);
    expect(report.issues.map((i) => i.code)).toContain(CONSISTENCY_ISSUE_CODES.SCHEMA_FINGERPRINT_MISMATCH);
    expect(report.fingerprint).toBe(schema.checksum);
    expect(report.fingerprint).not.toBe(stale);
  });

  it('the same stale bundle against two schemas with different checksums yields different reportIds', async () => {
    const schemaA = makeSchema([textQ('q1', 0, 'How satisfied are you?')], { formId: 'f', checksum: 'a'.repeat(64) });
    const schemaB = makeSchema([textQ('q1', 0, 'How satisfied are you?')], { formId: 'f', checksum: 'b'.repeat(64) });
    const base = await draft(schemaA);
    const stale: DraftBundle = { ...base, fingerprint: 'f'.repeat(64) };

    const reportA = await runConsistencyGate({ schema: schemaA, bundle: stale });
    const reportB = await runConsistencyGate({ schema: schemaB, bundle: stale });

    // Same normalized issue set (one fingerprint mismatch each)...
    expect(reportA.issues).toEqual(reportB.issues);
    // ...but the report identity is anchored to the evaluated schema checksum.
    expect(reportA.fingerprint).toBe(schemaA.checksum);
    expect(reportB.fingerprint).toBe(schemaB.checksum);
    expect(reportA.reportId).not.toBe(reportB.reportId);
  });
});

describe('P4-R12 — enforcement semantics', () => {
  it('hard issue => block', async () => {
    const schema = makeSchema([textQ('q1', 0, 'How satisfied are you?')]);
    const bundle = await draft(schema);
    const tampered: DraftBundle = { ...bundle, fingerprint: 'f'.repeat(64) };
    const report = await runConsistencyGate({ schema, bundle: tampered });
    expect(report.status).toBe('block');
    expect(report.blocking).toBe(true);
    expect(report.hardIssues).toBeGreaterThan(0);
  });

  it('soft-only => warn, blocking false', async () => {
    // Two identical-title text questions; one side is left unanswered, so the
    // repetition relationship cannot be hard-checked and only warns.
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
    expect(report.softIssues).toBeGreaterThan(0);
    expect(report.status).toBe('warn');
    expect(report.blocking).toBe(false);
  });

  it('no issues => pass, blocking false', async () => {
    const schema = makeSchema([textQ('q1', 0, 'How satisfied are you?')]);
    const bundle = await draft(schema);
    const report = await runConsistencyGate({ schema, bundle });
    expect(report.status).toBe('pass');
    expect(report.blocking).toBe(false);
  });
});

describe('P4-R11 — read-only gate', () => {
  it('does not mutate the input DraftBundle', async () => {
    const schema = makeSchema([
      singleChoiceQ('q1', 0, 'Preferred mode', ['A', 'B']),
      linearScaleQ('q2', 1, 'Satisfaction'),
    ]);
    const bundle = await draft(schema);
    const before = JSON.stringify(bundle);
    await runConsistencyGate({ schema, bundle });
    expect(JSON.stringify(bundle)).toBe(before);
  });

  it('does not mutate the input schema', async () => {
    const schema = makeSchema([singleChoiceQ('q1', 0, 'Preferred mode', ['A', 'B'])]);
    const before = JSON.stringify(schema);
    const bundle = await draft(schema);
    await runConsistencyGate({ schema, bundle });
    expect(JSON.stringify(schema)).toBe(before);
  });
});

describe('P4-R13 — consistency is not authorization', () => {
  it('a PASS report carries no authorization signal', async () => {
    const schema = makeSchema([textQ('q1', 0, 'How satisfied are you?')]);
    const bundle = await draft(schema);
    const report = await runConsistencyGate({ schema, bundle });

    expect(report.status).toBe('pass');
    // The report exposes no authorization fields whatsoever.
    expect(report).not.toHaveProperty('authorized');
    expect(report).not.toHaveProperty('allowlisted');
    expect(report).not.toHaveProperty('sensitivePermission');
    expect(report).not.toHaveProperty('runEligible');
    expect(report).not.toHaveProperty('safetyEligible');
    expect(report).not.toHaveProperty('submissionPermitted');
  });
});
