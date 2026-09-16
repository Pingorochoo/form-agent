# AGENT_HANDOFF — Phase 8 Planning

## Current repository state

Project: `form-agent`

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

Phase 7 is accepted.

Phase 8 is NOT implemented yet. This pass produced only the Phase 8 planning
specification.

---

## Phase 8 implementation-start contract

When Phase 8 implementation begins, the working tree is expected to contain a
newer Phase 8 planning/docs-only commit (this planning pass) whose parent code
baseline is the accepted Phase 7 code.

The worker must verify the relationship, not a fixed HEAD hash:

1. `git status --short` is clean (no uncommitted changes);
2. the current HEAD is a newer Phase 8 planning/docs-only commit;
3. `fbe2ed0` (`feat: complete phase 7 metrics observability`) is the trusted
   accepted implementation/code baseline that the planning commit builds on;
4. if repository history does not match that relationship, STOP and report
   instead of guessing.

Do NOT require HEAD itself to still be `fbe2ed0`; the planning/docs commit will
have advanced HEAD. The Phase 8 planning commit hash is not known at planning
time and must not be hard-coded.

The trusted accepted implementation baseline remains `fbe2ed0`.

```text
fbe2ed0 feat: complete phase 7 metrics observability   <- accepted CODE baseline
   |
   +-- <Phase 8 planning/docs-only commit>             <- current HEAD before implementation
```

Do not broadly re-audit or redesign accepted Phase 0–7 behavior.

---

## Accepted phase status

| Phase | Status |
|---|---|
| Phase 0 — Foundation | ACCEPTED |
| Phase 1 — Structural analysis | ACCEPTED |
| Phase 2 — Policy & authorization | ACCEPTED |
| Phase 3 — Synthetic profiles + draft answers | ACCEPTED |
| Phase 4 — Consistency gate | ACCEPTED |
| Phase 5 — Controlled browser execution | ACCEPTED |
| Phase 6 — Real LLM wiring | ACCEPTED |
| Phase 7 — Metrics / observability / export | ACCEPTED |
| Phase 8 — OpenClaw + Telegram | NOT STARTED (planning spec) |

The trusted accepted implementation baseline is `fbe2ed0`.

---

## Accepted durable-state invariants

Accepted migrations are `1–9`.

- Migration 8 is `execution_plan_snapshots`.
- Migration 9 is the Phase 7 `metrics_events` store.
- No migration 10 exists; Phase 8 plans none (see `docs/PHASE_8.md` §18).
- Execution plan version is `2.0.0`.
- The observed responder fixture fingerprint must remain exactly:

```text
7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e
```

- The reference draft provider remains the default and remains network-free.
- The frozen exit-code contract remains `0/1/2/3/4/5/127`.

---

## Phase 7 invariants Phase 8 MUST preserve

Phase 8 is an orchestration/presentation layer and must not weaken accepted
Phase 5–7 behavior.

- `PolicyEngine` remains the sole execution-policy authority.
- Authorization happens before `provider.open()`.
- The accepted Phase 5 submit ordering is unchanged: consistency block ->
  accepting gate -> policy A -> fill-only-answered -> DOM verify -> runtime
  fingerprint re-check -> accepting B -> submit readiness -> policy B -> atomic
  durable claim + rate event -> ONE submit attempt -> confirmed success |
  unknown_outcome.
- After the durable claim, ambiguous submit behavior is `unknown_outcome` and
  is never automatically retried.
- `run --submit` loads the persisted approved plan snapshot and makes ZERO LLM
  calls; it never regenerates a draft.
- Snapshot integrity/provenance/approval binding is unchanged: content-bound
  `bundle_sha256` + `provenance_hash` + bound `planId` must match before fill.
- Receipts remain the authoritative execution outcome/claim record.
- `llm_calls` remains the authoritative LLM call-accounting record.
- The real provider boundary is unchanged (one request per stage, no retries,
  no fallback chains, strict structured-output validation, secret-safe errors).
- Metrics are observation-only and must never be read by policy,
  authorization, rate, retry, approval, execution-plan identity,
  submission-claim, consistency, or drafting logic.
- `metrics_events` inserts never participate in any authoritative transaction;
  migration 9 is `metrics_events` only.

Phase 8 must NOT add a new Form Agent migration, a new metrics authority, a new
provider, parser/policy/rate changes, or any execution-order change.

---

## Phase 8 direction (summary)

Phase 8 is a bounded conversational integration:

