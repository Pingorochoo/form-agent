/**
 * Phase 8 trusted submit handoff + strict envelope validation (Findings N/Q/C).
 */

import { describe, expect, it } from 'vitest';

import {
  validateAdapterEnvelope,
  PendingClient,
} from '../integrations/openclaw-plugin/pending-client.ts';
import {
  ackSucceeded,
  decideDirectSubmit,
  decideRecoveredHandoff,
  type EnvelopeLike,
  type RecoveryViewLike,
} from '../integrations/openclaw-plugin/submit-handoff.ts';
import {
  validateCompletedResultShape,
  validateCompletedSubmitResult,
} from '../src/openclaw/contracts.ts';
import { exitResult, FakeRunner } from './support/phase8.ts';

const PENDING_REF = 'a'.repeat(32);
const PLAN_ID = 'b'.repeat(64);
const ATTEMPT_ID = 'c'.repeat(32);
const TARGET_DISPLAY = 'demo-fixture';
const OPERATOR = 'telegram:5550001';
const IDENTITY = {
  pendingRef: PENDING_REF,
  planId: PLAN_ID,
  targetDisplay: TARGET_DISPLAY,
  operator: OPERATOR,
};
const RESULT_IDENTITY = {
  pendingId: PENDING_REF,
  planId: PLAN_ID,
  targetDisplay: TARGET_DISPLAY,
  operator: OPERATOR,
  attemptId: ATTEMPT_ID,
};
const PRINCIPAL = { channel: 'telegram' as const, accountId: 'formagent', senderId: '5550001' };
const CLIENT_CONFIG = {
  adapterBinaryPath: '/opt/form-agent/bin/form-agent-openclaw.js',
  adapterConfigPath: '/etc/form-agent/openclaw-adapter.json',
};

function successData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 9,
    planId: PLAN_ID,
    targetDisplay: TARGET_DISPLAY,
    fingerprint: 'f'.repeat(64),
    receiptState: 'success',
    submitAttempted: true,
    outcome: 'success',
    outcomeCode: 'SUBMISSION_CONFIRMED',
    operator: OPERATOR,
    consistencySoftIssues: 0,
    ...overrides,
  };
}

function completedResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: 'ok_submit_success',
    status: 'ok',
    formAgentExitCode: 0,
    pendingId: PENDING_REF,
    attemptId: ATTEMPT_ID,
    planId: PLAN_ID,
    targetDisplay: TARGET_DISPLAY,
    data: successData(),
    pending: null,
    ...overrides,
  };
}

function envelope(overrides: Partial<EnvelopeLike> = {}): EnvelopeLike {
  return {
    category: 'ok_submit_success',
    status: 'ok',
    formAgentExitCode: 0,
    data: successData(),
    ...overrides,
  };
}

function completedRecovery(overrides: Partial<RecoveryViewLike> = {}): RecoveryViewLike {
  return {
    state: 'completed_unambiguous',
    pendingId: PENDING_REF,
    planId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    result: completedResult(),
    ...overrides,
  };
}

