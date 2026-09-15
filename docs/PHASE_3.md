# Phase 3 — Synthetic Respondent Profiles and Draft Answers

## Status

**PLANNED — NOT IMPLEMENTED**

Accepted implementation baseline:

`e5b4c2e` — `feat: complete phase 2 policy and authorization`

Phase 0, Phase 1, and Phase 2 are accepted work.

Do not broadly re-audit or reimplement them.

---

## Objective

Phase 3 adds a deterministic, local, provider-neutral draft-generation layer.

The phase takes an accepted `FormSchema`, interprets the form as a whole,
constructs one explicitly synthetic respondent profile, drafts answers using
that shared context, validates those answers against the structural schema, and
returns a structured `DraftBundle`.

Conceptual flow:

```text
FormSchema
    ↓
whole-form semantic interpretation
    ↓
synthetic respondent profile
    ↓
per-question drafting using the same semantics/profile
    ↓
structural answer validation
    ↓
DraftBundle
```

Phase 3 creates draft data only.

It does NOT:

- fetch a live form;
- open a browser;
- submit a form;
- implement `run`;
- implement an approval/preview workflow;
- call a real LLM;
- perform Phase 4 consistency repair.

---

## Core design principles

### Whole-form context first

Question drafting must not be designed as a collection of isolated,
context-free calls.

Before drafting answers, the pipeline must establish semantic context for the
whole form.

That context should be able to describe, at minimum:

- overall topic;
- apparent purpose;
- likely respondent/audience context;
- section-level meaning;
- question intent;
- meaningful relationships between questions when deterministically available.

The same form semantics and the same synthetic respondent profile must be
available throughout answer drafting.

### Synthetic data only

Profiles and drafted answers created by Phase 3 are synthetic.

Phase 3 must not infer, retrieve, import, or claim to represent a real person.

Outputs must make synthetic provenance explicit.

### Deterministic reference behavior

Phase 3 must be testable without a real LLM.

The accepted Phase 3 reference path must be deterministic from explicit inputs.

At minimum, deterministic behavior must depend on:

- accepted form structure/fingerprint;
- explicit seed;
- deterministic/reference-provider version or equivalent stable contract.

The same accepted form + same seed + same deterministic provider contract must
produce reproducible output.

Do not use implicit `Math.random()` behavior.

### Structural truth remains authoritative

The semantic/draft provider is not trusted to invent structural identifiers.

`FormSchema` remains authoritative for:

- question IDs;
- section IDs;
- choice IDs/values;
- grid rows;
- grid columns;
- scale bounds;
- required state;
- supported structural kind.

Provider output must be validated before becoming an accepted draft answer.

### Policy remains separate from execution

Phase 3 reuses Phase 2 sensitive-field classification.

It must NOT use successful draft generation as execution authorization.

The full Phase 2 `PolicyEngine` remains the future execution-policy gate.

Draft generation may use sensitivity classification directly without requiring
a target to be execution-authorized.

---

# Requirements

## P3-R1 — Preserve accepted Phase 0-2 behavior

Phase 3 must preserve accepted behavior from Phase 0, Phase 1, and Phase 2.

In particular:

- accepted parser behavior remains unchanged unless a direct Phase 3 contract
  requires an additive interface;
- accepted structural fingerprint remains unchanged;
- existing analyze/cache behavior remains compatible;
- existing auth/policy/rate behavior remains compatible;
- accepted migrations remain unchanged;
- existing CLI exit-code mapping remains unchanged.

Authoritative fixture fingerprint must remain:

`7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e`

---

## P3-R2 — Explicit draft pipeline

Introduce a clearly separated local draft pipeline representing:

```text
FormSchema
→ semantic interpretation
→ synthetic profile
→ draft proposal
→ structural validation
→ DraftBundle
```

The orchestration must be explicit enough that future provider implementations
can replace the deterministic provider without rewriting the whole pipeline.

Do not combine parsing, semantics, policy, answer validation, and execution into
one monolithic function.

---

## P3-R3 — Whole-form semantic analysis contract

