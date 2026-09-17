/**
 * Phase 8 same-config/same-DB auth consistency (P8-R21, AS).
 *
 * Authorization recorded in a DIFFERENT config/DB does not satisfy `run`. The
 * adapter always invokes Form Agent with the SAME fixed `--config` context for
 * every operation, including preflight and submit.
 */

import { describe, expect, it } from 'vitest';

import {
  buildAnalyzeArgv,
  buildPreflightArgv,
  buildSubmitArgv,
} from '../src/openclaw/contracts.ts';
import { handleCmdAuth } from '../src/cli/auth.ts';
import { captureStdout, readStdout, testConfig } from './support/phase8.ts';
import { makeMetricsCtx } from './support/phase7.ts';

const TARGET = 'https://fixtures.local/forms/exec-success';

describe('same-config authorization', () => {
  it('authorization in a different DB does not satisfy a check in another DB', async () => {
    const { ctx: ctxA } = makeMetricsCtx();
    await handleCmdAuth(['allow', TARGET, '--scope', 'run', '--by', 'op'], ctxA);

    const { ctx: ctxB } = makeMetricsCtx();
    const stdout = captureStdout();
    await handleCmdAuth(['check', TARGET], ctxB);
    const crossDb = readStdout(stdout);
    stdout.mockRestore();
    expect(crossDb).toContain('state=not-allowlisted');

    const stdoutSame = captureStdout();
    await handleCmdAuth(['check', TARGET], ctxA);
    const sameDb = readStdout(stdoutSame);
    stdoutSame.mockRestore();
    expect(sameDb).toContain('state=authorized');
  });
});

describe('single fixed adapter config context', () => {
  it('uses the exact same --config for every operation, including submit', () => {
    const config = testConfig('/tmp/p8-auth-consistency', { formAgentConfigPath: '/etc/form-agent/form-agent.json' });
    const expected = ['--config', '/etc/form-agent/form-agent.json'];
    expect(buildAnalyzeArgv(config, 'demo-fixture').slice(0, 2)).toEqual(expected);
    expect(buildPreflightArgv(config, 'demo-fixture', 'a'.repeat(32), undefined).slice(0, 2)).toEqual(expected);
    expect(
      buildSubmitArgv(config, { targetArg: 'demo-fixture', seed: 'a'.repeat(32), planId: 'b'.repeat(64) }, '1').slice(0, 2),
    ).toEqual(expected);
  });

  it('without an explicit config it uses a single fixed cwd (never model input)', () => {
    const withCwd = testConfig('/tmp/p8-auth-consistency', { formAgentCwd: '/srv/form-agent' });
    expect(withCwd.formAgentCwd).toBe('/srv/form-agent');
    expect(buildAnalyzeArgv(withCwd, 'demo-fixture')).not.toContain('--config');
  });
});
