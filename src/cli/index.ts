/**
 * Command handlers — Phase 0 scaffolding.
 *
 * Only `provider` is functional (config + fake provider connectivity). The
 * analysis/policy/execution commands have no implementation yet and return a
 * stable `not-implemented` signal rather than pretending to work.
 */

import type { AppConfig } from '../config/schema.ts';
import { resolveProviderConfig } from '../config/load.ts';
import type { ChatCompletionClient } from '../llm/interface.ts';
import { FakeProvider } from '../llm/fake.ts';
import type { Logger } from '../logging/logger.ts';
import { FormAgentDatabase } from '../db/database.ts';
import { AnalysisStore } from '../analyze/store.ts';
import { analyzeForm, formatAnalysisSummary } from '../analyze/analyze.ts';
import { AnalyzeInputError, resolveAnalyzeInput, type ResolvedAnalyzeInput } from '../analyze/resolve-input.ts';
import { GoogleFormsParseError } from '../parser/google-forms.ts';
import { ExitCodes } from './exit-codes.ts';
import { buildPolicyEngine, formatRunPolicySummary } from '../policy/policyEngine.ts';
import { loadSensitiveRules, resolveSensitiveRules, PolicyConfigError } from '../policy/policy-config.ts';
import { METRIC_EVENTS } from '../metrics/catalog.ts';
import { startTimer, systemMetricsClock, type MetricsClock } from '../metrics/clock.ts';
import { createMetricsRecorder } from '../metrics/store.ts';

export class NotImplementedError extends Error {
  constructor(command: string) {
    super(`${command} is not implemented yet (Phase 0 scaffolding)`);
    this.name = 'NotImplementedError';
  }
}

export interface CliContext {
  config: AppConfig;
  logger: Logger;
  /**
   * Optional injected clock for deterministic Phase 7 metrics timing in tests.
   * Production calls leave this undefined and use the system monotonic clock.
   */
  metricsClock?: MetricsClock;
}

function notImplemented(command: string): never {
  throw new NotImplementedError(command);
}

function makeCliSink(): (line: string) => void {
  return (line) => process.stdout.write(`${line}\n`);
}

/**
 * Resolve the configured LLM client for a provider id.
 *
 * `--validate`-style flows call this to prove the pipeline (config + resolve +
 * connectivity) works. Phase 3 will build real openai-compatible clients; for
 * now any non-fake provider that resolves config-wise also passes through the
 * fake client so `provider <id> --validate` succeeds deterministically.
 */
export function createClientForProvider(
  config: AppConfig,
  providerId: string,
): ChatCompletionClient {
  const { config: providerConfig } = resolveProviderConfig(config, providerId);
  if (providerConfig.type === 'fake') {
    return new FakeProvider();
  }
  // Note: openai-compatible wiring arrives in Phase 3. For Phase 0 validation
  // we hand back a fake client so the CLI contract is exercised end-to-end.
  return new FakeProvider(`fake-${providerId}`);
}

export async function handleCmdAnalyze(
  urlOrFixture: string,
  ctx: CliContext,
): Promise<number> {
  let input: ResolvedAnalyzeInput;
  try {
    input = await resolveAnalyzeInput(urlOrFixture);
  } catch (err) {
    if (err instanceof AnalyzeInputError) {
      ctx.logger.error(err.message);
      return ExitCodes.USAGE;
    }
    throw err;
  }

  // The business operation starts here (after all usage/input resolution): the
  // duration event is recorded on success OR controlled failure from now on.
  const timer = startTimer(ctx.metricsClock ?? systemMetricsClock);
  const database = FormAgentDatabase.open({
    directory: ctx.config.database.directory,
    filename: ctx.config.database.filename,
  });
  const recorder = createMetricsRecorder({
    database,
    onWarning: () => ctx.logger.warn('metrics recording skipped'),
    ...(ctx.metricsClock !== undefined ? { clock: ctx.metricsClock } : {}),
  });
  try {
    const store = new AnalysisStore(database);
    const outcome = analyzeForm({ html: input.html, url: input.url }, store);
    process.stdout.write(`${formatAnalysisSummary(outcome.schema, outcome.fingerprintId)}\n`);

    // Phase 2 policy visibility (P2-R18): report authorization state,
    // sensitive-field counts, and execution eligibility. Analysis is
    // inspection only and never implies execution authorization.
    const { rules } = loadSensitiveRules();
    const engine = buildPolicyEngine(ctx.config, database, resolveSensitiveRules(rules));
    const decision = engine.evaluateRunPolicy({ target: input.url, scope: 'run', schema: outcome.schema });
    process.stdout.write(`${formatRunPolicySummary(decision)}\n`);
    return ExitCodes.SUCCESS;
  } catch (err) {
    if (err instanceof GoogleFormsParseError) {
      ctx.logger.error(`Failed to parse form: ${err.message}`);
      return ExitCodes.VALIDATION;
    }
    if (err instanceof PolicyConfigError) {
      ctx.logger.error(err.message);
      return ExitCodes.USAGE;
    }
    throw err;
  } finally {
    recorder.recordDuration(METRIC_EVENTS.COMMAND_ANALYZE_DURATION, timer.elapsedMs());
    database.close();
  }
}

