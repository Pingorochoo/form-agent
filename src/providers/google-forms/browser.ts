/**
 * Google Forms Playwright execution provider (P5-R2, R19).
 *
 * Launches one isolated non-persistent Chromium context per run with finite
 * navigation/action timeouts. Navigation happens only for an already-authorized
 * exact Google Forms responder target (the orchestrator performs the
 * authorization-only gate before this provider is ever opened).
 */

import type { CanonicalTarget } from '../../policy/target.ts';
import type { ExecutionOpenOptions, ExecutionProvider, ExecutionSession } from '../../domain/execution.ts';
import { GoogleFormsExecutionSession } from './session.ts';
import { openProviderPage } from './browser-launch.ts';

export const GOOGLE_FORMS_EXECUTION_PROVIDER_ID = 'google-forms-execution' as const;
export const GOOGLE_FORMS_EXECUTION_PROVIDER_VERSION = '1.0.0' as const;

export class GoogleFormsExecutionProvider implements ExecutionProvider {
  readonly id = GOOGLE_FORMS_EXECUTION_PROVIDER_ID;
  readonly version = GOOGLE_FORMS_EXECUTION_PROVIDER_VERSION;

  async open(target: CanonicalTarget, options: ExecutionOpenOptions): Promise<ExecutionSession> {
    const { page, context, browser } = await openProviderPage(options, (page) =>
      page.goto(target.display, {
        waitUntil: 'domcontentloaded',
        timeout: options.navigationTimeoutMs,
      }),
    );

    return new GoogleFormsExecutionSession(
      page,
      context,
      browser,
      options.actionTimeoutMs,
      options.navigationTimeoutMs,
    );
  }
}
