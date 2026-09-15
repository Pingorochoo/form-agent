/**
 * Durable execution receipt + crash-safe submission claim (P5-R17).
 *
 * Wraps migration 7's `execution_receipts` table. The store persists only
 * sanitized provenance + stable state/outcome codes — never answer values,
 * profile values, blocked sensitive values, HTML, cookies/tokens, raw
 * exceptions, URL query/userinfo, or sensitive-policy regex bodies.
 *
 * The crash-safe claim invariant (P5-R16/P5-R17):
 *   - a receipt row is created for preflight and pre-submit failures with
 *     `submit_attempted = 0` (never consumes the submission key);
 *   - immediately before the single submit action, `claimSubmission` atomically
 *     inserts a `submit_attempted = 1` row (state `submitting`) — a second claim
 *     for the same submission key fails;
 *   - a persisted `submitting` row survives reopen and blocks automatic resubmit.
 */

import type { FormAgentDatabase } from '../db/database.ts';
import { sha256Hex } from '../domain/fingerprint.ts';
import type { ExecutionOutcome, ExecutionReceiptState } from '../domain/execution.ts';
import { ExecutionPreSubmitError } from './errors.ts';
import { EXECUTION_PRE_SUBMIT_CODES } from '../domain/execution.ts';

/** Derive a stable, opaque submission key from canonical target + planId. */
export function submissionKeyFor(targetKey: string, planId: string): string {
  return sha256Hex([targetKey, planId].join('\u0000'));
}

