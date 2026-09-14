# AGENT_HANDOFF.md — current state

**Short current-state handoff. Not a history dump.** Task definitions belong in
`docs/PHASE_N.md`; permanent rules belong in `AGENTS.md`.

## Status

| Item | Value |
| --- | --- |
| Phase 0 | **COMPLETE and ACCEPTED** |
| Accepted baseline commit | `63b2c3e` — `feat: complete phase 0 foundation` |
| Phase 1 | **NOT STARTED** |
| Working tree at acceptance | **clean** (baseline commit contains all Phase 0 files) |
| Tests | 95 passing across 10 files |
| Typecheck / build | clean |

## Source of truth

If sources conflict, earlier items win:

1. repository code
2. tests
3. git history
4. phase specifications (`docs/PHASE_N.md`)
5. handoff documentation (this file)

Do **not** reconstruct or re-audit Phase 0 unless concrete evidence requires it
(a failing regression test, a direct interface conflict with the current phase,
or repository evidence contradicting the documented baseline). The accepted
baseline is recorded above so it can be verified, not re-derived.

## Essential architecture

- `src/domain/` — provider-neutral, pure, dependency-free. `FormSchema`,
  `Question` union, sections + routing graph, `StructuralFingerprint`,
  semantic/profile/answer models.
- `src/config/` — Zod schema (`.strict()`), env merge, JSON/YAML/TS discovery.
- `src/cli/` — frozen exit-code contract + command handlers.
- `src/db/` — `better-sqlite3`, WAL, FK ON, idempotent migrations.
- `src/llm/` — `ChatCompletionClient` + deterministic `FakeProvider`.
- `src/logging/` — redaction matrix + structured logger.
- `src/fixtures/` — inline fixtures, archive loader, real-payload
  decoder/sanitizer.
- `bin/form-agent.js` — CLI launcher: `dist/src/index.js`, else TS source.

Module boundary: `src/domain/` must stay free of I/O, LLM and DB imports. The
Phase 1 parser consumes/produces these types; it must not pull provider or
network concerns into the domain layer.

## Contracts / interfaces Phase 1 depends on

These already exist and are tested — Phase 1 should **use** them, not redefine
them.

| Interface | Location | Notes |
| --- | --- | --- |
| `FormSchema` + `Question` union | `src/domain/types.ts` | 13 kinds; `FORMS_SCHEMA_VERSION = 2`; bump only if the shape changes |
| `DEFAULT_SECTION_ID` | `src/domain/types.ts` | `'__default__'` — implicit single section |
| `FormSection` / `SectionRouting` / `RoutingRule` | `src/domain/types.ts` | `default: 'continue' \| 'submit' \| sectionId`; `conditional` + `rules` |
| `NavigationTarget` | `src/domain/types.ts` | `'submit'` / `'continue'` sentinels — never raw indices |
| `sectionOfQuestion`, `resolveNavigationTarget`, `reachableSectionIds` | `src/domain/types.ts` | routing helpers already implemented |
| Guard helpers (`isGridQuestion`, `isScaleQuestion`, …) | `src/domain/types.ts` | use these instead of string comparisons |
| `structuralFingerprint`, `jsonFingerprint`, `canonicalJson`, `sha256Hex` | `src/domain/fingerprint.ts` | `FINGERPRINT_VERSION = 1`; input `{providerId, formId, formJson, generatorVersion}` |
| `MIGRATIONS` + `FormAgentDatabase.open()` | `src/db/` | add tables via **new** migration entries only |
| `ExitCodes` + `describeExitCode` | `src/cli/exit-codes.ts` | frozen positive-only mapping |
| `handleCmdAnalyze` | `src/cli/index.ts` | currently throws `NotImplementedError` → exit 2 |
| `loadFixture(id)` / `tryLoadArchive(id)` | `src/fixtures/index.ts` | archive first, then inline |
| `extractPayload` / `decodeEmbeddedPayload` | `src/fixtures/observed-payload.ts` | Phase 0 research decoder — reuse, do not fork |
| `sanitizeResponderHtml` | `src/fixtures/observed-sanitize.ts` | archive sanitizer (numeric ids preserved) |

### Exit-code contract (frozen)

`0` success · `1` error · `2` usage/config · `3` validation · `4` LLM offline ·
`5` LLM connectivity · `127` unknown command. Codes `6-126` reserved. Negative
codes are forbidden.

## Current database / LLM / fixture state

