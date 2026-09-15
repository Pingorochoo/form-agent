# Phase 7 — Metrics / Operational Observability / Export

## 1. Status and scope

Phase 7 adds bounded, read-only operational observability to the accepted
`form-agent` system.

Accepted code baseline:

```text
aaaa5d0 feat: complete phase 6 real llm wiring
```

Phase 7 must preserve all accepted behavior from Phases 0–6.

The central Phase 7 goal is:

> Add safe numeric/categorical metrics, deterministic local aggregation, and a
> read-only summary/export CLI around the CURRENT accepted command and execution
> lifecycle — without metrics ever becoming an input to any authorization,
> policy, rate, consistency, drafting, approval, execution, retry, or
> submission decision.

Phase 7 is not a platform, dashboard, analytics, or automation phase.

It is a bounded observability + accounting phase over already-accepted
durable tables and a small append-only metric-event store.

Metrics are **OBSERVATION ONLY**.

---

# 2. Why Phase 7 is deliberately small

Earlier roadmap notes described a much larger future system with batches,
preview tables, fallback chains, and metrics over a "real batch". Those are
**not** the accepted product surface.

The accepted system has:

- structural analysis/cache (`forms`, `form_schema`, `analysis_cache`);
- policy/authorization/rate (`authorizations`, `rate_events`);
- synthetic `DraftBundle` generation (`draft`);
- consistency gate (`check`);
- controlled browser execution + durable receipts (`execution_receipts`);
- a real OpenAI-compatible draft provider (`run` preflight);
- durable approved-plan snapshots (`execution_plan_snapshots`);
- safe `llm_calls` audit metadata (migration 4).

It intentionally does **not** yet have batches, schedulers/queue workers,
OpenClaw/Telegram, provider fallback chains, dashboards, or autonomous
workflows.

Phase 7 MUST NOT introduce any of those merely to satisfy an old roadmap
example.

---

# 3. Accepted surfaces Phase 7 consumes

Phase 7 consumes, and must not redefine:

| Surface | Location | Use in Phase 7 |
|---|---|---|
| `llm_calls` (migration 4) | `src/db/migrations.ts`, `src/llm/audit.ts` | LLM usage aggregates (count/tokens/latency/durable `status`) |
| `execution_receipts` (migration 7) | `src/execution/receipt.ts` | Authoritative execution-outcome aggregates |
| `execution_plan_snapshots` (migration 8) | `src/execution/snapshot.ts` | Protected accepted surface only — NOT a Phase 7 metrics source |
| `rate_events` (migration 6) | `src/policy/rate.ts` | Accepted surface only — NOT a Phase 7 output section |
| `analysis_cache` (migration 3) | `src/analyze/store.ts` | Accepted surface only — NOT a Phase 7 output section |
| CLI dispatcher + exit codes | `src/index.ts`, `src/cli/exit-codes.ts` | `metrics` subcommand + frozen exit mapping |
| Logger/redaction | `src/logging/logger.ts`, `src/logging/redact.ts` | Stable redacted metrics warning |
| Config | `src/config/schema.ts`, `src/config/load.ts` | No new required config; DB directory/filename reused |

The `handleCmdMetrics` scaffold already exists at
`src/cli/index.ts` and currently returns the Phase 0 `not-implemented` usage
path. Phase 7 replaces that scaffold with a real, read-only `metrics` command
surface. No other accepted command behavior may change.

---

# 4. Requirements

## P7-R1 — Preserve accepted Phase 0–6 behavior and fingerprint

Phase 7 must not weaken:

- Phase 1 parsing/cache;
- Phase 2 policy/authorization/rate behavior;
- Phase 3 sensitivity + validation + drafting;
- Phase 4 consistency;
- Phase 5 controlled execution + receipts + submission claim;
- Phase 6 real provider + plan snapshots + approval binding.

The observed responder fixture fingerprint must remain exactly:

```text
7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e
```

Migrations 1–8 remain immutable.

Execution-plan version remains `2.0.0`.

---

## P7-R2 — Metrics are observational, never authoritative

A metric, metric aggregate, or metric-store failure must never become an input
to:

- authorization decisions;
- `PolicyEngine` decisions;
- rate-policy decisions;
- retry decisions;
- approval / plan-identity decisions;
- execution-plan identity material;
- submission-key / submission-claim material;
- consistency decisions;
- draft/answer generation.

Metrics must not be read by `PolicyEngine`, `RateStore`, `ExecutionOrchestrator`,
`ReceiptStore`, `ExecutionPlanSnapshotStore`, the draft pipeline, or the browser
provider. Metrics readers exist only for the `metrics` CLI and tests.

Receipts remain the sole authority for execution outcome/claim semantics.
`llm_calls` remains the sole authority for LLM call accounting.

---

## P7-R3 — Recorder failure isolation (best-effort observability)

The isolation boundary is narrow and applies ONLY to the `metrics_events`
recorder write (and to the accepted best-effort LLM audit hook).

If a `metrics_events` recorder write fails for any reason (validator rejection,
insert error, unavailable metrics table):

- do not change any policy decision;
- do not change the command exit result;
- do not retry any business operation;
- do not retry a submission;
- do not turn success into failure;
- do not replace an existing stable error;
- never leak raw exception text.

The recorder is wrapped in a single catch-all boundary. On failure it may emit
one stable, redacted warning through the accepted logger (e.g.
`metrics recording skipped`), but it must never throw into the caller and must
never include the raw exception string.

Critical boundary — authoritative stores are NEVER swallowed as "metrics
failures":

- a `metrics_events` warning must not wrap or catch `ReceiptStore`,
  `ExecutionPlanSnapshotStore`, `PolicyEngine`/authorization/rate-store, or
  durable submission-claim failures;
- `run`/`submit` preserve all accepted fatal/fail-closed DB semantics;
- the receipt + rate-event claim transaction remains authoritative and
  unchanged; `metrics_events` is never part of that transaction;
- do not put metrics writes inside any authoritative DB transaction.

Draft/check LLM audit gap (P7-R11):

- Phase 7 MUST attempt the audit-only DB open for `draft`/`check` so the audit
  gap is instrumented; the open is not optional;
- that open/write is best-effort: if it fails, the draft/check business result
  may proceed without audit persistence, and stdout/JSON/exit are unchanged;
- LLM audit-hook write failures remain best-effort, per the accepted Phase 6
  audit isolation;
