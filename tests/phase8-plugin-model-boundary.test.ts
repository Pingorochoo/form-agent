/**
 * Phase 8 plugin machine/model boundary (Finding D).
 *
 * An operation-specific category contract plus a plugin-owned fixed renderer and
 * bounded data projection. Arbitrary adapter `message`/`data` never reaches the
 * model.
 */

import { describe, expect, it } from 'vitest';

import { validateAdapterEnvelope, PendingClient } from '../integrations/openclaw-plugin/pending-client.ts';
import { projectModelDetails, renderModelText } from '../integrations/openclaw-plugin/model-visible.ts';
import { exitResult, FakeRunner } from './support/phase8.ts';

const PRINCIPAL = { channel: 'telegram' as const, accountId: 'formagent', senderId: '5550001' };
const CLIENT_CONFIG = {
  adapterBinaryPath: '/opt/form-agent/bin/form-agent-openclaw.js',
  adapterConfigPath: '/etc/form-agent/openclaw-adapter.json',
};

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0.0',
    operation: 'analyze',
    status: 'ok',
    category: 'ok_analyze',
    formAgentExitCode: 0,
    message: 'Analysis complete.',
    data: { fingerprint: 'f'.repeat(64), sectionCount: 1, questionCount: 1, requiredCount: 0, optionalCount: 1 },
    pending: null,
    ...overrides,
  };
}

describe('operation -> category contract (D1)', () => {
  it('accepts the operation-appropriate category', () => {
    expect(validateAdapterEnvelope(envelope(), 'analyze')).toBe(true);
  });

  it('accepts non-submit usage_error envelopes without submit-terminal fields through PendingClient', async () => {
    const runner = new FakeRunner();
    const client = new PendingClient(CLIENT_CONFIG, runner);

    runner.enqueue(
      exitResult(
        0,
        JSON.stringify(
          envelope({
            operation: 'analyze',
            status: 'error',
            category: 'usage_error',
            formAgentExitCode: null,
            data: {},
          }),
        ),
      ),
    );
    const analyze = await client.formAgent(PRINCIPAL, {
      operation: 'analyze',
      target: 'demo-fixture',
    });
    expect(analyze.ok).toBe(true);
    if (analyze.ok) expect(analyze.envelope.category).toBe('usage_error');

    runner.enqueue(
      exitResult(
        0,
        JSON.stringify(
          envelope({
            operation: 'draft',
            status: 'error',
            category: 'usage_error',
            formAgentExitCode: null,
            data: {},
          }),
        ),
      ),
    );
    const draft = await client.formAgent(PRINCIPAL, {
      operation: 'draft',
      target: 'demo-fixture',
      draftProvider: 'reference',
    });
    expect(draft.ok).toBe(true);
    if (draft.ok) expect(draft.envelope.category).toBe('usage_error');
  });

  it('rejects a globally-valid but operation-impossible category', () => {
    // ok_submit_success / needs_confirmation are globally known but impossible
    // for `analyze`; ok_analyze is impossible for `submit_pending`.
    expect(validateAdapterEnvelope(envelope({ category: 'ok_submit_success', status: 'ok', formAgentExitCode: 0 }), 'analyze')).toBe(false);
    expect(validateAdapterEnvelope(envelope({ category: 'needs_confirmation', status: 'needs_confirmation', formAgentExitCode: 0 }), 'analyze')).toBe(
      false,
    );
    expect(validateAdapterEnvelope(envelope({ operation: 'submit_pending' }), 'submit_pending')).toBe(false);
  });

  it('accepts submit terminal/error categories only for submit_pending', () => {
    const success = envelope({
      operation: 'submit_pending',
      category: 'ok_submit_success',
      status: 'ok',
      formAgentExitCode: 0,
      data: {
        runId: 9,
        planId: 'b'.repeat(64),
        targetDisplay: 'demo-fixture',
        fingerprint: 'f'.repeat(64),
        receiptState: 'success',
        submitAttempted: true,
        outcome: 'success',
        outcomeCode: 'SUBMISSION_CONFIRMED',
        operator: 'telegram:5550001',
        consistencySoftIssues: 0,
      },
    });
    expect(validateAdapterEnvelope(success, 'submit_pending')).toBe(true);
    expect(validateAdapterEnvelope({ ...success, operation: 'analyze' }, 'analyze')).toBe(false);
  });
});

