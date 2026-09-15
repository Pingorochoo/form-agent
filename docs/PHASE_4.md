# Phase 4 — Deterministic Consistency Gate

## Status

**PLANNED — NOT IMPLEMENTED**

Accepted implementation baseline:

`19b312a` — `feat: complete phase 3 synthetic drafting`

Phase 0 through Phase 3 are accepted work.

Do not broadly re-audit or reimplement them.

---

## Objective

Phase 4 adds a deterministic, provider-neutral consistency gate on top of the
accepted Phase 3 `DraftBundle`.

The phase evaluates whether a structurally valid synthetic draft is internally
coherent enough to be consumed by future preview/run workflows.

Conceptual flow:

```text
FormSchema + DraftBundle
          ↓
input/integrity checks
          ↓
required/completeness checks
          ↓
profile ↔ answer checks
          ↓
answer ↔ answer / semantic relationship checks
          ↓
stable ConsistencyReport
     ├─ PASS
     ├─ WARN
     └─ BLOCK
```

Phase 4 detects and reports.

It does NOT silently repair, rewrite, regenerate, submit, or execute anything.

The accepted MVP enforcement rule is:

**hard issues block; soft issues warn.**

---

## Why this phase exists

Phase 3 guarantees structural validity per question.

That is necessary but not sufficient for whole-response coherence.

Examples of problems Phase 4 should be able to represent include:

- a draft/schema fingerprint mismatch;
- an accepted profile trait disagreeing with an answer that was supposed to
  reflect that trait;
- two strongly equivalent/repeated questions receiving incompatible answers;
- a required question remaining unanswered;
- a Phase 3 validation-error state surviving into a candidate response;
- a semantic relationship that cannot be confidently evaluated and should
  therefore surface as a warning rather than be guessed into a hard failure.

The gate must be conservative.

When the accepted structured data is insufficient to prove a contradiction,
Phase 4 must not invent domain knowledge.

---

## Core design principles

### 1. Read-only gate

The consistency gate consumes accepted data and returns a report.

It must not mutate:

- `FormSchema`;
- `SemanticModel`;
- `SyntheticProfile`;
- `DraftBundle`;
- per-question draft values.

No hidden repair.

No in-place normalization that changes the draft.

### 2. Deterministic-first

The accepted Phase 4 path must be fully testable with no model.

Same:

- accepted schema;
- accepted DraftBundle;
- gate version/contract;

must produce the same ordered report.

No wall-clock input.

No implicit randomness.

### 3. Hard means proven enough to block

A hard issue must be based on explicit structural/semantic/profile evidence.

Do not promote weak heuristics to hard blockers.

### 4. Soft means useful but non-blocking

A soft issue represents an inconsistency risk, ambiguity, or incomplete
cross-check that should be visible to a future operator but does not by itself
block.

### 5. Consistency is not policy

The consistency gate does not decide whether execution is authorized.

The Phase 2 `PolicyEngine` remains the sole authority for future execution
authorization/safety/rate eligibility.

A consistency PASS is never equivalent to execution permission.

### 6. Secret-safe reports

Consistency issues may identify:

- stable issue code;
- severity;
- relevant question ids;
- stable sanitized explanation.

They must not echo:

- raw answer values;
- profile trait values;
- blocked sensitive values;
- provider prompts;
- tokens/secrets;
- raw custom policy regex/patterns;
- URL query/userinfo secrets.

---

# Requirements

## P4-R1 — Preserve accepted Phase 0-3 behavior

Phase 4 must preserve accepted behavior from Phase 0 through Phase 3.

In particular:

- accepted parser behavior remains unchanged;
- accepted fixture structural fingerprint remains unchanged;
- analyze/cache remains compatible;
- Phase 2 auth/policy/rate behavior remains compatible;
- Phase 3 draft generation remains compatible;
- Phase 3 sensitivity ordering remains unchanged;
- Phase 3 provider error sanitization remains unchanged;
- migrations 1-6 remain unchanged;
- frozen CLI exit codes remain unchanged.

