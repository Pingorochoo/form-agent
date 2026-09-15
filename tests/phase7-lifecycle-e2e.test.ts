/**
 * Phase 7 local lifecycle E2E (P7-R18, P7-R20).
 *
 * A realistic CURRENT lifecycle over a temp DB: analyze -> real-provider draft
 * -> real-provider check -> real-provider preflight -> confirmed fixture submit,
 * then `metrics summary`/`metrics export`. Proves LLM-call aggregates (including
 * draft/check audit rows), execution-outcome aggregates, Phase 7 event metrics,
 * coverage disclosure, the preserved fixture fingerprint, and that the export
 * itself made no browser/LLM/network request. Local fixture harness + loopback
 * LLM stub only.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { handleCmdAnalyze } from '../src/cli/index.ts';
import { handleCmdDraft } from '../src/cli/draft.ts';
import { handleCmdCheck } from '../src/cli/check.ts';
import { handleCmdRun } from '../src/cli/run.ts';
import { handleCmdMetrics } from '../src/cli/metrics.ts';
import { ExitCodes } from '../src/cli/exit-codes.ts';
import { parseGoogleFormsHtml } from '../src/parser/google-forms.ts';
import { AuthorizationStore } from '../src/policy/authz.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';
import { SECRET_SENTINEL, LlmStub } from './support/phase6-llm-stub.ts';
import { captureStdout, makeMetricsCtx, openDb, readStdout } from './support/phase7.ts';

const FIXTURE_PATH = new URL('../fixtures/archives/observed-responder.html', import.meta.url);
const FIXTURE_URL = 'https://fixtures.local/forms/observed-responder';
const STUB_ANSWER = 'synthetic stub answer';

function allow(dir: string, fixtureId: string): void {
  const db = openDb(dir);
  try {
    new AuthorizationStore(db).allow(canonicalizeTarget(fixtureId), 'run', 'op');
  } finally {
    db.close();
  }
}

describe('P7-R20 — local lifecycle E2E', () => {
  it('produces event, LLM and execution aggregates across the accepted lifecycle', async () => {
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
      allow(dir, 'exec-success');

      // 1. analyze
      let stdout = captureStdout();
      expect(await handleCmdAnalyze(FIXTURE_PATH.pathname, ctx)).toBe(ExitCodes.SUCCESS);
      stdout.mockRestore();

      // 2. real-provider draft
      stdout = captureStdout();
      expect(
        await handleCmdDraft(
          [FIXTURE_URL, '--seed', 'seed-e2e-p7', '--draft-provider', 'openai-compatible'],
          ctx,
        ),
      ).toBe(ExitCodes.SUCCESS);
      stdout.mockRestore();

      // 3. real-provider check
      stdout = captureStdout();
      expect(
        await handleCmdCheck(
          [FIXTURE_URL, '--seed', 'seed-e2e-p7', '--draft-provider', 'openai-compatible'],
          ctx,
        ),
      ).toBe(ExitCodes.SUCCESS);
      stdout.mockRestore();

      // 4. real-provider preflight
      stdout = captureStdout();
      expect(
        await handleCmdRun(
          ['exec-success', '--seed', 'seed-e2e-p7', '--draft-provider', 'openai-compatible', '--json'],
          ctx,
        ),
      ).toBe(ExitCodes.SUCCESS);
      const preflight = JSON.parse(readStdout(stdout)) as { plan: { planId: string } };
      stdout.mockRestore();

      // 5. confirmed fixture submit (no LLM regeneration)
      stdout = captureStdout();
      expect(
        await handleCmdRun(
          ['exec-success', '--seed', 'seed-e2e-p7', '--submit', '--expect-plan', preflight.plan.planId, '--by', 'op'],
          ctx,
        ),
      ).toBe(ExitCodes.SUCCESS);
      stdout.mockRestore();

      // 6. metrics summary + export make no network/LLM/browser request.
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      stdout = captureStdout();
      expect(await handleCmdMetrics(['summary'], ctx)).toBe(ExitCodes.SUCCESS);
      const summary = readStdout(stdout);
      stdout.mockRestore();

      stdout = captureStdout();
      expect(await handleCmdMetrics(['export', '--format', 'json'], ctx)).toBe(ExitCodes.SUCCESS);
      const json = readStdout(stdout);
      stdout.mockRestore();
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();

      // Coverage + draft event metrics + execution + LLM aggregates.
      expect(summary).toContain('Coverage: metricsEvents=phase7+');
      expect(summary).toContain('run.preflight.duration');
      expect(summary).toContain('claims(all-time)=1');

      const doc = JSON.parse(json) as {
        coverage: Record<string, string>;
        metricsEvents: { byEvent: Array<{ event: string }> };
        llmUsage: {
          callCount: number;
          byProvider: Array<{ providerId: string; count: number }>;
          tokens: { input: { observedCount: number; sum: number | null } };
        };
        executionOutcomes: {
          submitClaimCount: number;
          byOutcome: Array<{ outcome: string; count: number }>;
        };
      };
      expect(doc.coverage).toEqual({
        metricsEvents: 'phase7+',
        llmUsage: 'partial-pre-phase7;best-effort-instrumented-from-phase7',
        executionOutcomes: 'phase5+',
      });
      const events = doc.metricsEvents.byEvent.map((row) => row.event);
      expect(events).toEqual(
        expect.arrayContaining([
          'command.analyze.duration',
          'command.draft.duration',
          'command.check.duration',
          'command.run.preflight.duration',
          'command.run.submit.duration',
          'draft.fields.total',
          'consistency.status',
        ]),
      );
      expect(doc.llmUsage.callCount).toBeGreaterThan(0);
      expect(doc.llmUsage.byProvider.some((row) => row.providerId === 'openai-compatible')).toBe(true);
      expect(doc.llmUsage.tokens.input.observedCount).toBeGreaterThan(0);
      expect(doc.llmUsage.tokens.input.sum).not.toBeNull();
      expect(doc.executionOutcomes.submitClaimCount).toBe(1);
      expect(doc.executionOutcomes.byOutcome.some((row) => row.outcome === 'success')).toBe(true);

      // No secrets/raw synthetic answers in machine output.
      expect(json).not.toContain(SECRET_SENTINEL);
      expect(json).not.toContain(STUB_ANSWER);

      // Preserved accepted fixture fingerprint.
      const html = readFileSync(FIXTURE_PATH, 'utf8');
      const schema = parseGoogleFormsHtml(html, {
        url: FIXTURE_URL,
        capturedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(schema.checksum).toBe(
        '7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e',
      );
    } finally {
      await stub.stop();
    }
  }, 90_000);
});
