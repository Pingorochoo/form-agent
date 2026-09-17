/**
 * Phase 8 adapter orchestration (P8-R2..P8-R14).
 *
 * The adapter is the ONLY state owner for pending orchestration. It:
 *   - re-validates the trusted principal against the single configured operator;
 *   - builds argv ARRAYS and invokes the accepted Form Agent CLI through the
 *     narrow runner seam;
 *   - maps accepted Form Agent exit codes + machine documents onto the frozen
 *     category→status vocabulary;
 *   - owns the race-safe claim/start lifecycle and the crash-safe terminal
 *     handoff;
 *   - NEVER reads Form Agent receipts/policy/rate/snapshot state directly.
 *
 * Form Agent remains the sole authority for every safety-critical decision.
 */

import {
  ALREADY_CLAIMED_CODE,
  buildAnalyzeArgv,
  buildCheckArgv,
  buildDraftArgv,
  buildMetricsArgv,
  buildPreflightArgv,
  buildSubmitArgv,
  generateSeed,
  isResolution,
  matchOperatorPrincipal,
  recheckThreePartTarget,
  validateDraftProvider,
  validatePendingRef,
  validatePlanId,
  validatePrincipalInput,
  validateTargetCommand,
  validateTerminalData,
  validateTimestampBound,
  type AdapterConfig,
  type AdapterEnvelope,
  type AdapterOperation,
  type AnyCategory,
  type PendingSummary,
  type Principal,
  type PrincipalInput,
  type TargetSupport,
  type ValidatedTargetCommand,
} from './contracts.ts';
import { categoryMessage } from './format.ts';
import {
  BarrierPersistenceError,
  PendingError,
  PendingStore,
  type CompletedResult,
  type PendingRecord,
  type RecoveryView,
} from './pending.ts';
import { reconcileUnknown } from './reconcile.ts';
import { buildChildEnv, type RunResult, type SpawnInfo, type SubprocessRunner } from './runner.ts';

export interface AdapterOperationInput {
  operation: AdapterOperation;
  target?: string;
  draftProvider?: string;
  reviewAnswers?: boolean;
  since?: string;
  until?: string;
  pendingRef?: string;
  planId?: string;
  attempt?: string;
  targetKey?: string;
  targetDisplay?: string;
  expiresAtMs?: number;
  resolution?: string;
  conversationId?: string;
}

export interface AdapterDeps {
  config: AdapterConfig;
  runner: SubprocessRunner;
  store: PendingStore;
  clock?: () => number;
}

type EnvelopeResult = AdapterEnvelope;

function env(operation: string, category: AnyCategory, data?: Record<string, unknown>, formAgentExitCode?: number | null): AdapterEnvelope {
  return {
    version: '1.0.0',
    operation,
    status: statusOf(category),
    category,
    formAgentExitCode: formAgentExitCode ?? null,
    message: categoryMessage(category),
    data: data ?? {},
    pending: null,
  };
}

const STATUS_BY_CATEGORY: Readonly<Record<string, AdapterEnvelope['status']>> = {
  ok_analyze: 'ok',
  ok_draft: 'ok',
  ok_check: 'ok',
  needs_confirmation: 'needs_confirmation',
  blocked_check: 'blocked',
  blocked_preflight: 'blocked',
  ok_submit_success: 'ok',
  blocked_submit: 'blocked',
  already_claimed: 'already_claimed',
  submit_start_failed: 'error',
  unknown_outcome: 'unknown_outcome',
  ok_metrics: 'ok',
  ok_cancelled: 'ok',
  ok_pending_status: 'ok',
  ok_reconciled: 'ok',
  no_pending: 'blocked',
  pending_expired: 'blocked',
  pending_replaced: 'blocked',
  pending_consumed: 'blocked',
  unknown_barrier: 'blocked',
  usage_error: 'error',
  unauthorized: 'blocked',
  llm_offline: 'blocked',
  llm_connectivity: 'blocked',
  timeout: 'error',
  error: 'error',
};

function statusOf(category: AnyCategory): AdapterEnvelope['status'] {
  return STATUS_BY_CATEGORY[category] ?? 'error';
}

/**
 * Parse EXACTLY ONE complete machine JSON document from a bounded stream.
 *
 * `JSON.parse` over the whole trimmed text rejects trailing junk, multiple
 * concatenated documents, and truncated output. There is deliberately NO
 * first-line rescue: any trailing/multiple output is malformed, never proof.
 */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Strict accepted `run --json-error` proof for a STARTED submit child.
 *
 * Requires the exact submit-mode machine document with a non-empty bounded
 * control-safe `error.code`, an accepted `error.kind`, and the exact
 * exit-code/kind relation. A preflight-mode document NEVER proves a started
 * submit outcome; stderr is never consulted.
 */
