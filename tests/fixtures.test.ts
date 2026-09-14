/**
 * Fixture harness tests.
 */

import { describe, expect, it } from 'vitest';

import { BUILTIN_FIXTURES, fixtureUrl, isBuiltinFixtureId, loadFixture } from '../src/fixtures/index.ts';
import { decodeEmbeddedPayload, extractPayload } from '../src/fixtures/observed-payload.ts';

describe('fixture harness', () => {
  it('exposes a stable fixture URL scheme', () => {
    expect(fixtureUrl('official')).toBe('https://fixtures.local/forms/official');
  });

  it('recognizes builtin fixture ids', () => {
    expect(isBuiltinFixtureId('official')).toBe(true);
    expect(isBuiltinFixtureId('demo')).toBe(true);
    expect(isBuiltinFixtureId('random')).toBe(false);
    expect(BUILTIN_FIXTURES).toEqual(['official', 'demo']);
  });

  it('loads the official sample and demo snapshots', async () => {
    for (const id of BUILTIN_FIXTURES) {
      const fixture = await loadFixture(id);
      const html = await fixture.snapshot();
      expect(fixture.url).toContain(`/forms/${id}`);
      expect(html).toContain('<!doctype html>');
      expect(html.length).toBeGreaterThan(200);
    }
  });

  it('throws for unknown fixtures', async () => {
    await expect(loadFixture('does-not-exist')).rejects.toThrow(/Unknown fixture/);
  });
});

describe('archived real-form fixture', () => {
  const ARCHIVE_ID = 'observed-responder';

  it('loads the sanitized archive as a source:archive fixture', async () => {
    const fixture = await loadFixture(ARCHIVE_ID);
    expect(fixture.source).toBe('archive');
    const html = await fixture.snapshot();
    expect(html.toLowerCase()).toContain('<!doctype html>');
  });

  it('contains real structural signals, not invented freebird* markup', async () => {
    const html = await (await loadFixture(ARCHIVE_ID)).snapshot();
    // Real Google Forms markers the Phase 1 parser must handle.
    expect(html).toContain('data-params');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('FB_PUBLIC_LOAD_DATA_');
    // The obfuscated container classes actually shipped by Google.
    expect(html).toContain('Qr7Oae');
    expect(html).toContain('OxAavc');
    expect(html).toContain('data-item-id');
    // The hand-written fixture classes are NOT present in real markup.
    expect(html).not.toContain('freebirdFormviewerViewItems');
    expect(html).not.toContain('data-test-harness');
  });

  it('is sanitized: no live form id, nonces or account URLs', async () => {
    const html = await (await loadFixture(ARCHIVE_ID)).snapshot();
    expect(html).not.toContain('1FAIpQLS');
    expect(html).not.toContain('nonce=');
    expect(html).not.toContain('AccountChooser');
    expect(html).not.toContain('data-user-email-address');
    expect(html).not.toContain('data-user-display-name');
    expect(html).not.toContain('resourcekey');
  });

  it('exposes a form-structure payload with the observed type codes', async () => {
    const html = await (await loadFixture(ARCHIVE_ID)).snapshot();
    const match = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(\[[\s\S]*?\]);\s*<\/script>/);
    expect(match).not.toBeNull();
    const data = JSON.parse(match![1] as string);
    const items = data[1][1] as unknown[][];
    const types = new Set(items.map((item) => item[3]));
    // 6 = section break, 7 = grid, 9 = date, 10 = time, 4 = checkboxes,
    // 5 = linear scale, 2 = multiple choice, 1 = paragraph, 0 = short answer.
    for (const expected of [0, 1, 2, 4, 5, 6, 7, 9, 10]) {
      expect(types.has(expected)).toBe(true);
    }
  });

  it('has 5 sections and no conditional routing (observed reality)', async () => {
    const html = await (await loadFixture(ARCHIVE_ID)).snapshot();
    const match = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(\[[\s\S]*?\]);\s*<\/script>/);
    const data = JSON.parse(match![1] as string);
    const items = data[1][1] as unknown[][];
    const sectionIds = items.filter((it) => it[3] === 6).map((it) => it[0]);
    expect(sectionIds).toHaveLength(5);
    // Every section id appears exactly once: none is a branch target.
    for (const id of sectionIds) {
      const occurrences = (match![0].split(String(id)).length - 1);
      expect(occurrences).toBe(1);
    }
    // The modality question is a short answer, not a routed multiple choice.
    const modality = items.find((it) => it[0] === 1240080904) as unknown[];
    expect(modality[3]).toBe(0);
  });
});

