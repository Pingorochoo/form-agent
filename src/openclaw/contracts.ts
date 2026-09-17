/**
 * Phase 8 OpenClaw adapter contracts (frozen).
 *
 * Pure, dependency-light module: operation grammar, the frozen closed
 * category→status vocabulary, input bounds (§7.4), the target support matrix
 * (§7.3), argv builders (§7.2), the adapter envelope, and the deployment
 * adapter-config schema.
 *
 * This module performs NO I/O and never spawns a process. It only validates
 * model/plugin-derived data and builds the exact argv arrays the adapter will
 * pass to `child_process`. No raw value is ever echoed on a validation error.
 */

import { randomBytes } from 'node:crypto';

import { canonicalizeTarget, TargetError, type CanonicalTarget, type TargetKind } from '../policy/target.ts';
import { parseIsoTimestamp } from '../metrics/time.ts';

export const ADAPTER_VERSION = '1.0.0';

/** Pending TTL (§11.1): 10 minutes, `pending` status only. */
export const PENDING_TTL_MS = 600_000;

export const PENDING_REF_PATTERN = /^[0-9a-f]{32}$/;
export const PLAN_ID_PATTERN = /^[0-9a-f]{64}$/;
export const HEX_32_PATTERN = /^[0-9a-f]{32}$/;
export const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const SENDER_ID_PATTERN = /^[0-9]{1,20}$/;
export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
export const DRAFT_PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Maximum provider credential env names forwarded across subprocess hops. */
export const MAX_PROVIDER_ENV_NAMES = 32;

/** Always dropped even when listed or present in a parent env (§14.1). */
const DENIED_PROVIDER_ENV_NAMES: ReadonlySet<string> = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'SSL_CERT_FILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'PWD',
  'SHELL',
  'USER',
]);

export function isDeniedProviderEnvName(name: string): boolean {
  if (DENIED_PROVIDER_ENV_NAMES.has(name)) return true;
  return name.startsWith('LD_') || name.startsWith('DYLD_');
}

/** The single shared credential-env-name rule (adapter + plugin). */
export function isAllowedProviderEnvName(name: string): boolean {
  return ENV_NAME_PATTERN.test(name) && !isDeniedProviderEnvName(name);
}

export const MAX_TARGET_INPUT_CHARS = 2048;
export const MAX_TARGET_DISPLAY_CHARS = 256;
export const MAX_DRAFT_PROVIDER_CHARS = 32;
export const MAX_TIMESTAMP_CHARS = 35;
export const MAX_CAPTURED_OUTPUT_BYTES = 262_144;

/** ASCII NUL and control characters are always rejected before any other check. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export function hasControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

// ---------------------------------------------------------------------------
// Operation grammar
// ---------------------------------------------------------------------------

/** Model-facing `form_agent` operations (a closed enum). */
export const MODEL_OPERATIONS = [
  'analyze',
  'draft',
  'draft_review',
  'check',
  'preflight',
  'metrics',
  'cancel_pending',
] as const;
export type ModelOperation = (typeof MODEL_OPERATIONS)[number];

/** Internal/plugin-only adapter operations. Never model- or Telegram-facing. */
export const INTERNAL_OPERATIONS = [
  'pending_status',
  'submit_status',
  'submit_ack',
  'submit_pending',
] as const;
export type InternalOperation = (typeof INTERNAL_OPERATIONS)[number];

/** Operator-only local recovery operation. Never an OpenClaw tool/Telegram command. */
export const OPERATOR_OPERATIONS = ['reconcile_unknown'] as const;
export type OperatorOperation = (typeof OPERATOR_OPERATIONS)[number];

export type AdapterOperation = ModelOperation | InternalOperation | OperatorOperation;

export const ALL_OPERATIONS: readonly string[] = [
  ...MODEL_OPERATIONS,
  ...INTERNAL_OPERATIONS,
  ...OPERATOR_OPERATIONS,
];

export function isKnownOperation(value: string): value is AdapterOperation {
  return (ALL_OPERATIONS as readonly string[]).includes(value);
}

export const INTERNAL_OPERATION_SET: ReadonlySet<string> = new Set(INTERNAL_OPERATIONS);
export const OPERATOR_OPERATION_SET: ReadonlySet<string> = new Set(OPERATOR_OPERATIONS);

// ---------------------------------------------------------------------------
// Closed category → exactly-one-status vocabulary (§8.4)
// ---------------------------------------------------------------------------

export type EnvelopeStatus =
  | 'ok'
  | 'needs_confirmation'
  | 'blocked'
  | 'already_claimed'
  | 'unknown_outcome'
  | 'error';

