/**
 * Durable authorization / allowlisting (P2-R3, P2-R4, P2-R5, P2-R6).
 *
 * Authorization only records that a canonical target is allowlisted for a
 * supported future execution scope. It performs no execution, no network
 * access, and no form submission.
 *
 * Deny-by-default: absence of an active matching authorization is a denied
 * state. Nothing here infers authorization from fixture presence, successful
 * parsing, local file location, cached schemas, or previous analysis.
 */

import type { FormAgentDatabase } from '../db/database.ts';
import type { CanonicalTarget } from './target.ts';

export const SUPPORTED_SCOPES = ['run'] as const;
export type SupportedScope = (typeof SUPPORTED_SCOPES)[number];

export function isSupportedScope(value: string): value is SupportedScope {
  return (SUPPORTED_SCOPES as readonly string[]).includes(value);
}

export type AuthorizationStatus = 'active' | 'revoked';

export type AuthorizationState =
  | 'authorized'
  | 'not-allowlisted'
  | 'revoked'
  | 'scope-unavailable';

export interface AuthorizationRecord {
  id: number;
  targetKey: string;
  targetDisplay: string;
  scope: string;
  operator: string;
  status: AuthorizationStatus;
  createdAt: string;
  revokedAt: string | null;
}

export interface AuthorizationCheckResult {
  state: AuthorizationState;
  /** Active record when `state === 'authorized'`, otherwise null. */
  record: AuthorizationRecord | null;
}

interface AuthorizationRow {
  id: number;
  target_key: string;
  target_display: string;
  scope: string;
  operator: string;
  status: string;
  created_at: string;
  revoked_at: string | null;
}

function toRecord(row: AuthorizationRow): AuthorizationRecord {
  return {
    id: row.id,
    targetKey: row.target_key,
    targetDisplay: row.target_display,
    scope: row.scope,
    operator: row.operator,
    status: row.status === 'revoked' ? 'revoked' : 'active',
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export class AuthorizationStore {
  private readonly database: FormAgentDatabase;

  constructor(database: FormAgentDatabase) {
    this.database = database;
  }

  /**
   * Idempotently allowlist a target for a scope. If an equivalent active
   * authorization already exists, it is returned unchanged (no duplicate
   * active record is created). Re-allow after revocation appends a new active
   * record while preserving the revoked history.
   */
  allow(target: CanonicalTarget, scope: SupportedScope, operator: string): AuthorizationRecord {
    if (operator.trim() === '') {
      throw new Error('authorization requires a non-empty operator (--by)');
    }
    const existing = this.activeRecord(target.key, scope);
    if (existing !== null) return existing;

    const result = this.database.db
      .prepare(
        `INSERT INTO authorizations (target_key, target_display, scope, operator, status)
         VALUES (?, ?, ?, ?, 'active')`,
      )
      .run(target.key, target.display, scope, operator);

    const row = this.database.db
      .prepare('SELECT * FROM authorizations WHERE id = ?')
      .get(result.lastInsertRowid) as AuthorizationRow | undefined;
    if (row === undefined) {
      throw new Error('authorization insert failed');
    }
    return toRecord(row);
  }

  /** Return the active record for a (target, scope), or null. */
  activeRecord(targetKey: string, scope: string): AuthorizationRecord | null {
    const row = this.database.db
      .prepare(
        `SELECT * FROM authorizations
         WHERE target_key = ? AND scope = ? AND status = 'active' LIMIT 1`,
      )
      .get(targetKey, scope) as AuthorizationRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Check authorization state for a target + scope, distinguishing authorized,
   * not-allowlisted, revoked, and scope-unavailable.
   */
  check(targetKey: string, scope: string): AuthorizationCheckResult {
    if (!isSupportedScope(scope)) {
      return { state: 'scope-unavailable', record: null };
    }
    const active = this.activeRecord(targetKey, scope);
    if (active !== null) {
      return { state: 'authorized', record: active };
    }
    const revoked = this.database.db
      .prepare(
        `SELECT COUNT(*) AS n FROM authorizations
         WHERE target_key = ? AND scope = ? AND status = 'revoked'`,
      )
      .get(targetKey, scope) as { n: number };
    if (revoked.n > 0) {
      return { state: 'revoked', record: null };
    }
    return { state: 'not-allowlisted', record: null };
  }

  /** All records (active + revoked), newest first, for audit output. */
  list(): AuthorizationRecord[] {
    const rows = this.database.db
      .prepare('SELECT * FROM authorizations ORDER BY id DESC')
      .all() as AuthorizationRow[];
    return rows.map(toRecord);
  }

  /**
   * Revoke the active authorization for a target + scope, if any. Idempotent:
   * returns the updated record or null when nothing was active.
   */
  revoke(targetKey: string, scope: string): AuthorizationRecord | null {
    if (!isSupportedScope(scope)) {
      throw new Error(`unsupported authorization scope: ${scope}`);
    }
    const active = this.activeRecord(targetKey, scope);
    if (active === null) return null;

    this.database.db
      .prepare(
        `UPDATE authorizations SET status = 'revoked',
           revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND status = 'active'`,
      )
      .run(active.id);

    const row = this.database.db
      .prepare('SELECT * FROM authorizations WHERE id = ?')
      .get(active.id) as AuthorizationRow | undefined;
    return row === undefined ? null : toRecord(row);
  }
}
