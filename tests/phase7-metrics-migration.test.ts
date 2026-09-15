/**
 * Phase 7 migration-9 tests (P7-R4, P7-R7, docs/PHASE_7.md §7).
 *
 * Pins the exact frozen `metrics_events` shape, the 1–8 immutability boundary,
 * fresh-DB apply, upgrade-from-migration-8, reopen idempotence, and the SQL
 * CHECK boundary (the runtime validator adds the catalog rules on top).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FormAgentDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'form-agent-p7-mig-'));
}

function open(dir: string): FormAgentDatabase {
  return FormAgentDatabase.open({ directory: dir, filename: 'm.db' });
}

describe('P7-R4 — migration catalog boundary', () => {
  it('leaves migrations 1-8 unchanged and appends exactly migration 9', () => {
    expect(MIGRATIONS.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(MIGRATIONS[8]?.name).toBe('metrics_events');
    expect(MIGRATIONS.some((m) => m.id === 10)).toBe(false);
  });
});

describe('P7-R4 — frozen metrics_events schema', () => {
  it('creates the exact column set as a STRICT table with both indexes', () => {
    const app = open(makeDir());
    try {
      const columns = app.db
        .prepare("PRAGMA table_info('metrics_events')")
        .all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toEqual([
        'id',
        'event',
        'kind',
        'value_num',
        'value_text',
        'at_ms',
        'created_at',
      ]);

      const ddl = app.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'metrics_events'")
        .get() as { sql: string };
      expect(ddl.sql).toContain('STRICT');
      expect(ddl.sql).toContain("kind IN ('count','duration_ms','categorical')");

      const indexes = app.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'metrics_events'")
        .all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);
      expect(names).toContain('idx_metrics_events_at');
      expect(names).toContain('idx_metrics_events_event');
    } finally {
      app.close();
    }
  });

  it('rejects structurally malformed rows at the SQL CHECK boundary', () => {
    const app = open(makeDir());
    try {
      const insert = app.db.prepare(
        'INSERT INTO metrics_events (event, kind, value_num, value_text, at_ms) VALUES (?, ?, ?, ?, ?)',
      );
      // Unknown kind.
      expect(() => insert.run('command.analyze.duration', 'bogus', 1, null, 1)).toThrow();
      // Negative at_ms.
      expect(() => insert.run('command.analyze.duration', 'duration_ms', 1, null, -1)).toThrow();
      // Negative numeric value.
      expect(() => insert.run('consistency.hard_issues.count', 'count', -1, null, 1)).toThrow();
      // Categorical carrying a numeric value.
      expect(() => insert.run('consistency.status', 'categorical', 1, 'pass', 1)).toThrow();
      // Numeric kind carrying text.
      expect(() => insert.run('consistency.hard_issues.count', 'count', 1, 'pass', 1)).toThrow();
    } finally {
      app.close();
    }
  });
});

describe('P7-R4 — migration lifecycle', () => {
  it('applies the full catalog to a fresh DB and is reopen-idempotent', () => {
    const dir = makeDir();
    const first = open(dir);
    try {
      const applied = first.db
        .prepare('SELECT id, name FROM schema_migrations ORDER BY id')
        .all() as Array<{ id: number; name: string }>;
      expect(applied.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(applied[8]?.name).toBe('metrics_events');
    } finally {
      first.close();
    }

    const second = open(dir);
    try {
      const count = (
        second.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }
      ).n;
      expect(count).toBe(MIGRATIONS.length);
    } finally {
      second.close();
    }
  });

  it('applies migration 9 when upgrading from a migration-8 database', () => {
    const dir = makeDir();
    const first = open(dir);
    // Simulate a DB that stopped at migration 8.
    first.db.exec('DROP TABLE metrics_events');
    first.db.prepare('DELETE FROM schema_migrations WHERE id = 9').run();
    first.close();

    const upgraded = open(dir);
    try {
      const applied = upgraded.db
        .prepare('SELECT id FROM schema_migrations ORDER BY id')
        .all() as Array<{ id: number }>;
      expect(applied.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const table = upgraded.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metrics_events'")
        .all();
      expect(table).toHaveLength(1);
      const count = (
        upgraded.db.prepare('SELECT COUNT(*) AS n FROM metrics_events').get() as { n: number }
      ).n;
      expect(count).toBe(0);
    } finally {
      upgraded.close();
    }
  });
});
