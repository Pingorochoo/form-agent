/**
 * Phase 4 `check` CLI tests (P4-R14, R15, R16).
 *
 * Covers human-readable + `--json` output against the sanitized fixture,
 * deterministic output, exit-code mapping (PASS/WARN -> 0, BLOCK -> 3), strict
 * non-echoing flag parsing, secret sentinels, and rejection of a live/external
 * Google Forms URL without fetching it.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleCmdCheck } from '../src/cli/check.ts';
import { ExitCodes } from '../src/cli/exit-codes.ts';
import type { CliContext } from '../src/cli/index.ts';
import { defaultConfig, type AppConfig } from '../src/config/schema.ts';
import { createLogger, type Logger } from '../src/logging/logger.ts';

const FIXTURE_PATH = new URL('../fixtures/archives/observed-responder.html', import.meta.url);
const FIXTURE_URL = 'https://fixtures.local/forms/observed-responder';

function makeCtx(): { ctx: CliContext; logs: string[] } {
  const config: AppConfig = defaultConfig();
  config.database.directory = mkdtempSync(join(tmpdir(), 'form-agent-check-'));
  const logs: string[] = [];
  const logger: Logger = createLogger(config, { sink: (line) => logs.push(line) });
  return { ctx: { config, logger }, logs };
}

function captureStdout() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

function readStdout(stdout: { mock: { calls: Array<Array<unknown>> } }): string {
  return stdout.mock.calls.map((call) => String(call[0])).join('');
}

/** A minimal embedded-payload fixture whose required name field hard-blocks. */
function blockingFixturePath(): string {
  const payload = [
    null,
    [
      '',
      [
        [10, 'Full name', null, 0, [[null, null, 1, null]]],
        [11, 'How satisfied are you?', null, 0, [[null, null, 0, null]]],
      ],
      null,
      null,
      null,
      null,
      null,
      null,
      'Block Test Form',
    ],
  ];
  const html = `<script>\nvar FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(payload)};\n</script>`;
  const file = join(mkdtempSync(join(tmpdir(), 'form-agent-block-')), 'block.html');
  writeFileSync(file, html, 'utf8');
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('P4-R15/R16 — check command (human-readable)', () => {
  it('summarizes identity, status, counts and issues without values', async () => {
    const { ctx } = makeCtx();
    const stdout = captureStdout();

    const code = await handleCmdCheck([FIXTURE_PATH.pathname, '--seed', 'respondent-001'], ctx);
    const output = readStdout(stdout);

    expect(code).toBe(ExitCodes.SUCCESS);
    expect(output).toContain('Consistency check: Evaluación de experiencia y preferencias del estudiante');
    expect(output).toContain('Draft ID:');
    expect(output).toContain('Report ID:');
    expect(output).toContain('Status:');
    expect(output).toContain('Hard issues:');
    expect(output).toContain('Soft issues:');
    expect(output).toContain('No submission occurred.');
    // Never prints a compared answer value for the blocked name field.
    expect(output).not.toContain('Nombre o código del participante =');
  });

  it('is deterministic for the same seed', async () => {
    const { ctx } = makeCtx();
    const first = captureStdout();
    await handleCmdCheck([FIXTURE_PATH.pathname, '--seed', 'respondent-001'], ctx);
    const firstOutput = readStdout(first);
    first.mockRestore();

    const second = captureStdout();
    await handleCmdCheck([FIXTURE_PATH.pathname, '--seed', 'respondent-001'], ctx);
    expect(readStdout(second)).toBe(firstOutput);
  });
});

describe('P4-R16 — check command (--json)', () => {
  it('returns structured, secret-safe JSON without full answer values', async () => {
    const { ctx } = makeCtx();
    const stdout = captureStdout();

    const code = await handleCmdCheck([FIXTURE_PATH.pathname, '--seed', 'respondent-001', '--json'], ctx);
    const output = readStdout(stdout);

    expect(code).toBe(ExitCodes.SUCCESS);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed.command).toBe('check');
    expect(parsed.draftId).toBeDefined();
    expect(parsed.fingerprint).toBe('7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e');
    expect(parsed.summary).toBeDefined();

    const consistency = parsed.consistency as Record<string, unknown>;
    expect(consistency).toBeDefined();
    expect(consistency.reportId).toBeDefined();
    expect(['pass', 'warn', 'block']).toContain(consistency.status);
    expect(Array.isArray(consistency.issues)).toBe(true);

    // Does NOT duplicate full draft answer values or profile trait values.
    expect(parsed.results).toBeUndefined();
    expect(parsed.profile).toBeUndefined();
    expect(output).not.toContain('VERY_SECRET_PROVIDER_VALUE');
    expect(output).not.toContain('token=VERY_SECRET_TOKEN');
  });

  it('uses a fixture URL through the local fixture harness', async () => {
    const { ctx } = makeCtx();
    const stdout = captureStdout();
    const code = await handleCmdCheck([FIXTURE_URL, '--seed', 'respondent-001', '--json'], ctx);
    expect(code).toBe(ExitCodes.SUCCESS);
    expect(readStdout(stdout)).toContain('"command": "check"');
  });
});

