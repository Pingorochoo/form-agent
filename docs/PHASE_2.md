# Phase 2 — Policy and Authorization

Status: NOT STARTED

Accepted baseline:
- Phase 0: `63b2c3e`
- Phase 1: `309f097`

Phase 1 is accepted and MUST NOT be broadly re-audited or reimplemented.
Inspect accepted code only when Phase 2 directly depends on an interface,
a relevant regression fails, or repository evidence contradicts a documented
contract.

---

## 1. Objective

Phase 2 adds the safety and authorization layer that all later execution
features must pass through.

This phase implements:

1. durable form authorization / allowlisting;
2. deterministic sensitive-field classification;
3. configurable sensitive-field policy overrides;
4. a central `PolicyEngine`;
5. safety-mode gating;
6. deterministic rate gating and durable rate state;
7. human- and machine-readable policy decisions;
8. CLI support for authorization management and policy visibility.

Phase 2 MUST remain deterministic and local.

No answer generation, semantic respondent profiles, browser automation,
network form fetching, form submission, LLM inference, OpenClaw, or Telegram
is implemented in this phase.

---

## 2. Safety model

The system is deny-by-default for execution.

Structural analysis may remain available for local/authorized fixtures even
when a form is not authorized for execution.

A future execution path must not be able to bypass the PolicyEngine.

Phase 2 does NOT implement that execution path. It only creates and tests
the policy gates that later phases will consume.

Important distinction:

- `analyze` is inspection only.
- authorization grants permission to a future execution path;
- authorization itself does not execute anything;
- rate policy only returns decisions/retry information;
- rate policy does not sleep, schedule, pace, submit, or automate requests.

---

## 3. Non-goals

The following are explicitly OUT OF SCOPE:

- respondent/profile generation;
- semantic whole-form analysis;
- answer generation;
- answer consistency validation;
- preview generation or approval workflows;
- Playwright/browser execution;
- HTTP fetching of live Google Forms;
- form submission;
- anti-detection or evasion behavior;
- randomized "human-like" behavior;
- conditional-routing implementation;
- checkbox-grid support beyond the accepted Phase 1 behavior;
- file-upload implementation;
- real LLM provider wiring;
- OpenClaw integration;
- Telegram integration;
- automatic transition to Phase 3.

Do not implement these even if they appear easy.

---

# 4. Requirements

## P2-R1 — Preserve accepted Phase 1 behavior

All accepted Phase 1 parser, schema, cache, fingerprint, CLI, fixture,
and safety behavior must continue to pass.

Phase 2 must not change the structural fingerprint of the accepted fixture
unless the Phase 2 specification explicitly requires a structural schema
change.

Prefer policy metadata outside the structural fingerprint.

---

## P2-R2 — Canonical authorization target identity

Authorization must use a deterministic target identity.

Target canonicalization must:

- require no network access;
- remove irrelevant query strings and fragments;
- normalize recognized fixture identifiers;
- normalize recognized Google Forms responder URLs when possible;
- preserve enough information for human-readable audit output;
- map semantically equivalent supported target strings to the same key.

Do not fetch the target while canonicalizing it.

Expose target canonicalization as a testable pure function.

---

## P2-R3 — Durable authorization records

Authorization state must be persisted in SQLite.

At minimum an authorization record must preserve:

- canonical target key;
- human-readable target;
- scope;
- operator / `--by` value;
- creation timestamp;
- revocation state or revocation timestamp.

Authorization history must be auditable.

Revocation should not silently erase historical authorization records.

Reuse existing Phase 0 database structures when they satisfy the contract.

If no existing structure can satisfy the requirement, add only the minimal
migration required by Phase 2 and test it.

---

## P2-R4 — `auth allow`

Implement:

    form-agent auth allow <url-or-target> --scope run --by <operator>

Phase 2 supports the `run` authorization scope.

The command:

- canonicalizes the target locally;
- persists authorization;
- requires a non-empty operator;
- requires the supported scope;
- performs no network request;
- performs no form execution;
- is idempotent for an already-active equivalent authorization.

A repeated allow must not create uncontrolled duplicate active records.

---

## P2-R5 — authorization inspection and revocation

Provide deterministic CLI operations for:

    form-agent auth check <url-or-target>
    form-agent auth list
    form-agent auth revoke <url-or-target> --scope run

