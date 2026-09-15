/**
 * Phase 5 browser E2E tests (P5-R9, R10, R11, R12, R13, R14, R15, R16, R18, R19).
 *
 * Uses the local loopback execution harness + Chromium only — never a real
 * Google Form. Covers confirmed success, closed form, structural mutation,
 * ambiguous outcome, locator failure/ambiguity, sequential multi-section flow,
 * duplicate-claim refusal, and conservative rate accounting.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExecutionOrchestrator } from '../src/execution/orchestrate.ts';
import { resolveExecutionProvider } from '../src/providers/execution.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';
import { RateStore } from '../src/policy/rate.ts';
import { submissionKeyFor } from '../src/execution/receipt.ts';
import { ExecutionPreSubmitError } from '../src/execution/errors.ts';
import { EXECUTION_PRE_SUBMIT_CODES } from '../src/domain/execution.ts';
import {
  allowFixture,
  makeConfig,
  makeDatabase,
  resolveRules,
  startHarnessContext,
  type HarnessContext,
  type TempDatabase,
} from './support/phase5.ts';
import type { AppConfig } from '../src/config/schema.ts';

let harness: HarnessContext;
let db: TempDatabase;

beforeAll(async () => {
  harness = await startHarnessContext();
  db = makeDatabase();
  for (const id of ['exec-success', 'exec-closed', 'exec-mutation', 'exec-ambiguous', 'exec-locator-failure', 'exec-locator-ambiguous', 'exec-flow']) {
    allowFixture(db.database, id);
  }
});

afterAll(async () => {
  db.cleanup();
  await harness.cleanup();
});

function orchestrator(fixtureId: string, seed: string, mutate?: (config: AppConfig) => void): ExecutionOrchestrator {
  const config = makeConfig(db.dir);
  mutate?.(config);
  const target = canonicalizeTarget(fixtureId);
  return new ExecutionOrchestrator({
    config,
    database: db.database,
    sensitiveRules: resolveRules(),
    provider: resolveExecutionProvider(target, harness.baseUrl),
    target,
    rawTarget: fixtureId,
    seed,
  });
}

async function preflightPlanId(fixtureId: string, seed: string): Promise<string> {
  const result = await orchestrator(fixtureId, seed).preflight();
  return result.plan.planId;
}

describe('P5-R20/R13 — preflight and accepting state', () => {
  it('preflight produces a plan without fill or submit', async () => {
    const result = await orchestrator('exec-success', 'seed-001').preflight();
    expect(result.plan.planId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.plan.fillableCount).toBe(8);
    expect(result.plan.blockedCount).toBe(0);
    expect(result.accepting).toBe('accepting');
    expect(result.receipt.submitAttempted).toBe(false);
    expect(result.receipt.state).toBe('preflight');
  });

  it('closed form aborts before fill', async () => {
    const planId = await preflightPlanId('exec-closed', 'seed-001');
    await expect(orchestrator('exec-closed', 'seed-001').submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_PRE_SUBMIT_CODES.FORM_NOT_ACCEPTING,
    });
  });
});

describe('P5-R9/R10/R15 — confirmed submission fills and verifies all kinds', () => {
  it('fills all 8 executable kinds, verifies, and confirms success', async () => {
    const planId = await preflightPlanId('exec-success', 'seed-001');
    const result = await orchestrator('exec-success', 'seed-001').submit(planId, 'operator-1');
    expect(result.outcome).toBe('success');
    expect(result.evidence?.state).toBe('confirmed');
    expect(result.receipt.state).toBe('success');
    expect(result.receipt.submitAttempted).toBe(true);
    expect(result.receipt.operator).toBe('operator-1');
  });

  it('records a submission rate event at the claim', async () => {
    const before = new RateStore(db.database).listEvents('fixture:exec-success').filter((e) => e.kind === 'submission').length;
    const planId = await preflightPlanId('exec-success', 'seed-rate-1');
    await orchestrator('exec-success', 'seed-rate-1').submit(planId, 'op');
    const after = new RateStore(db.database).listEvents('fixture:exec-success').filter((e) => e.kind === 'submission').length;
    expect(after).toBe(before + 1);
  });
});

describe('P5-R11 — locator failures fail closed', () => {
  it('missing control aborts with LOCATOR_NOT_FOUND', async () => {
    const planId = await preflightPlanId('exec-locator-failure', 'seed-001');
    await expect(orchestrator('exec-locator-failure', 'seed-001').submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_PRE_SUBMIT_CODES.LOCATOR_NOT_FOUND,
    });
  });

  it('ambiguous control aborts with LOCATOR_AMBIGUOUS', async () => {
    const planId = await preflightPlanId('exec-locator-ambiguous', 'seed-001');
    await expect(orchestrator('exec-locator-ambiguous', 'seed-001').submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_PRE_SUBMIT_CODES.LOCATOR_AMBIGUOUS,
    });
  });
});

describe('P5-R14 — fingerprint re-check before submit', () => {
  it('detects structural mutation between fill and submit and does not submit', async () => {
    const planId = await preflightPlanId('exec-mutation', 'seed-001');
    const rateBefore = new RateStore(db.database).listEvents('fixture:exec-mutation').filter((e) => e.kind === 'submission').length;

    await expect(orchestrator('exec-mutation', 'seed-001').submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_PRE_SUBMIT_CODES.FORM_CHANGED_BEFORE_SUBMIT,
    });

    const rateAfter = new RateStore(db.database).listEvents('fixture:exec-mutation').filter((e) => e.kind === 'submission').length;
    expect(rateAfter).toBe(rateBefore); // no submission event before claim
  });
});

describe('P5-R15/R16 — ambiguous outcome and no-retry', () => {
  it('ambiguous post-submit becomes unknown_outcome (not success)', async () => {
    const planId = await preflightPlanId('exec-ambiguous', 'seed-001');
    const result = await orchestrator('exec-ambiguous', 'seed-001').submit(planId, 'op');
    expect(result.outcome).toBe('unknown_outcome');
    expect(result.receipt.state).toBe('unknown_outcome');
    expect(result.receipt.submitAttempted).toBe(true);
  });

  it('records a submission rate event for unknown_outcome (conservative)', async () => {
    const before = new RateStore(db.database).listEvents('fixture:exec-ambiguous').filter((e) => e.kind === 'submission').length;
    const planId = await preflightPlanId('exec-ambiguous', 'seed-rate-2');
    await orchestrator('exec-ambiguous', 'seed-rate-2').submit(planId, 'op');
    const after = new RateStore(db.database).listEvents('fixture:exec-ambiguous').filter((e) => e.kind === 'submission').length;
    expect(after).toBe(before + 1);
  });

  it('duplicate claim for the same plan is refused', async () => {
    const seed = 'seed-dup-1';
    const planId = await preflightPlanId('exec-success', seed);
    const first = await orchestrator('exec-success', seed).submit(planId, 'op');
    expect(first.outcome).toBe('success');

    await expect(orchestrator('exec-success', seed).submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_PRE_SUBMIT_CODES.SUBMISSION_ALREADY_CLAIMED,
    });
  });
});

describe('P5-R8 — plan approval', () => {
  it('wrong planId aborts before fill', async () => {
    await expect(
      orchestrator('exec-success', 'seed-001').submit('f'.repeat(64), 'op'),
    ).rejects.toMatchObject({ code: EXECUTION_PRE_SUBMIT_CODES.PLAN_MISMATCH });
  });
});

describe('P5-R12 — sequential multi-section flow', () => {
  it('navigates sequential sections and confirms success', async () => {
    const planId = await preflightPlanId('exec-flow', 'seed-flow-1');
    const result = await orchestrator('exec-flow', 'seed-flow-1').submit(planId, 'op');
    expect(result.outcome).toBe('success');
    expect(result.receipt.state).toBe('success');
  });
});

describe('P5-R18 — conservative rate accounting', () => {
  it('rate cap blocks a second submission with a stable reason and retry-after', async () => {
    // Fresh database so the daily cap starts at zero for this test.
    const fresh = makeDatabase();
    allowFixture(fresh.database, 'exec-success');
    try {
      const cappedConfig = (config: AppConfig) => {
        config.rate.delayBetweenSubmissionsMs = 0;
        config.rate.maxSubmissionsPerFormPerDay = 1;
        config.database.directory = fresh.dir;
      };
      const build = (seed: string) => {
        const config = makeConfig(fresh.dir);
        cappedConfig(config);
        const target = canonicalizeTarget('exec-success');
        return new ExecutionOrchestrator({
          config,
          database: fresh.database,
          sensitiveRules: resolveRules(),
          provider: resolveExecutionProvider(target, harness.baseUrl),
          target,
          rawTarget: 'exec-success',
          seed,
        });
      };

      const planIdA = await build('seed-cap-a').preflight();
      const first = await build('seed-cap-a').submit(planIdA.plan.planId, 'op');
      expect(first.outcome).toBe('success');

      const planIdB = await build('seed-cap-b').preflight();
      await expect(build('seed-cap-b').submit(planIdB.plan.planId, 'op')).rejects.toMatchObject({
        code: EXECUTION_PRE_SUBMIT_CODES.POLICY_BLOCKED,
      });
      try {
        await build('seed-cap-b').submit(planIdB.plan.planId, 'op');
      } catch (err) {
        expect(err).toBeInstanceOf(ExecutionPreSubmitError);
        expect((err as ExecutionPreSubmitError).retryAfterMs).not.toBeNull();
      }
    } finally {
      fresh.cleanup();
    }
  });

  it('pre-submit abort (closed form) records no submission event', async () => {
    const before = new RateStore(db.database).listEvents('fixture:exec-closed').filter((e) => e.kind === 'submission').length;
    const planId = await preflightPlanId('exec-closed', 'seed-closed-1');
    await expect(orchestrator('exec-closed', 'seed-closed-1').submit(planId, 'op')).rejects.toBeInstanceOf(ExecutionPreSubmitError);
    const after = new RateStore(db.database).listEvents('fixture:exec-closed').filter((e) => e.kind === 'submission').length;
    expect(after).toBe(before);
  });
});

describe('P5-R17 — submission key', () => {
  it('is deterministic from canonical target + planId', () => {
    const a = submissionKeyFor('fixture:exec-success', 'a'.repeat(64));
    const b = submissionKeyFor('fixture:exec-success', 'a'.repeat(64));
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('P5-R19 — browser lifecycle', () => {
  it('preflight leaves a non-claimed preflight receipt (no side effects)', async () => {
    const result = await orchestrator('exec-success', 'seed-life-1').preflight();
    expect(result.receipt.submitAttempted).toBe(false);
    expect(result.receipt.state).toBe('preflight');
    expect(result.receipt.outcome).toBe('preflight');
  });

  it('a fresh browser session opens cleanly after a prior preflight (no leak)', async () => {
    const first = await orchestrator('exec-success', 'seed-life-2').preflight();
    const second = await orchestrator('exec-success', 'seed-life-2').preflight();
    // Same deterministic plan, distinct run receipts.
    expect(second.plan.planId).toBe(first.plan.planId);
    expect(second.receipt.id).not.toBe(first.receipt.id);
  });
});
