/**
 * Synthetic profile model (refinement #4).
 *
 * A profile carries both general identity/context attributes and
 * form-specific latent traits derived from the cached SemanticModel. For a
 * workplace survey the latent traits might be: job satisfaction, stress,
 * relationship with coworkers, relationship with management, salary
 * perception, intention to leave. For a different form type the traits
 * differ. Profiles are shuffled deterministically (Phase 3); each submission
 * gets a distinct profile while every answer derived from it stays coherent.
 */

import type { Confidence } from './types.ts';

export const PROFILE_MODEL_VERSION = 1 as const;

export interface ProfileIdentity {
  /** Broad demographic bands only (never real PII). */
  ageBand?: string;
  gender?: 'male' | 'female' | 'non-binary' | 'prefer-not-to-say';
  location?: string;
  selfDescribed?: string;
}

/** A latent trait; `anchor` drives distributions, `value` can be a band. */
export interface LatentTrait {
  name: string;
  /** e.g. 'job_satisfaction'. */
  anchor: string;
  value: string | number | boolean;
  confidence: Confidence;
  /** Why this trait was inferred (tied to SemanticModel evidence). */
  rationale: string;
}

/**
 * A single synthetic fact (Phase 3, P3-R5). Provider-neutral, form-dependent
 * synthetic state: facts, preferences, experiences and constraints are all
 * representable as named facts without inventing real-PII categories.
 */
export interface SyntheticFact {
  key: string;
  value: string | number | boolean;
  /** Why this fact was established (tied to semantic context). */
  rationale: string;
}

export interface SyntheticProfile {
  version: typeof PROFILE_MODEL_VERSION;
  profileId: string;
  formId: string;
  /** The semantic model snapshot used to derive this profile. */
  semanticModelId: string;
  /** Explicit synthetic-provenance marker (Phase 3, P3-R12). */
  synthetic: true;
  identity: ProfileIdentity;
  /** Form-specific latent traits (refinement #4). */
  latentTraits: LatentTrait[];
  /** Form-dependent synthetic facts/preferences/experiences/constraints (P3-R5). */
  facts: SyntheticFact[];
  /** How distinct/central this persona is; drives variation. */
  archetype: 'composite' | 'adversarial' | 'edge-case';
  metadata?: Record<string, unknown>;
}