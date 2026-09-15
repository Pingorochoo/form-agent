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
  {
    id: 5,
    name: 'authorizations',
    up: `
      -- Durable, auditable authorization records (Phase 2). Revocation flips
      -- the status column to 'revoked' instead of deleting the row, preserving
      -- history. The partial unique index enforces at most one ACTIVE record
      -- per (target_key, scope) so repeated allows stay idempotent.
      CREATE TABLE IF NOT EXISTS authorizations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_key TEXT NOT NULL,
        target_display TEXT NOT NULL,
        scope TEXT NOT NULL,
        operator TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        revoked_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_authorizations_target ON authorizations(target_key, scope);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_authorizations_active_unique
        ON authorizations(target_key, scope) WHERE status = 'active';
    `,
  },
  {
    id: 6,
    name: 'rate_events',
    up: `
      -- Durable rate-policy event log (Phase 2). Counters are derived from
      -- this log so caps and delays survive process restarts. No executor or
      -- scheduler writes here; only deterministic rate gate decisions do.
      CREATE TABLE IF NOT EXISTS rate_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_rate_events_target_kind ON rate_events(target_key, kind, at_ms);
    `,
  },
  {
    id: 7,
    name: 'execution_receipts',
    up: `
      -- Durable execution receipt / crash-safe submission claim (Phase 5).
      --
      -- Never stores answer values, profile values, blocked sensitive values,
      -- page HTML, cookies/storage, tokens, raw exceptions, URL query/userinfo,
      -- or sensitive-policy regex bodies. Only sanitized provenance + stable
      -- state/outcome codes.
      --
      -- The partial unique index enforces AT MOST ONE claimed
      -- (submit_attempted = 1) receipt per submission_key, which is the
      -- duplicate-submit prevention invariant. A crash after claim leaves a
      -- durable 'submitting' row that blocks automatic resubmit after reopen.
      CREATE TABLE IF NOT EXISTS execution_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        submission_key TEXT NOT NULL,
        target_key TEXT NOT NULL,
        target_display TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        draft_id TEXT NOT NULL,
        consistency_report_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        provider_version TEXT NOT NULL,
        operator TEXT,
        approval_at TEXT,
        state TEXT NOT NULL,
        submit_attempted INTEGER NOT NULL DEFAULT 0,
        outcome TEXT,
        outcome_code TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_execution_receipts_key ON execution_receipts(submission_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_receipts_claimed
        ON execution_receipts(submission_key) WHERE submit_attempted = 1;
    `,
  },
  {
    id: 8,
    name: 'execution_plan_snapshots',
    up: `
      -- Durable approved execution-plan snapshot (Phase 6).
      --
      -- Persists the EXACT validated synthetic DraftBundle used by preflight so
      -- submit reuses the operator-approved values without re-calling a real
      -- (nondeterministic) LLM. plan_id is the PRIMARY KEY and is
      -- content/provenance-derived, so a conflicting second write for the same
      -- plan id is a corruption/programming error (enforced by the store).
      --
      -- bundle_sha256 is a SHA-256 digest over the exact canonical serialized
      -- bundle (bundle_json): any byte/semantic change to a persisted answer or
      -- profile fails closed before fill. provenance_hash is a content-bound
      -- hash over the safe provider provenance columns below, so tampering with
      -- provider provenance cannot silently preserve an approved snapshot.
      --
      -- Never stores: API keys, Authorization headers, cookies/browser storage,
      -- raw HTML, raw LLM prompt/response, raw provider exceptions, or URL
      -- userinfo/query secrets. This is NOT the execution receipt table.
      CREATE TABLE IF NOT EXISTS execution_plan_snapshots (
        plan_id TEXT PRIMARY KEY,
        target_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        draft_id TEXT NOT NULL,
        consistency_report_id TEXT NOT NULL,
        draft_provider_id TEXT NOT NULL,
        draft_provider_version TEXT NOT NULL,
        model_or_provider_label TEXT,
        prompt_contract_versions TEXT NOT NULL DEFAULT '',
        endpoint_hash TEXT,
        provenance_hash TEXT NOT NULL,
        bundle_json TEXT NOT NULL,
        bundle_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_execution_plan_snapshots_target
        ON execution_plan_snapshots(target_key);
    `,
  },
  {
    id: 9,
    name: 'metrics_events',
    up: `
      -- Append-only, narrowly scoped operational metric-event store (Phase 7).
      --
      -- Stores ONLY the bounded Phase 7 metric catalog: a fixed event name, a
      -- fixed kind, a numeric value for count/duration_ms OR a bounded
      -- categorical value, and a normalized wall-clock event time. There is no
      -- free-form attributes/dimension map and no raw/unbounded text: the
      -- runtime validator rejects any event outside the closed catalog by
      -- construction. Never stores answers, profile values, question/choice
      -- text, HTML, prompts/responses, credentials, cookies, or raw exceptions.
      --
      -- Execution/Llm dimensions are derived read-only from the authoritative
      -- execution_receipts / llm_calls tables; they are deliberately NOT
      -- duplicated here. This table is never part of any authoritative
      -- receipt/claim transaction.
      CREATE TABLE IF NOT EXISTS metrics_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        kind TEXT NOT NULL,
        value_num REAL,
        value_text TEXT,
        at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK (kind IN ('count','duration_ms','categorical')),
        CHECK (at_ms >= 0),
        CHECK (value_num IS NULL OR value_num >= 0),
        CHECK (
          (kind = 'categorical' AND value_text IS NOT NULL AND value_num IS NULL) OR
          (kind IN ('count','duration_ms') AND value_num IS NOT NULL AND value_text IS NULL)
        )
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_metrics_events_at ON metrics_events(at_ms);
      CREATE INDEX IF NOT EXISTS idx_metrics_events_event ON metrics_events(event, at_ms);
    `,
  },
];

export function migrationMap(): Map<number, Migration> {
  return new Map(MIGRATIONS.map((m) => [m.id, m]));
}