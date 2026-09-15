/**
 * Phase 2 deterministic rate-policy tests (P2-R16, P2-R17).
 *
 * The gate evaluates allow/deny against injected timestamps (no wall-clock
 * sleeps) and persists state in SQLite so limits survive restarts.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FormAgentDatabase } from '../src/db/database.ts';
import { parseConfig } from '../src/config/schema.ts';
import { evaluateRateGate, RateStore, type RateConfig, type RateState } from '../src/policy/rate.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

function emptyState(): RateState {
  return {
    lastSubmissionAtMs: null,
    submissionsLastHour: 0,
    submissionsLastDay: 0,
    oldestSubmissionLastHourMs: null,
    oldestSubmissionLastDayMs: null,
    lastBatchAtMs: null,
    openBatchCount: 0,
  };
}

const BASE_CONFIG: RateConfig = {
  delayBetweenSubmissionsMs: 0,
  maxSubmissionsPerFormPerHour: undefined,
  maxSubmissionsPerFormPerDay: undefined,
  batchPauseSeconds: undefined,
  maxConcurrentBatches: 1,
  jitterFactor: 0,
};

describe('evaluateRateGate — deterministic decisions', () => {
  it('allows when no gate triggers', () => {
    const decision = evaluateRateGate(BASE_CONFIG, emptyState(), 1_000_000);
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.retryAfterMs).toBeNull();
  });

  it('denies on minimum delay and reports deterministic retry-after', () => {
    const config: RateConfig = { ...BASE_CONFIG, delayBetweenSubmissionsMs: 30_000 };
    const state: RateState = { ...emptyState(), lastSubmissionAtMs: 0 };
    const decision = evaluateRateGate(config, state, 10_000);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('MIN_DELAY_RATE_GATE');
    expect(decision.retryAfterMs).toBe(20_000);
  });

  it('denies on the per-form hourly cap', () => {
    const config: RateConfig = { ...BASE_CONFIG, maxSubmissionsPerFormPerHour: 1 };
    const state: RateState = {
      ...emptyState(),
      submissionsLastHour: 1,
      oldestSubmissionLastHourMs: 5_000,
    };
    const decision = evaluateRateGate(config, state, 5_000);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('HOURLY_RATE_CAP');
    expect(decision.retryAfterMs).toBe(HOUR); // 5000 + 1h - 5000
  });

  it('denies on the per-form daily cap', () => {
    const config: RateConfig = { ...BASE_CONFIG, maxSubmissionsPerFormPerDay: 2 };
    const state: RateState = {
      ...emptyState(),
      submissionsLastDay: 2,
      oldestSubmissionLastDayMs: 10_000,
    };
    const decision = evaluateRateGate(config, state, 10_000);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('DAILY_RATE_CAP');
    expect(decision.retryAfterMs).toBe(DAY);
  });

  it('denies on batch pause', () => {
    const config: RateConfig = { ...BASE_CONFIG, batchPauseSeconds: 10 };
    const state: RateState = { ...emptyState(), lastBatchAtMs: 0 };
    const decision = evaluateRateGate(config, state, 2_000);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('BATCH_PAUSE');
    expect(decision.retryAfterMs).toBe(8_000);
  });

  it('denies on the concurrent-batch cap (not time-based)', () => {
    const config: RateConfig = { ...BASE_CONFIG, maxConcurrentBatches: 1 };
    const state: RateState = { ...emptyState(), openBatchCount: 1 };
    const decision = evaluateRateGate(config, state, 1_000_000);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('CONCURRENT_BATCH_CAP');
    expect(decision.retryAfterMs).toBeNull();
  });

  it('accumulates multiple blocking reasons and reports the maximum retry-after', () => {
    const config: RateConfig = {
      ...BASE_CONFIG,
      delayBetweenSubmissionsMs: 30_000,
      maxSubmissionsPerFormPerHour: 1,
    };
    const state: RateState = {
      ...emptyState(),
      lastSubmissionAtMs: 0,
      submissionsLastHour: 1,
      oldestSubmissionLastHourMs: 2_000,
    };
    const decision = evaluateRateGate(config, state, 1_000);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('MIN_DELAY_RATE_GATE');
    expect(decision.reasons).toContain('HOURLY_RATE_CAP');
    // max(30000 - 1000, 2000 + 1h - 1000) = max(29000, 3601000) = 3601000
    expect(decision.retryAfterMs).toBe(3_601_000);
  });

  it('reports retry-after as the time until all time-based gates clear', () => {
    // Hourly cap clears far later than the minimum delay; retrying at the
    // minimum delay would still be denied, so retry-after must be the hourly
    // clearing time.
    const config: RateConfig = {
      ...BASE_CONFIG,
      delayBetweenSubmissionsMs: 30_000,
      maxSubmissionsPerFormPerHour: 1,
    };
    const state: RateState = {
      ...emptyState(),
      lastSubmissionAtMs: 0,
      submissionsLastHour: 1,
      oldestSubmissionLastHourMs: 2_000,
    };
    const decision = evaluateRateGate(config, state, 1_000);
    expect(decision.retryAfterMs).toBeGreaterThan(config.delayBetweenSubmissionsMs - 1_000);
    expect(decision.retryAfterMs).toBe(2_000 + HOUR - 1_000);
  });
});

describe('rate configuration validation (P2-R16)', () => {
  it('rejects negative delays and caps', () => {
    expect(() => parseConfig({ rate: { delayBetweenSubmissionsMs: -1 } })).toThrow();
    expect(() => parseConfig({ rate: { maxSubmissionsPerFormPerHour: -5 } })).toThrow();
    expect(() => parseConfig({ rate: { maxSubmissionsPerFormPerDay: -1 } })).toThrow();
    expect(() => parseConfig({ rate: { batchPauseSeconds: -1 } })).toThrow();
  });

  it('rejects invalid concurrency and jitter factor', () => {
    expect(() => parseConfig({ rate: { maxConcurrentBatches: 0 } })).toThrow();
    expect(() => parseConfig({ rate: { maxConcurrentBatches: -1 } })).toThrow();
    expect(() => parseConfig({ rate: { jitterFactor: -0.1 } })).toThrow();
    expect(() => parseConfig({ rate: { jitterFactor: 1.5 } })).toThrow();
  });

  it('preserves documented defaults', () => {
    const config = parseConfig({});
    expect(config.rate.delayBetweenSubmissionsMs).toBe(30_000);
    expect(config.rate.maxConcurrentBatches).toBe(1);
    expect(config.rate.jitterFactor).toBe(0);
    expect(config.rate.maxSubmissionsPerFormPerHour).toBeUndefined();
    expect(config.rate.maxSubmissionsPerFormPerDay).toBeUndefined();
    expect(config.rate.batchPauseSeconds).toBeUndefined();
  });

  it('rejects invalid safety mode', () => {
    expect(() => parseConfig({ safety: { mode: 'production' } })).toThrow();
  });
});

describe('RateStore — durable state (P2-R17)', () => {
  it('survives a database reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-rate-'));
    const targetKey = 'fixture:demo';

    const first = FormAgentDatabase.open({ directory: dir, filename: 'rate.db' });
    const store1 = new RateStore(first);
    store1.recordSubmission(targetKey, 1_000);
    store1.recordSubmission(targetKey, 2_000);
    first.close();

    const second = FormAgentDatabase.open({ directory: dir, filename: 'rate.db' });
    try {
      const store2 = new RateStore(second);
      const state = store2.getState(targetKey, 10_000);
      expect(state.lastSubmissionAtMs).toBe(2_000);
      expect(state.submissionsLastHour).toBe(2);
      expect(state.submissionsLastDay).toBe(2);
    } finally {
      second.close();
    }
  });

  it('computes state from persisted events for the gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-rate-int-'));
    const db = FormAgentDatabase.open({ directory: dir, filename: 'rate.db' });
    try {
      const store = new RateStore(db);
      const targetKey = 'fixture:demo';
      store.recordSubmission(targetKey, 1_000);
      store.recordSubmission(targetKey, 2_000);

      const config: RateConfig = { ...BASE_CONFIG, maxSubmissionsPerFormPerHour: 1 };
      const state = store.getState(targetKey, 10_000);
      const decision = evaluateRateGate(config, state, 10_000);
      expect(decision.allowed).toBe(false);
      expect(decision.reasons).toContain('HOURLY_RATE_CAP');
    } finally {
      db.close();
    }
  });

  it('tracks open batches for the concurrent-batch cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-rate-batch-'));
    const db = FormAgentDatabase.open({ directory: dir, filename: 'rate.db' });
    try {
      const store = new RateStore(db);
      const targetKey = 'fixture:demo';
      store.recordBatchStart(targetKey, 1_000);
      const state = store.getState(targetKey, 5_000);
      expect(state.openBatchCount).toBe(1);
      expect(state.lastBatchAtMs).toBe(1_000);

      store.recordBatchEnd(targetKey, 2_000);
      const after = store.getState(targetKey, 5_000);
      expect(after.openBatchCount).toBe(0);
      expect(after.lastBatchAtMs).toBe(2_000);
    } finally {
      db.close();
    }
  });
});

describe('RateStore snapshot boundaries (P2-R17)', () => {
  it('excludes an event exactly one hour old from the hourly window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-rate-boundary-h-'));
    const db = FormAgentDatabase.open({ directory: dir, filename: 'rate.db' });
    try {
      const store = new RateStore(db);
      const targetKey = 'fixture:demo';
      const now = 10_000_000;
      store.recordSubmission(targetKey, now - HOUR);
      const state = store.getState(targetKey, now);
      expect(state.submissionsLastHour).toBe(0);
      const config: RateConfig = { ...BASE_CONFIG, maxSubmissionsPerFormPerHour: 1 };
      const decision = evaluateRateGate(config, state, now);
      expect(decision.reasons).not.toContain('HOURLY_RATE_CAP');
    } finally {
      db.close();
    }
  });

  it('excludes an event exactly one day old from the daily window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-rate-boundary-d-'));
    const db = FormAgentDatabase.open({ directory: dir, filename: 'rate.db' });
    try {
      const store = new RateStore(db);
      const targetKey = 'fixture:demo';
      const now = 10_000_000;
      store.recordSubmission(targetKey, now - DAY);
      const state = store.getState(targetKey, now);
      expect(state.submissionsLastDay).toBe(0);
      const config: RateConfig = { ...BASE_CONFIG, maxSubmissionsPerFormPerDay: 1 };
      const decision = evaluateRateGate(config, state, now);
      expect(decision.reasons).not.toContain('DAILY_RATE_CAP');
    } finally {
      db.close();
    }
  });

  it('counts an event just inside the window with a positive retry-after', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-rate-boundary-inside-'));
    const db = FormAgentDatabase.open({ directory: dir, filename: 'rate.db' });
    try {
      const store = new RateStore(db);
      const targetKey = 'fixture:demo';
      const now = 10_000_000;
      store.recordSubmission(targetKey, now - HOUR + 1);
      const state = store.getState(targetKey, now);
      expect(state.submissionsLastHour).toBe(1);
      const config: RateConfig = { ...BASE_CONFIG, maxSubmissionsPerFormPerHour: 1 };
      const decision = evaluateRateGate(config, state, now);
      expect(decision.reasons).toContain('HOURLY_RATE_CAP');
      expect(decision.retryAfterMs).toBe(1);
    } finally {
      db.close();
    }
  });

  it('future submissions do not affect lastSubmissionAtMs or counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-rate-future-sub-'));
    const db = FormAgentDatabase.open({ directory: dir, filename: 'rate.db' });
    try {
      const store = new RateStore(db);
      const targetKey = 'fixture:demo';
      const now = 10_000;
      store.recordSubmission(targetKey, 5_000);
      store.recordSubmission(targetKey, 20_000); // future
      const state = store.getState(targetKey, now);
      expect(state.lastSubmissionAtMs).toBe(5_000);
      expect(state.submissionsLastHour).toBe(1);
    } finally {
      db.close();
    }
  });

  it('future batch events do not affect lastBatchAtMs or openBatchCount', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-rate-future-batch-'));
    const db = FormAgentDatabase.open({ directory: dir, filename: 'rate.db' });
    try {
      const store = new RateStore(db);
      const targetKey = 'fixture:demo';
      const now = 10_000;
      store.recordBatchStart(targetKey, 5_000);
      store.recordBatchStart(targetKey, 20_000); // future
      const state = store.getState(targetKey, now);
      expect(state.openBatchCount).toBe(1);
      expect(state.lastBatchAtMs).toBe(5_000);
    } finally {
      db.close();
    }
  });
});