describe('direct submit decision table (N1-N7)', () => {
  it('N1: forged success + recovery failure -> unknown_outcome (no ack)', () => {
    expect(decideDirectSubmit(envelope(), undefined, IDENTITY).surface).toBe('unknown_outcome');
  });

  it('N2: forged success + consumed_unknown recovery -> unknown_outcome', () => {
    expect(
      decideDirectSubmit(envelope(), { state: 'consumed_unknown', pendingId: PENDING_REF, planId: PLAN_ID }, IDENTITY)
        .surface,
    ).toBe('unknown_outcome');
  });

  it('N3: forged success + completed recovery with wrong category/identity/attempt -> unknown_outcome', () => {
    expect(
      decideDirectSubmit(envelope(), completedRecovery({ result: completedResult({ category: 'blocked_submit' }) }), IDENTITY).surface,
    ).toBe('unknown_outcome');
    expect(decideDirectSubmit(envelope(), completedRecovery({ pendingId: 'd'.repeat(32) }), IDENTITY).surface).toBe(
      'unknown_outcome',
    );
    expect(decideDirectSubmit(envelope(), completedRecovery({ attemptId: 'e'.repeat(32) }), IDENTITY).surface).toBe(
      'unknown_outcome',
    );
  });

  it('N4: exact success envelope + exact completed handoff -> terminal', () => {
    expect(decideDirectSubmit(envelope(), completedRecovery(), IDENTITY)).toMatchObject({
      surface: 'terminal',
      category: 'ok_submit_success',
      status: 'ok',
      attemptId: ATTEMPT_ID,
      replayed: false,
    });
  });

  it('N5: blocked/usage/already_claimed likewise require the matching completed handoff', () => {
    const cases: Array<{ category: string; status: string; exit: number; code: string }> = [
      { category: 'blocked_submit', status: 'blocked', exit: 3, code: 'EXECUTION_NOT_AUTHORIZED' },
      { category: 'already_claimed', status: 'already_claimed', exit: 3, code: 'SUBMISSION_ALREADY_CLAIMED' },
      { category: 'usage_error', status: 'error', exit: 2, code: 'EXECUTION_TARGET_UNSUPPORTED' },
    ];
    for (const testCase of cases) {
      const data = { errorCode: testCase.code };
      const env = envelope({ category: testCase.category, status: testCase.status, formAgentExitCode: testCase.exit, data });
      const recovery = completedRecovery({
        result: completedResult({
          category: testCase.category,
          status: testCase.status,
          formAgentExitCode: testCase.exit,
          data,
        }),
      });
      expect(decideDirectSubmit(env, recovery, IDENTITY).surface).toBe('terminal');
      expect(decideDirectSubmit(env, undefined, IDENTITY).surface).toBe('unknown_outcome');
      const bad = completedRecovery({
        result: completedResult({
          category: testCase.category,
          status: testCase.status,
          formAgentExitCode: testCase.exit,
          data: { errorCode: 'OTHER_CODE' },
        }),
      });
      expect(decideDirectSubmit(env, bad, IDENTITY).surface).toBe('unknown_outcome');
    }
  });

  it('N6: direct submit_start_failed requires exact start_failed recovery', () => {
    const env = envelope({ category: 'submit_start_failed', status: 'error', formAgentExitCode: null, data: {} });
    expect(decideDirectSubmit(env, { state: 'start_failed', pendingId: PENDING_REF, planId: PLAN_ID }, IDENTITY)).toEqual({
      surface: 'start_failed',
    });
  });

  it('N7: submit_start_failed + recovery mismatch/missing -> unknown_outcome', () => {
    const env = envelope({ category: 'submit_start_failed', status: 'error', formAgentExitCode: null, data: {} });
    expect(decideDirectSubmit(env, undefined, IDENTITY).surface).toBe('unknown_outcome');
    expect(
      decideDirectSubmit(env, { state: 'start_failed', pendingId: 'd'.repeat(32), planId: PLAN_ID }, IDENTITY).surface,
    ).toBe('unknown_outcome');
    expect(
      decideDirectSubmit(env, { state: 'completed_unambiguous', pendingId: PENDING_REF, planId: PLAN_ID }, IDENTITY).surface,
    ).toBe('unknown_outcome');
  });

  it('N14: non-terminal direct categories are unknown_outcome', () => {
    for (const category of ['error', 'no_pending', 'pending_expired', 'unknown_barrier']) {
      expect(
        decideDirectSubmit(envelope({ category, status: 'error', formAgentExitCode: null, data: {} }), completedRecovery(), IDENTITY)
          .surface,
      ).toBe('unknown_outcome');
    }
  });
});

