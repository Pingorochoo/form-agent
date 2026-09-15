/**
 * CLI-facing Phase 7 instrumentation helpers (P7-R8, P7-R11).
 *
 * `openAuditMetrics` performs the best-effort audit-only DB open required for
 * `draft`/`check` (P7-R11): it opens the accepted `FormAgentDatabase` lifecycle,
 * prepares a `recordCall` audit hook and a safe metrics recorder, and NEVER
 * throws. A failure leaves stdout/JSON/exit/business result unchanged while
 * emitting at most one stable redacted warning.
 *
 * `recordDraftSummary`/`recordConsistencySummary` map accepted `DraftBundle` /
 * `ConsistencyReport` aggregates onto the closed metric catalog. They record
 * only bounded counts/status — never answers, profile values, ids, or text.
 */

import { FormAgentDatabase } from '../db/database.ts';
import { LlmCallStore, type LlmCallAuditEntry } from '../llm/audit.ts';
import type { Logger } from '../logging/logger.ts';
import type { DraftSummary } from '../domain/draft.ts';
import type { ConsistencyReport } from '../domain/consistency.ts';
import type { MetricsClock, ElapsedTimer } from './clock.ts';
import { startTimer, systemMetricsClock } from './clock.ts';
import { createMetricsRecorder, type MetricsRecorder } from './store.ts';
import { METRIC_EVENTS } from './catalog.ts';
import { safeCall } from './safe.ts';

export interface AuditMetricsHandle {
  recorder: MetricsRecorder;
  /** Best-effort LLM audit hook (undefined when the audit DB is unavailable). */
  recordCall: ((entry: LlmCallAuditEntry) => void) | undefined;
  /** Start the command-duration timer (call at operation start). */
  startTimer(): ElapsedTimer;
  /** Close the audit-only database (idempotent, best-effort). */
  close(): void;
}

export interface OpenAuditMetricsOptions {
  directory: string;
  filename: string;
  logger: Logger;
  clock?: MetricsClock;
}

/**
 * Best-effort audit-only DB open + recorder for `draft`/`check`. Never throws:
 * a DB open failure yields a null recorder/hook and a stable warning.
 */
export function openAuditMetrics(options: OpenAuditMetricsOptions): AuditMetricsHandle {
  const clock = options.clock ?? systemMetricsClock;

  let database: FormAgentDatabase | null = null;
  try {
    database = FormAgentDatabase.open({
      directory: options.directory,
      filename: options.filename,
    });
  } catch {
    // Warning emission is best-effort; a throwing logger must not escape.
    safeCall(() =>
      options.logger.warn('audit/metrics database unavailable; continuing without persistence'),
    );
    database = null;
  }

  const recorderOptions: Parameters<typeof createMetricsRecorder>[0] = {
    database,
    onWarning: () => safeCall(() => options.logger.warn('metrics recording skipped')),
  };
  if (options.clock !== undefined) recorderOptions.clock = options.clock;
  const recorder = createMetricsRecorder(recorderOptions);

  let recordCall: ((entry: LlmCallAuditEntry) => void) | undefined;
  if (database !== null) {
    const llmCallStore = new LlmCallStore(database);
    recordCall = (entry) => {
      try {
        llmCallStore.record(entry);
      } catch {
        // Audit persistence stays best-effort and never leaks a raw exception;
        // a throwing logger must not escape either.
        safeCall(() => options.logger.warn('llm audit recording skipped'));
      }
    };
  }

  return {
    recorder,
    recordCall,
    startTimer: () => startTimer(clock),
    // Best-effort close: a close failure must not change stdout/JSON/exit.
    close: () => safeCall(() => database?.close()),
  };
}

export function recordDraftSummary(recorder: MetricsRecorder, summary: DraftSummary): void {
  recorder.recordCount(METRIC_EVENTS.DRAFT_FIELDS_TOTAL, summary.total);
  recorder.recordCount(METRIC_EVENTS.DRAFT_ANSWERED_COUNT, summary.answered);
  recorder.recordCount(METRIC_EVENTS.DRAFT_BLOCKED_COUNT, summary.blocked);
  recorder.recordCount(METRIC_EVENTS.DRAFT_UNSUPPORTED_COUNT, summary.unsupported);
  recorder.recordCount(METRIC_EVENTS.DRAFT_VALIDATION_ERROR_COUNT, summary.validationErrors);
  recorder.recordCount(METRIC_EVENTS.DRAFT_REQUIRED_UNANSWERED_COUNT, summary.requiredUnanswered);
}

export function recordConsistencySummary(
  recorder: MetricsRecorder,
  report: ConsistencyReport,
): void {
  recorder.recordCount(METRIC_EVENTS.CONSISTENCY_HARD_ISSUES_COUNT, report.hardIssues);
  recorder.recordCount(METRIC_EVENTS.CONSISTENCY_SOFT_ISSUES_COUNT, report.softIssues);
  recorder.recordCategorical(METRIC_EVENTS.CONSISTENCY_STATUS, report.status);
}
