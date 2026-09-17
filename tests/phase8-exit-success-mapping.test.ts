/**
 * Phase 8 operation-specific exit-0 mapping (P8-R9, AV + AX).
 *
 * Exit 0 is NOT a generic `ok` category. Preflight success is exactly
 * `needs_confirmation`; submit success is `ok_submit_success`.
 */

import { describe, expect, it } from 'vitest';

import { ADAPTER_CATEGORIES } from '../src/openclaw/contracts.ts';
import {
  analyzeDoc,
  checkDoc,
  draftDoc,
  exitResult,
  makeAdapter,
  metricsDoc,
  preflightDoc,
  submitParams,
  submitSuccessDoc,
} from './support/phase8.ts';
import { PRINCIPAL, getPreflightPending, preflightEnvelope } from './support/phase8-preflight.ts';

describe('exit 0 category mapping', () => {
  it('maps each operation to its frozen success category/status', async () => {
    const fixture = makeAdapter();
    fixture.runner.enqueue(exitResult(0, analyzeDoc()));
    const analyze = await fixture.adapter.execute(PRINCIPAL, { operation: 'analyze', target: 'demo-fixture' });
    expect(analyze).toMatchObject({ category: 'ok_analyze', status: 'ok', formAgentExitCode: 0 });

    fixture.runner.enqueue(exitResult(0, draftDoc()));
    const draft = await fixture.adapter.execute(PRINCIPAL, { operation: 'draft', target: 'demo-fixture' });
    expect(draft).toMatchObject({ category: 'ok_draft', status: 'ok' });

    fixture.runner.enqueue(exitResult(0, checkDoc(false)));
    const check = await fixture.adapter.execute(PRINCIPAL, { operation: 'check', target: 'demo-fixture' });
    expect(check).toMatchObject({ category: 'ok_check', status: 'ok' });

    fixture.runner.enqueue(exitResult(0, metricsDoc()));
    const metrics = await fixture.adapter.execute(PRINCIPAL, { operation: 'metrics' });
    expect(metrics).toMatchObject({ category: 'ok_metrics', status: 'ok' });
    fixture.cleanup();
  });

  it('a blocked check result is blocked_check, never ok_check', async () => {
    const fixture = makeAdapter();
    fixture.runner.enqueue(exitResult(3, checkDoc(true)));
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'check', target: 'demo-fixture' });
    expect(envelope.category).toBe('blocked_check');
    expect(envelope.status).toBe('blocked');
    fixture.cleanup();
  });

  it('preflight exit 0 is needs_confirmation (never ok)', async () => {
    const fixture = makeAdapter();
    fixture.runner.enqueue(exitResult(0, preflightDoc()));
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(envelope.category).toBe('needs_confirmation');
    expect(envelope.status).toBe('needs_confirmation');
    expect(envelope.category).not.toBe('ok');
    fixture.cleanup();
  });

  it('submit exit 0 with valid success JSON is ok_submit_success', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.runner.enqueue(exitResult(0, submitSuccessDoc(pending.planId)));
    const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    expect(envelope.category).toBe('ok_submit_success');
    expect(envelope.status).toBe('ok');
    fixture.cleanup();
  });

  it('has no generic ok / ok_preflight category', () => {
    expect(ADAPTER_CATEGORIES).not.toContain('ok' as never);
    expect(ADAPTER_CATEGORIES).not.toContain('ok_preflight' as never);
  });
});
