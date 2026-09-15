/**
 * Phase 3 CLI tests (P3-R16, P3-R17).
 *
 * Covers the local-only `draft` command: human-readable and `--json` output
 * against the sanitized fixture, deterministic output, controlled errors, and
 * rejection of a live/external Google Forms URL without fetching it.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleCmdDraft } from '../src/cli/draft.ts';
import { ExitCodes } from '../src/cli/exit-codes.ts';
import type { CliContext } from '../src/cli/index.ts';
import { defaultConfig, type AppConfig } from '../src/config/schema.ts';
import { createLogger, type Logger } from '../src/logging/logger.ts';

const FIXTURE_PATH = new URL('../fixtures/archives/observed-responder.html', import.meta.url);
const FIXTURE_URL = 'https://fixtures.local/forms/observed-responder';

function makeCtx(): { ctx: CliContext; logs: string[] } {
  const config: AppConfig = defaultConfig();
  config.database.directory = mkdtempSync(join(tmpdir(), 'form-agent-draft-'));
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('P3-R16 — draft command (human-readable)', () => {
  it('summarizes the draft without printing blocked sensitive values', async () => {
    const { ctx } = makeCtx();
    const stdout = captureStdout();

    const code = await handleCmdDraft([FIXTURE_PATH.pathname, '--seed', 'respondent-001'], ctx);
    const output = readStdout(stdout);

    expect(code).toBe(ExitCodes.SUCCESS);
    expect(output).toContain('Draft: Evaluación de experiencia y preferencias del estudiante');
    expect(output).toContain('Seed: respondent-001');
    expect(output).toContain('Profile:');
    expect(output).toContain('Answered:');
    expect(output).toContain('Blocked/deferred:');
    expect(output).toContain('Unsupported:');
    expect(output).toContain('Required unanswered:');
    expect(output).toContain('Complete:');
    expect(output).toContain('No submission occurred.');
    // The name question is policy-blocked; no value may be emitted for it.
    expect(output).not.toContain('Nombre o código del participante =');
  });

  it('produces deterministic output for the same seed', async () => {
    const { ctx } = makeCtx();
    const first = captureStdout();
    await handleCmdDraft([FIXTURE_PATH.pathname, '--seed', 'respondent-001'], ctx);
    const firstOutput = readStdout(first);
    first.mockRestore();

    const second = captureStdout();
    await handleCmdDraft([FIXTURE_PATH.pathname, '--seed', 'respondent-001'], ctx);
    expect(readStdout(second)).toBe(firstOutput);
  });
});

describe('P3-R16 — draft command (--json)', () => {
  it('returns structured JSON with eligible values but no blocked values', async () => {
    const { ctx } = makeCtx();
    const stdout = captureStdout();

    const code = await handleCmdDraft([FIXTURE_PATH.pathname, '--seed', 'respondent-001', '--json'], ctx);
    const output = readStdout(stdout);

    expect(code).toBe(ExitCodes.SUCCESS);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed.synthetic).toBe(true);
    expect(parsed.seed).toBe('respondent-001');
    expect(parsed.fingerprint).toBe('7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e');
    expect(parsed.summary).toBeDefined();

    const results = parsed.results as Array<Record<string, unknown>>;
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(27);

    // The blocked name question carries no value.
    const blocked = results.find((r) => r.state === 'blocked-sensitive');
    expect(blocked).toBeDefined();
    expect(blocked?.value).toBeUndefined();

    const answered = results.filter((r) => r.state === 'answered');
    expect(answered.length).toBeGreaterThan(0);
    for (const result of answered) {
      expect(result.value).toBeDefined();
    }
  });

  it('uses a fixture URL through the local fixture harness', async () => {
    const { ctx } = makeCtx();
    const stdout = captureStdout();
    const code = await handleCmdDraft([FIXTURE_URL, '--seed', 'respondent-001', '--json'], ctx);
    expect(code).toBe(ExitCodes.SUCCESS);
    expect(readStdout(stdout)).toContain('"synthetic": true');
  });
});

describe('P3-R16 — draft does not fetch live/external URLs', () => {
  it('rejects a live Google Forms URL without fetching it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { ctx, logs } = makeCtx();
    const stdout = captureStdout();

    const code = await handleCmdDraft(
      ['https://docs.google.com/forms/d/e/1FAIpQLSd98rnMrAiFm3vA4FoyGnS0UbOqz-M6qR9ZRqcwSOOx4nWX7w/viewform', '--seed', 'respondent-001'],
      ctx,
    );

    expect(code).toBe(ExitCodes.USAGE);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readStdout(stdout)).toBe('');
    expect(logs.join('\n')).toContain('live form fetching is not implemented');
  });
});

describe('P3-R17 — controlled errors', () => {
  it('requires a non-empty seed', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdDraft([FIXTURE_PATH.pathname], ctx)).toBe(ExitCodes.USAGE);
    expect(await handleCmdDraft([FIXTURE_PATH.pathname, '--seed', '   '], ctx)).toBe(ExitCodes.USAGE);
  });

  it('requires an input', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdDraft(['--seed', 'x'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('rejects an unknown fixture with a controlled usage error', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdDraft(['no-such-fixture-id', '--seed', 'x'], ctx)).toBe(ExitCodes.USAGE);
  });
});

describe('P3-R1 — fixture stays read-only', () => {
  it('does not modify the sanitized fixture bytes', async () => {
    const before = readFileSync(FIXTURE_PATH, 'utf8');
    const { ctx } = makeCtx();
    const stdout = captureStdout();
    await handleCmdDraft([FIXTURE_PATH.pathname, '--seed', 'respondent-001'], ctx);
    stdout.mockRestore();
    expect(readFileSync(FIXTURE_PATH, 'utf8')).toBe(before);
  });
});

describe('P3-R16 — deterministic draft flag parsing', () => {
  it('rejects an unknown flag', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdDraft([FIXTURE_PATH.pathname, '--seed', 'x', '--bogus'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('does not echo a sentinel unknown flag in logs or output', async () => {
    const { ctx, logs } = makeCtx();
    const stdout = captureStdout();
    const code = await handleCmdDraft(
      [FIXTURE_PATH.pathname, '--seed', 'x', '--token=VERY_SECRET_TOKEN'],
      ctx,
    );
    expect(code).toBe(ExitCodes.USAGE);
    expect(readStdout(stdout)).not.toContain('VERY_SECRET_TOKEN');
    expect(logs.join('\n')).not.toContain('VERY_SECRET_TOKEN');
  });

  it('rejects --seed without a following value', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdDraft([FIXTURE_PATH.pathname, '--seed'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('does not reinterpret --json as the seed', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdDraft([FIXTURE_PATH.pathname, '--seed', '--json'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('rejects an empty --seed= value', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdDraft([FIXTURE_PATH.pathname, '--seed='], ctx)).toBe(ExitCodes.USAGE);
  });

  it('rejects extra positional inputs', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdDraft([FIXTURE_PATH.pathname, 'extra', '--seed', 'x'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('accepts --seed=value and --json', async () => {
    const { ctx } = makeCtx();
    const stdout = captureStdout();
    const code = await handleCmdDraft([FIXTURE_PATH.pathname, '--seed=respondent-001', '--json'], ctx);
    expect(code).toBe(ExitCodes.SUCCESS);
    expect(readStdout(stdout)).toContain('"seed": "respondent-001"');
  });
});
