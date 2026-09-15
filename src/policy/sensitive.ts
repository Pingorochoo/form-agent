/**
 * Deterministic sensitive-field classification (P2-R7, P2-R8, P2-R10, P2-R11).
 *
 * Classification lives in the policy layer and never mutates the accepted
 * structural parser. It is a pure function of schema metadata (question title,
 * title thread, kind, and raw type hint) plus the active rule set. There are no
 * answer values in Phase 2, and no LLM is used.
 *
 * When several rules match a question, the effective mode is the most
 * restrictive one (`never` > `specific-authorization` > `human-reviewed` >
 * `synthetic-allowed`), and all matched categories are retained.
 */

import { isFileUploadQuestion, isUnsupportedQuestion, type FormSchema, type Question } from '../domain/types.ts';

export const SENSITIVITY_CATEGORIES = [
  'name',
  'email',
  'phone',
  'address',
  'government-id',
  'employee-id',
  'passport',
  'payment',
  'credentials',
  'health',
  'upload',
] as const;

export type SensitivityCategory = (typeof SENSITIVITY_CATEGORIES)[number];

export function isSensitivityCategory(value: string): value is SensitivityCategory {
  return (SENSITIVITY_CATEGORIES as readonly string[]).includes(value);
}

export const SENSITIVE_MODES = [
  'never',
  'specific-authorization',
  'human-reviewed',
  'synthetic-allowed',
] as const;

export type SensitiveMode = (typeof SENSITIVE_MODES)[number];

export function isSensitiveMode(value: string): value is SensitiveMode {
  return (SENSITIVE_MODES as readonly string[]).includes(value);
}

/** Restriction rank: higher is more restrictive (P2-R10). */
const MODE_RANK: Record<SensitiveMode, number> = {
  'synthetic-allowed': 0,
  'human-reviewed': 1,
  'specific-authorization': 2,
  never: 3,
};

export function mostRestrictiveMode(a: SensitiveMode, b: SensitiveMode): SensitiveMode {
  return MODE_RANK[a] >= MODE_RANK[b] ? a : b;
}

/** A single sensitivity rule (built-in or user-configured). */
export interface SensitiveRule {
  /** Stable, unique rule id. */
  id: string;
  /** Case-insensitive regex source matched against normalized labels. */
  pattern: string;
  category: SensitivityCategory;
  mode: SensitiveMode;
}

export class SensitiveRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SensitiveRuleError';
  }
}

/** Compile a rule's regex source, throwing a clear error when invalid. */
export function compileRulePattern(rule: SensitiveRule): RegExp {
  try {
    return new RegExp(rule.pattern, 'i');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SensitiveRuleError(`invalid sensitivity pattern for rule "${rule.id}": ${detail}`);
  }
}

/**
 * Validate a set of custom rules: stable ids (unique), non-empty patterns,
 * known categories/modes, and compilable regex. Throws `SensitiveRuleError` on
 * the first violation so invalid policy files fail clearly rather than being
 * silently ignored.
 */
export function validateSensitiveRules(rules: SensitiveRule[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.id.trim() === '' || !/^[a-zA-Z0-9._-]+$/.test(rule.id)) {
      throw new SensitiveRuleError(`invalid sensitivity rule id: ${JSON.stringify(rule.id)}`);
    }
    if (seen.has(rule.id)) {
      throw new SensitiveRuleError(`duplicate sensitivity rule id: "${rule.id}"`);
    }
    seen.add(rule.id);
    if (rule.pattern.trim() === '') {
      throw new SensitiveRuleError(`sensitivity rule "${rule.id}" has an empty pattern`);
    }
    if (!isSensitivityCategory(rule.category)) {
      throw new SensitiveRuleError(
        `sensitivity rule "${rule.id}" has unknown category "${rule.category}" (allowed: ${SENSITIVITY_CATEGORIES.join(', ')})`,
      );
    }
    if (!isSensitiveMode(rule.mode)) {
      throw new SensitiveRuleError(
        `sensitivity rule "${rule.id}" has unknown mode "${rule.mode}" (allowed: ${SENSITIVE_MODES.join(', ')})`,
      );
    }
    compileRulePattern(rule);
  }
}

