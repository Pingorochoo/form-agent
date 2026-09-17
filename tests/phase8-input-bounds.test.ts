/** Phase 8 §7.4 frozen input bounds (P8-R25). */

import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_ID_PATTERN,
  CONVERSATION_ID_PATTERN,
  HEX_32_PATTERN,
  MAX_TARGET_INPUT_CHARS,
  PENDING_REF_PATTERN,
  PLAN_ID_PATTERN,
  SENDER_ID_PATTERN,
  generatePendingId,
  generateSeed,
  hasControlChars,
  validateAdapterConfig,
  validateDraftProvider,
  validatePendingRef,
  validatePlanId,
  validatePrincipalInput,
  validateTargetCommand,
  validateTimestampBound,
} from '../src/openclaw/contracts.ts';

describe('target bounds', () => {
  it('accepts a canonical fixture target', () => {
    const result = validateTargetCommand('analyze', 'demo-fixture');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.targetKey).toBe('fixture:demo-fixture');
      expect(result.value.targetArg).toBe('demo-fixture');
      expect(result.value.targetDisplay).toBe('demo-fixture');
    }
  });

  it('rejects a target longer than 2048 raw chars', () => {
    expect(validateTargetCommand('analyze', 'x'.repeat(MAX_TARGET_INPUT_CHARS + 1)).ok).toBe(false);
  });

  it('rejects NUL and ASCII control characters before anything else', () => {
    expect(hasControlChars('a\u0000b')).toBe(true);
    expect(hasControlChars('a\u001fb')).toBe(true);
    expect(hasControlChars('a\u007fb')).toBe(true);
    expect(validateTargetCommand('analyze', 'fixture\u0000x').ok).toBe(false);
  });

  it('rejects an empty/whitespace target', () => {
    expect(validateTargetCommand('analyze', '   ').ok).toBe(false);
  });

  it('accepts a 256-char canonical display and rejects 257', () => {
    const ok256 = 'a'.repeat(256);
    const bad257 = 'a'.repeat(257);
    expect(validateTargetCommand('analyze', ok256).ok).toBe(true);
    expect(validateTargetCommand('analyze', bad257).ok).toBe(false);
  });
});

describe('draft provider bounds', () => {
  it('accepts an allowlisted provider and rejects regex/allowlist misses', () => {
    expect(validateDraftProvider('reference', ['reference', 'openai-compatible'])).toBe(true);
    expect(validateDraftProvider('openai-compatible', ['reference', 'openai-compatible'])).toBe(true);
    expect(validateDraftProvider('Reference', ['reference'])).toBe(false);
    expect(validateDraftProvider('-bad', ['-bad'])).toBe(false);
    expect(validateDraftProvider('x'.repeat(33), ['x'.repeat(33)])).toBe(false);
    expect(validateDraftProvider('other', ['reference'])).toBe(false);
  });
});

describe('timestamp bounds', () => {
  it('accepts RFC3339 with timezone within 35 chars', () => {
    expect(validateTimestampBound('2026-01-01T00:00:00.000Z')).toBe(true);
    expect(validateTimestampBound('2026-01-01T00:00:00+02:00')).toBe(true);
  });

  it('rejects malformed / overlong / control-char timestamps', () => {
    expect(validateTimestampBound('not-a-date')).toBe(false);
    expect(validateTimestampBound('2026-01-01')).toBe(false);
    expect(validateTimestampBound(`${'2'.repeat(30)}Z`)).toBe(false);
    expect(validateTimestampBound('2026-01-01T00:00:00Z\u0000')).toBe(false);
  });
});

describe('identity formats', () => {
  it('pins pendingRef/planId/principal formats', () => {
    expect(PENDING_REF_PATTERN.test('a'.repeat(32))).toBe(true);
    expect(PENDING_REF_PATTERN.test('A'.repeat(32))).toBe(false);
    expect(PLAN_ID_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(validatePlanId('a'.repeat(63))).toBe(false);
    expect(validatePendingRef('a'.repeat(31))).toBe(false);
    expect(HEX_32_PATTERN.test('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(ACCOUNT_ID_PATTERN.test('form_agent-1')).toBe(true);
    expect(ACCOUNT_ID_PATTERN.test('bad id')).toBe(false);
    expect(SENDER_ID_PATTERN.test('5550001')).toBe(true);
    expect(SENDER_ID_PATTERN.test('+15550001')).toBe(false);
    expect(CONVERSATION_ID_PATTERN.test('telegram:dm:5550001')).toBe(true);
  });

  it('generates adapter-owned 32-hex seeds and pending ids', () => {
    expect(HEX_32_PATTERN.test(generateSeed())).toBe(true);
    expect(HEX_32_PATTERN.test(generatePendingId())).toBe(true);
    expect(generateSeed()).not.toBe(generateSeed());
  });
});

describe('principal input validation', () => {
  it('accepts telegram + configured account + numeric sender', () => {
    const result = validatePrincipalInput({ channel: 'telegram', accountId: 'formagent', senderId: '5550001' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ channel: 'telegram', accountId: 'formagent', senderId: '5550001' });
  });

  it('rejects a non-telegram channel, bad account, and non-numeric sender', () => {
    expect(validatePrincipalInput({ channel: 'slack', accountId: 'formagent', senderId: '1' }).ok).toBe(false);
    expect(validatePrincipalInput({ channel: 'telegram', accountId: 'bad id', senderId: '1' }).ok).toBe(false);
    expect(validatePrincipalInput({ channel: 'telegram', accountId: 'formagent', senderId: 'abc' }).ok).toBe(false);
    expect(validatePrincipalInput({}).ok).toBe(false);
  });
});

describe('adapter deployment config', () => {
  const base = {
    adapterBinaryPath: '/opt/form-agent/bin/form-agent-openclaw.js',
    formAgentBinaryPath: '/opt/form-agent/bin/form-agent.js',
    formAgentCwd: '/var/lib/form-agent',
    dataDir: '/var/lib/form-agent',
    operatorPrincipal: { channel: 'telegram', accountId: 'formagent', senderId: '5550001' },
    allowedDraftProviders: ['reference', 'openai-compatible'],
    providerEnvNames: ['OPENAI_API_KEY'],
  };

  it('accepts a valid absolute-path data-only config', () => {
    const result = validateAdapterConfig(base);
    expect(result.ok).toBe(true);
  });

  it('rejects a relative executable or data dir', () => {
    expect(validateAdapterConfig({ ...base, formAgentBinaryPath: './form-agent' }).ok).toBe(false);
    expect(validateAdapterConfig({ ...base, dataDir: 'relative' }).ok).toBe(false);
  });

  it('rejects plural/invalid principals and bad env names', () => {
    expect(validateAdapterConfig({ ...base, operatorPrincipal: { channel: 'telegram', accountId: 'a', senderId: 'b' } }).ok).toBe(false);
    expect(validateAdapterConfig({ ...base, providerEnvNames: ['lower_case'] }).ok).toBe(false);
    expect(validateAdapterConfig({ ...base, allowedDraftProviders: [] }).ok).toBe(false);
  });
});
