/**
 * Phase 7 deterministic aggregation tests (P7-R9, P7-R10b, P7-R14, P7-R15).
 *
 * Proves exact count/sum/min/max/avg, self-describing nullable token/latency
 * aggregates (null never 0), call-count-only LLM grouping, all-time submit
 * claim semantics, and inclusive/exclusive time boundaries.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FormAgentDatabase } from '../src/db/database.ts';
import { readAggregates, type MetricsAggregates, type MetricsRange } from '../src/metrics/aggregate.ts';
import { METRIC_EVENTS } from '../src/metrics/catalog.ts';

function makeDb(): FormAgentDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'form-agent-p7-agg-'));
  return FormAgentDatabase.open({ directory: dir, filename: 'agg.db' });
}

const ALL: MetricsRange = { sinceMs: null, untilMs: null };

function insertMetric(
  db: FormAgentDatabase,
  event: string,
  kind: string,
  valueNum: number | null,
  valueText: string | null,
  atMs: number,
): void {
  db.db
    .prepare('INSERT INTO metrics_events (event, kind, value_num, value_text, at_ms) VALUES (?, ?, ?, ?, ?)')
    .run(event, kind, valueNum, valueText, atMs);
}

function insertLlm(
  db: FormAgentDatabase,
  row: {
    providerId: string;
    model: string;
    stage: string;
    input: number | null;
    output: number | null;
    total: number | null;
    duration: number | null;
    status: string;
    createdAt: string;
  },
): void {
  db.db
    .prepare(
      `INSERT INTO llm_calls
         (provider_id, model, stage, input_tokens, output_tokens, total_tokens,
          duration_ms, finish_reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      row.providerId,
      row.model,
      row.stage,
      row.input,
      row.output,
      row.total,
      row.duration,
      row.status,
      row.createdAt,
    );
}

function insertReceipt(
  db: FormAgentDatabase,
  row: {
    key: string;
    state: string;
    submitAttempted: number;
    outcome: string | null;
    outcomeCode: string | null;
    createdAt: string;
    updatedAt: string;
  },
): void {
  db.db
    .prepare(
      `INSERT INTO execution_receipts
         (submission_key, target_key, target_display, plan_id, draft_id,
          consistency_report_id, fingerprint, provider_id, provider_version,
          state, submit_attempted, outcome, outcome_code, created_at, updated_at)
       VALUES (?, 't', 't', 'p', 'd', 'c', 'f', 'fixture', '1.0.0', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.key,
      row.state,
      row.submitAttempted,
      row.outcome,
      row.outcomeCode,
      row.createdAt,
      row.updatedAt,
    );
}

describe('P7-R14 — empty aggregates', () => {
  it('returns success-shaped empty aggregates with null (not 0) statistics', () => {
    const db = makeDb();
    try {
      const agg = readAggregates(db, ALL);
      expect(agg.metricsEvents.byEvent).toEqual([]);
      expect(agg.metricsEvents.statusCounts).toEqual([]);
      expect(agg.llmUsage.callCount).toBe(0);
      expect(agg.llmUsage.tokens.input).toEqual({ sum: null, observedCount: 0, missingCount: 0 });
      expect(agg.llmUsage.latencyMs).toEqual({
        min: null,
        max: null,
        avg: null,
        observedCount: 0,
        missingCount: 0,
      });
      expect(agg.llmUsage.byStatus).toEqual([]);
      expect(agg.llmUsage.byProvider).toEqual([]);
      expect(agg.llmUsage.byModel).toEqual([]);
      expect(agg.llmUsage.byStage).toEqual([]);
      expect(agg.executionOutcomes).toMatchObject({
        preflightCount: 0,
        submitClaimCount: 0,
        byState: [],
        byOutcome: [],
        byOutcomeCode: [],
      });
    } finally {
      db.close();
    }
  });
});

describe('P7-R14 — metrics event aggregates', () => {
  it('computes exact count/sum/min/max/avg and status counts', () => {
    const db = makeDb();
    try {
      for (const value of [10, 20, 30]) {
        insertMetric(db, METRIC_EVENTS.COMMAND_ANALYZE_DURATION, 'duration_ms', value, null, 1000);
      }
      insertMetric(db, METRIC_EVENTS.CONSISTENCY_STATUS, 'categorical', null, 'pass', 1000);
      insertMetric(db, METRIC_EVENTS.CONSISTENCY_STATUS, 'categorical', null, 'pass', 1001);
      insertMetric(db, METRIC_EVENTS.CONSISTENCY_STATUS, 'categorical', null, 'warn', 1002);

      const agg = readAggregates(db, ALL);
      const duration = agg.metricsEvents.byEvent.find(
        (row) => row.event === METRIC_EVENTS.COMMAND_ANALYZE_DURATION,
      );
      expect(duration).toEqual({
        event: METRIC_EVENTS.COMMAND_ANALYZE_DURATION,
        kind: 'duration_ms',
        count: 3,
        sum: 60,
        min: 10,
        max: 30,
        avg: 20,
      });
      expect(agg.metricsEvents.statusCounts).toEqual([
        { value: 'pass', count: 2 },
        { value: 'warn', count: 1 },
      ]);
    } finally {
      db.close();
    }
  });
});

describe('P7-R10b — nullable token/latency aggregates', () => {
  it('reports sum + observed + missing; all-NULL is null, a real zero is 0', () => {
    const db = makeDb();
    try {
      insertLlm(db, { providerId: 'p', model: 'm', stage: 's', input: null, output: null, total: null, duration: null, status: 'success', createdAt: '2026-01-01T00:00:00.000Z' });
      insertLlm(db, { providerId: 'p', model: 'm', stage: 's', input: 5, output: 0, total: 5, duration: 10, status: 'success', createdAt: '2026-01-01T00:00:01.000Z' });
      insertLlm(db, { providerId: 'q', model: 'm2', stage: 's', input: 0, output: 0, total: 0, duration: 30, status: 'error', createdAt: '2026-01-01T00:00:02.000Z' });

      const agg = readAggregates(db, ALL);
      expect(agg.llmUsage.callCount).toBe(3);
      expect(agg.llmUsage.tokens.input).toEqual({ sum: 5, observedCount: 2, missingCount: 1 });
      expect(agg.llmUsage.tokens.output).toEqual({ sum: 0, observedCount: 2, missingCount: 1 });
      expect(agg.llmUsage.tokens.total).toEqual({ sum: 5, observedCount: 2, missingCount: 1 });
      expect(agg.llmUsage.latencyMs).toEqual({ min: 10, max: 30, avg: 20, observedCount: 2, missingCount: 1 });
    } finally {
      db.close();
    }
  });

  it('never fabricates zero when nothing is observed', () => {
    const db = makeDb();
    try {
      insertLlm(db, { providerId: 'p', model: 'm', stage: 's', input: null, output: null, total: null, duration: null, status: 'error', createdAt: '2026-01-01T00:00:00.000Z' });
      const agg = readAggregates(db, ALL);
      expect(agg.llmUsage.tokens.input).toEqual({ sum: null, observedCount: 0, missingCount: 1 });
      expect(agg.llmUsage.latencyMs).toEqual({ min: null, max: null, avg: null, observedCount: 0, missingCount: 1 });
    } finally {
      db.close();
    }
  });
});

describe('P7-R10 — LLM grouping is call-count only', () => {
  it('groups by status/provider/model/stage with no token or latency fields', () => {
    const db = makeDb();
    try {
      insertLlm(db, { providerId: 'p', model: 'm', stage: 'semantics', input: 1, output: 1, total: 2, duration: 1, status: 'success', createdAt: '2026-01-01T00:00:00.000Z' });
      insertLlm(db, { providerId: 'p', model: 'm', stage: 'answer', input: 1, output: 1, total: 2, duration: 2, status: 'success', createdAt: '2026-01-01T00:00:01.000Z' });
      insertLlm(db, { providerId: 'q', model: 'm2', stage: 'answer', input: 1, output: 1, total: 2, duration: 3, status: 'error', createdAt: '2026-01-01T00:00:02.000Z' });

      const agg: MetricsAggregates = readAggregates(db, ALL);
      expect(agg.llmUsage.byStatus).toEqual([
        { status: 'error', count: 1 },
        { status: 'success', count: 2 },
      ]);
      expect(agg.llmUsage.byProvider).toEqual([
        { providerId: 'p', count: 2 },
        { providerId: 'q', count: 1 },
      ]);
      expect(agg.llmUsage.byModel).toEqual([
        { model: 'm', count: 2 },
        { model: 'm2', count: 1 },
      ]);
      expect(agg.llmUsage.byStage).toEqual([
        { stage: 'answer', count: 2 },
        { stage: 'semantics', count: 1 },
      ]);
      for (const row of agg.llmUsage.byProvider) {
        expect(Object.keys(row)).toEqual(['providerId', 'count']);
      }
    } finally {
      db.close();
    }
  });
});

describe('P7-R15 — execution outcome timestamp semantics', () => {
  it('submit claim count is ALL-TIME even when the range excludes every receipt', () => {
    const db = makeDb();
    try {
      insertReceipt(db, {
        key: 'claimed-1',
        state: 'success',
        submitAttempted: 1,
        outcome: 'success',
        outcomeCode: 'SUBMISSION_CONFIRMED',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      });
      const ranged = readAggregates(db, {
        sinceMs: Date.parse('2026-01-01T00:00:00Z'),
        untilMs: Date.parse('2026-02-01T00:00:00Z'),
      });
      expect(ranged.executionOutcomes.submitClaimCount).toBe(1);
      expect(ranged.executionOutcomes.preflightCount).toBe(0);
      expect(ranged.executionOutcomes.byOutcome).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('preflight is filtered by created_at and terminal outcomes by updated_at', () => {
    const db = makeDb();
    try {
      insertReceipt(db, {
        key: 'preflight-in',
        state: 'preflight',
        submitAttempted: 0,
        outcome: 'preflight',
        outcomeCode: null,
        createdAt: '2026-01-15T00:00:00.000Z',
        updatedAt: '2026-01-15T00:00:00.000Z',
      });
      insertReceipt(db, {
        key: 'preflight-out',
        state: 'preflight',
        submitAttempted: 0,
        outcome: 'preflight',
        outcomeCode: null,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      });
      insertReceipt(db, {
        key: 'claimed-terminal-out',
        state: 'success',
        submitAttempted: 1,
        outcome: 'success',
        outcomeCode: 'SUBMISSION_CONFIRMED',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      });
      const agg = readAggregates(db, {
        sinceMs: Date.parse('2026-01-01T00:00:00Z'),
        untilMs: Date.parse('2026-02-01T00:00:00Z'),
      });
      expect(agg.executionOutcomes.preflightCount).toBe(1);
      expect(agg.executionOutcomes.submitClaimCount).toBe(1);
      // P7-R15: the in-range preflight must NOT appear in the terminal groupings.
      expect(agg.executionOutcomes.byState).toEqual([]);
      expect(agg.executionOutcomes.byOutcome).toEqual([]);
      expect(agg.executionOutcomes.byOutcomeCode).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('includes only accepted terminal outcomes in ranged byState/byOutcome/byOutcomeCode', () => {
    const db = makeDb();
    try {
      // In-range preflight: counts as preflight + ranged receipt, never terminal.
      insertReceipt(db, {
        key: 'preflight-in',
        state: 'preflight',
        submitAttempted: 0,
        outcome: 'preflight',
        outcomeCode: null,
        createdAt: '2026-01-15T00:00:00.000Z',
        updatedAt: '2026-01-15T00:00:00.000Z',
      });
      // In-range terminal outcome: must appear.
      insertReceipt(db, {
        key: 'terminal-in',
        state: 'unknown_outcome',
        submitAttempted: 1,
        outcome: 'unknown_outcome',
        outcomeCode: 'SUBMISSION_OUTCOME_UNKNOWN',
        createdAt: '2026-01-15T00:00:00.000Z',
        updatedAt: '2026-01-16T00:00:00.000Z',
      });
      // In-range claimed but NON-terminal (outcome null): must NOT appear.
      insertReceipt(db, {
        key: 'submitting-in',
        state: 'submitting',
        submitAttempted: 1,
        outcome: null,
        outcomeCode: null,
        createdAt: '2026-01-17T00:00:00.000Z',
        updatedAt: '2026-01-17T00:00:00.000Z',
      });
      // Out-of-range terminal outcome: must NOT appear.
      insertReceipt(db, {
        key: 'terminal-out',
        state: 'success',
        submitAttempted: 1,
        outcome: 'success',
        outcomeCode: 'SUBMISSION_CONFIRMED',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      });

      const agg = readAggregates(db, {
        sinceMs: Date.parse('2026-01-01T00:00:00Z'),
        untilMs: Date.parse('2026-02-01T00:00:00Z'),
      });
      expect(agg.executionOutcomes.preflightCount).toBe(1);
      // All-time claim count: terminal-in + submitting-in + terminal-out.
      expect(agg.executionOutcomes.submitClaimCount).toBe(3);
      expect(agg.executionOutcomes.byState).toEqual([{ state: 'unknown_outcome', count: 1 }]);
      expect(agg.executionOutcomes.byOutcome).toEqual([{ outcome: 'unknown_outcome', count: 1 }]);
      expect(agg.executionOutcomes.byOutcomeCode).toEqual([
        { outcomeCode: 'SUBMISSION_OUTCOME_UNKNOWN', count: 1 },
      ]);
      // Ranged receipt count includes the in-range preflight + non-terminal row.
      expect(agg.executionOutcomes.receiptCount).toBe(3);
    } finally {
      db.close();
    }
  });
});

describe('P7-R15 — time boundaries', () => {
  it('treats since as inclusive and until as exclusive for metrics_events', () => {
    const db = makeDb();
    try {
      insertMetric(db, METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 'count', 1, null, 1000);
      insertMetric(db, METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 'count', 2, null, 2000);
      insertMetric(db, METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 'count', 3, null, 3000);

      const agg = readAggregates(db, { sinceMs: 1000, untilMs: 3000 });
      const row = agg.metricsEvents.byEvent[0];
      expect(row?.count).toBe(2);
      expect(row?.sum).toBe(3);
      expect(agg.eventRowCount).toBe(2);

      const none = readAggregates(db, { sinceMs: 3000, untilMs: 3000 });
      expect(none.metricsEvents.byEvent).toEqual([]);
    } finally {
      db.close();
    }
  });
});
