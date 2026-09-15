/**
 * Deterministic reference provider (P3-R14, P3-R6).
 *
 * A local, offline provider sufficient to exercise the entire Phase 3
 * orchestration contract before real provider wiring arrives. It performs no
 * network, cloud, local-model, or browser activity; every value is derived
 * deterministically from the accepted form structure, the explicit seed, and
 * this provider's version.
 *
 * Determinism contract: same form + same seed + same provider version ⇒
 * reproducible semantic/profile/draft output. All variation flows through a
 * seeded 32-bit PRNG keyed on (seed, structural fingerprint, provider version,
 * domain separation label) — never implicit randomness or wall-clock time.
 *
 * The provider is generic and schema-derived; it is not hardcoded to the
 * accepted student fixture.
 */

import { createHash } from 'node:crypto';

import type { FormSchema, SingleChoiceQuestion } from '../domain/types.ts';
import { isFreeTextQuestion } from '../domain/types.ts';
import {
  SEMANTIC_MODEL_VERSION,
  type Domain,
  type QuestionSemantics,
  type SectionSemantics,
  type SemanticModel,
  type SemanticRelationship,
  type TargetAudience,
  unknownAudience,
} from '../domain/semantic.ts';
import {
  PROFILE_MODEL_VERSION,
  type LatentTrait,
  type SyntheticFact,
  type SyntheticProfile,
} from '../domain/profile.ts';
import type { DraftAnswerContext, DraftProvider, ProfileBuildContext } from './provider.ts';
import type { DraftValue } from '../domain/draft.ts';
import { DraftValidationError } from './errors.ts';

export const REFERENCE_PROVIDER_ID = 'deterministic-reference' as const;
export const REFERENCE_PROVIDER_VERSION = '1.0.0' as const;

// ---------------------------------------------------------------------------
// Deterministic hashing + PRNG.
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Combine several stable strings into one deterministic hash hex. */
function materialHash(parts: readonly string[]): string {
  return sha256Hex(parts.join('\u0000'));
}

/**
 * Stable, order-independent serialization of the eligible-question id set.
 * Profile content depends on which questions are eligible (blocked questions
 * contribute no latent trait and shift RNG consumption), so this material must
 * be part of the profile identity and RNG seed.
 */
function eligibilityMaterial(ids: ReadonlySet<string>): string {
  return [...ids].sort().join(',');
}

function deriveInt32(hex: string): number {
  return createHash('sha256').update(hex).digest().readInt32BE(0);
}

/** Minimal deterministic 32-bit xorshift PRNG (no implicit randomness). */
class DeterministicRng {
  private state: number;

  constructor(seedHex: string) {
    let s = deriveInt32(seedHex);
    if (s === 0) s = 0x6d2b79f5;
    this.state = s | 0;
  }

  /** Uniform value in [0, 1). */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x | 0;
    return (x >>> 0) / 4294967296;
  }

  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
}

// ---------------------------------------------------------------------------
// Schema-derived helpers (generic, no fixture-specific constants).
// ---------------------------------------------------------------------------

/** Normalize arbitrary title text into a stable, non-empty slug/tag. */
export function asciiSlug(text: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'untitled' : slug;
}

const DOMAIN_KEYWORDS: ReadonlyArray<readonly [Domain, readonly string[]]> = [
  ['education', ['student', 'course', 'class', 'teacher', 'school', 'university', 'professor', 'estudiante', 'clase', 'docente', 'academ']],
  ['healthcare', ['patient', 'doctor', 'health', 'medical', 'clinic', 'salud', 'm[eé]dic']],
  ['workplace', ['employee', 'manager', 'work', 'company', 'job', 'empleado', 'trabaj']],
  ['consumer', ['product', 'purchase', 'customer', 'brand', 'compra', 'cliente']],
  ['technology', ['software', 'app', 'device', 'platform', 'digital']],
  ['community', ['community', 'neighborhood', 'volunteer', 'comunidad']],
] as const;

function allSchemaText(schema: FormSchema): string {
  const pieces: string[] = [schema.title, schema.description ?? ''];
  for (const section of schema.sections) {
    pieces.push(section.title, section.description ?? '');
  }
  for (const q of schema.parts) pieces.push(q.title, q.titleThread);
  return pieces.join('\n');
}

