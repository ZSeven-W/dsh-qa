---
name: qa-explore
description: Explore an app autonomously with dsh-qa, preserve evidence and driver safety decisions, export only freshly observed outcomes, and replay the exact exported scenario.
---

# Explore with dsh-qa

Use this loop: **start → observe → choose one semantic target → act → inspect the fresh observation → assert → capture evidence when a problem appears → export → replay → stop**.

## Method

- Keep one explicit `owner` from `qa_session_start` through `qa_record_export`.
- Begin with `qa_observe`. Prefer a unique role plus accessible name. Treat refs, coordinates, indices, observation ids, and generated ids as ephemeral live-session handles.
- Perform exactly one `qa_act`, then inspect its fresh post-action observation before deciding what happened. Re-observe when diagnosing, and never reuse an old ref.
- An `unknown` receipt is never success. It needs a semantic delta or URL change in the fresh observation. A `rejected` or `failed` receipt is a hard stop; honor every driver safety rejection and never route around it.
- Assert resulting state with `qa_assert`; do not repeat the action to test whether it landed.
- Call `qa_evidence` at the moment a problem appears, before navigating away or changing the state. Missing permissions, truncation, and driver rejection are boundaries, not passes.

## Export rule

Call `qa_record_export` with the same owner and a `.json` `output_path` whose parent already exists under the current workspace or temporary directory.

Export is deliberately strict:

- an action target must resolve uniquely in its preceding observation by non-empty **role + accessible name**;
- every exported step gets an assertion synthesized from and evaluated against the immediate fresh observation after that action;
- unknown receipts require an observable semantic delta or URL change;
- rejected, failed, undispatched, unobserved, redacted, unnamed, duplicate, volatile, and Replay-unsupported actions are excluded with a structured reason;
- if no proven step remains, export returns `NO_PROVEN_STEPS` and writes no file.

Inspect `excludedActions`: exclusion is not success. Run `qa_replay_run` on the exact exported file without hand editing it. Only a `pass` report closes Explore→Replay.
