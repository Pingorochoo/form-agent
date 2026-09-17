---
name: form-agent
description: How to use the Form Agent typed tools (form_agent, form_agent_submit) safely.
---

# Form Agent tools

Use the typed plugin tools for all Form Agent work. Do not shell out, do not run
`exec`, and do not construct commands.

## `form_agent`

A closed operation enum with validated arguments:

- `analyze` — requires `target` (fixture only).
- `draft` / `draft_review` — require `target` (fixture only); optional `draftProvider`.
- `check` — requires `target` (fixture only); optional `draftProvider`.
- `preflight` — requires `target` (fixture or Google Forms responder URL);
  optional `draftProvider`; optional `reviewAnswers`.
- `metrics` — optional `since` / `until` (RFC3339 with timezone).
- `cancel_pending` — no arguments; cancels only a `pending` (not yet approved) plan.

Rules enforced by the plugin and the adapter:

- A known field that is invalid for the selected operation is a usage error.
- Unknown fields are rejected.
- You never supply a plan id, seed, pending id, executable, path, cwd, env, or
  identity. Those come only from trusted state.
- `preflight` registers a server-side pending plan and never fills or submits.

## `form_agent_submit`

- Takes NO arguments.
- Runs only the already-registered pending plan.
- Always pauses for host-mediated operator approval. Only an explicit
  `allow-once` proceeds; `deny`, timeout, or no approval route fails closed and
  leaves the pending plan intact.
- The operator sees the full canonical target and the full plan id.

## Review values

- `draft_review` is exploratory and is NOT submission-bound.
- `preflight --review-answers` shows eligible values from the SAME preflight
  result; it is submission-bound to that pending plan.
- Review values are delivered to the authorized operator directly and are never
  returned to you as model-visible content.

## Blocked and unknown outcomes

- A Form Agent block stays a block.
- An ambiguous submission outcome is never retried and is never reported as
  success. Tell the operator that local reconciliation is required.
