# AGENT_HANDOFF.md — current state

**Short current-state handoff. Not a history dump.**

Task definitions belong in `docs/PHASE_N.md`.
Permanent agent rules belong in `AGENTS.md`.

---

## Status

| Item | Value |
| --- | --- |
| Phase 0 | **COMPLETE and ACCEPTED** |
| Phase 0 baseline | `63b2c3e` — `feat: complete phase 0 foundation` |
| Phase 1 | **COMPLETE and ACCEPTED** |
| Phase 1 baseline | `309f097` — `feat: complete phase 1 structural analysis` |
| Phase 2 | **COMPLETE and ACCEPTED** |
| Phase 2 baseline | `e5b4c2e` — `feat: complete phase 2 policy and authorization` |
| Phase 3 | **COMPLETE and ACCEPTED** |
| Phase 3 baseline | `19b312a` — `feat: complete phase 3 synthetic drafting` |
| Phase 4 | **COMPLETE and ACCEPTED** |
| Accepted implementation baseline | `0cda0ff` — `feat: complete phase 4 consistency gate` |
| Phase 5 | **NOT STARTED** |
| Next phase | **Phase 5 — controlled browser execution** |
| Current phase spec | `docs/PHASE_5.md` — planning document, not implementation |
| Full regression at Phase 4 acceptance | **441 passing across 36 files** |
| Phase 4 targeted verification | **65 passing across 6 files** |
| Typecheck / build | **clean** |
| Working tree at Phase 4 acceptance | **clean** |
| Accepted DB migrations | **1-6** |

Phase 0 through Phase 4 are accepted work.

`0cda0ff` is the trusted accepted implementation baseline until Phase 5 itself
is implemented, independently reviewed, and committed.

Planning documentation for Phase 5 may be newer than the accepted
implementation baseline. A planning commit does not replace `0cda0ff` as the
accepted implementation baseline.

Do not broadly reconstruct, re-audit, or reimplement accepted earlier phases.

---

## Source of truth

If sources conflict, earlier items win:

1. repository code;
2. tests;
3. Git history;
4. phase specifications (`docs/PHASE_N.md`);
5. this handoff.

Accepted Git history is a trusted baseline, not an invitation to repeatedly
re-derive prior phases.

Inspect accepted earlier-phase code only when:

- Phase 5 directly depends on that interface;
- a relevant regression fails; or
- repository evidence contradicts a documented contract.

---

## Essential architecture

- `src/domain/`
  - provider-neutral pure domain models;
  - structural schema/fingerprint types;
  - semantic/profile/draft/consistency domain types;
  - no DB, filesystem, browser, network, or provider-specific I/O.

- `src/config/`
  - Zod-based configuration and config discovery;
  - accepted safety/rate configuration.

- `src/cli/`
  - CLI handlers;
  - frozen exit-code contract;
  - accepted analyze/auth/draft/check commands.

- `src/db/`
  - `better-sqlite3`;
  - WAL;
  - FK ON;
  - idempotent append-only migrations.

- `src/parser/google-forms.ts`
  - accepted Phase 1 Google Forms structural parser;
  - consumes responder HTML;
  - provider-neutral `FormSchema`.

- `src/analyze/`
  - accepted local/fixture input resolution;
  - structural analysis and cache integration.

- `src/policy/`
  - accepted target canonicalization;
  - authorization;
  - sensitive-field classification;
  - central `PolicyEngine`;
  - deterministic durable rate state;
  - stable policy reason codes.

- `src/draft/`
  - accepted Phase 3 semantics/profile/draft orchestration;
  - deterministic reference provider;
  - structural answer validation.

- `src/consistency/`
  - accepted Phase 4 deterministic consistency gate;
  - provider-neutral comparison/rules/report formatting;
  - no authorization;
  - no browser execution.

- `src/llm/`
  - Phase 0 provider/foundation abstractions;
  - no accepted real cloud/local inference yet.

- `src/logging/`
  - redaction and structured logging.

- `src/fixtures/`
  - sanitized fixture/archive loading.

- `bin/form-agent.js`
  - CLI launcher.