const SUBMIT_ERROR_KINDS: ReadonlySet<string> = new Set(['usage', 'block', 'error']);
const SUBMIT_ERROR_CODE_MAX = 128;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
/** The exact accepted `run --json-error` document key sets (no extras). */
const SUBMIT_ERROR_DOC_KEYS: ReadonlySet<string> = new Set(['command', 'mode', 'ok', 'error']);
const SUBMIT_ERROR_INNER_KEYS: ReadonlySet<string> = new Set(['code', 'kind']);

function hasExactKeys(record: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(record);
  if (actual.length !== keys.size) return false;
  return actual.every((key) => keys.has(key));
}

function runErrorDocOf(doc: unknown, exitCode: number): { code: string; kind: string } | null {
  if (!isRecord(doc)) return null;
  if (!hasExactKeys(doc, SUBMIT_ERROR_DOC_KEYS)) return null;
  if (doc['command'] !== 'run') return null;
  if (doc['mode'] !== 'submit') return null;
  if (doc['ok'] !== false) return null;
  const error = doc['error'];
  if (!isRecord(error)) return null;
  if (!hasExactKeys(error, SUBMIT_ERROR_INNER_KEYS)) return null;
  const code = error['code'];
  const kind = error['kind'];
  if (
    typeof code !== 'string' ||
    code === '' ||
    code.length > SUBMIT_ERROR_CODE_MAX ||
    CONTROL_CHARS.test(code)
  ) {
    return null;
  }
  if (typeof kind !== 'string' || !SUBMIT_ERROR_KINDS.has(kind)) return null;
  // Exact relation required for an unambiguous submit terminal classification.
  if (exitCode === 2 && kind !== 'usage') return null;
  if (exitCode === 3 && kind !== 'block') return null;
  return { code, kind };
}

function exitCodeOf(result: RunResult): number | null {
  if (result.kind === 'exit') return result.code;
  return null;
}

function rootCategoryForExit(operation: AdapterOperation, result: RunResult): AnyCategory {
  if (result.kind === 'spawn_failed') return 'error';
  if (result.kind === 'timeout') return 'timeout';
  if (result.kind === 'output_cap') return 'error';
  const code = result.kind === 'exit' ? result.code : null;
  switch (code) {
    case 2:
      return 'usage_error';
    case 4:
      return 'llm_offline';
    case 5:
      return 'llm_connectivity';
    case 3:
      if (operation === 'check') return 'blocked_check';
      if (operation === 'preflight') return 'blocked_preflight';
      return 'error';
    default:
      return 'error';
  }
}

export class FormAgentAdapter {
  private readonly config: AdapterConfig;
  private readonly runner: SubprocessRunner;
  private readonly store: PendingStore;
  /** Fail-closed session flag after a durable-barrier persistence failure. */
  private barrierPersistenceFailed = false;

  constructor(deps: AdapterDeps) {
    this.config = deps.config;
    this.runner = deps.runner;
    this.store = deps.store;
  }

  private runFormAgent(
    operation: AdapterOperation,
    args: string[],
    onSpawn?: (info: SpawnInfo) => void,
  ): Promise<RunResult> {
    const cwd = this.config.formAgentCwd;
    const timeoutMs = this.timeoutFor(operation);
    return this.runner.run({
      executablePath: this.config.formAgentBinaryPath,
      args,
      cwd,
      env: buildChildEnv(this.config.providerEnvNames),
      timeoutMs,
      maxOutputBytes: this.config.maxOutputBytes ?? 262_144,
      ...(onSpawn !== undefined ? { onSpawn } : {}),
    });
  }

  private timeoutFor(operation: AdapterOperation): number {
    const overrides = this.config.timeouts ?? {};
    switch (operation) {
      case 'analyze':
        return overrides.analyzeMs ?? 60_000;
      case 'draft':
      case 'draft_review':
        return overrides.draftMs ?? 300_000;
      case 'check':
        return overrides.checkMs ?? 300_000;
      case 'preflight':
        return overrides.preflightMs ?? 300_000;
      case 'submit_pending':
        return overrides.submitMs ?? 300_000;
      case 'metrics':
        return overrides.metricsMs ?? 30_000;
      default:
        return 10_000;
    }
  }

