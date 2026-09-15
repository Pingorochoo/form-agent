/**
 * LLM endpoint classification + validation (P6-R4, P6-R5, docs/PHASE_6.md §7/§10).
 *
 * Pure, dependency-free helpers. The data-egress boundary is deliberately
 * conservative: only true loopback is implicitly trusted. Any other host —
 * including LAN and RFC1918 private addresses — requires explicit remote
 * opt-in (`allowRemote: true`). This is a data boundary, not an internet
 * boundary, so "private IP" is never silently treated as local.
 *
 * Rejected outright:
 *   - URL userinfo (credentials embedded in the endpoint);
 *   - URL query/fragment (never part of the endpoint identity or request path);
 *   - non-http(s) schemes.
 */

import { LlmProviderError, LLM_ERROR_CODES } from './errors.ts';

export type EndpointClassification = 'loopback' | 'remote';

/** Normalize an IPv4/IPv6 literal by stripping `[]` brackets. */
function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** True for localhost, 127.0.0.0/8, and IPv6 ::1. Everything else is remote. */
export function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === 'localhost' || host === '::1') return true;
  const parts = host.split('.');
  if (parts.length === 4 && parts[0] === '127') {
    return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
  }
  return false;
}

export function classifyEndpoint(url: URL): EndpointClassification {
  return isLoopbackHost(url.hostname) ? 'loopback' : 'remote';
}

export interface NormalizedEndpoint {
  /** The full `.../chat/completions` URL used for the request. */
  chatCompletionsUrl: string;
  classification: EndpointClassification;
}

/**
 * Validate + normalize an OpenAI-compatible base URL into the final
 * `POST <baseUrl>/chat/completions` endpoint (P6-R4, docs/PHASE_6.md §7).
 *
 * Rejects userinfo, query, fragment, and unsupported schemes; collapses
 * redundant `/chat/completions` suffixes so `.../v1/chat/completions` does not
 * double-append. Never mutates or echoes secret-bearing URL components.
 */
export function normalizeOpenAiEndpoint(baseUrl: string): NormalizedEndpoint {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new LlmProviderError(
      LLM_ERROR_CODES.PROVIDER_CONFIG_INVALID,
      'LLM baseUrl is not a valid URL',
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new LlmProviderError(
      LLM_ERROR_CODES.PROVIDER_CONFIG_INVALID,
      'LLM baseUrl must use http or https',
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new LlmProviderError(
      LLM_ERROR_CODES.PROVIDER_CONFIG_INVALID,
      'LLM baseUrl must not contain userinfo (username/password)',
    );
  }
  if (parsed.search !== '') {
    throw new LlmProviderError(
      LLM_ERROR_CODES.PROVIDER_CONFIG_INVALID,
      'LLM baseUrl must not contain a query string',
    );
  }
  if (parsed.hash !== '') {
    throw new LlmProviderError(
      LLM_ERROR_CODES.PROVIDER_CONFIG_INVALID,
      'LLM baseUrl must not contain a fragment',
    );
  }

  // Normalize path: strip trailing slashes, then drop a redundant
  // `/chat/completions` suffix so it is never double-appended.
  let path = parsed.pathname;
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '/') path = '';
  if (path.endsWith('/chat/completions')) path = path.slice(0, -'/chat/completions'.length);

  const chatCompletionsUrl = new URL(path === '' ? '/chat/completions' : `${path}/chat/completions`, parsed.origin).href;

  return {
    chatCompletionsUrl,
    classification: classifyEndpoint(parsed),
  };
}