function domainFor(schema: FormSchema): Domain {
  const text = allSchemaText(schema).toLowerCase();
  let best: Domain = 'general-public';
  let bestScore = 0;
  for (const [domain, keywords] of DOMAIN_KEYWORDS) {
    let score = 0;
    for (const keyword of keywords) {
      if (text.includes(keyword)) score += 1;
    }
    if (score > bestScore) {
      best = domain;
      bestScore = score;
    }
  }
  return best;
}

function audienceFor(schema: FormSchema): TargetAudience {
  const domain = domainFor(schema);
  const audience = unknownAudience([`domain keyword scan: ${domain}`]);
  audience.domain = domain;
  audience.confidence = domain === 'general-public' ? 'low' : 'medium';
  return audience;
}

function purposeFor(schema: FormSchema): string {
  if (schema.description !== undefined && schema.description.trim() !== '') {
    return schema.description.trim();
  }
  return `collect structured responses for ${schema.title}`;
}

// ---------------------------------------------------------------------------
// Provider.
// ---------------------------------------------------------------------------

export class DeterministicReferenceProvider implements DraftProvider {
  readonly id = REFERENCE_PROVIDER_ID;
  readonly version = REFERENCE_PROVIDER_VERSION;

  private semanticModelId(schema: FormSchema): string {
    return materialHash([schema.checksum, this.version]);
  }

  interpretForm(schema: FormSchema, _seed: string): SemanticModel {
    const topic = asciiSlug(schema.title);
    const purpose = purposeFor(schema);

    const questions: Record<string, QuestionSemantics> = {};
    const structuredQuestionTags: Record<string, string> = {};
    for (const q of schema.parts) {
      const tag = asciiSlug(q.title);
      structuredQuestionTags[q.id] = tag;
      questions[q.id] = {
        questionId: q.id,
        topic,
        semanticAnswer: { semanticTag: tag, rationale: `derived from question title "${q.title}"` },
        relationships: [],
        freeTextSemantics: isFreeTextQuestion(q)
          ? { intent: 'free-text', keyContent: [tag] }
          : 'unknown',
      };
    }

    // Deterministic relationship detection: identical normalized titles
    // imply repetition. (Only titles are used; no invented semantics.)
    for (const q of schema.parts) {
      const tag = structuredQuestionTags[q.id] as string;
      const entry = questions[q.id];
      if (entry === undefined) continue;
      for (const other of schema.parts) {
        if (other.id === q.id) continue;
        if ((structuredQuestionTags[other.id] as string | undefined) === tag) {
          const relationship: SemanticRelationship = {
            kind: 'repetition',
            otherQuestionId: other.id,
            confidence: 'high',
            note: 'identical normalized question title',
          };
          entry.relationships.push(relationship);
        }
      }
    }

    const sections: Record<string, SectionSemantics> = {};
    for (const section of schema.sections) {
      sections[section.id] = {
        sectionId: section.id,
        meaning: section.title.trim() !== '' ? asciiSlug(section.title) : 'unknown',
        rationale: `derived from section title "${section.title}"`,
        confidence: section.title.trim() !== '' ? 'medium' : 'low',
      };
    }

    return {
      version: SEMANTIC_MODEL_VERSION,
      purpose,
      topic,
      style: 'formal',
      targetAudience: audienceFor(schema),
      questions,
      sections,
      structuredQuestionTags,
      confidence: 'low',
      evidence: [
        `title: ${schema.title}`,
        `sections: ${schema.sections.length}`,
        `questions: ${schema.parts.length}`,
      ],
      metadata: { semanticModelId: this.semanticModelId(schema) },
    };
  }