export const ADAPTER_CATEGORIES = [
  'ok_analyze',
  'ok_draft',
  'ok_check',
  'needs_confirmation',
  'blocked_check',
  'blocked_preflight',
  'ok_submit_success',
  'blocked_submit',
  'already_claimed',
  'submit_start_failed',
  'unknown_outcome',
  'ok_metrics',
  'ok_cancelled',
  'ok_pending_status',
  'ok_reconciled',
  'no_pending',
  'pending_expired',
  'pending_replaced',
  'pending_consumed',
  'unknown_barrier',
  'usage_error',
  'unauthorized',
  'llm_offline',
  'llm_connectivity',
  'timeout',
  'error',
] as const;
export type AdapterCategory = (typeof ADAPTER_CATEGORIES)[number];

/** Plugin-only pre-adapter categories (no `formAgentExitCode`). */
export const PLUGIN_CATEGORIES = [
  'submit_denied',
  'submit_approval_timeout',
  'submit_approval_unavailable',
] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

export type AnyCategory = AdapterCategory | PluginCategory;

export const CATEGORY_STATUS: Readonly<Record<AnyCategory, EnvelopeStatus>> = {
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
  // Plugin-only
  submit_denied: 'blocked',
  submit_approval_timeout: 'blocked',
  submit_approval_unavailable: 'blocked',
};

export function statusForCategory(category: AnyCategory): EnvelopeStatus {
  return CATEGORY_STATUS[category];
}

// ---------------------------------------------------------------------------
// Shared closed submit terminal contract (Findings P/Q)
// ---------------------------------------------------------------------------

/** Frozen persistable unambiguous terminal categories + status/exit relation. */
export const TERMINAL_SUBMIT_CONTRACT: ReadonlyMap<string, { status: string; exitCode: number }> = new Map([
  ['ok_submit_success', { status: 'ok', exitCode: 0 }],
  ['blocked_submit', { status: 'blocked', exitCode: 3 }],
  ['already_claimed', { status: 'already_claimed', exitCode: 3 }],
  ['usage_error', { status: 'error', exitCode: 2 }],
]);

/** The single already-claimed stable proof code. */
export const ALREADY_CLAIMED_CODE = 'SUBMISSION_ALREADY_CLAIMED';
export const SUBMISSION_CONFIRMED_CODE = 'SUBMISSION_CONFIRMED';
export const OPERATOR_PATTERN_SOURCE = /^telegram:[0-9]{1,20}$/;

export interface TerminalDataIdentity {
  planId?: string;
  targetDisplay?: string;
  operator?: string;
}

const TERMINAL_DATA_KEYS: Readonly<Record<string, readonly string[]>> = {
  ok_submit_success: [
    'runId',
    'planId',
    'targetDisplay',
    'fingerprint',
    'receiptState',
    'submitAttempted',
    'outcome',
    'outcomeCode',
    'operator',
    'consistencySoftIssues',
  ],
  blocked_submit: ['errorCode'],
  already_claimed: ['errorCode'],
  usage_error: ['errorCode'],
};

const TERMINAL_HASH_PATTERN = /^[0-9a-f]{64}$/;
const TERMINAL_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const MAX_TERMINAL_STRING = 256;
const MAX_TERMINAL_DATA_BYTES = 4096;
const FORBIDDEN_TERMINAL_KEYS: ReadonlySet<string> = new Set([
  'answers',
  'draftAnswers',
  'planReview',
  'rawHtml',
  'html',
  'bundle_json',
  'secret',
  'token',
  'password',
  'apiKey',
  'authorization',
]);

function isTerminalRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTerminalCleanString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.length <= MAX_TERMINAL_STRING &&
    !TERMINAL_CONTROL_CHARS.test(value)
  );
}

/**
 * THE single closed submit terminal-data validator (Finding Q).
 *
 * Enforces exact per-category keys + types + the frozen semantic constants, and
 * (when supplied) binds the approved identity fields. No null placeholders.
 */
