/**
 * Phase 8 pending orchestration store (P8-R11, P8-R27).
 *
 * Atomic JSON orchestration state kept OUTSIDE the Form Agent database (no
 * migration, §18). One record per `(channel, accountId, senderId)`. The store
 * owns:
 *
 *   - a REAL cross-process, per-principal lock owned by the ACTING process: the
 *     parent opens the lock file and keeps the descriptor, a short-lived
 *     `flock -n <inherited-fd>` helper acquires the Linux `flock(2)` advisory
 *     lock on the SAME open-file-description and exits; the parent retains the
 *     kernel lock for the entire critical section and releases it by closing the
 *     descriptor. No timestamp/ctime ordering and no stale-lock delete/reclaim.
 *     OpenClaw launches the adapter as a subprocess per call, so an in-memory
 *     mutex cannot provide atomic claims;
 *   - atomic, mode-0600 writes (temp file + rename) inside that lock;
 *   - the 10-minute `pending` TTL;
 *   - immutable identity fields (including `expiresAtMs` — never extended);
 *   - the two-step ownership lifecycle: pre-spawn atomic `pending -> claimed`
 *     with REQUIRED `attemptId`/`claimedAtMs`/`ownerPid`, then a SECOND
 *     post-spawn update for `childPid`/`childProcessGroup`;
 *   - `start_failed` / `consumed_unknown` / `completed_unambiguous` transitions
 *     that are bound to the exact `pendingId` + `attemptId` (stale writers are
 *     no-ops);
 *   - conservative crash recovery: a leftover `claimed` record whose owning
 *     adapter process is provably gone normalizes to `consumed_unknown` (never
 *     auto-retried); a record owned by a live adapter process is left alone;
 *   - strict, status-aware runtime validation of every persisted record, so
 *     parseable-but-semantically-invalid JSON is `corrupt`;
 *   - `submit_status` READ/NORMALIZE with a durable missing-state barrier.
 *
 * The record is orchestration state only. It is never submission authority and
 * stores no answers/HTML/secrets/provider payloads.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { canonicalizeTarget } from '../policy/target.ts';
import {
  ACCOUNT_ID_PATTERN,
  CONVERSATION_ID_PATTERN,
  PENDING_TTL_MS,
  SENDER_ID_PATTERN,
  generateAttemptId,
  generatePendingId,
  validateCompletedSubmitResult,
  type PendingApprovalView,
  type PendingPrincipal,
  type PendingStoreStatus,
  type PendingSummary,
} from './contracts.ts';

export type { PendingStoreStatus } from './contracts.ts';

export interface PendingRecord {
  version: 1;
  pendingId: string;
  principal: PendingPrincipal;
  conversationId?: string;
  targetKey: string;
  targetArg: string;
  targetDisplay: string;
  planId: string;
  seed: string;
  operator: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: PendingStoreStatus;
  /** Required in the same atomic transition that sets `claimed`. */
  attemptId?: string;
  claimedAtMs?: number;
  /**
   * OS pid of the adapter process that owns an in-flight claim. Used to
   * distinguish a live cross-process attempt from a true crash leftover.
   */
  ownerPid?: number;
  /** Post-spawn ownership metadata; `'unavailable'` when not persisted. */
  childPid?: number | 'unavailable';
  childProcessGroup?: number | 'unavailable';
  reason?: string;
  /** Bounded, replayable terminal handoff for `completed_unambiguous`. */
  result?: CompletedResult;
  /** True when this record is a recovery tombstone with no observed target. */
  recoveryTombstone?: boolean;
}

export interface CompletedResult {
  category: string;
  status: string;
  formAgentExitCode: number | null;
  pendingId: string;
  attemptId: string;
  planId: string;
  targetDisplay: string;
  data: Record<string, unknown>;
  pending: PendingSummary | null;
}

export type PendingErrorCode =
  | 'NO_PENDING'
  | 'UNKNOWN_BARRIER'
  | 'PENDING_CONSUMED'
  | 'PENDING_REPLACED'
  | 'PENDING_EXPIRED'
  | 'CORRUPT_STATE';

export class PendingError extends Error {
  readonly code: PendingErrorCode;
  constructor(code: PendingErrorCode, message: string) {
    super(message);
    this.name = 'PendingError';
    this.code = code;
  }
}

export class BarrierPersistenceError extends PendingError {
  constructor(message: string) {
    super('CORRUPT_STATE', message);
    this.name = 'BarrierPersistenceError';
  }
}

export interface PendingStoreOptions {
  dataDir: string;
  clock?: () => number;
  /** Test seam: override the OS pid recorded as the claim owner. */
  processId?: number;
  /** Test seam: override process-liveness detection. */
  isPidAlive?: (pid: number) => boolean;
  /** Cross-process lock acquisition timeout (ms). */
  lockTimeoutMs?: number;
  /** Cross-process lock poll interval (ms). */
  lockPollMs?: number;
  /** Test seam: absolute path to the flock(1) binary. */
  flockBinaryPath?: string;
}

export interface CreatePendingInput {
  principal: PendingPrincipal;
  conversationId?: string;
  targetKey: string;
  targetArg: string;
  targetDisplay: string;
  planId: string;
  seed: string;
  operator: string;
  ttlMs?: number;
}

export interface ClaimExpected {
  pendingRef: string;
  planId: string;
  targetKey: string;
  targetDisplay: string;
  expiresAtMs: number;
}

