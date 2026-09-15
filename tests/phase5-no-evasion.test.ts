/**
 * Phase 5 no-evasion / no-stealth / network-safety tests (P5-R19, R1).
 *
 * Source-level regression assertions are scoped to Phase 5 execution/provider/
 * browser code so they cannot produce false positives from accepted earlier
 * phases. A browser assertion proves the local loopback harness path makes no
 * external network request (and fails loudly if one is attempted).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import { ExecutionHarness } from '../src/providers/fixture/harness.ts';
import { FixtureExecutionProvider } from '../src/providers/fixture/provider.ts';
import type { BrowserLauncher } from '../src/providers/google-forms/browser-launch.ts';
import { ExecutionOrchestrator } from '../src/execution/orchestrate.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';
import { allowFixture, makeConfig, makeDatabase, resolveRules } from './support/phase5.ts';

const PHASE5_SOURCES = [
  '../src/domain/execution.ts',
  '../src/execution/errors.ts',
  '../src/execution/plan.ts',
  '../src/execution/receipt.ts',
  '../src/execution/orchestrate.ts',
  '../src/execution/format.ts',
  '../src/providers/execution.ts',
  '../src/providers/google-forms/browser.ts',
  '../src/providers/google-forms/browser-launch.ts',
  '../src/providers/google-forms/session.ts',
  '../src/providers/google-forms/locators.ts',
  '../src/providers/google-forms/fill.ts',
  '../src/providers/fixture/harness.ts',
  '../src/providers/fixture/provider.ts',
  '../src/cli/run.ts',
] as const;

/** Actual-usage evasion/pacing/persistence/upload patterns (never mere prose). */
const FORBIDDEN = [
  'force: true',
  'force:true',
  'Math.random',
  'waitForTimeout',
  'setInputFiles',
  'storageState',
  'userDataDir',
  'launchPersistentContext',
  'stealth',
  'captcha',
  'anti-bot',
  'evasion',
  'puppeteer-extra',
  'login',
  'signIn',
  'sign-in',
  'credentials',
  'jitter',
] as const;

describe('P5-R19 — no evasion, pacing, or out-of-scope behavior', () => {
  it('Phase 5 execution/provider code contains no force-clicks, random pacing, stealth, login, persistence, or upload', () => {
    for (const rel of PHASE5_SOURCES) {
      const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
      for (const token of FORBIDDEN) {
        expect(source, `${rel} must not contain ${token}`).not.toContain(token);
      }
    }
  });

  it('the rate layer still applies no sleep/jitter (accepted Phase 2 behavior)', () => {
    const source = readFileSync(new URL('../src/policy/rate.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('setTimeout');
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('Math.random');
  });
});

describe('P5-R19 — network safety', () => {
  it('the real fixture execution path makes no external network request (aborts loudly)', async () => {
    const harness = new ExecutionHarness();
    const baseUrl = await harness.start();
    const db = makeDatabase();
    allowFixture(db.database, 'exec-success');

    const external: string[] = [];
    // Inject a loopback-only launcher into the real FixtureExecutionProvider so
    // any non-loopback request is aborted and recorded.
    const launch: BrowserLauncher = async (opts) => {
      const browser = await chromium.launch({
        headless: opts.headless,
        ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
      });
      const origNewContext = browser.newContext.bind(browser);
      browser.newContext = async (...args) => {
        const context = await origNewContext(...args);
        await context.route('**/*', (route) => {
          const host = new URL(route.request().url()).hostname;
          if (host !== '127.0.0.1' && host !== 'localhost') {
            external.push(route.request().url());
            void route.abort();
            return;
          }
          void route.continue();
        });
        return context;
      };
      return browser;
    };

    const config = makeConfig(db.dir);
    const target = canonicalizeTarget('exec-success');
    const orchestrator = new ExecutionOrchestrator({
      config,
      database: db.database,
      sensitiveRules: resolveRules(),
      provider: new FixtureExecutionProvider(baseUrl, launch),
      target,
      rawTarget: 'exec-success',
      seed: 'net-safety-1',
    });

    await orchestrator.preflight();
    expect(external).toEqual([]);

    db.cleanup();
    await harness.stop();
  });

  it('automated tests never contact a real Google Forms host', () => {
    for (const rel of PHASE5_SOURCES) {
      const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
      expect(source, `${rel} must not reference docs.google.com`).not.toContain('docs.google.com');
    }
  });
});
