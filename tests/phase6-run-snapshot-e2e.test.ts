/**
 * Phase 6 end-to-end run snapshot tests (P6-R16, R17, R18, R20).
 *
 * The central Phase 6 acceptance proof: a real (loopback) OpenAI-compatible
 * provider generates a draft during preflight, the exact approved bundle is
 * persisted as a plan snapshot, and submit reuses that exact bundle with ZERO
 * LLM calls even after the LLM stub is made unreachable. It also proves that
 * content-bound bundle integrity (SHA-256) and provider-provenance binding
 * reject valid-to-valid tampering and provenance tampering before fill.
 *
 * Uses only the local browser fixture harness + loopback LLM stub — never a
 * real cloud model and never a real Google Form.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExecutionOrchestrator } from '../src/execution/orchestrate.ts';
import { resolveExecutionProvider } from '../src/providers/execution.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';
import { resolveDraftProvider, type ResolvedDraftProvider } from '../src/draft/resolve.ts';
import { LlmCallStore } from '../src/llm/audit.ts';
import { ExecutionPlanSnapshotStore } from '../src/execution/snapshot.ts';
import { serializeDraftBundle, bundleSha256 } from '../src/draft/serialize.ts';
import { provenanceHash } from '../src/draft/provenance.ts';
import { EXECUTION_SNAPSHOT_CODES } from '../src/domain/execution.ts';
import { LlmStub } from './support/phase6-llm-stub.ts';
import {
  allowFixture,
  makeConfig,
  makeDatabase,
  resolveRules,
  startHarnessContext,
  type HarnessContext,
  type TempDatabase,
} from './support/phase5.ts';
import type { AppConfig } from '../src/config/schema.ts';

let harness: HarnessContext;
let db: TempDatabase;

beforeAll(async () => {
  harness = await startHarnessContext();
  db = makeDatabase();
  allowFixture(db.database, 'exec-success');
  allowFixture(db.database, 'exec-mutation');
});

afterAll(async () => {
  db.cleanup();
  await harness.cleanup();
});

function configWithStub(dbDir: string, stubUrl: string): AppConfig {
  const config = makeConfig(dbDir);
  config.llm.draftProvider = 'openai-compatible';
  config.llm.providers = {
    'openai-compatible': {
      type: 'openai-compatible',
      baseUrl: stubUrl,
      model: 'stub-model-1',
      allowRemote: false,
      enabled: true,
    } as never,
  };
  return config;
}

type AuditEntry = { providerId: string; model: string; stage: string; status: 'success' | 'error'; errorCode?: string };

function resolveRealProvider(config: AppConfig, recordCall: (entry: AuditEntry) => void): ResolvedDraftProvider {
  return resolveDraftProvider('openai-compatible', { config, env: {}, recordCall });
}

function buildOrchestrator(
  fixtureId: string,
  seed: string,
  config: AppConfig,
  resolved?: ResolvedDraftProvider,
): ExecutionOrchestrator {
  const target = canonicalizeTarget(fixtureId);
  return new ExecutionOrchestrator({
    config,
    database: db.database,
    sensitiveRules: resolveRules(),
    provider: resolveExecutionProvider(target, harness.baseUrl),
    target,
    rawTarget: fixtureId,
    seed,
    ...(resolved !== undefined
      ? { draftProvider: resolved.provider, draftProviderProvenance: resolved.provenance }
      : {}),
  });
}

/** Load, mutate, and rewrite a persisted snapshot's bundle_json in place. */
function tamperBundle(planId: string, mutate: (bundle: Record<string, unknown>) => void): void {
  const row = db.database.db
    .prepare('SELECT bundle_json FROM execution_plan_snapshots WHERE plan_id = ?')
    .get(planId) as { bundle_json: string };
  const bundle = JSON.parse(row.bundle_json) as Record<string, unknown>;
  mutate(bundle);
  db.database.db
    .prepare('UPDATE execution_plan_snapshots SET bundle_json = ? WHERE plan_id = ?')
    .run(JSON.stringify(bundle), planId);
}

/**
 * Mutate the persisted bundle AND recompute/update its content digest so the
 * stored row stays self-consistent (the exact attack/regression the approval
 * binding must defeat). The snapshot primary-key plan_id is left unchanged.
 */
