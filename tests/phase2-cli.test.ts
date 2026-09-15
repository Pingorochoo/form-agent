/**
 * Phase 2 CLI tests (P2-R4, P2-R5, P2-R18).
 *
 * Covers `auth allow/check/list/revoke` local behavior and the policy-aware
 * `analyze` output. All targets are local fixtures only.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExitCodes } from '../src/cli/exit-codes.ts';
import { handleCmdAnalyze, type CliContext } from '../src/cli/index.ts';
import { handleCmdAuth } from '../src/cli/auth.ts';
import { defaultConfig, type AppConfig } from '../src/config/schema.ts';
import { createLogger, type Logger } from '../src/logging/logger.ts';

const FIXTURE_PATH = new URL('../fixtures/archives/observed-responder.html', import.meta.url);

function makeCtx(dbDir: string): { ctx: CliContext; logs: string[] } {
  const config: AppConfig = defaultConfig();
  config.database.directory = dbDir;
  config.database.filename = 'cli-test.db';
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

describe('auth allow / check / list / revoke (P2-R4, P2-R5)', () => {
  it('allow then check reports authorized', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-auth-cli-'));
    const { ctx } = makeCtx(dbDir);
    const stdout = captureStdout();

    expect(await handleCmdAuth(['allow', 'https://fixtures.local/forms/demo', '--scope', 'run', '--by', 'op-1'], ctx)).toBe(ExitCodes.SUCCESS);
    expect(await handleCmdAuth(['check', 'https://fixtures.local/forms/demo'], ctx)).toBe(ExitCodes.SUCCESS);

    const output = readStdout(stdout);
    expect(output).toContain('allowlisted https://fixtures.local/forms/demo for scope run (operator op-1)');
    expect(output).toContain('state=authorized');
    expect(output).toContain('scope=run');
    expect(output).toContain('operator=op-1');
  });

  it('check distinguishes not-allowlisted and revoked', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-auth-cli2-'));
    const { ctx } = makeCtx(dbDir);

    let stdout = captureStdout();
    expect(await handleCmdAuth(['check', 'https://fixtures.local/forms/never'], ctx)).toBe(ExitCodes.SUCCESS);
    expect(readStdout(stdout)).toContain('state=not-allowlisted');
    stdout.mockRestore();

    await handleCmdAuth(['allow', 'https://fixtures.local/forms/never', '--scope', 'run', '--by', 'op'], ctx);
    await handleCmdAuth(['revoke', 'https://fixtures.local/forms/never', '--scope', 'run'], ctx);

    stdout = captureStdout();
    expect(await handleCmdAuth(['check', 'https://fixtures.local/forms/never'], ctx)).toBe(ExitCodes.SUCCESS);
    expect(readStdout(stdout)).toContain('state=revoked');
  });

  it('list shows audit records with no secrets', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-auth-cli3-'));
    const { ctx } = makeCtx(dbDir);
    await handleCmdAuth(['allow', 'https://fixtures.local/forms/demo', '--scope', 'run', '--by', 'auditor'], ctx);

    const stdout = captureStdout();
    expect(await handleCmdAuth(['list'], ctx)).toBe(ExitCodes.SUCCESS);
    const output = readStdout(stdout);
    expect(output).toContain('target=https://fixtures.local/forms/demo');
    expect(output).toContain('scope=run');
    expect(output).toContain('status=active');
    expect(output).toContain('operator=auditor');
    expect(output).not.toContain('password');
    expect(output).not.toContain('token');
  });

  it('revoke reports a clear no-op for an unknown target', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-auth-cli4-'));
    const { ctx } = makeCtx(dbDir);
    const stdout = captureStdout();
    expect(await handleCmdAuth(['revoke', 'https://fixtures.local/forms/missing', '--scope', 'run'], ctx)).toBe(ExitCodes.SUCCESS);
    expect(readStdout(stdout)).toContain('nothing to revoke');
  });

  it('never echoes query/userinfo/fragment secrets in allow/check/list/revoke output', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-auth-cli-secret-'));
    const { ctx } = makeCtx(dbDir);
    const target = 'https://user:password@example.com/path?token=VERY_SECRET_VALUE#frag';

    let stdout = captureStdout();
    expect(await handleCmdAuth(['allow', target, '--scope', 'run', '--by', 'auditor'], ctx)).toBe(ExitCodes.SUCCESS);
    let output = readStdout(stdout);
    expect(output).not.toContain('VERY_SECRET_VALUE');
    expect(output).not.toContain('password');
    expect(output).toContain('https://example.com/path');
    stdout.mockRestore();

    stdout = captureStdout();
    expect(await handleCmdAuth(['check', target], ctx)).toBe(ExitCodes.SUCCESS);
    output = readStdout(stdout);
    expect(output).not.toContain('VERY_SECRET_VALUE');
    expect(output).not.toContain('password');
    stdout.mockRestore();

    stdout = captureStdout();
    await handleCmdAuth(['list'], ctx);
    output = readStdout(stdout);
    expect(output).not.toContain('VERY_SECRET_VALUE');
    expect(output).not.toContain('password');
    stdout.mockRestore();

    stdout = captureStdout();
    await handleCmdAuth(['revoke', target, '--scope', 'run'], ctx);
    output = readStdout(stdout);
    expect(output).not.toContain('VERY_SECRET_VALUE');
    expect(output).not.toContain('password');
  });
});

describe('auth CLI validation', () => {
  it('requires --by on allow', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-auth-cli5-'));
    const { ctx } = makeCtx(dbDir);
    expect(await handleCmdAuth(['allow', 'https://fixtures.local/forms/demo', '--scope', 'run'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('rejects an unsupported scope', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-auth-cli6-'));
    const { ctx } = makeCtx(dbDir);
    expect(await handleCmdAuth(['allow', 'https://fixtures.local/forms/demo', '--scope', 'delete', '--by', 'op'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('rejects an empty target', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-auth-cli7-'));
    const { ctx } = makeCtx(dbDir);
    expect(await handleCmdAuth(['check', ''], ctx)).toBe(ExitCodes.USAGE);
  });

  it('rejects an unknown auth subcommand', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-auth-cli8-'));
    const { ctx } = makeCtx(dbDir);
    expect(await handleCmdAuth(['bogus'], ctx)).toBe(ExitCodes.USAGE);
  });
});

describe('analyze remains read-only and policy-aware (P2-R18)', () => {
  it('reports NOT AUTHORIZED for an unallowlisted target', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-analyze-policy-'));
    const { ctx } = makeCtx(dbDir);
    const stdout = captureStdout();

    const code = await handleCmdAnalyze(FIXTURE_PATH.pathname, ctx);
    const output = readStdout(stdout);

    expect(code).toBe(ExitCodes.SUCCESS);
    expect(output).toContain('Form: Evaluación de experiencia y preferencias del estudiante');
    expect(output).toContain('Policy:');
    expect(output).toContain('NOT AUTHORIZED for submission/execution');
    expect(output).toContain('Sensitive fields:');
  });

  it('does not dump the raw payload in the policy section', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-analyze-policy2-'));
    const { ctx } = makeCtx(dbDir);
    const stdout = captureStdout();
    await handleCmdAnalyze(FIXTURE_PATH.pathname, ctx);
    const output = readStdout(stdout);
    expect(output).not.toContain('FB_PUBLIC_LOAD_DATA_');
    expect(output).not.toContain('"[1768533602');
  });

  it('fixture file bytes remain unchanged after analyze', async () => {
    const before = readFileSync(FIXTURE_PATH, 'utf8');
    const dbDir = mkdtempSync(join(tmpdir(), 'form-agent-analyze-policy3-'));
    const { ctx } = makeCtx(dbDir);
    await handleCmdAnalyze(FIXTURE_PATH.pathname, ctx);
    expect(readFileSync(FIXTURE_PATH, 'utf8')).toBe(before);
  });
});