Exact internal implementation is flexible, but behavior must be tested.

`check` must distinguish at least:

- authorized for requested scope;
- not allowlisted;
- authorization revoked;
- requested scope unavailable.

`list` must never expose secrets.

Machine-readable output may be provided using the repository's existing
CLI conventions. Do not add an unnecessary new formatting framework.

---

## P2-R6 — deny by default

Absence of an active matching authorization must produce a denied execution
policy decision.

There must be no implicit authorization based on:

- fixture presence;
- successful parsing;
- local file location;
- previous analysis;
- cached schemas;
- form ownership assumptions.

Analysis alone never grants execution permission.

---

## P2-R7 — static sensitive-field taxonomy

Implement deterministic sensitive-field classification.

The built-in taxonomy must be able to identify prompts involving at least:

- personal names;
- personal email addresses;
- phone numbers;
- physical addresses;
- government / national identifiers;
- employee identifiers;
- passport identifiers;
- banking or payment-card information;
- passwords, access tokens, credentials, or secrets;
- health / medical information;
- uploads / file attachments.

Classification is based on schema metadata such as question title,
title thread, and other already-normalized structural labels.

There are no answer values in Phase 2.

Do not use an LLM.

---

## P2-R8 — configurable sensitivity rules

Support user-configurable sensitivity pattern overrides using the existing
configuration conventions and `config/policies.d/`.

Requirements:

- deterministic loading;
- deterministic precedence;
- invalid policy files fail clearly rather than being silently ignored;
- custom regex/pattern rules must be validated before use;
- configuration must be testable with temporary policy files;
- do not add a new configuration language if existing config infrastructure
  already supports the requirement.

A custom rule must be able to specify:

- stable rule id;
- match pattern;
- sensitivity category;
- policy mode.

Do not embed form-specific production rules into source code merely to make
the fixture pass.

---

## P2-R9 — forced sensitive pre-scan

Sensitive classification must happen before an execution policy could be
considered allowed.

The PolicyEngine must not rely on callers remembering to classify fields
first.

Policy evaluation must perform or require a validated pre-scan as part of
its own deterministic flow.

---

## P2-R10 — sensitive policy modes

Support the following policy modes:

- `never`
- `synthetic-allowed`
- `human-reviewed`
- `specific-authorization`

`never` is the restrictive default for a sensitive field unless an accepted
configuration explicitly selects another mode.

When more than one matching rule applies, the most restrictive result wins.

Restriction precedence:

    never
    > specific-authorization
    > human-reviewed
    > synthetic-allowed

Phase 2 does not implement profile generation, human-review workflows, or
specific-authorization workflows.

It only returns the correct policy requirement/decision for future phases.

---

## P2-R11 — file upload policy

File-upload fields are always sensitive.

The MVP policy for file upload is always:

    never

Phase 2 does not implement upload capability.

The existing deferred Google Forms file-upload structure may remain
`unsupported`; the sensitive classifier may use its normalized/raw type hint
to recognize it.

No upload code may be introduced.

---

## P2-R12 — central PolicyEngine

Implement one central policy evaluation layer.

Suggested location:

    src/policy/policyEngine.ts

Supporting modules may include:

    src/policy/authz.ts
    src/policy/sensitive.ts
    src/policy/rate.ts

Use existing repository naming conventions if they provide a clearer fit.

The PolicyEngine must return structured decisions rather than relying only
on log text or thrown strings.

At minimum a policy result must make it possible to determine:

- allowed / denied;
- authorization state;
- sensitive-field decisions;
- safety-mode result;
- rate-gate result where applicable;
- stable reason code(s).

Future phases must be able to consume this API without duplicating policy
logic.

---

## P2-R13 — stable policy reason codes

Policy failures must expose stable machine-readable reason codes.

At minimum cover equivalent reasons for:

- target not allowlisted;
- required authorization scope missing;
- authorization revoked;
- sensitive field blocked by `never`;
- human review required;
- specific authorization required;
- safety mode not eligible;
- minimum-delay rate gate;
- hourly rate cap;
- daily rate cap;
- batch pause;
- concurrent-batch cap.

Exact enum spelling may follow repository conventions, but tests must use
the stable codes rather than parsing human-readable prose.

