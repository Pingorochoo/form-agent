/**
 * Execution provider resolution (P5-R3).
 *
 * Maps a canonical target to the narrow set of supported execution providers:
 * the exact Google Forms responder shape, or the local execution fixture
 * harness. Arbitrary URLs / files / raw strings are never executable.
 */

import type { CanonicalTarget } from '../policy/target.ts';
import type { ExecutionProvider } from '../domain/execution.ts';
import { EXECUTION_PRE_SUBMIT_CODES } from '../domain/execution.ts';
import { ExecutionUsageError } from '../execution/errors.ts';
import { GoogleFormsExecutionProvider } from './google-forms/browser.ts';
import { FixtureExecutionProvider, fixtureScenario } from './fixture/provider.ts';

export function resolveExecutionProvider(
  target: CanonicalTarget,
  fixtureBaseUrl?: string,
): ExecutionProvider {
  if (target.kind === 'google-forms') {
    return new GoogleFormsExecutionProvider();
  }
  if (target.kind === 'fixture') {
    if (fixtureBaseUrl === undefined || fixtureScenario(target) === null) {
      throw new ExecutionUsageError(
        EXECUTION_PRE_SUBMIT_CODES.TARGET_UNSUPPORTED,
        `fixture target "${target.display}" is not a supported execution harness scenario`,
      );
    }
    return new FixtureExecutionProvider(fixtureBaseUrl);
  }
  throw new ExecutionUsageError(
    EXECUTION_PRE_SUBMIT_CODES.TARGET_UNSUPPORTED,
    `unsupported execution target kind "${target.kind}"`,
  );
}
