/**
 * Compact structured stage input for the openai-compatible draft provider
 * (P6-R6, docs/PHASE_6.md §6).
 *
 * These DTOs carry only the domain data a stage needs to produce validated
 * output. They never include raw HTML, cookies/storage, authorization rows,
 * rate rows, execution receipts, target URL query/userinfo, policy regex
 * bodies, or API keys. Question/row/option ids are preserved so downstream
 * validation can reject invented identifiers.
 */

import type { FormSchema, Question } from '../domain/types.ts';
import type { SyntheticProfile } from '../domain/profile.ts';
import type { DraftAnswerContext, ProfileBuildContext } from './provider.ts';

function questionDto(question: Question): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: question.id,
    kind: question.kind,
    title: question.title,
    required: question.required === 'required',
  };
  if ('choices' in question && Array.isArray(question.choices)) {
    base['choices'] = question.choices;
  }
  if (question.kind === 'linear-scale') {
    base['minValue'] = question.minValue;
    base['maxValue'] = question.maxValue;
    base['minLabel'] = question.minLabel;
    base['maxLabel'] = question.maxLabel;
  }
  if (question.kind === 'multiple-choice-grid' || question.kind === 'checkbox-grid') {
    base['rows'] = question.rows.map((row) => ({ id: row.id, label: row.label }));
    base['choices'] = question.choices;
  }
  return base;
}

/** Compact whole-form input for the semantics stage. */
export function semanticsStageInput(schema: FormSchema): Record<string, unknown> {
  return {
    formId: schema.formId,
    title: schema.title,
    description: schema.description ?? '',
    sections: schema.sections.map((section) => ({
      id: section.id,
      title: section.title,
      description: section.description ?? '',
      order: section.index,
      questionIds: [...section.questionIds],
    })),
    questions: schema.parts.map(questionDto),
  };
}

/** Compact profile-stage input (sensitivity already applied by orchestration). */
export function profileStageInput(context: ProfileBuildContext): Record<string, unknown> {
  const { schema, semantics, eligibleQuestionIds } = context;
  const eligible = [...eligibleQuestionIds].sort();
  return {
    formId: schema.formId,
    seed: context.seed,
    purpose: semantics.purpose,
    topic: semantics.topic,
    targetAudience: semantics.targetAudience,
    eligibleQuestionIds: eligible,
    eligibleQuestions: schema.parts
      .filter((question) => eligibleQuestionIds.has(question.id))
      .map((question) => ({ id: question.id, kind: question.kind, title: question.title })),
  };
}

/** Compact per-question input for the answer stage. */
export function answerStageInput(context: DraftAnswerContext): Record<string, unknown> {
  const { schema, semantics, profile, question, seed } = context;
  const semanticTag = semantics.structuredQuestionTags[question.id] ?? question.id;
  return {
    formId: schema.formId,
    seed,
    question: questionDto(question),
    semanticTag,
    profile: compactProfile(profile),
  };
}

function compactProfile(profile: SyntheticProfile): Record<string, unknown> {
  return {
    identity: profile.identity,
    facts: profile.facts,
    latentTraits: profile.latentTraits,
  };
}
