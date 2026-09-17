/**
 * Phase 8 OpenClaw plugin entry (P8-R6, P8-R10, P8-R15).
 *
 * Registers exactly two optional model tools — `form_agent` and
 * `form_agent_submit` — plus the host-mediated `before_tool_call` submit
 * approval. The plugin is the ONLY submit execution surface:
 *
 *   typed form_agent_submit tool -> host plugin approval -> adapter submit_pending
 *
 * There is deliberately NO custom submit command and no skill+exec fallback.
 *
 * Verified against the OpenClaw plugin SDK (2026.9.4 docs):
 *   - `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`
 *   - `api.registerTool(factory, { name, optional })`
 *   - `api.on("before_tool_call", handler, { matcher: ["form_agent_submit"] })`
 *   - hook `params` are snapshotted with the approval and applied after it succeeds
 *   - `ctx.requester` provides channel/accountId/senderId
 *   - tool factories provide `requesterSenderId` / `nativeChannelId` / `delivery`
 */

import { Type } from 'typebox';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { validateModelParams } from '../../src/openclaw/contracts.ts';
import {
  buildSubmitApproval,
  verifyApprovalSnapshot,
  type ApprovalSnapshotParams,
  type PendingApprovalView,
} from './approval-hook.ts';
import {
  PendingClient,
  extractReviewValues,
  type AdapterEnvelope,
} from './pending-client.ts';
import { projectModelDetails, renderModelText } from './model-visible.ts';
import {
  deriveToolPrincipal,
  parsePluginConfig,
  type PluginDeploymentConfig,
  type PluginPrincipal,
} from './principal.ts';
import { HardRecoveryLatch, guardAdapterOperation } from './recovery-latch.ts';
import {
  ackSucceeded,
  decideDirectSubmit,
  decideRecoveredHandoff,
  type RecoveryViewLike,
} from './submit-handoff.ts';

const TOOL_RESULT_MAX = 2048;

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

function textResult(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text: text.slice(0, TOOL_RESULT_MAX) }], details };
}

