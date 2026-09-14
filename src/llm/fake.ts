/**
 * FakeProvider — deterministic, offline, always-available ChatCompletionClient.
 *
 * Ships from Phase 0 so `provider fake --validate` and the offline/free tier
 * work today. The fake is NOT a stub that pretends to reason: it returns a
 * deterministic template completion so downstream modules and tests can
 * exercise the ChatCompletionClient contract without any network.
 */

import type { ChatCompletionClient } from './interface.ts';
import type {
  ChatCompletionResult,
  ChatCompletionUsage,
  ChatRequestOptions,
  ChatMessage,
  ProviderConnectivity,
} from './types.ts';

export class FakeProvider implements ChatCompletionClient {
  readonly providerId = 'fake';
  readonly model: string;

  constructor(model = 'fake-0.1') {
    this.model = model;
  }

  async chat(
    messages: readonly ChatMessage[],
    options?: ChatRequestOptions,
  ): Promise<ChatCompletionResult> {
    const startedAt = Date.now();
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const content =
      `[fake:${this.model}] ` +
      `system=${JSON.stringify(system)} ` +
      `user=${JSON.stringify(lastUser)} ` +
      `cacheKey=${options?.cacheKey ?? '<none>'}`;

    const usage: ChatCompletionUsage = {
      inputTokens: messages.reduce((n, m) => n + m.content.length, 0),
      outputTokens: content.length,
      totalTokens: messages.reduce((n, m) => n + m.content.length, 0) + content.length,
    };
    return {
      content,
      model: this.model,
      provider: this.providerId,
      finishReason: 'stop',
      usage,
      latencyMs: Date.now() - startedAt,
    };
  }

  async listModels(): Promise<string[]> {
    return [this.model];
  }

  async checkConnectivity(): Promise<ProviderConnectivity> {
    return { ok: true, provider: this.providerId, model: this.model, latencyMs: 0 };
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}