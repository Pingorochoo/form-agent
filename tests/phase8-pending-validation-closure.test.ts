/**
 * Phase 8 closed persisted-state validation (Finding G).
 *
 * Every persisted orchestration record must be validated all the way down:
 * exact principal keys, the full target replay invariant, a frozen terminal
 * category/status/exit contract, and a bounded closed terminal `data` shape.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalizeTarget } from '../src/policy/target.ts';
import type { PendingPrincipal } from '../src/openclaw/contracts.ts';
import { pendingFilePath, PendingStore } from '../src/openclaw/pending.ts';
import {
  exitResult,
  makeAdapter,
  preflightDoc,
  runErrorDoc,
  submitParams,
  submitSuccessDoc,
  terminalSuccessData,
} from './support/phase8.ts';
import { PRINCIPAL, getPreflightPending, preflightEnvelope } from './support/phase8-preflight.ts';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeRaw(dir: string, principal: PendingPrincipal, record: unknown): void {
  mkdirSync(join(dir, 'openclaw-pending'), { recursive: true });
  writeFileSync(pendingFilePath(dir, principal), JSON.stringify(record));
}

function baseRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    status: 'pending',
    ...overrides,
  };
}

const CLAIMED = {
  status: 'claimed',
  attemptId: 'd'.repeat(32),
  claimedAtMs: 1_700_000_000_001,
  ownerPid: process.pid,
};

function completedRecord(resultOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  const pendingId = 'a'.repeat(32);
  const attemptId = 'd'.repeat(32);
  const planId = 'b'.repeat(64);
  return baseRecord({
    ...CLAIMED,
    status: 'completed_unambiguous',
    result: {
      category: 'ok_submit_success',
      status: 'ok',
      formAgentExitCode: 0,
      pendingId,
      attemptId,
      planId,
      targetDisplay: 'demo-fixture',
      data: terminalSuccessData(planId),
      pending: null,
      ...resultOverrides,
    },
  });
}

describe('closed principal validation (G1)', () => {
  it('rejects a principal with any extra field', () => {
    const dir = freshDir('p8-g1-');
    writeRaw(dir, PRINCIPAL, baseRecord({ principal: { ...PRINCIPAL, secret: 'extra' } }));
    expect(new PendingStore({ dataDir: dir }).isCorrupt(PRINCIPAL)).toBe(true);
  });
});

describe('stored target replay invariant (G2)', () => {
  it('rejects a targetKey mismatch', () => {
    const dir = freshDir('p8-g2-key-');
    writeRaw(dir, PRINCIPAL, baseRecord({ targetKey: 'fixture:other' }));
    expect(new PendingStore({ dataDir: dir }).isCorrupt(PRINCIPAL)).toBe(true);
  });

  it('rejects a targetArg that canonicalizes away but is not equal to targetDisplay', () => {
    const dir = freshDir('p8-g2-replay-');
    const url = 'https://docs.google.com/forms/d/e/ABC/viewform';
    const canonical = canonicalizeTarget(url);
    const tamperedArg = `${url}#heading=injected`;
    const tamperedCanonical = canonicalizeTarget(tamperedArg);
    // The tampered arg still canonicalizes to the same key/display ...
    expect(tamperedCanonical.key).toBe(canonical.key);
    expect(tamperedCanonical.display).toBe(canonical.display);
    expect(tamperedArg).not.toBe(canonical.display);
    // ... but the stored three-part replay invariant must reject it.
    writeRaw(
      dir,
      PRINCIPAL,
      baseRecord({ targetKey: canonical.key, targetDisplay: canonical.display, targetArg: tamperedArg }),
    );
    expect(new PendingStore({ dataDir: dir }).isCorrupt(PRINCIPAL)).toBe(true);
  });
});

describe('frozen terminal result contract (G3-G5)', () => {
  it('G3: rejects an unknown terminal category', () => {
    const dir = freshDir('p8-g3-');
    writeRaw(dir, PRINCIPAL, completedRecord({ category: 'ok_weird', status: 'ok', formAgentExitCode: 0 }));
    expect(new PendingStore({ dataDir: dir }).isCorrupt(PRINCIPAL)).toBe(true);
  });

  it('G4: rejects a category/status mismatch', () => {
    const dir = freshDir('p8-g4-');
    writeRaw(dir, PRINCIPAL, completedRecord({ category: 'ok_submit_success', status: 'blocked' }));
    expect(new PendingStore({ dataDir: dir }).isCorrupt(PRINCIPAL)).toBe(true);
  });

  it('G5: rejects an invalid exit-code/category relation', () => {
    const success = freshDir('p8-g5a-');
    writeRaw(success, PRINCIPAL, completedRecord({ category: 'ok_submit_success', formAgentExitCode: 3 }));
    expect(new PendingStore({ dataDir: success }).isCorrupt(PRINCIPAL)).toBe(true);

    const usage = freshDir('p8-g5b-');
    writeRaw(usage, PRINCIPAL, completedRecord({ category: 'usage_error', status: 'error', formAgentExitCode: 0 }));
    expect(new PendingStore({ dataDir: usage }).isCorrupt(PRINCIPAL)).toBe(true);
  });
});

describe('bounded closed terminal data (G6-G7)', () => {
  it('G6: rejects a forbidden field nested beyond the old depth cutoff', () => {
    const dir = freshDir('p8-g6-');
    writeRaw(
      dir,
      PRINCIPAL,
      completedRecord({
        category: 'blocked_submit',
        status: 'blocked',
        formAgentExitCode: 3,
        data: { errorCode: { a: { b: { c: { d: { e: { secret: 'nested' } } } } } } },
      }),
    );
    expect(new PendingStore({ dataDir: dir }).isCorrupt(PRINCIPAL)).toBe(true);
  });

  it('G7: rejects oversized/deep terminal data', () => {
    const oversized = freshDir('p8-g7a-');
    writeRaw(
      oversized,
      PRINCIPAL,
      completedRecord({
        category: 'blocked_submit',
        status: 'blocked',
        formAgentExitCode: 3,
        data: { errorCode: 'x'.repeat(5000) },
      }),
    );
    expect(new PendingStore({ dataDir: oversized }).isCorrupt(PRINCIPAL)).toBe(true);

    const extraKey = freshDir('p8-g7b-');
    writeRaw(
      extraKey,
      PRINCIPAL,
      completedRecord({
        category: 'blocked_submit',
        status: 'blocked',
        formAgentExitCode: 3,
        data: { errorCode: 'CODE', extra: 'not allowed' },
      }),
    );
    expect(new PendingStore({ dataDir: extraKey }).isCorrupt(PRINCIPAL)).toBe(true);
  });
});

describe('real accepted terminal handoffs still reload (G8)', () => {
  const terminals: Array<{ name: string; result: () => ReturnType<typeof exitResult> }> = [
    { name: 'ok_submit_success', result: () => exitResult(0, submitSuccessDoc()) },
    { name: 'blocked_submit', result: () => exitResult(3, runErrorDoc('EXECUTION_NOT_AUTHORIZED', 'block', 'submit')) },
    { name: 'already_claimed', result: () => exitResult(3, runErrorDoc('SUBMISSION_ALREADY_CLAIMED', 'block', 'submit')) },
    { name: 'usage_error', result: () => exitResult(2, runErrorDoc('EXECUTION_TARGET_UNSUPPORTED', 'usage', 'submit')) },
  ];

  for (const terminal of terminals) {
    it(`accepts the adapter-produced ${terminal.name} handoff`, async () => {
      const fixture = await preflightEnvelope();
      const pending = getPreflightPending(fixture.store, PRINCIPAL);
      if (pending === null) throw new Error('expected a pending record');
      fixture.runner.enqueue(terminal.result());
      const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
      expect(envelope.category).toBe(terminal.name);
      expect(fixture.store.isCorrupt(PRINCIPAL)).toBe(false);
      expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('completed_unambiguous');
      fixture.cleanup();
    });
  }
});

describe('known approved recovery of corrupt state (G9)', () => {
  const corruptCases: Array<{ name: string; record: () => Record<string, unknown>; planId: string }> = [
    { name: 'extra principal field', record: () => baseRecord({ principal: { ...PRINCIPAL, secret: 'x' } }), planId: 'b'.repeat(64) },
    { name: 'target replay mismatch', record: () => baseRecord({ targetKey: 'fixture:other' }), planId: 'b'.repeat(64) },
    {
      name: 'unknown terminal category',
      record: () => completedRecord({ category: 'ok_weird', status: 'ok', formAgentExitCode: 0 }),
      planId: 'b'.repeat(64),
    },
    {
      name: 'deep forbidden data',
      record: () =>
        completedRecord({
          category: 'blocked_submit',
          status: 'blocked',
          formAgentExitCode: 3,
          data: { errorCode: { a: { b: { c: { d: { e: { secret: 'deep' } } } } } } },
        }),
      planId: 'b'.repeat(64),
    },
  ];

  for (const testCase of corruptCases) {
    it(`${testCase.name} -> durable conservative barrier, no replay, no Form Agent call`, async () => {
      const dir = freshDir('p8-g9-');
      writeRaw(dir, PRINCIPAL, testCase.record());
      const fixture = makeAdapter({ dir });
      fixture.runner.enqueue(exitResult(0, preflightDoc()));

      const status = await fixture.adapter.execute(PRINCIPAL, {
        operation: 'submit_status',
        pendingRef: 'a'.repeat(32),
        planId: testCase.planId,
      });
      expect(status.data['state']).toBe('consumed_unknown');
      expect(status.data['result']).toBeUndefined();
      expect(fixture.runner.calls).toHaveLength(0);
      expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('consumed_unknown');

      const preflight = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
      expect(preflight.category).toBe('unknown_barrier');
      expect(fixture.runner.calls).toHaveLength(0);
      fixture.cleanup();
    });
  }
});