export function validateTerminalData(
  category: string,
  data: unknown,
  identity: TerminalDataIdentity = {},
): boolean {
  if (!isTerminalRecord(data)) return false;
  const expectedKeys = TERMINAL_DATA_KEYS[category];
  if (expectedKeys === undefined) return false;
  const keys = Object.keys(data);
  if (keys.length !== expectedKeys.length) return false;
  for (const key of keys) {
    if (!expectedKeys.includes(key)) return false;
    if (FORBIDDEN_TERMINAL_KEYS.has(key)) return false;
  }

  if (category === 'ok_submit_success') {
    const runId = data['runId'];
    const planId = data['planId'];
    const targetDisplay = data['targetDisplay'];
    const fingerprint = data['fingerprint'];
    const operator = data['operator'];
    if (typeof runId !== 'number' || !Number.isInteger(runId) || runId <= 0) return false;
    if (typeof planId !== 'string' || !TERMINAL_HASH_PATTERN.test(planId)) return false;
    if (!isTerminalCleanString(targetDisplay)) return false;
    if (typeof fingerprint !== 'string' || !TERMINAL_HASH_PATTERN.test(fingerprint)) return false;
    if (data['receiptState'] !== 'success') return false;
    if (data['submitAttempted'] !== true) return false;
    if (data['outcome'] !== 'success') return false;
    if (data['outcomeCode'] !== SUBMISSION_CONFIRMED_CODE) return false;
    if (typeof operator !== 'string' || !OPERATOR_PATTERN_SOURCE.test(operator)) return false;
    const softIssues = data['consistencySoftIssues'];
    if (typeof softIssues !== 'number' || !Number.isInteger(softIssues) || softIssues < 0) return false;
    if (identity.planId !== undefined && planId !== identity.planId) return false;
    if (identity.targetDisplay !== undefined && targetDisplay !== identity.targetDisplay) return false;
    if (identity.operator !== undefined && operator !== identity.operator) return false;
  } else {
    const errorCode = data['errorCode'];
    if (!isTerminalCleanString(errorCode)) return false;
    if (category === 'already_claimed' && errorCode !== ALREADY_CLAIMED_CODE) return false;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return false;
  }
  return Buffer.byteLength(serialized, 'utf8') <= MAX_TERMINAL_DATA_BYTES;
}

