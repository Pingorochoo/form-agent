/**
 * Read-only deterministic aggregation (P7-R9, P7-R10, P7-R14).
 *
 * Derives exactly three sections from accepted durable sources:
 *   - `metricsEvents`  <- migration 9 `metrics_events` (Phase 7 event store);
 *   - `llmUsage`       <- migration 4 `llm_calls` (sole LLM authority);
 *   - `executionOutcomes` <- migration 7 `execution_receipts` (sole outcome authority).
 *
 * Only `count`, `sum`, `min`, `max`, `avg` are produced — no percentiles and no
 * fabricated zeros. Nullable token/latency aggregates are self-describing with
 * `observedCount`/`missingCount`. Readers never write and never claim.
 */

import type { FormAgentDatabase } from '../db/database.ts';
import type { MetricKind } from './catalog.ts';
import { METRIC_EVENTS } from './catalog.ts';

/**
 * The only execution outcomes accepted as TERMINAL for P7-R15 updated_at
 * (terminal-time) ranging. `preflight` and other non-terminal states are
 * deliberately excluded.
 */
const TERMINAL_OUTCOMES: ReadonlySet<string> = new Set([
  'success',
  'unknown_outcome',
  'failed_pre_submit',
  'aborted',
]);

export interface MetricsRange {
  /** Inclusive lower bound (epoch ms) or null. */
  sinceMs: number | null;
  /** Exclusive upper bound (epoch ms) or null. */
  untilMs: number | null;
}

export interface MetricsRangeOutput {
  since: string | null;
  until: string | null;
}

export interface EventAggregateRow {
  event: string;
  kind: MetricKind;
  count: number;
  sum: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
}

export interface ValueCountRow {
  value: string;
  count: number;
}

export interface StatusCountRow {
  status: string;
  count: number;
}

export interface ProviderCountRow {
  providerId: string;
  count: number;
}

export interface ModelCountRow {
  model: string;
  count: number;
}

export interface StageCountRow {
  stage: string;
  count: number;
}

export interface StateCountRow {
  state: string;
  count: number;
}

export interface OutcomeCountRow {
  outcome: string;
  count: number;
}

export interface OutcomeCodeCountRow {
  outcomeCode: string;
  count: number;
}

/** Self-describing nullable token aggregate (P7-R10b). No min/max/avg. */
export interface TokenAggregate {
  sum: number | null;
  observedCount: number;
  missingCount: number;
}

/** Self-describing nullable latency aggregate (P7-R10b). No sum. */
export interface LatencyAggregate {
  min: number | null;
  max: number | null;
  avg: number | null;
  observedCount: number;
  missingCount: number;
}

export interface MetricsAggregates {
  /** Ranged `metrics_events` row count (human header only). */
  eventRowCount: number;
  metricsEvents: {
    byEvent: EventAggregateRow[];
    statusCounts: ValueCountRow[];
  };
  llmUsage: {
    callCount: number;
    byStatus: StatusCountRow[];
    tokens: { input: TokenAggregate; output: TokenAggregate; total: TokenAggregate };
    latencyMs: LatencyAggregate;
    byProvider: ProviderCountRow[];
    byModel: ModelCountRow[];
    byStage: StageCountRow[];
  };
  executionOutcomes: {
    preflightCount: number;
    /** ALL-TIME (migration 7 has no claim timestamp); never ranged. */
    submitClaimCount: number;
    byState: StateCountRow[];
    byOutcome: OutcomeCountRow[];
    byOutcomeCode: OutcomeCodeCountRow[];
    /** Ranged receipt count (human header only). */
    receiptCount: number;
  };
}

/**
 * Controlled, stable error raised when the required `metrics_events` source is
 * missing/unqueryable AFTER the accepted open/migration lifecycle succeeded.
 * The CLI maps this to the accepted generic error exit path; it never fabricates
 * empty data for an unavailable expected source.
 */
export class MetricsSourceUnavailableError extends Error {
  constructor() {
    super('metrics event store is unavailable');
    this.name = 'MetricsSourceUnavailableError';
  }
}

