# Phase 1 — Google Forms structural parser + analyze pipeline

**Status: NOT STARTED.** Phase 0 is complete and accepted at baseline
`63b2c3e`. Read `AGENTS.md` (permanent rules) and `AGENT_HANDOFF.md` (current
state) before starting.

## Goal

Implement structural analysis for the Google Forms structures that have been
**validated against our authorized real fixture**, producing a provider-neutral
`FormSchema` and a working `form-agent analyze` pipeline.

Phase 1 is **deterministic and offline**. No LLM, no network fetch requirement,
no submission.

## Scope

### MVP supported / real-fixture-validated structures

- short answer
- paragraph
- multiple choice
- checkboxes
- linear scale
- multiple-choice grid
- date
- time
- required vs optional fields
- sequential multi-section/page structure
- normal continue-to-next-section navigation
- terminal submit path
- stable question/section ordering
- structural fingerprint/cache integration as already designed

### Deferred / unvalidated structures

- dropdown
- Rating
- checkbox-grid
- Other / free-text choice
- file upload
- conditional section routing

These remain **represented in the domain model** (`src/domain/types.ts`) and
their representations must **not** be removed merely because they are deferred.
Phase 1 MUST NOT invent undocumented Google payload indices for them or claim
real support. If encountered, represent them as
`{ kind: 'unsupported', ... }` (with a raw hint) or handle them conservatively —
never guess.

### Authorized real fixture

Use the already-sanitized/captured authorized form fixture in the repository:

- `fixtures/archives/observed-responder.html`
- `fixtures/archives/observed-responder.structure.json`

Do **not** submit responses. Do **not** modify the external Google Form.
Live read-only fetching is optional and must never be required for tests.

## Verified fixture facts (Phase 1 golden expectations)

Independently verified from the archived payload:

| Fact | Value |
| --- | --- |
| Title | *Evaluación de experiencia y preferencias del estudiante* |
| Payload items | 32 = 27 questions + 5 page breaks |
| Questions | **27** |
| Sections | **5** |
| Required questions | **4** (3 paragraph + 1 single choice) |
| Conditional routing | none (sequential only) |
| Terminal path | single submit at end of form |

Section titles, in order:

1. `Datos generales`
2. `Experiencia académica presencial sin título`
3. `Experiencia académica virtual`
4. `Organización y satisfacción`
5. `Comentarios finales`

Raw type-code counts → normalized kinds present:

| `g[]` type | Google meaning | Count | Normalized kind |
| --- | --- | --- | --- |
| `0` | short answer | 8 | `text` |
| `1` | paragraph | 3 | `paragraph-text` |
| `2` | multiple choice | 1 | `single-choice` |
| `4` | checkboxes | 3 | `multi-choice` |
| `5` | linear scale | 5 | `linear-scale` |
| `6` | page break | 5 | `SectionBreak` (definitional) |
| `7` | grid | 4 | `multiple-choice-grid` (all rows `role="radio"`, rows 4/4/5/5) |
| `9` | date | 1 | `date` |
| `10` | time | 2 | `time` |

No `dropdown` (`3`), `rating` (`18`), `file-upload` (`13`), `checkbox-grid`,
`Other` option, or conditional branch target appears in this form.

> Note: `docs/phase0.md` prose says short answer ×10 / linear scale ×6. The
> **verified raw counts are ×8 / ×5**, and repository evidence wins. Encode the
> verified counts as the golden expectation.

## Phase 1 requirements

Each requirement has a stable id. The final report must map every id to
evidence (`P1-Rn PASS -> file/test`).

### Parser

- **P1-R1 — Parse the sanitized real fixture.** A parser accepts the archived
  `observed-responder.html` text and returns a `FormSchema`. It must not require
  network access, a browser, or a running Chrome instance.
- **P1-R2 — Extract correct form title/metadata.** `title`, `description`
  (when present), `formId`, `meta.url`, `meta.capturedAt`, `meta.source:
  'fixture'`, `meta.requiresSignIn`. Metadata comes from the embedded payload,
  not from scraping visible text where avoidable.
