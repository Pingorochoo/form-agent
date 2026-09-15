/**
 * Phase 1 cache / persistence tests (P1-R14).
 *
 * The parsed schema is persisted keyed by the structural fingerprint through
 * the existing `forms` / `form_schema` / `analysis_cache` tables. A hit returns
 * the stored schema; a changed fingerprint is a miss and re-parses.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FormAgentDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { AnalysisStore } from '../src/analyze/store.ts';
import { analyzeForm } from '../src/analyze/analyze.ts';
import { FORMS_SCHEMA_VERSION } from '../src/domain/types.ts';
import { GOOGLE_FORMS_PARSER_VERSION } from '../src/parser/google-forms.ts';

const FIXTURE_HTML = readFileSync(
  new URL('../fixtures/archives/observed-responder.html', import.meta.url),
  'utf8',
);

function makeStore(): { db: FormAgentDatabase; store: AnalysisStore } {
  const dir = mkdtempSync(join(tmpdir(), 'form-agent-analyze-'));
  const db = FormAgentDatabase.open({ directory: dir, filename: 'analyze.db' });
  return { db, store: new AnalysisStore(db) };
}

describe('cache / persistence', () => {
  it('preserves accepted migrations 1-4 and appends the later migrations', () => {
    // Migrations 1-4 are the accepted Phase 0/1 catalog and must never be
    // edited. Phase 2 appends authorizations (5) and rate_events (6); Phase 5
    // appends execution_receipts (7); Phase 6 appends execution_plan_snapshots
    // (8); Phase 7 appends metrics_events (9).
    expect(MIGRATIONS.slice(0, 4).map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(MIGRATIONS.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('persists the schema into form_schema + analysis_cache keyed by fingerprint', () => {
    const { db, store } = makeStore();
    try {
      const { fingerprintId } = analyzeForm({ html: FIXTURE_HTML }, store);

      const row = db.db
        .prepare('SELECT fingerprint_id, generator_version, schema_version FROM form_schema WHERE fingerprint_id = ?')
        .get(fingerprintId) as { fingerprint_id: string; generator_version: string; schema_version: number };
      expect(row.fingerprint_id).toBe(fingerprintId);
      expect(row.generator_version).toBe(GOOGLE_FORMS_PARSER_VERSION);
      expect(row.schema_version).toBe(FORMS_SCHEMA_VERSION);

      const cache = db.db
        .prepare('SELECT fingerprint_id, form_title FROM analysis_cache WHERE fingerprint_id = ?')
        .get(fingerprintId) as { fingerprint_id: string; form_title: string | null };
      expect(cache.fingerprint_id).toBe(fingerprintId);
      expect(cache.form_title).toBe('Evaluación de experiencia y preferencias del estudiante');
    } finally {
      db.close();
    }
  });

  it('returns the stored schema on a fingerprint hit, with current-input metadata', () => {
    const { db, store } = makeStore();
    try {
      const first = analyzeForm({ html: FIXTURE_HTML, capturedAt: '2026-01-01T00:00:00.000Z' }, store);
      expect(first.cacheHit).toBe(false);

      const second = analyzeForm({ html: FIXTURE_HTML, capturedAt: '2026-02-02T00:00:00.000Z' }, store);
      expect(second.cacheHit).toBe(true);
      expect(second.fingerprintId).toBe(first.fingerprintId);
      // Structure is cached (identical checksum), but the current invocation's
      // capturedAt is preserved rather than the first parse's.
      expect(second.schema.meta.capturedAt).toBe('2026-02-02T00:00:00.000Z');
      expect(second.schema.checksum).toBe(first.schema.checksum);
      expect(second.schema.title).toBe(first.schema.title);
    } finally {
      db.close();
    }
  });

  it('produces a miss and re-parses when the fingerprint changes', () => {
    const { db, store } = makeStore();
    try {
      const first = analyzeForm({ html: FIXTURE_HTML }, store);
      expect(first.cacheHit).toBe(false);

      const changed = analyzeForm(
        { html: FIXTURE_HTML.replaceAll('Nombre o código del participante', 'Nombre cambiado') },
        store,
      );
      expect(changed.cacheHit).toBe(false);
      expect(changed.fingerprintId).not.toBe(first.fingerprintId);
    } finally {
      db.close();
    }
  });
});
