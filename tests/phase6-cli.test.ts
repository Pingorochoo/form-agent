/**
 * Phase 6 CLI tests (P6-R13, docs/PHASE_6.md §24).
 *
 * Covers `--draft-provider` selection across the draft-producing commands,
 * stable LLM error exit mapping, loopback vs remote consent, secret-safe
 * config failures, and the frozen non-echo/usage behavior. The successful
 * openai-compatible path uses only the loopback LLM stub.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleCmdDraft } from '../src/cli/draft.ts';
import { handleCmdCheck } from '../src/cli/check.ts';
import { handleCmdRun } from '../src/cli/run.ts';
import { ExitCodes } from '../src/cli/exit-codes.ts';
import type { CliContext } from '../src/cli/index.ts';
import { defaultConfig, type AppConfig } from '../src/config/schema.ts';
import { createLogger, type Logger } from '../src/logging/logger.ts';
import { FormAgentDatabase } from '../src/db/database.ts';
import { AuthorizationStore } from '../src/policy/authz.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';
import { LlmStub } from './support/phase6-llm-stub.ts';

const FIXTURE_URL = 'https://fixtures.local/forms/observed-responder';
const DIRS: string[] = [];
const STUBS: LlmStub[] = [];

function makeCtx(config?: AppConfig): { ctx: CliContext; logs: string[] } {
  const base = config ?? defaultConfig();
  base.database.directory = mkdtempSync(join(tmpdir(), 'form-agent-p6-cli-'));
  DIRS.push(base.database.directory);
  const logs: string[] = [];
  const logger: Logger = createLogger(base, { sink: (line) => logs.push(line) });
  return { ctx: { config: base, logger }, logs };
}

function openAiConfig(stubUrl: string, overrides: Record<string, unknown> = {}): AppConfig {
  const config = defaultConfig();
  config.llm.providers = {
    'openai-compatible': {
      type: 'openai-compatible',
      baseUrl: stubUrl,
      model: 'stub-model-1',
      allowRemote: false,
      enabled: true,
      ...overrides,
    } as never,
  };
  return config;
}

function makeRunCtx(configure?: (config: AppConfig) => void): { ctx: CliContext; logs: string[]; dir: string } {
  const config = defaultConfig();
  config.safety.mode = 'test-only';
  config.database.directory = mkdtempSync(join(tmpdir(), 'form-agent-p6-run-'));
  config.browser.headless = true;
  DIRS.push(config.database.directory);
  // Allowlist the fixture in the same database the CLI will open.
  const db = FormAgentDatabase.open({ directory: config.database.directory, filename: 'form-agent.db' });
  new AuthorizationStore(db).allow(canonicalizeTarget('exec-success'), 'run', 'op');
  db.close();
  configure?.(config);
  const logs: string[] = [];
  const logger: Logger = createLogger(config, { sink: (line) => logs.push(line) });
  return { ctx: { config, logger }, logs, dir: config.database.directory };
}

function captureStdout() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

function readStdout(stdout: { mock: { calls: Array<Array<unknown>> } }): string {
  return stdout.mock.calls.map((call) => String(call[0])).join('');
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of DIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  for (const stub of STUBS.splice(0)) {
    await stub.stop();
  }
});

describe('P6-R13 — default reference provider', () => {
  it('draft defaults to the network-free reference provider', async () => {
    const { ctx } = makeCtx();
    const stdout = captureStdout();
    const code = await handleCmdDraft([FIXTURE_URL, '--seed', 'respondent-001'], ctx);
    expect(code).toBe(ExitCodes.SUCCESS);
    expect(readStdout(stdout)).toContain('Provider: deterministic-reference');
  });

  it('check defaults to the reference provider', async () => {
    const { ctx } = makeCtx();
    const stdout = captureStdout();
    const code = await handleCmdCheck([FIXTURE_URL, '--seed', 'respondent-001', '--json'], ctx);
    expect(code).toBe(ExitCodes.SUCCESS);
    expect(readStdout(stdout)).toContain('"id": "deterministic-reference"');
  });
});

describe('P6-R13 — explicit openai-compatible selection', () => {
  it('draft selects openai-compatible and contacts only the loopback stub', async () => {
    const stub = new LlmStub();
    stub.setScenario('valid');
    const url = await stub.start();
    STUBS.push(stub);

    const { ctx } = makeCtx(openAiConfig(url));
    const stdout = captureStdout();
    const code = await handleCmdDraft([FIXTURE_URL, '--seed', 'respondent-001', '--draft-provider', 'openai-compatible'], ctx);
    expect(code).toBe(ExitCodes.SUCCESS);
    expect(readStdout(stdout)).toContain('Provider: openai-compatible');
    expect(stub.requestCount()).toBeGreaterThan(0);
  });

  it('rejects an unknown --draft-provider value', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdDraft([FIXTURE_URL, '--seed', 'x', '--draft-provider', 'bogus'], ctx)).toBe(ExitCodes.USAGE);
    expect(await handleCmdCheck([FIXTURE_URL, '--seed', 'x', '--draft-provider', 'bogus'], ctx)).toBe(ExitCodes.USAGE);
  });
});

describe('P6-R4/R5/R10 — config + secret + endpoint failures map to frozen exit codes', () => {
  it('missing openai-compatible provider config -> usage (2)', async () => {
    const { ctx } = makeCtx(); // no openai-compatible provider defined
    expect(await handleCmdDraft([FIXTURE_URL, '--seed', 'x', '--draft-provider', 'openai-compatible'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('missing model -> usage (2)', async () => {
    const stub = new LlmStub();
    const url = await stub.start();
    STUBS.push(stub);
    const { ctx } = makeCtx(openAiConfig(url, { model: undefined }));
    expect(await handleCmdDraft([FIXTURE_URL, '--seed', 'x', '--draft-provider', 'openai-compatible'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('configured API-key env missing -> usage (2), without echoing the value', async () => {
    const stub = new LlmStub();
    const url = await stub.start();
    STUBS.push(stub);
    const { ctx, logs } = makeCtx(openAiConfig(url, { apiKeyEnv: 'FORM_AGENT_LLM_API_KEY' }));
    const code = await handleCmdDraft([FIXTURE_URL, '--seed', 'x', '--draft-provider', 'openai-compatible'], ctx);
    expect(code).toBe(ExitCodes.USAGE);
    expect(logs.join('\n')).toContain('FORM_AGENT_LLM_API_KEY');
    expect(logs.join('\n')).not.toContain('VERY_SECRET_LLM_TOKEN');
  });

  it('non-loopback endpoint without allowRemote -> usage (2)', async () => {
    const config = openAiConfig('https://api.example.com/v1');
    config.llm.providers['openai-compatible'] = {
      type: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      allowRemote: false,
      enabled: true,
    } as never;
    const { ctx } = makeCtx(config);
    expect(await handleCmdDraft([FIXTURE_URL, '--seed', 'x', '--draft-provider', 'openai-compatible'], ctx)).toBe(ExitCodes.USAGE);
  });

  it('loopback endpoint is allowed without allowRemote', async () => {
    const stub = new LlmStub();
    stub.setScenario('valid');
    const url = await stub.start();
    STUBS.push(stub);
    const { ctx } = makeCtx(openAiConfig(url));
    const stdout = captureStdout();
    const code = await handleCmdDraft([FIXTURE_URL, '--seed', 'x', '--draft-provider', 'openai-compatible'], ctx);
    expect(code).toBe(ExitCodes.SUCCESS);
    expect(readStdout(stdout)).toContain('openai-compatible');
  });

  it('unreachable loopback endpoint -> LLM offline (4)', async () => {
    const { ctx } = makeCtx(openAiConfig('http://127.0.0.1:1/v1'));
    const code = await handleCmdDraft([FIXTURE_URL, '--seed', 'x', '--draft-provider', 'openai-compatible'], ctx);
    expect(code).toBe(ExitCodes.LLM_OFFLINE);
  });
});

describe('P6-R13 — frozen non-echo usage behavior', () => {
  it('an unknown flag never echoes its secret contents', async () => {
    const { ctx, logs } = makeCtx();
    const stdout = captureStdout();
    const code = await handleCmdDraft([FIXTURE_URL, '--seed', 'x', '--token=VERY_SECRET_LLM_TOKEN'], ctx);
    expect(code).toBe(ExitCodes.USAGE);
    expect(readStdout(stdout)).not.toContain('VERY_SECRET_LLM_TOKEN');
    expect(logs.join('\n')).not.toContain('VERY_SECRET_LLM_TOKEN');
  });

  it('--draft-provider without a value is a controlled usage error', async () => {
    const { ctx } = makeCtx();
    expect(await handleCmdDraft([FIXTURE_URL, '--seed', 'x', '--draft-provider'], ctx)).toBe(ExitCodes.USAGE);
  });
});

describe('Finding D — preflight output exposes safe provider provenance', () => {
  it('reference preflight human output identifies the draft provider', async () => {
    const { ctx } = makeRunCtx();
    const stdout = captureStdout();
    const code = await handleCmdRun(['exec-success', '--seed', 'seed-d1'], ctx);
    expect(code).toBe(ExitCodes.SUCCESS);
    const output = readStdout(stdout);
    expect(output).toContain('Draft provider: deterministic-reference');
    expect(output).toContain('Plan ID:');
    expect(output).not.toContain('Model:');
    expect(output).not.toContain('Prompt contract:');
  }, 30_000);

  it('openai-compatible preflight JSON exposes id/model/prompt-contract', async () => {
    const stub = new LlmStub();
    stub.setScenario('valid');
    const url = await stub.start();
    STUBS.push(stub);

    const { ctx } = makeRunCtx((config) => {
      config.llm.providers = {
        'openai-compatible': {
          type: 'openai-compatible',
          baseUrl: url,
          model: 'stub-model-1',
          allowRemote: false,
          enabled: true,
        } as never,
      };
    });

    const stdout = captureStdout();
    const code = await handleCmdRun(['exec-success', '--seed', 'seed-d2', '--draft-provider', 'openai-compatible', '--json'], ctx);
    expect(code).toBe(ExitCodes.SUCCESS);
    const parsed = JSON.parse(readStdout(stdout)) as Record<string, unknown>;
    const draftProvider = parsed['draftProvider'] as Record<string, unknown>;
    expect(draftProvider['id']).toBe('openai-compatible');
    expect(draftProvider['version']).toBe('1.0.0');
    expect(draftProvider['model']).toBe('stub-model-1');
    expect(String(draftProvider['promptContractVersions'])).toContain('semantics=');
  }, 30_000);
});
