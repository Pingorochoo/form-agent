/**
 * `check` CLI presentation (P4-R16).
 *
 * Human output summarizes identity/provenance, status, counts, and stable
 * issue codes + validated question ids without printing any compared answer or
 * profile value. Structured JSON returns safe draft metadata/provenance plus
 * the `ConsistencyReport` — never the full answer values (that remains the
 * explicit `draft --json` command's job).
 */

import type { DraftBundle } from '../domain/draft.ts';
import type { ConsistencyReport } from '../domain/consistency.ts';

const STATUS_LABEL: Record<ConsistencyReport['status'], string> = {
  pass: 'PASS',
  warn: 'WARN',
  block: 'BLOCK',
};

function formatIssue(item: ConsistencyReport['issues'][number]): string {
  const ids = item.questionIds.length > 0 ? ` (${item.questionIds.join(', ')})` : '';
  return `  - [${item.severity}] ${item.code}${ids}: ${item.message}`;
}

/** Human-readable consistency summary (P4-R16). */
export function formatCheckHuman(schemaTitle: string, formId: string, report: ConsistencyReport): string {
  const lines: string[] = [];
  lines.push(`Consistency check: ${schemaTitle}`);
  lines.push(`Form ID: ${formId}`);
  lines.push(`Draft ID: ${report.draftId}`);
  lines.push(`Report ID: ${report.reportId}`);
  lines.push(`Status: ${STATUS_LABEL[report.status]}`);
  lines.push(`Hard issues: ${report.hardIssues}`);
  lines.push(`Soft issues: ${report.softIssues}`);
  lines.push('Issues:');
  if (report.issues.length === 0) {
    lines.push('  (none)');
  } else {
    for (const item of report.issues) lines.push(formatIssue(item));
  }
  lines.push('No submission occurred.');
  return lines.join('\n');
}

/**
 * Structured JSON projection (P4-R16). Contains safe draft metadata/provenance
 * and the full `ConsistencyReport`; it deliberately omits per-question answer
 * values and profile latent-trait values.
 */
export function checkToJson(bundle: DraftBundle, report: ConsistencyReport): Record<string, unknown> {
  return {
    command: 'check',
    synthetic: true,
    seed: bundle.seed,
    draftId: bundle.draftId,
    provider: { id: bundle.providerId, version: bundle.providerVersion },
    fingerprint: bundle.fingerprint,
    form: { id: bundle.formId, title: bundle.formTitle },
    summary: bundle.summary,
    consistency: report,
  };
}