Permanent boundaries:

- `src/domain/` remains pure and provider-neutral.
- structural parsing does not decide policy.
- draft generation does not authorize execution.
- consistency does not authorize execution.
- browser/provider code does not decide whether submission is legal.
- the Phase 2 `PolicyEngine` remains the authority for future run
  authorization/safety/rate eligibility.
- Phase 5 orchestration may sequence those accepted components, but must not
  duplicate their decision logic.

---

## Accepted Phase 1 structural behavior

Phase 1 is accepted at `309f097`.

The structural parser:

- parses sanitized responder-page HTML;
- extracts the accepted embedded Google Forms payload;
- produces provider-neutral `FormSchema`;
- preserves question ordering and section assignment;
- derives required state;
- performs no browser fill or submission.

Accepted fixture-validated structural kinds:

- type `0` → `text`
- type `1` → `paragraph-text`
- type `2` → `single-choice`
- type `4` → `multi-choice`
- type `5` → `linear-scale`
- type `7` → `multiple-choice-grid`
- type `9` → `date`
- type `10` → `time`

Distinct unvalidated/deferred kinds remain conservative `unsupported`.

Malformed non-array payload items fail with controlled
`GoogleFormsParseError`.

Linear-scale bounds use numeric step labels when available.

Do not invent undocumented Google Forms payload indices.

---

## Deferred structural behavior

Still deliberately deferred:

- dropdown;
- rating;
- file-upload execution;
- checkbox-grid distinction;
- "Other" free-text choice handling;
- conditional routing.

Accepted type `7` behavior remains:

`multiple-choice-grid` with `selectionMode: 'single'`.

Accepted routing remains sequential.

Phase 5 may execute only the accepted single-select grid representation.

Do not broaden the parser merely to make browser execution easier.

---

## Accepted observed fixture

Authoritative sanitized structural fixture:

`fixtures/archives/observed-responder.html`

Accepted facts:

- 5 sections;
- 27 questions;
- 4 required questions;
- 32 payload items total;
- 27 questions + 5 page breaks;
- 4 validated single-select grids;
- grid row counts 4 / 4 / 5 / 5;
- sequential routing;
- one terminal submit section.

Normalized question counts:

- text: 8
- paragraph-text: 3
- single-choice: 1
- multi-choice: 3
- linear-scale: 5
- multiple-choice-grid: 4
- date: 1
- time: 2

Golden structural artifact:

`tests/golden/observed-responder.schema.json`

Accepted structural fingerprint:

`7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e`

Phase 5 must preserve this fingerprint.

Important Phase 5 consequence:

The observed fixture contains a field classified by the accepted policy as
sensitive/`never`. The full Phase 2 `PolicyEngine` therefore blocks execution of
that fixture under the accepted policy.

**Do not weaken Phase 2 policy just to make the observed fixture executable.**

Phase 5 successful browser-submit E2E coverage should use a separate,
purpose-built local execution fixture/harness with no policy-blocked sensitive
fields.

The observed fixture remains a structural/regression fixture.

---

## Accepted local analyze/draft/check boundary

`analyze`, `draft`, and `check` currently accept local/fixture inputs.

Accepted local inputs include:

- sanitized local file path;
- fixture id;
- fixture URL handled by the local fixture harness.

Live external Google Forms URLs remain rejected by those commands.

Phase 5 must not silently turn `analyze`, `draft`, or `check` into network
commands.

`run` becomes the only Phase 5 command allowed to use the browser/network
execution provider, under explicit authorization and execution gates.

---

## Accepted Phase 2 policy behavior

Phase 2 is accepted at `e5b4c2e`.

Core principle:

**future execution is denied by default.**

Successful parsing, fixture presence, previous analysis, cache state, draft
generation, consistency PASS/WARN, or browser reachability must never implicitly
grant execution authorization.

Accepted Phase 2 capabilities include:

- durable target authorization;
- authorization inspection/revocation;
- canonical target identity;
- deterministic sensitive-field classification;
- configurable policy files;
- central `PolicyEngine`;
- safety-mode gate;
- durable deterministic rate state;
- stable machine-readable reason codes.