- OpenClaw + Telegram orchestrate the accepted Form Agent CLI;
- Form Agent remains the sole authority for every safety-critical decision;
- a narrow, typed OpenClaw **plugin tool** (REQUIRED) exposes fixed operations
  with argv arrays (no shell); a skill+`exec` submission fallback is out of
  scope because `tools.exec` does not mediate a plugin's own `child_process`;
- submission requires an OpenClaw **host-mediated plugin approval**
  (`before_tool_call.requireApproval`) with `allowedDecisions`
  exactly `["allow-once","deny"]`; the model cannot authorize submission;
- the planId/target/seed come only from server-side pending state bound to a
  canonical trusted **principal**: `channel` constant `telegram`, `accountId`
  = the single DEDICATED account id (used consistently by Telegram account
  config, binding `match.accountId`, plugin config, and adapter principal),
  `senderId` from tool-factory `requesterSenderId`; the `before_tool_call` hook
  requires and compares `ctx.requester.channel/accountId/senderId`; expires
  (10 min) and is single-use;
- pending stores `targetKey` (identity) plus a replayable `targetArg` and the
  operator-facing `targetDisplay`, with the full three-part equality
  (`canonical.key === targetKey`, `canonical.display === targetDisplay`,
  `targetArg === targetDisplay`) re-checked before approval and before
  claim/spawn; identity fields incl. `expiresAtMs` are immutable under one
  `pendingId`; the approval snapshot covers `{ pendingRef, principal, planId,
  targetKey, targetDisplay, expiresAtMs }`; submit passes `targetArg`, never
  `targetKey`; the 256 cap applies only to `targetArg`/`targetDisplay` (no
  `targetKey` cap); approval text shows the FULL targetDisplay and FULL 64-hex
  planId within the 80/512 caps; the internal `pending_status` returns a
  `PendingApprovalView` carrying `targetKey` (model results carry only the
  smaller `PendingSummary`);
- the pending lifecycle is race-safe as a real two-step: pre-spawn atomic
  `pending -> claimed` persisting required `attemptId`/`claimedAtMs`, then
  spawn, then a SECOND post-spawn atomic update for `childPid`/process group
  when available; pre-start spawn failure -> `start_failed` (new preflight
  allowed); an `UNAMBIGUOUS_TERMINAL_RESULTS` result persists a bounded
  `completed_unambiguous` terminal handoff (NOT an immediate delete) that
  survives a crash and is replayed, never re-executed, until the internal
  idempotent `submit_ack` clears it after the plugin validates the envelope and
  the stored result matches; a valid handoff under a delivery failure stays
  `completed_unambiguous` (never `consumed_unknown`);
  started-then-ambiguous -> sticky `consumed_unknown` that blocks new
  preflight/cancel until an operator-only local `reconcile_unknown` (adapter
  state only) that REFUSES while a prior submit child may still be live; both
  crash windows stay `consumed_unknown` (never auto-retried);
- a SUBMIT adapter crash / missing-or-malformed envelope is classified via the
  internal `submit_status` READ/NORMALIZE call (never an ordinary retryable
  error, never a direct JSON-file read); `claimed`/`consumed_unknown` ->
  `unknown_outcome`, `start_failed` -> `submit_start_failed`,
  `completed_unambiguous` -> replay the SAME stored result (never
  `consumed_unknown`, never re-executed), missing/inconsistent -> `unknown_outcome`
  plus an atomically created durable `consumed_unknown` recovery barrier
  (BB-3; barrier-persistence failure fails closed and no new preflight is
  allowed); the normal ack reads the trusted stored `attemptId` via
  `submit_status` and clears the handoff only when the stored result matches;
  a non-submit adapter crash is an ordinary `error` with no pending;
- `allow-always`, deny, timeout, and no-approval-route all fail closed; a
  non-approval leaves the pending record `pending` (no adapter call, no auto
  re-prompt);
- after the child starts, timeout/cancellation/output-cap/truncation/malformed
  output/process loss/crash are ALL `unknown_outcome` + `consumed_unknown`, never
  ordinary `timeout`, and never automatically retried; recognized
  `UNAMBIGUOUS_TERMINAL_RESULTS` (success/blocked/already_claimed/proven `usage_error`)
  persist the durable handoff described above;
- the exact per-operation model parameter matrix is frozen (AP): invalid-but-
  known fields are `usage_error`; draft/draft_review/check/preflight pass
  `--draft-provider` where accepted; preflight ALWAYS passes `--json --json-error`
  (AU); `reviewAnswers` is adapter-only (no Form Agent CLI flag);
