/** Phase 8 host-mediated submit approval builder (P8-R10). */

import { describe, expect, it } from 'vitest';

import {
  approvalDecisionsAllowed,
  buildSubmitApproval,
  type PendingApprovalView,
} from '../integrations/openclaw-plugin/approval-hook.ts';
import type { PluginDeploymentConfig, PluginPrincipal } from '../integrations/openclaw-plugin/principal.ts';

const CONFIG: PluginDeploymentConfig = {
  accountId: 'formagent',
  operatorSenderId: '5550001',
  adapterBinaryPath: '/opt/form-agent/bin/form-agent-openclaw.js',
  adapterConfigPath: '/etc/form-agent/openclaw-adapter.json',
  allowedDraftProviders: ['reference'],
  providerEnvNames: [],
};

const PRINCIPAL: PluginPrincipal = { channel: 'telegram', accountId: 'formagent', senderId: '5550001' };
const HOOK = { channel: 'telegram', accountId: 'formagent', senderId: '5550001' };
const NOW = 1_700_000_000_000;

function view(overrides: Partial<PendingApprovalView> = {}): PendingApprovalView {
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

describe('buildSubmitApproval', () => {
  it('snapshots all six fields and offers only allow-once/deny', () => {
    const result = buildSubmitApproval({ view: view(), config: CONFIG, toolPrincipal: PRINCIPAL, hookRequester: HOOK, nowMs: NOW });
    expect('params' in result).toBe(true);
    if (!('params' in result)) return;
    expect(result.params).toEqual({
      pendingRef: 'a'.repeat(32),
      principal: { channel: 'telegram', accountId: 'formagent', senderId: '5550001' },
      planId: 'b'.repeat(64),
      targetKey: 'fixture:demo-fixture',
      targetDisplay: 'demo-fixture',
      expiresAtMs: NOW + 600_000,
    });
    expect(result.requireApproval.allowedDecisions).toEqual(['allow-once', 'deny']);
    expect(result.requireApproval.severity).toBe('critical');
    expect(result.requireApproval.timeoutMs).toBe(120_000);
  });

  it('blocks when there is no pending (or a terminal/expired pending)', () => {
    expect(buildSubmitApproval({ view: null, config: CONFIG, toolPrincipal: PRINCIPAL, hookRequester: HOOK, nowMs: NOW })).toMatchObject({ block: true });
    expect(buildSubmitApproval({ view: view({ status: 'consumed_unknown' }), config: CONFIG, toolPrincipal: PRINCIPAL, hookRequester: HOOK, nowMs: NOW })).toMatchObject({ block: true });
    expect(buildSubmitApproval({ view: view({ expiresAtMs: NOW }), config: CONFIG, toolPrincipal: PRINCIPAL, hookRequester: HOOK, nowMs: NOW })).toMatchObject({ block: true });
  });

  it('blocks an unauthorized hook requester or a principal mismatch', () => {
    expect(buildSubmitApproval({ view: view(), config: CONFIG, toolPrincipal: PRINCIPAL, hookRequester: { channel: 'telegram', accountId: 'formagent', senderId: '999' }, nowMs: NOW })).toMatchObject({ block: true });
    expect(buildSubmitApproval({ view: view(), config: CONFIG, toolPrincipal: PRINCIPAL, hookRequester: undefined, nowMs: NOW })).toMatchObject({ block: true });
  });

  it('never offers or accepts allow-always', () => {
    expect(approvalDecisionsAllowed(['allow-once', 'deny'])).toBe(true);
    expect(approvalDecisionsAllowed(['allow-always'])).toBe(false);
    expect(approvalDecisionsAllowed(['allow-once', 'allow-always'])).toBe(false);
    expect(approvalDecisionsAllowed([])).toBe(false);
    const result = buildSubmitApproval({ view: view(), config: CONFIG, toolPrincipal: PRINCIPAL, hookRequester: HOOK, nowMs: NOW, decisions: ['allow-always'] });
    expect(result).toMatchObject({ block: true });
  });

  it('blocks a tampered targetDisplay that no longer reproduces targetKey', () => {
    const result = buildSubmitApproval({
      view: view({ targetDisplay: 'https://evil.example/form' }),
      config: CONFIG,
      toolPrincipal: PRINCIPAL,
      hookRequester: HOOK,
      nowMs: NOW,
    });
    expect(result).toMatchObject({ block: true });
  });
});
