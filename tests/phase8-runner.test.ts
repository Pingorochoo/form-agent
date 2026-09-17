/** Phase 8 subprocess runner safety + closed child env (P8-R7, §14.1). */

import { describe, expect, it } from 'vitest';

import { NodeSubprocessRunner, buildChildEnv, isInertArg } from '../src/openclaw/runner.ts';
import { ENV_NAME_PATTERN } from '../src/openclaw/contracts.ts';

describe('closed child env', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/op',
    OPENAI_API_KEY: 'sk-secret-value',
    FORM_AGENT_LLM_PROVIDER: 'openai',
    NODE_OPTIONS: '--inspect',
    LD_PRELOAD: '/evil.so',
    HTTPS_PROXY: 'http://proxy',
    UNLISTED: 'nope',
  } as NodeJS.ProcessEnv;

  it('forwards PATH/HOME plus exact provider names only', () => {
    const env = buildChildEnv(['OPENAI_API_KEY'], parent);
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/op');
    expect(env['OPENAI_API_KEY']).toBe('sk-secret-value');
    expect(env['UNLISTED']).toBeUndefined();
    expect(env['FORM_AGENT_LLM_PROVIDER']).toBeUndefined();
  });

  it('always drops denied/dangerous names even when listed', () => {
    const env = buildChildEnv(['NODE_OPTIONS', 'LD_PRELOAD', 'HTTPS_PROXY'], parent);
    expect(env['NODE_OPTIONS']).toBeUndefined();
    expect(env['LD_PRELOAD']).toBeUndefined();
    expect(env['HTTPS_PROXY']).toBeUndefined();
  });

  it('never forwards a malformed name', () => {
    const env = buildChildEnv(['lower_case', '1NOPE'], parent);
    expect(env['lower_case']).toBeUndefined();
    expect(env['1NOPE']).toBeUndefined();
  });

  it('exposes the env-name syntax for config validation', () => {
    expect(ENV_NAME_PATTERN.test('OPENAI_API_KEY')).toBe(true);
    expect(ENV_NAME_PATTERN.test('OPENAI_KEY_2')).toBe(true);
    expect(ENV_NAME_PATTERN.test('OPENAI_KEY_lc')).toBe(false);
  });
});

describe('argv is inert data', () => {
  it('rejects NUL and treats shell metacharacters as data', () => {
    expect(isInertArg('plain')).toBe(true);
    expect(isInertArg('a; b $(id) | cat > out')).toBe(true);
    expect(isInertArg('a\u0000b')).toBe(false);
    expect(isInertArg('a\u001fb')).toBe(false);
  });
});

describe('NodeSubprocessRunner', () => {
  const runner = new NodeSubprocessRunner();
  const execPath = process.execPath;

  it('runs an argv array, captures stdout and the terminal exit code', async () => {
    const result = await runner.run({
      executablePath: execPath,
      args: ['-e', "process.stdout.write('ok')"],
      cwd: process.cwd(),
      env: buildChildEnv([], {}),
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    expect(result.kind).toBe('exit');
    if (result.kind === 'exit') {
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('ok');
      expect(typeof result.pid).toBe('number');
    }
  });

  it('does not shell-interpret argument contents', async () => {
    const payload = 'a;b$(id)';
    const result = await runner.run({
      executablePath: execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', payload],
      cwd: process.cwd(),
      env: buildChildEnv([], {}),
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    expect(result.kind).toBe('exit');
    if (result.kind === 'exit') expect(result.stdout).toBe(payload);
  });

  it('reports a provable pre-start spawn failure', async () => {
    const result = await runner.run({
      executablePath: '/nonexistent/definitely-not-here',
      args: [],
      cwd: process.cwd(),
      env: buildChildEnv([], {}),
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    });
    expect(result.kind).toBe('spawn_failed');
  });

  it('bounds wall time and cancels the child', async () => {
    const result = await runner.run({
      executablePath: execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: buildChildEnv([], {}),
      timeoutMs: 200,
      maxOutputBytes: 1024,
    });
    expect(result.kind).toBe('timeout');
  });

  it('bounds captured output', async () => {
    const result = await runner.run({
      executablePath: execPath,
      args: ['-e', "process.stdout.write('x'.repeat(5000))"],
      cwd: process.cwd(),
      env: buildChildEnv([], {}),
      timeoutMs: 5000,
      maxOutputBytes: 128,
    });
    expect(result.kind).toBe('output_cap');
  });
});
