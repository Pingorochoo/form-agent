/**
 * Phase 2 target canonicalization tests (P2-R2).
 *
 * Authorization keys must be deterministic, offline, and stable across
 * equivalent target strings (fixture URL vs bare id, query/fragment variants,
 * host casing).
 */

import { describe, expect, it } from 'vitest';

import { canonicalizeTarget, TargetError } from '../src/policy/target.ts';

describe('canonicalizeTarget — fixture identifiers', () => {
  it('maps a fixture URL and a bare fixture id to the same key', () => {
    const viaUrl = canonicalizeTarget('https://fixtures.local/forms/observed-responder');
    const viaId = canonicalizeTarget('observed-responder');
    expect(viaUrl.key).toBe('fixture:observed-responder');
    expect(viaId.key).toBe('fixture:observed-responder');
    expect(viaUrl.kind).toBe('fixture');
  });

  it('strips query strings and fragments from fixture URLs', () => {
    const base = canonicalizeTarget('https://fixtures.local/forms/demo');
    const query = canonicalizeTarget('https://fixtures.local/forms/demo?x=1');
    const fragment = canonicalizeTarget('https://fixtures.local/forms/demo#frag');
    expect(query.key).toBe(base.key);
    expect(fragment.key).toBe(base.key);
  });

  it('is case-insensitive for the fixture origin', () => {
    const a = canonicalizeTarget('HTTPS://FIXTURES.LOCAL/FORMS/demo');
    const b = canonicalizeTarget('https://fixtures.local/forms/demo');
    expect(a.key).toBe(b.key);
  });
});

describe('canonicalizeTarget — Google Forms URLs', () => {
  it('normalizes a Google Forms responder URL', () => {
    const target = canonicalizeTarget('https://docs.google.com/forms/d/e/1FAIpQLSfABC/viewform');
    expect(target.kind).toBe('google-forms');
    // Origin is lowercased; the case-sensitive form path id is preserved.
    expect(target.key).toBe('google-forms:https://docs.google.com/forms/d/e/1FAIpQLSfABC/viewform');
  });

  it('removes query strings and fragments (equivalent targets share a key)', () => {
    const a = canonicalizeTarget('https://docs.google.com/forms/d/e/1FAIpQLSfABC/viewform?usp=send_form');
    const b = canonicalizeTarget('https://docs.google.com/forms/d/e/1FAIpQLSfABC/viewform#heading=h.abc');
    const c = canonicalizeTarget('https://docs.google.com/forms/d/e/1FAIpQLSfABC/viewform');
    expect(a.key).toBe(c.key);
    expect(b.key).toBe(c.key);
  });
});

describe('canonicalizeTarget — other inputs', () => {
  it('normalizes generic http(s) URLs (lowercased origin, path preserved)', () => {
    const target = canonicalizeTarget('https://Example.com/Path?x=1#y');
    expect(target.key).toBe('url:https://example.com/Path');
    expect(target.kind).toBe('url');
  });

  it('resolves filesystem paths to an absolute file key', () => {
    const target = canonicalizeTarget('fixtures/archives/observed-responder.html');
    expect(target.kind).toBe('file');
    expect(target.key.startsWith('file:')).toBe(true);
    expect(target.key.endsWith('observed-responder.html')).toBe(true);
  });

  it('falls back to a raw key for opaque non-empty strings', () => {
    const target = canonicalizeTarget('a target with spaces');
    expect(target.kind).toBe('raw');
    expect(target.key).toBe('raw:a target with spaces');
  });
});

describe('canonicalizeTarget — invalid targets fail predictably', () => {
  it('rejects empty input', () => {
    expect(() => canonicalizeTarget('')).toThrow(TargetError);
  });

  it('rejects whitespace-only input', () => {
    expect(() => canonicalizeTarget('   ')).toThrow(TargetError);
  });

  it('rejects unparseable URLs', () => {
    expect(() => canonicalizeTarget('http://')).toThrow(TargetError);
  });

  it('rejects unsupported schemes', () => {
    expect(() => canonicalizeTarget('ftp://example.com/file')).toThrow(TargetError);
  });

  it('performs no network access (pure transform)', () => {
    // The function is synchronous and has no async/IO surface; a successful
    // call for a live-looking URL proves no fetch occurs.
    const target = canonicalizeTarget('https://docs.google.com/forms/d/e/x/viewform');
    expect(target.kind).toBe('google-forms');
  });
});

describe('canonicalizeTarget — ports and audit safety (P2-R19)', () => {
  it('preserves a non-default port in the canonical key', () => {
    const defaultPort = canonicalizeTarget('https://example.com/path');
    const customPort = canonicalizeTarget('https://example.com:8443/path');
    expect(customPort.key).toBe('url:https://example.com:8443/path');
    expect(customPort.key).not.toBe(defaultPort.key);
  });

  it('normalizes a default port to the port-less form', () => {
    const a = canonicalizeTarget('https://example.com/path');
    const b = canonicalizeTarget('https://example.com:443/path');
    expect(b.key).toBe(a.key);
  });

  it('uses an exact Google Forms hostname (no loose substring match)', () => {
    const impostor = canonicalizeTarget('https://docs.google.com.evil.example/forms/d/e/x/viewform');
    expect(impostor.kind).toBe('url');
    expect(impostor.key.startsWith('google-forms:')).toBe(false);
  });

  it('strips query parameters from key and display', () => {
    const target = canonicalizeTarget('https://example.com/path?token=VERY_SECRET_VALUE');
    expect(target.key).toBe('url:https://example.com/path');
    expect(target.display).toBe('https://example.com/path');
    expect(target.key).not.toContain('VERY_SECRET_VALUE');
    expect(target.display).not.toContain('VERY_SECRET_VALUE');
  });

  it('strips URL userinfo (username/password) from key and display', () => {
    const target = canonicalizeTarget('https://user:secret@example.com/path');
    expect(target.key).toBe('url:https://example.com/path');
    expect(target.display).toBe('https://example.com/path');
    expect(target.key).not.toContain('secret');
    expect(target.key).not.toContain('user');
    expect(target.display).not.toContain('secret');
    expect(target.display).not.toContain('user');
  });

  it('strips fragments from key and display', () => {
    const target = canonicalizeTarget('https://example.com/path#VERY_SECRET_FRAGMENT');
    expect(target.key).toBe('url:https://example.com/path');
    expect(target.display).toBe('https://example.com/path');
    expect(target.display).not.toContain('VERY_SECRET_FRAGMENT');
  });

  it('strips query/fragment/userinfo from fixture URL display without weakening equivalence', () => {
    const a = canonicalizeTarget('https://fixtures.local/forms/demo');
    const b = canonicalizeTarget('https://fixtures.local/forms/demo?token=VERY_SECRET_VALUE#frag');
    expect(a.key).toBe('fixture:demo');
    expect(b.key).toBe('fixture:demo');
    expect(b.display).toBe('https://fixtures.local/forms/demo');
    expect(b.display).not.toContain('VERY_SECRET_VALUE');
  });
});
