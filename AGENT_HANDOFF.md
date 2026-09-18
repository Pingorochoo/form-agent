# AGENT_HANDOFF — Phase 9 Planning

## Repository

Project:

`form-agent`

Repository:

`https://github.com/Pingorochoo/form-agent`

---

## Current phase

```text
Current phase:                      Phase 9
Status:                             PLANNING REVIEWED — READY FOR OPERATOR EXECUTION
Current development branch:         phase/9
Phase 9 starting branch baseline:   71be41d
Accepted prior phase:               Phase 8
Phase 8 implementation checkpoint:  56995a9
Phase 8 acceptance tag:             phase-8-accepted
Phase 8 acceptance record:          954c2b7
Phase 9 specification:              docs/PHASE_9.md (FROZEN — reviewed; not implemented)
```

Phase 9 is titled **Production Deployment + Controlled Live E2E Validation**.

The development branch `phase/9` was created from the Phase 9 starting branch
baseline:

```text
71be41d docs: finalize phase 8 handoff
```

`71be41d` is the final Phase 8 handoff (documentation) commit, not the Phase 8
implementation checkpoint. The Phase 8 acceptance tag `phase-8-accepted`
(`954c2b7`) is reachable from that baseline.

---

## Phase 9 status

Phase 9 planning **PASSED external human/AI planning review**. The planning
specification is now **frozen for execution**. Phase 9 itself is **not
implemented and not accepted**.

- `docs/PHASE_9.md` is the frozen Phase 9 specification.
- `phase-worker` MUST NOT modify `docs/PHASE_9.md`; the edit block in
  `.opencode/agents/phase-worker.md` denies it.
- No Phase 9 implementation exists.
- No deployment has started and no Stage A–F result exists.
- Phase 9 is not accepted.
- `docs/PHASE_9_ACCEPTANCE.md` intentionally does NOT exist yet; it is created
  only when real acceptance evidence exists.

The planning changes are documentation/governance only:

```text
docs/PHASE_9.md
AGENT_HANDOFF.md
AGENTS.md
.opencode/agents/phase-worker.md
```

No production code, tests, or `package.json` files were changed by the planning
pass.

---

## Phase 9 execution model (operator-assisted)

Phase 9 is operator-assisted. Two distinct surfaces MUST NOT be conflated:

- **Human/operator live surface** — the operator performs or directly supervises
  all live actions: the real OpenClaw host and configuration outside this
  repository, Telegram bot/account/credential configuration, real Telegram
  messages, the controlled external Google Form, real Google Forms preflight, the
  single Stage F live submission, independent target inspection, and any local
  secret store coding agents must not inspect. The operator follows the frozen
  staged sequence (`docs/PHASE_9.md` §8) and returns only sanitized evidence.
- **Repository phase-worker surface** — the existing
  `.opencode/agents/phase-worker.md` contract is unchanged. It remains restricted
  (`external_directory: deny`; deny-by-default bash with a narrow allowlist; no
  external Google Form access; no work outside the repository) and MAY only
  diagnose/repair repository-local defects demonstrated by deployment evidence and
  help assemble sanitized repository acceptance evidence. It MUST NOT execute live
  Telegram/Google actions or claim live results. No new privileged agent is
  created.

A coding agent's assertion is never sufficient live evidence.

---

## Phase 9 purpose (summary)

Take the accepted Phase 8 OpenClaw/Telegram integration and prove the complete
controlled real deployment path end-to-end, staged from least to most dangerous:

```text
Stage A  deployed offline fixture analyze/draft/check
Stage B  fixture preflight
Stage C  real Telegram dedicated-account routing
Stage D  approval denial path
Stage E  controlled real Google Forms preflight (no submission)
Stage F  exactly one controlled allow-once real submission
```

A later stage MUST NOT be attempted until all earlier applicable stages pass.
Phase 9 does not redesign Phase 8 and does not add major new capabilities.

---

## Accepted Phase 8 baseline and Git roles

Phase 8 is accepted, closed, and integrated into `main`. Three distinct Git
facts MUST NOT be confused:

**Phase 8 implementation checkpoint** (the code/test state that was reviewed):

```text
56995a9 wip: checkpoint phase 8 implementation for runtime verification
```