Authoritative fixture fingerprint:

`7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e`

---

## P4-R2 — Explicit consistency-gate API

Introduce a clearly separated consistency API that consumes at minimum:

- accepted `FormSchema`;
- accepted `DraftBundle`.

Conceptually:

```ts
runConsistencyGate({
  schema,
  bundle,
}): Promise<ConsistencyReport>
```

Exact names may follow repository conventions.

The public orchestration boundary should be async-compatible now even though the
Phase 4 built-in rules are deterministic/synchronous internally.

Reason:

Phase 6 may append an optional asynchronous holistic/model pass without forcing
future preview/run callers to be rewritten.

Phase 4 itself must not call a real model.

Do not combine consistency evaluation with:

- parsing;
- authorization;
- browser fill;
- submission;
- persistence.

---

## P4-R3 — Provider-neutral ConsistencyReport

Define a provider-neutral consistency report.

At minimum represent:

```ts
type ConsistencySeverity = 'hard' | 'soft';

interface ConsistencyIssue {
  code: string;
  severity: ConsistencySeverity;
  questionIds: string[];
  message: string;
}

interface ConsistencyReport {
  version: string;
  reportId: string;
  draftId: string;
  fingerprint: string;
  status: 'pass' | 'warn' | 'block';
  blocking: boolean;
  hardIssues: number;
  softIssues: number;
  issues: ConsistencyIssue[];
}
```

Exact field names may follow repository style.

Required semantics:

- `pass`: zero issues;
- `warn`: one or more soft issues, zero hard issues;
- `block`: one or more hard issues;
- `blocking === true` iff hard issue count is greater than zero.

The report should contain enough provenance to identify the draft/schema it
evaluated without embedding answer values.

---

## P4-R4 — Stable report identity and deterministic ordering

The report must be deterministic.

Define a stable gate version/contract.

`reportId` must be derived from stable inputs such as:

- draft identity;
- accepted structural fingerprint;
- consistency gate version;
- normalized issue material.

Normalized issue identity should use stable safe fields only, for example:

- issue code;
- severity;
- ordered question ids.

Do not include:

- wall-clock timestamps;
- raw answer values;
- raw provider messages;
- secrets;
- custom regex patterns.

Issue ordering must be deterministic.

Recommended deterministic rule ordering:

1. schema/bundle integrity;
2. draft completeness/state;
3. profile↔answer conformance;
4. answer↔answer relationship checks;
5. non-blocking unresolved/weak relationship warnings.

Within a rule, follow accepted schema order where possible.

---

## P4-R5 — Schema / DraftBundle integrity checks

The gate must detect stale or mismatched inputs before semantic comparison.

At minimum hard-block:

- `bundle.fingerprint !== schema.checksum`;
- `bundle.formId !== schema.formId`;
- `bundle.profile.formId !== schema.formId`;
- duplicate per-question draft result ids;
- unknown draft result question ids;
- missing schema question results;
- result kind inconsistent with its schema question kind.

Use stable issue codes.

Suggested codes:

- `SCHEMA_FINGERPRINT_MISMATCH`;
- `FORM_ID_MISMATCH`;
- `PROFILE_FORM_MISMATCH`;
- `DRAFT_RESULT_COVERAGE_MISMATCH`;
- `DRAFT_RESULT_KIND_MISMATCH`.

Do not echo malformed raw ids if they are provider/untrusted values. The
structured `questionIds` field may contain only ids validated as real schema
question ids.

If the malformed condition cannot safely identify a real question, use an empty
`questionIds` array and a stable message.

---

## P4-R6 — Required/completeness and validation-state checks

The consistency gate must independently surface Phase 3 states that make a
future response unacceptable as a complete response.

Hard issues include at minimum:

