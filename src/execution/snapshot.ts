/**
 * Durable execution-plan snapshot store (P6-R14, R15, R16, docs/PHASE_6.md §12).
 *
 * A narrow repository over migration 8's `execution_plan_snapshots` table. It
 * persists the exact validated synthetic DraftBundle used by preflight and
 * reloads it by plan id for submit. Writes are atomic; a conflicting second
 * write for an existing plan id fails closed (the plan id is already
 * content/provenance-derived, so conflicting content indicates corruption).
 *
 * The store does NOT persist API keys, Authorization headers, raw LLM
 * prompt/response, raw HTML, cookies/storage, or raw exceptions. The
 * `bundle_json` is the exact accepted synthetic DraftBundle (which may contain
 * eligible synthetic answers — durable reuse requires preserving them).
 */

import type { FormAgentDatabase } from '../db/database.ts';
import { ExecutionPreSubmitError } from './errors.ts';
import { EXECUTION_SNAPSHOT_CODES } from '../domain/execution.ts';

export interface ExecutionPlanSnapshot {
  planId: string;
  targetKey: string;
  fingerprint: string;
  draftId: string;
  consistencyReportId: string;
  draftProviderId: string;
  draftProviderVersion: string;
  modelOrProviderLabel: string | null;
  promptContractVersions: string;
  endpointHash: string | null;
  provenanceHash: string;
  bundleJson: string;
  bundleSha256: string;
  createdAt: string;
}

export interface ExecutionPlanSnapshotInput {
  planId: string;
  targetKey: string;
  fingerprint: string;
  draftId: string;
  consistencyReportId: string;
  draftProviderId: string;
  draftProviderVersion: string;
  modelOrProviderLabel: string | null;
  promptContractVersions: string;
  endpointHash: string | null;
  provenanceHash: string;
  bundleJson: string;
  bundleSha256: string;
}

interface SnapshotRow {
  plan_id: string;
  target_key: string;
  fingerprint: string;
  draft_id: string;
  consistency_report_id: string;
  draft_provider_id: string;
  draft_provider_version: string;
  model_or_provider_label: string | null;
  prompt_contract_versions: string;
  endpoint_hash: string | null;
  provenance_hash: string;
  bundle_json: string;
  bundle_sha256: string;
  created_at: string;
}

function toSnapshot(row: SnapshotRow): ExecutionPlanSnapshot {
  return {
    planId: row.plan_id,
    targetKey: row.target_key,
    fingerprint: row.fingerprint,
    draftId: row.draft_id,
    consistencyReportId: row.consistency_report_id,
    draftProviderId: row.draft_provider_id,
    draftProviderVersion: row.draft_provider_version,
    modelOrProviderLabel: row.model_or_provider_label,
    promptContractVersions: row.prompt_contract_versions,
    endpointHash: row.endpoint_hash,
    provenanceHash: row.provenance_hash,
    bundleJson: row.bundle_json,
    bundleSha256: row.bundle_sha256,
    createdAt: row.created_at,
  };
}

export class ExecutionPlanSnapshotStore {
  private readonly database: FormAgentDatabase;

  constructor(database: FormAgentDatabase) {
    this.database = database;
  }

  /** Load a persisted snapshot by plan id, or null when absent. */
  load(planId: string): ExecutionPlanSnapshot | null {
    const row = this.database.db
      .prepare('SELECT * FROM execution_plan_snapshots WHERE plan_id = ?')
      .get(planId) as SnapshotRow | undefined;
    return row === undefined ? null : toSnapshot(row);
  }

  /**
   * Atomically persist a snapshot. If the plan id already exists:
   *   - identical content is idempotent (no-op);
   *   - conflicting content fails closed (plan id is content-derived).
   */
  save(input: ExecutionPlanSnapshotInput): void {
    const transaction = this.database.db.transaction(() => {
      const existing = this.load(input.planId);
      if (existing !== null) {
        const equivalent =
          existing.targetKey === input.targetKey &&
          existing.fingerprint === input.fingerprint &&
          existing.draftId === input.draftId &&
          existing.consistencyReportId === input.consistencyReportId &&
          existing.draftProviderId === input.draftProviderId &&
          existing.draftProviderVersion === input.draftProviderVersion &&
          (existing.modelOrProviderLabel ?? null) === (input.modelOrProviderLabel ?? null) &&
          existing.promptContractVersions === input.promptContractVersions &&
          (existing.endpointHash ?? null) === (input.endpointHash ?? null) &&
          existing.provenanceHash === input.provenanceHash &&
          existing.bundleJson === input.bundleJson &&
          existing.bundleSha256 === input.bundleSha256;
        if (equivalent) return;
        throw new ExecutionPreSubmitError(
          EXECUTION_SNAPSHOT_CODES.CONFLICT,
          'an execution plan snapshot with a different content already exists for this plan id',
        );
      }
      this.database.db
        .prepare(
          `INSERT INTO execution_plan_snapshots
             (plan_id, target_key, fingerprint, draft_id, consistency_report_id,
              draft_provider_id, draft_provider_version, model_or_provider_label,
              prompt_contract_versions, endpoint_hash, provenance_hash,
              bundle_json, bundle_sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.planId,
          input.targetKey,
          input.fingerprint,
          input.draftId,
          input.consistencyReportId,
          input.draftProviderId,
          input.draftProviderVersion,
          input.modelOrProviderLabel,
          input.promptContractVersions,
          input.endpointHash,
          input.provenanceHash,
          input.bundleJson,
          input.bundleSha256,
        );
    });
    transaction();
  }
}
