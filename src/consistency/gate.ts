/**
 * Consistency gate orchestration (P4-R2, R3, R4, R12).
 *
 * The public boundary is async-compatible now even though every accepted
 * Phase 4 rule is deterministic and synchronous internally, so a future Phase 6
 * holistic/model pass can be appended without rewriting callers.
 *
 * The gate is read-only: it consumes an accepted `FormSchema` + `DraftBundle`
 * and returns a stable `ConsistencyReport`. It never mutates the draft, never
 * calls the Phase 2 `PolicyEngine`, and never performs network/browser/
 * submission activity.
 */

import { sha256Hex } from '../domain/fingerprint.ts';
import type { FormSchema } from '../domain/types.ts';
import type { DraftBundle } from '../domain/draft.ts';
import {
  CONSISTENCY_GATE_VERSION,
  type ConsistencyIssue,
  type ConsistencyReport,
} from '../domain/consistency.ts';
import { evaluateConsistencyIssues } from './rules.ts';
import { ConsistencyInputError } from './errors.ts';

export interface ConsistencyGateInput {
  schema: FormSchema;
  bundle: DraftBundle;
}

/**
 * Derive a stable report identity from only safe deterministic material:
 * gate version, draft id, structural fingerprint, and normalized issue material
 * (code + severity + ordered question ids + stable message). No wall-clock
 * time, no raw answers, no provider messages, no secrets.
 */
function deriveReportId(draftId: string, fingerprint: string, issues: ConsistencyIssue[]): string {
  const issueMaterial = issues
    .map((item) =>
      [item.code, item.severity, item.questionIds.join(','), item.message].join('\u0000'),
    )
    .join('\n');
  return sha256Hex([CONSISTENCY_GATE_VERSION, draftId, fingerprint, issueMaterial].join('\u0000'));
}

/**
 * Run the deterministic consistency gate.
 *
 * Hard issues block; soft issues warn; no issues pass. The returned report is
 * reproducible for the same (schema, bundle, gate version).
 */
export async function runConsistencyGate(input: ConsistencyGateInput): Promise<ConsistencyReport> {
  const { schema, bundle } = input;

  if (!Array.isArray(bundle.results)) {
    throw new ConsistencyInputError('draft bundle results must be an array');
  }

  const issues = evaluateConsistencyIssues(schema, bundle);
  const hardIssues = issues.filter((item) => item.severity === 'hard').length;
  const softIssues = issues.filter((item) => item.severity === 'soft').length;
  const blocking = hardIssues > 0;
  const status = blocking ? 'block' : softIssues > 0 ? 'warn' : 'pass';

  return {
    version: CONSISTENCY_GATE_VERSION,
    reportId: deriveReportId(bundle.draftId, schema.checksum, issues),
    draftId: bundle.draftId,
    // Provenance identifies the schema actually evaluated, never a stale
    // bundle fingerprint (P4-R4 / FINDING A).
    fingerprint: schema.checksum,
    status,
    blocking,
    hardIssues,
    softIssues,
    issues,
  };
}
