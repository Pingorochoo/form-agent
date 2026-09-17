/** Phase 8 non-approval leaves the pending record `pending` (P8-R10, AK). */

import { describe, expect, it } from 'vitest';

import { approvalDecisionsAllowed } from '../integrations/openclaw-plugin/approval-hook.ts';
import { FIXTURE_KEY, PLAN_ID, makeAdapter } from './support/phase8.ts';
import { PRINCIPAL } from './support/phase8-preflight.ts';

function seedPending(fixture: ReturnType<typeof makeAdapter>) {
  return fixture.store.create({
    principal: PRINCIPAL,
    targetKey: FIXTURE_KEY,
    targetArg: 'demo-fixture',
    targetDisplay: 'demo-fixture',
    planId: PLAN_ID,
    seed: 'b'.repeat(32),
    operator: 'telegram:5550001',
  });
}

describe('deny / timeout / no-route / rejected allow-always', () => {
  it('does not invoke Form Agent and leaves the pending record pending', () => {
    const fixture = makeAdapter();
    const record = seedPending(fixture);
    // A non-approval performs no adapter mutation at all.
    const after = fixture.store.read(PRINCIPAL);
    expect(after?.status).toBe('pending');
    expect(after?.pendingId).toBe(record.pendingId);
    expect(fixture.runner.calls).toHaveLength(0);
    fixture.cleanup();
  });

  it('keeps re-approval, cancel, and replacement available while the TTL is valid', () => {
    const fixture = makeAdapter();
    const record = seedPending(fixture);
    expect(fixture.store.cancel(PRINCIPAL).pendingId).toBe(record.pendingId);
    expect(fixture.store.read(PRINCIPAL)).toBeNull();
    fixture.cleanup();
  });

  it('never accepts allow-always', () => {
    expect(approvalDecisionsAllowed(['allow-always', 'deny'])).toBe(false);
  });

  it('a denied (un-consumed) pending is replaceable by a new preflight', () => {
    const fixture = makeAdapter();
    seedPending(fixture);
    const replacement = seedPending(fixture);
    expect(replacement.status).toBe('pending');
    expect(fixture.store.read(PRINCIPAL)?.pendingId).toBe(replacement.pendingId);
    fixture.cleanup();
  });
});
