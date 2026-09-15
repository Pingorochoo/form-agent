/**
 * `form-agent run` command handler (P5-R20).
 *
 * Preflight by default; actual submission requires `--submit --expect-plan
 * <planId> --by <operator>`. Strict argument parsing: exactly one target,
 * non-empty seed, unknown flags rejected without echoing raw content,
 * `--submit` requires `--expect-plan` and `--by`, malformed plan ids rejected,
 * extra positionals rejected.
 *
 * Authorization-only preflight happens before any browser/network activity.
 */

import { canonicalizeTarget, TargetError } from '../policy/target.ts';
import { loadSensitiveRules, resolveSensitiveRules, PolicyConfigError } from '../policy/policy-config.ts';
import { FormAgentDatabase } from '../db/database.ts';
import { ExitCodes } from './exit-codes.ts';
import type { CliContext } from './index.ts';
import { resolveExecutionProvider } from '../providers/execution.ts';
import { fixtureScenario } from '../providers/fixture/provider.ts';
import { ExecutionHarness } from '../providers/fixture/harness.ts';
import { ExecutionOrchestrator } from '../execution/orchestrate.ts';
import {
  ExecutionError,
  ExecutionUsageError,
  executionExitCode,
} from '../execution/errors.ts';
import { DraftError } from '../draft/errors.ts';
import { resolveDraftProvider, isDraftProviderKind, type DraftProviderKind, type ResolvedDraftProvider } from '../draft/resolve.ts';
import { LlmProviderError, llmExitCode } from '../llm/errors.ts';
import { LlmCallStore } from '../llm/audit.ts';
import { ConsistencyError } from '../consistency/errors.ts';
import { formatPreflightHuman, formatSubmitHuman, preflightToJson, submitToJson } from '../execution/format.ts';
import { METRIC_EVENTS } from '../metrics/catalog.ts';
import { startTimer, systemMetricsClock } from '../metrics/clock.ts';
import { createMetricsRecorder } from '../metrics/store.ts';
import { recordConsistencySummary, recordDraftSummary } from '../metrics/instrument.ts';

const PLAN_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_OPERATOR_LENGTH = 200;

interface RunArgs {
  target: string | undefined;
  seed: string | undefined;
  json: boolean;
  submit: boolean;
  expectPlan: string | undefined;
  by: string | undefined;
  draftProvider: DraftProviderKind | undefined;
}

type ParsedRunArgs = { ok: true; value: RunArgs } | { ok: false; error: string };

function parseRunArgs(args: string[]): ParsedRunArgs {
  let target: string | undefined;
  let seed: string | undefined;
  let json = false;
  let submit = false;
  let expectPlan: string | undefined;
  let by: string | undefined;
  let draftProvider: DraftProviderKind | undefined;
  let sawTarget = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--submit') {
      submit = true;
    } else if (arg === '--seed' || arg === '--expect-plan' || arg === '--by' || arg === '--draft-provider') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, error: `${arg} requires a value` };
      }
      if (arg === '--seed') seed = next;
      else if (arg === '--expect-plan') expectPlan = next;
      else if (arg === '--by') by = next;
      else {
        if (!isDraftProviderKind(next)) return { ok: false, error: 'unknown draft provider' };
        draftProvider = next;
      }
      i += 1;
    } else if (
      arg.startsWith('--seed=') ||
      arg.startsWith('--expect-plan=') ||
      arg.startsWith('--by=') ||
      arg.startsWith('--draft-provider=')
    ) {
      const eq = arg.indexOf('=');
      const name = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (value === '') return { ok: false, error: `${name} requires a non-empty value` };
      if (name === '--seed') seed = value;
      else if (name === '--expect-plan') expectPlan = value;
      else if (name === '--by') by = value;
      else {
        if (!isDraftProviderKind(value)) return { ok: false, error: 'unknown draft provider' };
        draftProvider = value;
      }
    } else if (arg.startsWith('--')) {
      // Unknown flag; never echo raw contents.
      return { ok: false, error: 'unknown flag' };
    } else {
      if (sawTarget) return { ok: false, error: 'run accepts exactly one target' };
      sawTarget = true;
      target = arg;
    }
  }

  return { ok: true, value: { target, seed, json, submit, expectPlan, by, draftProvider } };
}

function validateArgs(args: RunArgs): string | null {
  if (args.target === undefined || args.target.trim() === '') {
    return 'run requires a target (fixture id, fixture URL, or Google Forms URL)';
  }
  if (args.seed === undefined || args.seed.trim() === '') {
    return 'run requires --seed <seed>';
  }
  if (args.submit) {
    if (args.expectPlan === undefined) return '--submit requires --expect-plan <planId>';
    if (args.by === undefined) return '--submit requires --by <operator>';
  } else {
    if (args.expectPlan !== undefined) return '--expect-plan is only valid with --submit';
    if (args.by !== undefined) return '--by is only valid with --submit';
  }
  if (args.expectPlan !== undefined && !PLAN_ID_PATTERN.test(args.expectPlan)) {
    return '--expect-plan is not a valid plan id';
  }
  if (args.by !== undefined) {
    const operator = args.by.trim();
    if (operator === '' || operator.length > MAX_OPERATOR_LENGTH) {
      return '--by must be a non-empty operator name (max 200 characters)';
    }
  }
  return null;
}

