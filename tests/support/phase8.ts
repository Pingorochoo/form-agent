/**
 * Shared Phase 8 test support: a deterministic fake subprocess runner, isolated
 * temp pending data directories, an adapter factory, and canonical accepted
 * Form Agent JSON documents. No network, no real Telegram, no real OpenClaw.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

import { FormAgentAdapter } from '../../src/openclaw/adapter.ts';
import { PendingStore, type PendingRecord } from '../../src/openclaw/pending.ts';
import type { AdapterConfig, OperatorPrincipal } from '../../src/openclaw/contracts.ts';
import type { RunRequest, RunResult, SubprocessRunner } from '../../src/openclaw/runner.ts';

export const OPERATOR: OperatorPrincipal = {
  channel: 'telegram',
  accountId: 'formagent',
  senderId: '5550001',
};

export const FIXTURE_TARGET = 'demo-fixture';
export const FIXTURE_KEY = 'fixture:demo-fixture';
export const GOOGLE_TARGET = 'https://docs.google.com/forms/d/e/ABC123/viewform';
export const GOOGLE_KEY = `google-forms:${GOOGLE_TARGET}`;
export const PLAN_ID = 'a'.repeat(64);

/**
 * The trusted claimed identity that a started-submit machine document must bind
 * to (planId + target key/display + exact `telegram:<senderId>` operator).
 */
export const SUBMIT_CLAIM_IDENTITY = {
  planId: PLAN_ID,
  targetKey: FIXTURE_KEY,
  targetDisplay: FIXTURE_TARGET,
  operator: `telegram:${OPERATOR.senderId}`,
} as const;

export function testConfig(dataDir: string, overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return {
    adapterBinaryPath: '/opt/form-agent/bin/form-agent-openclaw.js',
    formAgentBinaryPath: '/opt/form-agent/bin/form-agent.js',
    // A fixed absolute deployment cwd — never the incidental process cwd.
    formAgentCwd: '/opt/form-agent',
    dataDir,
    operatorPrincipal: OPERATOR,
    allowedDraftProviders: ['reference', 'openai-compatible'],
    providerEnvNames: [],
    ...overrides,
  };
}

export function exitResult(code: number, stdout = '', stderr = ''): RunResult {
  return {
    kind: 'exit',
    code,
    signal: null,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    pid: 4242,
    processGroup: 4242,
  };
}

export class FakeRunner implements SubprocessRunner {
  readonly calls: RunRequest[] = [];
  private readonly queue: Array<RunResult> = [];
  /** Fires the spawn hook (simulating a successful start) before resolving. */
  simulateSpawn = true;

  enqueue(result: RunResult): void {
    this.queue.push(result);
  }

  async run(request: RunRequest): Promise<RunResult> {
    this.calls.push(request);
    const next = this.queue.shift();
    if (next === undefined) return exitResult(0, '{}');
    if (next.kind !== 'spawn_failed' && this.simulateSpawn) {
      await request.onSpawn?.({ pid: 4242, processGroup: 4242 });
    }
    return next;
  }
}

export interface AdapterFixture {
  adapter: FormAgentAdapter;
  store: PendingStore;
  runner: FakeRunner;
  config: AdapterConfig;
  dir: string;
  clock: { nowMs: number };
  cleanup(): void;
}

/** Build the exact (trusted) submit_pending arguments from a stored record. */
export function submitParams(record: PendingRecord): {
  operation: 'submit_pending';
  pendingRef: string;
  planId: string;
  targetKey: string;
  targetDisplay: string;
  expiresAtMs: number;
} {
  return {
    operation: 'submit_pending',
    pendingRef: record.pendingId,
    planId: record.planId,
    targetKey: record.targetKey,
    targetDisplay: record.targetDisplay,
    expiresAtMs: record.expiresAtMs,
  };
}

