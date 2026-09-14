/**
 * Phase 1 CLI tests (P1-R15, P1-R16, P1-R17).
 *
 * Covers `analyze` output, frozen exit codes, unknown/deferred handling, and
 * read-only fixture access.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExitCodes } from '../src/cli/exit-codes.ts';
import { handleCmdAnalyze } from '../src/cli/index.ts';
import { defaultConfig, type AppConfig } from '../src/config/schema.ts';
import { createLogger, type Logger } from '../src/logging/logger.ts';
import { AnalyzeInputError, resolveAnalyzeInput } from '../src/analyze/resolve-input.ts';
import { formatAnalysisSummary, analyzeForm } from '../src/analyze/analyze.ts';
import { parseGoogleFormsHtml } from '../src/parser/google-forms.ts';
import type { CliContext } from '../src/cli/index.ts';

const FIXTURE_PATH = new URL('../fixtures/archives/observed-responder.html', import.meta.url);
const FIXTURE_HTML = readFileSync(FIXTURE_PATH, 'utf8');

function makeCtx(dbDir: string): { ctx: CliContext; logs: string[] } {
  const config: AppConfig = defaultConfig();
  config.database.directory = dbDir;
  config.database.filename = 'cli-test.db';
  const logs: string[] = [];
  const logger: Logger = createLogger(config, { sink: (line) => logs.push(line) });
  return { ctx: { config, logger }, logs };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveAnalyzeInput', () => {
  it('reads a local file path', async () => {
    const input = await resolveAnalyzeInput(FIXTURE_PATH.pathname);
    expect(input.source).toBe('file');
    expect(input.html).toContain('FB_PUBLIC_LOAD_DATA_');
  });

  it('resolves a fixture URL to the archived fixture', async () => {
    const input = await resolveAnalyzeInput('https://fixtures.local/forms/observed-responder');
    expect(input.source).toBe('archive');
    expect(input.html).toContain('data-params');
  });

  it('resolves a bare fixture id', async () => {
    const input = await resolveAnalyzeInput('observed-responder');
    expect(input.source).toBe('archive');
  });

  it('rejects a live Google Forms URL (no network in Phase 1)', async () => {
    await expect(resolveAnalyzeInput('https://docs.google.com/forms/d/e/x/viewform')).rejects.toThrow(
      AnalyzeInputError,
    );
  });

  it('rejects an empty argument', async () => {
    await expect(resolveAnalyzeInput('')).rejects.toThrow(AnalyzeInputError);
  });

  it('rejects an unknown fixture id', async () => {
    await expect(resolveAnalyzeInput('does-not-exist')).rejects.toThrow(AnalyzeInputError);
  });
});

describe('handleCmdAnalyze', () => {
  it('exits 0 and prints a useful structural summary for the archived fixture', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-cli-'));
    const { ctx } = makeCtx(dbDir);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await handleCmdAnalyze(FIXTURE_PATH.pathname, ctx);
    const output = stdout.mock.calls.map((call) => String(call[0])).join('');

    expect(code).toBe(ExitCodes.SUCCESS);
    expect(output).toContain('Form: Evaluación de experiencia y preferencias del estudiante');
    expect(output).toContain('Sections (5):');
    expect(output).toContain('Questions: 27');
    expect(output).toContain('Required: 4 (optional: 23)');
    expect(output).toContain('text: 8');
    expect(output).toContain('Routing: sequential (no conditional routing)');
    expect(output).toContain('Fingerprint: ');
  });

  it('returns usage (2) for a live URL', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-cli-'));
    const { ctx } = makeCtx(dbDir);
    expect(await handleCmdAnalyze('https://docs.google.com/forms/d/e/x/viewform', ctx)).toBe(ExitCodes.USAGE);
  });

  it('returns usage (2) for an empty argument', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-cli-'));
    const { ctx } = makeCtx(dbDir);
    expect(await handleCmdAnalyze('', ctx)).toBe(ExitCodes.USAGE);
  });

  it('returns validation (3) for HTML without an embedded payload', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-cli-'));
    const badFile = join(dbDir, 'bad.html');
    writeFileSync(badFile, '<!doctype html><html><body>no payload</body></html>');
    const { ctx } = makeCtx(dbDir);
    expect(await handleCmdAnalyze(badFile, ctx)).toBe(ExitCodes.VALIDATION);
  });
});

describe('summary formatter (P1-R16 safety)', () => {
  it('never dumps the raw payload, only the structural summary', () => {
    const schema = parseGoogleFormsHtml(FIXTURE_HTML, {
      url: 'https://fixtures.local/forms/observed-responder',
      capturedAt: '2026-01-01T00:00:00.000Z',
    });
    const summary = formatAnalysisSummary(schema, schema.checksum);
    expect(summary).not.toContain('FB_PUBLIC_LOAD_DATA_');
    expect(summary).not.toContain('"[1768533602');
  });

  it('preserves numeric Google item ids (they are never phone-redacted)', () => {
    const outcome = analyzeForm({ html: FIXTURE_HTML });
    expect(outcome.schema.parts[0]?.id).toBe('1768533602');
    expect(outcome.schema.sections[0]?.id).toBe('1249846430');
  });
});

describe('read-only fixture access (P1-R17)', () => {
  it('parsing performs no writes to the fixture file and issues no network calls', async () => {
    const before = readFileSync(FIXTURE_PATH, 'utf8');
    const input = await resolveAnalyzeInput(FIXTURE_PATH.pathname);
    parseGoogleFormsHtml(input.html);
    const after = readFileSync(FIXTURE_PATH, 'utf8');
    expect(after).toBe(before);
    expect(input.html).toBe(before);
  });
});
