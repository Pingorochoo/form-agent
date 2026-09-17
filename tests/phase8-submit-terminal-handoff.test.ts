/**
 * Phase 8 crash-safe completed_unambiguous terminal handoff (P8-R12/P8-R27, BA/BB).
 *
 * An unambiguous terminal result persists a bounded durable handoff (never an
 * immediate delete). A delivery failure while the handoff remains valid NEVER
 * converts it to consumed_unknown; the same result is replayed without
 * re-running Form Agent. A corrupt handoff normalizes to the conservative
 * durable barrier.
 */

import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { pendingFilePath } from '../src/openclaw/pending.ts';
import { exitResult, runErrorDoc, submitParams, submitSuccessDoc } from './support/phase8.ts';
import { PRINCIPAL, getPreflightPending, preflightEnvelope } from './support/phase8-preflight.ts';

async function submitSuccess() {
  const fixture = await preflightEnvelope();
  const pending = getPreflightPending(fixture.store, PRINCIPAL);
  if (pending === null) throw new Error('expected a pending record');
  fixture.runner.enqueue(exitResult(0, submitSuccessDoc(pending.planId)));
  const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
  expect(envelope.category).toBe('ok_submit_success');
  return { fixture, pending, envelope };
}

describe('durable terminal handoff', () => {
  it('persists the finished result and replays it without re-running Form Agent', async () => {
    const { fixture, pending, envelope } = await submitSuccess();
    const calls = fixture.runner.calls.length;

    const first = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_status',
      pendingRef: pending.pendingId,
      planId: pending.planId,
    });
    expect(first.data['state']).toBe('completed_unambiguous');
    const result = first.data['result'] as Record<string, unknown>;
    expect(result).toMatchObject({
      category: envelope.category,
      status: envelope.status,
      formAgentExitCode: envelope.formAgentExitCode,
    });

    // Simulated delivery failure: no ack; a repeated recovery read returns the
    // SAME stored result and never degrades to consumed_unknown.
    const second = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_status',
      pendingRef: pending.pendingId,
      planId: pending.planId,
    });
    expect(second.data['state']).toBe('completed_unambiguous');
    expect(second.data['result']).toEqual(result);
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('completed_unambiguous');
    expect(fixture.runner.calls.length).toBe(calls);
    fixture.cleanup();
  });

  it('a new preflight cannot replace an unacknowledged handoff', async () => {
    const { fixture } = await submitSuccess();
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(envelope.category).toBe('unknown_barrier');
    fixture.cleanup();
  });

  const terminals: Array<{ name: string; result: () => ReturnType<typeof exitResult> }> = [
    { name: 'blocked_submit', result: () => exitResult(3, runErrorDoc('EXECUTION_NOT_AUTHORIZED', 'block', 'submit')) },
    { name: 'already_claimed', result: () => exitResult(3, runErrorDoc('SUBMISSION_ALREADY_CLAIMED', 'block', 'submit')) },
    { name: 'usage_error', result: () => exitResult(2, runErrorDoc('EXECUTION_TARGET_UNSUPPORTED', 'usage', 'submit')) },
  ];
  for (const terminal of terminals) {
    it(`persists a durable handoff for ${terminal.name}`, async () => {
      const fixture = await preflightEnvelope();
      const pending = getPreflightPending(fixture.store, PRINCIPAL);
      if (pending === null) throw new Error('expected a pending record');
      fixture.runner.enqueue(terminal.result());
      const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
      expect(envelope.category).toBe(terminal.name);
      const stored = fixture.store.peekRaw(PRINCIPAL);
      expect(stored?.status).toBe('completed_unambiguous');
      expect(stored?.result?.category).toBe(terminal.name);
      fixture.cleanup();
    });
  }
});

describe('corrupt / incomplete handoff', () => {
  it('normalizes to the conservative durable consumed_unknown barrier', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');

    // Overwrite the durable record with an incomplete completed_unambiguous
    // handoff (no stored result).
    const path = pendingFilePath(fixture.dir, PRINCIPAL);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        pendingId: pending.pendingId,
        principal: PRINCIPAL,
        targetKey: pending.targetKey,
        targetArg: pending.targetArg,
        targetDisplay: pending.targetDisplay,
        planId: pending.planId,
        seed: pending.seed,
        operator: pending.operator,
        createdAtMs: pending.createdAtMs,
        expiresAtMs: pending.expiresAtMs,
        status: 'completed_unambiguous',
      }),
    );

    const status = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_status',
      pendingRef: pending.pendingId,
      planId: pending.planId,
    });
    expect(status.data['state']).toBe('consumed_unknown');
    // Strict validation rejects the incomplete handoff, so the conservative
    // durable barrier reason is one of the corrupt/missing recovery reasons.
    expect(['completed_handoff_corrupt', 'adapter_state_corrupt', 'adapter_state_missing_or_inconsistent']).toContain(
      status.data['reason'],
    );
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('consumed_unknown');

    const preflight = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(preflight.category).toBe('unknown_barrier');
    fixture.cleanup();
  });
});
