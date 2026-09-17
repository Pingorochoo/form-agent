/**
 * Phase 8 idempotent internal submit_ack (P8-R27, BA/BB).
 *
 * `submit_ack` is internal/plugin-only and idempotent. It clears ONLY a
 * `completed_unambiguous` handoff matching `pendingRef` + the trusted stored
 * `attemptId` obtained through `submit_status`, and never invokes Form Agent.
 */

import { describe, expect, it } from 'vitest';

import { recheckThreePartTarget } from '../src/openclaw/contracts.ts';
import { exitResult, submitParams, submitSuccessDoc } from './support/phase8.ts';
import { PRINCIPAL, getPreflightPending, preflightEnvelope } from './support/phase8-preflight.ts';

async function submitAndHandoff() {
  const fixture = await preflightEnvelope();
  const pending = getPreflightPending(fixture.store, PRINCIPAL);
  if (pending === null) throw new Error('expected a pending record');
  fixture.runner.enqueue(exitResult(0, submitSuccessDoc(pending.planId)));
  await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
  const status = await fixture.adapter.execute(PRINCIPAL, {
    operation: 'submit_status',
    pendingRef: pending.pendingId,
    planId: pending.planId,
  });
  return { fixture, pending, status };
}

describe('normal ack', () => {
  it('reads the trusted stored attemptId from submit_status and clears the handoff', async () => {
    const { fixture, pending, status } = await submitAndHandoff();
    const attemptId = status.data['attemptId'];
    expect(attemptId).toMatch(/^[0-9a-f]{32}$/);

    const calls = fixture.runner.calls.length;
    const ack = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_ack',
      pendingRef: pending.pendingId,
      attempt: attemptId as string,
    });
    expect(ack.data).toMatchObject({ acked: true, idempotent: false });
    expect(fixture.store.peekRaw(PRINCIPAL)).toBeNull();
    expect(fixture.runner.calls.length).toBe(calls);

    // Idempotent: a repeated ack finds nothing and never fails hard.
    const again = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_ack',
      pendingRef: pending.pendingId,
      attempt: attemptId as string,
    });
    expect(again.data).toMatchObject({ acked: false, idempotent: true });
    fixture.cleanup();
  });
});

describe('ack cannot clear the wrong state', () => {
  it('does not clear on an attemptId mismatch', async () => {
    const { fixture, pending } = await submitAndHandoff();
    const ack = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_ack',
      pendingRef: pending.pendingId,
      attempt: 'f'.repeat(32),
    });
    expect(ack.data).toMatchObject({ acked: false, idempotent: false });
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('completed_unambiguous');
    fixture.cleanup();
  });

  it('does not clear on a pendingRef mismatch', async () => {
    const { fixture } = await submitAndHandoff();
    const ack = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_ack',
      pendingRef: 'e'.repeat(32),
      attempt: 'f'.repeat(32),
    });
    expect(ack.data).toMatchObject({ acked: false });
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('completed_unambiguous');
    fixture.cleanup();
  });

  it('never clears a plain pending or a consumed_unknown barrier', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    const onPending = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_ack',
      pendingRef: pending.pendingId,
      attempt: 'f'.repeat(32),
    });
    expect(onPending.data).toMatchObject({ acked: false, idempotent: false });
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('pending');

    const claimed = fixture.store.claim(
      PRINCIPAL,
      {
        pendingRef: pending.pendingId,
        planId: pending.planId,
        targetKey: pending.targetKey,
        targetDisplay: pending.targetDisplay,
        expiresAtMs: pending.expiresAtMs,
      },
      recheckThreePartTarget,
    );
    fixture.store.markConsumedUnknown(PRINCIPAL, claimed.pendingId, claimed.attemptId as string, 'test');
    const onConsumed = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_ack',
      pendingRef: pending.pendingId,
      attempt: 'f'.repeat(32),
    });
    expect(onConsumed.data).toMatchObject({ acked: false });
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('consumed_unknown');
    fixture.cleanup();
  });

  it('rejects malformed refs/attempts as usage errors without touching state', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    const bad = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_ack',
      pendingRef: pending.pendingId,
      attempt: 'not-hex',
    });
    expect(bad.category).toBe('usage_error');
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('pending');
    fixture.cleanup();
  });
});