Define a provider-neutral semantic representation for a form.

It must support enough information to represent:

- overall topic;
- form purpose;
- likely audience/respondent context;
- section semantics;
- per-question intent;
- relevant question relationships.

The exact representation should follow existing domain conventions.

Do not hardcode the current student fixture as the semantic model.

The semantic representation belongs to the draft/semantic domain, not to the
Google Forms parser.

---

## P3-R4 — Semantic-reference validation

Semantic-provider output must not be blindly trusted.

Validate structural references produced by the provider.

At minimum:

- referenced question IDs must exist;
- referenced section IDs must exist;
- question relationships must reference real questions;
- duplicate or malformed references must be rejected or normalized according to
  one deterministic documented rule.

Invalid semantic-provider output must fail in a controlled way.

Do not silently invent missing structural objects.

---

## P3-R5 — Generic synthetic respondent profile

Define a provider-neutral `SyntheticRespondentProfile` or equivalent accepted
domain model.

The profile must not be hardcoded to students, employees, customers, or any
other specific form category.

It should be capable of representing form-dependent synthetic state such as:

- facts;
- traits;
- preferences;
- experiences;
- constraints;
- other provider-neutral synthetic attributes.

The exact representation may use structured key/value facts or another
validated generic representation consistent with existing domain style.

Every profile must be explicitly marked as synthetic.

---

## P3-R6 — Deterministic seed and profile identity

Draft generation requires an explicit non-empty seed.

For the deterministic/reference implementation:

same accepted form
+ same seed
+ same deterministic provider version/contract
= reproducible semantic/profile/draft output.

Create a stable profile/draft identity derived from deterministic inputs.

Do not depend on wall-clock time or implicit randomness for semantic content.

Ephemeral metadata such as generation timestamp, if present, must not alter the
deterministic content identity.

---

## P3-R7 — Structured DraftBundle and per-question state

Define a structured `DraftBundle` or equivalent.

Each form question must have an explicit draft result/state.

At minimum distinguish:

- `answered`;
- `blocked-sensitive`;
- `requires-human-review`;
- `requires-specific-authorization`;
- `unsupported`.

A structurally invalid provider proposal must not be promoted to `answered`.

It may either:

- produce a dedicated validation-error state; or
- fail the deterministic draft operation with a controlled validation error,

provided the behavior is explicit, deterministic, and covered by tests.

Do not silently coerce arbitrary invalid provider data into a valid answer.

---

## P3-R8 — Reuse Phase 2 sensitivity classification

Phase 3 must reuse the accepted Phase 2 sensitive classification/rule
resolution.

Effective sensitivity behavior:

- non-sensitive → eligible for synthetic draft generation;
- `synthetic-allowed` → eligible for synthetic draft generation;
- `human-reviewed` → do not auto-generate a value;
- `specific-authorization` → do not auto-generate a value in Phase 3;
- `never` → never generate a value.

The resulting per-question state must preserve why a value was not generated.

Do not weaken the accepted Phase 2 ordering:

`never > specific-authorization > human-reviewed > synthetic-allowed`

Do not use the full future-run `PolicyEngine` as a prerequisite for local
drafting.

---

## P3-R9 — Supported draft structural kinds

Phase 3 may generate draft answers for the accepted Phase 1 structural kinds:

- `text`;
- `paragraph-text`;
- `single-choice`;
- `multi-choice`;
- `linear-scale`;
- `multiple-choice-grid`;
- `date`;
- `time`.

An accepted `unsupported` question remains unsupported.

Do not add parser support for:

- dropdown;
- rating;
- checkbox-grid distinction;
- conditional routing;
- "Other" free-text behavior;
- file upload execution.

Do not invent undocumented Google Forms payload indices.

---

## P3-R10 — Structural answer validation

Every proposed `answered` value must be validated against its actual question
definition.

At minimum:

### text / paragraph-text

- value must satisfy the accepted answer representation;
- no arbitrary object/array may pass as textual content.

### single-choice

- selected value/identifier must correspond to an actual choice in the
  question.

