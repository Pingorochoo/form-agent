/**
 * Execution CLI presentation (P5-R20).
 *
 * Human + JSON output for preflight and submit modes. Preflight may show
 * eligible synthetic answered values (the explicit operator review step);
 * submit mode never re-dumps answer values. Blocked/deferred values are never
 * shown anywhere. Receipt output contains only sanitized provenance + stable
 * state/outcome codes.
 */

import type { DraftBundle, DraftValue } from '../domain/draft.ts';
import type { ConsistencyReport } from '../domain/consistency.ts';
import type { AcceptingState, ExecutionOutcome, ExecutionPlan } from '../domain/execution.ts';
import type { ExecutionReceipt } from './receipt.ts';

function formatValue(value: DraftValue): string {
  switch (value.kind) {
    case 'multi-choice':
      return value.value.join(', ');
    case 'multiple-choice-grid':
      return Object.entries(value.value)
        .map(([row, column]) => `${row}=${column}`)
        .join(', ');
    case 'date':
      return `${value.value.year}-${String(value.value.month).padStart(2, '0')}-${String(value.value.day).padStart(2, '0')}`;
    case 'time':
      return `${String(value.value.hour).padStart(2, '0')}:${String(value.value.minute).padStart(2, '0')}`;
    default:
      return String(value.value);
  }
}

/** Answered (fillable) entries only — blocked/deferred values never appear. */
function answeredEntries(bundle: DraftBundle): Array<{ questionId: string; kind: string; value: DraftValue }> {
  return bundle.results
    .filter((result) => result.state.state === 'answered')
    .map((result) => ({
      questionId: result.questionId,
      kind: result.kind,
      value: result.state.state === 'answered' ? result.state.value : (undefined as never),
    }));
}

const STATUS_LABEL: Record<ConsistencyReport['status'], string> = {
  pass: 'PASS',
  warn: 'WARN',
  block: 'BLOCK',
};

export interface PreflightFormatInput {
  plan: ExecutionPlan;
  bundle: DraftBundle;
  report: ConsistencyReport;
  accepting: AcceptingState;
  receipt: ExecutionReceipt;
  formTitle: string;
}

export function formatPreflightHuman(input: PreflightFormatInput): string {
  const { plan, bundle, report, accepting, receipt, formTitle } = input;
  const lines: string[] = [];
  lines.push(`Preflight plan: ${formTitle}`);
  lines.push(`Run ID: ${receipt.id}`);
  lines.push(`Target: ${plan.targetDisplay}`);
  lines.push(`Accepting responses: ${accepting}`);
  lines.push(`Fingerprint: ${plan.fingerprint}`);
  lines.push(`Draft ID: ${plan.draftId}`);
  lines.push(`Consistency report: ${plan.consistencyReportId} (${STATUS_LABEL[report.status]}, ${report.hardIssues} hard, ${report.softIssues} soft)`);
  lines.push(`Plan ID: ${plan.planId}`);
  lines.push(`Provider: ${plan.providerId} v${plan.providerVersion}`);
  lines.push(`Fillable (answered): ${plan.fillableCount}`);
  lines.push(`Blocked/deferred: ${plan.blockedCount}`);
  lines.push(`Policy: ${plan.policyAllowed ? 'allowed' : `blocked (${plan.policyReasons.join(', ') || 'no reason'})`}`);
  lines.push('Eligible synthetic answers (review only):');
  for (const entry of answeredEntries(bundle)) {
    lines.push(`  - ${entry.questionId} (${entry.kind}) = ${formatValue(entry.value)}`);
  }
  lines.push('NO FILL OR SUBMISSION OCCURRED.');
  return lines.join('\n');
}

export function preflightToJson(input: PreflightFormatInput): Record<string, unknown> {
  const { plan, bundle, report, accepting, receipt } = input;
  return {
    command: 'run',
    mode: 'preflight',
    runId: receipt.id,
    plan: {
      version: plan.version,
      planId: plan.planId,
      target: { key: plan.targetKey, display: plan.targetDisplay },
      fingerprint: plan.fingerprint,
      draftId: plan.draftId,
      consistency: {
        reportId: plan.consistencyReportId,
        status: plan.consistencyStatus,
        hardIssues: plan.consistencyHardIssues,
        softIssues: plan.consistencySoftIssues,
      },
      provider: { id: plan.providerId, version: plan.providerVersion },
      fillableCount: plan.fillableCount,
      blockedCount: plan.blockedCount,
      policy: { allowed: plan.policyAllowed, reasons: plan.policyReasons },
    },
    accepting,
    consistencyReport: report,
    answers: answeredEntries(bundle).map((entry) => ({
      questionId: entry.questionId,
      kind: entry.kind,
      value: entry.value,
    })),
    summary: bundle.summary,
  };
}

export interface SubmitFormatInput {
  plan: ExecutionPlan;
  receipt: ExecutionReceipt;
  outcome: ExecutionOutcome;
}

export function formatSubmitHuman(input: SubmitFormatInput): string {
  const { plan, receipt, outcome } = input;
  const lines: string[] = [];
  lines.push(`Submission result: ${outcome}`);
  lines.push(`Run ID: ${receipt.id}`);
  lines.push(`Plan ID: ${plan.planId}`);
  lines.push(`Target: ${plan.targetDisplay}`);
  lines.push(`Fingerprint: ${plan.fingerprint}`);
  lines.push(`Receipt state: ${receipt.state}`);
  lines.push(`Submit attempted: ${receipt.submitAttempted ? 'yes' : 'no'}`);
  lines.push(`Outcome code: ${receipt.outcomeCode ?? '(none)'}`);
  lines.push(`Consistency warnings: ${plan.consistencySoftIssues}`);
  lines.push(`Policy reasons: ${plan.policyReasons.length > 0 ? plan.policyReasons.join(', ') : '(none)'}`);
  lines.push(`Operator: ${receipt.operator ?? '(none)'}`);
  lines.push(`Confirmed: ${outcome === 'success' ? 'yes' : 'no'}`);
  return lines.join('\n');
}

export function submitToJson(input: SubmitFormatInput): Record<string, unknown> {
  const { plan, receipt, outcome } = input;
  return {
    command: 'run',
    mode: 'submit',
    runId: receipt.id,
    outcome,
    plan: {
      planId: plan.planId,
      target: { key: plan.targetKey, display: plan.targetDisplay },
      fingerprint: plan.fingerprint,
      provider: { id: plan.providerId, version: plan.providerVersion },
      consistency: {
        reportId: plan.consistencyReportId,
        status: plan.consistencyStatus,
        softIssues: plan.consistencySoftIssues,
      },
    },
    receipt: {
      state: receipt.state,
      submitAttempted: receipt.submitAttempted,
      outcome: receipt.outcome,
      outcomeCode: receipt.outcomeCode,
      operator: receipt.operator,
      approvalAt: receipt.approvalAt,
      createdAt: receipt.createdAt,
      updatedAt: receipt.updatedAt,
    },
  };
}
