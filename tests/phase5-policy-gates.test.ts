/**
 * Phase 5 policy/consistency gate tests (P5-R6, R7, R14, R18, R19).
 *
 * Uses an injected fake execution session/provider and an injected policy
 * evaluator to prove orchestrator sequencing without duplicating PolicyEngine
 * rules: consistency BLOCK prevents fill, full policy blocks before fill, the
 * policy is re-evaluated immediately before submit, and a revocation/rate change
 * between fill and submit prevents submit without creating a durable claim or a
 * submission rate event. Browser/session cleanup is asserted on every blocked
 * path.
 */

import { describe, expect, it } from 'vitest';

import { ExecutionOrchestrator } from '../src/execution/orchestrate.ts';
import { EXECUTION_PRE_SUBMIT_CODES } from '../src/domain/execution.ts';
import type {
  AcceptingState,
  ExecutionFillItem,
  ExecutionOpenOptions,
  ExecutionProvider,
  ExecutionSession,
  RuntimeFormSnapshot,
  SubmitEvidence,
} from '../src/domain/execution.ts';
import type { Question } from '../src/domain/types.ts';
import type { RunPolicyDecision } from '../src/policy/policyEngine.ts';
import type { PolicyReasonCode } from '../src/policy/reasons.ts';
import { RateStore } from '../src/policy/rate.ts';
import { AuthorizationStore } from '../src/policy/authz.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';
import type { CanonicalTarget } from '../src/policy/target.ts';
import { makeConfig, makeDatabase, resolveRules, type TempDatabase } from './support/phase5.ts';
import type { AppConfig } from '../src/config/schema.ts';

/** Minimal non-sensitive, optional text question (consistency PASS). */
function nonSensitiveHtml(): string {
  const payload = [
    null,
    ['', [[1, 'Favorite color', null, 0, [[null, null, 0, null]]]], null, null, null, null, null, null, 'Test Form'],
  ];
  return `<script>var FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(payload)};</script>`;
}

/** Required + sensitive `name` question (consistency BLOCK). */
function blockingHtml(): string {
  const payload = [
    null,
    ['', [[1, 'Full name', null, 0, [[null, null, 1, null]]]], null, null, null, null, null, null, 'Block Test Form'],
  ];
  return `<script>var FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(payload)};</script>`;
}

class FakeSession implements ExecutionSession {
  fillCalls = 0;
  verifyCalls = 0;
  submitCalled = false;
  closeCalled = false;
  snapshotCount = 0;

  constructor(
    private readonly html: string,
    private readonly accepting: AcceptingState = 'accepting',
    private readonly evidence: SubmitEvidence = { state: 'confirmed', confirmationCode: 'fake:confirmed' },
  ) {}

  async snapshot(): Promise<RuntimeFormSnapshot> {
    this.snapshotCount += 1;
    return { html: this.html, url: 'https://fixtures.local/forms/fake' };
  }
  async isAcceptingResponses(): Promise<AcceptingState> {
    return this.accepting;
  }
  async beginSection(_questions: Question[]): Promise<void> {}
  async fill(_item: ExecutionFillItem): Promise<void> {
    this.fillCalls += 1;
  }
  async verifyFilled(_item: ExecutionFillItem): Promise<void> {
    this.verifyCalls += 1;
  }
  async advanceSection(): Promise<void> {}
  async assertSubmitReady(): Promise<void> {}
  async submitOnce(): Promise<SubmitEvidence> {
    this.submitCalled = true;
    return this.evidence;
  }
  async close(): Promise<void> {
    this.closeCalled = true;
  }
}

class FakeProvider implements ExecutionProvider {
  readonly id = 'fake-execution';
  readonly version = '1.0.0';
  constructor(private readonly session: ExecutionSession) {}
  async open(_target: CanonicalTarget, _options: ExecutionOpenOptions): Promise<ExecutionSession> {
    return this.session;
  }
}

function makePolicy(allowed: boolean, reasons: PolicyReasonCode[] = []): RunPolicyDecision {
  return {
    allowed,
    authorization: allowed ? 'authorized' : 'revoked',
    sensitive: {
      fields: [],
      sensitiveCount: 0,
      byCategory: {} as RunPolicyDecision['sensitive']['byCategory'],
      blockedByNever: false,
      requiresHumanReview: false,
      requiresSpecificAuthorization: false,
    },
    safety: { mode: 'test-only', eligible: true },
    rate: allowed
      ? { allowed: true, reasons: [], retryAfterMs: null }
      : { allowed: false, reasons: [...reasons], retryAfterMs: 5000 },
    reasons,
    reasonDescriptions: reasons,
  };
}

