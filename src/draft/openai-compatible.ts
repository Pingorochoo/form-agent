/**
 * OpenAI-compatible draft provider (P6-R2, R3, R8, R12).
 *
 * The first real network LLM implementation against the accepted Phase 3
 * `DraftProvider` boundary. It wires the model into the exact three accepted
 * stages — whole-form semantics, synthetic profile, per-question answer — and
 * does NOT create a parallel pipeline. Each stage makes at most ONE remote
 * request, parses the JSON-only model output strictly, and returns structured
 * objects that the accepted orchestrators validators still gate (P6-R8).
 *
 * Provider identity participates in draft identity (P6-R12): the provider id,
 * provider version, model, per-stage prompt-contract version, and the exact
 * model output all flow into `semanticModelId` / `profileId`, which the accepted
 * `generateDraft` already folds into `draftId`. Credentials never participate.
 *
 * The model output is untrusted: malformed JSON, a non-object, or a
 * structurally invalid stage object fails closed with `LLM_OUTPUT_INVALID`.
 * No automatic repair, no second model attempt.
 */

import { createHash } from 'node:crypto';

import type { FormSchema } from '../domain/types.ts';
import { SEMANTIC_MODEL_VERSION, type SemanticModel } from '../domain/semantic.ts';
import { PROFILE_MODEL_VERSION, type SyntheticProfile } from '../domain/profile.ts';
import type { DraftValue } from '../domain/draft.ts';
import type { DraftAnswerContext, DraftProvider, ProfileBuildContext } from './provider.ts';
import type { NormalizedEndpoint } from '../llm/endpoint.ts';
import { openAiChatCompletions, type OpenAiCompatibleTransportConfig } from '../llm/openai-compatible.ts';
import { LlmProviderError, LLM_ERROR_CODES } from '../llm/errors.ts';
import type { LlmCallAuditEntry } from '../llm/audit.ts';
import {
  ANSWER_DRAFT_PROMPT_VERSION,
  FORM_SEMANTICS_PROMPT_VERSION,
  SYNTHETIC_PROFILE_PROMPT_VERSION,
  answerDraftSystemPrompt,
  formSemanticsSystemPrompt,
  syntheticProfileSystemPrompt,
} from './prompts.ts';
import { answerStageInput, profileStageInput, semanticsStageInput } from './stage-dto.ts';

export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible' as const;
export const OPENAI_COMPATIBLE_PROVIDER_VERSION = '1.0.0' as const;

const ARCHETYPES = new Set(['composite', 'adversarial', 'edge-case']);