export interface RecoveryResultView {
  category: string;
  status: string;
  formAgentExitCode: number | null;
  data: Record<string, unknown>;
  pending: PendingSummary | null;
  /** Identity binding of a replayed terminal handoff (set by `viewFor`). */
  pendingId?: string;
  planId?: string;
  attemptId?: string;
  targetDisplay?: string;
}

export type RecoveryState =
  | 'none'
  | 'pending'
  | 'claimed'
  | 'start_failed'
  | 'consumed_unknown'
  | 'completed_unambiguous';

export interface RecoveryView {
  state: RecoveryState;
  pendingId?: string;
  attemptId?: string;
  planId?: string;
  reason?: string;
  result?: RecoveryResultView;
}

export interface SubmitStatusOptions {
  pendingRef?: string;
  planId?: string;
  /** True when the caller is recovering a KNOWN approved submit invocation. */
  recoverKnownApproved?: boolean;
}

export interface ReconcileOutcome {
  pendingId: string;
  previousStatus: PendingStoreStatus;
  resolution: string;
  resultingStatus: string;
}

interface RawRead {
  record: PendingRecord | null;
  corrupt: boolean;
}

// ---------------------------------------------------------------------------
// Strict status-aware record validation (Finding C)
// ---------------------------------------------------------------------------

const PENDING_ID_PATTERN = /^[0-9a-f]{32}$/;
const PLAN_ID_PATTERN = /^[0-9a-f]{64}$/;
const SEED_PATTERN = /^[0-9a-f]{32}$/;
const ATTEMPT_ID_PATTERN = /^[0-9a-f]{32}$/;
const OPERATOR_PATTERN = /^telegram:[0-9]{1,20}$/;
const MAX_TARGET_FIELD = 256;
const MAX_TARGET_KEY = 4096;
const MAX_REASON = 128;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

const RECOVERY_TOMBSTONE_REASONS: ReadonlySet<string> = new Set([
  'adapter_state_missing_or_inconsistent',
  'adapter_state_corrupt',
  'recovery_identity_mismatch',
]);

const ALLOWED_RECORD_KEYS: ReadonlySet<string> = new Set([
  'version',
  'pendingId',
  'principal',
  'conversationId',
  'targetKey',
  'targetArg',
  'targetDisplay',
  'planId',
  'seed',
  'operator',
  'createdAtMs',
  'expiresAtMs',
  'status',
  'attemptId',
  'claimedAtMs',
  'ownerPid',
  'childPid',
  'childProcessGroup',
  'reason',
  'result',
  'recoveryTombstone',
]);

const ALLOWED_SUMMARY_KEYS: ReadonlySet<string> = new Set([
  'pendingId',
  'planId',
  'targetDisplay',
  'expiresAtMs',
  'status',
]);

/** Closed persisted `PendingSummary` shape used by any non-null pending field. */
export function validatePendingSummary(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !ALLOWED_SUMMARY_KEYS.has(key))) return false;
  if (typeof value['pendingId'] !== 'string' || !PENDING_ID_PATTERN.test(value['pendingId'])) return false;
  if (typeof value['planId'] !== 'string' || !PLAN_ID_PATTERN.test(value['planId'])) return false;
  if (!isCleanString(value['targetDisplay'], MAX_TARGET_FIELD)) return false;
  if (!isFiniteInt(value['expiresAtMs'])) return false;
  if (!isPendingStatus(value['status'])) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

function isCleanString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  if (typeof value !== 'string') return false;
  if (!allowEmpty && value === '') return false;
  if (value.length > maxLength) return false;
  return !CONTROL_CHARS.test(value);
}

function isPrincipal(value: unknown): value is PendingPrincipal {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3) return false;
  if (!(keys.includes('channel') && keys.includes('accountId') && keys.includes('senderId'))) return false;
  if (value['channel'] !== 'telegram') return false;
  if (typeof value['accountId'] !== 'string' || !ACCOUNT_ID_PATTERN.test(value['accountId'])) return false;
  if (typeof value['senderId'] !== 'string' || !SENDER_ID_PATTERN.test(value['senderId'])) return false;
  return true;
}

function samePrincipal(a: PendingPrincipal, b: PendingPrincipal): boolean {
  return a.channel === b.channel && a.accountId === b.accountId && a.senderId === b.senderId;
}

function isPendingStatus(value: unknown): value is PendingStoreStatus {
  return (
    value === 'pending' ||
    value === 'claimed' ||
    value === 'start_failed' ||
    value === 'consumed_unknown' ||
    value === 'completed_unambiguous'
  );
}

function validChildRef(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === 'unavailable') return true;
  return isFiniteInt(value) && value > 0;
}

function validateCompletedResult(
  value: unknown,
  binding: { pendingId: string; attemptId: string; planId: string; targetDisplay: string; operator: string },
): boolean {
  return validateCompletedSubmitResult(value, {
    pendingId: binding.pendingId,
    planId: binding.planId,
    targetDisplay: binding.targetDisplay,
    operator: binding.operator,
    attemptId: binding.attemptId,
  });
}

/**
 * Full three-part stored replay invariant (Finding G):
 *   canonicalizeTarget(targetArg).key === targetKey
 *   canonicalizeTarget(targetArg).display === targetDisplay
 *   targetArg === targetDisplay
 * Recovery tombstones are exempt (they carry intentionally empty identity).
 */
