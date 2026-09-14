# AGENT_HANDOFF.md — current state

**Short current-state handoff. Not a history dump.** Task definitions belong in
`docs/PHASE_N.md`; permanent rules belong in `AGENTS.md`.

## Status

| Item | Value |
| --- | --- |
| Phase 0 | **COMPLETE and ACCEPTED** |
| Phase 0 baseline | `63b2c3e` — `feat: complete phase 0 foundation` |
| Phase 1 | **COMPLETE and ACCEPTED** |
| Accepted implementation baseline | `309f097` — `feat: complete phase 1 structural analysis` |
| Phase 2 | **NOT STARTED** |
| Current phase spec | `docs/PHASE_2.md` |
| Tests at Phase 1 acceptance | **162 passing across 16 files** |
| Phase 1 targeted verification | **67 passing across 6 files** |
| Typecheck / build | **clean** |
| Working tree at Phase 1 acceptance | **clean** |

Phase 2 planning documentation may be newer than the accepted implementation
baseline. `309f097` remains the accepted code baseline until Phase 2 itself is
implemented, independently reviewed, and committed.

---

## Source of truth

If sources conflict, earlier items win:

1. repository code
2. tests
3. git history
4. phase specifications (`docs/PHASE_N.md`)
5. handoff documentation (this file)

Do **not** broadly reconstruct, re-audit, or reimplement accepted Phase 0 or
Phase 1 work.

Inspect accepted earlier-phase code only when:

- Phase 2 directly depends on that interface;
- a relevant regression test fails; or
- repository evidence contradicts a documented contract.

The accepted baseline exists so previous work can be trusted and verified,
not continuously re-derived.

---

## Essential architecture

- `src/domain/` — provider-neutral, pure, dependency-free domain models,
  structural fingerprinting, sections/routing types, semantic/profile/answer
  types reserved for later phases.
- `src/config/` — Zod-based configuration and config discovery.
- `src/cli/` — CLI handlers and frozen exit-code contract.
- `src/db/` — `better-sqlite3`, WAL, FK ON, idempotent migrations.
- `src/parser/google-forms.ts` — accepted Phase 1 offline Google Forms
  structural parser.
- `src/analyze/` — accepted Phase 1 input resolution, structural analysis,
  cache/persistence integration, and human-readable summary.
- `src/llm/` — provider interface + deterministic fake provider; no real LLM
  is used by Phase 1 or Phase 2.
- `src/logging/` — redaction + structured logger.
- `src/fixtures/` — sanitized fixture/archive loading and embedded-payload
  decoding.
- `bin/form-agent.js` — CLI launcher.

Permanent module boundary:

`src/domain/` must remain free of I/O, DB, network, browser, and LLM imports.

Phase 2 policy code should remain separate from Phase 1 structural parsing
unless a direct contract requires otherwise.

---

## Accepted Phase 1 behavior

Phase 1 is accepted at `309f097`.

### Structural parser

`src/parser/google-forms.ts`:

- parses sanitized responder-page HTML offline;
- extracts `FB_PUBLIC_LOAD_DATA_` through the accepted Phase 0 decoder;
- produces provider-neutral `FormSchema`;
- preserves question order and section assignment;
- derives required state from the embedded payload flag;
- supports fixture-validated type codes:
  - `0` text
  - `1` paragraph-text
  - `2` single-choice
  - `4` multi-choice
  - `5` linear-scale
  - `7` multiple-choice-grid
  - `9` date
  - `10` time
- maps distinct deferred/unknown types conservatively to `unsupported`;
- throws controlled `GoogleFormsParseError` for malformed non-array items;
- derives linear-scale bounds from numeric step labels when available;
- performs no network, browser, submission, or LLM activity.

### Deferred structural behavior

The following remain deliberately unvalidated/deferred:

- dropdown;
- rating;
- file upload;
- checkbox-grid detection;
- "Other" free-text choice handling;
- conditional routing.

Important:

Google Forms checkbox grids share payload type code `7` with the validated
single-select grid shape. Phase 1 cannot distinguish them from the embedded
payload alone because the distinguishing role is in DOM markup that the parser
does not consume.

Therefore accepted Phase 1 behavior emits type `7` as
`multiple-choice-grid` / `selectionMode: 'single'`, the only real-fixture shape
validated so far.

Conditional routing is not parsed. Accepted routing is sequential
`continue` / terminal `submit`, with `hasRouting === false`.

Do not invent undocumented payload indices to add deferred support.

### Accepted real fixture facts

Sanitized authoritative fixture:

`fixtures/archives/observed-responder.html`

Accepted facts:

- 5 sections;
- 27 questions;
- 4 required questions;
- 32 payload items total: 27 questions + 5 page breaks;
- 4 validated single-select grids with row counts 4/4/5/5;
- sequential routing;
- one terminal submit section.

Normalized counts:

- text: 8
- paragraph-text: 3
- single-choice: 1
- multi-choice: 3
- linear-scale: 5
- multiple-choice-grid: 4
- date: 1
- time: 2

The committed golden artifact is:

`tests/golden/observed-responder.schema.json`

---

## Phase 1 analyze / cache contracts

Accepted analysis modules:

- `src/analyze/analyze.ts`
- `src/analyze/resolve-input.ts`
- `src/analyze/store.ts`

`form-agent analyze` now works for local Phase 1 inputs.

Accepted input forms include:

- sanitized local file path;
- fixture id;
- fixture URL handled by the local fixture harness.

Live HTTP Google Forms fetching is NOT implemented.

