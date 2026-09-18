# Phase 9 — Production Deployment + Controlled Live E2E Validation

> **Status note.** This document is the planning specification for Phase 9. It
> was created from the Phase 9 starting branch baseline `71be41d`
> (`docs: finalize phase 8 handoff`, the final Phase 8 handoff commit). The Phase
> 8 implementation checkpoint is `56995a9`; the Phase 8 acceptance record/tag is
> `954c2b7` / `phase-8-accepted -> 954c2b7`. It is **PLANNED — NOT IMPLEMENTED**
> and is protected from implementation-worker edits (see
> `.opencode/agents/phase-worker.md`). Phase 9 does **not** redesign Phase 8
> and does **not** add major new capabilities; it deploys the accepted Phase 8
> integration and proves the complete controlled real operator path end-to-end.

## 1. Status, purpose, and non-goals

### Status

PLANNED — NOT IMPLEMENTED. No Phase 9 implementation exists at planning time.
`docs/PHASE_9_ACCEPTANCE.md` does not exist and MUST only be created when actual
Phase 9 acceptance evidence exists (§9).

### Purpose

Phase 9 exists to take the **accepted** Phase 8 OpenClaw/Telegram integration and
prove the complete controlled real deployment path end-to-end:

```text
real Telegram private DM
    ↓
dedicated Form Agent Telegram account
    ↓
dedicated non-default OpenClaw agent
    ↓
form_agent / form_agent_submit
    ↓
OpenClaw adapter
    ↓
Form Agent CLI
    ↓
authorized controlled Google Form
```

The intended project progression is:

```text
Phase 8
    implementation
    + deterministic integration verification

Phase 9
    production-like deployment
    + controlled live end-to-end validation

Later phases
    new capabilities
```

Phase 9 is primarily a **deployment and validation** phase. It consumes accepted
Phase 8 surfaces; it does not reimplement them.

### Non-goals

Phase 9 MUST NOT include any of the following (these require separately reviewed
future specifications and MUST NOT be assigned automatically to Phase 10):

- multi-operator support;
- multiple Telegram approvers;
- Telegram groups or channels;
- SSH execution;
- Tailscale remote execution;
- generic remote transport;
- HTTP APIs or REST APIs;
- new web services, daemons, listeners, webhooks, or opened ports;
- schedulers, cron-based execution, or queues;
- batch submissions or autonomous submissions;
- new LLM providers;
- parser redesign;
- answer-generation redesign;
- `PolicyEngine` redesign;
- new authorization semantics or new rate-policy semantics;
- database migrations unless a concrete deployment defect proves one absolutely
  necessary (§6; this is expected to be unnecessary);
- new submission execution surfaces;
- broad OpenClaw architecture changes.

Phase 9 MUST NOT redesign Phase 8, MUST NOT add major new capabilities, and MUST
NOT weaken any accepted Phase 8 safety contract.

### Core architectural principle (preserved, not redefined)

The Phase 8 core principle remains frozen and in force: OpenClaw/Telegram MAY
orchestrate CLI calls and present results, but MUST NOT override a Form Agent
block, invent approval, regenerate answers during submit, bypass
`--expect-plan`, retry a submission after durable submit intent, reinterpret
`unknown_outcome` as success, or mutate policy/rate/receipt/snapshot state
except through accepted CLI actions.

Form Agent remains the sole authority for: authorization; sensitive-field
policy; rate policy; draft eligibility; consistency; plan identity; approval
binding; execution gates; durable submission claim; duplicate-submit prevention;
unknown-outcome semantics; metrics/observability.

### Phase 9 execution model — operator-assisted live validation

Phase 9 has two distinct execution surfaces. They MUST NOT be conflated.

**Human/operator live surface.** The human operator performs or directly
supervises every action that touches live infrastructure or secrets, including:

- the real OpenClaw host and its runtime;
- OpenClaw configuration outside this repository;
- Telegram bot/account configuration;
- Telegram credentials/secrets;
- real Telegram messages;
- the controlled external Google Form;
- real Google Forms preflight;
- the single Stage F live submission;
- independent inspection of the controlled Google Form;
- any local secret store or environment that coding agents are forbidden to
  inspect.

The operator MUST follow the frozen Phase 9 staged sequence (§8) and provide only
**sanitized** evidence back to the repository/reviewer. No secret values are
committed or pasted into agent-readable repository files (§7).

