/**
 * Redaction of sensitive fields from arbitrary text.
 *
 * Owns a single global table of WHAT gets redacted (email, phone, api keys,
 * google form response IDs). How a mapping is built (which labels are
 * sensitive) belongs to the policy layer (Phase 2). Targeted redaction maps
 * are applied here.
 *
 * All redactions are deterministic so tests and diffs are stable.
 */

export const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
export const PHONE_PATTERN = /\+?\d[\d\s().-]{6,}\d/g;

/** Default masks. */
export const EMAIL_MASK = '<REDACTED-EMAIL>';
export const PHONE_MASK = '<REDACTED-PHONE>';
export const API_KEY_MASK = '********';

/**
 * Google Form response IDs.
 *
 * A raw "20+ word chars" rule has a false-positive problem: ordinary long
 * option labels and single-word answers (`Supercalifragilisticexpialidocious`,
 * `state-of-the-art-technology-stack`, `Extraordinarilylongoptionlabelword`)
 * match it and get silently redacted. So the pattern only finds *candidates*
 * and `looksLikeGoogleResponseId` applies the structural checks that real
 * response IDs satisfy:
 *
 *   - at least 20 characters (same lower bound as before),
 *   - at least one digit AND at least one upper- and one lowercase letter
 *     (every Google ID is mixed-case + mixed-class; prose words are not),
 *   - a separator (`_` / `-`) or a leading digit.
 *
 * The candidate character class is the full base64url-ish alphabet
 * (`0-9a-zA-Z_-`); the structural predicate above, not the character class, is
 * what separates real IDs from prose. `.` is still excluded from the class so a
 * dotted token like `example.com` is never a candidate at all.
 */
export const GOOGLE_FORM_RESPONSE_ID_CANDIDATE_PATTERN = /\b[0-9a-zA-Z_-]{20,}\b/g;

/** Structural check applied to each candidate substring. */
export function looksLikeGoogleResponseId(candidate: string): boolean {
  if (candidate.length < 20) return false;
  if (!/[0-9]/.test(candidate)) return false;
  if (!/[a-z]/.test(candidate)) return false;
  if (!/[A-Z]/.test(candidate)) return false;
  return candidate.includes('_') || candidate.includes('-') || /^[0-9]/.test(candidate);
}

/**
 * Backwards-compatible name. Kept so existing imports and tests keep working;
 * matches *candidates* only, so callers that need the strict behaviour must
 * pair it with `looksLikeGoogleResponseId`.
 */
export const GOOGLE_FORM_RESPONSE_ID_PATTERN = GOOGLE_FORM_RESPONSE_ID_CANDIDATE_PATTERN;

export interface RedactionOptions {
  replaceEmails?: boolean;
  replacePhones?: boolean;
  replaceApiKeys?: boolean;
  googleFormResponseIdReplacements?: 'legible' | 'redacted';
  /** Explicit mapping label -> replacement; e.g. { 'Email': 'user@example.test' }. */
  mapping?: Record<string, string>;
}

export interface RedactionResult {
  text: string;
  /** Final map of mask token -> what it redacted (for audit/logs). */
  applied: Record<string, string>;
}

export function resolveRedactionOptions(options?: RedactionOptions): Required<Pick<RedactionOptions, 'replaceEmails' | 'replacePhones' | 'replaceApiKeys' | 'googleFormResponseIdReplacements'>> {
  return {
    replaceEmails: options?.replaceEmails ?? true,
    replacePhones: options?.replacePhones ?? true,
    replaceApiKeys: options?.replaceApiKeys ?? true,
    googleFormResponseIdReplacements: options?.googleFormResponseIdReplacements ?? 'redacted',
  };
}

/**
 * Redact sensitive substrings from `text`.
 *
 * Rule order matters and is documented:
 *   1. applied map-derived tokens first (most specific) — replacements are
 *      stashed behind sentinels so later passes cannot re-redact them,
 *   2. API keys (k= / token= assignment syntax) — must precede the generic
 *      response-id pass so long tokens in assignments are not pre-consumed,
 *   3. google form response IDs,
 *   4. emails, 5. phones (phones last so emails won't bleed).
 * Sentinels are restored at the end.
 */
