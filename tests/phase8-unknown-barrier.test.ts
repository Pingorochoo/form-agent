/**
 * Phase 8 sticky unknown barrier (P8-R12/P8-R14, Y).
 *
 * `consumed_unknown` and an unacknowledged `completed_unambiguous` block new
 * preflight and `cancel_pending` until the operator-only local
 * `reconcile_unknown` (unknown) or the internal `submit_ack` (completed) clears
 * them. There is no automatic/timeout clear.
 */

import { describe, expect, it } from 'vitest';

import { PendingError } from '../src/openclaw/pending.ts';
import { reconcileUnknown } from '../src/openclaw/reconcile.ts';
import type { RunResult } from '../src/openclaw/runner.ts';
import { exitResult, preflightDoc, submitParams, submitSuccessDoc } from './support/phase8.ts';
import { PRINCIPAL, getPreflightPending, preflightEnvelope } from './support/phase8-preflight.ts';

function timeoutResult(): RunResult {
  return {
    kind: 'timeout',
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    pid: 4242,
    processGroup: 4242,
    signal: 'SIGTERM',
  };
}

async function makeAmbiguous(): Promise<Awaited<ReturnType<typeof preflightEnvelope>>> {
  const fixture = await preflightEnvelope();
  const pending = getPreflightPending(fixture.store, PRINCIPAL);
  if (pending === null) throw new Error('expected a pending record');
  fixture.runner.enqueue(timeoutResult());
  const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
  expect(envelope.category).toBe('unknown_outcome');
  return fixture;
}

describe('consumed_unknown barrier', () => {
  it('blocks a new preflight without invoking Form Agent', async () => {
    const fixture = await makeAmbiguous();
    const calls = fixture.runner.calls.length;
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(envelope.category).toBe('unknown_barrier');
    expect(envelope.status).toBe('blocked');
    expect(fixture.runner.calls.length).toBe(calls);
    fixture.cleanup();
  });

  it('blocks cancel_pending and direct store.create', async () => {
    const fixture = await makeAmbiguous();
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'cancel_pending' });
    expect(envelope.category).toBe('unknown_barrier');
    expect(() =>
      fixture.store.create({
        principal: PRINCIPAL,
        targetKey: 'fixture:demo-fixture',
        targetArg: 'demo-fixture',
        targetDisplay: 'demo-fixture',
        planId: 'a'.repeat(64),
        seed: 'b'.repeat(32),
        operator: 'telegram:5550001',
      }),
    ).toThrow(PendingError);
    fixture.cleanup();
  });

  it('is cleared ONLY by the operator-only reconcile_unknown, then preflight proceeds', async () => {
    const fixture = await makeAmbiguous();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    expect(pending).not.toBeNull();
    if (pending === null) return;
    const outcome = reconcileUnknown({
      store: fixture.store,
      principal: PRINCIPAL,
      pendingRef: pending.pendingId,
      resolution: 'observed-not-submitted',
    });
    expect(outcome.resultingStatus).toBe('resolved_not_submitted');
    expect(fixture.store.peekRaw(PRINCIPAL)).toBeNull();

    fixture.runner.enqueue(exitResult(0, preflightDoc()));
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(envelope.category).toBe('needs_confirmation');
    fixture.cleanup();
  });

  it('does not clear on a mere read', async () => {
    const fixture = await makeAmbiguous();
    fixture.store.read(PRINCIPAL);
    expect(getPreflightPending(fixture.store, PRINCIPAL)?.status).toBe('consumed_unknown');
    fixture.cleanup();
  });
});

describe('completed_unambiguous barrier', () => {
  it('blocks a new preflight until the internal submit_ack clears it', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.runner.enqueue(exitResult(0, submitSuccessDoc()));
    const submitted = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    expect(submitted.category).toBe('ok_submit_success');

    const blocked = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(blocked.category).toBe('unknown_barrier');

    const status = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_status',
      pendingRef: pending.pendingId,
      planId: pending.planId,
    });
    expect(status.data['state']).toBe('completed_unambiguous');
    await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_ack',
      pendingRef: pending.pendingId,
      attempt: status.data['attemptId'] as string,
    });

    fixture.runner.enqueue(exitResult(0, preflightDoc()));
    const allowed = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(allowed.category).toBe('needs_confirmation');
    fixture.cleanup();
  });

  it('cannot be cancelled', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.runner.enqueue(exitResult(0, submitSuccessDoc()));
    await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'cancel_pending' });
    expect(envelope.category).toBe('unknown_barrier');
    fixture.cleanup();
  });
});
