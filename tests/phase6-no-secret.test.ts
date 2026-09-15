/**
 * Phase 6 secret-sentinel safety tests (P6-R10, R15, docs/PHASE_6.md §21/§22).
 *
 * Proves the sentinel `VERY_SECRET_LLM_TOKEN` reaches ONLY the intended
 * Authorization header of the local loopback stub, and never appears in the
 * JSON prompt body, stdout, logger output, llm_calls metadata, execution plan
 * snapshot, execution receipt, or provider error prose.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ExecutionOrchestrator } from '../src/execution/orchestrate.ts';
import { resolveExecutionProvider } from '../src/providers/execution.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';
import { resolveDraftProvider } from '../src/draft/resolve.ts';
import { handleCmdDraft } from '../src/cli/draft.ts';
import { ExitCodes } from '../src/cli/exit-codes.ts';
import type { CliContext } from '../src/cli/index.ts';
import { defaultConfig } from '../src/config/schema.ts';
import { LlmCallStore } from '../src/llm/audit.ts';
import { ExecutionPlanSnapshotStore } from '../src/execution/snapshot.ts';
import { ReceiptStore } from '../src/execution/receipt.ts';
import { createLogger, type Logger } from '../src/logging/logger.ts';
import { LlmStub, SECRET_SENTINEL } from './support/phase6-llm-stub.ts';
import { buildSectionlessSchema } from './support/sample-schema.ts';
import { allowFixture, makeConfig, makeDatabase, resolveRules, startHarnessContext, type HarnessContext, type TempDatabase } from './support/phase5.ts';
import type { AppConfig } from '../src/config/schema.ts';

const FIXTURE_URL = 'https://fixtures.local/forms/observed-responder';

let harness: HarnessContext;
let db: TempDatabase;
const STUBS: LlmStub[] = [];

async function makeStub(): Promise<string> {
  const stub = new LlmStub();
  stub.setScenario('valid');
  STUBS.push(stub);
  return stub.start();
}

function readStdout(stdout: { mock: { calls: Array<Array<unknown>> } }): string {
  return stdout.mock.calls.map((call) => String(call[0])).join('');
}

afterEach(async () => {
  for (const stub of STUBS.splice(0)) {
    await stub.stop();
  }
});

function configWithKey(stubUrl: string): AppConfig {
  const config = makeConfig(db.dir);
  config.llm.draftProvider = 'openai-compatible';
  config.llm.providers = {
    'openai-compatible': {
      type: 'openai-compatible',
      baseUrl: stubUrl,
      model: 'stub-model-1',
      apiKeyEnv: 'FORM_AGENT_LLM_API_KEY',
      allowRemote: false,
      enabled: true,
    } as never,
  };
  return config;
}

describe('P6-R10/R15 — secret sentinel safety', () => {
  beforeAll(async () => {
    harness = await startHarnessContext();
    db = makeDatabase();
    allowFixture(db.database, 'exec-success');
  });

  afterAll(async () => {
    db.cleanup();
    await harness.cleanup();
  });

  it('the sentinel reaches only the Authorization header and never leaks anywhere', async () => {
    const stubUrl = await makeStub();
    const config = configWithKey(stubUrl);
    const llmCalls = new LlmCallStore(db.database);
    const resolved = resolveDraftProvider('openai-compatible', {
      config,
      env: { FORM_AGENT_LLM_API_KEY: SECRET_SENTINEL },
      recordCall: (entry) => llmCalls.record(entry),
    });

    const logs: string[] = [];
    const logger: Logger = createLogger(config, { sink: (line) => logs.push(line) });
    void logger;

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const target = canonicalizeTarget('exec-success');
      const orchestrator = new ExecutionOrchestrator({
        config,
        database: db.database,
        sensitiveRules: resolveRules(),
        provider: resolveExecutionProvider(target, harness.baseUrl),
        target,
        rawTarget: 'exec-success',
        seed: 'seed-secret-1',
        draftProvider: resolved.provider,
        draftProviderProvenance: resolved.provenance,
      });
      const preflight = await orchestrator.preflight();
      const planId = preflight.plan.planId;

      // 1. Sentinel only in the intended Authorization header.
      const stub = STUBS[0] as LlmStub;
      for (const request of stub.requests) {
        expect(request.authorization).toBe(`Bearer ${SECRET_SENTINEL}`);
        expect(request.system).not.toContain(SECRET_SENTINEL);
        expect(request.user).not.toContain(SECRET_SENTINEL);
      }

      // 2. Not in stdout.
      const stdoutText = stdout.mock.calls.map((call) => String(call[0])).join('');
      expect(stdoutText).not.toContain(SECRET_SENTINEL);

      // 3. Not in the snapshot (bundle JSON + provenance columns).
      const snapshot = new ExecutionPlanSnapshotStore(db.database).load(planId);
      expect(snapshot).not.toBeNull();
      expect(JSON.stringify(snapshot)).not.toContain(SECRET_SENTINEL);
      expect(snapshot?.bundleJson).not.toContain(SECRET_SENTINEL);

      // 4. Not in llm_calls metadata.
      const rows = db.database.db.prepare('SELECT * FROM llm_calls').all();
      expect(JSON.stringify(rows)).not.toContain(SECRET_SENTINEL);

      // 5. Not in the execution receipt.
      const receipts = new ReceiptStore(db.database).list();
      expect(JSON.stringify(receipts)).not.toContain(SECRET_SENTINEL);

      // 6. Not in tracked config.
      expect(JSON.stringify(config)).not.toContain(SECRET_SENTINEL);
    } finally {
      stdout.mockRestore();
    }
  }, 60_000);

  it('provider errors never echo the sentinel', async () => {
    const badConfig = configWithKey('http://127.0.0.1:1/v1');
    const badResolved = resolveDraftProvider('openai-compatible', {
      config: badConfig,
      env: { FORM_AGENT_LLM_API_KEY: SECRET_SENTINEL },
    });

    const schema = buildSectionlessSchema();
    try {
      await badResolved.provider.interpretForm(schema, 'seed');
      throw new Error('expected failure');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(SECRET_SENTINEL);
    }
  });
});

describe('Finding G — CLI-level secret regression', () => {
  function cliConfig(stubUrl: string): AppConfig {
    const config = defaultConfig();
    config.llm.providers = {
      'openai-compatible': {
        type: 'openai-compatible',
        baseUrl: stubUrl,
        model: 'stub-model-1',
        apiKeyEnv: 'FORM_AGENT_LLM_API_KEY',
        allowRemote: false,
        enabled: true,
      } as never,
    };
    return config;
  }

  function makeCliCtx(config: AppConfig): { ctx: CliContext; logs: string[] } {
    const logs: string[] = [];
    const logger: Logger = createLogger(config, { sink: (line) => logs.push(line) });
    return { ctx: { config, logger }, logs };
  }

  it('a normal real-provider CLI flow keeps the sentinel out of stdout, logger, and prompt body', async () => {
    const stubUrl = await makeStub();
    const { ctx, logs } = makeCliCtx(cliConfig(stubUrl));

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const prevKey = process.env.FORM_AGENT_LLM_API_KEY;
    process.env.FORM_AGENT_LLM_API_KEY = SECRET_SENTINEL;
    try {
      const code = await handleCmdDraft([FIXTURE_URL, '--seed', 'x', '--draft-provider', 'openai-compatible'], ctx);
      expect(code).toBe(ExitCodes.SUCCESS);

      expect(readStdout(stdout)).not.toContain(SECRET_SENTINEL);
      expect(logs.join('\n')).not.toContain(SECRET_SENTINEL);

      // The sentinel reaches only the intended Authorization header.
      const stub = STUBS[STUBS.length - 1] as LlmStub;
      expect(stub.requests.length).toBeGreaterThan(0);
      for (const request of stub.requests) {
        expect(request.authorization).toBe(`Bearer ${SECRET_SENTINEL}`);
        expect(request.system).not.toContain(SECRET_SENTINEL);
        expect(request.user).not.toContain(SECRET_SENTINEL);
      }
    } finally {
      if (prevKey === undefined) delete process.env.FORM_AGENT_LLM_API_KEY;
      else process.env.FORM_AGENT_LLM_API_KEY = prevKey;
      stdout.mockRestore();
    }
  });

  it('a provider-failure CLI flow keeps the sentinel out of user-facing error prose', async () => {
    const { ctx, logs } = makeCliCtx(cliConfig('http://127.0.0.1:1/v1'));

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const prevKey = process.env.FORM_AGENT_LLM_API_KEY;
    process.env.FORM_AGENT_LLM_API_KEY = SECRET_SENTINEL;
    try {
      const code = await handleCmdDraft([FIXTURE_URL, '--seed', 'x', '--draft-provider', 'openai-compatible'], ctx);
      expect(code).toBe(ExitCodes.LLM_OFFLINE);

      const combined = `${logs.join('\n')}\n${readStdout(stdout)}`;
      expect(combined).not.toContain(SECRET_SENTINEL);
    } finally {
      if (prevKey === undefined) delete process.env.FORM_AGENT_LLM_API_KEY;
      else process.env.FORM_AGENT_LLM_API_KEY = prevKey;
      stdout.mockRestore();
    }
  });
});