- any required question whose state is not `answered`;
- any per-question `validation-error` state.

Suggested codes:

- `REQUIRED_QUESTION_UNANSWERED`;
- `DRAFT_VALIDATION_ERROR`.

Do not invent a value to repair the condition.

Do not reinterpret policy-blocked required questions as answered.

A blocked required field may legitimately exist in a Phase 3 DraftBundle, but
the consistency report must still be `block` because the response is incomplete.

This does not override or weaken the reason the field was blocked.

---

## P4-R7 — Profile ↔ answer conformance

Phase 4 must perform deterministic answer/profile checks only when the accepted
structured profile makes the expected relation direct and unambiguous.

For the accepted Phase 3 model, support at minimum:

### linear-scale

When a question's semantic tag has an unambiguous numeric latent trait and the
question is `answered`, the answer should equal that trait value.

Mismatch → hard issue.

Suggested code:

`PROFILE_TRAIT_MISMATCH`.

### single-choice

When a question's semantic tag has an unambiguous string latent trait that is a
real choice and the question is `answered`, the answer should equal that trait.

Mismatch → hard issue.

### multi-choice

Do NOT hard-enforce the current Phase 3 multi-choice latent trait in Phase 4
unless the accepted provider contract is explicitly extended.

The Phase 3 reference provider does not currently guarantee that the latent
preference must appear in the final multi-choice set.

Do not manufacture a new hard invariant after the fact.

### free text / grid / date / time

Do not infer profile conformance without an explicit accepted structured
constraint.

This requirement is intentionally conservative.

---

## P4-R8 — Answer ↔ answer repetition/equivalence checks

Use accepted semantic relationships only when they can be interpreted
deterministically.

The accepted Phase 3 reference semantics can emit:

`kind: 'repetition'`

from identical normalized titles.

Phase 4 may compare two `answered` questions linked by repetition.

Canonical comparison must be deterministic and kind-aware.

Recommended comparison:

- text/paragraph: trim and normalize internal whitespace, otherwise preserve
  case/content;
- single-choice: exact selected value;
- multi-choice: set semantics, deterministic sorted comparison;
- linear-scale: exact integer;
- grid: same real row→column mapping after deterministic key ordering;
- date: exact accepted year/month/day;
- time: exact accepted hour/minute.

Do not coerce one structural kind into another merely to make values equal.

---

## P4-R9 — Conservative repetition severity

Identical wording is useful evidence, but it is not always proof of semantic
equivalence across sections.

For a `repetition` mismatch:

### hard

Treat as hard only when deterministic evidence is strong enough, at minimum:

- relationship confidence is `high`;
- both questions are in the same schema section;
- both questions have the same structural kind;
- both are answered;
- the accepted canonical comparator can compare that kind.

Suggested code:

`REPETITION_ANSWER_MISMATCH`.

### soft

Treat as soft when a repetition relation is relevant but equality cannot be
safely hard-enforced, for example:

- repeated wording occurs across different sections;
- one side is not answered but both are optional;
- kinds differ;
- comparator support is unavailable.

Suggested codes:

- `REPETITION_POSSIBLE_MISMATCH`;
- `RELATIONSHIP_NOT_FULLY_CHECKED`.

Do not hard-block merely because identical text appears in different contextual
sections.

---

## P4-R10 — Symmetric relationship deduplication

A relationship may be represented from A→B and B→A.

The consistency report must not emit duplicate issues for the same logical
pair/rule.

Build a stable canonical pair key from validated real question ids.

For example:

```text
min(schemaOrder(A), schemaOrder(B))
+
max(schemaOrder(A), schemaOrder(B))
+
rule code
```

or an equivalent deterministic rule.

Tests must cover symmetric duplicate relationships.

---

## P4-R11 — No silent repair or mutation

The consistency gate must never silently:

- change an answer;
- replace an answer;
- add a missing answer;
- regenerate a profile;
- regenerate semantics;
- downgrade a sensitivity state;
- remove a policy block;
- edit the DraftBundle;
- retry answer generation.

Tests should prove the input bundle is unchanged after consistency evaluation.

Automatic consistency repair/retry is explicitly out of Phase 4.

---

## P4-R12 — Hard-block / soft-warning enforcement semantics

The Phase 4 MVP rule is fixed:

- at least one hard issue → `status: 'block'`, `blocking: true`;
- no hard + one or more soft → `status: 'warn'`, `blocking: false`;
- no issues → `status: 'pass'`, `blocking: false`.

Do not add a configuration option that silently permits hard issues during this
phase.

Future preview/run code must be able to consume `blocking`.

Phase 4 itself does not implement preview/run.

---

## P4-R13 — Consistency is not execution authorization

The consistency gate must not call or replace the Phase 2 PolicyEngine.

A PASS/WARN report does not grant:

- allowlisting;
- sensitive-field authorization;
- safety-mode eligibility;
- rate eligibility;
- human/operator approval;
- browser permission;
- submission permission.

A BLOCK report is a quality/consistency blocker.

A future execution path will have to satisfy both:

1. consistency gate;
2. PolicyEngine / execution-specific requirements.

Tests must guard against a consistency PASS being interpreted as authorization.

---

## P4-R14 — Controlled failures and secret-safe issues

Introduce controlled Phase 4 errors consistent with existing repository
conventions.

Malformed Phase 4 inputs must not cause normal CLI behavior to:

- dump raw stacks;
- echo arbitrary provider payloads;
- echo tokens/secrets;
- echo raw answer values;
- expose blocked sensitive values.

Issue messages must be centrally stable/sanitized.

Do not interpolate arbitrary compared values into issue messages.

For example:

Good:

`repeated questions contain inconsistent answers`

Bad:

`question A was "token=VERY_SECRET_TOKEN" but question B was "..."`

Use sentinel tests containing:

- `VERY_SECRET_PROVIDER_VALUE`;
- `token=VERY_SECRET_TOKEN`.

Prove sentinels do not appear in:

- consistency issue messages;
- human check output;
- consistency JSON report;
- normal CLI error logs.

---

## P4-R15 — Local-only `check` CLI

Add a local consistency-inspection command.

Preferred contract:

```text
form-agent check <input> --seed <seed> [--json]
```

It should:

1. resolve the accepted local/fixture input;
2. generate the same accepted Phase 3 draft for the seed/current sensitivity
   rules;
3. run the Phase 4 consistency gate;
4. print the consistency result;
5. perform no execution.

Accepted inputs:

- sanitized local archive/file;
- fixture id;
- fixture URL handled by local fixture harness.

A live external HTTP(S) form must NOT be fetched.

CLI parsing must be strict like accepted `draft` parsing.

Unknown flags must not echo raw unknown flag contents.

---

## P4-R16 — `check` output and exit behavior

Human output should summarize at least:

- form identity/title;
- draft id;
- consistency report id;
- consistency status;
- hard issue count;
- soft issue count;
- stable issue codes + validated question ids;
- explicit statement that no submission occurred.

Human output must not print compared answer/profile values.

`--json` should return a structured consistency result.

Prefer returning:

- safe draft metadata/provenance;
- `ConsistencyReport`.

Do NOT duplicate the full DraftBundle answer values in `check --json` merely for
convenience.

The existing `draft --json` command remains the explicit command for viewing
eligible synthetic values.

Exit behavior:

- PASS → `0`;
- WARN only → `0`;
- BLOCK → existing validation exit code `3`;
- usage error → `2`;
- other accepted controlled failures follow frozen exit-code mapping.

Do not invent a new exit code.

---

## P4-R17 — No persistence or migration

Phase 4 consistency results remain ephemeral/in-memory CLI results.

Do not add:

- consistency report tables;
- preview tables;
- approval tables;
- new migrations.