/** Exact field-by-field equality over the frozen closed key set (Finding Q). */
export function terminalDataEquals(category: string, a: unknown, b: unknown): boolean {
  const keys = TERMINAL_DATA_KEYS[category];
  if (keys === undefined) return false;
  if (!isTerminalRecord(a) || !isTerminalRecord(b)) return false;
  if (Object.keys(a).length !== keys.length || Object.keys(b).length !== keys.length) return false;
  for (const key of keys) {
    if (!(key in a) || !(key in b)) return false;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** Exact completed-unambiguous result key set. */
const COMPLETED_RESULT_KEYS: ReadonlySet<string> = new Set([
  'category',
  'status',
  'formAgentExitCode',
  'pendingId',
  'attemptId',
  'planId',
  'targetDisplay',
  'data',
  'pending',
]);

/** Structural validation (no trusted identity equality). */
export function validateCompletedResultShape(value: unknown): boolean {
  if (!isTerminalRecord(value)) return false;
  if (Object.keys(value).length !== COMPLETED_RESULT_KEYS.size) return false;
  for (const key of Object.keys(value)) {
    if (!COMPLETED_RESULT_KEYS.has(key)) return false;
  }
  const category = value['category'];
  if (typeof category !== 'string') return false;
  const contract = TERMINAL_SUBMIT_CONTRACT.get(category);
  if (contract === undefined) return false;
  if (value['status'] !== contract.status) return false;
  if (value['formAgentExitCode'] !== contract.exitCode) return false;
  if (typeof value['pendingId'] !== 'string' || !PENDING_REF_PATTERN.test(value['pendingId'])) return false;
  if (typeof value['attemptId'] !== 'string' || !HEX_32_PATTERN.test(value['attemptId'])) return false;
  if (typeof value['planId'] !== 'string' || !PLAN_ID_PATTERN.test(value['planId'])) return false;
  if (!isTerminalCleanString(value['targetDisplay'])) return false;
  if (!validateTerminalData(category, value['data'])) return false;
  if (value['pending'] !== null) return false;
  return true;
}

export interface CompletedResultIdentity {
  pendingId: string;
  planId: string;
  targetDisplay: string;
  operator: string;
  attemptId: string;
}

/**
 * THE single strict completed-unambiguous result validator consumed by both the
 * PendingStore semantic validation and the plugin trust boundary (Finding C).
 */
export function validateCompletedSubmitResult(
  value: unknown,
  identity: CompletedResultIdentity,
): boolean {
  if (!validateCompletedResultShape(value)) return false;
  const record = value as Record<string, unknown>;
  if (record['pendingId'] !== identity.pendingId) return false;
  if (record['planId'] !== identity.planId) return false;
  if (record['targetDisplay'] !== identity.targetDisplay) return false;
  if (record['attemptId'] !== identity.attemptId) return false;
  const category = record['category'] as string;
  return validateTerminalData(category, record['data'], {
    planId: identity.planId,
    targetDisplay: identity.targetDisplay,
    operator: identity.operator,
  });
}

// ---------------------------------------------------------------------------
// Pending shapes (§8.3)
// ---------------------------------------------------------------------------

export type PendingStoreStatus =
  | 'pending'
  | 'claimed'
  | 'start_failed'
  | 'consumed_unknown'
  | 'completed_unambiguous';

/** Model/user-facing, smaller safe shape. Never `targetKey`/`targetArg`/answers. */
export interface PendingSummary {
  pendingId: string;
  planId: string;
  targetDisplay: string;
  expiresAtMs: number;
  status: PendingStoreStatus;
}

/** Internal / plugin-facing only. Adds `targetKey` for the approval snapshot. */
export interface PendingApprovalView extends PendingSummary {
  targetKey: string;
}

// ---------------------------------------------------------------------------
// Adapter envelope (§8.3, §8.5)
// ---------------------------------------------------------------------------

export interface AdapterEnvelope {
  version: string;
  operation: string;
  status: EnvelopeStatus;
  category: AnyCategory;
  formAgentExitCode: number | null;
  message: string;
  data: Record<string, unknown>;
  pending: PendingSummary | null;
}

export interface BuildEnvelopeInput {
  operation: string;
  category: AnyCategory;
  message: string;
  data?: Record<string, unknown>;
  pending?: PendingSummary | null;
  formAgentExitCode?: number | null;
}

export function buildEnvelope(input: BuildEnvelopeInput): AdapterEnvelope {
  return {
    version: ADAPTER_VERSION,
    operation: input.operation,
    status: statusForCategory(input.category),
    category: input.category,
    formAgentExitCode: input.formAgentExitCode ?? null,
    message: input.message,
    data: input.data ?? {},
    pending: input.pending ?? null,
  };
}

// ---------------------------------------------------------------------------
// Model operation-parameter matrix (§6.1.1)
// ---------------------------------------------------------------------------

export interface ModelOperationParams {
  operation: ModelOperation;
  target?: string;
  draftProvider?: string;
  reviewAnswers?: boolean;
  since?: string;
  until?: string;
}

export type ParamValidation =
  | { ok: true; value: ModelOperationParams }
  | { ok: false; code: 'usage_error' };

const KNOWN_FIELDS = ['operation', 'target', 'draftProvider', 'reviewAnswers', 'since', 'until'] as const;

const MATRIX: Readonly<Record<ModelOperation, Readonly<Record<string, 'required' | 'optional' | 'forbidden'>>>> = {
  analyze: { target: 'required', draftProvider: 'forbidden', reviewAnswers: 'forbidden', since: 'forbidden', until: 'forbidden' },
  draft: { target: 'required', draftProvider: 'optional', reviewAnswers: 'forbidden', since: 'forbidden', until: 'forbidden' },
  draft_review: { target: 'required', draftProvider: 'optional', reviewAnswers: 'forbidden', since: 'forbidden', until: 'forbidden' },
  check: { target: 'required', draftProvider: 'optional', reviewAnswers: 'forbidden', since: 'forbidden', until: 'forbidden' },
  preflight: { target: 'required', draftProvider: 'optional', reviewAnswers: 'optional', since: 'forbidden', until: 'forbidden' },
  metrics: { target: 'forbidden', draftProvider: 'forbidden', reviewAnswers: 'forbidden', since: 'optional', until: 'optional' },
  cancel_pending: { target: 'forbidden', draftProvider: 'forbidden', reviewAnswers: 'forbidden', since: 'forbidden', until: 'forbidden' },
};

/**
 * Validate a raw model-supplied `form_agent` parameter object against the
 * frozen AP matrix. Unknown fields are rejected; a known-but-invalid field is a
 * `usage_error` (never silently ignored). Raw values are never returned on
 * failure.
 */
export function validateModelParams(raw: unknown): ParamValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'usage_error' };
  const record = raw as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!(KNOWN_FIELDS as readonly string[]).includes(key)) return { ok: false, code: 'usage_error' };
  }

  const operationRaw = record['operation'];
  if (typeof operationRaw !== 'string' || !(MODEL_OPERATIONS as readonly string[]).includes(operationRaw)) {
    return { ok: false, code: 'usage_error' };
  }
  const operation = operationRaw as ModelOperation;
  const rules = MATRIX[operation];

  for (const field of KNOWN_FIELDS) {
    if (field === 'operation') continue;
    const present = record[field] !== undefined && record[field] !== null;
    const rule = rules[field] ?? 'forbidden';
    if (!present) {
      if (rule === 'required') return { ok: false, code: 'usage_error' };
      continue;
    }
    if (rule === 'forbidden') return { ok: false, code: 'usage_error' };
  }

  const out: ModelOperationParams = { operation };

  const targetRaw = record['target'];
  if (targetRaw !== undefined && targetRaw !== null) {
    if (typeof targetRaw !== 'string') return { ok: false, code: 'usage_error' };
    out.target = targetRaw;
  }

  const providerRaw = record['draftProvider'];
  if (providerRaw !== undefined && providerRaw !== null) {
    if (typeof providerRaw !== 'string') return { ok: false, code: 'usage_error' };
    out.draftProvider = providerRaw;
  }

  const reviewRaw = record['reviewAnswers'];
  if (reviewRaw !== undefined && reviewRaw !== null) {
    if (typeof reviewRaw !== 'boolean') return { ok: false, code: 'usage_error' };
    out.reviewAnswers = reviewRaw;
  }

  const sinceRaw = record['since'];
  if (sinceRaw !== undefined && sinceRaw !== null) {
    if (typeof sinceRaw !== 'string') return { ok: false, code: 'usage_error' };
    out.since = sinceRaw;
  }

  const untilRaw = record['until'];
  if (untilRaw !== undefined && untilRaw !== null) {
    if (typeof untilRaw !== 'string') return { ok: false, code: 'usage_error' };
    out.until = untilRaw;
  }

  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Input bounds (§7.4)
