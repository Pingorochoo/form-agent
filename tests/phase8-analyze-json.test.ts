/**
 * Phase 8 additive `analyze --json` (P8-R8, §8.2A).
 *
 * The flag adds ONE machine document on stdout and suppresses the human summary.
 * Without the flag, output and exit codes are unchanged.
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExitCodes } from '../src/cli/exit-codes.ts';
import { analyzeToJson, handleCmdAnalyze } from '../src/cli/index.ts';
import { parseGoogleFormsHtml } from '../src/parser/google-forms.ts';
import { makeMetricsCtx } from './support/phase7.ts';
import { captureStdout, readStdout } from './support/phase8.ts';

const FIXTURE_PATH = new URL('../fixtures/archives/observed-responder.html', import.meta.url);
const FIXTURE_URL = 'https://fixtures.local/forms/observed-responder';
const FINGERPRINT = '7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('analyzeToJson', () => {
  it('builds the frozen additive document shape from a real schema', () => {
    const schema = parseGoogleFormsHtml(readFileSync(FIXTURE_PATH, 'utf8'), {
      url: FIXTURE_URL,
      capturedAt: '2026-01-01T00:00:00.000Z',
    });
    const doc = analyzeToJson(schema, schema.checksum, { allowed: false, reasons: ['not-allowlisted'] });
    expect(doc).toMatchObject({
      command: 'analyze',
      form: { title: 'Evaluación de experiencia y preferencias del estudiante' },
      fingerprint: FINGERPRINT,
      routing: 'sequential',
      policy: { scope: 'run', allowed: false, reasons: ['not-allowlisted'] },
    });
    expect(doc['sections']).toHaveLength(5);
    expect(doc['questions']).toEqual({ total: 27, required: 4, optional: 23 });
    expect(Array.isArray(doc['terminalSectionIds'])).toBe(true);
    expect(typeof doc['kinds']).toBe('object');
  });
});

describe('handleCmdAnalyze --json', () => {
  it('emits exactly one JSON document and no human summary', async () => {
    const { ctx } = makeMetricsCtx();
    const stdout = captureStdout();
    const code = await handleCmdAnalyze(FIXTURE_PATH.pathname, ctx, true);
    const output = readStdout(stdout);
    stdout.mockRestore();

    expect(code).toBe(ExitCodes.SUCCESS);
    const doc = JSON.parse(output) as Record<string, unknown>;
    expect(doc['command']).toBe('analyze');
    expect(doc['fingerprint']).toBe(FINGERPRINT);
    expect(output).not.toContain('Sections (');
    expect(output).not.toContain('Policy:');
    expect(output).not.toContain('FB_PUBLIC_LOAD_DATA_');
  });

  it('absent flag keeps the human summary unchanged', async () => {
    const { ctx } = makeMetricsCtx();
    const stdout = captureStdout();
    const code = await handleCmdAnalyze(FIXTURE_PATH.pathname, ctx);
    const output = readStdout(stdout);
    stdout.mockRestore();

    expect(code).toBe(ExitCodes.SUCCESS);
    expect(output).toContain('Form: Evaluación de experiencia y preferencias del estudiante');
    expect(output).toContain('Sections (5):');
    expect(output).toContain('Policy:');
  });

  it('keeps exit codes unchanged (usage for a live URL)', async () => {
    const { ctx } = makeMetricsCtx();
    const stdout = captureStdout();
    const code = await handleCmdAnalyze('https://docs.google.com/forms/d/e/x/viewform', ctx, true);
    const output = readStdout(stdout);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.USAGE);
    expect(output).toBe('');
  });
});
