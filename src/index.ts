/**
 * form-agent CLI entry point.
 *
 * Phase 0: config loading + `provider` command functional; preview / plan / file
 * are scaffolded not-implemented commands with a stable exit-code contract.
 */

import { loadConfig, type LoadedConfig } from './config/load.ts';
import { createLogger } from './logging/logger.ts';
import { ExitCodes } from './cli/exit-codes.ts';
import {
  NotImplementedError,
  handleCmdAnalyze,
  handleCmdFile,
  handleCmdPlan,
  handleCmdPreview,
  handleCmdProviderValidate,
  handleCmdProviderWhere,
  handleCmdHelp,
  type CliContext,
} from './cli/index.ts';
import { handleCmdAuth } from './cli/auth.ts';
import { handleCmdDraft } from './cli/draft.ts';
import { handleCmdCheck } from './cli/check.ts';
import { handleCmdRun } from './cli/run.ts';
import { handleCmdMetrics } from './cli/metrics.ts';

export const VERSION = '0.1.0';

function makeContext(config: LoadedConfig): CliContext {
  const logger = createLogger(config.config);
  for (const warning of config.warnings) {
    logger.warn(`Config warning: ${warning}`);
  }
  if (config.source !== null) {
    logger.debug(`Using config file: ${config.source}`);
  }
  return { config: config.config, logger };
}

async function runArgv(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return handleCmdHelp();
  }
  if (argv[0] === '--version' || argv[0] === '-V') {
    process.stdout.write(`form-agent v${VERSION}\n`);
    return ExitCodes.SUCCESS;
  }

  const configFlagIndex = argv.indexOf('--config');
  let configPath: string | undefined;
  if (configFlagIndex !== -1) {
    configPath = argv[configFlagIndex + 1];
    if (configPath === undefined) {
      process.stderr.write('--config requires a path\n');
      return ExitCodes.USAGE;
    }
    argv.splice(configFlagIndex, 2);
  }

  const loaded = await loadConfig(configPath === undefined ? {} : { configPath });
  const ctx = makeContext(loaded);

  const [command, ...rest] = argv;
  switch (command) {
    case 'analyze':
      return await handleCmdAnalyze(rest[0] ?? '', ctx);
    case 'auth':
      return await handleCmdAuth(rest, ctx);
    case 'draft':
      return await handleCmdDraft(rest, ctx);
    case 'check':
      return await handleCmdCheck(rest, ctx);
    case 'file':
      return await handleCmdFile(rest[0] ?? '', ctx);
    case 'preview':
      return await handleCmdPreview(ctx);
    case 'plan':
      return await handleCmdPlan(rest[0] ?? '', ctx);
    case 'run':
      return await handleCmdRun(rest, ctx);
    case 'metrics':
      return await handleCmdMetrics(rest, ctx);
    case 'provider': {
      const providerId = rest[0];
      if (providerId === undefined) {
        ctx.logger.error('provider requires an id (e.g. form-agent provider fake)');
        return ExitCodes.USAGE;
      }
      if (rest.includes('--validate') || rest.includes('-v')) {
        return await handleCmdProviderValidate(providerId, ctx);
      }
      if (providerId === 'where') {
        return await handleCmdProviderWhere(ctx);
      }
      ctx.logger.error(`unknown provider subcommand: ${providerId}`);
      return ExitCodes.USAGE;
    }
    default:
      ctx.logger.error(`Unknown command "${command}" (see form-agent --help)`);
      return ExitCodes.UNKNOWN_COMMAND;
  }
}

export async function runCli(argv: string[]): Promise<void> {
  try {
    process.exitCode = await runArgv(argv);
  } catch (err) {
    if (err instanceof NotImplementedError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = ExitCodes.USAGE;
      return;
    }
    process.stderr.write(`form-agent: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = ExitCodes.ERROR;
  }
}

// Programmatic entry point (tests may import this instead of spawning).
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  return runArgv(argv);
}