/**
 * Phase 8 fixture-vs-live setup sequence (P8-R21, AG / AS).
 *
 * Offline `analyze`/`draft`/`check` against a fixture need no `run`
 * authorization. `run` (including fixture preflight) keeps the authorization
 * gate: an unauthorized fixture preflight is blocked, and after locally
 * allowlisting the execution fixture it proceeds through the SAME config/DB.
 */

import { describe, expect, it } from 'vitest';

import { handleCmdAnalyze } from '../src/cli/index.ts';
import { handleCmdDraft } from '../src/cli/draft.ts';
import { handleCmdCheck } from '../src/cli/check.ts';
import { handleCmdRun } from '../src/cli/run.ts';
import { ExitCodes } from '../src/cli/exit-codes.ts';
import { AuthorizationStore } from '../src/policy/authz.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';
import { captureStdout, makeMetricsCtx, openDb, readStdout } from './support/phase7.ts';

const FIXTURE_PATH = new URL('../fixtures/archives/observed-responder.html', import.meta.url);
const FIXTURE_URL = 'https://fixtures.local/forms/observed-responder';

function allow(dir: string, fixtureId: string): void {
  const db = openDb(dir);
  try {
    new AuthorizationStore(db).allow(canonicalizeTarget(fixtureId), 'run', 'op');
  } finally {
    db.close();
  }
}

describe('P8-R21 — setup sequence', () => {
  it('offline analyze/draft/check need no run authorization', async () => {
    const { ctx } = makeMetricsCtx();

    let stdout = captureStdout();
    expect(await handleCmdAnalyze(FIXTURE_PATH.pathname, ctx)).toBe(ExitCodes.SUCCESS);
    stdout.mockRestore();

    stdout = captureStdout();
    expect(await handleCmdDraft([FIXTURE_URL, '--seed', 'p8-setup-seed'], ctx)).toBe(ExitCodes.SUCCESS);
    stdout.mockRestore();

    stdout = captureStdout();
    expect(await handleCmdCheck([FIXTURE_URL, '--seed', 'p8-setup-seed'], ctx)).toBe(ExitCodes.SUCCESS);
    stdout.mockRestore();
  }, 60_000);

  it('an unauthorized fixture run preflight is blocked before submit', async () => {
    const { ctx } = makeMetricsCtx();
    const stdout = captureStdout();
    const code = await handleCmdRun(['exec-success', '--seed', 'p8-setup-unauth', '--json', '--json-error'], ctx);
    const output = readStdout(stdout);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.VALIDATION);
    expect(output).toContain('EXECUTION_NOT_AUTHORIZED');
    expect(output).toContain('"kind":"block"');
  }, 60_000);

  it('after locally allowlisting the execution fixture, preflight proceeds', async () => {
    const { ctx, dir } = makeMetricsCtx();
    allow(dir, 'exec-success');
    const stdout = captureStdout();
    const code = await handleCmdRun(['exec-success', '--seed', 'p8-setup-auth', '--json', '--json-error'], ctx);
    const output = readStdout(stdout);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.SUCCESS);
    const doc = JSON.parse(output) as { command: string; mode: string; plan: { planId: string } };
    expect(doc.command).toBe('run');
    expect(doc.mode).toBe('preflight');
    expect(doc.plan.planId).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);

  it('a different config/DB context does not satisfy the run authorization gate', async () => {
    const { dir: dirA } = makeMetricsCtx();
    allow(dirA, 'exec-success');

    // A second, independent DB has no authorization for the same fixture.
    const { ctx: ctxB, dir: dirB } = makeMetricsCtx();
    expect(dirA).not.toBe(dirB);
    const stdout = captureStdout();
    const code = await handleCmdRun(['exec-success', '--seed', 'p8-setup-cross', '--json', '--json-error'], ctxB);
    const output = readStdout(stdout);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.VALIDATION);
    expect(output).toContain('EXECUTION_NOT_AUTHORIZED');
  }, 60_000);
});
