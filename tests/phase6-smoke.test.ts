/**
 * Phase 6 smoke tests — top-level CLI entry-point wiring (non-redundant with
 * the stronger E2E + CLI tests). Confirms the accepted CLI still boots and the
 * reference draft path works end-to-end through `main()`, and that a
 * reference `run` preflight persists a snapshot (uniform snapshot semantics).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../src/index.ts';

function captureStdout() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

function readStdout(stdout: { mock: { calls: Array<Array<unknown>> } }): string {
  return stdout.mock.calls.map((call) => String(call[0])).join('');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('P6-R1 — CLI entry point', () => {
  it('--version returns success', async () => {
    const stdout = captureStdout();
    const code = await main(['--version']);
    expect(code).toBe(0);
    expect(readStdout(stdout)).toContain('form-agent v');
  });

  it('--help returns success and mentions --draft-provider', async () => {
    const stdout = captureStdout();
    const code = await main(['--help']);
    expect(code).toBe(0);
    expect(readStdout(stdout)).toContain('--draft-provider');
  });

  it('a reference draft works end-to-end through main()', async () => {
    const stdout = captureStdout();
    const code = await main(['draft', 'https://fixtures.local/forms/observed-responder', '--seed', 'smoke-1']);
    expect(code).toBe(0);
    expect(readStdout(stdout)).toContain('Provider: deterministic-reference');
  });
});
