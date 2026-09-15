/**
 * Google Forms execution session (P5-R2, R4, R10, R12).
 *
 * Owns one isolated page/context. Captures runtime structural snapshots through
 * the accepted parser (the orchestrator parses them — this session only returns
 * HTML), maps schema questions to DOM containers by accepted order within the
 * current section, fills/verifies answered fields, advances sequential sections,
 * and performs a single submit attempt.
 *
 * It never decides authorization/policy/consistency — it only reports DOM/state
 * evidence. Provider-specific Google Forms markers live here; the local fixture
 * harness subclasses this session to read its own test-only markers.
 */

import type { Browser, BrowserContext, Locator, Page } from 'playwright';

import type {
  AcceptingState,
  ExecutionSession,
  RuntimeFormSnapshot,
  SubmitEvidence,
} from '../../domain/execution.ts';
import { EXECUTION_PRE_SUBMIT_CODES } from '../../domain/execution.ts';
import type { Question } from '../../domain/types.ts';
import { ExecutionPreSubmitError } from '../../execution/errors.ts';
import { fillItem, verifyFilledItem } from './fill.ts';
import {
  containerTitle,
  nextButton,
  pageShowsClosedNotice,
  pageShowsResponderForm,
  questionContainers,
  submitButton,
} from './locators.ts';
import type { ExecutionFillItem } from '../../domain/execution.ts';

const CONFIRMATION_TEXT = /response has been recorded|se ha registrado tu respuesta/i;

export class GoogleFormsExecutionSession implements ExecutionSession {
  protected readonly page: Page;
  protected readonly context: BrowserContext;
  protected readonly browser: Browser;
  protected readonly actionTimeoutMs: number;
  protected readonly navigationTimeoutMs: number;

  /** Current-section mapping: schema question id -> DOM question container. */
  protected mapping: Map<string, Locator> = new Map();
  private closed = false;

  constructor(
    page: Page,
    context: BrowserContext,
    browser: Browser,
    actionTimeoutMs: number,
    navigationTimeoutMs: number,
  ) {
    this.page = page;
    this.context = context;
    this.browser = browser;
    this.actionTimeoutMs = actionTimeoutMs;
    this.navigationTimeoutMs = navigationTimeoutMs;
  }

  async snapshot(): Promise<RuntimeFormSnapshot> {
    return { html: await this.page.content(), url: this.page.url() };
  }

  async isAcceptingResponses(): Promise<AcceptingState> {
    if (await pageShowsClosedNotice(this.page)) return 'closed';
    if (await pageShowsResponderForm(this.page)) return 'accepting';
    return 'unknown';
  }

