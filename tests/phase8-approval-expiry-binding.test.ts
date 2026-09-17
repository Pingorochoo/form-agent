/** Phase 8 expiry is immutable and bound into the approval snapshot (AL). */

import { describe, expect, it } from 'vitest';

import { buildSubmitApproval } from '../integrations/openclaw-plugin/approval-hook.ts';
import type { PluginDeploymentConfig, PluginPrincipal } from '../integrations/openclaw-plugin/principal.ts';
import { PENDING_TTL_MS } from '../src/openclaw/contracts.ts';
import { exitResult, makeAdapter, PLAN_ID, FIXTURE_KEY } from './support/phase8.ts';

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

describe('expiry binding', () => {
  it('creates the pending with the exact 10-minute TTL and never extends it', () => {
    const fixture = makeAdapter({ nowMs: 1_000_000 });
    const record = fixture.store.create({
      principal: { channel: 'telegram', accountId: 'formagent', senderId: '5550001' },
      targetKey: FIXTURE_KEY,
      targetArg: 'demo-fixture',
      targetDisplay: 'demo-fixture',
      planId: PLAN_ID,
      seed: 'b'.repeat(32),
      operator: 'telegram:5550001',
    });
    expect(record.expiresAtMs - record.createdAtMs).toBe(PENDING_TTL_MS);
    fixture.clock.nowMs += 1000;
    const after = fixture.store.read({ channel: 'telegram', accountId: 'formagent', senderId: '5550001' });
    expect(after?.expiresAtMs).toBe(record.expiresAtMs);
    fixture.cleanup();
  });

  it('blocks approval once the frozen expiry has passed', () => {
    const expiresAtMs = 1_700_000_000_000;
    const result = buildSubmitApproval({
      view: { pendingId: 'a'.repeat(32), planId: 'b'.repeat(64), targetKey: 'fixture:demo-fixture', targetDisplay: 'demo-fixture', expiresAtMs, status: 'pending' },
      config: CONFIG,
      toolPrincipal: PRINCIPAL,
      hookRequester: HOOK,
      nowMs: expiresAtMs,
    });
    expect(result).toMatchObject({ block: true });
  });

  it('refuses a claim whose expiry does not match the immutable record', async () => {
    const fixture = makeAdapter();
    const record = fixture.store.create({
      principal: { channel: 'telegram', accountId: 'formagent', senderId: '5550001' },
      targetKey: FIXTURE_KEY,
      targetArg: 'demo-fixture',
      targetDisplay: 'demo-fixture',
      planId: PLAN_ID,
      seed: 'b'.repeat(32),
      operator: 'telegram:5550001',
    });
    fixture.runner.enqueue(exitResult(0, '{}'));
    const envelope = await fixture.adapter.execute(
      { channel: 'telegram', accountId: 'formagent', senderId: '5550001' },
      {
        operation: 'submit_pending',
        pendingRef: record.pendingId,
        planId: PLAN_ID,
        targetKey: FIXTURE_KEY,
        targetDisplay: 'demo-fixture',
        expiresAtMs: record.expiresAtMs + 1,
      },
    );
    expect(envelope.category).toBe('pending_replaced');
    expect(fixture.runner.calls).toHaveLength(0);
    fixture.cleanup();
  });
});
