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
| Accepted implementation baseline | `19b312a` — `feat: complete phase 3 synthetic drafting` |
| Phase 4 | **NOT STARTED** |
| Next phase | **Phase 4 — deterministic consistency gate** |
| Current phase spec | `docs/PHASE_4.md` — planning document, not implementation |
| Full regression at Phase 3 acceptance | **376 passing across 30 files** |
| Phase 3 targeted verification | **107 passing across 7 files** |
| Typecheck / build | **clean** |
| Working tree at Phase 3 acceptance | **clean** |
| Accepted DB migrations | **1-6, unchanged by Phase 3** |

Phase 0 through Phase 3 are accepted work.

`19b312a` is the trusted accepted code baseline until Phase 4 itself is
implemented, independently reviewed, and committed.

Planning documentation for Phase 4 may be newer than the accepted
implementation baseline. Planning commits do not replace `19b312a` as the
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
re-derive earlier phases.

Inspect accepted earlier-phase code only when:

- Phase 4 directly depends on that interface;
- a relevant regression fails; or
- repository evidence contradicts a documented contract.

---

## Essential architecture

- `src/domain/`
  - provider-neutral pure domain models;
  - structural schema/fingerprint types;
  - semantic/profile/draft domain types;
  - must remain free of DB, network, browser, filesystem, or provider-specific
    I/O.

- `src/config/`
  - Zod-based configuration and config discovery;
  - accepted Phase 2 safety/rate configuration.

- `src/cli/`
  - CLI handlers;
  - frozen exit-code contract;
  - accepted analyze/auth/draft commands.

- `src/db/`
  - `better-sqlite3`;
  - WAL;
  - FK ON;
  - idempotent append-only migrations.

- `src/parser/google-forms.ts`
  - accepted Phase 1 offline Google Forms structural parser.

- `src/analyze/`
  - accepted Phase 1 local input resolution;
  - structural analysis;
  - cache/persistence integration;
  - human-readable summary.

- `src/policy/`
  - accepted Phase 2 policy layer;
  - target canonicalization;
  - authorization;
  - sensitive-field classification;
  - policy-file loading;
  - central `PolicyEngine`;
  - deterministic rate gate/state;
  - stable reason codes.

- `src/draft/`
  - accepted Phase 3 semantic/profile/draft orchestration;
  - provider-neutral async-compatible draft provider boundary;
  - deterministic reference provider;
  - structural answer validation;
  - safe formatting;
  - no execution.

- `src/llm/`
  - Phase 0 provider/foundation abstractions;
  - no accepted real cloud/local inference yet.

- `src/logging/`
  - redaction and structured logging.

- `src/fixtures/`
  - sanitized fixture/archive loading;
  - embedded-payload decoding.

- `bin/form-agent.js`
  - CLI launcher.

Permanent boundaries:

- `src/domain/` remains pure and provider-neutral.
- parsing remains separate from semantic/profile/draft logic;
- policy authorization remains separate from consistency;
- consistency must remain separate from browser execution;
- only the PolicyEngine may decide future execution authorization.

---

## Accepted Phase 1 structural behavior

Phase 1 is accepted at `309f097`.

The structural parser:

- parses sanitized responder-page HTML offline;
- extracts the accepted embedded Google Forms payload;
- produces provider-neutral `FormSchema`;
- preserves question ordering and section assignment;
- derives required state;
- performs no network, browser, submission, or LLM activity.

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

Malformed non-array payload items fail with controlled `GoogleFormsParseError`.

Linear-scale bounds use numeric step labels when available.

Do not invent undocumented Google Forms payload indices.

---

## Deferred structural behavior

Still deliberately unvalidated/deferred:

- dropdown;
- rating;
- file-upload execution;
- checkbox-grid distinction;
- "Other" free-text choice handling;
- conditional routing.

Accepted type `7` behavior remains:

`multiple-choice-grid` with `selectionMode: 'single'`.

Accepted routing remains sequential.

Do not broaden parser support during Phase 4.

---

## Accepted real fixture

Authoritative sanitized fixture:

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

Phase 4 must preserve this fingerprint.

---

## Analyze / cache contract

Accepted local analysis inputs include:

- sanitized local file path;
- fixture id;
- fixture URL handled by the local fixture harness.

Live HTTP Google Forms fetching is NOT implemented.

A live Google Forms URL must not be fetched by `analyze`, `draft`, or Phase 4
local checking.

Analysis remains:

- offline;
- fixture-read-only;
- submission-free.

Structural schemas are persisted by structural fingerprint.

Fingerprinting excludes ephemeral invocation metadata.

On cache hit, accepted behavior reuses the structural schema while preserving
current-invocation metadata.

Phase 1 parser generator version remains accepted as implemented.

---

## Accepted Phase 2 policy behavior

