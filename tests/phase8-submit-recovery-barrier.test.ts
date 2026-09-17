/**
 * Phase 8 durable missing/inconsistent submit recovery barrier (P8-R14, BB-3).
 *
 * For a KNOWN approved submit invocation whose result cannot be proven,
 * `submit_status` atomically creates/preserves a durable `consumed_unknown`
 * tombstone. If barrier persistence itself fails it fails closed (hard recovery
 * error) and never permits a new preflight.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BarrierPersistenceError, PendingStore, pendingFilePath } from '../src/openclaw/pending.ts';
import { exitResult, makeAdapter, submitParams, submitSuccessDoc } from './support/phase8.ts';
import { PRINCIPAL, getPreflightPending, preflightEnvelope } from './support/phase8-preflight.ts';

const PENDING_REF = 'c'.repeat(32);
const PLAN = 'd'.repeat(64);

describe('submit_status READ/NORMALIZE', () => {
  it('creates a durable consumed_unknown tombstone on absent state for a known approved submit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-p8-barrier-'));
    const store = new PendingStore({ dataDir: dir, clock: () => 1_700_000_000_000 });
    const view = store.submitStatus(PRINCIPAL, { pendingRef: PENDING_REF, planId: PLAN, recoverKnownApproved: true });
    expect(view.state).toBe('consumed_unknown');
    expect(view.pendingId).toBe(PENDING_REF);
    expect(view.attemptId).toBe('unavailable');
    expect(view.reason).toBe('adapter_state_missing_or_inconsistent');

    const record = store.peekRaw(PRINCIPAL);
    expect(record?.status).toBe('consumed_unknown');
    expect(record?.recoveryTombstone).toBe(true);
    expect(record?.planId).toBe(PLAN);
  });

  it('does not create a barrier for an ordinary (non-recovery) read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-p8-barrier-none-'));
    const store = new PendingStore({ dataDir: dir });
    expect(store.submitStatus(PRINCIPAL, {})).toEqual({ state: 'none' });
    expect(store.peekRaw(PRINCIPAL)).toBeNull();
  });

  it('creates the conservative tombstone on corrupt state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-p8-barrier-corrupt-'));
    const store = new PendingStore({ dataDir: dir });
    const path = pendingFilePath(dir, PRINCIPAL);
    mkdirSync(join(dir, 'openclaw-pending'), { recursive: true });
    writeFileSync(path, '{this is not a record');
    const view = store.submitStatus(PRINCIPAL, { pendingRef: PENDING_REF, planId: PLAN, recoverKnownApproved: true });
    expect(view.state).toBe('consumed_unknown');
    expect(view.reason).toBe('adapter_state_corrupt');
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('consumed_unknown');
  });

  it('never converts a valid completed handoff into a barrier', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.runner.enqueue(exitResult(0, submitSuccessDoc(pending.planId)));
    await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    const view = fixture.store.submitStatus(PRINCIPAL, {
      pendingRef: pending.pendingId,
      planId: pending.planId,
      recoverKnownApproved: true,
    });
    expect(view.state).toBe('completed_unambiguous');
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('completed_unambiguous');
    fixture.cleanup();
  });
});

describe('barrier persistence failure fails closed', () => {
  it('throws BarrierPersistenceError and blocks a later preflight', async () => {
    const base = mkdtempSync(join(tmpdir(), 'form-agent-p8-nodir-'));
    const notADir = join(base, 'data-dir-is-a-file');
    writeFileSync(notADir, 'not a directory');
    const store = new PendingStore({ dataDir: notADir });
    expect(() =>
      store.submitStatus(PRINCIPAL, { pendingRef: PENDING_REF, planId: PLAN, recoverKnownApproved: true }),
    ).toThrow(BarrierPersistenceError);

    const fixture = makeAdapter({ dir: notADir });
    const envelope = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_status',
      pendingRef: PENDING_REF,
      planId: PLAN,
    });
    expect(envelope.category).toBe('error');
    expect(envelope.data).toMatchObject({ hardRecoveryError: true, persisted: false });

    // Fail-closed session flag: no new preflight may proceed.
    const preflight = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(preflight.category).toBe('unknown_barrier');
    expect(fixture.runner.calls).toHaveLength(0);
    fixture.cleanup();
  });
});
