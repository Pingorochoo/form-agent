/**
 * Phase 8 plugin → adapter client (P8-R6/P8-R7).
 *
 * The plugin NEVER reads the adapter's pending JSON directly: it invokes the
 * adapter binary with argv arrays and consumes exactly one bounded JSON
 * envelope. The child env is closed to `PATH`, `HOME`, and the absolute adapter
 * config path (`FORM_AGENT_OPENCLAW_CONFIG`).
 */

import {
  NodeSubprocessRunner,
  type RunResult,
  type SubprocessRunner,
} from '../../src/openclaw/runner.ts';
import {
  ADAPTER_CATEGORIES,
  ADAPTER_VERSION,
  OPERATION_TIMEOUTS,
  TERMINAL_SUBMIT_CONTRACT,
  isAllowedProviderEnvName,
  statusForCategory,
  validateCompletedResultShape,
  validateTerminalData,
  type ModelOperationParams,
} from '../../src/openclaw/contracts.ts';
import type { PluginPrincipal } from './principal.ts';

export interface AdapterEnvelope {
  version: string;
  operation: string;
  status: 'ok' | 'needs_confirmation' | 'blocked' | 'already_claimed' | 'unknown_outcome' | 'error';
  category: string;
  formAgentExitCode: number | null;
  message: string;
  data: Record<string, unknown>;
  pending: unknown;
}

export interface AdapterClientConfig {
  adapterBinaryPath: string;
  adapterConfigPath: string;
  /**
   * Exact provider credential env NAMES to forward to the short-lived adapter
   * subprocess. Values are copied from the plugin parent env only when present;
   * nothing else is forwarded (Finding S).
   */
  providerEnvNames?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  parentEnv?: NodeJS.ProcessEnv;
}

export type AdapterCallResult =
  | { ok: true; envelope: AdapterEnvelope }
  | { ok: false; reason: 'spawn_failed' | 'timeout' | 'output_cap' | 'malformed' };

export interface PendingForSubmit {
  pendingId: string;
  planId: string;
  targetKey: string;
  targetDisplay: string;
  expiresAtMs: number;
}

export interface AdapterCallOptions {
  timeoutMs?: number;
  /** Exact operation this call expects; the returned envelope must match. */
  expectedOperation?: string;
}

const ADAPTER_CONFIG_ENV = 'FORM_AGENT_OPENCLAW_CONFIG';

/**
 * `submit_pending` may legitimately run for the full adapter submit timeout.
 * The plugin-side subprocess bound must therefore be strictly longer so the
 * adapter has time to complete timeout handling, durable state updates, and
 * emit its terminal envelope instead of being killed by the outer runner.
 */
const SUBMIT_PENDING_OUTER_GRACE_MS = 15_000;
const SUBMIT_PENDING_OUTER_TIMEOUT_MS =
  (OPERATION_TIMEOUTS['submit_pending'] as number) + SUBMIT_PENDING_OUTER_GRACE_MS;

const PENDING_ID_RE = /^[0-9a-f]{32}$/;
const PLAN_ID_RE = /^[0-9a-f]{64}$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const MAX_MESSAGE = 2048;
const MAX_TARGET = 256;

const ADAPTER_CATEGORY_SET: ReadonlySet<string> = new Set(ADAPTER_CATEGORIES);
const PENDING_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'claimed',
  'start_failed',
  'consumed_unknown',
  'completed_unambiguous',
]);
const RECOVERY_STATES: ReadonlySet<string> = new Set([
  'none',
  'pending',
  'claimed',
  'start_failed',
  'consumed_unknown',
  'completed_unambiguous',
]);
const SUMMARY_KEYS: ReadonlySet<string> = new Set([
  'pendingId',
  'planId',
  'targetDisplay',
  'expiresAtMs',
  'status',
]);
const APPROVAL_VIEW_KEYS: ReadonlySet<string> = new Set([
  'pendingId',
  'planId',
  'targetKey',
  'targetDisplay',
  'expiresAtMs',
  'status',
]);

/** Frozen persistable unambiguous terminal triples (mirror of the adapter). */
const OPERATION_FAILURES: readonly string[] = [
  'usage_error',
  'unauthorized',
  'llm_offline',
  'llm_connectivity',
  'error',
  'timeout',
];

/**
 * Exact `operation -> allowed categories` contract derived from the current
 * adapter behavior (Finding D1). A globally-known but operation-impossible
 * category is rejected.
 */
