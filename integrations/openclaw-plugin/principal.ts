/**
 * Phase 8 OpenClaw plugin principal derivation + cross-check (P8-R28).
 *
 * Pure module (no OpenClaw SDK import) so it is unit-testable offline. The
 * canonical principal is:
 *
 *   channel    = constant "telegram" from the deployment contract
 *   accountId  = the immutable dedicated account id from deployment config
 *   senderId   = tool-factory `requesterSenderId` for this call
 *   conversationId? = tool-factory `nativeChannelId` (delivery/audit only)
 *
 * Nothing here is derived from model output, message text, usernames, display
 * names, or forwarded content. Any missing required field fails closed.
 */

import {
  MAX_PROVIDER_ENV_NAMES,
  isAllowedProviderEnvName,
} from '../../src/openclaw/contracts.ts';

export const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SENDER_ID_RE = /^[0-9]{1,20}$/;
export const CONVERSATION_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;

export interface PluginDeploymentConfig {
  accountId: string;
  operatorSenderId: string;
  adapterBinaryPath: string;
  adapterConfigPath: string;
  allowedDraftProviders: string[];
  providerEnvNames: string[];
}

export interface ToolFactoryTrustedContext {
  requesterSenderId?: string;
  nativeChannelId?: string;
}

export interface HookRequesterContext {
  channel?: string;
  accountId?: string;
  senderId?: string;
  senderIsOwner?: boolean;
  roleIds?: string[];
}

export interface PluginPrincipal {
  channel: 'telegram';
  accountId: string;
  senderId: string;
  conversationId?: string;
}

