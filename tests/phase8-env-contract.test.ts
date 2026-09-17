/**
 * Phase 8 closed child-env schema (P8-R7/P8-R16, §14.1).
 *
 * Baseline `PATH`/`HOME` plus exact validated `providerEnvNames` only. There is
 * no generic passthrough, accepted Form Agent env overrides are NOT forwarded,
 * dangerous names are always dropped, and env VALUES never enter an envelope.
 */

import { describe, expect, it } from 'vitest';

import { validateAdapterConfig } from '../src/openclaw/contracts.ts';
import { ADAPTER_CONFIG_ENV } from '../src/openclaw/main.ts';
import { buildChildEnv } from '../src/openclaw/runner.ts';

const PARENT = {
  PATH: '/usr/bin',
  HOME: '/home/op',
  OPENAI_API_KEY: 'sk-value',
  LOG_LEVEL: 'debug',
  FORM_AGENT_LLM_PROVIDER: 'openai',
  FORM_AGENT_LLM_BASE_URL: 'http://127.0.0.1:9',
  NODE_OPTIONS: '--inspect',
  NODE_PATH: '/evil',
  LD_PRELOAD: '/evil.so',
  DYLD_INSERT_LIBRARIES: '/evil.dylib',
  HTTP_PROXY: 'http://proxy',
  HTTPS_PROXY: 'http://proxy',
  ALL_PROXY: 'http://proxy',
  NO_PROXY: '*',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  SSL_CERT_FILE: '/evil.pem',
  PWD: '/',
  SHELL: '/bin/sh',
  USER: 'root',
  UNLISTED: 'nope',
} as NodeJS.ProcessEnv;

const DENIED = [
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'PWD', 'SHELL', 'USER',
  'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
];

describe('closed child env', () => {
  it('forwards only PATH/HOME plus exact provider names', () => {
    const env = buildChildEnv(['OPENAI_API_KEY'], PARENT);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'OPENAI_API_KEY', 'PATH']);
    expect(env['OPENAI_API_KEY']).toBe('sk-value');
  });

  it('never forwards accepted Form Agent env overrides by default', () => {
    const env = buildChildEnv([], PARENT);
    expect(env['LOG_LEVEL']).toBeUndefined();
    expect(env['FORM_AGENT_LLM_PROVIDER']).toBeUndefined();
    expect(env['FORM_AGENT_LLM_BASE_URL']).toBeUndefined();
    expect(env['UNLISTED']).toBeUndefined();
  });

  it('always drops denied/dangerous names even when listed', () => {
    const env = buildChildEnv(DENIED, PARENT);
    for (const name of DENIED) expect(env[name]).toBeUndefined();
  });

  it('does not forward an empty value', () => {
    const env = buildChildEnv(['OPENAI_API_KEY'], { ...PARENT, OPENAI_API_KEY: '' });
    expect(env['OPENAI_API_KEY']).toBeUndefined();
  });
});

describe('adapter deployment env schema', () => {
  const base = {
    adapterBinaryPath: '/opt/form-agent/bin/form-agent-openclaw.js',
    formAgentBinaryPath: '/opt/form-agent/bin/form-agent.js',
    formAgentCwd: '/var/lib/form-agent',
    dataDir: '/var/lib/form-agent',
    operatorPrincipal: { channel: 'telegram', accountId: 'formagent', senderId: '5550001' },
  };

  it('caps providerEnvNames at 32 valid names', () => {
    const many = Array.from({ length: 33 }, (_, i) => `PROVIDER_KEY_${i}`);
    expect(validateAdapterConfig({ ...base, providerEnvNames: many }).ok).toBe(false);
    expect(validateAdapterConfig({ ...base, providerEnvNames: many.slice(0, 32) }).ok).toBe(true);
    expect(validateAdapterConfig({ ...base, providerEnvNames: ['lower_case'] }).ok).toBe(false);
    expect(validateAdapterConfig({ ...base, providerEnvNames: ['A'.repeat(65)] }).ok).toBe(false);
  });

  it('has no passthrough list and no FORM_AGENT_CONFIG surface', () => {
    expect(ADAPTER_CONFIG_ENV).toBe('FORM_AGENT_OPENCLAW_CONFIG');
    expect(ADAPTER_CONFIG_ENV).not.toBe('FORM_AGENT_CONFIG');
    const withPassthrough = { ...base, passthroughEnvNames: ['SECRET'] };
    const config = validateAdapterConfig(withPassthrough);
    // Unknown top-level keys are ignored (data-only config), but critically the
    // passthrough list is never used to build the child env.
    expect(config.ok).toBe(true);
    if (config.ok) expect((config.value as unknown as Record<string, unknown>)['passthroughEnvNames']).toBeUndefined();
  });
});
