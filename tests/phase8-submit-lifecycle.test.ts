/**
 * Phase 8 submit lifecycle (P8-R27, §11.2/§11.4).
 *
 * pre-spawn claim -> spawn -> unambiguous terminal handoff -> internal
 * submit_status/submit_ack. Form Agent is the sole submission authority; the
 * adapter only ever replays the server-side pending material.
 */

import { describe, expect, it } from 'vitest';

import {
  FIXTURE_TARGET,
  exitResult,
  preflightDoc,
  runErrorDoc,
  submitParams,
  submitSuccessDoc,
} from './support/phase8.ts';
import { PRINCIPAL, getPreflightPending, preflightEnvelope } from './support/phase8-preflight.ts';

describe('successful submit lifecycle', () => {
  it('claims, submits with server-side material, then hands off and acks', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');

    fixture.runner.enqueue(exitResult(0, submitSuccessDoc(pending.planId)));
    const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));

    expect(envelope.category).toBe('ok_submit_success');
    expect(envelope.status).toBe('ok');
    expect(envelope.formAgentExitCode).toBe(0);
    expect(envelope.data).toMatchObject({ outcome: 'success', submitAttempted: true });

    // The record is NOT deleted immediately: it is a durable handoff.
    const stored = fixture.store.peekRaw(PRINCIPAL);
    expect(stored?.status).toBe('completed_unambiguous');
    expect(stored?.planId).toBe(pending.planId);

    const status = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_status',
      pendingRef: pending.pendingId,
      planId: pending.planId,
    });
    expect(status.data['state']).toBe('completed_unambiguous');

    const ack = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_ack',
      pendingRef: pending.pendingId,
      attempt: status.data['attemptId'] as string,
    });
    expect(ack.data).toMatchObject({ acked: true });
    expect(fixture.store.peekRaw(PRINCIPAL)).toBeNull();

    // A repeated submit after ack finds no local pending; Form Agent is not called.
    const callsBefore = fixture.runner.calls.length;
    const repeat = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    expect(repeat.category).toBe('no_pending');
    expect(fixture.runner.calls.length).toBe(callsBefore);
    fixture.cleanup();
  });

  it('replays only the server-side targetArg/seed/planId in argv (never targetKey)', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.runner.enqueue(exitResult(0, submitSuccessDoc(pending.planId)));
    await fixture.adapter.execute(PRINCIPAL, submitParams(pending));

    const submitCall = fixture.runner.calls[1];
    expect(submitCall).toBeDefined();
    const args = submitCall?.args ?? [];
    expect(args).toContain(FIXTURE_TARGET);
    expect(args).not.toContain('fixture:demo-fixture');
    expect(args).toEqual([
      'run',
      FIXTURE_TARGET,
      '--seed',
      pending.seed,
      '--submit',
      '--expect-plan',
      pending.planId,
      '--by',
      'telegram:5550001',
      '--json',
      '--json-error',
    ]);
    fixture.cleanup();
  });

  it('a repeated submit before ack cannot double-spawn', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.runner.enqueue(exitResult(0, submitSuccessDoc(pending.planId)));
    await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    const calls = fixture.runner.calls.length;
    const second = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    expect(second.category).toBe('unknown_barrier');
    expect(fixture.runner.calls.length).toBe(calls);
    fixture.cleanup();
  });
});

describe('pre-start spawn failure', () => {
  it('maps to submit_start_failed with formAgentExitCode null and start_failed state', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.runner.enqueue({ kind: 'spawn_failed', errorCode: 'ENOENT' });
    const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    expect(envelope.category).toBe('submit_start_failed');
    expect(envelope.status).toBe('error');
    expect(envelope.formAgentExitCode).toBeNull();
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('start_failed');
    fixture.cleanup();
  });

  it('new preflight is allowed after a start_failed (old approval never reused)', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.runner.enqueue({ kind: 'spawn_failed', errorCode: 'ENOENT' });
    await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    fixture.runner.enqueue(exitResult(0, preflightDoc()));
    const next = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(next.category).toBe('needs_confirmation');
    fixture.cleanup();
  });
});

describe('structured pre-submit terminal proofs', () => {
  it('maps a durable already-claimed block to already_claimed', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.runner.enqueue(exitResult(3, runErrorDoc('SUBMISSION_ALREADY_CLAIMED', 'block', 'submit')));
    const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    expect(envelope.category).toBe('already_claimed');
    expect(envelope.status).toBe('already_claimed');
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('completed_unambiguous');
    fixture.cleanup();
  });

  it('maps a structured pre-submit block to blocked_submit', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.runner.enqueue(exitResult(3, runErrorDoc('EXECUTION_NOT_AUTHORIZED', 'block', 'submit')));
    const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    expect(envelope.category).toBe('blocked_submit');
    expect(envelope.status).toBe('blocked');
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('completed_unambiguous');
    fixture.cleanup();
  });

  it('maps a structured usage proof to usage_error', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.runner.enqueue(exitResult(2, runErrorDoc('EXECUTION_TARGET_UNSUPPORTED', 'usage', 'submit')));
    const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    expect(envelope.category).toBe('usage_error');
    expect(envelope.status).toBe('error');
    fixture.cleanup();
  });
});
