/**
 * Phase 6 OpenAI-compatible transport + provider error-mapping tests
 * (P6-R3, R7, R9, R10).
 *
 * Uses only the loopback LLM stub — never a real cloud model. Verifies the
 * request contract, the conservative envelope parse, redirect rejection,
 * timeout/oversize bounds, HTTP status mapping, and secret-safe stable errors.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { openAiChatCompletions, type OpenAiCompatibleTransportConfig } from '../src/llm/openai-compatible.ts';
import { normalizeOpenAiEndpoint } from '../src/llm/endpoint.ts';
import { LlmProviderError, LLM_ERROR_CODES, llmExitCode } from '../src/llm/errors.ts';
import { ExitCodes } from '../src/cli/exit-codes.ts';
import { LlmStub, SECRET_SENTINEL, type LlmStubScenario } from './support/phase6-llm-stub.ts';

const STUBS: Array<{ stub: LlmStub; url: string }> = [];

async function makeStub(scenario: LlmStubScenario = 'valid'): Promise<{ stub: LlmStub; url: string }> {
  const stub = new LlmStub();
  stub.setScenario(scenario);
  stub.setTimeoutMs(200);
  const url = await stub.start();
  STUBS.push({ stub, url });
  return { stub, url };
}

afterEach(async () => {
  for (const { stub } of STUBS.splice(0)) {
    await stub.stop();
  }
});

function transportConfig(baseUrl: string, apiKey: string | null = null): OpenAiCompatibleTransportConfig {
  return {
    endpoint: normalizeOpenAiEndpoint(baseUrl),
    model: 'stub-model-1',
    apiKey,
    timeoutMs: 1000,
    maxOutputTokens: undefined,
    maxResponseBytes: 2 * 1024 * 1024,
  };
}

describe('P6-R3/R7 — request contract + envelope parse', () => {
  it('sends a non-streaming request with the configured model and structured messages', async () => {
    const { stub, url } = await makeStub('valid');
    const result = await openAiChatCompletions(transportConfig(url), {
      system: 'whole-form semantic model instruction',
      user: '{"hello":"world"}',
    });
    expect(result.content).toContain('"purpose"');

    const request = stub.requests[0];
    expect(request).toBeDefined();
    expect(request?.path).toBe('/chat/completions');
    expect(request?.model).toBe('stub-model-1');
    expect(request?.body['stream']).toBe(false);
    expect(request?.body['temperature']).toBe(0);
    expect(Array.isArray(request?.body['messages'])).toBe(true);
  });

  it('sends Authorization only when a key is configured, and never in the JSON body', async () => {
    const { stub, url } = await makeStub('valid');
    await openAiChatCompletions(transportConfig(url, SECRET_SENTINEL), {
      system: 'sys',
      user: '{}',
    });
    const request = stub.requests[0];
    expect(request?.authorization).toBe(`Bearer ${SECRET_SENTINEL}`);
    expect(JSON.stringify(request?.body)).not.toContain(SECRET_SENTINEL);
  });

  it('omits the Authorization header when no key is configured', async () => {
    const { stub, url } = await makeStub('valid');
    await openAiChatCompletions(transportConfig(url, null), { system: 'sys', user: '{}' });
    expect(stub.requests[0]?.authorization).toBeNull();
  });
});

describe('P6-R9/R10 — bounded transport behavior', () => {
  it('rejects an HTTP redirect without following it', async () => {
    const { url } = await makeStub('redirect');
    try {
      await openAiChatCompletions(transportConfig(url), { system: 'sys', user: '{}' });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as LlmProviderError).code).toBe(LLM_ERROR_CODES.HTTP_ERROR);
    }
  });

  it('maps 401/403/429/500 to stable codes without echoing the body', async () => {
    for (const [scenario, code] of [
      ['http-401', LLM_ERROR_CODES.HTTP_ERROR],
      ['http-403', LLM_ERROR_CODES.HTTP_ERROR],
      ['http-429', LLM_ERROR_CODES.RATE_LIMITED],
      ['http-500', LLM_ERROR_CODES.HTTP_ERROR],
    ] as const) {
      const { url } = await makeStub(scenario);
      try {
        await openAiChatCompletions(transportConfig(url), { system: 'sys', user: '{}' });
        throw new Error('expected failure');
      } catch (err) {
        expect((err as LlmProviderError).code).toBe(code);
        expect((err as Error).message).not.toContain('internal error');
        expect((err as Error).message).not.toContain('unauthorized');
      }
    }
  });

  it('maps a timeout to LLM_TIMEOUT', async () => {
    const { url } = await makeStub('timeout');
    const config = transportConfig(url);
    config.timeoutMs = 100;
    try {
      await openAiChatCompletions(config, { system: 'sys', user: '{}' });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as LlmProviderError).code).toBe(LLM_ERROR_CODES.TIMEOUT);
    }
  });

  it('maps an oversized response to RESPONSE_TOO_LARGE', async () => {
    const { url } = await makeStub('oversized');
    const config = transportConfig(url);
    config.maxResponseBytes = 1024;
    try {
      await openAiChatCompletions(config, { system: 'sys', user: '{}' });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as LlmProviderError).code).toBe(LLM_ERROR_CODES.RESPONSE_TOO_LARGE);
    }
  });

  it('maps a malformed envelope to PROTOCOL_INVALID', async () => {
    const { url } = await makeStub('malformed-envelope');
    try {
      await openAiChatCompletions(transportConfig(url), { system: 'sys', user: '{}' });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as LlmProviderError).code).toBe(LLM_ERROR_CODES.PROTOCOL_INVALID);
    }
  });

  it('maps an unreachable endpoint to LLM_OFFLINE', async () => {
    try {
      await openAiChatCompletions(transportConfig('http://127.0.0.1:1/v1'), { system: 'sys', user: '{}' });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as LlmProviderError).code).toBe(LLM_ERROR_CODES.OFFLINE);
    }
  });
});

describe('P6-R10 — stable exit-code mapping', () => {
  it('maps LLM error codes onto the frozen exit-code contract', () => {
    expect(llmExitCode(LLM_ERROR_CODES.PROVIDER_CONFIG_INVALID)).toBe(ExitCodes.USAGE);
    expect(llmExitCode(LLM_ERROR_CODES.REMOTE_NOT_ALLOWED)).toBe(ExitCodes.USAGE);
    expect(llmExitCode(LLM_ERROR_CODES.SECRET_MISSING)).toBe(ExitCodes.USAGE);
    expect(llmExitCode(LLM_ERROR_CODES.OUTPUT_INVALID)).toBe(ExitCodes.VALIDATION);
    expect(llmExitCode(LLM_ERROR_CODES.OFFLINE)).toBe(ExitCodes.LLM_OFFLINE);
    expect(llmExitCode(LLM_ERROR_CODES.TIMEOUT)).toBe(ExitCodes.LLM_CONNECTIVITY);
    expect(llmExitCode(LLM_ERROR_CODES.HTTP_ERROR)).toBe(ExitCodes.LLM_CONNECTIVITY);
  });
});
