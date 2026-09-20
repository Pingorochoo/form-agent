import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ApprovalSnapshotGate,
  isApprovalToolCallId,
} from '../integrations/openclaw-plugin/approval-snapshot-gate.ts';
import type { ApprovalSnapshotParams } from '../integrations/openclaw-plugin/approval-hook.ts';

const NOW = 1_700_000_000_000;

function snapshot(expiresAtMs = NOW + 600_000): ApprovalSnapshotParams {
  return {
    pendingRef: 'a'.repeat(32),
    principal: {
      channel: 'telegram',
      accountId: 'formagent',
      senderId: '5550001',
    },
    planId: 'b'.repeat(64),
    targetKey: 'fixture:demo-fixture',
    targetDisplay: 'demo-fixture',
    expiresAtMs,
  };
}

describe('Phase 9 host-owned approval snapshot transport', () => {
  it('keeps the model-facing submit tool zero-parameter', () => {
    const source = readFileSync(
      new URL('../integrations/openclaw-plugin/index.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('parameters: Type.Object({})');
    expect(source).not.toContain('readApprovalParams(');
    expect(source).toContain(
      'const approvalToken = approvalSnapshots.register(',
    );
    expect(source).toContain('approvalToken,');
    expect(source).toContain(
      'approvalSnapshots.consumeApproved(toolCallId, Date.now())',
    );
    expect(source).toContain('onResolution: (resolution: unknown) => {');
  });

  it('validates bounded host tool-call ids', () => {
    expect(isApprovalToolCallId('call-1')).toBe(true);
    expect(isApprovalToolCallId('')).toBe(false);
    expect(isApprovalToolCallId('x'.repeat(257))).toBe(false);
    expect(isApprovalToolCallId('bad\0id')).toBe(false);
  });

  it('cannot execute before approval and consumes allow-once exactly once', () => {
    const gate = new ApprovalSnapshotGate();
    const expected = snapshot();

    const token = gate.register('call-1', expected, NOW);
    expect(token).not.toBeNull();
    expect(gate.consumeApproved('call-1', NOW + 1)).toBeNull();

    gate.resolve('call-1', token!, 'allow-once', NOW + 2);

    expect(gate.consumeApproved('call-1', NOW + 3)).toEqual(expected);
    expect(gate.consumeApproved('call-1', NOW + 4)).toBeNull();
  });

  it.each(['deny', 'timeout', 'cancelled', 'allow-always', 'unexpected'])(
    'fails closed for resolution %s',
    (resolution) => {
      const gate = new ApprovalSnapshotGate();

      const token = gate.register('call-2', snapshot(), NOW);
      expect(token).not.toBeNull();
      gate.resolve('call-2', token!, resolution, NOW + 1);

      expect(gate.consumeApproved('call-2', NOW + 2)).toBeNull();
    },
  );

  it('binds approval to the exact toolCallId', () => {
    const gate = new ApprovalSnapshotGate();

    const token = gate.register('call-3', snapshot(), NOW);
    expect(token).not.toBeNull();
    gate.resolve('call-3', token!, 'allow-once', NOW + 1);

    expect(gate.consumeApproved('other-call', NOW + 2)).toBeNull();
    expect(gate.consumeApproved('call-3', NOW + 3)).not.toBeNull();
  });

  it('fails closed when the snapshot expires', () => {
    const gate = new ApprovalSnapshotGate();

    const token = gate.register('call-4', snapshot(NOW + 10), NOW);
    expect(token).not.toBeNull();
    gate.resolve('call-4', token!, 'allow-once', NOW + 1);

    expect(gate.consumeApproved('call-4', NOW + 10)).toBeNull();
  });

  it('ignores a stale resolution callback after toolCallId reuse', () => {
    const gate = new ApprovalSnapshotGate();

    const firstToken = gate.register('call-reused', snapshot(), NOW);
    expect(firstToken).not.toBeNull();

    gate.resolve('call-reused', firstToken!, 'deny', NOW + 1);

    const secondToken = gate.register('call-reused', snapshot(), NOW + 2);
    expect(secondToken).not.toBeNull();

    // A stale callback from the old registration cannot approve the new one.
    gate.resolve('call-reused', firstToken!, 'allow-once', NOW + 3);
    expect(gate.consumeApproved('call-reused', NOW + 4)).toBeNull();

    gate.resolve('call-reused', secondToken!, 'allow-once', NOW + 5);
    expect(gate.consumeApproved('call-reused', NOW + 6)).not.toBeNull();
  });

  it('rejects duplicate registration for one host toolCallId', () => {
    const gate = new ApprovalSnapshotGate();

    expect(gate.register('call-5', snapshot(), NOW)).not.toBeNull();
    expect(gate.register('call-5', snapshot(), NOW + 1)).toBeNull();
  });

  it('keeps outstanding approval transport bounded', () => {
    const gate = new ApprovalSnapshotGate();

    for (let i = 0; i < 32; i += 1) {
      expect(gate.register(`call-${i}`, snapshot(), NOW)).not.toBeNull();
    }

    expect(gate.register('call-over-limit', snapshot(), NOW)).toBeNull();
  });
});
