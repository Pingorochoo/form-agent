/**
 * Frozen Phase 7 output formatting (P7-R16, P7-R17, docs/PHASE_7.md §6).
 *
 * Three deterministic surfaces:
 *   - human summary (bounded, stable ordering; not machine-parsed);
 *   - JSON export (exact frozen top-level/coverage keys, one document);
 *   - CSV export (exact frozen header + vocabulary + ordering, RFC-4180 safe).
 *
 * No prose is mixed into the JSON/CSV documents.
 */

import type {
  LatencyAggregate,
  MetricsAggregates,
  MetricsRangeOutput,
  TokenAggregate,
} from './aggregate.ts';
import { METRIC_EVENTS, type MetricKind } from './catalog.ts';

export const COVERAGE = {
  metricsEvents: 'phase7+',
  llmUsage: 'partial-pre-phase7;best-effort-instrumented-from-phase7',
  executionOutcomes: 'phase5+',
} as const;

export const COVERAGE_LINE = `Coverage: metricsEvents=${COVERAGE.metricsEvents} llmUsage=${COVERAGE.llmUsage} executionOutcomes=${COVERAGE.executionOutcomes}`;

export interface MetricsExportDocument {
  generatedAt: string;
  range: { since: string | null; until: string | null };
  coverage: {
    metricsEvents: string;
    llmUsage: string;
    executionOutcomes: string;
  };
  metricsEvents: {
    byEvent: Array<{
      event: string;
      kind: MetricKind;
      count: number;
      sum: number | null;
      min: number | null;
      max: number | null;
      avg: number | null;
    }>;
    statusCounts: Array<{ value: string; count: number }>;
  };
  llmUsage: {
    callCount: number;
    byStatus: Array<{ status: string; count: number }>;
    tokens: { input: TokenAggregate; output: TokenAggregate; total: TokenAggregate };
    latencyMs: LatencyAggregate;
    byProvider: Array<{ providerId: string; count: number }>;
    byModel: Array<{ model: string; count: number }>;
    byStage: Array<{ stage: string; count: number }>;
  };
  executionOutcomes: {
    preflightCount: number;
    submitClaimCount: number;
    byState: Array<{ state: string; count: number }>;
    byOutcome: Array<{ outcome: string; count: number }>;
    byOutcomeCode: Array<{ outcomeCode: string; count: number }>;
  };
}