- that audit-only tolerance does NOT generalize to commands whose accepted
  behavior already requires the DB for authoritative state (e.g. `run`/submit,
  receipts, snapshots, authorization, rate).

Instrumentation records **after** the business result is computed. If the
business operation throws, the original error propagates unchanged. There is no
generic failure/reason-code metric: the minimal `metrics_events` catalog has no
generic error dimension.

How metrics interact with success vs controlled failure (exact, and consistent
with P7-R7):

- draft/count/consistency aggregate events are recorded only when the relevant
  business artifact/result exists (e.g. a produced `DraftBundle`, a consistency
  report). If a stage failed before producing the artifact, those events are not
  recorded.
- the command duration event is the ONE special case: if the business operation
  started, its elapsed duration MUST be recorded on success OR controlled
  failure exactly as P7-R7 specifies (the duration metric is intentionally
  outcome-agnostic);
- recording that duration is best-effort: it must never replace, swallow, or
  alter the original error, and the original error still propagates unchanged;
- the authoritative receipt/snapshot/claim/authorization/rate failure semantics
  above remain fatal and unchanged.

Execution receipt persistence and its transaction/claim behavior are unchanged:
metrics are never part of the claim transaction.

---

## P7-R4 — Migration policy: required append-only `metrics_events`

Migrations 1–8 are immutable.

Phase 7 MUST append **exactly one** migration:

```text
9 metrics_events
```

It is a narrowly scoped, append-only operational metric-event store for data
that cannot be safely/reliably derived from existing accepted tables.

Do not duplicate data already safely represented in `llm_calls`,
`execution_receipts`, `execution_plan_snapshots`, `rate_events`, or
`analysis_cache`.

Design constraints:

- no free-form "attributes JSON" column;
- the table stores ONLY the actual Phase 7 event catalog — do not build a
  generic future analytics table "just in case";
- no dimensions, provider/model/stage columns, or target hash unless a concrete
  accepted Phase 7 query requires them (see below);
- no raw/unbounded text;
- an event/kind validator enforces the catalog below so secret or raw-data
  insertion is impossible by construction;
- inserts are parameterized.

Minimal schema (this is the exact intended shape; only the smallest schema that
the actual Phase 7 catalog needs):

```sql
CREATE TABLE IF NOT EXISTS metrics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,            -- fixed catalog name
  kind TEXT NOT NULL,             -- 'count' | 'duration_ms' | 'categorical'
  value_num REAL,                 -- set for count/duration_ms
  value_text TEXT,                -- set for categorical (bounded)
  at_ms INTEGER NOT NULL,         -- normalized wall-clock epoch ms
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (kind IN ('count','duration_ms','categorical')),
  CHECK (at_ms >= 0),
  CHECK (value_num IS NULL OR value_num >= 0),
  CHECK (
    (kind = 'categorical' AND value_text IS NOT NULL AND value_num IS NULL) OR
    (kind IN ('count','duration_ms') AND value_num IS NOT NULL AND value_text IS NULL)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS idx_metrics_events_at ON metrics_events(at_ms);
CREATE INDEX IF NOT EXISTS idx_metrics_events_event ON metrics_events(event, at_ms);
```

Rationale for the minimal shape:

- `event` already identifies command/pipeline metric identity, so no separate
  `command`/`mode` column is needed;
- `consistency.status` uses bounded `value_text`;
- execution dimensions belong to `execution_receipts`, not `metrics_events`;
- LLM dimensions (provider/model/stage/status) belong to `llm_calls`, not
  `metrics_events`;
- there is no accepted Phase 7 query that needs a target hash, so `target_hash`
  is deliberately omitted.

The migration-9 column shape above is FROZEN by this spec. Do not add extra
columns, a generic dimension map, or any additional fixed column at
implementation time. If implementation evidence proves the frozen shape is
insufficient, STOP and report for spec review instead of extending it.

The store/recorder must additionally reject at runtime (stronger than the SQL
CHECKs, which only cover the simple non-negative rules):

- unknown `event` names;
- `kind` inconsistent with the catalog entry for that event;
- `count` events: finite, integer, `>= 0`;
- `duration_ms` events: finite, `>= 0`, integer or finite decimal depending on
  the monotonic timer; never `NaN`/`Infinity`/negative;
- `at_ms`: finite safe integer epoch milliseconds, `>= 0`;
- `categorical consistency.status`: exactly `pass | warn | block`;
- categorical values outside the event's fixed allowed set;
- `value_text` exceeding a fixed length bound (e.g. 64);
- any stored text containing newlines/control characters.

Migration 9 is REQUIRED by this Phase 7 design. The durable command-duration and
DraftBundle/consistency aggregate events (`metrics_events`) are intentionally not
derived from `llm_calls`, `execution_receipts`, or `execution_plan_snapshots`, so
no alternative accepted store can supply them.

- Phase 7 MUST append exactly one migration: `9 — metrics_events`.
- Migrations 1–8 remain immutable.
- No migration 10.
- There is no "worker may omit migration 9" escape hatch.

Fresh-DB apply, upgrade-from-migration-8, and reopen/idempotence must be tested in
the future implementation.

---

## P7-R5 — No sensitive/raw content in metrics

Never store or emit in `metrics_events`, summary output, JSON export, CSV
export, or metrics logs:

- raw answers / synthetic answer values;
- synthetic profile values;
- blocked sensitive values;
- form/question/section/choice text;
- raw HTML;
- prompt/response bodies;
- API keys / tokens;
- `Authorization` headers;
- cookies / browser storage;
- URL query/userinfo;
- raw provider/Playwright exception text;
- custom policy regex bodies;
- arbitrary CLI argument tokens;
- operator-provided free text (unless transformed into an approved bounded
  category/hash).

The only persisted metric material is the bounded catalog field set: `event`,
`kind`, `value_num` (for `count`/`duration_ms`), bounded `value_text` (for
`categorical`), and `at_ms`/`created_at`. There are no free-form dimensions.

Execution dimensions (target, outcome code, provider) are derived from
`execution_receipts`. LLM dimensions (provider, model, stage, status) are
derived from `llm_calls`. Neither is duplicated into `metrics_events`.

---

## P7-R6 — Bounded safe metric catalog

Phase 7 defines a small stable catalog, not "record everything". Metric names
are fixed constants.

Command / pipeline timing (`kind = duration_ms`, monotonic elapsed):

```text
command.analyze.duration
command.draft.duration
command.check.duration
command.run.preflight.duration
command.run.submit.duration
```

Draft / consistency safe counts (`kind = count` unless noted):