### multi-choice

- every selected value/identifier must correspond to an actual choice;
- duplicate selections must not survive validated output;
- provider-invented choices must fail validation.

### linear-scale

- value must be numeric/integer according to the accepted structural model;
- value must remain inside the real accepted bounds/steps.

### multiple-choice-grid

- only actual rows may be answered;
- selected column for each row must exist;
- accepted Phase 1 `selectionMode: 'single'` remains authoritative;
- provider-invented rows or columns must fail validation.

### date

- value must conform to the accepted Phase 3 date representation;
- invalid calendar values must fail validation.

### time

- value must conform to the accepted Phase 3 time representation;
- invalid hour/minute values must fail validation.

The validator should be provider-neutral and deterministic.

---

## P3-R11 — Required-question completeness

Draft completeness must be explicit.

A required question counts as satisfied only when Phase 3 produces a
structurally valid `answered` result.

A required question that is:

- sensitive-blocked;
- human-review-required;
- specific-authorization-required;
- unsupported;
- structurally invalid

must make the `DraftBundle` incomplete.

Do not invent data merely because the question is required.

Draft incompleteness is not itself an execution attempt or error unless the
specifically invoked CLI contract says otherwise.

---

## P3-R12 — Synthetic provenance

The `DraftBundle` and profile must clearly identify synthetic provenance.

At minimum expose enough metadata to determine that:

- the profile is synthetic;
- answers were synthetically drafted;
- the deterministic seed is known;
- the provider/reference implementation identity/version is known.

Do not claim generated values came from an actual respondent.

Do not persist or log raw sensitive values for blocked fields.

---

## P3-R13 — Reuse accepted provider abstractions

Before introducing a new semantic/draft provider abstraction, inspect:

- `src/llm/`;
- relevant `src/domain/`;
- accepted fake/deterministic provider infrastructure.

If an existing provider abstraction can be minimally extended, prefer that.

Do not build a parallel duplicate provider stack.

Any extension must preserve provider neutrality and keep real provider calls out
of Phase 3.

---

## P3-R14 — Deterministic local/reference provider only

Implement one deterministic local/reference provider sufficient to exercise the
entire Phase 3 orchestration contract.

It must perform no:

- network calls;
- cloud inference;
- local-model inference;
- browser activity.

Its purpose is to make semantics/profile/draft orchestration testable before
Phase 6 real-provider wiring.

The deterministic provider should generate structurally meaningful values from
the form schema rather than merely returning one hardcoded fixture-specific
object.

It may use deterministic schema-derived heuristics.

Do not optimize Phase 3 around natural-language realism.

Architecture and correctness are more important than prose quality in this
phase.

---

## P3-R15 — Shared context during drafting

Each answer-generation operation must receive or have access to:

- whole-form semantic context;
- the same synthetic respondent profile;
- the actual target question/schema.

Tests must demonstrate that drafting is not architected as isolated
question-only generation.

The deterministic provider should make it possible to verify profile reuse
across multiple questions.

Phase 3 may use shared profile facts when drafting.

Phase 3 must NOT implement a separate post-generation contradiction detector,
rewrite loop, or consistency-repair engine.

That belongs to Phase 4.

---

## P3-R16 — Local-only `draft` CLI

Add a local draft-generation command.

Preferred contract:

```text
form-agent draft <input> --seed <seed>
```

Accepted Phase 3 inputs should follow the existing local analyze input model:

- sanitized local archive/file;
- fixture id;
- fixture URL handled through the local fixture harness.

A live external HTTP(S) form must NOT be fetched.

The command should support human-readable output.

Also provide structured JSON output using the repository's accepted CLI
conventions, preferably:

```text
--json
```

Human-readable output should summarize at least:

- form identity/title;
- synthetic profile identity;
- seed;
- answered count;
- blocked/deferred count;
- unsupported count;
- required unanswered count;
- overall completeness;
- explicit statement that no submission occurred.

Do not print secrets or hidden raw provider internals.

---

## P3-R17 — Controlled provider and validation failures