Phase 2 is accepted at `e5b4c2e`.

Core principle:

**future execution is denied by default.**

Successful parsing, fixture presence, previous analysis, cache state, form
identity, draft generation, or consistency success must never implicitly grant
execution authorization.

Accepted Phase 2 capabilities include:

- explicit durable target authorization;
- authorization inspection;
- revocation with retained history;
- canonical target identity;
- deterministic sensitive-field classification;
- configurable JSON/YAML/YML sensitivity policy files;
- central `PolicyEngine`;
- stable policy reason codes;
- safety-mode gate;
- deterministic durable rate-policy state;
- policy visibility in `analyze`;
- local-only `auth` CLI.

Authorization is not execution.

Authorization does not imply:

- sensitive-field permission;
- answer approval;
- consistency approval;
- human approval;
- rate eligibility;
- browser permission;
- submission.

---

## Accepted target canonicalization

Canonical target handling is pure and performs no network access.

For HTTP(S) targets:

- query parameters are excluded from canonical identity/display;
- fragments are excluded;
- URL userinfo is excluded;
- non-default ports remain part of identity;
- default ports normalize;
- Google Forms recognition requires the supported exact hostname;
- audited display must not echo URL secrets.

Do not regress these audit-safety guarantees.

---

## Accepted sensitive-field policy

Phase 2 sensitivity classification is deterministic and LLM-free.

Effective sensitivity mode uses the most restrictive matching policy:

`never > specific-authorization > human-reviewed > synthetic-allowed`

File upload remains always sensitive and `never` in the accepted MVP.

Phase 3 consumes sensitivity classification before profile answer-like trait
generation and before per-question answer generation.

Phase 4 must not weaken or bypass that ordering.

---

## Accepted PolicyEngine contract

The full future-run policy path requires a `FormSchema`.

`evaluateRunPolicy(...)` performs the mandatory sensitive pre-scan and must not
return an allowed decision without it.

The separate authorization-only API may evaluate authorization without a
schema.

Policy evaluation remains decision-making only.

It performs no:

- browser execution;
- network fetch;
- submission;
- scheduling;
- human-like pacing;
- answer generation;
- consistency repair.

Phase 4 consistency results are an additional quality gate, not a replacement
for PolicyEngine authorization.

---

## Accepted rate contract

Rate policy is deterministic.

When several time-based gates block simultaneously, `retryAfterMs` means the
time until all current time-based blockers can clear, therefore the maximum
applicable remaining duration.

Injected-time snapshots ignore future events.

Rolling windows use consistent lower-bound semantics.

Phase 4 must not add sleeps, pacing, scheduling, or rate mutation.

---

## Accepted Phase 3 draft behavior

Phase 3 is accepted at `19b312a`.

Conceptual accepted pipeline:

```text
FormSchema
    ↓
whole-form semantic interpretation
    ↓
Phase 2 sensitivity pre-classification
    ↓
synthetic respondent profile
    ↓
per-question draft generation using same semantics/profile
    ↓
structural answer validation
    ↓
DraftBundle
```

Phase 3 is local and creates draft data only.

It does not fetch live forms, use a browser, submit forms, or call a real model.

---

## Accepted Phase 3 provider boundary

The draft provider boundary is async-compatible.

Provider stages may return synchronous values or promises through the accepted
`MaybePromise<T>` contract.

The orchestrator awaits provider stages.

The deterministic reference provider remains synchronous internally, but future
async providers can replace it without rewriting the draft pipeline.

Every exception originating inside a provider stage is treated as untrusted and
wrapped in a stable sanitized draft error.

Provider-originated raw error messages/tokens must not escape through normal CLI
behavior.

---

## Accepted Phase 3 semantic model behavior

Whole-form semantics cover:

- topic;
- purpose;
- target audience/respondent context;
- section semantics;
- one semantic entry per schema question;
- structured question tags;
- relationships between real schema questions.

Phase 3 runtime validation requires exact question and section coverage.

Semantic provider output must not:

- omit question entries;
- omit section entries;
- invent unknown question/section identifiers;
- mismatch embedded IDs with map keys;
- omit the per-question `relationships` array;
- contain malformed relationship objects;
- reference unknown relationship targets;
- contain duplicate relationships;
- contain malformed/unknown/missing structured-question tags.

Provider output remains untrusted until validated.

---

## Accepted Phase 3 synthetic profile behavior

Profiles are explicitly synthetic.

A profile contains provider-neutral synthetic state including:

- identity;
- latent traits;
- facts;
- form/semantic references;
- profile identity/provenance.

Sensitivity is classified before profile generation.

The provider receives only the sensitivity-filtered eligible question-id set for
answer-like latent-trait derivation.

Blocked questions must not contribute generated answer-like profile values.

The accepted reference provider uses deterministic seeded generation.