Human-readable explanations should accompany the codes.

---

## P2-R14 — future-run authorization gate

Expose a pure/testable policy path representing whether a future `run`
operation is authorized.

It must deny an unallowlisted target.

It must NOT implement `run`.

It must NOT submit a form.

It must NOT launch Playwright.

It must NOT fetch the form.

Tests call the policy API directly.

The existing `run` command remains unimplemented.

---

## P2-R15 — safety mode gate

A future execution policy may only be eligible when:

    safety.mode == test-only

Phase 2 must expose and test this gate.

Do not silently change an existing safety-mode default merely to make tests
pass.

Tests should explicitly configure both an allowed and a denied value.

This requirement does not create execution capability.

---

## P2-R16 — rate-policy configuration

Phase 2 implements deterministic rate-limit policy.

Existing/planned configuration includes:

    rate.delayBetweenSubmissionsMs
    rate.maxSubmissionsPerFormPerHour
    rate.maxSubmissionsPerFormPerDay
    rate.batchPauseSeconds
    rate.maxConcurrentBatches
    rate.jitterFactor

Known defaults that must be preserved where applicable:

    rate.delayBetweenSubmissionsMs = 30000
    rate.maxConcurrentBatches = 1
    rate.jitterFactor = 0

Do not invent new production defaults for rate values whose defaults are not
already defined by repository/config evidence.

Tests may supply explicit values.

Rate configuration must reject invalid negative limits/durations and invalid
concurrency.

`jitterFactor` is configuration only in Phase 2. No random pacing or sleep
behavior is implemented.

---

## P2-R17 — deterministic rate gate and durable state

Implement a deterministic rate gate suitable for later execution.

The gate must be able to evaluate:

- delay since previous accepted action;
- per-form hourly cap;
- per-form daily cap;
- required pause between batches;
- concurrent-batch cap.

The decision must be based on an injected/current timestamp so tests do not
depend on wall-clock sleeps.

A denied time-based decision should expose a deterministic retry-after value
when meaningful.

Rate state required for these checks must survive process restarts through
SQLite.

If existing database tables are sufficient, reuse them.

Otherwise add only the minimal migration necessary.

Phase 2 may expose store methods used only by tests/future phases.

It must not create an executor, worker loop, scheduler, or submission path.

---

## P2-R18 — analysis remains read-only and policy-aware

`form-agent analyze` must remain offline and read-only.

Phase 2 may extend its summary to report policy information such as:

- authorization state;
- number/categories of sensitive fields;
- execution eligibility summary.

It must never imply that successful analysis means authorization.

For an unallowlisted target, human-readable output must make clear that it
is NOT AUTHORIZED for submission/execution.

No raw payload or answer values may be dumped.

Existing Phase 1 analyze exit-code behavior must remain compatible unless
this specification explicitly requires otherwise.

---

## P2-R19 — logging and secret safety

Policy and authorization logs must not include:

- answer values;
- passwords;
- access tokens;
- API keys;
- raw sensitive values.

Authorization audit output may contain the operator name, canonical target,
scope, timestamps, reason codes, and policy metadata.

Existing repository redaction utilities should be reused where appropriate.

Do not weaken existing redaction behavior.

---

## P2-R20 — no execution or future-phase scope creep

At the end of Phase 2:

- `preview` remains unimplemented;
- `plan` remains unimplemented unless it was already accepted scaffolding;
- `run` remains unimplemented;
- no Playwright execution exists;
- no network fetch exists in Phase 2 modules;
- no form submission exists;
- no respondent/profile generation exists;
- no answer-generation logic exists;
- no consistency engine exists;
- no real LLM provider is invoked;
- no OpenClaw code is added;
- no Telegram code is added.

Add regression guards analogous to the accepted Phase 1 safety tests.

---

# 5. Sensitive classification model

A sensitive assessment should remain separate from structural parsing when
possible.

Do not mutate Phase 1 parser behavior merely to classify sensitivity.

A useful conceptual result is:

    questionId
    sensitive: boolean
    categories: [...]
    mode
    matchedRuleIds: [...]
    reason

Exact TypeScript type naming may follow repository conventions.

Classification must be deterministic.

A question matching multiple categories retains all relevant categories,
while effective mode follows the most-restrictive-mode rule.

