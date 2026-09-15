/**
 * form-agent configuration schema (Zod).
 *
 * Enforceable in Phase 0; enforced by real features in Phases 1-8.
 */

import { z } from 'zod';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const PROVIDER_TYPES = ['openai-compatible', 'fake'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/**
 * Draft-provider selection (Phase 6). `reference` is the deterministic,
 * network-free fallback (accepted Phase 3); `openai-compatible` is the first
 * real network LLM provider family wired against the same DraftProvider
 * boundary. This is intentionally distinct from the low-level text-chat
 * `providers` record above.
 */
export const DRAFT_PROVIDER_TYPES = ['reference', 'openai-compatible'] as const;
export type DraftProviderType = (typeof DRAFT_PROVIDER_TYPES)[number];

export const SENSITIVE_FIELD_NAMES = ['Email', 'Phone', 'ApiKey', 'GoogleFormResponseId', 'SpecificInput'] as const;

/**
 * Conservative Phase 6 transport defaults (P6-R9 / docs/PHASE_6.md §8).
 * Bounded timeout and bounded response body are applied at the transport layer
 * and never derived from provider output.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
export const DEFAULT_LLM_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB

const llmProviderSchema = z.object({
  type: z.enum(PROVIDER_TYPES).optional(),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** Explicit opt-in for any non-loopback LLM endpoint (P6-R5). */
  allowRemote: z.boolean().default(false),
  /** Bounded output token request, only sent when explicitly configured. */
  maxOutputTokens: z.number().int().positive().optional(),
  /** Bounded response body (bytes) before JSON parsing (P6-R9). */
  maxResponseBytes: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
});

const llmSchema = z.object({
  defaultProvider: z.string().min(1).default('fake'),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().default(2048),
  enableCaching: z.boolean().default(true),
  /** Selected DraftProvider for draft-producing flows; default network-free. */
  draftProvider: z.enum(DRAFT_PROVIDER_TYPES).default('reference'),
  providers: z.record(llmProviderSchema).default({}),
});

const databaseSchema = z.object({
  directory: z.string().min(1).default('.data'),
  filename: z.string().min(1).default('form-agent.db'),
});

const analyzeSchema = z.object({
  maxAnswerPerQuestion: z.number().int().positive().default(20),
  batchMaxSize: z.number().int().positive().default(10),
});

const runSchema = z.object({
  concurrency: z.number().int().min(1).max(16).default(1),
  autoApprove: z.boolean().default(false),
});

const formsSchema = z.object({
  allowlist: z.array(z.string()).default([]),
});

/**
 * Safety-mode gating (P2-R15). Execution eligibility requires
 * `safety.mode === 'test-only'`; every other mode (including the default)
 * denies. The default is deliberately deny-by-default.
 */
export const SAFETY_MODES = ['test-only', 'disabled'] as const;
export type SafetyMode = (typeof SAFETY_MODES)[number];

const safetySchema = z.object({
  mode: z.enum(SAFETY_MODES).default('disabled'),
});

/**
 * Deterministic rate policy (P2-R16). Limits are safety gates, never pacing or
 * anti-detection behavior. Only the defaults already defined by repository
 * evidence are set here; the hourly/daily caps and batch pause stay optional so
 * absence means "no configured cap" rather than an invented number.
 *
 * `jitterFactor` is configuration only in Phase 2 (validated, never applied).
 */
const rateSchema = z.object({
  delayBetweenSubmissionsMs: z.number().int().min(0).default(30_000),
  maxSubmissionsPerFormPerHour: z.number().int().min(0).optional(),
  maxSubmissionsPerFormPerDay: z.number().int().min(0).optional(),
  batchPauseSeconds: z.number().int().min(0).optional(),
  maxConcurrentBatches: z.number().int().min(1).default(1),
  jitterFactor: z.number().min(0).max(1).default(0),
});

const telegramSchema = z.object({
  enabled: z.boolean().default(false),
  chatId: z.string().optional(),
});

/**
 * Phase 5 browser-execution configuration (P5-R19).
 *
 * Conservative finite defaults: headless by default (no display needed), and
 * explicit finite navigation/action timeouts. `executablePath` is only for
 * environments that must point Playwright at a specific Chromium build; the
 * default empty string means "use Playwright's bundled Chromium".
 */
const browserSchema = z.object({
  headless: z.boolean().default(true),
  navigationTimeoutMs: z.number().int().positive().default(30_000),
  actionTimeoutMs: z.number().int().positive().default(10_000),
  executablePath: z.string().default(''),
});

export const appConfigSchema = z
  .object({
    database: databaseSchema.default({}),
    log: z.object({ level: z.enum(LOG_LEVELS).default('info') }).default({}),
    llm: llmSchema.default({}),
    analyze: analyzeSchema.default({}),
    run: runSchema.default({}),
    forms: formsSchema.default({}),
    safety: safetySchema.default({}),
    rate: rateSchema.default({}),
    browser: browserSchema.default({}),
    telegram: telegramSchema.default({}),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;
export type LlmProviderConfig = z.infer<typeof llmProviderSchema>;

/** Human-readable Zod validation errors. */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      const allowed = issue.code === 'invalid_enum_value' ? ` (allowed: ${issue.options.join(', ')})` : '';
      return `- ${path}: ${issue.message}${allowed}`;
    })
    .join('\n');
}

/** Parse untrusted config data; throws Error with human-readable details. */
export function parseConfig(data: unknown): AppConfig {
  const result = appConfigSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${formatZodError(result.error)}`);
  }
  return result.data;
}

/** The configuration the CLI ships with when nothing is provided. */
export function defaultConfig(): AppConfig {
  return parseConfig({});
}