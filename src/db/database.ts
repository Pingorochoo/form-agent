/**
 * better-sqlite3 connection, WAL, migration runner.
 *
 * Options:
 *   - WAL journal mode + synchronous NORMAL for the single-operator sequential
 *     submit path.
 *   - Foreign keys ON.
 *   - Idempotent migrations: `schema_migrations` tracks applied ids; a fresh
 *     database applies the full catalog inside a transaction.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { MIGRATIONS } from './migrations.ts';

export interface DatabaseOptions {
  /** Directory to place the .db file (created if needed). */
  directory: string;
  filename: string;
}

const SCHEMA_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT;
`;

export class FormAgentDatabase {
  readonly db: Database.Database;
  readonly path: string;

  private constructor(db: Database.Database, path: string) {
    this.db = db;
    this.path = path;
  }

  static open(options: DatabaseOptions): FormAgentDatabase {
    mkdirSync(options.directory, { recursive: true });
    const path = join(options.directory, options.filename);

    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    db.exec(SCHEMA_MIGRATIONS_DDL);
    const app = new FormAgentDatabase(db, path);
    app.migrate();
    return app;
  }

  migrate(): void {
    const applied = new Set(
      (this.db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: number }>).map((r) => r.id),
    );
    const pending = MIGRATIONS.filter((m) => !applied.has(m.id));
    if (pending.length === 0) return;

    const run = this.db.transaction(() => {
      for (const migration of pending) {
        this.db.exec(migration.up);
        this.db
          .prepare('INSERT OR REPLACE INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.id, migration.name, new Date().toISOString());
      }
    });
    run();
  }

  close(): void {
    this.db.close();
  }
}