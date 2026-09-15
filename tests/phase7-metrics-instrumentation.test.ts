/**
 * Phase 7 per-command instrumentation tests (P7-R7, P7-R8).
 *
 * Proves the exact event matrix, that `draft` gains no consistency pass, that
 * duration is recorded on started success/failure only, that `run --submit`
 * adds only its own duration, and that snapshot `bundle_json` is never a
 * metrics source.
 */

import { describe, expect, it } from 'vitest';

import { handleCmdAnalyze } from '../src/cli/index.ts';
import { handleCmdDraft } from '../src/cli/draft.ts';
import { handleCmdCheck } from '../src/cli/check.ts';
import { handleCmdRun } from '../src/cli/run.ts';
import { handleCmdMetrics } from '../src/cli/metrics.ts';
import { ExitCodes } from '../src/cli/exit-codes.ts';
import { METRIC_EVENTS } from '../src/metrics/catalog.ts';
import { readAggregates } from '../src/metrics/aggregate.ts';
import { AuthorizationStore } from '../src/policy/authz.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';
import { openDb, makeMetricsCtx, metricsEventNames, captureStdout, readStdout } from './support/phase7.ts';

const FIXTURE_PATH = new URL('../fixtures/archives/observed-responder.html', import.meta.url);
const FIXTURE_URL = 'https://fixtures.local/forms/observed-responder';

const DRAFT_EVENTS = [
  METRIC_EVENTS.COMMAND_DRAFT_DURATION,
  METRIC_EVENTS.DRAFT_FIELDS_TOTAL,
  METRIC_EVENTS.DRAFT_ANSWERED_COUNT,
  METRIC_EVENTS.DRAFT_BLOCKED_COUNT,
  METRIC_EVENTS.DRAFT_UNSUPPORTED_COUNT,
  METRIC_EVENTS.DRAFT_VALIDATION_ERROR_COUNT,
  METRIC_EVENTS.DRAFT_REQUIRED_UNANSWERED_COUNT,
];

const CONSISTENCY_EVENTS = [
  METRIC_EVENTS.CONSISTENCY_HARD_ISSUES_COUNT,
  METRIC_EVENTS.CONSISTENCY_SOFT_ISSUES_COUNT,
  METRIC_EVENTS.CONSISTENCY_STATUS,
];

function sorted(events: string[]): string[] {
  return [...events].sort();
}

function allow(dir: string, fixtureId: string): void {
  const db = openDb(dir);
  try {
    new AuthorizationStore(db).allow(canonicalizeTarget(fixtureId), 'run', 'op');
  } finally {
    db.close();
  }
}

describe('P7-R8 — analyze', () => {
  it('records only command.analyze.duration', async () => {
    const { ctx, dir } = makeMetricsCtx();
    const stdout = captureStdout();
    const code = await handleCmdAnalyze(FIXTURE_PATH.pathname, ctx);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.SUCCESS);
    expect(metricsEventNames(dir)).toEqual([METRIC_EVENTS.COMMAND_ANALYZE_DURATION]);
  });
});

describe('P7-R8 — draft records draft counts and NO consistency', () => {
  it('records the duration + six draft counts exactly', async () => {
    const { ctx, dir } = makeMetricsCtx();
    const stdout = captureStdout();
    const code = await handleCmdDraft([FIXTURE_URL, '--seed', 'seed-draft-1'], ctx);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.SUCCESS);
    const events = metricsEventNames(dir);
    expect(sorted(events)).toEqual(sorted(DRAFT_EVENTS));
    expect(events.some((event) => event.startsWith('consistency.'))).toBe(false);
  });

  it('records the duration but no draft counts on a controlled LLM failure', async () => {
    const { ctx, dir } = makeMetricsCtx({
      configure: (config) => {
        config.llm.providers = {
          'openai-compatible': {
            type: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:1/v1',
            model: 'stub-model-1',
            allowRemote: false,
            enabled: true,
          } as never,
        };
      },
    });
    const stdout = captureStdout();
    const code = await handleCmdDraft(
      [FIXTURE_URL, '--seed', 'x', '--draft-provider', 'openai-compatible'],
      ctx,
    );
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.LLM_OFFLINE);
    expect(metricsEventNames(dir)).toEqual([METRIC_EVENTS.COMMAND_DRAFT_DURATION]);
  });

  it('records no duration for a usage error that never starts the operation', async () => {
    const { ctx, dir } = makeMetricsCtx();
    const code = await handleCmdDraft([FIXTURE_URL], ctx);
    expect(code).toBe(ExitCodes.USAGE);
    expect(metricsEventNames(dir)).toEqual([]);
  });

  it('a metrics write failure never changes draft output/exit (best-effort only)', async () => {
    const { ctx, dir, logs } = makeMetricsCtx({
      clock: { wallNowMs: () => 1000, monotonicNowMs: () => Number.NaN },
    });
    const stdout = captureStdout();
    const code = await handleCmdDraft([FIXTURE_URL, '--seed', 'seed-fail-iso'], ctx);
    const output = readStdout(stdout);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.SUCCESS);
    expect(output).toContain('Provider: deterministic-reference');
    expect(logs.join('\n')).toContain('metrics recording skipped');
    // The invalid duration was rejected; the valid count events still landed.
    expect(metricsEventNames(dir)).not.toContain(METRIC_EVENTS.COMMAND_DRAFT_DURATION);
  });
});