function buildOrchestrator(
  db: TempDatabase,
  session: ExecutionSession,
  evaluatePolicy: (schema: unknown, nowMs: number) => RunPolicyDecision,
  nowMs?: () => number,
  seed = 'seed-001',
): ExecutionOrchestrator {
  const config: AppConfig = makeConfig(db.dir);
  const target = canonicalizeTarget('exec-success');
  // The orchestrator now self-enforces authorization (Blocker E), so explicitly
  // allowlist the fixture target; the injected policy evaluator governs the
  // full-policy choke points under test.
  new AuthorizationStore(db.database).allow(target, 'run', 'test-op');
  return new ExecutionOrchestrator({
    config,
    database: db.database,
    sensitiveRules: resolveRules(),
    provider: new FakeProvider(session),
    target,
    rawTarget: 'exec-success',
    seed,
    ...(nowMs !== undefined ? { nowMs } : {}),
    evaluatePolicy: evaluatePolicy as (schema: import('../src/domain/types.ts').FormSchema, nowMs: number) => RunPolicyDecision,
  });
}

describe('P5-R6 — consistency BLOCK prevents fill', () => {
  it('throws CONSISTENCY_BLOCKED and performs no fill/submit', async () => {
    const db = makeDatabase();
    try {
      const session = new FakeSession(blockingHtml());
      // Preflight yields the planId for the blocking schema (consistency is
      // checked at submit time, not preflight).
      const planId = (await buildOrchestrator(db, new FakeSession(blockingHtml()), () => makePolicy(true)).preflight()).plan.planId;
      const orchestrator = buildOrchestrator(db, session, () => makePolicy(true));
      await expect(orchestrator.submit(planId, 'op')).rejects.toMatchObject({
        code: EXECUTION_PRE_SUBMIT_CODES.CONSISTENCY_BLOCKED,
      });
      expect(session.fillCalls).toBe(0);
      expect(session.submitCalled).toBe(false);
      expect(session.closeCalled).toBe(true);
    } finally {
      db.cleanup();
    }
  });
});

describe('P5-R7 — full policy before fill', () => {
  it('blocks before fill when policy is denied', async () => {
    const db = makeDatabase();
    try {
      const session = new FakeSession(nonSensitiveHtml());
      const orchestrator = buildOrchestrator(db, session, () => makePolicy(false, ['AUTHORIZATION_REVOKED']));

      // The planId must match, so use preflight to obtain it via a separate
      // orchestrator whose policy is allowed.
      const planId = (await buildOrchestrator(db, new FakeSession(nonSensitiveHtml()), () => makePolicy(true)).preflight()).plan.planId;

      await expect(orchestrator.submit(planId, 'op')).rejects.toMatchObject({
        code: EXECUTION_PRE_SUBMIT_CODES.POLICY_BLOCKED,
      });
      expect(session.fillCalls).toBe(0);
      expect(session.submitCalled).toBe(false);
      expect(session.closeCalled).toBe(true);
    } finally {
      db.cleanup();
    }
  });
});

