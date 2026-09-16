# Phase 8 — OpenClaw + Telegram Integration

> **Revision note (final independent planning review correction pass).** This
> revision supersedes the prior two Phase 8 planning drafts. It preserves the
> host-mediated plugin approval correction and additionally freezes: exact
> input bounds (K), exploratory-vs-plan-bound review (L), the evidence-based
> target support matrix (M), the race-safe pending claim/start lifecycle (N),
> the two-surface trusted identity principal (O), the full category→status and
> `formAgentExitCode` semantics (P), the closed child-env schema (Q), the
> non-default dedicated agent (R), and the three-case review privacy contract
> (S). A follow-up micro-correction pass additionally fixes: explicit
> per-field principal sources with `accountId` from deployment config (T),
> the successful-vs-blocked preflight pending contract (U), removal of the
> unverified env passthrough list (V), and the review-envelope→human-delivery→
> model-result stripping rule (W). An acceptance-blocker pass additionally
> fixes: replayable `targetArg` separate from `targetKey` (X), the sticky
> unknown-outcome barrier + local reconciliation and crash recovery (Y), exact
> approval target/plan rendering bounds (Z), the single-operator approval
> contract (AA), the fixture-vs-live setup sequence (AB), post-start
> output-cap/malformed-output ambiguity (AC), and the removal of the custom
> submit command plus documentation-only remote fallback (AD). A final
> consistency pass additionally fixes: crypto/state-bound approval display with
> exact `targetKey`/`targetArg`/`targetDisplay` equality and immutable identity
> fields plus an expanded approval snapshot (AE), crash reconciliation that
> accounts for a possibly-live child (AF), fixture `run`/preflight fixture
> authorization in the setup sequence (AG), and the shared safe-terminal-result
> cleanup list (AH). A final contract-closure pass additionally fixes: the
> internal `PendingApprovalView` carrying `targetKey` for the approval hook (AI),
> the 256-char bound applying only to `targetArg`/`targetDisplay` (AJ),
> non-approvals leaving the pending record `pending` (AK), expiry bound into the
> immutable identity and approval snapshot (AL), required claim ownership
> metadata (AM), and the `UNAMBIGUOUS_TERMINAL_RESULTS` semantics (AN). A final
> implementability pass additionally fixes: the real two-step pre-spawn
> claim/post-spawn ownership persistence (AO), the exact per-operation model
> parameter matrix (AP), the full three-part target recheck (AQ), the dedicated
> account-scoped Telegram topology (AR), and same-config/same-DB auth admin
> consistency (AS). A final deployment/CLI pass additionally fixes: explicit
> dedicated-account group isolation and the GLOBAL (not account-scoped)
> `commands.ownerAllowFrom` scope (AT), preflight always passing `--json-error`
> (AU), the closed category→status and exit-code vocabulary (AV), and the
> §7.2 operation table matching the AP provider-argv matrix with adapter-only
> `reviewAnswers` (AW). A final multi-account/exit-map pass additionally fixes:
> operation-specific exit-0 mapping (successful preflight → `needs_confirmation`;
> no generic `ok` category) and the submit exit `0`/`2`/`3` structured-proof
> override (AX), preservation of the existing Telegram default account (AY), and
> explicit account-scoped approver fencing against the global-owner fallback
> (AZ). A final adapter-crash-consistency microfix adds the crash-safe
> `completed_unambiguous` terminal handoff, the internal idempotent
> `submit_status`/`submit_ack` recovery path, and conservative submit-crash
> classification, and aligns the approval-snapshot wording to all six fields
> (BA). A final terminal-handoff consistency fix removes a valid
> `completed_unambiguous` handoff from the `consumed_unknown` list and removes
> stale immediate-delete wording (BB-1/BB-2), and makes `submit_status` a
> READ/NORMALIZE operation that atomically creates a durable `consumed_unknown`
> recovery barrier on absent/corrupt state (BB-3). Implementation is NOT
> performed by this pass.

## 1. Status, purpose, and non-goals

**PLANNED — NOT IMPLEMENTED.** This document is the planning specification for
Phase 8. It is frozen against implementation and MUST NOT be edited by the
phase-worker (see `.opencode/agents/phase-worker.md`).

Accepted implementation baseline:

```text
fbe2ed0 feat: complete phase 7 metrics observability
```

Accepted history immediately before it:

```text
a84d39e chore: use DeepSeek V4.1 Flash for phase worker
b0cbeb5 docs: define phase 7 metrics observability
aaaa5d0 feat: complete phase 6 real llm wiring
```

### Purpose

Expose a bounded conversational workflow over OpenClaw + Telegram that
orchestrates the **already-accepted** Form Agent CLI (`analyze`, `draft`,
`check`, `run` preflight/submit, `metrics`), while Form Agent remains the sole
authority for every safety-critical decision.

### Non-goals

Phase 8 MUST NOT:

- reimplement or bypass any accepted Form Agent decision;
- add a broad HTTP API, daemon, public listener, webhook server, or opened port;
- add batches, schedulers, queues, cron, or autonomous workflows;
- add new providers, parser changes, answer generation, consistency repair,
  `PolicyEngine` changes, authorization/rate changes, or execution-ordering
  changes;
- create a new metrics/analytics authority;
- invent new Form Agent process exit codes;
- expose unrestricted shell execution or shell-concatenated commands;
- ship a skill+`exec` allowlist submission path (removed from scope; §6.3);
- ship a second submit execution surface such as a custom `/form_agent_submit`
  command (removed from scope; §6.7);
- implement the restricted remote transport (documentation-only contingency;
  §3.3);
- add a Form Agent database migration (see §18).

### Core architectural principle (frozen)

OpenClaw/Telegram MAY orchestrate CLI calls and present results, but MUST NOT:

- override a Form Agent block;
- invent approval;
- regenerate answers during submit;
- bypass `--expect-plan`;
- retry a submission after durable submit intent;
- reinterpret `unknown_outcome` as success;
- mutate policy/rate/receipt/snapshot state except through accepted CLI actions.

Form Agent remains the sole authority for: authorization; sensitive-field
policy; rate policy; draft eligibility; consistency; plan identity; approval
binding; execution gates; durable submission claim; duplicate-submit
prevention; unknown-outcome semantics; metrics/observability.

---

## 2. Accepted Phase 7 baseline (`fbe2ed0`)

Phase 8 builds on accepted Phases 0–7 and preserves:

- migrations `1–9` immutable (migration 9 is `metrics_events`);
- execution-plan version `2.0.0`;
- the observed responder fixture fingerprint
  `7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e`;
- the frozen exit-code contract `0/1/2/3/4/5/127`;
- the frozen Phase 7 metrics JSON/CSV schemas;
- the Phase 5 submit ordering and the Phase 6 approval/snapshot binding.

No accepted baseline is re-audited. Phase 8 only consumes accepted surfaces.

---

## 3. Architecture and selected deployment topology

### 3.1 Intended flow

```text
Telegram user (private DM)
    ↓
OpenClaw Gateway (Telegram channel + dedicated non-default agent + typed plugin tool)
    ↓  before_tool_call.requireApproval  ← host-mediated human confirmation for submit
narrow Form Agent adapter (typed operations, argv arrays)
    ↓
Form Agent CLI
    ↓
existing analyze / draft / check / run / metrics / auth contracts
```

### 3.2 Selected topology (frozen default): co-locate on the OpenClaw host

Deploy the Form Agent runtime (CLI + SQLite + Playwright/Chromium) on the same
Ubuntu host that runs the OpenClaw Gateway and invoke it as a **local
subprocess** through a fixed executable path.

Rationale (smallest attack surface, fewest moving parts):

- no new network listener, port, daemon, or webhook;
- no new authentication surface or credential to protect in transit;
- adapter and Form Agent share one local filesystem trust boundary;
- Chromium execution happens where the operator expects automation to run.

Optional hardening (recommended where practical): run Form Agent under a
dedicated OS user, with only its data directory and config readable by that
user, and keep the adapter executable path fixed and non-writable by the agent
process.

### 3.3 Fallback topology: restricted remote invocation (documentation-only)

Co-location (§3.2) is the frozen default. A restricted SSH/Tailscale transport
is documented ONLY as a contingency and is **NOT implemented in Phase 8**:

- if deployment evidence at implementation time proves co-location infeasible,
  the worker MUST STOP and produce a separate, reviewed transport design (with
  an explicit, non-interpolating forced-command contract) before any code;
- do not improvise `SSH_ORIGINAL_COMMAND`/shell parsing or transport inside the
  Phase 8 adapter;
- any future transport must still apply every rule in this document, and MUST
  NOT introduce a new HTTP API, listener, or open port.

### 3.4 Required extension point: typed plugin tool

The OpenClaw-facing surface is a **typed plugin tool** (OpenClaw Plugin SDK).
The plugin:

- exposes a closed operation enum plus typed, validated arguments;
- derives the trusted principal from the tool-factory runtime context (see §5.5
  and §6.5), never from model-supplied or message-supplied text;
- invokes a fixed adapter executable with `node:child_process.execFile` and an
  **argv array**, `shell: false`;
- returns a bounded `content` string (model-visible) plus structured `details`
  (runtime metadata);
- requires a **host-mediated plugin approval** for submission via
  `before_tool_call.requireApproval`.

**A typed plugin tool is REQUIRED for Phase 8.** A skill + `exec` allowlist
fallback is explicitly out of scope (§6.3).

All OpenClaw-specific API/config details are marked **NEEDS VERIFICATION**
because the Plugin SDK is experimental and version-pinned (§6.6).

---

## 4. Trust boundaries / threat model

| Boundary | Trust level | Control |
|---|---|---|
| Telegram platform | Untrusted transport | All message text is untrusted data |
| Telegram user identity | Claims until validated | Numeric immutable IDs allowlisted in OpenClaw; plugin uses trusted runtime principal (tool factory + `ctx.requester`); adapter re-checks |
| Telegram bot identity | Secret | Bot token in OpenClaw secret store; never in this repo |
| OpenClaw Gateway | Trusted operator runtime | One trust boundary; DM allowlist; dedicated non-default agent tool policy |
| Plugin tool | Trusted code, untrusted inputs | Closed operation enum; validated args; untrusted strings kept out of model `content` |
| Plugin approval (`before_tool_call.requireApproval`) | Host-mediated human authority | `allowedDecisions: ["allow-once","deny"]`; timeout/no-route/deny fail closed |
| Adapter process | Trusted code | Fixed executable path; argv arrays; no shell; bounded I/O |
| Form Agent process | **Sole authority** | All safety decisions originate here |
| Local SQLite / filesystem | Sensitive state + orchestration state | File permissions; no secrets in repo |
| Chromium / browser execution | Powerful local capability | Isolated context; existing Phase 5 constraints |
| Optional LLM provider | External | Existing Phase 6 provider boundary; no new trust |

### 4.1 Submission authority chain (frozen)

1. the model may request a submit tool call (`form_agent_submit`);
2. OpenClaw `before_tool_call` pauses the run and raises a plugin approval;
3. only an explicit human `allow-once` (or deterministic `/approve ... allow-once`)
   releases the frozen tool call;
4. the adapter re-validates the exact server-side pending record before invoking
   Form Agent;
5. Form Agent performs its own approval binding, policy, and durable claim.

A prompt-injected form/title/value may at worst CREATE an approval request. It
can never cause a submission without an explicit host-mediated operator
approval.

### 4.2 Residual risks

- Prompt injection still reaches the dedicated agent's model; mitigated by the
  minimal agent tool surface (§15.2), keeping untrusted strings out of
  model-visible `content` (§13), and the approval gate.
- Approval forwarding misconfiguration (public origin-chat delivery). Mitigated
  by DM-only delivery and numeric approvers.
- Operator device compromise is out of scope (OpenClaw one-trust-boundary model).

---

## 5. Telegram identity and authorization contract

### 5.1 Frozen decisions

1. **Private DM only.** Group/channel use is OUT OF SCOPE for Phase 8.
2. **Numeric user IDs only.** Immutable Telegram numeric `senderId`; never
   display names or `@username`.
3. **Single operator (frozen).** Exactly ONE Telegram numeric operator
   `senderId` is supported for this dedicated Form Agent bot/account. The same
   numeric ID is ALL of: the Telegram DM allowlist operator, `commands.
   ownerAllowFrom`, the native plugin-approval approver, and the adapter's
   allowed principal sender. Multiple Phase 8 human operators are NOT supported
   until a future spec can bind approval-resolver identity to requester identity
   with verified host support (AA).
4. **Dedicated, account-scoped Telegram account (frozen, AR).** Choose ONE
   dedicated OpenClaw Telegram account id (`<form-agent-account-id>`). This exact
   `accountId` is the SAME value used by ALL of: the Telegram account config, the
   agent binding `match.accountId`, the plugin deployment config, and the adapter
   `operatorPrincipal.accountId`. Telegram bot token, DM policy, group policy,
   allowlist, and native-approval settings for this workflow MUST be set under
   `channels.telegram.accounts.<form-agent-account-id>...` (exact installed
   syntax NEEDS VERIFICATION) so the user's unrelated general Telegram account is
   NOT affected. A binding that omits `accountId` matches the channel DEFAULT
   account and is WRONG for this workflow.
   **Default-account preservation (frozen, AY):** the pre-existing general
   Telegram account MUST remain the explicit Telegram default. With two or more
   Telegram account ids, set `channels.telegram.defaultAccount` to the existing
   general account id (or preserve the existing `accounts.default` equivalent)
   so the dedicated `<form-agent-account-id>` NEVER becomes the default for
   unrelated workflows. Do not move/rename/rewrite the existing account merely
   for Phase 8. Phase 8 routing never depends on the default because all Form
   Agent routing uses the explicit `match.accountId` plus the immutable
   plugin/adapter accountId.
5. **Deny by default and explicitly DM-only (frozen, AT).** Account-scoped
   `dmPolicy: "allowlist"` with only the frozen operator ID in `allowFrom`, AND
   explicit account-scoped group isolation:
   - `groupPolicy: "disabled"`, and
   - `groups: {}` (an explicit empty map),
   because multi-account Telegram inherits root `channels.telegram.groups` for
   accounts that OMIT `groups`. "No groups configured" is NOT sufficient.
   The general/default account's root/account group config stays untouched.
6. **Owner vs approver scope (frozen, AT + AZ).** `commands.ownerAllowFrom` is a
   GLOBAL command-owner allowlist, NOT scoped under
   `channels.telegram.accounts.<id>`. It is not the dedicated-account isolation
   boundary. Preserve unrelated existing valid global owners; do not
   overwrite/narrow them without an explicit deployment decision. The dedicated
   Form Agent account MUST have an explicit, non-empty account-scoped
   `channels.telegram.accounts.<form-agent-account-id>.execApprovals.approvers`
   containing EXACTLY the frozen Form Agent operator (exact syntax NEEDS
   VERIFICATION). Phase 8 MUST NOT rely on the global `commands.ownerAllowFrom`
   fallback for Form Agent approvals; an unrelated global owner MUST NOT be
   accepted as a Form Agent approver merely for being a global owner. At
   implementation start, verify the installed version fences the owner fallback
   when an explicit account-scoped approver list is present; if it instead unions
   unrelated global owners into the dedicated account's plugin-approval
   authority, STOP before implementation and produce a reviewed approval-routing
   adaptation (do not weaken AA). Rely on the dedicated originating account's
   same-chat/native approval path. `approvals.plugin` forwarding is OPTIONAL
   routing, NOT the approval primitive, and MUST NOT forward this approval to
   other humans or chats.
7. **Trusted principal required.** The plugin requires the canonical principal
   (§5.5) from the host runtime; if any required field is absent, it fails
   closed (`unauthorized`) and MUST NOT invoke the adapter. Phase 8 still
   supports only ONE Form Agent operator via the dedicated account + adapter
   principal even if unrelated global owners exist.
8. **Forwarded content is untrusted data.** It never grants identity or
   authorization. Phase 8 does NOT depend on a forward-message provenance flag
   (§5.3).
