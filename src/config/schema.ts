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

export const SENSITIVE_FIELD_NAMES = ['Email', 'Phone', 'ApiKey', 'GoogleFormResponseId', 'SpecificInput'] as const;

const llmProviderSchema = z.object({
  type: z.enum(PROVIDER_TYPES).optional(),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
});

const llmSchema = z.object({
  defaultProvider: z.string().min(1).default('fake'),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().default(2048),
  enableCaching: z.boolean().default(true),
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