  async execute(principalInput: PrincipalInput, input: AdapterOperationInput): Promise<EnvelopeResult> {
    const operation = input.operation;

    const principalResult = validatePrincipalInput(principalInput);
    if (!principalResult.ok) return env(operation, 'unauthorized');
    const principal = principalResult.value;

    const match = matchOperatorPrincipal(this.config.operatorPrincipal, principal);
    if (!match.ok) return env(operation, 'unauthorized');

    switch (operation) {
      case 'analyze':
        return await this.runAnalyze(principal, input);
      case 'draft':
      case 'draft_review':
        return await this.runDraft(principal, input, operation === 'draft_review');
      case 'check':
        return await this.runCheck(principal, input);
      case 'preflight':
        return await this.runPreflight(principal, input);
      case 'metrics':
        return await this.runMetrics(principal, input);
      case 'cancel_pending':
        return this.runCancel(principal);
      case 'pending_status':
        return this.runPendingStatus(principal);
      case 'submit_status':
        return this.runSubmitStatus(principal, input);
      case 'submit_ack':
        return this.runSubmitAck(principal, input);
      case 'submit_pending':
        return await this.runSubmitPending(principal, input);
      case 'reconcile_unknown':
        return this.runReconcile(principal, input);
      default:
        return env(operation, 'usage_error');
    }
  }

  private validateTarget(
    support: TargetSupport,
    target: string | undefined,
  ): { ok: true; value: ValidatedTargetCommand } | { ok: false } {
    if (typeof target !== 'string') return { ok: false };
    const result = validateTargetCommand(support, target);
    if (!result.ok) return { ok: false };
    return { ok: true, value: result.value };
  }

  private draftProviderOf(input: AdapterOperationInput): string | undefined {
    if (input.draftProvider === undefined) return undefined;
    if (!validateDraftProvider(input.draftProvider, this.config.allowedDraftProviders)) return undefined;
    return input.draftProvider;
  }

  private async runAnalyze(principal: Principal, input: AdapterOperationInput): Promise<EnvelopeResult> {
    void principal;
    const target = this.validateTarget('analyze', input.target);
    if (!target.ok) return env('analyze', 'usage_error');
    const result = await this.runFormAgent('analyze', buildAnalyzeArgv(this.config, target.value.targetArg));
    if (result.kind !== 'exit') return env('analyze', rootCategoryForExit('analyze', result), {}, null);
    if (result.code !== 0) return env('analyze', rootCategoryForExit('analyze', result), {}, result.code);
    const doc = parseJson(result.stdout);
    if (!isRecord(doc) || doc['command'] !== 'analyze') {
      return env('analyze', 'error', {}, 0);
    }
    const form = isRecord(doc['form']) ? doc['form'] : {};
    const questions = isRecord(doc['questions']) ? doc['questions'] : {};
    const policy = isRecord(doc['policy']) ? doc['policy'] : {};
    const sections = Array.isArray(doc['sections']) ? doc['sections'] : [];
    const data = {
      formTitle: typeof form['title'] === 'string' ? form['title'] : null,
      fingerprint: typeof doc['fingerprint'] === 'string' ? doc['fingerprint'] : null,
      sectionCount: sections.length,
      questionCount: typeof questions['total'] === 'number' ? questions['total'] : 0,
      requiredCount: typeof questions['required'] === 'number' ? questions['required'] : 0,
      optionalCount: typeof questions['optional'] === 'number' ? questions['optional'] : 0,
      kinds: isRecord(doc['kinds']) ? doc['kinds'] : {},
      routing: typeof doc['routing'] === 'string' ? doc['routing'] : null,
      policyAllowed: policy['allowed'] === true,
      policyReasons: Array.isArray(policy['reasons']) ? policy['reasons'] : [],
    };
    return env('analyze', 'ok_analyze', data, 0);
  }

  private async runDraft(principal: Principal, input: AdapterOperationInput, review: boolean): Promise<EnvelopeResult> {
    void principal;
    const operation: AdapterOperation = review ? 'draft_review' : 'draft';
    const target = this.validateTarget(review ? 'draft_review' : 'draft', input.target);
    if (!target.ok) return env(operation, 'usage_error');
    const seed = generateSeed();
    const provider = this.draftProviderOf(input);
    if (input.draftProvider !== undefined && provider === undefined) return env(operation, 'usage_error');
    const result = await this.runFormAgent(operation, buildDraftArgv(this.config, target.value.targetArg, seed, provider));
    if (result.kind !== 'exit') return env(operation, rootCategoryForExit(operation, result), {}, null);
    if (result.code !== 0) return env(operation, rootCategoryForExit(operation, result), {}, result.code);
    const doc = parseJson(result.stdout);
    if (!isRecord(doc) || typeof doc['draftId'] !== 'string') return env(operation, 'error', {}, 0);
    const form = isRecord(doc['form']) ? doc['form'] : {};
    const providerDoc = isRecord(doc['provider']) ? doc['provider'] : {};
    const summary = isRecord(doc['summary']) ? doc['summary'] : {};
    const data: Record<string, unknown> = {
      formTitle: typeof form['title'] === 'string' ? form['title'] : null,
      draftId: doc['draftId'],
      fingerprint: typeof doc['fingerprint'] === 'string' ? doc['fingerprint'] : null,
      providerId: typeof providerDoc['id'] === 'string' ? providerDoc['id'] : null,
      providerVersion: typeof providerDoc['version'] === 'string' ? providerDoc['version'] : null,
      summary,
      answeredCount: typeof summary['answered'] === 'number' ? summary['answered'] : 0,
    };
    if (review) {
      const results = Array.isArray(doc['results']) ? doc['results'] : [];
      // Accepted `draftToJson` projection: `state` is the state string and an
      // `answered` entry carries `value` at the item level (blocked entries do
      // not). Only eligible answered values are bridged.
      data['draftAnswers'] = results
        .filter((item): item is Record<string, unknown> => isRecord(item) && item['state'] === 'answered')
        .map((item) => ({
          questionId: item['questionId'],
          kind: item['kind'],
          value: item['value'],
        }));
    }
    return env(operation, 'ok_draft', data, 0);
  }

