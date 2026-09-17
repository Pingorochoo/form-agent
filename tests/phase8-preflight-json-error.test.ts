/**
 * Phase 8 preflight always passes `--json --json-error` (P8-R8/P8-R9, AU).
 *
 * A successful preflight uses the normal `--json` success document; a
 * controlled failure uses the `--json-error` document. No pending record is
 * created on a failed/blocked preflight, and the adapter never parses human
 * stderr as authority.
 */

import { describe, expect, it } from 'vitest';

import { buildPreflightArgv } from '../src/openclaw/contracts.ts';
import { exitResult, makeAdapter, preflightDoc, runErrorDoc, testConfig } from './support/phase8.ts';
import { PRINCIPAL } from './support/phase8-preflight.ts';

describe('preflight argv', () => {
  it('always includes --json and --json-error and never a review flag', () => {
    const argv = buildPreflightArgv(testConfig('/tmp/p8-preflight-argv'), 'demo-fixture', 'a'.repeat(32), undefined);
    expect(argv).toEqual(['run', 'demo-fixture', '--seed', 'a'.repeat(32), '--json', '--json-error']);
    expect(argv).not.toContain('--review-answers');
  });
});

describe('adapter preflight mapping', () => {
  it('a successful preflight returns needs_confirmation with a non-null pending', async () => {
    const fixture = makeAdapter();
    fixture.runner.enqueue(exitResult(0, preflightDoc()));
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(envelope.category).toBe('needs_confirmation');
    expect(envelope.status).toBe('needs_confirmation');
    expect(envelope.pending).not.toBeNull();
    fixture.cleanup();
  });

  it('a controlled block (exit 3) maps to blocked_preflight with no pending record', async () => {
    const fixture = makeAdapter();
    fixture.runner.enqueue(exitResult(3, runErrorDoc('EXECUTION_NOT_AUTHORIZED', 'block', 'preflight'), 'not authorized'));
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(envelope.category).toBe('blocked_preflight');
    expect(envelope.status).toBe('blocked');
    expect(fixture.store.peekRaw(PRINCIPAL)).toBeNull();
    fixture.cleanup();
  });

  it('a usage failure (exit 2) maps to usage_error with no pending record', async () => {
    const fixture = makeAdapter();
    fixture.runner.enqueue(exitResult(2, runErrorDoc('EXECUTION_TARGET_UNSUPPORTED', 'usage', 'preflight')));
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(envelope.category).toBe('usage_error');
    expect(fixture.store.peekRaw(PRINCIPAL)).toBeNull();
    fixture.cleanup();
  });

  it('never infers state from human stderr', async () => {
    const fixture = makeAdapter();
    fixture.runner.enqueue(exitResult(3, '', 'Eligible: 3\nBlocked: 1\nNo submission occurred.'));
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(envelope.category).toBe('blocked_preflight');
    expect(fixture.store.peekRaw(PRINCIPAL)).toBeNull();
    fixture.cleanup();
  });
});