describe('P4-R16 — exit-code mapping', () => {
  it('BLOCK uses the existing validation exit code (3)', async () => {
    const { ctx } = makeCtx();
    const stdout = captureStdout();
    const code = await handleCmdCheck([blockingFixturePath(), '--seed', 'x'], ctx);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.VALIDATION);
  });

  it('WARN/PASS use exit code 0', async () => {
    const { ctx } = makeCtx();
    const stdout = captureStdout();
    const code = await handleCmdCheck([FIXTURE_PATH.pathname, '--seed', 'respondent-001'], ctx);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.SUCCESS);
  });
});

describe('P4-R15 — check does not fetch live/external URLs', () => {
  it('rejects a live Google Forms URL without fetching it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { ctx, logs } = makeCtx();
    const stdout = captureStdout();

    const code = await handleCmdCheck(
      ['https://docs.google.com/forms/d/e/1FAIpQLSd98rnMrAiFm3vA4FoyGnS0UbOqz-M6qR9ZRqcwSOOx4nWX7w/viewform', '--seed', 'respondent-001'],
      ctx,
    );

    expect(code).toBe(ExitCodes.USAGE);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readStdout(stdout)).toBe('');
    expect(logs.join('\n')).toContain('live form fetching is not implemented');
  });
});

describe('P4-R14/R16 — controlled errors and strict flags', () => {
  it('requires a non-empty seed', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdCheck([FIXTURE_PATH.pathname], ctx)).toBe(ExitCodes.USAGE);
    expect(await handleCmdCheck([FIXTURE_PATH.pathname, '--seed', '   '], ctx)).toBe(ExitCodes.USAGE);
  });

  it('requires an input', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdCheck(['--seed', 'x'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('rejects an unknown flag', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdCheck([FIXTURE_PATH.pathname, '--seed', 'x', '--bogus'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('does not echo a secret-bearing unknown flag in logs or output', async () => {
    const { ctx, logs } = makeCtx();
    const stdout = captureStdout();
    const code = await handleCmdCheck([FIXTURE_PATH.pathname, '--seed', 'x', '--token=VERY_SECRET_TOKEN'], ctx);
    expect(code).toBe(ExitCodes.USAGE);
    expect(readStdout(stdout)).not.toContain('VERY_SECRET_TOKEN');
    expect(logs.join('\n')).not.toContain('VERY_SECRET_TOKEN');
  });

  it('rejects --seed without a following value', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdCheck([FIXTURE_PATH.pathname, '--seed'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('rejects an empty --seed= value', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdCheck([FIXTURE_PATH.pathname, '--seed='], ctx)).toBe(ExitCodes.USAGE);
  });

  it('rejects extra positional inputs', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdCheck([FIXTURE_PATH.pathname, 'extra', '--seed', 'x'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('accepts --seed=value and --json', async () => {
    const { ctx } = makeCtx();
    const stdout = captureStdout();
    const code = await handleCmdCheck([FIXTURE_PATH.pathname, '--seed=respondent-001', '--json'], ctx);
    expect(code).toBe(ExitCodes.SUCCESS);
    expect(readStdout(stdout)).toContain('"command": "check"');
  });
});
