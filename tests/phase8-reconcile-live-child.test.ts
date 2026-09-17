/**
 * Phase 8 operator-only reconciliation + live-child refusal (P8-R12/P8-R14, AF).
 *
 * `reconcile_unknown` is a privileged local assertion. It refuses to clear a
 * `consumed_unknown` barrier while persisted ownership metadata identifies a
 * still-live process, and requires the exact `pendingRef` + principal. There is
 * no automatic or timeout-based clear.
 */

import { describe, expect, it } from 'vitest';

import { recheckThreePartTarget } from '../src/openclaw/contracts.ts';
import { PendingError, type PendingRecord } from '../src/openclaw/pending.ts';
import { isPidAlive, reconcileUnknown } from '../src/openclaw/reconcile.ts';
import { FIXTURE_KEY, makeAdapter, submitParams } from './support/phase8.ts';
import { PRINCIPAL } from './support/phase8-preflight.ts';

function seedConsumedUnknown(
  fixture: ReturnType<typeof makeAdapter>,
  ownership: { childPid: number | 'unavailable'; childProcessGroup: number | 'unavailable' },
): PendingRecord {
  const created = fixture.store.create({
    principal: PRINCIPAL,
    targetKey: FIXTURE_KEY,
    targetArg: 'demo-fixture',
    targetDisplay: 'demo-fixture',
    planId: 'a'.repeat(64),
    seed: 'b'.repeat(32),
    operator: 'telegram:5550001',
  });
  const claimed = fixture.store.claim(
    PRINCIPAL,
    {
      pendingRef: created.pendingId,
      planId: created.planId,
      targetKey: created.targetKey,
      targetDisplay: created.targetDisplay,
      expiresAtMs: created.expiresAtMs,
    },
    recheckThreePartTarget,
  );
  fixture.store.markStarted(PRINCIPAL, claimed.pendingId, claimed.attemptId as string, ownership);
  fixture.store.markConsumedUnknown(PRINCIPAL, claimed.pendingId, claimed.attemptId as string, 'ambiguous_submit');
  const record = fixture.store.peekRaw(PRINCIPAL);
  if (record === null) throw new Error('expected a consumed_unknown record');
  return record;
}

describe('reconcile_unknown', () => {
  it('refuses to clear when a recorded child may still be live', async () => {
    const fixture = makeAdapter();
    const record = seedConsumedUnknown(fixture, { childPid: process.pid, childProcessGroup: 'unavailable' });
    expect(isPidAlive(process.pid)).toBe(true);

    expect(() =>
      reconcileUnknown({
        store: fixture.store,
        principal: PRINCIPAL,
        pendingRef: record.pendingId,
        resolution: 'observed-submitted',
      }),
    ).toThrow(PendingError);
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('consumed_unknown');

    // Adapter surface: refused, never killed/retried, still blocked.
    const envelope = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'reconcile_unknown',
      pendingRef: record.pendingId,
      resolution: 'observed-submitted',
    });
    expect(envelope.category).toBe('error');
    expect(envelope.data).toMatchObject({ refused: true, reason: 'live_child' });
    expect(fixture.runner.calls).toHaveLength(0);
    fixture.cleanup();
  });

  it('clears after the explicit operator assertion when ownership metadata is unavailable', async () => {
    const fixture = makeAdapter();
    const record = seedConsumedUnknown(fixture, { childPid: 'unavailable', childProcessGroup: 'unavailable' });
    const envelope = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'reconcile_unknown',
      pendingRef: record.pendingId,
      resolution: 'observed-not-submitted',
    });
    expect(envelope.category).toBe('ok_reconciled');
    expect(fixture.store.peekRaw(PRINCIPAL)).toBeNull();
    expect(fixture.runner.calls).toHaveLength(0);
    fixture.cleanup();
  });

  it('requires the exact pendingRef and rejects an unknown one', async () => {
    const fixture = makeAdapter();
    const record = seedConsumedUnknown(fixture, { childPid: 'unavailable', childProcessGroup: 'unavailable' });
    const envelope = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'reconcile_unknown',
      pendingRef: 'f'.repeat(32),
      resolution: 'observed-submitted',
    });
    expect(envelope.category).toBe('no_pending');
    expect(fixture.store.peekRaw(PRINCIPAL)?.pendingId).toBe(record.pendingId);

    const badResolution = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'reconcile_unknown',
      pendingRef: record.pendingId,
      resolution: 'maybe',
    });
    expect(badResolution.category).toBe('usage_error');
    fixture.cleanup();
  });

  it('never auto-clears with time', async () => {
    const fixture = makeAdapter();
    const record = seedConsumedUnknown(fixture, { childPid: 'unavailable', childProcessGroup: 'unavailable' });
    fixture.clock.nowMs += 24 * 60 * 60_000;
    expect(fixture.store.read(PRINCIPAL)?.status).toBe('consumed_unknown');
    expect(fixture.store.peekRaw(PRINCIPAL)?.pendingId).toBe(record.pendingId);
    fixture.cleanup();
  });

  it('is not a submit surface (never invokes Form Agent submit)', async () => {
    const fixture = makeAdapter();
    const record = seedConsumedUnknown(fixture, { childPid: 'unavailable', childProcessGroup: 'unavailable' });
    await fixture.adapter.execute(PRINCIPAL, {
      operation: 'reconcile_unknown',
      pendingRef: record.pendingId,
      resolution: 'observed-submitted',
    });
    expect(fixture.runner.calls).toHaveLength(0);
    // sanity: the helper shape is not model-facing
    expect(submitParams(record).operation).toBe('submit_pending');
    fixture.cleanup();
  });
});
