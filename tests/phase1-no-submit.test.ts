/**
 * Phase 1 safety tests (P1-R18, P1-R19, P1-R20).
 *
 *   - P1-R18: zero submission capability; preview/plan/run stay not-implemented.
 *   - P1-R19: no raw payload is logged/dumped; numeric item ids are preserved.
 *   - P1-R20: no scope creep (no LLM / semantic / profile / answer / Telegram).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  handleCmdPlan,
  handleCmdPreview,
  NotImplementedError,
} from '../src/cli/index.ts';
import { ExitCodes } from '../src/cli/exit-codes.ts';
import { runCli } from '../src/index.ts';
import { createLogger } from '../src/logging/logger.ts';
import { defaultConfig } from '../src/config/schema.ts';
import type { CliContext } from '../src/cli/index.ts';

function makeCtx(): CliContext {
  const config = defaultConfig();
  return { config, logger: createLogger(config, { sink: () => {} }) };
}

/** Phase 1 modules that must stay network-, LLM- and submission-free. */
const PHASE1_SOURCES = [
  '../src/parser/google-forms.ts',
  '../src/analyze/analyze.ts',
  '../src/analyze/store.ts',
  '../src/analyze/resolve-input.ts',
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
  // LLM / generation (future phases)
  'ChatCompletionClient',
  'FakeProvider',
  'createClientForProvider',
];

describe('P1-R18 — no form submission capability', () => {
  it('keeps preview / plan not-implemented', async () => {
    const ctx = makeCtx();
    await expect(handleCmdPreview(ctx)).rejects.toThrow(NotImplementedError);
    await expect(handleCmdPlan('https://fixtures.local/forms/observed-responder', ctx)).rejects.toThrow(NotImplementedError);
  });

  it('maps a not-implemented command to exit code 2 through the CLI', async () => {
    const previous = process.exitCode;
    try {
      await runCli(['preview']);
      expect(process.exitCode).toBe(ExitCodes.USAGE);
    } finally {
      process.exitCode = previous;
    }
  });
});

describe('P1-R19/P1-R20 — no raw dump, no LLM, no scope creep', () => {
  it('Phase 1 modules contain no network, submission, or LLM code', () => {
    for (const rel of PHASE1_SOURCES) {
      const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
      for (const token of FORBIDDEN) {
        expect(source, `${rel} must not contain ${token}`).not.toContain(token);
      }
    }
  });

  it('the parser is a pure string -> FormSchema transform (no I/O imports)', () => {
    const source = readFileSync(new URL('../src/parser/google-forms.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("from 'node:");
    expect(source).not.toContain('from "node:');
  });
});
