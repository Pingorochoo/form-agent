/**
 * Deterministic rate policy (P2-R16, P2-R17).
 *
 * The rate layer evaluates allow/deny, stores durable counters/state, and
 * reports reason codes + deterministic retry-after information. It is a safety
 * limit, NOT anti-detection behavior: it never sleeps, never inserts random
 * waits, never imitates humans, never schedules batches, and never executes a
 * submission.
 *
 * Time is injected explicitly so tests never depend on wall-clock sleeps.
 */

import type { AppConfig } from '../config/schema.ts';
import type { FormAgentDatabase } from '../db/database.ts';
import type { PolicyReasonCode } from './reasons.ts';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export type RateEventKind = 'submission' | 'batch-start' | 'batch-end';

export interface RateConfig {
  delayBetweenSubmissionsMs: number;
  maxSubmissionsPerFormPerHour: number | undefined;
  maxSubmissionsPerFormPerDay: number | undefined;
  batchPauseSeconds: number | undefined;
  maxConcurrentBatches: number;
  jitterFactor: number;
}

export function rateConfigFrom(config: AppConfig): RateConfig {
  return {
    delayBetweenSubmissionsMs: config.rate.delayBetweenSubmissionsMs,
    maxSubmissionsPerFormPerHour: config.rate.maxSubmissionsPerFormPerHour,
    maxSubmissionsPerFormPerDay: config.rate.maxSubmissionsPerFormPerDay,
    batchPauseSeconds: config.rate.batchPauseSeconds,
    maxConcurrentBatches: config.rate.maxConcurrentBatches,
    jitterFactor: config.rate.jitterFactor,
  };
}

/** Pure snapshot of rate state for one target, at one moment. */
export interface RateState {
  lastSubmissionAtMs: number | null;
  submissionsLastHour: number;
  submissionsLastDay: number;
  oldestSubmissionLastHourMs: number | null;
  oldestSubmissionLastDayMs: number | null;
  lastBatchAtMs: number | null;
  openBatchCount: number;
}

export interface RateDecision {
  allowed: boolean;
  /** Stable reason codes; empty when allowed. */
  reasons: PolicyReasonCode[];
  /**
   * Deterministic retry-after in ms: the time until ALL currently blocking
   * time-based gates can be clear (the maximum applicable remaining duration).
   */
  retryAfterMs: number | null;
}

