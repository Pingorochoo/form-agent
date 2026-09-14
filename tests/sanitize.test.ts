/**
 * Sanitizer tests — the archive fixture must never lose structural data.
 *
 * Regression: a generic phone redactor previously rewrote numeric Google item
 * ids (8-10 digit runs) to <REDACTED-PHONE>, corrupting the embedded
 * FB_PUBLIC_LOAD_DATA_ JSON. `src/fixtures/observed-sanitize.ts` (wrapped by
 * `scripts/sanitize-observed-form.mjs`) is the supported path; these tests pin
 * its guarantees.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ARCHIVE_HEADER, assertSanitized, sanitizeResponderHtml, LIVE_FORM_ID } from '../src/fixtures/observed-sanitize.ts';

const ARCHIVE = resolve(process.cwd(), 'fixtures', 'archives', 'observed-responder.html');

describe('sanitizeResponderHtml', () => {
  it('keeps numeric Google item ids intact (never phone-redacts them)', () => {
    const html = sanitizeResponderHtml(readFileSync(ARCHIVE, 'utf8'));
    expect(html).not.toContain('<REDACTED-PHONE>');
    expect(html).toContain('1249846430');
  });

  it('removes the live form id and session identity material', () => {
    const html = sanitizeResponderHtml(readFileSync(ARCHIVE, 'utf8'));
    expect(html).not.toContain(LIVE_FORM_ID);
    expect(html).not.toContain('AccountChooser');
    expect(html).not.toContain('nonce=');
    expect(html).not.toContain('data-user-email-address');
    expect(html).not.toContain('data-user-display-name');
    expect(html).not.toContain('resourcekey');
  });

  it('preserves the structural payload and ARIA/data-* signals', () => {
    const html = sanitizeResponderHtml(readFileSync(ARCHIVE, 'utf8'));
    for (const signal of ['FB_PUBLIC_LOAD_DATA_', 'data-params', 'data-item-id', 'role="radiogroup"', 'Qr7Oae']) {
      expect(html).toContain(signal);
    }
    // Non-structural scripts are gone; the payload statement survives.
    expect(html).toContain('FB_PUBLIC_LOAD_DATA_ = [');
  });

  it('produces a payload that still parses and keeps all 32 items', () => {
    const html = sanitizeResponderHtml(readFileSync(ARCHIVE, 'utf8'));
    const payload = assertSanitized(html);
    const repaired = JSON.parse(payload) as unknown[];
    const items = (repaired[1] as unknown[])[1] as unknown[][];
    expect(items).toHaveLength(32);
  });

  it('is idempotent on already-sanitized input', () => {
    const once = sanitizeResponderHtml(readFileSync(ARCHIVE, 'utf8'));
    const twice = sanitizeResponderHtml(once);
    expect(twice).toBe(once);
  });

  it('is deterministic (stable fixture bytes for stable input)', () => {
    expect(sanitizeResponderHtml(readFileSync(ARCHIVE, 'utf8'))).toBe(
      sanitizeResponderHtml(readFileSync(ARCHIVE, 'utf8')),
    );
  });

  it('the committed archive starts with the documented header', () => {
    expect(readFileSync(ARCHIVE, 'utf8').startsWith(ARCHIVE_HEADER)).toBe(true);
  });
});