export interface ExecutionReceipt {
  id: number;
  submissionKey: string;
  targetKey: string;
  targetDisplay: string;
  planId: string;
  draftId: string;
  consistencyReportId: string;
  fingerprint: string;
  providerId: string;
  providerVersion: string;
  operator: string | null;
  approvalAt: string | null;
  state: ExecutionReceiptState;
  submitAttempted: boolean;
  outcome: ExecutionOutcome | null;
  outcomeCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReceiptMetadata {
  targetKey: string;
  targetDisplay: string;
  planId: string;
  draftId: string;
  consistencyReportId: string;
  fingerprint: string;
  providerId: string;
  providerVersion: string;
}

export interface SubmissionClaim extends ReceiptMetadata {
  operator: string;
  approvalAt: string;
  /** Runs inside the claim transaction (used to record the rate event). */
  onClaimed?: () => void;
}

interface ReceiptRow {
  id: number;
  submission_key: string;
  target_key: string;
  target_display: string;
  plan_id: string;
  draft_id: string;
  consistency_report_id: string;
  fingerprint: string;
  provider_id: string;
  provider_version: string;
  operator: string | null;
  approval_at: string | null;
  state: string;
  submit_attempted: number;
  outcome: string | null;
  outcome_code: string | null;
  created_at: string;
  updated_at: string;
}

function toReceipt(row: ReceiptRow): ExecutionReceipt {
  return {
    id: row.id,
    submissionKey: row.submission_key,
    targetKey: row.target_key,
    targetDisplay: row.target_display,
    planId: row.plan_id,
    draftId: row.draft_id,
    consistencyReportId: row.consistency_report_id,
    fingerprint: row.fingerprint,
    providerId: row.provider_id,
    providerVersion: row.provider_version,
    operator: row.operator,
    approvalAt: row.approval_at,
    state: row.state as ExecutionReceiptState,
    submitAttempted: row.submit_attempted === 1,
    outcome: (row.outcome as ExecutionOutcome | null) ?? null,
    outcomeCode: row.outcome_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ReceiptStore {
  private readonly database: FormAgentDatabase;

  constructor(database: FormAgentDatabase) {
    this.database = database;
  }

  findById(id: number): ExecutionReceipt | null {
    const row = this.database.db
      .prepare('SELECT * FROM execution_receipts WHERE id = ?')
      .get(id) as ReceiptRow | undefined;
    return row === undefined ? null : toReceipt(row);
  }

  /** The claimed (submit_attempted = 1) receipt for a key, or null. */
  findClaimedBySubmissionKey(submissionKey: string): ExecutionReceipt | null {
    const row = this.database.db
      .prepare(
        'SELECT * FROM execution_receipts WHERE submission_key = ? AND submit_attempted = 1 ORDER BY id DESC LIMIT 1',
      )
      .get(submissionKey) as ReceiptRow | undefined;
    return row === undefined ? null : toReceipt(row);
  }

  /** Latest receipt (claimed or not) for a key, or null. */
  findLatestBySubmissionKey(submissionKey: string): ExecutionReceipt | null {
    const row = this.database.db
      .prepare('SELECT * FROM execution_receipts WHERE submission_key = ? ORDER BY id DESC LIMIT 1')
      .get(submissionKey) as ReceiptRow | undefined;
    return row === undefined ? null : toReceipt(row);
  }

  /**
   * Persist a non-claimed receipt (preflight or a pre-submit failure).
   * `submit_attempted = 0`, so it never consumes the submission key and never
   * blocks a future valid claim.
   */
  recordNonClaimed(
    submissionKey: string,
    metadata: ReceiptMetadata,
    state: ExecutionReceiptState,
    outcome: ExecutionOutcome,
    outcomeCode: string | null = null,
  ): ExecutionReceipt {
    const result = this.database.db
      .prepare(
        `INSERT INTO execution_receipts
           (submission_key, target_key, target_display, plan_id, draft_id,
            consistency_report_id, fingerprint, provider_id, provider_version,
            state, submit_attempted, outcome, outcome_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        submissionKey,
        metadata.targetKey,
        metadata.targetDisplay,
        metadata.planId,
        metadata.draftId,
        metadata.consistencyReportId,
        metadata.fingerprint,
        metadata.providerId,
        metadata.providerVersion,
        state,
        outcome,
        outcomeCode,
      );
    const receipt = this.findById(Number(result.lastInsertRowid));
    if (receipt === null) throw new Error('execution receipt insert failed');
    return receipt;
  }

  /** Persist a preflight receipt (non-claimed). */
  recordPreflight(submissionKey: string, metadata: ReceiptMetadata): ExecutionReceipt {
    return this.recordNonClaimed(submissionKey, metadata, 'preflight', 'preflight');
  }

  /** Persist a pre-submit failure receipt (non-claimed). */
  recordPreSubmitFailure(
    submissionKey: string,
    metadata: ReceiptMetadata,
    outcome: 'failed_pre_submit' | 'aborted',
    outcomeCode: string | null = null,
  ): ExecutionReceipt {
    return this.recordNonClaimed(submissionKey, metadata, outcome, outcome, outcomeCode);
  }

  /**
   * Atomically claim a submission key (P5-R16/P5-R17). Refuses when the key is
   * already claimed. `onClaimed` runs inside the same transaction so a
   * conservative rate event is durable with the claim.
   */
  claimSubmission(submissionKey: string, claim: SubmissionClaim): ExecutionReceipt {
    const claimTx = this.database.db.transaction(() => {
      const claimed = this.findClaimedBySubmissionKey(submissionKey);
      if (claimed !== null) {
        throw new ExecutionPreSubmitError(
          EXECUTION_PRE_SUBMIT_CODES.SUBMISSION_ALREADY_CLAIMED,
          `submission key already claimed by run ${claimed.id} (state ${claimed.state})`,
        );
      }

      const result = this.database.db
        .prepare(
          `INSERT INTO execution_receipts
             (submission_key, target_key, target_display, plan_id, draft_id,
              consistency_report_id, fingerprint, provider_id, provider_version,
              operator, approval_at, state, submit_attempted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitting', 1)`,
        )
        .run(
          submissionKey,
          claim.targetKey,
          claim.targetDisplay,
          claim.planId,
          claim.draftId,
          claim.consistencyReportId,
          claim.fingerprint,
          claim.providerId,
          claim.providerVersion,
          claim.operator,
          claim.approvalAt,
        );

      claim.onClaimed?.();
      return Number(result.lastInsertRowid);
    });

    const id = claimTx();
    const receipt = this.findById(id);
    if (receipt === null) throw new Error('execution receipt claim failed');
    return receipt;
  }

  /** Resolve a claimed receipt to a terminal state/outcome. */
  resolveOutcome(
    id: number,
    update: { state: ExecutionReceiptState; outcome: ExecutionOutcome; outcomeCode: string | null },
  ): ExecutionReceipt | null {
    this.database.db
      .prepare(
        `UPDATE execution_receipts
         SET state = ?, outcome = ?, outcome_code = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
      )
      .run(update.state, update.outcome, update.outcomeCode, id);
    return this.findById(id);
  }

  /** All receipts, newest first (audit aid). */
  list(): ExecutionReceipt[] {
    const rows = this.database.db
      .prepare('SELECT * FROM execution_receipts ORDER BY id DESC')
      .all() as ReceiptRow[];
    return rows.map(toReceipt);
  }
}
