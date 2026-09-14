/**
 * Provider-neutral LLM types.
 *
 * Per-stage string modes ('off' | 'auto' | 'required') are attached to each
 * answer-generation/analysis stage; every 'auto' stage degrades to
 * deterministic when the model is unavailable (enforced in Phase 3+).
 */

export type LlmStageMode = 'off' | 'auto' | 'required';

export interface StageConfig {
  mode: LlmStageMode;
  /** Helpful for `provider <id> --validate` output and dashboards. */
  description?: string;
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChatCompletionResult {
  content: string;
  model: string;
  provider: string;
  finishReason: string;
  usage: ChatCompletionUsage;
  /** Round-trip latency in milliseconds. */
  latencyMs: number;
}

export interface ChatRequestOptions {
  temperature?: number;
  maxTokens?: number;
  /** Form-wide stable cache key; deterministic when enableCaching is on. */
  cacheKey?: string;
}

export interface ProviderConnectivity {
  ok: boolean;
  provider: string;
  model?: string;
  latencyMs?: number;
  error?: string;
}