/**
 * Built-in static taxonomy (P2-R7). General-purpose, bilingual (en/es)
 * keyword patterns; no form-specific production rules are embedded. Every
 * built-in rule uses `never`, the restrictive default for a sensitive field
 * (P2-R10); configuration may introduce additional patterns with other modes.
 */
export const BUILTIN_SENSITIVE_RULES: SensitiveRule[] = [
  { id: 'builtin-name', pattern: '\\b(names?|full name|first name|last name|surname|nombre|nombre completo|apellidos?|nombre y apellido)\\b', category: 'name', mode: 'never' },
  { id: 'builtin-email', pattern: '\\b(e-?mails?|correo electr[oó]nico|correo|direcci[oó]n de correo)\\b', category: 'email', mode: 'never' },
  { id: 'builtin-phone', pattern: '\\b(phone|telephone|mobile|cell ?phone|n[úu]mero de tel[ée]fono|tel[ée]fono|m[oó]vil|celular)\\b', category: 'phone', mode: 'never' },
  { id: 'builtin-address', pattern: '\\b(address|home address|street|zip|postal code|direcci[oó]n|domicilio|calle|c[oó]digo postal|ciudad|city)\\b', category: 'address', mode: 'never' },
  { id: 'builtin-government-id', pattern: '\\b(government id|national id|social security|ssn|tax id|identificaci[oó]n oficial|dni|c[ée]dula|n[úu]mero de documento)\\b', category: 'government-id', mode: 'never' },
  { id: 'builtin-employee-id', pattern: '\\b(employee (id|number)|staff (id|number)|n[úu]mero de empleado|c[oó]digo de empleado)\\b', category: 'employee-id', mode: 'never' },
  { id: 'builtin-passport', pattern: '\\b(passport|pasaporte)\\b', category: 'passport', mode: 'never' },
  { id: 'builtin-payment', pattern: '\\b(credit card|debit card|bank account|card number|iban|swift|payment|billing|tarjeta|cuenta bancaria|n[úu]mero de tarjeta)\\b', category: 'payment', mode: 'never' },
  { id: 'builtin-credentials', pattern: '\\b(password|passphrase|secret|access token|api[ -]?key|credential|contrase[ñn]a|clave de acceso|token de acceso)\\b', category: 'credentials', mode: 'never' },
  { id: 'builtin-health', pattern: '\\b(health|medical|diagnos\\w*|allerg\\w*|medication|condition|salud|m[ée]dic[oa]|diagn[oó]stico|alergia|medicamento|s[íi]ntoma)\\b', category: 'health', mode: 'never' },
  { id: 'builtin-upload', pattern: '\\b(upload|attach\\w*|file|attachment|subir archivo|archivo|adjunto|comprobante)\\b', category: 'upload', mode: 'never' },
];

export interface SensitiveFieldResult {
  questionId: string;
  sensitive: boolean;
  categories: SensitivityCategory[];
  /** Effective mode; null when the field is not sensitive. */
  mode: SensitiveMode | null;
  matchedRuleIds: string[];
  /** Human-readable explanation (never parsed by callers). */
  reason: string;
}

export interface SensitiveScanResult {
  fields: SensitiveFieldResult[];
  /** Number of sensitive fields. */
  sensitiveCount: number;
  byCategory: Record<SensitivityCategory, number>;
  /** True when any field has effective mode `never`. */
  blockedByNever: boolean;
  /** True when any field requires human review. */
  requiresHumanReview: boolean;
  /** True when any field requires specific authorization. */
  requiresSpecificAuthorization: boolean;
}