// ---------------------------------------------------------------------------

export type TargetValidation =
  | { ok: true; value: ValidatedTargetCommand }
  | { ok: false; code: 'usage_error' };

export interface ValidatedTargetCommand {
  targetKey: string;
  targetArg: string;
  targetDisplay: string;
  kind: TargetKind;
}

export type TargetSupport = 'analyze' | 'draft' | 'draft_review' | 'check' | 'preflight' | 'submit';

const TARGET_MATRIX: Readonly<Record<TargetSupport, ReadonlySet<TargetKind>>> = {
  analyze: new Set<TargetKind>(['fixture']),
  draft: new Set<TargetKind>(['fixture']),
  draft_review: new Set<TargetKind>(['fixture']),
  check: new Set<TargetKind>(['fixture']),
  preflight: new Set<TargetKind>(['fixture', 'google-forms']),
  submit: new Set<TargetKind>(['fixture', 'google-forms']),
};

export function targetKindAllowed(support: TargetSupport, kind: TargetKind): boolean {
  return TARGET_MATRIX[support].has(kind);
}

/**
 * Validate + canonicalize one model/plugin target string for a given operation.
 * Enforces: control-char rejection, trimmed non-empty, raw length bound,
 * canonicalize, allowed-kind check, and the 256-char cap on the canonical
 * `targetArg`/`targetDisplay` only (never on `targetKey`).
 */
export function validateTargetCommand(support: TargetSupport, raw: string): TargetValidation {
  if (typeof raw !== 'string') return { ok: false, code: 'usage_error' };
  if (hasControlChars(raw)) return { ok: false, code: 'usage_error' };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, code: 'usage_error' };
  if (trimmed.length > MAX_TARGET_INPUT_CHARS) return { ok: false, code: 'usage_error' };

  let canonical: CanonicalTarget;
  try {
    canonical = canonicalizeTarget(trimmed);
  } catch (err) {
    if (err instanceof TargetError) return { ok: false, code: 'usage_error' };
    throw err;
  }

  if (!targetKindAllowed(support, canonical.kind)) return { ok: false, code: 'usage_error' };

  // `targetArg` = the replayable canonical display; `targetDisplay` identical
  // for the accepted fixture/google-forms forms. The 256 cap applies to these
  // (AJ) — never to `targetKey`.
  const targetArg = canonical.display;
  const targetDisplay = canonical.display;
  if (targetArg.length > MAX_TARGET_DISPLAY_CHARS) return { ok: false, code: 'usage_error' };

  return {
    ok: true,
    value: { targetKey: canonical.key, targetArg, targetDisplay, kind: canonical.kind },
  };
}

/**
 * Re-check the full three-part canonical equality (AQ) for a stored pending.
 * A `targetArg` that gains query/fragment/userinfo and happens to canonicalize
 * back to the same key/display still fails because `targetArg !== targetDisplay`.
 */
export function recheckThreePartTarget(
  targetArg: string,
  targetKey: string,
  targetDisplay: string,
): boolean {
  let canonical: CanonicalTarget;
  try {
    canonical = canonicalizeTarget(targetArg);
  } catch {
    return false;
  }
  if (canonical.key !== targetKey) return false;
  if (canonical.display !== targetDisplay) return false;
  if (targetArg !== targetDisplay) return false;
  return true;
}

