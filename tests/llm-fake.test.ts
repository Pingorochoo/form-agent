/**
 * FakeProvider contract tests.
 */

import { describe, expect, it } from 'vitest';

import { FakeProvider } from '../src/llm/fake.ts';

describe('FakeProvider', () => {
  it('implements the ChatCompletionClient contract end-to-end', async () => {
    const provider = new FakeProvider();
    expect(provider.providerId).toBe('fake');
    expect(provider.model).toBe('fake-0.1');

    const result = await provider.chat([
      { role: 'system', content: 'Speak plainly.' },
      { role: 'user', content: 'Hello' },
    ]);
    expect(result.provider).toBe('fake');
    expect(result.model).toBe('fake-0.1');
    expect(result.content).toContain('[fake:fake-0.1]');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic for the same input', async () => {
    const a = new FakeProvider();
    const b = new FakeProvider();
    const ra = await a.chat([{ role: 'user', content: 'same' }]);
    const rb = await b.chat([{ role: 'user', content: 'same' }]);
    expect(ra.content).toBe(rb.content);
  });

  it('lists models and reports connectivity OK', async () => {
    const provider = new FakeProvider('fake-test');
    expect(await provider.listModels()).toEqual(['fake-test']);
    const connectivity = await provider.checkConnectivity();
    expect(connectivity.ok).toBe(true);
    expect(connectivity.provider).toBe('fake');
  });

  it('close() is safe and no-op', async () => {
    const provider = new FakeProvider();
    await expect(provider.close()).resolves.toBeUndefined();
  });
});