  private async runCheck(principal: Principal, input: AdapterOperationInput): Promise<EnvelopeResult> {
    void principal;
    const target = this.validateTarget('check', input.target);
    if (!target.ok) return env('check', 'usage_error');
    const seed = generateSeed();
    const provider = this.draftProviderOf(input);
    if (input.draftProvider !== undefined && provider === undefined) return env('check', 'usage_error');
    const result = await this.runFormAgent('check', buildCheckArgv(this.config, target.value.targetArg, seed, provider));
    if (result.kind !== 'exit') return env('check', rootCategoryForExit('check', result), {}, null);
    const code = result.code;
    if (code !== 0 && code !== 3) return env('check', rootCategoryForExit('check', result), {}, code);
    const doc = parseJson(result.stdout);
    if (!isRecord(doc) || doc['command'] !== 'check') {
      return env('check', code === 3 ? 'blocked_check' : 'error', {}, code);
    }
    const form = isRecord(doc['form']) ? doc['form'] : {};
    const consistency = isRecord(doc['consistency']) ? doc['consistency'] : {};
    const issues = Array.isArray(consistency['issues']) ? consistency['issues'] : [];
    const data = {
      formTitle: typeof form['title'] === 'string' ? form['title'] : null,
      fingerprint: typeof doc['fingerprint'] === 'string' ? doc['fingerprint'] : null,
      reportId: typeof consistency['reportId'] === 'string' ? consistency['reportId'] : null,
      status: typeof consistency['status'] === 'string' ? consistency['status'] : null,
      hardIssues: typeof consistency['hardIssues'] === 'number' ? consistency['hardIssues'] : 0,
      softIssues: typeof consistency['softIssues'] === 'number' ? consistency['softIssues'] : 0,
      issueCodes: issues
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => item['code'])
        .filter((value): value is string => typeof value === 'string'),
    };
    const category: AnyCategory = consistency['blocking'] === true || consistency['status'] === 'block' ? 'blocked_check' : 'ok_check';
    return env('check', category, data, code);
  }

  private async runMetrics(principal: Principal, input: AdapterOperationInput): Promise<EnvelopeResult> {
    void principal;
    if (input.since !== undefined && !validateTimestampBound(input.since)) return env('metrics', 'usage_error');
    if (input.until !== undefined && !validateTimestampBound(input.until)) return env('metrics', 'usage_error');
    const result = await this.runFormAgent('metrics', buildMetricsArgv(this.config, input.since, input.until));
    if (result.kind !== 'exit') return env('metrics', rootCategoryForExit('metrics', result), {}, null);
    if (result.code !== 0) return env('metrics', rootCategoryForExit('metrics', result), {}, result.code);
    const doc = parseJson(result.stdout);
    if (!isRecord(doc)) return env('metrics', 'error', {}, 0);
    return env('metrics', 'ok_metrics', { metrics: doc }, 0);
  }

  private runCancel(principal: Principal): EnvelopeResult {
    try {
      this.store.cancel(principal);
      return env('cancel_pending', 'ok_cancelled');
    } catch (err) {
      return this.pendingErrorEnvelope('cancel_pending', err);
    }
  }

  private runPendingStatus(principal: Principal): EnvelopeResult {
    let record: PendingRecord | null = null;
    try {
      record = this.store.read(principal);
    } catch {
      record = null;
    }
    if (record === null) {
      return env('pending_status', 'ok_pending_status', { pending: null });
    }
    const view = this.store.toApprovalView(record);
    const pending: PendingSummary = this.store.toSummary(record);
    const out = env('pending_status', 'ok_pending_status', { pending: view });
    out.pending = pending;
    return out;
  }

  private runSubmitStatus(principal: Principal, input: AdapterOperationInput): EnvelopeResult {
    if (input.pendingRef !== undefined && !validatePendingRef(input.pendingRef)) return env('submit_status', 'usage_error');
    if (input.planId !== undefined && !validatePlanId(input.planId)) return env('submit_status', 'usage_error');
    const recoverKnownApproved = input.pendingRef !== undefined;
    let view: RecoveryView;
    try {
      view = this.store.submitStatus(principal, {
        ...(input.pendingRef !== undefined ? { pendingRef: input.pendingRef } : {}),
        ...(input.planId !== undefined ? { planId: input.planId } : {}),
        recoverKnownApproved,
      });
    } catch (err) {
      if (err instanceof BarrierPersistenceError) {
        this.barrierPersistenceFailed = true;
        return env('submit_status', 'error', { hardRecoveryError: true, persisted: false });
      }
      throw err;
    }
    return env('submit_status', 'ok_pending_status', { ...view, persisted: true });
  }

  private runSubmitAck(principal: Principal, input: AdapterOperationInput): EnvelopeResult {
    if (input.pendingRef === undefined || !validatePendingRef(input.pendingRef)) return env('submit_ack', 'usage_error');
    if (input.attempt === undefined || !validatePendingRef(input.attempt)) return env('submit_ack', 'usage_error');
    const outcome = this.store.acknowledge(principal, input.pendingRef, input.attempt);
    return env('submit_ack', 'ok_pending_status', { acked: outcome.acked, idempotent: outcome.idempotent });
  }

  private runReconcile(principal: Principal, input: AdapterOperationInput): EnvelopeResult {
    if (input.pendingRef === undefined || !validatePendingRef(input.pendingRef)) return env('reconcile_unknown', 'usage_error');
    if (input.resolution === undefined || !isResolution(input.resolution)) return env('reconcile_unknown', 'usage_error');
    try {
      const outcome = reconcileUnknown({
        store: this.store,
        principal,
        pendingRef: input.pendingRef,
        resolution: input.resolution,
      });
      return env('reconcile_unknown', 'ok_reconciled', { ...outcome });
    } catch (err) {
      if (err instanceof PendingError && err.code === 'PENDING_CONSUMED') {
        return env('reconcile_unknown', 'error', { refused: true, reason: 'live_child' });
      }
      return this.pendingErrorEnvelope('reconcile_unknown', err);
    }
  }

  private pendingErrorEnvelope(operation: AdapterOperation, err: unknown): EnvelopeResult {
    if (err instanceof PendingError) {
      switch (err.code) {
        case 'NO_PENDING':
          return env(operation, 'no_pending');
        case 'UNKNOWN_BARRIER':
          return env(operation, 'unknown_barrier');
        case 'PENDING_CONSUMED':
          return env(operation, 'pending_consumed');
        case 'PENDING_REPLACED':
          return env(operation, 'pending_replaced');
        case 'PENDING_EXPIRED':
          return env(operation, 'pending_expired');
        case 'CORRUPT_STATE':
          return env(operation, 'unknown_barrier');
        default:
          return env(operation, 'error');
      }
    }
    return env(operation, 'error');
  }

  // -------------------------------------------------------------------------
  // Preflight (§11, §9)
  // -------------------------------------------------------------------------

  private async runPreflight(principal: Principal, input: AdapterOperationInput): Promise<EnvelopeResult> {
    const target = this.validateTarget('preflight', input.target);
    if (!target.ok) return env('preflight', 'usage_error');
    const provider = this.draftProviderOf(input);
    if (input.draftProvider !== undefined && provider === undefined) return env('preflight', 'usage_error');

    // Fast-fail barrier check before any Form Agent work (no side effects).
    // Corrupt/invalid persisted orchestration state also fails closed here,
    // BEFORE a Form Agent process is spawned.
    if (this.barrierPersistenceFailed) return env('preflight', 'unknown_barrier');
    try {
      const barrier = this.store.barrier(principal);
      if (barrier !== null) return env('preflight', 'unknown_barrier');
    } catch (err) {
      return this.pendingErrorEnvelope('preflight', err);
    }

    const seed = generateSeed();
    const result = await this.runFormAgent(
      'preflight',
      buildPreflightArgv(this.config, target.value.targetArg, seed, provider),
    );

    if (result.kind !== 'exit') return env('preflight', rootCategoryForExit('preflight', result), {}, null);
    if (result.code !== 0) return env('preflight', rootCategoryForExit('preflight', result), {}, result.code);

    const doc = parseJson(result.stdout);
    if (!isRecord(doc) || doc['command'] !== 'run' || doc['mode'] !== 'preflight') {
      return env('preflight', 'error', {}, 0);
    }
    const plan = isRecord(doc['plan']) ? doc['plan'] : {};
    const planTarget = isRecord(plan['target']) ? plan['target'] : {};
    const consistency = isRecord(plan['consistency']) ? plan['consistency'] : {};
    const planProvider = isRecord(plan['provider']) ? plan['provider'] : {};
    const draftProviderDoc = isRecord(doc['draftProvider']) ? doc['draftProvider'] : {};
    const planId = typeof plan['planId'] === 'string' ? plan['planId'] : null;
    const runtimeTargetKey = typeof planTarget['key'] === 'string' ? planTarget['key'] : null;
    const runtimeTargetDisplay = typeof planTarget['display'] === 'string' ? planTarget['display'] : null;
    if (planId === null || runtimeTargetKey === null || runtimeTargetDisplay === null) {
      return env('preflight', 'error', {}, 0);
    }
    // Pending creation must enforce the full three-part canonical equality. The
    // adapter already canonicalized the requested target; Form Agent's runtime
    // plan must agree exactly.
    if (runtimeTargetKey !== target.value.targetKey || runtimeTargetDisplay !== target.value.targetDisplay) {
      return env('preflight', 'error', {}, 0);
    }
    if (!recheckThreePartTarget(target.value.targetArg, runtimeTargetKey, runtimeTargetDisplay)) {
      return env('preflight', 'error', {}, 0);
    }

    const policy = isRecord(plan['policy']) ? plan['policy'] : {};
    const data: Record<string, unknown> = {
      // The accepted `run --json` preflight document does not expose the form
      // title; the adapter never scrapes human output to invent one.
      formTitle: null,
      targetDisplay: runtimeTargetDisplay,
      fingerprint: typeof plan['fingerprint'] === 'string' ? plan['fingerprint'] : null,
      draftId: typeof plan['draftId'] === 'string' ? plan['draftId'] : null,
      reportId: typeof consistency['reportId'] === 'string' ? consistency['reportId'] : null,
      consistencyStatus: typeof consistency['status'] === 'string' ? consistency['status'] : null,
      planId,
      providerId: typeof planProvider['id'] === 'string' ? planProvider['id'] : null,
      providerVersion: typeof planProvider['version'] === 'string' ? planProvider['version'] : null,
      draftProviderId: typeof draftProviderDoc['id'] === 'string' ? draftProviderDoc['id'] : null,
      draftProviderVersion:
        typeof draftProviderDoc['version'] === 'string' ? draftProviderDoc['version'] : null,
      modelLabel: typeof draftProviderDoc['model'] === 'string' ? draftProviderDoc['model'] : null,
      fillableCount: typeof plan['fillableCount'] === 'number' ? plan['fillableCount'] : 0,
      blockedCount: typeof plan['blockedCount'] === 'number' ? plan['blockedCount'] : 0,
      policyAllowed: policy['allowed'] === true,
      policyReasons: Array.isArray(policy['reasons']) ? policy['reasons'] : [],
      accepting: typeof doc['accepting'] === 'string' ? doc['accepting'] : null,
    };

    if (input.reviewAnswers === true) {
      const answers = Array.isArray(doc['answers']) ? doc['answers'] : [];
      data['planReview'] = answers.filter(isRecord).map((item) => ({
        questionId: item['questionId'],
        kind: item['kind'],
        value: item['value'],
      }));
    }

    let record: PendingRecord;
    try {
      record = this.store.create({
        principal,
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        targetKey: runtimeTargetKey,
        targetArg: target.value.targetArg,
        targetDisplay: runtimeTargetDisplay,
        planId,
        seed,
        operator: `telegram:${principal.senderId}`,
      });
    } catch (err) {
      return this.pendingErrorEnvelope('preflight', err);
    }

    const pending: PendingSummary = {
      pendingId: record.pendingId,
      planId: record.planId,
      targetDisplay: record.targetDisplay,
      expiresAtMs: record.expiresAtMs,
      status: record.status,
    };
    const out = env('preflight', 'needs_confirmation', data, 0);
    out.pending = pending;
    return out;
  }

  // -------------------------------------------------------------------------
  // Submit lifecycle (§11.2, §8.6, §12.1)
  // -------------------------------------------------------------------------

  private async runSubmitPending(principal: Principal, input: AdapterOperationInput): Promise<EnvelopeResult> {
    if (input.pendingRef === undefined || !validatePendingRef(input.pendingRef)) return env('submit_pending', 'usage_error');
    if (input.planId === undefined || !validatePlanId(input.planId)) return env('submit_pending', 'usage_error');
    if (input.targetKey === undefined || input.targetDisplay === undefined) return env('submit_pending', 'usage_error');
    if (input.expiresAtMs === undefined || !Number.isFinite(input.expiresAtMs)) return env('submit_pending', 'usage_error');

    let claimed: PendingRecord;
    try {
      claimed = this.store.claim(
        principal,
        {
          pendingRef: input.pendingRef,
          planId: input.planId,
          targetKey: input.targetKey,
          targetDisplay: input.targetDisplay,
          expiresAtMs: input.expiresAtMs,
        },
        recheckThreePartTarget,
      );
    } catch (err) {
      return this.pendingErrorEnvelope('submit_pending', err);
    }

    const attemptId = claimed.attemptId as string;
    const result = await this.runFormAgent(
      'submit_pending',
      buildSubmitArgv(this.config, { targetArg: claimed.targetArg, seed: claimed.seed, planId: claimed.planId }, principal.senderId),
      (info) => {
        try {
          this.store.markStarted(principal, claimed.pendingId, attemptId, {
            childPid: info.pid > 0 ? info.pid : 'unavailable',
            childProcessGroup: info.processGroup ?? 'unavailable',
          });
        } catch {
          // Failure to persist optional process metadata must not make the
          // record reusable; the record stays `claimed`.
        }
      },
    );

    // Pre-start spawn failure: provably never started -> terminal safe.
    if (result.kind === 'spawn_failed') {
      this.store.markStartFailed(principal, claimed.pendingId, attemptId);
      return env('submit_pending', 'submit_start_failed', {}, null);
    }

    const classification = classifySubmitResult(result, {
      planId: claimed.planId,
      targetKey: claimed.targetKey,
      targetDisplay: claimed.targetDisplay,
      operator: claimed.operator,
    });

    if (classification.ambiguous) {
      this.store.markConsumedUnknown(principal, claimed.pendingId, attemptId, classification.reason);
      return env('submit_pending', 'unknown_outcome', {}, classification.formAgentExitCode);
    }

    let completed: CompletedResult;
    try {
      completed = this.store.markCompletedUnambiguous(
        principal,
        claimed.pendingId,
        attemptId,
        {
          category: classification.category,
          status: statusOf(classification.category),
          formAgentExitCode: classification.formAgentExitCode,
          data: classification.data,
          pending: null,
        },
      );
    } catch {
      try {
        this.store.markConsumedUnknown(principal, claimed.pendingId, attemptId, 'terminal_handoff_persist_failed');
      } catch {
        // The durable store is unreadable/unwritable; the caller still gets a
        // fail-closed unknown outcome.
      }
      return env('submit_pending', 'unknown_outcome', {}, classification.formAgentExitCode);
    }

    return env('submit_pending', completed.category as AnyCategory, completed.data, completed.formAgentExitCode);
  }
}