const OPERATION_CATEGORY_MAP: Readonly<Record<string, ReadonlySet<string>>> = {
  analyze: new Set(['ok_analyze', ...OPERATION_FAILURES]),
  draft: new Set(['ok_draft', ...OPERATION_FAILURES]),
  draft_review: new Set(['ok_draft', ...OPERATION_FAILURES]),
  check: new Set(['ok_check', 'blocked_check', ...OPERATION_FAILURES]),
  preflight: new Set(['needs_confirmation', 'blocked_preflight', 'unknown_barrier', ...OPERATION_FAILURES]),
  metrics: new Set(['ok_metrics', ...OPERATION_FAILURES]),
  cancel_pending: new Set([
    'ok_cancelled',
    'no_pending',
    'unknown_barrier',
    'pending_consumed',
    'pending_replaced',
    'pending_expired',
    ...OPERATION_FAILURES,
  ]),
  pending_status: new Set(['ok_pending_status', 'unauthorized', 'error']),
  submit_status: new Set(['ok_pending_status', 'usage_error', 'unauthorized', 'error']),
  submit_ack: new Set(['ok_pending_status', 'usage_error', 'unauthorized', 'error']),
  submit_pending: new Set([
    'ok_submit_success',
    'blocked_submit',
    'already_claimed',
    'usage_error',
    'unauthorized',
    'submit_start_failed',
    'unknown_outcome',
    'unknown_barrier',
    'no_pending',
    'pending_consumed',
    'pending_replaced',
    'pending_expired',
    'error',
  ]),
};

/** Exact accepted `submit_ack` data shape. */
const SUBMIT_ACK_KEYS: ReadonlySet<string> = new Set(['acked', 'idempotent']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCleanBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !CONTROL_CHARS.test(value);
}

function isPendingSummaryLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !SUMMARY_KEYS.has(key))) return false;
  if (typeof value['pendingId'] !== 'string' || !PENDING_ID_RE.test(value['pendingId'])) return false;
  if (typeof value['planId'] !== 'string' || !PLAN_ID_RE.test(value['planId'])) return false;
  if (!isCleanBoundedString(value['targetDisplay'], MAX_TARGET)) return false;
  if (typeof value['expiresAtMs'] !== 'number' || !Number.isInteger(value['expiresAtMs'])) return false;
  return typeof value['status'] === 'string' && PENDING_STATUSES.has(value['status']);
}

function isApprovalViewLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !APPROVAL_VIEW_KEYS.has(key))) return false;
  if (!isPendingSummaryLike({
    pendingId: value['pendingId'],
    planId: value['planId'],
    targetDisplay: value['targetDisplay'],
    expiresAtMs: value['expiresAtMs'],
    status: value['status'],
  })) {
    return false;
  }
  return isCleanBoundedString(value['targetKey'], 4096) && value['targetKey'] !== '';
}

/**
 * Strict adapter machine-contract validator (Finding N-a).
 *
 * Rejects an envelope unless version/operation are exact, the category belongs
 * to the closed adapter vocabulary, the status is the frozen category→status
 * mapping, the exit code obeys the frozen category relation, and the operation's
 * bounded `data`/`pending` shape holds. Arbitrary objects with required keys as
 * strings are NOT accepted.
 */
