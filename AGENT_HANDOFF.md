# AGENT_HANDOFF — Phase 7 Planning

## Current repository state

Project: `form-agent`

Accepted implementation baseline:

```text
aaaa5d0 feat: complete phase 6 real llm wiring
```

Phase 6 planning commit:

```text
55a19ad docs: add phase 6 real llm wiring plan
```

Phase 6 is accepted.

Phase 7 is NOT implemented yet. This pass produced only the Phase 7 planning
specification.

---

## Phase 7 implementation-start contract

When Phase 7 implementation begins, the working tree is expected to contain a
newer Phase 7 planning/docs-only commit (this planning pass) whose parent code
baseline is the accepted Phase 6 code.

The worker must verify the relationship, not a fixed HEAD hash:

1. `git status --short` is clean (no uncommitted changes);
2. the current HEAD is a newer Phase 7 planning/docs-only commit;
3. `aaaa5d0` (`feat: complete phase 6 real llm wiring`) is the trusted accepted
   implementation/code baseline that the planning commit builds on;
4. if repository history does not match that relationship, STOP and report
   instead of guessing.

Do NOT require HEAD itself to still be `aaaa5d0`; the planning/docs commit will
have advanced HEAD. The Phase 7 planning commit hash is not known at planning
time and must not be hard-coded.

The trusted accepted implementation baseline remains `aaaa5d0`.

```text
aaaa5d0 feat: complete phase 6 real llm wiring   <- accepted CODE baseline
   |
   +-- <Phase 7 planning/docs-only commit>       <- current HEAD before implementation
```

Do not broadly re-audit or redesign accepted Phase 0–6 behavior.

---

## Accepted phase status

| Phase | Status |
|---|---|
| Phase 0 — Foundation | ACCEPTED |
| Phase 1 — Structural analysis | ACCEPTED |
| Phase 2 — Policy & authorization | ACCEPTED |
| Phase 3 — Synthetic profiles + draft answers | ACCEPTED |
| Phase 4 — Consistency gate | ACCEPTED |
| Phase 5 — Controlled browser execution | ACCEPTED |
| Phase 6 — Real LLM wiring | ACCEPTED |
| Phase 7 — Metrics / observability / export | NOT STARTED (planning spec) |
| Phase 8 — OpenClaw + Telegram | NOT STARTED |

The trusted accepted implementation baseline is `aaaa5d0`.

---

## Accepted Phase 6 verification baseline

Final accepted Phase 6 verification:

```text
npm run verify:phase6   -> 89 passing / 9 files
npm test                -> 601 passing / 53 files
npm run typecheck       -> clean
npm run build           -> clean
git diff --check        -> clean
```

Observed responder fixture fingerprint must remain exactly:

```text
7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e
```

Accepted migrations are `1–8`.

Migration 8 is the accepted `execution_plan_snapshots` table.

Execution plan version is `2.0.0`.

Reference draft provider remains the default and remains network-free.

---

## Phase 6 invariants Phase 7 MUST preserve

Phase 7 is observation-only and must not weaken accepted Phase 6 (or Phase 5)
behavior.

- `PolicyEngine` remains the sole execution-policy authority.
- Authorization happens before `provider.open()`; the CLI keeps its outer
  authorization guard.
- The accepted Phase 5 submit ordering is unchanged:
  consistency block -> accepting gate -> policy A -> fill-only-answered ->
  DOM verify -> runtime fingerprint re-check -> accepting B -> submit readiness
  -> policy B -> atomic durable claim + rate event -> ONE submit attempt ->
  confirmed success | unknown_outcome.
- After the durable claim, ambiguous submit behavior is `unknown_outcome` and
  is never automatically retried.
- `run --submit` loads the persisted approved plan snapshot and makes ZERO LLM
  calls; it never regenerates a draft.
- Snapshot integrity/provenance/approval binding is unchanged: content-bound
  `bundle_sha256` + `provenance_hash` + bound `planId` must match before fill.