function replayTargetValid(targetArg: unknown, targetKey: unknown, targetDisplay: unknown): boolean {
  if (typeof targetArg !== 'string' || typeof targetKey !== 'string' || typeof targetDisplay !== 'string') {
    return false;
  }
  let canonical;
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

function validateNormalRecord(record: Record<string, unknown>, expected: PendingPrincipal): boolean {
  const status = record['status'];
  if (!isPendingStatus(status)) return false;
  if (typeof record['pendingId'] !== 'string' || !PENDING_ID_PATTERN.test(record['pendingId'])) return false;
  const principal = record['principal'];
  if (!isPrincipal(principal) || !samePrincipal(principal, expected)) return false;
  if (!isCleanString(record['targetKey'], MAX_TARGET_KEY)) return false;
  if (!isCleanString(record['targetArg'], MAX_TARGET_FIELD)) return false;
  if (!isCleanString(record['targetDisplay'], MAX_TARGET_FIELD)) return false;
  // Full three-part replay invariant; a tampered record is not semantically valid.
  if (!replayTargetValid(record['targetArg'], record['targetKey'], record['targetDisplay'])) return false;
  if (typeof record['planId'] !== 'string' || !PLAN_ID_PATTERN.test(record['planId'])) return false;
  if (typeof record['seed'] !== 'string' || !SEED_PATTERN.test(record['seed'])) return false;
  if (typeof record['operator'] !== 'string' || !OPERATOR_PATTERN.test(record['operator'])) return false;
  const createdAtMs = record['createdAtMs'];
  const expiresAtMs = record['expiresAtMs'];
  if (!isFiniteInt(createdAtMs) || createdAtMs < 0) return false;
  if (!isFiniteInt(expiresAtMs) || expiresAtMs < 0) return false;
  if (expiresAtMs <= createdAtMs) return false;
  if (record['conversationId'] !== undefined) {
    if (typeof record['conversationId'] !== 'string' || !CONVERSATION_ID_PATTERN.test(record['conversationId'])) {
      return false;
    }
  }
  if (!validChildRef(record['childPid']) || !validChildRef(record['childProcessGroup'])) return false;

  const attemptId = record['attemptId'];
  const claimedAtMs = record['claimedAtMs'];
  const ownerPid = record['ownerPid'];
  const reason = record['reason'];
  const result = record['result'];
  const hasAttempt = typeof attemptId === 'string' && ATTEMPT_ID_PATTERN.test(attemptId);
  const hasClaimedAt = isFiniteInt(claimedAtMs) && claimedAtMs >= 0;
  const hasOwner = isFiniteInt(ownerPid) && ownerPid > 0;

  switch (status) {
    case 'pending':
      if (attemptId !== undefined || claimedAtMs !== undefined || ownerPid !== undefined) return false;
      if (result !== undefined || reason !== undefined) return false;
      if (record['childPid'] !== undefined || record['childProcessGroup'] !== undefined) return false;
      return true;
    case 'claimed':
      if (!hasAttempt || !hasClaimedAt || !hasOwner) return false;
      if ((claimedAtMs as number) < createdAtMs) return false;
      if (result !== undefined || reason !== undefined) return false;
      return true;
    case 'start_failed':
      if (!hasAttempt || !hasClaimedAt || !hasOwner) return false;
      if (record['childPid'] !== undefined && record['childPid'] !== 'unavailable') return false;
      if (record['childProcessGroup'] !== undefined && record['childProcessGroup'] !== 'unavailable') return false;
      if (result !== undefined) return false;
      return true;
    case 'consumed_unknown':
      if (!hasAttempt || !hasClaimedAt || !hasOwner) return false;
      if (!isCleanString(reason, MAX_REASON)) return false;
      if (result !== undefined) return false;
      return true;
    case 'completed_unambiguous':
      if (!hasAttempt || !hasClaimedAt || !hasOwner) return false;
      if (
        !validateCompletedResult(result, {
          pendingId: record['pendingId'] as string,
          attemptId: attemptId as string,
          planId: record['planId'] as string,
          targetDisplay: record['targetDisplay'] as string,
          operator: `telegram:${principal.senderId}`,
        })
      ) {
        return false;
      }
      if (reason !== undefined && !isCleanString(reason, MAX_REASON)) return false;
      return true;
  }
}

function validateRecoveryTombstone(record: Record<string, unknown>, expected: PendingPrincipal): boolean {
  if (record['status'] !== 'consumed_unknown' || record['recoveryTombstone'] !== true) return false;
  if (typeof record['pendingId'] !== 'string' || !PENDING_ID_PATTERN.test(record['pendingId'])) return false;
  const principal = record['principal'];
  if (!isPrincipal(principal) || !samePrincipal(principal, expected)) return false;
  if (record['targetKey'] !== '' || record['targetArg'] !== '' || record['targetDisplay'] !== '') return false;
  const planId = record['planId'];
  if (!(planId === '' || (typeof planId === 'string' && PLAN_ID_PATTERN.test(planId)))) return false;
  if (record['seed'] !== '' || record['operator'] !== '') return false;
  const createdAtMs = record['createdAtMs'];
  const expiresAtMs = record['expiresAtMs'];
  if (!isFiniteInt(createdAtMs) || createdAtMs < 0) return false;
  if (!isFiniteInt(expiresAtMs) || expiresAtMs < createdAtMs) return false;
  if (record['attemptId'] !== 'unavailable') return false;
  if (!isFiniteInt(record['claimedAtMs'])) return false;
  if (typeof record['reason'] !== 'string' || !RECOVERY_TOMBSTONE_REASONS.has(record['reason'])) return false;
  if (record['result'] !== undefined) return false;
  if (record['childPid'] !== undefined || record['childProcessGroup'] !== undefined) return false;
  if (record['ownerPid'] !== undefined) return false;
  if (record['conversationId'] !== undefined) return false;
  return true;
}

/**
 * Strict status-aware parser. Returns the record only when it is structurally
 * and semantically valid for its status and bound to `expected` principal.
 */
export function parsePendingRecord(value: unknown, expected: PendingPrincipal): PendingRecord | null {
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) {
    if (!ALLOWED_RECORD_KEYS.has(key)) return null;
  }
  if (value['version'] !== 1) return null;
  if (typeof value['pendingId'] !== 'string' || !PENDING_ID_PATTERN.test(value['pendingId'])) return null;
  if (!isPrincipal(value['principal']) || !samePrincipal(value['principal'], expected)) return null;
  if (value['recoveryTombstone'] === true) {
    return validateRecoveryTombstone(value, expected) ? (value as unknown as PendingRecord) : null;
  }
  if ('recoveryTombstone' in value) return null;
  return validateNormalRecord(value, expected) ? (value as unknown as PendingRecord) : null;
}

