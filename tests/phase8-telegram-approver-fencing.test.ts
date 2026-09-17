/**
 * Phase 8 explicit single approver vs global owner fallback (P8-R28, AZ).
 *
 * The dedicated account's explicit `execApprovals.approvers` is exactly the
 * frozen operator and must fence the global `commands.ownerAllowFrom` fallback.
 * An unrelated global owner must NOT become a Form Agent approver, while the
 * unrelated owner itself is preserved in the global list.
 */

import { describe, expect, it } from 'vitest';

import {
  approverListFencesOwnerFallback,
  validateTelegramDeployment,
} from '../integrations/openclaw-plugin/principal.ts';
import { telegramDeployment, TELEGRAM_EXPECTATION } from './support/phase8.ts';

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(telegramDeployment())) as Record<string, unknown>;
}

function accountOf(deployment: Record<string, unknown>): Record<string, unknown> {
  const telegram = (deployment['channels'] as Record<string, unknown>)['telegram'] as Record<string, unknown>;
  const accounts = telegram['accounts'] as Record<string, unknown>;
  return accounts[TELEGRAM_EXPECTATION.accountId] as Record<string, unknown>;
}

const UNRELATED_OWNER = 'telegram:9990001';

describe('account-scoped approver fencing', () => {
  it('accepts exactly the frozen operator and fences the owner fallback', () => {
    const deployment = telegramDeployment();
    expect(approverListFencesOwnerFallback(deployment, TELEGRAM_EXPECTATION)).toBe(true);
    expect((accountOf(deployment)['execApprovals'] as Record<string, unknown>)['approvers']).toEqual(['5550001']);
    // The unrelated global owner is preserved but is not an approver.
    expect((deployment['commands'] as Record<string, unknown>)['ownerAllowFrom']).toContain(UNRELATED_OWNER);
  });

  it('fails when the explicit approver list is missing', () => {
    const missing = clone();
    delete accountOf(missing)['execApprovals'];
    expect(approverListFencesOwnerFallback(missing, TELEGRAM_EXPECTATION)).toBe(false);
    expect(validateTelegramDeployment(missing, TELEGRAM_EXPECTATION)).toContain('dedicated account execApprovals missing');
  });

  it('rejects an unrelated global owner being added as a Form Agent approver', () => {
    const widened = clone();
    (accountOf(widened)['execApprovals'] as Record<string, unknown>)['approvers'] = ['5550001', '9990001'];
    expect(approverListFencesOwnerFallback(widened, TELEGRAM_EXPECTATION)).toBe(false);
    expect(validateTelegramDeployment(widened, TELEGRAM_EXPECTATION)).toContain(
      'dedicated account execApprovals.approvers must be exactly the frozen operator (fences owner fallback)',
    );
  });

  it('does not replace or narrow the global owner list', () => {
    const replaced = clone();
    (replaced['commands'] as Record<string, unknown>)['ownerAllowFrom'] = ['telegram:5550001'];
    expect(validateTelegramDeployment(replaced, TELEGRAM_EXPECTATION)).toContain(
      `commands.ownerAllowFrom must preserve unrelated owner ${UNRELATED_OWNER}`,
    );
  });
});
