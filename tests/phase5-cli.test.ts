/**
 * Phase 5 `run` CLI tests (P5-R20, P5-R3).
 *
 * Covers strict argument parsing (no echoing), pre-network failures (no browser
 * launch for malformed/unsupported/unauthorized targets), safe preflight human/
 * JSON output, and secret sentinels. The authorized preflight path uses the
 * local execution harness only — never a real Google Form.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleCmdRun } from '../src/cli/run.ts';
import { ExitCodes } from '../src/cli/exit-codes.ts';
import type { CliContext } from '../src/cli/index.ts';
import { defaultConfig, type AppConfig } from '../src/config/schema.ts';
import { createLogger, type Logger } from '../src/logging/logger.ts';
import { FormAgentDatabase } from '../src/db/database.ts';
import { AuthorizationStore } from '../src/policy/authz.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';

const DIRS: string[] = [];

function makeCtx(): { ctx: CliContext; logs: string[]; dir: string } {
  const config: AppConfig = defaultConfig();
  config.safety.mode = 'test-only';
  config.database.directory = mkdtempSync(join(tmpdir(), 'form-agent-run-cli-'));
  config.browser.headless = true;
  DIRS.push(config.database.directory);
  const logs: string[] = [];
  const logger: Logger = createLogger(config, { sink: (line) => logs.push(line) });
  return { ctx: { config, logger }, logs, dir: config.database.directory };
}

function allow(dir: string, fixtureId: string): void {
  const db = FormAgentDatabase.open({ directory: dir, filename: 'form-agent.db' });
  try {
    new AuthorizationStore(db).allow(canonicalizeTarget(fixtureId), 'run', 'op');
  } finally {
    db.close();
  }
}

function captureStdout() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

function readStdout(stdout: { mock: { calls: Array<Array<unknown>> } }): string {
  return stdout.mock.calls.map((call) => String(call[0])).join('');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of DIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('P5-R20 — strict argument parsing', () => {
  it('requires a target', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdRun(['--seed', 'x'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('requires a non-empty seed', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdRun(['exec-success'], ctx)).toBe(ExitCodes.USAGE);
    expect(await handleCmdRun(['exec-success', '--seed', '   '], ctx)).toBe(ExitCodes.USAGE);
  });

  it('rejects an unknown flag without echoing its content', async () => {
    const { ctx, logs } = makeCtx();
    const stdout = captureStdout();
    const code = await handleCmdRun(['exec-success', '--seed', 'x', '--token=VERY_SECRET_TOKEN'], ctx);
    expect(code).toBe(ExitCodes.USAGE);
    expect(readStdout(stdout)).not.toContain('VERY_SECRET_TOKEN');
    expect(logs.join('\n')).not.toContain('VERY_SECRET_TOKEN');
  });

  it('rejects extra positionals', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdRun(['exec-success', 'extra', '--seed', 'x'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('--submit requires --expect-plan and --by', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdRun(['exec-success', '--seed', 'x', '--submit'], ctx)).toBe(ExitCodes.USAGE);
    expect(await handleCmdRun(['exec-success', '--seed', 'x', '--submit', '--expect-plan', 'a'.repeat(64)], ctx)).toBe(ExitCodes.USAGE);
    expect(await handleCmdRun(['exec-success', '--seed', 'x', '--submit', '--by', 'op'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('rejects a malformed plan id', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdRun(['exec-success', '--seed', 'x', '--submit', '--expect-plan', 'not-a-plan', '--by', 'op'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('rejects --expect-plan / --by without --submit', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdRun(['exec-success', '--seed', 'x', '--expect-plan', 'a'.repeat(64)], ctx)).toBe(ExitCodes.USAGE);
    expect(await handleCmdRun(['exec-success', '--seed', 'x', '--by', 'op'], ctx)).toBe(ExitCodes.USAGE);
  });
});

describe('P5-R3 — pre-network failures never open a browser', () => {
  it('rejects an unsupported target before any browser launch', async () => {
    const { ctx } = makeCtx();
    const launch = vi.spyOn(
      (await import('playwright')).chromium,
      'launch',
    );
    const code = await handleCmdRun(['https://example.com/not-a-form', '--seed', 'x'], ctx);
    expect(code).toBe(ExitCodes.USAGE);
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects an unallowlisted fixture target before any browser launch', async () => {
    const { ctx } = makeCtx();
    const launch = vi.spyOn((await import('playwright')).chromium, 'launch');
    const code = await handleCmdRun(['exec-success', '--seed', 'x'], ctx);
    expect(code).toBe(ExitCodes.VALIDATION);
    expect(launch).not.toHaveBeenCalled();
  });

  it('malformed submit args fail before any browser launch', async () => {
    const { ctx } = makeCtx();
    const launch = vi.spyOn((await import('playwright')).chromium, 'launch');
    const code = await handleCmdRun(['exec-success', '--seed', 'x', '--submit'], ctx);
    expect(code).toBe(ExitCodes.USAGE);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('P5-R20 — preflight output', () => {
  it('authorized preflight returns a plan and says NO FILL OR SUBMISSION OCCURRED', async () => {
    const { ctx, dir } = makeCtx();
    allow(dir, 'exec-success');
    const stdout = captureStdout();
    const code = await handleCmdRun(['exec-success', '--seed', 'seed-cli-1'], ctx);
    const output = readStdout(stdout);
    expect(code).toBe(ExitCodes.SUCCESS);
    expect(output).toContain('Preflight plan:');
    expect(output).toContain('Plan ID:');
    expect(output).toContain('NO FILL OR SUBMISSION OCCURRED.');
  }, 30000);

  it('preflight JSON is structured and secret-safe', async () => {
    const { ctx, dir } = makeCtx();
    allow(dir, 'exec-success');
    const stdout = captureStdout();
    const code = await handleCmdRun(['exec-success', '--seed', 'seed-cli-2', '--json'], ctx);
    const output = readStdout(stdout);
    expect(code).toBe(ExitCodes.SUCCESS);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed.command).toBe('run');
    expect(parsed.mode).toBe('preflight');
    expect(parsed.runId).toBeDefined();
    expect((parsed.plan as Record<string, unknown>).planId).toBeDefined();
    expect(output).not.toContain('VERY_SECRET_BROWSER_VALUE');
    expect(output).not.toContain('token=VERY_SECRET_TOKEN');
  }, 30000);
});