- Receipts remain the authoritative execution outcome/claim record.
- `llm_calls` remains the authoritative LLM call-accounting record.
- The real provider boundary is unchanged (one request per stage, no retries,
  no fallback chains, strict structured-output validation, secret-safe errors).
  The only authorized Phase 7 transport change is the single narrowly scoped
  P7-R10a audit-fidelity correction: missing/invalid usage fields become
  NULL/undefined instead of `0`; a genuinely supplied `0` is preserved.
- The reference provider remains available and deterministic.
- Migration 4 (`llm_calls`) is reused for LLM accounting; do not duplicate LLM
  events into a metrics table.

Metrics must never be read by policy, authorization, rate, retry, approval,
execution-plan identity, submission-claim, consistency, or drafting logic.

---

## Phase 6 known limitation relevant to Phase 7

`draft` and `check` do not currently persist `llm_calls` rows, even though the
accepted provider supports the audit hook and `resolveDraftProvider` accepts a
`recordCall` callback.

Phase 7 should close this accounting gap if it can be done on the accepted
database lifecycle without changing `draft`/`check` output or exit behavior.
`run` preflight already wires the audit store for real LLM calls.

Separately, accepted transport currently coerces missing usage fields to `0`.
Phase 7 authorizes one narrow audit-fidelity correction (P7-R10a) so missing
usage persists as NULL while a real `0` is preserved. See `docs/PHASE_7.md`.

---

## Phase 7 direction (summary)

Phase 7 is a bounded operational-observability phase:

- safe numeric/categorical metrics;
- deterministic local aggregation;
- read-only `metrics summary` / `metrics export` CLI;
- complete safe LLM-call accounting;
- no effect on policy, approval, drafting, consistency, browser execution,
  retry behavior, or submission semantics.

Migration posture:

- migrations 1–8 remain immutable;
- exactly ONE required append-only migration `9 metrics_events`, narrowly
  scoped to events that cannot be derived from accepted tables; no migration 10;
- do not duplicate `llm_calls`, `execution_receipts`, `execution_plan_snapshots`,
  `rate_events`, or `analysis_cache` data.

Full requirement set (`P7-R1` … `P7-R20`), metric catalog, schema, CLI/export
contract, failure semantics, test plan, and out-of-scope boundary live in:

```text
docs/PHASE_7.md
```

The phase-worker must not edit `docs/PHASE_7.md`.

---

## Where Phase 7 should start

1. Read `AGENTS.md`, this handoff, and `docs/PHASE_7.md`.
2. Verify `git status --short` is clean and that the Phase 7
   implementation-start contract above holds (current HEAD is the Phase 7
   planning/docs-only commit; `aaaa5d0` is its accepted code baseline). If the
   relationship does not match, STOP and report. Do NOT require HEAD to still be
   `aaaa5d0`.
3. Inspect the accepted surfaces Phase 7 consumes:
   - `src/db/migrations.ts`, `src/db/database.ts` (migration 4/7/8);
   - `src/llm/audit.ts`, `src/draft/openai-compatible.ts`,
     `src/draft/resolve.ts`;
   - `src/cli/index.ts`, `src/cli/exit-codes.ts`, `src/cli/draft.ts`,
     `src/cli/check.ts`, `src/cli/run.ts`;
   - `src/execution/receipt.ts`, `src/execution/snapshot.ts`,
     `src/execution/orchestrate.ts`;
   - `src/logging/logger.ts`, `src/logging/redact.ts`;
   - `tests/support/phase5.ts`, `tests/support/phase6-llm-stub.ts`.
4. Implement one milestone at a time (M1–M8 in `docs/PHASE_7.md`).
5. Run targeted tests during development; run the full regression only for
   final acceptance.

Do not start Phase 8.

---

## Phase 8

Phase 8 remains OpenClaw + Telegram and is NOT STARTED.
