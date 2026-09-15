/**
 * Execution orchestrator (P5-R6, R7, R8, R9, R12, R13, R14, R15, R16, R18).
 *
 * Owns sequencing, policy/consistency gates, durable run state, and retry/abort
 * semantics. It reuses the accepted Phase 1 parser, Phase 3 draft pipeline,
 * Phase 4 consistency gate, and Phase 2 PolicyEngine — never duplicating their
 * decision logic.
 *
 * Invariants enforced here:
 *   - consistency BLOCK prevents fill/submit (R6);
 *   - full policy is evaluated before fill and again before submit (R7);
 *   - submit mode recomputes the plan and requires exact planId equality (R8);
 *   - only `answered` draft entries are filled (R9);
 *   - accepting state is checked before fill and at final pre-submit (R13);
 *   - runtime fingerprint is re-checked before submit; mismatch aborts (R14);
 *   - durable submit claim precedes the single submit attempt (R16/R17);
 *   - a conservative submission rate event is recorded at claim (R18).
 */

import type { AppConfig } from '../config/schema.ts';
import type { FormAgentDatabase } from '../db/database.ts';
import type { FormSchema, Question } from '../domain/types.ts';
import type { DraftBundle } from '../domain/draft.ts';
import type { ConsistencyReport } from '../domain/consistency.ts';
import type { SensitiveRule } from '../policy/sensitive.ts';
import {
  buildPolicyEngine,
  type RunAuthorizationDecision,
  type RunPolicyDecision,
} from '../policy/policyEngine.ts';
import { RateStore } from '../policy/rate.ts';
import { parseGoogleFormsHtml } from '../parser/google-forms.ts';
import { DeterministicReferenceProvider } from '../draft/reference.ts';
import { generateDraft } from '../draft/orchestrate.ts';
import { runConsistencyGate } from '../consistency/gate.ts';
import { buildExecutionPlan } from './plan.ts';
import { ReceiptStore, submissionKeyFor, type ExecutionReceipt, type ReceiptMetadata } from './receipt.ts';
import { ExecutionPreSubmitError } from './errors.ts';
import {
  EXECUTION_PRE_SUBMIT_CODES,
  EXECUTION_TERMINAL_CODES,
  sequentialSections,
  type AcceptingState,
  type ExecutionFillItem,
  type ExecutionOpenOptions,
  type ExecutionOutcome,
  type ExecutionPlan,
  type ExecutionProvider,
  type ExecutionSession,
  type SubmitEvidence,
} from '../domain/execution.ts';
import type { CanonicalTarget } from '../policy/target.ts';

export interface OrchestratorOptions {
  config: AppConfig;
  database: FormAgentDatabase;
  sensitiveRules: SensitiveRule[];
  provider: ExecutionProvider;
  target: CanonicalTarget;
  /** Raw target string (pre-canonicalization) for the policy engine. */
  rawTarget: string;
  seed: string;
  /** Injected clock for deterministic rate evaluation. */
  nowMs?: () => number;
  /** Injected policy evaluator (test seam; defaults to the real engine). */
  evaluatePolicy?: (schema: FormSchema, nowMs: number) => RunPolicyDecision;
}

export interface ComputedPlan {
  plan: ExecutionPlan;
  schema: FormSchema;
  bundle: DraftBundle;
  report: ConsistencyReport;
  policy: RunPolicyDecision;
}

export interface PreflightResult {
  plan: ExecutionPlan;
  accepting: AcceptingState;
  receipt: ExecutionReceipt;
  bundle: DraftBundle;
  report: ConsistencyReport;
  formTitle: string;
}

export interface SubmitResult {
  plan: ExecutionPlan;
  outcome: ExecutionOutcome;
  evidence: SubmitEvidence | null;
  receipt: ExecutionReceipt;
}

export class ExecutionOrchestrator {
  private readonly config: AppConfig;
  private readonly database: FormAgentDatabase;
  private readonly sensitiveRules: SensitiveRule[];
  private readonly provider: ExecutionProvider;
  private readonly target: CanonicalTarget;
  private readonly rawTarget: string;
  private readonly seed: string;
  private readonly nowMs: () => number;
  private readonly evaluatePolicy: (schema: FormSchema, nowMs: number) => RunPolicyDecision;
  private readonly receiptStore: ReceiptStore;
  private readonly rateStore: RateStore;
  private readonly policyEngine: ReturnType<typeof buildPolicyEngine>;

  constructor(options: OrchestratorOptions) {
    this.config = options.config;
    this.database = options.database;
    this.sensitiveRules = options.sensitiveRules;
    this.provider = options.provider;
    this.target = options.target;
    this.rawTarget = options.rawTarget;
    this.seed = options.seed;
    this.nowMs = options.nowMs ?? (() => Date.now());

    const engine = buildPolicyEngine(this.config, this.database, this.sensitiveRules);
    this.policyEngine = engine;
    this.evaluatePolicy =
      options.evaluatePolicy ??
      ((schema, nowMs) =>
        engine.evaluateRunPolicy({ target: this.rawTarget, scope: 'run', schema, nowMs }));

    this.receiptStore = new ReceiptStore(this.database);
    this.rateStore = new RateStore(this.database);
  }

