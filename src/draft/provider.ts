/**
 * Provider-neutral semantic/profile/draft provider boundary (P3-R13, P3-R2).
 *
 * This is a distinct, higher-level abstraction from the raw text-chat boundary
 * in `src/llm/`: it produces structured domain objects (`SemanticModel`,
 * `SyntheticProfile`, `DraftValue`) rather than raw chat text. Phase 3 wires
 * one deterministic reference implementation (`src/draft/reference.ts`);
 * Phase 6 will provide real provider implementations against this same
 * boundary without rewriting the orchestration pipeline.
 *
 * Provider methods return `MaybePromise<T>` so a deterministic reference
 * implementation can stay synchronous while real cloud/local-model providers
 * (Phase 6) can be asynchronous — without changing orchestration.
 */

import type { FormSchema, Question } from '../domain/types.ts';
import type { SemanticModel } from '../domain/semantic.ts';
import type { SyntheticProfile } from '../domain/profile.ts';
import type { DraftValue } from '../domain/draft.ts';

/** A provider-neutral value that may be produced synchronously or asynchronously. */
export type MaybePromise<T> = T | Promise<T>;

/** Everything one answer-generation operation must receive (P3-R15). */
export interface DraftAnswerContext {
  schema: FormSchema;
  semantics: SemanticModel;
  profile: SyntheticProfile;
  question: Question;
  seed: string;
}

/**
 * Everything profile generation must receive. `eligibleQuestionIds` is the
 * sensitivity-filtered set of questions eligible for synthetic drafting
 * (computed by orchestration *before* profile generation, P3-R8/P3-R2). A
 * provider must not derive question-answer-like profile traits from questions
 * outside this set.
 */
export interface ProfileBuildContext {
  schema: FormSchema;
  semantics: SemanticModel;
  seed: string;
  /** Question ids eligible for synthetic drafting (sensitivity already applied). */
  eligibleQuestionIds: ReadonlySet<string>;
}

export interface DraftProvider {
  /** Stable provider identity (part of the deterministic contract). */
  readonly id: string;
  /** Stable provider version (part of the deterministic contract). */
  readonly version: string;

  /** Produce whole-form semantics from the structural schema. */
  interpretForm(schema: FormSchema, seed: string): MaybePromise<SemanticModel>;

  /** Derive one generic synthetic respondent profile from the schema + semantics. */
  buildProfile(context: ProfileBuildContext): MaybePromise<SyntheticProfile>;

  /**
   * Propose a draft value for one eligible question. Output is a raw proposal
   * and MUST be structurally validated before becoming an accepted answer.
   */
  proposeAnswer(context: DraftAnswerContext): MaybePromise<DraftValue>;
}
