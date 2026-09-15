/**
 * Deterministic consistency rules (P4-R5, R6, R7, R8, R9, R10).
 *
 * Each rule function is a pure, read-only transform from an accepted
 * `FormSchema` + `DraftBundle` into an ordered list of `ConsistencyIssue`s.
 * Rule functions never mutate their inputs and never embed raw answer/profile
 * values or untrusted ids into issue material.
 *
 * Stable rule ordering (P4-R4):
 *   1. schema/bundle integrity;
 *   2. required/completeness and validation-state;
 *   3. profile <-> answer conformance;
 *   4. answer <-> answer relationship checks.
 * Within a rule, issues follow accepted schema order where possible.
 */

import type { FormSchema, Question } from '../domain/types.ts';
import type { DraftBundle, DraftValue, QuestionDraftResult } from '../domain/draft.ts';
import { isAnsweredState } from '../domain/draft.ts';
import type { Confidence } from '../domain/types.ts';
import { CONSISTENCY_ISSUE_CODES, type ConsistencyIssue } from '../domain/consistency.ts';
import { answersEqual, isComparableKind } from './compare.ts';

/** Stable, value-free issue messages. */
const MESSAGES = {
  fingerprint: 'draft fingerprint does not match the schema checksum',
  formId: 'draft form identity does not match the schema',
  profileForm: 'profile form identity does not match the schema',
  coverageUnknown: 'draft result references an unknown question id',
  coverageDuplicate: 'duplicate draft result for a question',
  coverageMissing: 'schema question is missing a draft result',
  kindMismatch: 'draft result kind does not match the schema question kind',
  requiredUnanswered: 'required question is not answered',
  validationError: 'draft validation-error state is present',
  traitMismatch: 'answer does not match the profile latent trait',
  repetitionMismatch: 'repeated questions contain inconsistent answers',
  repetitionPossible: 'repeated questions may contain inconsistent answers',
  relationshipUnchecked: 'repeated question relationship could not be fully checked',
} as const;

function issue(
  code: string,
  severity: 'hard' | 'soft',
  questionIds: string[],
  message: string,
): ConsistencyIssue {
  return { code, severity, questionIds, message };
}

/** Index schema questions by id and remember their schema order (slot). */
function schemaIndex(schema: FormSchema): {
  byId: Map<string, Question>;
  order: Map<string, number>;
} {
  const byId = new Map<string, Question>();
  const order = new Map<string, number>();
  for (const question of schema.parts) {
    byId.set(question.id, question);
    order.set(question.id, question.slot);
  }
  return { byId, order };
}

/**
 * Map each question id to its result only when that id appears exactly once.
 * A missing result (0 occurrences) and a duplicate result (>1 occurrences) both
 * resolve to `undefined` here; those conditions are represented by the
 * integrity stage's coverage issue and must never silently pick one duplicate
 * (FINDING B). This map is therefore safe to use for completeness/state checks
 * even when the integrity stage has already failed.
 */