**Repository phase-worker surface.** The existing
`.opencode/agents/phase-worker.md` contract remains in force and is compatible
with this model. A repository phase-worker MAY:

- inspect repository code/spec/tests;
- run its allowed local deterministic commands and targeted tests;
- run `verify:phase8` / regression / typecheck / build where permitted;
- diagnose repository-local implementation defects demonstrated by deployment
  evidence;
- implement the narrowest repo-local fix if the Phase 9 code-change policy
  permits it (§6);
- add targeted deterministic regression tests when a real implementation defect
  is proven;
- help produce sanitized repository acceptance evidence from operator-observed
  results.

A repository phase-worker MUST NOT (these restate existing contract restrictions;
they are not new grants):

- operate the external Google Form;
- send real Telegram messages;
- inspect Telegram secrets;
- modify OpenClaw files outside the repository;
- bypass its `external_directory` restriction;
- gain broader shell permissions merely to execute Phase 9;
- claim a live Stage A–F result based on simulation.

A coding agent's assertion is never sufficient live evidence. Live stage results
MUST come from actual operator-observed deployment outcomes (§8, §9). No new
privileged agent is created to bypass these restrictions.

---

## 2. Accepted Phase 8 baseline and Git roles

Phase 8 is accepted and closed, and is integrated into `main`. Three distinct
Git facts MUST NOT be confused:

**Phase 8 implementation checkpoint** (the code/test state that was reviewed):

```text
56995a9 wip: checkpoint phase 8 implementation for runtime verification
```

**Phase 8 acceptance record/tag** (the durable acceptance evidence):

```text
954c2b7 docs: record phase 8 acceptance
phase-8-accepted -> 954c2b7
```

**Phase 9 starting branch baseline** (the final Phase 8 handoff state; `phase/9`
was created from this commit):

```text
71be41d docs: finalize phase 8 handoff
```

`71be41d` is a documentation/handoff commit, NOT the Phase 8 implementation
checkpoint. The `phase-8-accepted` tag (`954c2b7`) is reachable from the `71be41d`
baseline.

Phase 8 MUST NOT be broadly re-audited and MUST NOT be reimplemented. Only reopen
Phase 8 work when there is concrete evidence (a relevant regression test fails,
Phase 9 directly depends on a conflicting interface, or repository evidence
contradicts the documented baseline).

Phase 9 preserves the frozen accepted surfaces referenced by `docs/PHASE_8.md`,
including:

- migrations `1–9` immutable (no new migration expected; §6);
- execution-plan version `2.0.0`;
- the observed responder fixture fingerprint
  `7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e`;
- the frozen exit-code contract `0/1/2/3/4/5/127`;
- the frozen Phase 7 metrics JSON/CSV schemas;
- the Phase 5 submit ordering and Phase 6 approval/snapshot binding;
- the Phase 8 adapter envelope, category→status vocabulary, pending protocol,
  crash-safe submit terminal handoff, and trusted-principal contract.

---

## 3. What Phase 8 did and did not prove

Repository evidence (see `docs/PHASE_8_ACCEPTANCE.md`) records that Phase 8
established:

- OpenClaw plugin loading against the accepted runtime `OpenClaw 2026.9.4
  (3a9d69d)`;
- `form_agent` tool registration;
- `form_agent_submit` tool registration;
- `before_tool_call` approval hook registration;
- deterministic adapter/plugin tests;
- full repository regression;
- runtime compatibility evidence against the pinned runtime.

Phase 8 deliberately did **not** establish the complete real operator path with
a real Telegram private DM, a dedicated Telegram account, a live dedicated
OpenClaw agent, an authorized controlled Google Form, and a real submission. The
Phase 8 runtime proof used an isolated temporary OpenClaw home; no real Telegram
credentials, real Telegram messages, production OpenClaw state, or real Google
Form submissions were used.

Phase 9 closes exactly that validation gap. Phase 9 MUST NOT overstate anything
Phase 8 did not actually prove.

---

## 4. Preserved architectural invariants

Phase 9 MUST explicitly preserve every accepted Phase 8 safety/architecture
boundary. Where a requirement is already frozen by Phase 8, Phase 9 references
the Phase 8 requirement rather than silently redefining it. At minimum:

| Invariant | Phase 8 source |
|---|---|
| Form Agent remains the sole authority for safety-critical decisions | `docs/PHASE_8.md` §1, P8-R2 |
| OpenClaw is an orchestration surface, not a safety authority | `docs/PHASE_8.md` §1, §4 |
| Telegram is an operator/approval surface, not a safety authority | `docs/PHASE_8.md` §4, §5 |
| Exactly one Telegram operator | P8-R28, §5.1 |
| Immutable numeric Telegram identity for that operator | §5.1, §5.5 |
| Private DM only | §5.1 |
| Telegram groups disabled, with explicit `groupPolicy: "disabled"` + `groups: {}` | P8-R23, AT |
| Dedicated Form Agent Telegram bot/account | §5.1, AR |
| That account is not the existing default/general Telegram account | AY, §15.1 |
| Dedicated non-default OpenClaw agent | P8-R23 |
| Explicit binding between the dedicated account and the Form Agent agent | §15.2, AR |
| Local/co-located Form Agent adapter | §3.2 |
| Same Form Agent configuration for adapter and administrative operations | AS |
| Same Form Agent SQLite database for adapter and administrative operations | AS |
| Explicit host-mediated approval (`before_tool_call.requireApproval`) | P8-R10, §6.2 |
| Submit approval remains `allow-once` | §6.2 |
| No persistent `allow-always` submission permission | §6.2 |
| Explicit, non-empty account-scoped `execApprovals.approvers` containing EXACTLY the single frozen Form Agent operator, fencing the GLOBAL `commands.ownerAllowFrom` fallback (AZ) | P8-R23, §5.1 item 6, AZ |
| No authorization mutation through Telegram | P8-R19, §5.1 |
| No second submission execution path | §6.7 |
| No answer regeneration during submit | §11.4 |
| Submit uses the already-reviewed plan/answers | §11.4 |
| No retry of ambiguous or `unknown_outcome` submissions | §12.1, P8-R14 |
| Accepted Phase 8 runtime compatibility remains the baseline unless real deployment produces reproducible evidence of a narrow compatibility defect | §3, §6.6 |

Deployment-relevant invariants MUST be re-confirmed against the **real installed
deployment** using real configuration/runtime evidence. Pure code-path
invariants (fail-closed permutations, tampering, crash windows, corrupted state,
timeout/no-route handling) remain supported by the accepted Phase 8
implementation plus deterministic Phase 8 regression unless live deployment
evidence contradicts them.

### 4.1 Evidence model: live-required vs deterministic-supported

Phase 9 proves the real deployment without unnecessarily recreating every
destructive/edge-case Phase 8 test against live infrastructure.

**Must be demonstrated live/deployed (minimum):**

- the real dedicated Telegram account exists and is correctly isolated;
- the dedicated Form Agent account has an explicit, non-empty account-scoped
  `execApprovals.approvers` containing EXACTLY the single frozen Form Agent
  operator, and the installed runtime proves it FENCES the GLOBAL
  `commands.ownerAllowFrom` fallback (AZ);
- a real authorized operator DM routes to the dedicated Form Agent agent;
- the plugin/tools/`before_tool_call` hook register in the installed deployment;
- the deployed fixture flow (`analyze`/`draft`/`check`) works;
- deployed fixture preflight works using the adapter's same config/DB
  authorization;
- at least one REAL host-mediated `deny` demonstrates no submit;
- the real authorized Google Forms preflight performs no submission;
- exactly one controlled `allow-once` real submission is attempted in Stage F.

**May remain supported by accepted deterministic Phase 8 regression unless
deployment evidence contradicts it (examples):**

- wrong/missing principal internal permutations;
- malformed/tampered approval-snapshot fields;
- replaced pending records;
- every expired/invalid approval permutation;
- crash windows;
- corrupted state;
- every timeout/no-route edge case;
- other implementation-level fail-closed cases already accepted in Phase 8.

A second real Telegram user/account MUST NOT be required merely to make Phase 9
PASS. For unauthorized-principal deployment assurance, Phase 9 MUST verify the
real deployed allowlist and account-scoped approver configuration and the
fail-closed wiring. The AZ fencing gate (§5, Stage C) requires the installed
pinned runtime to PROVE that the explicit account-scoped `execApprovals.approvers`
fences the GLOBAL `commands.ownerAllowFrom` fallback; if it instead unions
unrelated global owners into the dedicated Form Agent approval authority, Phase 9
MUST STOP/BLOCK before any real Stage F submission and require reviewed
approval-routing adaptation (do not weaken AA/AZ). A live unauthorized-user DM
MAY be performed if a safe second identity is readily available, but the absence
of a second identity alone MUST NOT block Phase 9.