function maxPositive(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * Evaluate the rate gate for a prospective submission at `nowMs`, using the
 * injected state. Purely deterministic; no I/O.
 */
export function evaluateRateGate(config: RateConfig, state: RateState, nowMs: number): RateDecision {
  const reasons: PolicyReasonCode[] = [];
  let retryAfterMs: number | null = null;

  // 1. Minimum delay since the previous accepted action.
  if (config.delayBetweenSubmissionsMs > 0 && state.lastSubmissionAtMs !== null) {
    const elapsed = nowMs - state.lastSubmissionAtMs;
    if (elapsed < config.delayBetweenSubmissionsMs) {
      reasons.push('MIN_DELAY_RATE_GATE');
      retryAfterMs = maxPositive(retryAfterMs, config.delayBetweenSubmissionsMs - elapsed);
    }
  }

  // 2. Per-form hourly cap.
  if (config.maxSubmissionsPerFormPerHour !== undefined && state.submissionsLastHour >= config.maxSubmissionsPerFormPerHour) {
    reasons.push('HOURLY_RATE_CAP');
    if (state.oldestSubmissionLastHourMs !== null) {
      retryAfterMs = maxPositive(retryAfterMs, state.oldestSubmissionLastHourMs + HOUR_MS - nowMs);
    }
  }

  // 3. Per-form daily cap.
  if (config.maxSubmissionsPerFormPerDay !== undefined && state.submissionsLastDay >= config.maxSubmissionsPerFormPerDay) {
    reasons.push('DAILY_RATE_CAP');
    if (state.oldestSubmissionLastDayMs !== null) {
      retryAfterMs = maxPositive(retryAfterMs, state.oldestSubmissionLastDayMs + DAY_MS - nowMs);
    }
  }

  // 4. Required pause between batches.
  if (config.batchPauseSeconds !== undefined && config.batchPauseSeconds > 0 && state.lastBatchAtMs !== null) {
    const pauseMs = config.batchPauseSeconds * 1000;
    const elapsed = nowMs - state.lastBatchAtMs;
    if (elapsed < pauseMs) {
      reasons.push('BATCH_PAUSE');
      retryAfterMs = maxPositive(retryAfterMs, pauseMs - elapsed);
    }
  }

  // 5. Concurrent-batch cap (not time-based; no retry-after).
  if (state.openBatchCount >= config.maxConcurrentBatches) {
    reasons.push('CONCURRENT_BATCH_CAP');
  }

  return { allowed: reasons.length === 0, reasons, retryAfterMs };
}

interface RateEventRow {
  target_key: string;
  kind: string;
  at_ms: number;
}

/**
 * Durable rate state, persisted in SQLite so caps/delays survive restarts.
 * Store methods are consumed by tests and future phases; they create no
 * executor, worker loop, or scheduler.
 */
export class RateStore {
  private readonly database: FormAgentDatabase;

  constructor(database: FormAgentDatabase) {
    this.database = database;
  }

  private insert(targetKey: string, kind: RateEventKind, atMs: number): void {
    this.database.db
      .prepare('INSERT INTO rate_events (target_key, kind, at_ms) VALUES (?, ?, ?)')
      .run(targetKey, kind, atMs);
  }

  recordSubmission(targetKey: string, atMs: number): void {
    this.insert(targetKey, 'submission', atMs);
  }

  recordBatchStart(targetKey: string, atMs: number): void {
    this.insert(targetKey, 'batch-start', atMs);
  }

  recordBatchEnd(targetKey: string, atMs: number): void {
    this.insert(targetKey, 'batch-end', atMs);
  }

  /**
   * Count events of `kind` in the half-open rolling window `(sinceMs, upToMs]`:
   * strictly after `sinceMs` and up to and including `upToMs`. The strict lower
   * bound means an event exactly one window-length old is outside the window.
   */
  private countWindow(targetKey: string, kind: RateEventKind, sinceMs: number, upToMs: number): number {
    const row = this.database.db
      .prepare('SELECT COUNT(*) AS n FROM rate_events WHERE target_key = ? AND kind = ? AND at_ms > ? AND at_ms <= ?')
      .get(targetKey, kind, sinceMs, upToMs) as { n: number };
    return row.n;
  }

  /** Oldest event timestamp in the half-open rolling window `(sinceMs, upToMs]`. */
  private oldestWindow(targetKey: string, kind: RateEventKind, sinceMs: number, upToMs: number): number | null {
    const row = this.database.db
      .prepare('SELECT MIN(at_ms) AS m FROM rate_events WHERE target_key = ? AND kind = ? AND at_ms > ? AND at_ms <= ?')
      .get(targetKey, kind, sinceMs, upToMs) as { m: number | null };
    return row.m;
  }

  /** Latest event timestamp of any listed kind, up to and including `upToMs`. */
  private lastEventUpTo(targetKey: string, kinds: RateEventKind[], upToMs: number): number | null {
    const placeholders = kinds.map(() => '?').join(', ');
    const row = this.database.db
      .prepare(
        `SELECT MAX(at_ms) AS m FROM rate_events WHERE target_key = ? AND kind IN (${placeholders}) AND at_ms <= ?`,
      )
      .get(targetKey, ...kinds, upToMs) as { m: number | null };
    return row.m;
  }

  /** Count events of `kind` up to and including `upToMs`. */
  private countUpTo(targetKey: string, kind: RateEventKind, upToMs: number): number {
    const row = this.database.db
      .prepare('SELECT COUNT(*) AS n FROM rate_events WHERE target_key = ? AND kind = ? AND at_ms <= ?')
      .get(targetKey, kind, upToMs) as { n: number };
    return row.n;
  }

  /**
   * Build a pure `RateState` snapshot as of `nowMs`: future events (at_ms >
   * nowMs) do not affect lastSubmissionAtMs, lastBatchAtMs, openBatchCount, or
   * the rolling window counts/oldest timestamps.
   */
  getState(targetKey: string, nowMs: number): RateState {
    const hourStart = nowMs - HOUR_MS;
    const dayStart = nowMs - DAY_MS;

    const starts = this.countUpTo(targetKey, 'batch-start', nowMs);
    const ends = this.countUpTo(targetKey, 'batch-end', nowMs);

    return {
      lastSubmissionAtMs: this.lastEventUpTo(targetKey, ['submission'], nowMs),
      submissionsLastHour: this.countWindow(targetKey, 'submission', hourStart, nowMs),
      submissionsLastDay: this.countWindow(targetKey, 'submission', dayStart, nowMs),
      oldestSubmissionLastHourMs: this.oldestWindow(targetKey, 'submission', hourStart, nowMs),
      oldestSubmissionLastDayMs: this.oldestWindow(targetKey, 'submission', dayStart, nowMs),
      lastBatchAtMs: this.lastEventUpTo(targetKey, ['batch-start', 'batch-end'], nowMs),
      openBatchCount: Math.max(0, starts - ends),
    };
  }

  /** List raw events for a target (test/debug aid; not an execution path). */
  listEvents(targetKey: string): RateEventRow[] {
    return this.database.db
      .prepare('SELECT target_key, kind, at_ms FROM rate_events WHERE target_key = ? ORDER BY id')
      .all(targetKey) as RateEventRow[];
  }
}
