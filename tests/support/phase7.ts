/**
 * Shared Phase 7 test support.
 *
 * Deterministic, local-only helpers: temp databases, injected clocks, stdout
 * capture, and direct reads of `metrics_events`. No network and no sleeps.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

import { defaultConfig, type AppConfig } from '../../src/config/schema.ts';
import { createLogger, type Logger } from '../../src/logging/logger.ts';
import type { CliContext } from '../../src/cli/index.ts';
import type { MetricsClock } from '../../src/metrics/clock.ts';
import { FormAgentDatabase } from '../../src/db/database.ts';

/** A deterministic clock: fixed wall time + fixed monotonic start. */
export function fixedClock(wallMs = 1_700_000_000_000, monotonicMs = 0): MetricsClock {
  return {
    wallNowMs: () => wallMs,
    monotonicNowMs: () => monotonicMs,
  };
}

export interface MetricsCliCtx {
  ctx: CliContext;
  logs: string[];
  dir: string;
  config: AppConfig;
}

export interface MakeMetricsCtxOptions {
  dir?: string;
  clock?: MetricsClock;
  configure?: (config: AppConfig) => void;
}

export function makeMetricsCtx(options: MakeMetricsCtxOptions = {}): MetricsCliCtx {
  const config = defaultConfig();
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'form-agent-p7-'));
  config.database.directory = dir;
  config.database.filename = 'form-agent.db';
  config.safety.mode = 'test-only';
  config.rate.delayBetweenSubmissionsMs = 0;
  options.configure?.(config);
  const logs: string[] = [];
  const logger: Logger = createLogger(config, { sink: (line) => logs.push(line) });
  const ctx: CliContext = { config, logger };
  if (options.clock !== undefined) ctx.metricsClock = options.clock;
  return { ctx, logs, dir, config };
}

export function captureStdout() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

export function readStdout(stdout: { mock: { calls: Array<Array<unknown>> } }): string {
  return stdout.mock.calls.map((call) => String(call[0])).join('');
}

export function openDb(dir: string): FormAgentDatabase {
  return FormAgentDatabase.open({ directory: dir, filename: 'form-agent.db' });
}

export function metricsEventNames(dir: string): string[] {
  const db = openDb(dir);
  try {
    const rows = db.db
      .prepare('SELECT event FROM metrics_events ORDER BY id ASC')
      .all() as Array<{ event: string }>;
    return rows.map((row) => row.event);
  } finally {
    db.close();
  }
}

export function metricEventValues(dir: string, event: string): Array<{ value_num: number | null; value_text: string | null }> {
  const db = openDb(dir);
  try {
    return db.db
      .prepare('SELECT value_num, value_text FROM metrics_events WHERE event = ? ORDER BY id ASC')
      .all(event) as Array<{ value_num: number | null; value_text: string | null }>;
  } finally {
    db.close();
  }
}
