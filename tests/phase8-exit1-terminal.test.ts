/**
 * Phase 8 exit-1 terminal classification (Finding I).
 *
 * Generic exit-1 `error` is NOT in the frozen `UNAMBIGUOUS_TERMINAL_RESULTS`
 * list. After the submit child starts, an exit-1 result (structured kind:"error",
 * `outcome:"unknown_outcome"`, or malformed output) is `unknown_outcome` and
 * must persist `consumed_unknown` — never a `completed_unambiguous` handoff.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { classifySubmitResult } from '../src/openclaw/adapter.ts';
import { pendingFilePath, PendingStore } from '../src/openclaw/pending.ts';
import {
  SUBMIT_CLAIM_IDENTITY,
  exitResult,
  makeAdapter,
  runErrorDoc,
  submitParams,
  submitSuccessDoc,
} from './support/phase8.ts';
import { PRINCIPAL, getPreflightPending, preflightEnvelope } from './support/phase8-preflight.ts';

const classify = (result: Parameters<typeof classifySubmitResult>[0]) =>
  classifySubmitResult(result, SUBMIT_CLAIM_IDENTITY);

describe('classifySubmitResult exit-1 contract (I1)', () => {
  it('exit 1 + structured kind:"error" is ambiguous unknown_outcome', () => {
    for (const doc of [
      runErrorDoc('EXECUTION_BROWSER_ERROR', 'error', 'submit'),
      runErrorDoc('SOME_OTHER_EXIT1_CODE', 'error', 'submit'),
    ]) {
      const result = classify(exitResult(1, doc));
      expect(result.ambiguous).toBe(true);
      expect(result.category).toBe('unknown_outcome');
      expect(result.formAgentExitCode).toBe(1);
    }
  });

  it('exit 1 + outcome:"unknown_outcome" is ambiguous unknown_outcome', () => {
    const result = classify(exitResult(1, JSON.stringify({ command: 'run', mode: 'submit', outcome: 'unknown_outcome' })));
    expect(result.ambiguous).toBe(true);
    expect(result.category).toBe('unknown_outcome');
  });

  it('exit 1 + malformed output is ambiguous unknown_outcome', () => {
    const result = classify(exitResult(1, 'boom'));
    expect(result.ambiguous).toBe(true);
    expect(result.category).toBe('unknown_outcome');
  });
});

describe('exit-1 Submit orchestration (I2/I3/I6)', () => {
  it('a started submit exiting 1 becomes sticky consumed_unknown, never completed_unambiguous', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    const callsBeforeSubmit = fixture.runner.calls.length;
    fixture.runner.enqueue(exitResult(1, runErrorDoc('EXECUTION_BROWSER_ERROR', 'error', 'submit')));

    const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    expect(envelope.category).toBe('unknown_outcome');
    expect(envelope.status).toBe('unknown_outcome');
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('consumed_unknown');
    // Exactly one Form Agent submit invocation; no automatic retry.
    expect(fixture.runner.calls.length - callsBeforeSubmit).toBe(1);

    // A new preflight is blocked with no Form Agent invocation.
    const preflight = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(preflight.category).toBe('unknown_barrier');
    expect(fixture.runner.calls.length - callsBeforeSubmit).toBe(1);
    fixture.cleanup();
  }, 20_000);

  it('exit 1 malformed output also becomes sticky consumed_unknown (I3)', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.runner.enqueue(exitResult(1, 'not-json'));
    const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    expect(envelope.category).toBe('unknown_outcome');
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('consumed_unknown');
    expect(fixture.store.isCorrupt(PRINCIPAL)).toBe(false);
    fixture.cleanup();
  }, 20_000);
});

describe('persisted generic-error terminal is rejected (I4)', () => {
  it('a completed_unambiguous record with category "error" is corrupt and creates no replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p8-exit1-'));
    mkdirSync(join(dir, 'openclaw-pending'), { recursive: true });
    const record = {
      version: 1,
      pendingId: 'a'.repeat(32),
      principal: PRINCIPAL,
      targetKey: 'fixture:demo-fixture',
      targetArg: 'demo-fixture',
      targetDisplay: 'demo-fixture',
      planId: 'b'.repeat(64),
      seed: 'c'.repeat(32),
      operator: 'telegram:5550001',
      createdAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_600_000,
      status: 'completed_unambiguous',
      attemptId: 'd'.repeat(32),
      claimedAtMs: 1_700_000_000_001,
      ownerPid: process.pid,
      result: {
        category: 'error',
        status: 'error',
        formAgentExitCode: 1,
        pendingId: 'a'.repeat(32),
        attemptId: 'd'.repeat(32),
        planId: 'b'.repeat(64),
        targetDisplay: 'demo-fixture',
        data: { errorCode: 'EXECUTION_BROWSER_ERROR' },
        pending: null,
      },
    };
    writeFileSync(pendingFilePath(dir, PRINCIPAL), JSON.stringify(record));

    const store = new PendingStore({ dataDir: dir });
    expect(store.isCorrupt(PRINCIPAL)).toBe(true);

    const fixture = makeAdapter({ dir });
    const status = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_status',
      pendingRef: 'a'.repeat(32),
      planId: 'b'.repeat(64),
    });
    expect(status.data['state']).toBe('consumed_unknown');
    expect(status.data['result']).toBeUndefined();
    expect(fixture.runner.calls).toHaveLength(0);
    fixture.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('adapter-level strict stdout proof (K8)', () => {
  const cases: Array<{ name: string; result: () => ReturnType<typeof exitResult> }> = [
    {
      name: 'valid JSON + trailing junk',
      result: () => exitResult(3, `${runErrorDoc('EXECUTION_NOT_AUTHORIZED', 'block', 'submit')}\nTRAILING`),
    },
    {
      name: 'two JSON documents',
      result: () => exitResult(3, `${runErrorDoc('EXECUTION_NOT_AUTHORIZED', 'block', 'submit')}\n${runErrorDoc('SUBMISSION_ALREADY_CLAIMED', 'block', 'submit')}`),
    },
    {
      name: 'stderr usage proof with empty stdout',
      result: () => exitResult(2, '', runErrorDoc('EXECUTION_TARGET_UNSUPPORTED', 'usage', 'submit')),
    },
    {
      name: 'stderr block proof with malformed stdout',
      result: () => exitResult(3, 'not json', runErrorDoc('EXECUTION_NOT_AUTHORIZED', 'block', 'submit')),
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} -> unknown_outcome + sticky consumed_unknown, no retry`, async () => {
      const fixture = await preflightEnvelope();
      const pending = getPreflightPending(fixture.store, PRINCIPAL);
      if (pending === null) throw new Error('expected a pending record');
      const before = fixture.runner.calls.length;
      fixture.runner.enqueue(testCase.result());

      const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
      expect(envelope.category).toBe('unknown_outcome');
      expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('consumed_unknown');
      expect(fixture.runner.calls.length - before).toBe(1);

      const preflight = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
      expect(preflight.category).toBe('unknown_barrier');
      expect(fixture.runner.calls.length - before).toBe(1);
      fixture.cleanup();
    }, 20_000);
  }
});

describe('adapter-level identity-bound proof (P17)', () => {
  const cases: Array<{ name: string; result: () => ReturnType<typeof exitResult> }> = [
    {
      name: 'preflight-mode usage doc after submit start',
      result: () => exitResult(2, runErrorDoc('EXECUTION_TARGET_UNSUPPORTED', 'usage', 'preflight')),
    },
    {
      name: 'minimal success object without plan/target/receipt proof',
      result: () => exitResult(0, JSON.stringify({ command: 'run', mode: 'submit', outcome: 'success' })),
    },
    {
      name: 'success bound to the wrong planId',
      result: () => {
        const doc = JSON.parse(submitSuccessDoc()) as Record<string, any>;
        doc.plan.planId = 'e'.repeat(64);
        return exitResult(0, JSON.stringify(doc));
      },
    },
    {
      name: 'started-submit usage doc with an extra outer authority field',
      result: () =>
        exitResult(2, JSON.stringify({
          command: 'run',
          mode: 'submit',
          ok: false,
          error: { code: 'EXECUTION_TARGET_UNSUPPORTED', kind: 'usage' },
          outcome: 'success',
        })),
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} -> unknown_outcome + sticky consumed_unknown, no retry`, async () => {
      const fixture = await preflightEnvelope();
      const pending = getPreflightPending(fixture.store, PRINCIPAL);
      if (pending === null) throw new Error('expected a pending record');
      const before = fixture.runner.calls.length;
      fixture.runner.enqueue(testCase.result());

      const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
      expect(envelope.category).toBe('unknown_outcome');
      expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('consumed_unknown');
      expect(fixture.runner.calls.length - before).toBe(1);

      const preflight = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
      expect(preflight.category).toBe('unknown_barrier');
      expect(fixture.runner.calls.length - before).toBe(1);
      fixture.cleanup();
    }, 20_000);
  }
});

describe('accepted unambiguous terminal handoffs still replay (I5)', () => {
  const cases: Array<{ name: string; result: () => ReturnType<typeof exitResult> }> = [
    { name: 'ok_submit_success', result: () => exitResult(0, submitSuccessDoc()) },
    { name: 'blocked_submit', result: () => exitResult(3, runErrorDoc('EXECUTION_NOT_AUTHORIZED', 'block', 'submit')) },
    { name: 'already_claimed', result: () => exitResult(3, runErrorDoc('SUBMISSION_ALREADY_CLAIMED', 'block', 'submit')) },
    { name: 'usage_error', result: () => exitResult(2, runErrorDoc('EXECUTION_TARGET_UNSUPPORTED', 'usage', 'submit')) },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} still persists and replays`, async () => {
      const fixture = await preflightEnvelope();
      const pending = getPreflightPending(fixture.store, PRINCIPAL);
      if (pending === null) throw new Error('expected a pending record');
      fixture.runner.enqueue(testCase.result());
      const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
      expect(envelope.category).toBe(testCase.name);
      expect(fixture.store.isCorrupt(PRINCIPAL)).toBe(false);

      const view = await fixture.adapter.execute(PRINCIPAL, {
        operation: 'submit_status',
        pendingRef: pending.pendingId,
        planId: pending.planId,
      });
      expect(view.data['state']).toBe('completed_unambiguous');
      expect((view.data['result'] as Record<string, unknown>)['category']).toBe(testCase.name);
      fixture.cleanup();
    }, 20_000);
  }
});