9. **Adapter re-check (defense in depth).** The adapter re-validates the trusted
   principal against its single configured operator principal before any work.
10. **No auth mutation over Telegram.** `auth allow`/`auth revoke` remain
    operator CLI/admin actions (P8-R19).

### 5.2 Bot token exposure

The bot token is stored only through OpenClaw's accepted secret mechanism
(SecretRef / secret store). It MUST NOT appear in the Form Agent repo, adapter
config, adapter output, approval descriptions, or logs.

### 5.3 Forward provenance (corrected)

Official docs verify trusted requester fields and state that **missing fields
are unproven, not false assurances; fail closed when policy requires them**. No
stable forwarded-message boolean is documented for tool factories or
`before_tool_call`.

Therefore:

- private-DM-only is enforced at the channel config layer by the account-scoped
  `groupPolicy: "disabled"` + explicit `groups: {}` (AT) and by the
  dedicated-agent binding to a direct peer where the runtime supports it;
- if the installed runtime exposes a stable direct-chat/forward provenance field,
  the plugin MUST use it and reject non-direct origin;
- otherwise forwarded text is merely untrusted content and the
  authorization/approval model does not depend on forward metadata.

### 5.4 Message retention disclosure

Telegram retains messages. Default summary-only output (§13) minimizes this;
explicit exploratory or exact-plan review values are an external disclosure the
user must accept (§15 checklist).

### 5.5 Canonical trusted principal (frozen)

The two OpenClaw trusted surfaces are DIFFERENT and MUST NOT be conflated:

| Surface | Trusted fields |
|---|---|
| Tool factory (`api.registerTool` / `defineToolPlugin` `factory`) | `requesterSenderId`, `nativeChannelId`, delivery context (`toolContext.delivery?.send`) |
| `before_tool_call` hook | `ctx.requester` = `{ channel, accountId, senderId, senderIsOwner, roleIds }` (optional; missing = unproven) |

Current official tool-factory docs do NOT promise a tool-factory `accountId`.
Therefore Phase 8 freezes the dedicated Telegram account identity in immutable
plugin deployment configuration, not in a runtime field that may not exist.

Frozen canonical principal, with an explicit trusted source per field:

| Field | Exact trusted source |
|---|---|
| `channel` | Constant `"telegram"` from the plugin/tool deployment contract |
| `accountId` | The single dedicated `<form-agent-account-id>` from immutable plugin/deployment config (same value as the Telegram account config and binding `match.accountId`; AR); never model params |
| `senderId` | Tool-factory `requesterSenderId` (captured for the tool call / approval snapshot); hook `ctx.requester.senderId` MUST equal it |
| `conversationId` | Tool-factory `nativeChannelId` when present (delivery/audit only; not part of the pending key) |

```text
{
  channel:     "telegram"
  accountId:   <configured dedicated Telegram account id>
  senderId:    <numeric Telegram user id>
  conversationId?: <nativeChannelId, when available>
}
```

Rules:

- Model params NEVER contain any principal field.
- Phase 8 is single-operator: the principal `senderId` MUST equal the one
  frozen operator ID (§5.1) configured across Telegram allowlist, command
  owner, plugin-approval approver, and the adapter's allowed operator.
- `channel` = `"telegram"` and `accountId` = configured deployment account id;
  neither is derived from a message or model input.
- Tool execution obtains `senderId`/`conversationId` from the tool-factory
  trusted context (`requesterSenderId` / `nativeChannelId`).
- The submit approval hook requires `ctx.requester.channel`,
  `ctx.requester.accountId`, and `ctx.requester.senderId`, and compares all
  three to `("telegram", configured accountId, captured requesterSenderId)`.
- If the installed OpenClaw version exposes a host-trusted tool-factory
  `accountId`, it MAY be used as an additional cross-check, but the design MUST
  NOT require a field current official tool-factory docs do not promise.
- The plugin MUST cross-check that the hook principal (frozen in the approval
  snapshot) and the tool-factory principal agree on `channel`, `accountId`, and
  `senderId` before invoking the adapter. Any mismatch or missing required hook
  field fails closed (`unauthorized`).
- The pending key is `(channel, accountId, senderId)`; `conversationId` is kept
  for audit and delivery context only. No synthetic chat IDs are invented.
- The implementation-start checklist MUST verify the installed OpenClaw version
  provides the required `ctx.requester` fields (`channel`, `accountId`,
  `senderId`) and tool-factory `requesterSenderId`; otherwise STOP before
  writing code.

---

## 6. OpenClaw adapter / tool / skill contract

> OpenClaw facts below were verified against `docs.openclaw.ai` on 2026-09-15.
> The Plugin SDK is **experimental** and version-pinned; exact imports,
> `registerTool`/`defineToolPlugin` signatures, hook names, `ctx.requester`
> shape, tool-factory context field names, manifest fields, approval parameter
> snapshot correlation (run/tool-call id), and `plugin.approval.*` request APIs
> are **NEEDS VERIFICATION**. The Form-Agent-side adapter contract (§7–§10) is
> fully frozen by this repo.

### 6.1 Tools exposed to the model (frozen names)

| Tool | Purpose | Model params | Approval |
|---|---|---|---|
| `form_agent` | analyze / draft / draft_review / check / preflight / metrics / cancel_pending | `operation` enum + `target?` + `draftProvider?` + `reviewAnswers?` + `since?` + `until?` | none |
| `form_agent_submit` | submit the server-side pending plan | none | REQUIRED |

`form_agent` is an optional tool requiring explicit `tools.allow`.
`form_agent_submit` is a separate optional tool whose only effect is to run the
already-registered pending submission; it carries **no plan/target/secret/
identity parameters**.

The adapter operations `pending_status` and `reconcile_unknown` are NOT
model-facing: they do not appear in the `form_agent` `operation` enum. The
trusted plugin calls `pending_status` internally (AI), and `reconcile_unknown`
is operator-only local CLI (AF).

`reviewAnswers` is a bounded boolean affecting only presentation of the exact
preflight result (§13.3); it never changes Form Agent business behavior.

#### 6.1.1 Frozen model operation-parameter matrix (AP)

A field that is globally known but invalid for the selected operation is a
`usage_error` (never silently ignored). Unknown fields are rejected. Raw values
are never echoed on validation failure.

| `operation` | `target` | `draftProvider` | `reviewAnswers` | `since` | `until` |
|---|---|---|---|---|---|
| `analyze` | REQUIRED | not allowed | not allowed | not allowed | not allowed |
| `draft` | REQUIRED | optional | not allowed | not allowed | not allowed |
| `draft_review` | REQUIRED | optional | not allowed | not allowed | not allowed |
| `check` | REQUIRED | optional | not allowed | not allowed | not allowed |
| `preflight` | REQUIRED | optional | optional | not allowed | not allowed |
| `metrics` | not allowed | not allowed | not allowed | optional | optional |
| `cancel_pending` | not allowed | not allowed | not allowed | not allowed | not allowed |

- `form_agent_submit`: ZERO model parameters (separate tool).
- `pending_status`: internal/plugin-only; no model parameters.
- `reconcile_unknown`: local operator-only; no model parameters.
- When `draftProvider` is present for `draft`/`draft_review`/`check`/`preflight`,
  the adapter passes the accepted `--draft-provider <id>` to Form Agent (all
  three accepted commands support it; `src/cli/draft.ts`, `src/cli/check.ts`,
  `src/cli/run.ts`). The local `allowedDraftProviders` allowlist is preserved.

### 6.2 Host-mediated submit approval (frozen)

The plugin registers a `before_tool_call` hook with `matcher:
["form_agent_submit"]`. The hook:

1. reads trusted `ctx.requester`; if missing/not allowlisted → `{ block: true,
   blockReason: "Form Agent submission not authorized." }`;
2. queries the adapter `pending_status` (read-only, INTERNAL) for the trusted
   principal; if none/terminal/expired → `{ block: true, blockReason: "No
   pending submission to approve." }`;
3. otherwise returns:

```typescript
{
  params: {                                     // host snapshots params with the approval
    pendingRef:   "<trusted pendingId>",
    principal:    { channel: "telegram", accountId, senderId },
    planId:       "<trusted 64-hex planId>",
    targetKey:    "<trusted canonical target identity key>",
    targetDisplay:"<trusted canonical display>",
    expiresAtMs:  "<trusted pending expiry epoch ms>",
  },
  requireApproval: {
    title: "Approve form submission",
    description:
      `Submit the approved preflight plan.` +
      ` Target: ${targetDisplay}` +   // FULL canonical targetDisplay (<=256)
      ` Plan: ${planId}` +             // FULL 64-hex planId
      ` Expires: ${expiryIsoUtc}`,     // from expiresAtMs, bounded
    severity: "critical",
    allowedDecisions: ["allow-once", "deny"],
    timeoutMs: 120_000,
  },
}
```

All six `params` fields come from trusted `pending_status` state or trusted
runtime context, never from model params. The `pending_status` envelope's
`data.pending` is `PendingApprovalView` (AI), which carries `targetKey` for
exactly this purpose.

Frozen rules:

- `allowedDecisions` is EXACTLY `["allow-once", "deny"]`. `allow-always` is
  never offered and the plugin must reject it defensively if somehow received.
- `timeoutMs` is `120_000`; timeout, cancellation, deny, or no connected
  approval route ALL fail closed and MUST NOT invoke Form Agent. On such a
  non-approval, the pending record REMAINS `pending` (no adapter mutation runs on
  deny/timeout/no-route); the workflow returns to `pending_confirmation`, not
  `idle` (AK). The operator may re-request approval while the TTL is valid,
  `cancel_pending`, run a new preflight (replacement), or let it expire.
- Approval rendering (frozen, §Z): the description shows the FULL canonical
  `targetDisplay` (≤256 chars, §7.4) and the FULL 64-hex `planId`, plus an
  expiry derived from the frozen `expiresAtMs`, all from the trusted
  `PendingApprovalView`, never from model params. No short/truncated plan hash.
  The fixed `title` is ≤80 chars and the rendered `description` is ≤512 chars by
  construction; the implementation must prove the maximum-length case. It
  contains no secrets/answer values, and the preflight human delivery shows the
  same full `planId` + `targetDisplay`.
- `params` is injected by the hook from trusted state and frozen into the
  approval snapshot; the model cannot supply or change it. The snapshot covers
  ALL SIX fields `{ pendingRef, principal, planId, targetKey, targetDisplay,
  expiresAtMs }` (AE + AL); tool execution re-reads current pending and requires
  exact equality for all six plus current expiry before claim/spawn.
- `onResolution` (if used) is logging only; it never authorizes execution. It
  does not supply an independently bindable approver identity, which is why
  Phase 8 is single-operator (§5.1, AA).

### 6.3 No skill+exec submission fallback (removed)

The earlier draft allowed a skill + `tools.exec` allowlist fallback. It is
REMOVED from accepted scope because `tools.exec` governs the core `exec` tool,
not a plugin's `child_process`; dynamic arguments make "exact
non-interpolated command" unrealistic; and trusted identity would become
shell/model-composed. A skill may be shipped only to describe how to call the
typed tools; it MUST NOT be an alternate execution path.

### 6.4 Plugin spawn is NOT mediated by `tools.exec` (frozen)

A plugin calling Node `child_process.execFile` directly is plugin code and is
**not** governed by `tools.exec` approvals/allowlists. Controls for the direct
plugin spawn are: plugin enablement + optional-tool `tools.allow`; dedicated
non-default-agent per-tool allow/deny; trusted principal check; fixed executable
path; closed typed params; `shell:false`; the closed env allowlist (§14); and
OS filesystem permissions. The setup checklist MAY recommend a conservative
`tools.exec.mode` for the rest of the agent, but MUST NOT describe it as
protection for the plugin's `execFile`.

### 6.5 Tool/hook identity cross-check (frozen)

Before invoking the adapter for `form_agent_submit`, the plugin execution path:

- re-reads the frozen approval-snapshot params
  `{ pendingRef, principal, planId, targetKey, targetDisplay, expiresAtMs }`;
- requires `params.principal.channel === "telegram"`;
- requires `params.principal.accountId === configured deployment accountId`;
- requires `params.principal.senderId === requesterSenderId` captured from the
  tool-factory trusted context for this call;
- requires `params.pendingRef === current pending.pendingId`;
- requires `params.planId === current pending.planId`;
- requires `params.targetKey === current pending.targetKey`;
- requires `params.targetDisplay === current pending.targetDisplay`;
- requires `params.expiresAtMs === current pending.expiresAtMs`;
- requires the current pending to still be `pending` and bound to the same
  principal;
- on any mismatch/missing value, fails closed and does not invoke the adapter.

The adapter `submit_pending` path separately requires `nowMs < expiresAtMs`
(AL); the plugin never extends a TTL in place.

The run/tool-call identifier correlation between a `before_tool_call` event and
the concrete tool's `execute` is **NEEDS VERIFICATION**; if the installed
version cannot reliably correlate them, the plugin must use the frozen
`params.*` re-read from the approval snapshot and still enforce the equality
rules above against the configured account id and the tool-factory
`requesterSenderId`.

### 6.6 NEEDS VERIFICATION (installed version)

- exact Plugin SDK import paths and `registerTool`/`defineToolPlugin` signature;
- `before_tool_call` return shape and the params-snapshot-with-approval behavior;
- `ctx.requester` field availability (`channel`, `accountId`, `senderId`) and
  direct-chat provenance; account id is taken from deployment config and only
  used as an extra cross-check if a host-trusted tool-factory accountId exists;
- tool-factory context field names (`requesterSenderId`, `nativeChannelId`,
  delivery helper) and availability on Telegram; no tool-factory `accountId` is
  required;
- tool-call/run id correlation between hook and tool execute;
- **Telegram account scoping + routing (AR + AT + AY + AZ):** exact installed
  syntax for multi-account `channels.telegram.accounts.<form-agent-account-id>`
  (bot token, `dmPolicy`, `allowFrom`, `groupPolicy: "disabled"`, `groups: {}`),
  account-scoped native approval (`execApprovals.approvers`), and
  `bindings[].match.accountId`; verify that root `channels.telegram.groups` is
  the shared default for accounts that omit `groups` (so the dedicated account
  MUST set an explicit empty `groups`), that `channels.telegram.defaultAccount`
  preserves the pre-existing general account so the dedicated account never
  becomes the default (AY), that an omitted binding `accountId` matches the
  channel default, that the dedicated account routes only to the Form Agent
  agent while the general/default account keeps its existing agent, that
  `commands.ownerAllowFrom` is GLOBAL (not account-scoped), and that an explicit
  account-scoped approver list FENCES the global-owner fallback for that account
  (AZ; if it cannot be proven, STOP before implementation);
- **hook-injected internal params (implementation-start gate):** verify on the
  installed version that the trusted hook-injected
  `pendingRef/principal/planId/targetKey/targetDisplay/expiresAtMs` fields
  survive approval and are delivered to `form_agent_submit.execute` WITHOUT
  schema rejection and WITHOUT becoming model-authoritative. If not supported,
  STOP before implementation and produce a reviewed binding adaptation (e.g. a
  verified tool-call correlation mechanism). Do NOT silently expose
  authority-bearing fields as model-controlled inputs and do NOT drop the
  approval binding.
- `approvals.plugin` (optional routing) and Telegram native/same-chat plugin
  approval behavior.

### 6.7 No second submit execution surface (removed)

Phase 8 has exactly ONE submit execution surface:

```text
typed form_agent_submit tool
  -> host plugin approval (before_tool_call.requireApproval)
  -> adapter submit_pending
```

A custom `/form_agent_submit` command (or any other alternate submit path) is
REMOVED from Phase 8 implementation scope. The operator may still approve via
OpenClaw's normal plugin-approval surfaces/buttons or generic
`/approve <id> ...`; Phase 8 must not create a second, custom submit command.
This keeps a single, auditable submission path whose only execution gate is the
host-mediated approval.

---

