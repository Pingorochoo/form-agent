# form-agent — Phase 0 scaffolding (complete)

Phase 0 establishes the foundation only: repository layout, TypeScript strict
configuration, CLI skeleton with a stable exit-code contract, configuration
schema and loader, SQLite migrations, redaction-aware logging, the fixture
harness, and the LLM interface with a `FakeProvider`.

No browsing, form analysis, policy enforcement, profile generation, or
submission logic exists yet — those arrive in Phases 1-8.

## Layout

```
bin/form-agent.js        CLI launcher (resolves dist/src/index.js, falls back to TS source)
config/example.yaml      Documented example configuration
docs/phase0.md           This file
src/domain/types.ts      Provider-neutral domain types (FormSchema, questions)
src/domain/semantic.ts   SemanticModel + structured TargetAudience (refinements #2/#3)
src/domain/profile.ts    SyntheticProfile (refinement #4)
src/domain/answer.ts     Answer value model (refinement #5)
src/domain/fingerprint.ts Structural fingerprint (SHA-256 of canonical FormSchema)
src/config/schema.ts     Zod schema for form-agent config
src/config/env.ts        Environment variable loading + validation
src/config/load.ts       Config file discovery, merging, validation
src/cli/exit-codes.ts    Stable exit-code contract
src/cli/index.ts         Command-handler scaffolding + `provider` implementation
src/db/migrations.ts     SQLite migration catalog (1-4)
src/db/database.ts       better-sqlite3 connection, WAL, migration runner
src/llm/types.ts         Provider-neutral LLM types, per-stage string modes
src/llm/interface.ts     ChatCompletionClient interface
src/llm/fake.ts          Deterministic FakeProvider (offline-safe)
src/logging/redact.ts    Redaction of emails, phones, keys, response IDs
src/logging/logger.ts    Sensitive-field-aware structured logger
src/fixtures/index.ts    Fixture registry (inline fixtures + archive loader)
src/fixtures/official-sample.ts Google Forms "Feedback" snapshot
src/fixtures/demo.ts     Multi-question-kind snapshot
src/fixtures/observed-payload.ts   Decoder for real FB_PUBLIC_LOAD_DATA_ payloads
src/fixtures/observed-sanitize.ts  Archive sanitizer (identity/session stripping)
src/index.ts             CLI entry point
scripts/                 Sanitize/decode helpers for the archived real fixture
tests/                   Unit + integration tests (95 total)
```

## Key decisions

- **TypeScript strict + strictest-adjacent flags**: `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noImplicitOverride`,
  `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`
  (Node 24 type-strips; `tsc` emits `.js` with rewritten specifiers).
- **ESM `type: module`**, NodeNext resolution, no bundler.
- **Module boundary**: `src/domain/` is provider-neutral, pure, dependency-free.
  The Phase 1 Google DOM parser produces `FormSchema`; fingerprints,
  SemanticModel, TargetAudience, SyntheticProfile all live here.
- **CLI exit codes are a contract** — see `src/cli/exit-codes.ts`:
  `0` success, `1` error, `2` usage/config, `3` validation, `4` LLM offline,
  `5` LLM connectivity, `127` unknown command. Every code is a **positive**
  integer (0-127); negative exit codes are forbidden (see below).