interface SubmitClassification {
  ambiguous: boolean;
  category: AnyCategory;
  formAgentExitCode: number | null;
  data: Record<string, unknown>;
  reason: string;
}

/** Trusted claimed identity a started-submit result must bind to. */
export interface SubmitClaimIdentity {
  planId: string;
  targetKey: string;
  targetDisplay: string;
  operator: string;
}

const TERMINAL_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Strict successful-submit proof (Finding P) bound to the claimed identity.
 * Returns the exact closed terminal data, or null (=> unknown_outcome).
 */
function submitSuccessDataOf(doc: unknown, expected: SubmitClaimIdentity): Record<string, unknown> | null {
  if (!isRecord(doc)) return null;
  if (doc['command'] !== 'run' || doc['mode'] !== 'submit' || doc['outcome'] !== 'success') return null;
  const runId = doc['runId'];
  if (typeof runId !== 'number' || !Number.isInteger(runId) || runId <= 0) return null;
  const plan = isRecord(doc['plan']) ? doc['plan'] : null;
  if (plan === null) return null;
  const planId = plan['planId'];
  if (typeof planId !== 'string' || !TERMINAL_HASH_PATTERN.test(planId) || planId !== expected.planId) return null;
  const target = isRecord(plan['target']) ? plan['target'] : null;
  if (target === null) return null;
  if (target['key'] !== expected.targetKey) return null;
  if (target['display'] !== expected.targetDisplay) return null;
  const fingerprint = plan['fingerprint'];
  if (typeof fingerprint !== 'string' || !TERMINAL_HASH_PATTERN.test(fingerprint)) return null;
  const consistency = isRecord(plan['consistency']) ? plan['consistency'] : null;
  if (consistency === null) return null;
  const softIssues = consistency['softIssues'];
  if (typeof softIssues !== 'number' || !Number.isInteger(softIssues) || softIssues < 0) return null;
  const receipt = isRecord(doc['receipt']) ? doc['receipt'] : null;
  if (receipt === null) return null;
  if (receipt['state'] !== 'success') return null;
  if (receipt['submitAttempted'] !== true) return null;
  if (receipt['outcome'] !== 'success') return null;
  if (receipt['outcomeCode'] !== 'SUBMISSION_CONFIRMED') return null;
  if (receipt['operator'] !== expected.operator) return null;

  const data: Record<string, unknown> = {
    runId,
    planId,
    targetDisplay: target['display'],
    fingerprint,
    receiptState: receipt['state'],
    submitAttempted: true,
    outcome: doc['outcome'],
    outcomeCode: receipt['outcomeCode'],
    operator: receipt['operator'],
    consistencySoftIssues: softIssues,
  };
  if (
    !validateTerminalData('ok_submit_success', data, {
      planId: expected.planId,
      targetDisplay: expected.targetDisplay,
      operator: expected.operator,
    })
  ) {
    return null;
  }
  return data;
}

