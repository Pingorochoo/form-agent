/** Helper: run one successful adapter preflight in a temp pending store. */

import { makeAdapter, exitResult, preflightDoc, type AdapterFixture } from './phase8.ts';
import type { PendingPrincipal } from '../../src/openclaw/contracts.ts';
import type { PendingRecord } from '../../src/openclaw/pending.ts';

export const PRINCIPAL: PendingPrincipal = { channel: 'telegram', accountId: 'formagent', senderId: '5550001' };

export async function preflightEnvelope(options: { target?: string; targetKey?: string; planId?: string } = {}): Promise<
  AdapterFixture & { envelope: Record<string, unknown>; principal: PendingPrincipal }
> {
  const fixture = makeAdapter();
  fixture.runner.enqueue(exitResult(0, preflightDoc(options)));
  const envelope = (await fixture.adapter.execute(PRINCIPAL, {
    operation: 'preflight',
    target: options.target ?? 'demo-fixture',
  })) as unknown as Record<string, unknown>;
  return { ...fixture, envelope, principal: PRINCIPAL };
}

export function getPreflightPending(store: AdapterFixture['store'], principal: PendingPrincipal): PendingRecord | null {
  return store.read(principal);
}