A live host-mediated `deny` IS required because it directly validates the real
approval route. A live approval timeout MAY be performed if useful and safe, but
not every negative host state is mandatory when Phase 8 already provides
deterministic executable evidence.

All Phase 8 tests are preserved and `verify:phase8` is rerun (§10).

---

## 5. Real deployment verification (required before Stage F)

Before the Stage F real submission, Phase 9 MUST verify the **real installed
deployment** rather than assuming documented configuration examples are still
correct. Exact OpenClaw configuration syntax MUST be verified against the
actually installed pinned runtime; an old configuration example MUST NOT be
blindly copied if runtime evidence disagrees with it.

At minimum verify:

**Dedicated Telegram account / bot**

- dedicated Telegram account/bot exists;
- it is not the default/general Telegram account;
- existing general/default behavior and account/agent routing remain unaffected
  (see the §4 AY invariant; narrowly scoped root/global configuration changes
  that preserve those invariants are permitted and MAY be required);
- the dedicated account uses the intended private-DM policy;
- the Telegram operator allowlist contains only the intended Form Agent
  operator;
- groups are explicitly disabled;
- the groups configuration does not accidentally permit access (account-scoped
  explicit empty `groups`; no root-group inheritance).

**Approver fencing (AZ gate — deployment-acceptance critical)**

- the dedicated Form Agent Telegram account has an explicit, non-empty
  account-scoped `execApprovals.approvers`;
- that list contains EXACTLY the single frozen Form Agent operator;
- the installed OpenClaw runtime proves this explicit account-scoped approver
  list FENCES the GLOBAL `commands.ownerAllowFrom` fallback;
- unrelated global owners MUST NOT become Form Agent approvers merely because
  they are global command owners;
- the existing rule that GLOBAL `commands.ownerAllowFrom` may need to
  preserve/merge unrelated valid owners is NOT weakened — the security property
  is isolation of Form Agent approval authority, not removal of unrelated global
  owners;
- if the installed pinned runtime instead unions unrelated global owners into the
  dedicated Form Agent approval authority, Phase 9 MUST STOP/BLOCK before any
  real Stage F submission and require reviewed approval-routing adaptation.

**Dedicated OpenClaw agent**

- dedicated OpenClaw Form Agent agent exists;
- dedicated agent is not the default agent;
- routing/binding explicitly references the dedicated Telegram account.

**Runtime / plugin registration**

- plugin loads successfully;
- `form_agent` registers;
- `form_agent_submit` registers;
- `before_tool_call` approval hook registers.

**Adapter / Form Agent wiring**

- adapter executable resolves correctly;
- Form Agent configuration path is the intended path;
- Form Agent SQLite database is the intended database;
- administrative authorization operations resolve to that same configuration and
  database (same-config/same-DB, AS).

**Execution runtime**

- Playwright is available;
- Chromium/browser runtime is available;
- required runtime dependencies exist;
- environment forwarding is no broader than accepted Phase 8 behavior (closed
  env schema, `docs/PHASE_8.md` §14.1).

Verification evidence MUST be sanitized (§7) and recorded for acceptance (§9).

---

## 6. Production-code change policy

Phase 9 is deployment/validation first. Production code changes are **not
expected** merely because deployment is taking place.

If live deployment uncovers a defect:

1. capture reproducible evidence;
2. identify the violated accepted Phase 8 contract;
3. determine whether the problem is:
   - deployment/configuration only; or
   - an actual implementation defect;
4. if it is an implementation defect, make the **narrowest possible**
   correction;
5. add a targeted deterministic regression test;
6. preserve every relevant accepted Phase 8 invariant;
7. rerun the required Phase 8 and full regression gates.

If the required fix would alter a frozen architectural decision or expand scope:

```text
Phase 9 status = BLOCKED
```

and specification review is required before continuing. Do not silently expand
Phase 9.

No database migration is expected. If implementation evidence proves a migration
is genuinely required, STOP and report rather than silently reserving or
inventing migration 10 (consistent with `docs/PHASE_8.md` §18). A migration is
only permissible after explicit specification review that proves it absolutely
necessary.

