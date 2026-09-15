/**
 * Phase 2 central PolicyEngine tests (P2-R9, P2-R12, P2-R14, P2-R15).
 *
 * The single policy layer composes authorization, safety-mode, sensitive
 * pre-scan, and rate gates, returning structured decisions with stable reason
 * codes. Nothing here executes, submits, fetches, or launches a browser.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FormAgentDatabase } from '../src/db/database.ts';
import { defaultConfig, type AppConfig } from '../src/config/schema.ts';
import { AuthorizationStore } from '../src/policy/authz.ts';
import { buildPolicyEngine, formatRunPolicySummary, PolicyEngine, PolicyEngineError } from '../src/policy/policyEngine.ts';
import { BUILTIN_SENSITIVE_RULES, type SensitiveRule } from '../src/policy/sensitive.ts';
import { canonicalizeTarget } from '../src/policy/target.ts';
import {
  DOMAIN_PROVIDER_ID,
  FORMS_SCHEMA_VERSION,
  type FormSchema,
  type FreeTextQuestion,
  type Question,
} from '../src/domain/types.ts';

function textQ(id: string, title: string): FreeTextQuestion {
  return { id, slot: 0, title, titleThread: title, kind: 'text', required: 'optional', sensitive: false, inputType: 'string' };
}

function makeSchema(questions: Question[]): FormSchema {
  const byId: Record<string, Question> = {};
  const questionSection: Record<string, string> = {};
  for (const q of questions) {
    byId[q.id] = q;
    questionSection[q.id] = 's0';
  }
  return {
    providerId: DOMAIN_PROVIDER_ID,
    formId: 'synthetic',
    checksum: '0'.repeat(64),
    schemaVersion: FORMS_SCHEMA_VERSION,
    meta: { url: 'https://fixtures.local/forms/synthetic', title: 'synthetic', capturedAt: '2026-01-01T00:00:00.000Z', source: 'fixture', requiresSignIn: false },
    title: 'synthetic',
    parts: questions,
    definitional: [{ type: 'section', id: 's0', title: 'S', slot: 0 }],
    questions: byId,
    sections: [{ id: 's0', slot: 0, index: 0, title: 'S', questionIds: questions.map((q) => q.id), routing: { default: 'submit', conditional: false, rules: [] } }],
    questionSection,
    nonQuestionContent: [],
    hasRouting: false,
    terminalSectionIds: ['s0'],
    rowCount: 0,
    fieldCount: questions.length,
    answerModel: 'flat',
  };
}

interface Fixture {
  db: FormAgentDatabase;
  config: AppConfig;
  engine: PolicyEngine;
  authz: AuthorizationStore;
}

function makeEngine(rules: SensitiveRule[] = BUILTIN_SENSITIVE_RULES, safetyMode: AppConfig['safety']['mode'] = 'test-only'): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'form-agent-policy-'));
  const db = FormAgentDatabase.open({ directory: dir, filename: 'policy.db' });
  const config = defaultConfig();
  config.database.directory = dir;
  config.safety.mode = safetyMode;
  const authz = new AuthorizationStore(db);
  const engine = buildPolicyEngine(config, db, rules);
  return { db, config, engine, authz };
}

const BENIGN = makeSchema([textQ('q-ok', 'How satisfied are you?')]);
const SENSITIVE_EMAIL = makeSchema([textQ('q-email', 'Email address')]);

describe('future-run authorization gate (P2-R14)', () => {
  it('denies an unallowlisted target', () => {
    const { engine } = makeEngine();
    const decision = engine.evaluateRunAuthorization('https://fixtures.local/forms/demo', 'run');
    expect(decision.allowed).toBe(false);
    expect(decision.state).toBe('not-allowlisted');
    expect(decision.reasons).toEqual(['TARGET_NOT_ALLOWLISTED']);
  });

  it('allows an allowlisted target for the run scope', () => {
    const { engine, authz } = makeEngine();
    authz.allow(canonicalizeTarget('https://fixtures.local/forms/demo'), 'run', 'op');
    const decision = engine.evaluateRunAuthorization('demo', 'run');
    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe('authorized');
    expect(decision.reasons).toEqual([]);
  });
});

describe('evaluateRunPolicy — full decision', () => {
  it('is allowed when authorized + test-only + benign schema + rate clear', () => {
    const { engine, authz } = makeEngine();
    authz.allow(canonicalizeTarget('https://fixtures.local/forms/demo'), 'run', 'op');
    const decision = engine.evaluateRunPolicy({ target: 'demo', scope: 'run', schema: BENIGN });
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.authorization).toBe('authorized');
    expect(decision.safety.eligible).toBe(true);
  });

  it('forces a sensitive pre-scan even though the caller did not classify first (P2-R9)', () => {
    const { engine, authz } = makeEngine();
    authz.allow(canonicalizeTarget('https://fixtures.local/forms/demo'), 'run', 'op');
    // The engine classifies internally; the caller only supplied the schema.
    const decision = engine.evaluateRunPolicy({ target: 'demo', scope: 'run', schema: SENSITIVE_EMAIL });
    expect(decision.sensitive).not.toBeNull();
    expect(decision.sensitive.blockedByNever).toBe(true);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('SENSITIVE_FIELD_NEVER');
  });

  it('never returns allowed when the schema/pre-scan is absent (P2-R9 fail-safe)', () => {
    const { engine, authz } = makeEngine();
    authz.allow(canonicalizeTarget('https://fixtures.local/forms/demo'), 'run', 'op');
    // Simulate an untyped/JS caller omitting the required schema.
    expect(() =>
      engine.evaluateRunPolicy({ target: 'demo', scope: 'run' } as unknown as Parameters<PolicyEngine['evaluateRunPolicy']>[0]),
    ).toThrow(PolicyEngineError);
  });

  it('safety mode gate denies non-test-only mode (P2-R15)', () => {
    const { engine, authz } = makeEngine(BUILTIN_SENSITIVE_RULES, 'disabled');
    authz.allow(canonicalizeTarget('https://fixtures.local/forms/demo'), 'run', 'op');
    const decision = engine.evaluateRunPolicy({ target: 'demo', scope: 'run', schema: BENIGN });
    expect(decision.allowed).toBe(false);
    expect(decision.safety.eligible).toBe(false);
    expect(decision.reasons).toContain('SAFETY_MODE_NOT_ELIGIBLE');
  });

  it('human review and specific authorization block with stable codes', () => {
    const humanRules: SensitiveRule[] = [
      ...BUILTIN_SENSITIVE_RULES,
      { id: 'custom-review', pattern: 'manager reference', category: 'credentials', mode: 'human-reviewed' },
    ];
    const { engine, authz } = makeEngine(humanRules);
    authz.allow(canonicalizeTarget('https://fixtures.local/forms/demo'), 'run', 'op');
    const decision = engine.evaluateRunPolicy({
      target: 'demo',
      scope: 'run',
      schema: makeSchema([textQ('q-ref', 'Manager reference')]),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('HUMAN_REVIEW_REQUIRED');
  });

  it('a revoked authorization denies with AUTHORIZATION_REVOKED', () => {
    const { engine, authz } = makeEngine();
    const canonical = canonicalizeTarget('https://fixtures.local/forms/demo');
    authz.allow(canonical, 'run', 'op');
    authz.revoke(canonical.key, 'run');
    const decision = engine.evaluateRunPolicy({ target: 'demo', scope: 'run', schema: BENIGN });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('AUTHORIZATION_REVOKED');
  });

  it('an unsupported scope maps to REQUIRED_SCOPE_MISSING', () => {
    const { engine, authz } = makeEngine();
    authz.allow(canonicalizeTarget('https://fixtures.local/forms/demo'), 'run', 'op');
    const decision = engine.evaluateRunPolicy({ target: 'demo', scope: 'delete', schema: BENIGN });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('REQUIRED_SCOPE_MISSING');
  });

  it('exposes stable reason codes (never prose)', () => {
    const { engine } = makeEngine();
    const decision = engine.evaluateRunPolicy({ target: 'never-listed', scope: 'run', schema: BENIGN });
    expect(decision.reasons).toEqual(['TARGET_NOT_ALLOWLISTED']);
    for (const code of decision.reasons) {
      expect(code).toMatch(/^[A-Z][A-Z_]+$/);
    }
  });
});

describe('formatRunPolicySummary (P2-R18)', () => {
  it('marks an unallowlisted target as NOT AUTHORIZED', () => {
    const { engine } = makeEngine();
    const decision = engine.evaluateRunPolicy({ target: 'never-listed', scope: 'run', schema: BENIGN });
    const summary = formatRunPolicySummary(decision);
    expect(summary).toContain('NOT AUTHORIZED for submission/execution');
    expect(summary).toContain('Authorization: not-allowlisted');
    expect(summary).toContain('TARGET_NOT_ALLOWLISTED');
  });

  it('reports sensitive-field counts', () => {
    const { engine, authz } = makeEngine();
    authz.allow(canonicalizeTarget('https://fixtures.local/forms/demo'), 'run', 'op');
    const decision = engine.evaluateRunPolicy({ target: 'demo', scope: 'run', schema: SENSITIVE_EMAIL });
    const summary = formatRunPolicySummary(decision);
    expect(summary).toContain('Sensitive fields: 1');
    expect(summary).toContain('email: 1');
  });
});
