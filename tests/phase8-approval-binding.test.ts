/** Phase 8 approval snapshot ↔ current pending binding on ALL SIX fields (AE + AL). */

import { describe, expect, it } from 'vitest';

import {
  verifyApprovalSnapshot,
  type ApprovalSnapshotParams,
  type PendingApprovalView,
} from '../integrations/openclaw-plugin/approval-hook.ts';
import type { PluginDeploymentConfig } from '../integrations/openclaw-plugin/principal.ts';

const CONFIG: PluginDeploymentConfig = {
  accountId: 'formagent',
  operatorSenderId: '5550001',
  adapterBinaryPath: '/opt/form-agent/bin/form-agent-openclaw.js',
  adapterConfigPath: '/etc/form-agent/openclaw-adapter.json',
  allowedDraftProviders: ['reference'],
  providerEnvNames: [],
};

const NOW = 1_700_000_000_000;

function snapshot(overrides: Partial<ApprovalSnapshotParams> = {}): ApprovalSnapshotParams {
  return {
    pendingRef: 'a'.repeat(32),
    principal: { channel: 'telegram', accountId: 'formagent', senderId: '5550001' },
    planId: 'b'.repeat(64),
    targetKey: 'fixture:demo-fixture',
    targetDisplay: 'demo-fixture',
    expiresAtMs: NOW + 600_000,
    ...overrides,
  };
}

function current(overrides: Partial<PendingApprovalView> = {}): PendingApprovalView {
  return {
    pendingId: 'a'.repeat(32),
    planId: 'b'.repeat(64),
    targetKey: 'fixture:demo-fixture',
    targetDisplay: 'demo-fixture',
    expiresAtMs: NOW + 600_000,
    status: 'pending',
    ...overrides,
  };
}

function verify(params: ApprovalSnapshotParams, view: PendingApprovalView | null) {
  return verifyApprovalSnapshot(params, view, CONFIG, '5550001', NOW);
}

describe('verifyApprovalSnapshot', () => {
  it('accepts an exact match while still pending and unexpired', () => {
    expect(verify(snapshot(), current())).toEqual({ ok: true });
  });

  const mismatches: Array<{ name: string; params: ApprovalSnapshotParams; view: PendingApprovalView | null }> = [
    { name: 'pendingRef', params: snapshot({ pendingRef: 'c'.repeat(32) }), view: current() },
    { name: 'planId', params: snapshot({ planId: 'd'.repeat(64) }), view: current() },
    { name: 'targetKey', params: snapshot({ targetKey: 'fixture:other' }), view: current() },
    { name: 'targetDisplay', params: snapshot({ targetDisplay: 'other' }), view: current() },
    { name: 'expiresAtMs', params: snapshot({ expiresAtMs: NOW + 1 }), view: current() },
    {
      name: 'principal',
      params: snapshot({ principal: { channel: 'telegram', accountId: 'formagent', senderId: '999' } }),
      view: current(),
    },
    { name: 'status', params: snapshot(), view: current({ status: 'consumed_unknown' }) },
    { name: 'missing current', params: snapshot(), view: null },
  ];
  for (const mismatch of mismatches) {
    it(`fails closed when ${mismatch.name} differs`, () => {
      expect(verify(mismatch.params, mismatch.view).ok).toBe(false);
    });
  }

  it('fails closed once the pending has expired', () => {
    expect(verifyApprovalSnapshot(snapshot(), current(), CONFIG, '5550001', NOW + 600_000).ok).toBe(false);
  });
});
