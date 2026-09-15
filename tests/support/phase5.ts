/**
 * Shared Phase 5 test support.
 *
 * Provides a deterministic local execution harness, an isolated temp database,
 * and a configured (safety test-only, headless) app config for browser E2E and
 * orchestrator unit tests. Automated tests never touch a real Google Form.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ExecutionHarness } from '../../src/providers/fixture/harness.ts';
import { FixtureExecutionProvider } from '../../src/providers/fixture/provider.ts';
import { FormAgentDatabase } from '../../src/db/database.ts';
import { AuthorizationStore } from '../../src/policy/authz.ts';
import { canonicalizeTarget } from '../../src/policy/target.ts';
import { defaultConfig, type AppConfig } from '../../src/config/schema.ts';
import { loadSensitiveRules, resolveSensitiveRules } from '../../src/policy/policy-config.ts';
import type { SensitiveRule } from '../../src/policy/sensitive.ts';

export function resolveRules(): SensitiveRule[] {
  return resolveSensitiveRules(loadSensitiveRules().rules);
}

export function makeConfig(dbDirectory: string): AppConfig {
  const config: AppConfig = defaultConfig();
  config.safety.mode = 'test-only';
  config.database.directory = dbDirectory;
  config.database.filename = 'form-agent.db';
  config.browser.headless = true;
  config.browser.actionTimeoutMs = 3000;
  config.browser.navigationTimeoutMs = 10_000;
  // Disable the min-delay gate so tests are isolated from each other's
  // submissions; hourly/daily caps remain undefined (absent) by default.
  config.rate.delayBetweenSubmissionsMs = 0;
  return config;
}

export interface TempDatabase {
  database: FormAgentDatabase;
  dir: string;
  cleanup(): void;
}

export function makeDatabase(): TempDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'form-agent-p5-'));
  const database = FormAgentDatabase.open({ directory: dir, filename: 'form-agent.db' });
  return {
    database,
    dir,
    cleanup: () => {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function allowFixture(database: FormAgentDatabase, fixtureId: string, operator = 'test-op'): void {
  const authz = new AuthorizationStore(database);
  authz.allow(canonicalizeTarget(fixtureId), 'run', operator);
}

export interface HarnessContext {
  harness: ExecutionHarness;
  baseUrl: string;
  providerFor(scenarioFixtureId: string): FixtureExecutionProvider;
  cleanup(): Promise<void>;
}

export async function startHarnessContext(): Promise<HarnessContext> {
  const harness = new ExecutionHarness();
  const baseUrl = await harness.start();
  return {
    harness,
    baseUrl,
    providerFor: () => new FixtureExecutionProvider(baseUrl),
    cleanup: async () => {
      await harness.stop();
    },
  };
}
