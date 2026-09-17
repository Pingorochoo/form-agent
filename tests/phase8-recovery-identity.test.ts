/**
 * Phase 8 known-submit recovery identity (Finding F).
 *
 * Recovery of an approved submit is bound to BOTH the approved `pendingRef`
 * and `planId`. A different valid record for the same principal must never be
 * returned or replayed as that submit's result.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  recoveryViewMatchesApproved,
  shouldReplayRecoveredTerminal,
} from '../integrations/openclaw-plugin/recovery-identity.ts';
import { PendingStore } from '../src/openclaw/pending.ts';
import { terminalSuccessData } from './support/phase8.ts';
import { PRINCIPAL } from './support/phase8-preflight.ts';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function freshStore(): PendingStore {
  const dir = mkdtempSync(join(tmpdir(), 'p8-recovery-identity-'));
  dirs.push(dir);
  return new PendingStore({ dataDir: dir });
}

function createPending(store: PendingStore, planId: string) {
  return store.create({
    principal: PRINCIPAL,
    targetKey: 'fixture:demo-fixture',
    targetArg: 'demo-fixture',
    targetDisplay: 'demo-fixture',
    planId,
    seed: 'c'.repeat(32),
    operator: 'telegram:5550001',
  });
}

function completePending(store: PendingStore, planId: string) {
  const created = createPending(store, planId);
  const claimed = store.claim(
    PRINCIPAL,
    {
      pendingRef: created.pendingId,
      planId: created.planId,
      targetKey: created.targetKey,
      targetDisplay: created.targetDisplay,
      expiresAtMs: created.expiresAtMs,
    },
    (arg, _key, display) => arg === display,
  );
  store.markCompletedUnambiguous(PRINCIPAL, claimed.pendingId, claimed.attemptId as string, {
    category: 'ok_submit_success',
    status: 'ok',
    formAgentExitCode: 0,
    data: terminalSuccessData(planId),
    pending: null,
  });
  return { created, claimed };
}

describe('store-level recovery identity binding', () => {
  it('F1: recovery for ref A seeing a different valid pending B creates a sticky barrier, never a replay', () => {
    const store = freshStore();
    const a = createPending(store, 'a'.repeat(64));
    const b = createPending(store, 'b'.repeat(64));
    expect(b.pendingId).not.toBe(a.pendingId);

    const view = store.submitStatus(PRINCIPAL, {
      pendingRef: a.pendingId,
      planId: a.planId,
      recoverKnownApproved: true,
    });
    expect(view.state).toBe('consumed_unknown');
    expect(view.reason).toBe('recovery_identity_mismatch');
    expect(view.result).toBeUndefined();
    // The mismatched pending B was not made reusable.
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('consumed_unknown');
    expect(store.barrier(PRINCIPAL)?.status).toBe('consumed_unknown');
    expect(() => createPending(store, 'd'.repeat(64))).toThrow();
  });

  it('F2: same pendingRef but a different valid planId creates a sticky barrier', () => {
    const store = freshStore();
    const a = createPending(store, 'a'.repeat(64));
    const view = store.submitStatus(PRINCIPAL, {
      pendingRef: a.pendingId,
      planId: 'b'.repeat(64),
      recoverKnownApproved: true,
    });
    expect(view.state).toBe('consumed_unknown');
    expect(view.reason).toBe('recovery_identity_mismatch');
    expect(view.result).toBeUndefined();
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('consumed_unknown');
  });

  it('F3: a mismatched completed_unambiguous record is never surfaced as the approved result', () => {
    const store = freshStore();
    const b = completePending(store, 'b'.repeat(64));
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('completed_unambiguous');

    const view = store.submitStatus(PRINCIPAL, {
      pendingRef: 'f'.repeat(32),
      planId: 'e'.repeat(64),
      recoverKnownApproved: true,
    });
    expect(view.state).toBe('consumed_unknown');
    expect(view.reason).toBe('recovery_identity_mismatch');
    expect(view.result).toBeUndefined();
    // The existing terminal barrier is preserved (not overwritten), so it is
    // still not reusable for a new preflight.
    expect(store.peekRaw(PRINCIPAL)?.status).toBe('completed_unambiguous');
    expect(store.peekRaw(PRINCIPAL)?.pendingId).toBe(b.created.pendingId);
    expect(store.barrier(PRINCIPAL)?.status).toBe('completed_unambiguous');
  });

  it('F4: the exact approved pendingRef + planId completed handoff still replays', () => {
    const store = freshStore();
    const a = completePending(store, 'a'.repeat(64));
    const view = store.submitStatus(PRINCIPAL, {
      pendingRef: a.created.pendingId,
      planId: a.created.planId,
      recoverKnownApproved: true,
    });
    expect(view.state).toBe('completed_unambiguous');
    expect(view.result?.category).toBe('ok_submit_success');
    expect(view.result?.pendingId).toBe(a.created.pendingId);
    expect(view.result?.planId).toBe(a.created.planId);
  });

  it('F5: the exact handoff still acks idempotently', () => {
    const store = freshStore();
    const a = completePending(store, 'a'.repeat(64));
    const view = store.submitStatus(PRINCIPAL, {
      pendingRef: a.created.pendingId,
      planId: a.created.planId,
      recoverKnownApproved: true,
    });
    const attemptId = view.attemptId as string;
    expect(attemptId).toMatch(/^[0-9a-f]{32}$/);
    expect(store.acknowledge(PRINCIPAL, a.created.pendingId, attemptId)).toEqual({
      acked: true,
      idempotent: false,
    });
    expect(store.acknowledge(PRINCIPAL, a.created.pendingId, attemptId)).toEqual({
      acked: false,
      idempotent: true,
    });
  });
});

describe('plugin-level recovery identity guard (F6)', () => {
  const expected = { pendingRef: 'a'.repeat(32), planId: 'b'.repeat(64) };

  function exactView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      state: 'completed_unambiguous',
      pendingId: expected.pendingRef,
      planId: expected.planId,
      attemptId: 'c'.repeat(32),
      result: {
        pendingId: expected.pendingRef,
        planId: expected.planId,
        category: 'ok_submit_success',
        status: 'ok',
        formAgentExitCode: 0,
      },
      ...overrides,
    };
  }

  it('accepts only an exact identity + bound result', () => {
    expect(recoveryViewMatchesApproved(exactView(), expected)).toBe(true);
    expect(shouldReplayRecoveredTerminal(exactView(), expected)).toBe(true);
  });

  it('rejects adversarial / mismatched recovery views', () => {
    expect(shouldReplayRecoveredTerminal(exactView({ pendingId: 'd'.repeat(32) }), expected)).toBe(false);
    expect(shouldReplayRecoveredTerminal(exactView({ planId: 'e'.repeat(64) }), expected)).toBe(false);
    expect(
      shouldReplayRecoveredTerminal(
        exactView({ result: { pendingId: 'd'.repeat(32), planId: expected.planId, category: 'ok_submit_success' } }),
        expected,
      ),
    ).toBe(false);
    expect(
      shouldReplayRecoveredTerminal(exactView({ result: { pendingId: expected.pendingRef, planId: 'e'.repeat(64) } }), expected),
    ).toBe(false);
    expect(shouldReplayRecoveredTerminal(exactView({ result: undefined }), expected)).toBe(false);
    expect(shouldReplayRecoveredTerminal(exactView({ state: 'pending' }), expected)).toBe(false);
    expect(shouldReplayRecoveredTerminal(exactView({ state: 'claimed' }), expected)).toBe(false);
    expect(shouldReplayRecoveredTerminal(undefined, expected)).toBe(false);
    expect(recoveryViewMatchesApproved(exactView({ pendingId: 'd'.repeat(32) }), expected)).toBe(false);
  });
});