export function validateDraftProvider(raw: string, allowlist: readonly string[]): boolean {
  if (raw.length > MAX_DRAFT_PROVIDER_CHARS) return false;
  if (!DRAFT_PROVIDER_PATTERN.test(raw)) return false;
  return allowlist.includes(raw);
}

export function validateTimestampBound(raw: string): boolean {
  if (hasControlChars(raw)) return false;
  if (raw.length > MAX_TIMESTAMP_CHARS) return false;
  return parseIsoTimestamp(raw) !== null;
}

export function validatePendingRef(raw: string): boolean {
  return PENDING_REF_PATTERN.test(raw);
}

export function validatePlanId(raw: string): boolean {
  return PLAN_ID_PATTERN.test(raw);
}

export type Resolution = 'observed-submitted' | 'observed-not-submitted';

export function isResolution(value: string): value is Resolution {
  return value === 'observed-submitted' || value === 'observed-not-submitted';
}

export function generateSeed(): string {
  return randomBytes(16).toString('hex');
}

export function generatePendingId(): string {
  return randomBytes(16).toString('hex');
}

export function generateAttemptId(): string {
  return randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

export interface Principal {
  channel: 'telegram';
  accountId: string;
  senderId: string;
  conversationId?: string;
}

export interface PrincipalInput {
  channel?: string;
  accountId?: string;
  senderId?: string;
  conversationId?: string;
}

export type PrincipalValidation =
  | { ok: true; value: Principal }
  | { ok: false; code: 'unauthorized' };

/** Validate the adapter-argv principal shape (deployment-derived, never model input). */
export function validatePrincipalInput(input: PrincipalInput): PrincipalValidation {
  if (input.channel !== 'telegram') return { ok: false, code: 'unauthorized' };
  if (typeof input.accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(input.accountId)) {
    return { ok: false, code: 'unauthorized' };
  }
  if (typeof input.senderId !== 'string' || !SENDER_ID_PATTERN.test(input.senderId)) {
    return { ok: false, code: 'unauthorized' };
  }
  const principal: Principal = { channel: 'telegram', accountId: input.accountId, senderId: input.senderId };
  if (input.conversationId !== undefined && input.conversationId !== '') {
    if (!CONVERSATION_ID_PATTERN.test(input.conversationId)) return { ok: false, code: 'unauthorized' };
    principal.conversationId = input.conversationId;
  }
  return { ok: true, value: principal };
}

/** The bare principal keyed into the pending store (no conversation id). */
export type PendingPrincipal = OperatorPrincipal;

export function samePendingPrincipal(a: Principal, b: Principal): boolean {
  return a.channel === b.channel && a.accountId === b.accountId && a.senderId === b.senderId;
}

/** Single frozen deployment operator principal. */
export interface OperatorPrincipal {
  channel: 'telegram';
  accountId: string;
  senderId: string;
}

export type PrincipalMatch =
  | { ok: true }
  | { ok: false; code: 'unauthorized' };

/** Defense-in-depth adapter re-check against the single configured operator. */
export function matchOperatorPrincipal(configured: OperatorPrincipal, actual: Principal): PrincipalMatch {
  if (configured.channel !== 'telegram') return { ok: false, code: 'unauthorized' };
  if (!ACCOUNT_ID_PATTERN.test(configured.accountId)) return { ok: false, code: 'unauthorized' };
  if (!SENDER_ID_PATTERN.test(configured.senderId)) return { ok: false, code: 'unauthorized' };
  if (actual.channel !== configured.channel) return { ok: false, code: 'unauthorized' };
  if (actual.accountId !== configured.accountId) return { ok: false, code: 'unauthorized' };
  if (actual.senderId !== configured.senderId) return { ok: false, code: 'unauthorized' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Adapter deployment config (§14)
// ---------------------------------------------------------------------------

export interface AdapterTimeouts {
  analyzeMs?: number;
  draftMs?: number;
  checkMs?: number;
  preflightMs?: number;
  submitMs?: number;
  metricsMs?: number;
  statusMs?: number;
}

export interface AdapterConfig {
  adapterBinaryPath: string;
  formAgentBinaryPath: string;
  /**
   * REQUIRED deterministic Form Agent discovery context. The accepted loader
   * resolves relative DB paths (`database.directory`, default `.data`) against
   * the process cwd, so a fixed absolute cwd is what guarantees the adapter and
   * the operator's local authorization admin commands use the SAME database.
   * There is no incidental `process.cwd()` fallback.
   */
  formAgentCwd: string;
  /** Optional absolute explicit config path passed as `--config <path>`. */
  formAgentConfigPath?: string;
  dataDir: string;
  operatorPrincipal: OperatorPrincipal;
  allowedDraftProviders: string[];
  providerEnvNames: string[];
  timeouts?: AdapterTimeouts;
  maxOutputBytes?: number;
}

export type AdapterConfigValidation =
  | { ok: true; value: AdapterConfig }
  | { ok: false; code: 'usage_error' };

export const DEFAULT_ALLOWED_DRAFT_PROVIDERS = ['reference', 'openai-compatible'] as const;

export const OPERATION_TIMEOUTS: Readonly<Record<string, number>> = {
  analyze: 60_000,
  draft: 300_000,
  draft_review: 300_000,
  check: 300_000,
  preflight: 300_000,
  submit_pending: 300_000,
  metrics: 30_000,
  pending_status: 10_000,
  submit_status: 10_000,
  submit_ack: 10_000,
};

export function timeoutForOperation(config: AdapterConfig, operation: string): number {
  const overrides = config.timeouts ?? {};
  switch (operation) {
    case 'analyze':
      return overrides.analyzeMs ?? OPERATION_TIMEOUTS['analyze'] as number;
    case 'draft':
    case 'draft_review':
      return overrides.draftMs ?? OPERATION_TIMEOUTS['draft'] as number;
    case 'check':
      return overrides.checkMs ?? OPERATION_TIMEOUTS['check'] as number;
    case 'preflight':
      return overrides.preflightMs ?? OPERATION_TIMEOUTS['preflight'] as number;
    case 'submit_pending':
      return overrides.submitMs ?? OPERATION_TIMEOUTS['submit_pending'] as number;
    case 'metrics':
      return overrides.metricsMs ?? OPERATION_TIMEOUTS['metrics'] as number;
    case 'pending_status':
    case 'submit_status':
    case 'submit_ack':
      return overrides.statusMs ?? OPERATION_TIMEOUTS['pending_status'] as number;
    default:
      return OPERATION_TIMEOUTS['preflight'] as number;
  }
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/** Validate an untrusted adapter deployment config object (data-only, no secrets). */
export function validateAdapterConfig(raw: unknown): AdapterConfigValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'usage_error' };
  const record = raw as Record<string, unknown>;

  const str = (key: string): string | null => {
    const value = record[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };

  const adapterBinaryPath = str('adapterBinaryPath');
  const formAgentBinaryPath = str('formAgentBinaryPath');
  const dataDir = str('dataDir');
  if (adapterBinaryPath === null || formAgentBinaryPath === null || dataDir === null) {
    return { ok: false, code: 'usage_error' };
  }
  if (!isAbsolutePath(formAgentBinaryPath)) return { ok: false, code: 'usage_error' };
  // The data directory must be absolute so the pending store never lands in an
  // attacker-influenced cwd.
  if (!isAbsolutePath(dataDir)) return { ok: false, code: 'usage_error' };

  const opRaw = record['operatorPrincipal'];
  if (opRaw === null || typeof opRaw !== 'object' || Array.isArray(opRaw)) return { ok: false, code: 'usage_error' };
  const op = opRaw as Record<string, unknown>;
  if (op['channel'] !== 'telegram') return { ok: false, code: 'usage_error' };
  if (typeof op['accountId'] !== 'string' || !ACCOUNT_ID_PATTERN.test(op['accountId'])) return { ok: false, code: 'usage_error' };
  if (typeof op['senderId'] !== 'string' || !SENDER_ID_PATTERN.test(op['senderId'])) return { ok: false, code: 'usage_error' };

  const providersRaw = record['allowedDraftProviders'];
  let allowedDraftProviders: string[] = [...DEFAULT_ALLOWED_DRAFT_PROVIDERS];
  if (providersRaw !== undefined) {
    if (!Array.isArray(providersRaw) || providersRaw.length === 0) return { ok: false, code: 'usage_error' };
    const providers: string[] = [];
    for (const item of providersRaw) {
      if (typeof item !== 'string') return { ok: false, code: 'usage_error' };
      if (!DRAFT_PROVIDER_PATTERN.test(item)) return { ok: false, code: 'usage_error' };
      providers.push(item);
    }
    allowedDraftProviders = providers;
  }

  const envRaw = record['providerEnvNames'];
  let providerEnvNames: string[] = [];
  if (envRaw !== undefined) {
    if (!Array.isArray(envRaw) || envRaw.length > MAX_PROVIDER_ENV_NAMES) return { ok: false, code: 'usage_error' };
    const names: string[] = [];
    const seen = new Set<string>();
    for (const item of envRaw) {
      if (typeof item !== 'string' || !isAllowedProviderEnvName(item) || seen.has(item)) {
        return { ok: false, code: 'usage_error' };
      }
      seen.add(item);
      names.push(item);
    }
    providerEnvNames = names;
  }

  const formAgentConfigPath = str('formAgentConfigPath');
  const formAgentCwd = str('formAgentCwd');
  // The accepted loader resolves relative DB directories against cwd, so an
  // explicit config path alone still cannot pin the database. A fixed absolute
  // cwd is therefore REQUIRED; `formAgentConfigPath` is an optional absolute
  // explicit config override.
  if (formAgentCwd === null || !isAbsolutePath(formAgentCwd)) return { ok: false, code: 'usage_error' };
  if (formAgentConfigPath !== null && !isAbsolutePath(formAgentConfigPath)) return { ok: false, code: 'usage_error' };

  const config: AdapterConfig = {
    adapterBinaryPath,
    formAgentBinaryPath,
    formAgentCwd,
    dataDir,
    operatorPrincipal: {
      channel: 'telegram',
      accountId: op['accountId'],
      senderId: op['senderId'],
    },
    allowedDraftProviders,
    providerEnvNames,
  };
  if (formAgentConfigPath !== null) config.formAgentConfigPath = formAgentConfigPath;

  const timeoutsRaw = record['timeouts'];
  if (timeoutsRaw !== undefined && timeoutsRaw !== null) {
    if (typeof timeoutsRaw !== 'object' || Array.isArray(timeoutsRaw)) return { ok: false, code: 'usage_error' };
    config.timeouts = timeoutsRaw as AdapterTimeouts;
  }
  const maxOutputBytes = record['maxOutputBytes'];
  if (maxOutputBytes !== undefined) {
    if (typeof maxOutputBytes !== 'number' || !Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      return { ok: false, code: 'usage_error' };
    }
    config.maxOutputBytes = maxOutputBytes;
  }

  return { ok: true, value: config };
}

// ---------------------------------------------------------------------------
// Argv builders (§7.2, §14)
// ---------------------------------------------------------------------------

function withGlobalConfig(config: AdapterConfig): string[] {
  // The accepted CLI strips `--config <path>` from anywhere in argv (src/index.ts)
  // and all adapter-invoked Form Agent calls must resolve the SAME config/DB.
  if (config.formAgentConfigPath !== undefined) {
    return ['--config', config.formAgentConfigPath];
  }
  return [];
}

export function buildAnalyzeArgv(config: AdapterConfig, targetArg: string): string[] {
  return [...withGlobalConfig(config), 'analyze', targetArg, '--json'];
}

export function buildDraftArgv(
  config: AdapterConfig,
  targetArg: string,
  seed: string,
  draftProvider: string | undefined,
): string[] {
  const args = [...withGlobalConfig(config), 'draft', targetArg, '--seed', seed, '--json'];
  if (draftProvider !== undefined) args.push('--draft-provider', draftProvider);
  return args;
}

export function buildCheckArgv(
  config: AdapterConfig,
  targetArg: string,
  seed: string,
  draftProvider: string | undefined,
): string[] {
  const args = [...withGlobalConfig(config), 'check', targetArg, '--seed', seed, '--json'];
  if (draftProvider !== undefined) args.push('--draft-provider', draftProvider);
  return args;
}

export function buildPreflightArgv(
  config: AdapterConfig,
  targetArg: string,
  seed: string,
  draftProvider: string | undefined,
): string[] {
  // AU: preflight ALWAYS passes `--json --json-error`.
  const args = [...withGlobalConfig(config), 'run', targetArg, '--seed', seed, '--json', '--json-error'];
  if (draftProvider !== undefined) args.push('--draft-provider', draftProvider);
  return args;
}

export function buildSubmitArgv(
  config: AdapterConfig,
  pending: { targetArg: string; seed: string; planId: string },
  senderId: string,
): string[] {
  return [
    ...withGlobalConfig(config),
    'run',
    pending.targetArg,
    '--seed',
    pending.seed,
    '--submit',
    '--expect-plan',
    pending.planId,
    '--by',
    `telegram:${senderId}`,
    '--json',
    '--json-error',
  ];
}

export function buildMetricsArgv(
  config: AdapterConfig,
  since: string | undefined,
  until: string | undefined,
): string[] {
  const args = [...withGlobalConfig(config), 'metrics', 'export', '--format', 'json'];
  if (since !== undefined) args.push('--since', since);
  if (until !== undefined) args.push('--until', until);
  return args;
}