describe('shared completed-result validator (C1-C8)', () => {
  it('C1: completed result missing targetDisplay -> rejected', () => {
    const { targetDisplay: _drop, ...rest } = completedResult();
    expect(validateCompletedResultShape(rest)).toBe(false);
    expect(validateCompletedSubmitResult(rest, RESULT_IDENTITY)).toBe(false);
  });

  it('C2: completed result targetDisplay mismatch -> unknown_outcome', () => {
    const recovery = completedRecovery({ result: completedResult({ targetDisplay: 'other' }) });
    expect(decideDirectSubmit(envelope(), recovery, IDENTITY).surface).toBe('unknown_outcome');
    expect(decideRecoveredHandoff(recovery, IDENTITY).surface).toBe('unknown_outcome');
  });

  it('C3: completed result missing pending -> rejected', () => {
    const { pending: _drop, ...rest } = completedResult();
    expect(validateCompletedResultShape(rest)).toBe(false);
  });

  it('C4: completed result pending != null -> rejected', () => {
    expect(validateCompletedResultShape(completedResult({ pending: {} }))).toBe(false);
  });

  it('C5: extra completed-result key -> rejected', () => {
    expect(validateCompletedResultShape(completedResult({ extra: 1 }))).toBe(false);
  });

  it('C6: wrong/missing attemptId -> rejected', () => {
    expect(validateCompletedSubmitResult(completedResult({ attemptId: 'e'.repeat(32) }), RESULT_IDENTITY)).toBe(false);
    const { attemptId: _drop, ...rest } = completedResult();
    expect(validateCompletedResultShape(rest)).toBe(false);
  });

  it('C7: malformed nested completed result inside submit_status -> rejected', () => {
    const { targetDisplay: _drop, ...broken } = completedResult();
    const env = {
      version: '1.0.0',
      operation: 'submit_status',
      status: 'ok',
      category: 'ok_pending_status',
      formAgentExitCode: null,
      message: 'Pending status read.',
      data: { state: 'completed_unambiguous', result: broken },
      pending: null,
    };
    expect(validateAdapterEnvelope(env, 'submit_status')).toBe(false);
  });

  it('C8: exact nested completed result -> accepted', () => {
    const env = {
      version: '1.0.0',
      operation: 'submit_status',
      status: 'ok',
      category: 'ok_pending_status',
      formAgentExitCode: null,
      message: 'Pending status read.',
      data: { state: 'completed_unambiguous', result: completedResult() },
      pending: null,
    };
    expect(validateAdapterEnvelope(env, 'submit_status')).toBe(true);
  });

  it('C11: direct and durable data differ in one field -> unknown_outcome', () => {
    const durable = completedRecovery({ result: completedResult({ data: successData({ runId: 10 }) }) });
    expect(decideDirectSubmit(envelope({ data: successData({ runId: 9 }) }), durable, IDENTITY).surface).toBe('unknown_outcome');
  });

  it('C12: same wrong targetDisplay/operator in direct + durable is still rejected vs trusted identity', () => {
    const wrong = completedRecovery({
      result: completedResult({ targetDisplay: 'evil', data: successData({ targetDisplay: 'evil', operator: 'telegram:9999999' }) }),
    });
    expect(decideDirectSubmit(envelope({ data: successData({ targetDisplay: 'evil', operator: 'telegram:9999999' }) }), wrong, IDENTITY).surface).toBe(
      'unknown_outcome',
    );
  });
});

describe('recovered handoff decision (N13/C9/C10)', () => {
  it('replays the exact stored result only', () => {
    expect(decideRecoveredHandoff(completedRecovery(), IDENTITY)).toMatchObject({
      surface: 'terminal',
      category: 'ok_submit_success',
      attemptId: ATTEMPT_ID,
      replayed: true,
    });
  });

  it('rejects identity/result mismatches and non-terminal stored categories', () => {
    expect(decideRecoveredHandoff(undefined, IDENTITY).surface).toBe('unknown_outcome');
    expect(decideRecoveredHandoff({ state: 'consumed_unknown' }, IDENTITY).surface).toBe('unknown_outcome');
    expect(decideRecoveredHandoff(completedRecovery({ planId: 'e'.repeat(64) }), IDENTITY).surface).toBe('unknown_outcome');
    expect(
      decideRecoveredHandoff(completedRecovery({ result: completedResult({ category: 'error' }) }), IDENTITY).surface,
    ).toBe('unknown_outcome');
  });

  it('start_failed is replayed only with exact identity', () => {
    expect(decideRecoveredHandoff({ state: 'start_failed', pendingId: PENDING_REF, planId: PLAN_ID }, IDENTITY)).toEqual({
      surface: 'start_failed',
    });
    expect(
      decideRecoveredHandoff({ state: 'start_failed', pendingId: 'd'.repeat(32), planId: PLAN_ID }, IDENTITY).surface,
    ).toBe('unknown_outcome');
  });
});

