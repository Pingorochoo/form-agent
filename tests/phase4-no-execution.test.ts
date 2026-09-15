/**
 * Phase 4 scope-creep regression guards (P4-R17, R18, R19, R1).
 *
 * Phase 4 modules stay deterministic, local, and ephemeral: no network fetch,
 * no browser automation, no submission, no real LLM inference, no implicit
 * randomness or wall-clock pacing, no persistence/migration. The accepted
 * fixture fingerprint is preserved and `preview`/`plan`/`run` remain
 * not-implemented.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { handleCmdPlan, handleCmdPreview, NotImplementedError } from '../src/cli/index.ts';
import { defaultConfig } from '../src/config/schema.ts';
import { createLogger } from '../src/logging/logger.ts';
import type { CliContext } from '../src/cli/index.ts';
import { parseGoogleFormsHtml } from '../src/parser/google-forms.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';

function makeCtx(): CliContext {
  const config = defaultConfig();
  return { config, logger: createLogger(config, { sink: () => {} }) };
}

const PHASE4_SOURCES = [
  '../src/domain/consistency.ts',
  '../src/consistency/compare.ts',
  '../src/consistency/rules.ts',
  '../src/consistency/gate.ts',
  '../src/consistency/errors.ts',
  '../src/consistency/format.ts',
  '../src/cli/check.ts',
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
  // persistence / authorization coupling
  'better-sqlite3',
  'FormAgentDatabase',
  "from '../db/",
  "from '../../db/",
  "from '../policy/policyEngine",
  "from '../../policy/policyEngine",
];

describe('P4-R18/R19 — no execution or out-of-scope behavior', () => {
  it('phase 4 modules contain no network, submission, browser, LLM, persistence, or policy code', () => {
    for (const rel of PHASE4_SOURCES) {
      const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
      for (const token of FORBIDDEN) {
        expect(source, `${rel} must not contain ${token}`).not.toContain(token);
      }
    }
  });

  it('preview / plan remain not-implemented after Phase 4', async () => {
    const ctx = makeCtx();
    await expect(handleCmdPreview(ctx)).rejects.toThrow(NotImplementedError);
    await expect(handleCmdPlan('https://fixtures.local/forms/demo', ctx)).rejects.toThrow(NotImplementedError);
  });
});

describe('P4-R17 — no persistence or migration', () => {
  it('preserves migrations 1-6 and appends only migration 7 (execution receipt)', () => {
    expect(MIGRATIONS.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(MIGRATIONS.slice(0, 6).map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6]);
    const up = MIGRATIONS.map((m) => m.up).join('\n').toLowerCase();
    expect(up).not.toContain('create table if not exists consistency');
    expect(up).not.toContain('create table if not exists preview');
    expect(up).not.toContain('create table if not exists approval');
  });
});

describe('P4-R1 — accepted fixture fingerprint is preserved', () => {
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
