# Phase 5 — Controlled Browser Execution

## Status

**PLANNED — NOT IMPLEMENTED**

Accepted implementation baseline:

`0cda0ff` — `feat: complete phase 4 consistency gate`

Phase 0 through Phase 4 are accepted work.

Do not broadly re-audit or reimplement them.

---

## Objective

Phase 5 adds the first controlled browser execution path.

It takes the already-accepted deterministic analysis/draft/consistency/policy
stack and connects it to a narrowly scoped Playwright execution provider.

The phase must be safe against:

- stale form structure;
- unauthorized network/browser use;
- accidental submission;
- duplicate submission;
- ambiguous submission outcome;
- browser/locator drift;
- policy/rate changes between fill and submit;
- secret leakage;
- process/browser crashes.

Conceptual flow:

```text
run request
   ↓
strict CLI validation
   ↓
canonical target
   ↓
authorization-only preflight
   ↓
open authorized target in isolated Chromium context
   ↓
runtime FormSchema snapshot
   ↓
deterministic DraftBundle
   ↓
ConsistencyReport
   ↓
ExecutionPlan + planId
   ↓
full PolicyEngine gate
   ↓
PREVIEW/PREFLIGHT RETURN
   OR
explicit --submit + --expect-plan + --by
   ↓
fill accepted answered fields
   ↓
verify DOM values
   ↓
runtime fingerprint re-check
   ↓
full PolicyEngine gate again
   ↓
durable submission claim + conservative rate event
   ↓
ONE submit attempt
   ↓
confirmed success | unknown_outcome
   ↓
durable safe execution receipt
```

Phase 5 is not a batch automation phase.

One invocation handles one deterministic response.

---

## Design decisions locked for Phase 5

### Browser technology

Use Playwright with Chromium.

The implementation should use:

- one isolated non-persistent browser context per run;
- one page/session per run;
- finite action/navigation timeouts;
- guaranteed context/browser teardown in `finally`.

Do not reuse persistent cookies or browser profiles.

### Default `run` is preflight-only

Preferred CLI:

```text
form-agent run <target> --seed <seed> [--json]
```

Without `--submit`, `run`:

- may open the authorized target;
- may parse runtime structure;
- may generate the draft;
- may run consistency and policy;
- must NOT fill;
- must NOT click submit;
- returns an `ExecutionPlan` and `planId`.

This makes accidental omission of a safety flag non-destructive.

### Explicit submission

Actual execution requires:

```text
form-agent run <target> \
  --seed <seed> \
  --submit \
  --expect-plan <planId> \
  --by <operator> \
  [--json]
```

`--submit` without `--expect-plan` or `--by` is a usage error before browser
network activity.

The submitted run must recompute the plan from the current runtime form and
require exact `planId` equality before fill.

### Narrow target support

Phase 5 execution supports only:

1. the local execution fixture/harness; and
2. the accepted exact Google Forms responder target shape handled by the
   Google Forms provider.

Do not execute arbitrary HTTP(S) URLs.

Do not follow an unsupported top-level redirect into login/account/consent
workflows.

### Automated acceptance is local-only

CI/tests must not submit to a real Google Form.

All browser E2E tests use the local execution harness.

Live Google Forms execution is a manual operator-run capability only after
Phase 5 acceptance, with explicit allowlisting and `safety.mode=test-only`.

---

# Requirements

## P5-R1 — Preserve accepted Phase 0-4 behavior

Phase 5 must preserve all accepted behavior from Phase 0 through Phase 4.

In particular:

- observed fixture parsing stays unchanged;
- authoritative observed-fixture fingerprint stays unchanged;
- `analyze` remains local/offline;
- `draft` remains local/offline;
- `check` remains local/offline;
- Phase 2 authorization/sensitivity/rate behavior remains authoritative;
- Phase 3 blocked fields still carry no value;
- Phase 4 hard/soft consistency semantics remain unchanged;
- existing exit-code contract remains unchanged;
- migrations 1-6 remain byte-for-byte unchanged.

Authoritative observed fixture fingerprint:

`7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e`

Do not alter accepted earlier behavior just to make execution easier.

---

## P5-R2 — Explicit provider-neutral execution boundary

Introduce a browser execution provider/session boundary.

Exact names may follow repository conventions, but conceptually support:

```ts
interface ExecutionProvider {
  readonly id: string;
  open(target: CanonicalTarget, options: OpenOptions): Promise<ExecutionSession>;
}

interface ExecutionSession {
  snapshot(): Promise<RuntimeFormSnapshot>;
  isAcceptingResponses(): Promise<AcceptingState>;
  fill(...): Promise<void>;
  verifyFilled(...): Promise<void>;
  advanceSection(...): Promise<void>;
  submitOnce(): Promise<SubmitEvidence>;
  close(): Promise<void>;
}
```