function tamperBundleWithRecomputedDigest(planId: string, mutate: (bundle: Record<string, unknown>) => void): void {
  const row = db.database.db
    .prepare('SELECT bundle_json FROM execution_plan_snapshots WHERE plan_id = ?')
    .get(planId) as { bundle_json: string };
  const bundle = JSON.parse(row.bundle_json) as Record<string, unknown>;
  mutate(bundle);
  const newJson = serializeDraftBundle(bundle as never);
  const newDigest = bundleSha256(newJson);
  db.database.db
    .prepare('UPDATE execution_plan_snapshots SET bundle_json = ?, bundle_sha256 = ? WHERE plan_id = ?')
    .run(newJson, newDigest, planId);
}

function tamperSnapshotColumn(planId: string, column: string, value: string | null): void {
  db.database.db
    .prepare(`UPDATE execution_plan_snapshots SET ${column} = ? WHERE plan_id = ?`)
    .run(value, planId);
}

describe('P6-R20 — real-provider preflight + offline submit', () => {
  it('preflight calls the LLM, persists the exact snapshot, and submit reuses it with zero LLM calls', async () => {
    const stub = new LlmStub();
    stub.setScenario('valid');
    const stubUrl = await stub.start();
    const config = configWithStub(db.dir, stubUrl);
    const llmCalls = new LlmCallStore(db.database);
    const resolved = resolveRealProvider(config, (entry) => llmCalls.record(entry));

    const callsBefore = stub.requestCount();
    const orchestrator = buildOrchestrator('exec-success', 'seed-e2e-1', config, resolved);
    const preflight = await orchestrator.preflight();

    // Real LLM stage calls occurred during preflight.
    expect(stub.requestCount()).toBeGreaterThan(callsBefore);
    expect(stub.countForStage('semantics')).toBeGreaterThan(0);
    expect(stub.countForStage('profile')).toBeGreaterThan(0);
    expect(stub.countForStage('answer')).toBeGreaterThan(0);

    // The snapshot persisted the exact approved bundle + provenance.
    const store = new ExecutionPlanSnapshotStore(db.database);
    const snapshot = store.load(preflight.plan.planId);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.bundleJson).toBe(serializeDraftBundle(preflight.bundle));
    expect(snapshot?.bundleSha256).toBeDefined();
    expect(snapshot?.draftId).toBe(preflight.bundle.draftId);
    expect(snapshot?.draftProviderId).toBe('openai-compatible');
    expect(snapshot?.modelOrProviderLabel).toBe('stub-model-1');
    expect(snapshot?.promptContractVersions).toContain('semantics=');
    expect(snapshot?.fingerprint).toBe(preflight.plan.fingerprint);
    // Preflight exposes safe provenance for the operator.
    expect(preflight.provenance.providerId).toBe('openai-compatible');
    expect(preflight.provenance.modelLabel).toBe('stub-model-1');

    const planId = preflight.plan.planId;

    // Make the LLM stub unreachable BEFORE submit.
    await stub.stop();
    const requestsAfterPreflight = stub.requestCount();

    // Submit must NOT resolve/contact a real provider: build the submit
    // orchestrator without any draft provider (mirrors the CLI submit path).
    const submitOrchestrator = buildOrchestrator('exec-success', 'seed-e2e-1', config);
    const result = await submitOrchestrator.submit(planId, 'operator-e2e');

    // Zero LLM calls occurred during submit (stub unreachable + count unchanged).
    expect(stub.requestCount()).toBe(requestsAfterPreflight);
    expect(result.outcome).toBe('success');
    expect(result.plan.draftId).toBe(preflight.bundle.draftId);
    expect(result.receipt.state).toBe('success');
    expect(result.receipt.submitAttempted).toBe(true);
  }, 60_000);

  it('a missing snapshot blocks before fill', async () => {
    const config = makeConfig(db.dir);
    const orchestrator = buildOrchestrator('exec-success', 'seed-e2e-2', config);
    await expect(orchestrator.submit('f'.repeat(64), 'op')).rejects.toMatchObject({
      code: EXECUTION_SNAPSHOT_CODES.NOT_FOUND,
    });
  }, 60_000);

  it('a corrupt snapshot bundle blocks before fill', async () => {
    const stub = new LlmStub();
    stub.setScenario('valid');
    const stubUrl = await stub.start();
    const config = configWithStub(db.dir, stubUrl);
    const llmCalls = new LlmCallStore(db.database);
    const resolved = resolveRealProvider(config, (entry) => llmCalls.record(entry));
    const orchestrator = buildOrchestrator('exec-success', 'seed-e2e-3', config, resolved);
    const preflight = await orchestrator.preflight();
    const planId = preflight.plan.planId;

    // Tamper the persisted bundle JSON directly.
    db.database.db
      .prepare('UPDATE execution_plan_snapshots SET bundle_json = ? WHERE plan_id = ?')
      .run('{"synthetic":true}', planId);

    await expect(buildOrchestrator('exec-success', 'seed-e2e-3', config).submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_SNAPSHOT_CODES.INVALID,
    });
    await stub.stop();
  }, 60_000);

  it('a fingerprint mismatch blocks before fill (no hidden regeneration)', async () => {
    const stub = new LlmStub();
    stub.setScenario('valid');
    const stubUrl = await stub.start();
    const config = configWithStub(db.dir, stubUrl);
    const llmCalls = new LlmCallStore(db.database);
    const resolved = resolveRealProvider(config, (entry) => llmCalls.record(entry));
    const orchestrator = buildOrchestrator('exec-success', 'seed-e2e-4', config, resolved);
    const preflight = await orchestrator.preflight();
    const planId = preflight.plan.planId;

    // Tamper the stored fingerprint so it no longer matches the runtime schema.
    tamperSnapshotColumn(planId, 'fingerprint', '0'.repeat(64));

    const callsBefore = stub.requestCount();
    await expect(buildOrchestrator('exec-success', 'seed-e2e-4', config).submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_SNAPSHOT_CODES.MISMATCH,
    });
    // No LLM call attempted during the blocked submit.
    expect(stub.requestCount()).toBe(callsBefore);
    await stub.stop();
  }, 60_000);

  it('Phase 5 gates still execute: structural mutation during submit still blocks', async () => {
    // Reference provider (default) also uses snapshot semantics; the mutation
    // scenario still fails the runtime fingerprint re-check before submit.
    const config = makeConfig(db.dir);
    const target = canonicalizeTarget('exec-mutation');
    const preflightOrchestrator = new ExecutionOrchestrator({
      config,
      database: db.database,
      sensitiveRules: resolveRules(),
      provider: resolveExecutionProvider(target, harness.baseUrl),
      target,
      rawTarget: 'exec-mutation',
      seed: 'seed-e2e-5',
    });
    const planId = (await preflightOrchestrator.preflight()).plan.planId;
    await expect(
      new ExecutionOrchestrator({
        config,
        database: db.database,
        sensitiveRules: resolveRules(),
        provider: resolveExecutionProvider(target, harness.baseUrl),
        target,
        rawTarget: 'exec-mutation',
        seed: 'seed-e2e-5',
      }).submit(planId, 'op'),
    ).rejects.toMatchObject({ code: 'FORM_CHANGED_BEFORE_SUBMIT' });
  }, 60_000);
});

