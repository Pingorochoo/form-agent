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
| Accepted implementation baseline | `e5b4c2e` — `feat: complete phase 2 policy and authorization` |
| Phase 3 | **NOT STARTED** |
| Next phase | **Phase 3 — synthetic profiles and draft answers** |
| Current phase spec | `docs/PHASE_3.md` — to be created in the Phase 3 planning commit |
| Full regression at Phase 2 acceptance | **269 passing across 23 files** |
| Phase 2 targeted verification | **107 passing across 7 files** |
| Typecheck / build | **clean** |
| Working tree at Phase 2 acceptance | **clean** |

Phase 0, Phase 1, and Phase 2 are accepted work.

`e5b4c2e` is the accepted code baseline until Phase 3 itself is implemented,
independently reviewed, and committed.

Do not broadly reconstruct, re-audit, or reimplement accepted earlier phases.

---

## Source of truth

If sources conflict, earlier items win:

1. repository code
2. tests
3. git history
4. phase specifications (`docs/PHASE_N.md`)
5. this handoff

Accepted Git history is a trusted baseline, not an invitation to repeatedly
re-derive previous phases.

Inspect accepted earlier-phase code only when:

- the current phase directly depends on that interface;
- a relevant regression fails; or
- repository evidence contradicts a documented contract.

---

## Essential architecture

- `src/domain/`
  - provider-neutral pure domain models;
  - structural schema/fingerprint types;
  - no DB, network, browser, filesystem, or provider-specific I/O.

- `src/config/`
  - Zod-based configuration and config discovery;
  - Phase 2 safety/rate configuration lives here.

- `src/cli/`
  - CLI handlers;
  - frozen exit-code contract;
  - accepted `auth` command implementation.

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
  - stable policy reason codes.

- `src/llm/`
  - Phase 0 provider abstraction/foundation;
  - deterministic fake provider infrastructure;
  - no real provider inference is accepted yet.

- `src/logging/`
  - redaction and structured logging.

- `src/fixtures/`
  - sanitized fixture/archive loading;
  - embedded-payload decoding.

- `bin/form-agent.js`
  - CLI launcher.

Permanent boundary:

`src/domain/` must remain pure and provider-neutral.

Policy behavior should remain outside the accepted structural parser unless an
explicit contract requires otherwise.

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

Distinct unvalidated/deferred kinds are represented conservatively as
`unsupported`.

Malformed non-array payload items throw controlled `GoogleFormsParseError`
instead of being silently skipped.

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

Google Forms checkbox grids share payload type code `7` with the validated
single-select grid shape.

The accepted parser cannot distinguish them from the embedded payload alone
because the distinguishing information is DOM-level markup that the parser
does not currently consume.

Therefore accepted type `7` behavior remains:

`multiple-choice-grid` with `selectionMode: 'single'`.

Accepted routing remains sequential.

Do not silently broaden parser support during Phase 3.

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

Phase 3 must preserve this fingerprint.

---

## Analyze / cache contract

Accepted local analysis inputs include:

- sanitized local file path;
- fixture id;
- fixture URL handled by the local fixture harness.

Live HTTP Google Forms fetching is NOT implemented.

A live Google Forms URL must not be fetched by `analyze`.

Analysis remains:

- offline;
- fixture-read-only;
- submission-free;
- real-LLM-free.

Structural schemas are persisted by structural fingerprint.

Fingerprinting excludes ephemeral invocation metadata.

On cache hit, accepted behavior reuses the structural schema while preserving
current-invocation metadata.

Phase 1 parser generator version:

`GOOGLE_FORMS_PARSER_VERSION = 0.1.0`

---

## Accepted Phase 2 policy behavior

Phase 2 is accepted at `e5b4c2e`.

Core principle:

**future execution is denied by default.**

Successful parsing, fixture presence, previous analysis, cache state, or known
form identity must never implicitly grant execution authorization.

Accepted Phase 2 capabilities:

- explicit durable target authorization;
- authorization inspection;
- revocation with retained history;
- canonical target identity;
- deterministic sensitive-field classification;
- configurable sensitivity policy files;
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
- human approval;
- rate eligibility;
- browser permission;
- submission.

---

## Accepted target canonicalization

Canonical target handling is pure and performs no network access.

Accepted target forms include:

- fixture id;
- fixture URL;
- HTTP(S) URL;
- local path;
- controlled opaque/raw target.

For HTTP(S) targets:

