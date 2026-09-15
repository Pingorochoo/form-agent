/**
 * Phase 6 no-network tests (P6-R5, R9, docs/PHASE_6.md §10).
 *
 * Proves the reference provider is network-free, that loopback is the only
 * implicitly trusted LLM endpoint, that LAN/RFC1918/private addresses are NOT
 * loopback, and that a non-loopback endpoint can never send a request without
 * explicit allowRemote. No real external LLM service is ever contacted.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultConfig } from '../src/config/schema.ts';
import { isLoopbackHost, classifyEndpoint } from '../src/llm/endpoint.ts';
import { resolveDraftProvider } from '../src/draft/resolve.ts';
import { generateDraft } from '../src/draft/orchestrate.ts';
import { LlmProviderError, LLM_ERROR_CODES } from '../src/llm/errors.ts';
import { textQuestion } from './support/sample-schema.ts';
import type { FormSchema } from '../src/domain/types.ts';
import { sha256Hex } from '../src/domain/fingerprint.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeTextSchema(): FormSchema {
  const question = textQuestion('q-color', 0, 'Favorite color');
  const sectionId = '__default__';
  return {
    providerId: 'google-forms',
    formId: 'text-form',
    checksum: sha256Hex('q-color:text:Favorite color'),
    schemaVersion: 2,
    meta: { url: 'https://fixtures.local/forms/text-form', title: 'Text form', capturedAt: '2026-01-01T00:00:00.000Z', source: 'fixture', requiresSignIn: false },
    title: 'Text form',
    parts: [question],
    definitional: [],
    questions: { 'q-color': question },
    sections: [{ id: sectionId, slot: 0, index: 0, title: '', questionIds: ['q-color'], routing: { default: 'submit', conditional: false, rules: [] } }],
    questionSection: { 'q-color': sectionId },
    nonQuestionContent: [],
    hasRouting: false,
    terminalSectionIds: [sectionId],
    rowCount: 1,
    fieldCount: 1,
    answerModel: 'flat',
  };
}

describe('P6-R1/R5 — reference provider is network-free', () => {
  it('a reference draft performs zero fetch calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const resolved = resolveDraftProvider('reference', { config: defaultConfig(), env: {} });
    const schema = makeTextSchema();
    await generateDraft({ schema, seed: 's', provider: resolved.provider, sensitiveRules: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('P6-R5 — RFC1918/LAN addresses are never loopback', () => {
  it('classifies LAN and private addresses as remote', () => {
    for (const host of ['192.168.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.254', '100.64.0.1']) {
      expect(isLoopbackHost(host)).toBe(false);
      expect(classifyEndpoint(new URL(`http://${host}/v1`))).toBe('remote');
    }
    for (const host of ['localhost', '127.0.0.1', '127.255.255.255', '::1']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });
});

describe('P6-R5/R9 — non-loopback endpoints cannot send without consent', () => {
  function configWith(baseUrl: string, allowRemote: boolean): ReturnType<typeof defaultConfig> {
    const config = defaultConfig();
    config.llm.providers = {
      'openai-compatible': { type: 'openai-compatible', baseUrl, model: 'm', apiKeyEnv: 'K', allowRemote, enabled: true } as never,
    };
    return config;
  }

  it('a LAN endpoint without allowRemote throws before any request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const config = configWith('http://192.168.1.10/v1', false);
    try {
      resolveDraftProvider('openai-compatible', { config, env: { K: 'secret' } });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as LlmProviderError).code).toBe(LLM_ERROR_CODES.REMOTE_NOT_ALLOWED);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolution with allowRemote=true performs no network I/O', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const config = configWith('https://api.example.com/v1', true);
    const resolved = resolveDraftProvider('openai-compatible', { config, env: { K: 'secret' } });
    expect(resolved.kind).toBe('openai-compatible');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