function resultIndex(bundle: DraftBundle): Map<string, QuestionDraftResult> {
  const counts = new Map<string, number>();
  for (const result of bundle.results) {
    counts.set(result.questionId, (counts.get(result.questionId) ?? 0) + 1);
  }
  const map = new Map<string, QuestionDraftResult>();
  for (const result of bundle.results) {
    if ((counts.get(result.questionId) ?? 0) === 1) {
      map.set(result.questionId, result);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// 1. Schema / DraftBundle integrity (P4-R5).
// ---------------------------------------------------------------------------

function integrityIssues(schema: FormSchema, bundle: DraftBundle): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const { byId } = schemaIndex(schema);

  if (bundle.fingerprint !== schema.checksum) {
    issues.push(
      issue(CONSISTENCY_ISSUE_CODES.SCHEMA_FINGERPRINT_MISMATCH, 'hard', [], MESSAGES.fingerprint),
    );
  }
  if (bundle.formId !== schema.formId) {
    issues.push(issue(CONSISTENCY_ISSUE_CODES.FORM_ID_MISMATCH, 'hard', [], MESSAGES.formId));
  }
  if (bundle.profile.formId !== schema.formId) {
    issues.push(issue(CONSISTENCY_ISSUE_CODES.PROFILE_FORM_MISMATCH, 'hard', [], MESSAGES.profileForm));
  }

  // Coverage: unknown ids, duplicate ids, missing schema questions, kind mismatch.
  const counts = new Map<string, number>();
  for (const result of bundle.results) {
    counts.set(result.questionId, (counts.get(result.questionId) ?? 0) + 1);
  }

  // Unknown ids first (never echo the untrusted id).
  const unknownSeen = new Set<string>();
  for (const result of bundle.results) {
    if (!byId.has(result.questionId) && !unknownSeen.has(result.questionId)) {
      unknownSeen.add(result.questionId);
      issues.push(issue(CONSISTENCY_ISSUE_CODES.DRAFT_RESULT_COVERAGE_MISMATCH, 'hard', [], MESSAGES.coverageUnknown));
    }
  }

  // Duplicate ids (only for ids that are real schema questions, so we may echo them).
  const duplicateSeen = new Set<string>();
  for (const result of bundle.results) {
    const count = counts.get(result.questionId) ?? 0;
    if (byId.has(result.questionId) && count > 1 && !duplicateSeen.has(result.questionId)) {
      duplicateSeen.add(result.questionId);
      issues.push(
        issue(CONSISTENCY_ISSUE_CODES.DRAFT_RESULT_COVERAGE_MISMATCH, 'hard', [result.questionId], MESSAGES.coverageDuplicate),
      );
    }
  }

  // Kind mismatch (result.kind vs schema question kind) for known ids.
  for (const result of bundle.results) {
    const question = byId.get(result.questionId);
    if (question !== undefined && result.kind !== question.kind) {
      issues.push(
        issue(CONSISTENCY_ISSUE_CODES.DRAFT_RESULT_KIND_MISMATCH, 'hard', [result.questionId], MESSAGES.kindMismatch),
      );
    }
  }

  // Missing schema-question results (in schema order).
  for (const question of schema.parts) {
    if ((counts.get(question.id) ?? 0) === 0) {
      issues.push(
        issue(CONSISTENCY_ISSUE_CODES.DRAFT_RESULT_COVERAGE_MISMATCH, 'hard', [question.id], MESSAGES.coverageMissing),
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 2. Required / completeness and validation-state (P4-R6).
// ---------------------------------------------------------------------------

function completenessIssues(schema: FormSchema, bundle: DraftBundle): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const { byId } = schemaIndex(schema);
  const results = resultIndex(bundle);

  for (const question of schema.parts) {
    const result = results.get(question.id);
    if (result === undefined) continue; // covered by integrity
    if (result.state.state === 'validation-error') {
      issues.push(
        issue(CONSISTENCY_ISSUE_CODES.DRAFT_VALIDATION_ERROR, 'hard', [question.id], MESSAGES.validationError),
      );
      continue;
    }
    if (question.required === 'required' && result.state.state !== 'answered') {
      issues.push(
        issue(CONSISTENCY_ISSUE_CODES.REQUIRED_QUESTION_UNANSWERED, 'hard', [question.id], MESSAGES.requiredUnanswered),
      );
    }
  }
  void byId;
  return issues;
}

// ---------------------------------------------------------------------------
// 3. Profile <-> answer conformance (P4-R7).
// ---------------------------------------------------------------------------

/** Value-type discriminator for the trait types we may hard-check. */
function traitMatchesKind(kind: string, value: unknown): boolean {
  if (kind === 'linear-scale') return typeof value === 'number';
  if (kind === 'single-choice') return typeof value === 'string';
  return false;
}

/**
 * Deterministic ambiguity rule: when several latent traits share the same
 * semantic anchor and disagree, we do NOT arbitrarily pick one for a hard
 * comparison — we skip hard conformance for that question.
 */
function profileConformanceIssues(schema: FormSchema, bundle: DraftBundle): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const results = resultIndex(bundle);
  const traits = Array.isArray(bundle.profile.latentTraits) ? bundle.profile.latentTraits : [];
  const tags = bundle.semantics.structuredQuestionTags;

  for (const question of schema.parts) {
    if (question.kind !== 'linear-scale' && question.kind !== 'single-choice') continue;
    const result = results.get(question.id);
    if (result === undefined || !isAnsweredState(result.state)) continue;

    const tag = tags[question.id];
    if (typeof tag !== 'string' || tag.trim() === '') continue;

    const matching = traits.filter((trait) => trait.anchor === tag && traitMatchesKind(question.kind, trait.value));
    const distinct = [...new Set(matching.map((trait) => JSON.stringify(trait.value)))];
    if (distinct.length !== 1) continue; // ambiguous or absent -> skip (documented rule)

    const expected = matching[0]?.value;
    const actualValue: DraftValue = result.state.value;

    if (question.kind === 'linear-scale') {
      if (typeof expected === 'number' && actualValue.kind === 'linear-scale' && actualValue.value !== expected) {
        issues.push(
          issue(CONSISTENCY_ISSUE_CODES.PROFILE_TRAIT_MISMATCH, 'hard', [question.id], MESSAGES.traitMismatch),
        );
      }
    } else if (question.kind === 'single-choice') {
      if (
        typeof expected === 'string' &&
        question.choices.includes(expected) &&
        actualValue.kind === 'single-choice' &&
        actualValue.value !== expected
      ) {
        issues.push(
          issue(CONSISTENCY_ISSUE_CODES.PROFILE_TRAIT_MISMATCH, 'hard', [question.id], MESSAGES.traitMismatch),
        );
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 4. Answer <-> answer relationship checks (P4-R8, R9, R10).
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };

/** Collapse A->B / B->A repetition relations into one canonical pair. */
function collectRepetitionPairs(
  schema: FormSchema,
  bundle: DraftBundle,
): Array<{ a: string; b: string; confidence: Confidence }> {
  const { byId, order } = schemaIndex(schema);
  const pairs = new Map<string, { a: string; b: string; confidence: Confidence }>();
  const semanticsQuestions = bundle.semantics.questions;

  for (const question of schema.parts) {
    const entry = semanticsQuestions[question.id];
    if (entry === undefined) continue;
    for (const rel of entry.relationships) {
      if (rel.kind !== 'repetition') continue;
      const other = rel.otherQuestionId;
      if (other === question.id || !byId.has(other)) continue;
      const aOrder = order.get(question.id) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = order.get(other) ?? Number.MAX_SAFE_INTEGER;
      const [a, b] = aOrder <= bOrder ? [question.id, other] : [other, question.id];
      const key = `${a}\u0000${b}`;
      const existing = pairs.get(key);
      const confidence =
        existing === undefined
          ? rel.confidence
          : CONFIDENCE_RANK[rel.confidence] >= CONFIDENCE_RANK[existing.confidence]
            ? rel.confidence
            : existing.confidence;
      pairs.set(key, { a, b, confidence });
    }
  }

  const result = [...pairs.values()];
  // Deterministic schema-order sort: first by the lower-order question, then by
  // the higher-order question. Relationship-array order is not semantic meaning
  // and must not influence report order or reportId (FINDING C).
  result.sort((left, right) => {
    const leftA = order.get(left.a) ?? Number.MAX_SAFE_INTEGER;
    const rightA = order.get(right.a) ?? Number.MAX_SAFE_INTEGER;
    if (leftA !== rightA) return leftA - rightA;
    const leftB = order.get(left.b) ?? Number.MAX_SAFE_INTEGER;
    const rightB = order.get(right.b) ?? Number.MAX_SAFE_INTEGER;
    return leftB - rightB;
  });
  return result;
}

function relationshipIssues(schema: FormSchema, bundle: DraftBundle): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const results = resultIndex(bundle);

  for (const pair of collectRepetitionPairs(schema, bundle)) {
    const { a, b, confidence } = pair;
    const questionA = schema.questions[a];
    const questionB = schema.questions[b];
    if (questionA === undefined || questionB === undefined) continue;

    const resultA = results.get(a);
    const resultB = results.get(b);
    const valueA = resultA !== undefined && isAnsweredState(resultA.state) ? resultA.state.value : undefined;
    const valueB = resultB !== undefined && isAnsweredState(resultB.state) ? resultB.state.value : undefined;
    const sameSection = schema.questionSection[a] === schema.questionSection[b];
    const sameKind = questionA.kind === questionB.kind;
    const comparable = sameKind && isComparableKind(questionA.kind);

    if (valueA !== undefined && valueB !== undefined && comparable) {
      const equal = answersEqual(valueA, valueB);
      if (!equal) {
        if (sameSection && confidence === 'high') {
          issues.push(
            issue(CONSISTENCY_ISSUE_CODES.REPETITION_ANSWER_MISMATCH, 'hard', [a, b], MESSAGES.repetitionMismatch),
          );
        } else {
          issues.push(
            issue(CONSISTENCY_ISSUE_CODES.REPETITION_POSSIBLE_MISMATCH, 'soft', [a, b], MESSAGES.repetitionPossible),
          );
        }
      }
    } else {
      issues.push(
        issue(CONSISTENCY_ISSUE_CODES.RELATIONSHIP_NOT_FULLY_CHECKED, 'soft', [a, b], MESSAGES.relationshipUnchecked),
      );
    }
  }

  return issues;
}

/**
 * Evaluate every Phase 4 rule in its stable order and return the ordered issues.
 *
 * Pipeline (FINDING B): integrity first, then required/completeness/state, then
 * profile<->answer and answer<->answer semantic comparison. When the integrity
 * stage has already found a hard schema/bundle integrity failure, the pairing
 * is not safe to compare semantically, so profile and relationship rules are
 * skipped entirely rather than fed ambiguous/stale data.
 */
export function evaluateConsistencyIssues(schema: FormSchema, bundle: DraftBundle): ConsistencyIssue[] {
  const integrity = integrityIssues(schema, bundle);
  const completeness = completenessIssues(schema, bundle);

  if (integrity.length > 0) {
    return [...integrity, ...completeness];
  }

  return [
    ...integrity,
    ...completeness,
    ...profileConformanceIssues(schema, bundle),
    ...relationshipIssues(schema, bundle),
  ];
}
