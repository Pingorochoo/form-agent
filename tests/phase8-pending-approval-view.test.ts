/**
 * Phase 8 pending views (P8-R11, AI).
 *
 * `pending_status` is INTERNAL/plugin-only and returns `PendingApprovalView`
 * (with `targetKey`). Model-facing results carry only `PendingSummary` (never
 * `targetKey`/`targetArg`). The trusted plugin never reads the JSON file.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MODEL_OPERATIONS } from '../src/openclaw/contracts.ts';
import { PRINCIPAL, preflightEnvelope } from './support/phase8-preflight.ts';

describe('pending_status internal view (AI)', () => {
  it('returns a PendingApprovalView with targetKey for the trusted plugin', async () => {
    const fixture = await preflightEnvelope();
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'pending_status' });
    expect(envelope.category).toBe('ok_pending_status');
    const pending = envelope.data['pending'] as Record<string, unknown>;
    expect(pending).toMatchObject({
      status: 'pending',
      targetKey: 'fixture:demo-fixture',
      targetDisplay: 'demo-fixture',
    });
    expect(pending['pendingId']).toMatch(/^[0-9a-f]{32}$/);
    expect(pending['planId']).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof pending['expiresAtMs']).toBe('number');
    // The model-facing envelope.pending is only the smaller PendingSummary.
    expect(envelope.pending).not.toHaveProperty('targetKey');
    expect(envelope.pending).not.toHaveProperty('targetArg');
    fixture.cleanup();
  });

  it('returns pending:null when there is no record', async () => {
    const fixture = await preflightEnvelope();
    fixture.store.cancel(PRINCIPAL);
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'pending_status' });
    expect(envelope.data['pending']).toBeNull();
    expect(envelope.pending).toBeNull();
    fixture.cleanup();
  });

  it('is not exposed in the model operation enum', async () => {
    expect((MODEL_OPERATIONS as readonly string[]).includes('pending_status')).toBe(false);
  });
});

describe('model-facing results never expose identity internals', () => {
  it('a successful preflight envelope carries targetDisplay but no targetKey/targetArg', async () => {
    const fixture = await preflightEnvelope();
    const serialized = JSON.stringify(fixture.envelope);
    expect(serialized).toContain('demo-fixture');
    expect(serialized).not.toContain('fixture:demo-fixture');
    expect(serialized).not.toContain('targetArg');
    expect(serialized).not.toContain('targetKey');
    fixture.cleanup();
  });

  it('the plugin client never reads the pending JSON file directly', () => {
    const source = readFileSync(
      new URL('../integrations/openclaw-plugin/pending-client.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('node:fs');
    expect(source).not.toContain('readFileSync');
    expect(source).not.toContain('openclaw-pending');
  });
});