## 7. Form Agent adapter operations exposed

The adapter is a separate entrypoint (`bin/form-agent-openclaw.js` →
`src/openclaw/main.ts`). It does NOT modify the accepted `form-agent` CLI
dispatcher.

### 7.1 Frozen operation grammar

```text
form-agent-openclaw <operation> \
  --channel <channel> \
  --account <accountId> \
  --sender <numeric-sender-id> \
  [--conversation <conversationId>] \
  [operation-specific flags]
```

`--channel`/`--account`/`--sender` are mandatory. `--channel` is the constant
`telegram`, `--account` is the configured dedicated Telegram account id
(immutable deployment config), and `--sender` is the numeric Telegram user id
from the tool-factory `requesterSenderId`. None of these is model-supplied.
Operation-specific flags (e.g. `--target`) are the only validated model-derived
arguments. Unknown operations/flags are rejected without echoing raw content.
The adapter emits exactly one JSON envelope on stdout and no prose.

### 7.2 Frozen operation list

| Operation | Args | Underlying Form Agent call | Notes |
|---|---|---|---|
| `analyze` | `--target` | `analyze <target> --json` | fixture only |
| `draft` | `--target` [`--draft-provider <id>`] | `draft <target> --seed <adapter-generated> --json` [`--draft-provider <id>`] | summary only |
| `draft_review` | `--target` [`--draft-provider <id>`] | `draft <target> --seed <adapter-generated> --json` [`--draft-provider <id>`] | exploratory; NOT submission-bound |
| `check` | `--target` [`--draft-provider <id>`] | `check <target> --seed <adapter-generated> --json` [`--draft-provider <id>`] | block stays a block |
| `preflight` | `--target` [`--draft-provider <id>`] [`--review-answers`] | `run <target> --seed <adapter-generated> --json --json-error` [`--draft-provider <id>`] | registers pending; exact-plan review |
| `pending_status` | none | none | INTERNAL/plugin-only (AI); not in the model `form_agent` enum; returns `PendingApprovalView` |
| `submit_status` | `--pending-ref <id>?` `--plan <planId>?` | none | INTERNAL/plugin-only crash-recovery READ/NORMALIZE (BA/BB, §8.6.1/§8.6.3); normalizes leftover `claimed` and atomically creates a durable `consumed_unknown` barrier on absent/corrupt state; returns the recovery view incl. a stored `completed_unambiguous` result |
| `submit_ack` | `--pending-ref <pendingId>` `--attempt <attemptId>` | none | INTERNAL/plugin-only idempotent ack (BA, §8.6.1); clears ONLY a matching `completed_unambiguous` handoff; never invokes Form Agent |
| `submit_pending` | `--pending-ref <pendingId>` | `run <pending.targetArg> --seed <pending.seed> --submit --expect-plan <pending.planId> --by telegram:<sender> --json --json-error` | invoked only after host approval; never uses `targetKey` |
| `cancel_pending` | none | none | cancels status `pending` only; model-facing |
| `reconcile_unknown` | `--pending-ref <pendingId>` `--resolution observed-submitted\|observed-not-submitted` | none | OPERATOR-ONLY local recovery; not an OpenClaw tool/Telegram command |
| `metrics` | [`--since`][`--until`] | `metrics export --format json [...]` | read-only |

Notes (frozen, AU + AW):

- `seed` is NOT a model/user parameter. The adapter generates a bounded seed
  (§7.4) and stores it in the pending record for `submit_pending`.
- `operator` is derived as `telegram:<senderId>`; never free text.
- `draft`/`draft_review`/`check`/`preflight` pass the accepted
  `--draft-provider <id>` when the model supplies `draftProvider` (matching the
  AP matrix); the adapter keeps the local `allowedDraftProviders` allowlist.
- **`preflight` ALWAYS passes `--json-error` (AU).** A successful preflight is
  the accepted normal `--json` success document; a controlled failure after
  argument parsing is the frozen `--json-error` document. The adapter never
  scrapes human stderr to infer authorization/policy/consistency state, and no
  pending record is created on a failed/blocked preflight.
- `reviewAnswers` is an ADAPTER/PLUGIN option, NOT a Form Agent CLI flag.
  Current accepted source implements NO `--review-answers` flag (verified:
  none exists in `src/`). Form Agent preflight still runs ONCE with the accepted
  CLI args; the adapter parses the accepted preflight JSON answer projection
  and performs trusted human delivery. The operation-flag shown above is the
  adapter's own `--review-answers`, not a Form Agent flag.
- `pending_status` and `reconcile_unknown` are not model-invocable; the former
  is used by the trusted plugin hook, the latter is a local operator CLI only.
  `reconcile_unknown` is never exposed to the model or Telegram.

### 7.3 Target support matrix (evidence-based, frozen)

| Operation | `fixture` | `google-forms` | `file` | `url` | `raw` |
|---|---|---|---|---|---|
| `analyze` | yes | NO | no | no | no |
| `draft` | yes | NO | no | no | no |
| `draft_review` | yes | NO | no | no | no |
| `check` | yes | NO | no | no | no |
| `preflight` | yes | yes | no | no | no |
| `submit_pending` | pending only | pending only | no | no | no |

Evidence for the `google-forms` restriction (repository is the source of
truth):

- `analyze`/`draft`/`check`/`draft_review` use `resolveAnalyzeInput`, which
  accepts only local files, fixture URLs, and fixture ids and explicitly rejects
  live `http(s)` targets without any fetch (`src/analyze/resolve-input.ts:66-70`,
  used by `src/cli/draft.ts` and `src/cli/check.ts`).
- `run` preflight uses the execution provider, which supports the fixture and
  the accepted exact Google Forms responder shape (`src/policy/target.ts`,
  `src/providers/execution.ts`).

Consequence (explicit scope note): a live Google Forms responder URL cannot be
offline-analyzed/drafted/checked over Telegram without changing accepted Phase
1/3/4 behavior, which Phase 8 must not do. For live forms, the supported
Telegram workflow is `preflight`, which performs the runtime structural
snapshot, draft, consistency gate, plan identity, and (on request) exact-plan
review of the eligible answers. `analyze`/`draft`/`check`/`draft_review` remain
available for local fixtures. This is a deliberate, evidence-based deviation
from the assumption that `google-forms` works for all non-submit operations.

### 7.4 Frozen input validation table

Ranges are inclusive. Every model/user-controlled string rejects NUL and ASCII
control characters (`U+0000-U+001F`, `U+007F`) before any other check.

| Field | Exact rule |
|---|---|
| `target` | trimmed; non-empty; max 2048 UTF-16 code units; then `canonicalizeTarget`; then the §7.3 allowed-kind check. No broad URL normalization |
| canonical `targetDisplay` / `targetArg` | ≤256 chars after canonicalization; otherwise the Phase 8 request is rejected (`usage_error`) before preflight (Z). The 256 cap is on the sanitized canonical form, not the raw input |
| `draftProvider` | max 32 chars; regex `^[a-z][a-z0-9-]{0,31}$`; must be in adapter config `allowedDraftProviders` (subset of `reference`, `openai-compatible`) |
| `reviewAnswers` | boolean |
| `since` / `until` | max 35 chars; delegated to the accepted strict RFC3339-with-timezone parser; invalid → `usage_error` |
| `pendingRef` | exactly 32 lowercase hex: `^[0-9a-f]{32}$` |
| `planId` (internal only) | exactly 64 lowercase hex: `^[0-9a-f]{64}$` |
| `resolution` (operator-only) | exactly `observed-submitted` or `observed-not-submitted` |
| `channel` | exactly `telegram` (deployment-derived) |
| `accountId` | `^[A-Za-z0-9_-]{1,64}$`; must equal the configured dedicated-account id (deployment-derived, never model-supplied) |
| `senderId` | `^[0-9]{1,20}$` (from tool-factory `requesterSenderId`) |
| `conversationId` | optional; `^[A-Za-z0-9:_-]{1,128}$` (from `nativeChannelId`) |
| adapter-generated `seed` | exactly 32 lowercase hex (`crypto.randomBytes(16)`); never model/user supplied |
| adapter-generated `pendingId` | exactly 32 lowercase hex (`crypto.randomBytes(16)`) |
| flags/fields | unknown flags and unknown/extra fields rejected; never echoed |
| forbidden fields | no executable, path, cwd, or env field is ever accepted |

Tests pin each boundary (max accepted and, where useful, max+1 rejected).

### 7.5 Prohibitions (frozen)

- No operation accepts a local filesystem path, executable name, shell string,
  cwd, or env supplied by Telegram/model.
- Arguments are always an argv array; `shell` is never enabled.
- The adapter never reads/writes Form Agent policy/rate/receipt/snapshot state
  directly; only the underlying CLI does.

---

## 8. Machine-readable input/output contracts consumed

### 8.1 Existing contracts consumed (unchanged)

- `draft --json` — `draftToJson(bundle)`.
- `check --json` — `checkToJson(bundle, report)`.
- `run --json` preflight — `preflightToJson(...)` (includes the eligible
  `answers` projection of the exact bundle that produced the persisted plan).
- `run --json --submit` — `submitToJson(...)` (emitted even for
  `unknown_outcome`).
- `metrics export --format json` — the frozen Phase 7 document.

### 8.2 Minimal additive Form Agent CLI surfaces (frozen schemas)

**(A) `analyze --json`** — additive success document on stdout:

```json
{
  "command": "analyze",
  "form": { "id": "<formId>", "title": "<title>" },
  "fingerprint": "<64-hex>",
  "sections": [ { "index": 0, "title": "<title>", "questionCount": 3 } ],
  "questions": { "total": 10, "required": 4, "optional": 6 },
  "kinds": { "text": 2, "single-choice": 1 },
  "routing": "sequential",
  "answerModel": "<model>",
  "terminalSectionIds": [ "<id>" ],
  "policy": { "scope": "run", "allowed": true, "reasons": [] }
}
```

**(B) `run --json-error`** — additive controlled-failure document on stdout,
only when the flag is present, for failures detected after argument parsing:

```json
{
  "command": "run",
  "mode": "preflight" | "submit",
  "ok": false,
  "error": { "code": "SUBMISSION_ALREADY_CLAIMED", "kind": "block" | "usage" | "error" }
}
```

Absent-flag output/exit codes are byte-identical to accepted behavior. Exactly
one machine document is produced on the relevant `run --json [--json-error]`
path; raw child stdout/stderr is never concatenated into an adapter document.

### 8.3 Adapter envelope (frozen)

Exactly one JSON document on stdout:

```json
{
  "version": "1.0.0",
  "operation": "preflight",
  "status": "needs_confirmation",
  "category": "needs_confirmation",
  "formAgentExitCode": 0,
  "message": "Preflight ready. No fill or submission occurred. A submission approval is required to proceed.",
  "data": { },
  "pending": {
    "pendingId": "<32 lowercase hex>",
    "planId": "<64 lowercase hex>",
    "targetDisplay": "<bounded>",
    "expiresAtMs": 0,
    "status": "pending"
  }
}
```

Preflight pending contract (frozen):

- A **successful** preflight (`status = needs_confirmation`, `category =
  needs_confirmation`) MUST have a **non-null** `pending` `PendingSummary`.
- A failed/blocked preflight creates no pending record and returns
  `pending = null`.
- Exact-plan review values NEVER appear inside `pending`.

Frozen `status` values: `ok`, `needs_confirmation`, `blocked`,
`already_claimed`, `unknown_outcome`, `error`.

Frozen per-operation `data` (no extra fields):

- `analyze`: `formTitle, fingerprint, sectionCount, questionCount,
  requiredCount, optionalCount, kinds, routing, policyAllowed, policyReasons`.
- `draft` / `draft_review`: `formTitle, draftId, fingerprint, providerId,
  providerVersion, summary, answeredCount`. `draft_review` additionally:
  `draftAnswers: [{ questionId, kind, value }]` for eligible `answered` entries
  only. Exploratory only; never presented as the pending plan.
- `check`: `formTitle, fingerprint, reportId, status, hardIssues, softIssues,
  issueCodes`.
- `preflight`: `formTitle, targetDisplay, fingerprint, draftId, reportId,
  consistencyStatus, planId, providerId, providerVersion, draftProviderId,
  draftProviderVersion, modelLabel, fillableCount, blockedCount, policyAllowed,
  policyReasons, accepting`. When `--review-answers` is set, additionally:
  `planReview: [{ questionId, kind, value }]` for eligible `answered` entries
  from the SAME preflight result.
- `pending_status` (INTERNAL, plugin-only): exactly
  `{ "pending": PendingApprovalView | null }`.
- `submit_pending`: `runId, planId, targetDisplay, fingerprint, receiptState,
  submitAttempted, outcome, outcomeCode, operator, consistencySoftIssues`.
- `reconcile_unknown` (operator-only): `{ pendingId, previousStatus, resolution,
  resultingStatus }`.
- `metrics`: exactly `{ "metrics": <Phase7ExportDocument> }` where the inner
  value is the accepted Phase 7 `metrics export --format json` document.

Two distinct pending shapes (frozen, AI):

```text
PendingSummary =              // model/user-facing, smaller safe shape
  { pendingId, planId, targetDisplay, expiresAtMs, status }

PendingApprovalView =         // internal /plugin-facing only
  { pendingId, planId, targetKey, targetDisplay, expiresAtMs, status }
```

- `pending_status` is an INTERNAL adapter operation used only by the trusted
  plugin. It is NOT exposed in the model-facing `form_agent` operation enum
  (§6.1). Its envelope `data.pending` is `PendingApprovalView | null`.
- `PendingSummary` (frozen): `{ pendingId, planId, targetDisplay, expiresAtMs,
  status }` — never answers, secrets, or principal secrets beyond policy; never
  `targetKey`/`targetArg`. It is what any model-facing result may carry.
- `PendingApprovalView` additionally carries `targetKey` so the trusted approval
  hook can construct the frozen approval snapshot (AL) using ONLY trusted
  runtime context + `pending_status`. `targetArg`, seed, answers, raw target
  input, secrets, provider env values, and execution snapshot bodies remain
  absent from both shapes.
- The plugin MUST NOT read the pending JSON file directly; the adapter remains
  the single state interface.
- `status` in both shapes is the pending-store status (§11.1).

### 8.4 Category → status mapping (frozen closed vocabulary, AV)

Preflight success is EXACTLY `needs_confirmation`; `ok_preflight` does not
exist. A category string has exactly ONE status across all layers (adapter
envelope, plugin pre-adapter result); `unauthorized` is `blocked` everywhere.

Adapter-envelope categories:

| Category | Status |
|---|---|
| `ok_analyze` | `ok` |
| `ok_draft` | `ok` |
| `ok_check` | `ok` |
| `needs_confirmation` | `needs_confirmation` |
| `blocked_check` | `blocked` |
| `blocked_preflight` | `blocked` |
| `ok_submit_success` | `ok` |
| `blocked_submit` | `blocked` |
| `already_claimed` | `already_claimed` |
| `submit_start_failed` | `error` |
| `unknown_outcome` | `unknown_outcome` |
| `ok_metrics` | `ok` |
| `ok_cancelled` | `ok` |
| `ok_pending_status` | `ok` |
| `ok_reconciled` | `ok` |
| `no_pending` | `blocked` |
| `pending_expired` | `blocked` |
| `pending_replaced` | `blocked` |
| `pending_consumed` | `blocked` |
| `unknown_barrier` | `blocked` |
| `usage_error` | `error` |
| `unauthorized` | `blocked` |
| `llm_offline` | `blocked` |
| `llm_connectivity` | `blocked` |
| `timeout` | `error` |
| `error` | `error` |

Plugin-only pre-adapter categories (before any adapter/Form Agent execution;
they carry no `formAgentExitCode`):

| Category | Status |
|---|---|
| `submit_denied` | `blocked` |
| `submit_approval_timeout` | `blocked` |
| `submit_approval_unavailable` | `blocked` |
| `no_pending` | `blocked` (same status as the adapter layer) |
| `unknown_barrier` | `blocked` (same status as the adapter layer) |
| `unauthorized` | `blocked` (same status as the adapter layer) |
| `error` | `error` |

