/**
 * Phase 7 LLM audit-gap + usage-fidelity tests (P7-R10a, P7-R11).
 *
 * Proves: `draft`/`check` now attempt the audit-only DB open and persist
 * `llm_calls` rows for real-provider calls; a usable provider token count
 * (including a real 0) is preserved; missing/invalid values persist as SQL
 * NULL and are never fabricated. Uses only the loopback stub + in-process fake
 * fetch — no real cloud model.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openAiChatCompletions, type OpenAiCompatibleTransportConfig } from '../src/llm/openai-compatible.ts';
import { normalizeOpenAiEndpoint } from '../src/llm/endpoint.ts';
import { LlmCallStore } from '../src/llm/audit.ts';
import { handleCmdDraft } from '../src/cli/draft.ts';
import { handleCmdCheck } from '../src/cli/check.ts';
import { ExitCodes } from '../src/cli/exit-codes.ts';
import { FormAgentDatabase } from '../src/db/database.ts';
import { LlmStub } from './support/phase6-llm-stub.ts';
import { captureStdout, makeMetricsCtx, openDb, readStdout } from './support/phase7.ts';

const FIXTURE_URL = 'https://fixtures.local/forms/observed-responder';

afterEach(() => {
  vi.restoreAllMocks();
});

function transportConfig(): OpenAiCompatibleTransportConfig {
  return {
    endpoint: normalizeOpenAiEndpoint('http://127.0.0.1:9/v1'),
    model: 'stub-model-1',
    apiKey: null,
    timeoutMs: 1000,
    maxOutputTokens: undefined,
    maxResponseBytes: 2 * 1024 * 1024,
  };
}

function envelopeWithUsage(usage: unknown): string {
  return JSON.stringify({
    model: 'stub-model-1',
    choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    usage,
  });
}

function fetchReturning(body: string): typeof fetch {
  return (async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

async function usageFrom(usage: unknown): Promise<{ inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined }> {
  const result = await openAiChatCompletions(
    transportConfig(),
    { system: 'sys', user: '{}' },
    fetchReturning(envelopeWithUsage(usage)),
  );
  return result.usage;
}

describe('P7-R10a — usage normalization', () => {
  it('preserves real numeric usage including a real zero', async () => {
    expect(await usageFrom({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 })).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
    expect(await usageFrom({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  it('normalizes missing/string/negative/fractional/non-finite/invalid to undefined', async () => {
    expect(await usageFrom({})).toEqual({ inputTokens: undefined, outputTokens: undefined, totalTokens: undefined });
    expect(
      await usageFrom({ prompt_tokens: '10', completion_tokens: null, total_tokens: true }),
    ).toEqual({ inputTokens: undefined, outputTokens: undefined, totalTokens: undefined });
    expect(await usageFrom({ prompt_tokens: -1, completion_tokens: 1.5, total_tokens: 2.25 })).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    });
    // Non-finite JSON numbers (1e999 parses to Infinity) are invalid.
    const nonFinite = await openAiChatCompletions(
      transportConfig(),
      { system: 'sys', user: '{}' },
      fetchReturning(
        '{"model":"m","choices":[{"message":{"content":"{}"}}],"usage":{"prompt_tokens":1e999,"completion_tokens":-1e999,"total_tokens":1e999}}',
      ),
    );
    expect(nonFinite.usage).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    });
  });

  it('persists missing usage as SQL NULL (never 0) and real usage as numbers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-p7-usage-'));
    const database = FormAgentDatabase.open({ directory: dir, filename: 'usage.db' });
    try {
      const store = new LlmCallStore(database);
      const missing = await openAiChatCompletions(
        transportConfig(),
        { system: 'sys', user: '{}' },
        fetchReturning(envelopeWithUsage({})),
      );
      store.record({
        providerId: 'openai-compatible',
        model: 'stub-model-1',
        stage: 'semantics',
        status: 'success',
        durationMs: missing.latencyMs,
        ...(missing.usage.inputTokens !== undefined ? { inputTokens: missing.usage.inputTokens } : {}),
        ...(missing.usage.outputTokens !== undefined ? { outputTokens: missing.usage.outputTokens } : {}),
        ...(missing.usage.totalTokens !== undefined ? { totalTokens: missing.usage.totalTokens } : {}),
      });
      const real = await openAiChatCompletions(
        transportConfig(),
        { system: 'sys', user: '{}' },
        fetchReturning(envelopeWithUsage({ prompt_tokens: 0, completion_tokens: 5, total_tokens: 5 })),
      );
      store.record({
        providerId: 'openai-compatible',
        model: 'stub-model-1',
        stage: 'answer',
        status: 'success',
        durationMs: real.latencyMs,
        ...(real.usage.inputTokens !== undefined ? { inputTokens: real.usage.inputTokens } : {}),
        ...(real.usage.outputTokens !== undefined ? { outputTokens: real.usage.outputTokens } : {}),
        ...(real.usage.totalTokens !== undefined ? { totalTokens: real.usage.totalTokens } : {}),
      });

      const rows = database.db
        .prepare('SELECT stage, input_tokens, output_tokens, total_tokens FROM llm_calls ORDER BY id')
        .all() as Array<{ stage: string; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null }>;
      expect(rows[0]).toEqual({ stage: 'semantics', input_tokens: null, output_tokens: null, total_tokens: null });
      expect(rows[1]).toEqual({ stage: 'answer', input_tokens: 0, output_tokens: 5, total_tokens: 5 });
    } finally {
      database.close();
    }
  });
});

describe('P7-R11 — draft/check audit gap is closed', () => {
  it('draft persists llm_calls rows through the wired recordCall hook', async () => {
    const stub = new LlmStub();
    stub.setScenario('valid');
    const url = await stub.start();
    try {
      const { ctx, dir } = makeMetricsCtx({
        configure: (config) => {
          config.llm.providers = {
            'openai-compatible': {
              type: 'openai-compatible',
              baseUrl: url,
              model: 'stub-model-1',
              allowRemote: false,
              enabled: true,
            } as never,
          };
        },
      });
      const stdout = captureStdout();
      const code = await handleCmdDraft(
        [FIXTURE_URL, '--seed', 'seed-gap-1', '--draft-provider', 'openai-compatible'],
        ctx,
      );
      stdout.mockRestore();
      expect(code).toBe(ExitCodes.SUCCESS);

      const db = openDb(dir);
      try {
        const rows = db.db
          .prepare('SELECT provider_id, stage, status FROM llm_calls ORDER BY id')
          .all() as Array<{ provider_id: string; stage: string; status: string }>;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.provider_id === 'openai-compatible')).toBe(true);
        expect(rows.every((row) => row.status === 'success')).toBe(true);
        expect(rows.map((row) => row.stage)).toEqual(expect.arrayContaining(['semantics', 'profile', 'answer']));
      } finally {
        db.close();
      }
    } finally {
      await stub.stop();
    }
  }, 30_000);

  it('check persists llm_calls rows too', async () => {
    const stub = new LlmStub();
    stub.setScenario('valid');
    const url = await stub.start();
    try {
      const { ctx, dir } = makeMetricsCtx({
        configure: (config) => {
          config.llm.providers = {
            'openai-compatible': {
              type: 'openai-compatible',
              baseUrl: url,
              model: 'stub-model-1',
              allowRemote: false,
              enabled: true,
            } as never,
          };
        },
      });
      const stdout = captureStdout();
      const code = await handleCmdCheck(
        [FIXTURE_URL, '--seed', 'seed-gap-2', '--draft-provider', 'openai-compatible'],
        ctx,
      );
      stdout.mockRestore();
      expect(code).toBe(ExitCodes.SUCCESS);
      const db = openDb(dir);
      try {
        const count = (db.db.prepare('SELECT COUNT(*) AS n FROM llm_calls').get() as { n: number }).n;
        expect(count).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    } finally {
      await stub.stop();
    }
  }, 30_000);

  it('an audit-only DB open failure leaves draft output/exit unchanged', async () => {
    const { ctx, dir } = makeMetricsCtx();
    void dir;
    // Point the database directory at an existing FILE so the audit open fails.
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const badDir = join(mkdtempSync(join(tmpdir(), 'form-agent-p7-bad-')), 'not-a-directory');
    writeFileSync(badDir, 'x');
    ctx.config.database.directory = badDir;

    const stdout = captureStdout();
    const code = await handleCmdDraft([FIXTURE_URL, '--seed', 'seed-gap-3'], ctx);
    const output = stdout.mock.calls.map((call) => String(call[0])).join('');
    stdout.mockRestore();
    expect(code).toBe(ExitCodes.SUCCESS);
    expect(output).toContain('Provider: deterministic-reference');
  });

  it('an LLM audit RECORD failure leaves draft output/exit unchanged', async () => {
    const stub = new LlmStub();
    stub.setScenario('valid');
    const url = await stub.start();
    // Force the audit store write itself to fail; the best-effort recordCall
    // boundary must absorb it and only emit a stable redacted warning.
    const recordSpy = vi.spyOn(LlmCallStore.prototype, 'record').mockImplementation(() => {
      throw new Error('audit boom');
    });
    try {
      const { ctx, logs } = makeMetricsCtx({
        configure: (config) => {
          config.llm.providers = {
            'openai-compatible': {
              type: 'openai-compatible',
              baseUrl: url,
              model: 'stub-model-1',
              allowRemote: false,
              enabled: true,
            } as never,
          };
        },
      });
      const stdout = captureStdout();
      const code = await handleCmdDraft(
        [FIXTURE_URL, '--seed', 'seed-audit-fail', '--draft-provider', 'openai-compatible'],
        ctx,
      );
      const output = readStdout(stdout);
      stdout.mockRestore();
      expect(code).toBe(ExitCodes.SUCCESS);
      expect(output).toContain('Provider: openai-compatible');
      expect(logs.join('\n')).toContain('llm audit recording skipped');
      expect(logs.join('\n')).not.toContain('audit boom');
    } finally {
      recordSpy.mockRestore();
      await stub.stop();
    }
  }, 30_000);
});