Introduce controlled Phase 3 errors consistent with existing repository error
conventions.

Invalid semantic/profile/draft provider output must not cause:

- raw stack dumps through normal CLI behavior;
- secret/token leakage;
- uncontrolled process crashes;
- silent acceptance of malformed output.

Reuse the frozen CLI exit-code contract.

Do not introduce a new exit code unless the existing contract genuinely cannot
represent the failure and the specification is explicitly amended before
implementation.

Logs/errors must not expose blocked sensitive values.

---

## P3-R18 — No new persistence requirement

Phase 3 profiles, semantics, and DraftBundles are ephemeral/in-memory results or
explicit CLI output.

No new database migration is expected.

Do not persist profiles/drafts merely for convenience.

Do not modify migrations 1-6.

If repository evidence proves that minimal persistence is absolutely required,
STOP and report the conflict instead of silently adding a migration.

---

## P3-R19 — Explicit out-of-scope boundary

Phase 3 must NOT implement:

- real OpenAI/DeepSeek/other cloud inference;
- real local-model inference;
- OpenClaw integration;
- Telegram integration;
- live Google Forms fetching;
- Playwright;
- browser automation;
- form submission;
- `run`;
- execution workers;
- submission workers;
- preview approval workflow;
- scheduling;
- batch submission;
- human-like/randomized pacing;
- anti-detection/evasion;
- cross-answer contradiction detection;
- automatic answer rewrite/retry for semantic consistency;
- deferred conditional-routing parsing;
- checkbox-grid detection;
- upload execution.

Do not begin Phase 4 automatically.

---

## P3-R20 — Acceptance coverage

Phase 3 acceptance must prove all of the following:

- deterministic output for same form + seed;
- changed seed can produce a distinct deterministic profile/draft where the
  reference provider supports variation;
- whole-form semantic context is created;
- semantic references are structurally validated;
- one shared profile is reused across questions;
- synthetic provenance is explicit;
- Phase 2 sensitivity rules block the correct questions before value
  generation;
- non-sensitive / synthetic-allowed fields can be drafted;
- required blocked/unsupported fields make the bundle incomplete;
- all supported answer kinds pass structural validation;
- invented choice values fail;
- invalid scale values fail;
- invalid grid rows/columns fail;
- invalid dates/times fail;
- unsupported structural kinds remain unsupported;
- local fixture integration works;
- `draft --json` returns structured output;
- external/live URLs are not fetched;
- no browser/submission path exists;
- Phase 0-2 regression behavior is preserved;
- accepted fixture fingerprint is unchanged.

---

# Domain / architecture guidance

Exact filenames and type names may follow repository conventions.

A reasonable conceptual separation is:

```text
domain semantic/profile/draft types
            ↓
semantic/draft provider boundary
            ↓
draft orchestration
            ↓
structural answer validator
            ↓
CLI presentation
```

Do not force this exact directory tree if accepted repository structure already
provides a better equivalent.

Keep pure domain logic separate from:

- filesystem I/O;
- SQLite;
- CLI formatting;
- provider-specific implementations.

---

# Draft result semantics

The accepted implementation must make a clear distinction between:

```text
question exists
        ↓
sensitivity evaluated
        ↓
eligible to draft?
   ├─ no → explicit blocked/deferred state
   └─ yes
        ↓
provider proposes answer
        ↓
structural validation
   ├─ invalid → controlled failure/state
   └─ valid → answered
```

A question must never move directly from provider proposal to accepted answer
without structural validation.

---

# Sensitivity order in draft generation

Sensitivity classification must occur before requesting a generated value for
a blocked question.

For:

- `never`;
- `human-reviewed`;
- `specific-authorization`

the deterministic provider should not be asked to create the answer value.

This is stronger than generating a value and discarding it afterward.

Tests should verify this behavior through a spy/fake/reference-provider signal
or equivalent deterministic evidence.

---

# Determinism

Deterministic output should not depend on:

- current clock time;
- file iteration nondeterminism;
- database row ordering without explicit ordering;
- global random state;
- implicit `Math.random()`.

