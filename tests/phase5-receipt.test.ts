/**
 * Phase 5 receipt + migration 7 tests (P5-R17).
 *
 * Covers the durable receipt contract, the crash-safe submission claim
 * invariant, duplicate-claim rejection, and secret-safety of the receipt schema.
 */

import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../src/db/migrations.ts';
import { FormAgentDatabase } from '../src/db/database.ts';
import { ReceiptStore, submissionKeyFor, type ReceiptMetadata } from '../src/execution/receipt.ts';
import { ExecutionPreSubmitError } from '../src/execution/errors.ts';
import { EXECUTION_PRE_SUBMIT_CODES } from '../src/domain/execution.ts';
import { makeDatabase } from './support/phase5.ts';

function metadata(overrides: Partial<ReceiptMetadata> = {}): ReceiptMetadata {
  return {
    targetKey: 'fixture:exec-success',
    targetDisplay: 'exec-success',
    planId: 'a'.repeat(64),
    draftId: 'b'.repeat(64),
    consistencyReportId: 'c'.repeat(64),
    fingerprint: 'd'.repeat(64),
    providerId: 'fixture-execution',
    providerVersion: '1.0.0',
    ...overrides,
  };
}

describe('P5-R17 — migration 7', () => {
  it('appends migration 7 without changing migrations 1-6', () => {
    expect(MIGRATIONS.slice(0, 7).map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(MIGRATIONS.slice(0, 6).map((m) => m.name)).toEqual([
      'meta_applied_at',
      'forms_and_form_schema',
      'analysis_cache',
      'llm_calls',
      'authorizations',
      'rate_events',
    ]);
    expect(MIGRATIONS[6]?.name).toBe('execution_receipts');
  });

  it('applies to a fresh database and is idempotent on reopen', () => {
    const { database, dir, cleanup } = makeDatabase();
    try {
      const applied = database.db
        .prepare('SELECT id FROM schema_migrations WHERE id <= 7 ORDER BY id')
        .all() as Array<{ id: number }>;
      expect(applied.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);

      // Reopen the same database: no error, same applied set.
      const reopened = FormAgentDatabase.open({ directory: dir, filename: 'form-agent.db' });
      const after = reopened.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id <= 7').get() as { n: number };
      expect(after.n).toBe(7);
      reopened.close();
    } finally {
      cleanup();
    }
  });
});

describe('P5-R17 — receipt schema secret-safety', () => {
  it('receipt columns contain no answer/profile/secret fields', () => {
    const { database, cleanup } = makeDatabase();
    try {
      const cols = database.db.prepare('PRAGMA table_info(execution_receipts)').all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name).join('\n').toLowerCase();
      for (const forbidden of ['answer', 'profile', 'value', 'html', 'cookie', 'token', 'secret', 'regex', 'payload', 'credential']) {
        expect(names).not.toContain(forbidden);
      }
    } finally {
      cleanup();
    }
  });
});

