/**
 * Draft CLI presentation (human-readable + structured JSON).
 *
 * Human-readable output summarizes provenance and counts without printing
 * blocked sensitive values. Structured JSON is the explicit command result and
 * may contain eligible synthetic values, but never values for policy-blocked
 * fields (P3-R12, P3-R16).
 */

import type { DraftBundle, DraftValue, QuestionDraftResult } from '../domain/draft.ts';

function formatValue(value: DraftValue): string {
  switch (value.kind) {
    case 'multi-choice':
      return value.value.join(', ');
    case 'multiple-choice-grid':
      return Object.entries(value.value)
        .map(([row, column]) => `${row}=${column}`)
        .join(', ');
    case 'date':
      return `${value.value.year}-${value.value.month}-${value.value.day}`;
    case 'time': {
      const hour = String(value.value.hour).padStart(2, '0');
      const minute = String(value.value.minute).padStart(2, '0');
      return `${hour}:${minute}`;
    }
    default:
      return String(value.value);
  }
}

function resultSuffix(result: QuestionDraftResult): string {
  const { state } = result;
  if (state.state === 'answered') {
    return ` = ${formatValue(state.value)}`;
  }
  if ('reason' in state && state.reason !== '') {
    return ` (${state.reason})`;
  }
  return '';
}

/** Human-readable draft summary (P3-R16). */
export function formatDraftHuman(bundle: DraftBundle): string {
  const summary = bundle.summary;
  const lines: string[] = [];
  lines.push(`Draft: ${bundle.formTitle}`);
  lines.push(`Form ID: ${bundle.formId}`);
  lines.push(`Seed: ${bundle.seed}`);
  lines.push(`Profile: ${bundle.profile.profileId} (synthetic, archetype ${bundle.profile.archetype})`);
  lines.push(`Provider: ${bundle.providerId} v${bundle.providerVersion}`);
  lines.push(`Fingerprint: ${bundle.fingerprint}`);
  lines.push(`Answered: ${summary.answered}`);
  lines.push(`Blocked/deferred: ${summary.blocked}`);
  lines.push(`Unsupported: ${summary.unsupported}`);
  lines.push(`Required unanswered: ${summary.requiredUnanswered}`);
  lines.push(`Complete: ${summary.complete ? 'yes' : 'no'}`);
  lines.push('Questions:');
  for (const result of bundle.results) {
    lines.push(`  - ${result.questionId} (${result.kind}) [${result.state.state}]${resultSuffix(result)}`);
  }
  lines.push('No submission occurred.');
  return lines.join('\n');
}

function serializeResult(result: QuestionDraftResult): Record<string, unknown> {
  const { state } = result;
  if (state.state === 'answered') {
    return {
      questionId: result.questionId,
      kind: result.kind,
      required: result.required,
      state: 'answered',
      value: state.value,
    };
  }
  const out: Record<string, unknown> = {
    questionId: result.questionId,
    kind: result.kind,
    required: result.required,
    state: state.state,
  };
  if ('reason' in state) out.reason = state.reason;
  if ('categories' in state) out.categories = state.categories;
  if ('mode' in state) out.mode = state.mode;
  return out;
}

/** Structured JSON projection (P3-R16, P3-R12). Blocked fields carry no value. */
export function draftToJson(bundle: DraftBundle): Record<string, unknown> {
  return {
    synthetic: true,
    seed: bundle.seed,
    draftId: bundle.draftId,
    provider: { id: bundle.providerId, version: bundle.providerVersion },
    fingerprint: bundle.fingerprint,
    form: { id: bundle.formId, title: bundle.formTitle },
    semantics: {
      purpose: bundle.semantics.purpose,
      topic: bundle.semantics.topic,
      style: bundle.semantics.style,
      confidence: bundle.semantics.confidence,
      targetAudience: bundle.semantics.targetAudience,
      sections: bundle.semantics.sections ?? {},
    },
    profile: {
      profileId: bundle.profile.profileId,
      synthetic: true,
      archetype: bundle.profile.archetype,
      identity: bundle.profile.identity,
      facts: bundle.profile.facts,
      latentTraits: bundle.profile.latentTraits,
    },
    summary: bundle.summary,
    results: bundle.results.map(serializeResult),
  };
}