If hashing is used, inputs must be explicitly defined and stable.

Tests should compare meaningful structured output, not only incidental console
text.

---

# Configuration

Follow existing configuration conventions.

Do not create a second configuration system.

Phase 3 should require as little new configuration as possible.

The seed belongs to the draft invocation, not global hidden state.

If provider/reference configuration is required, validate it explicitly.

---

# Database

Do not add a migration.

Accepted migrations remain 1-6.

Phase 3 generation should operate from accepted structural input and current
policy configuration without persistent profile/draft storage.

---

# Logging and secret safety

Do not log:

- credentials;
- tokens;
- raw blocked sensitive values;
- URL userinfo/query secrets;
- arbitrary provider-internal prompts if they could contain protected values.

Human-readable draft output may display generated non-sensitive synthetic
answers only when consistent with existing logging/output conventions.

Structured JSON may contain eligible synthetic draft values because that is the
explicit command result, but must not contain values for policy-blocked fields.

---

# Expected tests

Exact file names may follow repository conventions, but acceptance coverage
should be organized around responsibilities similar to:

```text
tests/phase3-semantics.test.ts
tests/phase3-profile.test.ts
tests/phase3-draft.test.ts
tests/phase3-answer-validation.test.ts
tests/phase3-sensitive.test.ts
tests/phase3-cli.test.ts
tests/phase3-no-execution.test.ts
```

Do not create empty/ceremonial test files merely to match these names.

Tests should use synthetic schemas for edge cases.

Use the accepted sanitized fixture only for integration/regression coverage.

Do not access the external Google Form.

---

# Implementation workflow

Before editing implementation code:

1. Read `AGENTS.md`.
2. Read `AGENT_HANDOFF.md`.
3. Read this specification.
4. Confirm accepted baseline `e5b4c2e`.
5. Inspect only the existing interfaces Phase 3 directly depends on.
6. Inspect existing `src/domain/` and `src/llm/` before designing provider
   abstractions.
7. Create a native TODO plan mapping every P3 requirement.

Use 6-8 meaningful milestones.

Each milestone must include its P3 requirement IDs.

Every requirement P3-R1 through P3-R20 must be mapped.

Keep exactly one milestone `in_progress` at a time.

Do not wait for user confirmation after creating the TODO.

---

# Testing workflow

During implementation:

- prefer targeted tests;
- run tests relevant to the currently edited contract;
- do not repeatedly run the entire regression suite;
- do not repeat investigations without new evidence.

If the same blocker remains after three genuinely different attempted
solutions:

- STOP;
- report `BLOCKED`;
- list the evidence;
- list the distinct attempts;
- preserve the working tree.

---

# Final verification

Before Phase 3 acceptance, run:

```bash
npm run verify:phase3
npm test
npm run typecheck
npm run build
```

Run local-only CLI smoke tests including:

```bash
node bin/form-agent.js draft   fixtures/archives/observed-responder.html   --seed respondent-001

node bin/form-agent.js draft   fixtures/archives/observed-responder.html   --seed respondent-001   --json
```

Also verify a live/external Google Forms URL is not fetched by `draft`.

Then run:

```bash
git diff --check
git diff --stat
git status --short
```

---

# Final acceptance report

The Phase 3 agent report must map every requirement individually:

```text
P3-R1  PASS / FAIL
P3-R2  PASS / FAIL
...
P3-R20 PASS / FAIL
```

For each requirement include:

- implementation evidence;
- test evidence.

Also report:

- final TODO state;
- files added;
- files modified;
- provider abstraction reused/extended;
- deterministic provider/reference version;
- migrations added — expected answer: `none`;
- targeted verification totals;
- full regression totals;
- typecheck result;
- build result;
- CLI smoke results;
- accepted fixture fingerprint;
- known limitations;
- deferred features;
- deviations from this specification;
- final `git status --short`.

Do NOT commit.

Do NOT push.

Do NOT begin Phase 4.

STOP after the Phase 3 acceptance report.
