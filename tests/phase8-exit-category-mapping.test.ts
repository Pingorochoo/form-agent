/**
 * Phase 8 non-zero exit → category mapping (P8-R9, AV).
 *
 *   1 runtime error -> error          2 usage/config -> usage_error
 *   3 block -> blocked_check / blocked_preflight (operation-dependent)
 *   4 LLM offline -> llm_offline      5 LLM connectivity -> llm_connectivity
 *   127 unknown command -> error; every category maps to exactly one status.
 */

import { describe, expect, it } from 'vitest';

import { statusForCategory } from '../src/openclaw/contracts.ts';
import { exitResult, makeAdapter } from './support/phase8.ts';
import { PRINCIPAL } from './support/phase8-preflight.ts';

interface Case {
  operation: 'analyze' | 'check' | 'preflight' | 'metrics';
  input: { target?: string };
  exit: number;
  category: string;
}

const CASES: Case[] = [
  { operation: 'analyze', input: { target: 'demo-fixture' }, exit: 1, category: 'error' },
  { operation: 'analyze', input: { target: 'demo-fixture' }, exit: 2, category: 'usage_error' },
  { operation: 'analyze', input: { target: 'demo-fixture' }, exit: 3, category: 'error' },
  { operation: 'analyze', input: { target: 'demo-fixture' }, exit: 4, category: 'llm_offline' },
  { operation: 'analyze', input: { target: 'demo-fixture' }, exit: 5, category: 'llm_connectivity' },
  { operation: 'analyze', input: { target: 'demo-fixture' }, exit: 127, category: 'error' },
  { operation: 'check', input: { target: 'demo-fixture' }, exit: 3, category: 'blocked_check' },
  { operation: 'preflight', input: { target: 'demo-fixture' }, exit: 3, category: 'blocked_preflight' },
  { operation: 'metrics', input: {}, exit: 4, category: 'llm_offline' },
];

describe('adapter non-zero exit mapping', () => {
  for (const testCase of CASES) {
    it(`${testCase.operation} exit ${testCase.exit} -> ${testCase.category}`, async () => {
      const fixture = makeAdapter();
      fixture.runner.enqueue(exitResult(testCase.exit, '', 'controlled failure'));
      const envelope = await fixture.adapter.execute(PRINCIPAL, {
        operation: testCase.operation,
        ...testCase.input,
      });
      expect(envelope.category).toBe(testCase.category);
      expect(envelope.formAgentExitCode).toBe(testCase.exit);
      expect(statusForCategory(envelope.category)).toBe(envelope.status);
      // No fabricated success and no new exit code.
      expect([1, 2, 3, 4, 5, 127]).toContain(envelope.formAgentExitCode);
      fixture.cleanup();
    });
  }

  it('a pre-start spawn failure is an error with a null exit code', async () => {
    const fixture = makeAdapter();
    fixture.runner.enqueue({ kind: 'spawn_failed', errorCode: 'ENOENT' });
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'analyze', target: 'demo-fixture' });
    expect(envelope.category).toBe('error');
    expect(envelope.formAgentExitCode).toBeNull();
    fixture.cleanup();
  });
});