```text
draft.fields.total
draft.answered.count
draft.blocked.count
draft.unsupported.count
draft.validation_error.count
draft.required_unanswered.count
consistency.hard_issues.count
consistency.soft_issues.count
consistency.status                (kind = categorical; {pass, warn, block})
```

Execution and LLM metrics are **not** catalog events; they are derived from the
authoritative durable tables (P7-R9, P7-R10):

```text
execution.preflight.count            (derived: execution_receipts)
execution.submit.claim.count         (derived: receipts, submit_attempted=1)
execution.success.count              (derived: receipts, outcome=success)
execution.unknown_outcome.count      (derived: receipts)
execution.failed_pre_submit.count    (derived: receipts, grouped by stable code)
execution.aborted.count              (derived: receipts, grouped by stable code)
llm.call.count                       (derived: llm_calls)
llm.success.count / llm.error.count  (derived: llm_calls.status)
llm.tokens.input/output/total        (derived: llm_calls, only where non-NULL)
llm.latency.min/max/avg              (derived: llm_calls.duration_ms)
llm.by.provider/model/stage          (derived: llm_calls dimensions)
```

LLM success/error is aggregated by the durable `llm_calls.status` column only.

Accepted migration 4 does NOT persist a stable LLM error code: `LlmCallAuditEntry`
has an optional `errorCode`, but `LlmCallStore.record(...)` inserts only
`provider_id, model, stage, cache_key, input_tokens, output_tokens,
total_tokens, duration_ms, finish_reason, status`. Therefore Phase 7 must NOT
promise per-error-code LLM historical grouping and must NOT repurpose
`finish_reason`, `cache_key`, or any other accepted column for that purpose.
Durable per-error-code LLM analytics would require an explicit later-phase
storage contract; it is not part of Phase 7.

Do not add catalog entries without updating this spec's catalog and the
validator. Unknown events are rejected, not stored.

---

## P7-R7 — Command/pipeline timing instrumentation

Record the bounded command-duration events around the CURRENT accepted command
lifecycle:

- `command.analyze.duration`;
- `command.draft.duration`;
- `command.check.duration`;
- `command.run.preflight.duration`;
- `command.run.submit.duration`.

Rules:

- elapsed duration uses a monotonic source (e.g. `process.hrtime.bigint()` or
  `performance.now()`), not wall-clock subtraction;
- `at_ms` uses normalized wall-clock epoch ms only for storage/filter windows;
- recording failure is isolated (P7-R3).

Duration recording semantics (explicit, deterministic):

- usage/config errors that never start the business operation: NO duration event;
- once a business operation has started, record the elapsed command duration
  **regardless of eventual success or controlled failure** (the metric is
  intentionally outcome-agnostic), with ONE documented rule;
- the duration event MUST NOT contain or infer failure reason/status;
- authoritative outcome/error classification remains in the existing
  command/error/receipt surfaces;
- success vs failure timing is therefore never ambiguous: started => recorded,
  never started => not recorded.

Time must be injectable/controllable in unit tests; tests must not sleep.

---

## P7-R8 — Per-command event instrumentation matrix

Record only the bounded events a command actually produces. **No command may
execute a new business stage merely to create a metric.** In particular, `draft`
MUST NOT run the Phase 4 consistency gate.

`analyze`

```text
command.analyze.duration
```

`draft`

```text
command.draft.duration
draft.fields.total
draft.answered.count
draft.blocked.count
draft.unsupported.count
draft.validation_error.count
draft.required_unanswered.count
```

- accepted `draft` does NOT run consistency, so it records NO consistency events
  and adds no consistency pass.

`check` (generates a DraftBundle AND runs consistency)

```text
command.check.duration
draft.fields.total
draft.answered.count
draft.blocked.count
draft.unsupported.count
draft.validation_error.count
draft.required_unanswered.count
consistency.hard_issues.count
consistency.soft_issues.count
consistency.status
```

`run` preflight (generates a DraftBundle AND runs consistency)

```text
command.run.preflight.duration
draft.fields.total
draft.answered.count
draft.blocked.count
draft.unsupported.count
draft.validation_error.count
draft.required_unanswered.count
consistency.hard_issues.count
consistency.soft_issues.count
consistency.status
```

`run --submit`

```text
command.run.submit.duration
```

- only the submit duration event comes from `metrics_events` unless another
  metric is explicitly justified by the accepted submit lifecycle;
- do NOT duplicate the preflight draft/consistency event set during submit;
- execution outcomes remain derived from `execution_receipts`;
- do NOT parse snapshot `bundle_json` for metrics.

Contract applying to all commands:

- each invocation records one set of its defined event measurements **at
  operation time** into the Phase 7 metrics event store;
- only aggregate counts/status are persisted; individual answers, question ids,
  choice labels, semantic text, and profile values are never persisted;
- no snapshot `bundle_json` parsing for metrics, ever;
- `execution_plan_snapshots` has no dedicated safe count history and is NOT a
  Phase 7 metrics source;
- do not derive draft/consistency counts from Phase 6 plan snapshots or from
  "plan fields" — those safe count fields do not exist in the accepted snapshot
  store;
- these event metrics are available only from Phase 7 onward;
- execution outcome analytics remain derived from `execution_receipts`;
- LLM analytics remain derived from `llm_calls`.

---

## P7-R9 — Execution outcomes derive from authoritative receipts

Execution-outcome aggregates are derived **read-only** from
`execution_receipts` (migration 7). Do not duplicate receipt events into
`metrics_events`.

Report at minimum:

- preflight receipt count;
- submit-claim count (`submit_attempted = 1`);
- confirmed success count;
- `unknown_outcome` count;
- pre-submit failure / abort counts grouped by stable `outcome_code`.

Receipts remain the sole authority for claim/outcome semantics. Metrics export
must never insert, update, or claim a receipt.

---

## P7-R10 — LLM usage derives from `llm_calls`; no fabrication, no cost model

LLM usage aggregates are derived **read-only** from `llm_calls` (migration 4).
Do not duplicate LLM events into `metrics_events`.

Report at minimum:

- call count;
- success/error count (by the durable `llm_calls.status` column only);
- input/output/total tokens (only where non-NULL);
- latency min/max/average;
- call-count-only grouping by provider id, model label, and stage. Token and
  latency aggregates are global (`tokens`, `latencyMs`); Phase 7 does NOT define
  per-provider/per-model/per-stage token or latency schemas.

