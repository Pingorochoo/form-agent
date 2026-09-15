/**
 * Phase 7 metrics store tests (P7-R3, P7-R4, P7-R6).
 *
 * Proves the closed-catalog runtime validator (stronger than the SQL CHECKs),
 * the best-effort recorder failure boundary, and the null-recorder fallback.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { FormAgentDatabase } from '../src/db/database.ts';
import { defaultConfig } from '../src/config/schema.ts';
import { createLogger } from '../src/logging/logger.ts';
import { METRIC_EVENTS, type MetricEvent } from '../src/metrics/catalog.ts';
import { createMetricsRecorder, MetricsStore, NullMetricsRecorder, type MetricsRecorder } from '../src/metrics/store.ts';
import { openAuditMetrics } from '../src/metrics/instrument.ts';
import { ReceiptStore } from '../src/execution/receipt.ts';
import { ExecutionPreSubmitError } from '../src/execution/errors.ts';
import { fixedClock } from './support/phase7.ts';

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'form-agent-p7-store-'));
  return FormAgentDatabase.open({ directory: dir, filename: 'store.db' });
}

function rows(db: FormAgentDatabase): Array<{ event: string; kind: string; value_num: number | null; value_text: string | null; at_ms: number }> {
  return db.db
    .prepare('SELECT event, kind, value_num, value_text, at_ms FROM metrics_events ORDER BY id')
    .all() as Array<{ event: string; kind: string; value_num: number | null; value_text: string | null; at_ms: number }>;
}

describe('P7-R4/R6 — closed-catalog runtime validation', () => {
  it('stores valid count/duration/categorical records', () => {
    const db = makeDb();
    try {
      const store = new MetricsStore(db, { clock: fixedClock(1234) });
      store.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 0);
      store.recordCount(METRIC_EVENTS.DRAFT_ANSWERED_COUNT, 7);
      store.recordDuration(METRIC_EVENTS.COMMAND_DRAFT_DURATION, 1.5);
      store.recordCategorical(METRIC_EVENTS.CONSISTENCY_STATUS, 'warn');
      const stored = rows(db);
      expect(stored).toHaveLength(4);
      expect(stored.every((r) => r.at_ms === 1234)).toBe(true);
      expect(stored[2]?.value_num).toBe(1.5);
      expect(stored[3]?.value_text).toBe('warn');
    } finally {
      db.close();
    }
  });

  it('rejects unknown events, wrong kinds, bad numerics, bad status and unsafe text', () => {
    const db = makeDb();
    const warnings: number[] = [];
    try {
      const store = new MetricsStore(db, { clock: fixedClock(10), onWarning: () => warnings.push(1) });
      const unknown = 'command.unknown.duration' as MetricEvent;
      store.recordCount(unknown, 1);
      store.recordCount(METRIC_EVENTS.CONSISTENCY_HARD_ISSUES_COUNT, -1);
      store.recordCount(METRIC_EVENTS.CONSISTENCY_HARD_ISSUES_COUNT, 1.5);
      store.recordCount(METRIC_EVENTS.CONSISTENCY_HARD_ISSUES_COUNT, Number.NaN);
      store.recordDuration(METRIC_EVENTS.COMMAND_DRAFT_DURATION, Number.POSITIVE_INFINITY);
      store.recordDuration(METRIC_EVENTS.COMMAND_DRAFT_DURATION, -3);
      store.recordCategorical(METRIC_EVENTS.CONSISTENCY_STATUS, 'bogus');
      store.recordCategorical(METRIC_EVENTS.CONSISTENCY_STATUS, 'x'.repeat(65));
      store.recordCategorical(METRIC_EVENTS.CONSISTENCY_STATUS, 'pass\ninjected');
      // kind mismatch: record a count under a duration event
      store.recordCount(METRIC_EVENTS.COMMAND_ANALYZE_DURATION as MetricEvent, 5);
      expect(rows(db)).toHaveLength(0);
      expect(warnings.length).toBe(10);
    } finally {
      db.close();
    }
  });

  it('rejects a non-integer/invalid at_ms', () => {
    const db = makeDb();
    try {
      const invalid = new MetricsStore(db, { clock: { wallNowMs: () => 1.5, monotonicNowMs: () => 0 } });
      invalid.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 1);
      const negative = new MetricsStore(db, { clock: { wallNowMs: () => -1, monotonicNowMs: () => 0 } });
      negative.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 1);
      expect(rows(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe('P7-R3 — recorder failure isolation', () => {
  it('cannot throw into the caller and emits only a stable warning when the table is gone', () => {
    const db = makeDb();
    const warnings: string[] = [];
    try {
      const store = new MetricsStore(db, {
        clock: fixedClock(),
        onWarning: () => warnings.push('metrics recording skipped'),
      });
      db.db.exec('DROP TABLE metrics_events');
      expect(() => store.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 1)).not.toThrow();
      expect(() => store.recordDuration(METRIC_EVENTS.COMMAND_DRAFT_DURATION, 1)).not.toThrow();
      expect(() => store.recordCategorical(METRIC_EVENTS.CONSISTENCY_STATUS, 'pass')).not.toThrow();
      expect(warnings).toEqual([
        'metrics recording skipped',
        'metrics recording skipped',
        'metrics recording skipped',
      ]);
    } finally {
      db.close();
    }
  });

  it('falls back to a no-op recorder when the database/table is unavailable', () => {
    const nullRecorder = createMetricsRecorder({ database: null });
    expect(nullRecorder).toBeInstanceOf(NullMetricsRecorder);
    expect(() => nullRecorder.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 1)).not.toThrow();

    const db = makeDb();
    try {
      db.db.exec('DROP TABLE metrics_events');
      const warnings: number[] = [];
      const fallback = createMetricsRecorder({
        database: db,
        onWarning: () => warnings.push(1),
      });
      expect(fallback).toBeInstanceOf(NullMetricsRecorder);
      fallback.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 1);
      expect(warnings.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('never swallows an authoritative ReceiptStore claim failure as a metrics failure', () => {
    const db = makeDb();
    try {
      const store = new MetricsStore(db, { clock: fixedClock(), onWarning: () => {} });
      // Break the metrics table, then prove a metrics failure is isolated...
      db.db.exec('DROP TABLE metrics_events');
      expect(() => store.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 1)).not.toThrow();

      // ...while the authoritative durable claim still fails closed.
      const store2 = new ReceiptStore(db);
      const metadata = {
        targetKey: 't',
        targetDisplay: 't',
        planId: 'p',
        draftId: 'd',
        consistencyReportId: 'c',
        fingerprint: 'f',
        providerId: 'fixture',
        providerVersion: '1.0.0',
      };
      store2.claimSubmission('key-1', { ...metadata, operator: 'op', approvalAt: '2026-01-01T00:00:00.000Z' });
      expect(() =>
        store2.claimSubmission('key-1', { ...metadata, operator: 'op', approvalAt: '2026-01-01T00:00:00.000Z' }),
      ).toThrow(ExecutionPreSubmitError);
    } finally {
      db.close();
    }
  });
});

describe('P7-R6 — count integer vs safe-integer at_ms', () => {
  it('accepts a finite integer count outside the Number safe-integer range', () => {
    const db = makeDb();
    try {
      const store = new MetricsStore(db, { clock: fixedClock(5) });
      // 2^53 is a finite integer but NOT a safe integer; count metrics allow it.
      store.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 9007199254740992);
      const row = db.db.prepare('SELECT value_num FROM metrics_events').get() as { value_num: number };
      expect(row.value_num).toBe(9007199254740992);
    } finally {
      db.close();
    }
  });

  it('still rejects fractional/NaN/Infinity/negative counts and unsafe at_ms', () => {
    const db = makeDb();
    try {
      const store = new MetricsStore(db, { clock: fixedClock(5), onWarning: () => {} });
      store.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 1.5);
      store.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, Number.NaN);
      store.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, Number.POSITIVE_INFINITY);
      store.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, -1);
      const unsafeClock = new MetricsStore(db, {
        clock: { wallNowMs: () => 9007199254740992, monotonicNowMs: () => 0 },
        onWarning: () => {},
      });
      unsafeClock.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 1);
      expect(db.db.prepare('SELECT COUNT(*) AS n FROM metrics_events').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});

describe('P7-R3 — throwing warning emission cannot escape', () => {
  it('MetricsStore record* never throws when onWarning itself throws', () => {
    const db = makeDb();
    try {
      const store = new MetricsStore(db, {
        onWarning: () => {
          throw new Error('warn boom');
        },
      });
      db.db.exec('DROP TABLE metrics_events');
      expect(() => store.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 1)).not.toThrow();
      expect(() => store.recordDuration(METRIC_EVENTS.COMMAND_DRAFT_DURATION, 1)).not.toThrow();
      expect(() => store.recordCategorical(METRIC_EVENTS.CONSISTENCY_STATUS, 'pass')).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('createMetricsRecorder returns the no-op recorder even when onWarning throws', () => {
    const db = makeDb();
    try {
      db.db.exec('DROP TABLE metrics_events');
      let recorder: MetricsRecorder | undefined;
      expect(() => {
        recorder = createMetricsRecorder({
          database: db,
          onWarning: () => {
            throw new Error('warn boom');
          },
        });
      }).not.toThrow();
      expect(recorder).toBeInstanceOf(NullMetricsRecorder);
      expect(() => recorder?.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, 1)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('openAuditMetrics tolerates a throwing logger and a throwing close', () => {
    const badDir = join(mkdtempSync(join(tmpdir(), 'form-agent-p7-badlog-')), 'not-a-dir');
    writeFileSync(badDir, 'x');
    const throwingLogger = createLogger(defaultConfig(), {
      sink: () => {
        throw new Error('sink boom');
      },
    });
    let failedHandle: ReturnType<typeof openAuditMetrics> | undefined;
    expect(() => {
      failedHandle = openAuditMetrics({ directory: badDir, filename: 'x.db', logger: throwingLogger });
    }).not.toThrow();
    expect(failedHandle?.recorder).toBeInstanceOf(NullMetricsRecorder);

    const goodDir = mkdtempSync(join(tmpdir(), 'form-agent-p7-close-'));
    const logger = createLogger(defaultConfig(), { sink: () => {} });
    const handle = openAuditMetrics({ directory: goodDir, filename: 'close.db', logger });
    const closeSpy = vi
      .spyOn(FormAgentDatabase.prototype, 'close')
      .mockImplementation(() => {
        throw new Error('close boom');
      });
    try {
      expect(() => handle.close()).not.toThrow();
    } finally {
      closeSpy.mockRestore();
      handle.close();
    }
  });
});
