/**
 * Phase 7 frozen JSON/CSV export tests (P7-R14, P7-R16, P7-R17, docs §6).
 *
 * Proves the exact JSON top-level/coverage/range keys, the exact CSV header +
 * vocabulary + deterministic ordering, RFC-4180 escaping, nullable
 * observed/missing columns, coverage disclosure, and the absence of percentiles
 * / extra machine sections.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FormAgentDatabase } from '../src/db/database.ts';
import { readAggregates } from '../src/metrics/aggregate.ts';
import {
  buildMetricsExport,
  COVERAGE,
  formatMetricsCsv,
  formatMetricsHuman,
} from '../src/metrics/format.ts';
import { METRIC_EVENTS } from '../src/metrics/catalog.ts';

const CSV_HEADER = 'section,scope,dimension,metric,value,unit,observedCount,missingCount';

function seededDb(nastyModel = false): FormAgentDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'form-agent-p7-export-'));
  const db = FormAgentDatabase.open({ directory: dir, filename: 'export.db' });
  db.db
    .prepare('INSERT INTO metrics_events (event, kind, value_num, value_text, at_ms) VALUES (?, ?, ?, ?, ?)')
    .run(METRIC_EVENTS.COMMAND_ANALYZE_DURATION, 'duration_ms', 10, null, 1000);
  db.db
    .prepare('INSERT INTO metrics_events (event, kind, value_num, value_text, at_ms) VALUES (?, ?, ?, ?, ?)')
    .run(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 'count', 5, null, 1000);
  db.db
    .prepare('INSERT INTO metrics_events (event, kind, value_num, value_text, at_ms) VALUES (?, ?, ?, ?, ?)')
    .run(METRIC_EVENTS.CONSISTENCY_STATUS, 'categorical', null, 'pass', 1000);
  db.db
    .prepare(
      `INSERT INTO llm_calls
         (provider_id, model, stage, input_tokens, output_tokens, total_tokens,
          duration_ms, finish_reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run('p', 'model-a', 'semantics', 1, 2, 3, 10, 'success', '2026-01-01T00:00:00.000Z');
  db.db
    .prepare(
      `INSERT INTO llm_calls
         (provider_id, model, stage, input_tokens, output_tokens, total_tokens,
          duration_ms, finish_reason, status, created_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .run('p', nastyModel ? 'a,"b\nc' : 'model-b', 'answer', 'error', '2026-01-01T00:00:01.000Z');
  db.db
    .prepare(
      `INSERT INTO execution_receipts
         (submission_key, target_key, target_display, plan_id, draft_id,
          consistency_report_id, fingerprint, provider_id, provider_version,
          state, submit_attempted, outcome, outcome_code, created_at, updated_at)
       VALUES ('k', 't', 't', 'p', 'd', 'c', 'f', 'fixture', '1.0.0',
               'success', 1, 'success', 'SUBMISSION_CONFIRMED',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.000Z')`,
    )
    .run();
  return db;
}

describe('P7-R16/R17 — frozen JSON contract', () => {
  it('has exactly the frozen top-level, coverage and range keys + coverage values', () => {
    const db = seededDb();
    try {
      const agg = readAggregates(db, { sinceMs: null, untilMs: null });
      const doc = buildMetricsExport(agg, { since: null, until: null }, '2026-01-01T00:00:00.000Z');
      expect(Object.keys(doc)).toEqual([
        'generatedAt',
        'range',
        'coverage',
        'metricsEvents',
        'llmUsage',
        'executionOutcomes',
      ]);
      expect(Object.keys(doc.range)).toEqual(['since', 'until']);
      expect(doc.coverage).toEqual(COVERAGE);
      expect(Object.keys(doc.coverage)).toEqual([
        'metricsEvents',
        'llmUsage',
        'executionOutcomes',
      ]);

      const text = JSON.stringify(doc);
      expect(text).not.toContain('rate_events');
      expect(text).not.toContain('analysis_cache');
      expect(text).not.toContain('p50');
      expect(text).not.toContain('p95');
      expect(text).not.toContain('percentile');
    } finally {
      db.close();
    }
  });

  it('uses exact nullable aggregate shapes and call-count-only grouping rows', () => {
    const db = seededDb();
    try {
      const agg = readAggregates(db, { sinceMs: null, untilMs: null });
      const doc = buildMetricsExport(agg, { since: null, until: null }, '2026-01-01T00:00:00.000Z');
      expect(Object.keys(doc.llmUsage.tokens.input)).toEqual(['sum', 'observedCount', 'missingCount']);
      expect(Object.keys(doc.llmUsage.latencyMs)).toEqual([
        'min',
        'max',
        'avg',
        'observedCount',
        'missingCount',
      ]);
      expect(Object.keys(doc.llmUsage.byProvider[0] ?? {})).toEqual(['providerId', 'count']);
      expect(Object.keys(doc.llmUsage.byStatus[0] ?? {})).toEqual(['status', 'count']);
      expect(Object.keys(doc.metricsEvents.byEvent[0] ?? {})).toEqual([
        'event',
        'kind',
        'count',
        'sum',
        'min',
        'max',
        'avg',
      ]);
      expect(Object.keys(doc.executionOutcomes)).toEqual([
        'preflightCount',
        'submitClaimCount',
        'byState',
        'byOutcome',
        'byOutcomeCode',
      ]);
    } finally {
      db.close();
    }
  });
});

describe('P7-R16 — frozen CSV contract', () => {
  it('emits the exact header, coverage rows, vocabulary and ordering', () => {
    const db = seededDb();
    try {
      const agg = readAggregates(db, { sinceMs: null, untilMs: null });
      const csv = formatMetricsCsv(agg);
      const lines = csv.split('\n');
      expect(lines[0]).toBe(CSV_HEADER);

      const dataLines = lines.slice(1);
      // Coverage rows come first, ordered by scope ascending as the section rule requires.
      expect(dataLines.slice(0, 3)).toEqual([
        `coverage,executionOutcomes,,present,${COVERAGE.executionOutcomes},text,,`,
        `coverage,llmUsage,,present,${COVERAGE.llmUsage},text,,`,
        `coverage,metricsEvents,,present,${COVERAGE.metricsEvents},text,,`,
      ]);

      const sections = dataLines.map((line) => line.split(',')[0]);
      const sectionRank = (section: string | undefined) => ['coverage', 'metricsEvents', 'llmUsage', 'executionOutcomes'].indexOf(section ?? '');
      for (let i = 1; i < sections.length; i++) {
        expect(sectionRank(sections[i])).toBeGreaterThanOrEqual(sectionRank(sections[i - 1]));
      }

      for (const line of dataLines.slice(3)) {
        const metric = line.split(',')[3];
        expect(['count', 'sum', 'min', 'max', 'avg', 'present']).toContain(metric);
        expect(metric).not.toBe('observedCount');
        expect(metric).not.toBe('missingCount');
      }

      // Nullable usage rows use dedicated observed/missing columns.
      expect(csv).toContain('llmUsage,tokens.input,,sum,1,tokens,1,1');
      expect(csv).toContain('llmUsage,latencyMs,,avg,10,ms,1,1');
      // All-time submit claim row.
      expect(csv).toContain('executionOutcomes,submitClaimAllTime,,count,1,count,,');
    } finally {
      db.close();
    }
  });

  it('escapes values containing comma/quote/newline per RFC 4180', () => {
    const db = seededDb(true);
    try {
      const agg = readAggregates(db, { sinceMs: null, untilMs: null });
      const csv = formatMetricsCsv(agg);
      expect(csv).toContain('"a,""b\nc"');
    } finally {
      db.close();
    }
  });
});

describe('P7-R17 — coverage disclosure', () => {
  it('emits the coverage line in the human summary', () => {
    const db = seededDb();
    try {
      const agg = readAggregates(db, { sinceMs: null, untilMs: null });
      const human = formatMetricsHuman(agg, { since: null, until: null });
      expect(human).toContain(
        'Coverage: metricsEvents=phase7+ llmUsage=partial-pre-phase7;best-effort-instrumented-from-phase7 executionOutcomes=phase5+',
      );
      expect(human).toContain('claims(all-time)=1');
      // P7-R15 truthfulness: terminal outcomes are disclosed as updated_at
      // (terminal-time) ranged, and updated_at is never called claim time.
      expect(human).toContain('ranged by terminal time (updated_at)');
      expect(human).toContain('claims(all-time) never ranged');
      expect(human.toLowerCase()).not.toContain('claim time');
      expect(human).not.toContain('p95');
    } finally {
      db.close();
    }
  });
});
