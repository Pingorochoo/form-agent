/**
 * Phase 8 submit-path ambiguity semantics (P8-R13, AC / §12.1).
 *
 * For a STARTED submit child, timeout/cap/truncation/malformed/loss are
 * ambiguous: `unknown_outcome` + sticky `consumed_unknown`, never retried and
 * never reinterpreted as a safe generic error. Non-submit capped/malformed
 * output is an ordinary controlled error with no pending record.
 */

import { describe, expect, it } from 'vitest';

import type { RunResult } from '../src/openclaw/runner.ts';
import { exitResult, submitParams, submitUnknownDoc } from './support/phase8.ts';
import { PRINCIPAL, getPreflightPending, preflightEnvelope } from './support/phase8-preflight.ts';

function capResult(): RunResult {
  return {
    kind: 'output_cap',
    stream: 'stdout',
    stdout: 'x',
    stderr: '',
    pid: 4242,
    processGroup: 4242,
    signal: 'SIGKILL',
  };
}

function timeoutResult(): RunResult {
  return {
    kind: 'timeout',
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    pid: 4242,
    processGroup: 4242,
    signal: 'SIGTERM',
  };
}

async function ambiguousWith(result: RunResult) {
  const fixture = await preflightEnvelope();
  const pending = getPreflightPending(fixture.store, PRINCIPAL);
  if (pending === null) throw new Error('expected a pending record');
  fixture.runner.enqueue(result);
  const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
  return { fixture, pending, envelope };
}

describe('ambiguous started submit', () => {
  const cases: Array<{ name: string; result: RunResult; exitCode: number | null }> = [
    { name: 'output cap', result: capResult(), exitCode: null },
    { name: 'timeout', result: timeoutResult(), exitCode: null },
    { name: 'malformed exit 0', result: exitResult(0, 'not json at all'), exitCode: 0 },
    { name: 'malformed exit 3', result: exitResult(3, 'partial non-json'), exitCode: 3 },
    { name: 'form-agent unknown_outcome (exit 0)', result: exitResult(0, submitUnknownDoc()), exitCode: 0 },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} -> unknown_outcome + consumed_unknown`, async () => {
      const { fixture, envelope } = await ambiguousWith(testCase.result);
      expect(envelope.category).toBe('unknown_outcome');
      expect(envelope.status).toBe('unknown_outcome');
      expect(envelope.formAgentExitCode).toBe(testCase.exitCode);
      expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('consumed_unknown');
      fixture.cleanup();
    });
  }

  it('the barrier is sticky: preflight and cancel both blocked, no retry', async () => {
    const { fixture } = await ambiguousWith(timeoutResult());
    const calls = fixture.runner.calls.length;
    expect((await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' })).category).toBe('unknown_barrier');
    expect((await fixture.adapter.execute(PRINCIPAL, { operation: 'cancel_pending' })).category).toBe('unknown_barrier');
    expect(fixture.runner.calls.length).toBe(calls);
    fixture.cleanup();
  });
});

describe('non-submit capped/malformed output', () => {
  it('preflight cap is a controlled error and creates no pending record', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.store.cancel(PRINCIPAL);

    fixture.runner.enqueue(capResult());
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(['error', 'timeout']).toContain(envelope.category);
    expect(fixture.store.peekRaw(PRINCIPAL)).toBeNull();
    fixture.cleanup();
  });

  it('non-submit timeout is an ordinary timeout with no pending record', async () => {
    const fixture = await preflightEnvelope();
    fixture.store.cancel(PRINCIPAL);
    fixture.runner.enqueue(timeoutResult());
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'analyze', target: 'demo-fixture' });
    expect(envelope.category).toBe('timeout');
    expect(fixture.store.peekRaw(PRINCIPAL)).toBeNull();
    fixture.cleanup();
  });
});