Accepted migrations remain 1-6.

If implementation evidence suggests persistence is required, STOP and report the
conflict instead of adding a migration.

---

## P4-R18 — No network/browser/submission side effects

Phase 4 must perform no:

- external network fetch;
- live form fetch;
- browser launch;
- Playwright interaction;
- DOM filling;
- submit click;
- HTTP submission;
- scheduling;
- sleep;
- randomized pacing;
- retry of submissions.

The accepted fixture/local path remains the integration boundary.

Add explicit no-execution regression coverage.

---

## P4-R19 — Explicit out-of-scope boundary

Phase 4 must NOT implement:

- real OpenAI/DeepSeek/other cloud inference;
- real local-model inference;
- an actual LLM consistency pass;
- automatic contradiction repair;
- automatic answer regeneration/retry;
- preview approval workflow;
- `run`;
- browser execution;
- Playwright;
- live Google Forms fetching;
- form submission;
- submission-state detection;
- receipts;
- runtime live-form fingerprint re-fetch;
- metrics phase;
- OpenClaw integration;
- Telegram integration;
- batch scheduling/workers;
- human-like/randomized pacing;
- anti-detection/evasion;
- deferred conditional routing;
- checkbox-grid detection;
- upload execution;
- parser expansion unrelated to a direct Phase 4 requirement.

Do not begin Phase 5 automatically.

---

## P4-R20 — Acceptance coverage

Phase 4 acceptance must prove all of the following:

- Phase 0-3 regression behavior preserved;
- accepted fixture fingerprint unchanged;
- consistency API is provider-neutral and async-compatible;
- same schema + same DraftBundle produces identical report/reportId;
- issue ordering is deterministic;
- symmetric relationships do not duplicate issues;
- schema fingerprint mismatch hard-blocks;
- form/profile identity mismatch hard-blocks;
- missing/unknown/duplicate draft-result coverage hard-blocks;
- required unanswered hard-blocks;
- validation-error state hard-blocks;
- direct single-choice profile-trait mismatch hard-blocks;
- direct linear-scale profile-trait mismatch hard-blocks;
- matching direct profile traits pass;
- strong same-section high-confidence repetition mismatch hard-blocks;
- weaker/cross-section repetition inconsistency surfaces only as soft warning;
- uncheckable optional repetition can surface a non-blocking warning;
- no automatic repair/mutation occurs;
- hard issue => BLOCK;
- soft-only => WARN;
- no issue => PASS;
- PASS/WARN never grants execution authorization;
- issue/report output does not expose answer/profile/provider secret sentinels;
- local fixture `check` works;
- `check --json` is structured and secret-safe;
- `check` BLOCK uses exit code 3;
- `check` WARN/PASS uses exit code 0;
- malformed/unknown CLI flags are strict and non-echoing;
- live/external Google Forms URL is rejected with no fetch;
- no browser/submission path is added;
- migrations 1-6 remain unchanged.

---

# Domain / architecture guidance

Exact filenames/type names may follow repository conventions.

A reasonable conceptual separation is:

```text
src/domain/consistency.ts
        ↓
src/consistency/
    compare.ts
    rules.ts
    gate.ts
    format.ts
        ↓
src/cli/check.ts
```

Do not force this exact tree if repository structure provides a cleaner
equivalent.

Keep:

- domain types pure;
- deterministic rules separate from CLI formatting;
- consistency separate from policy;
- consistency separate from draft generation;
- consistency separate from future execution.

---

# Suggested issue-code baseline

Exact names may be adjusted before implementation if repository conventions
strongly prefer another shape, but issue codes must be stable and tested.

Suggested hard-capable codes:

```text
SCHEMA_FINGERPRINT_MISMATCH
FORM_ID_MISMATCH
PROFILE_FORM_MISMATCH
DRAFT_RESULT_COVERAGE_MISMATCH
DRAFT_RESULT_KIND_MISMATCH
REQUIRED_QUESTION_UNANSWERED
DRAFT_VALIDATION_ERROR
PROFILE_TRAIT_MISMATCH
REPETITION_ANSWER_MISMATCH
```

Suggested soft codes:

```text
REPETITION_POSSIBLE_MISMATCH
RELATIONSHIP_NOT_FULLY_CHECKED
```

Do not encode raw values into codes.

---

# Canonical answer comparison guidance

The comparator must compare accepted values without changing the draft.

Recommended deterministic canonicalization:

### text / paragraph-text

- trim outer whitespace;
- collapse internal whitespace runs;
- otherwise preserve content/case.

Do not semantic-paraphrase.

### single-choice

Exact accepted choice value.

### multi-choice

Compare as sets:

- deduplicate defensively;
- sort deterministically;
- exact members.

Do not infer choice synonyms.

### linear-scale

Exact integer.

### multiple-choice-grid

- validate real row ids;
- deterministic row ordering;
- exact selected column per compared row.

### date

Exact accepted `(year, month, day)`.

### time

Exact accepted `(hour, minute)`.

If kinds differ, do not coerce.

---

# Profile-conformance guidance

The Phase 3 reference provider creates latent traits keyed by semantic tag.

Phase 4 may use an exact tag/anchor match only when unambiguous.

If multiple latent traits share the same anchor and disagree, do not arbitrarily
pick one for a hard comparison.

Either:

- emit a controlled soft ambiguity warning; or
- skip hard conformance for that question;

according to one documented deterministic rule.

Do not silently choose the first conflicting trait for a hard blocker.

The accepted reference provider's current direct guarantees are strongest for:

- single-choice;
- linear-scale.

Keep Phase 4 hard checks aligned with actual accepted provider semantics.

---

# Relationship guidance

A semantic relationship is not automatically a hard constraint.

The gate should ask:

1. Are both question ids real?
2. Is the relationship kind supported deterministically?
3. Is confidence strong enough?
4. Are both questions in a context where equality is justified?
5. Are both values present and comparable?

Only then hard-block.

Otherwise prefer a soft warning or no issue.

This prevents a heuristic semantic model from creating false hard failures.

---

# Immutability proof

Tests should deep-copy or serialize the input `DraftBundle` before evaluation and
prove it is unchanged afterward.

The consistency gate owns a report, not a rewritten draft.

---

# Async-compatible future boundary

Phase 4 contains no real model calls.

However, choose a public gate contract that can later support an optional
asynchronous holistic pass.

A simple acceptable approach is:

```ts
export async function runConsistencyGate(...): Promise<ConsistencyReport>
```

with deterministic rule evaluation inside.

Do not add a fake network client merely to prove async capability.

Do not add Phase 6 provider configuration.

---

# Configuration

Prefer no new Phase 4 configuration unless repository evidence makes it
necessary.

Hard-block semantics are fixed for this phase.

Do not add a `hardBlock=false` escape hatch.

Do not create a second config system.

---

# Database

Do not add a migration.

Accepted migrations remain 1-6.

Consistency reports are ephemeral.

---

# Logging and secret safety

Consistency logging/output may include:

- form/draft/report ids;
- issue code;
- severity;
- validated real question ids;
- counts/status.

Do not log:

- raw compared answer values;
- profile trait values;
- blocked sensitive values;
- provider prompts;
- tokens/credentials;
- arbitrary malformed provider content.

A future metrics phase may count issue codes, but Phase 4 does not implement that
persistence/metrics path.

---

# Expected tests

Exact file names may follow repository conventions.

A reasonable acceptance layout is:

```text
tests/phase4-consistency.test.ts
tests/phase4-integrity.test.ts
tests/phase4-profile.test.ts
tests/phase4-relationships.test.ts
tests/phase4-cli.test.ts
tests/phase4-no-execution.test.ts
```

