/**
 * Phase 8 provider credential ENV chain (Finding S).
 *
 * The long-lived plugin must forward ONLY the exact validated credential names
 * to the short-lived adapter subprocess, and the adapter must re-validate its
 * own allowlist before forwarding to Form Agent. Values never leak to
 * envelopes/logs/pending/model output.
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';

import { PendingClient } from '../integrations/openclaw-plugin/pending-client.ts';
import { parsePluginConfig } from '../integrations/openclaw-plugin/principal.ts';
import { projectModelDetails, renderModelText } from '../integrations/openclaw-plugin/model-visible.ts';
import { renderApprovalDescription } from '../src/openclaw/format.ts';
import { buildChildEnv } from '../src/openclaw/runner.ts';
import { exitResult, FakeRunner } from './support/phase8.ts';

const PRINCIPAL = { channel: 'telegram' as const, accountId: 'formagent', senderId: '5550001' };
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ADAPTER_CONFIG_PATH = '/etc/form-agent/openclaw-adapter.json';

/** Runtime-generated sentinel so the VALUE is never a static repo literal. */
function makeSentinel(): string {
  return `SENTINEL_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

let SENTINEL: string;
beforeEach(() => {
  SENTINEL = makeSentinel();
});

const PLUGIN_CONFIG = {
  accountId: 'formagent',
  operatorSenderId: '5550001',
  adapterBinaryPath: '/opt/form-agent/bin/form-agent-openclaw.js',
  adapterConfigPath: ADAPTER_CONFIG_PATH,
};

function pendingStatusEnvelope(): string {
  return JSON.stringify({
    version: '1.0.0',
    operation: 'pending_status',
    status: 'ok',
    category: 'ok_pending_status',
    formAgentExitCode: null,
    message: 'Pending status read.',
    data: { pending: null },
    pending: null,
  });
}

describe('plugin providerEnvNames validation (S1/S2)', () => {
  it('S1: rejects dangerous/invalid credential names', () => {
    for (const bad of [['NODE_OPTIONS'], ['LD_PRELOAD'], ['DYLD_INSERT_LIBRARIES'], ['lower_case'], ['*'], ['A', 'A']]) {
      expect(parsePluginConfig({ ...PLUGIN_CONFIG, providerEnvNames: bad }).ok).toBe(false);
    }
  });

  it('S2: rejects too many names', () => {
    const many = Array.from({ length: 33 }, (_, i) => `PROVIDER_KEY_${i}`);
    expect(parsePluginConfig({ ...PLUGIN_CONFIG, providerEnvNames: many }).ok).toBe(false);
    expect(parsePluginConfig({ ...PLUGIN_CONFIG, providerEnvNames: many.slice(0, 32) }).ok).toBe(true);
  });

  it('accepts an exact valid allowlist', () => {
    const parsed = parsePluginConfig({ ...PLUGIN_CONFIG, providerEnvNames: ['OPENAI_API_KEY'] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.providerEnvNames).toEqual(['OPENAI_API_KEY']);
  });
});

describe('plugin -> adapter child env (S3/S4)', () => {
  it('forwards exactly PATH/HOME/config + allowed credential values; nothing else', async () => {
    const runner = new FakeRunner();
    runner.enqueue(exitResult(0, pendingStatusEnvelope()));
    const client = new PendingClient(
      {
        adapterBinaryPath: '/opt/form-agent/bin/form-agent-openclaw.js',
        adapterConfigPath: ADAPTER_CONFIG_PATH,
        providerEnvNames: ['SAFE_PROVIDER_KEY', 'NODE_OPTIONS', 'LD_PRELOAD'],
        parentEnv: {
          PATH: '/usr/bin',
          HOME: '/home/op',
          SAFE_PROVIDER_KEY: SENTINEL,
          UNLISTED_SECRET: 'MUST_NOT_PASS',
          NODE_OPTIONS: 'MUST_NOT_PASS',
          LD_PRELOAD: '/evil.so',
        },
      },
      runner,
    );
    await client.pendingStatus(PRINCIPAL);
    const env = runner.calls[0]?.env ?? {};
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/op');
    expect(env['FORM_AGENT_OPENCLAW_CONFIG']).toBe(ADAPTER_CONFIG_PATH);
    expect(env['SAFE_PROVIDER_KEY']).toBe(SENTINEL);
    expect(env['UNLISTED_SECRET']).toBeUndefined();
    expect(env['NODE_OPTIONS']).toBeUndefined();
    expect(env['LD_PRELOAD']).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual([
      'FORM_AGENT_OPENCLAW_CONFIG',
      'HOME',
      'PATH',
      'SAFE_PROVIDER_KEY',
    ]);
  });
});

describe('reference provider needs zero credentials (S8)', () => {
  it('an empty allowlist forwards only PATH/HOME', () => {
    expect(buildChildEnv([], { PATH: '/usr/bin', HOME: '/home/op', SAFE: 'x' })).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/op',
    });
  });
});

describe('real two-hop credential chain (S5/S6/S7)', () => {
  function writeExecutable(path: string, content: string): void {
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }

  it('SAFE_PROVIDER_KEY survives plugin -> adapter -> Form Agent; unlisted/dangerous never do', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p8-env-chain-'));
    const recordPath = join(dir, 'recorded-env.json');
    const recorderPath = join(dir, 'form-agent-recorder.mjs');
    const wrapperPath = join(dir, 'adapter-wrapper.mjs');
    const adapterConfigPath = join(dir, 'adapter.json');

    // Form Agent child seam: records its env, then emits a valid analyze doc.
    writeExecutable(
      recorderPath,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(process.env));
process.stdout.write(JSON.stringify({ command: 'analyze', form: { id: 'form-1', title: 'Fixture Form' }, fingerprint: 'f'.repeat(64), sections: [], questions: { total: 0, required: 0, optional: 0 }, kinds: {}, routing: 'sequential', answerModel: 'flat', terminalSectionIds: [], policy: { scope: 'run', allowed: true, reasons: [] } }));
`,
    );

    // Wrapper that runs the REAL adapter launcher (plain Node type-stripping).
    writeExecutable(
      wrapperPath,
      `#!/usr/bin/env node
await import(${JSON.stringify(join(REPO_ROOT, 'bin/form-agent-openclaw.js'))});
`,
    );

    writeFileSync(
      adapterConfigPath,
      JSON.stringify({
        adapterBinaryPath: wrapperPath,
        formAgentBinaryPath: recorderPath,
        formAgentCwd: dir,
        dataDir: dir,
        operatorPrincipal: PRINCIPAL,
        providerEnvNames: ['SAFE_PROVIDER_KEY'],
      }),
    );

    const client = new PendingClient({
      adapterBinaryPath: wrapperPath,
      adapterConfigPath,
      providerEnvNames: ['SAFE_PROVIDER_KEY', 'UNLISTED_SECRET', 'NODE_OPTIONS'],
      parentEnv: {
        PATH: process.env['PATH'] ?? '/usr/bin',
        HOME: REPO_ROOT,
        SAFE_PROVIDER_KEY: SENTINEL,
        UNLISTED_SECRET: 'MUST_NOT_PASS',
        NODE_OPTIONS: 'MUST_NOT_PASS',
      },
    });

    const result = await client.formAgent(PRINCIPAL, { operation: 'analyze', target: 'demo-fixture' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.category).toBe('ok_analyze');
      // S7: the sentinel never appears in the model-facing envelope.
      expect(JSON.stringify(result.envelope)).not.toContain(SENTINEL);
    }

    // S5: the allowed credential reached the Form Agent child across both hops.
    expect(existsSync(recordPath)).toBe(true);
    const recorded = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, string>;
    expect(recorded['SAFE_PROVIDER_KEY']).toBe(SENTINEL);
    // S4/S6: names absent from the adapter allowlist or denied never arrive.
    expect(recorded['UNLISTED_SECRET']).toBeUndefined();
    expect(recorded['NODE_OPTIONS']).toBeUndefined();
    expect(recorded['LD_PRELOAD']).toBeUndefined();

    // S7: no application state file persists the sentinel (the recorder's own
    // capture file is a test artifact and is excluded).
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name.endsWith('.json') && full !== recordPath) {
        expect(readFileSync(full, 'utf8')).not.toContain(SENTINEL);
      }
    }

    // G5: plugin model-visible text/details never carry the sentinel.
    expect(renderModelText('ok_analyze')).not.toContain(SENTINEL);
    expect(JSON.stringify(projectModelDetails('analyze', result.ok ? result.envelope.data : {}))).not.toContain(SENTINEL);

    // G6: the approval description surface never carries the sentinel.
    expect(renderApprovalDescription('demo-fixture', 'b'.repeat(64), Date.now() + 60_000)).not.toContain(SENTINEL);

    // G8: captured adapter stdout/stderr never carry the sentinel.
    const direct = spawnSync(
      wrapperPath,
      ['analyze', '--target', 'demo-fixture', '--channel', 'telegram', '--account', 'formagent', '--sender', '5550001'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: REPO_ROOT,
          FORM_AGENT_OPENCLAW_CONFIG: adapterConfigPath,
          SAFE_PROVIDER_KEY: SENTINEL,
          UNLISTED_SECRET: 'MUST_NOT_PASS',
          NODE_OPTIONS: 'MUST_NOT_PASS',
        },
      },
    );
    expect(direct.stdout).not.toContain(SENTINEL);
    expect(direct.stderr).not.toContain(SENTINEL);

    // G9: the adapter allowlist is authoritative — an empty adapter allowlist
    // drops the credential even though the plugin allowed it. Never broadens.
    writeFileSync(
      adapterConfigPath,
      JSON.stringify({
        adapterBinaryPath: wrapperPath,
        formAgentBinaryPath: recorderPath,
        formAgentCwd: dir,
        dataDir: dir,
        operatorPrincipal: PRINCIPAL,
        providerEnvNames: [],
      }),
    );
    rmSync(recordPath, { force: true });
    const narrowed = await client.formAgent(PRINCIPAL, { operation: 'analyze', target: 'demo-fixture' });
    expect(narrowed.ok).toBe(true);
    const recordedNarrowed = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, string>;
    expect(recordedNarrowed['SAFE_PROVIDER_KEY']).toBeUndefined();
    expect(recordedNarrowed['UNLISTED_SECRET']).toBeUndefined();
    expect(recordedNarrowed['NODE_OPTIONS']).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