export function makeAdapter(options: {
  dir?: string;
  config?: Partial<AdapterConfig>;
  runner?: FakeRunner;
  nowMs?: number;
} = {}): AdapterFixture {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'form-agent-p8-'));
  const clock = { nowMs: options.nowMs ?? 1_700_000_000_000 };
  const config = testConfig(dir, options.config ?? {});
  const runner = options.runner ?? new FakeRunner();
  const store = new PendingStore({ dataDir: dir, clock: () => clock.nowMs });
  const adapter = new FormAgentAdapter({ config, runner, store });
  return {
    adapter,
    store,
    runner,
    config,
    dir,
    clock,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Accepted Form Agent machine documents
// ---------------------------------------------------------------------------

export function analyzeDoc(): string {
  return JSON.stringify({
    command: 'analyze',
    form: { id: 'form-1', title: 'Fixture Form' },
    fingerprint: 'f'.repeat(64),
    sections: [{ index: 0, title: 'Section 1', questionCount: 2 }],
    questions: { total: 2, required: 1, optional: 1 },
    kinds: { text: 1, 'single-choice': 1 },
    routing: 'sequential',
    answerModel: 'flat',
    terminalSectionIds: ['__default__'],
    policy: { scope: 'run', allowed: false, reasons: ['not-allowlisted'] },
  });
}

export function draftDoc(): string {
  return JSON.stringify({
    synthetic: true,
    seed: 'b'.repeat(32),
    draftId: 'd'.repeat(64),
    provider: { id: 'reference', version: '1.0.0' },
    fingerprint: 'f'.repeat(64),
    form: { id: 'form-1', title: 'Fixture Form' },
    summary: { total: 2, answered: 1, blocked: 1, unsupported: 0, validationErrors: 0, requiredUnanswered: 0, complete: true },
    results: [
      { questionId: 'q1', kind: 'text', required: true, state: 'answered', value: { kind: 'text', value: 'hello' } },
      { questionId: 'q2', kind: 'text', required: false, state: 'blocked-sensitive', categories: ['Email'], mode: 'block', reason: 'sensitive' },
    ],
  });
}

export function checkDoc(blocking = false): string {
  return JSON.stringify({
    command: 'check',
    synthetic: true,
    draftId: 'd'.repeat(64),
    fingerprint: 'f'.repeat(64),
    form: { id: 'form-1', title: 'Fixture Form' },
    summary: { total: 2, answered: 1, blocked: 1, unsupported: 0, validationErrors: 0, requiredUnanswered: 0, complete: true },
    consistency: {
      version: '1.0.0',
      reportId: 'e'.repeat(64),
      draftId: 'd'.repeat(64),
      fingerprint: 'f'.repeat(64),
      status: blocking ? 'block' : 'pass',
      blocking,
      hardIssues: blocking ? 1 : 0,
      softIssues: 0,
      issues: blocking ? [{ code: 'REQUIRED_QUESTION_UNANSWERED', severity: 'hard', questionIds: ['q1'], message: 'missing' }] : [],
    },
  });
}

export function preflightDoc(options: {
  target?: string;
  targetKey?: string;
  planId?: string;
  answers?: Array<{ questionId: string; kind: string; value: unknown }>;
} = {}): string {
  const target = options.target ?? FIXTURE_TARGET;
  const targetKey = options.targetKey ?? FIXTURE_KEY;
  const planId = options.planId ?? PLAN_ID;
  return JSON.stringify({
    command: 'run',
    mode: 'preflight',
    runId: 7,
    plan: {
      version: '2.0.0',
      planId,
      target: { key: targetKey, display: target },
      fingerprint: 'f'.repeat(64),
      draftId: 'd'.repeat(64),
      consistency: { reportId: 'e'.repeat(64), status: 'pass', hardIssues: 0, softIssues: 0 },
      provider: { id: 'fixture', version: '1.0.0' },
      fillableCount: 1,
      blockedCount: 1,
      policy: { allowed: true, reasons: [] },
    },
    draftProvider: { id: 'reference', version: '1.0.0', model: null, promptContractVersions: null },
    accepting: 'accepting',
    consistencyReport: { status: 'pass', blocking: false, hardIssues: 0, softIssues: 0, issues: [], reportId: 'e'.repeat(64), draftId: 'd'.repeat(64), fingerprint: 'f'.repeat(64), version: '1.0.0' },
    answers: options.answers ?? [{ questionId: 'q1', kind: 'text', value: { kind: 'text', value: 'hello' } }],
    summary: { total: 2, answered: 1, blocked: 1, unsupported: 0, validationErrors: 0, requiredUnanswered: 0, complete: true },
  });
}

export function submitSuccessDoc(planId = PLAN_ID): string {
  return JSON.stringify({
    command: 'run',
    mode: 'submit',
    runId: 9,
    outcome: 'success',
    plan: {
      planId,
      target: { key: FIXTURE_KEY, display: FIXTURE_TARGET },
      fingerprint: 'f'.repeat(64),
      provider: { id: 'fixture', version: '1.0.0' },
      consistency: { reportId: 'e'.repeat(64), status: 'pass', softIssues: 0 },
    },
    receipt: {
      state: 'success',
      submitAttempted: true,
      outcome: 'success',
      outcomeCode: 'SUBMISSION_CONFIRMED',
      operator: 'telegram:5550001',
      approvalAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  });
}

/**
 * The exact closed `data` shape the adapter persists for an
 * `ok_submit_success` terminal handoff (`submitDataFrom`).
 */
export function terminalSuccessData(planId = PLAN_ID): Record<string, unknown> {
  return {
    runId: 9,
    planId,
    targetDisplay: FIXTURE_TARGET,
    fingerprint: 'f'.repeat(64),
    receiptState: 'success',
    submitAttempted: true,
    outcome: 'success',
    outcomeCode: 'SUBMISSION_CONFIRMED',
    operator: 'telegram:5550001',
    consistencySoftIssues: 0,
  };
}

export function submitUnknownDoc(planId = PLAN_ID): string {
  return JSON.stringify({
    command: 'run',
    mode: 'submit',
    runId: 9,
    outcome: 'unknown_outcome',
    plan: {
      planId,
      target: { key: FIXTURE_KEY, display: FIXTURE_TARGET },
      fingerprint: 'f'.repeat(64),
      provider: { id: 'fixture', version: '1.0.0' },
      consistency: { reportId: 'e'.repeat(64), status: 'pass', softIssues: 0 },
    },
    receipt: {
      state: 'unknown_outcome',
      submitAttempted: true,
      outcome: 'unknown_outcome',
      outcomeCode: 'SUBMISSION_OUTCOME_UNKNOWN',
      operator: 'telegram:5550001',
      approvalAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  });
}

export function runErrorDoc(code: string, kind: 'block' | 'usage' | 'error', mode: 'preflight' | 'submit' = 'preflight'): string {
  return JSON.stringify({ command: 'run', mode, ok: false, error: { code, kind } });
}

export function metricsDoc(): string {
  return JSON.stringify({
    version: '1.0.0',
    generatedAt: '2026-01-01T00:00:00.000Z',
    range: { since: null, until: null },
    events: [],
  });
}

export function captureStdout() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

export function readStdout(stdout: { mock: { calls: Array<Array<unknown>> } }): string {
  return stdout.mock.calls.map((call) => String(call[0])).join('');
}

export function parseEnvelope(text: string): Record<string, unknown> {
  return JSON.parse(text.trim()) as Record<string, unknown>;
}

/** A valid dedicated Telegram deployment config (data-only; never applied). */
export function telegramDeployment(): Record<string, unknown> {
  return {
    agents: {
      entries: {
        'form-agent': {
          workspace: '~/.openclaw/workspace-form-agent',
          tools: {
            allow: ['form_agent', 'form_agent_submit', 'session_status', 'ask_user'],
            deny: [
              'group:runtime',
              'group:fs',
              'group:automation',
              'group:messaging',
              'group:ui',
              'group:nodes',
              'group:web',
              'write',
              'edit',
              'apply_patch',
              'browser',
              'cron',
              'gateway',
              'sessions_spawn',
              'subagents',
            ],
          },
        },
        main: { default: true, workspace: '~/.openclaw/workspace-main' },
      },
    },
    bindings: [
      { agentId: 'main', match: { channel: 'telegram', accountId: 'default' } },
      {
        agentId: 'form-agent',
        match: {
          channel: 'telegram',
          accountId: 'formagent',
          peer: { kind: 'direct', id: '5550001' },
        },
      },
    ],
    channels: {
      telegram: {
        defaultAccount: 'default',
        groups: { '*': { requireMention: true } },
        accounts: {
          default: { name: 'Primary bot', botToken: 'env:TELEGRAM_PRIMARY_BOT_TOKEN' },
          formagent: {
            botToken: { source: 'store', provider: 'default', id: 'FORM_AGENT_TELEGRAM_BOT_TOKEN' },
            dmPolicy: 'allowlist',
            allowFrom: ['5550001'],
            groupPolicy: 'disabled',
            groups: {},
            execApprovals: { approvers: ['5550001'] },
          },
        },
      },
    },
    commands: {
      ownerAllowFrom: ['telegram:9990001', 'telegram:5550001'],
    },
  };
}

export const TELEGRAM_EXPECTATION = {
  accountId: 'formagent',
  operatorSenderId: '5550001',
  generalAccountId: 'default',
  agentId: 'form-agent',
  additionalGlobalOwners: ['telegram:9990001'],
};
