/**
 * Central policy evaluation layer (P2-R9, P2-R12, P2-R14, P2-R15).
 *
 * `PolicyEngine` is the single place future execution phases consult to decide
 * whether a `run` is allowed. It composes four independent gates in a fixed,
 * deterministic order:
 *
 *   1. authorization (deny-by-default allowlist);
 *   2. safety mode (execution eligible only when `safety.mode === 'test-only'`);
 *   3. sensitive-field pre-scan (forced here — callers cannot skip it);
 *   4. rate gate (deterministic, no sleep).
 *
 * The engine returns structured decisions with stable reason codes. It never
 * executes, submits, fetches, or launches a browser.
 */

import type { AppConfig } from '../config/schema.ts';
import type { FormSchema } from '../domain/types.ts';
import type { FormAgentDatabase } from '../db/database.ts';
import { AuthorizationStore, type AuthorizationState } from './authz.ts';
import type { PolicyReasonCode } from './reasons.ts';
import { policyReasonDescription } from './reasons.ts';
import { canonicalizeTarget } from './target.ts';
import { classifySensitiveFields, type SensitiveRule, type SensitiveScanResult } from './sensitive.ts';
import { evaluateRateGate, rateConfigFrom, RateStore, type RateDecision } from './rate.ts';

export interface RunAuthorizationDecision {
  allowed: boolean;
  state: AuthorizationState;
  reasons: PolicyReasonCode[];
}

export interface RunPolicyDecision {
  allowed: boolean;
  authorization: AuthorizationState;
  /** Mandatory sensitive pre-scan result (the schema is required, so this is never absent). */
  sensitive: SensitiveScanResult;
  safety: { mode: string; eligible: boolean };
  rate: RateDecision | null;
  /** All blocking reason codes, in deterministic evaluation order. */
  reasons: PolicyReasonCode[];
  /** Human-readable explanations aligned with `reasons`. */
  reasonDescriptions: string[];
}

export class PolicyEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyEngineError';
  }
}

export interface PolicyEngineOptions {
  config: AppConfig;
  authz: AuthorizationStore;
  rate: RateStore;
  /** Active rule set: built-in taxonomy + user-configured overrides. */
  sensitiveRules: SensitiveRule[];
}

export interface RunPolicyInput {
  /** Raw target string (fixture id, fixture URL, local path, URL). */
  target: string;
  /** Requested scope; only `run` is supported in Phase 2. */
  scope: string;
  /**
   * Schema to pre-scan. Required: the full policy path must never skip the
   * mandatory sensitive pre-scan. Use `evaluateRunAuthorization` for the
   * authorization-only gate that does not need a schema.
   */
  schema: FormSchema;
  /** Injected timestamp for the rate gate (defaults to Date.now()). */
  nowMs?: number;
}

export class PolicyEngine {
  private readonly options: PolicyEngineOptions;

  constructor(options: PolicyEngineOptions) {
    this.options = options;
  }

  /**
   * Pure authorization gate for a future `run` (P2-R14). Denies an
   * unallowlisted target; performs no execution, submission, fetch, or browser.
   */
  evaluateRunAuthorization(target: string, scope: string): RunAuthorizationDecision {
    const canonical = canonicalizeTarget(target);
    const check = this.options.authz.check(canonical.key, scope);
    switch (check.state) {
      case 'authorized':
        return { allowed: true, state: 'authorized', reasons: [] };
      case 'revoked':
        return { allowed: false, state: 'revoked', reasons: ['AUTHORIZATION_REVOKED'] };
      case 'scope-unavailable':
        return { allowed: false, state: 'scope-unavailable', reasons: ['REQUIRED_SCOPE_MISSING'] };
      case 'not-allowlisted':
        return { allowed: false, state: 'not-allowlisted', reasons: ['TARGET_NOT_ALLOWLISTED'] };
    }
  }

