/**
 * Phase 8 race-safe two-step claim/ownership (P8-R11/P8-R27, AM + AO).
 *
 * Pre-spawn claim atomically persists REQUIRED `attemptId` + `claimedAtMs`.
 * `childPid`/`childProcessGroup` are persisted in a SECOND post-spawn update,
 * explicitly `'unavailable'` when unprovable. Both crash windows leave a
 * leftover `claimed` record that recovery converts to `consumed_unknown`.
 */

import { describe, expect, it } from 'vitest';

import { recheckThreePartTarget } from '../src/openclaw/contracts.ts';
import { PendingStore } from '../src/openclaw/pending.ts';
import { exitResult, makeAdapter, submitParams, submitSuccessDoc, FIXTURE_KEY } from './support/phase8.ts';
import { PRINCIPAL, getPreflightPending, preflightEnvelope } from './support/phase8-preflight.ts';

function claimFresh(fixture: ReturnType<typeof makeAdapter>) {
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
  return claimed;
}

describe('pre-spawn claim', () => {
  it('atomically persists attemptId + claimedAtMs with no process identity yet', () => {
    const fixture = makeAdapter();
    const claimed = claimFresh(fixture);
    expect(claimed.status).toBe('claimed');
    expect(claimed.attemptId).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof claimed.claimedAtMs).toBe('number');
    expect(claimed.childPid).toBeUndefined();
    expect(claimed.childProcessGroup).toBeUndefined();
    fixture.cleanup();
  });

  it('cannot reuse a claimed record (claim twice fails closed)', () => {
    const fixture = makeAdapter();
    const claimed = claimFresh(fixture);
    expect(() =>
      fixture.store.claim(
        PRINCIPAL,
        {
          pendingRef: claimed.pendingId,
          planId: claimed.planId,
          targetKey: claimed.targetKey,
          targetDisplay: claimed.targetDisplay,
          expiresAtMs: claimed.expiresAtMs,
        },
        recheckThreePartTarget,
      ),
    ).toThrow();
    fixture.cleanup();
  });
});

describe('post-spawn ownership persistence', () => {
  it('persists childPid + processGroup in a second update', () => {
    const fixture = makeAdapter();
    const claimed = claimFresh(fixture);
    fixture.store.markStarted(PRINCIPAL, claimed.pendingId, claimed.attemptId as string, {
      childPid: 7777,
      childProcessGroup: 7777,
    });
    const record = fixture.store.peekRaw(PRINCIPAL);
    expect(record?.childPid).toBe(7777);
    expect(record?.childProcessGroup).toBe(7777);
    expect(record?.status).toBe('claimed');
    fixture.cleanup();
  });

  it('records unavailable (never fabricates a crash-window PID)', () => {
    const fixture = makeAdapter();
    const claimed = claimFresh(fixture);
    fixture.store.markStarted(PRINCIPAL, claimed.pendingId, claimed.attemptId as string, {
      childPid: 'unavailable',
      childProcessGroup: 'unavailable',
    });
    const record = fixture.store.peekRaw(PRINCIPAL);
    expect(record?.childPid).toBe('unavailable');
    expect(record?.childProcessGroup).toBe('unavailable');
    fixture.cleanup();
  });

  it('a failed/partial metadata write never makes the record reusable', async () => {
    const fixture = makeAdapter();
    const claimed = claimFresh(fixture);
    // Wrong attemptId is a no-op; the record stays claimed and blocks preflight.
    fixture.store.markStarted(PRINCIPAL, claimed.pendingId, 'f'.repeat(32), {
      childPid: 1,
      childProcessGroup: 1,
    });
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('claimed');
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(envelope.category).toBe('unknown_barrier');
    fixture.cleanup();
  });

  it('adapter persists ownership on the real spawn hook', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.runner.enqueue(exitResult(0, submitSuccessDoc()));
    const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    expect(envelope.category).toBe('ok_submit_success');
    const record = fixture.store.peekRaw(PRINCIPAL);
    expect(record?.childPid).toBe(4242);
    expect(record?.childProcessGroup).toBe(4242);
    fixture.cleanup();
  });
});

describe('crash-window recovery (both windows)', () => {
  it('claim-before-spawn leftover converts to consumed_unknown on restart', () => {
    const fixture = makeAdapter();
    const claimed = claimFresh(fixture);
    // A fresh process whose owner is provably gone (simulated via liveness seam).
    const restarted = new PendingStore({ dataDir: fixture.dir, isPidAlive: () => false });
    const record = restarted.read(PRINCIPAL);
    expect(record?.status).toBe('consumed_unknown');
    expect(record?.pendingId).toBe(claimed.pendingId);
    expect(record?.attemptId).toBe(claimed.attemptId);
    fixture.cleanup();
  });

  it('spawned-but-PID-not-persisted leftover also converts to consumed_unknown', () => {
    const fixture = makeAdapter();
    const claimed = claimFresh(fixture);
    fixture.store.markStarted(PRINCIPAL, claimed.pendingId, claimed.attemptId as string, {
      childPid: 'unavailable',
      childProcessGroup: 'unavailable',
    });
    const restarted = new PendingStore({ dataDir: fixture.dir, isPidAlive: () => false });
    expect(restarted.read(PRINCIPAL)?.status).toBe('consumed_unknown');
    fixture.cleanup();
  });
});
