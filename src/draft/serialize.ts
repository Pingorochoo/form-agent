/**
 * DraftBundle persistence serialization (P6-R13 docs/PHASE_6.md §13).
 *
 * Persists the exact accepted synthetic DraftBundle as JSON and reconstructs it
 * through a narrow runtime parser that never blindly casts arbitrary JSON. The
 * parser reuses the accepted Phase 3 validators (semantic model, synthetic
 * profile, per-question draft value) so a corrupt/tampered snapshot fails
 * closed before any fill.
 *
 * Serialization uses plain `JSON.stringify` (the bundle is always produced in a
 * stable shape with no `undefined` fields); identity/equivalence is performed by
 * the snapshot store on the serialized string.
 */

import type { FormSchema, Question } from '../domain/types.ts';
import type { DraftBundle, DraftSummary, QuestionDraftResult } from '../domain/draft.ts';
import { canonicalJson, sha256Hex } from '../domain/fingerprint.ts';
import { validateDraftValue, validateSemanticModel, validateSyntheticProfile } from './validate.ts';
import { DraftValidationError } from './errors.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Canonical (key-sorted, deterministic) serialization of the exact bundle. */
export function serializeDraftBundle(bundle: DraftBundle): string {
  return canonicalJson(bundle);
}

/**
 * Stable SHA-256 content digest over the exact serialized DraftBundle bytes.
 * Any change to any persisted byte (including a structurally valid answer or
 * profile mutation) changes this digest, so submit can verify the operator
 * approved the exact bundle it will fill.
 */
export function bundleSha256(serialized: string): string {
  return sha256Hex(serialized);
}

/** Validate + reconstruct one question result against its schema question. */
function parseResult(question: Question, raw: unknown): QuestionDraftResult {
  if (!isRecord(raw)) {
    throw new DraftValidationError('snapshot bundle result is not an object');
  }
  if (raw['questionId'] !== question.id) {
    throw new DraftValidationError('snapshot bundle result question id does not match the schema');
  }
  if (raw['kind'] !== question.kind) {
    throw new DraftValidationError('snapshot bundle result kind does not match the schema question');
  }
  if (raw['required'] !== (question.required === 'required')) {
    throw new DraftValidationError('snapshot bundle result required mark does not match the schema question');
  }

  const state = raw['state'];
  if (!isRecord(state)) {
    throw new DraftValidationError('snapshot bundle result state is not an object');
  }
  switch (state['state']) {
    case 'answered': {
      const validation = validateDraftValue(state['value'], question);
      if (!validation.ok) {
        throw new DraftValidationError('snapshot bundle answered value failed validation');
      }
      return { questionId: question.id, kind: question.kind, required: question.required === 'required', state: { state: 'answered', value: validation.value } };
    }
    case 'blocked-sensitive':
    case 'requires-human-review':
    case 'requires-specific-authorization': {
      const categories = state['categories'];
      if (!Array.isArray(categories) || !categories.every((c) => typeof c === 'string')) {
        throw new DraftValidationError('snapshot bundle blocked state has invalid categories');
      }
      if (typeof state['mode'] !== 'string' || typeof state['reason'] !== 'string') {
        throw new DraftValidationError('snapshot bundle blocked state is malformed');
      }
      const base = { questionId: question.id, kind: question.kind, required: question.required === 'required' };
      return {
        ...base,
        state: {
          state: state['state'],
          categories: categories as string[],
          mode: state['mode'] as string,
          reason: state['reason'] as string,
        },
      };
    }
    case 'unsupported':
    case 'validation-error': {
      if (typeof state['reason'] !== 'string') {
        throw new DraftValidationError('snapshot bundle result state is missing a reason');
      }
      return { questionId: question.id, kind: question.kind, required: question.required === 'required', state: { state: state['state'], reason: state['reason'] as string } };
    }
    default:
      throw new DraftValidationError('snapshot bundle result has an unknown state');
  }
}

/**
 * Deterministically recompute the DraftSummary from the validated results and
 * schema (matches the accepted Phase 3 `summarize` logic exactly). Used to
 * verify the persisted summary rather than trusting arbitrary stored numbers.
 */