export async function handleCmdRun(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseRunArgs(args);
  if (!parsed.ok) {
    ctx.logger.error(parsed.error);
    return ExitCodes.USAGE;
  }
  const value = parsed.value;
  const validationError = validateArgs(value);
  if (validationError !== null) {
    ctx.logger.error(validationError);
    return ExitCodes.USAGE;
  }

  let canonical;
  try {
    canonical = canonicalizeTarget(value.target as string);
  } catch (err) {
    ctx.logger.error(err instanceof TargetError ? err.message : String(err));
    return ExitCodes.USAGE;
  }

  let sensitiveRules;
  try {
    sensitiveRules = resolveSensitiveRules(loadSensitiveRules().rules);
  } catch (err) {
    if (err instanceof PolicyConfigError) {
      ctx.logger.error(err.message);
      return ExitCodes.USAGE;
    }
    throw err;
  }

  // Start the local execution harness only for fixture targets.
  let harness: ExecutionHarness | null = null;
  const database = FormAgentDatabase.open({
    directory: ctx.config.database.directory,
    filename: ctx.config.database.filename,
  });
  const clock = ctx.metricsClock ?? systemMetricsClock;
  const recorder = createMetricsRecorder({
    database,
    onWarning: () => ctx.logger.warn('metrics recording skipped'),
    ...(ctx.metricsClock !== undefined ? { clock: ctx.metricsClock } : {}),
  });
  try {
    let fixtureBaseUrl: string | undefined;
    if (canonical.kind === 'fixture' && fixtureScenario(canonical) !== null) {
      harness = new ExecutionHarness();
      fixtureBaseUrl = await harness.start();
    }

    let provider;
    try {
      provider = resolveExecutionProvider(canonical, fixtureBaseUrl);
    } catch (err) {
      if (err instanceof ExecutionUsageError) {
        ctx.logger.error(err.message);
        return ExitCodes.USAGE;
      }
      throw err;
    }

    // Resolve the selected DraftProvider only for preflight. `--submit` loads
    // the persisted approved snapshot and makes ZERO LLM calls (P6-R16), so it
    // never resolves or contacts a real provider.
    let resolvedDraft: ResolvedDraftProvider | null = null;
    if (!value.submit) {
      try {
        const llmCallStore = new LlmCallStore(database);
        resolvedDraft = resolveDraftProvider(value.draftProvider, {
          config: ctx.config,
          recordCall: (entry) => llmCallStore.record(entry),
        });
      } catch (err) {
        if (err instanceof LlmProviderError) {
          ctx.logger.error(err.message);
          return llmExitCode(err.code);
        }
        throw err;
      }
    }

    const orchestrator = new ExecutionOrchestrator({
      config: ctx.config,
      database,
      sensitiveRules,
      provider,
      target: canonical,
      rawTarget: value.target as string,
      seed: value.seed as string,
      ...(resolvedDraft !== null
        ? { draftProvider: resolvedDraft.provider, draftProviderProvenance: resolvedDraft.provenance }
        : {}),
    });

    // P5-R3: authorization-only gate BEFORE any browser/network activity.
    const auth = orchestrator.checkAuthorization();
    if (!auth.allowed) {
      ctx.logger.error(`run not authorized for target (${auth.reasons.join(', ') || 'not-allowlisted'})`);
      return ExitCodes.VALIDATION;
    }

    if (value.submit) {
      // `run --submit` contributes ONLY command.run.submit.duration from
      // metrics_events; execution outcomes remain derived from receipts and the
      // preflight draft/consistency set is never duplicated here.
      const timer = startTimer(clock);
      try {
        const result = await orchestrator.submit(value.expectPlan as string, (value.by as string).trim());
        if (value.json) {
          process.stdout.write(`${JSON.stringify(submitToJson(result), null, 2)}\n`);
        } else {
          process.stdout.write(`${formatSubmitHuman({ plan: result.plan, receipt: result.receipt, outcome: result.outcome })}\n`);
        }
        return result.outcome === 'success' ? ExitCodes.SUCCESS : ExitCodes.ERROR;
      } finally {
        recorder.recordDuration(METRIC_EVENTS.COMMAND_RUN_SUBMIT_DURATION, timer.elapsedMs());
      }
    }

    const timer = startTimer(clock);
    try {
      const result = await orchestrator.preflight();
      // Recorded only on success, when the DraftBundle/consistency report
      // exists. No new business stage is executed to emit a metric.
      recordDraftSummary(recorder, result.bundle.summary);
      recordConsistencySummary(recorder, result.report);
      if (value.json) {
        process.stdout.write(
          `${JSON.stringify(
            preflightToJson({
              plan: result.plan,
              bundle: result.bundle,
              report: result.report,
              accepting: result.accepting,
              receipt: result.receipt,
              formTitle: result.formTitle,
              provenance: result.provenance,
            }),
            null,
            2,
          )}\n`,
        );
      } else {
        process.stdout.write(
          `${formatPreflightHuman({
            plan: result.plan,
            bundle: result.bundle,
            report: result.report,
            accepting: result.accepting,
            receipt: result.receipt,
            formTitle: result.formTitle,
            provenance: result.provenance,
          })}\n`,
        );
      }
      return ExitCodes.SUCCESS;
    } finally {
      recorder.recordDuration(METRIC_EVENTS.COMMAND_RUN_PREFLIGHT_DURATION, timer.elapsedMs());
    }
  } catch (err) {
    if (err instanceof LlmProviderError) {
      ctx.logger.error(err.message);
      return llmExitCode(err.code);
    }
    if (err instanceof ExecutionError) {
      if (err.retryAfterMs !== null) {
        ctx.logger.error(`${err.message} (retry-after ${err.retryAfterMs}ms)`);
      } else {
        ctx.logger.error(err.message);
      }
      return executionExitCode(err.code);
    }
    if (err instanceof DraftError || err instanceof ConsistencyError) {
      ctx.logger.error(err.message);
      return ExitCodes.VALIDATION;
    }
    throw err;
  } finally {
    database.close();
    if (harness !== null) await harness.stop();
  }
}
