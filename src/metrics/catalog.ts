/**
 * Closed Phase 7 metric-event catalog + runtime validator (P7-R4, P7-R6).
 *
 * The catalog is intentionally small and fixed. `MetricsStore` rejects any
 * event that is not an exact member of this catalog, so inserting secret or
 * raw data is impossible by construction. There is no generic "attributes"
 * escape hatch and no dimension map: execution and LLM dimensions are derived
 * read-only from the authoritative `execution_receipts` / `llm_calls` tables.
 */

/** The only three storage kinds the metrics_events table accepts. */
export type MetricKind = 'count' | 'duration_ms' | 'categorical';

/** Fixed Phase 7 event names. Unknown names are rejected, never stored. */
export const METRIC_EVENTS = {
  COMMAND_ANALYZE_DURATION: 'command.analyze.duration',
  COMMAND_DRAFT_DURATION: 'command.draft.duration',
  COMMAND_CHECK_DURATION: 'command.check.duration',
  COMMAND_RUN_PREFLIGHT_DURATION: 'command.run.preflight.duration',
  COMMAND_RUN_SUBMIT_DURATION: 'command.run.submit.duration',
  DRAFT_FIELDS_TOTAL: 'draft.fields.total',
  DRAFT_ANSWERED_COUNT: 'draft.answered.count',
  DRAFT_BLOCKED_COUNT: 'draft.blocked.count',
  DRAFT_UNSUPPORTED_COUNT: 'draft.unsupported.count',
  DRAFT_VALIDATION_ERROR_COUNT: 'draft.validation_error.count',
  DRAFT_REQUIRED_UNANSWERED_COUNT: 'draft.required_unanswered.count',
  CONSISTENCY_HARD_ISSUES_COUNT: 'consistency.hard_issues.count',
  CONSISTENCY_SOFT_ISSUES_COUNT: 'consistency.soft_issues.count',
  CONSISTENCY_STATUS: 'consistency.status',
} as const;

export type MetricEvent = (typeof METRIC_EVENTS)[keyof typeof METRIC_EVENTS];

/** The only accepted categorical values (consistency.status). */
export const CONSISTENCY_STATUS_VALUES = ['pass', 'warn', 'block'] as const;
export type ConsistencyStatusValue = (typeof CONSISTENCY_STATUS_VALUES)[number];

/** Fixed bound on stored categorical text (no raw/unbounded text). */
export const MAX_CATEGORICAL_LENGTH = 64;

interface CatalogEntry {
  readonly kind: MetricKind;
  readonly allowed?: readonly string[];
}

/** The closed catalog. Addition requires a spec revision + validator update. */
const CATALOG: Record<MetricEvent, CatalogEntry> = {
  [METRIC_EVENTS.COMMAND_ANALYZE_DURATION]: { kind: 'duration_ms' },
  [METRIC_EVENTS.COMMAND_DRAFT_DURATION]: { kind: 'duration_ms' },
  [METRIC_EVENTS.COMMAND_CHECK_DURATION]: { kind: 'duration_ms' },
  [METRIC_EVENTS.COMMAND_RUN_PREFLIGHT_DURATION]: { kind: 'duration_ms' },
  [METRIC_EVENTS.COMMAND_RUN_SUBMIT_DURATION]: { kind: 'duration_ms' },
  [METRIC_EVENTS.DRAFT_FIELDS_TOTAL]: { kind: 'count' },
  [METRIC_EVENTS.DRAFT_ANSWERED_COUNT]: { kind: 'count' },
  [METRIC_EVENTS.DRAFT_BLOCKED_COUNT]: { kind: 'count' },
  [METRIC_EVENTS.DRAFT_UNSUPPORTED_COUNT]: { kind: 'count' },
  [METRIC_EVENTS.DRAFT_VALIDATION_ERROR_COUNT]: { kind: 'count' },
  [METRIC_EVENTS.DRAFT_REQUIRED_UNANSWERED_COUNT]: { kind: 'count' },
  [METRIC_EVENTS.CONSISTENCY_HARD_ISSUES_COUNT]: { kind: 'count' },
  [METRIC_EVENTS.CONSISTENCY_SOFT_ISSUES_COUNT]: { kind: 'count' },
  [METRIC_EVENTS.CONSISTENCY_STATUS]: {
    kind: 'categorical',
    allowed: CONSISTENCY_STATUS_VALUES,
  },
};

