/**
 * Config loading tests — all three formats, env merging, validation.
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config/schema.ts';
import { loadConfig } from '../src/config/load.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'form-agent-config-'));
}

describe('parseConfig', () => {
  it('applies defaults for an empty config', () => {
    const config = parseConfig({});
    expect(config.llm.defaultProvider).toBe('fake');
    expect(config.database.directory).toBe('.data');
    expect(config.run.concurrency).toBe(1);
    expect(config.forms.allowlist).toEqual([]);
  });

  it('rejects unknown top-level keys', () => {
    expect(() => parseConfig({ nope: true })).toThrow(/Unrecognized key/);
  });
});

describe('loadConfig format support', () => {
  it('loads a JSON config with allowlist', async () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'form-agent.config.json'),
      JSON.stringify({
        forms: { allowlist: ['https://fixtures.local/forms/*'] },
        llm: { defaultProvider: 'fake' },
      }),
    );
    const loaded = await loadConfig({ cwd: dir, env: {} });
    expect(loaded.source).toContain('form-agent.config.json');
    expect(loaded.config.forms.allowlist).toHaveLength(1);
    expect(loaded.config.llm.providers['fake']?.type).toBe('fake');
  });

  it('loads a TS config via default export', async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(
      join(dir, 'config', 'form-agent.ts'),
      'export default { llm: { defaultProvider: "fake" } };\n',
    );
    const loaded = await loadConfig({ cwd: dir, env: {} });
    expect(loaded.config.llm.defaultProvider).toBe('fake');
    expect(loaded.source).toContain('form-agent.ts');
  });

  it('prefers env LOG_LEVEL over config file', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'form-agent.config.json'), JSON.stringify({ log: { level: 'warn' } }));
    const loaded = await loadConfig({ cwd: dir, env: { LOG_LEVEL: 'error' } });
    expect(loaded.config.log.level).toBe('error');
  });

  it('respects --config explicit paths over discovery', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'custom.yaml'), 'run:\n  concurrency: 4\n');
    const loaded = await loadConfig({ cwd: dir, configPath: join(dir, 'custom.yaml'), env: {} });
    expect(loaded.config.run.concurrency).toBe(4);
    expect(loaded.source).toContain('custom.yaml');
  });
});

describe('config validation', () => {
  it('loads a config whose defaultProvider is present but does not crash early', async () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'form-agent.config.json'),
      JSON.stringify({ llm: { defaultProvider: 'fake' } }),
    );
    const loaded = await loadConfig({ cwd: dir, env: {} });
    expect(loaded.config.llm.defaultProvider).toBe('fake');
  });
});