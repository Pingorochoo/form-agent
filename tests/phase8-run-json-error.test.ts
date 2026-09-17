/**
 * Phase 8 additive `run --json-error` (P8-R8, §8.2B / AU).
 *
 * The flag adds ONE safe machine error document on stdout for a controlled
 * failure after argument parsing (mode + stable code + kind). Without the flag,
 * output and exit codes are byte-identical to the accepted contract.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExitCodes } from '../src/cli/exit-codes.ts';
import { handleCmdRun, runErrorKindForExit } from '../src/cli/run.ts';
import { makeMetricsCtx } from './support/phase7.ts';
import { captureStdout, readStdout } from './support/phase8.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runErrorKindForExit', () => {
  it('maps the frozen controlled-failure kinds', () => {
    expect(runErrorKindForExit(ExitCodes.USAGE)).toBe('usage');
    expect(runErrorKindForExit(ExitCodes.VALIDATION)).toBe('block');
    expect(runErrorKindForExit(ExitCodes.ERROR)).toBe('error');
    expect(runErrorKindForExit(ExitCodes.LLM_OFFLINE)).toBe('error');
    expect(runErrorKindForExit(ExitCodes.LLM_CONNECTIVITY)).toBe('error');
    expect(runErrorKindForExit(127)).toBe('error');
  });
});

describe('run --json-error document', () => {
  it('emits exactly one safe document for a usage failure (preflight mode)', async () => {
    const { ctx } = makeMetricsCtx();
    const stdout = captureStdout();
    const code = await handleCmdRun(['--json-error'], ctx);
    const output = readStdout(stdout);
    stdout.mockRestore();

    expect(code).toBe(ExitCodes.USAGE);
    expect(output.trim().split('\n')).toHaveLength(1);
    const doc = JSON.parse(output) as Record<string, unknown>;
    expect(doc).toEqual({
      command: 'run',
      mode: 'preflight',
      ok: false,
      error: { code: 'USAGE_INVALID_ARGUMENTS', kind: 'usage' },
    });
  });

  it('reports mode=submit for a submit-mode controlled failure', async () => {
    const { ctx } = makeMetricsCtx();
    const stdout = captureStdout();
    const code = await handleCmdRun(['demo-fixture', '--seed', 's', '--submit', '--json-error'], ctx);
    const output = readStdout(stdout);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.USAGE);
    expect(JSON.parse(output)).toMatchObject({ command: 'run', mode: 'submit', ok: false });
  });

  it('rejects unknown flags without echoing the raw value', async () => {
    const { ctx } = makeMetricsCtx();
    const stdout = captureStdout();
    await handleCmdRun(['--json-error', '--executable', '/bin/sh'], ctx);
    const output = readStdout(stdout);
    stdout.mockRestore();
    expect(output).not.toContain('/bin/sh');
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { kind: 'usage' } });
  });

  it('absent flag produces no machine document', async () => {
    const { ctx, logs } = makeMetricsCtx();
    const stdout = captureStdout();
    const code = await handleCmdRun([], ctx);
    const output = readStdout(stdout);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.USAGE);
    expect(output).toBe('');
    expect(logs.length).toBeGreaterThan(0);
  });
});
