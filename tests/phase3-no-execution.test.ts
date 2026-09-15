/**
 * Phase 3 scope-creep regression guards (P3-R19, P3-R1).
 *
 * Phase 3 modules stay deterministic and local: no network fetch, no browser
 * automation, no submission, no real LLM inference, no implicit randomness or
 * wall-clock pacing, no OpenClaw/Telegram. `preview`/`plan`/`run` remain
 * not-implemented, and the accepted fixture fingerprint is preserved.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { handleCmdPlan, handleCmdPreview, NotImplementedError } from '../src/cli/index.ts';
import { defaultConfig } from '../src/config/schema.ts';
import { createLogger } from '../src/logging/logger.ts';
import type { CliContext } from '../src/cli/index.ts';
import { parseGoogleFormsHtml } from '../src/parser/google-forms.ts';

function makeCtx(): CliContext {
  const config = defaultConfig();
  return { config, logger: createLogger(config, { sink: () => {} }) };
}

const PHASE3_SOURCES = [
  '../src/domain/draft.ts',
  '../src/draft/errors.ts',
  '../src/draft/provider.ts',
  '../src/draft/reference.ts',
  '../src/draft/validate.ts',
  '../src/draft/orchestrate.ts',
  '../src/draft/format.ts',
  '../src/cli/draft.ts',
] as const;

const FORBIDDEN = [
  // network
  'fetch(',
  'XMLHttpRequest',
  "from 'node:http",
  "from 'node:https",
  "from 'node:net",
  // browser automation / submission
  'playwright',
  'puppeteer',
  '.submit(',
  'FormData(',
  // implicit randomness / pacing
  'Math.random',
  'setTimeout',
  'setInterval',
  'sleep(',
  // real inference / out-of-scope integrations
  'ChatCompletionClient',
  'createClientForProvider',
  'OpenClaw',
  'openclaw',
  'Telegram',
  'telegram',
];

describe('P3-R19 — no execution or out-of-scope behavior', () => {
  it('phase 3 modules contain no network, submission, browser, or LLM-inference code', () => {
    for (const rel of PHASE3_SOURCES) {
      const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
      for (const token of FORBIDDEN) {
        expect(source, `${rel} must not contain ${token}`).not.toContain(token);
      }
    }
  });

  it('preview / plan remain not-implemented after Phase 3', async () => {
    const ctx = makeCtx();
    await expect(handleCmdPreview(ctx)).rejects.toThrow(NotImplementedError);
    await expect(handleCmdPlan('https://fixtures.local/forms/demo', ctx)).rejects.toThrow(NotImplementedError);
  });
});

describe('P3-R1 — accepted fixture fingerprint is preserved', () => {
  it('still produces the accepted structural fingerprint', () => {
    const html = readFileSync(
      new URL('../fixtures/archives/observed-responder.html', import.meta.url),
      'utf8',
    );
    const schema = parseGoogleFormsHtml(html, {
      url: 'https://fixtures.local/forms/observed-responder',
      capturedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(schema.checksum).toBe('7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e');
  });
});
