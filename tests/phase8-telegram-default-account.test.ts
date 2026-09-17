/**
 * Phase 8 default-account preservation (P8-R23, AY).
 *
 * Adding the dedicated `<form-agent-account-id>` must not change the existing
 * Telegram default. `channels.telegram.defaultAccount` remains the general
 * account, and an omitted binding `accountId` resolves to that default.
 */

import { describe, expect, it } from 'vitest';

import { validateTelegramDeployment } from '../integrations/openclaw-plugin/principal.ts';
import { telegramDeployment, TELEGRAM_EXPECTATION } from './support/phase8.ts';

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(telegramDeployment())) as Record<string, unknown>;
}

function telegramOf(deployment: Record<string, unknown>): Record<string, unknown> {
  return (deployment['channels'] as Record<string, unknown>)['telegram'] as Record<string, unknown>;
}

describe('preserved Telegram default', () => {
  it('requires defaultAccount to remain the general account', () => {
    const deployment = telegramDeployment();
    expect(telegramOf(deployment)['defaultAccount']).toBe(TELEGRAM_EXPECTATION.generalAccountId);
    expect(validateTelegramDeployment(deployment, TELEGRAM_EXPECTATION)).toEqual([]);
  });

  it('rejects the dedicated account becoming the default', () => {
    const drifted = clone();
    telegramOf(drifted)['defaultAccount'] = TELEGRAM_EXPECTATION.accountId;
    expect(validateTelegramDeployment(drifted, TELEGRAM_EXPECTATION)).toContain(
      'channels.telegram.defaultAccount must be the preserved general account',
    );
  });

  it('an omitted accountId resolves to the preserved general default', () => {
    const deployment = telegramDeployment();
    const general = (deployment['bindings'] as Array<Record<string, unknown>>).find(
      (item) => (item['match'] as Record<string, unknown>)['accountId'] === telegramOf(deployment)['defaultAccount'],
    );
    // The general account keeps its existing (non-Form-Agent) agent.
    expect(general?.['agentId']).not.toBe(TELEGRAM_EXPECTATION.agentId);
  });
});