---

## 7. Security / secret handling

Phase 9 MUST NOT commit:

- Telegram bot tokens;
- API keys;
- passwords;
- authentication cookies;
- browser session secrets;
- private environment values;
- access tokens;
- unnecessary personal identifiers.

Acceptance evidence MUST be sanitized. Do not paste secret values into:

- Markdown;
- test fixtures;
- committed logs;
- snapshots;
- example configuration;
- Git commit messages.

If an identifier is not necessary for proving an invariant, redact it. Numeric
Telegram IDs should not be published in acceptance evidence unless absolutely
required to establish a specific invariant. Live credentials and live
target identifiers remain local/operator-held.

---

## 8. Staged live-validation progression

Validation MUST be staged from least dangerous to most dangerous. A later stage
MUST NOT be attempted until all earlier applicable stages have passed. A failed
or blocked stage stops progression (see §12).

**Stage ownership.** Stages that involve live infrastructure (the real OpenClaw
host, Telegram, and the controlled Google Form) are operator-executed and
operator-observed (see §1, "Phase 9 execution model — operator-assisted live
validation"). Repository-local tooling MAY assist with deterministic checks only.
Live evidence MUST derive from actual operator-observed deployment results; a
coding agent's assertion is never sufficient evidence.

### Stage A — deployed offline fixture

Using the real deployed OpenClaw/Form Agent stack, run the accepted offline
fixture through:

```text
analyze → draft → check
```

Verify the actual deployed integration path.

- No submission occurs.
- No real Google Form is required.

### Stage B — fixture preflight

Using the exact Form Agent configuration and SQLite database used by the
deployed adapter:

- perform any required authorization through the existing trusted local/admin
  surface (never through Telegram);
- invoke the fixture/preflight path through deployed OpenClaw/Form Agent;
- confirm Telegram exposes no authorization-mutation surface.

No real external submission occurs.

### Stage C — real Telegram routing

Using the dedicated Form Agent Telegram account and the single authorized
operator, verify:

- a private DM reaches the dedicated Form Agent OpenClaw agent;
- the dedicated account is not the default/general Telegram account;
- existing general/default behavior and account/agent routing remain unaffected;
- Form Agent tools are available in the dedicated agent;
- unrelated dangerous tools are not exposed through the Form Agent surface;
- groups remain disabled;
- the real deployed Telegram allowlist and account-scoped approver configuration
  are verified and the unauthorized-principal path fails closed by configuration
  and wiring;
- the AZ gate is demonstrated: the explicit account-scoped
  `execApprovals.approvers` (EXACTLY the single frozen operator) is proven to
  fence the GLOBAL `commands.ownerAllowFrom` fallback; unrelated global owners are
  not Form Agent approvers. If the installed runtime instead unions unrelated
  global owners into the dedicated Form Agent approval authority, Phase 9 MUST
  STOP/BLOCK before any real Stage F submission and require reviewed
  approval-routing adaptation;
- a live unauthorized-user DM MAY additionally be performed if a safe second
  identity is readily available; the absence of a second identity alone MUST NOT
  block Phase 9 (see §4.1).

This stage MUST NOT submit a Google Form.

### Stage D — approval denial path

Create a valid controlled pending submission state using an appropriate safe
target/fixture. Exercise the **real host-mediated approval path** with:

```text
deny
```

A live host-mediated `deny` IS required. Verify:

- submission execution does not occur;
- no receipt incorrectly claims success;
- pending-state behavior matches accepted Phase 8 semantics (a non-approval
  leaves the pending record `pending`, AK).

The remaining negative states (absent, expired, invalid, or
unproven/wrong-principal approval; approval timeout/no-route) MAY remain
supported by the accepted deterministic Phase 8 regression unless deployment
evidence contradicts it (§4.1). A live approval timeout MAY be performed if
useful and safe, but is not mandatory. No real successful external submission is
required for Stage D.

### Stage E — controlled real Google Forms preflight

Use a purpose-built Google Form that is:

- owned by the operator; or
- explicitly controlled and authorized for this test.

Authorization MUST occur using the trusted Form Agent local/admin path. Telegram
MUST NOT gain authorization mutation functionality.

Through the real Telegram/OpenClaw/Form Agent stack, perform the real target
preflight. Verify:

- target authorization is recognized;
- plan identity is produced and preserved;
- review information is bounded;
- the target is the intended controlled form;
- no submission occurs.

### Stage F — exactly one controlled real submission

Only after Stages A through E pass, perform exactly one intentional end-to-end
submission to the purpose-built controlled Google Form.

Require explicit human `allow-once`. Verify the full chain:

```text
Telegram operator request
    ↓
dedicated OpenClaw agent
    ↓
Form Agent tool request
    ↓
host-mediated approval request
    ↓
explicit human allow-once
    ↓
adapter pending-state validation
    ↓
Form Agent authorization validation
    ↓
plan/approval binding validation
    ↓
durable submission claim
    ↓
browser execution
    ↓
terminal outcome
    ↓
receipt / metrics evidence
```

Then independently verify at the controlled target that:

```text
exactly one expected test response exists
```

Do not perform repeated live submissions merely to gain confidence. Do not
perform batch testing against the external target.

If the single Stage F execution returns `unknown_outcome` or any other ambiguous
post-start outcome:

1. DO NOT retry the submission;
2. preserve all evidence;
3. independently inspect the controlled target;
4. use the already-accepted local/operator-only reconciliation mechanism only
   when its requirements are satisfied (`docs/PHASE_8.md` §11.2a, §12.1,
   P8-R14);
5. do not reinterpret `unknown_outcome` as success;
6. Stage F does NOT count as a successful Phase 9 live terminal-path proof;
7. Phase 9 acceptance remains BLOCKED for Stage F rather than performing a
   second live submission merely to obtain a clean run.

Document the observed response count and reconciliation result in the eventual
acceptance evidence. The sticky `consumed_unknown` barrier and the
operator-only reconciliation contract MUST NOT be weakened.

`unknown_outcome` MUST NOT be converted into success even if a later independent
target inspection finds a response; the accepted ambiguity semantics remain
authoritative and Phase 9 remains BLOCKED for Stage F in that case.

A successful Phase 9 Stage F / PASS therefore requires the one controlled Stage F
attempt to return the accepted successful submit category `ok_submit_success`
with status `ok`, receipt/metrics evidence consistent with that successful
submission, AND independent inspection of the controlled Google Form showing
exactly one expected response. Any other terminal result — even an accepted
unambiguous non-success such as `blocked_submit`, `already_claimed`,
`usage_error`, or `submit_start_failed` — does NOT satisfy Stage F success: it
leaves Stage F not accepted / BLOCKED for this acceptance run, with evidence
preserved for diagnosis. Phase 8 retry rules are unchanged; no automatic retry is
invented for these outcomes in this pass.

---

## 9. Acceptance evidence

Successful Phase 9 must eventually produce:

```text
docs/PHASE_9_ACCEPTANCE.md
```

This file MUST NOT be created during planning and MUST only be created when
actual acceptance evidence exists. Never fabricate live evidence. A mocked or
simulated Telegram workflow MUST NOT be represented as live evidence. Live stage
results recorded here MUST be sanitized operator-observed outcomes, not
coding-agent claims.

The final acceptance document should record sanitized evidence for:

- deployment configuration invariants;
- deployed runtime/plugin registration;
- Stage A result;
- Stage B result;
- Stage C result;
- Stage D result;
- Stage E result;
- Stage F result;
- Stage F ambiguity handling and reconciliation result (if the single attempt was
  ambiguous);
- regression results;
- final Git state;
- acceptance decision.

---

## 10. Automated regression requirements

The Phase 9 specification preserves at least these final regression gates:

```bash
npm run verify:phase8
npm test
npm run typecheck
npm run build
git diff --check
git status --short
```

If Phase 9 causes repository code/tests to be added, a targeted deterministic
`verify:phase9` command MAY be introduced during implementation. Any future
`verify:phase9` command:

- must be deterministic;
- must be safe for ordinary CI/local regression;
- must not require Telegram credentials;
- must not require a live Telegram account;
- must not require a real Google Form;
- must not perform real external submissions.

Live E2E validation is a separate acceptance gate and MUST NOT be represented by
deterministic tests. `verify:phase9` is not added during planning.

---

## 11. Phase 9 requirement list

- **P9-R1 — Preserve the accepted Phase 8 baseline.** Phase 8 is accepted and
  closed; do not re-audit or reimplement it. Preserve migrations `1–9`, plan
  version `2.0.0`, the observed fixture fingerprint, the frozen exit-code
  contract, the Phase 7 metrics schemas, the Phase 5 submit ordering, the Phase 6
  approval/snapshot binding, and the Phase 8 adapter/plugin contracts.
- **P9-R2 — Form Agent sole authority.** No bypass or reimplementation of any
  safety-critical decision; OpenClaw and Telegram remain orchestration/
  operator surfaces only.
- **P9-R3 — Single-operator / private-DM topology.** Exactly one immutable
  numeric Telegram operator, private DM only, explicit group isolation; preserve
  P8-R28 and Phase 8 §5.
- **P9-R4 — Preserve existing general/default Telegram behavior.** The
  pre-existing general/default account remains the Telegram default, and its
  account configuration, routing, existing agent behavior, group behavior, and
  unrelated workflows remain unaffected; the dedicated account never becomes the
  default (AY preserved). Narrowly scoped global/root changes required to
  preserve those invariants are permitted and MAY be necessary — explicitly
  setting `channels.telegram.defaultAccount` to the existing general account, and
  MERGING the Form Agent operator into the GLOBAL `commands.ownerAllowFrom` when
  owner status is actually required while preserving every unrelated existing
  valid owner (AT/AZ preserved). The entire root/general OpenClaw configuration
  is NOT required to be byte-for-byte unchanged.
- **P9-R5 — Verify the real dedicated OpenClaw deployment.** Verify the
  deployment checklist in §5 against the actually installed pinned runtime; do
  not assume documented examples are current.
- **P9-R6 — Verify deployed offline-fixture analyze/draft/check.** Stage A.
- **P9-R7 — Verify fixture/preflight behavior through the deployed stack.**
  Stage B.
- **P9-R8 — Verify real Telegram dedicated-account routing and principal
  restrictions.** Stage C: verify real deployed routing, the dedicated-account
  allowlist and account-scoped approver configuration, fail-closed wiring, and
  unaffected general/default behavior. Verify the AZ fencing gate: the explicit
  account-scoped `execApprovals.approvers` contains EXACTLY the single frozen
  Form Agent operator and the installed runtime proves it fences the GLOBAL
  `commands.ownerAllowFrom` fallback; unrelated global owners MUST NOT be Form
  Agent approvers, and if the runtime unions them in, Phase 9 MUST STOP/BLOCK
  before any real Stage F submission pending reviewed approval-routing
  adaptation. A live unauthorized-user DM is optional (§4.1); its absence alone
  MUST NOT block Phase 9.
- **P9-R9 — Verify a real host-mediated deny produces no submission.** Stage D
  requires a live `deny`. The other negative approval states (absent, expired,
  invalid, wrong/unknown principal, timeout/no-route) MAY remain supported by the
  accepted deterministic Phase 8 regression unless deployment evidence
  contradicts it (§4.1); a live timeout is optional.
- **P9-R10 — Verify authorized real Google Forms preflight without submission.**
  Stage E.
- **P9-R11 — Verify exactly one controlled allow-once end-to-end submission.**
  Stage F, gated on Stages A–E passing; no retry on ambiguity. Phase 9 PASS for
  Stage F requires the submit path to return the accepted success category
  `ok_submit_success` with status `ok` and consistent receipt/metrics evidence.
  An unambiguous non-success terminal result (`blocked_submit`,
  `already_claimed`, `usage_error`, `submit_start_failed`) does NOT satisfy Stage
  F; `unknown_outcome` or any ambiguous post-start outcome leaves Stage F BLOCKED
  without retry (§8, Stage F; Phase 8 retry/reconciliation rules unchanged).
- **P9-R12 — Verify terminal receipt/metrics evidence and exactly one
  independently observed controlled response.** Stage F independent target
  verification: exactly one expected response at the controlled form, consistent
  with the `ok_submit_success` (status `ok`) terminal category and its durable
  receipt/metrics evidence.
- **P9-R13 — Preserve authorization mutation exclusively through the trusted
  non-Telegram administrative surface.** No auth-mutation tool or command over
  Telegram; the same config/DB context is used by adapter and admin operations
  (AS).
- **P9-R14 — Commit no credentials or secrets.** §7 sanitization rules apply to
  code, tests, fixtures, logs, configuration examples, documentation, and Git
  commit messages.
- **P9-R15 — Pass Phase 8 regression, full regression, typecheck, build, and
  repository consistency checks.** §10 gates.
- **P9-R16 — Record durable sanitized Phase 9 acceptance evidence.**
  `docs/PHASE_9_ACCEPTANCE.md` per §9, only from real evidence.

If repository evidence demonstrates one of these IDs is logically redundant or
inconsistent with existing contracts, report that before changing it. Do not add
speculative requirements unrelated to the stated Phase 9 purpose.

---

## 12. Acceptance semantics

Use:

```text
PASS
```

only when all applicable Phase 9 requirements have sufficient executable or
directly observed evidence.

Use:

```text
BLOCKED
```

when required real-world acceptance evidence cannot be produced. Examples:

- unavailable Telegram credentials;
- unavailable controlled Google Form;
- deployment environment unavailable;
- required runtime incompatibility requiring architectural review.

Examples of `BLOCKED` are not failures of the deterministic suite and MUST NOT be
reported as `PASS`.

Do not call Phase 9 PASS based solely on mocked tests. Do not substitute
simulated live infrastructure for required live validation.

---

## 13. Phase 9 end state

Successful Phase 9 is approximately:

```text
accepted Phase 8 implementation
        +
real dedicated OpenClaw deployment
        +
real dedicated Telegram operator path
        +
controlled real Google Forms preflight
        +
one controlled human-approved submission
        +
independent verification of exactly one expected response
        +
sanitized durable acceptance evidence
```

After Phase 9 acceptance: STOP. Do not automatically begin Phase 10.

---

## 14. Final verification / acceptance checklist

Future Phase 9 acceptance must run and report:

```bash
npm run verify:phase8
npm test
npm run typecheck
npm run build
git diff --check
git status --short
```

and confirm, with sanitized evidence:

- Stages A–E passed before Stage F was attempted, with the live-required items in
  §4.1 demonstrated live/deployed;
- exactly ONE controlled real submission was performed, under explicit human
  `allow-once`, with no retry on ambiguity;
- the single Stage F attempt returned the accepted success category
  `ok_submit_success` with status `ok`, and receipt/metrics evidence is
  consistent with that successful submission;
- exactly one expected test response was independently observed at the
  controlled target, matching the successful `ok_submit_success` submission;
- any other Stage F terminal result — `unknown_outcome`/ambiguous, or an
  unambiguous non-success such as `blocked_submit`, `already_claimed`,
  `usage_error`, or `submit_start_failed` — leaves Stage F not accepted /
  BLOCKED for this acceptance run, with evidence preserved for diagnosis and no
  second live submission;
- the dedicated Telegram account is not the default/general account and
  general/default behavior and routing remain unaffected;
- groups are explicitly disabled; the deployed allowlist/account-scoped approver
  configuration is verified and a non-operator fails closed (a live
  unauthorized-user DM is optional, §4.1);
- the AZ fencing gate passed: the installed runtime proved the explicit
  account-scoped `execApprovals.approvers` (EXACTLY the single frozen operator)
  fences the GLOBAL `commands.ownerAllowFrom` fallback, and unrelated global
  owners are not Form Agent approvers;
- authorization mutation remains exclusively on the trusted non-Telegram
  administrative surface, using the adapter's same config/DB;
- deterministic-only invariants (fail-closed permutations, tampering, crash
  windows, corrupted state, timeout/no-route) are supported by the accepted Phase
  8 implementation plus `verify:phase8`, unless live deployment evidence
  contradicts them;
- no credentials/secrets/personal identifiers were committed or published;
- Phase 8 regression, full regression, typecheck, build, `git diff --check`, and
  `git status --short` are clean;
- `docs/PHASE_9_ACCEPTANCE.md` records only real, sanitized evidence.

The Phase 9 final acceptance report (prepared from operator-observed live results)
must map each requirement:

```text
P9-R1  PASS / FAIL / BLOCKED -> evidence
...
P9-R16 PASS / FAIL / BLOCKED -> evidence
```

and report: targeted/phase-8 regression totals; full regression totals;
typecheck; build; `git status`; known limitations; and any deviations from this
specification.

## 15. Explicit out-of-scope confirmation

For the avoidance of doubt, the non-goals in §1 are the authoritative exclusion
list for Phase 9. Any capability not named in §1 as in scope, and not already
part of the accepted Phase 8 baseline, is out of scope for Phase 9 and requires a
separately reviewed future specification.