describe('P7-R8 — check records draft + consistency', () => {
  it('records command.check.duration + draft counts + consistency events', async () => {
    const { ctx, dir } = makeMetricsCtx();
    const stdout = captureStdout();
    const code = await handleCmdCheck([FIXTURE_URL, '--seed', 'seed-check-1'], ctx);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.SUCCESS);
    const events = metricsEventNames(dir);
    expect(sorted(events)).toEqual(
      sorted([
        METRIC_EVENTS.COMMAND_CHECK_DURATION,
        ...DRAFT_EVENTS.filter((event) => event !== METRIC_EVENTS.COMMAND_DRAFT_DURATION),
        ...CONSISTENCY_EVENTS,
      ]),
    );
  });

  it('records command.check.duration but no draft/consistency counts on a controlled LLM failure', async () => {
    const { ctx, dir } = makeMetricsCtx({
      configure: (config) => {
        config.llm.providers = {
          'openai-compatible': {
            type: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:1/v1',
            model: 'stub-model-1',
            allowRemote: false,
            enabled: true,
          } as never,
        };
      },
    });
    const stdout = captureStdout();
    const code = await handleCmdCheck(
      [FIXTURE_URL, '--seed', 'x', '--draft-provider', 'openai-compatible'],
      ctx,
    );
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.LLM_OFFLINE);
    expect(metricsEventNames(dir)).toEqual([METRIC_EVENTS.COMMAND_CHECK_DURATION]);
  });
});

describe('P7-R8 — run preflight and run --submit', () => {
  it('run preflight records its duration + draft + consistency; submit adds only submit duration', async () => {
    const { ctx, dir } = makeMetricsCtx();
    allow(dir, 'exec-success');

    const preflightStdout = captureStdout();
    const preflightCode = await handleCmdRun(
      ['exec-success', '--seed', 'seed-run-1', '--json'],
      ctx,
    );
    const preflightOutput = readStdout(preflightStdout);
    preflightStdout.mockRestore();
    expect(preflightCode).toBe(ExitCodes.SUCCESS);

    const preflightEvents = metricsEventNames(dir);
    expect(sorted(preflightEvents)).toEqual(
      sorted([
        METRIC_EVENTS.COMMAND_RUN_PREFLIGHT_DURATION,
        ...DRAFT_EVENTS.filter((event) => event !== METRIC_EVENTS.COMMAND_DRAFT_DURATION),
        ...CONSISTENCY_EVENTS,
      ]),
    );

    const plan = (JSON.parse(preflightOutput) as { plan: { planId: string } }).plan;
    const submitStdout = captureStdout();
    const submitCode = await handleCmdRun(
      ['exec-success', '--seed', 'seed-run-1', '--submit', '--expect-plan', plan.planId, '--by', 'op'],
      ctx,
    );
    submitStdout.mockRestore();
    expect(submitCode).toBe(ExitCodes.SUCCESS);

    const after = metricsEventNames(dir);
    const added = after.slice(preflightEvents.length);
    expect(added).toEqual([METRIC_EVENTS.COMMAND_RUN_SUBMIT_DURATION]);
  }, 60_000);
});

describe('P7-R8 — snapshots are never a metrics source', () => {
  it('draft counts disappear when metrics_events rows are removed, even with a snapshot present', async () => {
    const { ctx, dir } = makeMetricsCtx();
    allow(dir, 'exec-success');
    const stdout = captureStdout();
    const code = await handleCmdRun(['exec-success', '--seed', 'seed-src-1'], ctx);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.SUCCESS);

    const db = openDb(dir);
    try {
      // A snapshot with a non-empty bundle_json exists...
      const snapshot = db.db
        .prepare('SELECT bundle_json FROM execution_plan_snapshots LIMIT 1')
        .get() as { bundle_json: string } | undefined;
      expect(snapshot).toBeDefined();
      expect(typeof snapshot?.bundle_json).toBe('string');
      expect((snapshot?.bundle_json ?? '').length).toBeGreaterThan(0);

      // ...draft metric rows are removed...
      db.db.prepare("DELETE FROM metrics_events WHERE event LIKE 'draft.%'").run();
      const remaining = (
        db.db.prepare("SELECT COUNT(*) AS n FROM metrics_events WHERE event LIKE 'draft.%'").get() as { n: number }
      ).n;
      expect(remaining).toBe(0);

      // ...and the Phase 7 reader still reports no draft counts, proving it did
      // not reconstruct metrics by parsing snapshot bundle_json.
      const aggregates = readAggregates(db, { sinceMs: null, untilMs: null });
      expect(
        aggregates.metricsEvents.byEvent.some((row) => row.event.startsWith('draft.')),
      ).toBe(false);
    } finally {
      db.close();
    }

    // The export path is equally snapshot-independent.
    const exportStdout = captureStdout();
    expect(await handleCmdMetrics(['export', '--format', 'json'], ctx)).toBe(ExitCodes.SUCCESS);
    const document = JSON.parse(readStdout(exportStdout)) as {
      metricsEvents: { byEvent: Array<{ event: string }> };
    };
    exportStdout.mockRestore();
    expect(document.metricsEvents.byEvent.some((row) => row.event.startsWith('draft.'))).toBe(false);
  }, 60_000);
});
