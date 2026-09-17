/**
 * Phase 8 cross-process per-principal lock + ownership (Finding A).
 *
 * These tests spawn REAL separate Node processes. An in-memory mutex cannot
 * satisfy the frozen OpenClaw topology (one adapter subprocess per call), so the
 * atomic claim must be proven across process boundaries.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { lockPathFor, PendingStore, type PendingRecord } from '../src/openclaw/pending.ts';
import { OPERATOR } from './support/phase8.ts';

const WORKER = fileURLToPath(new URL('./support/phase8-pending-worker.ts', import.meta.url));
const PRINCIPAL = { channel: 'telegram' as const, accountId: OPERATOR.accountId, senderId: OPERATOR.senderId };
const PLAN = 'a'.repeat(64);
const SEED = 'b'.repeat(32);
const OPERATOR_STRING = `telegram:${OPERATOR.senderId}`;

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface WorkerResult {
  ok: boolean;
  code?: string;
  pendingId?: string;
  attemptId?: string;
  status?: string | null;
}

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function createPending(store: PendingStore) {
  return store.create({
    principal: PRINCIPAL,
    targetKey: 'fixture:demo-fixture',
    targetArg: 'demo-fixture',
    targetDisplay: 'demo-fixture',
    planId: PLAN,
    seed: SEED,
    operator: OPERATOR_STRING,
  });
}

function expectedOf(record: PendingRecord) {
  return {
    pendingRef: record.pendingId,
    planId: record.planId,
    targetKey: record.targetKey,
    targetDisplay: record.targetDisplay,
    expiresAtMs: record.expiresAtMs,
  };
}

function spawnWorker(mode: string, dataDir: string, payload: Record<string, unknown>) {
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER, mode, dataDir, JSON.stringify(payload)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const done = new Promise<WorkerResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .pop();
      if (line === undefined) {
        reject(new Error(`worker ${mode} produced no result (exit ${code}): ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(line) as WorkerResult);
      } catch {
        reject(new Error(`worker ${mode} produced invalid JSON: ${line}`));
      }
    });
  });
  return { child, done };
}

async function waitForFiles(files: string[], timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!files.every((file) => existsSync(file))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${files.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('cross-process claim race (A1/A2)', () => {
  it('exactly ONE of N racing adapter processes claims, and only one spawn side effect is released', async () => {
    const dir = freshDir('p8-race-claim-');
    const store = new PendingStore({ dataDir: dir });
    const created = createPending(store);
    const expected = expectedOf(created);
    const startFile = join(dir, 'go');
    const sideEffectFile = join(dir, 'spawns.log');
    const readyFiles: string[] = [];

    const workers = Array.from({ length: 5 }, (_, index) => {
      const ready = join(dir, `ready-${index}`);
      readyFiles.push(ready);
      return spawnWorker('claim', dir, {
        principal: PRINCIPAL,
        expected,
        startFile,
        sideEffectFile,
        startReadyFile: ready,
      });
    });

    await waitForFiles(readyFiles);
    writeFileSync(startFile, 'go');

    const results = await Promise.all(workers.map((worker) => worker.done));
    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);

    expect(winners).toHaveLength(1);
    expect(winners[0]?.attemptId).toMatch(/^[0-9a-f]{32}$/);
    expect(losers).toHaveLength(4);
    for (const loser of losers) expect(loser.code).toBe('PENDING_CONSUMED');

    // Exactly one submit spawn/side effect could be released from the race.
    const spawns = readFileSync(sideEffectFile, 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(spawns).toHaveLength(1);

    const final = store.peekRaw(PRINCIPAL);
    expect(final?.status).toBe('claimed');
    expect(final?.attemptId).toBe(winners[0]?.attemptId);
    expect(final?.ownerPid).toBeGreaterThan(0);
  }, 40_000);
});

describe('cross-process create/cancel races (A3/A4)', () => {
  const CREATE_INPUT = {
    principal: PRINCIPAL,
    targetKey: 'fixture:demo-fixture',
    targetArg: 'demo-fixture',
    targetDisplay: 'demo-fixture',
    planId: 'c'.repeat(64),
    seed: 'd'.repeat(32),
    operator: OPERATOR_STRING,
  };

  it('concurrent create/replacement cannot overwrite a live in-flight claim', async () => {
    for (let round = 0; round < 3; round += 1) {
      const dir = freshDir(`p8-race-create-${round}-`);
      const store = new PendingStore({ dataDir: dir });
      const created = createPending(store);
      const claimedFile = join(dir, 'claim-held');
      const releaseFile = join(dir, 'release');

      // A genuinely live owner holds the claim while a replacement is attempted.
      const holder = spawnWorker('claim-hold', dir, {
        principal: PRINCIPAL,
        expected: expectedOf(created),
        claimedFile,
        releaseFile,
      });
      await waitForFiles([claimedFile]);
      const held = JSON.parse(readFileSync(claimedFile, 'utf8')) as { attemptId: string };

      const createReady = join(dir, 'create-ready');
      const startFile = join(dir, 'go');
      const create = spawnWorker('create', dir, {
        principal: PRINCIPAL,
        create: CREATE_INPUT,
        startFile,
        startReadyFile: createReady,
      });
      await waitForFiles([createReady]);
      writeFileSync(startFile, 'go');
      const createResult = await create.done;

      expect(createResult.ok).toBe(false);
      expect(createResult.code).toBe('UNKNOWN_BARRIER');
      const final = store.peekRaw(PRINCIPAL);
      expect(final?.status).toBe('claimed');
      expect(final?.pendingId).toBe(created.pendingId);
      expect(final?.attemptId).toBe(held.attemptId);

      writeFileSync(releaseFile, 'go');
      await holder.done;
    }
  }, 60_000);

  it('concurrent cancel cannot delete a live in-flight claim', async () => {
    for (let round = 0; round < 3; round += 1) {
      const dir = freshDir(`p8-race-cancel-${round}-`);
      const store = new PendingStore({ dataDir: dir });
      const created = createPending(store);
      const claimedFile = join(dir, 'claim-held');
      const releaseFile = join(dir, 'release');

      const holder = spawnWorker('claim-hold', dir, {
        principal: PRINCIPAL,
        expected: expectedOf(created),
        claimedFile,
        releaseFile,
      });
      await waitForFiles([claimedFile]);

      const cancelReady = join(dir, 'cancel-ready');
      const startFile = join(dir, 'go');
      const cancel = spawnWorker('cancel', dir, {
        principal: PRINCIPAL,
        startFile,
        startReadyFile: cancelReady,
      });
      await waitForFiles([cancelReady]);
      writeFileSync(startFile, 'go');
      const cancelResult = await cancel.done;

      expect(cancelResult.ok).toBe(false);
      const final = store.peekRaw(PRINCIPAL);
      expect(final?.status).toBe('claimed');
      expect(final?.pendingId).toBe(created.pendingId);

      writeFileSync(releaseFile, 'go');
      await holder.done;
    }
  }, 60_000);
});

describe('attempt-bound transitions (A5)', () => {
  it('a wrong/stale attemptId cannot complete, consume-unknown, or start-fail the current attempt', () => {
    const dir = freshDir('p8-stale-attempt-');
    const store = new PendingStore({ dataDir: dir });
    const created = createPending(store);
    const claimed = store.claim(PRINCIPAL, expectedOf(created), (arg, _key, display) => arg === display);
    const stale = 'f'.repeat(32);

    store.markStartFailed(PRINCIPAL, claimed.pendingId, stale);
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('claimed');

    store.markConsumedUnknown(PRINCIPAL, claimed.pendingId, stale, 'stale');
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('claimed');

    expect(() =>
      store.markCompletedUnambiguous(PRINCIPAL, claimed.pendingId, stale, {
        category: 'ok_submit_success',
        status: 'ok',
        formAgentExitCode: 0,
        data: {},
        pending: null,
      }),
    ).toThrow();
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('claimed');

    // The exact attempt still transitions legally.
    store.markStartFailed(PRINCIPAL, claimed.pendingId, claimed.attemptId as string);
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('start_failed');
  });
});

describe('cross-process ownership liveness (A6/A7)', () => {
  it('a live owned attempt is not reusable; after the owner exits it recovers to sticky consumed_unknown', async () => {
    const dir = freshDir('p8-live-owner-');
    const store = new PendingStore({ dataDir: dir });
    const created = createPending(store);
    const expected = expectedOf(created);
    const claimedFile = join(dir, 'claimed.json');
    const releaseFile = join(dir, 'release');

    const holder = spawnWorker('claim-hold', dir, {
      principal: PRINCIPAL,
      expected,
      claimedFile,
      releaseFile,
    });
    await waitForFiles([claimedFile]);
    const held = JSON.parse(readFileSync(claimedFile, 'utf8')) as { attemptId: string };

    // A DIFFERENT store instance (fresh adapter view) must see the live-owned
    // attempt as claimed — never reusable and never falsely normalized.
    const observer = new PendingStore({ dataDir: dir });
    expect(observer.read(PRINCIPAL)?.status).toBe('claimed');
    expect(observer.barrier(PRINCIPAL)?.status).toBe('claimed');
    expect(observer.peekRaw(PRINCIPAL)?.attemptId).toBe(held.attemptId);

    // Let the owner exit; the ownerless claim recovers conservatively.
    writeFileSync(releaseFile, 'go');
    await holder.done;
    expect(observer.read(PRINCIPAL)?.status).toBe('consumed_unknown');
    expect(observer.read(PRINCIPAL)?.status).toBe('consumed_unknown');
    expect(observer.barrier(PRINCIPAL)?.status).toBe('consumed_unknown');
    expect(() => createPending(observer)).toThrow();
  }, 40_000);

  it('a crashed ownerless claim becomes a sticky consumed_unknown barrier', async () => {
    const dir = freshDir('p8-crashed-owner-');
    const store = new PendingStore({ dataDir: dir });
    const created = createPending(store);
    const worker = spawnWorker('claim-exit', dir, { principal: PRINCIPAL, expected: expectedOf(created) });
    const claimResult = await worker.done;
    expect(claimResult.ok).toBe(true);

    const observer = new PendingStore({ dataDir: dir });
    expect(observer.read(PRINCIPAL)?.status).toBe('consumed_unknown');
    expect(observer.read(PRINCIPAL)?.status).toBe('consumed_unknown');
    expect(observer.barrier(PRINCIPAL)?.status).toBe('consumed_unknown');
    expect(() => createPending(observer)).toThrow();
  }, 40_000);
});

describe('kernel flock cross-process mutex (Finding H)', () => {
  it('H1: two or more independent processes racing the same pending yield exactly one claim', async () => {
    const dir = freshDir('p8-h1-');
    const store = new PendingStore({ dataDir: dir });
    const created = createPending(store);
    const startFile = join(dir, 'go');
    const sideEffectFile = join(dir, 'spawns.log');
    const readyFiles: string[] = [];

    const workers = Array.from({ length: 4 }, (_, index) => {
      const ready = join(dir, `ready-${index}`);
      readyFiles.push(ready);
      return spawnWorker('claim', dir, {
        principal: PRINCIPAL,
        expected: expectedOf(created),
        startFile,
        sideEffectFile,
        startReadyFile: ready,
      });
    });

    await waitForFiles(readyFiles);
    writeFileSync(startFile, 'go');
    const results = await Promise.all(workers.map((worker) => worker.done));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(readFileSync(sideEffectFile, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  }, 40_000);

  it('H2: a holder excludes a second contender until release', async () => {
    const dir = freshDir('p8-h2-');
    const heldFile = join(dir, 'held');
    const releaseFile = join(dir, 'release');
    const holder = spawnWorker('lock-hold', dir, { principal: PRINCIPAL, claimedFile: heldFile, releaseFile });
    await waitForFiles([heldFile]);

    const timeoutFile = join(dir, 'timeout');
    const waiter = spawnWorker('lock-wait', dir, { principal: PRINCIPAL, lockTimeoutMs: 500, timeoutFile });
    const waiterResult = await waiter.done;
    expect(waiterResult.ok).toBe(false);
    expect(existsSync(timeoutFile)).toBe(true);

    writeFileSync(releaseFile, 'go');
    await holder.done;
    const after = spawnWorker('lock-wait', dir, { principal: PRINCIPAL, lockTimeoutMs: 3_000 });
    expect((await after.done).ok).toBe(true);
  }, 40_000);

  it('H3: abrupt owner death releases the kernel lock with no stale reaping', async () => {
    const dir = freshDir('p8-h3-');
    const heldFile = join(dir, 'held');
    const holder = spawnWorker('lock-hold', dir, {
      principal: PRINCIPAL,
      claimedFile: heldFile,
      releaseFile: join(dir, 'never-released'),
    });
    await waitForFiles([heldFile]);
    holder.child.kill('SIGKILL');
    await holder.done.catch(() => undefined);

    const after = spawnWorker('lock-wait', dir, { principal: PRINCIPAL, lockTimeoutMs: 4_000 });
    expect((await after.done).ok).toBe(true);
  }, 40_000);

  it('H4: after a crashed owner, simultaneous waiters still yield exactly one owner', async () => {
    const dir = freshDir('p8-h4-');
    const crashedHeld = join(dir, 'crashed-held');
    const crashed = spawnWorker('lock-hold', dir, {
      principal: PRINCIPAL,
      claimedFile: crashedHeld,
      releaseFile: join(dir, 'never-released'),
    });
    await waitForFiles([crashedHeld]);
    crashed.child.kill('SIGKILL');
    await crashed.done.catch(() => undefined);

    const releaseFile = join(dir, 'release');
    const heldFiles: string[] = [];
    const workers = Array.from({ length: 4 }, (_, index) => {
      const held = join(dir, `held-${index}`);
      heldFiles.push(held);
      // Each tries to become the (single) owner; losers time out. The winner
      // holds until we publish the shared release file.
      return spawnWorker('lock-hold', dir, {
        principal: PRINCIPAL,
        claimedFile: held,
        releaseFile,
        lockTimeoutMs: 1_500,
      });
    });

    // Wait until exactly one owner is established, then confirm it stays single.
    const deadline = Date.now() + 5_000;
    while (!heldFiles.some((file) => existsSync(file))) {
      if (Date.now() > deadline) throw new Error('no owner acquired the mutex');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(heldFiles.filter((file) => existsSync(file))).toHaveLength(1);

    writeFileSync(releaseFile, 'go');
    const results = await Promise.all(workers.map((worker) => worker.done));
    // After release each waiter may acquire sequentially; the proven invariant
    // is the single-owner check above (only one holder at any instant).
    expect(results.some((result) => result.ok)).toBe(true);
  }, 40_000);

  it('H5: deterministic tie regression — production mutex ignores legacy ctime/token ordering', async () => {
    const dir = freshDir('p8-h5-');
    const lockFile = lockPathFor(dir, PRINCIPAL);
    mkdirSync(dirname(lockFile), { recursive: true });
    // Legacy-style adversarial contenders with an inverted token order and a
    // forced "equal" ordering key. Under the removed `(ctimeNs, token)` rule
    // these could both look eligible; the production mutex must ignore them and
    // rely only on the kernel lock.
    writeFileSync(`${lockFile}.claim-a.json`, JSON.stringify({ pid: process.pid, gen: 1, token: 'aaaa' }));
    writeFileSync(`${lockFile}.claim-z.json`, JSON.stringify({ pid: process.pid, gen: 1, token: 'zzzz' }));

    // Static guard: the timestamp-ordering primitive must not return.
    const source = readFileSync(new URL('../src/openclaw/pending.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('ctimeNs');
    expect(source).not.toMatch(/\.ctime/);

    const heldFile = join(dir, 'held');
    const releaseFile = join(dir, 'release');
    const holder = spawnWorker('lock-hold', dir, { principal: PRINCIPAL, claimedFile: heldFile, releaseFile });
    await waitForFiles([heldFile]);
    const timeoutFile = join(dir, 'timeout');
    const waiter = spawnWorker('lock-wait', dir, { principal: PRINCIPAL, lockTimeoutMs: 400, timeoutFile });
    expect((await waiter.done).ok).toBe(false);
    expect(existsSync(timeoutFile)).toBe(true);
    writeFileSync(releaseFile, 'go');
    await holder.done;
  }, 40_000);

  it('H6/E3: lock setup failure fails closed without entering a critical section', () => {
    const dir = freshDir('p8-h6-');
    const store = new PendingStore({ dataDir: dir });
    const created = createPending(store);

    const brokenStore = new PendingStore({ dataDir: dir, flockBinaryPath: join(dir, 'missing-flock-binary') });
    expect(() =>
      brokenStore.claim(PRINCIPAL, expectedOf(created), (arg, _key, display) => arg === display),
    ).toThrow();
    // No critical section was entered: the record was not mutated.
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('pending');
  });
});

describe('parent-owned kernel lock lifetime (Finding J)', () => {
  function flockProbe(lockFile: string): number | null {
    const result = spawnSync('/usr/bin/flock', ['-n', lockFile, 'true']);
    return result.status;
  }

  it('J1: the parent owns the kernel lock after the acquisition helper exits; a second process is excluded', async () => {
    const dir = freshDir('p8-j1-');
    const lockFile = lockPathFor(dir, PRINCIPAL);
    const heldFile = join(dir, 'held');
    const releaseFile = join(dir, 'release');

    // The acquisition helper has ALREADY exited by the time the worker declares
    // itself "held" (acquireProcessLock uses synchronous spawnSync). The lock is
    // still held only because the worker retains the shared descriptor.
    const holder = spawnWorker('lock-hold', dir, { principal: PRINCIPAL, claimedFile: heldFile, releaseFile });
    await waitForFiles([heldFile]);
    expect(flockProbe(lockFile)).not.toBe(0);

    // A second independent process cannot enter either.
    const timeoutFile = join(dir, 'timeout');
    const waiter = spawnWorker('lock-wait', dir, { principal: PRINCIPAL, lockTimeoutMs: 500, timeoutFile });
    expect((await waiter.done).ok).toBe(false);
    expect(existsSync(timeoutFile)).toBe(true);

    writeFileSync(releaseFile, 'go');
    await holder.done;
    expect(flockProbe(lockFile)).toBe(0);
  }, 40_000);

  it('J3: SIGKILL of the owning process releases the kernel lock', async () => {
    const dir = freshDir('p8-j3-');
    const lockFile = lockPathFor(dir, PRINCIPAL);
    const heldFile = join(dir, 'held');
    const holder = spawnWorker('lock-hold', dir, {
      principal: PRINCIPAL,
      claimedFile: heldFile,
      releaseFile: join(dir, 'never'),
    });
    await waitForFiles([heldFile]);
    expect(flockProbe(lockFile)).not.toBe(0);

    holder.child.kill('SIGKILL');
    await holder.done.catch(() => undefined);
    // Kernel released the lock when the owner's descriptor closed.
    const deadline = Date.now() + 5_000;
    while (flockProbe(lockFile) !== 0) {
      if (Date.now() > deadline) throw new Error('lock not released after owner death');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(flockProbe(lockFile)).toBe(0);
  }, 40_000);

  it('J5: bounded acquisition timeout does not mutate pending state', async () => {
    const dir = freshDir('p8-j5-');
    const store = new PendingStore({ dataDir: dir });
    const created = createPending(store);
    const heldFile = join(dir, 'held');
    const releaseFile = join(dir, 'release');

    const holder = spawnWorker('lock-hold', dir, { principal: PRINCIPAL, claimedFile: heldFile, releaseFile });
    await waitForFiles([heldFile]);

    const blockedStore = new PendingStore({ dataDir: dir, lockTimeoutMs: 300, lockPollMs: 20 });
    expect(() =>
      blockedStore.claim(PRINCIPAL, expectedOf(created), (arg, _key, display) => arg === display),
    ).toThrow();
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('pending');

    writeFileSync(releaseFile, 'go');
    await holder.done;
  }, 40_000);
});