Authorization does not imply:

- sensitive-field permission;
- answer approval;
- consistency approval;
- operator approval;
- rate eligibility;
- browser fill permission;
- submission.

---

## Accepted target canonicalization

Canonical target handling is pure and performs no network access.

For HTTP(S) targets:

- query parameters are excluded from identity/display;
- fragments are excluded;
- URL userinfo is excluded;
- non-default ports remain part of identity;
- default ports normalize;
- Google Forms recognition requires the accepted exact hostname;
- audited display must not echo URL secrets.

Phase 5 must canonicalize before any browser activity.

Execution provider support must not broaden authorization to arbitrary URLs.

---

## Accepted sensitive-field policy

Phase 2 sensitivity classification remains deterministic and LLM-free.

Effective restrictiveness:

`never > specific-authorization > human-reviewed > synthetic-allowed`

File upload remains always sensitive and `never` in the MVP.

Phase 3 classifies sensitivity before answer-like profile state and answer
generation.

Blocked questions carry no generated value.

Phase 5 must never reconstruct or invent values for blocked questions.

---

## Accepted PolicyEngine contract

The full future-run policy path requires a `FormSchema`.

`evaluateRunPolicy(...)` performs:

- authorization;
- safety-mode gate;
- mandatory sensitive pre-scan;
- rate gate.

The accepted safety-eligible mode is `test-only`.

The full policy result is the authority for whether a run may continue toward
execution.

The authorization-only API may be called without a schema.

Phase 5 should use that authorization-only API before external network/browser
access, then the full policy path before fill and again immediately before
submission.

Policy decision-making itself performs no browser/submission side effects.

---

## Accepted rate behavior

Rate policy remains deterministic.

Accepted controls include:

- minimum delay;
- hourly cap;
- daily cap;
- batch pause;
- concurrent-batch cap;
- configured jitter field.

Phase 2 does not sleep or apply random pacing.

Phase 5 should continue to fail with deterministic retry-after information
rather than sleep.

`jitterFactor` remains configuration only unless a later explicit phase changes
that contract.

Unknown/ambiguous submission attempts must count conservatively against
submission rate limits.

---

## Accepted Phase 3 draft behavior

Phase 3 is accepted at `19b312a`.

Accepted flow:

```text
FormSchema
    ↓
whole-form semantics
    ↓
sensitivity pre-classification
    ↓
synthetic profile
    ↓
per-question draft proposals
    ↓
structural validation
    ↓
DraftBundle
```

`DraftBundle` includes:

- seed;
- deterministic draft identity;
- provider id/version;
- structural fingerprint;
- form identity;
- semantics;
- one synthetic profile;
- one result per schema question;
- explicit completeness summary.

Per-question states include:

- `answered`;
- `blocked-sensitive`;
- `requires-human-review`;
- `requires-specific-authorization`;
- `unsupported`;
- `validation-error`.

Phase 5 may fill only accepted `answered` values.

Blocked/deferred/unsupported states are never converted into browser values.

---

## Accepted Phase 3 structural answer validation

Accepted `answered` values already satisfy provider-neutral structural checks:

- text/paragraph non-empty;
- single-choice uses real choice;
- multi-choice non-empty, real choices, deduplicated;
- linear-scale integer in bounds;
- grid uses real rows/columns;
- required grid covers every real row;
- valid date;
- valid time.

Browser execution must still verify that the DOM actually reflects the intended
accepted value after fill.

Structural validity in memory does not prove DOM fill succeeded.

---

## Accepted Phase 3 determinism and secret safety

Same accepted schema + seed + provider contract + effective policy produces a
reproducible draft.

`profileId`/`draftId` incorporate stable eligibility/effective-policy material.

Provider exceptions are sanitized.

Unknown CLI flags do not echo raw token-bearing input.

Do not regress those contracts in `run`.

---

## Accepted Phase 4 consistency behavior

Phase 4 is accepted at `0cda0ff`.

Consistency gate version:

`1.0.0`

Public boundary is async-compatible:

```text
runConsistencyGate({ schema, bundle }) → Promise<ConsistencyReport>
```

Accepted semantics:

- no issues → `pass`, non-blocking;
- soft issues only → `warn`, non-blocking;
- any hard issue → `block`, blocking.

The gate is read-only.

It does not:

- mutate draft values;
- repair contradictions;
- authorize execution;
- submit anything.

Stable hard-capable issue codes include:

- `SCHEMA_FINGERPRINT_MISMATCH`
- `FORM_ID_MISMATCH`
- `PROFILE_FORM_MISMATCH`
- `DRAFT_RESULT_COVERAGE_MISMATCH`
- `DRAFT_RESULT_KIND_MISMATCH`
- `REQUIRED_QUESTION_UNANSWERED`
- `DRAFT_VALIDATION_ERROR`
- `PROFILE_TRAIT_MISMATCH`
- `REPETITION_ANSWER_MISMATCH`

Stable soft issue codes include:

- `REPETITION_POSSIBLE_MISMATCH`
- `RELATIONSHIP_NOT_FULLY_CHECKED`

Phase 5 must refuse a consistency `block`.

A consistency `warn` remains non-blocking, but must be visible in preflight and
receipt metadata.

---

## Accepted Phase 4 review corrections

Independent review corrections are part of the accepted baseline.

Preserve all three:

1. **Report provenance**
   - report fingerprint identifies the schema actually evaluated;
   - `reportId` uses `schema.checksum`, not a stale bundle fingerprint.

2. **Integrity before semantic comparison**
   - invalid schema/bundle integrity stops profile/relationship comparison;
   - duplicate result ids do not use last-write-wins.

3. **Relationship ordering**
   - repetition pairs are explicitly ordered by accepted schema order;
   - semantically equivalent relationship-array ordering cannot change issue
     ordering/report identity.

Do not regress these when Phase 5 re-runs consistency during execution.

---

## Accepted verification at Phase 4 baseline

Final independent verification before commit `0cda0ff`:

```text
npm run verify:phase4
→ 65 passing across 6 files

npm test
→ 441 passing across 36 files

npm run typecheck
→ clean

npm run build
→ clean

git diff --check
→ clean
```

Accepted observed-fixture fingerprint remained unchanged.

After commit, working tree was clean.

---

## Database state

Accepted migrations are currently **1-6**.

Migrations 1-4 are accepted earlier-phase migrations.

Phase 2 appended:

- migration 5 — authorization history;
- migration 6 — rate events/state.

Phases 3 and 4 added no migration.

Phase 5 is the first phase where a new durable execution receipt/submission
claim is justified.

`docs/PHASE_5.md` permits **one append-only migration 7** for the minimal
execution-receipt / crash-safe submission-claim contract.

Do not mutate migrations 1-6.

Do not add migration 8 or a broad batch/preview schema without stopping and
reporting the need first.

---

## Frozen exit-code contract

- `0` success
- `1` error
- `2` usage/config
- `3` validation/policy/consistency block
- `4` LLM offline
- `5` LLM connectivity
- `127` unknown command

Codes `6-126` remain reserved.

Phase 5 should reuse this mapping.

Do not invent a "submission unknown" process exit code.

Unknown submission outcome should be represented in the structured execution
receipt/result and use the accepted generic error path unless
`docs/PHASE_5.md` explicitly defines a more precise use of the existing codes.

---

## Current CLI state

Implemented:

- version/help;
- provider inspection/validation foundation;
- `analyze`;
- `auth allow`;
- `auth check`;
- `auth list`;
- `auth revoke`;
- `draft <input> --seed <seed> [--json]`;
- `check <input> --seed <seed> [--json]`.

Still unavailable at the accepted Phase 4 baseline:

- `preview`;
- `plan`;
- `run`;
- browser fill;
- submission.

Phase 5 implements `run` only as specified by `docs/PHASE_5.md`.

Do not repurpose `preview` or `plan` unless the Phase 5 specification is
explicitly amended before implementation.

---

## Current LLM/provider state

No accepted real cloud/local inference exists yet.

