/**
 * Sanitize a captured Google Forms responder page into a committable archive
 * fixture (fixtures/archives/<id>.html).
 *
 * The archive keeps the *structural* markup byte-for-byte (obfuscated class
 * names, ARIA roles, data-params, the embedded FB_PUBLIC_LOAD_DATA_ payload) so
 * the Phase 1 parser can be developed against real markup. Only identity and
 * session material is stripped, and every stripped token is *removed*, never
 * replaced by a placeholder that could itself look structural or numeric.
 *
 * WHY THIS EXISTS (Phase 0 fix)
 * A previous pass ran a generic phone redactor over the whole document. Bare
 * numeric Google item ids (8-10 digit runs, e.g. 1249846430) matched the phone
 * pattern and were rewritten to <REDACTED-PHONE>, corrupting the embedded
 * FB_PUBLIC_LOAD_DATA_ JSON (fixture tests then failed on JSON.parse). This
 * module therefore never applies a digit-only phone rule to the document; the
 * embedded payload is sanitized structurally (JSON.parse -> transform ->
 * JSON.stringify) so numeric item ids survive.
 *
 * The CLI wrapper is scripts/sanitize-observed-form.mjs.
 */

/** The authorized test form's responder id (never committed verbatim). */
export const LIVE_FORM_ID = '1FAIpQLSd98rnMrAiFm3vA4FoyGnS0UbOqz-M6qR9ZRqcwSOOx4nWX7w';
export const FORM_ID_PLACEHOLDER = 'REDACTED_FORM_ID';

/** Identity/session substrings that must never be committed (removed). */
export const STRIP_SUBSTRINGS = [
  'AccountChooser',
  'data-user-email-address',
  'data-user-display-name',
  'resourcekey',
];

function replaceAll(text: string, needle: string, replacement: string): string {
  if (needle === '') return text;
  return text.split(needle).join(replacement);
}

/**
 * Remove non-structural <script> blocks entirely. The statement that carries
 * FB_PUBLIC_LOAD_DATA_ is preserved verbatim: it is structural, language-neutral
 * data, not code.
 */
function stripScripts(html: string): string {
  return html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (match, body: string) =>
    /FB_PUBLIC_LOAD_DATA_/.test(body) ? match : '<!-- script removed during sanitization -->',
  );
}

/**
 * Rewrite the live form id inside the embedded FB_PUBLIC_LOAD_DATA_ payload.
 * Parsing (rather than regexing the serialized numbers) is what makes this safe:
 * numeric item ids that look like phone numbers are left untouched.
 */
function sanitizeEmbeddedPayload(html: string): string {
  return html.replace(
    /(FB_PUBLIC_LOAD_DATA_\s*=\s*)(\[[\s\S]*?\])(\s*;\s*<\/script>)/,
    (_match, head: string, payload: string, tail: string) => {
      let data: unknown;
      try {
        data = JSON.parse(payload);
      } catch {
        return `${head}${replaceAll(payload, LIVE_FORM_ID, FORM_ID_PLACEHOLDER)}${tail}`;
      }
      const roundTripped = replaceAll(JSON.stringify(data), LIVE_FORM_ID, FORM_ID_PLACEHOLDER);
      const reencoded = roundTripped.replace(
        /[<>&]/g,
        (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
      return `${head}${reencoded}${tail}`;
    },
  );
}

/** Drop identity/session attributes, URLs, tokens and instrumentation scripts. */
function stripIdentityAndSession(html: string): string {
  let out = html;
  for (const needle of STRIP_SUBSTRINGS) out = replaceAll(out, needle, '');
  out = out.replace(/nonce="[^"]*"/g, '');
  out = out.replace(/\bnonce=[^&\s"'<>]*/g, '');
  out = out.replace(/<script data-id="_gd"[^>]*>[\s\S]*?<\/script>/g, '');
  return out;
}

/** Full sanitization pass. */
export function sanitizeResponderHtml(html: string): string {
  let out = replaceAll(html, LIVE_FORM_ID, FORM_ID_PLACEHOLDER);
  out = stripScripts(out);
  out = sanitizeEmbeddedPayload(out);
  out = stripIdentityAndSession(out);
  return out;
}

/** Returns the embedded payload string; throws when sanitization is incomplete. */
export function assertSanitized(html: string): string {
  for (const needle of STRIP_SUBSTRINGS) {
    if (html.includes(needle)) throw new Error(`sanitized html still contains ${needle}`);
  }
  if (html.includes('nonce=')) throw new Error('sanitized html still contains a nonce');
  const match = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(\[[\s\S]*?\]);\s*<\/script>/);
  if (match?.[1] === undefined) throw new Error('sanitized html has no parseable FB_PUBLIC_LOAD_DATA_ payload');
  JSON.parse(match[1]);
  return match[1];
}

/** Header comment prepended to every archived fixture. */
export const ARCHIVE_HEADER = `<!--
  Sanitized read-only archive fixture for form-agent Phase 0/1 regression tests.

  Source: the authorized responder page created specifically for testing
  form-agent. Captured READ-ONLY: no response was submitted and the form was
  not modified. Live identity/session material (form id, nonces, sign-in URLs,
  user attributes) was stripped; non-structural page scripts were removed.
  Structural markup (obfuscated class names, ARIA roles, data-params) and the
  embedded FB_PUBLIC_LOAD_DATA_ payload are preserved so Phase 1 can be
  developed against real markup.

  Numeric Google item ids are preserved: they must NOT be run through a phone
  redactor (see scripts/sanitize-observed-form.mjs).

  DO NOT replay submissions against this fixture data.
-->
`;