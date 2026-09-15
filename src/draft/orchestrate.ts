/**
 * Draft orchestration (P3-R2, P3-R8, P3-R11, P3-R15).
 *
 * The explicit local draft pipeline:
 *
 *   FormSchema → semantic interpretation → sensitivity pre-classification →
 *   synthetic profile (restricted to eligible questions) → per-question draft
 *   proposal → structural validation → DraftBundle
 *
 * The same whole-form semantics and the same shared synthetic profile are
 * passed to every answer-generation operation (P3-R15). Phase 2 sensitivity
 * classification runs before profile generation and before any value is
 * requested for a blocked question (P3-R8/P3-R2): blocked questions never reach
 * the provider and never contribute a profile trait. Structural validation
 * gates every proposal before it can be promoted to `answered` (P3-R10).
 *
 * Provider stages are `MaybePromise`, so the pipeline awaits them and remains
 * future-provider replaceable without rewriting orchestration (P3-R2).
 *
 * This pipeline is ephemeral and persists nothing (P3-R18). It does not use
 * the full future-run `PolicyEngine`; it reuses sensitivity classification
 * directly.
 */

import type { FormSchema, Question } from '../domain/types.ts';
import type { SensitiveRule, SensitiveFieldResult, SensitiveMode } from '../policy/sensitive.ts';
import { classifyQuestion } from '../policy/sensitive.ts';
import { sha256Hex } from '../domain/fingerprint.ts';
import type {
  DraftBundle,
  DraftSummary,
  QuestionDraftResult,
  QuestionDraftState,
} from '../domain/draft.ts';
import type { DraftProvider, MaybePromise } from './provider.ts';
import { validateDraftValue, validateSemanticModel, validateSyntheticProfile } from './validate.ts';
import { DraftSeedError, DraftValidationError } from './errors.ts';
import { LlmProviderError } from '../llm/errors.ts';

/** Accepted Phase 1 structural kinds that Phase 3 may draft (P3-R9). */
export const SUPPORTED_DRAFT_KINDS: ReadonlySet<string> = new Set([
  'text',
  'paragraph-text',
  'single-choice',
  'multi-choice',
  'linear-scale',
  'multiple-choice-grid',
  'date',
  'time',
]);

export function isDraftableKind(kind: string): boolean {
  return SUPPORTED_DRAFT_KINDS.has(kind);
}

/** A question is eligible for synthetic drafting only when sensitivity allows it. */
export function isEligibleForDraft(mode: SensitiveMode | null): boolean {
  return mode === null || mode === 'synthetic-allowed';
}

/**
 * Stable normalized effective-policy material for draft identity. Different
 * effective sensitivity outcomes (per-question mode/categories) produce
 * different draft states/content, so they must not alias to the same draftId.
 * Only stable, non-secret classification fields are hashed — never raw regex
 * patterns, secrets, or wall-clock data.
 */
export function policyFingerprintMaterial(
  schema: FormSchema,
  classifications: Map<string, SensitiveFieldResult>,
): string {
  const parts: string[] = [];
  for (const question of schema.parts) {
    const classification = classifications.get(question.id);
    if (classification === undefined) continue;
    const mode = classification.mode ?? 'none';
    const categories = [...classification.categories].sort().join(',');
    parts.push(`${question.id}:${mode}:${categories}`);
  }
  return parts.join('\n');
}

export interface GenerateDraftOptions {
  schema: FormSchema;
  seed: string;
  provider: DraftProvider;
  sensitiveRules: SensitiveRule[];
}

/**
 * Invoke a provider stage. Every exception raised inside the provider boundary
 * is untrusted (a future provider may throw a DraftError with a raw provider
 * message or token), so ALL of them are wrapped into a stable, sanitized
 * stage error — EXCEPT stable `LlmProviderError`s, which already carry
 * sanitized, stable codes that the CLI maps onto the frozen exit-code contract.
 * Orchestration/validator errors raised OUTSIDE the provider invocation are
 * unaffected.
 */
async function callProviderStage<T>(stage: string, run: () => MaybePromise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof LlmProviderError) throw err;
    throw new DraftValidationError(`draft provider failed during ${stage}`);
  }
}

interface DraftQuestionInput {
  schema: FormSchema;
  seed: string;
  provider: DraftProvider;
  semantics: Awaited<ReturnType<DraftProvider['interpretForm']>>;
  profile: Awaited<ReturnType<DraftProvider['buildProfile']>>;
  question: Question;
  classification: SensitiveFieldResult;
}

