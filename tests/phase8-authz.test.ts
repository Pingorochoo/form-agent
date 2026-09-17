/** Phase 8 adapter authorization re-check (P8-R5, §5.1.9). */

import { describe, expect, it } from 'vitest';

import { analyzeDoc, exitResult, makeAdapter, OPERATOR } from './support/phase8.ts';

describe('adapter principal re-check', () => {
  it('rejects a non-operator sender without invoking Form Agent', async () => {
    const fixture = makeAdapter();
    const envelope = await fixture.adapter.execute(
      { channel: 'telegram', accountId: OPERATOR.accountId, senderId: '9999999' },
      { operation: 'analyze', target: 'demo-fixture' },
    );
    expect(envelope.category).toBe('unauthorized');
    expect(envelope.status).toBe('blocked');
    expect(fixture.runner.calls).toHaveLength(0);
    fixture.cleanup();
  });

  it('rejects a mismatched account without invoking Form Agent', async () => {
    const fixture = makeAdapter();
    const envelope = await fixture.adapter.execute(
      { channel: 'telegram', accountId: 'other-account', senderId: OPERATOR.senderId },
      { operation: 'analyze', target: 'demo-fixture' },
    );
    expect(envelope.category).toBe('unauthorized');
    expect(fixture.runner.calls).toHaveLength(0);
    fixture.cleanup();
  });

  it('rejects missing principal fields without invoking Form Agent', async () => {
    const fixture = makeAdapter();
    const envelope = await fixture.adapter.execute({}, { operation: 'analyze', target: 'demo-fixture' });
    expect(envelope.category).toBe('unauthorized');
    expect(fixture.runner.calls).toHaveLength(0);
    fixture.cleanup();
  });

  it('authorizes exactly the frozen operator principal', async () => {
    const fixture = makeAdapter();
    fixture.runner.enqueue(exitResult(0, analyzeDoc()));
    const envelope = await fixture.adapter.execute(OPERATOR, { operation: 'analyze', target: 'demo-fixture' });
    expect(envelope.category).toBe('ok_analyze');
    expect(fixture.runner.calls).toHaveLength(1);
    fixture.cleanup();
  });

  it('re-checks authorization for internal and operator operations too', async () => {
    const fixture = makeAdapter();
    for (const operation of ['pending_status', 'submit_status', 'submit_ack', 'cancel_pending', 'reconcile_unknown'] as const) {
      const envelope = await fixture.adapter.execute(
        { channel: 'telegram', accountId: OPERATOR.accountId, senderId: '111' },
        { operation, pendingRef: 'a'.repeat(32), attempt: 'b'.repeat(32), resolution: 'observed-submitted' },
      );
      expect(envelope.category).toBe('unauthorized');
    }
    expect(fixture.runner.calls).toHaveLength(0);
    fixture.cleanup();
  });
});
