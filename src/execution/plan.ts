/**
 * Execution-plan construction (P5-R5).
 *
 * Builds a provider-neutral `ExecutionPlan` from safe deterministic material and
 * derives its stable `planId`. Identity material is restricted to: plan version,
 * canonical target key, runtime schema checksum, draft id, consistency report
 * id, and provider id/version. Wall-clock time, raw answer/profile values, rate
 * counters, policy regex bodies, and URL query/userinfo secrets never
 * participate in identity.
 */

import { sha256Hex } from '../domain/fingerprint.ts';
import { EXECUTION_PLAN_VERSION, type ExecutionPlan } from '../domain/execution.ts';
import type { FormSchema } from '../domain/types.ts';
import type { DraftBundle } from '../domain/draft.ts';
import type { ConsistencyReport } from '../domain/consistency.ts';
import type { CanonicalTarget } from '../policy/target.ts';

export interface PlanInput {
  target: CanonicalTarget;
  schema: FormSchema;
  bundle: DraftBundle;
  report: ConsistencyReport;
  providerId: string;
  providerVersion: string;
  /** Whether the current full policy gate allows execution. */
  policyAllowed: boolean;
  /** Stable policy reason codes (empty when allowed). */
  policyReasons: string[];
}

/**
 * Derive the stable plan identity from only safe deterministic material.
 * A structural change, seed/draft change, consistency report change, or provider
 * contract change all change the planId; time/rate/raw values do not.
 */
export function derivePlanId(input: {
  targetKey: string;
  fingerprint: string;
  draftId: string;
  reportId: string;
  providerId: string;
  providerVersion: string;
}): string {
  return sha256Hex(
    [
      EXECUTION_PLAN_VERSION,
      input.targetKey,
      input.fingerprint,
      input.draftId,
      input.reportId,
      input.providerId,
      input.providerVersion,
    ].join('\u0000'),
  );
}

/** Count answered (fillable) vs blocked/deferred/unsupported draft results. */
function countDraftStates(bundle: DraftBundle): { fillable: number; blocked: number } {
  let fillable = 0;
  let blocked = 0;
  for (const result of bundle.results) {
    if (result.state.state === 'answered') fillable += 1;
    else blocked += 1;
  }
  return { fillable, blocked };
}

/** Build a provider-neutral execution plan. */
export function buildExecutionPlan(input: PlanInput): ExecutionPlan {
  const { target, schema, bundle, report, providerId, providerVersion } = input;
  const counts = countDraftStates(bundle);

  return {
    version: EXECUTION_PLAN_VERSION,
    planId: derivePlanId({
      targetKey: target.key,
      fingerprint: schema.checksum,
      draftId: bundle.draftId,
      reportId: report.reportId,
      providerId,
      providerVersion,
    }),
    targetKey: target.key,
    targetDisplay: target.display,
    fingerprint: schema.checksum,
    draftId: bundle.draftId,
    consistencyReportId: report.reportId,
    consistencyStatus: report.status,
    consistencyHardIssues: report.hardIssues,
    consistencySoftIssues: report.softIssues,
    providerId,
    providerVersion,
    fillableCount: counts.fillable,
    blockedCount: counts.blocked,
    policyAllowed: input.policyAllowed,
    policyReasons: [...input.policyReasons],
  };
}
