/**
 * Phase 2 authorization tests (P2-R3, P2-R4, P2-R5, P2-R6).
 *
 * Durable, auditable, idempotent allowlisting with deny-by-default semantics.
 * All checks are local-only (no network, no execution).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FormAgentDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { AuthorizationStore, isSupportedScope } from '../src/policy/authz.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';

const DIRS: string[] = [];

function makeDb(): FormAgentDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'form-agent-auth-'));
  DIRS.push(dir);
  return FormAgentDatabase.open({ directory: dir, filename: 'auth.db' });
}

afterEach(() => {
  // Directory cleanup is best-effort; better-sqlite3 closes cleanly per-test.
  DIRS.length = 0;
});

describe('migration catalog', () => {
  it('adds the authorizations migration without editing earlier ones', () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6]);
    const authz = MIGRATIONS.find((m) => m.id === 5);
    expect(authz?.name).toBe('authorizations');
    expect(authz?.up).toContain('CREATE TABLE IF NOT EXISTS authorizations');
  });
});

describe('AuthorizationStore — allow / check / revoke / list', () => {
  it('allow is idempotent: a repeated allow creates no duplicate active record', () => {
    const db = makeDb();
    const store = new AuthorizationStore(db);
    const target = canonicalizeTarget('https://fixtures.local/forms/demo');

    const first = store.allow(target, 'run', 'op-1');
    const second = store.allow(target, 'run', 'op-1');

    expect(first.id).toBe(second.id);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.status).toBe('active');
    db.close();
  });

  it('requires a non-empty operator', () => {
    const db = makeDb();
    const store = new AuthorizationStore(db);
    const target = canonicalizeTarget('https://fixtures.local/forms/demo');
    expect(() => store.allow(target, 'run', '   ')).toThrow(/non-empty operator/);
    db.close();
  });

  it('check distinguishes authorized, not-allowlisted, revoked, and scope-unavailable', () => {
    const db = makeDb();
    const store = new AuthorizationStore(db);
    const target = canonicalizeTarget('https://fixtures.local/forms/demo');

    expect(store.check(target.key, 'run').state).toBe('not-allowlisted');

    store.allow(target, 'run', 'op-1');
    expect(store.check(target.key, 'run').state).toBe('authorized');

    expect(store.check(target.key, 'delete').state).toBe('scope-unavailable');

    store.revoke(target.key, 'run');
    expect(store.check(target.key, 'run').state).toBe('revoked');
    db.close();
  });

  it('revocation preserves history and re-allow appends a new active record', () => {
    const db = makeDb();
    const store = new AuthorizationStore(db);
    const target = canonicalizeTarget('https://fixtures.local/forms/demo');

    store.allow(target, 'run', 'op-1');
    store.revoke(target.key, 'run');

    // History preserved: one revoked record.
    const afterRevoke = store.list();
    expect(afterRevoke).toHaveLength(1);
    expect(afterRevoke[0]?.status).toBe('revoked');
    expect(afterRevoke[0]?.revokedAt).not.toBeNull();

    // Re-allow after revoke: new active record, history intact.
    const reallowed = store.allow(target, 'run', 'op-2');
    expect(reallowed.status).toBe('active');
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list.filter((r) => r.status === 'active')).toHaveLength(1);
    expect(list.filter((r) => r.status === 'revoked')).toHaveLength(1);
    db.close();
  });

  it('revoking an unknown target is a no-op returning null', () => {
    const db = makeDb();
    const store = new AuthorizationStore(db);
    const target = canonicalizeTarget('https://fixtures.local/forms/missing');
    expect(store.revoke(target.key, 'run')).toBeNull();
    db.close();
  });
});

describe('durability and deny-by-default (P2-R6)', () => {
  it('authorization survives a database reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-auth-reopen-'));
    const target = canonicalizeTarget('https://fixtures.local/forms/demo');

    const first = FormAgentDatabase.open({ directory: dir, filename: 'reopen.db' });
    new AuthorizationStore(first).allow(target, 'run', 'op-1');
    first.close();

    const second = FormAgentDatabase.open({ directory: dir, filename: 'reopen.db' });
    try {
      const store = new AuthorizationStore(second);
      expect(store.check(target.key, 'run').state).toBe('authorized');
    } finally {
      second.close();
    }
  });

  it('absence of an active matching authorization is denied (deny by default)', () => {
    const db = makeDb();
    const store = new AuthorizationStore(db);
    const target = canonicalizeTarget('https://fixtures.local/forms/never-allowed');
    // No fixture presence, parse, cache, or file location implies authorization.
    expect(store.check(target.key, 'run').state).toBe('not-allowlisted');
    expect(store.activeRecord(target.key, 'run')).toBeNull();
    db.close();
  });

  it('a revoked authorization denies even though history exists', () => {
    const db = makeDb();
    const store = new AuthorizationStore(db);
    const target = canonicalizeTarget('https://fixtures.local/forms/demo');
    store.allow(target, 'run', 'op-1');
    store.revoke(target.key, 'run');
    expect(store.check(target.key, 'run').state).toBe('revoked');
    expect(store.activeRecord(target.key, 'run')).toBeNull();
    db.close();
  });
});

describe('authorization records never expose secrets (P2-R19)', () => {
  it('records contain only audit metadata (no secret keys)', () => {
    const db = makeDb();
    const store = new AuthorizationStore(db);
    const target = canonicalizeTarget('https://fixtures.local/forms/demo');
    store.allow(target, 'run', 'auditor');

    const record = store.list()[0];
    expect(record).not.toBeUndefined();
    for (const key of Object.keys(record as object)) {
      expect(['password', 'secret', 'token', 'apikey', 'api_key', 'answer']).not.toContain(key.toLowerCase());
    }
    expect(record?.operator).toBe('auditor');
    expect(record?.targetKey).toBe('fixture:demo');
    db.close();
  });

  it('supports only the run scope', () => {
    expect(isSupportedScope('run')).toBe(true);
    expect(isSupportedScope('delete')).toBe(false);
    expect(isSupportedScope('')).toBe(false);
  });

  it('persists a sanitized canonical display (no query/userinfo/fragment secrets)', () => {
    const db = makeDb();
    const store = new AuthorizationStore(db);
    const target = canonicalizeTarget('https://user:secret@example.com/path?token=VERY_SECRET_VALUE#frag');
    const record = store.allow(target, 'run', 'auditor');
    expect(record.targetDisplay).toBe('https://example.com/path');
    expect(record.targetKey).toBe('url:https://example.com/path');
    expect(record.targetDisplay).not.toContain('VERY_SECRET_VALUE');
    expect(record.targetDisplay).not.toContain('secret');
    expect(record.targetKey).not.toContain('VERY_SECRET_VALUE');
    db.close();
  });
});