- **LLM providers are NOT a CLI subcommand.** Phase 0 ships `provider <id>
  --validate` (config + resolve + fake connectivity) and `provider where`; the
  real `openai-compatible` client wiring arrives in Phase 3 (moved earlier per
  the approved refinement #1).
- **`fake` LLM provider ships now** so the offline/free tier and the `4`/`5`
  exit tiers are usable today. Playwright/browser binaries are NOT installed
  in Phase 0.
- **SQLite via `better-sqlite3`**, WAL, foreign keys ON, idempotent migrations.
  `llm_calls` table is Phase 0 because Phase 3 generation wiring depends on
  it; rows land once generation runs.
- **Config**: Zod schema, `.strict()`, JSON/YAML/TS formats, discovery order,
  env > file > defaults. `FORM_AGENT_*` unknown vars warn but don't hard-fail.

## Redaction design

`src/logging/redact.ts` owns the global sensitive-field matrix. Pass order:

1. **Targeted mapping** (label → replacement), stashed behind sentinels so a
   mapped replacement value (e.g. a synthetic email) is not re-redacted by
   the generic passes.
2. **API keys** — key=/token=/Bearer assignment syntax (must precede the
   generic response-ID pass so long assignment values aren't pre-consumed).
3. **Google Form response IDs** — a candidate scan
   (`\b[0-9a-zA-Z_-]{20,}\b`) gates each match through
   `looksLikeGoogleResponseId`, which requires a digit **and** mixed case and a
   `_`/`-` separator (or leading digit). This prevents ordinary long option
   labels (`Supercalifragilisticexpialidocious`,
   `state-of-the-art-technology-stack`) from being silently redacted. Redacted
   by default; `legible` opt-in.
4. **Emails**, 5. **Phones** (phones last so emails won't bleed).

`redactObjectDeep` redacts sensitive-key values recursively and is used by the
logger for structured fields; `sensitive()` logs a whole raw payload under
`_raw`.

## Exit-code contract (frozen)

Every code is a **positive** integer in the 0-127 range. Negative process exit
codes are forbidden: at the OS level a negative value is truncated to an
unsigned byte (`-1` → 255), so they were never portable across shells,
wrappers and language runtimes.

| Code | Meaning | Notes |
| --- | --- | --- |
| 0 | success | |
| 1 | unexpected error or unhandled failure | |
| 2 | user error: bad usage, bad config, invalid input | |
| 3 | validation/consistency failure | |
| 4 | LLM offline / configured model unavailable | was `-1` |
| 5 | LLM connectivity check failed | was `-2` |
| 127 | unknown command | POSIX shell convention |

Codes 6-126 are reserved for future tiers (`src/cli/exit-codes.ts`). The former
`-1`/`-2` meanings are preserved exactly at `4`/`5`, so no behaviour changed —
only the numeric representation. `isValidExitCode` rejects anything outside
`[0, 127]` including negatives and non-integers.

The hard/soft consistency-gate distinction (Phase 4) maps onto 3 vs
warn-and-continue without changing this table.

## Configuration safety

Configuration can be a **data file** or a **program**; they are not equally
trusted:

| Format | Trust level | Why |
| --- | --- | --- |
| **JSON / YAML** | data only (**preferred**) | parsed (`JSON.parse` / `yaml.parse`) then Zod-validated; a malicious document can fail validation but cannot execute |
| **TypeScript** | **trusted executable code** | `.ts` config is `import()`-ed, so it runs arbitrary code with the process's privileges (filesystem, network, credentials, child processes) |

TypeScript configuration files are **trusted executable code**. JSON and YAML
remain the preferred, data-only configuration formats.

Prefer `config/form-agent.json` or `config/form-agent.yaml`. Use a `.ts` config
only when you genuinely need computed values, and review it with the same
standard as application source: the loader does **not** sandbox it. Only point
`--config` at `.ts` files you control and have reviewed; never at a file
downloaded from an untrusted source. This is documented in `src/config/load.ts`
and `config/example.yaml`.

The same rule applies to any future plugin/hook mechanism: executable
configuration is opt-in and trusted, data configuration is the default.

## Commands (Phase 0 status)

| Command | Status |
| --- | --- |
| `form-agent analyze <url>` | scaffolded; exit 2 `not-implemented` |
| `form-agent preview` | scaffolded; exit 2 `not-implemented` |
| `form-agent run` | scaffolded; exit 2 `not-implemented` |
| `form-agent plan <url>` | scaffolded; exit 2 `not-implemented` |
| `form-agent metrics` | scaffolded; exit 2 `not-implemented` |
| `form-agent file <path>` | scaffolded; exit 2 `not-implemented` |
| `form-agent provider <id> --validate` | works (config + fake) |
| `form-agent provider where` | works |
| `form-agent --version` / `--help` | works |

## Validation run (this session)

```
npm install            (97 packages; better-sqlite3 build approved)
npm run typecheck      clean under strict profile
npm test               full suite, all pass (95 tests)
npm run build          tsc emits dist/ with rewritten .js specifiers
node bin/form-agent.js --version            → 0
node bin/form-agent.js provider fake --validate → 0
node bin/form-agent.js provider where       → 0
node bin/form-agent.js analyze <url>        → 2 (not-implemented)
node bin/form-agent.js nonsense-subcommand  → 127
```

## Evidence from the authorized test form (read-only)

Inspected the responder page for
`1FAIpQLSd98rnMrAiFm3vA4FoyGnS0UbOqz-M6qR9ZRqcwSOOx4nWX7w` without submitting,
modifying, or probing submission. The form is titled *Evaluación de experiencia
y preferencias del estudiante* and was authored to exercise question kinds and
section navigation. The page embeds `FB_PUBLIC_LOAD_DATA_` (the authoritative
structural JSON); we decoded **32 items = 27 questions + 5 page breaks**. A
**sanitized** HTML copy and a decoded structure JSON are archived under
`fixtures/archives/`, and the decoded values are asserted by
`tests/fixtures.test.ts` so these findings cannot silently drift.

- **Question types actually present** (Google type code in parentheses) —
  short answer (`0`, ten of them), paragraph (`1`, three), multiple choice
  (`2`, one), checkboxes (`4`, three), linear scale (`5`, six), grid (`7`,
  **four**), date (`9`, one), time (`10`, two), and page breaks/sections (`6`,
  five). **No dropdown (`3`), no rating (`18`), no file upload (`13`), and no
  Other option** appear in this particular form; the model represents them
  anyway so Phase 1 never misclassifies them.
- **Sections** — five page breaks: `Datos generales` → `Experiencia académica
  presencial sin título` → `Experiencia académica virtual` → `Organización y
  satisfacción` → `Comentarios finales`. Each carries a title and a description,
  matching the `FormSection` model. The trailing `sin título` on the second
  section is a real quirk worth preserving rather than normalizing away.
- **Routing** — the modality question (item 5,
  `¿Cuál es tu modalidad principal de estudio?`) is a **short-answer text**
  question, not a multiple choice, and it carries **no conditional
  go-to-section routing**. Decisively: every section id appears **exactly once
  in the whole payload** (asserted as
  `anySectionIdAppearsMoreThanOnce === false`), i.e. never as a branch target.
  This form therefore uses only sequential `continue` navigation with a single
  terminal path to submission. (A downstream section description mentions "the
  route selected", but the routing itself was configured with a plain sequential
  flow.) `RoutingRule` is therefore validated against the synthetic
  `buildRoutedSchema` fixture, which explicitly models the *capability*.
- **Required/optional** — only the final four items (3 paragraph + 1 multiple
  choice) are required, identified by the embedded `g[0][2] === 1` flag. The
  DOM is **not** a reliable source here: only **one** `aria-required="true"`
  appears in the whole page although four questions are required (and it is on
  the *last*, single-choice question). This reinforces that required/optional
  must come from the embedded payload, not from ARIA.
- **Grids** — **four** `type: 7` grids with 4, 4, 5 and 5 rows. Every row is
  single-select (`role="radio"`, 5 radios per 5-column grid), so all four
  normalize to `multiple-choice-grid`, not `checkbox-grid`. Each grid reuses one
  shared column scale and carries per-row labels at `g[i][3]`. No checkbox grid
  is present in this form.
- **Other choices** — none present in this form.
- **Rating** — not present; `linear-scale` (`5`) is what this form uses for
  1–5 ratings, and there is **no** `type: 18` item.
- **Validation metadata** — essentially not discoverable from the renderer; the
  date item carries only a `[0,1]` flag at `g[0][7]` and the time items a `[0]`
  at `g[0][6]`. The field is modelled as optional with a `discoverable` flag for
  exactly this reason.
- **Quiz metadata** — the form is not a quiz; no scoring is exposed.

**Raw structure is embedded, not only in `class` names.** The page ships the
serialized structural payload inline plus a per-item `data-params` copy; Phase 1
should anchor on that embedded data and on ARIA/`data-*` relationships rather
than on the obfuscated Material class names (see the parser-signal research
below).

### Reproducing the findings

```
npm run fixture:sanitize -- <captured.html>   # -> fixtures/archives/observed-responder.html
npm run fixture:decode                        # -> fixtures/archives/observed-responder.structure.json
```

Both scripts are thin wrappers over typed modules
(`src/fixtures/observed-sanitize.ts`, `src/fixtures/observed-payload.ts`) that
the test suite imports directly, so the documentation above is backed by
executable assertions rather than prose.

## Parser selector signals (research only — do NOT implement in Phase 0)

| Signal | Fragility | Use for |
| --- | --- | --- |
| embedded structural JSON (inline `FB_PUBLIC_LOAD_DATA_`) | **lowest** | preferred primary source |
| `name="entry.<id>"` / `entry.<id>_sentinel` | **low** | per-question ids in the DOM |
| `data-params` (27) | **low** (serialized item payload) | authoritative per-item metadata |
| `data-item-id` (5, page-break containers only) | **low** | section identity — NOT per-question |
| `role="heading"` + `aria-level` (33: 1/5/27 by level) | moderate | form/section/question title by level |
| `role="radiogroup"` / `role="radio"` / `role="checkbox"` | moderate | choice grouping, grid shape, single-vs-multi |
| `role="group"` / `listbox` / `option` | moderate | time and date pickers |
| `aria-required` (1) | **unreliable** | do NOT use for required/optional |
| `jsmodel` / `jsname` / `jscontroller` | medium (Angular-generated) | item container + widget tie-breaker |
| `freebird*` / `docssharedWiz*` / `Qr7Oae` class names | **highest (fragile)** | avoid as sole basis — obfuscated and version-drifting |

Measured against the sanitized archive (literal occurrence counts in the real
page): embedded `FB_PUBLIC_LOAD_DATA_` payload (1) plus `name="entry.<id>"` (27);
`data-params` (27); `data-item-id` (5, all page-break containers); `jsmodel=
"CP1oW"` (27); `role="heading"` (33: 1× `aria-level` 1 = form title, 5×
`aria-level` 2 = section titles, 27× `aria-level` 3 = question titles);
`role="radiogroup"` (24, including 4–5 per grid); `role="radio"` (188) vs
`role="checkbox"` (18); `role="group"`/`role="listbox"`/`role="option"`
(2/2/4, time and date pickers); `role="alert"` (32); `aria-describedby` (126);
`aria-labelledby` (27); `aria-required` (1); obfuscated classes `Qr7Oae` (32),
`OxAavc` (5), `meSK8` (5), `spb5Rd` (5), `OIC90c` (144), `o3Dpx` (1) and
**zero** `freebird*` viewer classes.

Do not build the Phase 1 parser on class names such as
`freebirdFormviewerViewItemsItem` or `docssharedWizToggleLabeled`. Prefer the
embedded data plus ARIA/`data-*` relationships, and use class names only as a
last-resort tie-breaker.

- `FormSchema`, `SemanticModel`, `TargetAudience`, `SyntheticProfile`,
  `ResolvedAnswer` are the provider-neutral contracts the DOM parser (Phase 1)
  and the answer layer (Phase 3) must satisfy.
- The fixture harness serves `https://fixtures.local/forms/{official,demo}` —
  an allowlist-safe URL family for CI replay.
- `config/example.yaml` documents the `local` openai-compatible provider slot
  (disabled by default) ready for Phase 3 wiring.
- The `demo` fixture exercises every supported question kind for the Phase 1
  parser regression suite.

## Phase 0 follow-up decisions (final)

### #1 — Exit codes are positive-only

`-1`/`-2` were replaced by `4`/`5`. Meanings preserved; no negative codes.
See the frozen table above and `tests/exit-codes.test.ts`.

### #2 — FormSchema question kinds

`QuestionKind` is now the single source of truth and is a superset of the MVP's
fillable set: `text`, `paragraph-text`, `single-choice`, `multi-choice`,
`dropdown`, `linear-scale`, `rating`, `multiple-choice-grid`, `checkbox-grid`,
`date`, `time`, `file-upload`, `unsupported`.

- **Rating** is a single first-class kind (`RatingQuestion` with `style:
  'star' | 'smiley' | 'heart' | 'thumb'` and `maxRating`), replacing the
  earlier `star-rating`/`smiley-rating` split. It shares the `isScaleQuestion`
  guard with `linear-scale`.
- **Grids are normalized into two explicit kinds** — `multiple-choice-grid`
  (one answer per row) and `checkbox-grid` (many per row). `ChoiceGridQuestion`
  additionally exposes a read-only `selectionMode: 'single' | 'multi'` so the
  execution layer need not re-derive the fact.
  **Decision (documented, not implied):** Google exposes a single embedded
  grid type code (`7`) for both layouts, so the parser must decide single- vs
  multi-select from the rendered row controls (`role="radio"` rows →
  `multiple-choice-grid`, `role="checkbox"` rows → `checkbox-grid`) rather than
  from the type code, and the two-kind split (plus `selectionMode`) is retained
  over a single `grid` kind because the answer layer needs the difference
  explicitly. All four grids in the real test form are `role="radio"` rows, so
  every one of them normalizes to `multiple-choice-grid`; no `checkbox-grid` has
  been observed yet (see Remaining concerns).
- **Unsupported types are explicit.** `UnsupportedQuestion` carries the raw
  `rawTypeHint` and a human `reason`; the parser must emit it rather than
  coercing an unknown shape into a supported one. `file-upload` is represented
  fully (size/count/type limits) but flagged `supported: false`.
- **Choice metadata**: `ChoiceOption[]` + `otherLabels` + `isOtherOpen`
  capture Other/free-text choices; `isConsistentChoiceContainer` is a
  self-check that `choices` and `options` stay aligned.
- **Validation/quiz**: optional `ResponseValidation` (`number` |
  `text-length` | `regex` | `unknown`) and `QuizScoring` metadata on the
  relevant kinds, populated only when discoverable.
- `FORMS_SCHEMA_VERSION` is bumped to `2`. `tests/schema.test.ts` asserts all
  of the above.

### #3 — Sections and routing are first-class

`FormSchema.sections` is ordered and each `FormSection` keeps `title`,
`description`, `questionIds` (ordering preserved), `slot`, `index` and a
`routing` block: `{ default: 'continue' | 'submit' | sectionId,
conditional: boolean, rules: { choiceLabel, target }[] }`. Helpers:
`sectionOfQuestion`, `resolveNavigationTarget(schema, sectionId, signal)`, and
`reachableSectionIds`. A sectionless form becomes one implicit section
(`DEFAULT_SECTION_ID = '__default__'`). No navigation information is flattened
away. Terminal paths are recorded in `routing.default === 'submit'` and mirrored
in the schema-level `terminalSectionIds` (its `hasRouting` flag is true only
when conditional rules exist).

### #4 — Findings from the authorized test form (read-only)

The responder page embeds `FB_PUBLIC_LOAD_DATA_`, the authoritative structural
JSON, which we decoded: **32 items = 27 questions + 5 page breaks**. A sanitized
copy plus the decoded structure JSON are archived as fixtures, and the values
below are asserted in `tests/fixtures.test.ts`.

- **Question types present**: short answer (type 0, ×10), paragraph (1, ×3),
  multiple choice (2, ×1), checkboxes (4, ×3), linear scale (5, ×6), grid
  (7, ×4) — all served as `multiple-choice-grid` because every grid row is
  single-select — date (9, ×1), time (10, ×2), and page breaks/sections
  (6, ×5). **No dropdown (3), no rating (18), no file upload (13) and no Other
  option** appear in this particular form.
- **Sections (5)**: `Datos generales` → `Experiencia académica presencial sin
  título` → `Experiencia académica virtual` → `Organización y satisfacción` →
  `Comentarios finales`. Each carries a title and a description.
- **Grids (4)**: rows 4/4/5/5, all single-select (`role="radio"`); row labels are
  read from each row tuple (`g[i][3]`) and the column scale is shared across
  rows. No checkbox grid is present.
- **Required fields**: only the final four items (3 paragraph + 1 multiple
  choice) are required; the embedded `g[0][2] === 1` flag identifies them.
  Notably the DOM is **not** a reliable source here — only **one**
  `aria-required="true"` appears in the whole page (on the last question)
  although four questions are required. This reinforces that required/optional
  must come from the embedded payload, not from ARIA.
- **Routing**: the modality question (`¿Cuál es tu modalidad principal de
  estudio?`, item 5) is a **short answer, not a multiple choice**, and it
  contains **no conditional routing**. The section ids appear exactly once in
  the whole payload (`anySectionIdAppearsMoreThanOnce === false`), i.e. never as
  a branch target, so this form uses only normal sequential `next-section`
  navigation with a single terminal path to submission. (`buildRoutedSchema` in
  the test support therefore models the *capability*, and is explicitly labelled
  as such.)
- **Validation metadata**: essentially not discoverable here; the date item
  carries only a `[0,1]` flag at `g[0][7]` and the time items a `[0]` at
  `g[0][6]`. The schema represents validation as optional with a `discoverable`
  flag for exactly this reason.
- **Rating / quiz metadata**: this form is not a quiz and exposes no rating
  widget, so no scoring or star-scale data is present.

The findings are machine-checked by
`tests/fixtures.test.ts > observed payload decoder`, which re-decodes the
committed archive with `src/fixtures/observed-payload.ts`.

### #5 — Parser selector assumptions (research only, no parser yet)

Useful/structural signals observed in the real DOM:

- `FB_PUBLIC_LOAD_DATA_` — **the** preferred source: a stable, typed,
  language-independent serialization of the whole form (title, description,
  every item, choices, required flags, section breaks and their titles). It is
  the only signal that carried *all* of: sections, required flags and (where
  present) routing. Pair it with the `name="entry.<id>"` /
  `entry.<id>_sentinel` hidden inputs, which give the same per-question ids in
  the DOM.
- `data-params` on each question container — a per-item copy of the same
  payload (HTML-entity encoded), useful when the block-level script is pruned.
  Present on all 27 questions.
- `data-item-id` — present only on the **5 page-break containers**, where it
  carries the same numeric id as the section break in the embedded JSON. It is
  NOT emitted on ordinary question containers in this render, so it keys
  *sections*, not questions.
- `role`/`aria-*` semantics: `list`, `listitem`, `heading` (+`aria-level`),
  `radiogroup`, `radio`, `checkbox`, `combobox`, `listbox`, `option`, `group`,
  `alert`, `aria-describedby`, `aria-labelledby`. Section titles are
  `aria-level="2"`, question titles `aria-level="3"`.
- `jsname`/`jscontroller` identifiers and the `role=list`/`listitem` item
  structure, as a secondary tie-breaker (`jsmodel="CP1oW"` marks the 27 item
  containers).

Signals that appear fragile and must not be the sole basis:

- Obfuscated CSS class names — the real page uses `Qr7Oae`, `OxAavc`, `meSK8`,
  `M7eMe`, `spb5Rd`, `OIC90c`, `o3Dpx`, and **zero** `freebird*` classes. The
  hand-written `freebirdFormviewerViewItems*`/`docssharedWizToggleLabeled`
  classes exist only in our invented fixtures. Class names are minified and
  change without notice.
- `aria-required` — observed on only 1 of the 4 required questions in the real
  form; do not use it as the required/optional source.
- Visible text/labels for classification (locale-dependent).
- Inferring grid single- vs multi-select from CSS classes: use the per-row
  `role="radio"` vs `role="checkbox"` instead.

Guidance for Phase 1: prefer `FB_PUBLIC_LOAD_DATA_` (plus `data-params` /
`entry.*` names and ARIA structure as corroboration), classify grid selection
mode from row roles, treat class names as a last-resort heuristic behind a
`generatorVersion`-tracked fallback, and keep the archived real fixture in the
regression suite so invented markup is never the only coverage. The existing
`demo`/`official` inline fixtures remain valid as unit fixtures, but must not be
the sole basis for parser selectors.

### #6 — Response-ID redaction false positive (fixed)

Documented above. `looksLikeGoogleResponseId` gates the candidate scan;
regression tests in `tests/redact.test.ts` cover long option labels. The
complementary archive-fixture regression (numeric Google item ids must never be
phone-redacted) lives in `tests/sanitize.test.ts` and `tests/fixtures.test.ts`,
since the same digit-run ambiguity previously corrupted the embedded payload.

### #7 — Configuration safety

Documented above: JSON/YAML are the preferred data-only formats; `.ts` config
is trusted executable code. The policy is stated in three places that now agree:
`src/config/load.ts` (module header + the `.ts` branch), `config/example.yaml`,
and this document.

### #8 — Documentation reflects the finalized decisions

This document is the Phase 0 record. The frozen exit-code table (Fix #1),
redaction pipeline with the response-ID guard (Fix #6), configuration-safety
policy (Fix #7), the finalized FormSchema kinds/grids/rating (#2), first-class
sections and routing (#3), the read-only observations from the authorized form
(#4), the parser-signal research table (#5), and the read-only evidence section
were all updated together so no two sections contradict each other. The
archived sanitized fixture and its decoded structure JSON are recorded below,
and the sampling in `tests/support/sample-schema.ts` mirrors the real form's
27-question / 5-section / 4-grid shape instead of an invented one.

### Archived fixture

`fixtures/archives/observed-responder.html` — a **sanitized** copy of the
authorized responder page (fetched read-only; no response was submitted and the
form was not modified). Intended for the Phase 1 parser regression suite.
`fixtures/archives/observed-responder.structure.json` is the decoded
`FB_PUBLIC_LOAD_DATA_` payload for the same page (27 questions, 5 sections,
no conditional routing).

Both files are reproducible from the raw capture:

```
npm run fixture:sanitize -- <captured.html>   # archive HTML
npm run fixture:decode                        # structure JSON
```

(or call `node scripts/…` directly)

The sanitizer's contract is regression-tested in `tests/sanitize.test.ts`, and
the decoded structure is asserted in `tests/fixtures.test.ts`.

## Remaining concerns before Phase 1

1. The embedded `FB_PUBLIC_LOAD_DATA_` shape is **undocumented and
   version-specific**. The archived real fixture plus the `generatorVersion`
   stamp on fingerprints are the mitigation. Phase 1 should parse that payload
   as the primary source, use `data-params`/`entry.*`/ARIA as corroboration, and
   keep class names only as a last-resort fallback.
2. This one test form does **not** exercise dropdown (`3`), rating (`18`),
   file upload (`13`), checkbox grids, or an "Other" free-text choice. Those
   kinds are structurally represented and unit-tested against synthetic
   witnesses, but **no real markup for them has been captured**. A second form
   with those features should be captured read-only (same two scripts) before
   Phase 1 hard-codes their selectors or `g[]` indices.
3. `linear-scale` (`5`) and `rating` (`18`) both render as ordinal scales; the
   observed form uses linear scale for its 1–5 ratings, so the `rating`
   normalization (and its `style` discriminator) is currently unvalidated
   against real markup.