**Phase 8 acceptance record/tag** (durable acceptance evidence):

```text
954c2b7 docs: record phase 8 acceptance
phase-8-accepted -> 954c2b7
```

**Phase 9 starting branch baseline** (the final Phase 8 handoff state, from which
`phase/9` was created):

```text
71be41d docs: finalize phase 8 handoff
```

`71be41d` is a documentation/handoff commit, NOT the Phase 8 implementation
checkpoint. The `phase-8-accepted` tag (`954c2b7`) is reachable from the
`71be41d` baseline.

Historical note: earlier handoffs referenced the last accepted baseline as
`fbe2ed0 feat: complete phase 7 metrics observability` (Phase 7) and treated
`phase/8` as the active development branch. That is superseded: Phase 8 is now
accepted, and `phase/9` is the development branch.

---

## Phase 8 acceptance (historical evidence)

Phase 8 acceptance evidence is recorded durably in
`docs/PHASE_8_ACCEPTANCE.md`. Independent review status at acceptance:

```text
Finding P                                  FIXED
Finding Q                                  FIXED
Finding S                                  FIXED
Finding J residual hard-bound behavior    FIXED
Adapter launcher executable/direct spawn  FIXED
Finding R real OpenClaw runtime proof      FIXED
```

Finding R real runtime verification used OpenClaw `2026.9.4 (3a9d69d)` in an
isolated temporary OpenClaw home. The plugin loaded and imported successfully,
registered `form_agent` and `form_agent_submit`, registered the `before_tool_call`
typed hook, resolved `typebox` normally, reported no missing required
dependencies, and produced no runtime diagnostics.

No real Telegram credentials, real Telegram messages, production OpenClaw state,
or real Google Form submissions were used for the Phase 8 runtime verification.

Phase 8 final regression at acceptance:

- `npm run verify:phase8`: 56 files / 400 tests passed;
- `npm test`: 119 files / 1060 tests passed;
- `npm run typecheck`: passed;
- `npm run build`: passed;
- final branch state: `phase/8...origin/phase/8`.

Do not broadly redesign or rewrite Phase 8. Previously fixed findings remain
closed. Only reopen implementation when new concrete evidence requires it.

---

## Environment preflight (historical, from Phase 8)

Dev Agent environment observed during Phase 8:

```text
Node:       v24.21.0
npm:        11.19.0
Plugin ID:  form-agent-openclaw
OpenClaw:   2026.9.4 under an isolated temporary home during Finding R
```

The plugin declares:

```text
openclaw peer dependency: 2026.9.4
pluginApi:                2026.9.4
minGatewayVersion:        2026.9.4
typebox:                  ^1.1.38
```

---

## Exact next action

Phase 9 planning PASSED external human/AI review. The reviewed planning/governance
changes are ready, but they are not yet committed (this handoff contains no future
commit hash). The next actions are:

1. commit the reviewed Phase 9 planning/governance changes
   (`docs/PHASE_9.md`, this file, `AGENTS.md`,
   `.opencode/agents/phase-worker.md`);
2. push `phase/9`;
3. begin operator-assisted Phase 9 deployment/validation;
4. execute Stages A–F in order (`docs/PHASE_9.md` §8);
5. live infrastructure actions are human/operator executed or directly
   supervised;
6. invoke `phase-worker` only if concrete deployment evidence requires
   repository-local implementation/remediation/testing;
7. record sanitized acceptance evidence in `docs/PHASE_9_ACCEPTANCE.md` only when
   real evidence exists;
8. do not automatically begin Phase 10.

Phase 9 is not implemented and not accepted. No deployment has started and no
Stage A–F result exists yet.

---

## Continuity rule

This file is the single canonical current-state handoff.

A fresh ChatGPT/OpenCode/reviewer session must not require old chat transcripts
to reconstruct the project. It should read:

1. `AGENTS.md`;
2. this file;
3. `docs/AI_REVIEW_PROTOCOL.md`;
4. `docs/PHASE_9.md`;
5. Git branch/history/diff;
6. relevant implementation/tests.

If any of those sources disagree, inspect Git/repository evidence and report the
mismatch instead of silently reconciling it.
