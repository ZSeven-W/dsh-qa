# Bounded settle: proving asynchronous outcomes without flakiness

Source: `src/session/settle.ts` · applied by `src/session/session.ts` ·
consumed symmetrically by `src/explore/export.ts` and `src/replay/runner.ts`.

## The defect this exists to remove

Both sides of the Explore -> Replay loop used to judge exactly ONE observation
taken immediately after an action, with no settle and no retry. Real UIs are
asynchronous, so that single-shot proof observation is a race — and it loses in
both directions. Both modes below were observed by hand against live Wikipedia:

* **A — the outcome arrives too late.** A `fill` in the search box whose only
  semantic delta is the async suggestion listbox was excluded at export time
  with `ASSERTION_NOT_PROVABLE`. The exported scenario then had no fill step at
  all, so replay could never reach the suggestion and died with
  `no observable node matches the action target`.
* **B — unrelated churn arrives instead.** MediaWiki rewrites an unrelated
  link's accessible name after hydration ("`... [o]`" becomes
  "`... [ctrl-option-o]`"). The exporter mistook that rename for the fill's
  proof; replay, running faster, still saw the pre-hydration spelling and failed
  an assertion that had nothing to do with the action.

## The policy

One settle window = observe repeatedly until the **semantic projection** holds
still, or until a bounded budget is spent.

* **Projection** (`projectSemanticView`) — URL, title, and every node's
  role/name/tag/state/href/viewport membership in document order. Session-local
  identity (refs, observation ids, fingerprints, pids, window numbers, window
  geometry) is excluded: it changes on every read and would make every page look
  unstable. Nothing a scenario can address or assert on is excluded.
* **Quiet window** (`QA_SETTLE_QUIET_MS`, 300ms) — how long the projection must
  stay unchanged to count as settled. It subsumes "two consecutive observations
  agree" (several consecutive observations must agree) and closes that rule's
  hole: two back-to-back reads of a view whose change has not started yet are
  equal. A follow-up change arriving within the quiet window keeps the window
  open, so ONE window covers late hydration churn *and* the slower real outcome
  behind it.
* **awaitChange** — for the PROOF observation right after an action, silence is
  not a conclusion: an outcome still in flight is indistinguishable from no
  outcome. Such a window keeps polling until the view differs from the
  pre-action baseline and then quiets down, or until the budget is spent. An
  outcome that already landed synchronously is recognised through that baseline,
  so a synchronous UI still costs only one quiet window.
* **Budget** (`QA_SETTLE_BUDGET_MS`, 2500ms) — the hard bound. In practice this
  policy can prove an outcome landing up to roughly `budgetMs - quietMs` after
  the action; a slower page needs a bigger configured budget and is never
  silently accepted.
* **Poll interval** (`QA_SETTLE_INTERVAL_MS`, 50ms) — spacing between
  observations inside a window. This is a poll interval, not a sleep: a settled
  view returns immediately after its quiet window.

A fixed sleep was rejected on purpose: it is both slower (it always waits) and
less reliable (it never checks that the view actually stopped moving).

## Symmetry and fail-closed

`QaSession` owns the policy, so Explore and Replay cannot drift apart:

| Observation | Explore | Replay |
| --- | --- | --- |
| before an action | `observeSettled()` (qa_observe / qa_assert) | `observeSettled()` (initial view) |
| proof after an action | `act()` -> `observeSettled({ awaitChange })` | `act()` -> `observeSettled({ awaitChange })` |
| final view | last step's proof observation | `observeSettled()` (final assertions) |

Both sides refuse an unsettled view:

* export — the recorder stores `afterObservationStable`; anything other than
  `true` is excluded as `ASSERTION_NOT_PROVABLE` ("the post-action view never
  stabilized within the settle budget"), and a trajectory with no provable step
  still writes no file (`NO_PROVEN_STEPS`);
* replay — an unsettled initial, post-action, or final observation is a run/step
  failure ("the ... observation never settled within the 2500ms settle budget").

Nothing is widened to make an unstable page pass. An unstable page is honestly
unprovable.

## Target-proximate evidence

Among the semantic deltas in the settled proof observation, evidence on or near
the action target (within `PROXIMATE_NODE_DISTANCE` document-ordered nodes) is
ranked above evidence anywhere else, then by outcome-announcing role
(alert/status/dialog/heading), then by document order. A distant delta is still
exported — dropping it would re-introduce failure mode A — but the step's intent
records the weakness ("Weak proof: the only observable change was away from the
action target (...) — verify manually.") and the assertion description says so
too.

## Configuration

```ts
new QaToolHost({ settle: { budgetMs: 5_000, quietMs: 400 } })   // Explore + qa_replay_run
runScenario(scenario, adapter, { settle: { budgetMs: 5_000 } }) // Replay directly
```

Environment overrides (clamped, garbage falls back to the defaults, never fails
open): `DSH_QA_SETTLE_BUDGET_MS`, `DSH_QA_SETTLE_QUIET_MS`,
`DSH_QA_SETTLE_INTERVAL_MS`.

## Determinism

Settling changes duration, not outcome: the settled observation is the
deterministic artifact. Pass counts and elapsed times stay out of the run report,
so the two-run byte-identical determinism check
(`normalizeReportForDeterminism`) is unaffected.

## Regression fixtures

| Fixture | Reproduces | Proof |
| --- | --- | --- |
| `fixtures/web/async-suggest.html` | mode A (suggestion after 350ms, and again close to the budget at 1800ms) | fill step exported WITH a proof assertion; replay passes twice with an identical deterministic projection |
| `fixtures/web/hydration-churn.html` | mode B (a far-away link renames itself 10ms after the keystroke, the real suggestion lands at 220ms) | the churning node never becomes the assertion; replay unaffected by the rename |
| `fixtures/web/never-settles.html` | a page that never holds still (90ms ticker) | export refuses (`ASSERTION_NOT_PROVABLE` / `NO_PROVEN_STEPS`); replay fails honestly instead of passing by luck |

Unit-level twins with synthetic drivers: `test/settle.test.mjs`. End-to-end with
a real browser: `test/explore-replay-async.integration.test.mjs`.