describe('archived fixture — sanitization regression (no structural data burned)', () => {
  const ARCHIVE_ID = 'observed-responder';

  it('preserves numeric Google item ids (they must not be treated as phone numbers)', async () => {
    const html = await (await loadFixture(ARCHIVE_ID)).snapshot();
    // Regression: a generic phone redactor rewrote 8-10 digit item ids such as
    // 1249846430 to <REDACTED-PHONE>, corrupting the embedded JSON.
    expect(html).not.toContain('<REDACTED-PHONE>');
    expect(html).toContain('data-item-id="1249846430"');
    expect(html).toContain('name="entry.');
    // Every section-break id survives verbatim in both the payload and the DOM.
    for (const id of ['1249846430', '336245140', '1142924921', '21510676', '1860209072']) {
      expect(html).toContain(id);
    }
  });

  it('has a still-parseable embedded payload after sanitization', async () => {
    const html = await (await loadFixture(ARCHIVE_ID)).snapshot();
    const match = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(\[[\s\S]*?\]);\s*<\/script>/);
    expect(match).not.toBeNull();
    const payload = JSON.parse(match![1] as string) as unknown[];
    const items = (payload[1] as unknown[])[1] as unknown[][];
    expect(items).toHaveLength(32);
    // 27 questions + 5 page breaks.
    expect(items.filter((it) => it[3] === 6)).toHaveLength(5);
    expect(items.length - 5).toBe(27);
  });
});

describe('observed payload decoder (Phase 0 findings, reproducible)', () => {
  const ARCHIVE_ID = 'observed-responder';

  it('decodes the archived payload into the documented structure', async () => {
    const html = await (await loadFixture(ARCHIVE_ID)).snapshot();
    const decoded = decodeEmbeddedPayload(extractPayload(html));

    expect(decoded.sections).toHaveLength(5);
    expect(decoded.sections.map((s) => s.title)).toEqual([
      'Datos generales',
      'Experiencia académica presencial sin título',
      'Experiencia académica virtual',
      'Organización y satisfacción',
      'Comentarios finales',
    ]);
    expect(decoded.questions).toHaveLength(27);
    expect(decoded.questions.every((q) => q.sectionId !== null)).toBe(true);
  });

  it('records the observed question kinds, required flags and grids', async () => {
    const html = await (await loadFixture(ARCHIVE_ID)).snapshot();
    const decoded = decodeEmbeddedPayload(extractPayload(html));

    expect([...new Set(decoded.questions.map((q) => q.kind))].sort()).toEqual(
      [
        'date',
        'linear-scale',
        'multi-choice',
        'multiple-choice-grid',
        'paragraph-text',
        'single-choice',
        'text',
        'time',
      ].sort(),
    );

    // Only the final four questions are required.
    const required = decoded.questions.filter((q) => q.required);
    expect(required).toHaveLength(4);
    expect(required.map((q) => q.kind)).toEqual([
      'paragraph-text',
      'paragraph-text',
      'paragraph-text',
      'single-choice',
    ]);

    // Four type-7 grids, every one single-select (no checkbox grid present).
    const grids = decoded.questions.filter((q) => q.rawType === 7);
    expect(grids).toHaveLength(4);
    expect(grids.every((g) => g.selectionMode === 'single')).toBe(true);
    expect(grids.map((g) => g.rowLabels?.length)).toEqual([4, 4, 5, 5]);
  });

  it('records that no conditional go-to-section routing is present', async () => {
    const html = await (await loadFixture(ARCHIVE_ID)).snapshot();
    const decoded = decodeEmbeddedPayload(extractPayload(html));

    expect(decoded.routingEvidence.conditionalRoutingDetected).toBe(false);
    expect(decoded.routingEvidence.anySectionIdAppearsMoreThanOnce).toBe(false);
    expect(decoded.routingEvidence.conditionalChoices).toEqual([]);
    expect(Object.values(decoded.routingEvidence.sectionIdOccurrences)).toEqual([1, 1, 1, 1, 1]);
  });

  it('records the observed type-code table and validation hints', async () => {
    const html = await (await loadFixture(ARCHIVE_ID)).snapshot();
    const decoded = decodeEmbeddedPayload(extractPayload(html));

    expect(decoded.typeCodeToKind[0]).toBe('text');
    expect(decoded.typeCodeToKind[1]).toBe('paragraph-text');
    expect(decoded.typeCodeToKind[2]).toBe('single-choice');
    expect(decoded.typeCodeToKind[4]).toBe('multi-choice');
    expect(decoded.typeCodeToKind[5]).toBe('linear-scale');
    expect(decoded.typeCodeToKind[7]).toBe('multiple-choice-grid');
    expect(decoded.typeCodeToKind[9]).toBe('date');
    expect(decoded.typeCodeToKind[10]).toBe('time');
    // No dropdown (3) / rating (18) / file-upload (13) in this form.
    expect(decoded.questions.some((q) => q.kind === 'dropdown')).toBe(false);
    expect(decoded.questions.some((q) => q.kind === 'rating')).toBe(false);
    expect(decoded.questions.some((q) => q.kind === 'file-upload')).toBe(false);

    const date = decoded.questions.find((q) => q.kind === 'date');
    const time = decoded.questions.find((q) => q.kind === 'time');
    expect(date?.validationHints?.dateFlags).toEqual([0, 1]);
    expect(time?.validationHints?.timeFlags).toEqual([0]);
  });
});