describe('Finding A — content-bound bundle integrity (valid-to-valid tamper)', () => {
  it('a valid-to-valid answer mutation blocks before fill with zero LLM calls', async () => {
    const stub = new LlmStub();
    stub.setScenario('valid');
    const stubUrl = await stub.start();
    const config = configWithStub(db.dir, stubUrl);
    const llmCalls = new LlmCallStore(db.database);
    const resolved = resolveRealProvider(config, (entry) => llmCalls.record(entry));
    const orchestrator = buildOrchestrator('exec-success', 'seed-e2e-a1', config, resolved);
    const preflight = await orchestrator.preflight();
    const planId = preflight.plan.planId;

    // Change the single-choice answer (q3) to a DIFFERENT but still valid
    // choice, leaving every id and identity field untouched.
    tamperBundle(planId, (bundle) => {
      const results = bundle['results'] as Array<{ questionId: string; state: { state: string; value?: { value?: unknown } } }>;
      const q3 = results.find((r) => r.questionId === 'q3' && r.state.state === 'answered');
      expect(q3).toBeDefined();
      const value = q3?.state.value as { value?: unknown };
      value.value = 'macOS'; // valid choice, different from the stub's 'Windows'
    });

    const callsBefore = stub.requestCount();
    await expect(buildOrchestrator('exec-success', 'seed-e2e-a1', config).submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_SNAPSHOT_CODES.INVALID,
    });
    expect(stub.requestCount()).toBe(callsBefore);
    await stub.stop();
  }, 60_000);

  it('a valid-to-valid synthetic-profile content mutation blocks before fill', async () => {
    // Reference provider is deterministic and network-free; its draftId does not
    // bind profile fact values, so only the bundle digest can catch this.
    const config = makeConfig(db.dir);
    const orchestrator = buildOrchestrator('exec-success', 'seed-e2e-a2', config);
    const preflight = await orchestrator.preflight();
    const planId = preflight.plan.planId;

    tamperBundle(planId, (bundle) => {
      const profile = bundle['profile'] as { facts: Array<{ value: unknown }> };
      profile.facts[0]!.value = 'tampered-role';
    });

    await expect(buildOrchestrator('exec-success', 'seed-e2e-a2', config).submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_SNAPSHOT_CODES.INVALID,
    });
  }, 60_000);
});