Profile identity/RNG material includes stable eligibility material so different
effective eligibility cannot alias to the same profile identity/content.

---

## Accepted Phase 3 DraftBundle behavior

`DraftBundle` includes:

- explicit synthetic provenance;
- seed;
- stable draft identity;
- provider id/version;
- accepted structural fingerprint;
- form identity;
- validated semantic model;
- one synthetic profile;
- exactly one per-question draft result;
- summary/completeness.

Accepted per-question states include:

- `answered`;
- `blocked-sensitive`;
- `requires-human-review`;
- `requires-specific-authorization`;
- `unsupported`;
- `validation-error`.

A required question counts as satisfied only by a structurally valid non-empty
`answered` result.

Required blocked/unsupported/invalid questions make the bundle incomplete.

Phase 3 never invents a value merely to make a required question complete.

---

## Accepted Phase 3 structural validation

Every accepted `answered` value is validated against its actual `FormSchema`
question.

Accepted guards include:

- text/paragraph values must be non-empty after trimming;
- single-choice values must be real choices;
- multi-choice must be non-empty, contain only real choices, and deduplicate;
- linear-scale must be an integer inside accepted bounds;
- grid rows/columns must exist;
- a required grid must answer every real row;
- date/time values must satisfy accepted representation/ranges;
- unsupported kinds remain unsupported.

Structural validation is not semantic consistency validation.

Cross-answer/profile semantic consistency belongs to Phase 4.

---

## Accepted Phase 3 deterministic identity

The accepted reference contract is deterministic.

Same:

- schema/fingerprint;
- explicit seed;
- provider id/version;
- effective sensitivity outcomes;

produces reproducible profile/draft identities and content.

`profileId` includes stable order-independent eligibility material.

`draftId` includes stable effective-policy material plus the resulting
`profileId`.

Raw custom regex patterns, secrets, and wall-clock data are not identity inputs.

---

## Accepted Phase 3 CLI and secret safety

Implemented Phase 3 command:

```text
form-agent draft <input> --seed <seed> [--json]
```

Accepted input forms mirror local analyze inputs.

Live external forms are rejected without fetch.

CLI parsing is strict:

- unknown flags are usage errors;
- unknown-flag messages do not echo raw flag contents;
- `--seed` requires a following non-flag value;
- `--seed=` may not be empty;
- extra positional inputs are rejected.

Human output states explicitly that no submission occurred.

Structured draft JSON may contain eligible synthetic values because it is the
explicit draft result.

It must not contain generated values for policy-blocked questions.

Normal errors/logs must not echo provider secrets or arbitrary rejected provider
values.

---

## Independent Phase 3 review corrections now part of baseline

The accepted Phase 3 baseline includes all independent-review corrections.

Important contracts to preserve:

1. draft provider boundary is async-compatible;
2. sensitivity classification occurs before profile answer-like trait generation;
3. semantic output requires exact complete validated structural references;
4. provider/validation/CLI errors do not echo untrusted secret-bearing values;
5. empty/partial invalid answers cannot satisfy required completeness;
6. CLI flags are parsed strictly;
7. every semantic question entry requires `relationships`;
8. every provider-thrown exception is sanitized at the provider boundary;
9. unknown CLI flags use stable non-echoing text;
10. profile/draft identities incorporate effective eligibility/policy inputs.

Do not regress these contracts.

---

## Accepted verification at Phase 3 baseline

Final independent verification before commit `19b312a`:

```text
npm run verify:phase3
→ 107 passing across 7 files

npm test
→ 376 passing across 30 files

npm run typecheck
→ clean

npm run build
→ clean

git diff --check
→ clean
```

Accepted fixture fingerprint remained unchanged.

After commit, working tree was clean.

---

## Database state

Accepted migrations are **1-6**.

Migrations 1-4 are accepted earlier-phase migrations.

Phase 2 appended:

- migration 5 — durable authorization records/history;
- migration 6 — durable rate events/state.

Phase 3 added no migration.

Do not mutate accepted migration definitions.

Phase 4 is expected to remain ephemeral/in-memory and add no migration.

If Phase 4 implementation appears to require persistence, STOP and report the
conflict before adding a migration.

The normal local database remains gitignored under `.data/`.

---

## Frozen exit-code contract

- `0` success
- `1` error
- `2` usage/config
- `3` validation
- `4` LLM offline
- `5` LLM connectivity
- `127` unknown command

Codes `6-126` remain reserved.

Do not renumber or repurpose accepted codes without an explicit specification
change.

Phase 4 consistency hard-blocks should use the existing validation semantics,
not invent a new exit code.

---

## Current CLI state

Implemented:

- version/help foundation;
- provider inspection/validation foundation;
- `analyze` for accepted local/fixture inputs;
- `auth allow`;
- `auth check`;
- `auth list`;
- `auth revoke`;
- `draft <input> --seed <seed> [--json]`.

