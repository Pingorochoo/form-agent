/** Phase 8 plugin principal derivation + dedicated deployment validation (P8-R28). */

import { describe, expect, it } from 'vitest';

import {
  approverListFencesOwnerFallback,
  crossCheckHookRequester,
  deriveToolPrincipal,
  parsePluginConfig,
  validateTelegramDeployment,
  type PluginDeploymentConfig,
} from '../integrations/openclaw-plugin/principal.ts';
import { TELEGRAM_EXPECTATION, telegramDeployment } from './support/phase8.ts';

const CONFIG: PluginDeploymentConfig = {
  accountId: 'formagent',
  operatorSenderId: '5550001',
  adapterBinaryPath: '/opt/form-agent/bin/form-agent-openclaw.js',
  adapterConfigPath: '/etc/form-agent/openclaw-adapter.json',
  allowedDraftProviders: ['reference'],
  providerEnvNames: [],
};

describe('plugin config parsing', () => {
  it('accepts a valid config and rejects invalid account/sender/paths', () => {
    expect(parsePluginConfig(CONFIG).ok).toBe(true);
    expect(parsePluginConfig({ ...CONFIG, accountId: 'bad id' }).ok).toBe(false);
    expect(parsePluginConfig({ ...CONFIG, operatorSenderId: '+1555' }).ok).toBe(false);
    expect(parsePluginConfig({ ...CONFIG, adapterBinaryPath: 'relative' }).ok).toBe(false);
    expect(parsePluginConfig({ ...CONFIG, adapterConfigPath: 'relative' }).ok).toBe(false);
  });
});

describe('tool-factory principal derivation', () => {
  it('derives channel/account/sender from trusted sources only', () => {
    const result = deriveToolPrincipal(CONFIG, { requesterSenderId: '5550001', nativeChannelId: 'telegram:dm:5550001' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal).toEqual({
        channel: 'telegram',
        accountId: 'formagent',
        senderId: '5550001',
        conversationId: 'telegram:dm:5550001',
      });
    }
  });

  it('fails closed when requesterSenderId is missing or not the frozen operator', () => {
    expect(deriveToolPrincipal(CONFIG, {}).ok).toBe(false);
    expect(deriveToolPrincipal(CONFIG, { requesterSenderId: '42' }).ok).toBe(false);
  });

  it('never accepts a model-provided identity field', () => {
    const result = deriveToolPrincipal(CONFIG, {
      requesterSenderId: '5550001',
      // @ts-expect-error model identity is not part of the trusted context
      channel: 'slack',
      accountId: 'attacker',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.channel).toBe('telegram');
  });
});

describe('hook ↔ tool-factory cross-check', () => {
  it('requires channel/accountId/senderId to all match', () => {
    const principal = { channel: 'telegram' as const, accountId: 'formagent', senderId: '5550001' };
    expect(crossCheckHookRequester(CONFIG, principal, { channel: 'telegram', accountId: 'formagent', senderId: '5550001' }).ok).toBe(true);
    expect(crossCheckHookRequester(CONFIG, principal, { channel: 'telegram', accountId: 'other', senderId: '5550001' }).ok).toBe(false);
    expect(crossCheckHookRequester(CONFIG, principal, { channel: 'slack', accountId: 'formagent', senderId: '5550001' }).ok).toBe(false);
    expect(crossCheckHookRequester(CONFIG, principal, { channel: 'telegram', accountId: 'formagent', senderId: '42' }).ok).toBe(false);
    expect(crossCheckHookRequester(CONFIG, principal, { channel: 'telegram', accountId: 'formagent' }).ok).toBe(false);
    expect(crossCheckHookRequester(CONFIG, principal, undefined).ok).toBe(false);
  });
});

describe('dedicated Telegram deployment validation', () => {
  it('accepts the frozen reference topology', () => {
    expect(validateTelegramDeployment(telegramDeployment(), TELEGRAM_EXPECTATION)).toEqual([]);
  });

  it('requires the dedicated account to fence the global-owner fallback', () => {
    expect(approverListFencesOwnerFallback(telegramDeployment(), TELEGRAM_EXPECTATION)).toBe(true);
    const noApprovers = telegramDeployment();
    const account = (noApprovers['channels'] as any).telegram.accounts.formagent;
    delete account.execApprovals;
    expect(approverListFencesOwnerFallback(noApprovers, TELEGRAM_EXPECTATION)).toBe(false);
  });

  it('rejects a missing dedicated account, default-account drift, or owner replacement', () => {
    const missingDefault = telegramDeployment();
    (missingDefault['channels'] as any).telegram.defaultAccount = 'formagent';
    expect(validateTelegramDeployment(missingDefault, TELEGRAM_EXPECTATION).length).toBeGreaterThan(0);

    const replacedOwners = telegramDeployment();
    (replacedOwners['commands'] as any).ownerAllowFrom = ['telegram:5550001'];
    expect(validateTelegramDeployment(replacedOwners, TELEGRAM_EXPECTATION).length).toBeGreaterThan(0);
  });
});