async function draftQuestion(input: DraftQuestionInput): Promise<QuestionDraftResult> {
  const { schema, seed, provider, semantics, profile, question, classification } = input;
  const required = question.required === 'required';
  const base = { questionId: question.id, kind: question.kind, required };

  // 1. Sensitivity classification (pre-computed in generateDraft) gates first
  //    (P3-R8). A blocked question never reaches the provider.
  const mode = classification.mode;

  if (mode === 'never') {
    return {
      ...base,
      state: {
        state: 'blocked-sensitive',
        categories: classification.categories,
        mode,
        reason: classification.reason,
      },
    };
  }
  if (mode === 'human-reviewed') {
    return {
      ...base,
      state: {
        state: 'requires-human-review',
        categories: classification.categories,
        mode,
        reason: classification.reason,
      },
    };
  }
  if (mode === 'specific-authorization') {
    return {
      ...base,
      state: {
        state: 'requires-specific-authorization',
        categories: classification.categories,
        mode,
        reason: classification.reason,
      },
    };
  }

  // 2. Non-sensitive / synthetic-allowed questions must still be draftable.
  if (!isDraftableKind(question.kind)) {
    const reason =
      question.kind === 'unsupported' && 'reason' in question && typeof question.reason === 'string'
        ? question.reason
        : 'unsupported structural kind';
    return { ...base, state: { state: 'unsupported', reason } };
  }

  // 3. Request a proposal from the provider, then structurally validate it.
  const proposal = await callProviderStage(`answer for question`, () =>
    provider.proposeAnswer({ schema, semantics, profile, question, seed }),
  );
  const validation = validateDraftValue(proposal, question);
  if (validation.ok) {
    return { ...base, state: { state: 'answered', value: validation.value } };
  }
  return { ...base, state: { state: 'validation-error', reason: validation.reason } };
}

function summarize(schema: FormSchema, results: QuestionDraftResult[]): DraftSummary {
  let answered = 0;
  let blocked = 0;
  let unsupported = 0;
  let validationErrors = 0;
  let requiredUnanswered = 0;

  for (const result of results) {
    const state: QuestionDraftState = result.state;
    switch (state.state) {
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
    if (result.required && state.state !== 'answered') {
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
 * Run the full draft pipeline for a schema. Deterministic from (schema, seed,
 * provider contract). Throws a controlled error for an empty seed or invalid
 * semantic/profile provider output.
 */
export async function generateDraft(options: GenerateDraftOptions): Promise<DraftBundle> {
  const { schema, seed, provider, sensitiveRules } = options;
  if (typeof seed !== 'string' || seed.trim() === '') {
    throw new DraftSeedError('draft requires a non-empty --seed');
  }

  const semantics = await callProviderStage('semantic interpretation', () =>
    provider.interpretForm(schema, seed),
  );
  validateSemanticModel(semantics, schema);

  // Sensitivity pre-classification runs before profile generation so blocked
  // questions cannot contribute question-answer-like profile values (P3-R2).
  const classifications = new Map<string, SensitiveFieldResult>();
  const eligibleQuestionIds = new Set<string>();
  for (const question of schema.parts) {
    const classification = classifyQuestion(question, sensitiveRules);
    classifications.set(question.id, classification);
    if (isEligibleForDraft(classification.mode)) {
      eligibleQuestionIds.add(question.id);
    }
  }

  const profile = await callProviderStage('profile generation', () =>
    provider.buildProfile({ schema, semantics, seed, eligibleQuestionIds }),
  );
  validateSyntheticProfile(profile, schema, semantics);

  const results: QuestionDraftResult[] = [];
  for (const question of schema.parts) {
    const classification = classifications.get(question.id);
    if (classification === undefined) {
      throw new DraftValidationError('sensitivity classification missing for a schema question');
    }
    results.push(
      await draftQuestion({ schema, seed, provider, semantics, profile, question, classification }),
    );
  }

  const summary = summarize(schema, results);
  const policyMaterial = policyFingerprintMaterial(schema, classifications);
  const draftId = sha256Hex(
    [schema.checksum, seed, provider.id, provider.version, policyMaterial, profile.profileId].join('\u0000'),
  );

  return {
    synthetic: true,
    seed,
    draftId,
    providerId: provider.id,
    providerVersion: provider.version,
    fingerprint: schema.checksum,
    formId: schema.formId,
    formTitle: schema.title,
    semantics,
    profile,
    results,
    summary,
  };
}
