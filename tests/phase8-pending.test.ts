/** Phase 8 pending store: TTL, immutable identity, cancel rules (P8-R11/P8-R27). */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PENDING_TTL_MS, recheckThreePartTarget } from '../src/openclaw/contracts.ts';
import { PendingError, PendingStore } from '../src/openclaw/pending.ts';
import { PRINCIPAL, getPreflightPending, preflightEnvelope } from './support/phase8-preflight.ts';

describe('pending record', () => {
  it('creates a pending record with the frozen fields and 10-minute TTL', async () => {
    const fixture = await preflightEnvelope();
    const record = getPreflightPending(fixture.store, PRINCIPAL);
    expect(record).not.toBeNull();
    if (record === null) return;
    expect(record.version).toBe(1);
    expect(record.pendingId).toMatch(/^[0-9a-f]{32}$/);
    expect(record.planId).toMatch(/^[0-9a-f]{64}$/);
    expect(record.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(record.operator).toBe('telegram:5550001');
    expect(record.status).toBe('pending');
    expect(record.expiresAtMs - record.createdAtMs).toBe(PENDING_TTL_MS);
    expect(record).not.toHaveProperty('confirmationCode');
    fixture.cleanup();
  });

  it('writes the pending file with mode 0600 and without answer values', async () => {
    const fixture = await preflightEnvelope();
    const record = getPreflightPending(fixture.store, PRINCIPAL);
    const path = join(fixture.dir, 'openclaw-pending');
    const files = readdirSync(path);
    expect(files.length).toBe(1);
    const full = join(path, files[0] as string);
    expect(statSync(full).mode & 0o777).toBe(0o600);
    const body = readFileSync(full, 'utf8');
    expect(body).not.toContain('"value"');
    expect(body).not.toContain('hello');
    expect(record).not.toHaveProperty('answers');
    fixture.cleanup();
  });

  it('gives a replacement preflight a NEW pendingId (identity immutability)', async () => {
    const fixture = await preflightEnvelope();
    const first = getPreflightPending(fixture.store, PRINCIPAL);
    fixture.runner.enqueue({ ...(await import('./support/phase8.ts')).exitResult(0, (await import('./support/phase8.ts')).preflightDoc()) });
    await fixture.adapter.execute(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    const second = getPreflightPending(fixture.store, PRINCIPAL);
    expect(second?.pendingId).not.toBe(first?.pendingId);
    fixture.cleanup();
  });

  it('cancels only a pending record', async () => {
    const fixture = await preflightEnvelope();
    const record = getPreflightPending(fixture.store, PRINCIPAL);
    expect(fixture.store.cancel(PRINCIPAL).pendingId).toBe(record?.pendingId);
    expect(fixture.store.read(PRINCIPAL)).toBeNull();
    expect(() => fixture.store.cancel(PRINCIPAL)).toThrow(PendingError);
    fixture.cleanup();
  });

  it('never mutates identity fields in place when claiming', async () => {
    const fixture = await preflightEnvelope();
    const before = getPreflightPending(fixture.store, PRINCIPAL);
    const claimed = fixture.store.claim(
      PRINCIPAL,
      {
        pendingRef: before?.pendingId as string,
        planId: before?.planId as string,
        targetKey: before?.targetKey as string,
        targetDisplay: before?.targetDisplay as string,
        expiresAtMs: before?.expiresAtMs as number,
      },
      recheckThreePartTarget,
    );
    expect(claimed.pendingId).toBe(before?.pendingId);
    expect(claimed.planId).toBe(before?.planId);
    expect(claimed.targetKey).toBe(before?.targetKey);
    expect(claimed.targetArg).toBe(before?.targetArg);
    expect(claimed.targetDisplay).toBe(before?.targetDisplay);
    expect(claimed.expiresAtMs).toBe(before?.expiresAtMs);
    expect(claimed.status).toBe('claimed');
    fixture.cleanup();
  });

  it('persists conversationId outside the durable principal and remains readable by a fresh store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-p8-conversation-'));

    const writer = new PendingStore({ dataDir: dir });
    const created = writer.create({
      principal: PRINCIPAL,
      conversationId: 'telegram',
      targetKey: 'fixture:demo-fixture',
      targetArg: 'demo-fixture',
      targetDisplay: 'demo-fixture',
      planId: 'a'.repeat(64),
      seed: 'b'.repeat(32),
      operator: 'telegram:5550001',
    });

    expect(created.principal).toEqual(PRINCIPAL);
    expect('conversationId' in created.principal).toBe(false);
    expect(created.conversationId).toBe('telegram');

    // Simulates the next short-lived adapter process reading persisted state.
    const reader = new PendingStore({ dataDir: dir });
    const reloaded = reader.read(PRINCIPAL);

    expect(reloaded).not.toBeNull();
    expect(reloaded?.pendingId).toBe(created.pendingId);
    expect(reloaded?.principal).toEqual(PRINCIPAL);
    expect('conversationId' in (reloaded?.principal ?? {})).toBe(false);
    expect(reloaded?.conversationId).toBe('telegram');

    expect(reader.cancel(PRINCIPAL).pendingId).toBe(created.pendingId);
    expect(reader.read(PRINCIPAL)).toBeNull();
  });

  it('detects a corrupt pending file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-p8-corrupt-'));
    const store = new PendingStore({ dataDir: dir });
    mkdirSync(join(dir, 'openclaw-pending'), { recursive: true });
    // A principal-hashed filename is not predictable here; write one known name.
    const key = createHash('sha256').update('telegram\u0000formagent\u00005550001').digest('hex').slice(0, 32);
    writeFileSync(join(dir, 'openclaw-pending', `pending-${key}.json`), '{not json');
    expect(store.isCorrupt(PRINCIPAL)).toBe(true);
  });
});
