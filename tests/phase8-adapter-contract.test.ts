/** Phase 8 adapter envelope + closed category vocabulary (P8-R9, AV). */

import { describe, expect, it } from 'vitest';

import {
  ADAPTER_CATEGORIES,
  CATEGORY_STATUS,
  PLUGIN_CATEGORIES,
  buildEnvelope,
  statusForCategory,
  type AnyCategory,
} from '../src/openclaw/contracts.ts';
import { runAdapterCli } from '../src/openclaw/main.ts';
import { categoryMessage } from '../src/openclaw/format.ts';
import { FakeRunner, captureStdout, exitResult, parseEnvelope, readStdout, testConfig } from './support/phase8.ts';

const ALL: AnyCategory[] = [...ADAPTER_CATEGORIES, ...PLUGIN_CATEGORIES];

describe('category → status vocabulary', () => {
  it('maps every category to exactly one frozen status', () => {
    for (const category of ALL) {
      const status = statusForCategory(category);
      expect(CATEGORY_STATUS[category]).toBe(status);
      expect(['ok', 'needs_confirmation', 'blocked', 'already_claimed', 'unknown_outcome', 'error']).toContain(status);
    }
  });

  it('has no duplicate categories and no generic ok category', () => {
    expect(new Set(ALL).size).toBe(ALL.length);
    expect(ALL).not.toContain('ok' as AnyCategory);
    expect(ALL).not.toContain('ok_preflight' as AnyCategory);
  });

  it('keeps unauthorized blocked in both layers and freezes blocked_preflight/llm_*', () => {
    expect(statusForCategory('unauthorized')).toBe('blocked');
    expect(statusForCategory('blocked_preflight')).toBe('blocked');
    expect(statusForCategory('llm_offline')).toBe('blocked');
    expect(statusForCategory('llm_connectivity')).toBe('blocked');
  });

  it('maps successful preflight to needs_confirmation', () => {
    expect(statusForCategory('needs_confirmation')).toBe('needs_confirmation');
  });
});

describe('envelope shape', () => {
  it('always carries one version/operation/status/category/message/data/pending', () => {
    const envelope = buildEnvelope({ operation: 'analyze', category: 'ok_analyze', message: categoryMessage('ok_analyze') });
    expect(envelope).toMatchObject({
      version: '1.0.0',
      operation: 'analyze',
      status: 'ok',
      category: 'ok_analyze',
      formAgentExitCode: null,
      pending: null,
    });
    expect(typeof envelope.message).toBe('string');
    expect(typeof envelope.data).toBe('object');
  });
});

describe('adapter process contract', () => {
  it('emits exactly one JSON envelope and exits 0 for an unauthorized principal', async () => {
    const stdout = captureStdout();
    const code = await runAdapterCli(
      ['analyze', '--channel', 'telegram', '--account', 'formagent', '--sender', '999', '--target', 'demo-fixture'],
      { config: testConfig('/tmp/form-agent-p8-contract'), runner: new FakeRunner() },
    );
    const output = readStdout(stdout);
    expect(code).toBe(0);
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(1);
    const envelope = parseEnvelope(output);
    expect(envelope['category']).toBe('unauthorized');
    expect(envelope['status']).toBe('blocked');
  });

  it('rejects unknown flags with usage_error and never echoes the raw value', async () => {
    const stdout = captureStdout();
    await runAdapterCli(
      ['analyze', '--channel', 'telegram', '--account', 'formagent', '--sender', '5550001', '--target', 'x', '--executable', '/bin/sh'],
      { config: testConfig('/tmp/form-agent-p8-contract2'), runner: new FakeRunner() },
    );
    const output = readStdout(stdout);
    expect(output).not.toContain('/bin/sh');
    expect(parseEnvelope(output)['category']).toBe('usage_error');
  });

  it('returns exactly one JSON document on a non-submit adapter crash', async () => {
    const stdout = captureStdout();
    const runner = new FakeRunner();
    runner.enqueue(exitResult(1, 'partial', 'boom'));
    await runAdapterCli(
      ['analyze', '--channel', 'telegram', '--account', 'formagent', '--sender', '5550001', '--target', 'demo-fixture'],
      { config: testConfig('/tmp/form-agent-p8-contract3'), runner },
    );
    const output = readStdout(stdout).trim();
    expect(output.split('\n')).toHaveLength(1);
    expect(parseEnvelope(output)['category']).toBe('error');
  });
});
