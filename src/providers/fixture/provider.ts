/**
 * Local execution fixture provider (P5-R19).
 *
 * A separate harness adapter that navigates to the local loopback execution
 * harness and reads its explicit test-only markers. The live Google Forms
 * provider never reads these markers. This provider reuses the Google Forms
 * session fill/verify mechanics (the harness pages are Google-Forms-shaped) but
 * overrides accepting-state detection, section progression evidence, submit
 * confirmation, and the deterministic structural mutation to use harness
 * markers only.
 */

import type { CanonicalTarget } from '../../policy/target.ts';
import type { AcceptingState, ExecutionOpenOptions, ExecutionProvider, ExecutionSession, RuntimeFormSnapshot, SubmitEvidence } from '../../domain/execution.ts';
import { EXECUTION_PRE_SUBMIT_CODES } from '../../domain/execution.ts';
import { ExecutionPreSubmitError, ExecutionUsageError } from '../../execution/errors.ts';
import { GoogleFormsExecutionSession } from '../google-forms/session.ts';
import { openProviderPage, type BrowserLauncher } from '../google-forms/browser-launch.ts';
import { isHarnessScenario, type HarnessScenario } from './harness.ts';

export const FIXTURE_EXECUTION_PROVIDER_ID = 'fixture-execution' as const;
export const FIXTURE_EXECUTION_PROVIDER_VERSION = '1.0.0' as const;

/**
 * Map a canonical fixture target to a harness scenario. Fixture ids of the form
 * `exec-<scenario>` map to `<scenario>` (e.g. `exec-success` -> `success`).
 */
export function fixtureScenario(target: CanonicalTarget): HarnessScenario | null {
  if (target.kind !== 'fixture') return null;
  const id = target.key.slice('fixture:'.length);
  if (!id.startsWith('exec-')) return null;
  const scenario = id.slice('exec-'.length);
  return isHarnessScenario(scenario) ? scenario : null;
}

export class FixtureExecutionSession extends GoogleFormsExecutionSession {
  private readonly scenario: HarnessScenario;
  private snapshotCount = 0;

  constructor(
    scenario: HarnessScenario,
    ...args: ConstructorParameters<typeof GoogleFormsExecutionSession>
  ) {
    super(...args);
    this.scenario = scenario;
  }

  override async isAcceptingResponses(): Promise<AcceptingState> {
    const attr = await this.page
      .locator('[data-harness-accepting]')
      .getAttribute('data-harness-accepting');
    if (attr === 'accepting') return 'accepting';
    if (attr === 'closed') return 'closed';
    return 'unknown';
  }

  protected override async currentSectionEvidence(): Promise<string> {
    const attr = await this.page
      .locator('[data-harness-current-section]')
      .getAttribute('data-harness-current-section');
    return attr ?? 'unknown';
  }

  protected override async verifyAdvanced(before: string): Promise<void> {
    const after = await this.currentSectionEvidence();
    if (after === before) {
      throw new ExecutionPreSubmitError(
        EXECUTION_PRE_SUBMIT_CODES.FLOW_UNEXPECTED,
        'form did not advance to the next section',
      );
    }
  }

  protected override async readSubmitEvidence(): Promise<SubmitEvidence> {
    const marker = this.page.locator('[data-harness-submitted="confirmed"]');
    try {
      await marker.waitFor({ state: 'attached', timeout: this.actionTimeoutMs });
      const code = await marker.getAttribute('data-harness-confirmation');
      return { state: 'confirmed', confirmationCode: code ?? 'fixture:confirmed' };
    } catch {
      return { state: 'ambiguous', reasonCode: 'SUBMISSION_OUTCOME_UNKNOWN' };
    }
  }

  /**
   * For the mutation scenario, the second snapshot mutates the page's embedded
   * payload in-place (deterministic, test-only) so the orchestrator's
   * fingerprint re-check detects a structural change between fill and submit.
   */
  override async snapshot(): Promise<RuntimeFormSnapshot> {
    this.snapshotCount += 1;
    if (this.scenario === 'mutation' && this.snapshotCount === 2) {
      await this.page.evaluate(() => {
        const harnessMutate = (globalThis as unknown as { __harnessMutate?: () => void }).__harnessMutate;
        if (typeof harnessMutate === 'function') harnessMutate();
      });
    }
    return super.snapshot();
  }
}

export class FixtureExecutionProvider implements ExecutionProvider {
  readonly id = FIXTURE_EXECUTION_PROVIDER_ID;
  readonly version = FIXTURE_EXECUTION_PROVIDER_VERSION;
  private readonly baseUrl: string;
  private readonly launch: BrowserLauncher | undefined;

  constructor(baseUrl: string, launch?: BrowserLauncher) {
    this.baseUrl = baseUrl;
    this.launch = launch;
  }

  async open(target: CanonicalTarget, options: ExecutionOpenOptions): Promise<ExecutionSession> {
    const scenario = fixtureScenario(target);
    if (scenario === null) {
      throw new ExecutionUsageError(
        EXECUTION_PRE_SUBMIT_CODES.TARGET_UNSUPPORTED,
        `fixture target ${target.key} does not map to an execution harness scenario`,
      );
    }

    const { page, context, browser } = await openProviderPage(
      options,
      (page) =>
        page.goto(`${this.baseUrl}/${scenario}`, {
          waitUntil: 'domcontentloaded',
          timeout: options.navigationTimeoutMs,
        }),
      this.launch,
    );

    return new FixtureExecutionSession(
      scenario,
      page,
      context,
      browser,
      options.actionTimeoutMs,
      options.navigationTimeoutMs,
    );
  }
}