Do NOT aggregate by LLM error code: accepted migration 4 does not persist it
(see P7-R6). Do not repurpose `finish_reason`, `cache_key`, or any other
accepted column to simulate one.

Do not fabricate missing token counts or latency values. A SQL NULL token
column means "the provider did not supply a usable value" and must remain
NULL/absent in aggregates — never coerced to `0`. Do not infer monetary cost in
USD or any currency, and do not add a hard-coded or configured provider pricing
table.

Nullable usage aggregation must be self-describing (P7-R10b): a bare
`tokens.input=1234` MUST NOT be able to look like a complete total when some
`llm_calls` rows have NULL `input_tokens`.

### P7-R10a — Authorized audit-fidelity correction for usage fields

Accepted Phase 6 transport (`src/llm/openai-compatible.ts`) currently coerces
absent/invalid OpenAI-compatible usage fields to numeric `0` via its usage
parsing (`toInt`), and a successful call therefore persists `0` values in
`llm_calls`. As a result, "provider supplied 0" and "provider omitted usage"
are indistinguishable today.

Phase 7 authorizes exactly ONE narrowly scoped observability correction:

- define a usable provider-supplied token count as: `number`, finite, safe
  integer, `>= 0`;
- preserve a genuinely supplied usable token count, including a real `0`;
- missing, string, negative, fractional, non-finite, or otherwise invalid usage
  values become `undefined`/`null` and persist as SQL NULL in `llm_calls`;
- do not infer or fabricate token counts.

This correction is allowed ONLY for audit/usage fidelity. It must NOT change:

- endpoint/request shape;
- provider selection;
- prompt contracts;
- response content validation;
- retry behavior;
- timeout behavior;
- redirects;
- output-body limits;
- draft semantics;
- plan/snapshot semantics;
- submit behavior.

There is no contract requirement on LLM error code. If a later phase wants
durable per-error-code LLM analytics, it needs an explicit storage contract;
that is not required for Phase 7.

### P7-R10b — Self-describing nullable usage aggregates

Nullable token fields (`input_tokens`, `output_tokens`, `total_tokens`) use
EXACTLY this shape:

```json
{ "sum": null, "observedCount": 0, "missingCount": 0 }
```

- `sum`: sum over non-NULL rows (`number`), or `null` when `observedCount = 0`;
- `observedCount`: number of rows with a value;
- `missingCount`: number of rows with `NULL`;
- do NOT require `min`/`max`/`avg` for token totals in Phase 7.

Nullable `duration_ms` latency uses EXACTLY this shape:

```json
{ "min": null, "max": null, "avg": null, "observedCount": 0, "missingCount": 0 }
```

- `min`/`max`/`avg`: computed over non-NULL rows (`number`), each `null` when
  `observedCount = 0`;
- `observedCount`/`missingCount`: rows with / without a value;
- do NOT require `sum` for latency in Phase 7.

Rules:

- `callCount` is always the accurate total row count and is independent of
  observed/missing counts;
- when `observedCount = 0`: token `sum` is `null`, and latency
  `min`/`max`/`avg` are `null` (never `0`); `observedCount`/`missingCount` remain
  accurate;
- never convert an all-NULL aggregate to numeric zero without also exposing
  `observedCount = 0`;
- partial coverage MUST be visible in human summary, JSON, and CSV so it cannot
  be mistaken for full usage coverage;
- the §6 frozen JSON contract uses these exact shapes.

---

## P7-R11 — Close the draft/check LLM-call audit gap

Accepted Phase 6 limitation: `draft` and `check` do not currently persist
`llm_calls` rows, even though the provider supports the audit hook and
`resolveDraftProvider` accepts `recordCall`.

Phase 7 closes this gap, provided it can be done without changing draft/check
behavior:

- Phase 7 MUST attempt to open the configured SQLite database using the accepted
  `FormAgentDatabase` lifecycle for `draft`/`check`; the audit-only DB open is
  NOT optional;
- pass `recordCall: (entry) => new LlmCallStore(database).record(entry)` into
  `resolveDraftProvider` for `draft` and `check`;
- the open/write is best-effort: a DB open/write failure must not change the
  command stdout, JSON shape, exit code, or business result (the command
  proceeds without persistence);
- do not persist prompt/response bodies, secrets, or raw exceptions;
- do not redesign the real provider, add retries, or add fallbacks (the single
  P7-R10a audit-fidelity usage correction is the only permitted transport
  change);
- `run` preflight continues to wire the audit store exactly as accepted.

This must not change draft/check stdout, JSON shape, or exit codes.

---

## P7-R12 — Read-only metrics CLI with no side effects

Planned surface (summary is human-readable only; export owns the stable
machine-readable schemas):

```text
form-agent metrics summary [--since <ISO8601>] [--until <ISO8601>]
form-agent metrics export --format json|csv [--since <ISO8601>] [--until <ISO8601>]
```

There is deliberately NO `metrics summary --json`: two subtly different
machine-readable contracts are avoided, and `export --format json` is the single
JSON contract.

Operational read-only contract — `metrics` performs no OPERATIONAL writes:

- no browser, network, or LLM activity;
- no submission claim created;
- no authorization or rate-state mutation;
- no draft provider invoked;
- summary/export must NOT insert a `metrics_events` row merely because metrics
  were queried/exported;
- no receipt insert/update, no plan/snapshot mutation;
- export writes to stdout only for the first implementation (no `--out`).

Explicit schema-maintenance contract (resolves the "read-only vs migration"
ambiguity): the accepted `FormAgentDatabase.open(...)` lifecycle runs the
idempotent migration catalog on open. `metrics summary`/`export` MUST reuse that
accepted lifecycle — do not build a parallel database stack merely to claim
byte-level read-only behavior — so applying a not-yet-applied migration to an
existing database is the ONE permitted schema-maintenance write. Apart from
that, metrics commands perform no operational writes.

Behavior under that contract (one chosen contract, tested):

- missing DB file: accepted open may create the DB/directory and apply the full
  catalog (schema maintenance); empty aggregates as success and no operational
  rows;
- DB at migration 8 with no migration 9: accepted open applies migration 9
  (schema maintenance); empty `metricsEvents` is success **if the table exists**;
- existing `metrics_events` table with zero rows: success, empty aggregates;
- existing expected source with zero rows: success, empty aggregates — no data
  is not an error;
- BUT after a successful migration/open lifecycle, an expected `metrics_events`
  table that is missing or unqueryable is a controlled metrics-command ERROR
  (stable, redacted, mapped to the accepted generic error exit path). Never
  fabricate empty data for an unavailable expected source.