The orchestrator owns:

- sequencing;
- policy gates;
- consistency;
- durable run state;
- retry/abort semantics.

The provider owns:

- browser lifecycle/session;
- DOM lookup;
- page navigation;
- fill mechanics;
- provider-specific submission evidence.

The provider must never decide:

- whether target is authorized;
- whether sensitivity policy permits run;
- whether consistency blocks;
- whether rate permits submission.

Do not put policy logic inside Playwright locators.

---

## P5-R3 — Canonical target and authorization before browser/network access

Before any external browser/network activity:

1. validate CLI syntax;
2. canonicalize the target;
3. confirm the target is a supported execution provider/shape;
4. call the accepted authorization-only `run` check.

If authorization is not `authorized`:

- return controlled block;
- do not launch Chromium;
- do not fetch the target.

This pre-network authorization check is not itself permission to submit.

The full PolicyEngine is still required later with the runtime schema.

For live external execution, support only the accepted exact Google Forms
responder hostname/path shape.

No arbitrary-URL browser automation.

---

## P5-R4 — Runtime schema acquisition is authoritative for execution

Once an authorized execution target is opened:

- capture current responder HTML/runtime structural material;
- parse it through accepted structural logic;
- obtain a provider-neutral current `FormSchema`;
- preserve the existing parser/fingerprint contract.

Do not maintain a second structural parser inside the execution provider.

Provider-specific runtime extraction may retrieve page HTML/raw handles, but
normalized structural truth must reuse the accepted parser/domain contract.

If the runtime page cannot be parsed into the accepted schema:

- abort before fill;
- close browser;
- return controlled execution failure.

---

## P5-R5 — Deterministic ExecutionPlan

From the runtime schema, build the accepted deterministic response:

```text
runtime FormSchema
   ↓
generateDraft(seed, current policy rules)
   ↓
runConsistencyGate(schema, bundle)
   ↓
ExecutionPlan
```

Define a provider-neutral `ExecutionPlan`.

At minimum it should expose:

- execution plan version;
- stable `planId`;
- canonical target key/display;
- runtime structural fingerprint;
- draft id;
- consistency report id;
- consistency status/counts;
- provider id/version;
- fillable answered-question count;
- skipped blocked/deferred count;
- whether current full policy would allow execution.

`planId` must be deterministic from safe stable material such as:

- execution-plan version;
- canonical target key;
- runtime schema checksum;
- draft id;
- consistency report id;
- execution provider id/version.

Do not include:

- wall-clock time;
- raw answer values;
- raw profile values;
- policy regex bodies;
- URL query/userinfo secrets.

The plan may present executable synthetic answer values to the operator in
explicit preflight output, but raw values are not plan identity material and
must not be persisted in execution receipts.

---

## P5-R6 — Consistency gate is mandatory

Every run preflight and submit run must evaluate the accepted Phase 4
consistency gate against the current runtime schema/draft.

If:

```text
report.blocking === true
```

then:

- no fill;
- no submit;
- controlled validation block.

Soft WARN remains non-blocking.

Warnings must be visible in:

- human preflight output;
- structured plan output;
- final receipt metadata/counts.

Do not add a flag that ignores hard consistency issues.

---

## P5-R7 — Full PolicyEngine before fill and before submit

After runtime schema/draft/consistency are available, use the full accepted
`PolicyEngine.evaluateRunPolicy(...)`.

Required choke points:

### Choke point A — before fill

Immediately before any field is changed in the browser:

- full policy must be allowed;
- otherwise no fill.

### Choke point B — before submit

After fill verification and runtime fingerprint re-check, immediately before
durable submit claim/click:

- run the full policy again against the current schema and current rate state;
- otherwise no submit.

The second gate is mandatory because authorization/rate state may have changed
while the page was open.

Do not duplicate policy rules in the orchestrator.

Do not treat plan/consistency success as policy permission.

---

## P5-R8 — Explicit operator approval bound to the exact plan

`run` defaults to preflight-only.

Submission mode requires all of:

- `--submit`;
- `--expect-plan <planId>`;
- `--by <operator>`.

Before fill in submit mode:

1. recompute current `ExecutionPlan`;
2. compare the current `planId` with `--expect-plan`;
3. exact mismatch → abort before fill.

Operator identity must be validated as a bounded non-empty audit string.

