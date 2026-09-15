/**
 * Phase 7 metrics CLI operational tests (P7-R12, P7-R13).
 *
 * Proves missing/empty/migration-8 DB success, the controlled error for an
 * unavailable required `metrics_events` source, strict usage parsing, and the
 * operational read-only contract (no network/LLM/browser, no new metric/
 * receipt/claim rows from querying).
 */

import { describe, expect, it, vi } from 'vitest';

import { handleCmdMetrics, type HandleMetricsOptions } from '../src/cli/metrics.ts';
import { ExitCodes } from '../src/cli/exit-codes.ts';
import { FormAgentDatabase } from '../src/db/database.ts';
import { captureStdout, makeMetricsCtx, openDb, readStdout } from './support/phase7.ts';

function seededReadOnlyDb(dir: string): void {
  const db = openDb(dir);
  try {
    db.db
      .prepare('INSERT INTO metrics_events (event, kind, value_num, value_text, at_ms) VALUES (?, ?, ?, ?, ?)')
      .run('command.analyze.duration', 'duration_ms', 12, null, 1000);
  } finally {
    db.close();
  }
}

describe('P7-R12 — missing / empty / migration-8 databases', () => {
  it('creates + migrates a missing DB and returns empty aggregates as success', async () => {
    const { ctx } = makeMetricsCtx();
    const stdout = captureStdout();
    const code = await handleCmdMetrics(['summary'], ctx);
    const output = readStdout(stdout);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.SUCCESS);
    expect(output).toContain('Metrics summary (0 events, 0 receipts, 0 llm_calls)');
  });

  it('returns empty aggregates for a zero-row metrics_events table', async () => {
    const { ctx, dir } = makeMetricsCtx();
    openDb(dir).close();
    const stdout = captureStdout();
    const code = await handleCmdMetrics(['export', '--format', 'json'], ctx);
    const output = readStdout(stdout);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.SUCCESS);
    const doc = JSON.parse(output) as { metricsEvents: { byEvent: unknown[] } };
    expect(doc.metricsEvents.byEvent).toEqual([]);
  });

  it('applies migration 9 to a migration-8 database as schema maintenance', async () => {
    const { ctx, dir } = makeMetricsCtx();
    const db = openDb(dir);
    db.db.exec('DROP TABLE metrics_events');
    db.db.prepare('DELETE FROM schema_migrations WHERE id = 9').run();
    db.close();

    const stdout = captureStdout();
    const code = await handleCmdMetrics(['summary'], ctx);
    const output = readStdout(stdout);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.SUCCESS);
    expect(output).toContain('0 events');

    const reopened = openDb(dir);
    try {
      const table = reopened.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metrics_events'")
        .all();
      expect(table).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it('returns a controlled error when metrics_events is missing after a successful open', async () => {
    const { ctx } = makeMetricsCtx();
    const openDatabase: NonNullable<HandleMetricsOptions['openDatabase']> = (options) => {
      const db = FormAgentDatabase.open(options);
      db.db.exec('DROP TABLE metrics_events');
      return db;
    };
    const stdout = captureStdout();
    const code = await handleCmdMetrics(['summary'], ctx, { openDatabase });
    const output = readStdout(stdout);
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.ERROR);
    expect(output).toBe('');
    expect(ctx.logger).toBeDefined();
  });
});

describe('P7-R12/R13 — strict usage parsing', () => {
  it('rejects summary --json, export without format, and unknown flags', async () => {
    const { ctx, logs } = makeMetricsCtx();
    expect(await handleCmdMetrics(['summary', '--json'], ctx)).toBe(ExitCodes.USAGE);
    expect(await handleCmdMetrics(['export'], ctx)).toBe(ExitCodes.USAGE);
    expect(await handleCmdMetrics(['export', '--format', 'xml'], ctx)).toBe(ExitCodes.USAGE);
    expect(await handleCmdMetrics(['unknown'], ctx)).toBe(ExitCodes.USAGE);
    expect(await handleCmdMetrics([], ctx)).toBe(ExitCodes.USAGE);
    expect(await handleCmdMetrics(['summary', '--bogus'], ctx)).toBe(ExitCodes.USAGE);
    expect(logs.join('\n')).not.toContain('--json');
  });

  it('rejects invalid time filters and inverted ranges as usage errors', async () => {
    const { ctx } = makeMetricsCtx();
    expect(await handleCmdMetrics(['summary', '--since', '2026-01-01'], ctx)).toBe(ExitCodes.USAGE);
    expect(await handleCmdMetrics(['summary', '--since', '2026-01-01T00:00:00'], ctx)).toBe(ExitCodes.USAGE);
    expect(
      await handleCmdMetrics(
        ['summary', '--since', '2026-02-01T00:00:00Z', '--until', '2026-01-01T00:00:00Z'],
        ctx,
      ),
    ).toBe(ExitCodes.USAGE);
    expect(
      await handleCmdMetrics(
        ['summary', '--since', '2026-01-01T00:00:00Z', '--until', '2026-01-01T00:00:00Z'],
        ctx,
      ),
    ).toBe(ExitCodes.USAGE);
  });

  it('accepts export --format json and csv without prose in the output', async () => {
    const { ctx } = makeMetricsCtx();
    const jsonStdout = captureStdout();
    expect(await handleCmdMetrics(['export', '--format', 'json'], ctx)).toBe(ExitCodes.SUCCESS);
    const jsonText = readStdout(jsonStdout);
    jsonStdout.mockRestore();
    expect(() => JSON.parse(jsonText)).not.toThrow();
    expect(jsonText).not.toContain('form-agent');

    const csvStdout = captureStdout();
    expect(await handleCmdMetrics(['export', '--format', 'csv'], ctx)).toBe(ExitCodes.SUCCESS);
    const csvText = readStdout(csvStdout);
    csvStdout.mockRestore();
    expect(csvText.startsWith('section,scope,dimension,metric,value,unit,observedCount,missingCount')).toBe(true);
  });
});

describe('P7-R12 — operational read-only behavior', () => {
  it('makes no network/LLM call and writes no new rows while querying', async () => {
    const { ctx, dir } = makeMetricsCtx();
    seededReadOnlyDb(dir);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const stdout = captureStdout();
    expect(await handleCmdMetrics(['export', '--format', 'json'], ctx)).toBe(ExitCodes.SUCCESS);
    expect(await handleCmdMetrics(['summary'], ctx)).toBe(ExitCodes.SUCCESS);
    stdout.mockRestore();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    const db = openDb(dir);
    try {
      const metrics = (db.db.prepare('SELECT COUNT(*) AS n FROM metrics_events').get() as { n: number }).n;
      const calls = (db.db.prepare('SELECT COUNT(*) AS n FROM llm_calls').get() as { n: number }).n;
      const claims = (
        db.db.prepare('SELECT COUNT(*) AS n FROM execution_receipts WHERE submit_attempted = 1').get() as {
          n: number;
        }
      ).n;
      expect(metrics).toBe(1);
      expect(calls).toBe(0);
      expect(claims).toBe(0);
    } finally {
      db.close();
    }
  });
});
