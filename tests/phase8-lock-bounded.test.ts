/**
 * Phase 8 bounded kernel-lock helper (J-residual A).
 *
 * A deliberately hung helper must not block acquisition past the configured
 * bound; the parent descriptor is released and state is untouched; a later
 * normal acquisition succeeds.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { lockPathFor, PendingStore } from '../src/openclaw/pending.ts';
import { OPERATOR } from './support/phase8.ts';

const PRINCIPAL = { channel: 'telegram' as const, accountId: OPERATOR.accountId, senderId: OPERATOR.senderId };
const PLAN = 'a'.repeat(64);
const SEED = 'b'.repeat(32);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function createPending(store: PendingStore) {
  return store.create({
    principal: PRINCIPAL,
    targetKey: 'fixture:demo-fixture',
    targetArg: 'demo-fixture',
    targetDisplay: 'demo-fixture',
    planId: PLAN,
    seed: SEED,
    operator: `telegram:${OPERATOR.senderId}`,
  });
}

describe('bounded lock helper (A1-A6)', () => {
  it('a hung helper fails acquisition within the bound, releases the FD, and leaves state untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p8-lock-bounded-'));
    dirs.push(dir);

    const store = new PendingStore({ dataDir: dir });
    const created = createPending(store);

    // Deterministic helper that ignores SIGTERM and then hangs. With
    // `killSignal: 'SIGKILL'` the acquisition must still return near the bound.
    const hangingHelper = join(dir, 'hanging-flock.sh');
    writeFileSync(hangingHelper, "#!/bin/sh\ntrap '' TERM\nexec sleep 60\n");
    chmodSync(hangingHelper, 0o755);

    const boundedStore = new PendingStore({ dataDir: dir, flockBinaryPath: hangingHelper, lockTimeoutMs: 300, lockPollMs: 20 });
    const started = Date.now();
    expect(() =>
      boundedStore.claim(PRINCIPAL, {
        pendingRef: created.pendingId,
        planId: created.planId,
        targetKey: created.targetKey,
        targetDisplay: created.targetDisplay,
        expiresAtMs: created.expiresAtMs,
      }, (arg, _key, display) => arg === display),
    ).toThrow();
    const elapsed = Date.now() - started;
    // Materially near the 300 ms bound (not the helper's 60 s sleep), and it
    // actually waited for the bound.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1_500);

    // A3: state unchanged.
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('pending');

    // A4: the parent descriptor was released -> the lock is free.
    const lockFile = lockPathFor(dir, PRINCIPAL);
    expect(spawnSync('/usr/bin/flock', ['-n', lockFile, 'true']).status).toBe(0);

    // A5: a later normal acquisition succeeds.
    const normalStore = new PendingStore({ dataDir: dir });
    const claimed = normalStore.claim(PRINCIPAL, {
      pendingRef: created.pendingId,
      planId: created.planId,
      targetKey: created.targetKey,
      targetDisplay: created.targetDisplay,
      expiresAtMs: created.expiresAtMs,
    }, (arg, _key, display) => arg === display);
    expect(claimed.status).toBe('claimed');
  }, 30_000);
});
