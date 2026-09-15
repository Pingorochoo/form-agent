/**
 * Safe draft-provider provenance (P6-R12, docs/PHASE_6.md §18).
 *
 * A stable, secret-free description of what produced a DraftBundle, and a
 * content-bound hash over that description. The hash binds provider id/version,
 * model label, prompt-contract versions, and a normalized endpoint identity so
 * that tampering with any persisted provenance field cannot silently preserve
 * an approved snapshot (P6-R17).
 *
 * Never stores credentials or raw endpoint secrets: only the provider id,
 * version, a safe model label, prompt-contract version strings, and a SHA-256
 * hash of the normalized endpoint URL (which already rejects userinfo/query/
 * fragment).
 */

import { createHash } from 'node:crypto';
import { FORM_SEMANTICS_PROMPT_VERSION, SYNTHETIC_PROFILE_PROMPT_VERSION, ANSWER_DRAFT_PROMPT_VERSION } from './prompts.ts';
import { REFERENCE_PROVIDER_ID, REFERENCE_PROVIDER_VERSION } from './reference.ts';
import { OPENAI_COMPATIBLE_PROVIDER_ID, OPENAI_COMPATIBLE_PROVIDER_VERSION } from './openai-compatible.ts';

export interface DraftProviderProvenance {
  providerId: string;
  providerVersion: string;
  /** Safe model label, or null for the network-free reference provider. */
  modelLabel: string | null;
  /** Stable per-stage prompt-contract versions ('' for the reference provider). */
  promptContractVersions: string;
  /** Safe endpoint identity hash for the real provider, or null. */
  endpointHash: string | null;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** A stable string form of the real-provider prompt-contract versions. */
export function openAiPromptContractVersions(): string {
  return [
    `semantics=${FORM_SEMANTICS_PROMPT_VERSION}`,
    `profile=${SYNTHETIC_PROFILE_PROMPT_VERSION}`,
    `answer=${ANSWER_DRAFT_PROMPT_VERSION}`,
  ].join(';');
}

/** Content-bound hash over the provenance material (never over raw values). */
export function provenanceHash(provenance: DraftProviderProvenance): string {
  return sha256Hex(
    [
      provenance.providerId,
      provenance.providerVersion,
      provenance.modelLabel ?? '',
      provenance.promptContractVersions,
      provenance.endpointHash ?? '',
    ].join('\u0000'),
  );
}

/** The provenance of the deterministic reference provider. */
export function referenceProvenance(): DraftProviderProvenance {
  return {
    providerId: REFERENCE_PROVIDER_ID,
    providerVersion: REFERENCE_PROVIDER_VERSION,
    modelLabel: null,
    promptContractVersions: '',
    endpointHash: null,
  };
}

/** The provenance of an openai-compatible provider instance. */
export function openAiProvenance(model: string, endpointUrl: string): DraftProviderProvenance {
  return {
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    providerVersion: OPENAI_COMPATIBLE_PROVIDER_VERSION,
    modelLabel: model,
    promptContractVersions: openAiPromptContractVersions(),
    endpointHash: sha256Hex(endpointUrl),
  };
}