Phase 3 uses the deterministic reference provider.

Phase 4 is deterministic/model-free.

Phase 5 remains model-free.

Real LLM wiring remains Phase 6.

Browser execution is not an excuse to introduce cloud inference.

---

## Phase 5 objective

Next phase:

**Phase 5 — Controlled Browser Execution**

Phase 5 has NOT started.

Detailed contract:

`docs/PHASE_5.md`

High-level execution flow:

```text
CLI run request
    ↓
strict argument validation
    ↓
canonical target + authorization-only preflight
    ↓
browser opens authorized execution target
    ↓
runtime FormSchema snapshot
    ↓
deterministic DraftBundle
    ↓
ConsistencyReport
    ↓
ExecutionPlan / planId
    ↓
full PolicyEngine gate
    ↓
explicit operator approval for submit mode
    ↓
fill + DOM verification
    ↓
runtime fingerprint re-check
    ↓
full PolicyEngine gate again
    ↓
durable submit claim + rate event
    ↓
ONE submit attempt
    ↓
confirmed success OR unknown_outcome
    ↓
durable safe receipt
```

---

## Locked Phase 5 safety decisions

Unless repository evidence proves a conflict, Phase 5 planning assumes:

1. **Playwright + Chromium**
   - one isolated non-persistent browser context per execution;
   - deterministic finite timeouts;
   - guaranteed teardown in `finally`.

2. **Run defaults to preflight**
   - `form-agent run <target> --seed <seed>` does NOT fill or submit;
   - it returns an execution plan and `planId`.

3. **Submission requires explicit approval**
   - actual submission requires `--submit`;
   - requires `--expect-plan <planId>`;
   - requires an explicit operator identity (`--by <operator>`);
   - missing approval arguments fail before network/browser use.

4. **Authorization before network**
   - canonicalize target first;
   - authorization-only `run` gate before any external page open.

5. **Full PolicyEngine twice**
   - once before fill;
   - again immediately before submit.

6. **Consistency is mandatory**
   - BLOCK stops execution;
   - WARN may continue but is surfaced.

7. **No random/human imitation**
   - no randomized delays;
   - no stealth;
   - no CAPTCHA bypass;
   - no anti-bot evasion.

8. **Single response per command**
   - no scheduler;
   - no batch worker;
   - no repeated submissions.

9. **Ambiguous submit is never retried**
   - once durable submit intent exists, no automatic retry;
   - unconfirmed post-submit state becomes `unknown_outcome`.

10. **Durable submission claim**
    - migration 7 stores safe receipt metadata;
    - claim is persisted before click;
    - a crash after claim cannot turn into an automatic duplicate retry.

11. **No stored credentials**
    - non-persistent browser context;
    - no login automation;
    - forms requiring sign-in/consent/captcha fail closed.

12. **External support is narrow**
    - exact supported Google Forms responder targets only;
    - local execution harness for tests;
    - no arbitrary URL browser automation.

---

## Phase 5 executable question kinds

Phase 5 should execute all accepted Phase 1/3 answer kinds:

- text;
- paragraph-text;
- single-choice;
- multi-choice;
- linear-scale;
- multiple-choice-grid with accepted `selectionMode: 'single'`;
- date;
- time.

Earlier architecture notes deferred generic grid/matrix fill.

Repository reality now has an accepted, structurally validated single-select
grid representation and the observed fixture contains four such grids.

Therefore Phase 5 may implement **only that accepted single-select grid shape**.

Checkbox-grid detection/execution remains deferred.

If repository/DOM evidence shows the accepted single-select grid cannot be
filled safely without broad parser changes, STOP and report the conflict rather
than silently skipping an `answered` field.

---

## Browser locator direction

Use resilient user-facing/accessibility locators where possible.

Prefer:

- role;
- label;
- accessible name;
- validated question container scope.

Do not use global title text alone as identity because duplicate titles exist.

Do not use `force: true` to bypass Playwright actionability.

Any necessary provider-specific CSS/XPath fallback should be isolated in the
Google Forms locator module and regression-tested.