  /**
   * Authorization-only pre-network gate (P5-R3). Performs no execution. Exposed
   * for the CLI's fast outer guard, and also enforced internally by
   * `assertAuthorized()` at the start of `preflight()`/`submit()`.
   */
  checkAuthorization(): RunAuthorizationDecision {
    return this.policyEngine.evaluateRunAuthorization(this.rawTarget, 'run');
  }

  /**
   * Self-enforcing authorization gate (P5-R3/E). Called at the very beginning of
   * `preflight()` and `submit()` before any provider/browser/network activity, so
   * a caller can never open an unauthorized target even if it forgets the outer
   * CLI guard.
   */
  private assertAuthorized(): void {
    const auth = this.checkAuthorization();
    if (!auth.allowed) {
      throw new ExecutionPreSubmitError(
        EXECUTION_PRE_SUBMIT_CODES.NOT_AUTHORIZED,
        `run not authorized for target (${auth.reasons.join(', ') || 'not-allowlisted'})`,
      );
    }
  }

  private browserOptions(): ExecutionOpenOptions {
    const executablePath = this.config.browser.executablePath;
    return {
      headless: this.config.browser.headless,
      navigationTimeoutMs: this.config.browser.navigationTimeoutMs,
      actionTimeoutMs: this.config.browser.actionTimeoutMs,
      ...(executablePath !== '' ? { executablePath } : {}),
    };
  }

  private receiptMetadata(plan: ExecutionPlan): ReceiptMetadata {
    return {
      targetKey: this.target.key,
      targetDisplay: this.target.display,
      planId: plan.planId,
      draftId: plan.draftId,
      consistencyReportId: plan.consistencyReportId,
      fingerprint: plan.fingerprint,
      providerId: plan.providerId,
      providerVersion: plan.providerVersion,
    };
  }

  private parseRuntime(snapshot: { html: string; url: string }): FormSchema {
    try {
      return parseGoogleFormsHtml(snapshot.html, { url: snapshot.url });
    } catch {
      throw new ExecutionPreSubmitError(
        EXECUTION_PRE_SUBMIT_CODES.RUNTIME_SCHEMA_PARSE_FAILED,
        'runtime structure could not be parsed safely',
      );
    }
  }

  /** Snapshot -> parse -> draft -> consistency -> policy -> plan. */
  private async computePlan(session: ExecutionSession): Promise<ComputedPlan> {
    const snapshot = await session.snapshot();
    const schema = this.parseRuntime(snapshot);
    const bundle = await generateDraft({
      schema,
      seed: this.seed,
      provider: new DeterministicReferenceProvider(),
      sensitiveRules: this.sensitiveRules,
    });
    const report = await runConsistencyGate({ schema, bundle });
    const policy = this.evaluatePolicy(schema, this.nowMs());
    const plan = buildExecutionPlan({
      target: this.target,
      schema,
      bundle,
      report,
      providerId: this.provider.id,
      providerVersion: this.provider.version,
      policyAllowed: policy.allowed,
      policyReasons: policy.reasons,
    });
    return { plan, schema, bundle, report, policy };
  }

  private assertPolicyAllowed(decision: RunPolicyDecision): void {
    if (!decision.allowed) {
      throw new ExecutionPreSubmitError(
        EXECUTION_PRE_SUBMIT_CODES.POLICY_BLOCKED,
        `execution policy blocked (${decision.reasons.join(', ') || 'no reason'})`,
        decision.rate?.retryAfterMs ?? null,
      );
    }
  }

  private async assertAccepting(session: ExecutionSession): Promise<void> {
    const accepting = await session.isAcceptingResponses();
    if (accepting !== 'accepting') {
      throw new ExecutionPreSubmitError(
        EXECUTION_PRE_SUBMIT_CODES.FORM_NOT_ACCEPTING,
        `form is not accepting responses (state: ${accepting})`,
      );
    }
  }

