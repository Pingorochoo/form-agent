/**
 * Phase 8 adapter entrypoint (`form-agent-openclaw`).
 *
 * Strict argv parsing for the FROZEN operation grammar, then exactly one JSON
 * envelope on stdout. The adapter exits `0` whenever it can emit a document
 * (including blocked/usage/unauthorized/timeout) and `1` only when it cannot
 * emit one at all.
 *
 * Deployment adapter config is data-only and is loaded from the absolute path
 * in `FORM_AGENT_OPENCLAW_CONFIG` (never model input). It contains no secrets.
 */

import { readFileSync } from 'node:fs';

import {
  ALL_OPERATIONS,
  buildEnvelope,
  isKnownOperation,
  validateAdapterConfig,
  type AdapterConfig,
  type AdapterOperation,
} from './contracts.ts';
import { categoryMessage } from './format.ts';
import { FormAgentAdapter, type AdapterOperationInput } from './adapter.ts';
import { PendingStore } from './pending.ts';
import { NodeSubprocessRunner } from './runner.ts';

export const ADAPTER_CONFIG_ENV = 'FORM_AGENT_OPENCLAW_CONFIG';

interface ParsedArgv {
  operation: AdapterOperation;
  input: AdapterOperationInput;
  principal: { channel?: string; accountId?: string; senderId?: string; conversationId?: string };
}

type ParseOutcome = { ok: true; value: ParsedArgv } | { ok: false; operation: string | null; error: string };

const VALUE_FLAGS = new Map<string, keyof AdapterOperationInput | 'conversationId' | 'channel' | 'accountId' | 'senderId'>([
  ['--channel', 'channel'],
  ['--account', 'accountId'],
  ['--sender', 'senderId'],
  ['--conversation', 'conversationId'],
  ['--target', 'target'],
  ['--draft-provider', 'draftProvider'],
  ['--since', 'since'],
  ['--until', 'until'],
  ['--pending-ref', 'pendingRef'],
  ['--plan', 'planId'],
  ['--attempt', 'attempt'],
  ['--target-key', 'targetKey'],
  ['--target-display', 'targetDisplay'],
  ['--expires-at', 'expiresAtMs'],
  ['--resolution', 'resolution'],
]);

const BOOLEAN_FLAGS = new Set(['--review-answers']);

/**
 * Operator-facing CLI aliases. The internal typed operation stays
 * `reconcile_unknown`; the local operator command accepts the dashed
 * `reconcile-unknown` spelling (§11.2a). This is operator-local only: it never
 * appears in the model-facing `form_agent` operation enum and is never a
 * Telegram command.
 */
export const OPERATION_CLI_ALIASES: Readonly<Record<string, AdapterOperation>> = {
  'reconcile-unknown': 'reconcile_unknown',
};

export function normalizeOperationName(raw: string): AdapterOperation | null {
  const aliased = OPERATION_CLI_ALIASES[raw];
  if (aliased !== undefined) return aliased;
  return isKnownOperation(raw) ? raw : null;
}

export function parseAdapterArgv(argv: string[]): ParseOutcome {
  const operationRaw = argv[0];
  const operation = operationRaw === undefined ? null : normalizeOperationName(operationRaw);
  if (operation === null) {
    return { ok: false, operation: operationRaw ?? null, error: 'unknown operation' };
  }
  const input: AdapterOperationInput = { operation };
  const principal: ParsedArgv['principal'] = {};

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    let name = arg;
    let inlineValue: string | null = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }

    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== null) return { ok: false, operation, error: 'invalid boolean flag' };
      input.reviewAnswers = true;
      continue;
    }

    const field = VALUE_FLAGS.get(name);
    if (field === undefined) {
      return { ok: false, operation, error: 'unknown flag' };
    }

    let value: string;
    if (inlineValue !== null) {
      value = inlineValue;
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, operation, error: `${name} requires a value` };
      }
      value = next;
      i += 1;
    }

    if (field === 'channel' || field === 'accountId' || field === 'senderId') {
      principal[field] = value;
      continue;
    }
    if (field === 'conversationId') {
      input.conversationId = value;
      continue;
    }
    if (field === 'expiresAtMs') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) return { ok: false, operation, error: 'invalid expiry' };
      input.expiresAtMs = parsed;
      continue;
    }
    if (field === 'reviewAnswers') {
      input.reviewAnswers = value === 'true';
      continue;
    }
    (input as unknown as Record<string, unknown>)[field] = value;
  }

  return { ok: true, value: { operation, input, principal } };
}

export interface RunAdapterOptions {
  /** Test seam: resolved adapter config (bypasses env loading). */
  config?: AdapterConfig;
  /** Test seam: resolved runner. */
  runner?: NodeSubprocessRunner;
  clock?: () => number;
  parentEnv?: NodeJS.ProcessEnv;
}

function loadAdapterConfigFromEnv(parentEnv: NodeJS.ProcessEnv): AdapterConfig | null {
  const path = parentEnv[ADAPTER_CONFIG_ENV];
  if (path === undefined || path === '') return null;
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const validated = validateAdapterConfig(raw);
  return validated.ok ? validated.value : null;
}

function emit(envelope: unknown): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Run one adapter invocation. Returns the process exit code: `0` when exactly
 * one envelope was emitted, `1` when no document could be produced.
 */
export async function runAdapterCli(argv: string[], options: RunAdapterOptions = {}): Promise<number> {
  const parsed = parseAdapterArgv(argv);
  if (!parsed.ok) {
    const operation = parsed.operation ?? (argv[0] ?? 'unknown');
    emit(buildEnvelope({ operation, category: 'usage_error', message: categoryMessage('usage_error') }));
    return 0;
  }

  let config = options.config ?? null;
  if (config === null) {
    try {
      config = loadAdapterConfigFromEnv(options.parentEnv ?? process.env);
    } catch {
      config = null;
    }
  }

  if (config === null) {
    // Deployment config is mandatory; without it no principal can be validated.
    emit(
      buildEnvelope({
        operation: parsed.value.operation,
        category: 'error',
        message: categoryMessage('error'),
        data: { configUnavailable: true },
      }),
    );
    return 0;
  }

  const store = new PendingStore({
    dataDir: config.dataDir,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  const adapter = new FormAgentAdapter({
    config,
    runner: options.runner ?? new NodeSubprocessRunner(),
    store,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });

  let envelope;
  try {
    envelope = await adapter.execute(parsed.value.principal, parsed.value.input);
  } catch {
    envelope = buildEnvelope({
      operation: parsed.value.operation,
      category: 'error',
      message: categoryMessage('error'),
    });
  }
  emit(envelope);
  return 0;
}

export { ALL_OPERATIONS };
