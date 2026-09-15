/**
 * Phase 2 sensitive-field classification tests (P2-R7, P2-R8, P2-R10, P2-R11).
 *
 * Deterministic, LLM-free taxonomy + configurable rule overrides, with the
 * most-restrictive-mode rule and file-upload-always-never behavior.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BUILTIN_SENSITIVE_RULES,
  classifyQuestion,
  classifySensitiveFields,
  mostRestrictiveMode,
  validateSensitiveRules,
  type SensitiveRule,
} from '../src/policy/sensitive.ts';
import { loadSensitiveRules, resolveSensitiveRules, PolicyConfigError } from '../src/policy/policy-config.ts';
import {
  DOMAIN_PROVIDER_ID,
  FORMS_SCHEMA_VERSION,
  type FormSchema,
  type FreeTextQuestion,
  type Question,
} from '../src/domain/types.ts';
import { fileUpload, buildObservedFormSchema } from './support/sample-schema.ts';

function textQ(id: string, title: string, thread?: string): FreeTextQuestion {
  return {
    id,
    slot: 0,
    title,
    titleThread: thread ?? title,
    kind: 'text',
    required: 'optional',
    sensitive: false,
    inputType: 'string',
  };
}

function unsupportedUploadQ(id: string): Question {
  return {
    id,
    slot: 0,
    title: 'Sube tu comprobante',
    titleThread: 'Sube tu comprobante',
    kind: 'unsupported',
    required: 'optional',
    sensitive: false,
    rawTypeHint: 'google-form-item-type:13',
    reason: 'deferred: file-upload is not validated in Phase 1',
  };
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
    meta: {
      url: 'https://fixtures.local/forms/synthetic',
      title: 'synthetic',
      capturedAt: '2026-01-01T00:00:00.000Z',
      source: 'fixture',
      requiresSignIn: false,
    },
    title: 'synthetic',
    parts: questions,
    definitional: [{ type: 'section', id: 's0', title: 'S', slot: 0 }],
    questions: byId,
    sections: [
      {
        id: 's0',
        slot: 0,
        index: 0,
        title: 'S',
        questionIds: questions.map((q) => q.id),
        routing: { default: 'submit', conditional: false, rules: [] },
      },
    ],
    questionSection,
    nonQuestionContent: [],
    hasRouting: false,
    terminalSectionIds: ['s0'],
    rowCount: 0,
    fieldCount: questions.length,
    answerModel: 'flat',
  };
}

describe('built-in static taxonomy (P2-R7)', () => {
  const cases: Array<[string, string]> = [
    ['name', 'What is your full name?'],
    ['email', 'Please enter your email address'],
    ['phone', 'Phone number'],
    ['address', 'Home address'],
    ['government-id', 'Government ID (SSN)'],
    ['employee-id', 'Employee ID'],
    ['passport', 'Passport number'],
    ['payment', 'Credit card number'],
    ['credentials', 'Account password'],
    ['health', 'Any known medical conditions?'],
  ];

  it.each(cases)('classifies %s prompts as sensitive', (category, title) => {
    const result = classifyQuestion(textQ(`q-${category}`, title), BUILTIN_SENSITIVE_RULES);
    expect(result.sensitive).toBe(true);
    expect(result.categories).toContain(category);
    expect(result.mode).toBe('never');
    expect(result.matchedRuleIds.length).toBeGreaterThan(0);
  });

  it('leaves a benign prompt non-sensitive', () => {
    const result = classifyQuestion(textQ('q-ok', 'How satisfied are you?'), BUILTIN_SENSITIVE_RULES);
    expect(result.sensitive).toBe(false);
    expect(result.mode).toBeNull();
  });

  it('uses the title thread as well as the title', () => {
    const result = classifyQuestion(
      textQ('q-email', 'Your contact details', 'Registration — Your email address'),
      BUILTIN_SENSITIVE_RULES,
    );
    expect(result.sensitive).toBe(true);
    expect(result.categories).toContain('email');
  });
});

describe('file upload policy (P2-R11)', () => {
  it('a file-upload question is always sensitive with mode never', () => {
    const result = classifyQuestion(fileUpload(), BUILTIN_SENSITIVE_RULES);
    expect(result.sensitive).toBe(true);
    expect(result.categories).toContain('upload');
    expect(result.mode).toBe('never');
  });

  it('recognizes the deferred parser file-upload type hint as upload + never', () => {
    const result = classifyQuestion(unsupportedUploadQ('q-up'), BUILTIN_SENSITIVE_RULES);
    expect(result.sensitive).toBe(true);
    expect(result.categories).toContain('upload');
    expect(result.mode).toBe('never');
  });
});

describe('configurable sensitivity rules (P2-R8)', () => {
  it('loads custom rules from config/policies.d deterministically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-policies-'));
    const policies = join(dir, 'config', 'policies.d');
    mkdirSync(policies, { recursive: true });
    writeFileSync(
      join(policies, '20-custom.json'),
      JSON.stringify({
        rules: [{ id: 'custom-badge', pattern: 'badge number', category: 'employee-id', mode: 'human-reviewed' }],
      }),
    );

    const loaded = loadSensitiveRules({ cwd: dir });
    expect(loaded.rules).toHaveLength(1);
    expect(loaded.rules[0]?.id).toBe('custom-badge');
    expect(loaded.sources).toHaveLength(1);

    const active = resolveSensitiveRules(loaded.rules);
    const result = classifyQuestion(textQ('q-badge', 'Employee badge number'), active);
    expect(result.sensitive).toBe(true);
    expect(result.categories).toContain('employee-id');
    expect(result.mode).toBe('human-reviewed');
    expect(result.matchedRuleIds).toContain('custom-badge');
  });

  it('loads custom rules from a .yaml policy file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-policies-yaml-'));
    const policies = join(dir, 'config', 'policies.d');
    mkdirSync(policies, { recursive: true });
    writeFileSync(
      join(policies, '10-custom.yaml'),
      'rules:\n  - id: custom-yaml\n    pattern: badge number\n    category: employee-id\n    mode: human-reviewed\n',
    );

    const loaded = loadSensitiveRules({ cwd: dir });
    expect(loaded.rules).toHaveLength(1);
    expect(loaded.rules[0]?.id).toBe('custom-yaml');
    expect(loaded.rules[0]?.mode).toBe('human-reviewed');
    expect(loaded.sources[0]?.endsWith('10-custom.yaml')).toBe(true);

    const active = resolveSensitiveRules(loaded.rules);
    const result = classifyQuestion(textQ('q-badge', 'Employee badge number'), active);
    expect(result.sensitive).toBe(true);
    expect(result.mode).toBe('human-reviewed');
    expect(result.matchedRuleIds).toContain('custom-yaml');
  });

  it('loads custom rules from a .yml policy file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-policies-yml-'));
    const policies = join(dir, 'config', 'policies.d');
    mkdirSync(policies, { recursive: true });
    writeFileSync(
      join(policies, '10-custom.yml'),
      'rules:\n  - id: custom-yml\n    pattern: badge number\n    category: employee-id\n    mode: specific-authorization\n',
    );

    const loaded = loadSensitiveRules({ cwd: dir });
    expect(loaded.rules).toHaveLength(1);
    expect(loaded.rules[0]?.id).toBe('custom-yml');
    expect(loaded.rules[0]?.mode).toBe('specific-authorization');

    const active = resolveSensitiveRules(loaded.rules);
    const result = classifyQuestion(textQ('q-badge', 'Employee badge number'), active);
    expect(result.mode).toBe('specific-authorization');
  });

  it('invalid YAML fails clearly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-policies-yaml-bad-'));
    const policies = join(dir, 'config', 'policies.d');
    mkdirSync(policies, { recursive: true });
    writeFileSync(join(policies, 'bad.yaml'), 'rules:\n  - id: [unclosed\n');
    expect(() => loadSensitiveRules({ cwd: dir })).toThrow(PolicyConfigError);
  });

  it('invalid custom regex fails clearly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-policies-bad-'));
    const policies = join(dir, 'config', 'policies.d');
    mkdirSync(policies, { recursive: true });
    writeFileSync(join(policies, 'bad.json'), JSON.stringify({ rules: [{ id: 'bad', pattern: '(', category: 'name', mode: 'never' }] }));
    expect(() => loadSensitiveRules({ cwd: dir })).toThrow(PolicyConfigError);
  });

  it('invalid policy files (bad JSON) fail clearly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'form-agent-policies-json-'));
    const policies = join(dir, 'config', 'policies.d');
    mkdirSync(policies, { recursive: true });
    writeFileSync(join(policies, 'broken.json'), '{ not valid json');
    expect(() => loadSensitiveRules({ cwd: dir })).toThrow(PolicyConfigError);
  });

  it('rejects unknown categories and modes in custom rules', () => {
    const rules: SensitiveRule[] = [
      { id: 'bad-cat', pattern: 'x', category: 'not-a-category' as never, mode: 'never' },
    ];
    expect(() => validateSensitiveRules(rules)).toThrow(/unknown category/);

    const rules2: SensitiveRule[] = [
      { id: 'bad-mode', pattern: 'x', category: 'name', mode: 'not-a-mode' as never },
    ];
    expect(() => validateSensitiveRules(rules2)).toThrow(/unknown mode/);
  });
});

describe('most restrictive mode wins (P2-R10)', () => {
  it('orders modes by restriction', () => {
    expect(mostRestrictiveMode('synthetic-allowed', 'human-reviewed')).toBe('human-reviewed');
    expect(mostRestrictiveMode('human-reviewed', 'specific-authorization')).toBe('specific-authorization');
    expect(mostRestrictiveMode('specific-authorization', 'never')).toBe('never');
    expect(mostRestrictiveMode('never', 'synthetic-allowed')).toBe('never');
  });

  it('a field matching multiple rules uses the most restrictive mode', () => {
    const custom: SensitiveRule[] = [
      { id: 'relax-email', pattern: 'contact email', category: 'email', mode: 'synthetic-allowed' },
    ];
    const active = resolveSensitiveRules(custom);
    // Matches builtin-email (never) and relax-email (synthetic-allowed).
    const result = classifyQuestion(textQ('q-email', 'Contact email'), active);
    expect(result.sensitive).toBe(true);
    expect(result.categories).toContain('email');
    expect(result.mode).toBe('never');
    expect(result.matchedRuleIds).toContain('builtin-email');
    expect(result.matchedRuleIds).toContain('relax-email');
  });

  it('retains all matched categories', () => {
    const result = classifyQuestion(
      textQ('q-multi', 'What is your email address?'),
      BUILTIN_SENSITIVE_RULES,
    );
    expect(result.categories).toContain('email');
    expect(result.categories).toContain('address');
  });
});

describe('classifySensitiveFields (integration)', () => {
  it('scans the accepted fixture and reports a summary', () => {
    const schema = buildObservedFormSchema();
    const scan = classifySensitiveFields(schema, BUILTIN_SENSITIVE_RULES);
    expect(scan.sensitiveCount).toBeGreaterThan(0);
    expect(scan.fields).toHaveLength(schema.parts.length);
    expect(scan.byCategory.name).toBeGreaterThan(0);
  });

  it('summarizes a synthetic schema with a never-blocked field', () => {
    const schema = makeSchema([textQ('q-ok', 'How satisfied are you?'), textQ('q-email', 'Email address')]);
    const scan = classifySensitiveFields(schema, BUILTIN_SENSITIVE_RULES);
    expect(scan.sensitiveCount).toBe(1);
    expect(scan.blockedByNever).toBe(true);
    expect(scan.requiresHumanReview).toBe(false);
  });
});