describe('Finding B — provider provenance validation', () => {
  it('a provider id mismatch blocks before fill with zero LLM calls', async () => {
    const config = makeConfig(db.dir);
    const orchestrator = buildOrchestrator('exec-success', 'seed-e2e-b1', config);
    const planId = (await orchestrator.preflight()).plan.planId;
    tamperSnapshotColumn(planId, 'draft_provider_id', 'other-provider');
    await expect(buildOrchestrator('exec-success', 'seed-e2e-b1', config).submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_SNAPSHOT_CODES.MISMATCH,
    });
  }, 60_000);

  it('a provider version mismatch blocks before fill', async () => {
    const config = makeConfig(db.dir);
    const orchestrator = buildOrchestrator('exec-success', 'seed-e2e-b2', config);
    const planId = (await orchestrator.preflight()).plan.planId;
    tamperSnapshotColumn(planId, 'draft_provider_version', '9.9.9');
    await expect(buildOrchestrator('exec-success', 'seed-e2e-b2', config).submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_SNAPSHOT_CODES.MISMATCH,
    });
  }, 60_000);

  it('a corrupted provenance hash blocks before fill', async () => {
    const config = makeConfig(db.dir);
    const orchestrator = buildOrchestrator('exec-success', 'seed-e2e-b3', config);
    const planId = (await orchestrator.preflight()).plan.planId;
    tamperSnapshotColumn(planId, 'provenance_hash', '0'.repeat(64));
    await expect(buildOrchestrator('exec-success', 'seed-e2e-b3', config).submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_SNAPSHOT_CODES.MISMATCH,
    });
  }, 60_000);

  it('a real-provider model mismatch blocks before fill', async () => {
    const stub = new LlmStub();
    stub.setScenario('valid');
    const stubUrl = await stub.start();
    const config = configWithStub(db.dir, stubUrl);
    const llmCalls = new LlmCallStore(db.database);
    const resolved = resolveRealProvider(config, (entry) => llmCalls.record(entry));
    const orchestrator = buildOrchestrator('exec-success', 'seed-e2e-b4', config, resolved);
    const planId = (await orchestrator.preflight()).plan.planId;

    tamperSnapshotColumn(planId, 'model_or_provider_label', 'other-model');

    const callsBefore = stub.requestCount();
    await expect(buildOrchestrator('exec-success', 'seed-e2e-b4', config).submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_SNAPSHOT_CODES.MISMATCH,
    });
    expect(stub.requestCount()).toBe(callsBefore);
    await stub.stop();
  }, 60_000);
});

