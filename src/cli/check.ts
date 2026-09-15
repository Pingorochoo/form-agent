/**
 * `form-agent check` command handler (P4-R15, P4-R16).
 *
 * Local-only, deterministic, submission-free consistency inspection. It
 * resolves an accepted local/fixture input, generates the same accepted
 * Phase 3 draft for the seed/current sensitivity rules, runs the Phase 4
 * consistency gate, and prints the result. It performs no execution.
 *
 * A live external HTTP(S) Google Forms URL is rejected without being fetched.
 * `BLOCK` maps to the existing validation exit code (3); `PASS`/`WARN` map to
 * success (0). Consistency is NOT an authorization decision.
 */

import { AnalyzeInputError, resolveAnalyzeInput } from '../analyze/resolve-input.ts';
import { GoogleFormsParseError, parseGoogleFormsHtml } from '../parser/google-forms.ts';
import { PolicyConfigError, loadSensitiveRules, resolveSensitiveRules } from '../policy/policy-config.ts';
import { generateDraft } from '../draft/orchestrate.ts';
import { resolveDraftProvider, isDraftProviderKind, type DraftProviderKind } from '../draft/resolve.ts';
import { DraftError } from '../draft/errors.ts';
import { LlmProviderError, llmExitCode } from '../llm/errors.ts';
import { runConsistencyGate } from '../consistency/gate.ts';
import { ConsistencyError } from '../consistency/errors.ts';
import { checkToJson, formatCheckHuman } from '../consistency/format.ts';
import { ExitCodes } from './exit-codes.ts';
import type { CliContext } from './index.ts';
import { METRIC_EVENTS } from '../metrics/catalog.ts';
import { openAuditMetrics, recordConsistencySummary, recordDraftSummary } from '../metrics/instrument.ts';

interface CheckArgs {
  input: string | undefined;
  seed: string | undefined;
  json: boolean;
  draftProvider: DraftProviderKind | undefined;
}

type ParsedCheckArgs = { ok: true; value: CheckArgs } | { ok: false; error: string };

/**
 * Parse `check` command arguments deterministically (same strict philosophy as
 * `draft`). Unknown flags, a `--seed` without a following non-flag value, an
 * empty `--seed=`, and extra positional inputs are all controlled usage errors.
 * Unknown flags never echo their raw contents.
 */
function parseCheckArgs(args: string[]): ParsedCheckArgs {
  let input: string | undefined;
  let seed: string | undefined;
  let json = false;
  let draftProvider: DraftProviderKind | undefined;
  let sawInput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--seed' || arg === '--draft-provider') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, error: `${arg} requires a value` };
      }
      if (arg === '--seed') {
        seed = next;
      } else {
        if (!isDraftProviderKind(next)) return { ok: false, error: 'unknown draft provider' };
        draftProvider = next;
      }
      i += 1;
    } else if (arg.startsWith('--seed=') || arg.startsWith('--draft-provider=')) {
      const eq = arg.indexOf('=');
      const name = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (value === '') return { ok: false, error: `${name} requires a non-empty value` };
      if (name === '--seed') {
        seed = value;
      } else {
        if (!isDraftProviderKind(value)) return { ok: false, error: 'unknown draft provider' };
        draftProvider = value;
      }
    } else if (arg.startsWith('--')) {
      return { ok: false, error: 'unknown flag' };
    } else {
      if (sawInput) {
        return { ok: false, error: 'check accepts exactly one input (form URL or fixture path)' };
      }
      sawInput = true;
      input = arg;
    }
  }

  return { ok: true, value: { input, seed, json, draftProvider } };
}

export async function handleCmdCheck(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseCheckArgs(args);
  if (!parsed.ok) {
    ctx.logger.error(parsed.error);
    return ExitCodes.USAGE;
  }
  const { input, seed, json, draftProvider } = parsed.value;

  if (seed === undefined || seed.trim() === '') {
    ctx.logger.error('check requires --seed <seed>');
    return ExitCodes.USAGE;
  }
  if (input === undefined || input.trim() === '') {
    ctx.logger.error('check requires a form URL or fixture path');
    return ExitCodes.USAGE;
  }

  let resolved;
  try {
    resolved = await resolveAnalyzeInput(input);
  } catch (err) {
    if (err instanceof AnalyzeInputError) {
      ctx.logger.error(err.message);
      return ExitCodes.USAGE;
    }
    throw err;
  }

  let schema;
  try {
    schema = parseGoogleFormsHtml(resolved.html, { url: resolved.url });
  } catch (err) {
    if (err instanceof GoogleFormsParseError) {
      ctx.logger.error(`Failed to parse form: ${err.message}`);
      return ExitCodes.VALIDATION;
    }
    throw err;
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

  let selectedProvider;
  // P7-R11: best-effort audit-only DB open so real-provider `check` calls are
  // instrumented in `llm_calls`. The open is not optional; a failure must not
  // change stdout/JSON/exit/business result.
  const audit = openAuditMetrics({
    directory: ctx.config.database.directory,
    filename: ctx.config.database.filename,
    logger: ctx.logger,
    ...(ctx.metricsClock !== undefined ? { clock: ctx.metricsClock } : {}),
  });
  try {
    try {
      selectedProvider = resolveDraftProvider(draftProvider, {
        config: ctx.config,
        ...(audit.recordCall !== undefined ? { recordCall: audit.recordCall } : {}),
      });
    } catch (err) {
      if (err instanceof LlmProviderError) {
        ctx.logger.error(err.message);
        return llmExitCode(err.code);
      }
      throw err;
    }

    const timer = audit.startTimer();
    let bundle;
    let report;
    try {
      bundle = await generateDraft({
        schema,
        seed,
        provider: selectedProvider.provider,
        sensitiveRules,
      });
      recordDraftSummary(audit.recorder, bundle.summary);

      report = await runConsistencyGate({ schema, bundle });
      recordConsistencySummary(audit.recorder, report);
    } catch (err) {
      if (err instanceof LlmProviderError) {
        ctx.logger.error(err.message);
        return llmExitCode(err.code);
      }
      if (err instanceof DraftError) {
        ctx.logger.error(err.message);
        return ExitCodes.VALIDATION;
      }
      if (err instanceof ConsistencyError) {
        ctx.logger.error(err.message);
        return ExitCodes.VALIDATION;
      }
      throw err;
    } finally {
      // Started => recorded, on success or controlled failure (P7-R7).
      audit.recorder.recordDuration(METRIC_EVENTS.COMMAND_CHECK_DURATION, timer.elapsedMs());
    }

    if (json) {
      process.stdout.write(`${JSON.stringify(checkToJson(bundle, report), null, 2)}\n`);
    } else {
      process.stdout.write(`${formatCheckHuman(bundle.formTitle, bundle.formId, report)}\n`);
    }

    return report.blocking ? ExitCodes.VALIDATION : ExitCodes.SUCCESS;
  } finally {
    audit.close();
  }
}
