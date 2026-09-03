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
- A `fill` is proven by its OWN target's value: when the fresh observation shows the target carrying the typed text, the exporter synthesizes a `node-value` assertion on that target — including when the fill REWROTE the target's accessible name OR role (`aria-label` following the value: "Search" → "Search: async", or `textbox` → `combobox` once suggestions open); the exporter then follows the same identity rule the echo mask uses (match by name role-agnostic OR by role name-agnostic, unique among candidates) and binds the assertion to the node's MOST STABLE predicate — the unique accessible name alone (role omitted) when the role changed, so a fast replay still matches before the role switch; `role+name` only when the name alone is ambiguous — never `node-present` of the renamed field alone. A secret-bearing control (`valueWithheld`: password / one-time-code / cc autocomplete) never carries a value, so no value assertion is synthesized for it.
- The settle window echo-masks the action's own value write (`fill`/`type`/`select`, and `key`/`press` on a uniquely identified target), so a downstream consequence that lands after the echo is still waited for — a fresh observation that only shows the echo never proves the action alone.
- After the first non-echo change is observed, the quiet window lengthens to `postChangeQuietMs` (default 2× `quietMs`), measured from the last change, so an outcome landing after early unrelated churn (a sibling mirroring the typed value, a late hydration rename) is still captured rather than cut off by one short quiet window.
- Assert resulting state with `qa_assert`; do not repeat the action to test whether it landed. `node-value` (`expected: { role?, name?, tag?, value }`) asserts a node's exact current value and is deterministic, like `node-present` / `node-absent` / `page-url`. It demands the predicate identify EXACTLY ONE node (`TARGET_NOT_UNIQUE` otherwise — a twin already holding the value proves nothing), and a `valueWithheld`/`secure`/`valueTruncated` node can never satisfy it (`VALUE_WITHHELD`/`VALUE_SECURE`/`VALUE_TRUNCATED`).
- A view can also be UNSTABLE: when a fresh observation's `settle.stable` is `false` the page never stopped changing inside the settle budget, so nothing in it proves anything. `qa_assert` then returns `passed: false` with `inconclusive: true` and `code: "INCONCLUSIVE_UNSTABLE"` (the same non-result vocabulary as `INCONCLUSIVE_TRUNCATED`) — never a false green; wait for the page to stop changing, then re-observe. A `qa_act` on an unstable proof window keeps its receipt honest (`confirmed` / `unknown`) but adds `proven: false` plus `code: "INCONCLUSIVE_UNSTABLE"`: the dispatch happened, the consequence is unproven.
- A view can be TRUNCATED at the node budget, and a node outside that window still exists. An absence therefore cannot be proven from a truncated view: `node-absent` re-observes once at a raised budget and then fails closed with `completeness.reason: "INCONCLUSIVE_TRUNCATED"` instead of reporting a false "gone". Read `completeness` before believing any negative result — "we did not see it" is not "it is not there". A node that WAS returned is sound evidence of presence either way.
- Call `qa_evidence` at the moment a problem appears, before navigating away or changing the state. Missing permissions, truncation, and driver rejection are boundaries, not passes.

## Visual assertions: trust the verdict, never the narration

- `qa_assert kind:"visual"` is ADVISORY and never changes pass/fail. Trust `verdict` and `confidence`; they are the model's answer.
- Never quote details from `reasoning` as observed fact. It is unverified model narration and it invents detail: in a live run the model correctly answered `yes` (confidence 1.00) to "is the serif WIKIPEDIA wordmark present" and then narrated "with the puzzle globe logo", which was not on the page. Every advisory record carries `reasoningTrust: "unverified-model-narration"`, and report.md renders the text as a labelled "model narration" blockquote.
- Need a detail confirmed? Ask a separate visual question about it, or prove it with `node-present` / `node-absent` / `page-url`.
- A visual assertion takes its own fresh settled observation before capturing, so it works right after `qa_act` or `qa_evidence`; no extra `qa_observe` is needed. A capture you pinned with `visual_fingerprint` is never silently refreshed, so a stale pin is refused by design.
- A visual finding carries `settle: { stable, passes, budgetMs }` from the observation it captured from. When `settle.stable` is `false` the finding also carries `captureSettled: false`: the advisory verdict is over a view that never stopped changing, so it proves nothing about the page. A `qa_evidence` visual capture carries the SAME `settle` + `captureSettled: false` vocabulary.

## Export rule

Call `qa_record_export` with the same owner and a `.json` `output_path` whose parent already exists under the current workspace or temporary directory.

Export is deliberately strict:

- an action target must resolve uniquely in its preceding observation by non-empty **role + accessible name**;
- every exported step gets an assertion synthesized from and evaluated against the immediate fresh observation after that action; a fill is proven by its own target's value (`node-value`);
- unknown receipts require an observable semantic delta or URL change (a fill's own value counts);
- rejected, failed, undispatched, unobserved, redacted, unnamed, duplicate, volatile, and Replay-unsupported actions are excluded with a structured reason;
- a delta whose accessible name is a concatenation of its children's text (an ordering-fragile container such as a `search`/`list`/`listbox` whose name exceeds ~80 characters) is never exported as a proof — skipped in favour of a sound delta, or `FRAGILE_PROOF_ONLY` when it is the only change;
- if no proven step remains, export returns `NO_PROVEN_STEPS` and writes no file.

Inspect `excludedActions`: exclusion is not success. Run `qa_replay_run` on the exact exported file without hand editing it. Only a `pass` report closes Explore→Replay. A failed run carries a machine `failure.code` for recognized non-results — `INCONCLUSIVE_UNSTABLE` (a view that never settled) and `TARGET_NOT_UNIQUE` (an ambiguous action target) — so you never have to parse prose to tell them from an ordinary assertion failure.