Still intentionally unavailable:

- `preview`;
- `plan`;
- `run`;
- browser execution;
- submission.

Phase 4 may add only the local consistency-inspection CLI explicitly described
by `docs/PHASE_4.md`.

Do not repurpose `preview` or `run` during Phase 4.

---

## Current LLM/provider state

No accepted real cloud/local provider inference exists yet.

Phase 3 provides the deterministic reference semantic/profile/draft provider.

Phase 4 must remain deterministic and model-free in its accepted path.

The consistency API should remain compatible with a future optional async
holistic pass, but Phase 4 must not call a real model.

Real cloud/local-model inference remains Phase 6.

---

## Phase 4 objective

Next phase:

**Phase 4 — Deterministic Consistency Gate**

Phase 4 has NOT started.

Detailed contract:

`docs/PHASE_4.md`

High-level flow:

```text
FormSchema + accepted DraftBundle
              ↓
      deterministic consistency gate
              ↓
      stable ConsistencyReport
         ├─ PASS
         ├─ WARN  (soft issues)
         └─ BLOCK (hard issues)
```

The gate checks coherence; it does not rewrite answers.

It must remain provider-neutral and deterministic.

---

## Phase 4 design direction

Phase 4 should detect consistency problems across:

- schema ↔ DraftBundle identity/integrity;
- required/completeness state;
- profile ↔ answer values where the accepted structured evidence is direct;
- answer ↔ answer relationships where deterministic evidence is strong enough;
- semantic relationships where they can be evaluated without guessing.

Hard issues block future preview/run consumption.

Soft issues surface as warnings.

The accepted MVP rule remains:

**hard-block on hard issues; warn on soft issues.**

The gate must not silently repair, replace, regenerate, or mutate answers.

---

## Conservative consistency principle

Do not turn uncertain semantic heuristics into hard blockers.

The accepted Phase 3 deterministic semantic provider can infer `repetition`
relationships from identical normalized titles.

That evidence is useful, but identical wording across different sections is not
automatically proof that two answers must be identical.

Phase 4 must therefore use explicit deterministic evidence and conservative
severity rules described in `docs/PHASE_4.md`.

Do not invent domain knowledge such as:

- age ↔ seniority;
- degree ↔ job role;
- address relationships;
- "none of the above" exclusivity;
- conditional question implications;

unless the accepted structured model explicitly represents the needed
constraint.

---

## Consistency is not authorization

A `PASS` consistency report does NOT mean:

- target is allowlisted;
- sensitivity permits execution;
- safety mode is eligible;
- rate gates permit execution;
- operator approved execution;
- browser execution is allowed;
- submission may occur.

The future execution path must satisfy both consistency and PolicyEngine
requirements independently.

---

## Phase 4 must NOT implement

Do not implement during Phase 4:

- live Google Forms fetching;
- browser automation;
- Playwright;
- form submission;
- `run`;
- preview approval workflow;
- batch scheduling;
- submission workers;
- sleep/random pacing;
- anti-detection/evasion;
- real cloud-model calls;
- real local-model inference;
- automatic LLM consistency pass;
- automatic answer rewrite;
- automatic answer regeneration/retry;
- OpenClaw integration;
- Telegram integration;
- metrics phase;
- deferred conditional-routing support;
- deferred checkbox-grid detection;
- upload execution;
- new persistence/migrations.

Do not begin Phase 5 automatically.

---

## Expected Phase 4 verification style

Use targeted tests while implementing.

Run the full regression only for final acceptance.

Expected final commands include:

```bash
npm run verify:phase4
npm test
npm run typecheck
npm run build
git diff --check
git diff --stat
git status --short
```

Local smoke tests should exercise the Phase 4 check command against the accepted
fixture and structured JSON output.

A live/external Google Forms URL must remain rejected without network fetch.

The exact acceptance contract belongs in `docs/PHASE_4.md`.

---

## Where Phase 4 should start

1. Read `AGENTS.md`.
2. Read this handoff.
3. Read `docs/PHASE_4.md`.
4. Treat `19b312a` as the accepted implementation baseline.
5. Confirm the Phase 4 spec is protected from agent edits.
6. Do not broadly re-audit Phase 0/1/2/3.
7. Inspect only Phase 3 domain/draft interfaces and earlier contracts directly
   needed by Phase 4.
8. Build the native TODO from P4 requirement IDs.
9. Keep exactly one meaningful milestone in progress.
10. Implement Phase 4 only.
11. Use deterministic/local tests only.
12. Use targeted tests during implementation.
13. Run complete verification only for final acceptance.
14. Produce a P4 requirement-by-requirement acceptance report.
15. Do not commit.
16. Stop.
17. Do not begin Phase 5.