- **Database**: migrations **1-4** exist — `meta`, `forms`, `form_schema`,
  `analysis_cache`, `llm_calls`. `form_schema` is keyed by `fingerprint_id` and
  stores `schema_version` + `generator_version`; `analysis_cache` is keyed by
  `fingerprint_id`. `llm_calls` exists for the Phase 3 dependency; **no rows
  land yet**. The real DB file is gitignored under `.data/`.
- **LLM**: only the `fake` provider is wired. `provider <id> --validate` and
  `provider where` work; the `openai-compatible` client arrives in Phase 3.
  Phase 1 must not require an LLM.
- **Fixtures**: `fixtures/archives/observed-responder.html` (sanitized real
  responder page; read-only capture — the live form was never modified and no
  response was submitted) and `observed-responder.structure.json` (decoded
  structure). Inline `official`/`demo` fixtures are invented markup and must
  never be the sole basis for parser selectors.

### Verified real-form facts (golden expectations for Phase 1)

- Title: *Evaluación de experiencia y preferencias del estudiante*; **not** a
  quiz.
- **27 questions, 5 sections, 4 required**, 32 payload items
  (27 questions + 5 page breaks).
- Section titles in order: `Datos generales`, `Experiencia académica presencial
  sin título`, `Experiencia académica virtual`, `Organización y satisfacción`,
  `Comentarios finales`.
- Raw type-code counts: `0` short answer = **8**, `1` paragraph = **3**,
  `2` multiple choice = **1**, `4` checkboxes = **3**, `5` linear scale = **5**,
  `6` page break = **5**, `7` grid = **4**, `9` date = **1**, `10` time = **2**.
- All 4 grids are single-select (`role="radio"`) → `multiple-choice-grid`, with
  row counts 4/4/5/5.
- Required flags come from `g[0][2] === 1`. Only the final 4 questions are
  required (3 paragraph + 1 single choice).
- Routing: sequential only; no conditional rules; single terminal submit path.

## Commands to validate the repository

```bash
npm install
npm test              # full regression suite
npm run typecheck
npm run build

# targeted
npx vitest run tests/schema.test.ts

# CLI smoke (analyze currently exits 2: not-implemented)
node bin/form-agent.js --version
node bin/form-agent.js provider where
node bin/form-agent.js analyze https://docs.google.com/forms/d/e/1FAIpQLSd98rnMrAiFm3vA4FoyGnS0UbOqz-M6qR9ZRqcwSOOx4nWX7w/viewform
```

## Known limitations relevant to Phase 1

1. The embedded `FB_PUBLIC_LOAD_DATA_` layout is **undocumented and
   version-specific**. Anchor on it (plus `data-params` / `entry.*` names and
   ARIA) rather than obfuscated CSS classes; stamp `generatorVersion` so caches
   invalidate.
2. The form has **no** dropdown, rating, file upload, checkbox grid, "Other", or
   conditional routing. Those are structurally represented in the domain model
   but **unvalidated against real markup** — Phase 1 must not invent payload
   indices for them, and must **not** remove their domain representations.
3. `data-item-id` appears only on page-break containers (5), not on questions;
   per-question identity must come from `data-params` / `entry.*` names.
4. `aria-required` appears on only 1 of 4 required questions — required state
   must come from the embedded `g[0][2] === 1` flag.
5. `docs/phase0.md` prose states short answer ×10 / linear scale ×6; the
   **verified raw counts are ×8 / ×5**. Repository evidence wins. Phase 1 should
   encode the verified counts as its golden expectation.
6. `analyze` currently returns exit `2` (`not-implemented`). Phase 1 changes the
   behavior but must keep the exit-code contract.

## Where Phase 1 should start

1. Read `AGENTS.md` and `docs/PHASE_1.md`.
2. Turn the `P1-R*` requirements into a visible TODO list.
3. Begin at **P1-R1**: parse `fixtures/archives/observed-responder.html`, extract
   `FB_PUBLIC_LOAD_DATA_`, and produce a provider-neutral `FormSchema` matching
   the verified facts above (5 sections, 27 questions, ordering, required flags,
   4 single-select grids, sequential routing, terminal submit path).
4. Wire the structural fingerprint + cache integration already designed in
   `src/domain/fingerprint.ts` and the Phase 0 migrations.
5. Make `form-agent analyze` emit useful structural output.
6. Keep the whole phase LLM-free and submission-free.

Do not begin Phase 2. Stop when every Phase 1 acceptance criterion has evidence
and final verification passes.