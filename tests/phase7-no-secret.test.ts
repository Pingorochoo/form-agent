/**
 * Phase 7 secret/privacy sentinel tests (P7-R5, P7-R19).
 *
 * Proves the bounded catalog plus metrics output never carry raw answers,
 * profile values, form text, prompts/responses, or credentials. Uses the
 * accepted sentinels and the loopback LLM stub only.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleCmdDraft } from '../src/cli/draft.ts';
import { handleCmdMetrics } from '../src/cli/metrics.ts';
import { ExitCodes } from '../src/cli/exit-codes.ts';
import { METRIC_EVENTS } from '../src/metrics/catalog.ts';
import { MetricsStore } from '../src/metrics/store.ts';
import { LlmStub, SECRET_SENTINEL } from './support/phase6-llm-stub.ts';
import { captureStdout, makeMetricsCtx, openDb, readStdout } from './support/phase7.ts';

const METRICS_SENTINEL = 'VERY_SECRET_METRICS_VALUE';
const BROWSER_SENTINEL = 'VERY_SECRET_BROWSER_VALUE';
const FIXTURE_URL = 'https://fixtures.local/forms/observed-responder';
const STUB_ANSWER = 'synthetic stub answer';

const STUBS: LlmStub[] = [];
const PREV_KEY = process.env.FORM_AGENT_LLM_API_KEY;

afterEach(async () => {
  vi.restoreAllMocks();
  if (PREV_KEY === undefined) delete process.env.FORM_AGENT_LLM_API_KEY;
  else process.env.FORM_AGENT_LLM_API_KEY = PREV_KEY;
  for (const stub of STUBS.splice(0)) await stub.stop();
});

function forEachSentinel(assert: (sentinel: string, haystack: string) => void, haystack: string): void {
  for (const sentinel of [METRICS_SENTINEL, SECRET_SENTINEL, BROWSER_SENTINEL, STUB_ANSWER]) {
    assert(sentinel, haystack);
  }
}

describe('P7-R19 — no secrets/raw data in metrics output', () => {
  it('keeps sentinels out of metrics_events, summary, JSON, CSV and logs', async () => {
    const stub = new LlmStub();
    stub.setScenario('valid');
    const url = await stub.start();
    STUBS.push(stub);

    const { ctx, dir, logs } = makeMetricsCtx({
      configure: (config) => {
        config.llm.providers = {
          'openai-compatible': {
            type: 'openai-compatible',
            baseUrl: url,
            model: 'stub-model-1',
            apiKeyEnv: 'FORM_AGENT_LLM_API_KEY',
            allowRemote: false,
            enabled: true,
          } as never,
        };
      },
    });
    process.env.FORM_AGENT_LLM_API_KEY = SECRET_SENTINEL;

    // Rejected categorical sentinel must never reach the store.
    const db = openDb(dir);
    try {
      const warnings: number[] = [];
      const store = new MetricsStore(db, { onWarning: () => warnings.push(1) });
      store.recordCategorical(METRIC_EVENTS.CONSISTENCY_STATUS as never, METRICS_SENTINEL);
      expect(warnings.length).toBe(1);
      const rows = db.db.prepare('SELECT * FROM metrics_events').all();
      expect(JSON.stringify(rows)).not.toContain(METRICS_SENTINEL);
    } finally {
      db.close();
    }

    // Real-provider draft (loopback stub) with the credential sentinel.
    const draftStdout = captureStdout();
    const code = await handleCmdDraft(
      [FIXTURE_URL, '--seed', 'seed-secret-p7', '--draft-provider', 'openai-compatible'],
      ctx,
    );
    const draftOutput = readStdout(draftStdout);
    draftStdout.mockRestore();
    expect(code).toBe(ExitCodes.SUCCESS);

    const summaryStdout = captureStdout();
    await handleCmdMetrics(['summary'], ctx);
    const summary = readStdout(summaryStdout);
    summaryStdout.mockRestore();

    const jsonStdout = captureStdout();
    await handleCmdMetrics(['export', '--format', 'json'], ctx);
    const json = readStdout(jsonStdout);
    jsonStdout.mockRestore();

    const csvStdout = captureStdout();
    await handleCmdMetrics(['export', '--format', 'csv'], ctx);
    const csv = readStdout(csvStdout);
    csvStdout.mockRestore();

    forEachSentinel((sentinel, haystack) => expect(haystack).not.toContain(sentinel), summary);
    forEachSentinel((sentinel, haystack) => expect(haystack).not.toContain(sentinel), json);
    forEachSentinel((sentinel, haystack) => expect(haystack).not.toContain(sentinel), csv);
    expect(logs.join('\n')).not.toContain(SECRET_SENTINEL);
    expect(draftOutput).not.toContain(SECRET_SENTINEL);
  }, 30_000);
});