// ---------------------------------------------------------------------------
// Cross-process per-principal lock (Finding A)
// ---------------------------------------------------------------------------

/** True when a PID exists from this process's point of view. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err) {
      return (err as { code?: unknown }).code === 'EPERM';
    }
    return false;
  }
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

/** Resolve the util-linux `flock(1)` binary for the co-located Linux host. */
const FLOCK_CANDIDATES = ['/usr/bin/flock', '/bin/flock', '/usr/local/bin/flock'] as const;

function resolveFlockBinary(override?: string): string {
  if (override !== undefined && override !== '') {
    if (existsSync(override)) return override;
    throw new PendingError('CORRUPT_STATE', `configured flock binary not found: ${override}`);
  }
  for (const candidate of FLOCK_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new PendingError('CORRUPT_STATE', 'flock(1) is required for cross-process locking but was not found');
}

/** Child fd number that carries the parent's inherited lock descriptor. */
const LOCK_CHILD_FD = 3;

export interface ProcessLockOptions {
  timeoutMs: number;
  pollMs: number;
  /** Test seam: absolute path to the flock(1) binary. */
  flockBinaryPath?: string;
}

/**
 * Genuine cross-process per-principal mutex backed by the Linux kernel
 * `flock(2)` advisory lock (via util-linux `flock(1)`), OWNED BY THE PARENT
 * PROCESS for the entire critical-section lifetime.
 *
 * The parent opens the lock file and keeps the descriptor. A short-lived helper
 * inherits that exact descriptor (`stdio[3] = fd`, i.e. a `dup2` onto the SAME
 * Linux open-file-description) and runs `flock -n 3`; it exits immediately after
 * acquiring. Because `flock(2)` locks are associated with the open-file-
 * description — not the process that called `flock` — the kernel lock remains
 * held by the parent's retained descriptor after the helper exits. The parent
 * owns the lock for the whole JS closure and releases it with `closeSync(fd)`.
 *
 * Consequences:
 *   - the helper is NOT a lock holder; its death after acquisition cannot
 *     release the lock while the parent's descriptor stays open;
 *   - a parent crash closes the descriptor and the kernel releases the lock;
 *   - a second process cannot acquire while the parent holds the descriptor;
 *   - no timestamp/ctime/mtime/random-token ordering is used anywhere;
 *   - no stale-lock path deletion/reclaim exists;
 *   - EVERY helper invocation is itself HARD-bounded: `spawnSync` is called with
 *     `timeout = remaining lock budget` and `killSignal: 'SIGKILL'`, so even a
 *     helper that ignores SIGTERM is killed and acquisition fails closed within
 *     the configured bound; a helper timeout/error closes the parent descriptor
 *     and never mutates state.
 */
export function acquireProcessLock(lockFile: string, options: ProcessLockOptions): () => void {
  const flockBinary = resolveFlockBinary(options.flockBinaryPath);
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });

  let fd: number;
  try {
    // Open (creating if needed) the canonical lock file. This descriptor — and
    // therefore the open-file-description the kernel lock attaches to — is kept
    // by THIS process for the whole critical section.
    fd = openSync(lockFile, 'a+', 0o600);
  } catch (err) {
    throw new PendingError(
      'CORRUPT_STATE',
      `failed to open pending lock file: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }

  const deadline = Date.now() + options.timeoutMs;
  const release = (): void => {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  };

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new PendingError('CORRUPT_STATE', 'timed out acquiring pending lock');
      }
      // `spawnSync` enforces `timeout` by killing the child with `killSignal`
      // (SIGKILL) and only returns once it has actually exited, so even a helper
      // that ignores SIGTERM cannot exceed the remaining acquisition budget.
      const result = spawnSync(flockBinary, ['-n', String(LOCK_CHILD_FD)], {
        // fd 3 in the child is a dup2 of the parent's descriptor => same OFD.
        stdio: ['ignore', 'ignore', 'ignore', fd],
        timeout: remaining,
        killSignal: 'SIGKILL',
      });
      if (result.error !== undefined) {
        // Includes ETIMEDOUT: the helper was killed at the bound. Fail closed.
        throw new PendingError(
          'CORRUPT_STATE',
          `flock helper did not complete within the acquisition bound: ${result.error.message}`,
        );
      }
      if (result.status === 0) {
        // Kernel lock now held on the shared OFD; the parent's `fd` owns it.
        return release;
      }
      if (Date.now() >= deadline) {
        throw new PendingError('CORRUPT_STATE', 'timed out acquiring pending lock');
      }
      sleepSync(options.pollMs);
    }
  } catch (err) {
    release();
    if (err instanceof PendingError) throw err;
    throw new PendingError(
      'CORRUPT_STATE',
      `failed to acquire pending lock: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}

export function principalKey(principal: PendingPrincipal): string {
  return [principal.channel, principal.accountId, principal.senderId].join('\u0000');
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/** Exact on-disk path of a principal's bounded orchestration record (test seam). */
export function pendingFilePath(dataDir: string, principal: PendingPrincipal): string {
  return join(dataDir, 'openclaw-pending', `pending-${hashKey(principalKey(principal))}.json`);
}

/** Exact on-disk cross-process lock FILE for a principal (test seam). */
export function lockPathFor(baseDir: string, principal: PendingPrincipal): string {
  return join(baseDir, 'openclaw-locks', `pending-${hashKey(principalKey(principal))}.lock`);
}

export class PendingStore {
  private readonly baseDir: string;
  private readonly dataDir: string;
  private readonly clock: () => number;
  private readonly processId: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;
  private readonly flockBinaryPath: string | undefined;

  constructor(options: PendingStoreOptions) {
    this.baseDir = options.dataDir;
    this.dataDir = join(options.dataDir, 'openclaw-pending');
    this.clock = options.clock ?? (() => Date.now());
    this.processId = options.processId ?? process.pid;
    this.isAlive = options.isPidAlive ?? isPidAlive;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.lockPollMs = options.lockPollMs ?? 5;
    this.flockBinaryPath = options.flockBinaryPath;
  }

  private ensureDir(): void {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
  }

  private pathFor(principal: PendingPrincipal): string {
    return join(this.dataDir, `pending-${hashKey(principalKey(principal))}.json`);
  }

  private lockFileFor(principal: PendingPrincipal): string {
    return lockPathFor(this.baseDir, principal);
  }

  /**
   * Serialize every read/check/write state transition for one principal across
   * separate OS adapter processes sharing the same data directory.
   */
  private withProcessLock<T>(principal: PendingPrincipal, fn: () => T): T {
    this.ensureDir();
    const release = acquireProcessLock(this.lockFileFor(principal), {
      timeoutMs: this.lockTimeoutMs,
      pollMs: this.lockPollMs,
      ...(this.flockBinaryPath !== undefined ? { flockBinaryPath: this.flockBinaryPath } : {}),
    });
    try {
      return fn();
    } finally {
      release();
    }
  }

  private readRawFile(principal: PendingPrincipal): RawRead {
    const path = this.pathFor(principal);
    if (!existsSync(path)) return { record: null, corrupt: false };
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const record = parsePendingRecord(parsed, principal);
      if (record === null) return { record: null, corrupt: true };
      return { record, corrupt: false };
    } catch {
      return { record: null, corrupt: true };
    }
  }

  private writeRecord(principal: PendingPrincipal, record: PendingRecord): void {
    this.ensureDir();
    const path = this.pathFor(principal);
    const tmp = `${path}.tmp-${process.pid}-${generatePendingId()}`;
    writeFileSync(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  }

  private removeRecord(principal: PendingPrincipal): void {
    const path = this.pathFor(principal);
    if (existsSync(path)) rmSync(path, { force: true });
  }

  /**
   * Normalize a leftover `claimed` record whose owning adapter process is
   * provably gone (crash recovery). Covers both crash windows: claim-before-
   * spawn and spawn-before-PID-persist. A record owned by a LIVE adapter
   * process is returned untouched. Never auto-retried.
   */
  private normalizeIfLeftoverClaimed(principal: PendingPrincipal, record: PendingRecord): PendingRecord {
    if (record.status !== 'claimed') return record;
    const owner = record.ownerPid;
    if (typeof owner === 'number' && this.isAlive(owner)) return record;
    const normalized: PendingRecord = {
      ...record,
      status: 'consumed_unknown',
      reason: record.reason ?? 'leftover_claimed_after_restart',
    };
    this.writeRecord(principal, normalized);
    return normalized;
  }

  /** Read + normalize the current record (crash recovery applied). */
  read(principal: PendingPrincipal): PendingRecord | null {
    return this.withProcessLock(principal, () => this.readUnlocked(principal));
  }

  private readUnlocked(principal: PendingPrincipal): PendingRecord | null {
    const raw = this.readRawFile(principal);
    if (raw.corrupt || raw.record === null) return null;
    return this.normalizeIfLeftoverClaimed(principal, raw.record);
  }

  /** Read raw without normalization; throws when persisted state is invalid. */
  private mustReadRaw(principal: PendingPrincipal): PendingRecord | null {
    const raw = this.readRawFile(principal);
    if (raw.corrupt) throw new PendingError('CORRUPT_STATE', 'pending orchestration state is corrupt');
    return raw.record;
  }

  isCorrupt(principal: PendingPrincipal): boolean {
    return this.readRawFile(principal).corrupt;
  }

  /**
   * Barrier status for new preflight/cancel. `consumed_unknown` and an
   * unacknowledged `completed_unambiguous` (and a still-`claimed` record) block.
   * Throws `CORRUPT_STATE` for semantically invalid persisted state so callers
   * fail closed BEFORE invoking Form Agent.
   */
  barrier(principal: PendingPrincipal): { status: PendingStoreStatus; pendingId: string } | null {
    return this.withProcessLock(principal, () => this.barrierUnlocked(principal));
  }

  private barrierUnlocked(principal: PendingPrincipal): { status: PendingStoreStatus; pendingId: string } | null {
    const raw = this.readRawFile(principal);
    if (raw.corrupt) throw new PendingError('CORRUPT_STATE', 'pending orchestration state is corrupt');
    if (raw.record === null) return null;
    const record = this.normalizeIfLeftoverClaimed(principal, raw.record);
    if (record.status === 'consumed_unknown' || record.status === 'completed_unambiguous' || record.status === 'claimed') {
      return { status: record.status, pendingId: record.pendingId };
    }
    return null;
  }

  toSummary(record: PendingRecord): PendingSummary {
    return {
      pendingId: record.pendingId,
      planId: record.planId,
      targetDisplay: record.targetDisplay,
      expiresAtMs: record.expiresAtMs,
      status: record.status,
    };
  }

  toApprovalView(record: PendingRecord): PendingApprovalView {
    return {
      pendingId: record.pendingId,
      planId: record.planId,
      targetKey: record.targetKey,
      targetDisplay: record.targetDisplay,
      expiresAtMs: record.expiresAtMs,
      status: record.status,
    };
  }

  /**
   * Create a new pending record. Refuses while a barrier (`consumed_unknown`,
   * unacknowledged `completed_unambiguous`, or `claimed`) is present. Replaces
   * a `pending` or `start_failed` record. Never extends an existing TTL.
   */
  create(input: CreatePendingInput): PendingRecord {
    return this.withProcessLock(input.principal, () => {
      const barrier = this.barrierUnlocked(input.principal);
      if (barrier !== null) {
        throw new PendingError('UNKNOWN_BARRIER', `principal has an unresolved ${barrier.status} record`);
      }
      const now = this.clock();
      const ttl = input.ttlMs ?? PENDING_TTL_MS;
      const record: PendingRecord = {
        version: 1,
        pendingId: generatePendingId(),
        principal: input.principal,
        targetKey: input.targetKey,
        targetArg: input.targetArg,
        targetDisplay: input.targetDisplay,
        planId: input.planId,
        seed: input.seed,
        operator: input.operator,
        createdAtMs: now,
        expiresAtMs: now + ttl,
        status: 'pending',
      };
      if (input.conversationId !== undefined) record.conversationId = input.conversationId;
      this.writeRecord(input.principal, record);
      return record;
    });
  }

  /**
   * Cancel ONLY a `pending` record. Never clears `start_failed`, `claimed`,
   * `consumed_unknown`, or an unacknowledged `completed_unambiguous`.
   */
  cancel(principal: PendingPrincipal): { pendingId: string } {
    return this.withProcessLock(principal, () => {
      const record = this.mustReadRaw(principal);
      if (record === null) throw new PendingError('NO_PENDING', 'no pending record');
      if (record.status === 'consumed_unknown' || record.status === 'completed_unambiguous' || record.status === 'claimed') {
        throw new PendingError('UNKNOWN_BARRIER', `cannot cancel a ${record.status} record`);
      }
      if (record.status !== 'pending') throw new PendingError('PENDING_CONSUMED', `cannot cancel a ${record.status} record`);
      const pendingId = record.pendingId;
      this.removeRecord(principal);
      return { pendingId };
    });
  }

  /**
   * Pre-spawn atomic claim. Validates exact identity+expiry, re-checks the
   * full three-part target equality, then persists status `claimed` with the
   * REQUIRED `attemptId` + `claimedAtMs` + `ownerPid` in ONE atomic write under
   * the cross-process lock. Only one caller can ever obtain submit authority.
   */
  claim(
    principal: PendingPrincipal,
    expected: ClaimExpected,
    recheckTarget: (targetArg: string, targetKey: string, targetDisplay: string) => boolean,
  ): PendingRecord {
    return this.withProcessLock(principal, () => {
      const record = this.mustReadRaw(principal);
      if (record === null) throw new PendingError('NO_PENDING', 'no pending record');
      if (record.status === 'consumed_unknown' || record.status === 'completed_unambiguous') {
        throw new PendingError('UNKNOWN_BARRIER', `principal has an unresolved ${record.status} record`);
      }
      if (record.status !== 'pending') throw new PendingError('PENDING_CONSUMED', `pending is ${record.status}`);
      if (record.pendingId !== expected.pendingRef) throw new PendingError('PENDING_REPLACED', 'pending ref mismatch');
      if (record.planId !== expected.planId) throw new PendingError('PENDING_REPLACED', 'plan mismatch');
      if (record.targetKey !== expected.targetKey) throw new PendingError('PENDING_REPLACED', 'target key mismatch');
      if (record.targetDisplay !== expected.targetDisplay) throw new PendingError('PENDING_REPLACED', 'target display mismatch');
      if (record.expiresAtMs !== expected.expiresAtMs) throw new PendingError('PENDING_REPLACED', 'expiry mismatch');
      if (this.clock() >= record.expiresAtMs) throw new PendingError('PENDING_EXPIRED', 'pending has expired');
      if (!recheckTarget(record.targetArg, record.targetKey, record.targetDisplay)) {
        throw new PendingError('PENDING_REPLACED', 'target replay equality failed');
      }

      const claimed: PendingRecord = {
        ...record,
        status: 'claimed',
        attemptId: generateAttemptId(),
        claimedAtMs: this.clock(),
        ownerPid: this.processId,
      };
      this.writeRecord(principal, claimed);
      return claimed;
    });
  }

  /** Second post-spawn atomic update: persist process ownership when available. */
  markStarted(
    principal: PendingPrincipal,
    pendingRef: string,
    attemptId: string,
    ownership: { childPid: number | 'unavailable'; childProcessGroup: number | 'unavailable' },
  ): void {
    this.withProcessLock(principal, () => {
      const record = this.mustReadRaw(principal);
      if (record === null || record.status !== 'claimed' || record.pendingId !== pendingRef) return;
      if (record.attemptId !== attemptId) return;
      this.writeRecord(principal, {
        ...record,
        childPid: ownership.childPid,
        childProcessGroup: ownership.childProcessGroup,
      });
    });
  }

  /** `claimed -> start_failed` for a pre-start spawn failure. Attempt-bound. */
  markStartFailed(principal: PendingPrincipal, pendingRef: string, attemptId: string): void {
    this.withProcessLock(principal, () => {
      const record = this.mustReadRaw(principal);
      if (record === null || record.pendingId !== pendingRef) return;
      if (record.attemptId !== attemptId) return;
      if (record.status !== 'claimed') return;
      this.writeRecord(principal, { ...record, status: 'start_failed' });
    });
  }

  /**
   * `claimed -> consumed_unknown` for a STARTED submit path. Requires the exact
   * `pendingId` + `attemptId`; a stale writer is a no-op. When no trustworthy
   * attemptId exists, use the `submit_status` recovery-tombstone path instead.
   */
  markConsumedUnknown(principal: PendingPrincipal, pendingRef: string, attemptId: string, reason: string): void {
    this.withProcessLock(principal, () => {
      const record = this.mustReadRaw(principal);
      if (record === null || record.pendingId !== pendingRef) return;
      if (record.attemptId !== attemptId) return;
      if (record.status === 'consumed_unknown') return;
      if (record.status !== 'claimed') return;
      this.writeRecord(principal, { ...record, status: 'consumed_unknown', reason });
    });
  }

  /**
   * Atomically persist a bounded `completed_unambiguous` terminal handoff.
   * Rejects a wrong/stale attempt and any illegal source state.
   */
  markCompletedUnambiguous(
    principal: PendingPrincipal,
    pendingRef: string,
    attemptId: string,
    result: RecoveryResultView,
  ): CompletedResult {
    return this.withProcessLock(principal, () => {
      const record = this.mustReadRaw(principal);
      if (record === null || record.pendingId !== pendingRef) {
        throw new PendingError('PENDING_CONSUMED', 'pending record disappeared during submit');
      }
      if (record.attemptId !== attemptId) {
        throw new PendingError('PENDING_REPLACED', 'stale submit attempt cannot complete');
      }
      if (record.status !== 'claimed') {
        throw new PendingError('PENDING_CONSUMED', `cannot complete from ${record.status}`);
      }
      const completed: PendingRecord = {
        ...record,
        status: 'completed_unambiguous',
        result: {
          category: result.category,
          status: result.status,
          formAgentExitCode: result.formAgentExitCode,
          pendingId: record.pendingId,
          attemptId,
          planId: record.planId,
          targetDisplay: record.targetDisplay,
          data: result.data,
          pending: result.pending,
        },
      };
      this.writeRecord(principal, completed);
      return completed.result as CompletedResult;
    });
  }

  /**
   * `submit_status` READ/NORMALIZE (BB-3). Never invokes Form Agent. Normalizes
   * a leftover `claimed` record, replays a valid `completed_unambiguous`, and
   * atomically creates/preserves a durable `consumed_unknown` recovery
   * tombstone when the state is absent/corrupt/inconsistent for a KNOWN
   * approved submit invocation.
   */
  submitStatus(principal: PendingPrincipal, options: SubmitStatusOptions = {}): RecoveryView {
    // Any failure to read/normalize/persist the recovery state (including an
    // un-acquirable cross-process lock) is a HARD recovery failure: the caller
    // must fail closed and must not treat it as proof that no submit occurred.
    try {
      return this.withProcessLock(principal, () => this.submitStatusLocked(principal, options));
    } catch (err) {
      if (err instanceof BarrierPersistenceError) throw err;
      throw new BarrierPersistenceError(
        `submit_status recovery read failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }

  private submitStatusLocked(principal: PendingPrincipal, options: SubmitStatusOptions): RecoveryView {
    const raw = this.readRawFile(principal);
    const pendingRef = options.pendingRef;
    const planId = options.planId;
    const knownApproved = options.recoverKnownApproved === true && pendingRef !== undefined;

    if (!raw.corrupt && raw.record !== null) {
      const record = this.normalizeIfLeftoverClaimed(principal, raw.record);
      if (knownApproved) {
        // Exact recovery identity: the record must match BOTH the approved
        // pendingRef and planId before any result may be considered.
        const identityMatches =
          record.pendingId === (pendingRef as string) && planId !== undefined && record.planId === planId;
        if (!identityMatches) {
          return this.establishRecoveryIdentityBarrier(principal, pendingRef as string, planId, record);
        }
      }
      return this.viewFor(record);
    }

    if (!knownApproved) {
      return { state: 'none' };
    }

    return this.persistRecoveryTombstone(principal, pendingRef as string, planId, {
      reason: raw.corrupt ? 'adapter_state_corrupt' : 'adapter_state_missing_or_inconsistent',
    });
  }

  /**
   * Inconsistent known-submit recovery identity (Finding F). Establish or
   * preserve a sticky conservative barrier for the principal. The mismatched
   * record is NEVER returned or replayed as the requested approved submit.
   */
  private establishRecoveryIdentityBarrier(
    principal: PendingPrincipal,
    pendingRef: string,
    planId: string | undefined,
    record: PendingRecord,
  ): RecoveryView {
    if (
      record.status === 'claimed' ||
      record.status === 'consumed_unknown' ||
      record.status === 'completed_unambiguous'
    ) {
      // Preserve the existing fail-closed barrier; never surface its terminal
      // result as the requested approved submit.
      return {
        state: 'consumed_unknown',
        pendingId: pendingRef,
        ...(planId !== undefined ? { planId } : {}),
        reason: 'recovery_identity_mismatch',
      };
    }
    return this.persistRecoveryTombstone(principal, pendingRef, planId, { reason: 'recovery_identity_mismatch' });
  }

  /** Atomically persist a durable `consumed_unknown` recovery tombstone. */
  private persistRecoveryTombstone(
    principal: PendingPrincipal,
    pendingRef: string,
    planId: string | undefined,
    options: { reason: string },
  ): RecoveryView {
    const now = this.clock();
    const tombstone: PendingRecord = {
      version: 1,
      pendingId: pendingRef,
      principal,
      targetKey: '',
      targetArg: '',
      targetDisplay: '',
      planId: planId ?? '',
      seed: '',
      operator: '',
      createdAtMs: now,
      expiresAtMs: now,
      status: 'consumed_unknown',
      attemptId: 'unavailable',
      claimedAtMs: now,
      reason: options.reason,
      recoveryTombstone: true,
    };
    try {
      this.writeRecord(principal, tombstone);
    } catch (err) {
      throw new BarrierPersistenceError(
        `failed to persist durable recovery barrier: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
    return {
      state: 'consumed_unknown',
      pendingId: tombstone.pendingId,
      attemptId: tombstone.attemptId ?? 'unavailable',
      planId: tombstone.planId,
      reason: tombstone.reason ?? 'adapter_state_missing_or_inconsistent',
    };
  }

  private viewFor(record: PendingRecord): RecoveryView {
    switch (record.status) {
      case 'completed_unambiguous': {
        const stored = record.result;
        if (stored === undefined || typeof stored.category !== 'string' || typeof stored.status !== 'string') {
          // Corrupt handoff: normalize conservatively to a durable barrier.
          this.writeRecord(record.principal, {
            ...record,
            status: 'consumed_unknown',
            reason: 'completed_handoff_corrupt',
          });
          return {
            state: 'consumed_unknown',
            pendingId: record.pendingId,
            ...(record.attemptId !== undefined ? { attemptId: record.attemptId } : {}),
            planId: record.planId,
            reason: 'completed_handoff_corrupt',
          };
        }
        return {
          state: 'completed_unambiguous',
          pendingId: record.pendingId,
          attemptId: stored.attemptId,
          planId: record.planId,
          result: {
            category: stored.category,
            status: stored.status,
            formAgentExitCode: stored.formAgentExitCode,
            data: stored.data,
            pending: stored.pending,
            pendingId: stored.pendingId,
            planId: stored.planId,
            attemptId: stored.attemptId,
            targetDisplay: stored.targetDisplay,
          },
        };
      }
      case 'consumed_unknown':
        return {
          state: 'consumed_unknown',
          pendingId: record.pendingId,
          ...(record.attemptId !== undefined ? { attemptId: record.attemptId } : {}),
          planId: record.planId,
          ...(record.reason !== undefined ? { reason: record.reason } : {}),
        };
      case 'claimed':
        return {
          state: 'claimed',
          pendingId: record.pendingId,
          ...(record.attemptId !== undefined ? { attemptId: record.attemptId } : {}),
          planId: record.planId,
        };
      case 'start_failed':
        return {
          state: 'start_failed',
          pendingId: record.pendingId,
          ...(record.attemptId !== undefined ? { attemptId: record.attemptId } : {}),
          planId: record.planId,
        };
      case 'pending':
      default:
        return { state: 'pending', pendingId: record.pendingId, planId: record.planId };
    }
  }

  /**
   * Idempotent internal ack. Clears ONLY a `completed_unambiguous` handoff that
   * matches `pendingRef` + `attemptId`. Never invokes Form Agent.
   */
  acknowledge(
    principal: PendingPrincipal,
    pendingRef: string,
    attemptId: string,
  ): { acked: boolean; idempotent: boolean } {
    return this.withProcessLock(principal, () => {
      const record = this.mustReadRaw(principal);
      if (record === null) return { acked: false, idempotent: true };
      if (record.status !== 'completed_unambiguous' || record.pendingId !== pendingRef) {
        return { acked: false, idempotent: false };
      }
      const storedAttempt = record.result?.attemptId ?? record.attemptId;
      if (storedAttempt !== attemptId) return { acked: false, idempotent: false };
      this.removeRecord(principal);
      return { acked: true, idempotent: false };
    });
  }

  /** Raw record for operator reconciliation (does not normalize). */
  peekRaw(principal: PendingPrincipal): PendingRecord | null {
    const raw = this.readRawFile(principal);
    return raw.corrupt ? null : raw.record;
  }

  /** Operator-only reconciliation outcome; clears an exact `consumed_unknown`. */
  reconcile(
    principal: PendingPrincipal,
    pendingRef: string,
    resolution: string,
    isLive: (record: PendingRecord) => boolean,
  ): ReconcileOutcome {
    return this.withProcessLock(principal, () => {
      const record = this.mustReadRaw(principal);
      if (record === null || record.pendingId !== pendingRef || record.status !== 'consumed_unknown') {
        throw new PendingError('NO_PENDING', 'no matching consumed_unknown record');
      }
      if (isLive(record)) {
        throw new PendingError('PENDING_CONSUMED', 'a prior submit child may still be live');
      }
      this.removeRecord(principal);
      return {
        pendingId: record.pendingId,
        previousStatus: record.status,
        resolution,
        resultingStatus: resolution === 'observed-submitted' ? 'resolved_submitted' : 'resolved_not_submitted',
      };
    });
  }
}

export { PENDING_TTL_MS };