- **P1-R3 — Detect all 5 sections.** `schema.sections.length === 5`, in document
  order, with ids resolvable by `sectionOfQuestion`.
- **P1-R4 — Detect all 27 questions.** `schema.parts.length === 27` (questions
  only; page breaks are definitional, not questions) and
  `Object.keys(schema.questions).length === 27`.
- **P1-R5 — Preserve question ordering.** `schema.parts` is in rendered
  document order and matches the payload item order; no sorting by label, id, or
  kind.
- **P1-R6 — Assign questions to correct sections.** Every question id appears in
  exactly one section's `questionIds`, and `schema.questionSection` is
  consistent with `schema.sections`. Section 1 receives the questions before the
  first page break, and so on.
- **P1-R7 — Recognize all MVP-supported question types present in the fixture.**
  Normalized kinds and counts must match the golden table: `text` 8,
  `paragraph-text` 3, `single-choice` 1, `multi-choice` 3, `linear-scale` 5,
  `multiple-choice-grid` 4, `date` 1, `time` 2. No question may land in
  `unsupported`.
- **P1-R8 — Distinguish required/optional questions.** `required` is derived from
  the embedded payload flag (`g[0][2] === 1`), not from ARIA. Exactly 4 questions
  are required and 23 optional; the required set is stable and asserted by id.
- **P1-R9 — Parse multiple-choice-grid structure and rows.** All 4 grids keep
  their row labels in order (`g[i][3]`), row counts 4/4/5/5, their column
  choices, and `selectionMode: 'single'` (every row is `role="radio"`). Each row
  gets a stable `GridRow.id`.
- **P1-R10 — Preserve sequential navigation.** Each non-terminal section's
  `routing.default === 'continue'`; ordering of sections is preserved;
  `schema.hasRouting === false` for this fixture.
- **P1-R11 — Identify terminal submit path.** `schema.terminalSectionIds`
  contains exactly the final section, whose `routing.default === 'submit'`.
- **P1-R12 — Produce a provider-neutral `FormSchema`.** Output conforms to
  `src/domain/types.ts` with `providerId === 'google-forms'`,
  `schemaVersion === FORMS_SCHEMA_VERSION`, a consistent `checksum`,
  `rowCount`/`fieldCount` set, and a valid `answerModel`
  (`'flat' | 'grid' | 'multi-section'`). No DOM nodes, Playwright handles, or
  raw HTML leak into the schema.
- **P1-R13 — Stable structural fingerprinting.** Re-parsing the same fixture
  yields an identical `checksum`; `canonicalJson` makes the fingerprint
  insensitive to key order but sensitive to structural change (add/remove/reorder
  a question or section ⇒ different fingerprint). The fingerprint records
  `generatorVersion`.

### Cache / persistence

- **P1-R14 — Cache behavior and invalidation.** Persist the parsed schema keyed
  by `fingerprint_id` (`form_schema` / `analysis_cache`) through the existing
  migrations. A cache hit on the same fingerprint returns the stored schema; a
  changed fingerprint produces a miss and re-parses. **No new migration may edit
  an existing migration** — add new entries only if the existing tables cannot
  serve Phase 1.

### CLI

- **P1-R15 — `analyze` produces useful structural output.** `form-agent analyze
  <url-or-fixture>` parses and prints a human-readable structural summary
  (title, section count/order, question count, per-kind counts, required counts,
  routing, fingerprint). It exits `0` on success and returns the frozen exit
  codes on failure (`2` usage, `3` validation) — no negative codes, no new codes.
- **P1-R16 — Safe handling of unknown/deferred structures.** An item whose type
  code is unknown, or one of the deferred kinds, becomes
  `{ kind: 'unsupported' }` (or a conservatively-parsed representation) carrying
  a raw hint; it never crashes the parse, is never silently dropped, and never
  receives invented field values. A synthetic witness test must prove this.
- **P1-R17 — Read-only fixture access.** Parsing the archived HTML performs no
  writes to the fixture and no network requests. Tests must pass with networking
  unavailable.

### Safety

