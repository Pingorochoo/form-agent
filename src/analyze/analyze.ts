/**
 * Analyze pipeline (Phase 1): parse the archived payload, persist it keyed by
 * the structural fingerprint, and format a human-readable summary.
 *
 * Deterministic and offline. No LLM, no network, no submission.
 */

import type { FormSchema } from '../domain/types.ts';
import {
  GOOGLE_FORMS_PARSER_VERSION,
  parseGoogleFormsHtml,
  type GoogleFormsParseOptions,
} from '../parser/google-forms.ts';
import type { AnalysisStore } from './store.ts';

export interface AnalyzeInput {
  html: string;
  /** Overrides `meta.url` (e.g. the fixture URL or file path). */
  url?: string;
  /** Overrides `meta.capturedAt` (used to make fixtures deterministic). */
  capturedAt?: string;
  /** Overrides the form id derived from the payload. */
  formId?: string;
}

export interface AnalyzeOutcome {
  schema: FormSchema;
  /** The structural fingerprint (schema.checksum); the cache key. */
  fingerprintId: string;
  /** True when the schema came from the persisted cache. */
  cacheHit: boolean;
}

/**
 * Parse `html` into a `FormSchema` and (optionally) round-trip it through the
 * store. A cache hit returns the persisted structural schema with the current
 * invocation's `meta.url`/`meta.capturedAt` overlaid; a miss persists the
 * freshly parsed one.
 */
export function analyzeForm(input: AnalyzeInput, store?: AnalysisStore): AnalyzeOutcome {
  const options: GoogleFormsParseOptions = {
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.capturedAt !== undefined ? { capturedAt: input.capturedAt } : {}),
    ...(input.formId !== undefined ? { formId: input.formId } : {}),
  };
  const schema = parseGoogleFormsHtml(input.html, options);
  const fingerprintId = schema.checksum;

  if (store !== undefined) {
    const cached = store.getSchemaByFingerprint(fingerprintId);
    if (cached !== null) {
      // The structural result is cached; overlay the current invocation's
      // ephemeral metadata so a hit still reflects this parse's url/capturedAt.
      const merged = {
        ...cached,
        meta: { ...cached.meta, url: schema.meta.url, capturedAt: schema.meta.capturedAt },
      };
      return { schema: merged, fingerprintId, cacheHit: true };
    }
    store.saveSchema(schema, GOOGLE_FORMS_PARSER_VERSION);
  }

  return { schema, fingerprintId, cacheHit: false };
}

/** Count questions by kind, in a stable order. */
export function countByKind(schema: FormSchema): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const question of schema.parts) {
    counts[question.kind] = (counts[question.kind] ?? 0) + 1;
  }
  const sorted: Record<string, number> = {};
  for (const kind of Object.keys(counts).sort()) sorted[kind] = counts[kind] as number;
  return sorted;
}

/** Human-readable structural summary for `form-agent analyze`. */
export function formatAnalysisSummary(schema: FormSchema, fingerprintId: string): string {
  const lines: string[] = [];
  lines.push(`Form: ${schema.title}`);
  lines.push(`Form ID: ${schema.formId}`);
  lines.push(`Sections (${schema.sections.length}):`);
  schema.sections.forEach((section) => {
    lines.push(`  ${section.index + 1}. ${section.title || '(untitled)'} (${section.questionIds.length} questions)`);
  });
  const requiredCount = schema.parts.filter((question) => question.required === 'required').length;
  lines.push(`Questions: ${schema.parts.length}`);
  lines.push(`Required: ${requiredCount} (optional: ${schema.parts.length - requiredCount})`);
  lines.push('Kinds:');
  for (const [kind, count] of Object.entries(countByKind(schema))) {
    lines.push(`  ${kind}: ${count}`);
  }
  lines.push(`Routing: ${schema.hasRouting ? 'conditional' : 'sequential (no conditional routing)'}`);
  const terminal = schema.terminalSectionIds
    .map((id) => schema.sections.find((section) => section.id === id)?.title ?? id)
    .join(', ');
  lines.push(`Terminal sections: ${terminal || '(none)'}`);
  lines.push(`Answer model: ${schema.answerModel}`);
  lines.push(`Fingerprint: ${fingerprintId}`);
  return lines.join('\n');
}
