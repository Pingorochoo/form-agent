/**
 * Phase 5 independent-review correction tests (Findings A–D).
 *
 * A: execution error prose is value-free (sentinel answer never echoed).
 * B: provider open/navigation failure cleans up browser/context and throws a
 *    controlled stable error (no raw Playwright text).
 * C: base Google Forms session reports `accepting` on a non-final Next-only
 *    section (not `unknown`).
 * D: final submit readiness is validated BEFORE the durable claim, so a
 *    missing/ambiguous submit control is a pre-submit failure with no claim and
 *    no rate event.
 */

import { describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';

import { fillItem } from '../src/providers/google-forms/fill.ts';
import { openProviderPage, type BrowserLauncher } from '../src/providers/google-forms/browser-launch.ts';
import { GoogleFormsExecutionSession } from '../src/providers/google-forms/session.ts';
import { ExecutionHarness } from '../src/providers/fixture/harness.ts';
import { ExecutionOrchestrator } from '../src/execution/orchestrate.ts';
import { resolveExecutionProvider } from '../src/providers/execution.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';
import { RateStore } from '../src/policy/rate.ts';
import { ReceiptStore } from '../src/execution/receipt.ts';
import { ExecutionPreSubmitError } from '../src/execution/errors.ts';
import { EXECUTION_PRE_SUBMIT_CODES } from '../src/domain/execution.ts';
import type { ExecutionOpenOptions, ExecutionProvider } from '../src/domain/execution.ts';
import type { ChoiceGridQuestion, Question } from '../src/domain/types.ts';
import {
  allowFixture,
  makeConfig,
  makeDatabase,
  resolveRules,
  type TempDatabase,
} from './support/phase5.ts';

const SENTINEL = 'VERY_SECRET_BROWSER_VALUE';

describe('Finding A — value-free execution errors', () => {
  it('single-choice locator-not-found never echoes the answer value', async () => {
    const harness = new ExecutionHarness();
    const baseUrl = await harness.start();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/success`);

    const container = page.locator('.freebirdFormviewerViewItemsItem').nth(2); // single-choice
    try {
      await fillItem(container, {
        question: { id: 'q3' } as Question,
        value: { kind: 'single-choice', value: SENTINEL },
      });
      throw new Error('expected fillItem to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(SENTINEL);
      expect(message).toContain('q3');
      expect((err as ExecutionPreSubmitError).code).toBe(EXECUTION_PRE_SUBMIT_CODES.LOCATOR_NOT_FOUND);
    }

    await context.close();
    await browser.close();
    await harness.stop();
  });

  it('grid locator-not-found never echoes the selected column or row label', async () => {
    const harness = new ExecutionHarness();
    const baseUrl = await harness.start();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/success`);

    const container = page.locator('.freebirdFormviewerViewItemsItem').nth(5); // grid
    const gridQuestion = {
      id: 'q6',
      rows: [{ id: 'q6.r1', label: 'VERY_SECRET_ROW_LABEL' }],
      choices: ['Low', 'Medium', 'High'],
    } as unknown as ChoiceGridQuestion;

    try {
      await fillItem(container, {
        question: gridQuestion as unknown as Question,
        value: { kind: 'multiple-choice-grid', value: { 'q6.r1': SENTINEL } },
      });
      throw new Error('expected fillItem to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(SENTINEL);
      expect(message).not.toContain('VERY_SECRET_ROW_LABEL');
      expect(message).toContain('q6');
    }

    await context.close();
    await browser.close();
    await harness.stop();
  });
});

describe('Finding B — provider open/navigation failure safety', () => {
  const options: ExecutionOpenOptions = { headless: true, navigationTimeoutMs: 5000, actionTimeoutMs: 3000 };

  it('navigation failure closes context and browser and throws a controlled error', async () => {
    let browserClosed = false;
    let contextClosed = false;
    const fakeBrowser = {
      newContext: async () => ({
        newPage: async () => ({ setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {} }),
        close: async () => {
          contextClosed = true;
        },
      }),
      close: async () => {
        browserClosed = true;
      },
    } as unknown as Browser;
    const launch: BrowserLauncher = async () => fakeBrowser;

    await expect(openProviderPage(options, async () => Promise.reject(new Error('RAW_PLAYWRIGHT_SENTINEL')), launch)).rejects.toMatchObject({
      code: EXECUTION_PRE_SUBMIT_CODES.BROWSER_OPEN_FAILED,
    });
    expect(contextClosed).toBe(true);
    expect(browserClosed).toBe(true);
  });

  it('page creation failure closes the browser and throws a controlled error', async () => {
    let browserClosed = false;
    const fakeBrowser = {
      newContext: async () => ({
        newPage: async () => Promise.reject(new Error('RAW_PLAYWRIGHT_SENTINEL')),
        close: async () => {},
      }),
      close: async () => {
        browserClosed = true;
      },
    } as unknown as Browser;
    const launch: BrowserLauncher = async () => fakeBrowser;

    try {
      await openProviderPage(options, async () => {}, launch);
      throw new Error('expected openProviderPage to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionPreSubmitError);
      expect((err as ExecutionPreSubmitError).code).toBe(EXECUTION_PRE_SUBMIT_CODES.BROWSER_OPEN_FAILED);
      expect((err as Error).message).not.toContain('RAW_PLAYWRIGHT_SENTINEL');
    }
    expect(browserClosed).toBe(true);
  });
});

describe('Finding C — live multi-section accepting detection', () => {
  it('non-final Next-only section is accepting; final Submit is accepting; closed/unknown stay', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const session = new GoogleFormsExecutionSession(page, context, browser, 3000, 10000);

    await page.setContent('<button>Next</button>');
    expect(await session.isAcceptingResponses()).toBe('accepting');

    await page.setContent('<button>Submit</button>');
    expect(await session.isAcceptingResponses()).toBe('accepting');

    await page.setContent('<div>This form is no longer accepting responses</div>');
    expect(await session.isAcceptingResponses()).toBe('closed');

    await page.setContent('<div>some unrelated page</div>');
    expect(await session.isAcceptingResponses()).toBe('unknown');

    await context.close();
    await browser.close();
  });
});

describe('Finding D — submit readiness before claim', () => {
  let db: TempDatabase;
  let harness: ExecutionHarness;
  let baseUrl: string;

  async function setup(): Promise<void> {
    db = makeDatabase();
    harness = new ExecutionHarness();
    baseUrl = await harness.start();
    allowFixture(db.database, 'exec-submit-missing');
    allowFixture(db.database, 'exec-submit-ambiguous');
    allowFixture(db.database, 'exec-submit-disabled');
    allowFixture(db.database, 'exec-success');
  }

  async function teardown(): Promise<void> {
    db.cleanup();
    await harness.stop();
  }

  function orchestrator(fixtureId: string, seed: string): ExecutionOrchestrator {
    const config = makeConfig(db.dir);
    const target = canonicalizeTarget(fixtureId);
    return new ExecutionOrchestrator({
      config,
      database: db.database,
      sensitiveRules: resolveRules(),
      provider: resolveExecutionProvider(target, baseUrl),
      target,
      rawTarget: fixtureId,
      seed,
    });
  }

  it('missing submit control is a pre-submit failure with no claim and no rate event', async () => {
    await setup();
    try {
      const planId = (await orchestrator('exec-submit-missing', 'seed-miss-1').preflight()).plan.planId;
      await expect(orchestrator('exec-submit-missing', 'seed-miss-1').submit(planId, 'op')).rejects.toMatchObject({
        code: EXECUTION_PRE_SUBMIT_CODES.FLOW_UNEXPECTED,
      });

      const rate = new RateStore(db.database);
      expect(rate.listEvents('fixture:exec-submit-missing').filter((e) => e.kind === 'submission')).toHaveLength(0);
      const claimed = new ReceiptStore(db.database).list().filter((r) => r.submitAttempted && r.targetKey === 'fixture:exec-submit-missing');
      expect(claimed).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('ambiguous submit control is a pre-submit failure with no claim and no rate event', async () => {
    await setup();
    try {
      const planId = (await orchestrator('exec-submit-ambiguous', 'seed-amb-1').preflight()).plan.planId;
      await expect(orchestrator('exec-submit-ambiguous', 'seed-amb-1').submit(planId, 'op')).rejects.toMatchObject({
        code: EXECUTION_PRE_SUBMIT_CODES.LOCATOR_AMBIGUOUS,
      });

      const rate = new RateStore(db.database);
      expect(rate.listEvents('fixture:exec-submit-ambiguous').filter((e) => e.kind === 'submission')).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('a valid single submit control still confirms success after the claim', async () => {
    await setup();
    try {
      const planId = (await orchestrator('exec-success', 'seed-ok-1').preflight()).plan.planId;
      const result = await orchestrator('exec-success', 'seed-ok-1').submit(planId, 'op');
      expect(result.outcome).toBe('success');
    } finally {
      await teardown();
    }
  });

  it('a disabled/non-actionable submit control fails readiness before claim', async () => {
    await setup();
    try {
      const planId = (await orchestrator('exec-submit-disabled', 'seed-dis-1').preflight()).plan.planId;
      await expect(orchestrator('exec-submit-disabled', 'seed-dis-1').submit(planId, 'op')).rejects.toMatchObject({
        code: EXECUTION_PRE_SUBMIT_CODES.FLOW_UNEXPECTED,
      });

      const rate = new RateStore(db.database);
      expect(rate.listEvents('fixture:exec-submit-disabled').filter((e) => e.kind === 'submission')).toHaveLength(0);
      const claimed = new ReceiptStore(db.database).list().filter((r) => r.submitAttempted && r.targetKey === 'fixture:exec-submit-disabled');
      expect(claimed).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});

describe('Blocker E — authorization enforced inside the orchestrator', () => {
  it('unauthorized preflight and submit never open the provider', async () => {
    const db = makeDatabase(); // no allowlist entry
    try {
      let openCount = 0;
      const provider: ExecutionProvider = {
        id: 'fake-execution',
        version: '1.0.0',
        open: async () => {
          openCount += 1;
          throw new Error('OPEN_SHOULD_NOT_BE_CALLED');
        },
      };
      const config = makeConfig(db.dir);
      const target = canonicalizeTarget('exec-success');
      const orchestrator = new ExecutionOrchestrator({
        config,
        database: db.database,
        sensitiveRules: resolveRules(),
        provider,
        target,
        rawTarget: 'exec-success',
        seed: 'seed-unauth',
      });

      await expect(orchestrator.preflight()).rejects.toMatchObject({
        code: EXECUTION_PRE_SUBMIT_CODES.NOT_AUTHORIZED,
      });
      await expect(orchestrator.submit('a'.repeat(64), 'op')).rejects.toMatchObject({
        code: EXECUTION_PRE_SUBMIT_CODES.NOT_AUTHORIZED,
      });
      expect(openCount).toBe(0);
    } finally {
      db.cleanup();
    }
  });
});