This controlled error is for the metrics CLI itself and must not weaken the
business-command failure-isolation rules (P7-R3).

Unknown subcommands/flags are controlled usage errors and never echo raw
contents.

---

## P7-R13 — Strict parsing and frozen exit codes

`metrics` argument parsing follows the accepted strict style of `draft`/`check`/
`run`:

- reject unknown flags without echoing their raw contents;
- reject missing/invalid values deterministically;
- `export` requires `--format json|csv`;
- reject extra positionals;
- invalid time filters are usage errors.

Use the existing frozen exit-code contract; do not invent new process exit
codes:

```text
0   success
1   unexpected error
2   usage/config
3   validation
4   LLM offline
5   LLM connectivity
127 unknown command
```

A metrics command that finds no data is success with empty aggregates, not an
error.

---

## P7-R14 — Deterministic aggregation contract

Aggregation is deterministic and dependency-free. Phase 7 exports EXACTLY:

- `count`;
- `sum` for counters/tokens;
- `min` / `max` / `avg` for durations and latency.

Percentiles (p50/p95 or any other) are OUT OF SCOPE for Phase 7: the frozen
JSON/CSV contracts do not define them. A later spec may extend the schema; do
not add a statistics dependency or emit percentile rows.

Output must clearly separate the three frozen machine sections (exact JSON/CSV
shape in §6):

- `metricsEvents` aggregates (Phase 7 event store);
- `llmUsage` aggregates (`llm_calls`);
- `executionOutcomes` aggregates (`execution_receipts`).

Do not add additional top-level machine sections in Phase 7. Averages and
nullable usage statistics are defined over non-null values only and are
self-describing with `observedCount`/`missingCount` (P7-R10b); an unavailable
statistic is `null`, never a fabricated `0`.

---

## P7-R15 — Deterministic time filtering

Explicit filtering uses a strict timestamp grammar:

```text
--since <timestamp>   inclusive lower bound
--until <timestamp>   exclusive upper bound
```

Grammar (validate syntax first, then parse):

- accept ONLY an explicit RFC3339/ISO-8601 timestamp WITH a timezone: `Z` or a
  numeric offset (`±HH:MM`);
- require a full date AND time component;
- REJECT date-only values (e.g. `2026-01-01`);
- REJECT local-time-without-zone values (e.g. `2026-01-01T00:00:00`);
- do not use bare `Date.parse` as the grammar validator; apply an explicit
  RFC3339 pattern, then convert to epoch ms;
- reject invalid/malformed values as usage errors;
- `--since` is inclusive; `--until` is exclusive;
- when both are present, require `since < until` (equal or inverted -> usage
  error);
- no natural-language duration parser and no relative-time parser;
- tests inject/control time and never sleep, and must cover exact lower/upper
  boundaries and equivalent timezone offsets (e.g. `...Z` vs an equivalent
  `+00:00`).

If only one bound is supplied, apply that bound only. No bound means all
retained data.

Source timestamp mapping (exact; required so filtering is truthful):

```text
metrics_events      -> at_ms (integer epoch ms; the Phase 7 event time)
llm_calls           -> created_at (TEXT ISO-8601) parsed to epoch ms; the only
                       accepted llm_calls timestamp (index idx_llm_calls_created)
execution_receipts  -> created_at and updated_at (TEXT ISO-8601); see below
```

Execution-receipt timestamp semantics (truthful contract):

- migration 7 has `created_at`, `updated_at`, `approval_at`, `submit_attempted`,
  but NO dedicated submit-claim timestamp;
- `execution.preflight.count` may use `created_at` with `state='preflight'`;
- `execution.submit.claim.count` is defined as an ALL-TIME count of
  `submit_attempted = 1`; it MUST NOT be presented as ranged by exact claim time,
  because no claim timestamp exists. It must be visibly labelled as all-time in
  every surface: human summary `claims(all-time)=..`, JSON `submitClaimCount`,
  CSV `scope=submitClaimAllTime`;
- ranged terminal-outcome aggregates (`success`, `unknown_outcome`,
  `failed_pre_submit`, `aborted`) may use `updated_at` as the final/terminal
  timestamp for that receipt and MUST label it as the terminal-time filter;
- never call `updated_at` "claim time";
- if an exact claim-time range cannot be reconstructed, disclose the limitation
  (all-time claim count) rather than inventing a timestamp.

---

## P7-R16 — Stable machine-readable exports

The exact JSON top-level/coverage keys and the exact CSV header/row grammar are
FROZEN in §6. Implementations must not invent alternate top-level keys or a
different CSV header.

JSON:

- deterministic key ordering and array ordering (sort groups by stable keys);
- stable numeric formatting; unavailable nullable statistics are `null`;
- machine-parsable on stdout, one JSON document;
- no trailing prose mixed into the document.

CSV (exact header `section,scope,dimension,metric,value,unit,observedCount,missingCount`):

- standards-safe escaping (RFC 4180-style): quote fields containing comma,
  double-quote, CR, or LF; double embedded quotes;
- one stable header row; no dynamic column names;
- deterministic row ordering (section -> scope -> dimension -> metric, all
  ascending);
- coverage represented in the same table shape via `section=coverage` rows with
  the same coverage values as JSON (P7-R17);
- no secret/raw-data dimensions.

CSV must be parseable by a standard reader and must never break the table shape
on a value containing a comma or quote, and it must contain no prose outside the
CSV document.

---

## P7-R17 — Explicit historical coverage disclosure

Machine-readable export must state coverage so operators cannot mistake absent
history for zero activity. Coverage must be represented in human summary, JSON
export, and CSV export (P7-R16).

```text
metricsEvents      -> available only from Phase 7 onward
llmUsage           -> derived from llm_calls for whatever durable history
                      actually exists; pre-Phase-7 coverage is INCOMPLETE across
                      commands (Phase 6 run preflight persisted real-provider
                      calls, but draft/check did not persist llm_calls rows);
                      from Phase 7 onward the draft/check/run real-provider paths
                      are all instrumented, but llm_calls persistence remains
                      BEST-EFFORT and must never be described as guaranteed
                      complete durable history
executionOutcomes  -> derived from execution_receipts for whatever history
                      exists (durable since migration 7 / Phase 5)
```

Phase 7 machine output has exactly three sections: `metricsEvents`, `llmUsage`,
`executionOutcomes`. `rate_events` and `analysis_cache` remain accepted
repository surfaces, but Phase 7 summary/export MUST NOT add a fourth/fifth
output section; doing so requires an explicit future spec revision.