export async function handleCmdFile(
  _path: string,
  ctx: CliContext,
): Promise<number> {
  void ctx;
  notImplemented('file');
}

export async function handleCmdPreview(
  ctx: CliContext,
): Promise<number> {
  void ctx;
  notImplemented('preview');
}

export async function handleCmdPlan(
  _url: string,
  ctx: CliContext,
): Promise<number> {
  void ctx;
  notImplemented('plan');
}

export async function handleCmdProviderValidate(
  providerId: string,
  ctx: CliContext,
): Promise<number> {
  const logger = ctx.logger.child('provider');
  const client = createClientForProvider(ctx.config, providerId);
  logger.info(`Validating LLM provider "${providerId}"...`);
  const connectivity = await client.checkConnectivity();
  if (!connectivity.ok) {
    logger.error(`Provider "${providerId}" connectivity check failed: ${connectivity.error ?? 'unknown error'}`);
    await client.close();
    return ExitCodes.LLM_CONNECTIVITY;
  }
  logger.info(
    `Provider "${providerId}" is reachable (model: ${connectivity.model ?? 'unknown'}, ${connectivity.latencyMs ?? 0}ms)`,
  );
  const models = await client.listModels();
  logger.debug(`Models available: ${models.join(', ')}`);
  await client.close();
  return ExitCodes.SUCCESS;
}

export async function handleCmdProviderWhere(ctx: CliContext): Promise<number> {
  const logger = ctx.logger.child('provider');
  const config = ctx.config;
  const providers = config.llm.providers;
  const defaultProvider = config.llm.defaultProvider;

  for (const [id, providerConfig] of Object.entries(providers)) {
    const flags: string[] = [];
    if (id === defaultProvider) flags.push('default');
    if (!providerConfig.enabled) flags.push('disabled');
    if (providerConfig.type === 'fake') flags.push('offline-safe');
    logger.info(`${id} (type=${providerConfig.type})${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}${providerConfig.baseUrl !== undefined ? ` -> ${providerConfig.baseUrl}` : ''}`);
  }

  if (providers[defaultProvider] === undefined) {
    logger.warn(`defaultProvider "${defaultProvider}" is not configured; add it under llm.providers`);
  }
  return ExitCodes.SUCCESS;
}

export function handleCmdHelp(): number {
  makeCliSink()(
    [
      'form-agent — deterministic-first, AI-assisted Google Forms testing CLI',
      '',
      'Usage:',
      '  form-agent analyze <url>            Analyze a form (Phase 1)',
      '  form-agent auth allow <target> --scope run --by <operator>',
      '                                      Allowlist a target for a future run',
      '  form-agent auth check <target>      Check authorization state',
      '  form-agent auth list               List authorization records',
      '  form-agent auth revoke <target>     Revoke an authorization',
      '  form-agent draft <input> --seed <seed> [--json] [--draft-provider reference|openai-compatible]',
      '                                      Generate a synthetic draft (Phase 3)',
      '  form-agent check <input> --seed <seed> [--json] [--draft-provider reference|openai-compatible]',
      '                                      Check draft consistency (Phase 4)',
      '  form-agent file <path>              File an update (scaffold)',
      '  form-agent preview                  Preview answers before run (not implemented)',
      '  form-agent plan <url>               Plan a batch (not implemented)',
      '  form-agent run <target> --seed <seed> [--json] [--draft-provider reference|openai-compatible]',
      '                                      Preflight a run (plan only, no fill/submit)',
      '  form-agent run <target> --seed <seed> --submit --expect-plan <planId> --by <operator>',
      '                                      Submit an approved plan (explicit approval)',
      '  form-agent provider <id> --validate  Check an LLM provider',
      '  form-agent provider where           List configured providers',
      '  form-agent metrics summary [--since <ISO8601>] [--until <ISO8601>]',
      '                                      Show bounded operational metrics',
      '  form-agent metrics export --format json|csv [--since <ISO8601>] [--until <ISO8601>]',
      '                                      Export deterministic machine-readable metrics',
      '  form-agent --version                Print version',
      '  form-agent --help                   This help',
      '',
      'Exit codes: 0 success, 1 error, 2 usage, 3 validation, 4 LLM offline, 5 LLM connectivity, 127 unknown command',
    ].join('\n'),
  );
  return ExitCodes.SUCCESS;
}