/**
 * SQLite migration catalog.
 *
 * Migrations are applied in order via the advisory-locked runner in
 * `database.ts`. Each migration body runs inside a transaction; the
 * schema_migrations table records applied ids.
 *
 * Phase 0 ships the structural foundation. Phases 1-8 add tables
 * (analysis_result, semantic_model, synthetic_profile, submissions,
 * llm_calls) via new migration entries — never by editing existing ones.
 */

export interface Migration {
  id: number;
  name: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'meta_applied_at',
    up: `
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    id: 2,
    name: 'forms_and_form_schema',
    up: `
      -- Single source of truth for a form's identity + structural fingerprint.
      CREATE TABLE IF NOT EXISTS forms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        form_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(form_id, provider_id)
      ) STRICT;

      -- The structural fingerprint is the cache key; schema_version bumps
      -- when the parser changes shape.
      CREATE TABLE IF NOT EXISTS form_schema (
        fingerprint_id TEXT PRIMARY KEY,
        form_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        generator_version TEXT NOT NULL,
        parsed_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (form_id, provider_id) REFERENCES forms(form_id, provider_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_form_schema_form ON form_schema(form_id, provider_id);
    `,
  },
  {
    id: 3,
    name: 'analysis_cache',
    up: `
      -- Structural analysis cache, keyed by fingerprint as designed.
      CREATE TABLE IF NOT EXISTS analysis_cache (
        fingerprint_id TEXT PRIMARY KEY,
        form_id TEXT NOT NULL,
        form_title TEXT,
        schema_json TEXT NOT NULL,
        plugin_meta_json TEXT,
        status TEXT NOT NULL DEFAULT 'done',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (fingerprint_id) REFERENCES form_schema(fingerprint_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_analysis_cache_form ON analysis_cache(form_id);
    `,
  },
  {
    id: 4,
    name: 'llm_calls',
    up: `
      -- Phase 3 depends on this table. Rows land once generation runs.
      CREATE TABLE IF NOT EXISTS llm_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        stage TEXT NOT NULL,
        cache_key TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        duration_ms INTEGER,
        finish_reason TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at);
    `,
  },
];

export function migrationMap(): Map<number, Migration> {
  return new Map(MIGRATIONS.map((m) => [m.id, m]));
}