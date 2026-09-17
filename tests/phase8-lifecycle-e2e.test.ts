/**
 * Phase 8 local lifecycle E2E (P8-R20, §16).
 *
 * Real, local fixture-harness lifecycle through the ACCEPTED Form Agent CLI
 * (analyze -> preflight -> submit -> metrics) feeding the adapter's real machine
 * documents, then the crash-safe completed_unambiguous -> submit_status ->
 * submit_ack handoff. No Telegram, no OpenClaw Gateway, no network, no real
 * credentials.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { handleCmdAnalyze } from '../src/cli/index.ts';
import { handleCmdRun } from '../src/cli/run.ts';
import { handleCmdMetrics } from '../src/cli/metrics.ts';
import { ExitCodes } from '../src/cli/exit-codes.ts';
import { AuthorizationStore } from '../src/policy/authz.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';
import { parseGoogleFormsHtml } from '../src/parser/google-forms.ts';
import { captureStdout, exitResult, makeAdapter, submitParams } from './support/phase8.ts';
import { PRINCIPAL, getPreflightPending } from './support/phase8-preflight.ts';
import { makeMetricsCtx, openDb, readStdout } from './support/phase7.ts';

const FIXTURE_PATH = new URL('../fixtures/archives/observed-responder.html', import.meta.url);
const FIXTURE_URL = 'https://fixtures.local/forms/observed-responder';
const FINGERPRINT = '7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e';

function allow(dir: string, fixtureId: string): void {
  const db = openDb(dir);
  try {
    new AuthorizationStore(db).allow(canonicalizeTarget(fixtureId), 'run', 'op');
  } finally {
    db.close();
  }
}

describe('P8-R20 — local lifecycle E2E', () => {
  it('runs analyze -> preflight -> submit -> metrics and the adapter handoff', async () => {
    const { ctx, dir } = makeMetricsCtx();
    allow(dir, 'exec-success');

    // 1. Offline analyze keeps the accepted fingerprint.
    let stdout = captureStdout();
    expect(await handleCmdAnalyze(FIXTURE_PATH.pathname, ctx, true)).toBe(ExitCodes.SUCCESS);
    const analyzeDoc = readStdout(stdout);
    stdout.mockRestore();
    expect(JSON.parse(analyzeDoc)['fingerprint']).toBe(FINGERPRINT);

    // 2. Real fixture preflight.
    stdout = captureStdout();
    expect(
      await handleCmdRun(['exec-success', '--seed', 'p8-e2e', '--json', '--json-error'], ctx),
    ).toBe(ExitCodes.SUCCESS);
    const preflightText = readStdout(stdout);
    stdout.mockRestore();
    const preflight = JSON.parse(preflightText) as { plan: { planId: string; target: { key: string; display: string } } };
    expect(preflight.plan.planId).toMatch(/^[a-f0-9]{64}$/);

    // 3. Real fixture submit (one durable claim).
    stdout = captureStdout();
    expect(
      await handleCmdRun(
        ['exec-success', '--seed', 'p8-e2e', '--submit', '--expect-plan', preflight.plan.planId, '--by', 'telegram:5550001', '--json', '--json-error'],
        ctx,
      ),
    ).toBe(ExitCodes.SUCCESS);
    const submitText = readStdout(stdout);
    stdout.mockRestore();
    expect(JSON.parse(submitText)).toMatchObject({ command: 'run', mode: 'submit', outcome: 'success' });

    // 4. Adapter lifecycle over the REAL accepted documents.
    const adapter = makeAdapter();
    adapter.runner.enqueue(exitResult(0, preflightText));
    const preflightEnvelope = await adapter.adapter.execute(PRINCIPAL, {
      operation: 'preflight',
      target: 'exec-success',
    });
    expect(preflightEnvelope.category).toBe('needs_confirmation');
    expect(preflightEnvelope.pending?.planId).toBe(preflight.plan.planId);

    const pending = getPreflightPending(adapter.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    adapter.runner.enqueue(exitResult(0, submitText));
    const submitEnvelope = await adapter.adapter.execute(PRINCIPAL, submitParams(pending));
    expect(submitEnvelope.category).toBe('ok_submit_success');

    const status = await adapter.adapter.execute(PRINCIPAL, {
      operation: 'submit_status',
      pendingRef: pending.pendingId,
      planId: pending.planId,
    });
    expect(status.data['state']).toBe('completed_unambiguous');
    const ack = await adapter.adapter.execute(PRINCIPAL, {
      operation: 'submit_ack',
      pendingRef: pending.pendingId,
      attempt: status.data['attemptId'] as string,
    });
    expect(ack.data).toMatchObject({ acked: true });
    expect(adapter.store.peekRaw(PRINCIPAL)).toBeNull();
    adapter.cleanup();

    // 5. Metrics reflect the single durable claim and make no network call.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    stdout = captureStdout();
    expect(await handleCmdMetrics(['export', '--format', 'json'], ctx)).toBe(ExitCodes.SUCCESS);
    const metricsJson = readStdout(stdout);
    stdout.mockRestore();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    const doc = JSON.parse(metricsJson) as { executionOutcomes: { submitClaimCount: number } };
    expect(doc.executionOutcomes.submitClaimCount).toBe(1);
    expect(metricsJson).not.toContain('hello');

    // Preserved accepted fixture fingerprint.
    const schema = parseGoogleFormsHtml(readFileSync(FIXTURE_PATH, 'utf8'), {
      url: FIXTURE_URL,
      capturedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(schema.checksum).toBe(FINGERPRINT);
  }, 120_000);
});