A live Google Forms URL is rejected rather than fetched.

Analysis is:

- offline;
- read-only with respect to the fixture;
- submission-free;
- LLM-free.

Structural schemas are persisted using the existing Phase 0 database design,
keyed by structural fingerprint.

The fingerprint excludes ephemeral input metadata such as current
`meta.url` / `meta.capturedAt`.

On a cache hit, accepted behavior reuses the cached structural schema while
preserving current-invocation metadata.

Phase 1 parser generator version:

`GOOGLE_FORMS_PARSER_VERSION = 0.1.0`

---

## Database state

Accepted migrations are currently **1-4**.

Existing database structures include:

- `meta`
- `forms`
- `form_schema`
- `analysis_cache`
- `llm_calls`

Phase 1 actively uses:

- `forms`
- `form_schema`
- `analysis_cache`

`form_schema` is keyed by `fingerprint_id`.

Do not mutate existing migration definitions.

If Phase 2 genuinely requires new durable authorization or rate-policy state
that existing tables cannot represent, append only the minimal new migration
and test migration/reopen behavior.

The real database file remains gitignored under `.data/`.

---

## Exit-code contract

Frozen CLI mapping:

- `0` success
- `1` error
- `2` usage/config
- `3` validation
- `4` LLM offline
- `5` LLM connectivity
- `127` unknown command

Codes `6-126` remain reserved.

Do not renumber or repurpose accepted codes without an explicit phase
specification change.

---

## Current CLI state relevant to Phase 2

Implemented:

- version/help foundation;
- provider inspection/validation foundation;
- `analyze` for accepted local/fixture inputs.

Still intentionally unimplemented:

- `preview`
- `run`
- future answer/execution flows

Phase 2 adds policy/authorization CLI behavior described only by
`docs/PHASE_2.md`.

Authorization must not itself perform execution.

---

## Current LLM state

Only deterministic/foundation LLM infrastructure from Phase 0 exists.

Phase 2 must remain LLM-free.

Do not add:

- semantic whole-form inference;
- respondent/profile generation;
- answer generation;
- real provider inference;
- cloud model calls.

Those belong to later phases.

---

## Phase 2 objective

Current phase:

**Phase 2 — Policy and Authorization**

Specification:

`docs/PHASE_2.md`

Phase 2 creates the safety gates that future execution features must consume.

Primary scope:

- explicit durable authorization / allowlisting;
- revocation and authorization inspection;
- deterministic sensitive-field classification;
- configurable sensitive-field rules;
- central `PolicyEngine`;
- stable machine-readable policy reason codes;
- safety-mode gating;
- deterministic/durable rate-policy state;
- optional policy visibility in `analyze`;
- regression guards preventing future-phase scope creep.

Core principle:

**deny future execution by default.**

Successful parsing, local fixture presence, previous analysis, cached schemas,
or form identity must never implicitly grant execution authorization.

---

## Phase 2 must NOT implement

Do not implement:

- respondent/profile generation;
- semantic answer generation;
- answer consistency logic;
- preview approval workflow;
- Playwright/browser execution;
- live network form fetching;
- Google Form submission;
- scheduling/submission workers;
- randomized human-like pacing;
- anti-detection/evasion logic;
- deferred conditional routing;
- deferred checkbox-grid support;
- file uploads;
- real LLM calls;
- OpenClaw;
- Telegram.

`preview` and `run` remain unavailable after Phase 2.

Do not begin Phase 3 automatically.

---

## Phase 2 design boundaries

### Authorization

Authorization means only that a canonical target is explicitly allowlisted for
a supported future execution scope.

It does not imply:

- sensitive-field permission;
- human approval;
- answer approval;
- rate-policy eligibility;
- execution.

### Sensitive classification

Prefer a policy-layer assessment over mutating the accepted structural parser.

Classification is deterministic and LLM-free.

When several sensitivity rules match, the effective policy uses the most
restrictive mode defined by `docs/PHASE_2.md`.

File upload is always sensitive and `never` for the MVP.

### Rate policy

Rate controls are safety limits, not anti-detection behavior.

Phase 2 may:

- evaluate allow/deny;
- persist counters/state;
- expose stable reason codes;
- return deterministic retry-after information.

Phase 2 must NOT:

- sleep;
- randomly delay;
- imitate humans;
- submit;
- schedule batches;
- create an executor.

Tests should inject time rather than waiting on wall-clock sleeps.

---

## Commands to validate the accepted repository

```bash
npm run verify:phase1
npm test
npm run typecheck
npm run build

node bin/form-agent.js analyze fixtures/archives/observed-responder.html

```
Accepted Phase 1 verification:

- Phase 1 targeted: 67 passing
- full regression: 162 passing
- typecheck: clean
- build: clean
- analyze smoke: exit 0

Phase 2 final verification additionally follows `docs/PHASE_2.md`.

---

## Where Phase 2 should start

1. Read `AGENTS.md`.
2. Read this handoff.
3. Read `docs/PHASE_2.md`.
4. Treat `309f097` as the accepted implementation baseline.
5. Do not broadly re-audit Phase 0/1.
6. Inspect only existing interfaces directly needed by Phase 2.
7. Convert P2-R1 through P2-R20 into 6-8 visible milestones.
8. Keep exactly one milestone in progress.
9. Implement policy/authorization infrastructure only.
10. Use targeted tests during implementation.
11. Run complete verification only for final acceptance.
12. Produce the P2-R1..P2-R20 acceptance report.
13. Do not commit.
14. Stop.
15. Do not begin Phase 3.