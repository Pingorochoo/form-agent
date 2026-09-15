/**
 * Phase 2 scope-creep regression guards (P2-R20, P2-R19).
 *
 * Phase 2 modules must stay deterministic and local: no network fetch, no
 * browser automation, no submission, no LLM inference, no profile/answer
 * generation, no OpenClaw, no Telegram, and no sleep/scheduling/randomization
 * in the rate layer. `preview`/`plan`/`run` remain not-implemented.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  handleCmdPlan,
  handleCmdPreview,
  handleCmdRun,
  NotImplementedError,
} from '../src/cli/index.ts';
import { defaultConfig } from '../src/config/schema.ts';
import { createLogger } from '../src/logging/logger.ts';
import type { CliContext } from '../src/cli/index.ts';

function makeCtx(): CliContext {
  const config = defaultConfig();
  return { config, logger: createLogger(config, { sink: () => {} }) };
}

const PHASE2_SOURCES = [
  '../src/policy/reasons.ts',
  '../src/policy/target.ts',
  '../src/policy/sensitive.ts',
  '../src/policy/policy-config.ts',
  '../src/policy/authz.ts',
  '../src/policy/rate.ts',
  '../src/policy/policyEngine.ts',
  '../src/cli/auth.ts',
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
  // profile / answer generation (future phases)
  "from '../domain/profile.ts'",
  "from '../domain/answer.ts'",
  "from './profile.ts'",
  "from './answer.ts'",
  // out-of-scope integrations
  'OpenClaw',
  'openclaw',
  'Telegram',
  'telegram',
];

describe('P2-R20 — no execution or future-phase scope creep', () => {
  it('policy modules contain no network, submission, LLM, profile, or answer code', () => {
    for (const rel of PHASE2_SOURCES) {
      const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
      for (const token of FORBIDDEN) {
        expect(source, `${rel} must not contain ${token}`).not.toContain(token);
      }
    }
  });

  it('the rate layer never sleeps, schedules, or randomizes', () => {
    const source = readFileSync(new URL('../src/policy/rate.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('setTimeout');
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('sleep(');
    expect(source).not.toContain('Math.random');
  });

  it('preview / plan / run remain not-implemented after Phase 2', async () => {
    const ctx = makeCtx();
    await expect(handleCmdPreview(ctx)).rejects.toThrow(NotImplementedError);
    await expect(handleCmdPlan('https://fixtures.local/forms/demo', ctx)).rejects.toThrow(NotImplementedError);
    await expect(handleCmdRun(ctx)).rejects.toThrow(NotImplementedError);
  });
});

describe('P2-R19 — logging and secret safety', () => {
  it('policy reason descriptions contain no secret material', async () => {
    const { POLICY_REASON_DESCRIPTIONS } = await import('../src/policy/reasons.ts');
    for (const text of Object.values(POLICY_REASON_DESCRIPTIONS)) {
      expect(text).not.toMatch(/password|token|secret|api[ -]?key/i);
    }
  });

  it('authorization audit output uses only metadata (no answer values)', () => {
    // Authorization records are constructed from target/scope/operator/timestamps;
    // there is no answer-value field in the schema. This guard pins that fact.
    const migration = readFileSync(new URL('../src/db/migrations.ts', import.meta.url), 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS authorizations');
    const authzBlock = migration.split('CREATE TABLE IF NOT EXISTS authorizations')[1]?.split(') STRICT')[0] ?? '';
    expect(authzBlock).not.toMatch(/answer|password|token|secret/i);
  });
});