Do not echo arbitrary oversized/malformed operator input in errors.

This is the Phase 5 CLI-first per-run approval contract.

A broader multi-preview approval workflow remains deferred.

---

## P5-R9 — Fill only accepted `answered` draft values

Build the executable answer set strictly from the accepted `DraftBundle`.

Only:

```text
state === answered
```

may produce a browser value.

Never synthesize/fill a value for:

- `blocked-sensitive`;
- `requires-human-review`;
- `requires-specific-authorization`;
- `unsupported`;
- `validation-error`.

Optional blocked/deferred fields remain blank.

A required non-answered field will already cause consistency BLOCK and must stop
execution before fill.

Never "helpfully" fill a required blocked field.

---

## P5-R10 — Supported browser fill kinds

Phase 5 must safely fill all accepted executable structural kinds:

- `text`;
- `paragraph-text`;
- `single-choice`;
- `multi-choice`;
- `linear-scale`;
- `multiple-choice-grid` with accepted `selectionMode: 'single'`;
- `date`;
- `time`.

Execution support must be based on the actual accepted DOM/harness mapping.

For every fill operation:

- locate the intended question container safely;
- perform the action;
- verify the resulting DOM state matches the intended accepted value.

If an `answered` value cannot be located or verified:

- abort before submit;
- controlled error;
- no silent skip.

### Important grid decision

Earlier architecture notes deferred generic grid/matrix fill.

The accepted repository now has a concrete single-select grid model and the
structural fixture validates it.

Phase 5 may implement only that accepted single-select grid form.

Do NOT implement checkbox-grid behavior.

If safe single-select grid execution requires parser/model changes beyond the
accepted representation, STOP and report the conflict.

---

## P5-R11 — Locator strategy must be resilient and fail closed

Prefer Playwright's user-facing/accessibility locator model:

- `getByRole`;
- `getByLabel`;
- accessible names/text scoped to a validated question container.

Do not identify questions globally by title text alone because duplicate titles
can exist.

Provider mapping should use validated question structure/order/id plus scoped DOM
evidence.

Do not use `force: true` to bypass actionability.

Avoid brittle full-page CSS/XPath selectors.

If a provider-specific selector fallback is unavoidable:

- isolate it in one locator module;
- document why;
- add regression coverage.

Ambiguous locator matches must fail closed.

Do not choose "first match" when multiple candidates cannot be structurally
disambiguated.

---

## P5-R12 — Sequential multi-section navigation only

Phase 5 supports the currently accepted sequential routing model.

For multi-section forms:

- fill current expected section;
- verify filled values;
- activate the expected "Next" control;
- verify progression to the next expected section;
- continue in schema order.

At the final expected section:

- locate the submit control;
- do not click until all pre-submit gates pass.

Unexpected branch/section ordering, hidden conditional content, loop, login
wall, consent wall, or unknown flow:

- abort;
- no submit.

Do not implement conditional-routing inference.

---

## P5-R13 — Accepting-responses gate

The execution provider must expose an explicit accepting state.

At minimum:

```text
accepting
closed
unknown
```

Before fill:

- `closed` → abort;
- `unknown` → fail closed;
- only `accepting` may continue.

Check again at the final pre-submit stage.

Do not attempt to reopen, bypass, or work around a closed form.

Do not bypass sign-in requirements or other access controls.

Local harness tests must include a deterministic closed-form scenario.

---

## P5-R14 — Runtime fingerprint re-check before submit

The execution plan fingerprint is derived from the runtime schema used for the
draft/consistency decision.

After all fills are complete, before submit:

1. reacquire the runtime structural snapshot;
2. parse through accepted structural logic;
3. compute current checksum;
4. require exact equality with the plan fingerprint.

Mismatch:

- abort before submit;
- stable reason/code;
- do not field-level guess;
- do not regenerate answers in place and continue.

If the operator wants to proceed after a form change, they must obtain a new
preflight plan and explicitly approve the new `planId`.

Local harness tests must mutate structure between fill and submit and prove no
submit occurs.

---

## P5-R15 — Submission outcome model and positive confirmation

Define provider-neutral submit evidence/result.

Execution outcome must distinguish at least:

```text
preflight
success
failed_pre_submit
aborted
unknown_outcome
```

`success` requires positive provider-specific confirmation.

Do not call a run successful merely because:

- click did not throw;
- a navigation occurred;
- HTTP status was non-error;
- the browser remained open.

Once submit action has started, any state without positive confirmation is
`unknown_outcome` unless the provider can prove no submission request/action
occurred.

Examples that become `unknown_outcome` after submit intent/action:

- timeout;
- browser disconnect;
- ambiguous navigation;
- unexpected page;
- network interruption;
- process-level uncertainty.

Local execution harness must expose a deterministic success marker and an
ambiguous-outcome scenario.

---

## P5-R16 — Never auto-retry after durable submit intent

Hard safety invariant:

**one submission attempt per approved plan/submission key.**

Once durable submit intent is claimed:

- no automatic retry;
- no retry on timeout;
- no retry on `unknown_outcome`;
- no retry after process/browser restart.

A later invocation with the same claimed submission key must be refused and
surface the prior run/claim as requiring manual reconciliation.

Pre-submit failures where no submit intent was claimed may be retried after the
operator obtains/uses a still-valid plan.

Do not implement a "retry unknown" flag.

---

## P5-R17 — Durable execution receipt and crash-safe submission claim

Phase 5 may append exactly one new migration:

**migration 7**

Purpose:

- durable execution receipt metadata;
- explicit operator approval audit;
- crash-safe submit-intent claim;
- duplicate-submit prevention.

Migrations 1-6 must not change.

The logical receipt contract must represent at least:

- unique run id;
- stable submission key;
- sanitized target key/display;
- plan id;
- draft id;
- consistency report id;
- structural fingerprint;
- execution provider id/version;
- operator identity;
- approval timestamp;
- state;
- whether submit intent was claimed;
- final outcome;
- stable outcome/error code;
- created/updated timestamps.

Receipt must NOT persist:

- raw answers;
- profile values;
- blocked sensitive values;
- full page HTML;
- browser cookies/storage;
- credentials/tokens;
- raw exception strings;
- URL query/userinfo secrets;
- custom sensitive-policy regex bodies.

### Submission key

Define a stable safe `submissionKey`, conceptually from:

```text
canonical target key
+ planId
```

or an equivalent safe deterministic contract.

### Atomic claim

Immediately before the one submit action:

- atomically mark/claim this submission key as submit-attempted;
- persist state equivalent to `submitting`;
- only after successful durable claim may the provider click submit.

A second claim for the same submission key must fail.

A process crash after the claim but before final receipt resolution leaves a
durable unresolved attempt.

Future run must treat that as unresolved/unknown and refuse automatic resubmit.

A single receipt table plus a partial unique index/transaction is acceptable if
it meets the invariant.

Do not add a broad Phase 7 metrics/batch schema.

If one migration cannot express the minimal contract safely, STOP and report
before adding migration 8.

---

## P5-R18 — Rate-state integration is conservative

Phase 5 must consume the accepted Phase 2 rate gate.

It must not sleep to wait out a gate.

When rate policy blocks:

- surface accepted reason codes;
- surface deterministic retry-after when available;
- exit without fill/submit as appropriate.

A submission rate event must be recorded conservatively when durable submit
intent is claimed, before the provider action.

Therefore:

- confirmed success counts;
- `unknown_outcome` counts;
- crash after submit claim counts;
- pre-submit abort with no claim does not count as submission.

If accepted `RateStore` batch-start/end APIs exist, use them consistently.

If minimal additive methods are needed to record already-modeled Phase 2 event
types, keep them thin and do not change accepted rate evaluation semantics.

Do not apply configured jitter/random pacing.

---

## P5-R19 — Browser lifecycle, timeouts, cleanup, and network safety

Every browser execution must have bounded lifecycle.

Requirements:

- finite navigation timeout;
- finite action timeout;
- no unbounded wait;
- no arbitrary `waitForTimeout` sleeps as synchronization;
- close page/context/browser in `finally`;
- cleanup runs on policy block, consistency block, locator error, timeout,
  fingerprint mismatch, success, and unknown outcome.

Use isolated non-persistent browser context.

Do not persist cookies/storage state.

Do not automatically download files.

No file-upload capability.

### Automated-test network rule

Phase 5 automated browser tests must run against local loopback execution
harness only.

Tests should abort unexpected external requests so accidental internet access
fails loudly.

No automated test submits to Google.

---

## P5-R20 — `run` CLI, safe output, explicit side-effect semantics

Implement:

```text
form-agent run <target> --seed <seed> [--json]
```

as preflight-only.

Implement actual submit mode:

```text
form-agent run <target> \
  --seed <seed> \
  --submit \
  --expect-plan <planId> \
  --by <operator> \
  [--json]
```

Strict parsing rules:

- one target only;
- explicit non-empty seed;
- unknown flags rejected;
- unknown flags do not echo raw content;
- `--submit` requires `--expect-plan`;
- `--submit` requires `--by`;
- `--expect-plan` without valid id rejected;
- extra positionals rejected.

