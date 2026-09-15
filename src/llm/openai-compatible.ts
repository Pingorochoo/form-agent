/**
 * OpenAI-compatible non-streaming chat-completions transport (P6-R3, R7, R9,
 * docs/PHASE_6.md §7/§8).
 *
 * A single-shot, provider-neutral HTTP client that performs at most one request
 * per invocation, with no automatic retries. It uses Node's built-in `fetch`
 * (preferred) and enforces:
 *   - non-streaming request (`stream: false`);
 *   - finite timeout via AbortController;
 *   - redirect rejection (`redirect: 'manual'` so an Authorization header is
 *     never forwarded to a redirected destination);
 *   - a bounded response body read before any JSON parsing;
 *   - conservative response-envelope parsing (P6-R7).
 *
 * It never logs request headers or response bodies. All failures surface as
 * stable `LlmProviderError`s without raw server-body text.
 */

import { LlmProviderError, LLM_ERROR_CODES } from './errors.ts';
import type { NormalizedEndpoint } from './endpoint.ts';

export interface OpenAiCompatibleTransportConfig {
  endpoint: NormalizedEndpoint;
  model: string;
  /** null when the endpoint is unauthenticated (loopback). */
  apiKey: string | null;
  timeoutMs: number;
  maxOutputTokens: number | undefined;
  maxResponseBytes: number;
}

export interface OpenAiCompatibleRequest {
  system: string;
  user: string;
  temperature?: number;
}

export interface OpenAiCompatibleResult {
  content: string;
  model: string;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  latencyMs: number;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const textDecoder = new TextDecoder();

/** Read the response body up to `maxBytes`; abort the stream past the bound. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (body === null) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new LlmProviderError(
          LLM_ERROR_CODES.RESPONSE_TOO_LARGE,
          'LLM response body exceeded the configured size limit',
        );
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof LlmProviderError) throw err;
    // Only a genuine AbortController abort (our timeout) maps to LLM_TIMEOUT;
    // an unrelated stream/network read failure is a connectivity failure.
    if (isAbortError(err)) {
      throw new LlmProviderError(LLM_ERROR_CODES.TIMEOUT, 'LLM request timed out');
    }
    throw new LlmProviderError(LLM_ERROR_CODES.OFFLINE, 'LLM response stream failed');
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return textDecoder.decode(buffer);
}

/** Map a non-2xx HTTP status to a stable LLM error (no body echo). */
function httpError(status: number): LlmProviderError {
  if (status === 429) {
    return new LlmProviderError(LLM_ERROR_CODES.RATE_LIMITED, 'LLM provider rate-limited the request', status);
  }
  if (status === 401 || status === 403) {
    return new LlmProviderError(LLM_ERROR_CODES.HTTP_ERROR, 'LLM provider rejected the request (authentication)', status);
  }
  if (status >= 500) {
    return new LlmProviderError(LLM_ERROR_CODES.HTTP_ERROR, 'LLM provider returned a server error', status);
  }
  return new LlmProviderError(LLM_ERROR_CODES.HTTP_ERROR, 'LLM provider returned an error response', status);
}

/** Conservative chat-completions envelope parse (P6-R7). */
function parseEnvelope(payload: string): { content: string; model: string; finishReason: string; usage: OpenAiCompatibleResult['usage'] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new LlmProviderError(LLM_ERROR_CODES.PROTOCOL_INVALID, 'LLM response was not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LlmProviderError(LLM_ERROR_CODES.PROTOCOL_INVALID, 'LLM response was not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const choices = record['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmProviderError(LLM_ERROR_CODES.PROTOCOL_INVALID, 'LLM response is missing the choices array');
  }
  const first = choices[0];
  if (typeof first !== 'object' || first === null) {
    throw new LlmProviderError(LLM_ERROR_CODES.PROTOCOL_INVALID, 'LLM response choice is malformed');
  }
  const message = (first as Record<string, unknown>)['message'];
  if (typeof message !== 'object' || message === null) {
    throw new LlmProviderError(LLM_ERROR_CODES.PROTOCOL_INVALID, 'LLM response choice is missing a message');
  }
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content !== 'string') {
    throw new LlmProviderError(LLM_ERROR_CODES.PROTOCOL_INVALID, 'LLM response message content is missing');
  }

  const usageRaw = record['usage'];
  const usage = {
    inputTokens: typeof usageRaw === 'object' && usageRaw !== null ? toInt((usageRaw as Record<string, unknown>)['prompt_tokens']) : 0,
    outputTokens: typeof usageRaw === 'object' && usageRaw !== null ? toInt((usageRaw as Record<string, unknown>)['completion_tokens']) : 0,
    totalTokens: typeof usageRaw === 'object' && usageRaw !== null ? toInt((usageRaw as Record<string, unknown>)['total_tokens']) : 0,
  };

  const model = typeof record['model'] === 'string' ? record['model'] : 'unknown';
  const finishReason =
    typeof (first as Record<string, unknown>)['finish_reason'] === 'string'
      ? ((first as Record<string, unknown>)['finish_reason'] as string)
      : 'stop';

  return { content, model, finishReason, usage };
}

function toInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * Perform one non-streaming chat-completions request. Never retries. Throws a
 * stable `LlmProviderError` on any failure. Defaults to the global `fetch`.
 */
export async function openAiChatCompletions(
  config: OpenAiCompatibleTransportConfig,
  request: OpenAiCompatibleRequest,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<OpenAiCompatibleResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey !== null) {
    headers['authorization'] = `Bearer ${config.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    temperature: request.temperature ?? 0,
    stream: false,
  };
  if (config.maxOutputTokens !== undefined) {
    body['max_tokens'] = config.maxOutputTokens;
  }

  let response: Response;
  try {
    response = await fetchImpl(config.endpoint.chatCompletionsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (isAbortError(err)) {
      throw new LlmProviderError(LLM_ERROR_CODES.TIMEOUT, 'LLM request timed out');
    }
    throw new LlmProviderError(LLM_ERROR_CODES.OFFLINE, 'LLM provider is unreachable');
  }

  // Reject any HTTP redirect (3xx) rather than forwarding Authorization.
  if (response.status >= 300 && response.status < 400) {
    clearTimeout(timer);
    throw new LlmProviderError(
      LLM_ERROR_CODES.HTTP_ERROR,
      'LLM endpoint returned a redirect, which is not allowed',
      response.status,
    );
  }

  if (!response.ok) {
    clearTimeout(timer);
    throw httpError(response.status);
  }

  let payload: string;
  try {
    payload = await readBoundedBody(response, config.maxResponseBytes);
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseEnvelope(payload);
  return {
    content: parsed.content,
    model: parsed.model,
    finishReason: parsed.finishReason,
    usage: parsed.usage,
    latencyMs: Date.now() - startedAt,
  };
}
