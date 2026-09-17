/**
 * Phase 8 plugin-session hard recovery (Finding B, BB-3).
 *
 * The adapter's per-process flag dies with the adapter subprocess. These tests
 * prove the fail-closed latch lives at the long-lived plugin/session level and
 * fences later adapter calls for the SAME principal.
 */

import { describe, expect, it } from 'vitest';

import {
  HardRecoveryLatch,
  envelopeIndicatesHardRecovery,
  guardAdapterOperation,
  hardRecoveryBlock,
} from '../integrations/openclaw-plugin/recovery-latch.ts';
import { PendingClient } from '../integrations/openclaw-plugin/pending-client.ts';
import { exitResult, FakeRunner } from './support/phase8.ts';

const PRINCIPAL = { channel: 'telegram' as const, accountId: 'formagent', senderId: '5550001' };
const OTHER = { channel: 'telegram' as const, accountId: 'formagent', senderId: '6660002' };

const CLIENT_CONFIG = {
  adapterBinaryPath: '/opt/form-agent/bin/form-agent-openclaw.js',
  adapterConfigPath: '/etc/form-agent/openclaw-adapter.json',
};

function hardRecoveryEnvelope() {
  return {
    version: '1.0.0',
    operation: 'submit_status',
    status: 'error',
    category: 'error',
    formAgentExitCode: null,
    message: 'Operation failed.',
    data: { hardRecoveryError: true, persisted: false },
    pending: null,
  };
}

describe('hard recovery latch (B1-B5)', () => {
  it('adapter call #1 hard recovery fences later NEW subprocess calls in the same session (B1/B2/B3)', async () => {
    const latch = new HardRecoveryLatch();

    // B1: the first adapter subprocess reports the failed durable barrier.
    const runnerA = new FakeRunner();
    runnerA.enqueue(exitResult(0, JSON.stringify(hardRecoveryEnvelope())));
    const clientA = new PendingClient(CLIENT_CONFIG, runnerA);
    const statusA = await clientA.submitStatus(PRINCIPAL, { pendingRef: 'a'.repeat(32), planId: 'b'.repeat(64) });
    expect(statusA.ok).toBe(true);
    if (!statusA.ok) return;
    expect(envelopeIndicatesHardRecovery(statusA.envelope)).toBe(true);
    expect(latch.recordFromSubmitStatus(PRINCIPAL, statusA.envelope)).toBe(true);
    expect(latch.isLatched(PRINCIPAL)).toBe(true);

    // B2/B3: a NEW adapter client (fresh subprocess path) in the SAME session is
    // fenced before any adapter/Form Agent spawn occurs.
    const runnerB = new FakeRunner();
    const clientB = new PendingClient(CLIENT_CONFIG, runnerB);
    const block = guardAdapterOperation(latch, PRINCIPAL, 'preflight');
    expect(block).not.toBeNull();
    expect(block?.category).toBe('unknown_barrier');
    if (block !== null) {
      expect(runnerB.calls).toHaveLength(0);
    } else {
      await clientB.formAgent(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    }
    expect(runnerB.calls).toHaveLength(0);

    // cancel + submit are fenced; observational reads are not.
    expect(guardAdapterOperation(latch, PRINCIPAL, 'cancel_pending')).not.toBeNull();
    expect(guardAdapterOperation(latch, PRINCIPAL, 'submit_pending')).not.toBeNull();
    expect(guardAdapterOperation(latch, PRINCIPAL, 'analyze')).toBeNull();
    expect(guardAdapterOperation(latch, PRINCIPAL, 'metrics')).toBeNull();
    expect(guardAdapterOperation(latch, PRINCIPAL, 'submit_status')).toBeNull();
  });

  it('model/Telegram input cannot clear the latch (B4)', () => {
    const latch = new HardRecoveryLatch();
    expect(latch.recordFromSubmitStatus(PRINCIPAL, hardRecoveryEnvelope())).toBe(true);

    // Arbitrary model/Telegram-shaped input and non-hard-recovery envelopes
    // never clear the latch.
    expect(latch.recordFromSubmitStatus(PRINCIPAL, { category: 'ok_submit_success', data: {} })).toBe(false);
    expect(
      latch.recordFromSubmitStatus(PRINCIPAL, {
        category: 'error',
        data: { hardRecoveryError: true, persisted: true },
      }),
    ).toBe(false);
    expect(latch.recordFromSubmitStatus(PRINCIPAL, 'allow-once')).toBe(false);
    expect(latch.recordFromSubmitStatus(PRINCIPAL, undefined)).toBe(false);
    expect(hardRecoveryBlock(latch, PRINCIPAL)).not.toBeNull();
  });

  it('the latch is principal-scoped (B5)', () => {
    const latch = new HardRecoveryLatch();
    latch.recordFromSubmitStatus(PRINCIPAL, hardRecoveryEnvelope());
    expect(latch.isLatched(PRINCIPAL)).toBe(true);
    expect(latch.isLatched(OTHER)).toBe(false);
    expect(latch.latchedAt(OTHER)).toBeUndefined();
    expect(guardAdapterOperation(latch, OTHER, 'preflight')).toBeNull();
  });
});
