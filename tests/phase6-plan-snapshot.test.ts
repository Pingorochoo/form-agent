/**
 * Phase 6 migration 8 + execution-plan snapshot store tests
 * (P6-R14, R15, docs/PHASE_6.md §12/§13/§20).
 */

import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../src/db/migrations.ts';
import { FormAgentDatabase } from '../src/db/database.ts';
import { ExecutionPlanSnapshotStore, type ExecutionPlanSnapshotInput } from '../src/execution/snapshot.ts';
import { ExecutionPreSubmitError } from '../src/execution/errors.ts';
import { EXECUTION_SNAPSHOT_CODES } from '../src/domain/execution.ts';
import { serializeDraftBundle, parseDraftBundleJson } from '../src/draft/serialize.ts';
import { generateDraft } from '../src/draft/orchestrate.ts';
import { DeterministicReferenceProvider } from '../src/draft/reference.ts';
import { BUILTIN_SENSITIVE_RULES } from '../src/policy/sensitive.ts';
import { textQuestion } from './support/sample-schema.ts';
import type { FormSchema } from '../src/domain/types.ts';
import { sha256Hex } from '../src/domain/fingerprint.ts';
import { makeDatabase } from './support/phase5.ts';

/** A minimal non-sensitive schema whose single text question is draftable. */
function makeTextSchema(): FormSchema {
  const question = textQuestion('q-color', 0, 'Favorite color');
  const sectionId = '__default__';
  return {
    providerId: 'google-forms',
    formId: 'text-form',
    checksum: sha256Hex('q-color:text:Favorite color'),
    schemaVersion: 2,
    meta: {
      url: 'https://fixtures.local/forms/text-form',
      title: 'Text form',
      capturedAt: '2026-01-01T00:00:00.000Z',
      source: 'fixture',
      requiresSignIn: false,
    },
    title: 'Text form',
    parts: [question],
    definitional: [],
    questions: { 'q-color': question },
    sections: [
      { id: sectionId, slot: 0, index: 0, title: '', questionIds: ['q-color'], routing: { default: 'submit', conditional: false, rules: [] } },
    ],
    questionSection: { 'q-color': sectionId },
    nonQuestionContent: [],
    hasRouting: false,
    terminalSectionIds: [sectionId],
    rowCount: 1,
    fieldCount: 1,
    answerModel: 'flat',
  };
}

function snapshotInput(planId: string, bundleJson: string, overrides: Partial<ExecutionPlanSnapshotInput> = {}): ExecutionPlanSnapshotInput {
  return {
    planId,
    targetKey: 'fixture:exec-success',
    fingerprint: 'e'.repeat(64),
    draftId: 'b'.repeat(64),
    consistencyReportId: 'c'.repeat(64),
    draftProviderId: 'deterministic-reference',
    draftProviderVersion: '1.0.0',
    modelOrProviderLabel: null,
    promptContractVersions: '',
    endpointHash: null,
    provenanceHash: 'p'.repeat(64),
    bundleJson,
    bundleSha256: 'd'.repeat(64),
    ...overrides,
  };
}

describe('P6-R14 — migration 8', () => {
  it('appends migration 8 without changing migrations 1-7', () => {
    expect(MIGRATIONS.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(MIGRATIONS[7]?.name).toBe('execution_plan_snapshots');
    // Migrations 1-7 names are unchanged.
    expect(MIGRATIONS.slice(0, 7).map((m) => m.name)).toEqual([
      'meta_applied_at',
      'forms_and_form_schema',
      'analysis_cache',
      'llm_calls',
      'authorizations',
      'rate_events',
      'execution_receipts',
    ]);
  });

  it('applies to a fresh database and is idempotent on reopen', () => {
    const { database, dir, cleanup } = makeDatabase();
    try {
      const applied = database.db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: number }>;
      expect(applied.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

      const reopened = FormAgentDatabase.open({ directory: dir, filename: 'form-agent.db' });
      const after = reopened.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
      expect(after.n).toBe(8);
      reopened.close();
    } finally {
      cleanup();
    }
  });

  it('snapshot columns are secret-safe (no raw prompt/response/key fields)', () => {
    const { database, cleanup } = makeDatabase();
    try {
      const cols = database.db.prepare('PRAGMA table_info(execution_plan_snapshots)').all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name).join('\n').toLowerCase();
      // Raw prompt/response content columns are forbidden; `prompt_contract_versions`
      // is safe (version strings only, never raw prompt text).
      for (const forbidden of [
        'raw_prompt',
        'prompt_text',
        'prompt_body',
        'prompt_content',
        'raw_response',
        'response_text',
        'response_body',
        'response_content',
        'api_key',
        'token',
        'authorization',
        'cookie',
        'html',
        'receipt',
        'secret',
        'credential',
      ]) {
        expect(names).not.toContain(forbidden);
      }
    } finally {
      cleanup();
    }
  });
});

