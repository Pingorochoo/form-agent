/**
 * Phase 8 dedicated account routing (P8-R23, AR).
 *
 * The dedicated account id is used consistently by the Telegram account config,
 * binding `match.accountId`, plugin config, and adapter operatorPrincipal. An
 * omitted/mismatched `accountId` does not route to the Form Agent agent; the
 * general/default account keeps its existing agent.
 */

import { describe, expect, it } from 'vitest';

import { validateTelegramDeployment } from '../integrations/openclaw-plugin/principal.ts';
import { OPERATOR, telegramDeployment, TELEGRAM_EXPECTATION } from './support/phase8.ts';

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(telegramDeployment())) as Record<string, unknown>;
}

describe('dedicated account routing', () => {
  it('accepts the frozen reference topology', () => {
    expect(validateTelegramDeployment(telegramDeployment(), TELEGRAM_EXPECTATION)).toEqual([]);
  });

  it('requires an explicit account-scoped binding to the dedicated agent', () => {
    const wrong = clone();
    (wrong['bindings'] as Array<Record<string, unknown>>)[1] = {
      agentId: 'form-agent',
      match: { channel: 'telegram', accountId: 'default', peer: { kind: 'direct', id: '5550001' } },
    };
    expect(validateTelegramDeployment(wrong, TELEGRAM_EXPECTATION)).toContain(
      'missing explicit direct-peer binding to the dedicated account',
    );

    const omitted = clone();
    (omitted['bindings'] as Array<Record<string, unknown>>)[1] = {
      agentId: 'form-agent',
      match: { channel: 'telegram', peer: { kind: 'direct', id: '5550001' } },
    };
    expect(validateTelegramDeployment(omitted, TELEGRAM_EXPECTATION).length).toBeGreaterThan(0);
  });

  it('uses one accountId for the Telegram account, binding, plugin and adapter', () => {
    const deployment = telegramDeployment();
    expect(TELEGRAM_EXPECTATION.accountId).toBe(OPERATOR.accountId);
    const accounts = ((deployment['channels'] as Record<string, unknown>)['telegram'] as Record<string, unknown>)[
      'accounts'
    ] as Record<string, unknown>;
    expect(accounts[TELEGRAM_EXPECTATION.accountId]).toBeDefined();
    const binding = (deployment['bindings'] as Array<Record<string, unknown>>).find(
      (item) => item['agentId'] === 'form-agent',
    );
    expect((binding?.['match'] as Record<string, unknown>)['accountId']).toBe(OPERATOR.accountId);
  });

  it('routes the general/default account to its existing agent', () => {
    const deployment = telegramDeployment();
    const general = (deployment['bindings'] as Array<Record<string, unknown>>).find(
      (item) => (item['match'] as Record<string, unknown>)['accountId'] === TELEGRAM_EXPECTATION.generalAccountId,
    );
    expect(general?.['agentId']).toBe('main');
  });
});

describe('exact direct-peer binding enforcement (Finding L)', () => {
  function withFormAgentBinding(
    binding: Record<string, unknown>,
    extraBindings: Array<Record<string, unknown>> = [],
  ): Record<string, unknown> {
    const deployment = clone();
    const bindings = deployment['bindings'] as Array<Record<string, unknown>>;
    const index = bindings.findIndex((item) => item['agentId'] === 'form-agent');
    bindings[index] = binding;
    bindings.push(...extraBindings);
    return deployment;
  }

  function formAgentBinding(match: Record<string, unknown>): Record<string, unknown> {
    return { agentId: 'form-agent', match };
  }

  it('L1: the exact reference topology (direct peer + frozen operator) passes', () => {
    expect(validateTelegramDeployment(telegramDeployment(), TELEGRAM_EXPECTATION)).toEqual([]);
  });

  it('L2: a binding without a peer is rejected', () => {
    const deployment = withFormAgentBinding(
      formAgentBinding({ channel: 'telegram', accountId: TELEGRAM_EXPECTATION.accountId }),
    );
    expect(validateTelegramDeployment(deployment, TELEGRAM_EXPECTATION)).toContain(
      'missing explicit direct-peer binding to the dedicated account',
    );
  });

  it('L3: a group peer is rejected', () => {
    const deployment = withFormAgentBinding(
      formAgentBinding({
        channel: 'telegram',
        accountId: TELEGRAM_EXPECTATION.accountId,
        peer: { kind: 'group', id: TELEGRAM_EXPECTATION.operatorSenderId },
      }),
    );
    expect(validateTelegramDeployment(deployment, TELEGRAM_EXPECTATION)).toContain(
      'missing explicit direct-peer binding to the dedicated account',
    );
  });

  it('L4: a direct peer with the wrong id is rejected', () => {
    const deployment = withFormAgentBinding(
      formAgentBinding({
        channel: 'telegram',
        accountId: TELEGRAM_EXPECTATION.accountId,
        peer: { kind: 'direct', id: '9999999' },
      }),
    );
    expect(validateTelegramDeployment(deployment, TELEGRAM_EXPECTATION)).toContain(
      'missing explicit direct-peer binding to the dedicated account',
    );
  });

  it('L5: a correct peer but a wrong accountId is rejected', () => {
    const deployment = withFormAgentBinding(
      formAgentBinding({
        channel: 'telegram',
        accountId: 'default',
        peer: { kind: 'direct', id: TELEGRAM_EXPECTATION.operatorSenderId },
      }),
    );
    expect(validateTelegramDeployment(deployment, TELEGRAM_EXPECTATION)).toContain(
      'missing explicit direct-peer binding to the dedicated account',
    );
  });

  it('L6: a broad account-level binding cannot be rescued by an unrelated exact binding', () => {
    const deployment = withFormAgentBinding(
      formAgentBinding({ channel: 'telegram', accountId: TELEGRAM_EXPECTATION.accountId }),
      [
        {
          agentId: 'someone-else',
          match: {
            channel: 'telegram',
            accountId: TELEGRAM_EXPECTATION.accountId,
            peer: { kind: 'direct', id: TELEGRAM_EXPECTATION.operatorSenderId },
          },
        },
      ],
    );
    expect(validateTelegramDeployment(deployment, TELEGRAM_EXPECTATION)).toContain(
      'missing explicit direct-peer binding to the dedicated account',
    );
  });
});