export function buildMetricsExport(
  aggregates: MetricsAggregates,
  range: MetricsRangeOutput,
  generatedAt: string,
): MetricsExportDocument {
  const tokens = aggregates.llmUsage.tokens;
  return {
    generatedAt,
    range: { since: range.since, until: range.until },
    coverage: {
      metricsEvents: COVERAGE.metricsEvents,
      llmUsage: COVERAGE.llmUsage,
      executionOutcomes: COVERAGE.executionOutcomes,
    },
    metricsEvents: {
      byEvent: aggregates.metricsEvents.byEvent.map((row) => ({
        event: row.event,
        kind: row.kind,
        count: row.count,
        sum: row.sum,
        min: row.min,
        max: row.max,
        avg: row.avg,
      })),
      statusCounts: aggregates.metricsEvents.statusCounts.map((row) => ({
        value: row.value,
        count: row.count,
      })),
    },
    llmUsage: {
      callCount: aggregates.llmUsage.callCount,
      byStatus: aggregates.llmUsage.byStatus.map((row) => ({ status: row.status, count: row.count })),
      tokens: {
        input: { sum: tokens.input.sum, observedCount: tokens.input.observedCount, missingCount: tokens.input.missingCount },
        output: { sum: tokens.output.sum, observedCount: tokens.output.observedCount, missingCount: tokens.output.missingCount },
        total: { sum: tokens.total.sum, observedCount: tokens.total.observedCount, missingCount: tokens.total.missingCount },
      },
      latencyMs: {
        min: aggregates.llmUsage.latencyMs.min,
        max: aggregates.llmUsage.latencyMs.max,
        avg: aggregates.llmUsage.latencyMs.avg,
        observedCount: aggregates.llmUsage.latencyMs.observedCount,
        missingCount: aggregates.llmUsage.latencyMs.missingCount,
      },
      byProvider: aggregates.llmUsage.byProvider.map((row) => ({ providerId: row.providerId, count: row.count })),
      byModel: aggregates.llmUsage.byModel.map((row) => ({ model: row.model, count: row.count })),
      byStage: aggregates.llmUsage.byStage.map((row) => ({ stage: row.stage, count: row.count })),
    },
    executionOutcomes: {
      preflightCount: aggregates.executionOutcomes.preflightCount,
      submitClaimCount: aggregates.executionOutcomes.submitClaimCount,
      byState: aggregates.executionOutcomes.byState.map((row) => ({ state: row.state, count: row.count })),
      byOutcome: aggregates.executionOutcomes.byOutcome.map((row) => ({ outcome: row.outcome, count: row.count })),
      byOutcomeCode: aggregates.executionOutcomes.byOutcomeCode.map((row) => ({
        outcomeCode: row.outcomeCode,
        count: row.count,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Human summary
// ---------------------------------------------------------------------------

function eventRow(aggregates: MetricsAggregates, event: string) {
  return aggregates.metricsEvents.byEvent.find((row) => row.event === event);
}

function countSum(aggregates: MetricsAggregates, event: string): number {
  return eventRow(aggregates, event)?.sum ?? 0;
}

function statusCount(aggregates: MetricsAggregates, status: string): number {
  return aggregates.metricsEvents.statusCounts.find((row) => row.value === status)?.count ?? 0;
}

function outcomeCount(aggregates: MetricsAggregates, outcome: string): number {
  return aggregates.executionOutcomes.byOutcome.find((row) => row.outcome === outcome)?.count ?? 0;
}

function llmStatusCount(aggregates: MetricsAggregates, status: string): number {
  return aggregates.llmUsage.byStatus.find((row) => row.status === status)?.count ?? 0;
}

function numberOrDash(value: number | null): string {
  return value === null ? '-' : String(value);
}

export function formatMetricsHuman(
  aggregates: MetricsAggregates,
  range: MetricsRangeOutput,
): string {
  const lines: string[] = [];
  lines.push(
    `Metrics summary (${aggregates.eventRowCount} events, ${aggregates.executionOutcomes.receiptCount} receipts, ${aggregates.llmUsage.callCount} llm_calls)`,
  );
  lines.push(`Range: ${range.since ?? '-'} .. ${range.until ?? '-'}`);
  lines.push(COVERAGE_LINE);

  lines.push('Commands:');
  let commandRows = 0;
  for (const event of [
    METRIC_EVENTS.COMMAND_ANALYZE_DURATION,
    METRIC_EVENTS.COMMAND_DRAFT_DURATION,
    METRIC_EVENTS.COMMAND_CHECK_DURATION,
    METRIC_EVENTS.COMMAND_RUN_PREFLIGHT_DURATION,
    METRIC_EVENTS.COMMAND_RUN_SUBMIT_DURATION,
  ] as const) {
    const row = eventRow(aggregates, event);
    if (row === undefined) continue;
    commandRows += 1;
    const label = event.replace(/^command\./, '');
    lines.push(
      `  ${label}   count=${row.count} min=${numberOrDash(row.min)}ms max=${numberOrDash(row.max)}ms avg=${numberOrDash(row.avg)}ms`,
    );
  }
  if (commandRows === 0) lines.push('  (none)');

  lines.push('Draft:');
  lines.push(
    `  fields.total=${countSum(aggregates, METRIC_EVENTS.DRAFT_FIELDS_TOTAL)} answered=${countSum(aggregates, METRIC_EVENTS.DRAFT_ANSWERED_COUNT)} blocked=${countSum(aggregates, METRIC_EVENTS.DRAFT_BLOCKED_COUNT)} unsupported=${countSum(aggregates, METRIC_EVENTS.DRAFT_UNSUPPORTED_COUNT)} validation_error=${countSum(aggregates, METRIC_EVENTS.DRAFT_VALIDATION_ERROR_COUNT)} required_unanswered=${countSum(aggregates, METRIC_EVENTS.DRAFT_REQUIRED_UNANSWERED_COUNT)}`,
  );

  lines.push('Consistency:');
  lines.push(
    `  status pass=${statusCount(aggregates, 'pass')} warn=${statusCount(aggregates, 'warn')} block=${statusCount(aggregates, 'block')} hard=${countSum(aggregates, METRIC_EVENTS.CONSISTENCY_HARD_ISSUES_COUNT)} soft=${countSum(aggregates, METRIC_EVENTS.CONSISTENCY_SOFT_ISSUES_COUNT)}`,
  );

  lines.push('Execution:');
  lines.push(
    `  preflight=${aggregates.executionOutcomes.preflightCount} claims(all-time)=${aggregates.executionOutcomes.submitClaimCount} success=${outcomeCount(aggregates, 'success')} unknown_outcome=${outcomeCount(aggregates, 'unknown_outcome')} failed_pre_submit=${outcomeCount(aggregates, 'failed_pre_submit')} aborted=${outcomeCount(aggregates, 'aborted')}`,
  );
  // P7-R15 truthfulness: ranged terminal outcomes use updated_at as the receipt
  // terminal time; it is NOT a claim time. preflightCount is created_at-ranged
  // and submitClaimCount is all-time.
  lines.push('  terminal outcomes (success/unknown_outcome/failed_pre_submit/aborted) ranged by terminal time (updated_at); preflight ranged by created_at; claims(all-time) never ranged');

  const tokens = aggregates.llmUsage.tokens;
  const latency = aggregates.llmUsage.latencyMs;
  lines.push('LLM:');
  lines.push(
    `  calls=${aggregates.llmUsage.callCount} success=${llmStatusCount(aggregates, 'success')} error=${llmStatusCount(aggregates, 'error')}`,
  );
  lines.push(
    `  tokens.input  sum=${numberOrDash(tokens.input.sum)} observed=${tokens.input.observedCount} missing=${tokens.input.missingCount}`,
  );
  lines.push(
    `  tokens.output sum=${numberOrDash(tokens.output.sum)} observed=${tokens.output.observedCount} missing=${tokens.output.missingCount}`,
  );
  lines.push(
    `  tokens.total  sum=${numberOrDash(tokens.total.sum)} observed=${tokens.total.observedCount} missing=${tokens.total.missingCount}`,
  );
  lines.push(
    `  latency min=${numberOrDash(latency.min)}ms max=${numberOrDash(latency.max)}ms avg=${numberOrDash(latency.avg)}ms observed=${latency.observedCount} missing=${latency.missingCount}`,
  );
  lines.push(
    `  by provider: ${aggregates.llmUsage.byProvider.map((row) => `${row.providerId}=${row.count}`).join(' ') || '(none)'}`,
  );
  lines.push(
    `  by model: ${aggregates.llmUsage.byModel.map((row) => `${row.model}=${row.count}`).join(' ') || '(none)'}`,
  );
  lines.push(
    `  by stage: ${aggregates.llmUsage.byStage.map((row) => `${row.stage}=${row.count}`).join(' ') || '(none)'}`,
  );
  lines.push('  (no per-error-code grouping; migration 4 does not persist it)');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

const CSV_HEADER = 'section,scope,dimension,metric,value,unit,observedCount,missingCount';

const SECTION_ORDER = ['coverage', 'metricsEvents', 'llmUsage', 'executionOutcomes'] as const;
type Section = (typeof SECTION_ORDER)[number];

interface CsvRow {
  section: Section;
  scope: string;
  dimension: string;
  metric: string;
  value: string;
  unit: string;
  observedCount: string;
  missingCount: string;
}

function escapeCsvField(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

function toCsvLine(row: CsvRow): string {
  return [
    row.section,
    row.scope,
    row.dimension,
    row.metric,
    row.value,
    row.unit,
    row.observedCount,
    row.missingCount,
  ]
    .map(escapeCsvField)
    .join(',');
}

export function formatMetricsCsv(aggregates: MetricsAggregates): string {
  const rows: CsvRow[] = [];

  // Coverage rows (canonical value order).
  rows.push({
    section: 'coverage',
    scope: 'metricsEvents',
    dimension: '',
    metric: 'present',
    value: COVERAGE.metricsEvents,
    unit: 'text',
    observedCount: '',
    missingCount: '',
  });
  rows.push({
    section: 'coverage',
    scope: 'llmUsage',
    dimension: '',
    metric: 'present',
    value: COVERAGE.llmUsage,
    unit: 'text',
    observedCount: '',
    missingCount: '',
  });
  rows.push({
    section: 'coverage',
    scope: 'executionOutcomes',
    dimension: '',
    metric: 'present',
    value: COVERAGE.executionOutcomes,
    unit: 'text',
    observedCount: '',
    missingCount: '',
  });

  // metricsEvents.byEvent
  for (const row of aggregates.metricsEvents.byEvent) {
    const unit = row.kind === 'duration_ms' ? 'ms' : 'count';
    for (const metric of ['count', 'sum', 'min', 'max', 'avg'] as const) {
      const value = row[metric];
      rows.push({
        section: 'metricsEvents',
        scope: 'byEvent',
        dimension: row.event,
        metric,
        value: value === null ? '' : String(value),
        unit,
        observedCount: '',
        missingCount: '',
      });
    }
  }

  // metricsEvents.statusCounts
  for (const row of aggregates.metricsEvents.statusCounts) {
    rows.push({
      section: 'metricsEvents',
      scope: 'byStatus',
      dimension: row.value,
      metric: 'count',
      value: String(row.count),
      unit: 'count',
      observedCount: '',
      missingCount: '',
    });
  }

  // llmUsage.callCount (overall total)
  rows.push({
    section: 'llmUsage',
    scope: 'callCount',
    dimension: '',
    metric: 'count',
    value: String(aggregates.llmUsage.callCount),
    unit: 'count',
    observedCount: '',
    missingCount: '',
  });

  for (const row of aggregates.llmUsage.byStatus) {
    rows.push({
      section: 'llmUsage',
      scope: 'byStatus',
      dimension: row.status,
      metric: 'count',
      value: String(row.count),
      unit: 'count',
      observedCount: '',
      missingCount: '',
    });
  }
  for (const row of aggregates.llmUsage.byProvider) {
    rows.push({
      section: 'llmUsage',
      scope: 'byProvider',
      dimension: row.providerId,
      metric: 'count',
      value: String(row.count),
      unit: 'count',
      observedCount: '',
      missingCount: '',
    });
  }
  for (const row of aggregates.llmUsage.byModel) {
    rows.push({
      section: 'llmUsage',
      scope: 'byModel',
      dimension: row.model,
      metric: 'count',
      value: String(row.count),
      unit: 'count',
      observedCount: '',
      missingCount: '',
    });
  }
  for (const row of aggregates.llmUsage.byStage) {
    rows.push({
      section: 'llmUsage',
      scope: 'byStage',
      dimension: row.stage,
      metric: 'count',
      value: String(row.count),
      unit: 'count',
      observedCount: '',
      missingCount: '',
    });
  }

  // Nullable token aggregates: metric=sum + dedicated observed/missing columns.
  for (const [scope, token] of [
    ['tokens.input', aggregates.llmUsage.tokens.input],
    ['tokens.output', aggregates.llmUsage.tokens.output],
    ['tokens.total', aggregates.llmUsage.tokens.total],
  ] as const) {
    rows.push({
      section: 'llmUsage',
      scope,
      dimension: '',
      metric: 'sum',
      value: token.sum === null ? '' : String(token.sum),
      unit: 'tokens',
      observedCount: String(token.observedCount),
      missingCount: String(token.missingCount),
    });
  }

  // Nullable latency: metric=min|max|avg, same observed/missing on all three.
  for (const metric of ['min', 'max', 'avg'] as const) {
    const latencyValue = aggregates.llmUsage.latencyMs[metric];
    rows.push({
      section: 'llmUsage',
      scope: 'latencyMs',
      dimension: '',
      metric,
      value: latencyValue === null ? '' : String(latencyValue),
      unit: 'ms',
      observedCount: String(aggregates.llmUsage.latencyMs.observedCount),
      missingCount: String(aggregates.llmUsage.latencyMs.missingCount),
    });
  }

  // executionOutcomes
  rows.push({
    section: 'executionOutcomes',
    scope: 'preflightCount',
    dimension: '',
    metric: 'count',
    value: String(aggregates.executionOutcomes.preflightCount),
    unit: 'count',
    observedCount: '',
    missingCount: '',
  });
  rows.push({
    section: 'executionOutcomes',
    scope: 'submitClaimAllTime',
    dimension: '',
    metric: 'count',
    value: String(aggregates.executionOutcomes.submitClaimCount),
    unit: 'count',
    observedCount: '',
    missingCount: '',
  });
  for (const row of aggregates.executionOutcomes.byState) {
    rows.push({
      section: 'executionOutcomes',
      scope: 'byState',
      dimension: row.state,
      metric: 'count',
      value: String(row.count),
      unit: 'count',
      observedCount: '',
      missingCount: '',
    });
  }
  for (const row of aggregates.executionOutcomes.byOutcome) {
    rows.push({
      section: 'executionOutcomes',
      scope: 'byOutcome',
      dimension: row.outcome,
      metric: 'count',
      value: String(row.count),
      unit: 'count',
      observedCount: '',
      missingCount: '',
    });
  }
  for (const row of aggregates.executionOutcomes.byOutcomeCode) {
    rows.push({
      section: 'executionOutcomes',
      scope: 'byOutcomeCode',
      dimension: row.outcomeCode,
      metric: 'count',
      value: String(row.count),
      unit: 'count',
      observedCount: '',
      missingCount: '',
    });
  }

  rows.sort((a, b) => {
    const sectionDiff = SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section);
    if (sectionDiff !== 0) return sectionDiff;
    if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
    if (a.dimension !== b.dimension) return a.dimension < b.dimension ? -1 : 1;
    if (a.metric !== b.metric) return a.metric < b.metric ? -1 : 1;
    return 0;
  });

  return [CSV_HEADER, ...rows.map(toCsvLine)].join('\n');
}