describe('P6-R15 — snapshot store', () => {
  it('saves and loads a snapshot round-trip', () => {
    const { database, cleanup } = makeDatabase();
    try {
      const store = new ExecutionPlanSnapshotStore(database);
      store.save(snapshotInput('a'.repeat(64), '{"synthetic":true}'));
      const loaded = store.load('a'.repeat(64));
      expect(loaded).not.toBeNull();
      expect(loaded?.planId).toBe('a'.repeat(64));
      expect(loaded?.bundleJson).toBe('{"synthetic":true}');
    } finally {
      cleanup();
    }
  });

  it('re-saving identical content for the same plan id is idempotent', () => {
    const { database, cleanup } = makeDatabase();
    try {
      const store = new ExecutionPlanSnapshotStore(database);
      const input = snapshotInput('a'.repeat(64), '{"synthetic":true}');
      store.save(input);
      expect(() => store.save(input)).not.toThrow();
      expect(store.load('a'.repeat(64))).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('conflicting content for the same plan id fails closed', () => {
    const { database, cleanup } = makeDatabase();
    try {
      const store = new ExecutionPlanSnapshotStore(database);
      store.save(snapshotInput('a'.repeat(64), '{"synthetic":true}'));
      expect(() => store.save(snapshotInput('a'.repeat(64), '{"synthetic":false}'))).toThrow(ExecutionPreSubmitError);
      try {
        store.save(snapshotInput('a'.repeat(64), '{"synthetic":false}'));
      } catch (err) {
        expect((err as ExecutionPreSubmitError).code).toBe(EXECUTION_SNAPSHOT_CODES.CONFLICT);
      }
    } finally {
      cleanup();
    }
  });

  it('load returns null for a missing plan id', () => {
    const { database, cleanup } = makeDatabase();
    try {
      const store = new ExecutionPlanSnapshotStore(database);
      expect(store.load('f'.repeat(64))).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe('P6-R13 — DraftBundle serialization round-trip + corruption', () => {
  async function bundleJson(): Promise<string> {
    const schema = makeTextSchema();
    const bundle = await generateDraft({ schema, seed: 'seed-1', provider: new DeterministicReferenceProvider(), sensitiveRules: BUILTIN_SENSITIVE_RULES });
    return serializeDraftBundle(bundle);
  }

  it('round-trips a real reference bundle and validates it', async () => {
    const schema = makeTextSchema();
    const json = await bundleJson();
    const parsed = parseDraftBundleJson(json, schema);
    expect(parsed.synthetic).toBe(true);
    expect(parsed.results.length).toBe(schema.parts.length);
  });

  it('corrupt JSON fails closed', () => {
    const schema = makeTextSchema();
    expect(() => parseDraftBundleJson('not json', schema)).toThrow();
    expect(() => parseDraftBundleJson('{"synthetic":true}', schema)).toThrow();
    expect(() => parseDraftBundleJson('null', schema)).toThrow();
  });

  it('a tampered answered value fails closed', async () => {
    const schema = makeTextSchema();
    const json = await bundleJson();
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const results = parsed['results'] as Array<Record<string, unknown>>;
    const answered = results.find((r) => (r['state'] as Record<string, unknown>)['state'] === 'answered');
    expect(answered).toBeDefined();
    (answered?.['state'] as Record<string, unknown>)['value'] = { kind: 'text', value: '' };
    expect(() => parseDraftBundleJson(JSON.stringify(parsed), schema)).toThrow();
  });

  it('a tampered summary (counts/complete) fails closed', async () => {
    const schema = makeTextSchema();
    const json = await bundleJson();

    // Altering the answered count must fail (recomputed summary disagrees).
    const withCount = JSON.parse(json) as Record<string, unknown>;
    const summary = withCount['summary'] as Record<string, unknown>;
    summary['answered'] = Number(summary['answered']) + 1;
    expect(() => parseDraftBundleJson(JSON.stringify(withCount), schema)).toThrow();

    // Altering the complete flag must fail.
    const withComplete = JSON.parse(json) as Record<string, unknown>;
    (withComplete['summary'] as Record<string, unknown>)['complete'] = false;
    expect(() => parseDraftBundleJson(JSON.stringify(withComplete), schema)).toThrow();
  });
});