  buildProfile(context: ProfileBuildContext): SyntheticProfile {
    const { schema, semantics, seed, eligibleQuestionIds } = context;
    const eligibility = eligibilityMaterial(eligibleQuestionIds);
    const rng = new DeterministicRng(
      materialHash([seed, schema.checksum, this.version, 'profile', eligibility]),
    );
    const semanticModelId = this.semanticModelId(schema);
    const profileId = materialHash([schema.checksum, seed, this.version, 'profile-id', eligibility]);

    const ageBands = ['18-24', '25-34', '35-44', '45-54', '55+'] as const;
    const identity = {
      ageBand: rng.pick(ageBands),
      location: 'synthetic-location',
    };

    const facts: SyntheticFact[] = [
      { key: 'respondent_role', value: 'synthetic-respondent', rationale: 'explicit synthetic provenance' },
      { key: 'form_topic', value: typeof semantics.topic === 'string' ? semantics.topic : 'unknown', rationale: 'derived from whole-form semantics' },
    ];

    // Question-answer-like traits are derived ONLY from questions eligible for
    // synthetic drafting (sensitivity already applied by orchestration). A
    // blocked question must never contribute a generated value to the profile.
    const latentTraits: LatentTrait[] = [];
    for (const q of schema.parts) {
      if (!eligibleQuestionIds.has(q.id)) continue;
      const tag = semantics.structuredQuestionTags[q.id] ?? q.id;
      if (q.kind === 'linear-scale') {
        latentTraits.push({
          name: tag,
          anchor: tag,
          value: q.minValue + rng.int(q.maxValue - q.minValue + 1),
          confidence: 'medium',
          rationale: 'synthetic scale attitude derived from the form structure',
        });
      } else if (q.kind === 'single-choice') {
        latentTraits.push({
          name: tag,
          anchor: tag,
          value: q.choices.length > 0 ? rng.pick(q.choices) : 'unknown',
          confidence: 'medium',
          rationale: 'synthetic choice preference derived from the form structure',
        });
      } else if (q.kind === 'multi-choice') {
        latentTraits.push({
          name: tag,
          anchor: tag,
          value: q.choices.length > 0 ? rng.pick(q.choices) : 'unknown',
          confidence: 'medium',
          rationale: 'synthetic preference derived from the form structure',
        });
      }
    }

    return {
      version: PROFILE_MODEL_VERSION,
      profileId,
      formId: schema.formId,
      semanticModelId,
      synthetic: true,
      identity,
      latentTraits,
      facts,
      archetype: 'composite',
    };
  }

  proposeAnswer(context: DraftAnswerContext): DraftValue {
    const { schema, semantics, profile, question, seed } = context;
    const rng = new DeterministicRng(materialHash([seed, schema.checksum, this.version, 'answer', question.id]));
    const tag = semantics.structuredQuestionTags[question.id] ?? question.id;
    const trait = profile.latentTraits.find((t) => t.anchor === tag);
    const role = profile.facts.find((f) => f.key === 'respondent_role')?.value ?? 'synthetic-respondent';

    switch (question.kind) {
      case 'text':
      case 'paragraph-text': {
        const value =
          question.kind === 'text'
            ? `synthetic ${role} response for ${tag}`
            : `synthetic ${role} response for ${tag}: describes ${tag} from the respondent's perspective`;
        return { kind: question.kind, value };
      }
      case 'single-choice': {
        return {
          kind: 'single-choice',
          value: this.preferTraitChoice(trait, question, rng),
        };
      }
      case 'multi-choice': {
        const count = question.choices.length === 0 ? 0 : 1 + rng.int(question.choices.length);
        const selected: string[] = [];
        const used = new Set<string>();
        while (selected.length < count && used.size < question.choices.length) {
          const candidate = rng.pick(question.choices);
          if (!used.has(candidate)) {
            used.add(candidate);
            selected.push(candidate);
          }
        }
        return { kind: 'multi-choice', value: selected };
      }
      case 'linear-scale': {
        const traitValue = typeof trait?.value === 'number' ? trait.value : undefined;
        const value =
          traitValue !== undefined
            ? Math.min(question.maxValue, Math.max(question.minValue, traitValue))
            : question.minValue + rng.int(question.maxValue - question.minValue + 1);
        return { kind: 'linear-scale', value };
      }
      case 'multiple-choice-grid': {
        const value: Record<string, string> = {};
        for (const row of question.rows) {
          value[row.id] = question.choices.length > 0 ? rng.pick(question.choices) : '';
        }
        return { kind: 'multiple-choice-grid', value };
      }
      case 'date': {
        const value = {
          year: 1980 + rng.int(30),
          month: 1 + rng.int(12),
          day: 1 + rng.int(28),
        };
        return { kind: 'date', value };
      }
      case 'time': {
        return { kind: 'time', value: { hour: rng.int(24), minute: rng.int(60) } };
      }
      default:
        throw new DraftValidationError(
          `reference provider cannot propose an answer for unsupported question kind "${question.kind}"`,
        );
    }
  }

  /** Prefer a profile trait value when it is a real choice, else pick one. */
  private preferTraitChoice(
    trait: LatentTrait | undefined,
    question: SingleChoiceQuestion,
    rng: DeterministicRng,
  ): string {
    if (trait !== undefined && typeof trait.value === 'string' && question.choices.includes(trait.value)) {
      return trait.value;
    }
    return question.choices.length > 0 ? rng.pick(question.choices) : '';
  }
}
