/**
 * `form-agent draft` command handler (P3-R16, P3-R17).
 *
 * Local-only, deterministic, submission-free draft generation. Accepted inputs
 * follow the existing local analyze input model (sanitized local archive/file,
 * fixture id, or fixture URL through the local fixture harness). A live
 * external HTTP(S) Google Forms URL is rejected without being fetched.
 *
 * The command reuses Phase 2 sensitivity classification directly — it does not
 * require a target to be execution-authorized and it does not use the full
 * future-run `PolicyEngine` (P3-R8).
 */

import { AnalyzeInputError, resolveAnalyzeInput } from '../analyze/resolve-input.ts';
import { GoogleFormsParseError, parseGoogleFormsHtml } from '../parser/google-forms.ts';
import { PolicyConfigError, loadSensitiveRules, resolveSensitiveRules } from '../policy/policy-config.ts';
import { generateDraft } from '../draft/orchestrate.ts';
import { resolveDraftProvider, isDraftProviderKind, type DraftProviderKind } from '../draft/resolve.ts';
import { DraftError } from '../draft/errors.ts';
import { LlmProviderError, llmExitCode } from '../llm/errors.ts';
import { draftToJson, formatDraftHuman } from '../draft/format.ts';
import { ExitCodes } from './exit-codes.ts';
import type { CliContext } from './index.ts';

interface DraftArgs {
  input: string | undefined;
  seed: string | undefined;
  json: boolean;
  draftProvider: DraftProviderKind | undefined;
}

type ParsedDraftArgs = { ok: true; value: DraftArgs } | { ok: false; error: string };

/**
 * Parse `draft` command arguments deterministically. Unknown flags, a `--seed`
 * without a following non-flag value, an empty `--seed=`, and extra positional
 * inputs are all controlled usage errors.
 */
function parseDraftArgs(args: string[]): ParsedDraftArgs {
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
        return { ok: false, error: 'draft accepts exactly one input (form URL or fixture path)' };
      }
      sawInput = true;
      input = arg;
    }
  }

  return { ok: true, value: { input, seed, json, draftProvider } };
}

export async function handleCmdDraft(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseDraftArgs(args);
  if (!parsed.ok) {
    ctx.logger.error(parsed.error);
    return ExitCodes.USAGE;
  }
  const { input, seed, json, draftProvider } = parsed.value;

  if (seed === undefined || seed.trim() === '') {
    ctx.logger.error('draft requires --seed <seed>');
    return ExitCodes.USAGE;
  }
  if (input === undefined || input.trim() === '') {
    ctx.logger.error('draft requires a form URL or fixture path');
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
  try {
    selectedProvider = resolveDraftProvider(draftProvider, { config: ctx.config });
  } catch (err) {
    if (err instanceof LlmProviderError) {
      ctx.logger.error(err.message);
      return llmExitCode(err.code);
    }
    throw err;
  }

  let bundle;
  try {
    bundle = await generateDraft({
      schema,
      seed,
      provider: selectedProvider.provider,
      sensitiveRules,
    });
  } catch (err) {
    if (err instanceof LlmProviderError) {
      ctx.logger.error(err.message);
      return llmExitCode(err.code);
    }
    if (err instanceof DraftError) {
      ctx.logger.error(err.message);
      return ExitCodes.VALIDATION;
    }
    throw err;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(draftToJson(bundle), null, 2)}\n`);
  } else {
    process.stdout.write(`${formatDraftHuman(bundle)}\n`);
  }
  return ExitCodes.SUCCESS;
}
