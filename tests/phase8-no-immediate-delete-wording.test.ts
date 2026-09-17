/**
 * Phase 8 no-immediate-delete consistency (P8-R12/P8-R27, BA/BB).
 *
 * The controlling BA/BB correction: an `UNAMBIGUOUS_TERMINAL_RESULTS` result
 * persists a durable `completed_unambiguous` handoff and is NOT deleted
 * immediately. Only the internal idempotent `submit_ack` removes it.
 *
 * NOTE: `docs/PHASE_8.md` still contains the older "closes/removes the local
 * pending record" sentence in §16 (AH) and §17 acceptance scenario 10. That
 * sentence is superseded by the BA/BB sections and MUST NOT be implemented as
 * immediate deletion. This pass does not edit the frozen spec.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { exitResult, submitParams, submitSuccessDoc } from './support/phase8.ts';
import { PRINCIPAL, getPreflightPending, preflightEnvelope } from './support/phase8-preflight.ts';
import { pendingFilePath } from '../src/openclaw/pending.ts';
import { existsSync } from 'node:fs';

describe('no immediate delete', () => {
  it('keeps the durable handoff on disk until submit_ack', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.runner.enqueue(exitResult(0, submitSuccessDoc(pending.planId)));
    await fixture.adapter.execute(PRINCIPAL, submitParams(pending));

    // Completed, but the local record still exists (not immediately deleted).
    expect(fixture.store.peekRaw(PRINCIPAL)?.status).toBe('completed_unambiguous');
    expect(existsSync(pendingFilePath(fixture.dir, PRINCIPAL))).toBe(true);

    const status = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_status',
      pendingRef: pending.pendingId,
      planId: pending.planId,
    });
    await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_ack',
      pendingRef: pending.pendingId,
      attempt: status.data['attemptId'] as string,
    });
    expect(fixture.store.peekRaw(PRINCIPAL)).toBeNull();
    expect(existsSync(pendingFilePath(fixture.dir, PRINCIPAL))).toBe(false);
    fixture.cleanup();
  });

  it('the pending store removes records only in cancel/reconcile/ack paths', () => {
    const source = readFileSync(new URL('../src/openclaw/pending.ts', import.meta.url), 'utf8');
    // markCompletedUnambiguous must never call removeRecord.
    const completed = source.slice(
      source.indexOf('markCompletedUnambiguous'),
      source.indexOf('submitStatus('),
    );
    expect(completed).not.toContain('removeRecord');
    // acknowledge is the internal remover for a completed handoff.
    const ack = source.slice(source.indexOf('acknowledge('), source.indexOf('peekRaw('));
    expect(ack).toContain('removeRecord');
  });

  it('the frozen spec keeps the BA/BB correction and marks the legacy wording stale', () => {
    const spec = readFileSync(new URL('../docs/PHASE_8.md', import.meta.url), 'utf8');
    expect(spec).toContain('does NOT immediately delete the record');
    for (const line of spec.split('\n')) {
      if (line.includes('clean completion removes the local record')) {
        // Only ever referenced as the stale/non-normative phrase being rejected.
        expect(line.includes('stale') || line.includes('no normative')).toBe(true);
      }
    }
  });
});
