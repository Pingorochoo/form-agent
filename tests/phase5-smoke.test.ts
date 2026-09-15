import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ExecutionHarness } from '../src/providers/fixture/harness.ts';
import { FixtureExecutionProvider } from '../src/providers/fixture/provider.ts';
import { ExecutionOrchestrator } from '../src/execution/orchestrate.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';
import { FormAgentDatabase } from '../src/db/database.ts';
import { AuthorizationStore } from '../src/policy/authz.ts';
import { defaultConfig, type AppConfig } from '../src/config/schema.ts';
import { loadSensitiveRules, resolveSensitiveRules } from '../src/policy/policy-config.ts';

describe('phase5 smoke', () => {
  let harness: ExecutionHarness;
  let baseUrl: string;
  let dir: string;
  let database: FormAgentDatabase;

  beforeAll(async () => {
    harness = new ExecutionHarness();
    baseUrl = await harness.start();
    dir = mkdtempSync(join(tmpdir(), 'form-agent-p5-smoke-'));
    database = FormAgentDatabase.open({ directory: dir, filename: 'smoke.db' });
    const authz = new AuthorizationStore(database);
    authz.allow(canonicalizeTarget('exec-success'), 'run', 'smoke-op');
  });

  afterAll(async () => {
    database.close();
    await harness.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('preflight produces a plan without fill/submit', async () => {
    const config: AppConfig = defaultConfig();
    config.safety.mode = 'test-only';
    config.database.directory = dir;

    const provider = new FixtureExecutionProvider(baseUrl);
    const orchestrator = new ExecutionOrchestrator({
      config,
      database,
      sensitiveRules: resolveSensitiveRules(loadSensitiveRules().rules),
      provider,
      target: canonicalizeTarget('exec-success'),
      rawTarget: 'exec-success',
      seed: 'seed-001',
    });

    const auth = orchestrator.checkAuthorization();
    expect(auth.allowed).toBe(true);

    const result = await orchestrator.preflight();
    expect(result.plan.planId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.plan.fillableCount).toBe(8);
    expect(result.accepting).toBe('accepting');
  }, 30000);
});