export interface OpenAiCompatibleDraftProviderOptions {
  model: string;
  endpoint: NormalizedEndpoint;
  apiKey: string | null;
  timeoutMs: number;
  maxOutputTokens: number | undefined;
  maxResponseBytes: number;
  fetchImpl?: typeof fetch;
  /** Optional safe audit hook (run flow persists safe metadata to llm_calls). */
  recordCall?: (entry: LlmCallAuditEntry) => void;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class OpenAiCompatibleDraftProvider implements DraftProvider {
  readonly id = OPENAI_COMPATIBLE_PROVIDER_ID;
  readonly version = OPENAI_COMPATIBLE_PROVIDER_VERSION;
  readonly model: string;

  private readonly transport: OpenAiCompatibleTransportConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly recordCall: ((entry: LlmCallAuditEntry) => void) | undefined;

  constructor(options: OpenAiCompatibleDraftProviderOptions) {
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.recordCall = options.recordCall;
    this.transport = {
      endpoint: options.endpoint,
      model: options.model,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      maxOutputTokens: options.maxOutputTokens,
      maxResponseBytes: options.maxResponseBytes,
    };
  }

  private async call(stage: string, system: string, user: string): Promise<string> {
    let result;
    try {
      result = await openAiChatCompletions(
        this.transport,
        { system, user },
        this.fetchImpl,
      );
    } catch (err) {
      // Audit persistence must never replace or alter the stable transport
      // error, and must never leak a raw exception (P6-R11).
      if (err instanceof LlmProviderError) {
        this.safeRecordCall({
          providerId: this.id,
          model: this.model,
          stage,
          status: 'error',
          errorCode: err.code,
        });
        throw err;
      }
      this.safeRecordCall({ providerId: this.id, model: this.model, stage, status: 'error' });
      throw new LlmProviderError(LLM_ERROR_CODES.OFFLINE, 'LLM provider failed during stage');
    }

    this.safeRecordCall({
      providerId: this.id,
      model: this.model,
      stage,
      status: 'success',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      durationMs: result.latencyMs,
      finishReason: result.finishReason,
    });
    return result.content;
  }

  /**
   * Invoke the audit hook without ever letting its failure corrupt provider
   * transport/error semantics or leak a raw secret-bearing exception.
   */
  private safeRecordCall(entry: LlmCallAuditEntry): void {
    try {
      this.recordCall?.(entry);
    } catch {
      // Audit is best-effort; swallow any hook failure by design.
    }
  }

  /** Parse JSON-only model output into a plain object; fail closed otherwise. */
  private parseStageObject(content: string, stage: string): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new LlmProviderError(LLM_ERROR_CODES.OUTPUT_INVALID, `LLM ${stage} output was not valid JSON`);
    }
    if (!isRecord(parsed)) {
      throw new LlmProviderError(LLM_ERROR_CODES.OUTPUT_INVALID, `LLM ${stage} output was not a JSON object`);
    }
    return parsed;
  }

  private identityMaterial(parts: string[]): string {
    return parts.join('\u0000');
  }

  /**
   * Stable safe provenance that participates in semantic/profile identity
   * (P6-R12). Includes provider id/version, model, every prompt-contract
   * version, and a hash of the normalized endpoint (so two endpoints serving an
   * identical model label remain distinguishable). Never includes credentials.
   */
  private provenance(): string {
    const endpointHash = sha256Hex(this.transport.endpoint.chatCompletionsUrl);
    return this.identityMaterial([
      this.id,
      this.version,
      this.model,
      FORM_SEMANTICS_PROMPT_VERSION,
      SYNTHETIC_PROFILE_PROMPT_VERSION,
      ANSWER_DRAFT_PROMPT_VERSION,
      endpointHash,
    ]);
  }

  async interpretForm(schema: FormSchema, _seed: string): Promise<SemanticModel> {
    const content = await this.call(
      'semantics',
      formSemanticsSystemPrompt(),
      JSON.stringify(semanticsStageInput(schema)),
    );
    const output = this.parseStageObject(content, 'semantics');

    // Stage-shape validation (P6-R8): the orchestrator still enforces exact
    // schema coverage, but a grossly malformed object fails closed here.
    if (!isRecord(output['questions'])) {
      throw new LlmProviderError(LLM_ERROR_CODES.OUTPUT_INVALID, 'LLM semantics output is missing a questions record');
    }
    if (!isRecord(output['sections'])) {
      throw new LlmProviderError(LLM_ERROR_CODES.OUTPUT_INVALID, 'LLM semantics output is missing a sections record');
    }
    if (!isRecord(output['structuredQuestionTags'])) {
      throw new LlmProviderError(LLM_ERROR_CODES.OUTPUT_INVALID, 'LLM semantics output is missing structuredQuestionTags');
    }

    const semanticModelId = sha256Hex(
      this.identityMaterial([this.provenance(), schema.checksum, content]),
    );

    return {
      ...(output as Partial<SemanticModel>),
      version: SEMANTIC_MODEL_VERSION,
      metadata: { ...(isRecord(output['metadata']) ? output['metadata'] : {}), semanticModelId },
    } as SemanticModel;
  }

  async buildProfile(context: ProfileBuildContext): Promise<SyntheticProfile> {
    const content = await this.call(
      'profile',
      syntheticProfileSystemPrompt(),
      JSON.stringify(profileStageInput(context)),
    );
    const output = this.parseStageObject(content, 'profile');

    if (!isRecord(output['identity'])) {
      throw new LlmProviderError(LLM_ERROR_CODES.OUTPUT_INVALID, 'LLM profile output is missing an identity object');
    }
    if (!Array.isArray(output['latentTraits'])) {
      throw new LlmProviderError(LLM_ERROR_CODES.OUTPUT_INVALID, 'LLM profile output is missing a latentTraits array');
    }
    if (!Array.isArray(output['facts'])) {
      throw new LlmProviderError(LLM_ERROR_CODES.OUTPUT_INVALID, 'LLM profile output is missing a facts array');
    }
    if (typeof output['archetype'] !== 'string' || !ARCHETYPES.has(output['archetype'])) {
      throw new LlmProviderError(LLM_ERROR_CODES.OUTPUT_INVALID, 'LLM profile output has an invalid archetype');
    }

    const semanticModelId = context.semantics.metadata?.semanticModelId;
    const semanticModelIdString = typeof semanticModelId === 'string' ? semanticModelId : '';

    const profileId = sha256Hex(
      this.identityMaterial([
        this.provenance(),
        context.schema.checksum,
        context.seed,
        semanticModelIdString,
        content,
      ]),
    );

    return {
      version: PROFILE_MODEL_VERSION,
      profileId,
      formId: context.schema.formId,
      semanticModelId: semanticModelIdString,
      synthetic: true,
      identity: output['identity'] as SyntheticProfile['identity'],
      latentTraits: output['latentTraits'] as SyntheticProfile['latentTraits'],
      facts: output['facts'] as SyntheticProfile['facts'],
      archetype: output['archetype'] as SyntheticProfile['archetype'],
    };
  }

  async proposeAnswer(context: DraftAnswerContext): Promise<DraftValue> {
    const content = await this.call(
      'answer',
      answerDraftSystemPrompt(),
      JSON.stringify(answerStageInput(context)),
    );
    const output = this.parseStageObject(content, 'answer');
    if (typeof output['kind'] !== 'string') {
      throw new LlmProviderError(LLM_ERROR_CODES.OUTPUT_INVALID, 'LLM answer output is missing a kind discriminator');
    }
    if (!('value' in output)) {
      throw new LlmProviderError(LLM_ERROR_CODES.OUTPUT_INVALID, 'LLM answer output is missing a value');
    }
    // The accepted orchestration validates `value` against the real question.
    return output as unknown as DraftValue;
  }
}
