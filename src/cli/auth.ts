/**
 * `form-agent auth` command handlers (P2-R4, P2-R5).
 *
 * Authorization management is local-only and performs no network access, no
 * form execution, and no submission. Audit output contains operator name,
 * canonical target, scope, status, and timestamps — never secrets or answer
 * values (there are none in Phase 2).
 */

import { FormAgentDatabase } from '../db/database.ts';
import { ExitCodes } from './exit-codes.ts';
import { AuthorizationStore, isSupportedScope, type SupportedScope } from '../policy/authz.ts';
import { canonicalizeTarget, type CanonicalTarget, TargetError } from '../policy/target.ts';
import type { CliContext } from './index.ts';

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | undefined>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const name = arg.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[name] = next;
          i += 1;
        } else {
          flags[name] = undefined;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function openDatabase(ctx: CliContext): FormAgentDatabase {
  return FormAgentDatabase.open({
    directory: ctx.config.database.directory,
    filename: ctx.config.database.filename,
  });
}

function resolveScope(flags: Record<string, string | undefined>): string | undefined {
  return flags.scope ?? 'run';
}

function resolveCanonical(target: string, ctx: CliContext): CanonicalTarget | null {
  try {
    return canonicalizeTarget(target);
  } catch (err) {
    ctx.logger.error(err instanceof TargetError ? err.message : String(err));
    return null;
  }
}

function requireTarget(positionals: string[], ctx: CliContext): string | null {
  const target = positionals[0];
  if (target === undefined || target.trim() === '') {
    ctx.logger.error('auth requires a target (url, fixture id, or fixture URL)');
    return null;
  }
  return target;
}

function requireSupportedScope(scope: string, ctx: CliContext): SupportedScope | null {
  if (!isSupportedScope(scope)) {
    ctx.logger.error(`unsupported authorization scope "${scope}" (supported: run)`);
    return null;
  }
  return scope;
}

async function authAllow(args: string[], ctx: CliContext): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  const target = requireTarget(positionals, ctx);
  if (target === null) return ExitCodes.USAGE;
  const scopeValue = resolveScope(flags);
  if (scopeValue === undefined) {
    ctx.logger.error('--scope requires a value');
    return ExitCodes.USAGE;
  }
  const scope = requireSupportedScope(scopeValue, ctx);
  if (scope === null) return ExitCodes.USAGE;

  const operator = flags.by;
  if (operator === undefined || operator.trim() === '') {
    ctx.logger.error('auth allow requires a non-empty --by <operator>');
    return ExitCodes.USAGE;
  }

  const canonical = resolveCanonical(target, ctx);
  if (canonical === null) return ExitCodes.USAGE;

  const database = openDatabase(ctx);
  try {
    const store = new AuthorizationStore(database);
    const record = store.allow(canonical, scope, operator);
    process.stdout.write(
      `allowlisted ${record.targetDisplay} for scope ${record.scope} (operator ${record.operator})\n`,
    );
    return ExitCodes.SUCCESS;
  } finally {
    database.close();
  }
}

async function authCheck(args: string[], ctx: CliContext): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  const target = requireTarget(positionals, ctx);
  if (target === null) return ExitCodes.USAGE;
  const scopeValue = resolveScope(flags) ?? 'run';

  const canonical = resolveCanonical(target, ctx);
  if (canonical === null) return ExitCodes.USAGE;

  const database = openDatabase(ctx);
  try {
    const store = new AuthorizationStore(database);
    const result = store.check(canonical.key, scopeValue);
    if (result.state === 'authorized' && result.record !== null) {
      process.stdout.write(
        `state=authorized target=${result.record.targetDisplay} scope=${result.record.scope} operator=${result.record.operator}\n`,
      );
    } else if (result.state === 'revoked') {
      process.stdout.write(`state=revoked target=${canonical.display} scope=${scopeValue}\n`);
    } else if (result.state === 'scope-unavailable') {
      process.stdout.write(`state=scope-unavailable scope=${scopeValue}\n`);
    } else {
      process.stdout.write(`state=not-allowlisted target=${canonical.display} scope=${scopeValue}\n`);
    }
    return ExitCodes.SUCCESS;
  } finally {
    database.close();
  }
}

async function authList(ctx: CliContext): Promise<number> {
  const database = openDatabase(ctx);
  try {
    const store = new AuthorizationStore(database);
    const records = store.list();
    for (const record of records) {
      const revoked = record.revokedAt !== null ? ` revoked=${record.revokedAt}` : '';
      process.stdout.write(
        `id=${record.id} target=${record.targetDisplay} scope=${record.scope} status=${record.status} operator=${record.operator} created=${record.createdAt}${revoked}\n`,
      );
    }
    return ExitCodes.SUCCESS;
  } finally {
    database.close();
  }
}

async function authRevoke(args: string[], ctx: CliContext): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  const target = requireTarget(positionals, ctx);
  if (target === null) return ExitCodes.USAGE;
  const scopeValue = resolveScope(flags);
  if (scopeValue === undefined) {
    ctx.logger.error('--scope requires a value');
    return ExitCodes.USAGE;
  }
  const scope = requireSupportedScope(scopeValue, ctx);
  if (scope === null) return ExitCodes.USAGE;

  const canonical = resolveCanonical(target, ctx);
  if (canonical === null) return ExitCodes.USAGE;

  const database = openDatabase(ctx);
  try {
    const store = new AuthorizationStore(database);
    const record = store.revoke(canonical.key, scope);
    if (record === null) {
      process.stdout.write(`nothing to revoke for ${canonical.display} (scope ${scope})\n`);
    } else {
      process.stdout.write(`revoked ${record.targetDisplay} for scope ${record.scope}\n`);
    }
    return ExitCodes.SUCCESS;
  } finally {
    database.close();
  }
}

export async function handleCmdAuth(args: string[], ctx: CliContext): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) {
    ctx.logger.error('auth requires a subcommand: allow, check, list, revoke');
    return ExitCodes.USAGE;
  }
  switch (subcommand) {
    case 'allow':
      return authAllow(rest, ctx);
    case 'check':
      return authCheck(rest, ctx);
    case 'list':
      return authList(ctx);
    case 'revoke':
      return authRevoke(rest, ctx);
    default:
      ctx.logger.error(`unknown auth subcommand: ${subcommand}`);
      return ExitCodes.USAGE;
  }
}
