/**
 * Phase 8 strict status-aware pending validation (Finding C).
 *
 * Parseable-but-semantically-invalid JSON must be `corrupt`, ordinary preflight
 * must fail closed BEFORE spawning Form Agent, and a known approved submit must
 * create/preserve the durable `consumed_unknown` recovery barrier.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { PendingPrincipal } from '../src/openclaw/contracts.ts';
import { pendingFilePath, PendingStore } from '../src/openclaw/pending.ts';
import {
  exitResult,
  makeAdapter,
  preflightDoc,
  terminalSuccessData,
} from './support/phase8.ts';
import { PRINCIPAL } from './support/phase8-preflight.ts';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface RawRecord extends Record<string, unknown> {
  version: number;
  pendingId: string;
  status: string;
}

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeRaw(dir: string, principal: PendingPrincipal, record: unknown): void {
  mkdirSync(join(dir, 'openclaw-pending'), { recursive: true });
  writeFileSync(pendingFilePath(dir, principal), JSON.stringify(record));
}

function baseRecord(overrides: Record<string, unknown> = {}): RawRecord {
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
  } as RawRecord;
}

const CLAIMED_FIELDS = {
  status: 'claimed',
  attemptId: 'd'.repeat(32),
  claimedAtMs: 1_700_000_000_001,
  ownerPid: process.pid,
};

describe('strict semantic validation (C1-C5)', () => {
  it('a parseable partial pending JSON is corrupt (C1)', () => {
    const dir = freshDir('p8-sem-partial-');
    writeRaw(dir, PRINCIPAL, { version: 1, pendingId: 'a'.repeat(32), status: 'pending' });
    const store = new PendingStore({ dataDir: dir });
    expect(store.isCorrupt(PRINCIPAL)).toBe(true);
    expect(store.peekRaw(PRINCIPAL)).toBeNull();
  });

  it('a principal mismatch is corrupt (C2)', () => {
    const dir = freshDir('p8-sem-principal-');
    writeRaw(
      dir,
      PRINCIPAL,
      baseRecord({ principal: { channel: 'telegram', accountId: 'formagent', senderId: '9999999' } }),
    );
    const store = new PendingStore({ dataDir: dir });
    expect(store.isCorrupt(PRINCIPAL)).toBe(true);
  });

  it('malformed planId / seed / timestamps are corrupt (C3)', () => {
    for (const bad of [{ planId: 'not-hex' }, { seed: 'zz' }, { expiresAtMs: 1_700_000_000_000 }]) {
      const dir = freshDir('p8-sem-format-');
      writeRaw(dir, PRINCIPAL, baseRecord(bad));
      expect(new PendingStore({ dataDir: dir }).isCorrupt(PRINCIPAL)).toBe(true);
    }
  });

  it('a claimed record without attempt metadata is corrupt (C4)', () => {
    const dir = freshDir('p8-sem-claimed-');
    writeRaw(dir, PRINCIPAL, baseRecord({ status: 'claimed' }));
    expect(new PendingStore({ dataDir: dir }).isCorrupt(PRINCIPAL)).toBe(true);
  });

  it('completed_unambiguous with a mismatched result binding becomes a durable ambiguity barrier (C5)', () => {
    const dir = freshDir('p8-sem-result-');
    const record = baseRecord({
      ...CLAIMED_FIELDS,
      status: 'completed_unambiguous',
      result: {
        category: 'ok_submit_success',
        status: 'ok',
        formAgentExitCode: 0,
        pendingId: 'f'.repeat(32), // mismatched binding
        attemptId: 'd'.repeat(32),
        planId: 'b'.repeat(64),
        targetDisplay: 'demo-fixture',
        data: {},
        pending: null,
      },
    });
    writeRaw(dir, PRINCIPAL, record);
    const store = new PendingStore({ dataDir: dir });
    const view = store.submitStatus(PRINCIPAL, {
      pendingRef: 'a'.repeat(32),
      planId: 'b'.repeat(64),
      recoverKnownApproved: true,
    });
    expect(view.state).toBe('consumed_unknown');
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('consumed_unknown');
  });
});

describe('valid records still load (C6/C7)', () => {
  it('valid pending/claimed/completed records still load (C6)', () => {
    const dir = freshDir('p8-sem-valid-');
    const store = new PendingStore({ dataDir: dir });
    const created = store.create({
      principal: PRINCIPAL,
      targetKey: 'fixture:demo-fixture',
      targetArg: 'demo-fixture',
      targetDisplay: 'demo-fixture',
      planId: 'b'.repeat(64),
      seed: 'c'.repeat(32),
      operator: 'telegram:5550001',
    });
    expect(store.isCorrupt(PRINCIPAL)).toBe(false);
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('pending');

    const claimed = store.claim(
      PRINCIPAL,
      {
        pendingRef: created.pendingId,
        planId: created.planId,
        targetKey: created.targetKey,
        targetDisplay: created.targetDisplay,
        expiresAtMs: created.expiresAtMs,
      },
      (arg, _key, display) => arg === display,
    );
    expect(store.isCorrupt(PRINCIPAL)).toBe(false);
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('claimed');

    store.markCompletedUnambiguous(PRINCIPAL, claimed.pendingId, claimed.attemptId as string, {
      category: 'ok_submit_success',
      status: 'ok',
      formAgentExitCode: 0,
      data: terminalSuccessData(created.planId),
      pending: null,
    });
    expect(store.isCorrupt(PRINCIPAL)).toBe(false);
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('completed_unambiguous');
  });

  it('a valid recovery tombstone still loads (C7)', () => {
    const dir = freshDir('p8-sem-tombstone-');
    const store = new PendingStore({ dataDir: dir });
    const view = store.submitStatus(PRINCIPAL, {
      pendingRef: 'a'.repeat(32),
      planId: 'b'.repeat(64),
      recoverKnownApproved: true,
    });
    expect(view.state).toBe('consumed_unknown');
    expect(store.isCorrupt(PRINCIPAL)).toBe(false);
    expect(store.peekRaw(PRINCIPAL)?.recoveryTombstone).toBe(true);
    expect(store.barrier(PRINCIPAL)?.status).toBe('consumed_unknown');
  });
});

describe('fail-closed behavior (C1/C8)', () => {
  it('ordinary preflight fails closed BEFORE invoking Form Agent on corrupt state (C1)', async () => {
    const dir = freshDir('p8-sem-preflight-');
    writeRaw(dir, PRINCIPAL, { version: 1, pendingId: 'a'.repeat(32), status: 'pending' });
    const fixture = makeAdapter({ dir });
    fixture.runner.enqueue(exitResult(0, preflightDoc()));
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(envelope.category).toBe('unknown_barrier');
    expect(envelope.status).toBe('blocked');
    expect(fixture.runner.calls).toHaveLength(0);
    fixture.cleanup();
  });

  it('a known approved submit with semantic corruption never becomes reusable pending and never spawns Form Agent (C8)', async () => {
    const dir = freshDir('p8-sem-submit-');
    writeRaw(dir, PRINCIPAL, baseRecord({ status: 'claimed' })); // parseable, missing attempt metadata
    const fixture = makeAdapter({ dir });

    const status = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_status',
      pendingRef: 'a'.repeat(32),
      planId: 'b'.repeat(64),
    });
    expect(status.data['state']).toBe('consumed_unknown');
    expect(fixture.runner.calls).toHaveLength(0);

    // The corrupt state is never treated as reusable pending.
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('consumed_unknown');
    const preflight = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(preflight.category).toBe('unknown_barrier');
    expect(fixture.runner.calls).toHaveLength(0);
    fixture.cleanup();
  });
});