Required coverage representation:

- human summary: a `Coverage:` line (see §6);
- JSON export: a `coverage` object whose `llmUsage` value explicitly notes the
  incomplete pre-Phase-7 coverage and that Phase 7 instrumentation is
  best-effort, not guaranteed-complete durable history;
- CSV export: stable `section=coverage` rows carrying the same values.

Do not claim complete historical LLM coverage. Do not label old missing data as
zero activity. Do not synthesize missing historical calls.

---

## P7-R18 — Local-only deterministic tests

All Phase 7 tests must be local and deterministic:

- no external Google Forms;
- no real external LLM endpoint;
- no third-party telemetry;
- reuse temp/in-memory SQLite;
- reuse the local execution fixture harness (`ExecutionHarness`);
- reuse the loopback Phase 6 LLM stub (`LlmStub`) where real-provider
  accounting is required;
- reuse the accepted `makeDatabase`/`makeConfig`/`allowFixture` support;
- injected/controlled time instead of sleeps.

Unexpected external network access must fail loudly.

---

## P7-R19 — Privacy / secret sentinel proof

Use sentinels such as:

```text
VERY_SECRET_METRICS_VALUE
VERY_SECRET_LLM_TOKEN
VERY_SECRET_BROWSER_VALUE
```

Prove none appear in:

- `metrics_events` rows;
- metrics summary output (human);
- JSON export;
- CSV export;
- metrics error/warning logs.

Also prove no raw synthetic answers, profile values, question/choice text, or
page HTML appear in metrics output. Existing accepted LLM/browser secret
guarantees must remain intact.

---

## P7-R20 — Local lifecycle E2E + `verify:phase7` + full acceptance

Add a focused `verify:phase7` script covering every Phase 7 targeted test file.

The acceptance E2E proves a realistic CURRENT lifecycle (not a nonexistent
batch workflow):

1. create a temp database;
2. perform one or more accepted local operations (e.g. `analyze` a fixture);
3. make at least one loopback real-provider `draft`/`check`/preflight call;
4. perform local fixture preflight/confirmed submit where appropriate;
5. query `metrics summary` and `metrics export`;
6. prove LLM-call aggregates are present (including draft/check audit rows);
7. prove execution-outcome aggregates are present (from receipts);
8. prove Phase 7 event metrics (command durations / draft counts) are present;
9. prove no raw synthetic answers/profile/secrets are present;
10. prove the export itself made no browser/LLM/network request.

Future implementation must run:

```bash
npm run verify:phase7
npm test
npm run typecheck
npm run build
git diff --check
```

and confirm:

- observed fixture fingerprint remains exactly
  `7335cdcceb9056de39a12615a62d4cec96e0b147e4b661fca7aa70b6a6a5ad5e`;
- migrations 1–8 unchanged; migration 9 (`metrics_events`) required; no migration 10;
- no external test network;
- no browser/LLM activity from metrics export itself;
- no raw answer/profile/secret leakage;
- Phase 5 submission safety still passes;
- Phase 6 snapshot/approval binding still passes;
- zero Phase 8 work.

---

# 5. Recorder/storage design (recorder boundary)

A narrow recorder/store abstraction, conceptually:

```text
interface MetricsRecorder {
  recordCount(event, value): void;
  recordDuration(event, durationMs): void;
  recordCategorical(event, value): void;
}

class MetricsStore implements MetricsRecorder { ... }   // migration 9
class NullMetricsRecorder implements MetricsRecorder { ... } // no-op
```

Rules:

- construct the store only after the accepted DB is open;
- if the DB or table is unavailable, fall back to the no-op recorder;
- validate every argument against the closed catalog (exact event name, exact
  kind, allowed categorical set, finite numeric) before insert;
- every `record*` call is wrapped so it cannot throw into the caller;
- readers (`summary`, `export`) never call `record*`.

`at_ms` and monotonic elapsed timing are injectable for tests.

---

# 6. CLI output shapes (frozen)

Human summary (stable ordering, bounded):

```text
Metrics summary (<n> events, <m> receipts, <k> llm_calls)
Range: <since|-> .. <until|->
Coverage: metricsEvents=phase7+ llmUsage=partial-pre-phase7;best-effort-instrumented-from-phase7 executionOutcomes=phase5+
Commands:
  analyze.duration   count=.. min=..ms max=..ms avg=..ms
  ...
Draft:
  fields.total=.. answered=.. blocked=.. unsupported=.. validation_error=.. required_unanswered=..
Consistency:
  status pass=.. warn=.. block=.. hard=.. soft=..
Execution:
  preflight=.. claims(all-time)=.. success=.. unknown_outcome=.. failed_pre_submit=.. aborted=..
LLM:
  calls=.. success=.. error=..
  tokens.input  sum=.. observed=.. missing=..
  tokens.output sum=.. observed=.. missing=..
  tokens.total  sum=.. observed=.. missing=..
  latency min=..ms max=..ms avg=..ms observed=.. missing=..
  by provider: ...
  (no per-error-code grouping; migration 4 does not persist it)
```

JSON export — FROZEN top-level contract (exact keys; do not invent alternates):

```json
{
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "range": { "since": null, "until": null },
  "coverage": {
    "metricsEvents": "phase7+",
    "llmUsage": "partial-pre-phase7;best-effort-instrumented-from-phase7",
    "executionOutcomes": "phase5+"
  },
  "metricsEvents": {
    "byEvent": [
      { "event": "command.analyze.duration", "kind": "duration_ms", "count": 1, "sum": 12, "min": 12, "max": 12, "avg": 12 }
    ],
    "statusCounts": [ { "value": "pass", "count": 1 } ]
  },
  "llmUsage": {
    "callCount": 0,
    "byStatus": [],
    "tokens": {
      "input":  { "sum": null, "observedCount": 0, "missingCount": 0 },
      "output": { "sum": null, "observedCount": 0, "missingCount": 0 },
      "total":  { "sum": null, "observedCount": 0, "missingCount": 0 }
    },
    "latencyMs": { "min": null, "max": null, "avg": null, "observedCount": 0, "missingCount": 0 },
    "byProvider": [],
    "byModel": [],
    "byStage": []
  },
  "executionOutcomes": {
    "preflightCount": 0,
    "submitClaimCount": 0,
    "byState": [],
    "byOutcome": [],
    "byOutcomeCode": []
  }
}
```

