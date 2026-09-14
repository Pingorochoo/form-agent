/**
 * Answer value model (provider-neutral).
 *
 * The answer layer (Phase 3+) produces `ResolvedAnswer`s; the executor
 * converts them into provider-specific DOM actions. `strategy` records how
 * the answer was produced (deterministic vs LLM vs fallback) for traceability.
 */

import type { FormFieldId } from './types.ts';

export type ChoiceAnswer = string;
export type MultiChoiceAnswer = string[];
export type ScaleAnswer = number;
export type TextAnswer = string;
export type GridAnswer = Record<string, string>;
export type MultiGridAnswer = Record<string, string[]>;

export type AnswerValue =
  | ChoiceAnswer
  | MultiChoiceAnswer
  | ScaleAnswer
  | TextAnswer
  | GridAnswer
  | MultiGridAnswer;

export type AnswerValueKind = 'single-choice' | 'multi-choice' | 'scale' | 'text' | 'grid' | 'multi-grid';

export function answerValueKind(value: AnswerValue): AnswerValueKind {
  if (Array.isArray(value)) return 'multi-choice';
  if (typeof value === 'number') return 'scale';
  if (typeof value === 'string') return 'text';
  const keys = Object.keys(value);
  if (keys.length === 0) return 'grid';
  const first = value[keys[0]!];
  return Array.isArray(first) ? 'multi-grid' : 'grid';
}

export interface AnswerTrace {
  /** Stage that resolved the answer, e.g. 'consistency-conflict', 'validator'. */
  sourceStage: string;
  /** Non-null when an LLM call produced the value (log-trackable). */
  usedProvider: string | null;
  LLMReasoning?: string;
}

export interface ResolvedAnswer {
  questionId: FormFieldId;
  value: AnswerValue;
  /** e.g. 'deterministic' | 'profile-llm' | 'llm' | 'fallback-deterministic'. */
  strategy: string;
  trace: AnswerTrace;
}

export type ResolvedAnswerMap = Record<FormFieldId, ResolvedAnswer>;

export function formatAnswerForLog(value: AnswerValue): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}