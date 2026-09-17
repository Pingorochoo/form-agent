# AGENTS.md

Repository-wide instructions for AI coding agents and reviewers.

## Start here

Before changing code:

1. Read `docs/PROJECT_STATE.md`.
2. Read `docs/AI_REVIEW_PROTOCOL.md`.
3. Read the current phase specification referenced by `PROJECT_STATE.md`.
4. Inspect:
   - `git branch --show-current`
   - `git rev-parse HEAD`
   - `git status --short`
   - `git diff --cached --name-only`
5. Treat Git, repository files, specifications, and tests as authoritative.
   Previous chat/session memory is supplemental only.

If repository state conflicts with `PROJECT_STATE.md`, stop and report
the mismatch instead of guessing.

## Change discipline

- Work only within the current phase/task.
- Do not edit a frozen phase specification unless explicitly requested.
- Do not reset, clean, stash, discard, rebase, or overwrite existing work
  unless explicitly authorized.
- Do not commit or push unless explicitly requested.
- Preserve already accepted behavior.
- Prefer the smallest change that closes a finding.
- Avoid unrelated dependency churn.
- Never commit real credentials, tokens, secrets, personal identifiers,
  or production configuration.

## Verification discipline

Never claim a test or verification passed unless it was actually run
against the relevant state.

If a requirement explicitly requires a real external runtime, a stub,
mock, synthetic package, or plain import is not equivalent proof.

If required evidence cannot be produced because an environment/runtime
is unavailable, report `BLOCKED`, not `PASS`.

Use these status terms consistently:

- `FIXED`
- `NOT FIXED`
- `BLOCKED`
- `PASS`
- `FAIL`

## Safety boundaries

Automated tests and verification must not:

- use real Telegram credentials;
- send real Telegram messages;
- perform real Google Form submissions;
- mutate a production OpenClaw configuration;
- leak provider/API secrets.

## Final reports

Implementation/review reports should include:

- branch and Git baseline;
- files changed;
- findings fixed;
- findings still open or blocked;
- exact verification commands and outcomes;
- whether the index/working tree is dirty;
- whether a commit/push was performed;
- exact next action.
