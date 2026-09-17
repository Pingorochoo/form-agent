/**
 * Phase 8 cross-process pending-store worker (Finding A test support).
 *
 * Runs in a SEPARATE OS process so cross-process locking/ownership behavior is
 * exercised for real. Local only; never touches Form Agent or the network.
 */

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

import { recheckThreePartTarget } from '../../src/openclaw/contracts.ts';
import {
  acquireProcessLock,
  lockPathFor,
  PendingStore,
  type PendingRecord,
} from '../../src/openclaw/pending.ts';

interface WorkerPayload {
  principal: { channel: 'telegram'; accountId: string; senderId: string };
  expected?: {
    pendingRef: string;
    planId: string;
    targetKey: string;
    targetDisplay: string;
    expiresAtMs: number;
  };
  create?: {
    principal: { channel: 'telegram'; accountId: string; senderId: string };
    targetKey: string;
    targetArg: string;
    targetDisplay: string;
    planId: string;
    seed: string;
    operator: string;
  };
  startReadyFile?: string;
  startFile?: string;
  claimedFile?: string;
  releaseFile?: string;
  sideEffectFile?: string;
  lockTimeoutMs?: number;
  acquiredFile?: string;
  timeoutFile?: string;
}

const mode = process.argv[2];
const dataDir = process.argv[3] ?? '';
const payload: WorkerPayload = JSON.parse(process.argv[4] ?? '{}');

const store = new PendingStore({ dataDir });

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitFor(file: string | undefined, timeoutMs: number): boolean {
  if (file === undefined) return true;
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) return false;
    sleep(5);
  }
  return true;
}

if (payload.startReadyFile !== undefined) writeFileSync(payload.startReadyFile, 'ready');

function codeOf(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'ERR';
}

try {
  switch (mode) {
    case 'claim': {
      waitFor(payload.startFile, 15_000);
      try {
        const record = store.claim(payload.principal, payload.expected as never, recheckThreePartTarget);
        if (payload.sideEffectFile !== undefined) appendFileSync(payload.sideEffectFile, 'spawn\n');
        emit({ ok: true, pendingId: record.pendingId, attemptId: record.attemptId });
      } catch (err) {
        emit({ ok: false, code: codeOf(err) });
      }
      break;
    }
    case 'create': {
      waitFor(payload.startFile, 15_000);
      try {
        const record = store.create(payload.create as never);
        emit({ ok: true, pendingId: record.pendingId });
      } catch (err) {
        emit({ ok: false, code: codeOf(err) });
      }
      break;
    }
    case 'cancel': {
      waitFor(payload.startFile, 15_000);
      try {
        const result = store.cancel(payload.principal);
        emit({ ok: true, pendingId: result.pendingId });
      } catch (err) {
        emit({ ok: false, code: codeOf(err) });
      }
      break;
    }
    case 'claim-hold': {
      try {
        const record = store.claim(payload.principal, payload.expected as never, recheckThreePartTarget);
        if (payload.claimedFile !== undefined) {
          writeFileSync(payload.claimedFile, JSON.stringify({ pendingId: record.pendingId, attemptId: record.attemptId }));
        }
        waitFor(payload.releaseFile, 15_000);
        emit({ ok: true, released: true });
      } catch (err) {
        emit({ ok: false, code: codeOf(err) });
      }
      break;
    }
    case 'claim-exit': {
      try {
        const record = store.claim(payload.principal, payload.expected as never, recheckThreePartTarget);
        emit({ ok: true, pendingId: record.pendingId, attemptId: record.attemptId });
      } catch (err) {
        emit({ ok: false, code: codeOf(err) });
      }
      break;
    }
    case 'read': {
      try {
        const record: PendingRecord | null = store.read(payload.principal);
        emit({ ok: true, status: record?.status ?? null });
      } catch (err) {
        emit({ ok: false, code: codeOf(err) });
      }
      break;
    }
    case 'lock-hold': {
      const lockFile = lockPathFor(dataDir, payload.principal);
      try {
        const release = acquireProcessLock(lockFile, {
          timeoutMs: payload.lockTimeoutMs ?? 10_000,
          pollMs: 5,
        });
        if (payload.claimedFile !== undefined) writeFileSync(payload.claimedFile, 'held');
        waitFor(payload.releaseFile, 15_000);
        release();
        emit({ ok: true });
      } catch (err) {
        emit({ ok: false, code: codeOf(err) });
      }
      break;
    }
    case 'lock-wait': {
      const lockFile = lockPathFor(dataDir, payload.principal);
      try {
        const release = acquireProcessLock(lockFile, {
          timeoutMs: payload.lockTimeoutMs ?? 600,
          pollMs: 5,
        });
        if (payload.acquiredFile !== undefined) writeFileSync(payload.acquiredFile, 'acquired');
        release();
        emit({ ok: true, acquired: true });
      } catch (err) {
        if (payload.timeoutFile !== undefined) writeFileSync(payload.timeoutFile, 'timeout');
        emit({ ok: false, code: codeOf(err) });
      }
      break;
    }
    default:
      emit({ ok: false, code: 'UNKNOWN_MODE' });
  }
} catch (err) {
  emit({ ok: false, code: 'WORKER_ERROR' });
  process.exitCode = 1;
}
