/**
 * Semantic model of the whole form (refinement #2).
 *
 * The analyzer must produce ONE semantic model for the entire form and
 * persist it together with the structural analysis. It is computed once per
 * structural fingerprint and reused for every synthetic profile; it is never
 * re-inferred per profile.
 *
 * TargetAudience (refinement #3) is a structured model. `hardConstraints`
 * are strongly implied or explicitly required; `softConstraints` are
 * plausible tendencies that may influence profile distributions but must
 * never become mandatory. When there is not enough evidence for a dimension,
 * the analyzer must say `unknown` rather than invent a narrow demographic.
 *
 * Extensible semantic attributes may be added later as serialized JSON
 * metadata on the persisted semantic payload, without schema changes.
 */

import type { Confidence } from './types.ts';

export const SEMANTIC_MODEL_VERSION = 1 as const;

export type SemanticAttribute<T> = T | 'unknown';

/**
 * A trait supported by evidence. `confidence` is low/medium/high; `evidence`
 * lists the source fragments (title, description, question text, options) the
 * trait was derived from.
 */
export interface EvidenceScored {
  confidence: Confidence;
  evidence: string[];
}

export type Domain =
  | 'education'
  | 'healthcare'
  | 'workplace'
  | 'consumer'
  | 'community'
  | 'technology'
  | 'general-public'
  | 'other';

export type LikelyGroup =
  | 'general-public'
  | 'employees'
  | 'current-patients'
  | 'psychology-patients'
  | 'students'
  | 'parents'
  | 'gamers'
  | 'young-adults'
  | 'customers'
  | 'other';

export interface AudienceDimension<T extends string> extends EvidenceScored {
  value: SemanticAttribute<T>;
}

export interface TargetAudience {
  /** What the form's subject domain is, e.g. 'workplace-feedback'. */
  domain: SemanticAttribute<Domain>;
  /** Where the respondent is situated, e.g. 'a software company'. */
  setting: SemanticAttribute<string>;
  /** Explicit candidate groups (see LikelyGroup). */
  likelyGroups: AudienceDimension<LikelyGroup>[];
  /** Likely age range, e.g. '25-45' when supported, else 'unknown'. */
  likelyAgeRange: SemanticAttribute<string>;
  /** Roles the respondent plausibly plays, e.g. 'staff', 'manager'. */
  roles: AudienceDimension<string>[];
  /** Interests relevant to the form topic. */
  relevantInterests: AudienceDimension<string>[];
  /** Strongly implied or explicitly required audience traits. */
  hardConstraints: AudienceDimension<string>[];
  /** Plausible tendencies that may shift distributions, never mandatory. */
  softConstraints: AudienceDimension<string>[];
  /** Overall confidence in the audience inference. */
  confidence: Confidence;
  /** Why the audience is broad/unknown where it is. */
  evidence: string[];
}

export interface SemanticAnswer {
  /** Resolved meaning of the question, e.g. 'job_satisfaction'. */
  semanticTag: string;
  /** Why the tag was chosen. */
  rationale: string;
}

export interface QuestionSemantics {
  questionId: string;
  /** Form-level topic thread the question belongs to, e.g. 'company-culture'. */
  topic: SemanticAttribute<string>;
  semanticAnswer: SemanticAnswer;
  /** Explicit relationships to other questions detected by the analyzer. */
  relationships: SemanticRelationship[];
  /** Free-text essay/comment marker; other fields remain semantic-less. */
  freeTextSemantics: SemanticAttribute<{
    intent: string;
    keyContent?: string[];
  }>;
}

export interface SemanticRelationship {
  kind: 'repetition' | 'rephrase' | 'inverse' | 'related-attitude' | 'dependency';
  otherQuestionId: string;
  confidence: Confidence;
  note?: string;
}

/**
 * Section-level meaning (Phase 3, P3-R3). The whole-form semantic model must
 * be able to describe what each section/page of the form is for, not just the
 * form as a whole and its individual questions.
 */
export interface SectionSemantics {
  sectionId: string;
  /** What the section is about / its role in the form. */
  meaning: SemanticAttribute<string>;
  rationale: string;
  confidence: Confidence;
}

export interface SemanticModel {
  version: typeof SEMANTIC_MODEL_VERSION;
  /** What the form as a whole is about. */
  purpose: SemanticAttribute<string>;
  /** Topic the form addresses, e.g. 'employee-engagement'. */
  topic: SemanticAttribute<string>;
  /** Form's tone/style, e.g. 'formal' | 'casual'. */
  style: SemanticAttribute<string>;
  /** Inferred target audience (refinement #3). */
  targetAudience: TargetAudience;
  /** Per-question semantics (refinement #2: one model per form). */
  questions: Record<string, QuestionSemantics>;
  /** Per-section semantics keyed by section id (Phase 3, P3-R3). */
  sections?: Record<string, SectionSemantics>;
  /** Structured question semantic tags available for option reasoning. */
  structuredQuestionTags: Record<string, string>;
  /** Overall confidence in the semantic model. */
  confidence: Confidence;
  /** Global evidence fragments; question-level evidence lives per question. */
  evidence: string[];
  /** Reserved for extensible semantic attributes (serialized JSON metadata). */
  metadata?: Record<string, unknown>;
}

/**
 * A strictly-inferred audience where every dimension is explicitly
 * `unknown` — the approved "broad/unknown instead of inventing" case.
 */
export function unknownAudience(evidence: string[] = []): TargetAudience {
  return {
    domain: 'unknown',
    setting: 'unknown',
    likelyGroups: [],
    likelyAgeRange: 'unknown',
    roles: [],
    relevantInterests: [],
    hardConstraints: [],
    softConstraints: [],
    confidence: 'low',
    evidence,
  };
}