/** Extract eligible review values for the trusted same-chat delivery bridge. */
function reviewText(envelope: AdapterEnvelope): string | null {
  const review = extractReviewValues(envelope);
  if (review === null) return null;
  const label =
    review.kind === 'exact'
      ? 'Exact preflight-plan review (submission-bound to the pending plan):'
      : 'Exploratory draft review (NOT submission-bound):';
  return `${label}\n${review.lines.join('\n')}`.slice(0, TOOL_RESULT_MAX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readApprovalParams(params: unknown): ApprovalSnapshotParams | null {
  if (!isRecord(params)) return null;
  const principal = params['principal'];
  if (!isRecord(principal)) return null;
  if (principal['channel'] !== 'telegram') return null;
  if (typeof principal['accountId'] !== 'string' || typeof principal['senderId'] !== 'string') return null;
  if (typeof params['pendingRef'] !== 'string') return null;
  if (typeof params['planId'] !== 'string') return null;
  if (typeof params['targetKey'] !== 'string') return null;
  if (typeof params['targetDisplay'] !== 'string') return null;
  if (typeof params['expiresAtMs'] !== 'number') return null;
  return {
    pendingRef: params['pendingRef'],
    principal: {
      channel: 'telegram',
      accountId: principal['accountId'],
      senderId: principal['senderId'],
    },
    planId: params['planId'],
    targetKey: params['targetKey'],
    targetDisplay: params['targetDisplay'],
    expiresAtMs: params['expiresAtMs'],
  };
}

function pendingViewOf(envelope: AdapterEnvelope): PendingApprovalView | null {
  const data = envelope.data;
  const pending = data['pending'];
  if (!isRecord(pending)) return null;
  if (typeof pending['pendingId'] !== 'string') return null;
  if (typeof pending['planId'] !== 'string') return null;
  if (typeof pending['targetKey'] !== 'string') return null;
  if (typeof pending['targetDisplay'] !== 'string') return null;
  if (typeof pending['expiresAtMs'] !== 'number') return null;
  if (typeof pending['status'] !== 'string') return null;
  return {
    pendingId: pending['pendingId'],
    planId: pending['planId'],
    targetKey: pending['targetKey'],
    targetDisplay: pending['targetDisplay'],
    expiresAtMs: pending['expiresAtMs'],
    status: pending['status'],
  };
}

export default definePluginEntry({
  id: 'form-agent-openclaw',
  name: 'Form Agent',
  description: 'Bounded OpenClaw + Telegram orchestration of the accepted Form Agent CLI.',
  register(api: any) {
    const parsed = parsePluginConfig(api.pluginConfig);
    if (!parsed.ok) {
      api.logger.error(`form-agent plugin config invalid: ${parsed.errors.join('; ')}`);
      return;
    }
    const config: PluginDeploymentConfig = parsed.value;
    const client = new PendingClient({
      adapterBinaryPath: config.adapterBinaryPath,
      adapterConfigPath: config.adapterConfigPath,
      // The adapter re-validates its own config allowlist before forwarding to
      // Form Agent, so the effective set is exactly the adapter config's names.
      providerEnvNames: config.providerEnvNames,
    });
    // Long-lived, per-principal hard-recovery latch owned by THIS plugin
    // instance. It outlives every short-lived adapter subprocess, so a failed
    // durable barrier in one adapter call fences later calls in the session.
    const hardRecovery = new HardRecoveryLatch();

    api.registerTool(
      (toolContext: any) => {
        const principalResult = deriveToolPrincipal(config, {
          ...(typeof toolContext?.requesterSenderId === 'string'
            ? { requesterSenderId: toolContext.requesterSenderId }
            : {}),
          ...(typeof toolContext?.nativeChannelId === 'string'
            ? { nativeChannelId: toolContext.nativeChannelId }
            : {}),
        });
        return {
          name: 'form_agent',
          description:
            'Run a bounded Form Agent operation (analyze, draft, draft_review, check, preflight, metrics, cancel_pending). Never fills or submits.',
          parameters: Type.Object({
            operation: Type.Union([
              Type.Literal('analyze'),
              Type.Literal('draft'),
              Type.Literal('draft_review'),
              Type.Literal('check'),
              Type.Literal('preflight'),
              Type.Literal('metrics'),
              Type.Literal('cancel_pending'),
            ]),
            target: Type.Optional(Type.String()),
            draftProvider: Type.Optional(Type.String()),
            reviewAnswers: Type.Optional(Type.Boolean()),
            since: Type.Optional(Type.String()),
            until: Type.Optional(Type.String()),
          }),
          async execute(_toolCallId: string, params: unknown) {
            if (!principalResult.ok) {
              return textResult('Request not authorized.', { category: 'unauthorized', status: 'blocked' });
            }
            const validation = validateModelParams(params);
            if (!validation.ok) {
              return textResult('Request rejected: invalid arguments.', { category: 'usage_error', status: 'error' });
            }
            const blocked = guardAdapterOperation(
              hardRecovery,
              principalResult.principal,
              validation.value.operation,
            );
            if (blocked !== null) {
              // Fail closed BEFORE spawning another adapter/Form Agent operation.
              return textResult(blocked.message, {
                category: blocked.category,
                status: blocked.status,
                reason: blocked.reason,
              });
            }
            const call = await client.formAgent(principalResult.principal, validation.value);
            if (!call.ok) {
              return textResult('Form Agent adapter is unavailable.', { category: 'error', status: 'error' });
            }
            const review = reviewText(call.envelope);
            if (review !== null) {
              const send = toolContext?.delivery?.send;
              if (typeof send !== 'function') {
                // Fail closed: never fall back to content/details.
                return textResult('Review delivery is unavailable; no review values were delivered.', {
                  category: 'error',
                  status: 'error',
                });
              }
              try {
                await send({ text: review });
              } catch {
                return textResult('Review delivery failed; no review values were delivered.', {
                  category: 'error',
                  status: 'error',
                });
              }
            }
            // Plugin-owned fixed model-visible text + bounded safe projection.
            // The adapter `message` and arbitrary `data` are never surfaced.
            return textResult(renderModelText(call.envelope.category), {
              operation: call.envelope.operation,
              category: call.envelope.category,
              status: call.envelope.status,
              ...projectModelDetails(validation.value.operation, call.envelope.data),
            });
          },
        };
      },
      { name: 'form_agent', optional: true },
    );

    api.registerTool(
      (toolContext: any) => {
        const principalResult = deriveToolPrincipal(config, {
          ...(typeof toolContext?.requesterSenderId === 'string'
            ? { requesterSenderId: toolContext.requesterSenderId }
            : {}),
          ...(typeof toolContext?.nativeChannelId === 'string'
            ? { nativeChannelId: toolContext.nativeChannelId }
            : {}),
        });
        return {
          name: 'form_agent_submit',
          description:
            'Submit the already-registered pending Form Agent plan. Requires host-mediated operator approval; carries zero model parameters.',
          parameters: Type.Object({}),
          async execute(_toolCallId: string, params: unknown) {
            if (!principalResult.ok) {
              return textResult('Request not authorized.', { category: 'unauthorized', status: 'blocked' });
            }
            const principal: PluginPrincipal = principalResult.principal;
            const snapshot = readApprovalParams(params);
            if (snapshot === null) {
              return textResult('No approved pending submission.', { category: 'no_pending', status: 'blocked' });
            }
            const blocked = guardAdapterOperation(hardRecovery, principal, 'submit_pending');
            if (blocked !== null) {
              return textResult(blocked.message, {
                category: blocked.category,
                status: blocked.status,
                reason: blocked.reason,
              });
            }
            return await executeApprovedSubmit(client, config, principal, snapshot, hardRecovery);
          },
        };
      },
      { name: 'form_agent_submit', optional: true },
    );

    api.on(
      'before_tool_call',
      async (event: any, ctx: any) => {
        if (event?.toolName !== 'form_agent_submit') return;
        const principalResult = deriveToolPrincipal(config, {
          requesterSenderId: ctx?.requester?.senderId,
        });
        if (!principalResult.ok) {
          return { block: true, blockReason: 'Form Agent submission not authorized.' };
        }
        const status = await client.pendingStatus(principalResult.principal);
        const view = status.ok ? pendingViewOf(status.envelope) : null;
        return buildSubmitApproval({
          view,
          config,
          toolPrincipal: principalResult.principal,
          hookRequester: ctx?.requester,
          nowMs: Date.now(),
        });
      },
      { matcher: ['form_agent_submit'], priority: 50 },
    );
  },
});

/**
 * The approved submit execution path. Re-reads the current pending via the
 * adapter (never the JSON file), verifies the frozen snapshot on all six
 * fields, invokes `submit_pending`, then performs the normal
 * `submit_status`/`submit_ack` handoff.
 */
async function executeApprovedSubmit(
  client: PendingClient,
  config: PluginDeploymentConfig,
  principal: PluginPrincipal,
  snapshot: ApprovalSnapshotParams,
  hardRecovery: HardRecoveryLatch,
): Promise<ToolResult> {
  const status = await client.pendingStatus(principal);
  const current = status.ok ? pendingViewOf(status.envelope) : null;
  const verified = verifyApprovalSnapshot(snapshot, current, config, principal.senderId, Date.now());
  if (!verified.ok) {
    return textResult('No pending submission to approve.', { category: 'no_pending', status: 'blocked' });
  }

  const identity = {
    pendingRef: snapshot.pendingRef,
    planId: snapshot.planId,
    targetDisplay: snapshot.targetDisplay,
    operator: `telegram:${principal.senderId}`,
  };

  const call = await client.submitPending(principal, {
    pendingId: snapshot.pendingRef,
    planId: snapshot.planId,
    targetKey: snapshot.targetKey,
    targetDisplay: snapshot.targetDisplay,
    expiresAtMs: snapshot.expiresAtMs,
  });

  // ALWAYS consult the trusted durable recovery state for submit results. A
  // favorable adapter envelope is NEVER surfaced on its own; the decision table
  // requires an exact completed_unambiguous handoff (or start_failed) bound to
  // the approved identity.
  const recoveryCall = await client.submitStatus(principal, {
    pendingRef: snapshot.pendingRef,
    planId: snapshot.planId,
  });
  hardRecovery.recordFromSubmitStatus(principal, recoveryCall.ok ? recoveryCall.envelope : undefined);
  const recoveryView = recoveryCall.ok
    ? (recoveryCall.envelope.data as RecoveryViewLike)
    : undefined;

  const decision = call.ok
    ? decideDirectSubmit(call.envelope, recoveryView, identity)
    : decideRecoveredHandoff(recoveryView, identity);

  if (decision.surface === 'terminal') {
    const ack = await client.submitAck(principal, {
      pendingRef: snapshot.pendingRef,
      attemptId: decision.attemptId,
    });
    // The terminal outcome is proven and remains authoritative; a failed/malformed
    // ack must never be reported as a completed cleanup and must never retry.
    const cleanupOk = ackSucceeded(ack);
    return textResult(categoryMessageFor(decision.category), {
      category: decision.category,
      status: decision.status,
      replayed: decision.replayed,
      ...(cleanupOk ? {} : { cleanupFailed: true }),
    });
  }
  if (decision.surface === 'start_failed') {
    return textResult('Submit process could not be started. A new preflight is required.', {
      category: 'submit_start_failed',
      status: 'error',
    });
  }
  return textResult('Submission outcome is unknown. Manual reconciliation is required.', {
    category: 'unknown_outcome',
    status: 'unknown_outcome',
  });
}

function categoryMessageFor(category: string): string {
  switch (category) {
    case 'ok_submit_success':
      return 'Submission confirmed by Form Agent.';
    case 'blocked_submit':
      return 'Submission blocked by Form Agent. No submission occurred.';
    case 'already_claimed':
      return 'Form Agent reports this submission was already claimed.';
    case 'usage_error':
      return 'Request rejected: invalid arguments.';
    default:
      return 'Submission outcome is unknown. Manual reconciliation is required.';
  }
}