describe('Final approval binding — planId commits to bundle + provenance content', () => {
  it('A: a valid answer change + recomputed digest cannot retain approval (zero LLM)', async () => {
    const stub = new LlmStub();
    stub.setScenario('valid');
    const stubUrl = await stub.start();
    const config = configWithStub(db.dir, stubUrl);
    const llmCalls = new LlmCallStore(db.database);
    const resolved = resolveRealProvider(config, (entry) => llmCalls.record(entry));
    const orchestrator = buildOrchestrator('exec-success', 'seed-binding-a', config, resolved);
    const preflight = await orchestrator.preflight();
    const planId = preflight.plan.planId;

    // Change one answered value AND recompute/update the digest so the row is
    // self-consistent; the primary-key plan_id stays the old approved id.
    tamperBundleWithRecomputedDigest(planId, (bundle) => {
      const results = bundle['results'] as Array<{ questionId: string; state: { state: string; value?: { value?: unknown } } }>;
      const q3 = results.find((r) => r.questionId === 'q3' && r.state.state === 'answered');
      expect(q3).toBeDefined();
      (q3?.state.value as { value?: unknown }).value = 'macOS';
    });

    const callsBefore = stub.requestCount();
    await expect(buildOrchestrator('exec-success', 'seed-binding-a', config).submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_SNAPSHOT_CODES.MISMATCH,
    });
    expect(stub.requestCount()).toBe(callsBefore);
    await stub.stop();
  }, 60_000);

  it('B: a valid profile change + recomputed digest cannot retain approval', async () => {
    const config = makeConfig(db.dir);
    const orchestrator = buildOrchestrator('exec-success', 'seed-binding-b', config);
    const planId = (await orchestrator.preflight()).plan.planId;

    tamperBundleWithRecomputedDigest(planId, (bundle) => {
      const profile = bundle['profile'] as { facts: Array<{ value: unknown }> };
      profile.facts[0]!.value = 'tampered-role';
    });

    await expect(buildOrchestrator('exec-success', 'seed-binding-b', config).submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_SNAPSHOT_CODES.MISMATCH,
    });
  }, 60_000);

  it('C: a provenance change + recomputed hash cannot retain approval (zero LLM)', async () => {
    const stub = new LlmStub();
    stub.setScenario('valid');
    const stubUrl = await stub.start();
    const config = configWithStub(db.dir, stubUrl);
    const llmCalls = new LlmCallStore(db.database);
    const resolved = resolveRealProvider(config, (entry) => llmCalls.record(entry));
    const orchestrator = buildOrchestrator('exec-success', 'seed-binding-c', config, resolved);
    const planId = (await orchestrator.preflight()).plan.planId;

    // Change the model label AND recompute/update provenance_hash so the row is
    // self-consistent; the primary-key plan_id stays the old approved id.
    const row = db.database.db
      .prepare('SELECT draft_provider_id, draft_provider_version, prompt_contract_versions, endpoint_hash FROM execution_plan_snapshots WHERE plan_id = ?')
      .get(planId) as { draft_provider_id: string; draft_provider_version: string; prompt_contract_versions: string; endpoint_hash: string | null };
    const newModel = 'other-model';
    const newProvHash = provenanceHash({
      providerId: row.draft_provider_id,
      providerVersion: row.draft_provider_version,
      modelLabel: newModel,
      promptContractVersions: row.prompt_contract_versions,
      endpointHash: row.endpoint_hash,
    });
    db.database.db
      .prepare('UPDATE execution_plan_snapshots SET model_or_provider_label = ?, provenance_hash = ? WHERE plan_id = ?')
      .run(newModel, newProvHash, planId);

    const callsBefore = stub.requestCount();
    await expect(buildOrchestrator('exec-success', 'seed-binding-c', config).submit(planId, 'op')).rejects.toMatchObject({
      code: EXECUTION_SNAPSHOT_CODES.MISMATCH,
    });
    expect(stub.requestCount()).toBe(callsBefore);
    await stub.stop();
  }, 60_000);

  it('D: an untouched snapshot reconstructs the identical bound planId deterministically and submits', async () => {
    const config = makeConfig(db.dir);
    const first = await buildOrchestrator('exec-success', 'seed-binding-d', config).preflight();
    const second = await buildOrchestrator('exec-success', 'seed-binding-d', config).preflight();
    expect(second.plan.planId).toBe(first.plan.planId);

    // Submit the first approved planId succeeds (untouched snapshot, no LLM).
    const result = await buildOrchestrator('exec-success', 'seed-binding-d', config).submit(first.plan.planId, 'op');
    expect(result.outcome).toBe('success');
  }, 60_000);
});
