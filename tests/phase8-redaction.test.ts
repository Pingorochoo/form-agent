/**
 * Phase 8 output privacy / redaction (P8-R15, §13).
 *
 * Default operator/adapter envelopes never carry answer values, raw HTML,
 * secrets, provider payloads, or internal DB paths. Only the explicit review
 * paths transmit eligible answered values, and only to the trusted human.
 */

import { describe, expect, it } from 'vitest';

import { categoryMessage, PREFLIGHT_READY_MESSAGE } from '../src/openclaw/format.ts';
import { analyzeDoc, checkDoc, draftDoc, exitResult, makeAdapter, submitSuccessDoc } from './support/phase8.ts';
import { PRINCIPAL, getPreflightPending, preflightEnvelope } from './support/phase8-preflight.ts';
import { submitParams } from './support/phase8.ts';

const ANSWER_SENTINEL = 'SECRET_ANSWER_SENTINEL_4417';
const HTML_SENTINEL = '<script>alert("raw-html-sentinel")</script>';

function withSentinels(doc: string): string {
  const parsed = JSON.parse(doc) as Record<string, unknown>;
  parsed['rawHtml'] = HTML_SENTINEL;
  parsed['bundle_json'] = HTML_SENTINEL;
  return JSON.stringify(parsed);
}

describe('default operations', () => {
  it('analyze emits no raw HTML / bundle_json sentinel', async () => {
    const fixture = makeAdapter();
    fixture.runner.enqueue(exitResult(0, withSentinels(analyzeDoc())));
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'analyze', target: 'demo-fixture' });
    expect(envelope.category).toBe('ok_analyze');
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('raw-html-sentinel');
    expect(serialized).not.toContain('bundle_json');
    fixture.cleanup();
  });

  it('check emits bounded structural fields only', async () => {
    const fixture = makeAdapter();
    fixture.runner.enqueue(exitResult(0, withSentinels(checkDoc())));
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'check', target: 'demo-fixture' });
    expect(envelope.category).toBe('ok_check');
    expect(JSON.stringify(envelope)).not.toContain('raw-html-sentinel');
    expect(Object.keys(envelope.data).sort()).toEqual(
      ['fingerprint', 'formTitle', 'hardIssues', 'issueCodes', 'reportId', 'softIssues', 'status'].sort(),
    );
    fixture.cleanup();
  });

  it('plain draft emits summary metadata only (no draftAnswers/values)', async () => {
    const fixture = makeAdapter();
    fixture.runner.enqueue(exitResult(0, draftDoc()));
    const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'draft', target: 'demo-fixture' });
    expect(envelope.data).not.toHaveProperty('draftAnswers');
    expect(JSON.stringify(envelope)).not.toContain('hello');
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    expect(pending).toBeNull();
    fixture.cleanup();
  });

  it('a successful submit result carries no answer values', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, PRINCIPAL);
    if (pending === null) throw new Error('expected a pending record');
    fixture.runner.enqueue(exitResult(0, submitSuccessDoc(pending.planId)));
    const envelope = await fixture.adapter.execute(PRINCIPAL, submitParams(pending));
    expect(JSON.stringify(envelope)).not.toContain('hello');
    fixture.cleanup();
  });
});

describe('format helpers', () => {
  it('status messages are fixed and contain no untrusted interpolation', () => {
    expect(categoryMessage('needs_confirmation')).toBe(PREFLIGHT_READY_MESSAGE);
    expect(PREFLIGHT_READY_MESSAGE).toContain('No fill or submission occurred.');
    expect(categoryMessage('unknown_outcome')).toContain('Manual reconciliation is required.');
    for (const message of [categoryMessage('needs_confirmation'), categoryMessage('ok_submit_success')]) {
      expect(message).not.toContain(ANSWER_SENTINEL);
      expect(message).not.toContain('<script>');
    }
  });

  it('preflight formTitle is null rather than scraped from human output', async () => {
    const fixture = await preflightEnvelope();
    expect(fixture.envelope['data']).toMatchObject({ formTitle: null });
    fixture.cleanup();
  });
});

describe('provider env values are never exposed', () => {
  it('forwards the value to the child but never into the envelope', async () => {
    const secretName = 'P8_SECRET_SENTINEL';
    process.env[secretName] = ANSWER_SENTINEL;
    try {
      const fixture = makeAdapter({ config: { providerEnvNames: [secretName] } });
      fixture.runner.enqueue(exitResult(0, analyzeDoc()));
      const envelope = await fixture.adapter.execute(PRINCIPAL, { operation: 'analyze', target: 'demo-fixture' });
      expect(fixture.runner.calls[0]?.env[secretName]).toBe(ANSWER_SENTINEL);
      expect(JSON.stringify(envelope)).not.toContain(ANSWER_SENTINEL);
      fixture.cleanup();
    } finally {
      delete process.env[secretName];
    }
  });
});
