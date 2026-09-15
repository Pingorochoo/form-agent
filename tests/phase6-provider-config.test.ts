/**
 * Phase 6 provider config + endpoint/secret boundary tests (P6-R4, P6-R5).
 */

import { describe, expect, it } from 'vitest';

import { defaultConfig, parseConfig } from '../src/config/schema.ts';
import {
  isLoopbackHost,
  normalizeOpenAiEndpoint,
  classifyEndpoint,
} from '../src/llm/endpoint.ts';
import { LlmProviderError, LLM_ERROR_CODES } from '../src/llm/errors.ts';
import { resolveDraftProvider } from '../src/draft/resolve.ts';
import { DeterministicReferenceProvider } from '../src/draft/reference.ts';
import { OpenAiCompatibleDraftProvider } from '../src/draft/openai-compatible.ts';

describe('P6-R4 — config schema', () => {
  it('defaults the draft provider to reference and allowRemote to false', () => {
    const config = defaultConfig();
    expect(config.llm.draftProvider).toBe('reference');
    const withFake = parseConfig({ llm: { providers: { fake: { type: 'fake' } } } });
    expect(withFake.llm.providers['fake']?.allowRemote).toBe(false);
  });

  it('parses an openai-compatible provider with safe fields', () => {
    const config = parseConfig({
      llm: {
        draftProvider: 'openai-compatible',
        providers: {
          'openai-compatible': {
            type: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:1234/v1',
            model: 'some-model',
            apiKeyEnv: 'FORM_AGENT_LLM_API_KEY',
            allowRemote: false,
            timeoutMs: 5000,
            maxOutputTokens: 256,
            maxResponseBytes: 1024,
          },
        },
      },
    });
    expect(config.llm.draftProvider).toBe('openai-compatible');
    const provider = config.llm.providers['openai-compatible'];
    expect(provider?.allowRemote).toBe(false);
    expect(provider?.maxOutputTokens).toBe(256);
    expect(provider?.maxResponseBytes).toBe(1024);
  });

  it('rejects an unknown draftProvider value', () => {
    expect(() => parseConfig({ llm: { draftProvider: 'nope' } })).toThrow();
  });
});

describe('P6-R5 — endpoint classification', () => {
  it('treats localhost / 127.0.0.0/8 / ::1 as loopback', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.8.9.10')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  it('treats LAN / private / public hosts as remote', () => {
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
    expect(isLoopbackHost('172.16.0.1')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('8.8.8.8')).toBe(false);
  });

  it('normalizes base URL and appends /chat/completions exactly once', () => {
    const normalized = normalizeOpenAiEndpoint('http://127.0.0.1:11434/v1');
    expect(normalized.chatCompletionsUrl).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(normalized.classification).toBe('loopback');

    const already = normalizeOpenAiEndpoint('http://127.0.0.1:11434/v1/chat/completions');
    expect(already.chatCompletionsUrl).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  it('rejects userinfo, query, fragment, and non-http schemes', () => {
    expect(() => normalizeOpenAiEndpoint('http://user:pass@127.0.0.1/v1')).toThrow(LlmProviderError);
    expect(() => normalizeOpenAiEndpoint('http://127.0.0.1/v1?x=1')).toThrow(LlmProviderError);
    expect(() => normalizeOpenAiEndpoint('http://127.0.0.1/v1#frag')).toThrow(LlmProviderError);
    expect(() => normalizeOpenAiEndpoint('ftp://127.0.0.1/v1')).toThrow(LlmProviderError);
    expect(() => normalizeOpenAiEndpoint('not a url')).toThrow(LlmProviderError);
  });

  it('classifies a parsed endpoint as remote for LAN addresses', () => {
    const parsed = new URL('http://192.168.1.10/v1');
    expect(classifyEndpoint(parsed)).toBe('remote');
  });
});

describe('P6-R4/R5 — draft provider resolution', () => {
  function configWith(provider: Record<string, unknown>): ReturnType<typeof defaultConfig> {
    const config = defaultConfig();
    config.llm.providers = { 'openai-compatible': provider as never };
    return config;
  }

  it('resolves reference by default (network-free)', () => {
    const resolved = resolveDraftProvider(undefined, { config: defaultConfig(), env: {} });
    expect(resolved.kind).toBe('reference');
    expect(resolved.provider).toBeInstanceOf(DeterministicReferenceProvider);
    expect(resolved.modelLabel).toBeNull();
  });

  it('resolves openai-compatible for a loopback endpoint without allowRemote', () => {
    const config = configWith({ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'm', apiKeyEnv: 'K', enabled: true, allowRemote: false });
    const resolved = resolveDraftProvider('openai-compatible', { config, env: { K: 'secret' } });
    expect(resolved.provider).toBeInstanceOf(OpenAiCompatibleDraftProvider);
    expect(resolved.modelLabel).toBe('m');
  });

  it('rejects a remote endpoint without allowRemote', () => {
    const config = configWith({ type: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'm', enabled: true, allowRemote: false });
    try {
      resolveDraftProvider('openai-compatible', { config, env: {} });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as LlmProviderError).code).toBe(LLM_ERROR_CODES.REMOTE_NOT_ALLOWED);
    }
  });

  it('allows a remote endpoint with allowRemote=true (no request is made)', () => {
    const config = configWith({ type: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'm', apiKeyEnv: 'K', enabled: true, allowRemote: true });
    const resolved = resolveDraftProvider('openai-compatible', { config, env: { K: 'secret' } });
    expect(resolved.kind).toBe('openai-compatible');
  });

  it('rejects a missing model', () => {
    const config = configWith({ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true, allowRemote: false });
    try {
      resolveDraftProvider('openai-compatible', { config, env: {} });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as LlmProviderError).code).toBe(LLM_ERROR_CODES.PROVIDER_CONFIG_INVALID);
    }
  });

  it('rejects a missing configured API key env var (stable secret-safe code)', () => {
    const config = configWith({ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'm', apiKeyEnv: 'MISSING_KEY', enabled: true, allowRemote: false });
    try {
      resolveDraftProvider('openai-compatible', { config, env: {} });
      throw new Error('expected failure');
    } catch (err) {
      const error = err as LlmProviderError;
      expect(error.code).toBe(LLM_ERROR_CODES.SECRET_MISSING);
      expect(error.message).toContain('MISSING_KEY');
      expect(error.message).not.toContain('VERY_SECRET_LLM_TOKEN');
    }
  });

  it('rejects an unknown provider kind', () => {
    try {
      resolveDraftProvider('bogus' as never, { config: defaultConfig(), env: {} });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as LlmProviderError).code).toBe(LLM_ERROR_CODES.PROVIDER_CONFIG_INVALID);
    }
  });
});