DOM lookup failure must fail closed before submit.

---

## Sequential sections

The accepted structural routing is sequential.

Phase 5 may navigate accepted multi-section forms by the known section order.

It must verify expected progression.

Unexpected branching, hidden conditional flow, login wall, consent wall, or
unknown section behavior must abort.

Do not implement conditional-routing inference in Phase 5.

---

## Runtime fingerprint rule

The browser-loaded schema is the structural truth for the execution plan.

Actual submit mode must recompute the same plan from the current runtime form.

After fill, and immediately before submit:

- re-acquire the runtime form structure;
- parse it through accepted structural logic;
- compare the current checksum with the plan checksum.

Mismatch:

**abort before submit.**

Do not guess around field-level changes.

---

## Submission-outcome rule

Positive confirmation is required for `success`.

Once submit intent is durably claimed and the submit action begins:

- confirmed provider-specific success → `success`;
- any timeout/navigation/network/ambiguous state without positive confirmation
  → `unknown_outcome`.

Do not blindly retry.

Do not classify a post-click ambiguity as a safe pre-submit failure.

---

## Receipt safety

Execution receipts may contain:

- run id;
- submission key;
- sanitized target key/display;
- plan id;
- draft id;
- consistency report id;
- structural fingerprint;
- provider id;
- operator;
- timestamps;
- stable state/outcome codes;
- policy/consistency counts/reason codes.

Receipts must NOT persist:

- raw answers;
- profile values;
- blocked sensitive values;
- provider prompts;
- browser page HTML;
- cookies;
- tokens;
- URL userinfo/query secrets;
- custom sensitive-rule regex bodies.

---

## Phase 5 must NOT implement

Do not implement during Phase 5:

- real cloud/local LLM inference;
- LLM consistency pass;
- automatic answer repair;
- batch response generation;
- batch submission workers;
- scheduler/cron;
- randomized/human-like pacing;
- anti-detection/evasion;
- CAPTCHA solving;
- login automation;
- persistent browser profiles/cookies;
- file upload execution;
- checkbox-grid support;
- conditional-routing parser expansion;
- rating/dropdown parser expansion merely for execution;
- Microsoft Forms/provider #2;
- Google Forms API/OAuth submission;
- OpenClaw integration;
- Telegram integration;
- Phase 7 metrics/export system;
- Phase 6 work.

Do not begin Phase 6 automatically.

---

## Expected Phase 5 verification style

Use targeted tests while implementing.

Do not hit real Google Forms in automated tests.

Acceptance browser tests must use a local execution harness and Chromium.

The test harness must provide deterministic scenarios for at least:

- normal confirmed success;
- closed/not-accepting form;
- fingerprint mutation before submit;
- ambiguous post-submit outcome;
- locator/fill failure.

Tests should prove no external network is reached.

Final acceptance should include:

```bash
npm run verify:phase5
npm test
npm run typecheck
npm run build
git diff --check
git diff --stat
git status --short
```

The exact acceptance contract belongs in `docs/PHASE_5.md`.

---

## Where Phase 5 should start

1. Read `AGENTS.md`.
2. Read this handoff.
3. Read `docs/PHASE_5.md`.
4. Treat `0cda0ff` as the accepted implementation baseline.
5. Confirm the Phase 5 spec is protected from worker edits.
6. Do not broadly re-audit Phase 0/1/2/3/4.
7. Inspect only interfaces Phase 5 directly consumes:
   - domain schema/draft/consistency;
   - draft orchestration;
   - consistency gate;
   - policy engine/auth/rate store;
   - DB migration/repository conventions;
   - CLI/exit handling;
   - fixture infrastructure.
8. Inspect current package/browser dependencies before adding Playwright.
9. Build a native TODO from every P5 requirement id.
10. Keep exactly one meaningful milestone in progress.
11. Implement Phase 5 only.
12. Use the local execution harness for browser tests.
13. Use targeted tests during implementation.
14. Run full verification only for final acceptance.
15. Produce requirement-by-requirement acceptance evidence.
16. Do not commit.
17. Stop.
18. Do not begin Phase 6.