Frozen points:

- top-level keys are exactly: `generatedAt`, `range`, `coverage`, `metricsEvents`,
  `llmUsage`, `executionOutcomes`;
- `coverage` keys are exactly: `metricsEvents`, `llmUsage`, `executionOutcomes`;
- `range` keys are exactly: `since`, `until`;
- aggregate row objects use the fixed field names shown above (no ad-hoc naming);
- `submitClaimCount` is an all-time count (see P7-R15) and is never presented as
  claim-time ranged;
- nullable token fields use the EXACT P7-R10b shape
  `{ "sum", "observedCount", "missingCount" }` (no `min`/`max`/`avg`);
- nullable `latencyMs` uses the EXACT P7-R10b shape
  `{ "min", "max", "avg", "observedCount", "missingCount" }` (no `sum`);
  unavailable statistics are `null`, never `0`;
- LLM grouping scope is explicit: `byStatus`, `byProvider`, `byModel`, and
  `byStage` are grouped CALL-COUNT rows ONLY. Global token and latency
  aggregates live only under `tokens` and `latencyMs`. Phase 7 MUST NOT invent a
  per-provider/per-model/per-stage token or latency schema; broader grouped usage
  requires a deliberate later-spec schema extension;
- zero-data consistency: when `callCount = 0`, `byStatus`/`byProvider`/`byModel`/
  `byStage` are `[]`. When an outcomes count is `0`, `byState`/`byOutcome`/
  `byOutcomeCode` are `[]`. Never fabricate zero-count groups (e.g. a synthetic
  `reference` provider row);
- array ordering is deterministic by the row's stable key (sorted ascending by
  `event`/`value`/`status`/`providerId`/`model`/`stage`/`state`/`outcome`/
  `outcomeCode` as applicable); when a group has rows, rows are always emitted
  in that order.

CSV export — FROZEN row grammar. One exact stable header, never dynamically
generated column names:

```text
section,scope,dimension,metric,value,unit,observedCount,missingCount
```

Column semantics:

- `section`: `coverage` | `metricsEvents` | `llmUsage` | `executionOutcomes`;
- `scope`: stable sub-area, e.g. `byEvent`, `byStatus`, `byProvider`, `byModel`,
  `byStage`, `preflightCount`, `submitClaimAllTime`, `byState`, `byOutcome`,
  `byOutcomeCode`, `tokens.input`, `tokens.output`, `tokens.total`, `latencyMs`;
- `dimension`: the group-key VALUE for a grouped row (e.g. a provider id, model
  label, stage, status, state, outcome code); empty for `totals` and coverage
  rows. Provider/model/stage values are NEVER encoded as column names;
- `metric`: fixed vocabulary `count` | `sum` | `min` | `max` | `avg` |
  `present`. `observedCount`/`missingCount` are DEDICATED COLUMNS and are NEVER
  emitted as `metric`-name rows;
- `value`: numeric text, or the coverage string for `section=coverage`; empty
  when the statistic is unavailable (all-NULL);
- `unit`: `ms` | `tokens` | `count` | `text`;
- `observedCount` / `missingCount`: dedicated integer columns; empty unless the
  row represents a nullable aggregate; never `metric`-name rows.

Nullable usage row grammar:

- token aggregate row: `metric=sum`, `value=<sum or empty>`,
  `observedCount=<n>`, `missingCount=<n>`, `unit=tokens`;
- latency rows: `metric=min|max|avg`, `value=<number or empty>`, and
  `observedCount`/`missingCount` carry the SAME `n` for all three rows,
  `unit=ms`;
- ordinary count/event/outcome rows: `observedCount`/`missingCount` are empty;
- coverage rows: `metric=present`, `observedCount`/`missingCount` empty.

Submit-claim row (all-time; never ranged by `--since`/`--until`):

```csv
executionOutcomes,submitClaimAllTime,,count,<n>,count,,
```

Coverage rows use:

```csv
section,scope,dimension,metric,value,unit,observedCount,missingCount
coverage,metricsEvents,,present,phase7+,text,,
coverage,llmUsage,,present,partial-pre-phase7;best-effort-instrumented-from-phase7,text,,
coverage,executionOutcomes,,present,phase5+,text,,
```

Deterministic ordering: section order (`coverage`, `metricsEvents`, `llmUsage`,
`executionOutcomes`), then `scope` ascending, then `dimension` ascending, then
`metric` ascending; RFC-4180-safe escaping; no prose outside the CSV document.

Aggregate `llmUsage` is grouped by durable `status` (success/error) only; there
is no per-error-code LLM grouping because migration 4 does not persist it.

`generatedAt` is wall-clock metadata only and is excluded from determinism
comparisons; aggregate values and ordering must be deterministic.

---

# 7. Migration contract (summary)

- Migrations 1–8: immutable, byte/behavior-compatible.
- Migration 9 (`metrics_events`): REQUIRED, append-only, metrics-only.
- No migration 10.
- No other durable table is added, altered, or dropped.
- Do not backfill or fabricate historical events.
- Migration tests assert ids `[1..8]` unchanged, migration 9 named
  `metrics_events`, fresh-DB apply, upgrade from migration 8, reopen
  idempotent, the validator rejects unknown/bad events, and the secret sentinel
  is not persisted.

---

# 8. Out of scope (explicit boundary)

Do NOT implement in Phase 7:

- batch generation or batch submission;
- scheduler / cron / queue workers;
- OpenClaw;
- Telegram;
- dashboard / web UI;
- Prometheus / OpenTelemetry / any network telemetry backend;
- remote metrics upload;
- provider fallback chains;
- automatic LLM retries;
- budget enforcement;
- hard-coded or configured monetary pricing / USD cost estimates;
- alerting / paging;
- retention cleanup jobs;
- browser trace/video systems;
- new form provider families;
- parser expansion;
- answer-generation changes;
- consistency repair;
- `PolicyEngine` changes;
- authorization changes;
- rate-policy changes;
- execution ordering changes;
- any change to submission semantics or the Phase 5 state machine;
- any change to Phase 6 provider/transport/snapshot semantics, EXCEPT the single
  narrowly scoped P7-R10a audit-fidelity correction (missing usage -> NULL
  instead of `0`), which is explicitly authorized and constrained.

Phase 8 remains OpenClaw + Telegram.

---

# 9. Recommended milestones

Exactly one meaningful milestone in progress at a time.

