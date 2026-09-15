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
import type { DraftProvider } from '../draft/provider.ts';
import { generateDraft } from '../draft/orchestrate.ts';
import { DraftValidationError } from '../draft/errors.ts';
import { serializeDraftBundle, bundleSha256, parseDraftBundleJson } from '../draft/serialize.ts';
import { provenanceHash, type DraftProviderProvenance } from '../draft/provenance.ts';
import { runConsistencyGate } from '../consistency/gate.ts';
import { buildExecutionPlan, deriveApprovedPlanId } from './plan.ts';
import { ReceiptStore, submissionKeyFor, type ExecutionReceipt, type ReceiptMetadata } from './receipt.ts';
import { ExecutionPlanSnapshotStore } from './snapshot.ts';
import { ExecutionPreSubmitError } from './errors.ts';
import {
  EXECUTION_PRE_SUBMIT_CODES,
  EXECUTION_SNAPSHOT_CODES,
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
  /** Selected DraftProvider (defaults to the deterministic reference). */
  draftProvider?: DraftProvider;
  /** Safe model/provider label for snapshot provenance + operator output. */
  draftProviderModelLabel?: string | null;
  /** Stable secret-free provenance (provider id/version/model/prompt/endpoint). */
  draftProviderProvenance?: DraftProviderProvenance;
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
  /** Safe provider provenance for operator output (no API keys or secrets). */
  provenance: DraftProviderProvenance;
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
  private readonly draftProvider: DraftProvider;
  private readonly draftProviderModelLabel: string | null;
  private readonly draftProviderProvenance: DraftProviderProvenance;
  private readonly nowMs: () => number;
  private readonly evaluatePolicy: (schema: FormSchema, nowMs: number) => RunPolicyDecision;
  private readonly receiptStore: ReceiptStore;
  private readonly rateStore: RateStore;
  private readonly snapshotStore: ExecutionPlanSnapshotStore;
  private readonly policyEngine: ReturnType<typeof buildPolicyEngine>;

  constructor(options: OrchestratorOptions) {
    this.config = options.config;
    this.database = options.database;
    this.sensitiveRules = options.sensitiveRules;
    this.provider = options.provider;
    this.target = options.target;
    this.rawTarget = options.rawTarget;
    this.seed = options.seed;
    this.draftProvider = options.draftProvider ?? new DeterministicReferenceProvider();
    this.draftProviderModelLabel = options.draftProviderModelLabel ?? null;
    this.draftProviderProvenance =
      options.draftProviderProvenance ?? {
        providerId: this.draftProvider.id,
        providerVersion: this.draftProvider.version,
        modelLabel: this.draftProviderModelLabel,
        promptContractVersions: '',
        endpointHash: null,
      };
    this.nowMs = options.nowMs ?? (() => Date.now());

    const engine = buildPolicyEngine(this.config, this.database, this.sensitiveRules);
    this.policyEngine = engine;
    this.evaluatePolicy =
      options.evaluatePolicy ??
      ((schema, nowMs) =>
        engine.evaluateRunPolicy({ target: this.rawTarget, scope: 'run', schema, nowMs }));

    this.receiptStore = new ReceiptStore(this.database);
    this.rateStore = new RateStore(this.database);
    this.snapshotStore = new ExecutionPlanSnapshotStore(this.database);
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

  /**
   * Snapshot -> parse -> draft (selected provider) -> consistency -> policy ->
   * plan. Preflight only: this path MAY invoke a real LLM via the selected
   * DraftProvider.
   */
  private async computePlan(session: ExecutionSession): Promise<ComputedPlan> {
    const snapshot = await session.snapshot();
    const schema = this.parseRuntime(snapshot);
    const bundle = await generateDraft({
      schema,
      seed: this.seed,
      provider: this.draftProvider,
      sensitiveRules: this.sensitiveRules,
    });
    return this.buildPlanFromBundle(schema, bundle);
  }

  /** Consistency + policy + plan from an already-produced bundle. NO LLM call. */
  private async buildPlanFromBundle(schema: FormSchema, bundle: DraftBundle): Promise<ComputedPlan> {
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

  /** Preflight-only: plan, no fill, no submit (P5-R20, P6-R15). */
  async preflight(): Promise<PreflightResult> {
    this.assertAuthorized();
    const session = await this.provider.open(this.target, this.browserOptions());
    try {
      const computed = await this.computePlan(session);
      const accepting = await session.isAcceptingResponses();

      // P6-R15: persist the exact approved DraftBundle BEFORE returning the plan
      // to the operator. This is NOT a submission claim and does not consume the
      // submission key. The bundle is content-bound (SHA-256) and the provider
      // provenance is content-bound (provenance_hash) so submit can detect any
      // tampering of the approved plan before filling.
      const bundleJson = serializeDraftBundle(computed.bundle);
      const bundleDigest = bundleSha256(bundleJson);
      const provenance = this.draftProviderProvenance;
      const provHash = provenanceHash(provenance);

      // Phase 6 approval binding: the operator-visible planId commits to the
      // exact bundle content + provider provenance, so an approved planId can
      // never be reused for different content.
      const boundPlanId = deriveApprovedPlanId(computed.plan.planId, bundleDigest, provHash);
      const plan = { ...computed.plan, planId: boundPlanId };

      this.snapshotStore.save({
        planId: boundPlanId,
        targetKey: this.target.key,
        fingerprint: plan.fingerprint,
        draftId: plan.draftId,
        consistencyReportId: plan.consistencyReportId,
        draftProviderId: provenance.providerId,
        draftProviderVersion: provenance.providerVersion,
        modelOrProviderLabel: provenance.modelLabel,
        promptContractVersions: provenance.promptContractVersions,
        endpointHash: provenance.endpointHash,
        provenanceHash: provHash,
        bundleJson,
        bundleSha256: bundleDigest,
      });

      const key = submissionKeyFor(this.target.key, boundPlanId);
      const receipt = this.receiptStore.recordPreflight(key, this.receiptMetadata(plan));
      return {
        plan,
        accepting,
        receipt,
        bundle: computed.bundle,
        report: computed.report,
        formTitle: computed.schema.title,
        provenance,
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
      const snapshot = await session.snapshot();
      const schema = this.parseRuntime(snapshot);

      // P6-R16: load the exact persisted approved snapshot. NO LLM call occurs
      // on the submit path — the stored bundle is reused verbatim.
      const stored = this.snapshotStore.load(expectPlanId);
      if (stored === null) {
        throw new ExecutionPreSubmitError(
          EXECUTION_SNAPSHOT_CODES.NOT_FOUND,
          'no approved plan snapshot exists for this plan id; run preflight first',
        );
      }

      // P6-R17 (A): verify the bundle content digest BEFORE parsing/filling, so
      // any byte or semantic change to the persisted bundle fails closed.
      if (bundleSha256(stored.bundleJson) !== stored.bundleSha256) {
        throw new ExecutionPreSubmitError(
          EXECUTION_SNAPSHOT_CODES.INVALID,
          'approved plan snapshot bundle integrity digest mismatch',
        );
      }

      // P6-R17 (B): verify the stored provider provenance is self-consistent
      // (content-bound). Any tampering with a provenance column changes the
      // recomputed hash and fails closed.
      const recomputedProvenanceHash = provenanceHash({
        providerId: stored.draftProviderId,
        providerVersion: stored.draftProviderVersion,
        modelLabel: stored.modelOrProviderLabel,
        promptContractVersions: stored.promptContractVersions,
        endpointHash: stored.endpointHash,
      });
      if (recomputedProvenanceHash !== stored.provenanceHash) {
        throw new ExecutionPreSubmitError(
          EXECUTION_SNAPSHOT_CODES.MISMATCH,
          'approved plan snapshot provider provenance is inconsistent',
        );
      }

      // P6-R17: validate identity/integrity before any fill.
      if (stored.planId !== expectPlanId) {
        throw new ExecutionPreSubmitError(
          EXECUTION_SNAPSHOT_CODES.MISMATCH,
          'approved plan snapshot identity does not match the expected plan id',
        );
      }
      if (stored.targetKey !== this.target.key) {
        throw new ExecutionPreSubmitError(
          EXECUTION_SNAPSHOT_CODES.MISMATCH,
          'approved plan snapshot target does not match this run',
        );
      }
      if (stored.fingerprint !== schema.checksum) {
        throw new ExecutionPreSubmitError(
          EXECUTION_SNAPSHOT_CODES.MISMATCH,
          'form structure changed since the plan was approved',
        );
      }

      let bundle: DraftBundle;
      try {
        bundle = parseDraftBundleJson(stored.bundleJson, schema);
      } catch (err) {
        if (err instanceof DraftValidationError) {
          throw new ExecutionPreSubmitError(
            EXECUTION_SNAPSHOT_CODES.INVALID,
            'approved plan snapshot bundle is corrupt',
          );
        }
        throw err;
      }

      if (bundle.draftId !== stored.draftId) {
        throw new ExecutionPreSubmitError(
          EXECUTION_SNAPSHOT_CODES.MISMATCH,
          'approved plan snapshot draft identity does not match the stored provenance',
        );
      }
      // P6-R17 (B): the bundle's own provider identity must match the stored
      // provenance (provider id/version cannot silently diverge).
      if (bundle.providerId !== stored.draftProviderId) {
        throw new ExecutionPreSubmitError(
          EXECUTION_SNAPSHOT_CODES.MISMATCH,
          'approved plan snapshot provider id does not match the stored bundle',
        );
      }
      if (bundle.providerVersion !== stored.draftProviderVersion) {
        throw new ExecutionPreSubmitError(
          EXECUTION_SNAPSHOT_CODES.MISMATCH,
          'approved plan snapshot provider version does not match the stored bundle',
        );
      }
      if (bundle.fingerprint !== schema.checksum) {
        throw new ExecutionPreSubmitError(
          EXECUTION_SNAPSHOT_CODES.MISMATCH,
          'approved plan snapshot bundle fingerprint does not match the runtime form',
        );
      }

      // Re-run deterministic consistency on current schema + stored bundle; the
      // reconstructed plan must reproduce the approved identity exactly.
      const computed = await this.buildPlanFromBundle(schema, bundle);

      // Phase 6 approval binding: recompute the final bound planId from the
      // base plan identity + the STORED content/provenance hashes and require
      // exact equality with --expect-plan BEFORE fill. A valid-to-valid answer/
      // profile/provenance change — even with recomputed stored hashes — changes
      // this binding and can no longer match the old approved planId.
      const boundPlanId = deriveApprovedPlanId(computed.plan.planId, stored.bundleSha256, stored.provenanceHash);
      if (boundPlanId !== expectPlanId) {
        throw new ExecutionPreSubmitError(
          EXECUTION_SNAPSHOT_CODES.MISMATCH,
          'approved plan no longer matches the approved snapshot (approval binding failed)',
        );
      }
      const plan = { ...computed.plan, planId: boundPlanId };

      // P6-R17: require the expected deterministic consistency report identity.
      if (computed.report.reportId !== stored.consistencyReportId) {
        throw new ExecutionPreSubmitError(
          EXECUTION_SNAPSHOT_CODES.MISMATCH,
          'approved plan snapshot consistency report identity changed',
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