export function validateAdapterEnvelope(
  value: unknown,
  expectedOperation: string,
): value is AdapterEnvelope {
  if (!isRecord(value)) return false;
  if (value['version'] !== ADAPTER_VERSION) return false;
  if (value['operation'] !== expectedOperation) return false;
  const category = value['category'];
  if (typeof category !== 'string' || !ADAPTER_CATEGORY_SET.has(category)) return false;
  // Operation-specific category contract (Finding D1): a globally-known but
  // impossible category for this operation is rejected.
  const allowedCategories = OPERATION_CATEGORY_MAP[expectedOperation];
  if (allowedCategories === undefined || !allowedCategories.has(category)) return false;
  const expectedStatus = statusForCategory(category as never);
  if (value['status'] !== expectedStatus) return false;
  if (!isCleanBoundedString(value['message'], MAX_MESSAGE)) return false;
  if (!isRecord(value['data'])) return false;
  if (!('pending' in value)) return false;
  if (value['pending'] !== null && !isPendingSummaryLike(value['pending'])) return false;

  const exitCode = value['formAgentExitCode'];
  if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isInteger(exitCode))) return false;

  // The frozen terminal exit/data contract belongs exclusively to
  // `submit_pending`. Categories such as `usage_error` are also valid for
  // non-submit operations, where they intentionally carry no submit-terminal
  // exit/data shape.
  if (expectedOperation === 'submit_pending') {
    const terminal = TERMINAL_SUBMIT_CONTRACT.get(category);
    if (terminal !== undefined) {
      if (exitCode !== terminal.exitCode) return false;
      // Closed terminal `data` shape (Findings Q): null placeholders/extra keys
      // are rejected at the plugin boundary too.
      if (!validateTerminalData(category, value['data'])) return false;
    }
  }
  if (category === 'submit_start_failed' && exitCode !== null) return false;

  if (expectedOperation === 'pending_status') {
    const pending = value['data']['pending'];
    if (pending !== null && !isApprovalViewLike(pending)) return false;
  }
  if (expectedOperation === 'submit_status') {
    const data = value['data'];
    const hardRecovery = data['hardRecoveryError'] === true && data['persisted'] === false;
    if (hardRecovery) {
      // The frozen BB hard-recovery envelope carries no `state`.
      if (category !== 'error') return false;
    } else {
      const state = data['state'];
      if (typeof state !== 'string' || !RECOVERY_STATES.has(state)) return false;
      // The nested durable completed handoff must satisfy the SAME closed
      // completed-result shape used by the PendingStore (Finding C).
      if (state === 'completed_unambiguous' && !validateCompletedResultShape(data['result'])) return false;
    }
  }
  if (expectedOperation === 'submit_ack') {
    const data = value['data'];
    const keys = Object.keys(data);
    if (keys.length !== SUBMIT_ACK_KEYS.size) return false;
    for (const key of keys) {
      if (!SUBMIT_ACK_KEYS.has(key)) return false;
    }
    if (typeof data['acked'] !== 'boolean' || typeof data['idempotent'] !== 'boolean') return false;
  }
  return true;
}

/**
 * Strip review-value fields from an adapter envelope's data before it can
 * become model-visible `content`/`details`. Trusted same-chat delivery of
 * those values is a separate step; this function is the fail-safe side.
 */
export function stripReviewFields(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  delete out['draftAnswers'];
  delete out['planReview'];
  return out;
}

function formatReviewValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}=${String(item)}`)
      .join(', ');
  }
  return String(value);
}

export interface ReviewValues {
  /** `exact` = submission-bound preflight plan review; `exploratory` = draft_review. */
  kind: 'exact' | 'exploratory';
  lines: string[];
}

/**
 * Extract review values for the trusted human-delivery bridge. Only eligible
 * `answered` entries are present in the adapter envelope (blocked/sensitive
 * values never are).
 */
export function extractReviewValues(envelope: AdapterEnvelope): ReviewValues | null {
  const planReview = envelope.data['planReview'];
  const draftAnswers = envelope.data['draftAnswers'];
  const values = Array.isArray(planReview) ? planReview : Array.isArray(draftAnswers) ? draftAnswers : null;
  if (values === null || values.length === 0) return null;
  const lines = values
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => `${String(item['questionId'])} (${String(item['kind'])}) = ${formatReviewValue(item['value'])}`);
  return { kind: Array.isArray(planReview) ? 'exact' : 'exploratory', lines };
}

function principalFlags(principal: PluginPrincipal): string[] {
  const args = ['--channel', principal.channel, '--account', principal.accountId, '--sender', principal.senderId];
  if (principal.conversationId !== undefined) args.push('--conversation', principal.conversationId);
  return args;
}

export class PendingClient {
  private readonly config: AdapterClientConfig;
  private readonly runner: SubprocessRunner;

  constructor(config: AdapterClientConfig, runner?: SubprocessRunner) {
    this.config = config;
    this.runner = runner ?? new NodeSubprocessRunner();
  }

  private childEnv(): Record<string, string> {
    const parent = this.config.parentEnv ?? process.env;
    const env: Record<string, string> = {};
    for (const name of ['PATH', 'HOME'] as const) {
      const value = parent[name];
      if (typeof value === 'string') env[name] = value;
    }
    env[ADAPTER_CONFIG_ENV] = this.config.adapterConfigPath;
    // Forward ONLY the exact validated credential names whose values exist in
    // the plugin parent env; never the whole environment (Finding S).
    for (const name of this.config.providerEnvNames ?? []) {
      if (!isAllowedProviderEnvName(name)) continue;
      const value = parent[name];
      if (typeof value === 'string' && value !== '') env[name] = value;
    }
    return env;
  }

  async call(args: string[], options: AdapterCallOptions = {}): Promise<AdapterCallResult> {
    let result: RunResult;
    try {
      result = await this.runner.run({
        executablePath: this.config.adapterBinaryPath,
        args,
        cwd: this.config.parentEnv?.['HOME'] ?? process.cwd(),
        env: this.childEnv(),
        timeoutMs: options.timeoutMs ?? this.config.timeoutMs ?? 30_000,
        maxOutputBytes: this.config.maxOutputBytes ?? 262_144,
      });
    } catch {
      return { ok: false, reason: 'spawn_failed' };
    }
    if (result.kind === 'spawn_failed') return { ok: false, reason: 'spawn_failed' };
    if (result.kind === 'timeout') return { ok: false, reason: 'timeout' };
    if (result.kind === 'output_cap') return { ok: false, reason: 'output_cap' };

    const trimmed = result.stdout.trim();
    if (trimmed === '') return { ok: false, reason: 'malformed' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (!isRecord(parsed)) return { ok: false, reason: 'malformed' };
    if (
      options.expectedOperation === undefined ||
      !validateAdapterEnvelope(parsed, options.expectedOperation)
    ) {
      return { ok: false, reason: 'malformed' };
    }
    return { ok: true, envelope: parsed };
  }

  formAgent(principal: PluginPrincipal, params: ModelOperationParams): Promise<AdapterCallResult> {
    const args = [...this.operationArgs(params), ...principalFlags(principal)];
    return this.call(args, { expectedOperation: params.operation });
  }

  private operationArgs(params: ModelOperationParams): string[] {
    const args: string[] = [params.operation];
    switch (params.operation) {
      case 'analyze':
        args.push('--target', params.target as string);
        break;
      case 'draft':
      case 'draft_review':
      case 'check':
        args.push('--target', params.target as string);
        if (params.draftProvider !== undefined) args.push('--draft-provider', params.draftProvider);
        break;
      case 'preflight':
        args.push('--target', params.target as string);
        if (params.draftProvider !== undefined) args.push('--draft-provider', params.draftProvider);
        if (params.reviewAnswers === true) args.push('--review-answers');
        break;
      case 'metrics':
        if (params.since !== undefined) args.push('--since', params.since);
        if (params.until !== undefined) args.push('--until', params.until);
        break;
      case 'cancel_pending':
        break;
    }
    return args;
  }

  pendingStatus(principal: PluginPrincipal): Promise<AdapterCallResult> {
    return this.call(['pending_status', ...principalFlags(principal)], {
      timeoutMs: 10_000,
      expectedOperation: 'pending_status',
    });
  }

  submitStatus(
    principal: PluginPrincipal,
    recovery: { pendingRef?: string; planId?: string },
  ): Promise<AdapterCallResult> {
    const args = ['submit_status', ...principalFlags(principal)];
    if (recovery.pendingRef !== undefined) args.push('--pending-ref', recovery.pendingRef);
    if (recovery.planId !== undefined) args.push('--plan', recovery.planId);
    return this.call(args, { timeoutMs: 10_000, expectedOperation: 'submit_status' });
  }

  submitAck(
    principal: PluginPrincipal,
    ack: { pendingRef: string; attemptId: string },
  ): Promise<AdapterCallResult> {
    return this.call(
      ['submit_ack', ...principalFlags(principal), '--pending-ref', ack.pendingRef, '--attempt', ack.attemptId],
      { timeoutMs: 10_000, expectedOperation: 'submit_ack' },
    );
  }

  submitPending(principal: PluginPrincipal, pending: PendingForSubmit): Promise<AdapterCallResult> {
    return this.call(
      [
        'submit_pending',
        ...principalFlags(principal),
        '--pending-ref',
        pending.pendingId,
        '--plan',
        pending.planId,
        '--target-key',
        pending.targetKey,
        '--target-display',
        pending.targetDisplay,
        '--expires-at',
        String(pending.expiresAtMs),
      ],
      {
        timeoutMs: Math.max(
          this.config.timeoutMs ?? 0,
          SUBMIT_PENDING_OUTER_TIMEOUT_MS,
        ),
        expectedOperation: 'submit_pending',
      },
    );
  }
}