  /** Full execution-policy decision for a future `run`. */
  evaluateRunPolicy(input: RunPolicyInput): RunPolicyDecision {
    const canonical = canonicalizeTarget(input.target);

    // 1. Authorization (deny-by-default).
    const checkResult = this.options.authz.check(canonical.key, input.scope);
    const authorization = checkResult.state;
    const authReasons = authorizationToReasons(authorization);

    // 2. Safety mode gate.
    const safetyMode = this.options.config.safety.mode;
    const safetyEligible = safetyMode === 'test-only';

    // 3. Mandatory sensitive pre-scan. The schema is required at the type
    //    boundary, and this runtime fail-safe prevents untyped/JS callers from
    //    accidentally bypassing the scan.
    const schema = input.schema as FormSchema | undefined | null;
    if (schema === undefined || schema === null) {
      throw new PolicyEngineError(
        'evaluateRunPolicy requires a schema to perform the mandatory sensitive pre-scan',
      );
    }
    const sensitive = classifySensitiveFields(schema, this.options.sensitiveRules);

    // 4. Rate gate.
    const nowMs = input.nowMs ?? Date.now();
    const rateConfig = rateConfigFrom(this.options.config);
    const rateState = this.options.rate.getState(canonical.key, nowMs);
    const rate = evaluateRateGate(rateConfig, rateState, nowMs);

    const reasons: PolicyReasonCode[] = [];
    reasons.push(...authReasons);
    if (!safetyEligible) reasons.push('SAFETY_MODE_NOT_ELIGIBLE');
    if (sensitive.blockedByNever) reasons.push('SENSITIVE_FIELD_NEVER');
    if (sensitive.requiresHumanReview) reasons.push('HUMAN_REVIEW_REQUIRED');
    if (sensitive.requiresSpecificAuthorization) reasons.push('SPECIFIC_AUTHORIZATION_REQUIRED');
    if (!rate.allowed) reasons.push(...rate.reasons);

    return {
      allowed: reasons.length === 0,
      authorization,
      sensitive,
      safety: { mode: safetyMode, eligible: safetyEligible },
      rate,
      reasons,
      reasonDescriptions: reasons.map((code) => policyReasonDescription(code)),
    };
  }
}

function authorizationToReasons(state: AuthorizationState): PolicyReasonCode[] {
  switch (state) {
    case 'authorized':
      return [];
    case 'revoked':
      return ['AUTHORIZATION_REVOKED'];
    case 'scope-unavailable':
      return ['REQUIRED_SCOPE_MISSING'];
    case 'not-allowlisted':
      return ['TARGET_NOT_ALLOWLISTED'];
  }
}

/** Build an engine from an open database + config + resolved rule set. */
export function buildPolicyEngine(
  config: AppConfig,
  database: FormAgentDatabase,
  sensitiveRules: SensitiveRule[],
): PolicyEngine {
  return new PolicyEngine({
    config,
    authz: new AuthorizationStore(database),
    rate: new RateStore(database),
    sensitiveRules,
  });
}

/**
 * Human-readable policy section appended to `form-agent analyze` output
 * (P2-R18). It reports authorization state, sensitive-field counts, and
 * execution eligibility — and never implies that successful analysis grants
 * authorization. No raw payload or answer values are emitted.
 */
export function formatRunPolicySummary(decision: RunPolicyDecision): string {
  const lines: string[] = ['Policy:'];
  lines.push(`  Authorization: ${decision.authorization}`);
  if (decision.authorization !== 'authorized') {
    lines.push('  Execution eligibility: NOT AUTHORIZED for submission/execution');
  } else if (decision.allowed) {
    lines.push('  Execution eligibility: authorized for the run scope');
  } else {
    lines.push('  Execution eligibility: DENIED (not eligible for submission/execution)');
  }
  if (decision.reasons.length > 0) {
    lines.push(`  Reasons: ${decision.reasons.join(', ')}`);
  }
  const sensitive = decision.sensitive;
  const categories = Object.entries(sensitive.byCategory)
    .filter(([, count]) => count > 0)
    .map(([category, count]) => `${category}: ${count}`)
    .join(', ');
  lines.push(`  Sensitive fields: ${sensitive.sensitiveCount}${categories !== '' ? ` (${categories})` : ''}`);
  return lines.join('\n');
}