function computeSummary(schema: FormSchema, results: QuestionDraftResult[]): DraftSummary {
  let answered = 0;
  let blocked = 0;
  let unsupported = 0;
  let validationErrors = 0;
  let requiredUnanswered = 0;

  for (const result of results) {
    switch (result.state.state) {
      case 'answered':
        answered += 1;
        break;
      case 'blocked-sensitive':
      case 'requires-human-review':
      case 'requires-specific-authorization':
        blocked += 1;
        break;
      case 'unsupported':
        unsupported += 1;
        break;
      case 'validation-error':
        validationErrors += 1;
        break;
    }
    if (result.required && result.state.state !== 'answered') {
      requiredUnanswered += 1;
    }
  }

  return {
    total: schema.parts.length,
    answered,
    blocked,
    unsupported,
    validationErrors,
    requiredUnanswered,
    complete: requiredUnanswered === 0,
  };
}

/**
 * Parse and validate a persisted DraftBundle JSON against the current schema.
 * Throws `DraftValidationError` for any corrupt/malformed/mismatched shape.
 */
export function parseDraftBundleJson(json: string, schema: FormSchema): DraftBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DraftValidationError('snapshot bundle is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new DraftValidationError('snapshot bundle is not an object');
  }

  if (parsed['synthetic'] !== true) {
    throw new DraftValidationError('snapshot bundle is not marked synthetic');
  }
  if (!isNonEmptyString(parsed['seed'])) {
    throw new DraftValidationError('snapshot bundle is missing a seed');
  }
  for (const field of ['draftId', 'providerId', 'providerVersion', 'fingerprint', 'formId', 'formTitle'] as const) {
    if (!isNonEmptyString(parsed[field])) {
      throw new DraftValidationError(`snapshot bundle is missing ${field}`);
    }
  }

  validateSemanticModel(parsed['semantics'], schema);
  const semantics = parsed['semantics'] as DraftBundle['semantics'];
  validateSyntheticProfile(parsed['profile'], schema, semantics);
  const profile = parsed['profile'] as DraftBundle['profile'];

  const rawResults = parsed['results'];
  if (!Array.isArray(rawResults) || rawResults.length !== schema.parts.length) {
    throw new DraftValidationError('snapshot bundle results do not match the schema question count');
  }
  const byId = new Map<string, unknown>();
  for (const raw of rawResults) {
    if (!isRecord(raw) || typeof raw['questionId'] !== 'string') {
      throw new DraftValidationError('snapshot bundle result is malformed');
    }
    if (byId.has(raw['questionId'])) {
      throw new DraftValidationError('snapshot bundle contains a duplicate result');
    }
    byId.set(raw['questionId'], raw);
  }
  const results: QuestionDraftResult[] = [];
  for (const question of schema.parts) {
    const raw = byId.get(question.id);
    if (raw === undefined) {
      throw new DraftValidationError('snapshot bundle is missing a schema question result');
    }
    results.push(parseResult(question, raw));
  }

  const summary = parsed['summary'];
  if (!isRecord(summary)) {
    throw new DraftValidationError('snapshot bundle summary is malformed');
  }
  // P6-R17: do not trust persisted summary numbers — recompute from the
  // validated results and require exact equality.
  const recomputedSummary = computeSummary(schema, results);
  for (const field of ['total', 'answered', 'blocked', 'unsupported', 'validationErrors', 'requiredUnanswered'] as const) {
    if (summary[field] !== recomputedSummary[field]) {
      throw new DraftValidationError('snapshot bundle summary does not match its results');
    }
  }
  if (summary['complete'] !== recomputedSummary.complete) {
    throw new DraftValidationError('snapshot bundle summary complete flag does not match its results');
  }

  return {
    synthetic: true,
    seed: parsed['seed'] as string,
    draftId: parsed['draftId'] as string,
    providerId: parsed['providerId'] as string,
    providerVersion: parsed['providerVersion'] as string,
    fingerprint: parsed['fingerprint'] as string,
    formId: parsed['formId'] as string,
    formTitle: parsed['formTitle'] as string,
    semantics,
    profile,
    results,
    summary: recomputedSummary,
  };
}