  private async fillAcceptedFields(
    session: ExecutionSession,
    schema: FormSchema,
    bundle: DraftBundle,
  ): Promise<void> {
    const resultsById = new Map(bundle.results.map((result) => [result.questionId, result]));
    const sections = sequentialSections(schema);

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (section === undefined) continue;
      const questions = section.questionIds
        .map((id) => schema.questions[id])
        .filter((question): question is Question => question !== undefined);

      await session.beginSection(questions);

      const items: ExecutionFillItem[] = [];
      for (const question of questions) {
        const result = resultsById.get(question.id);
        // Only `answered` entries are ever filled (P5-R9).
        if (result !== undefined && result.state.state === 'answered') {
          items.push({ question, value: result.state.value });
        }
      }

      for (const item of items) await session.fill(item);
      for (const item of items) await session.verifyFilled(item);

      if (i < sections.length - 1) await session.advanceSection();
    }
  }

  private async reacquireSchema(session: ExecutionSession): Promise<FormSchema> {
    const snapshot = await session.snapshot();
    return this.parseRuntime(snapshot);
  }

  /** Preflight-only: plan, no fill, no submit (P5-R20). */
  async preflight(): Promise<PreflightResult> {
    this.assertAuthorized();
    const session = await this.provider.open(this.target, this.browserOptions());
    try {
      const computed = await this.computePlan(session);
      const accepting = await session.isAcceptingResponses();
      const key = submissionKeyFor(this.target.key, computed.plan.planId);
      const receipt = this.receiptStore.recordPreflight(key, this.receiptMetadata(computed.plan));
      return {
        plan: computed.plan,
        accepting,
        receipt,
        bundle: computed.bundle,
        report: computed.report,
        formTitle: computed.schema.title,
      };
    } finally {
      await session.close();
    }
  }

  /** Full submit flow. Throws controlled errors before any claim. */
  async submit(expectPlanId: string, operator: string): Promise<SubmitResult> {
    this.assertAuthorized();
    const session = await this.provider.open(this.target, this.browserOptions());
    try {
      const computed = await this.computePlan(session);
      const plan = computed.plan;

      // P5-R8: recompute the plan and require exact planId equality before fill.
      if (plan.planId !== expectPlanId) {
        const key = submissionKeyFor(this.target.key, plan.planId);
        this.receiptStore.recordPreSubmitFailure(key, this.receiptMetadata(plan), 'aborted', EXECUTION_PRE_SUBMIT_CODES.PLAN_MISMATCH);
        throw new ExecutionPreSubmitError(
          EXECUTION_PRE_SUBMIT_CODES.PLAN_MISMATCH,
          'current plan does not match the approved plan id',
        );
      }

      // P5-R6: consistency BLOCK prevents fill/submit.
      if (computed.report.blocking) {
        const key = submissionKeyFor(this.target.key, plan.planId);
        this.receiptStore.recordPreSubmitFailure(key, this.receiptMetadata(plan), 'failed_pre_submit', EXECUTION_PRE_SUBMIT_CODES.CONSISTENCY_BLOCKED);
        throw new ExecutionPreSubmitError(
          EXECUTION_PRE_SUBMIT_CODES.CONSISTENCY_BLOCKED,
          'consistency gate blocked execution',
        );
      }

      // P5-R13: accepting gate before fill.
      await this.assertAccepting(session);

      // P5-R7 choke point A: full policy before fill.
      this.assertPolicyAllowed(computed.policy);

      // P5-R9/R12: fill + verify, sequential sections.
      await this.fillAcceptedFields(session, computed.schema, computed.bundle);

      // P5-R14: runtime fingerprint re-check before submit.
      const currentSchema = await this.reacquireSchema(session);
      if (currentSchema.checksum !== plan.fingerprint) {
        const key = submissionKeyFor(this.target.key, plan.planId);
        this.receiptStore.recordPreSubmitFailure(key, this.receiptMetadata(plan), 'failed_pre_submit', EXECUTION_PRE_SUBMIT_CODES.FORM_CHANGED_BEFORE_SUBMIT);
        throw new ExecutionPreSubmitError(
          EXECUTION_PRE_SUBMIT_CODES.FORM_CHANGED_BEFORE_SUBMIT,
          'form structure changed after the approved plan was produced',
        );
      }

      // P5-R13: accepting state again at the final pre-submit stage.
      await this.assertAccepting(session);

      // P5-R16/D: validate final submit readiness BEFORE the durable claim, so a
      // missing/ambiguous submit control stays a pre-submit failure that never
      // consumes the submission key.
      await session.assertSubmitReady();

      // P5-R7 choke point B: full policy again immediately before submit (as
      // close as practical to the claim).
      this.assertPolicyAllowed(this.evaluatePolicy(currentSchema, this.nowMs()));

      // P5-R16/R17: durable submit claim + conservative rate event, then ONE
      // submit attempt.
      const submissionKey = submissionKeyFor(this.target.key, plan.planId);
      const claimed = this.receiptStore.claimSubmission(submissionKey, {
        ...this.receiptMetadata(plan),
        operator,
        approvalAt: new Date().toISOString(),
        onClaimed: () => this.rateStore.recordSubmission(this.target.key, this.nowMs()),
      });

      let evidence: SubmitEvidence;
      try {
        evidence = await session.submitOnce();
      } catch {
        // Submit action started (claim durable); no positive confirmation.
        evidence = { state: 'ambiguous', reasonCode: 'SUBMISSION_OUTCOME_UNKNOWN' };
      }

      if (evidence.state === 'confirmed') {
        const receipt = this.receiptStore.resolveOutcome(claimed.id, {
          state: 'success',
          outcome: 'success',
          outcomeCode: EXECUTION_TERMINAL_CODES.SUBMISSION_CONFIRMED,
        });
        return { plan, outcome: 'success', evidence, receipt: receipt ?? claimed };
      }

      const receipt = this.receiptStore.resolveOutcome(claimed.id, {
        state: 'unknown_outcome',
        outcome: 'unknown_outcome',
        outcomeCode: EXECUTION_TERMINAL_CODES.SUBMISSION_OUTCOME_UNKNOWN,
      });
      return { plan, outcome: 'unknown_outcome', evidence, receipt: receipt ?? claimed };
    } finally {
      await session.close();
    }
  }
}
