/**
 * Draft-provider resolution (P6-R2, R4, R5, docs/PHASE_6.md §10/§11).
 *
 * Selects the accepted `DraftProvider` for draft-producing flows. `reference`
 * (default, network-free) is always available; `openai-compatible` is resolved
 * from the `llm.providers.openai-compatible` config, with safe secret
 * resolution from the environment at call time. No API-key value is ever stored
 * in config, and no secret participates in any persisted identity.
 *
 * All endpoint/config validation happens here, before any browser or network
 * activity, so a misconfigured provider fails fast with a stable
 * `LlmProviderError` rather than after opening an execution target.
 */

import type { AppConfig, LlmProviderConfig } from '../config/schema.ts';
import {
  DEFAULT_LLM_MAX_RESPONSE_BYTES,
  DEFAULT_LLM_TIMEOUT_MS,
} from '../config/schema.ts';
import type { DraftProvider } from './provider.ts';
import { DeterministicReferenceProvider } from './reference.ts';
import { OpenAiCompatibleDraftProvider } from './openai-compatible.ts';
import { normalizeOpenAiEndpoint } from '../llm/endpoint.ts';
import { LlmProviderError, LLM_ERROR_CODES } from '../llm/errors.ts';
import type { LlmCallAuditEntry } from '../llm/audit.ts';
import { openAiProvenance, referenceProvenance, type DraftProviderProvenance } from './provenance.ts';

export type DraftProviderKind = 'reference' | 'openai-compatible';

const DRAFT_PROVIDER_KINDS: readonly DraftProviderKind[] = ['reference', 'openai-compatible'];

export function isDraftProviderKind(value: string): value is DraftProviderKind {
  return (DRAFT_PROVIDER_KINDS as readonly string[]).includes(value);
}

export interface ResolvedDraftProvider {
  provider: DraftProvider;
  kind: DraftProviderKind;
  /** Safe model/provider label for operator output + snapshot provenance. */
  modelLabel: string | null;
  /** Stable, secret-free provider provenance (operator output + snapshot binding). */
  provenance: DraftProviderProvenance;
}

export interface ResolveDraftProviderOptions {
  config: AppConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  recordCall?: (entry: LlmCallAuditEntry) => void;
}

function openAiProviderConfig(config: AppConfig): LlmProviderConfig {
  const provider = config.llm.providers['openai-compatible'];
  if (provider === undefined) {
    throw new LlmProviderError(
      LLM_ERROR_CODES.PROVIDER_CONFIG_INVALID,
      'draft provider "openai-compatible" is not defined under llm.providers',
    );
  }
  if (!provider.enabled) {
    throw new LlmProviderError(
      LLM_ERROR_CODES.PROVIDER_CONFIG_INVALID,
      'draft provider "openai-compatible" is disabled in configuration',
    );
  }
  return provider;
}

function resolveApiKey(provider: LlmProviderConfig, env: NodeJS.ProcessEnv): string | null {
  if (provider.apiKeyEnv === undefined || provider.apiKeyEnv.trim() === '') {
    return null;
  }
  const value = env[provider.apiKeyEnv];
  if (value === undefined || value === '') {
    throw new LlmProviderError(
      LLM_ERROR_CODES.SECRET_MISSING,
      `LLM provider requires the environment variable ${provider.apiKeyEnv}`,
    );
  }
  return value;
}

/**
 * Resolve the DraftProvider for `kind` (defaulting to `config.llm.draftProvider`
 * when omitted). Throws stable `LlmProviderError`s for config/secret/endpoint
 * violations; never performs network I/O here.
 */
export function resolveDraftProvider(
  kind: DraftProviderKind | undefined,
  options: ResolveDraftProviderOptions,
): ResolvedDraftProvider {
  const selected = kind ?? options.config.llm.draftProvider;
  const env = options.env ?? process.env;

  if (selected === 'reference') {
    return { provider: new DeterministicReferenceProvider(), kind: 'reference', modelLabel: null, provenance: referenceProvenance() };
  }

  if (selected !== 'openai-compatible') {
    throw new LlmProviderError(
      LLM_ERROR_CODES.PROVIDER_CONFIG_INVALID,
      `unknown draft provider "${String(selected)}" (expected reference or openai-compatible)`,
    );
  }

  const provider = openAiProviderConfig(options.config);

  if (provider.baseUrl === undefined || provider.baseUrl.trim() === '') {
    throw new LlmProviderError(
      LLM_ERROR_CODES.PROVIDER_CONFIG_INVALID,
      'draft provider "openai-compatible" requires baseUrl',
    );
  }
  if (provider.model === undefined || provider.model.trim() === '') {
    throw new LlmProviderError(
      LLM_ERROR_CODES.PROVIDER_CONFIG_INVALID,
      'draft provider "openai-compatible" requires a model',
    );
  }

  const endpoint = normalizeOpenAiEndpoint(provider.baseUrl);
  if (endpoint.classification === 'remote' && !provider.allowRemote) {
    throw new LlmProviderError(
      LLM_ERROR_CODES.REMOTE_NOT_ALLOWED,
      'LLM endpoint is not loopback; set allowRemote: true to permit data egress',
    );
  }

  const apiKey = resolveApiKey(provider, env);

  const draftProvider = new OpenAiCompatibleDraftProvider({
    model: provider.model,
    endpoint,
    apiKey,
    timeoutMs: provider.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    maxOutputTokens: provider.maxOutputTokens,
    maxResponseBytes: provider.maxResponseBytes ?? DEFAULT_LLM_MAX_RESPONSE_BYTES,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.recordCall !== undefined ? { recordCall: options.recordCall } : {}),
  });

  return {
    provider: draftProvider,
    kind: 'openai-compatible',
    modelLabel: provider.model,
    provenance: openAiProvenance(provider.model, endpoint.chatCompletionsUrl),
  };
}