describe('plugin-owned model-visible rendering (D2/D3/D4/D6)', () => {
  it('D2/D3: content is fixed plugin-owned text, never the adapter message', () => {
    expect(renderModelText('ok_analyze')).toBe('Analysis complete. No fill or submission occurred.');
    expect(renderModelText('ok_submit_success')).toBe('Submission confirmed by Form Agent.');
    expect(renderModelText('unknown_outcome')).toContain('Manual reconciliation is required.');
    // There is no path that interpolates an adapter message.
    expect(renderModelText('made_up')).toBe('Operation failed.');
  });

  it('D4: arbitrary extra data fields are dropped from details', () => {
    const details = projectModelDetails('analyze', {
      fingerprint: 'f'.repeat(64),
      sectionCount: 1,
      formTitle: '<script>untrusted</script>',
      evil: 'x',
      draftAnswers: [{ questionId: 'q', value: 'secret' }],
    });
    expect(details).toEqual({ fingerprint: 'f'.repeat(64), sectionCount: 1 });
    expect(JSON.stringify(details)).not.toContain('untrusted');
    expect(JSON.stringify(details)).not.toContain('secret');
  });

  it('D6: review values and untrusted strings are absent from the projection', () => {
    const details = projectModelDetails('preflight', {
      planId: 'b'.repeat(64),
      targetDisplay: 'https://docs.google.com/forms/d/e/UNTRUSTED/viewform',
      planReview: [{ questionId: 'q', kind: 'text', value: 'ANSWER' }],
      draftAnswers: [{ questionId: 'q', value: 'ANSWER' }],
      consistencyStatus: 'pass',
    });
    expect(details['planId']).toBe('b'.repeat(64));
    expect(details['consistencyStatus']).toBe('pass');
    expect(details).not.toHaveProperty('targetDisplay');
    expect(JSON.stringify(details)).not.toContain('UNTRUSTED');
    expect(JSON.stringify(details)).not.toContain('ANSWER');
  });
});

describe('submit_ack envelope closure (E)', () => {
  function ackEnvelope(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      version: '1.0.0',
      operation: 'submit_ack',
      status: 'ok',
      category: 'ok_pending_status',
      formAgentExitCode: null,
      message: 'Pending status read.',
      data: { acked: true, idempotent: false },
      pending: null,
      ...overrides,
    });
  }

  async function ackWith(json: string) {
    const runner = new FakeRunner();
    runner.enqueue(exitResult(0, json));
    const client = new PendingClient(CLIENT_CONFIG, runner);
    return client.submitAck(PRINCIPAL, { pendingRef: 'a'.repeat(32), attemptId: 'c'.repeat(32) });
  }

  it('E1: exact {acked:true,idempotent:boolean} is accepted', async () => {
    const result = await ackWith(ackEnvelope());
    expect(result.ok).toBe(true);
  });

  it('E3/E4: missing idempotent or an extra key is malformed', async () => {
    expect((await ackWith(ackEnvelope({ data: { acked: true } }))).ok).toBe(false);
    expect((await ackWith(ackEnvelope({ data: { acked: true, idempotent: false, extra: 1 } }))).ok).toBe(false);
  });
});

describe('PendingClient submit timeout boundary', () => {
  it('keeps submit_pending outside the full adapter submit window while status remains 10s', async () => {
    const runner = new FakeRunner();
    const client = new PendingClient(CLIENT_CONFIG, runner);

    runner.enqueue(exitResult(0, '{}'));
    await client.submitPending(PRINCIPAL, {
      pendingId: 'a'.repeat(32),
      planId: 'b'.repeat(64),
      targetKey: 'fixture:demo-fixture',
      targetDisplay: 'demo-fixture',
      expiresAtMs: 1_800_000_000_000,
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.timeoutMs).toBe(315_000);

    runner.enqueue(exitResult(0, '{}'));
    await client.submitStatus(PRINCIPAL, {
      pendingRef: 'a'.repeat(32),
      planId: 'b'.repeat(64),
    });

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.timeoutMs).toBe(10_000);
  });

  it('preserves a caller timeout when it is longer than the safe submit boundary', async () => {
    const runner = new FakeRunner();
    const client = new PendingClient(
      {
        ...CLIENT_CONFIG,
        timeoutMs: 600_000,
      },
      runner,
    );

    runner.enqueue(exitResult(0, '{}'));
    await client.submitPending(PRINCIPAL, {
      pendingId: 'a'.repeat(32),
      planId: 'b'.repeat(64),
      targetKey: 'fixture:demo-fixture',
      targetDisplay: 'demo-fixture',
      expiresAtMs: 1_800_000_000_000,
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.timeoutMs).toBe(600_000);
  });
});
