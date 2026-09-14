/**
 * Persistence for structural analysis, keyed by the structural fingerprint.
 *
 * Writes go through the Phase 0 `forms` / `form_schema` / `analysis_cache`
 * tables (migrations 2 and 3). No new migration is required: the fingerprint
 * is the cache key already, and a parser/generator-version bump changes the
 * fingerprint, which naturally invalidates the cache.
 */

import { sha256Hex } from '../domain/fingerprint.ts';
import type { FormSchema } from '../domain/types.ts';
import type { FormAgentDatabase } from '../db/database.ts';

export class AnalysisStore {
  private readonly database: FormAgentDatabase;

  constructor(database: FormAgentDatabase) {
    this.database = database;
  }

  /** Return the persisted schema for a fingerprint, or null on a miss. */
  getSchemaByFingerprint(fingerprintId: string): FormSchema | null {
    const row = this.database.db
      .prepare('SELECT payload_json FROM form_schema WHERE fingerprint_id = ?')
      .get(fingerprintId) as { payload_json: string } | undefined;
    if (row === undefined) return null;
    try {
      return JSON.parse(row.payload_json) as FormSchema;
    } catch {
      return null;
    }
  }

  /** Persist a freshly parsed schema (forms + form_schema + analysis_cache). */
  saveSchema(schema: FormSchema, generatorVersion: string): void {
    const fingerprintId = schema.checksum;
    const payloadJson = JSON.stringify(schema);
    const hash = sha256Hex(payloadJson);
    const parsedAt = new Date().toISOString();

    const transaction = this.database.db.transaction(() => {
      this.database.db
        .prepare(
          `INSERT INTO forms (form_id, provider_id, url, title) VALUES (?, ?, ?, ?)
           ON CONFLICT(form_id, provider_id)
           DO UPDATE SET url = excluded.url, title = excluded.title,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        )
        .run(schema.formId, schema.providerId, schema.meta.url, schema.title);

      this.database.db
        .prepare(
          `INSERT INTO form_schema (
             fingerprint_id, form_id, provider_id, schema_version,
             generator_version, parsed_at, payload_json, hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(fingerprint_id) DO NOTHING`,
        )
        .run(
          fingerprintId,
          schema.formId,
          schema.providerId,
          schema.schemaVersion,
          generatorVersion,
          parsedAt,
          payloadJson,
          hash,
        );

      this.database.db
        .prepare(
          `INSERT INTO analysis_cache (
             fingerprint_id, form_id, form_title, schema_json, status
           ) VALUES (?, ?, ?, ?, 'done')
           ON CONFLICT(fingerprint_id) DO NOTHING`,
        )
        .run(fingerprintId, schema.formId, schema.title, payloadJson);
    });

    transaction();
  }
}