---

# 6. Authorization semantics

Authorization is explicit.

Supported execution scope in this phase:

    run

`analyze` does not require `run` authorization because it remains local,
read-only inspection.

An active authorization means only:

    "this target is allowlisted for the future run scope"

It does NOT mean:

- sensitive fields may automatically be answered;
- human review has occurred;
- a preview is approved;
- a fingerprint is approved;
- rate limits are satisfied;
- execution may bypass PolicyEngine.

Those additional gates belong to their respective current/future phases.

---

# 7. Rate semantics

Rate controls are safety limits, not anti-detection features.

The Phase 2 rate layer:

- evaluates policy;
- stores durable counters/state;
- reports allow/deny;
- reports reason codes;
- reports retry-after where deterministic.

It does not:

- sleep;
- insert random waits;
- imitate human behavior;
- evade platform controls;
- schedule submissions;
- execute batches.

---

# 8. Expected source layout

Prefer the existing architecture and conventions.

Expected additions may include:

    src/policy/authz.ts
    src/policy/sensitive.ts
    src/policy/policyEngine.ts
    src/policy/rate.ts

Possible persistence additions should live with existing DB/repository code.

Do not create abstraction layers merely to match these filenames if the
existing repository already has the right abstraction.

---

# 9. Expected tests

Create focused Phase 2 tests, for example:

    tests/phase2-auth.test.ts
    tests/phase2-sensitive.test.ts
    tests/phase2-policy.test.ts
    tests/phase2-rate.test.ts
    tests/phase2-cli.test.ts
    tests/phase2-no-submit.test.ts

Exact grouping is flexible.

Tests must include negative/edge cases, not only happy paths.

Required coverage includes:

- equivalent targets canonicalize identically;
- invalid targets fail predictably;
- allow/check/list/revoke persistence;
- authorization survives DB reopen;
- revoked authorization denies;
- unallowlisted future-run policy denies;
- static sensitive taxonomy;
- custom policy pattern;
- invalid custom pattern/config failure;
- multiple sensitive rules use most restrictive mode;
- file upload => sensitive + never;
- safety.mode gate;
- delay rate gate;
- hourly cap;
- daily cap;
- batch pause;
- concurrent batch cap;
- durable rate state after DB reopen;
- stable reason codes;
- analyze remains read-only;
- preview/run remain unimplemented;
- no network/browser/submission/LLM/profile/answer-generation scope creep.

Use synthetic schemas for taxonomy/rate/policy edge cases.

Use the accepted sanitized fixture only for regression/integration coverage.

Do not contact the external Google Form.

---

# 10. Verification commands

During implementation use targeted tests.

Final acceptance must run:

    npm run verify:phase2
    npm test
    npm run typecheck
    npm run build

Also run CLI smoke tests for:

    form-agent analyze <sanitized local fixture>
    form-agent auth allow ...
    form-agent auth check ...
    form-agent auth list
    form-agent auth revoke ...

All smoke tests must use local fixture/test targets only.

No external Google Form access.

Run:

    git diff --check
    git diff --stat
    git status --short

---

# 11. Acceptance report

The final Phase 2 report must map every requirement:

    P2-R1 through P2-R20

to:

    PASS / FAIL
    implementation evidence
    test evidence

The report must also include:

- final TODO state;
- files added/modified;
- migrations added or explicitly "none";
- targeted test result;
- full regression result;
- typecheck result;
- build result;
- CLI smoke results;
- known limitations;
- deferred features;
- deviations from this spec;
- final `git status --short`.

Do not commit.

Stop after the Phase 2 report.

Do not begin Phase 3.

---

# 12. Phase 2 exit criteria

Phase 2 is acceptable only when all of the following are true:

1. authorization is explicit, durable, revocable, and deny-by-default;
2. an unallowlisted future-run policy is rejected;
3. sensitive fields are deterministically classified;
4. sensitive modes are enforced by one central policy layer;
5. file upload is sensitive and `never`;
6. safety-mode gating is testable;
7. rate limits are deterministic and durable;
8. analyze remains local/read-only;
9. run/preview/submission remain unavailable;
10. no LLM/profile/answer/browser/network scope creep exists;
11. all P2 requirements pass;
12. full regression, typecheck, and build are green.

