/** Phase 8 §6.1.1 per-operation model parameter matrix (P8-R29, AP). */

import { describe, expect, it } from 'vitest';

import { MODEL_OPERATIONS, validateModelParams } from '../src/openclaw/contracts.ts';

describe('form_agent operation-parameter matrix', () => {
  it('accepts each operation only with its frozen fields', () => {
    expect(validateModelParams({ operation: 'analyze', target: 'demo-fixture' }).ok).toBe(true);
    expect(validateModelParams({ operation: 'draft', target: 'demo-fixture', draftProvider: 'reference' }).ok).toBe(true);
    expect(validateModelParams({ operation: 'draft_review', target: 'demo-fixture' }).ok).toBe(true);
    expect(validateModelParams({ operation: 'check', target: 'demo-fixture', draftProvider: 'reference' }).ok).toBe(true);
    expect(validateModelParams({ operation: 'preflight', target: 'demo-fixture', reviewAnswers: true }).ok).toBe(true);
    expect(validateModelParams({ operation: 'metrics', since: '2026-01-01T00:00:00Z' }).ok).toBe(true);
    expect(validateModelParams({ operation: 'cancel_pending' }).ok).toBe(true);
  });

  it('requires target where the matrix requires it', () => {
    expect(validateModelParams({ operation: 'analyze' }).ok).toBe(false);
    expect(validateModelParams({ operation: 'draft' }).ok).toBe(false);
    expect(validateModelParams({ operation: 'check' }).ok).toBe(false);
    expect(validateModelParams({ operation: 'preflight' }).ok).toBe(false);
  });

  it('treats a known-but-invalid field as usage_error (never ignored)', () => {
    expect(validateModelParams({ operation: 'analyze', draftProvider: 'reference' }).ok).toBe(false);
    expect(validateModelParams({ operation: 'analyze', since: '2026-01-01T00:00:00Z' }).ok).toBe(false);
    expect(validateModelParams({ operation: 'draft', reviewAnswers: true }).ok).toBe(false);
    expect(validateModelParams({ operation: 'metrics', target: 'demo-fixture' }).ok).toBe(false);
    expect(validateModelParams({ operation: 'cancel_pending', target: 'demo-fixture' }).ok).toBe(false);
  });

  it('rejects unknown fields and wrong types', () => {
    expect(validateModelParams({ operation: 'analyze', target: 'x', executable: '/bin/sh' }).ok).toBe(false);
    expect(validateModelParams({ operation: 'analyze', target: 'x', cwd: '/tmp' }).ok).toBe(false);
    expect(validateModelParams({ operation: 'analyze', target: 5 }).ok).toBe(false);
    expect(validateModelParams({ operation: 'preflight', target: 'x', reviewAnswers: 'yes' }).ok).toBe(false);
    expect(validateModelParams({ operation: 'metrics', since: 5 }).ok).toBe(false);
  });

  it('has no internal/operator operations in the model enum', () => {
    for (const internal of ['pending_status', 'submit_status', 'submit_ack', 'submit_pending', 'reconcile_unknown']) {
      expect(validateModelParams({ operation: internal }).ok).toBe(false);
      expect((MODEL_OPERATIONS as readonly string[]).includes(internal)).toBe(false);
    }
  });
});
