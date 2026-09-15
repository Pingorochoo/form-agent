/**
 * Canonical authorization target identity (P2-R2).
 *
 * Authorization is keyed by a deterministic, offline-computed target key so
 * semantically equivalent target strings (fixture URL vs bare fixture id,
 * query-string variants, fragments) map to the same key. No network access is
 * performed: this is a pure, synchronous string transform.
 */

import { resolve } from 'node:path';

import { FIXTURE_HARNESS_BASE } from '../fixtures/index.ts';

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

export type TargetKind = 'fixture' | 'google-forms' | 'url' | 'file' | 'raw';

export interface CanonicalTarget {
  /** Deterministic machine key used as the authorization lookup key. */
  key: string;
  /** Human-readable form preserved for audit output. */
  display: string;
  kind: TargetKind;
}

/** Fixture harness origin, normalized for comparison (host + base path). */
const FIXTURE_BASE = FIXTURE_HARNESS_BASE.toLowerCase(); // https://fixtures.local/forms

/** A bare fixture id: no scheme, no path separators, no whitespace. */
const BARE_FIXTURE_ID = /^[A-Za-z0-9._-]+$/;

/** A bare string that looks like a path or file reference. */
function looksLikePath(value: string): boolean {
  return (
    value.includes('/') ||
    value.includes('\\') ||
    value.startsWith('.') ||
    value.startsWith('~')
  );
}

function stripTrailingSlash(path: string): string {
  let result = path;
  while (result.length > 1 && result.endsWith('/')) result = result.slice(0, -1);
  return result;
}

/** Extract a fixture id from a `https://fixtures.local/forms/<id>...` URL. */
function fixtureIdFromUrl(raw: string): string | null {
  const lower = raw.toLowerCase();
  if (!lower.startsWith(FIXTURE_BASE + '/')) return null;
  const rest = raw.slice(FIXTURE_BASE.length + 1);
  const id = rest.split(/[/?#]/)[0];
  if (id === undefined || id === '') return null;
  return id;
}

function normalizeHttpUrl(raw: string): { key: string; display: string; kind: TargetKind } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TargetError(`invalid target URL: ${raw}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  // `URL.host` includes a non-default port and omits default ports; it never
  // includes userinfo (username/password). This keeps distinct targets such as
  // `https://example.com/path` and `https://example.com:8443/path` distinct.
  const host = parsed.host.toLowerCase();
  // Remove irrelevant query strings and fragments; the sanitized origin+path is
  // the canonical identity AND the audited display (no userinfo/query/fragment).
  const path = stripTrailingSlash(parsed.pathname) || '/';
  const normalized = `${parsed.protocol.toLowerCase()}//${host}${path}`;

  if (hostname === 'docs.google.com' && path.includes('/forms/')) {
    // Normalize a Google Forms responder URL: lowercased origin + normalized
    // path only. No fetch is performed; the key stays stable across query/frag
    // variation (e.g. `?usp=send_form`, `#heading=...`).
    return { key: `google-forms:${normalized}`, display: normalized, kind: 'google-forms' };
  }
  return { key: `url:${normalized}`, display: normalized, kind: 'url' };
}

/**
 * Canonicalize an authorization target. Returns a stable `key` for equivalent
 * supported targets and a human-readable `display` for audit output.
 *
 * Recognized forms:
 *   - fixture URL (`https://fixtures.local/forms/<id>`) -> `fixture:<id>`
 *   - bare fixture id (`<id>`) -> `fixture:<id>`
 *   - Google Forms responder URL -> `google-forms:<normalized origin+path>`
 *   - other http(s) URL -> `url:<normalized origin+path>`
 *   - filesystem path -> `file:<resolved absolute path>`
 *   - anything else non-empty -> `raw:<trimmed value>`
 *
 * Throws `TargetError` for empty/whitespace-only input and unparseable URLs.
 */
export function canonicalizeTarget(input: string): CanonicalTarget {
  const raw = input.trim();
  if (raw === '') {
    throw new TargetError('authorization target must not be empty');
  }

  // 1. Fixture URL.
  const fixtureUrlId = fixtureIdFromUrl(raw);
  if (fixtureUrlId !== null) {
    // Sanitized/canonical display: the bare fixture URL, without any query
    // string, fragment, or userinfo that may have been present in the input.
    return { key: `fixture:${fixtureUrlId}`, display: `${FIXTURE_HARNESS_BASE}/${fixtureUrlId}`, kind: 'fixture' };
  }

  // 2. Bare fixture id (also what `analyze` accepts as a fixture id).
  if (BARE_FIXTURE_ID.test(raw) && !looksLikePath(raw)) {
    return { key: `fixture:${raw}`, display: raw, kind: 'fixture' };
  }

  // 3. http(s) URLs.
  if (/^https?:\/\//i.test(raw)) {
    return normalizeHttpUrl(raw);
  }

  // 4. Any other scheme is unsupported as a Phase 2 target.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    throw new TargetError(`unsupported target scheme: ${raw}`);
  }

  // 5. Filesystem path.
  if (looksLikePath(raw)) {
    return { key: `file:${resolve(raw)}`, display: raw, kind: 'file' };
  }

  // 6. Fallback: an opaque, non-empty string.
  return { key: `raw:${raw}`, display: raw, kind: 'raw' };
}