/**
 * Classify a STARTED submit child. Exit code alone is never sufficient: the
 * accepted machine document must prove an unambiguous terminal result AND bind
 * to the trusted claimed identity, otherwise the result is ambiguous
 * (`unknown_outcome` + `consumed_unknown`).
 */
export function classifySubmitResult(result: RunResult, expected: SubmitClaimIdentity): SubmitClassification {
  const exitCode = exitCodeOf(result);

  if (result.kind === 'timeout' || result.kind === 'output_cap' || result.kind === 'spawn_failed') {
    return { ambiguous: true, category: 'unknown_outcome', formAgentExitCode: null, data: {}, reason: `submit_${result.kind}` };
  }
  if (result.kind !== 'exit') {
    return { ambiguous: true, category: 'unknown_outcome', formAgentExitCode: null, data: {}, reason: 'submit_unrecognized' };
  }

  const stdoutDoc = parseJson(result.stdout);

  if (result.code === 0) {
    if (isRecord(stdoutDoc) && stdoutDoc['outcome'] === 'unknown_outcome') {
      return { ambiguous: true, category: 'unknown_outcome', formAgentExitCode: 0, data: {}, reason: 'form_agent_unknown_outcome' };
    }
    const data = submitSuccessDataOf(stdoutDoc, expected);
    if (data !== null) {
      return { ambiguous: false, category: 'ok_submit_success', formAgentExitCode: 0, data, reason: 'proven_success' };
    }
    return { ambiguous: true, category: 'unknown_outcome', formAgentExitCode: 0, data: {}, reason: 'submit_missing_or_malformed_success' };
  }

  if (result.code === 1) {
    // Generic exit-1 is NEVER an unambiguous terminal result. `run --json-error`
    // with `kind:"error"` describes an error class; it does not prove that no
    // submit action could have occurred.
    if (isRecord(stdoutDoc) && stdoutDoc['outcome'] === 'unknown_outcome') {
      return { ambiguous: true, category: 'unknown_outcome', formAgentExitCode: 1, data: {}, reason: 'form_agent_unknown_outcome' };
    }
    return { ambiguous: true, category: 'unknown_outcome', formAgentExitCode: 1, data: {}, reason: 'submit_generic_error_unproven' };
  }

  if (result.code === 2 || result.code === 3) {
    const proof = runErrorDocOf(stdoutDoc, result.code);
    if (proof === null) {
      return { ambiguous: true, category: 'unknown_outcome', formAgentExitCode: result.code, data: {}, reason: 'submit_missing_or_malformed_proof' };
    }
    if (result.code === 2) {
      const data = { errorCode: proof.code };
      if (!validateTerminalData('usage_error', data)) return ambiguousSubmitExit(result.code, 'usage_data_invalid');
      return { ambiguous: false, category: 'usage_error', formAgentExitCode: 2, data, reason: 'proven_usage' };
    }
    if (proof.code === ALREADY_CLAIMED_CODE) {
      const data = { errorCode: proof.code };
      if (!validateTerminalData('already_claimed', data)) return ambiguousSubmitExit(result.code, 'already_claimed_data_invalid');
      return { ambiguous: false, category: 'already_claimed', formAgentExitCode: 3, data, reason: 'proven_already_claimed' };
    }
    const data = { errorCode: proof.code };
    if (!validateTerminalData('blocked_submit', data)) return ambiguousSubmitExit(result.code, 'block_data_invalid');
    return { ambiguous: false, category: 'blocked_submit', formAgentExitCode: 3, data, reason: 'proven_block' };
  }

  // exit 4/5/127 or null code with no recognized proof after start: ambiguous.
  return { ambiguous: true, category: 'unknown_outcome', formAgentExitCode: exitCode, data: {}, reason: 'submit_unrecognized_result' };
}

function ambiguousSubmitExit(exitCode: number, reason: string): SubmitClassification {
  return { ambiguous: true, category: 'unknown_outcome', formAgentExitCode: exitCode, data: {}, reason };
}
