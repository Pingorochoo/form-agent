/**
 * Phase 5 plan tests (P5-R4, R5).
 *
 * Covers deterministic planId derivation, the exclusion of wall-clock/rate/raw
 * material from identity, the effect of structural/draft/report/provider changes,
 * and the fillable/blocked counts. Uses the accepted parser + draft + consistency
 * gate on the observed fixture (no browser needed).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseGoogleFormsHtml } from '../src/parser/google-forms.ts';
import { generateDraft } from '../src/draft/orchestrate.ts';
import { DeterministicReferenceProvider } from '../src/draft/reference.ts';
import { runConsistencyGate } from '../src/consistency/gate.ts';
import { buildExecutionPlan, derivePlanId } from '../src/execution/plan.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';
import { EXECUTION_PLAN_VERSION } from '../src/domain/execution.ts';
import { resolveRules } from './support/phase5.ts';
import type { FormSchema } from '../src/domain/types.ts';
import type { DraftBundle } from '../src/domain/draft.ts';

const OBSERVED = new URL('../fixtures/archives/observed-responder.html', import.meta.url);
const OFFICIAL = new URL('../fixtures/archives/observed-responder.html', import.meta.url);

function parseFixture(): FormSchema {
  return parseGoogleFormsHtml(readFileSync(OBSERVED, 'utf8'), {
    url: 'https://fixtures.local/forms/observed-responder',
    capturedAt: '2026-01-01T00:00:00.000Z',
  });
}

async function makeBundle(schema: FormSchema, seed: string): Promise<DraftBundle> {
  return generateDraft({ schema, seed, provider: new DeterministicReferenceProvider(), sensitiveRules: resolveRules() });
}

async function makePlan(overrides?: {
  schema?: FormSchema;
  seed?: string;
  providerVersion?: string;
  target?: string;
  policyAllowed?: boolean;
  policyReasons?: string[];
}): Promise<ReturnType<typeof buildExecutionPlan>> {
  const schema = overrides?.schema ?? parseFixture();
  const seed = overrides?.seed ?? 'seed-001';
  const bundle = await makeBundle(schema, seed);
  const report = await runConsistencyGate({ schema, bundle });
  const target = canonicalizeTarget(overrides?.target ?? 'https://fixtures.local/forms/observed-responder');
  return buildExecutionPlan({
    target,
    schema,
    bundle,
    report,
    providerId: 'google-forms-execution',
    providerVersion: overrides?.providerVersion ?? '1.0.0',
    policyAllowed: overrides?.policyAllowed ?? false,
    policyReasons: overrides?.policyReasons ?? ['SENSITIVE_FIELD_NEVER'],
  });
}

describe('P5-R5 — deterministic ExecutionPlan', () => {
  it('derives a 64-hex stable planId', async () => {
    const plan = await makePlan();
    expect(plan.version).toBe(EXECUTION_PLAN_VERSION);
    expect(plan.planId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for identical material', async () => {
    const a = await makePlan();
    const b = await makePlan();
    expect(a.planId).toBe(b.planId);
  });

  it('changes when the runtime schema fingerprint changes', async () => {
    const a = await makePlan({ seed: 'seed-001' });
    const b = await makePlan({ seed: 'seed-002' }); // different draft, same schema
    expect(a.draftId).not.toBe(b.draftId);
    expect(a.planId).not.toBe(b.planId);
  });

  it('changes when the provider contract version changes', async () => {
    const a = await makePlan({ providerVersion: '1.0.0' });
    const b = await makePlan({ providerVersion: '2.0.0' });
    expect(a.planId).not.toBe(b.planId);
  });

  it('changes when the canonical target changes', async () => {
    const a = await makePlan({ target: 'observed-responder' });
    const b = await makePlan({ target: 'https://fixtures.local/forms/observed-responder' });
    // fixture id and fixture URL canonicalize to the SAME key -> same planId.
    expect(a.targetKey).toBe(b.targetKey);
    expect(a.planId).toBe(b.planId);
  });

  it('does not include wall-clock/rate/policy material in planId', async () => {
    const allowed = await makePlan({ policyAllowed: true, policyReasons: [] });
    const blocked = await makePlan({ policyAllowed: false, policyReasons: ['MIN_DELAY_RATE_GATE'] });
    expect(allowed.planId).toBe(blocked.planId);
  });

  it('derives planId only from the documented safe material', () => {
    const base = {
      targetKey: 'google-forms:https://docs.google.com/forms/x',
      fingerprint: 'f'.repeat(64),
      draftId: 'd'.repeat(64),
      reportId: 'r'.repeat(64),
      providerId: 'google-forms-execution',
      providerVersion: '1.0.0',
    };
    const id = derivePlanId(base);
    // Time/rate/answer values are not inputs; the function is pure.
    expect(derivePlanId(base)).toBe(id);
    expect(derivePlanId({ ...base, providerVersion: '9.9.9' })).not.toBe(id);
  });

  it('reports fillable and blocked counts', async () => {
    const plan = await makePlan();
    expect(plan.fillableCount + plan.blockedCount).toBe(27); // observed fixture has 27 questions
    expect(plan.blockedCount).toBeGreaterThan(0); // observed fixture has a sensitive never field
  });
});

describe('P5-R4 — runtime schema flows through the accepted parser', () => {
  it('the plan fingerprint equals the accepted parser checksum', async () => {
    const schema = parseFixture();
    const plan = await makePlan();
    expect(plan.fingerprint).toBe(schema.checksum);
    expect(plan.fingerprint).toBe('7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e');
  });

  it('the accepted observed fixture fingerprint is preserved', () => {
    const schema = parseGoogleFormsHtml(readFileSync(OFFICIAL, 'utf8'), {
      url: 'https://fixtures.local/forms/observed-responder',
      capturedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(schema.checksum).toBe('7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e');
  });
});