### Preflight human output

At minimum:

- sanitized target;
- runtime form identity/title;
- fingerprint;
- draft id;
- consistency report id/status;
- plan id;
- policy allowed/blocked + stable reasons;
- fillable count;
- blocked/skipped count;
- explicit `NO FILL OR SUBMISSION OCCURRED`.

Preflight may show the actual executable synthetic answer preview because this is
the explicit operator review step.

Never show values for blocked/deferred fields.

### Preflight JSON

May include:

- safe plan/provenance;
- executable `answered` values for explicit review;
- consistency report;
- policy summary.

Must exclude blocked sensitive values.

### Submit-mode output

At minimum:

- run id;
- plan id;
- sanitized target;
- fingerprint;
- receipt state/outcome;
- submit-attempted boolean;
- stable outcome/reason code;
- consistency warning counts;
- policy reason summary;
- explicit confirmation status.

Do not print all answer values again in final receipt output.

### Exit-code mapping

Reuse accepted codes.

Recommended mapping:

- successful preflight → `0`;
- confirmed submission success → `0`;
- usage/config → `2`;
- policy/consistency/plan/fingerprint validation block → `3`;
- pre-submit execution/browser failure → `1`;
- `unknown_outcome` → `1` while structured receipt carries the precise state;
- LLM codes remain unused by Phase 5.

Do not invent a new exit code.

---

# Additional execution contracts

## Runtime question mapping

The browser provider must build a runtime mapping from accepted schema questions
to DOM question containers.

Mapping must tolerate duplicate question titles.

Use:

- provider structural ids when available;
- accepted question order;
- section scope;
- accessible labels/roles;
- validated container structure.

Do not globally locate a question only by displayed title.

---

## DOM fill verification

After every field is filled, verify the actual browser state.

Examples:

### text / paragraph

Read the control value and require equality with accepted value.

### single-choice

Require exactly the intended choice selected.

### multi-choice

Require selected set equality.

### linear-scale

Require intended scale option selected.

### single-select grid

For every intended row:

- locate the actual row;
- require exactly the intended column selected.

### date/time

Require accepted component/control state to match the intended representation.

Verification failure aborts before submit.

Do not use a successful Playwright action call as the only proof that fill is
correct.

---

## Form-flow fail-closed behavior

Abort before submit on:

- unknown section;
- unexpected extra required question;
- missing expected question;
- unexpected page branch;
- login requirement;
- CAPTCHA;
- consent interstitial not part of accepted form;
- form closed;
- locator ambiguity;
- runtime parser mismatch;
- structural fingerprint change.

Do not add bypass/evasion logic.

---

## Preflight-plan approval semantics

The preflight plan is deterministic.

The operator approval is bound to `planId`.

Actual submit recomputes the plan before fill.

This closes the "review one response, submit a changed one" gap for:

- seed changes;
- schema changes;
- draft changes;
- consistency changes;
- provider contract changes.

Rate/authorization are deliberately NOT frozen into the plan.

They are live gates and must be re-evaluated at execution time.

---

## Execution receipt state machine

Exact names may follow conventions, but preserve equivalent semantics:

```text
created / approved
       ↓
filled
       ↓
submitting   ← durable submit claim exists
   ├──────────────→ success
   └──────────────→ unknown_outcome

pre-submit branches:
created/approved → aborted
created/approved → failed_pre_submit
filled           → aborted
filled           → failed_pre_submit
```

Once state reaches `submitting`, never transition back to a state that permits
automatic resubmission.

On process restart, an unresolved persisted `submitting` claim is treated
conservatively as unresolved/unknown for duplicate prevention.

---

## Provider submit evidence

Provider `submitOnce()` should return structured evidence, not a raw boolean.

Conceptually:

```ts
type SubmitEvidence =
  | {
      state: 'confirmed';
      confirmationCode: string;
    }
  | {
      state: 'ambiguous';
      reasonCode: string;
    };
```

Do not return raw HTML/error strings in the domain receipt.

Provider may log only redacted/stable diagnostic metadata.

---

## Live Google Forms constraints

Phase 5 may support manual live execution only when all gates pass.

Do not support:

- forms requiring login;
- forms requiring account switching;
- CAPTCHA/anti-bot challenge bypass;
- file uploads;
- unsupported conditional routing;
- arbitrary non-Google targets;
- shortened redirect target forms unless canonicalization explicitly supports
  them in accepted code.

If the top-level browser state leaves the supported execution flow, abort.

---

## Local execution fixture/harness