export function redactText(text: string, options?: RedactionOptions): RedactionResult {
  const resolved = resolveRedactionOptions(options);
  let working = text;
  const applied: Record<string, string> = {};

  // 1. Targeted mapping — stash replacement values behind sentinels.
  const sentinels: Array<{ token: string; value: string }> = [];
  if (options?.mapping !== undefined) {
    let index = 0;
    for (const [needle, label] of Object.entries(options.mapping)) {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const token = `\u0000FA_MAPPED_${index}\u0000`;
      working = working.replace(new RegExp(`\\b${escaped}\\b`, 'g'), token);
      sentinels.push({ token, value: label });
      applied[needle] = label;
      index += 1;
    }
  }

  // 2. API keys (key= / token= / Bearer forms with long values).
  if (resolved.replaceApiKeys) {
    const KEY_ASSIGN_PATTERN = /\b(?:api[_-]?key|apikey|token|secret|password)\b\s*[=:]\s*["']?([A-Za-z0-9_\-.]{16,})["']?/gi;
    const BEARER_PATTERN = /\bbearer\s+([A-Za-z0-9_\-.:]{16,})/gi;
    for (const match of working.matchAll(KEY_ASSIGN_PATTERN)) {
      if (match[1] !== undefined) {
        working = working.split(match[1]).join(API_KEY_MASK);
        applied[API_KEY_MASK] = 'api-key-or-token';
      }
    }
    for (const match of working.matchAll(BEARER_PATTERN)) {
      if (match[1] !== undefined) {
        working = working.split(match[1]).join(API_KEY_MASK);
        applied[API_KEY_MASK] = 'bearer-token';
      }
    }
  }

  // 3. Google Form response IDs — redacted by default, legible surrogate opt-in.
  //    Only candidates that pass the structural check are replaced, so ordinary
  //    long option labels survive intact (see looksLikeGoogleResponseId).
  if (resolved.googleFormResponseIdReplacements === 'redacted') {
    const surrogate = '<REDACTED-RESPONSE-ID>';
    working = working.replace(GOOGLE_FORM_RESPONSE_ID_CANDIDATE_PATTERN, (candidate) =>
      looksLikeGoogleResponseId(candidate) ? surrogate : candidate,
    );
    applied['google-form-response-id'] = surrogate;
  }
  if (resolved.replaceEmails) {
    // 4. Emails.
    const matches = working.match(EMAIL_PATTERN) ?? [];
    const first = matches[0];
    if (matches.length > 0 && first !== undefined) {
      applied[EMAIL_MASK] = first;
      working = working.replace(EMAIL_PATTERN, EMAIL_MASK);
    }
  }

  // 5. Phones (last — emails handled above, phones must not re-burn).
  if (resolved.replacePhones) {
    const matches = working.match(PHONE_PATTERN) ?? [];
    const first = matches[0];
    if (matches.length > 0 && first !== undefined) {
      applied[PHONE_MASK] = first;
      working = working.replace(PHONE_PATTERN, PHONE_MASK);
    }
  }

  // 6. Restore mapped replacement values.
  for (const { token, value } of sentinels) {
    working = working.split(token).join(value);
  }

  return { text: working, applied };
}

const SENSITIVE_KEYS = new Set(['apikey', 'api_key', 'token', 'secret', 'password', 'authorization', 'credential']);

/** Redact the values of sensitive-looking keys in an object (deep). */
export function redactObjectDeep(input: unknown, depth = 0, seen = new Set<unknown>()): unknown {
  if (depth > 16) return input;
  if (input === null || typeof input !== 'object') return input;
  if (seen.has(input)) return input;
  seen.add(input);

  if (Array.isArray(input)) {
    return input.map((item) =>
      typeof item === 'string' ? redactText(item).text : redactObjectDeep(item, depth + 1, seen),
    );
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (
      SENSITIVE_KEYS.has(lower) ||
      lower.includes('password') ||
      lower.includes('secret') ||
      lower.includes('authorization')
    ) {
      out[key] = API_KEY_MASK;
      continue;
    }
    out[key] = typeof value === 'string' ? redactText(value).text : redactObjectDeep(value, depth + 1, seen);
  }
  return out;
}