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
import { DeterministicReferenceProvider } from '../draft/reference.ts';
import { generateDraft } from '../draft/orchestrate.ts';
import { DraftError } from '../draft/errors.ts';
import { runConsistencyGate } from '../consistency/gate.ts';
import { ConsistencyError } from '../consistency/errors.ts';
import { checkToJson, formatCheckHuman } from '../consistency/format.ts';
import { ExitCodes } from './exit-codes.ts';
import type { CliContext } from './index.ts';

interface CheckArgs {
  input: string | undefined;
  seed: string | undefined;
  json: boolean;
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
  let sawInput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--seed') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, error: '--seed requires a value' };
      }
      seed = next;
      i += 1;
    } else if (arg.startsWith('--seed=')) {
      const value = arg.slice('--seed='.length);
      if (value === '') {
        return { ok: false, error: '--seed requires a non-empty value' };
      }
      seed = value;
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

  return { ok: true, value: { input, seed, json } };
}

export async function handleCmdCheck(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseCheckArgs(args);
  if (!parsed.ok) {
    ctx.logger.error(parsed.error);
    return ExitCodes.USAGE;
  }
  const { input, seed, json } = parsed.value;

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

  let bundle;
  try {
    bundle = await generateDraft({
      schema,
      seed,
      provider: new DeterministicReferenceProvider(),
      sensitiveRules,
    });
  } catch (err) {
    if (err instanceof DraftError) {
      ctx.logger.error(err.message);
      return ExitCodes.VALIDATION;
    }
    throw err;
  }

  let report;
  try {
    report = await runConsistencyGate({ schema, bundle });
  } catch (err) {
    if (err instanceof ConsistencyError) {
      ctx.logger.error(err.message);
      return ExitCodes.VALIDATION;
    }
    throw err;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(checkToJson(bundle, report), null, 2)}\n`);
  } else {
    process.stdout.write(`${formatCheckHuman(bundle.formTitle, bundle.formId, report)}\n`);
  }

  return report.blocking ? ExitCodes.VALIDATION : ExitCodes.SUCCESS;
}