Create a separate deterministic execution fixture/harness.

Do NOT repurpose the observed sensitive fixture by weakening policy.

The local execution harness should exercise all accepted execution kinds with
non-sensitive question labels.

It should provide deterministic switches/scenarios for:

1. normal confirmed submit;
2. form closed before fill;
3. structural mutation before submit;
4. ambiguous post-submit outcome;
5. fill/locator failure.

The harness should expose explicit test-only markers for:

- current section;
- accepting state;
- confirmed submission;
- structural version.

Provider code should not rely on those test-only markers for live Google
execution except through a separate fixture provider/harness adapter.

---

## Playwright implementation guidance

Use the Playwright library without replacing the existing Vitest test runner
unless repository evidence strongly requires otherwise.

Prefer accessibility/user-facing locators.

Use Playwright auto-wait/actionability.

Avoid force-clicks and arbitrary sleeps.

Use an isolated `BrowserContext`.

Close the context before closing the browser.

Set explicit finite defaults for:

- navigation timeout;
- action timeout.

Keep browser-specific code out of pure domain/policy/draft/consistency modules.

---

## Configuration

Reuse the existing configuration system.

Minimal Phase 5 additive browser config may include:

- browser headless boolean;
- browser navigation timeout ms;
- browser action timeout ms;
- executable path only if environment genuinely requires it.

Defaults should be conservative.

Do not add randomized delay/jitter execution behavior.

Do not create a second config system.

---

## Database / migration 7

Phase 5 may add one append-only migration 7.

Migration 7 must be minimal and focused on execution receipt/submission claim.

Do not add:

- metrics_events redesign;
- preview batches;
- large workflow history schema;
- LLM usage changes.

Do not modify migrations 1-6.

Migration tests must cover:

- fresh DB upgrade;
- reopen/idempotence;
- existing Phase 1-6 data preserved;
- receipt insert/update;
- duplicate submission claim rejected;
- pre-submit non-attempt receipt does not block a future valid claim;
- unresolved submit claim survives reopen.

---

## Error and secret safety

Create controlled execution errors with stable codes/messages.

Do not expose:

- raw Playwright stack in normal CLI output;
- raw page HTML;
- browser cookies;
- raw response bodies;
- arbitrary locator text containing secrets;
- raw submitted values in error messages;
- URL query/userinfo;
- custom policy regex bodies.

Use sentinel tests such as:

```text
VERY_SECRET_BROWSER_VALUE
token=VERY_SECRET_TOKEN
```

Prove they do not appear in:

- normal errors;
- receipt storage;
- receipt human output;
- submit-mode JSON result;
- logs captured by tests.

Explicit preflight answer preview is the only Phase 5 CLI surface allowed to
show eligible synthetic answer values.

Blocked/deferred values must never exist/show.

---

# Explicit out-of-scope boundary

Phase 5 must NOT implement:

- real LLM calls;
- local model calls;
- automatic semantic repair;
- automatic consistency repair;
- batch generation;
- batch submission;
- scheduler;
- cron;
- queue worker;
- random delays;
- human-like pacing;
- stealth behavior;
- CAPTCHA solving;
- sign-in automation;
- persistent browser profiles;
- upload execution;
- checkbox-grid;
- conditional routing inference;
- rating/dropdown parser expansion solely for execution;
- Microsoft Forms;
- Google Forms API submission;
- metrics export;
- OpenClaw;
- Telegram;
- Phase 6 provider wiring.

Do not begin Phase 6 automatically.

---

# Expected architecture

Exact files may follow repository conventions.

A reasonable conceptual separation is:

```text
src/domain/execution.ts

src/execution/
    plan.ts
    orchestrate.ts
    receipt.ts
    errors.ts
    format.ts

src/providers/
    execution.ts
    google-forms/
        browser.ts
        session.ts
        locators.ts
        fill.ts
        submit.ts
    fixture/
        execution-harness.ts

src/cli/run.ts
```

Do not force this exact tree if accepted repository structure suggests a cleaner
equivalent.

Keep provider-specific Playwright code isolated.

---

# Recommended stable execution codes

Exact strings may follow repository conventions, but machine-readable codes must
be stable and tested.

Suggested pre-submit codes:

```text
EXECUTION_TARGET_UNSUPPORTED
EXECUTION_NOT_AUTHORIZED
FORM_NOT_ACCEPTING_RESPONSES
RUNTIME_SCHEMA_PARSE_FAILED
CONSISTENCY_BLOCKED
EXECUTION_POLICY_BLOCKED
EXECUTION_PLAN_MISMATCH
EXECUTION_KIND_UNSUPPORTED
EXECUTION_LOCATOR_AMBIGUOUS
EXECUTION_LOCATOR_NOT_FOUND
EXECUTION_FILL_VERIFICATION_FAILED
EXECUTION_FLOW_UNEXPECTED
FORM_CHANGED_BEFORE_SUBMIT
SUBMISSION_ALREADY_CLAIMED
```

