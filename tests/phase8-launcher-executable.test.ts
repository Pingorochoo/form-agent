/**
 * Phase 8 real adapter launcher (deployment executable mode).
 *
 * `bin/form-agent-openclaw.js` is the reference deployment executable
 * (`/opt/form-agent/bin/form-agent-openclaw.js`). It must be mode 100755 and
 * directly spawnable (shebang), not merely importable through a wrapper.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAUNCHER = join(REPO_ROOT, 'bin/form-agent-openclaw.js');

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('real launcher executable mode', () => {
  it('is mode 0755 and directly spawnable with a valid adapter config', () => {
    const mode = statSync(LAUNCHER).mode & 0o777;
    expect(mode).toBe(0o755);
    expect(mode & 0o111).not.toBe(0);

    const dir = mkdtempSync(join(tmpdir(), 'p8-launcher-'));
    dirs.push(dir);

    // Recording Form Agent child seam (valid analyze document, no submission).
    const recorder = join(dir, 'form-agent-recorder.mjs');
    writeFileSync(
      recorder,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ command: 'analyze', form: { id: 'form-1', title: 'Fixture Form' }, fingerprint: 'f'.repeat(64), sections: [], questions: { total: 0, required: 0, optional: 0 }, kinds: {}, routing: 'sequential', answerModel: 'flat', terminalSectionIds: [], policy: { scope: 'run', allowed: true, reasons: [] } }));
`,
    );
    chmodSync(recorder, 0o755);

    const adapterConfigPath = join(dir, 'adapter.json');
    writeFileSync(
      adapterConfigPath,
      JSON.stringify({
        adapterBinaryPath: LAUNCHER,
        formAgentBinaryPath: recorder,
        formAgentCwd: dir,
        dataDir: dir,
        operatorPrincipal: { channel: 'telegram', accountId: 'formagent', senderId: '5550001' },
        providerEnvNames: [],
      }),
    );

    // Spawn the REAL launcher directly (no chmodded wrapper / no Node import).
    const result = spawnSync(
      LAUNCHER,
      ['analyze', '--target', 'demo-fixture', '--channel', 'telegram', '--account', 'formagent', '--sender', '5550001'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: REPO_ROOT,
          FORM_AGENT_OPENCLAW_CONFIG: adapterConfigPath,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope['operation']).toBe('analyze');
    expect(envelope['category']).toBe('ok_analyze');
  }, 60_000);
});