Duplicate states are distinct: adapter pending terminal states →
`pending_consumed`/`pending_replaced`/`pending_expired`; a sticky
`consumed_unknown` barrier → `unknown_barrier`; Form Agent durable
`SUBMISSION_ALREADY_CLAIMED` → `already_claimed` (only when Form Agent itself
reports its durable claim was already present).

### 8.5 Adapter process exit and `formAgentExitCode` (frozen)

- The adapter always attempts to emit exactly one envelope and exits `0`,
  including for `blocked`, `needs_confirmation`, `unknown_outcome`,
  `already_claimed`, `usage_error`, `unauthorized`, and `timeout`.
- If the adapter cannot emit a document (unexpected internal crash), it exits
  `1` with no stdout JSON.
- **NON-SUBMIT operations:** missing/non-JSON output is an ordinary plugin
  `error`; no submit pending state is created and no submission is possible.
- **SUBMIT operations (BA):** once `form_agent_submit` is approved and the
  adapter has entered the submit path, missing/malformed/truncated output or an
  unexpected adapter process crash is treated as POTENTIALLY AMBIGUOUS. The
  plugin MUST NOT report it as an ordinary retryable `error` merely because the
  adapter exited `1`. It MUST classify via the internal crash-recovery read
  (§8.6) and fail conservatively.
- `formAgentExitCode` is:
  - a `number` ONLY when a Form Agent process ran AND a terminal exit code was
    observed;
  - `null` when no process ran OR no terminal exit code was observed (including
    submit timeout / process loss / SIGKILL, and all approval-denied paths).
  Never fabricate a code.

### 8.6 Crash-safe submit terminal handoff (frozen, BA)

The submit path keeps durable, orchestration-only crash state so a finished
result can be delivered after an adapter crash. The local record uses these
statuses (adding one to §11.1):

```text
pending | claimed | start_failed | consumed_unknown | completed_unambiguous
```

Lifecycle:

1. Before spawn: `pending -> claimed` with required `attemptId`/`claimedAtMs`
   (unchanged).
2. Started, ambiguous result: `claimed -> consumed_unknown` (unchanged).
3. Proven child-never-started: `claimed -> start_failed` (unchanged).
4. Proven `UNAMBIGUOUS_TERMINAL_RESULTS` child result: **do NOT immediately
   delete the record.** Atomically persist a bounded terminal handoff
   `completed_unambiguous` containing ONLY the minimum safe orchestration result
   needed to replay the envelope:

   ```text
   status: "completed_unambiguous"
   pendingId, principal, attemptId
   category, status
   formAgentExitCode
   safe bounded result metadata already permitted by §8/§13
   (e.g. planId, targetDisplay, runId, outcomeCode, receiptState)
   ```

   Never persist answer values, raw HTML, secrets, provider payloads, or any new
   Form Agent authority. This handoff is a crash-safe DELIVERY record for an
   attempt that already finished — not a new submission authority.
5. Emit the normal adapter envelope from that durable handoff.
6. Only after the trusted plugin has received AND validated the complete
   envelope may the handoff be cleared through a narrow, INTERNAL, idempotent
   adapter acknowledgement (`submit_ack`). That acknowledgement is not
   model-facing, not Telegram-facing, not another submit surface, never invokes
   Form Agent, and never changes Form Agent DB/receipt/policy/rate/snapshot/
   metrics state.
7. If adapter/plugin/Gateway crashes before acknowledgement, the
   `completed_unambiguous` handoff survives restart. A repeated internal read
   (`submit_status`, §8.6.1) returns the SAME already-completed result; it NEVER
   re-runs Form Agent and NEVER creates another submit attempt.
8. A fresh preflight MUST NOT replace a surviving `completed_unambiguous`
   handoff (nor `consumed_unknown`) until it has been safely acknowledged/cleared
   by the trusted plugin/operator recovery path.

#### 8.6.1 Internal crash-recovery operations (frozen names)

```text
form-agent-openclaw submit_status <principal flags> [--pending-ref <id>] [--plan <planId>]
form-agent-openclaw submit_ack    <principal flags> --pending-ref <id> --attempt <attemptId>
```

- Both are INTERNAL / plugin-only; they do NOT appear in the model `form_agent`
  enum and are NOT Telegram commands. They never invoke Form Agent.
- `submit_status` is a crash-recovery READ/NORMALIZE operation, not a pure read
  (BB-3). When the trusted plugin calls it while recovering a KNOWN approved
  `form_agent_submit` invocation, it supplies recovery context frozen from the
  approved tool call: `principal`, `pendingRef`, `planId` (all trusted
  host-snapshotted fields, never model inputs). Under the per-principal adapter
  lock it returns the recovery view for the principal:
  `{ state: "none"|"pending"|"claimed"|"start_failed"|"consumed_unknown"|"completed_unambiguous",
  pendingId?, attemptId?, result?: { category, status, formAgentExitCode, safe metadata } }`.
- `submit_ack` is idempotent, clears ONLY a `completed_unambiguous` handoff that
  matches `pendingRef` + `attemptId`, and never modifies Form Agent state.
- The plugin MUST use `submit_status`; it MUST NOT read the adapter JSON file
  directly.

#### 8.6.3 Missing/inconsistent submit state → durable barrier (frozen, BB-3)

Under the per-principal adapter lock, `submit_status` (recovery call):

1. reads the current state;
2. performs the already-frozen normalization `leftover claimed -> consumed_unknown`;
3. if the state is absent/corrupt/inconsistent AND the caller is recovering a
   known approved submit invocation whose result cannot be proven, it atomically
   creates/preserves a minimal durable `consumed_unknown` recovery
   tombstone/barrier containing only bounded orchestration identity needed for
   reconciliation:

   ```text
   principal
   pendingRef            (from approved tool-call snapshot)
   planId                (from approved tool-call snapshot)
   attemptId = "unavailable" when not provable
   reason = "adapter_state_missing_or_inconsistent"
   + already-known safe bounded metadata required by the existing reconciliation contract
   ```

The recovery tombstone: is NOT submission authority; never invokes Form Agent;
never fabricates success/failure; blocks new preflight/cancel exactly like normal
`consumed_unknown`; is cleared only by the existing operator-only
`reconcile_unknown`; carries enough identity for the operator to inspect the
exact plan/receipts where possible; and does NOT store answers, raw HTML,
secrets, provider payloads, target raw input, or new Form Agent business state.

If durable barrier persistence itself fails, FAIL CLOSED: do NOT allow a new
preflight in the same process/session, and surface a hard recovery error
requiring operator intervention. A persistence failure MUST NOT be interpreted
as proof that no submission happened.

#### 8.6.4 Normal successful acknowledgement flow (frozen, BB)

1. Plugin validates the adapter terminal envelope.
2. Plugin internally calls `submit_status` for the same trusted principal +
   `pendingRef` (+ `planId`).
3. Require `state == completed_unambiguous` and that the stored result matches
   the envelope `category`/`status`/`formAgentExitCode` and the same
   `pendingRef`.
4. Read the trusted stored `attemptId` from that recovery state.
5. Call `submit_ack --pending-ref <pendingId> --attempt <attemptId>`.
6. Ack succeeds idempotently; the local handoff is cleared.
7. If the status/result does NOT match, DO NOT ack; enter the conservative
   recovery path (§8.6.2 / §8.6.3).

`attemptId` is never exposed to the model or Telegram.

#### 8.6.2 Plugin behavior on submit adapter failure (frozen)

For `form_agent_submit` only:

- Valid complete adapter envelope: handle normally; acknowledge/clear a
  persisted `completed_unambiguous` handoff only AFTER the envelope is
  validated and matches the stored result (§8.6.4).
- Adapter missing/non-JSON/truncated/crashed: re-read trusted adapter state via
  `submit_status` (recovery call, supplying trusted `principal`/`pendingRef`/
  `planId`):
  - `claimed` or `consumed_unknown` → `unknown_outcome`; ensure sticky
    `consumed_unknown`; no retry;
  - `start_failed` → `submit_start_failed`; no Form Agent retry; new preflight
    required;
  - `completed_unambiguous` → replay the SAME stored safe result; do NOT invoke
    Form Agent again; acknowledge only after successful validation/delivery and
    result match (§8.6.4); a delivery failure while the valid handoff remains
    does NOT convert it to `consumed_unknown`;
  - still `pending` with proof the claim never happened → controlled
    plugin/adapter error; pending may remain for a fresh approval attempt;
  - state missing or inconsistent where the plugin cannot prove what happened →
    `submit_status` atomically creates/preserves the durable `consumed_unknown`
    recovery barrier (§8.6.3), then FAIL CONSERVATIVELY as `unknown_outcome`
    before allowing a new preflight. Do NOT assume "no record" means "nothing
    happened".

---

## 9. Exit-code mapping (frozen, AV + AX)

Success (`exit 0`) is operation-specific; there is no generic `ok` category:

| Operation | exit 0 category | status |
|---|---|---|
| `analyze` | `ok_analyze` | `ok` |
| `draft` / `draft_review` | `ok_draft` | `ok` |
| `check` | `ok_check` | `ok` |
| `preflight` (valid accepted preflight success JSON) | `needs_confirmation` | `needs_confirmation` |
| `submit_pending` (valid recognized success JSON) | `ok_submit_success` | `ok` |
| `metrics` | `ok_metrics` | `ok` |

Non-zero exit mapping:

| Form Agent exit | Meaning | Adapter category | Status |
|---|---|---|---|
| `1` | runtime error | `error`; on submit with a started-but-unrecognized result → `unknown_outcome` | `error` / `unknown_outcome` |
| `2` | usage/config | `usage_error` | `error` |
| `3` | validation/policy/consistency/plan/claim block | operation-dependent: `blocked_check` / `blocked_preflight` / `blocked_submit`; stable special `SUBMISSION_ALREADY_CLAIMED` → `already_claimed` | `blocked` / `already_claimed` |
| `4` | LLM offline | `llm_offline` | `blocked` |
| `5` | LLM connectivity | `llm_connectivity` | `blocked` |
| `127` | unknown command | `error` (configuration defect) | `error` |