export type PrincipalResult =
  | { ok: true; principal: PluginPrincipal }
  | { ok: false; reason: 'unauthorized' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate an untrusted plugin config object. */
export function parsePluginConfig(raw: unknown): { ok: true; value: PluginDeploymentConfig } | { ok: false; errors: string[] } {
  if (!isRecord(raw)) return { ok: false, errors: ['config must be an object'] };
  const errors: string[] = [];

  const accountId = raw['accountId'];
  if (typeof accountId !== 'string' || !ACCOUNT_ID_RE.test(accountId)) errors.push('accountId invalid');

  const operatorSenderId = raw['operatorSenderId'];
  if (typeof operatorSenderId !== 'string' || !SENDER_ID_RE.test(operatorSenderId)) {
    errors.push('operatorSenderId invalid');
  }

  const adapterBinaryPath = raw['adapterBinaryPath'];
  if (typeof adapterBinaryPath !== 'string' || !adapterBinaryPath.startsWith('/')) {
    errors.push('adapterBinaryPath must be absolute');
  }

  const adapterConfigPath = raw['adapterConfigPath'];
  if (typeof adapterConfigPath !== 'string' || !adapterConfigPath.startsWith('/')) {
    errors.push('adapterConfigPath must be absolute');
  }

  const allowedDraftProvidersRaw = raw['allowedDraftProviders'];
  let allowedDraftProviders: string[] = ['reference', 'openai-compatible'];
  if (allowedDraftProvidersRaw !== undefined) {
    if (!Array.isArray(allowedDraftProvidersRaw) || allowedDraftProvidersRaw.some((v) => typeof v !== 'string')) {
      errors.push('allowedDraftProviders invalid');
    } else {
      allowedDraftProviders = allowedDraftProvidersRaw as string[];
    }
  }

  const providerEnvNamesRaw = raw['providerEnvNames'];
  let providerEnvNames: string[] = [];
  if (providerEnvNamesRaw !== undefined) {
    if (!Array.isArray(providerEnvNamesRaw) || providerEnvNamesRaw.length > MAX_PROVIDER_ENV_NAMES) {
      errors.push('providerEnvNames invalid');
    } else {
      const seen = new Set<string>();
      for (const name of providerEnvNamesRaw) {
        if (typeof name !== 'string' || !isAllowedProviderEnvName(name) || seen.has(name)) {
          errors.push('providerEnvNames invalid');
          break;
        }
        seen.add(name);
        providerEnvNames.push(name);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      accountId: accountId as string,
      operatorSenderId: operatorSenderId as string,
      adapterBinaryPath: adapterBinaryPath as string,
      adapterConfigPath: adapterConfigPath as string,
      allowedDraftProviders,
      providerEnvNames,
    },
  };
}

/**
 * Derive the canonical principal from the TOOL FACTORY trusted context. The
 * dedicated account id comes from immutable deployment config; the sender id
 * comes from `requesterSenderId`. A missing/mismatched sender fails closed.
 */
export function deriveToolPrincipal(
  config: PluginDeploymentConfig,
  toolContext: ToolFactoryTrustedContext,
): PrincipalResult {
  if (!ACCOUNT_ID_RE.test(config.accountId)) return { ok: false, reason: 'unauthorized' };
  if (!SENDER_ID_RE.test(config.operatorSenderId)) return { ok: false, reason: 'unauthorized' };
  const senderId = toolContext.requesterSenderId;
  if (typeof senderId !== 'string' || senderId === '') return { ok: false, reason: 'unauthorized' };
  // Phase 8 is single-operator: only the frozen operator may act.
  if (senderId !== config.operatorSenderId) return { ok: false, reason: 'unauthorized' };

  const principal: PluginPrincipal = { channel: 'telegram', accountId: config.accountId, senderId };
  const nativeChannelId = toolContext.nativeChannelId;
  if (nativeChannelId !== undefined && nativeChannelId !== '' && CONVERSATION_ID_RE.test(nativeChannelId)) {
    principal.conversationId = nativeChannelId;
  }
  return { ok: true, principal };
}

/**
 * Cross-check the `before_tool_call` hook requester against the tool-factory
 * principal. ALL THREE of channel/accountId/senderId must be present and equal.
 * Any mismatch/missing required field fails closed.
 */
export function crossCheckHookRequester(
  config: PluginDeploymentConfig,
  principal: PluginPrincipal,
  requester: HookRequesterContext | undefined,
): { ok: true } | { ok: false; reason: 'unauthorized' } {
  if (requester === undefined) return { ok: false, reason: 'unauthorized' };
  if (requester.channel !== 'telegram') return { ok: false, reason: 'unauthorized' };
  if (requester.accountId !== config.accountId) return { ok: false, reason: 'unauthorized' };
  if (requester.accountId !== principal.accountId) return { ok: false, reason: 'unauthorized' };
  if (requester.senderId === undefined || requester.senderId === '') return { ok: false, reason: 'unauthorized' };
  if (requester.senderId !== principal.senderId) return { ok: false, reason: 'unauthorized' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Dedicated-account deployment validation (AR/AT/AY/AZ) — data-only, no real
// OpenClaw configuration is applied by Phase 8.
// ---------------------------------------------------------------------------

export interface TelegramDeploymentExpectation {
  accountId: string;
  operatorSenderId: string;
  generalAccountId: string;
  agentId: string;
  /** Unrelated global owners that must be preserved in `commands.ownerAllowFrom`. */
  additionalGlobalOwners?: string[];
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Validate the dedicated Telegram account topology against the frozen contract.
 * Returns a list of human-readable setup errors (empty = valid). This is a
 * config-validation helper only; it never contacts Telegram or OpenClaw.
 */
export function validateTelegramDeployment(
  raw: unknown,
  expected: TelegramDeploymentExpectation,
): string[] {
  const errors: string[] = [];
  if (!isRecord(raw)) return ['config must be an object'];
  const channels = isRecord(raw['channels']) ? raw['channels'] : undefined;
  const telegram = channels !== undefined && isRecord(channels['telegram']) ? channels['telegram'] : undefined;
  if (telegram === undefined) return ['channels.telegram missing'];

  // AY: preserve the pre-existing general account as the explicit default.
  if (telegram['defaultAccount'] !== expected.generalAccountId) {
    errors.push('channels.telegram.defaultAccount must be the preserved general account');
  }
  const accounts = isRecord(telegram['accounts']) ? telegram['accounts'] : {};
  const account = isRecord(accounts[expected.accountId]) ? (accounts[expected.accountId] as Record<string, unknown>) : undefined;
  if (account === undefined) {
    errors.push('dedicated telegram account missing');
  } else {
    if (account['dmPolicy'] !== 'allowlist') errors.push('dedicated account dmPolicy must be allowlist');
    if (!Array.isArray(account['allowFrom']) || !deepEqualJson(account['allowFrom'], [expected.operatorSenderId])) {
      errors.push('dedicated account allowFrom must contain exactly the frozen operator');
    }
    if (account['groupPolicy'] !== 'disabled') errors.push('dedicated account groupPolicy must be disabled');
    const groups = account['groups'];
    if (!isRecord(groups) || Object.keys(groups).length !== 0) {
      errors.push('dedicated account groups must be an explicit empty map');
    }
    const execApprovals = isRecord(account['execApprovals']) ? account['execApprovals'] : undefined;
    if (execApprovals === undefined) {
      errors.push('dedicated account execApprovals missing');
    } else if (!Array.isArray(execApprovals['approvers']) || !deepEqualJson(execApprovals['approvers'], [expected.operatorSenderId])) {
      errors.push('dedicated account execApprovals.approvers must be exactly the frozen operator (fences owner fallback)');
    }
  }

  // AR/AY: explicit account-scoped binding to the dedicated non-default agent,
  // with an exact private-DM direct peer for the frozen operator. A broad
  // account-level binding (no peer / group peer / other user) is NOT accepted.
  const bindings = Array.isArray(raw['bindings']) ? raw['bindings'] : [];
  const matched = bindings.some((binding) => {
    if (!isRecord(binding)) return false;
    if (binding['agentId'] !== expected.agentId) return false;
    const match = isRecord(binding['match']) ? binding['match'] : undefined;
    if (match === undefined) return false;
    if (match['channel'] !== 'telegram') return false;
    if (match['accountId'] !== expected.accountId) return false;
    const peer = isRecord(match['peer']) ? match['peer'] : undefined;
    if (peer === undefined) return false;
    if (peer['kind'] !== 'direct') return false;
    if (peer['id'] !== expected.operatorSenderId) return false;
    return true;
  });
  if (!matched) errors.push('missing explicit direct-peer binding to the dedicated account');

  // Dedicated non-default agent with a minimal tool surface.
  const agents = isRecord(raw['agents']) ? raw['agents'] : undefined;
  const entries = agents !== undefined && isRecord(agents['entries']) ? agents['entries'] : undefined;
  const agent = entries !== undefined && isRecord(entries[expected.agentId]) ? (entries[expected.agentId] as Record<string, unknown>) : undefined;
  if (agent === undefined) {
    errors.push('dedicated form-agent agent missing');
  } else {
    if (agent['default'] === true) errors.push('dedicated agent must not be the default');
    const tools = isRecord(agent['tools']) ? agent['tools'] : undefined;
    const allow = tools !== undefined && Array.isArray(tools['allow']) ? (tools['allow'] as unknown[]) : [];
    if (!allow.includes('form_agent') || !allow.includes('form_agent_submit')) {
      errors.push('dedicated agent must allow form_agent and form_agent_submit');
    }
    const deny = tools !== undefined && Array.isArray(tools['deny']) ? (tools['deny'] as unknown[]) : [];
    for (const dangerous of ['group:runtime', 'group:fs', 'group:automation', 'group:messaging', 'cron', 'gateway']) {
      if (!deny.includes(dangerous)) errors.push(`dedicated agent must deny ${dangerous}`);
    }
  }

  // AT/AZ: global owner allowlist is preserved/merged, never replaced.
  const commands = isRecord(raw['commands']) ? raw['commands'] : {};
  const owners = Array.isArray(commands['ownerAllowFrom']) ? (commands['ownerAllowFrom'] as unknown[]) : [];
  const operatorOwner = `telegram:${expected.operatorSenderId}`;
  if (!owners.includes(operatorOwner)) errors.push('commands.ownerAllowFrom must include the frozen operator');
  for (const owner of expected.additionalGlobalOwners ?? []) {
    if (!owners.includes(owner)) errors.push(`commands.ownerAllowFrom must preserve unrelated owner ${owner}`);
  }

  return errors;
}

/** True when the global owner fallback must NOT be relied on for approvals. */
export function approverListFencesOwnerFallback(
  raw: unknown,
  expected: TelegramDeploymentExpectation,
): boolean {
  if (!isRecord(raw)) return false;
  const channels = isRecord(raw['channels']) ? raw['channels'] : undefined;
  const telegram = channels !== undefined && isRecord(channels['telegram']) ? channels['telegram'] : undefined;
  if (telegram === undefined) return false;
  const accounts = isRecord(telegram['accounts']) ? telegram['accounts'] : {};
  const account = isRecord(accounts[expected.accountId]) ? (accounts[expected.accountId] as Record<string, unknown>) : undefined;
  if (account === undefined) return false;
  const execApprovals = isRecord(account['execApprovals']) ? account['execApprovals'] : undefined;
  if (execApprovals === undefined || !Array.isArray(execApprovals['approvers'])) return false;
  // Explicit account-scoped approvers take precedence over (fence) the
  // `commands.ownerAllowFrom` fallback for Telegram native approvals.
  return deepEqualJson(execApprovals['approvers'], [expected.operatorSenderId]);
}