- **P1-R18 — No form submission capability.** Phase 1 adds **zero** submission
  code paths, no HTTP POST to Google, no Playwright fill/submit, and no
  navigation of a live form. `preview` / `plan` / `run` remain not-implemented
  (exit `2`).
- **P1-R19 — Redaction safety preserved.** Any logged or dumped payload passes
  through the existing redaction pipeline; the numeric Google item-id
  false-positive fix must not regress, and no respondent identity data may be
  introduced into logs or fixtures.
- **P1-R20 — No scope creep into later phases.** No LLM calls, no semantic
  analysis, no profile/answer generation, no Telegram integration.

## Testing and verification

### Required test layers

- **Unit tests** for each normalization decision: type-code → kind mapping,
  required-flag derivation, grid row/choice extraction, ordering, section
  attachment, routing derivation, fingerprint stability.
- **Negative / edge-case tests**: unknown type code, missing/empty payload,
  truncated HTML, a page break with no following questions, a question before the
  first page break, duplicate labels, empty grid rows, malformed JSON, and HTML
  with no `FB_PUBLIC_LOAD_DATA_` block. No input may throw an unhandled error.
- **Real sanitized fixture regression tests** against
  `fixtures/archives/observed-responder.html`. This is the authoritative
  regression source; invented markup may supplement but never replace it.
- **Golden / expected structural result** for the real form, stored as an
  expected-value artifact (JSON or a typed expectation module) and asserted by
  the suite. The golden output must let a human reviewer confirm at a glance:
  - 5 sections, in the documented order
  - 27 questions
  - expected supported question-type counts (8/3/1/3/5/4/1/2)
  - sequential routing with a single terminal submit section
  - exactly 4 required questions, identified by id
- **Targeted Phase 1 verification** command (below).
- **Full regression suite, typecheck, and build** as final acceptance checks.

### Suggested verification command

Add a user-friendly aggregate script during Phase 1 if it fits cleanly:

```bash
npm run verify:phase1
```

It should run the Phase 1 test files plus the golden-fixture assertion, and (if
implemented) the CLI analyze smoke check on the archived fixture, then print a
short PASS/FAIL summary mapped to `P1-R*`. If adding the script is not
appropriate, the equivalent targeted `npx vitest run tests/phase1-*.test.ts`
must be documented in the Phase 1 report instead.

### Suggested targeted commands

```bash
npx vitest run tests/phase1-parser.test.ts
npx vitest run tests/phase1-fixture.test.ts
npx vitest run tests/phase1-golden.test.ts
node bin/form-agent.js analyze fixtures/archives/observed-responder.html
```

### Acceptance evidence table

The Phase 1 report must contain a table of this shape:

```
P1-R1  PASS -> tests/phase1-*.test.ts
P1-R2  PASS -> tests/phase1-*.test.ts
...
P1-R20 PASS -> repository inspection / tests/phase1-no-submit.test.ts
```

plus: targeted results, full regression result, typecheck, build, known
limitations, and `git status`.

## Anti-loop / progress rules

- Before implementation, create a concise TODO list derived from the `P1-R*`
  requirements.
- Keep exactly one TODO in progress where practical.
- If blocked after multiple **distinct** approaches, stop and report the blocker
  (`BLOCKED: <obstacle>, <approaches tried>, <evidence>`) rather than continuing
  indefinitely.
- If several consecutive actions yield no new evidence, no code change, no test
  change, and no diagnosis, stop and report.
- Do not repeat the same command or investigation without new evidence.
- Do not re-run the full regression suite after every edit.
- Do not re-audit Phase 0; use its accepted interfaces.

## Out of scope for Phase 1

- LLM semantic analysis
- synthetic profile generation
- answer generation
- form submission
- Telegram / OpenClaw integration
- implementation of the deferred Google Forms structures listed above
  (dropdown, rating, checkbox-grid, Other/free-text choice, file upload,
  conditional section routing)

## Stop condition

When every Phase 1 acceptance criterion has evidence and final verification
passes, **STOP**. Do not start Phase 2.
> **verified raw counts are ×8 / ×5**, and repository evidence wins. Encode the
> verified counts as the golden expectation.