describe('P5-R17 — crash-safe submission claim', () => {
  it('recordPreflight does not consume the submission key', () => {
    const { database, cleanup } = makeDatabase();
    try {
      const store = new ReceiptStore(database);
      const key = submissionKeyFor('fixture:exec-success', 'a'.repeat(64));
      const receipt = store.recordPreflight(key, metadata());
      expect(receipt.submitAttempted).toBe(false);
      expect(receipt.state).toBe('preflight');
      expect(store.findClaimedBySubmissionKey(key)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('claims once and rejects a duplicate claim', () => {
    const { database, cleanup } = makeDatabase();
    try {
      const store = new ReceiptStore(database);
      const key = submissionKeyFor('fixture:exec-success', 'a'.repeat(64));
      const claimed = store.claimSubmission(key, { ...metadata(), operator: 'op', approvalAt: '2026-01-01T00:00:00.000Z' });
      expect(claimed.submitAttempted).toBe(true);
      expect(claimed.state).toBe('submitting');

      expect(() =>
        store.claimSubmission(key, { ...metadata(), operator: 'op', approvalAt: '2026-01-01T00:00:00.000Z' }),
      ).toThrow(ExecutionPreSubmitError);

      try {
        store.claimSubmission(key, { ...metadata(), operator: 'op', approvalAt: '2026-01-01T00:00:00.000Z' });
      } catch (err) {
        expect((err as ExecutionPreSubmitError).code).toBe(EXECUTION_PRE_SUBMIT_CODES.SUBMISSION_ALREADY_CLAIMED);
      }
    } finally {
      cleanup();
    }
  });

  it('success and unknown_outcome both block a future claim for the same key', () => {
    const { database, cleanup } = makeDatabase();
    try {
      const store = new ReceiptStore(database);
      const key = submissionKeyFor('fixture:exec-success', 'a'.repeat(64));
      const claimed = store.claimSubmission(key, { ...metadata(), operator: 'op', approvalAt: '2026-01-01T00:00:00.000Z' });
      store.resolveOutcome(claimed.id, { state: 'success', outcome: 'success', outcomeCode: 'SUBMISSION_CONFIRMED' });
      expect(() =>
        store.claimSubmission(key, { ...metadata(), operator: 'op', approvalAt: '2026-01-01T00:00:00.000Z' }),
      ).toThrow(ExecutionPreSubmitError);
    } finally {
      cleanup();
    }
  });

  it('unknown_outcome also blocks a future claim for the same key', () => {
    const { database, cleanup } = makeDatabase();
    try {
      const store = new ReceiptStore(database);
      const key = submissionKeyFor('fixture:exec-success', 'b'.repeat(64));
      const claimed = store.claimSubmission(key, { ...metadata({ planId: 'b'.repeat(64) }), operator: 'op', approvalAt: '2026-01-01T00:00:00.000Z' });
      store.resolveOutcome(claimed.id, { state: 'unknown_outcome', outcome: 'unknown_outcome', outcomeCode: 'SUBMISSION_OUTCOME_UNKNOWN' });

      expect(() =>
        store.claimSubmission(key, { ...metadata({ planId: 'b'.repeat(64) }), operator: 'op', approvalAt: '2026-01-01T00:00:00.000Z' }),
      ).toThrow(ExecutionPreSubmitError);
    } finally {
      cleanup();
    }
  });

  it('an unresolved submitting claim survives reopen and blocks resubmit', () => {
    const { database, dir, cleanup } = makeDatabase();
    try {
      const key = submissionKeyFor('fixture:exec-success', 'a'.repeat(64));
      const store = new ReceiptStore(database);
      store.claimSubmission(key, { ...metadata(), operator: 'op', approvalAt: '2026-01-01T00:00:00.000Z' });
      database.close();

      const reopened = FormAgentDatabase.open({ directory: dir, filename: 'form-agent.db' });
      const store2 = new ReceiptStore(reopened);
      expect(store2.findClaimedBySubmissionKey(key)).not.toBeNull();
      expect(() =>
        store2.claimSubmission(key, { ...metadata(), operator: 'op', approvalAt: '2026-01-01T00:00:00.000Z' }),
      ).toThrow(ExecutionPreSubmitError);
      reopened.close();
    } finally {
      cleanup();
    }
  });

  it('a pre-submit failure (non-claimed) does not block a future valid claim', () => {
    const { database, cleanup } = makeDatabase();
    try {
      const store = new ReceiptStore(database);
      const key = submissionKeyFor('fixture:exec-success', 'a'.repeat(64));
      store.recordPreSubmitFailure(key, metadata(), 'failed_pre_submit', EXECUTION_PRE_SUBMIT_CODES.CONSISTENCY_BLOCKED);
      expect(store.findClaimedBySubmissionKey(key)).toBeNull();

      const claimed = store.claimSubmission(key, { ...metadata(), operator: 'op', approvalAt: '2026-01-01T00:00:00.000Z' });
      expect(claimed.submitAttempted).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('receipts persist no secret sentinels', () => {
    const { database, cleanup } = makeDatabase();
    try {
      const store = new ReceiptStore(database);
      const key = submissionKeyFor('fixture:exec-success', 'a'.repeat(64));
      const receipt = store.recordPreflight(key, metadata());
      const serialized = JSON.stringify(receipt);
      expect(serialized).not.toContain('VERY_SECRET_BROWSER_VALUE');
      expect(serialized).not.toContain('VERY_SECRET_TOKEN');
      expect(serialized).not.toContain('token=');
    } finally {
      cleanup();
    }
  });
});
