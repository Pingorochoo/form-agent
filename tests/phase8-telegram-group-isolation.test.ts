/**
 * Phase 8 Telegram group isolation (P8-R23/P8-R28, AT).
 *
 * The dedicated account must declare explicit `groupPolicy: "disabled"` and an
 * explicit empty `groups: {}` (multi-account Telegram otherwise inherits the
 * root `channels.telegram.groups`). The root/general group config is untouched
 * and `commands.ownerAllowFrom` is GLOBAL (not account-scoped).
 */

import { describe, expect, it } from 'vitest';

import { validateTelegramDeployment } from '../integrations/openclaw-plugin/principal.ts';
import { telegramDeployment, TELEGRAM_EXPECTATION } from './support/phase8.ts';

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(telegramDeployment())) as Record<string, unknown>;
}

function accountOf(deployment: Record<string, unknown>): Record<string, unknown> {
  const telegram = (deployment['channels'] as Record<string, unknown>)['telegram'] as Record<string, unknown>;
  const accounts = telegram['accounts'] as Record<string, unknown>;
  return accounts[TELEGRAM_EXPECTATION.accountId] as Record<string, unknown>;
}

describe('dedicated account group isolation', () => {
  it('requires groupPolicy disabled and an explicit empty groups map', () => {
    const noGroupPolicy = clone();
    delete accountOf(noGroupPolicy)['groupPolicy'];
    expect(validateTelegramDeployment(noGroupPolicy, TELEGRAM_EXPECTATION)).toContain(
      'dedicated account groupPolicy must be disabled',
    );

    const omittedGroups = clone();
    delete accountOf(omittedGroups)['groups'];
    expect(validateTelegramDeployment(omittedGroups, TELEGRAM_EXPECTATION)).toContain(
      'dedicated account groups must be an explicit empty map',
    );

    const inheritedGroups = clone();
    accountOf(inheritedGroups)['groups'] = { '*': { requireMention: true } };
    expect(validateTelegramDeployment(inheritedGroups, TELEGRAM_EXPECTATION)).toContain(
      'dedicated account groups must be an explicit empty map',
    );
  });

  it('leaves the root/general group config intact', () => {
    const deployment = telegramDeployment();
    const telegram = (deployment['channels'] as Record<string, unknown>)['telegram'] as Record<string, unknown>;
    expect(telegram['groups']).toEqual({ '*': { requireMention: true } });
    expect(accountOf(deployment)['groups']).toEqual({});
  });

  it('ownerAllowFrom is global and not scoped to the dedicated account', () => {
    const deployment = telegramDeployment();
    expect(Array.isArray((deployment['commands'] as Record<string, unknown>)['ownerAllowFrom'])).toBe(true);
    expect(accountOf(deployment)).not.toHaveProperty('ownerAllowFrom');
    // Validation succeeds while unrelated global owners are preserved.
    expect(validateTelegramDeployment(deployment, TELEGRAM_EXPECTATION)).toEqual([]);
  });

  it('keeps the dedicated DM allowlist to exactly the frozen operator', () => {
    const widened = clone();
    accountOf(widened)['allowFrom'] = ['5550001', '9990001'];
    expect(validateTelegramDeployment(widened, TELEGRAM_EXPECTATION)).toContain(
      'dedicated account allowFrom must contain exactly the frozen operator',
    );
  });
});