- query parameters are excluded from canonical identity/display;
- fragments are excluded;
- URL userinfo is excluded;
- non-default ports remain part of identity;
- default ports normalize to the equivalent port-less URL;
- Google Forms recognition requires the supported exact hostname;
- audited display is sanitized and must not echo URL secrets.

Fixture-id and equivalent fixture-URL forms resolve to the same fixture key.

Do not weaken these audit-safety guarantees in later phases.

---

## Accepted sensitive-field policy

Phase 2 sensitivity classification is deterministic and does not use an LLM.

Built-in taxonomy covers at least:

- names;
- email;
- phone;
- address;
- government identifiers;
- employee identifiers;
- passport;
- payment/bank/card information;
- credentials/password/token/secret;
- health information;
- uploads.

Custom policy rules may be loaded from deterministic sorted policy files under:

`config/policies.d/`

Accepted formats:

- `.json`
- `.yaml`
- `.yml`

Invalid files/rules fail explicitly.

Effective sensitivity mode uses the most restrictive matching policy.

Restrictiveness:

`never > specific-authorization > human-reviewed > synthetic-allowed`

File upload is always sensitive and `never` in the current accepted MVP.

---

## Accepted PolicyEngine contract

The full future-run policy path requires a `FormSchema`.

A full `evaluateRunPolicy(...)` call must perform the sensitive pre-scan.

The full policy path must not return an allowed decision without that scan.

The TypeScript boundary requires the schema and a runtime fail-safe protects
untyped/JavaScript callers.

The separate authorization-only API may evaluate authorization without a
schema.

Policy evaluation remains decision-making only.

It performs no:

- browser execution;
- network fetch;
- submission;
- scheduling;
- human-like pacing;
- semantic answer generation.

---

## Accepted safety and rate contract

Only the accepted safety mode may make a future execution path safety-eligible.

Rate configuration/state includes the accepted controls for:

- minimum delay;
- hourly cap;
- daily cap;
- batch pause;
- concurrent-batch cap;
- jitter configuration.

Phase 2 does NOT apply random pacing or sleep.

`jitterFactor` is configuration only at this stage.

Rate evaluation is deterministic.

When several time-based gates block simultaneously,
`retryAfterMs` means the time until all current time-based blockers can clear,
therefore the maximum applicable remaining duration.

Rate-store snapshots evaluated at injected `nowMs` must not be affected by
future events.

Rolling windows use consistent half-open lower-bound semantics.

Tests inject time rather than waiting.

---

## Database state

Accepted migrations are currently **1-6**.

Migrations 1-4 are accepted earlier-phase migrations and remain unchanged.

Phase 2 appended:

- migration 5 — durable authorization records/history;
- migration 6 — durable rate events/state.

Existing accepted structures include the earlier Phase 0/1 tables plus the
Phase 2 authorization/rate structures.

Do not mutate an accepted migration definition.

Phase 3 is not expected to require a migration.

Do not add persistent profile/draft storage unless the Phase 3 specification
explicitly changes that decision based on repository evidence.

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

---

## Current CLI state

Implemented:

- version/help foundation;
- provider inspection/validation foundation;
- `analyze` for accepted local/fixture inputs;
- `auth allow`;
- `auth check`;
- `auth list`;
- `auth revoke`.

Still intentionally unavailable:

- `preview`;
- `plan`;
- `run`;
- browser execution;
- submission.

Phase 3 may add only the local draft-generation CLI explicitly described by
`docs/PHASE_3.md`.

Do not repurpose `preview` or `run` for Phase 3.

---

## Current LLM/provider state

Only deterministic/foundation provider infrastructure exists.

No accepted real provider inference exists yet.

Phase 3 may build deterministic semantic/profile/draft orchestration on top of
the accepted provider-neutral abstractions.

Before introducing a new provider interface, inspect the existing `src/llm/`
and relevant `src/domain/` contracts.

Reuse or minimally extend accepted abstractions when they already model the
needed boundary.

Do not create a duplicate provider system.

Real cloud/local-model inference remains deferred.

---

## Independent Phase 2 review corrections now part of the baseline

The accepted Phase 2 baseline includes four corrections found during
independent review:

1. JSON and YAML/YML policy decoding are separated from shared validated
   policy-object conversion.

2. Full `PolicyEngine` evaluation cannot bypass the mandatory sensitive
   pre-scan.

3. Rate `retryAfterMs` uses the maximum applicable blocking duration and
   injected-time snapshots ignore future events / handle rolling-window
   boundaries consistently.

4. Canonical URL identity preserves non-default ports and authorization audit
   display strips userinfo, query, and fragment secrets.