export function catalogEntry(event: string): CatalogEntry | undefined {
  return (CATALOG as Record<string, CatalogEntry | undefined>)[event];
}

export class MetricValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricValidationError';
  }
}

export interface MetricRecordInput {
  event: string;
  kind: MetricKind;
  valueNum: number | null;
  valueText: string | null;
  atMs: number;
}

export interface ValidatedMetricRecord {
  event: MetricEvent;
  kind: MetricKind;
  valueNum: number | null;
  valueText: string | null;
  atMs: number;
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

/**
 * Validate one metric record against the closed catalog. Throws
 * `MetricValidationError` on any violation; the recorder boundary catches it.
 */
export function validateMetricRecord(input: MetricRecordInput): ValidatedMetricRecord {
  const entry = catalogEntry(input.event);
  if (entry === undefined) {
    throw new MetricValidationError('unknown metric event');
  }
  if (entry.kind !== input.kind) {
    throw new MetricValidationError('metric kind does not match the catalog entry');
  }
  if (!Number.isSafeInteger(input.atMs) || input.atMs < 0) {
    throw new MetricValidationError('metric timestamp must be a finite safe integer >= 0');
  }

  if (entry.kind === 'categorical') {
    if (input.valueNum !== null) {
      throw new MetricValidationError('categorical metric must not carry a numeric value');
    }
    if (typeof input.valueText !== 'string' || input.valueText.length === 0) {
      throw new MetricValidationError('categorical metric requires non-empty text');
    }
    if (input.valueText.length > MAX_CATEGORICAL_LENGTH) {
      throw new MetricValidationError('categorical metric text exceeds the fixed length bound');
    }
    if (CONTROL_CHARACTER_PATTERN.test(input.valueText)) {
      throw new MetricValidationError('categorical metric text must not contain control characters');
    }
    if (entry.allowed !== undefined && !entry.allowed.includes(input.valueText)) {
      throw new MetricValidationError('categorical metric value is outside the event allowed set');
    }
    return {
      event: input.event as MetricEvent,
      kind: entry.kind,
      valueNum: null,
      valueText: input.valueText,
      atMs: input.atMs,
    };
  }

  if (input.valueText !== null) {
    throw new MetricValidationError('numeric metric must not carry text');
  }
  if (input.valueNum === null || !Number.isFinite(input.valueNum)) {
    throw new MetricValidationError('numeric metric value must be finite');
  }
  if (input.valueNum < 0) {
    throw new MetricValidationError('numeric metric value must be >= 0');
  }
  // P7-R6: count values are finite integers >= 0 (only `at_ms` must be a SAFE
  // integer). This is intentionally looser than Number.isSafeInteger.
  if (entry.kind === 'count' && !Number.isInteger(input.valueNum)) {
    throw new MetricValidationError('count metric value must be a finite integer');
  }
  return {
    event: input.event as MetricEvent,
    kind: entry.kind,
    valueNum: input.valueNum,
    valueText: null,
    atMs: input.atMs,
  };
}

/** The ordered duration event names (human summary + tests). */
export const DURATION_EVENTS: readonly MetricEvent[] = [
  METRIC_EVENTS.COMMAND_ANALYZE_DURATION,
  METRIC_EVENTS.COMMAND_DRAFT_DURATION,
  METRIC_EVENTS.COMMAND_CHECK_DURATION,
  METRIC_EVENTS.COMMAND_RUN_PREFLIGHT_DURATION,
  METRIC_EVENTS.COMMAND_RUN_SUBMIT_DURATION,
];