function emptyByCategory(): Record<SensitivityCategory, number> {
  const out = {} as Record<SensitivityCategory, number>;
  for (const category of SENSITIVITY_CATEGORIES) out[category] = 0;
  return out;
}

/** Labels used for matching: title + title thread (already-normalized). */
function labelsFor(question: Question): string[] {
  const labels: string[] = [];
  if (question.title.trim() !== '') labels.push(question.title);
  if (question.titleThread.trim() !== '' && question.titleThread !== question.title) {
    labels.push(question.titleThread);
  }
  return labels;
}

/** Detect a file-upload field by kind or by the parser's deferred type hint. */
function isUploadField(question: Question): boolean {
  if (isFileUploadQuestion(question)) return true;
  if (isUnsupportedQuestion(question)) {
    const hint = question.rawTypeHint ?? '';
    const reason = question.reason ?? '';
    return hint.includes('file-upload') || hint === 'google-form-item-type:13' || reason.includes('file-upload');
  }
  return false;
}

/** Classify a single question against the active rule set. */
export function classifyQuestion(question: Question, rules: SensitiveRule[]): SensitiveFieldResult {
  const labels = labelsFor(question);
  const matched: SensitiveRule[] = [];
  const seenIds = new Set<string>();
  for (const rule of rules) {
    const regex = compileRulePattern(rule);
    if (labels.some((label) => regex.test(label))) {
      if (!seenIds.has(rule.id)) {
        seenIds.add(rule.id);
        matched.push(rule);
      }
    }
  }

  const isUpload = isUploadField(question);
  const sensitive = matched.length > 0 || isUpload;

  if (!sensitive) {
    return {
      questionId: question.id,
      sensitive: false,
      categories: [],
      mode: null,
      matchedRuleIds: [],
      reason: 'not sensitive',
    };
  }

  // File upload is always sensitive with mode `never` (P2-R11), regardless of
  // any configured rule.
  if (isUpload) {
    const uploadRule: SensitiveRule = { id: 'builtin-file-upload', pattern: '', category: 'upload', mode: 'never' };
    matched.push(uploadRule);
  }

  const categories: SensitivityCategory[] = [];
  const categorySet = new Set<SensitivityCategory>();
  let mode: SensitiveMode = 'synthetic-allowed';
  const matchedRuleIds: string[] = [];
  for (const rule of matched) {
    if (!categorySet.has(rule.category)) {
      categorySet.add(rule.category);
      categories.push(rule.category);
    }
    mode = mostRestrictiveMode(mode, rule.mode);
    matchedRuleIds.push(rule.id);
  }
  categories.sort();
  matchedRuleIds.sort();

  const reason =
    isUpload && matched.length === 1 && matched[0]?.id === 'builtin-file-upload'
      ? 'file upload fields are always sensitive and never'
      : `matched ${categories.join(', ')}; effective mode ${mode}`;

  return {
    questionId: question.id,
    sensitive: true,
    categories,
    mode,
    matchedRuleIds,
    reason,
  };
}

/** Classify every question in a schema, returning a scan summary. */
export function classifySensitiveFields(schema: FormSchema, rules: SensitiveRule[]): SensitiveScanResult {
  const fields = schema.parts.map((question) => classifyQuestion(question, rules));
  const byCategory = emptyByCategory();
  let blockedByNever = false;
  let requiresHumanReview = false;
  let requiresSpecificAuthorization = false;

  for (const field of fields) {
    if (!field.sensitive) continue;
    for (const category of field.categories) {
      byCategory[category] = (byCategory[category] ?? 0) + 1;
    }
    if (field.mode === 'never') blockedByNever = true;
    if (field.mode === 'human-reviewed') requiresHumanReview = true;
    if (field.mode === 'specific-authorization') requiresSpecificAuthorization = true;
  }

  return {
    fields,
    sensitiveCount: fields.filter((field) => field.sensitive).length,
    byCategory,
    blockedByNever,
    requiresHumanReview,
    requiresSpecificAuthorization,
  };
}