For exit `3`, the adapter distinguishes `blocked_check` / `blocked_preflight` /
`blocked_submit` by the running operation, except stable special codes (for
example Form Agent's durable already-claimed code) which map to
`already_claimed`. No new Form Agent process exit codes are invented.

### 9.1 Submit structured-proof override (frozen, AX)

For a submit child that has started, an observed process exit code BY ITSELF is
NOT sufficient to classify the result as safe/unambiguous:

- exit `2` becomes `usage_error` ONLY when the accepted `run --json-error`
  structured document proves that terminal pre-submit result;
- exit `3` becomes `blocked_submit` / `already_claimed` ONLY when the accepted
  structured document proves it;
- malformed / missing / unrecognized machine output after submit start, even if
  exit `0`/`2`/`3` was observed, follows §12.1 and becomes
  `unknown_outcome` + `consumed_unknown`, unless the accepted machine contract
  proves an unambiguous terminal outcome.

This is consistent with `UNAMBIGUOUS_TERMINAL_RESULTS`: a code is safe only when
paired with accepted structured proof. `preflight` and `submit_pending` use
`run --json-error` to recover the stable `code`.

---

## 10. Conversation / workflow state machine

```text
idle
  ├─ analyze / draft / draft_review / check / metrics      -> idle
  ├─ preflight [reviewAnswers]
  │      ├─ principal has consumed_unknown or completed_unambiguous (unacked)
  │      │                                                   -> unknown_barrier (no record)
  │      ├─ success                                         -> pending_confirmation
  │      └─ cancel_pending (status pending only)            -> idle
  ├─ pending_confirmation
  │      ├─ expiry (10 min)                                 -> idle
  │      └─ form_agent_submit (model requests)
  │             ├─ no pending / missing-or-mismatched principal -> blocked (no approval)
  │             └─ before_tool_call.requireApproval
  │                    ├─ deny / timeout / no route / allow-always
  │                    │     -> pending_confirmation (NO Form Agent call; pending remains)
  │                    └─ allow-once
  │                           -> submit_pending (revalidate snapshot fields + targetArg + expiry)
  │                                 ├─ replaced/expired/consumed      -> idle (fail closed)
  │                                 ├─ pre-start spawn failure        -> start_failed (safe; new preflight allowed)
  │                                 └─ child started
  │                                       ├─ UNAMBIGUOUS terminal result
  │                                       │     -> durable completed_unambiguous handoff
  │                                       │     -> emit/validate envelope
  │                                       │     -> internal submit_ack clears handoff -> idle
  │                                       └─ ambiguous (timeout/cap/truncation/malformed/loss/crash)
  │                                             -> consumed_unknown + unknown_outcome  [NEVER retried]
  └─ operator-only local: reconcile-unknown (observed-submitted|observed-not-submitted)
```

A `block` remains a `block`. Preflight output always states no fill/submission
occurred.

---

## 11. Explicit preflight → host approval → submit protocol

### 11.1 Pending state (frozen fields)

One record per `(channel, accountId, senderId)`:

```json
{
  "version": 1,
  "pendingId": "<32 lowercase hex>",
  "principal": { "channel": "telegram", "accountId": "<...>", "senderId": "<numeric>" },
  "conversationId": "<optional>",
  "targetKey": "<canonical identity key>",
  "targetArg": "<replayable canonical target string>",
  "targetDisplay": "<sanitized display>",
  "planId": "<64 lowercase hex>",
  "seed": "<32 lowercase hex>",
  "operator": "telegram:<senderId>",
  "createdAtMs": 0,
  "expiresAtMs": 0,
  "status": "pending"
}
```

`targetKey` vs `targetArg` vs `targetDisplay` (frozen, X + AE):

- `targetKey` = `canonicalizeTarget(target).key` (e.g. `fixture:<id>`,
  `google-forms:https://docs.google.com/...`). It is the authoritative identity
  only and is NEVER passed to the CLI.
- `targetArg` = the canonical target's sanitized replayable display
  (`canonicalizeTarget(target).display`), which is a valid future
  `form-agent run <target>` argument (a bare fixture id / fixture URL, or the
  normalized Google Forms responder URL). It never contains userinfo, query, or
  fragment.
- `targetDisplay` = the operator-facing sanitized display. For Phase 8's
  accepted `fixture`/`google-forms` replay forms it is IDENTICAL to `targetArg`.
- At pending creation, the adapter MUST enforce ALL of:
  - `canonicalizeTarget(targetArg).key === targetKey`
  - `canonicalizeTarget(targetArg).display === targetDisplay`
  - `targetArg === targetDisplay` (for the accepted fixture/google-forms forms)
  - `targetArg`/`targetDisplay` ≤256 chars (§7.4)
  - the kind is allowed by §7.3
- **Length rule (AJ):** the 256-char bound applies ONLY to `targetArg` and
  `targetDisplay`. `targetKey` is derived-only (never human/model input) and has
  NO independent 256 cap; for Google Forms `targetKey = "google-forms:" +
  targetDisplay`, so a valid 256-char display yields a longer key by
  construction. No separate `targetKey` length limit is imposed.
- Immediately before raising the host approval AND again immediately before
  claim/spawn, the adapter MUST re-check the full THREE-part equality (AQ):
  - `canonicalizeTarget(pending.targetArg).key === pending.targetKey`
  - `canonicalizeTarget(pending.targetArg).display === pending.targetDisplay`
  - `pending.targetArg === pending.targetDisplay`
  Any mismatch fails closed and MUST NOT invoke Form Agent (AE + AQ). This
  catches a `targetArg` that gains query/fragment/userinfo and happens to
  canonicalize back to the same key/display.
- The original raw target input is NOT stored, so stripped query/userinfo/
  fragment data cannot reappear.
- `targetArg` is never model-supplied during submit.

Immutable pending identity fields (AE + AL): once created, the following fields
MUST NOT change in place; any new preflight identity gets a NEW `pendingId`. This
includes the pending expiry, which MUST NOT be extended in place. Only lifecycle
`status` and execution-ownership metadata may change.

```text
pendingId, principal, targetKey, targetArg, targetDisplay, planId, seed,
operator, createdAtMs, expiresAtMs
```

Frozen statuses and transitions:

| Status | Meaning | Cancellable | Replaceable by new preflight |
|---|---|---|---|
| `pending` | awaiting approval | yes (`cancel_pending`) | yes |
| `start_failed` | child provably never started | no | yes (new preflight; old approval never reused) |
| `claimed` | submit child started / in flight (transient) | **no** | **no while present** |
| `consumed_unknown` | ambiguous submit; manual reconciliation required | **no** | **no (sticky barrier)** |
| `completed_unambiguous` | finished result awaiting safe delivery/ack (BA) | **no** | **no until acknowledged** |

- **TTL:** `PENDING_TTL_MS = 600_000` (10 minutes); applies to `pending` only.
  No operation extends a pending TTL in place.
- No `confirmationCode`, no attempts counter, no answer values stored.
- **Execution-attempt ownership metadata (orchestration only, AF + AM + AO):**
  - `attemptId` and `claimedAtMs` are REQUIRED in the SAME atomic transition
    that sets status `claimed` (pre-spawn), and are RETAINED when state later
    becomes `consumed_unknown`.
  - `childPid` / `childProcessGroup` cannot exist before spawn; when the
    successful spawn supplies them they are persisted in a SECOND atomic
    update to the `claimed` record as soon as practical.
  - Absence due to the spawn→persist crash window is explicitly represented as
    `unavailable`, never silently fabricated. Failure to persist optional
    process metadata MUST NOT make the record reusable.
  - This metadata is diagnosis/live-process-check input only; it is never
    authority and is never used as a submission key.

### 11.2 Race-safe claim/start lifecycle + crash recovery (frozen, AO)

Under the per-principal lock, the ownership lifecycle is a real two-step process
(a PID cannot exist before spawn):

1. if the principal has a `consumed_unknown` OR unacknowledged
   `completed_unambiguous` record → refuse new preflight (`unknown_barrier`,
   status `blocked`) until local reconciliation / trusted acknowledgement
   (§11.2a / §8.6);
2. validate `pendingRef`, principal, expiry, and `pending` status;
3. re-check the full THREE-part target equality (AQ) before claim;
4. **pre-spawn atomic claim:** `pending -> claimed` and atomically persist the
   REQUIRED `attemptId` + `claimedAtMs` (no process identity yet);
5. attempt `execFile` spawn of the Form Agent submit child:
   - spawn provably fails before a child starts → atomically
     `claimed -> start_failed`; envelope `submit_start_failed` (status `error`,
     `formAgentExitCode: null`); terminal safe; a NEW preflight is required;
   - spawn succeeds → **post-spawn atomic update:** persist
     `childPid`/`childProcessGroup` in a SECOND atomic update to the same
     `claimed` record as soon as practical (absence on crash is `unavailable`);
     the record remains `claimed` and NEVER returns to a reusable state. The
     outcome is then classified against ONE frozen list
     (`UNAMBIGUOUS_TERMINAL_RESULTS`, AH + AN):
     - `ok_submit_success`
     - `blocked_submit`
     - `already_claimed`
     - `usage_error` (only when supported by an accepted terminal code /
       `run --json-error` structured proof)
     - any other category this spec explicitly classifies as an unambiguous
       terminal result
     For every `UNAMBIGUOUS_TERMINAL_RESULTS` outcome, the adapter atomically
     persists a bounded `claimed -> completed_unambiguous` terminal handoff
     (BA, §8.6) — it does NOT immediately delete the record. It then emits the
     envelope, and only after the trusted plugin validates the complete envelope
     is the handoff cleared through the internal idempotent `submit_ack`. Safety
     MUST NOT be inferred from an exit code alone when the accepted structured
     contract does not prove the submission state is unambiguous.
     - every other post-start result (timeout / cancellation / output-cap /
       truncation / malformed result / lost process / ambiguous) →
       atomically `claimed -> consumed_unknown`, envelope `unknown_outcome`,
       manual reconciliation.

`UNAMBIGUOUS_TERMINAL_RESULTS` means: a recognized terminal outcome for which
the accepted Form Agent machine contract proves the submission state is NOT
ambiguous. It is NOT a claim that every entry is a pre-submit result — success
is explicitly included and is NOT "pre-submit" (AN).

`§12.1` MUST use this same `UNAMBIGUOUS_TERMINAL_RESULTS` definition; the two
sections must not drift.

Crash recovery (AF + AO): if the adapter/Gateway restarts and finds a leftover
`claimed` record, it conservatively converts it to `consumed_unknown` (manual
reconciliation) on first read — NEVER retried. This covers BOTH windows:

1. claim persisted, crash BEFORE spawn (no process identity exists); and
2. child spawned, crash BEFORE `childPid`/`childProcessGroup` metadata was
   persisted (process identity `unavailable`).

A crash does NOT prove the already-started child/browser stopped, so the record
must not be made reusable in either case.

#### 11.2a Operator-only local reconciliation (frozen, AF)

`consumed_unknown` is a sticky barrier. The ONLY way to clear it is the
operator-only local adapter operation:

```text
form-agent-openclaw reconcile-unknown \
  --channel telegram --account <accountId> --sender <senderId> \
  --pending-ref <pendingId> --resolution observed-submitted|observed-not-submitted
```

- It is a PRIVILEGED LOCAL OPERATOR ASSERTION, not automatic inference.
- Before it clears the barrier, the operator must have manually verified:
  the Form Agent durable receipt/state for the exact plan/run when available;
  the external form outcome as needed; and that no prior submit child/browser
  process for that attempt can still complete the submission.
- Where persisted ownership metadata (`childPid`/`childProcessGroup`) identifies
  a still-live process, `reconcile_unknown` MUST REFUSE to clear the barrier. It
  MUST NOT kill or retry silently.
- If ownership metadata is unavailable (crash in the spawn/persist race window),
  the state remains `consumed_unknown`; clearing it requires the explicit
  operator assertion after the manual checks. This is a documented manual safety
  responsibility.
- It changes only adapter orchestration state; it never mutates Form Agent
  receipts, policy, rate, snapshots, or metrics. No new Form Agent DB migration
  is added for this metadata.
- It is NEVER exposed as an OpenClaw tool or Telegram command.
- After a successful reconciliation (`ok_reconciled`), a future preflight may
  proceed.
- No automatic reconciliation and no timeout-based auto-clear.

`cancel_pending` cancels ONLY status `pending`; it cannot clear `start_failed`,
`claimed`, `consumed_unknown`, or an unacknowledged `completed_unambiguous`.
`start_failed` is replaced only by a fresh preflight; a `completed_unambiguous`
handoff is cleared only by internal `submit_ack`.

### 11.3 Binding and revalidation (frozen)

The approval is bound to the exact pending record because the hook injects
trusted `{ pendingRef, principal, planId, targetKey, targetDisplay,
expiresAtMs }` into the frozen tool parameters (AE + AL). On execution,
`submit_pending`:

- requires `--pending-ref` to equal the current record's `pendingId`;
- requires the tool-factory principal to equal the frozen hook principal on
  `channel`/`accountId`/`senderId`;
- requires the frozen `planId`, `targetKey`, `targetDisplay`, and `expiresAtMs`
  to equal the current record's values;
- requires `nowMs < pending.expiresAtMs`;
- requires the record to still be `pending` and bound to that principal;
- re-derives and re-checks the full THREE-part equality immediately before
  claim/spawn:
  `canonicalizeTarget(pending.targetArg).key === pending.targetKey`,
  `canonicalizeTarget(pending.targetArg).display === pending.targetDisplay`, and
  `pending.targetArg === pending.targetDisplay` (AQ);
- uses `planId`, `targetArg`, `targetKey`, `targetDisplay`, `expiresAtMs`, and
  `seed` ONLY from the server-side record — never from model input.

If the record was replaced, expired, or consumed while approval was
outstanding, execution fails closed with no Form Agent call.

### 11.4 Form Agent authority (unchanged)

On a valid claim the adapter invokes:

```text
form-agent run <pending.targetArg> --seed <pending.seed> --submit \
  --expect-plan <pending.planId> --by telegram:<senderId> --json --json-error
```

`<pending.targetArg>` is the replayable canonical string; `targetKey` is NEVER
passed as an argv target. Form Agent reloads the persisted approved snapshot,
re-runs consistency, re-checks the fingerprint, re-evaluates live policy, makes
the durable claim, and performs exactly one submit attempt. The adapter never
supplies or regenerates answers.

### 11.5 Anti-patterns explicitly prevented

| Anti-pattern | Prevention |
|---|---|
| Stale confirmation | 10-minute pending expiry |
| Confirming wrong target | pending stores `targetKey` (identity) + `targetArg` (replayable); re-canonicalized equality before submit runs against `targetArg` |
| Confirming wrong plan | planId from server-side pending; Form Agent `--expect-plan` binding |
| Accidental replay | single-use pending claim; Form Agent durable claim; an unambiguous result persists a `completed_unambiguous` handoff removed only after internal `submit_ack` |
| Repeated Telegram message | local `no_pending`/`pending_consumed` before any Form Agent call; fresh approval required |
| "yes" outside pending | bare "yes" is not a tool approval; only `allow-once` releases the frozen call |
| Different user | single frozen operator; tool-factory + `ctx.requester` cross-check |
| Auto-submit after preflight | preflight never submits; `form_agent_submit` + approval required |
| Prompt-injected submission | injection can only create an approval request; human `allow-once` required |
| Persistent blanket approval | `allow-always` never offered or accepted |
| Double spawn race | atomic claim under per-principal lock before spawn |
| Reusing an old approval after spawn failure | `start_failed` terminal; new preflight required |
| New plan after ambiguous submit | sticky `consumed_unknown` barrier; operator-only `reconcile_unknown` required |
| Crash leaving ambiguous claimed | leftover `claimed` becomes `consumed_unknown` on restart |

---

## 12. Timeout / concurrency / duplicate-message behavior

- **Two rapid messages:** per-principal file lock serializes operations.
- **Single operator:** Phase 8 deployment has exactly one principal, so there
  is one pending record and one lock (the multi-principal isolation helpers may
  still be unit-tested).
- **Pending replacement while approval outstanding:** execution fails closed.
- **Sticky unknown barrier:** while a principal has `consumed_unknown`, new
  preflight and `cancel_pending` are refused; only operator-only
  `reconcile_unknown` clears it.
- **Crash recovery:** a leftover `claimed` record with no live execution
  ownership becomes `consumed_unknown` on first read after restart.
- **OpenClaw restart with pending:** a `pending` record persists on disk; valid
  until expiry; approval is re-raised on the next `form_agent_submit`.
- **Duplicate Telegram update IDs:** OpenClaw dedupes; single-use claim is the
  backstop.
- **Never** automatically re-invoke submit after claim/start failure/timeout/
  unknown.

Frozen per-operation subprocess timeouts (ms): analyze 60_000; draft/check
300_000; preflight 300_000; `pending_status` 10_000; submit 300_000; metrics
30_000. Frozen max captured output: 262_144 bytes per stream.

### 12.1 Submit-path ambiguity semantics (frozen)

For a submit child that has successfully started, ALL of the following MUST lead
to `unknown_outcome` + `consumed_unknown` + manual reconciliation + no
automatic retry:

- timeout;
- cancellation;
- output-cap termination;
- stdout truncation;
- malformed/non-JSON result where no accepted pre-submit proof exists;
- lost process/IPC;
- adapter crash/restart with a leftover `claimed` record.

Never reinterpret malformed output as a safe, retryable generic error.

`completed_unambiguous` is NOT in the list above (BB-1). A valid durable
`completed_unambiguous` handoff proves the underlying Form Agent submission
state is already unambiguous, so an adapter/plugin DELIVERY failure while it
remains valid MUST NOT convert it to `consumed_unknown`. The handoff remains
`completed_unambiguous`; the plugin re-reads it via `submit_status`; the adapter
replays the SAME safe result; Form Agent is never invoked again; `submit_ack`
clears it only after the plugin validates the recovered envelope. If the handoff
is corrupt/incomplete so the stored terminal result can no longer be proven
valid, that is a DIFFERENT case handled as missing/inconsistent recovery state
(§8.6.3, BB-3), not an ordinary valid replay.

Safe exceptions (`UNAMBIGUOUS_TERMINAL_RESULTS`, the SAME list as §11.2, AH +
AN): a recognized terminal outcome for which the accepted machine contract
proves the submission state is NOT ambiguous is reported as its category and
MUST atomically persist a bounded `completed_unambiguous` terminal handoff for
crash-safe delivery (BA, §8.6) — never `consumed_unknown`, and never an immediate
delete. This is NOT a claim that every entry is a pre-submit result:
`ok_submit_success` is explicitly included and is NOT "pre-submit". The list is:

- `ok_submit_success`
- `blocked_submit`
- `already_claimed`
- `usage_error` (only when supported by an accepted terminal code /
  `run --json-error` structured proof)
- any other category this spec explicitly classifies as an unambiguous terminal
  result

Safety MUST NOT be inferred from an exit code alone when the accepted structured
contract does not prove an unambiguous submission state. Never fabricate
success.

Non-submit operations: malformed or capped output is an ordinary controlled
`error`/`timeout` and creates no pending submit record.

Other frozen rules:

- Spawn failure BEFORE the child starts: `submit_start_failed`, status `error`,
  `formAgentExitCode: null`; the record becomes `start_failed` and a new
  preflight is required.
- Timeout/cancellation for analyze/draft/check/preflight/metrics: ordinary
  `timeout`.
- `formAgentExitCode` is `null` whenever no terminal exit code was observed,
  including submit timeout/loss.
- Form Agent's durable receipt remains the authority if manually inspected.
- No new Form Agent exit code is introduced.

---

## 13. Output privacy / redaction rules

Telegram is an external disclosure surface. The adapter/plugin MUST NEVER send:

- raw API keys/tokens or Authorization headers;
- bot tokens, OpenClaw secrets, or environment values;
- browser cookies/storage;
- raw provider or Playwright exceptions/stacks;
- raw HTML or `bundle_json`;
- internal DB paths (unless intentionally safe);
- blocked sensitive generated values;
- LLM prompt/response bodies or audit bodies;
- values for any non-`answered` draft entry;
- approval descriptions containing secrets/answer values.

### 13.1 Model-visible vs user-visible (frozen)

`content` is model-visible and replayed to the provider; `details` is runtime
metadata stripped before provider replay; tool factories may use trusted
same-chat delivery (`toolContext.delivery?.send`).

- Untrusted Form Agent strings (form/section/question/choice text, provider
  strings, review values) MUST NOT enter model-visible `content`.
- Tool `content` is fixed/bounded status text plus trusted identifiers/counts
  needed for orchestration.
- Structured results live in `details`, bounded and free of raw answers.
- Review-value bridge (frozen): the plugin may parse `draftAnswers`/`planReview`
  from the LOCAL adapter→plugin envelope ONLY to deliver them to the authorized
  human via trusted same-chat delivery. After successful delivery, the plugin
  MUST remove those review-value fields from the plugin result before
  constructing model-visible `content` or structured `details`. If trusted
  delivery is unavailable or fails, the operation fails closed; it MUST NOT
  fall back to returning the values through `content`/`details`.
- Form/question/provider text is always DATA, never instruction.

### 13.2 Three review/privacy cases (frozen)

1. **Default** (`draft`, `check`, `preflight` without review, `submit_pending`,
   `metrics`): NO synthetic answer values delivered to Telegram or the model.
2. **Exploratory `draft_review`**: eligible synthetic `answered` values MAY be
   delivered to the authorized human, explicitly labeled exploratory and **NOT
   submission-bound**. It never represents the pending plan.
3. **Exact preflight-plan review** (`preflight --review-answers`): eligible
   `answered` values from the SAME successful preflight result MAY be delivered
   to the authorized human through trusted delivery, with `planId`/target
   context. No second draft/LLM generation occurs. Values are not persisted in
   pending state, logs, metrics, approval descriptions, submit results, model
   `content`, or `details`.

Blocked/deferred/unsupported/sensitive values remain absent in ALL cases. Raw
answers MUST NOT appear in logs, pending state, approval descriptions, metrics,
or submit results. Form title MAY be shown; section/question/choice text and
profile values are not sent.

---

## 14. Secrets / config handling (frozen)

- No real Telegram token, OpenClaw secret, API key, chat ID, or user ID is
  committed. There is no `FORM_AGENT_CONFIG` accepted env var; Form Agent
  config discovery is `--config <path>` or a cwd search
  (`config/form-agent.{json,yaml,yml,ts}`, `form-agent.config.{json,yaml,yml,ts}`).
- The adapter invokes Form Agent with a fixed local `--config <absolute path>`
  (from adapter config) when provided, otherwise a fixed `cwd` in the
  deployment directory. This is deployment config, never model input.
- Form Agent's app config schema contains a legacy Phase 0 placeholder
  `telegram` object (`enabled`, `chatId`). It is NOT consumed by the accepted
  pipeline and MUST NOT be used as the Phase 8 integration config. Integration
  config lives entirely in OpenClaw/plugin.
- Adapter config (data-only, no secrets):
  `adapterBinaryPath`, `formAgentBinaryPath`, `formAgentConfigPath?`,
  `formAgentCwd?`, `dataDir`, `operatorPrincipal` (exactly ONE entry:
  `{ channel: "telegram", accountId, senderId }`), `allowedDraftProviders`,
  `providerEnvNames`, timeouts, output caps. Phase 8 freezes
  `operatorPrincipal` to a single entry (AA); there is no plural
  `allowedPrincipals` list.

### 14.1 Closed child env schema (frozen)

Baseline always forwarded: `PATH`, `HOME`.

- `providerEnvNames: string[]` — exact credential variable names required by the
  accepted Form Agent config `apiKeyEnv` (e.g. `OPENAI_API_KEY`).
- There is deliberately NO generic `passthroughEnvNames` list. Accepted Form
  Agent env overrides DO exist in source (`LOG_LEVEL`,
  `FORM_AGENT_LLM_PROVIDER`, `FORM_AGENT_LLM_BASE_URL` in
  `src/config/env.ts` `parseEnv`, applied by `src/config/load.ts` `mergeEnv`),
  but each has a config-file equivalent (`log.level`, `llm.defaultProvider`,
  `llm.providers.<id>.baseUrl`) and none is required for Phase 8. They are
  therefore NOT forwarded by default. A future spec may add an explicit closed
  list only with direct evidence of need.
- Name syntax: `^[A-Z][A-Z0-9_]{0,63}$`; at most 32 names; each at most 64 chars.
- Always dropped even if listed or present: `NODE_OPTIONS`, `NODE_PATH`, `LD_*`,
  `DYLD_*`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`,
  `NODE_TLS_REJECT_UNAUTHORIZED`, `SSL_CERT_FILE`, `PWD`, `SHELL`, `USER`.
- Values are copied from the adapter process env only when present. Unknown/
  unlisted names are NOT forwarded. The whole OpenClaw env is NEVER forwarded.
- Env NAMES are local config, never Telegram/model parameters. Env VALUES are
  never logged, returned, persisted in pending state, or shown to the model.
  This keeps a real configured provider (`apiKeyEnv`) working.
- Adapter logs are redacted/bounded; raw stderr is not forwarded to Telegram.

---

## 15. External setup and dedicated-agent hardening

### 15.1 External user setup checklist (documented, NOT performed)

1. Choose ONE dedicated OpenClaw Telegram account id
   (`<form-agent-account-id>`) and create a **dedicated** Telegram bot via
   BotFather for the Form Agent workflow.
2. Store the bot token via OpenClaw's secret mechanism under the account-scoped
   config `channels.telegram.accounts.<form-agent-account-id>.botToken`.
3. Determine the immutable numeric Telegram user ID of the single frozen
   operator.
4. Configure the DEDICATED account only: account-scoped `dmPolicy: "allowlist"`
   with ONLY that numeric ID in `allowFrom`, PLUS explicit account-scoped group
   isolation `groupPolicy: "disabled"` and `groups: {}` (an explicit empty map;
   multi-account Telegram inherits root `channels.telegram.groups` when an
   account omits `groups`). Add an explicit account-scoped native approval
   approver list
   (`channels.telegram.accounts.<form-agent-account-id>.execApprovals.approvers`)
   containing EXACTLY that ID (AZ; exact installed syntax NEEDS VERIFICATION).
   Do NOT apply these settings to the user's unrelated general Telegram account,
   and do NOT forward `approvals.plugin` to other humans/chats.
5. Owner config (AT + AZ): `commands.ownerAllowFrom` is GLOBAL, not
   account-scoped. MERGE the frozen operator into it if the approval surface
   requires owner status, while PRESERVING every unrelated existing valid global
   owner (never replace the array). Phase 8 MUST NOT rely on the global-owner
   fallback for Form Agent approvals; the dedicated account's explicit
   `execApprovals.approvers` is the approval authority for this account.
6. Preserve the existing general Telegram default (AY): before adding the
   dedicated account, identify the currently active general/default Telegram
   account and set `channels.telegram.defaultAccount` to it (or preserve the
   existing `accounts.default` relationship) so the dedicated account never
   becomes the default for unrelated workflows. Do not rename/move the existing
   account merely for Phase 8.
7. Create the dedicated **non-default** `form-agent` OpenClaw agent and bind the
   DEDICATED account's DM to it with `match.accountId` = the dedicated account id
   (AR). Do not rely on an omitted `accountId` (it matches the channel default).
8. Deploy Form Agent on the OpenClaw host (co-location is the frozen default;
   §3.3 remote is not implemented) and record its EXACT config path and SQLite
   DB location.
9. Ensure Playwright/Chromium exists where execution runs.
10. Install the adapter binary; set its config (`operatorPrincipal` whose
    `accountId` MUST equal the dedicated account id, `formAgentConfigPath`,
    `providerEnvNames`, timeouts, caps).
11. Install/enable the plugin; `tools.allow` the `form_agent` and
    `form_agent_submit` tools; rely on the dedicated account's same-chat/native
    approval path.
12. Set a conservative `tools.exec.mode` for the rest of the agent (not as
    protection for the plugin spawn).
13. **Fixture structural smoke (no `run` authorization needed):** `analyze` →
    `draft` → `check` against the accepted offline fixture. These are offline
    and submission-free.
14. **Locally authorize the purpose-built execution fixture/harness BEFORE any
    fixture preflight, using the SAME Form Agent config/DB the adapter uses
    (AS).** `run` (including preflight) retains the authorization-only gate even
    for the local execution harness; fixtures do NOT bypass
    `PolicyEngine`/authorization (accepted Phase 5/6 tests allowlist the
    execution fixture before invoking `run`). On the Form Agent host, using the
    adapter's exact config context:

    ```bash
    # If the adapter uses an explicit config path:
    form-agent --config <formAgentConfigPath> auth allow <execution-fixture-id> --scope run --by <operator>
    form-agent --config <formAgentConfigPath> auth check <execution-fixture-id>
    # If the adapter uses cwd discovery, run from the same fixed formAgentCwd:
    # (cd <formAgentCwd> && form-agent auth allow <execution-fixture-id> --scope run --by <operator>)
    ```

    Then run a fixture `preflight`.
15. **Locally authorize the live Google Forms target before any real preflight,
    using the SAME config/DB context (AS).** Telegram intentionally exposes no
    auth-mutation tool, and real `run` preflight is deny-by-default. Use the
    exact accepted flags (do not invent flags; `auth allow` requires `--by`):

    ```bash
    form-agent --config <formAgentConfigPath> auth allow <target> --scope run --by <operator>
    form-agent --config <formAgentConfigPath> auth check <target>
    ```

    A target that is not authorized — or that was authorized in a DIFFERENT
    config/DB — makes Telegram report the stable not-authorized block and
    instruct the operator to authorize locally against the adapter's context.
    Never copy or infer a second DB path.
16. **Real no-submit preflight** against the authorized Google Forms target.
17. Confirm the Telegram message-retention disclosure with the operator.

### 15.2 Dedicated-agent recommendation (frozen)

Run the workflow on a dedicated **non-default** OpenClaw agent with a minimal
tool surface:

```json5
{
  agents: {
    entries: {
      "form-agent": {
        // NOT default: unrelated sessions must keep their existing agent.
        workspace: "~/.openclaw/workspace-form-agent",
        tools: {
          allow: ["form_agent", "form_agent_submit", "session_status", "ask_user"],
          deny: [
            "group:runtime", "group:fs", "group:automation",
            "group:messaging", "group:ui", "group:nodes", "group:web",
            "write", "edit", "apply_patch", "browser", "cron", "gateway",
            "sessions_spawn", "subagents"
          ]
        }
      }
    }
  },
  bindings: [
    {
      agentId: "form-agent",
      match: {
        channel: "telegram",
        accountId: "<form-agent-account-id>", // AR: dedicated account, not the channel default
        peer: { kind: "direct", id: "<numeric-user-id>" }
      }
    }
  ],
  channels: {
    telegram: {
      // Root config (including root `groups`) is the shared default for
      // accounts that OMIT `groups`; it stays owned by the existing general
      // setup and MUST NOT be narrowed/overwritten for Phase 8.
      defaultAccount: "<existing-general-account-id>", // AY: preserve the existing default
      accounts: {
        "<form-agent-account-id>": {
          botToken: { source: "store", provider: "default", id: "FORM_AGENT_TELEGRAM_BOT_TOKEN" },
          dmPolicy: "allowlist",
          allowFrom: ["<numeric-user-id>"],
          groupPolicy: "disabled", // AT: explicit, not "no groups"
          groups: {},              // AT: explicit empty map blocks root-group inheritance
          execApprovals: { approvers: ["<numeric-user-id>"] }, // AZ: explicit single approver (fences owner fallback)
        },
      },
    },
  },
  commands: {
    // AT/AZ: GLOBAL (not account-scoped). MERGE: keep every existing valid
    // owner; ensure telegram:<numeric-user-id> is present if owner status is
    // needed. Do NOT replace the array with only the Form Agent operator.
    ownerAllowFrom: [/* existing owners ... */ "telegram:<numeric-user-id>"],
  },
}
```

Notes (frozen):

- Do NOT set `default: true` on the dedicated agent.
- The dedicated Telegram account id MUST be used consistently by the Telegram
  account config, this binding `match.accountId`, the plugin deployment config,
  and the adapter `operatorPrincipal.accountId` (AR). An omitted `accountId`
  matches the channel DEFAULT account and is wrong here.
- The dedicated account MUST set explicit `groupPolicy: "disabled"` and
  `groups: {}` (AT); an omitted account `groups` inherits root
  `channels.telegram.groups`.
- `commands.ownerAllowFrom` is GLOBAL (AT), not account-scoped. MERGE the
  frozen operator into it if owner status is needed, preserving every unrelated
  existing valid global owner; never replace the array.
- Default-account preservation (AY): the pre-existing general Telegram account
  MUST remain the explicit Telegram default (`channels.telegram.defaultAccount`
  or the equivalent preserved `accounts.default`), so adding
  `<form-agent-account-id>` never changes default routing for unrelated
  workflows. Phase 8 routing uses the explicit `match.accountId`, never the
  default.
- Single approver vs owner fallback (AZ): the dedicated account's explicit
  `execApprovals.approvers` is exactly the frozen operator and MUST fence the
  global-owner fallback; an unrelated global owner MUST NOT be accepted as a
  Form Agent approver. `approvals.plugin` remains optional forwarding only.
- The user's general/default Telegram account and its existing agent/root group
  config MUST remain unaffected; the dedicated account routes only to the Form
  Agent agent.
- Bindings are routing, not authorization: keep the Telegram DM numeric
  allowlist and `tools.toolsBySender` as defense in depth.
- Phase 8 is single-operator (AA): only the one frozen numeric operator may be
  the DM allowlist, the dedicated account's approver, and the adapter
  principal.
- Exact tool/group names, `execApprovals`, secret-ref, `defaultAccount`, and
  config syntax are NEEDS VERIFICATION.

---

## 16. Local/offline testing strategy

All Phase 8 tests are local and deterministic. No Telegram, no OpenClaw
Gateway, no real bot, no external network.

Required future tests (minimum):

- exact input bounds: each field max accepted and max+1 rejected; control chars
  and unknown flags/fields rejected;
- prompt-injected form/title can trigger at most an approval request, never
  submit;
- submit cannot execute until host plugin approval resolves `allow-once`;
- deny / timeout / missing approval route → no Form Agent submit invocation;
- `allow-always` is never offered/accepted for submit;
- approval binds exact pending record + principal + plan;
- principal sources: `channel` constant, `accountId` from deployment config,
  `senderId` from tool-factory `requesterSenderId`; hook `ctx.requester`
  channel/accountId/senderId compared to those; mismatch → fail closed;
- hook-principal vs tool-factory-principal mismatch → fail closed;
- missing trusted principal fields (including required `ctx.requester` fields)
  → unauthorized/fail closed;
- pending replacement while approval outstanding → execution fails closed;
- **targetArg replay (X):** for both fixture and Google Forms,
  `canonicalizeTarget(pending.targetArg).key === pending.targetKey`; the kind is
  allowed; `targetArg`/`targetDisplay` ≤256; a 257-char `targetDisplay` is
  rejected before preflight; `targetKey` is never passed as an argv target;
  original raw target/query/userinfo is never stored;
- **length rule (AJ):** a valid 256-char `targetDisplay` produces a longer
  `targetKey` for Google Forms and is accepted; no independent `targetKey` cap
  is enforced;
- **pending views (AI):** `pending_status` returns `PendingApprovalView`
  including `targetKey`; model-facing results never expose
  `targetKey`/`targetArg`; the approval hook can construct every frozen
  snapshot field using only trusted runtime context + `pending_status`; the
  plugin never reads the pending JSON directly;
- **approval/state binding (AE + AL):** `canonicalizeTarget(targetArg).display
  === targetDisplay` and `targetArg === targetDisplay`; a tampered
  `targetDisplay`/`targetKey`/`planId`/`pendingRef`/`expiresAtMs` mismatch after
  the approval snapshot fails closed; immutable identity fields (including
  `expiresAtMs`) cannot mutate or be extended in place under the same
  `pendingId`; execution requires `now < expiresAtMs`;
- **deny/timeout state (AK):** deny / approval timeout / no route / defensively
  rejected `allow-always` invoke no adapter/Form Agent submit and leave the
  pending record `pending` (workflow returns to `pending_confirmation`, not
  `idle`); re-approval, `cancel_pending`, replacement, and expiry remain
  available; no auto re-prompt loop;
- **pending lifecycle (Y + BA/BB):** unknown barrier blocks new preflight and
  `cancel_pending`; stale `claimed` on restart → `consumed_unknown`; local
  `reconcile_unknown` required before a new preflight; an unambiguous result
  persists a `completed_unambiguous` handoff (never an immediate delete) that is
  removed only after internal `submit_ack`; concurrent callers cannot
  double-spawn;
- **completed_unambiguous replay (BB-1/BB-2):** a valid handoff with an adapter/
  plugin delivery failure remains `completed_unambiguous` (never
  `consumed_unknown`), replays the SAME result, and never re-runs Form Agent;
  the normal success path reads the trusted stored `attemptId` via
  `submit_status` and acks; stale "clean completion removes the local record"
  wording must not exist;
- **durable missing/inconsistent barrier (BB-3):** for a known approved submit
  invocation, `submit_status` atomically creates/preserves a durable
  `consumed_unknown` recovery tombstone on absent/corrupt state, blocking new
  preflight/cancel until operator reconciliation; barrier-persistence failure
  fails closed (no new preflight) and is never treated as proof no submission
  happened;
- **ownership metadata (AM + AO):** pre-spawn claim atomically persists REQUIRED
  `attemptId` + `claimedAtMs`; `childPid`/`childProcessGroup` are persisted in a
  SECOND post-spawn atomic update when available and explicitly unavailable
  (not fabricated) otherwise; both crash windows (claim-before-spawn and
  spawn-before-PID-persist) leave a `claimed` record that recovery converts to
  `consumed_unknown` and never auto-retries;
- **crash/live-child reconciliation (AF):** leftover `claimed` →
  `consumed_unknown`; a recorded live child ownership makes
  `reconcile_unknown` REFUSE; no automatic/timeout clear; reconciliation is
  local-only and requires exact `pendingRef`+principal; after an explicit safe
  reconciliation a new preflight may proceed;
- **submit adapter-crash / terminal handoff (BA):** non-submit adapter crash →
  ordinary `error`, no pending; submit crash before claim → safe controlled
  error, no Form Agent submit; crash after claim before spawn → `consumed_unknown`,
  no retry; crash after child start → `consumed_unknown`/`unknown_outcome`, no
  retry; proven unambiguous child result → durable `completed_unambiguous`
  handoff replaying the SAME result after a crash (no re-execution); internal
  `submit_ack` clears the handoff only after the plugin validates the complete
  envelope; crash after envelope but before ack → repeated recovery returns the
  SAME result, never submits again; missing/inconsistent state → conservative
  `unknown_outcome` + sticky barrier; a new preflight cannot replace
  `completed_unambiguous` or ambiguous recovery state before
  acknowledgement/reconciliation;
- **terminal-handoff consistency (BB):** valid `completed_unambiguous` +
  delivery failure remains `completed_unambiguous`, replays the SAME result,
  never becomes `consumed_unknown`, never re-runs Form Agent; successful
  validation obtains the trusted stored `attemptId` via `submit_status` and
  `submit_ack` clears exactly that handoff; crash after envelope before ack
  replays on restart; missing state after a known approved submit invocation
  atomically creates/preserves a durable `consumed_unknown` recovery tombstone
  that blocks new preflight/cancel; a corrupt/inconsistent handoff normalizes to
  the conservative durable barrier and never pretends the result is valid;
  barrier-persistence failure fails closed and never permits a new preflight;
  a spec scan asserts no normative "clean completion removes the local record"
  (or equivalent) wording remains before `submit_ack`;
- **operation-parameter matrix (AP):** each `form_agent` operation accepts only
  its frozen fields; a known field invalid for the operation → `usage_error`
  (not ignored); `--draft-provider` is passed for draft/draft_review/check/
  preflight; `form_agent_submit` has zero model params;
- **three-part target recheck (AQ):** a `targetArg` tampered with
  query/fragment/userinfo that still canonicalizes to the same key/display FAILS
  because `targetArg !== targetDisplay`; the exact canonical targetArg passes;
- **ar (dedicated account routing):** the dedicated account routes only to the
  Form Agent agent; the general/default account keeps its existing agent; a
  wrong/missing `match.accountId` does not route to Form Agent; plugin accountId
  equals adapter `operatorPrincipal.accountId`;
- **telegram account isolation (AT):** the dedicated account has
  `groupPolicy: "disabled"` and an explicit `groups: {}` that does NOT inherit
  root `channels.telegram.groups`; the general account's group config is
  unchanged; `commands.ownerAllowFrom` is validated as GLOBAL (never treated as
  account-scoped); the dedicated account's `execApprovals` approver is the
  frozen operator;
- **preflight --json-error (AU):** preflight argv always includes `--json-error`;
  a successful preflight uses the normal `--json` success document; a controlled
  preflight failure uses the `--json-error` document; no pending is created on a
  failed/blocked preflight; the adapter never infers state from stderr;
- **closed category/status vocabulary (AV):** every category maps to exactly one
  status; `unauthorized` is `blocked` in both adapter and plugin layers;
  `blocked_preflight`/`llm_offline`/`llm_connectivity` exist and map as frozen;
  exit `0/1/2/3/4/5/127` maps to the exact frozen categories;
- **exit-0/preflight + submit override (AX):** successful preflight exit `0` →
  `needs_confirmation` (never `ok`); submit exit `2` + valid structured usage
  proof → `usage_error`; submit exit `2` + malformed/missing doc →
  `unknown_outcome`; submit exit `3` + valid structured block proof →
  `blocked_submit`; submit exit `3` + malformed/missing doc →
  `unknown_outcome`; submit exit `0` + malformed/missing success JSON →
  `unknown_outcome`;
- **default-account preservation (AY):** adding `<form-agent-account-id>` does
  NOT change the existing Telegram default; an unrelated action with omitted
  `accountId` still resolves to the preserved general/default account; the Form
  Agent binding still uses the dedicated explicit `accountId`;
- **explicit single approver vs global owner (AZ):** the dedicated account's
  explicit `execApprovals.approvers` is exactly the frozen operator; an
  unrelated global owner is NOT accepted as a Form Agent approver; missing
  explicit dedicated approver config fails setup validation; installed-version
  verification confirms explicit approvers fence the owner fallback, else STOP;
- **argv/table consistency (AW):** draft/draft_review/check pass
  `--draft-provider` when supplied and omit it otherwise; preflight passes
  `--json --json-error`; `reviewAnswers` is adapter-only and never emitted as a
  Form Agent CLI flag;
- **as (same-config auth):** authorization recorded in a DIFFERENT config/DB does
  NOT satisfy preflight; same-config `auth allow` + `auth check` does;
- **approval rendering (Z):** at maximum `targetDisplay`+`planId` the rendered
  description is ≤512 and the title ≤80; the full 64-hex planId and full
  targetDisplay appear; no short hash; no answers/secrets;
- **single operator (AA):** exactly one configured principal; a second numeric
  user is rejected; the adapter/config has no plural allowed-principals list;
- **setup sequence (AG):** `analyze`/`draft`/`check` against a fixture need no
  `run` authorization; an unauthorized fixture `run` preflight is blocked; after
  locally allowlisting the execution fixture it proceeds; a live Google Forms
  preflight without local `auth allow` reports the not-authorized block (no test
  relies on an unauthorized fixture passing `run` preflight);
- **safe terminal cleanup (AH):** a recognized structured `usage_error`/
  pre-submit failure after the child starts closes/removes the local pending
  record and is NOT `consumed_unknown`;
- **submit ambiguity (AC):** submit output cap → `unknown_outcome`; submit
  malformed result after start → `unknown_outcome`; preflight
  malformed/capped output → controlled `error`, no pending record;
- **single submit surface (AD):** no custom submit command exists; the only
  path is `form_agent_submit` → plugin approval → adapter `submit_pending`;
- spawn failure BEFORE start → `submit_start_failed`, consumed, no reuse,
  new preflight required;
- submit child timeout/loss AFTER start → `unknown_outcome`, `consumed_unknown`,
  no retry, `formAgentExitCode: null`;
- preflight timeout → ordinary `timeout`; analyze/draft/check timeouts;
- plugin direct spawn does not claim `tools.exec` mediation (policy/docs test);
- dedicated agent is non-default and does not expose generic dangerous tools;
- target matrix: fixture reaches each non-submit op; accepted google-forms
  responder shape reaches preflight; arbitrary https URL rejected; file/raw/path
  rejected; `submit_pending` has no target parameter;
- exploratory `draft_review` is not submission-bound;
- exact-plan review uses answers from the SAME preflight invocation and
  performs zero second draft/LLM generation (real-provider path too);
- successful preflight envelope has non-null `pending` PendingSummary; blocked
  preflight has `pending: null`;
- pending storage contains no raw answer values;
- three review/privacy cases: default emits no values; exploratory and
  exact-plan review deliver eligible values to the human; blocked values absent
  everywhere;
- review bridge: the local adapter→plugin envelope MAY contain eligible review
  values, but the FINAL plugin result `content`/`details` MUST NOT; delivery
  failure fails closed with no values in `content`/`details`;
- provider API-key env allowlist works without exposing the value; only
  `providerEnvNames` are forwarded; accepted Form Agent env overrides are not
  forwarded; unknown/unlisted/dangerous env names are not inherited;
- adapter envelope is exactly one JSON document; one-document `run --json`;
- `formAgentExitCode` number-vs-null rule;
- category→status mapping for every frozen category;
- local `pending_consumed` vs durable `already_claimed`;
- exact argv assertions; shell injection payloads remain inert data;
- output redaction sentinels; output-size bound;
- two-message concurrency; OpenClaw restart / pending persistence;
- fixture-harness local lifecycle E2E (analyze → preflight → review → approve →
  submit → metrics);
- Phase 0–7 full regression remains green;
- `verify:phase8` runs every Phase 8 test file.

No real Telegram credentials in CI/tests.

---

## 17. Acceptance scenarios

1. **Analyze (fixture)** — `ok_analyze`, no fill/submit.
2. **Draft / exploratory review (fixture)** — `ok_draft`; explicit
   `draft_review` delivers eligible `answered` values to the human, labeled
   exploratory and not submission-bound.
3. **Check (fixture)** — pass/warn non-blocking (`ok_check`); a `block` is
   `blocked_check`.
4. **Preflight (fixture or accepted google-forms)** — `needs_confirmation` with
   bounded target/plan summary; `No fill or submission occurred.`; pending
   registered. Requires the target to be locally authorized for `run` first
   (fixtures do NOT bypass authorization). With `--review-answers`, eligible
   values from the same result are delivered to the human.
5. **Approval happy path** — `form_agent_submit` raises the plugin approval
   showing the FULL targetDisplay and FULL planId; `allow-once` →
   `ok_submit_success`; the local pending record is removed.
6. **Approval anti-patterns** — deny/timeout/no-route/allow-always-rejected;
   wrong/replaced/expired/consumed pending → no submit, correct category;
   `targetDisplay`/`planId`/`targetKey`/`pendingRef` mismatch after the approval
   snapshot → fail closed.
7. **Repeated local submit** — a repeated adapter submit after the local pending
   was consumed does NOT reach Form Agent; it is a local
   `no_pending`/`pending_consumed` result. `already_claimed` is reserved for the
   case where Form Agent itself reports its durable claim was already present
   (e.g. another trusted execution path claimed the same plan first).
8. **Start failure** — pre-start spawn failure → `submit_start_failed`; new
   preflight required.
9. **Unknown outcome** — ambiguous submit/timeout/cap/truncation/malformed/loss
   after start → `unknown_outcome`; sticky `consumed_unknown`; new preflight and
   `cancel_pending` are blocked until operator-only `reconcile_unknown`; a
   recorded live child refuses reconciliation; `formAgentExitCode: null`; no
   retry.
10. **Safe terminal after child start** — recognized `usage_error`/pre-submit
    block closes/removes the local pending record and is not
    `consumed_unknown`.
11. **Unauthorized** — non-operator, missing, or mismatched principal →
    `unauthorized`, adapter not invoked; unauthorized fixture/live `run`
    preflight is blocked.
12. **Injection** — shell metacharacter payloads remain data; argv assertions
    prove no shell composition; injected/raw form text never enters model
    `content`.
13. **Redaction** — secret/HTML sentinels absent; default ops emit no answer
    values; review ops deliver only eligible values to the human.
14. **Metrics** — bounded read-only; `data.metrics` is the accepted Phase 7
    document; no rows created; no browser/LLM.

---

## 18. Migration decision

**No new Form Agent migration.** Accepted durable state already covers every
authoritative requirement:

- `execution_plan_snapshots` — approved plan identity/approval binding;
- `execution_receipts` — durable claim, duplicate-submit prevention, outcome;
- `rate_events` — conservative submission rate;
- `metrics_events` + derived tables — observability.

The adapter pending record is **orchestration state**, not submission authority,
stored outside the database in a bounded atomic JSON file under the configured
data directory (file mode `0600`). It stores no answer values and never
influences policy, approval, or claims.

If implementation evidence proves a migration is genuinely required, the worker
MUST STOP and report rather than silently reserving or inventing migration 10.

---

## 19. Implementation file plan

Form-Agent-side (this repo):

```text
src/openclaw/contracts.ts     operation enum, argv builders, envelope types, categories, input bounds
src/openclaw/runner.ts        SubprocessRunner seam + NodeSubprocessRunner (execFile, no shell)
src/openclaw/pending.ts       PendingStore (atomic JSON, TTL, targetArg replay, claim/start_failed/consumed_unknown, lock, crash recovery)
src/openclaw/reconcile.ts     operator-only reconcile-unknown (local recovery; adapter state only)
src/openclaw/adapter.ts       operation orchestration + result mapping + claim/start lifecycle
src/openclaw/format.ts        Telegram-safe bounded rendering (fixed content text)
src/openclaw/main.ts          argv parsing + one-document envelope emission
bin/form-agent-openclaw.js    adapter launcher (dist/ with TS fallback)
```

Additive accepted-CLI changes (only these):

```text
src/cli/index.ts   `analyze --json` (additive; human output unchanged)
src/cli/run.ts     `run --json-error` (additive; default output unchanged)
```

OpenClaw-side integration (required; SDK details NEEDS VERIFICATION; EXACTLY
ONE submit surface — no custom command):

```text
integrations/openclaw-plugin/index.ts            tools form_agent / form_agent_submit
integrations/openclaw-plugin/approval-hook.ts    before_tool_call.requireApproval for submit
integrations/openclaw-plugin/pending-client.ts   adapter pending_status/submit_pending client
integrations/openclaw-plugin/principal.ts        tool-factory/hook principal derivation + cross-check (single operator)
integrations/openclaw-plugin/openclaw.plugin.json
integrations/openclaw-plugin/package.json
integrations/openclaw-plugin/skills/form-agent/SKILL.md
```

Tests:

```text
tests/phase8-input-bounds.test.ts
tests/phase8-operation-matrix.test.ts
tests/phase8-target-matrix.test.ts
tests/phase8-target-replay.test.ts
tests/phase8-target-tamper.test.ts
tests/phase8-adapter-contract.test.ts
tests/phase8-runner.test.ts
tests/phase8-authz.test.ts
tests/phase8-principal.test.ts
tests/phase8-approval.test.ts
tests/phase8-approval-binding.test.ts
tests/phase8-approval-render.test.ts
tests/phase8-approval-expiry-binding.test.ts
tests/phase8-approval-deny-state.test.ts
tests/phase8-pending.test.ts
tests/phase8-pending-approval-view.test.ts
tests/phase8-unknown-barrier.test.ts
tests/phase8-reconcile-live-child.test.ts
tests/phase8-claim-ownership.test.ts
tests/phase8-submit-lifecycle.test.ts
tests/phase8-submit-ambiguity.test.ts
tests/phase8-submit-terminal-handoff.test.ts
tests/phase8-submit-recovery-barrier.test.ts
tests/phase8-submit-ack-recovery.test.ts
tests/phase8-no-immediate-delete-wording.test.ts
tests/phase8-plan-review.test.ts
tests/phase8-env-contract.test.ts
tests/phase8-redaction.test.ts
tests/phase8-analyze-json.test.ts
tests/phase8-run-json-error.test.ts
tests/phase8-setup-sequence.test.ts
tests/phase8-auth-config-consistency.test.ts
tests/phase8-telegram-account-routing.test.ts
tests/phase8-telegram-group-isolation.test.ts
tests/phase8-exit-category-mapping.test.ts
tests/phase8-exit-success-mapping.test.ts
tests/phase8-submit-structured-proof.test.ts
tests/phase8-telegram-default-account.test.ts
tests/phase8-telegram-approver-fencing.test.ts
tests/phase8-preflight-json-error.test.ts
tests/phase8-argv-matrix.test.ts
tests/phase8-lifecycle-e2e.test.ts
```

`package.json` adds the `bin` entry and `verify:phase8`; no production
dependency unless unavoidable.

---

## 20. Phase 8 requirement list

- **P8-R1 — Preserve accepted Phases 0–7.** Fingerprint
  `7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e`,
  migrations 1–9 immutable, plan version `2.0.0`, frozen exit codes and metrics
  schemas unchanged.
- **P8-R2 — Form Agent sole authority.** No bypass/reimplementation of any
  safety decision.
- **P8-R3 — Deployment topology.** Co-located local invocation by default; no
  new HTTP API/daemon/listener/webhook/port; the restricted remote transport is
  documentation-only and NOT implemented in Phase 8 (STOP + separate transport
  design if co-location proves infeasible).
- **P8-R4 — Trust boundaries.** Implement §4, including the submission
  authority chain and residual-risk mitigations.
- **P8-R5 — Telegram identity/authorization.** Numeric allowlist, private DM
  only, deny-by-default, forwarded content untrusted, adapter re-check, no
  `auth` mutation. Canonical principal from the correct trusted surface (§5.5).
- **P8-R6 — Required typed plugin tool.** `form_agent` and
  `form_agent_submit`; closed operation enum; the exact AP operation-parameter
  matrix (invalid-but-known fields → `usage_error`); argv arrays; `shell:false`;
  no model-supplied executable/path/plan/seed/identity; no skill+exec fallback.
- **P8-R7 — Subprocess safety.** Fixed executable/cwd; closed env schema (§14.1);
  per-op timeouts; output caps; exit capture; process-group cancellation.
- **P8-R8 — Machine-readable contracts.** Consume accepted JSON; only additive
  `analyze --json` and `run --json-error`; preflight ALWAYS passes
  `--json-error` (AU); frozen schemas; defaults unchanged; exactly one machine
  document; adapter never parses human stderr as authority.
- **P8-R9 — Exit-code mapping.** Map `0/1/2/3/4/5/127` to the exact frozen
  categories (AV + AX): exit `0` is operation-specific (`ok_analyze`/`ok_draft`/
  `ok_check`/`needs_confirmation`/`ok_submit_success`/`ok_metrics`; `ok` is a
  STATUS, not a category); `error`/`unknown_outcome`; `usage_error`;
  `blocked_check`/`blocked_preflight`/`blocked_submit`/`already_claimed`;
  `llm_offline`; `llm_connectivity`; submit exit `0`/`2`/`3` requires accepted
  structured proof or becomes `unknown_outcome`; no new Form Agent codes; every
  category has exactly one status.
- **P8-R10 — Host-mediated submit approval.** `before_tool_call.requireApproval`
  with `allowedDecisions: ["allow-once","deny"]`, fail-closed timeout/no-route,
  and a bounded (≤512) description showing the FULL canonical targetDisplay and
  FULL 64-hex planId from trusted pending state; the approval snapshot covers
  `{ pendingRef, principal, planId, targetKey, targetDisplay, expiresAtMs }`
  and tool execution requires exact equality (AE + AL); a non-approval leaves the
  pending record `pending` (AK); the model cannot authorize submission.
- **P8-R11 — Pending protocol.** Frozen fields (no `confirmationCode`),
  `targetKey` (identity) + `targetArg` (replayable) + `targetDisplay` with the
  exact AE/AQ equalities (`canonical.key === targetKey`,
  `canonical.display === targetDisplay`, `targetArg === targetDisplay`; never
  `targetKey` as argv; 256 cap only on `targetArg`/`targetDisplay`, AJ),
  immutable identity fields including `expiresAtMs` (AL), two-step required
  ownership metadata (`attemptId`/`claimedAtMs` pre-spawn; process identity
  post-spawn; AO),
  10-min TTL, single-use claim,
  `pendingRef`+`principal`+`planId`+`targetKey`+`targetDisplay`+`expiresAtMs`
  bound via approval-snapshot param injection, all submit material from
  server-side state only. `pending_status` returns internal `PendingApprovalView`
  with `targetKey`; model-facing results carry only `PendingSummary` (AI).
  Successful preflight returns a non-null `PendingSummary`; blocked preflight
  returns `pending: null`; review values never appear in `pending`.
- **P8-R12 — Confirmation anti-pattern prevention.** §11.5, including
  double-spawn race, old-approval reuse after `start_failed`, the sticky
  `consumed_unknown` barrier, crash recovery, the crash-safe
  `completed_unambiguous` terminal handoff (BA/BB) that never immediately
  deletes and is cleared only by internal `submit_ack`, and a live-child check
  that makes `reconcile_unknown` refuse when the old attempt could still
  complete (AF).
- **P8-R13 — Concurrency/timeout/restart/duplicate behavior.** §12, including
  submit-path ambiguity semantics (§12.1: timeout, cancellation, output cap,
  truncation, malformed output, process loss, crash; a valid
  `completed_unambiguous` handoff under delivery failure remains
  `completed_unambiguous`, replays the same result, and is never
  `consumed_unknown` or re-executed — BB-1).
- **P8-R14 — Unknown outcome.** Never retried; `consumed_unknown` is sticky and
  blocks new preflight/cancel until the operator-only local
  `reconcile_unknown` (privileged assertion + live-child check; adapter
  orchestration state only) clears it. A missing/inconsistent submit state after
  an adapter crash where the outcome cannot be proven is conservatively
  `unknown_outcome`; `submit_status` atomically creates/preserves a durable
  `consumed_unknown` recovery tombstone (BB-3) that blocks new preflight/cancel,
  and barrier-persistence failure fails closed rather than permitting
  retry.
- **P8-R15 — Output privacy.** §13 never-send list; model-visible `content`
  excludes untrusted strings; three review/privacy cases (§13.2); review-value
  bridge strips `draftAnswers`/`planReview` from the final plugin result after
  trusted human delivery and fails closed if delivery is unavailable.
- **P8-R16 — Secrets/config.** No secrets in repo; no `FORM_AGENT_CONFIG`;
  config via `--config`/cwd discovery; closed child env schema (§14.1) with only
  `providerEnvNames` (exact `apiKeyEnv` names) plus `PATH`/`HOME`, no generic
  passthrough list; values never logged/returned/persisted.
- **P8-R17 — Metrics.** Consume Phase 7 read-only; `data = { metrics: <Phase7
  document> }`; no new authority/events/migration.
- **P8-R18 — Migration decision.** No new migration; pending state is
  orchestration-only outside the DB.
- **P8-R19 — Authorization operations.** `auth allow/revoke` remain operator
  CLI/admin actions; not exposed over Telegram.
- **P8-R20 — Local/offline testing + `verify:phase8`.** §16.
- **P8-R21 — External setup checklist.** §15 documented, not performed;
  offline `analyze`/`draft`/`check` fixture smoke (no `run` auth), then local
  `auth allow`/`auth check` for the execution fixture before fixture preflight,
  then local `auth allow`/`auth check` for the live Google Forms target before
  real preflight, all through the SAME Form Agent config/DB context the adapter
  uses (AS; a different DB does not count); fixtures do NOT bypass
  authorization; no real URLs/IDs committed.
- **P8-R22 — No scope creep.** No batch/scheduler/cron/queue/daemon/HTTP/
  provider/parser/policy/rate/execution changes; exactly ONE submit execution
  surface (no custom submit command).
- **P8-R23 — Dedicated agent hardening.** Non-default agent; minimal tool
  surface; dedicated, account-scoped Telegram account (AR) whose `accountId` is
  used consistently by the Telegram account config, binding `match.accountId`,
  plugin config, and adapter `operatorPrincipal.accountId`; explicit
  account-scoped `groupPolicy: "disabled"` + `groups: {}` (AT); preserved
  existing Telegram default via `defaultAccount` (AY); explicit single-approver
  list that fences the global-owner fallback (AZ); single operator; bindings are
  routing not authorization; explicit dangerous-tool denials.
- **P8-R24 — Plugin spawn separation.** No claim that `tools.exec` mediates the
  plugin's `execFile`; document the actual controls.
- **P8-R25 — Frozen input bounds.** The exact table in §7.4 (raw target length
  and kinds, canonical `targetDisplay`/`targetArg` ≤256, provider allowlist,
  adapter-generated seed/pendingId formats, strict RFC3339 since/until,
  pendingRef/planId formats, principal syntax, no control chars, unknown fields
  rejected, no executable/path/cwd/env fields).
- **P8-R26 — Evidence-based target matrix.** §7.3; google-forms limited to
  `preflight`; submit uses `pending.targetArg` only.
- **P8-R27 — Race-safe pending lifecycle.** §11.2 (`pending -> claimed ->
  start_failed | consumed_unknown | completed_unambiguous`, immutable identity
  incl. `expiresAtMs`, two-step pre/post-spawn ownership persistence (AO),
  AE/AQ canonical equality, crash-safe `completed_unambiguous` handoff removed
  only after internal `submit_ack`, `submit_status` READ/NORMALIZE with durable
  missing-state barrier creation, conservative crash recovery (BA/BB)),
  `targetArg` replay, double-spawn elimination, no old-approval reuse,
  sticky unknown barrier + operator-only `reconcile_unknown` with live-child
  refusal; non-approvals leave the pending record `pending` (AK).
- **P8-R28 — Trusted principal separation and single operator.** §5.5 / §6.5;
  `channel` is the constant `telegram`, `accountId` is the single dedicated
  account id (AR) from immutable deployment config, `senderId` from tool-factory
  `requesterSenderId`; hook requires `ctx.requester.channel/accountId/senderId`
  and compares all three; exactly one frozen operator across the dedicated
  account's DM allowlist/native approver and the adapter principal, with the
  GLOBAL `commands.ownerAllowFrom` handled separately (AT; not account-scoped)
  and an explicit account-scoped approver list that fences the global-owner
  fallback (AZ);
  missing/
  mismatch fails closed; no required field assumed beyond official tool-factory
  promises; installed-version verification (including account-scoped Telegram
  config, `defaultAccount` preservation, group isolation, approver-fallback
  fencing, and hook-injected internal params surviving to tool execution, §6.6)
  required before coding.
- **P8-R29 — Operation-parameter matrix.** §6.1.1 exact per-operation model
  field legality; invalid known fields → `usage_error`; `--draft-provider`
  passed where accepted; `form_agent_submit` zero model params.
- **P8-R30 — Three-part target recheck.** §11.1/§11.3: the full
  `key`/`display`/`targetArg === targetDisplay` equality is rechecked before
  approval and before claim/spawn, catching canonicalizing query/fragment/
  userinfo tampering (AQ).

---

## 21. Final verification / acceptance checklist

Future implementation must run:

```bash
npm run verify:phase8
npm test
npm run typecheck
npm run build
git diff --check
```

and confirm:

- observed fixture fingerprint unchanged;
- migrations 1–9 byte-for-byte unchanged; no migration 10;
- execution-plan version still `2.0.0`;
- only `analyze --json` and `run --json-error` are additive; absent-flag output
  is byte-identical;
- submission requires host-mediated plugin approval with
  `allowedDecisions: ["allow-once","deny"]`;
- no model-supplied plan/seed/identity authorizes submission;
- hook and tool-factory principals are cross-checked; mismatch/missing fails
  closed;
- exactly one frozen operator is configured for Phase 8; the DEDICATED,
  account-scoped Telegram account uses explicit `groupPolicy: "disabled"` and
  `groups: {}` (no root-group inheritance) with only that operator in the
  DM allowlist and an explicit account-scoped approver list that fences the
  global-owner fallback (AZ); the dedicated account id is used consistently by
  Telegram config, binding `match.accountId`, plugin config, and adapter
  `operatorPrincipal`; the pre-existing general account remains the explicit
  Telegram `defaultAccount` (AY) and the GLOBAL `commands.ownerAllowFrom` (not
  account-scoped) is preserved/merged, not replaced;
- exact preflight argv includes `--json --json-error`; controlled preflight
  failure uses `--json-error` and creates no pending; the adapter never parses
  stderr as authority;
- exit `0` maps to operation-specific categories (`ok_analyze`/`ok_draft`/
  `ok_check`/`needs_confirmation`/`ok_submit_success`/`ok_metrics`; never a
  generic `ok` category); submit exit `0`/`2`/`3` requires accepted structured
  proof or becomes `unknown_outcome`/`consumed_unknown` (AX);
- every adapter/plugin category maps to exactly ONE frozen status (AV);
  `unauthorized` is `blocked` in both layers; `blocked_preflight`/`llm_offline`/
  `llm_connectivity` are frozen; exit codes map exactly;
- `targetArg` (not `targetKey`) is the only replay target; the full three-part
  canonical equality (`key`, `display`, `targetArg === targetDisplay`) is
  rechecked before approval and before claim/spawn; immutable
  identity fields (including `expiresAtMs`) cannot mutate or be extended under
  one `pendingId`; `targetArg`/`targetDisplay` ≤256 chars (no `targetKey` cap);
- every `form_agent` operation accepts only its frozen AP fields (invalid known
  field → `usage_error`); `--draft-provider` is passed to draft/draft_review/
  check/preflight where accepted; `reviewAnswers` is adapter-only (no Form Agent
  CLI flag); `form_agent_submit` has zero model params;
- `pending_status` exposes `targetKey` only via the internal
  `PendingApprovalView`; model-facing results expose only `PendingSummary`;
- the approval snapshot covers `{ pendingRef, principal, planId, targetKey,
  targetDisplay, expiresAtMs }` and execution requires exact equality plus
  `now < expiresAtMs`;
- deny/timeout/no-route/rejected-allow-always leave the pending record `pending`
  (no adapter call, no auto re-prompt);
- `consumed_unknown` is a sticky barrier cleared only by operator-only
  `reconcile_unknown`; a recorded live child refuses reconciliation; an
  `UNAMBIGUOUS_TERMINAL_RESULTS` result is not deleted immediately but persists a
  bounded `completed_unambiguous` handoff that survives a crash, is replayed (not
  re-executed) until the internal idempotent `submit_ack` clears it after the
  plugin validates the envelope and the stored result matches; a valid handoff
  under delivery failure is NEVER converted to `consumed_unknown`
  (BB-1/BB-2); `attemptId`/`claimedAtMs` are required pre-spawn
  and process identity is persisted post-spawn when available (both crash windows
  stay `consumed_unknown`);
- a submit adapter crash / missing-or-malformed envelope is classified via the
  internal `submit_status` READ/NORMALIZE operation, never as an ordinary
  retryable error and never by reading the adapter JSON directly;
  missing/inconsistent state atomically creates/preserves a durable
  `consumed_unknown` recovery tombstone that blocks new preflight/cancel, and
  barrier-persistence failure fails closed (BB-3);
- no normative "clean completion removes the local record" (or equivalent)
  wording remains anywhere before `submit_ack`;
- the approval snapshot covers ALL SIX fields `{ pendingRef, principal, planId,
  targetKey, targetDisplay, expiresAtMs }` with exact equality plus current
  expiry;
- the setup sequence requires local `auth allow` for the execution fixture
  before fixture preflight and for the live target before real preflight, all
  through the adapter's SAME config/DB context (a different DB does not count);
  no test relies on an unauthorized fixture passing `run` preflight;
- no Telegram/OpenClaw network in tests; no real credentials;
- no new HTTP/daemon/listener/port; remote transport not implemented;
- exactly one submit execution surface (no custom submit command);
- submit-path ambiguity (timeout/cancellation/output-cap/truncation/malformed/
  loss/crash) after start surfaces as `unknown_outcome`, never `timeout`;
  pre-start failure is `submit_start_failed` with a new preflight required;
- `formAgentExitCode` follows the number/null rule (§8.5);
- exact-plan review uses only the same preflight result; pending stores no
  answers;
- secret/HTML sentinels absent; default ops emit no answer values;
- Phase 5 submission safety and Phase 6 approval binding still pass;
- `git status --short` shows only intended Phase 8 files.

### Phase 8 worker final report must map each requirement:

```text
P8-R1  PASS / FAIL -> evidence
...
P8-R30 PASS / FAIL -> evidence
```

and report: targeted `verify:phase8` totals; full regression totals; typecheck;
build; `git status`; known limitations; deviations from this specification.