```text
M1 — inspect accepted DB/audit/CLI surfaces + define metric domain contract
M2 — required migration 9 / metrics event store + validator
M3 — safe recorder + failure isolation + command instrumentation
M4 — complete LLM audit coverage + P7-R10a usage fidelity + aggregation readers
M5 — metrics summary/export CLI
M6 — deterministic JSON/CSV + time filtering
M7 — privacy/secret/no-side-effect tests
M8 — local lifecycle E2E + final acceptance
```

Names may adapt to repository evidence.

---

# 10. Recommended test files

Exact names may follow repository conventions.

```text
tests/phase7-metrics-store.test.ts
tests/phase7-metrics-recorder.test.ts
tests/phase7-metrics-migration.test.ts
tests/phase7-metrics-aggregate.test.ts
tests/phase7-metrics-cli.test.ts
tests/phase7-time-filter.test.ts
tests/phase7-export-format.test.ts
tests/phase7-llm-audit-gap.test.ts
tests/phase7-llm-usage-fidelity.test.ts
tests/phase7-no-secret.test.ts
tests/phase7-no-side-effects.test.ts
tests/phase7-lifecycle-e2e.test.ts
tests/phase7-smoke.test.ts
```

Do not create redundant micro-tests when one focused test can prove the
contract.

---

# 11. Acceptance scenarios

## Scenario A — reference regression

```text
draft/check/run preflight with default reference provider
-> accepted deterministic behavior unchanged
-> metrics recording does not alter output/exit
```

## Scenario B — per-command instrumentation matrix

```text
analyze          -> command.analyze.duration only
draft            -> command.draft.duration + draft.* counts; NO consistency pass/events
check            -> command.check.duration + draft.* counts + consistency.* events
run preflight    -> command.run.preflight.duration + draft.* + consistency.* events
run --submit     -> command.run.submit.duration only from metrics_events
-> no command runs a new business stage merely to emit a metric
-> no raw answers/profile/text present
```

## Scenario C — LLM accounting

```text
loopback LlmStub
draft (and check) with openai-compatible
-> llm_calls persisted (gap closed)
-> metrics export shows call/token/latency aggregates grouped by durable status
-> missing token counts persist as NULL and are not fabricated
```

## Scenario C2 — LLM usage fidelity (NULL vs 0)

```text
response with real usage -> those numbers persist (a real 0 is a valid value)
response with missing/invalid usage (missing, string, negative, fractional,
non-finite) -> NULL token fields persist (not 0)
draft result otherwise identical
```

## Scenario D — execution outcomes

```text
fixture preflight + confirmed submit
-> execution_outcomes aggregates reflect receipts
-> no receipt row modified by metrics
```

## Scenario E — deterministic export

```text
same DB, same range, two exports
-> identical aggregate values/ordering (excluding generatedAt)
-> valid RFC-4180 CSV for values containing comma/quote/newline
```

## Scenario F — time filtering

```text
--since/--until strict RFC3339 with timezone
-> inclusive since, exclusive until; since < until enforced
-> reject date-only and local-time-without-zone values as usage errors
-> exact-boundary tests and equivalent-offset tests (Z vs +00:00)
-> invalid timestamp -> usage exit code, no operational data written
-> submit claim count is disclosed as all-time (no claim timestamp exists)
```

## Scenario F2 — nullable usage disclosure

```text
llm_calls rows with some NULL tokens
-> tokens.input/output/total report sum + observedCount + missingCount
-> all-NULL statistic is null (not 0) with observedCount=0
-> partial coverage is visible in human, JSON, and CSV
```

## Scenario G — recorder failure isolation boundary

```text
simulated metrics_events recorder failure during a command
-> command output/exit unchanged; stable redacted warning only; no raw exception
AND
a simulated ReceiptStore / snapshot / claim / authorization / rate failure
-> remains fatal/fail-closed; NEVER swallowed as a "metrics failure"
```

## Scenario J — migration 9 required + missing-table handling

```text
fresh DB        -> migration 9 applied; metrics_events present; reopen idempotent
migration-8 DB  -> open applies migration 9; empty metrics_events is success
metrics_events missing after successful open
-> controlled metrics-command error (stable/redacted), NOT fake empty data
```

## Scenario H — secret safety

```text
VERY_SECRET_METRICS_VALUE / VERY_SECRET_LLM_TOKEN / VERY_SECRET_BROWSER_VALUE
-> absent from metrics_events, summary, JSON, CSV, logs
```

## Scenario I — no side effects

```text
metrics summary/export
-> zero fetch calls, zero LLM calls, zero browser activity
-> no new metrics_events row created by the query itself
-> no submission claim created
```

---

# 12. Final report

The Phase 7 worker must report every requirement:

```text
P7-R1  PASS / FAIL
...
P7-R20 PASS / FAIL
```

For each:

- implementation evidence;
- test evidence.

Also report:

- final TODO state;
- files added / modified;
- dependency changes (expected: none);
- migration decision (migration 9 `metrics_events` is REQUIRED, with fresh-DB,
  upgrade-from-8, and reopen/idempotence evidence);
- exact per-command event instrumentation matrix (proof `draft` gained no
  consistency pass);
- `metrics_events` schema + validator numeric rules (count integer >= 0;
  duration_ms finite >= 0; at_ms finite safe integer >= 0; status enum);
- metrics recorder failure-isolation boundary proof (authoritative
  receipt/snapshot/claim/authorization/rate failures remain fatal, never
  swallowed as metrics failures);
- draft/check LLM audit-gap resolution proof;
- P7-R10a usage-fidelity proof (real usage persists numbers; missing usage
  persists NULL; otherwise-identical draft);
- P7-R10b self-describing nullable usage aggregates (sum + observedCount +
  missingCount; null not 0);
- strict time-filter grammar + source timestamp mapping (including all-time
  submit-claim-count disclosure);
- metrics CLI surface;
- DB-open / schema-maintenance / operational read-only contract proof, plus the
  controlled error when the required `metrics_events` table is missing after a
  successful open;
- exact frozen JSON top-level keys and exact CSV header/row grammar + escaping
  and deterministic ordering proof;
- coverage disclosure;
- `verify:phase7` totals;
- full regression totals;
- typecheck;
- build;
- `git diff --check`;
- observed fixture fingerprint;
- migrations 1–8 unchanged; migration 9 (`metrics_events`) required; no migration 10;
- known limitations;
- deferred Phase 8 work;
- final `git status --short`.

Do not commit.
Do not push.
Do not start Phase 8.

STOP after the report.
