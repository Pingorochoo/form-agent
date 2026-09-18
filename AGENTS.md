# AGENTS.md — permanent rules for coding agents

Permanent operating rules for every agent working in this repository.
Phase-specific work is defined in `docs/PHASE_N.md`; current state lives in
`AGENT_HANDOFF.md`.

## Project

`form-agent` — deterministic-first, AI-assisted Google Forms structural analysis
and authorized test automation, delivered in numbered phases (0-9). The CLI is
the interface; SQLite is the local store; a provider-neutral LLM layer is used
only where deterministic logic is insufficient.

## Architecture (high level)

- `src/domain/` — provider-neutral, pure, dependency-free types
  (`FormSchema`, questions, sections/routing, fingerprints, semantic/profile/
  answer models). No I/O, no LLM, no DB here.
- `src/config/` — Zod config schema, env loading, file discovery/merge.
- `src/cli/` — exit-code contract + command handlers.
- `src/db/` — `better-sqlite3` connection (WAL, FK on) + migration catalog.
- `src/llm/` — `ChatCompletionClient` interface + deterministic `FakeProvider`.
- `src/logging/` — redaction + structured, sensitive-field-aware logger.
- `src/fixtures/` — inline fixtures, archive loader, and the real-payload
  decoder/sanitizer.
- `bin/form-agent.js` — CLI launcher (uses `dist/`, falls back to TS source).
- `tests/` — vitest unit/integration tests. `fixtures/archives/` — archived
  real fixture used as a regression source of truth.

Phases add tables to the migration catalog — **never** by editing existing
migrations.

## Standard commands

```bash
npm test            # full regression suite (vitest run)
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/

# targeted development loop
npx vitest run tests/<file>.test.ts

# CLI smoke
node bin/form-agent.js --version
node bin/form-agent.js analyze <url-or-fixture>
```

Fixture tooling (regenerate archived real fixture artifacts):

```bash
npm run fixture:sanitize -- <captured.html>
npm run fixture:decode
```

## Source of truth

Repository code, tests, and git history are the source of truth. Documentation
describes intent; if documentation and repository evidence disagree, **repository
evidence wins** — report the discrepancy rather than coding to the prose.

## Accepted baselines are not re-audited

Accepted Git baselines (see `AGENT_HANDOFF.md` for the current one) must **not**
be broadly re-audited, and completed phases must **not** be reimplemented.

Only reopen completed work when there is concrete evidence:

1. a relevant regression test fails,
2. the current phase directly depends on a conflicting interface, or
3. repository evidence contradicts the documented baseline.

When that happens, fix the specific conflict; do not re-do the whole phase.

## Workflow rules

- Work on **one phase only**.
- Read the current `docs/PHASE_N.md` **before** implementation.
- Maintain a visible TODO list for the current phase; keep exactly one item in
  progress where practical.
- Do not add scope unless a concrete dependency requires it.
- Inspect only files relevant to the current task unless evidence requires
  broader inspection.
- Use targeted tests while developing.
- Do not re-run the full regression suite after every edit; run it as a final
  acceptance check.
- Do not repeat the same command or investigation without new evidence.
- If multiple distinct attempts at the same blocker produce no progress, stop
  and report `BLOCKED` instead of looping.
- If several consecutive actions produce no new evidence, code change, test
  change, or diagnosis, stop and report.
- Never automatically begin the next phase.
- Never treat the agent's own statement that something works as proof — provide
  executable evidence.

## Phase acceptance rule

A phase is complete only when its documented acceptance criteria have
**verifiable evidence**. The final phase report must map requirements to
evidence, e.g.:

```
P1-R1 PASS -> tests/phase1-parser.test.ts
P1-R2 PASS -> tests/phase1-fixture-golden.test.ts
```

and must report:

- targeted test results
- full regression result
- typecheck result
- build result
- known limitations
- `git status`

## Git

- Do not commit accepted-phase baselines automatically unless explicitly
  instructed by the user.
- Keep the working tree free of unrelated edits; do not reformat or refactor
  outside the current phase.
## AI continuity and fresh-review protocol

`AGENT_HANDOFF.md` is the single canonical file for the project's current
operational state. Do not create a second competing current-state document.

For review/session continuity, also read `docs/AI_REVIEW_PROTOCOL.md`.

A fresh AI/reviewer session must reconstruct state from repository evidence,
not from assumed memory of previous chats. Read, in order:

1. `AGENTS.md`;
2. `AGENT_HANDOFF.md`;
3. `docs/AI_REVIEW_PROTOCOL.md`;
4. the current `docs/PHASE_N.md`;
5. the relevant branch/diff and tests.

Previous ChatGPT/OpenCode transcripts are forensic fallback only.

If repository evidence and handoff/documentation disagree, repository evidence
wins; report the discrepancy instead of guessing.

Use these review statuses consistently:

- `FIXED` — evidence satisfies the requirement.
- `NOT FIXED` — the requirement is still unsatisfied.
- `BLOCKED` — required evidence cannot currently be produced.
- `PASS` — every acceptance gate in scope passed.
- `FAIL` — at least one acceptance gate failed.

`BLOCKED` is never equivalent to `PASS`.

Do not let a long chat/session become the only record of project state. Before
rolling to a fresh reviewer session, ensure `AGENT_HANDOFF.md` and the relevant
Git branch/checkpoint are current.