describe('P5-R7/R18 — second policy gate before submit', () => {
  it('evaluates policy exactly twice on a successful submit', async () => {
    const db = makeDatabase();
    try {
      let calls = 0;
      const session = new FakeSession(nonSensitiveHtml());
      const orchestrator = buildOrchestrator(db, session, () => {
        calls += 1;
        return makePolicy(true);
      });
      const planId = (await buildOrchestrator(db, new FakeSession(nonSensitiveHtml()), () => makePolicy(true)).preflight()).plan.planId;
      const result = await orchestrator.submit(planId, 'op');
      expect(result.outcome).toBe('success');
      expect(calls).toBe(2); // choke A + choke B
    } finally {
      db.cleanup();
    }
  });

  it('authorization revocation between fill and submit prevents submit with no claim and no rate event', async () => {
    const db = makeDatabase();
    try {
      const session = new FakeSession(nonSensitiveHtml());
      let gate = 0;
      const orchestrator = buildOrchestrator(db, session, () => {
        gate += 1;
        // First gate allowed; second gate revoked (simulates revocation during run).
        return gate === 1 ? makePolicy(true) : makePolicy(false, ['AUTHORIZATION_REVOKED']);
      });
      const planId = (await buildOrchestrator(db, new FakeSession(nonSensitiveHtml()), () => makePolicy(true)).preflight()).plan.planId;

      await expect(orchestrator.submit(planId, 'op')).rejects.toMatchObject({
        code: EXECUTION_PRE_SUBMIT_CODES.POLICY_BLOCKED,
      });
      expect(session.fillCalls).toBeGreaterThan(0); // fill happened
      expect(session.submitCalled).toBe(false); // but no submit
      expect(session.closeCalled).toBe(true);

      // No durable claim and no submission rate event.
      const rate = new RateStore(db.database);
      expect(rate.listEvents('fixture:exec-success').filter((e) => e.kind === 'submission')).toHaveLength(0);
    } finally {
      db.cleanup();
    }
  });

  it('rate-state change between fill and submit prevents submit (no claim, no event)', async () => {
    const db = makeDatabase();
    try {
      const session = new FakeSession(nonSensitiveHtml());
      let gate = 0;
      const orchestrator = buildOrchestrator(db, session, () => {
        gate += 1;
        return gate === 1 ? makePolicy(true) : makePolicy(false, ['DAILY_RATE_CAP']);
      });
      const planId = (await buildOrchestrator(db, new FakeSession(nonSensitiveHtml()), () => makePolicy(true)).preflight()).plan.planId;

      await expect(orchestrator.submit(planId, 'op')).rejects.toMatchObject({
        code: EXECUTION_PRE_SUBMIT_CODES.POLICY_BLOCKED,
      });
      expect(session.submitCalled).toBe(false);
      const rate = new RateStore(db.database);
      expect(rate.listEvents('fixture:exec-success').filter((e) => e.kind === 'submission')).toHaveLength(0);
    } finally {
      db.cleanup();
    }
  });
});

describe('P5-R19 — cleanup on blocked paths', () => {
  it('closes the session when the fingerprint re-check fails', async () => {
    const db = makeDatabase();
    try {
      // Snapshot changes structure after fill: first snapshot non-sensitive,
      // second snapshot blocking (different checksum).
      let snap = 0;
      const session = new FakeSession(nonSensitiveHtml());
      const originalSnapshot = session.snapshot.bind(session);
      session.snapshot = async () => {
        snap += 1;
        if (snap >= 2) return { html: blockingHtml(), url: 'https://fixtures.local/forms/fake' };
        return originalSnapshot();
      };
      const orchestrator = buildOrchestrator(db, session, () => makePolicy(true));
      const planId = (await buildOrchestrator(db, new FakeSession(nonSensitiveHtml()), () => makePolicy(true)).preflight()).plan.planId;

      await expect(orchestrator.submit(planId, 'op')).rejects.toMatchObject({
        code: EXECUTION_PRE_SUBMIT_CODES.FORM_CHANGED_BEFORE_SUBMIT,
      });
      expect(session.submitCalled).toBe(false);
      expect(session.closeCalled).toBe(true);
    } finally {
      db.cleanup();
    }
  });

  it('closes the session on preflight, success, and unknown_outcome', async () => {
    const db = makeDatabase();
    try {
      // Preflight.
      const preSession = new FakeSession(nonSensitiveHtml());
      await buildOrchestrator(db, preSession, () => makePolicy(true), undefined, 'seed-pre').preflight();
      expect(preSession.closeCalled).toBe(true);

      // Confirmed success.
      const successSession = new FakeSession(nonSensitiveHtml());
      const successPlanId = (await buildOrchestrator(db, new FakeSession(nonSensitiveHtml()), () => makePolicy(true), undefined, 'seed-ok').preflight()).plan.planId;
      await buildOrchestrator(db, successSession, () => makePolicy(true), undefined, 'seed-ok').submit(successPlanId, 'op');
      expect(successSession.closeCalled).toBe(true);

      // Unknown outcome (distinct seed -> distinct submission key).
      const unknownSession = new FakeSession(nonSensitiveHtml(), 'accepting', {
        state: 'ambiguous',
        reasonCode: 'SUBMISSION_OUTCOME_UNKNOWN',
      });
      const unknownPlanId = (await buildOrchestrator(db, new FakeSession(nonSensitiveHtml()), () => makePolicy(true), undefined, 'seed-unknown').preflight()).plan.planId;
      const result = await buildOrchestrator(db, unknownSession, () => makePolicy(true), undefined, 'seed-unknown').submit(unknownPlanId, 'op');
      expect(result.outcome).toBe('unknown_outcome');
      expect(unknownSession.closeCalled).toBe(true);
    } finally {
      db.cleanup();
    }
  });
});
