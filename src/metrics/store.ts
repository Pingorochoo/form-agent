/**
 * Metrics recorder boundary (P7-R3, P7-R4, docs/PHASE_7.md §5).
 *
 * `MetricsStore` writes the closed catalog into migration 9's `metrics_events`
 * table. Every `record*` call validates against the catalog and is wrapped in a
 * single catch-all boundary, so a validator rejection or insert failure can
 * never throw into the caller, never changes an exit result, business result, or
 * authoritative error, and never leaks a raw exception.
 *
 * `NullMetricsRecorder` is the no-op fallback used when the database or table is
 * unavailable. Readers (`summary`/`export`) never call `record*`.
 */

import type { FormAgentDatabase } from '../db/database.ts';
import { systemMetricsClock, type MetricsClock } from './clock.ts';
import { validateMetricRecord, type MetricEvent, type MetricKind } from './catalog.ts';
import { safeCall } from './safe.ts';

export interface MetricsRecorder {
  recordCount(event: MetricEvent, value: number): void;
  recordDuration(event: MetricEvent, durationMs: number): void;
  recordCategorical(event: MetricEvent, value: string): void;
}

export class NullMetricsRecorder implements MetricsRecorder {
  recordCount(): void {
    // no-op
  }

  recordDuration(): void {
    // no-op
  }

  recordCategorical(): void {
    // no-op
  }
}

export interface MetricsStoreOptions {
  /** Stable, redacted warning emitted on a rejected/failed write. */
  onWarning?: () => void;
  clock?: MetricsClock;
}

interface InsertStatement {
  run(...params: unknown[]): unknown;
}

export class MetricsStore implements MetricsRecorder {
  private readonly insert: InsertStatement;
  private readonly onWarning: () => void;
  private readonly clock: MetricsClock;

  constructor(database: FormAgentDatabase, options: MetricsStoreOptions = {}) {
    this.clock = options.clock ?? systemMetricsClock;
    this.onWarning = options.onWarning ?? (() => {});
    // Preparing fails closed when the metrics table is unavailable; the caller
    // decides whether to fall back to the null recorder.
    this.insert = database.db.prepare(
      'INSERT INTO metrics_events (event, kind, value_num, value_text, at_ms) VALUES (?, ?, ?, ?, ?)',
    );
  }

  recordCount(event: MetricEvent, value: number): void {
    this.write(event, 'count', value, null);
  }

  recordDuration(event: MetricEvent, durationMs: number): void {
    this.write(event, 'duration_ms', durationMs, null);
  }

  recordCategorical(event: MetricEvent, value: string): void {
    this.write(event, 'categorical', null, value);
  }

  private write(
    event: MetricEvent,
    kind: MetricKind,
    valueNum: number | null,
    valueText: string | null,
  ): void {
    try {
      const validated = validateMetricRecord({
        event,
        kind,
        valueNum,
        valueText,
        atMs: this.clock.wallNowMs(),
      });
      this.insert.run(
        validated.event,
        validated.kind,
        validated.valueNum,
        validated.valueText,
        validated.atMs,
      );
    } catch {
      // Best-effort only: a single stable, redacted warning; never rethrow,
      // never retry, never leak the raw exception. Warning emission itself is
      // guarded so a throwing warning/logging callback cannot escape either.
      safeCall(this.onWarning);
    }
  }
}

export interface CreateMetricsRecorderOptions {
  database: FormAgentDatabase | null;
  onWarning?: () => void;
  clock?: MetricsClock;
}

/**
 * Build a safe recorder. A null database (unavailable best-effort table) or a
 * table that cannot be prepared yields the no-op recorder.
 */
export function createMetricsRecorder(options: CreateMetricsRecorderOptions): MetricsRecorder {
  if (options.database === null) return new NullMetricsRecorder();
  const storeOptions: MetricsStoreOptions = {};
  if (options.onWarning !== undefined) storeOptions.onWarning = options.onWarning;
  if (options.clock !== undefined) storeOptions.clock = options.clock;
  try {
    return new MetricsStore(options.database, storeOptions);
  } catch {
    // A throwing warning callback must not prevent the no-op fallback.
    safeCall(options.onWarning);
    return new NullMetricsRecorder();
  }
}