  async beginSection(questions: Question[]): Promise<void> {
    const containers = await questionContainers(this.page).all();
    if (containers.length !== questions.length) {
      throw new ExecutionPreSubmitError(
        EXECUTION_PRE_SUBMIT_CODES.FLOW_UNEXPECTED,
        `expected ${questions.length} question containers in the current section but found ${containers.length}`,
      );
    }

    const mapping = new Map<string, Locator>();
    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      const container = containers[i];
      if (question === undefined || container === undefined) continue;

      // Cross-check runtime DOM evidence (accessible heading) against the
      // accepted schema title. Order is the primary key; the title check fails
      // closed on drift (P5-R11).
      if (question.title.trim() !== '') {
        const title = await containerTitle(container);
        if (title !== question.title.trim()) {
          throw new ExecutionPreSubmitError(
            EXECUTION_PRE_SUBMIT_CODES.FLOW_UNEXPECTED,
            `question container title mismatch for question ${question.id}`,
          );
        }
      }
      mapping.set(question.id, container);
    }
    this.mapping = mapping;
  }

  async fill(item: ExecutionFillItem): Promise<void> {
    const container = this.containerFor(item.question.id);
    await fillItem(container, item);
  }

  async verifyFilled(item: ExecutionFillItem): Promise<void> {
    const container = this.containerFor(item.question.id);
    await verifyFilledItem(container, item);
  }

  protected containerFor(questionId: string): Locator {
    const container = this.mapping.get(questionId);
    if (container === undefined) {
      throw new ExecutionPreSubmitError(
        EXECUTION_PRE_SUBMIT_CODES.FLOW_UNEXPECTED,
        `question ${questionId} is not part of the current section`,
      );
    }
    return container;
  }

  /** Stable evidence string for the currently-visible section (progression). */
  protected async currentSectionEvidence(): Promise<string> {
    const containers = await questionContainers(this.page).all();
    const titles = await Promise.all(containers.map((container) => containerTitle(container)));
    return titles.join('\u0000');
  }

  /** Verify that clicking Next actually advanced the form. */
  protected async verifyAdvanced(before: string): Promise<void> {
    const after = await this.currentSectionEvidence();
    if (after === before) {
      throw new ExecutionPreSubmitError(
        EXECUTION_PRE_SUBMIT_CODES.FLOW_UNEXPECTED,
        'form did not advance to the next section',
      );
    }
  }

  async advanceSection(): Promise<void> {
    const before = await this.currentSectionEvidence();
    const next = nextButton(this.page);
    const count = await next.count();
    if (count === 0) {
      throw new ExecutionPreSubmitError(
        EXECUTION_PRE_SUBMIT_CODES.FLOW_UNEXPECTED,
        'no Next control on the current section',
      );
    }
    if (count > 1) {
      throw new ExecutionPreSubmitError(
        EXECUTION_PRE_SUBMIT_CODES.LOCATOR_AMBIGUOUS,
        'ambiguous Next control on the current section',
      );
    }
    await next.click();
    await this.verifyAdvanced(before);
  }

  /** Provider-specific positive submit confirmation (overridable). */
  protected async readSubmitEvidence(): Promise<SubmitEvidence> {
    try {
      await this.page.waitForURL(/formResponse/, { timeout: this.navigationTimeoutMs });
      return { state: 'confirmed', confirmationCode: 'google-forms:formResponse' };
    } catch {
      const confirmed = await this.page.getByText(CONFIRMATION_TEXT).count();
      if (confirmed > 0) {
        return { state: 'confirmed', confirmationCode: 'google-forms:confirmation-text' };
      }
      return { state: 'ambiguous', reasonCode: 'SUBMISSION_OUTCOME_UNKNOWN' };
    }
  }

  /**
   * Validate that the final submit control is present, unique, and actionable
   * BEFORE any durable claim (P5-R16/D/F). A missing/ambiguous/disabled control
   * fails here as a controlled pre-submit error so it never consumes the
   * submission key. The trial click proves actionability without performing the
   * submit; no raw Playwright error text is exposed.
   */
  async assertSubmitReady(): Promise<void> {
    const submit = submitButton(this.page);
    const count = await submit.count();
    if (count === 0) {
      throw new ExecutionPreSubmitError(
        EXECUTION_PRE_SUBMIT_CODES.FLOW_UNEXPECTED,
        'no submit control on the final section',
      );
    }
    if (count > 1) {
      throw new ExecutionPreSubmitError(
        EXECUTION_PRE_SUBMIT_CODES.LOCATOR_AMBIGUOUS,
        'ambiguous submit control on the final section',
      );
    }
    try {
      // Actionability trial: performs the checks (visible, stable, enabled,
      // receives events, not covered) without dispatching the click.
      await submit.click({ trial: true });
    } catch {
      throw new ExecutionPreSubmitError(
        EXECUTION_PRE_SUBMIT_CODES.FLOW_UNEXPECTED,
        'submit control is not actionable on the final section',
      );
    }
  }

  async submitOnce(): Promise<SubmitEvidence> {
    const submit = submitButton(this.page);
    const count = await submit.count();
    if (count === 0) {
      throw new ExecutionPreSubmitError(
        EXECUTION_PRE_SUBMIT_CODES.FLOW_UNEXPECTED,
        'no submit control on the final section',
      );
    }
    if (count > 1) {
      throw new ExecutionPreSubmitError(
        EXECUTION_PRE_SUBMIT_CODES.LOCATOR_AMBIGUOUS,
        'ambiguous submit control on the final section',
      );
    }
    await submit.click();
    return this.readSubmitEvidence();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Best-effort teardown: a context-close failure must not prevent the browser
    // close, and neither failure must propagate (guaranteed teardown).
    try {
      await this.context.close();
    } catch {
      // ignore
    }
    try {
      await this.browser.close();
    } catch {
      // ignore
    }
  }
}