Suggested terminal outcome codes:

```text
SUBMISSION_CONFIRMED
SUBMISSION_OUTCOME_UNKNOWN
```

Do not embed raw values in codes.

---

# Tests

Exact file names may follow repository conventions.

A reasonable organization:

```text
tests/phase5-plan.test.ts
tests/phase5-policy.test.ts
tests/phase5-fill.test.ts
tests/phase5-flow.test.ts
tests/phase5-submit.test.ts
tests/phase5-receipt.test.ts
tests/phase5-cli.test.ts
tests/phase5-no-evasion.test.ts
tests/phase5-browser-e2e.test.ts
```

Use synthetic/unit data for narrow rules.

Use a local HTTP execution harness for browser E2E.

No automated external Google Forms access.

---

# Required Phase 5 acceptance coverage

Phase 5 acceptance must prove all of the following:

### Regression / baseline

- Phase 0-4 full regression passes;
- observed fixture fingerprint unchanged;
- migrations 1-6 unchanged;
- only migration 7 appended if needed.

### Browser/network authorization

- malformed CLI fails before browser;
- unsupported target fails before browser;
- unallowlisted target fails before browser/network;
- authorized target may open browser;
- `analyze`/`draft`/`check` still do not fetch live URLs.

### Plan

- runtime schema uses accepted structural parser;
- same target/schema/seed/provider contract → same planId;
- different fingerprint/draft/report/provider contract changes planId;
- planId excludes wall-clock/rate/raw answer material;
- preflight performs no fill and no submit;
- preflight output may show only eligible synthetic answered values;
- blocked/deferred fields expose no value.

### Consistency / policy

- consistency BLOCK prevents fill;
- consistency WARN remains visible and non-blocking;
- full PolicyEngine block prevents fill;
- policy is evaluated again pre-submit;
- a policy/rate change between fill and submit prevents submit.

### Fill

- text fill + verification;
- paragraph fill + verification;
- single-choice fill + verification;
- multi-choice fill + verification;
- linear-scale fill + verification;
- accepted single-select grid fill + row/column verification;
- date fill + verification;
- time fill + verification;
- locator ambiguity aborts;
- answered field cannot be silently skipped.

### Flow

- sequential multi-section navigation succeeds in harness;
- unexpected branch/order aborts;
- closed form aborts;
- unknown accepting state fails closed.

### Approval

- run without `--submit` never fills/submits;
- `--submit` without `--expect-plan` fails before browser;
- `--submit` without `--by` fails before browser;
- wrong planId aborts before fill;
- matching planId permits progression subject to live gates.

### Fingerprint

- structural change between preflight/fill and submit is detected;
- fingerprint mismatch prevents submit;
- no in-place regeneration/continue after mismatch.

### Submission outcome

- confirmed harness submission → success;
- positive confirmation required for success;
- ambiguous post-submit scenario → `unknown_outcome`;
- unknown outcome exits nonzero;
- no automatic retry occurs.

### Durable claim / receipt

- submission claim persisted before click;
- duplicate claim for same submission key rejected;
- success blocks same-key automatic resubmit;
- unknown outcome blocks same-key automatic resubmit;
- unresolved `submitting` state survives DB reopen and blocks same-key resubmit;
- pre-submit abort with `submit_attempted=false` does not falsely claim a
  submission;
- receipt contains no answer/profile/secret sentinel values.

### Rate

- submission event recorded at durable claim;
- unknown/crash claim counts conservatively;
- pre-submit abort does not record submission;
- rate block surfaces stable reasons/retry-after;
- no automatic sleep/jitter.

### Lifecycle

- browser context closed on success;
- browser context closed on pre-submit error;
- browser context closed on unknown outcome;
- test harness external network attempts are blocked;
- no force-click/random pacing/evasion code.

### CLI

- preflight human output safe;
- preflight JSON structured;
- confirmed submit human output safe;
- confirmed submit JSON structured;
- unknown flag non-echoing;
- secret sentinels absent from normal errors/final receipt;
- accepted exit-code mapping preserved.

---

# Recommended implementation milestones

Map every P5 requirement into 7-9 native TODO milestones.

A reasonable grouping:

1. **M1 — execution domain + plan/provider boundary**
   - P5-R1, R2, R4, R5

2. **M2 — target authorization + browser lifecycle**
   - P5-R3, R19

3. **M3 — filler + locator + sequential flow**
   - P5-R9, R10, R11, R12, R13

4. **M4 — consistency/policy/fingerprint gates**
   - P5-R6, R7, R14

5. **M5 — approval + submit outcome**
   - P5-R8, R15, R16

6. **M6 — migration 7 + receipt + rate integration**
   - P5-R17, R18

7. **M7 — run CLI**
   - P5-R20

8. **M8 — browser harness + acceptance coverage**
   - all P5 requirements / final acceptance

Keep exactly one meaningful milestone `in_progress`.

---

# Implementation workflow

Before implementation:

1. Read `AGENTS.md`.
2. Read `AGENT_HANDOFF.md`.
3. Read this specification.
4. Confirm accepted implementation baseline `0cda0ff`.
5. Confirm this spec is protected from worker edits.
6. Inspect only directly required accepted interfaces:
   - `src/domain/types.ts`;
   - `src/domain/draft.ts`;
   - `src/domain/consistency.ts`;
   - draft orchestrator/reference provider;
   - consistency gate/rules;
   - policy engine/auth/rate store;
   - target canonicalization;
   - DB/migration conventions;
   - CLI dispatcher/exit handling;
   - existing fixture/harness utilities;
   - package/dependency state.
7. Inspect existing provider abstractions before creating a new provider stack.
8. Create native TODO mapping P5-R1 through P5-R20.
9. Do not wait for confirmation after TODO creation.

---

# Testing workflow

During implementation:

- use targeted tests;
- run the local browser harness only;
- do not repeatedly run the full regression suite;
- do not access real Google Forms;
- do not weaken policy to make a test green.

If the observed fixture is blocked by `SENSITIVE_FIELD_NEVER`, that is expected.

Use the separate execution harness.

If the same blocker remains after three genuinely different attempted
solutions:

- STOP;
- report `BLOCKED`;
- list evidence;
- list distinct attempts;
- preserve working tree.

---

# Browser dependency/setup workflow

Inspect the current package before deciding dependency placement.

Phase 5 needs Playwright/Chromium available to both the runtime CLI and browser
E2E tests.

Prefer the smallest reproducible repository change.

Do not migrate existing Vitest tests to a new test runner merely because
Playwright is introduced.

The Phase 5 final report must state:

- package(s) added;
- Playwright version;
- how Chromium is provisioned in the dev environment;
- exact browser version used in acceptance.

If browser installation/provisioning requires a devcontainer change, keep it
minimal and explain it.

---

# Final verification

Before Phase 5 acceptance:

```bash
npm run verify:phase5
npm test
npm run typecheck
npm run build
```

Run local-only browser smoke tests against the execution harness.

At minimum smoke:

1. preflight plan, no fill/submit;
2. approved confirmed submission;
3. closed form;
4. fingerprint changed before submit;
5. ambiguous submit → unknown outcome;
6. duplicate same-plan submit refused;
7. secret-bearing unknown CLI flag does not echo secret.

Then:

```bash
git diff --check
git diff --stat
git status --short
```

Confirm:

- observed fixture fingerprint unchanged;
- migrations 1-6 unchanged;
- migration 7 only if implemented as specified;
- no external Google request in automated tests;
- no LLM;
- no OpenClaw/Telegram;
- no batch/scheduler/evasion.

---

# Final acceptance report

The Phase 5 worker must map every requirement individually:

```text
P5-R1  PASS / FAIL
P5-R2  PASS / FAIL
...
P5-R20 PASS / FAIL
```

For each requirement include:

- implementation evidence;
- test evidence.

Also report:

- final TODO state;
- files added;
- files modified;
- Playwright package/version;
- Chromium provisioning/version;
- execution-plan version;
- execution-provider id/version;
- stable execution codes;
- migration added;
- receipt schema/claim invariant;
- targeted `verify:phase5` totals;
- full regression totals;
- typecheck result;
- build result;
- local browser E2E totals;
- preflight smoke result;
- confirmed-submit smoke result;
- closed-form smoke result;
- fingerprint-change smoke result;
- unknown-outcome smoke result;
- duplicate-claim smoke result;
- secret-sentinel smoke result;
- observed fixture fingerprint;
- migrations 1-6 status;
- known limitations;
- deferred features;
- deviations from this specification;
- final `git status --short`.

Do NOT commit.

Do NOT push.

Do NOT begin Phase 6.

STOP after the Phase 5 acceptance report.