Do not regress these contracts.

---

## Accepted verification at Phase 2 baseline

Final independent verification at `e5b4c2e`:

```text
npm run verify:phase2
→ 107 passing across 7 files

npm test
→ 269 passing across 23 files

npm run typecheck
→ clean

npm run build
→ clean

git diff --check
→ clean
```

The accepted fixture fingerprint remained unchanged.

---

## Phase 3 objective

Next phase:

**Phase 3 — Synthetic Respondent Profiles and Draft Answers**

Phase 3 has NOT started.

The detailed contract belongs in:

`docs/PHASE_3.md`

The high-level objective is to build a deterministic, local, provider-neutral
draft-generation pipeline on top of accepted `FormSchema` and Phase 2
sensitivity policy.

Conceptual flow:

```text
FormSchema
    ↓
whole-form semantic interpretation
    ↓
synthetic respondent profile
    ↓
per-question draft generation using the same form/profile context
    ↓
structural answer validation
    ↓
DraftBundle
```

Phase 3 drafts data.

It does NOT execute or submit a form.

---

## Phase 3 design direction

Phase 3 should preserve separation between:

- form structural truth;
- semantic interpretation;
- synthetic respondent state;
- draft answers;
- structural answer validation;
- future consistency validation;
- future browser execution.

Question generation must not be architected as isolated stateless calls.

Draft generation should receive:

- whole-form semantics;
- one shared synthetic respondent profile;
- the actual question/schema definition.

The profile must be generic and form-dependent rather than hardcoded to the
current student fixture.

Synthetic data must be clearly marked as synthetic.

Determinism should use an explicit seed/reference-provider contract.

Do not rely on implicit `Math.random()` behavior.

---

## Phase 3 sensitivity boundary

Phase 3 must reuse accepted Phase 2 sensitivity policy.

Draft generation must not create values for fields whose effective policy is:

- `never`;
- `human-reviewed`;
- `specific-authorization`.

Such questions must remain explicitly blocked/deferred in the draft result.

Non-sensitive and `synthetic-allowed` questions may be eligible for synthetic
draft generation.

Do not invent a value merely because the question is required.

A required blocked/unsupported question makes the draft incomplete.

It does not justify bypassing policy.

---

## Phase 3 structural answer boundary

Phase 3 may draft only against accepted structural kinds.

Draft values must validate against the real `FormSchema`.

Examples:

- choice answers must reference real choices;
- scale values must respect accepted bounds;
- grid answers must reference real rows/columns;
- date/time values must satisfy the accepted structural representation;
- question identifiers must exist in the schema.

The semantic provider must not be trusted to invent schema identifiers.

Structural validation belongs to Phase 3.

Cross-answer semantic consistency detection/rewrite belongs to Phase 4.

---

## Phase 3 must NOT implement

Do not implement during Phase 3:

- live Google Forms fetching;
- browser automation;
- Playwright;
- form submission;
- `run`;
- preview approval workflow;
- batch scheduling;
- submission workers;
- random/human-like pacing;
- anti-detection/evasion;
- real cloud-model calls;
- real local-model inference;
- OpenClaw integration;
- Telegram integration;
- cross-answer consistency repair/retry;
- deferred conditional-routing support;
- deferred checkbox-grid detection;
- upload execution.

Do not begin Phase 4 automatically.

---

## Expected Phase 3 verification style

Use targeted tests while implementing.

Run the full regression only for final acceptance.

Expected acceptance commands will include:

```bash
npm run verify:phase3
npm test
npm run typecheck
npm run build
git diff --check
git diff --stat
git status --short
```

The exact Phase 3 test contract belongs in `docs/PHASE_3.md`.

No implementation should begin until that specification exists and has been
reviewed.

---

## Where Phase 3 should start

1. Read `AGENTS.md`.
2. Read this handoff.
3. Read `docs/PHASE_3.md`.
4. Treat `e5b4c2e` as the accepted implementation baseline.
5. Do not broadly re-audit Phase 0/1/2.
6. Inspect only the accepted `src/domain/`, `src/llm/`, policy, schema, and CLI
   interfaces directly needed by Phase 3.
7. Build the native TODO from the Phase 3 requirement IDs.
8. Keep exactly one meaningful milestone in progress.
9. Implement Phase 3 only.
10. Use deterministic/local test providers only.
11. Use targeted tests during implementation.
12. Run complete verification only for final acceptance.
13. Produce the Phase 3 requirement-by-requirement acceptance report.
14. Do not commit.
15. Stop.
16. Do not begin Phase 4.
