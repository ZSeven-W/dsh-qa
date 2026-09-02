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
* **the action's own echo is not a change.** Every action that writes a value
  onto its own target — `fill`, `type`, `select` (the chosen option), and
  `key`/`press` — is echo-masked, or the write would satisfy `awaitChange`
  by itself, close the window at one quiet window (300ms), and miss a downstream
  consequence still in flight (a suggestion list, a fetch-backed status). The
  mask is built from the PRE-ACTION observation (`QaEchoMask` in
  settle.ts): the exact pre-action ref (identity inside the baseline observation
  only — the browser driver re-mints refs on every later observation), the full
  pre-action predicate with EMPTY role/name/tag strings kept as exact matchers,
  and the driver-normalized written value. A node's `value` AND `name` are
  masked from the CHANGE decision only when the node IS the echo target, decided
  per observation as follows (a change on any OTHER node is legitimate
  evidence):
  1. it carries the echo's exact pre-action ref (baseline observation only); or
  2. its `value` equals the normalized written value AND it matches the full
     pre-action predicate, OR its role/tag match the pre-action target
     (name-agnostic — this is what keeps the mask working when the fill REWRITES
     the target's accessible name, e.g. `aria-label` derived from the value:
     "Search" -> "Search: async"); or
  3. its role/tag match the pre-action target AND its (new) name CONTAINS the
     written value (a renamed target that announces the value in its name is
     still the echo even when its value is withheld); or
  4. it is the ONLY node in the observation matching the full predicate — a
     unique target is the echo whatever its value is (a page transform, a
     withheld value, an echo that has not landed yet, or a `key`/`press` whose
     written value is unknowable ahead of time — `key`/`press` masking is
     therefore only sound for unique targets); or
  5. it matches the predicate AND its value is still empty — with SEVERAL
     predicate matches (duplicate role/name/tag, or an empty name shared by
     siblings) only the twin carrying the written value is masked, an
     empty-valued twin is masked as the pre-write state, and a sibling's
     NON-EMPTY value that differs from the written value is NEVER masked: that
     change is legitimate evidence and unblocks `awaitChange` within one quiet
     window. Because the masked projection replaces the echo target's name and
     value with null, a name the fill itself rewrote never satisfies
     `awaitChange` either, while the quiet window still uses the FULL
     projection (the rename and every downstream consequence restart the quiet
     window). A synchronous UI with a real downstream consequence still costs
     one quiet window; only a write into a completely inert field spends the
     budget.

### A fill is proven by its own value

`dsh-browser` contract v5 adds a bounded `value` to semantic nodes for editable
controls (secret-bearing controls are `valueWithheld` and never carry a value).
The exporter therefore prefers the TARGET's own value for a fill: when the
settled proof observation shows the target carrying the typed text
(driver-normalized), it synthesizes a `node-value` assertion on the target
rather than hunting for some other node that changed. That is the most
proximate and durable evidence possible, and it outranks every delta candidate.
The fallback to delta ranking stays for fills whose target value is withheld
(secret), truncated, absent (non-editable), or transformed by the page. When
the fill REWROTE the target's accessible name, the exporter follows the same
identity rule the echo mask uses: it looks up the written value on a node whose
ROLE matches the pre-action target (name-agnostic), requires that node's
(role, name) predicate to be unique in the settled view, and binds the
`node-value` assertion to the node's CURRENT name — so the proof stays the
target's own value and never degrades to `node-present` of the renamed field
alone.

At REPLAY, `node-value` re-checks the same rules (defense in depth for
hand-written scenarios): the matching predicate must identify EXACTLY ONE node
(more than one fails with `TARGET_NOT_UNIQUE` — a twin that already holds the
recorded value proves nothing about the recorded target), and a
`valueWithheld`/`secure`/`valueTruncated` node can NEVER satisfy it, even
when a leaked `value` field happens to carry the expected string
(`VALUE_WITHHELD` / `VALUE_SECURE` / `VALUE_TRUNCATED`). Both refusals fail
closed with their code in report.json and report.md.
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
  failure ("the ... observation never settled within the 2500ms settle budget"),
  and the failure now carries the machine code `INCONCLUSIVE_UNSTABLE` in
  `failure.code` (rendered in report.md) so the non-result is distinguishable
  from an ordinary assertion failure without parsing prose.
* replay target resolution — an action target whose predicate matches more than
  one observable node fails closed with `TARGET_NOT_UNIQUE` (the same
  vocabulary as export's exclusion) instead of acting on the first match: a
  twin that already holds the recorded value would otherwise turn the step's
  `node-value` into a false green while the recorded target stays empty.

Nothing is widened to make an unstable page pass. An unstable page is honestly
unprovable.

## Explore tool surfaces fail closed too

The live Explore tools enforce the SAME rule the runner does, instead of
returning a false green on an unsettled view:

* **`qa_assert`** — when the settle window closes with `stable: false` the
  result is
  `{ ok: true, passed: false, inconclusive: true, code: "INCONCLUSIVE_UNSTABLE", ... }`
  with `observed: null` and a `reason` telling the agent to wait and re-observe.
  `passed` is never `true` from an unstable view, and the decision is never even
  evaluated against churn. `INCONCLUSIVE_UNSTABLE` is the same honest non-result
  vocabulary as `INCONCLUSIVE_TRUNCATED` (that code means "the view was
  truncated at its node budget", this one means "the view never stopped
  changing inside the settle budget").
* **`qa_act`** — a confirmed/unknown receipt still reports the dispatch honestly
  (`outcome: "ok"` / `"unknown"`), but when the proof window never settled the
  result ADDS `proven: false` and `code: "INCONCLUSIVE_UNSTABLE"`. The receipt
  stays `confirmed` (the dispatch DID happen); what is unproven is the
  CONSEQUENCE, because nothing in an unstable view is attributable to the action.
* **visual (`qa_assert kind:"visual"` and Replay advisory)** — the capture's
  settle window travels beside the verdict as
  `settle: { stable, passes, budgetMs }`, and when `stable === false` the finding
  also carries `captureSettled: false`, rendered next to the verdict in
  report.md and report.json. Advisory semantics are unchanged (a visual finding
  never changes pass/fail). `qa_evidence` visual captures carry the SAME
  `settle` + `captureSettled: false` vocabulary (tools.ts AND server.mjs), so
  an evidence frame from a churning page is marked, never silently presented.

All three surfaces reuse the one `INCONCLUSIVE_UNSTABLE` code, so an agent sees a
single vocabulary: an unsettled result is a non-result — never a pass and never
an ordinary failure — and the recovery is always the same (wait for the page to
stop changing, then re-observe).

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
| `fixtures/web/async-suggest.html` | mode A (suggestion after 350ms, and again close to the budget at 1800ms) | fill step exported WITH a `node-value` proof on the target (the late suggestion is still observed so the next click can reach it); replay passes twice with an identical deterministic projection |
| `fixtures/web/hydration-churn.html` | mode B (a far-away link renames itself 10ms after the keystroke, the real suggestion lands at 220ms) | the churning node never becomes the assertion; replay unaffected by the rename |
| `fixtures/web/never-settles.html` | a page that never holds still (90ms ticker) | export refuses (`ASSERTION_NOT_PROVABLE` / `NO_PROVEN_STEPS`); replay fails honestly instead of passing by luck |

Unit-level twins with synthetic drivers: `test/settle.test.mjs`. End-to-end with
a real browser: `test/explore-replay-async.integration.test.mjs`.
