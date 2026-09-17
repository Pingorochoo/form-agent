/**
 * Phase 8 exact argv matrix + operation grammar (P8-R29/P8-R6, AW).
 *
 * Every accepted Form Agent call is an argv ARRAY with a fixed executable and
 * `shell:false`. `reviewAnswers` is adapter-only (never a Form Agent flag).
 * The operator-only `reconcile-unknown` CLI spelling maps to the internal
 * `reconcile_unknown` operation.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildAnalyzeArgv,
  buildCheckArgv,
  buildDraftArgv,
  buildMetricsArgv,
  buildPreflightArgv,
  buildSubmitArgv,
  MODEL_OPERATIONS,
  recheckThreePartTarget,
} from '../src/openclaw/contracts.ts';
import { parseAdapterArgv, runAdapterCli } from '../src/openclaw/main.ts';
import { PendingClient } from '../integrations/openclaw-plugin/pending-client.ts';
import {
  captureStdout,
  exitResult,
  FakeRunner,
  makeAdapter,
  readStdout,
  testConfig,
} from './support/phase8.ts';
import { PRINCIPAL } from './support/phase8-preflight.ts';

const CONFIG_PATH = '/etc/form-agent/adapter.json';
const SEED = 'a'.repeat(32);

describe('exact argv builders', () => {
  it('analyze', () => {
    expect(buildAnalyzeArgv(testConfig('/tmp/p8-argv'), 'demo-fixture')).toEqual(['analyze', 'demo-fixture', '--json']);
  });

  it('draft / draft_review / check pass --draft-provider only when supplied', () => {
    expect(buildDraftArgv(testConfig('/tmp/p8-argv'), 'demo-fixture', SEED, undefined)).toEqual([
      'draft', 'demo-fixture', '--seed', SEED, '--json',
    ]);
    expect(buildDraftArgv(testConfig('/tmp/p8-argv'), 'demo-fixture', SEED, 'reference')).toEqual([
      'draft', 'demo-fixture', '--seed', SEED, '--json', '--draft-provider', 'reference',
    ]);
    expect(buildCheckArgv(testConfig('/tmp/p8-argv'), 'demo-fixture', SEED, 'reference')).toEqual([
      'check', 'demo-fixture', '--seed', SEED, '--json', '--draft-provider', 'reference',
    ]);
  });

  it('preflight uses --json --json-error', () => {
    expect(buildPreflightArgv(testConfig('/tmp/p8-argv'), 'demo-fixture', SEED, 'reference')).toEqual([
      'run', 'demo-fixture', '--seed', SEED, '--json', '--json-error', '--draft-provider', 'reference',
    ]);
  });

  it('submit uses targetArg/seed/planId from the server-side record', () => {
    const argv = buildSubmitArgv(
      testConfig('/tmp/p8-argv'),
      { targetArg: 'demo-fixture', seed: SEED, planId: 'b'.repeat(64) },
      '5550001',
    );
    expect(argv).toEqual([
      'run', 'demo-fixture', '--seed', SEED, '--submit', '--expect-plan', 'b'.repeat(64), '--by', 'telegram:5550001', '--json', '--json-error',
    ]);
    expect(argv.join(' ')).not.toContain('targetKey');
  });

  it('metrics is read-only and bounded', () => {
    expect(buildMetricsArgv(testConfig('/tmp/p8-argv'), undefined, undefined)).toEqual([
      'metrics', 'export', '--format', 'json',
    ]);
    expect(buildMetricsArgv(testConfig('/tmp/p8-argv'), '2026-01-01T00:00:00Z', undefined)).toEqual([
      'metrics', 'export', '--format', 'json', '--since', '2026-01-01T00:00:00Z',
    ]);
  });

  it('passes the fixed --config first for every operation when configured', () => {
    const config = testConfig('/tmp/p8-argv', { formAgentConfigPath: CONFIG_PATH });
    for (const argv of [
      buildAnalyzeArgv(config, 'demo-fixture'),
      buildDraftArgv(config, 'demo-fixture', SEED, undefined),
      buildCheckArgv(config, 'demo-fixture', SEED, undefined),
      buildPreflightArgv(config, 'demo-fixture', SEED, undefined),
      buildMetricsArgv(config, undefined, undefined),
    ]) {
      expect(argv.slice(0, 2)).toEqual(['--config', CONFIG_PATH]);
    }
  });
});

describe('adapter-only review flag', () => {
  it('the plugin sends --review-answers only for preflight with reviewAnswers', async () => {
    const runner = new FakeRunner();
    const envelope = JSON.stringify({
      version: '1.0.0',
      operation: 'preflight',
      status: 'needs_confirmation',
      category: 'needs_confirmation',
      formAgentExitCode: 0,
      message: 'm',
      data: {},
      pending: null,
    });
    const client = new PendingClient(
      { adapterBinaryPath: '/opt/form-agent/bin/form-agent-openclaw.js', adapterConfigPath: CONFIG_PATH },
      runner,
    );

    runner.enqueue(exitResult(0, envelope));
    await client.formAgent(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture', reviewAnswers: true });
    expect(runner.calls[0]?.args).toContain('--review-answers');

    runner.enqueue(exitResult(0, envelope));
    await client.formAgent(PRINCIPAL, { operation: 'preflight', target: 'demo-fixture' });
    expect(runner.calls[1]?.args).not.toContain('--review-answers');
  });

  it('unknown model operations are never forwarded', async () => {
    const runner = new FakeRunner();
    const client = new PendingClient(
      { adapterBinaryPath: '/opt/form-agent/bin/form-agent-openclaw.js', adapterConfigPath: CONFIG_PATH },
      runner,
    );
    // @ts-expect-error internal operation is not a model operation
    await client.formAgent(PRINCIPAL, { operation: 'submit_pending' });
    // The client only emits known model-operation shapes; submit_pending has no
    // target and emits no argument-bearing surface.
    expect(runner.calls[0]?.args).not.toContain('--submit');
    expect(runner.calls[0]?.args).not.toContain('--expect-plan');
  });
});

describe('reconcile-unknown operator CLI alias', () => {
  it('maps the dashed spelling to the internal operation and not to the model enum', () => {
    const dashed = parseAdapterArgv([
      'reconcile-unknown',
      '--channel', 'telegram',
      '--account', 'formagent',
      '--sender', '5550001',
      '--pending-ref', 'a'.repeat(32),
      '--resolution', 'observed-submitted',
    ]);
    expect(dashed.ok).toBe(true);
    if (dashed.ok) expect(dashed.value.operation).toBe('reconcile_unknown');

    const underscored = parseAdapterArgv([
      'reconcile_unknown',
      '--channel', 'telegram',
      '--account', 'formagent',
      '--sender', '5550001',
      '--pending-ref', 'a'.repeat(32),
      '--resolution', 'observed-submitted',
    ]);
    expect(underscored.ok).toBe(true);
    if (underscored.ok) expect(underscored.value.operation).toBe('reconcile_unknown');

    expect((MODEL_OPERATIONS as readonly string[]).includes('reconcile-unknown')).toBe(false);
    expect((MODEL_OPERATIONS as readonly string[]).includes('reconcile_unknown')).toBe(false);
  });

  it('the dashed CLI spelling reconciles locally through the adapter entrypoint', async () => {
    const fixture = makeAdapter();
    const created = fixture.store.create({
      principal: PRINCIPAL,
      targetKey: 'fixture:demo-fixture',
      targetArg: 'demo-fixture',
      targetDisplay: 'demo-fixture',
      planId: 'a'.repeat(64),
      seed: 'b'.repeat(32),
      operator: 'telegram:5550001',
    });
    const claimed = fixture.store.claim(
      PRINCIPAL,
      {
        pendingRef: created.pendingId,
        planId: created.planId,
        targetKey: created.targetKey,
        targetDisplay: created.targetDisplay,
        expiresAtMs: created.expiresAtMs,
      },
      recheckThreePartTarget,
    );
    fixture.store.markConsumedUnknown(PRINCIPAL, claimed.pendingId, claimed.attemptId as string, 'ambiguous');

    const stdout = captureStdout();
    const code = await runAdapterCli(
      [
        'reconcile-unknown',
        '--channel', 'telegram',
        '--account', 'formagent',
        '--sender', '5550001',
        '--pending-ref', created.pendingId,
        '--resolution', 'observed-not-submitted',
      ],
      { config: testConfig(fixture.dir), runner: new FakeRunner() },
    );
    const output = readStdout(stdout);
    stdout.mockRestore();
    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ operation: 'reconcile_unknown', category: 'ok_reconciled' });
    expect(fixture.store.peekRaw(PRINCIPAL)).toBeNull();
    fixture.cleanup();
  });

  it('a bare dashed command with an unknown flag is a usage error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p8-alias-'));
    const stdout = captureStdout();
    await runAdapterCli(['reconcile-unknown', '--bogus'], { config: testConfig(dir), runner: new FakeRunner() });
    const output = readStdout(stdout);
    stdout.mockRestore();
    expect(JSON.parse(output)).toMatchObject({ operation: 'reconcile_unknown', category: 'usage_error' });
  });
});
