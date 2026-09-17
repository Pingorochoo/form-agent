# AI Review and Continuity Protocol

## Core rule

The conversation is not the project memory.

A fresh reviewer must reconstruct project state from:

1. Git history and branches;
2. `docs/PROJECT_STATE.md`;
3. the current phase specification;
4. implementation and tests;
5. durable decision/review artifacts.

Old ChatGPT/OpenCode transcripts are forensic fallback only.

## Git model

`main` represents accepted/stable project state.

In-progress phases use dedicated branches such as:

- `phase/8`
- `phase/9`
- `phase/10`

Checkpoint/WIP commits on a phase branch do not mean the phase is accepted.

Acceptance occurs only after the phase's required review and verification
gates pass.

## Recommended phase lifecycle

1. Start from accepted `main`.
2. Create `phase/N`.
3. Define/freeze the phase specification.
4. Implement on `phase/N`.
5. Push checkpoint commits when useful.
6. Review the phase diff against the accepted baseline.
7. Fix findings narrowly.
8. Run phase verification plus full regressions.
9. Record acceptance.
10. Merge accepted work to `main`.
11. Optionally tag the accepted state, e.g. `phase-8-accepted`.
12. Update `PROJECT_STATE.md`.

## Fresh reviewer startup

A fresh ChatGPT/reviewer session should read:

1. `AGENTS.md`
2. `docs/PROJECT_STATE.md`
3. this file
4. the current phase specification
5. the current branch diff against `main`
6. relevant tests and implementation

Before recommending changes, state:

- current phase;
- last accepted state;
- baseline;
- current branch/checkpoint;
- what is already fixed/accepted;
- remaining blockers;
- exact next action.

Do not infer missing state from assumed prior-chat memory.

## Review semantics

- `FIXED`: evidence satisfies the requirement.
- `NOT FIXED`: implementation/evidence still fails the requirement.
- `BLOCKED`: required evidence cannot currently be produced because of an external/environmental dependency.
- `PASS`: all acceptance gates in scope passed.
- `FAIL`: at least one acceptance gate failed.

`BLOCKED` is not `PASS`.

## Session rollover

Do not wait until a ChatGPT conversation becomes unusably large.

Before moving to a fresh chat:

1. ensure `PROJECT_STATE.md` is current;
2. push the current phase branch/checkpoint when appropriate;
3. use `NEW_CHAT_START_PROMPT.txt` in the fresh chat.

The new chat reconstructs state from the repository instead of requiring
a retelling of previous conversations.

## Durable decisions

Architectural decisions that survive multiple phases should be written
as small ADR/decision files containing:

- context;
- decision;
- consequences;
- superseding decision, if applicable.

Do not store giant chat transcripts as project documentation.