Possible support helpers may live under:

```text
tests/support/
```

Do not create ceremonial empty files.

Use synthetic schemas/bundles for precise contradiction cases.

Use the accepted sanitized fixture for integration/regression only.

Do not access the external Google Form.

---

# Recommended Phase 4 implementation milestones

Map every P4 requirement into 6-8 native TODO milestones.

A reasonable grouping:

1. **M1 — domain/report contract**
   - P4-R1, R2, R3, R4

2. **M2 — integrity/completeness rules**
   - P4-R5, R6

3. **M3 — profile conformance**
   - P4-R7

4. **M4 — relationship comparison**
   - P4-R8, R9, R10

5. **M5 — enforcement/safety/immutability**
   - P4-R11, R12, R13, R14

6. **M6 — local check CLI**
   - P4-R15, R16

7. **M7 — no-side-effect/persistence guards**
   - P4-R17, R18, R19

8. **M8 — acceptance**
   - P4-R20

Keep exactly one meaningful milestone `in_progress`.

---

# Implementation workflow

Before editing implementation code:

1. Read `AGENTS.md`.
2. Read `AGENT_HANDOFF.md`.
3. Read this specification.
4. Confirm accepted implementation baseline `19b312a`.
5. Confirm this spec is protected from agent edits.
6. Inspect only Phase 3 interfaces Phase 4 directly depends on:
   - `src/domain/draft.ts`;
   - `src/domain/profile.ts`;
   - `src/domain/semantic.ts`;
   - `src/domain/types.ts`;
   - `src/draft/orchestrate.ts`;
   - `src/draft/validate.ts`;
   - CLI wiring needed for the local `check` command.
7. Do not broadly re-audit earlier phases.
8. Create the native TODO mapping P4-R1 through P4-R20.

Do not wait for user confirmation after creating the TODO.

---

# Testing workflow

During implementation:

- prefer targeted tests;
- run only tests relevant to the current milestone;
- do not repeatedly run the full regression suite;
- do not repeatedly investigate accepted earlier phases without new evidence.

If the same blocker remains after three genuinely distinct attempted solutions:

- STOP;
- report `BLOCKED`;
- list evidence;
- list the distinct attempts;
- preserve the working tree.

---

# Final verification

Before Phase 4 acceptance, run:

```bash
npm run verify:phase4
npm test
npm run typecheck
npm run build
```

Run local-only CLI smoke tests including:

```bash
node bin/form-agent.js check \
  fixtures/archives/observed-responder.html \
  --seed respondent-001

node bin/form-agent.js check \
  fixtures/archives/observed-responder.html \
  --seed respondent-001 \
  --json
```

Also test:

- a synthetic hard-block case returns exit `3`;
- a synthetic soft-only case remains non-blocking;
- a secret-bearing unknown flag does not echo the secret;
- a live/external Google Forms URL is rejected without fetch.

Then run:

```bash
git diff --check
git diff --stat
git status --short
```

Confirm:

- no migration changes;
- no browser/network/submission implementation;
- accepted fixture fingerprint unchanged.

---

# Final acceptance report

The Phase 4 worker report must map every requirement individually:

```text
P4-R1  PASS / FAIL
P4-R2  PASS / FAIL
...
P4-R20 PASS / FAIL
```

For each requirement include:

- implementation evidence;
- test evidence.

Also report:

- final TODO state;
- files added;
- files modified;
- consistency gate version;
- stable issue codes implemented;
- migrations added — expected answer: `none`;
- targeted verification totals;
- full regression totals;
- typecheck result;
- build result;
- CLI smoke results;
- hard-block exit-code smoke;
- accepted fixture fingerprint;
- known limitations;
- deferred features;
- deviations from this specification;
- final `git status --short`.

Do NOT commit.

Do NOT push.

Do NOT begin Phase 5.

STOP after the Phase 4 acceptance report.
