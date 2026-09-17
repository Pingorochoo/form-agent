/**
 * Phase 8 deterministic Form Agent discovery context (Finding M).
 *
 * The accepted loader resolves relative DB paths against the process cwd, so a
 * fixed absolute `formAgentCwd` is REQUIRED; there is no incidental
 * `process.cwd()` fallback. `formAgentConfigPath` is an optional absolute
 * explicit override.
 */

import { describe, expect, it } from 'vitest';

import { validateAdapterConfig } from '../src/openclaw/contracts.ts';
import { makeAdapter, preflightDoc, exitResult, testConfig } from './support/phase8.ts';
import { PRINCIPAL } from './support/phase8-preflight.ts';

const BASE = {
  adapterBinaryPath: '/opt/form-agent/bin/form-agent-openclaw.js',
  formAgentBinaryPath: '/opt/form-agent/bin/form-agent.js',
  dataDir: '/var/lib/form-agent',
  operatorPrincipal: { channel: 'telegram', accountId: 'formagent', senderId: '5550001' },
};

describe('deployment config context (M1-M3)', () => {
  it('M1: neither formAgentCwd nor formAgentConfigPath is rejected', () => {
    expect(validateAdapterConfig({ ...BASE }).ok).toBe(false);
  });

  it('M1b: a fixed absolute formAgentCwd is accepted (config path optional)', () => {
    expect(validateAdapterConfig({ ...BASE, formAgentCwd: '/srv/form-agent' }).ok).toBe(true);
  });

  it('M2: a relative formAgentConfigPath is rejected', () => {
    expect(
      validateAdapterConfig({ ...BASE, formAgentCwd: '/srv/form-agent', formAgentConfigPath: 'config/form-agent.json' }).ok,
    ).toBe(false);
  });

  it('M3: a relative formAgentCwd is rejected', () => {
    expect(validateAdapterConfig({ ...BASE, formAgentCwd: 'relative/cwd' }).ok).toBe(false);
  });

  it('accepts an explicit absolute config path alongside the fixed cwd', () => {
    const result = validateAdapterConfig({
      ...BASE,
      formAgentCwd: '/srv/form-agent',
      formAgentConfigPath: '/etc/form-agent/form-agent.json',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.formAgentCwd).toBe('/srv/form-agent');
      expect(result.value.formAgentConfigPath).toBe('/etc/form-agent/form-agent.json');
    }
  });
});

describe('fixed cwd execution (M4/M7)', () => {
  it('M4: the adapter executes Form Agent from the exact configured cwd', async () => {
    const fixture = makeAdapter({ config: { formAgentCwd: '/srv/form-agent' } });
    fixture.runner.enqueue(exitResult(0, preflightDoc()));
    await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(fixture.runner.calls).toHaveLength(1);
    expect(fixture.runner.calls[0]?.cwd).toBe('/srv/form-agent');
    fixture.cleanup();
  });

  it('M7: the test deployment helper uses a fixed absolute cwd, never process.cwd()', () => {
    const config = testConfig('/tmp/p8-m7');
    expect(config.formAgentCwd).toBe('/opt/form-agent');
    expect(config.formAgentCwd.startsWith('/')).toBe(true);
    expect(config.formAgentCwd).not.toBe(process.cwd());
  });

  it('M5/M6: explicit config path is passed on every operation from the same context', async () => {
    const fixture = makeAdapter({
      config: { formAgentCwd: '/srv/form-agent', formAgentConfigPath: '/etc/form-agent/form-agent.json' },
    });
    fixture.runner.enqueue(exitResult(0, preflightDoc()));
    await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    const call = fixture.runner.calls[0];
    expect(call?.cwd).toBe('/srv/form-agent');
    expect(call?.args.slice(0, 2)).toEqual(['--config', '/etc/form-agent/form-agent.json']);
    fixture.cleanup();
  });
});