function parseStoredTimestamp(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function withinRange(ms: number | null, range: MetricsRange): boolean {
  if (ms === null) return false;
  if (range.sinceMs !== null && ms < range.sinceMs) return false;
  if (range.untilMs !== null && ms >= range.untilMs) return false;
  return true;
}

function sortedEntries(map: Map<string, number>): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

interface MetricsEventRow {
  event: string;
  kind: MetricKind;
  count: number;
  sum: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
}

interface LlmCallRow {
  provider_id: string;
  model: string;
  stage: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  duration_ms: number | null;
  status: string;
  created_at: string;
}

interface ReceiptRow {
  state: string;
  outcome: string | null;
  outcome_code: string | null;
  submit_attempted: number;
  created_at: string;
  updated_at: string;
}

function requireMetricsTable(database: FormAgentDatabase): void {
  const row = database.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metrics_events'")
    .get() as { name: string } | undefined;
  if (row === undefined) throw new MetricsSourceUnavailableError();
}

function aggregateToken(
  rows: LlmCallRow[],
  select: (row: LlmCallRow) => number | null,
): TokenAggregate {
  let sum = 0;
  let observedCount = 0;
  let missingCount = 0;
  for (const row of rows) {
    const value = select(row);
    if (value === null || !Number.isFinite(value)) {
      missingCount += 1;
      continue;
    }
    observedCount += 1;
    sum += value;
  }
  return { sum: observedCount === 0 ? null : sum, observedCount, missingCount };
}

function aggregateLatency(rows: LlmCallRow[]): LatencyAggregate {
  let sum = 0;
  let observedCount = 0;
  let missingCount = 0;
  let min: number | null = null;
  let max: number | null = null;
  for (const row of rows) {
    const value = row.duration_ms;
    if (value === null || !Number.isFinite(value)) {
      missingCount += 1;
      continue;
    }
    observedCount += 1;
    sum += value;
    if (min === null || value < min) min = value;
    if (max === null || value > max) max = value;
  }
  return {
    min,
    max,
    avg: observedCount === 0 ? null : sum / observedCount,
    observedCount,
    missingCount,
  };
}

/** Read-only aggregation over the accepted durable sources. */
export function readAggregates(
  database: FormAgentDatabase,
  range: MetricsRange,
): MetricsAggregates {
  requireMetricsTable(database);

  const rangeConds: string[] = [];
  const rangeParams: number[] = [];
  if (range.sinceMs !== null) {
    rangeConds.push('at_ms >= ?');
    rangeParams.push(range.sinceMs);
  }
  if (range.untilMs !== null) {
    rangeConds.push('at_ms < ?');
    rangeParams.push(range.untilMs);
  }
  const rangeSql = rangeConds.length > 0 ? ` AND ${rangeConds.join(' AND ')}` : '';

  const eventRowCount = (
    database.db
      .prepare(`SELECT COUNT(*) AS n FROM metrics_events WHERE 1 = 1${rangeSql}`)
      .get(...rangeParams) as { n: number }
  ).n;

  const byEvent = database.db
    .prepare(
      `SELECT event, kind, COUNT(*) AS count, SUM(value_num) AS sum,
              MIN(value_num) AS min, MAX(value_num) AS max, AVG(value_num) AS avg
         FROM metrics_events
        WHERE 1 = 1${rangeSql}
        GROUP BY event, kind
        ORDER BY event ASC, kind ASC`,
    )
    .all(...rangeParams) as MetricsEventRow[];

  const statusRows = database.db
    .prepare(
      `SELECT value_text AS value, COUNT(*) AS count
         FROM metrics_events
        WHERE event = ?${rangeSql}
        GROUP BY value_text
        ORDER BY value_text ASC`,
    )
    .all(METRIC_EVENTS.CONSISTENCY_STATUS, ...rangeParams) as ValueCountRow[];

  // ---- LLM usage: read-only, filtered by created_at (the only accepted ts).
  const llmRows = database.db
    .prepare(
      `SELECT provider_id, model, stage, input_tokens, output_tokens,
              total_tokens, duration_ms, status, created_at
         FROM llm_calls`,
    )
    .all() as LlmCallRow[];
  const rangedLlm = llmRows.filter((row) => withinRange(parseStoredTimestamp(row.created_at), range));

  const statusMap = new Map<string, number>();
  const providerMap = new Map<string, number>();
  const modelMap = new Map<string, number>();
  const stageMap = new Map<string, number>();
  for (const row of rangedLlm) {
    increment(statusMap, row.status);
    increment(providerMap, row.provider_id);
    increment(modelMap, row.model);
    increment(stageMap, row.stage);
  }

  // ---- Execution outcomes: submit claim is ALL-TIME; terminal aggregates are
  // ranged by updated_at (the terminal timestamp) and labelled as such.
  const receiptRows = database.db
    .prepare(
      `SELECT state, outcome, outcome_code, submit_attempted, created_at, updated_at
         FROM execution_receipts`,
    )
    .all() as ReceiptRow[];

  const submitClaimCount = receiptRows.filter((row) => row.submit_attempted === 1).length;
  const preflightCount = receiptRows.filter(
    (row) => row.state === 'preflight' && withinRange(parseStoredTimestamp(row.created_at), range),
  ).length;

  // Human-header ranged receipt count: collected separately from the terminal
  // outcomes, because a ranged preflight/non-terminal receipt must still count
  // as a receipt while being excluded from the terminal groupings below.
  const rangedReceiptRows = receiptRows.filter((row) =>
    withinRange(parseStoredTimestamp(row.updated_at), range),
  );

  // P7-R15: only accepted TERMINAL outcomes may be ranged by updated_at (their
  // terminal time). `preflight`, claimed `submitting`, and any other
  // non-terminal receipt are excluded from byState/byOutcome/byOutcomeCode.
  const terminalRows = rangedReceiptRows.filter(
    (row) => row.outcome !== null && TERMINAL_OUTCOMES.has(row.outcome),
  );

  const stateMap = new Map<string, number>();
  const outcomeMap = new Map<string, number>();
  const outcomeCodeMap = new Map<string, number>();
  for (const row of terminalRows) {
    increment(stateMap, row.state);
    if (row.outcome !== null) increment(outcomeMap, row.outcome);
    if (row.outcome_code !== null) increment(outcomeCodeMap, row.outcome_code);
  }

  return {
    eventRowCount,
    metricsEvents: {
      byEvent: byEvent.map((row) => ({
        event: row.event,
        kind: row.kind,
        count: row.count,
        sum: row.sum,
        min: row.min,
        max: row.max,
        avg: row.avg,
      })),
      statusCounts: statusRows,
    },
    llmUsage: {
      callCount: rangedLlm.length,
      byStatus: sortedEntries(statusMap).map(([status, count]) => ({ status, count })),
      tokens: {
        input: aggregateToken(rangedLlm, (row) => row.input_tokens),
        output: aggregateToken(rangedLlm, (row) => row.output_tokens),
        total: aggregateToken(rangedLlm, (row) => row.total_tokens),
      },
      latencyMs: aggregateLatency(rangedLlm),
      byProvider: sortedEntries(providerMap).map(([providerId, count]) => ({ providerId, count })),
      byModel: sortedEntries(modelMap).map(([model, count]) => ({ model, count })),
      byStage: sortedEntries(stageMap).map(([stage, count]) => ({ stage, count })),
    },
    executionOutcomes: {
      preflightCount,
      submitClaimCount,
      byState: sortedEntries(stateMap).map(([state, count]) => ({ state, count })),
      byOutcome: sortedEntries(outcomeMap).map(([outcome, count]) => ({ outcome, count })),
      byOutcomeCode: sortedEntries(outcomeCodeMap).map(([outcomeCode, count]) => ({
        outcomeCode,
        count,
      })),
      receiptCount: rangedReceiptRows.length,
    },
  };
}