- the adapter/plugin category->status vocabulary is closed (AV): every category
  has exactly one status, `unauthorized` is `blocked` in both layers, and
  `blocked_preflight`/`llm_offline`/`llm_connectivity` are frozen; exit `0` maps
  to operation-specific categories (successful preflight -> `needs_confirmation`;
  no generic `ok` category) and submit exit `0`/`2`/`3` requires accepted
  structured proof or becomes `unknown_outcome`/`consumed_unknown` (AX);
- exact input bounds are frozen (§7.4), and the target matrix is evidence-based:
  `analyze`/`draft`/`check` are fixture-only (accepted resolver rejects live
  URLs), while live Google Forms is supported via `preflight`; fixtures do NOT
  bypass the `run` authorization gate, so setup allowlists the execution fixture
  before fixture preflight and the live target before real preflight, all
  through the adapter's SAME config/DB context (AS);
- submission-bound review comes only from the SAME successful preflight result
  (`--review-answers`); exploratory `draft_review` is never submission-bound;
  pending state stores no answer values; review values are stripped before model
  `content`/`details`;
- dedicated **non-default**-agent hardening with a SINGLE frozen operator on a
  DEDICATED, account-scoped Telegram account (AR) that is explicitly DM-only via
  account-scoped `groupPolicy: "disabled"` + `groups: {}` (AT, no root-group
  inheritance), with `commands.ownerAllowFrom` GLOBAL (not account-scoped) and
  preserved/merged alongside unrelated owners; an explicit account-scoped
  `execApprovals.approvers` list of exactly the frozen operator fences the
  global-owner fallback (AZ); the pre-existing general account remains the
  explicit Telegram `defaultAccount` and keeps its own agent/config (AY);
  minimal tool surface and untrusted form text kept out of
  model-visible `content`; review values delivered to the human via trusted
  same-chat delivery; Telegram output summary-only by default and redacted;
- exactly ONE submit execution surface (typed tool -> plugin approval ->
  adapter); no custom submit command;
- deployment is co-located local invocation by default (no new HTTP API,
  daemon, listener, or port); the restricted remote transport is
  documentation-only and not implemented in Phase 8.

Full requirement set (`P8-R1` … `P8-R30`), trust/threat model, frozen input
bounds, target matrix, adapter operations, host-approval/pending lifecycle,
submit-timeout semantics, principal model, sensitive-output policy, child
env/config contract, external setup checklist, test plan, CLI additive-surface
decisions, and migration decision live in:

```text
docs/PHASE_8.md
```

The phase-worker must not edit `docs/PHASE_8.md`.

---

## Where Phase 8 should start

1. Read `AGENTS.md`, this handoff, and `docs/PHASE_8.md`.
2. Verify `git status --short` is clean and that the Phase 8
   implementation-start contract above holds (current HEAD is the Phase 8
   planning/docs-only commit; `fbe2ed0` is its accepted code baseline). If the
   relationship does not match, STOP and report. Do NOT require HEAD to still be
   `fbe2ed0`.
3. Inspect the accepted surfaces Phase 8 consumes:
   - `src/cli/index.ts` (`analyze`), `src/cli/run.ts`, `src/cli/draft.ts`,
     `src/cli/check.ts`, `src/cli/metrics.ts`;
   - `src/cli/exit-codes.ts`, `src/execution/errors.ts`;
   - `src/execution/format.ts`, `src/execution/orchestrate.ts`,
     `src/execution/receipt.ts`, `src/execution/snapshot.ts`;
   - `src/draft/format.ts`, `src/consistency/format.ts`;
   - `src/metrics/format.ts`, `src/metrics/aggregate.ts`;
   - `src/policy/target.ts`, `src/config/schema.ts`;
   - `tests/support/phase5.ts`, `tests/support/phase7.ts`,
     `tests/support/phase6-llm-stub.ts`.
4. Implement one milestone at a time, beginning with the adapter contracts and
   subprocess runner seam, then the pending store and input bounds, then the
   adapter operations/formatting and submit-timeout semantics, then the
   additive CLI JSON surfaces, then the OpenClaw plugin tools plus the
   `before_tool_call.requireApproval` submit gate, then the local E2E
   acceptance.
5. Run targeted tests during development; run the full regression only for
   final acceptance.

Do not start Phase 9.

---

## Phase 9

There is no accepted Phase 9 definition. Phase 9 remains undefined and is NOT
STARTED.
