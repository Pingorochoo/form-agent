/**
 * SQLite migration + open/close tests.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FormAgentDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';

function makeDbDir(): string {
  return mkdtempSync(join(tmpdir(), 'form-agent-db-'));
}

describe('FormAgentDatabase', () => {
  it('applies the full migration catalog to a fresh database', () => {
    const dir = makeDbDir();
    const app = FormAgentDatabase.open({ directory: dir, filename: 'test.db' });
    try {
      const applied = app.db
        .prepare('SELECT id, name FROM schema_migrations ORDER BY id')
        .all() as Array<{ id: number; name: string }>;
      expect(applied.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
    } finally {
      app.close();
    }
  });

  it('is idempotent across reopen', () => {
    const dir = makeDbDir();
    const path = join(dir, 'idem.db');
    const first = FormAgentDatabase.open({ directory: dir, filename: 'idem.db' });
    first.close();
    const second = FormAgentDatabase.open({ directory: dir, filename: 'idem.db' });
    try {
      const count = (second.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n;
      expect(count).toBe(MIGRATIONS.length);
      expect(second.path).toBe(path);
    } finally {
      second.close();
    }
  });

  it('creates WAL files and the expected Phase 0 tables', () => {
    const dir = makeDbDir();
    const app = FormAgentDatabase.open({ directory: dir, filename: 'wal.db' });
    try {
      const pragma = app.db.pragma('journal_mode') as Array<{ journal_mode: string }>;
      expect(pragma[0]?.journal_mode).toBe('wal');
      const tables = (app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>)
        .map((r) => r.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          'schema_migrations',
          'meta',
          'forms',
          'form_schema',
          'analysis_cache',
          'llm_calls',
        ]),
      );
    } finally {
      app.close();
    }
  });

  it('llm_calls table accepts an insert (Phase 3 dependency is structural now)', () => {
    const dir = makeDbDir();
    const app = FormAgentDatabase.open({ directory: dir, filename: 'calls.db' });
    try {
      app.db
        .prepare(
          `INSERT INTO llm_calls (
            provider_id, model, stage, cache_key, input_tokens, output_tokens,
            total_tokens, duration_ms, finish_reason, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('fake', 'fake-0.1', 'analyze', 'fp-abc', 10, 20, 30, 1, 'stop', 'ok');
      const row = app.db.prepare('SELECT * FROM llm_calls LIMIT 1').get() as { stage: string; status: string };
      expect(row.stage).toBe('analyze');
      expect(row.status).toBe('ok');
    } finally {
      app.close();
    }
  });
});