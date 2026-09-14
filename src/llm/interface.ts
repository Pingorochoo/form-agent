/**
 * ChatCompletionClient interface.
 *
 * Implemented by `FakeProvider` (Phase 0) and by the openai-compatible
 * client (Phase 3 wiring per the approved refined order). Providers are
 * config-backed; `listModels` is used by `provider <id> --validate`.
 */

import type { ChatRequestOptions, ChatCompletionResult, ProviderConnectivity } from './types.ts';

export interface ChatCompletionClient {
  readonly providerId: string;
  readonly model: string;

  chat(messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[], options?: ChatRequestOptions): Promise<ChatCompletionResult>;

  listModels(): Promise<string[]>;

  checkConnectivity(): Promise<ProviderConnectivity>;

  /** Release any long-lived resources (HTTP clients, sockets). */
  close(): Promise<void>;
}