describe('submit_ack completion (Q10-Q12/E)', () => {
  it('E1: exact {acked:true,idempotent:boolean} -> cleanup success', () => {
    expect(ackSucceeded({ ok: true, envelope: { data: { acked: true, idempotent: false } } })).toBe(true);
    expect(ackSucceeded({ ok: true, envelope: { data: { acked: true, idempotent: true } } })).toBe(true);
  });

  it('E2-E4: acked:false / missing idempotent / extra key -> cleanup failure', () => {
    expect(ackSucceeded({ ok: true, envelope: { data: { acked: false, idempotent: false } } })).toBe(false);
    expect(ackSucceeded({ ok: true, envelope: { data: { acked: true } } })).toBe(false);
    expect(ackSucceeded({ ok: true, envelope: { data: { acked: true, idempotent: true, extra: 1 } } })).toBe(false);
    expect(ackSucceeded(undefined)).toBe(false);
    expect(ackSucceeded({ ok: false })).toBe(false);
  });

  it('E5: proven terminal result is unchanged by ack failure (no retry)', () => {
    expect(decideDirectSubmit(envelope(), completedRecovery(), IDENTITY).surface).toBe('terminal');
    expect(ackSucceeded({ ok: true, envelope: { data: { acked: false, idempotent: false } } })).toBe(false);
  });
});

describe('strict adapter envelope validation (N8-N12)', () => {
  function strictEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: '1.0.0',
      operation: 'submit_pending',
      status: 'ok',
      category: 'ok_submit_success',
      formAgentExitCode: 0,
      message: 'Submission confirmed by Form Agent.',
      data: successData(),
      pending: null,
      ...overrides,
    };
  }

  it('N8: wrong version is rejected', () => {
    expect(validateAdapterEnvelope(strictEnvelope({ version: '9.9.9' }), 'submit_pending')).toBe(false);
  });

  it('N9: wrong operation is rejected', () => {
    expect(validateAdapterEnvelope(strictEnvelope({ operation: 'analyze' }), 'submit_pending')).toBe(false);
  });

  it('N10: category/status mismatch is rejected', () => {
    expect(validateAdapterEnvelope(strictEnvelope({ status: 'blocked' }), 'submit_pending')).toBe(false);
  });

  it('N11: wrong category/exit relation is rejected', () => {
    expect(validateAdapterEnvelope(strictEnvelope({ formAgentExitCode: 3 }), 'submit_pending')).toBe(false);
    expect(
      validateAdapterEnvelope(
        strictEnvelope({ category: 'already_claimed', status: 'already_claimed', formAgentExitCode: 0, data: { errorCode: 'SUBMISSION_ALREADY_CLAIMED' } }),
        'submit_pending',
      ),
    ).toBe(false);
  });

  it('N12: arbitrary object shaped like an envelope is rejected', () => {
    expect(validateAdapterEnvelope({ hello: 'world' }, 'submit_pending')).toBe(false);
    expect(validateAdapterEnvelope(strictEnvelope({ category: 'made_up' }), 'submit_pending')).toBe(false);
    expect(validateAdapterEnvelope(strictEnvelope({ pending: { bogus: true } }), 'submit_pending')).toBe(false);
  });

  it('accepts an exact adapter terminal envelope', () => {
    expect(validateAdapterEnvelope(strictEnvelope(), 'submit_pending')).toBe(true);
  });

  it('shares the strict validator through PendingClient (forged envelope -> malformed)', async () => {
    const runner = new FakeRunner();
    runner.enqueue(exitResult(0, JSON.stringify(strictEnvelope({ operation: 'analyze' }))));
    const client = new PendingClient(CLIENT_CONFIG, runner);
    const result = await client.submitPending(PRINCIPAL, {
      pendingId: PENDING_REF,
      planId: PLAN_ID,
      targetKey: 'fixture:demo-fixture',
      targetDisplay: TARGET_DISPLAY,
      expiresAtMs: Date.now() + 60_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });
});
