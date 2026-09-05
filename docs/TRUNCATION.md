# Observation truncation and assertion soundness

Every observation is budget-limited. `QaObservation.truncated` is true when the
driver returned fewer nodes than the page/app actually exposes (the browser
driver defaults to 60 nodes and clamps a request to 100; the computer driver
defaults to 200 and clamps to 500, and both also enforce a byte ceiling).

A truncated view is **incomplete, not empty**. That single fact decides what an
assertion may conclude from it.

## `node-absent` means "no driver-OBSERVABLE semantic node"

The driver's projection is of **observable semantic nodes**: elements hidden by
`visibility:hidden`, `display:none`, `opacity:0`, or zero client rects are
skipped by the visibility gate and are NOT returned and NOT counted. So
`node-absent` never claims "the element is not in the DOM" — it can only claim
"no OBSERVABLE node matched". A control that exists but is momentarily hidden
(fade-in, `content-visibility`, a collapsed panel) is invisible to every
absence claim by design, and a reader must not treat an absence pass as a
DOM-level fact.

## Absence passes are SUSPENDED until the driver verifies coverage (QA-BL-052)

Even a **complete** observation — scoped or whole-page — cannot currently prove
an absence. The driver does not yet verify the observation's **boundaries**:
closed shadow roots inside the subtree are neither pierced nor counted, and
slot assignment may be unresolved, so a view that reports `truncated: false`
can silently miss whole subtrees of semantic nodes. The audit (zcode
REPORT.md, F1/F2) showed the old "a complete scoped view proves absence" claim
was unsound exactly this way.

Containment, fail-closed: an otherwise-passing `node-absent` (no match on a
complete view) now fails closed with `passed: false`, `inconclusive: true`, and
the reason code **`COVERAGE_UNVERIFIED`** — scoped AND whole-page views alike.
The gate is per-observation affirmative evidence (`QaObservation.coverageVerified
=== true`, to be provided by the driver's coverage probe in contract v9 Phase
C); it is never a driver-version check, and no adapter reports the field yet —
that is the point. The moment a driver reports `coverageVerified: true` on the
deciding observation, the proven-absence pass returns (the restoration path is
pinned by tests). `INCONCLUSIVE_TRUNCATED` semantics for truncated views are
unchanged, and a returned matching node still fails `node-absent` normally.

The `completeness.detail` for the coverage refusal says, in plain words, that
no observable node matched but the observation's boundaries (closed shadow
roots, slot assignment) were not verified, so the absence is UNPROVEN — not
"not present".

## The rule

| claim | truncated view | why |
| --- | --- | --- |
| a node WAS returned | sound | the driver returned it, so it exists |
| `node-absent` and nothing matched | **unprovable** | the node may exist outside the window |
| `node-present` / `node-in-viewport` and nothing matched | **unprovable** | same reason, opposite direction |
| `node-value` and EXACTLY ONE unflagged node with the expected value was returned | sound | the node and its value were both reported |
| `node-value` and nothing matched | **unprovable** | the node (and its value) may exist outside the window |
| `node-value` and several nodes match, or the match is flagged | refused, not a pass | a twin holding the value proves nothing about the recorded target (`TARGET_NOT_UNIQUE`); a `valueWithheld`/`secure`/`valueTruncated` node can never satisfy it (`VALUE_WITHHELD` / `VALUE_SECURE` / `VALUE_TRUNCATED`) — both fail closed with their code, in a complete or truncated view alike |
| `page-url` | sound | the URL is carried by every observation |

Evidence of presence is sound; absence of evidence is not evidence of absence.

## What the code does

1. **`node-absent` can never pass on a truncated observation.**
   `evaluateAssertion` (src/replay/assertions.ts) fails it closed, and the
   result is marked `inconclusive` rather than silently converted into an
   ordinary "not present". Since QA-BL-052 it can also never pass on a
   COMPLETE observation whose boundaries the driver has not verified
   (`coverageVerified !== true`): that outcome fails closed with
   `COVERAGE_UNVERIFIED` and a completeness block explaining that the absence
   is UNPROVEN — see the section above.

2. **One bounded budget escalation before concluding.** When an outcome would
   be decided against a truncated view — any absent-claim, or a present /
   in-viewport / value claim that found nothing — `decideAssertion` re-observes ONCE at
   `QA_ESCALATED_NODE_BUDGET` (500, clamped by each driver to its own maximum)
   and decides against that fuller view. It never loops, never escalates twice,
   and a present-claim that already found its match never escalates at all. The
   escalated observation is SETTLED like every other proof observation; an
   unsettled one is refused and the decision falls back, still fail-closed.

3. **Still truncated ⇒ fail closed with a distinct reason.** The result carries
   `completeness.reason: "INCONCLUSIVE_TRUNCATED"` and a detail naming the
   budget, and the runner's failure message says so instead of "assertion
   node-absent failed".

4. **The report explains itself.** Whenever truncation touched a decision, the
   step / assertion result carries `completeness` (`truncated`, `nodeBudget`,
   `escalated`, `outcomeDependsOnCompleteView`, `reason`, `detail`) into
   report.json, report.jsonl, and a "view completeness" line in report.md. A
   human triaging a failure can tell "not present" from "we could not see the
   whole page". The field is additive: `schemaVersion` stays 1, and a result
   decided against a complete view is unchanged.

5. **The same blind spot elsewhere.**
   - The replay runner resolves an action target the same way: a target missing
     from a truncated view triggers the same single escalation, and the failure
     message names `INCONCLUSIVE_TRUNCATED` instead of claiming the target is
     not on the page. This is the live scroll case: after a scroll the target
     was absent from the 60-node view and present at 100. A target whose
     predicate matches SEVERAL nodes never escalates (a fuller view can only
     add more matches): it fails closed with `TARGET_NOT_UNIQUE` — acting on
     the first match would be a guess.
   - The Explore exporter cannot re-observe a recorded trajectory, so when a
     proof observation was truncated it records the weakness in the step intent
     ("Weak proof: the proof observation was truncated at the driver node
     budget …") exactly like the existing distant-delta weakness — but ONLY when
     truncation can actually weaken the assertion: a delta-derived
     `node-present` / `node-in-viewport` (an "apparently new" node may have
     been there all along, outside `before`'s window). A `page-url` (the URL
     travels on every observation) and a `node-value` on a FOUND target (a
     returned node really carries the reported value, per the rule table above)
     are sound even on a truncated view, so no weakness note is attached to
     them.
   - An action ref missing from a truncated preceding observation is excluded
     with a detail that says the target may have fallen outside the window.

6. **A positive-existence "not found" is retried, bounded by the settle budget.**
   `decideAssertionWithRetry` (src/replay/assertions.ts) re-observes a
   `node-present` / `node-value` / `node-in-viewport` / `page-url` that was
   first decided "not found" (including the `INCONCLUSIVE_TRUNCATED` branch
   taken after the single escalation): a slow page's late node or role switch is
   not absence. Each re-observation is SETTLED at `QA_ESCALATED_NODE_BUDGET`;
   the loop stops as soon as the assertion is found (a returned node is sound on
   any view) or the budget is exhausted, and the step / assertion result
   records `attempts` and `elapsedMs` (rendered in report.md, excluded from the
   determinism projection as duration, not outcome). When the retry exhausts the
   budget without finding its target AND the session's widen gate has not fired
   AND `adaptiveBudgetMs > budgetMs`, it widens ONCE through the SAME
   once-per-session gate as the unstable settle path (recorded with
   `cause: "assertion-retry"`) and keeps retrying until `adaptiveBudgetMs`
   measured from the retry's original start — so a page that settles FAST but
   renders the node slowly is found instead of failing when the budget is below
   page latency. `node-absent` is NEVER
   retried — absence is never proven by waiting, only by having seen the whole
   view — and a structural refusal (`TARGET_NOT_UNIQUE`, `VALUE_WITHHELD` /
   `VALUE_SECURE` / `VALUE_TRUNCATED`) is deterministic and never resolves by
   waiting either.

## Scoped observation changes what truncation means (browser driver contract v8)

Since contract v8 the browser driver can root an observation at ONE element
(`observe(owner, { within })`); dsh-qa exposes it as `qa_observe within_ref`
(`QaObserveOptions.withinRef`). The ref comes from the caller's CURRENT
(latest, unexpired) observation and is resolved exactly like an action ref —
an unknown, expired, consumed, non-element, or detached ref REFUSES the call
(`REF_INVALID` / `REF_UNKNOWN` / `OBSERVATION_REQUIRED` / `REF_EXPIRED` /
`PAGE_CHANGED` / `TARGET_UNBINDABLE` / `TARGET_CHANGED` /
`WITHIN_NOT_ELEMENT`), never falling back to a whole-page view.

Inside a scoped observation, **`maxNodes`, the 48 KiB byte ceiling, the scan
window, and the iframe marker are all subtree-relative**. A subtree that fits
reports `truncated: false` with NO `truncationReasons`. That is the whole
point: the browser clamp stays at 100 nodes (the byte ceiling caps emission
at ~221 anyway), so scoping — not a bigger budget — is how a deep target is
reached (an absence stays UNPROVEN until coverage is verified, see above).
`QaObservation.scope`
(`{ ref, role, name, tag }`) echoes the root the driver observed and is
absent for whole-page observations; node `inViewport` keeps whole-page
viewport-intersection meaning.

What it changes for the soundness rules above:

- `node-absent` with nothing matched **no longer passes even on a COMPLETE
scoped view** (QA-BL-052): closed shadow roots inside the container and
unresolved slot assignment are unverified, so a complete-looking scoped view
can silently miss nodes. It fails closed with `COVERAGE_UNVERIFIED` until
the deciding observation carries `coverageVerified: true` (driver contract
v9, Phase C) — exactly like whole-page absence claims.
- A scoped view that is STILL truncated escalates **within the same scope**
(one bounded re-read at `QA_ESCALATED_NODE_BUDGET` carrying the same
`withinRef`), never by widening to the whole page; a still-truncated scoped
view fails closed with `INCONCLUSIVE_TRUNCATED` exactly like an unscoped
one. Unscoped truncated views keep their exact escalation and
`INCONCLUSIVE_TRUNCATED` semantics.
- `completeness` now names the scope whenever the deciding view was scoped
(additive `scope: { role, name }`), and a scoped deciding view ALWAYS
reports completeness — complete or truncated — so "absent from this
container" can never be read as "absent from the whole page" (and since
QA-BL-052 NEITHER is provable until the driver verifies coverage). The
detail string and report.md say which container the outcome was decided
inside.
- Replay: a scenario assertion may carry `scope: { role, name, tag? }`
(loader-validated fail-closed; the name may be empty). The runner resolves
that container in the whole-page view by UNIQUE predicate — ambiguous
containers are refused with the existing `TARGET_NOT_UNIQUE` vocabulary,
never guessed. QA-BL-054: ZERO matches in a truncated whole-page view may
mean the container sits outside the window, and ONE match in a truncated
view is NOT proven uniqueness (a twin may sit outside the window) — both
escalate the whole-page budget ONCE, and a still-truncated view refuses
with `INCONCLUSIVE_TRUNCATED` naming the scope. It then takes a SETTLED
scoped observation within the container and decides the assertion against
that scoped view; driver refusals on the scoped read surface as themselves
(their code rides into `failure.code`), never as a "not found". After a
scoped decision the runner refreshes the whole-page view (settled,
fail-closed on an unstable refresh) because the scoped read consumed the
observation the container was resolved from.
- Export records the scope when the explorer used one AND the scope is
PROVEN durable (QA-BL-054): an assertion whose deciding proof observation
was scoped is exported with the container's `scope: { role, name }` only
when that predicate (role+name, plus tag when needed to disambiguate)
matches EXACTLY ONE node in the recorded BASELINE observation (the action's
pre-action view) and that baseline is COMPLETE (`truncated: false`). An
empty accessible NAME is a legitimate predicate value and is kept literally
(`name: ''`). Anything else EXCLUDES the step with `SCOPE_NOT_DURABLE` — a
scoped proof is never silently exported as if it were a whole-page proof.
`page-url` is never scoped (the URL travels on every observation). When the
action's PRECEDING observation was scoped, the step intent records that the
target's whole-page uniqueness was not verified at export.
- The computer driver has no scoping: a `withinRef` there is REFUSED with a
clear error, never silently ignored.

## Record-time scroll-proof escalation (Explore recording only)

Explore cannot re-observe a recorded trajectory, so the recording session
takes the ONE bounded escalation at RECORD time instead: a browser
`scroll`-by-ref whose settled post-action proof observation is truncated AND
still lacks the action target in the viewport gets one more SETTLED read at
`QA_ESCALATED_NODE_BUDGET`.

**Scoped preference RETIRED (QA-BL-055).** The QA-BL-050 container-heuristic
SCOPED escalation is switched OFF: the audit (F4) showed the nearest-
container heuristic can pick a NON-ancestor (the driver exposes no ancestry),
and a same-identity twin inside the wrong container can then satisfy the
proof — matching by role+name+tag across observations is not identity. A
target beyond the clamped 100-node whole-page window is therefore NOT
provable today, and the scroll step is honestly excluded at export (the deep-
target fixture test pins this exclusion until contract v9's identity anchor
restores the capability). The ONE escalation is the WHOLE-PAGE read again
(QA-BL-045/047 behaviour, all acceptance properties intact):

**Whole-page acceptance rule (unchanged).** The escalated view must EXTEND
the settled one (same page URL/title and every settled node unchanged at the
front in the same order — the page is still the exact state the settle window
proved), the window must have settled (`stable`), and the target must be
returned with `inViewport: true`.

The recorded proof observation keeps its own honest `truncated` flag and
its `scope`, and export carries the scope onto the synthesized assertion
(`withProofScope`), so a scoped proof is never exported as a whole-page
proof. Replay resolves a scoped step's action target INSIDE the same
container (settled, with one in-scope escalation when the scoped view is
still truncated), so such scenarios replay even though the target is
unreachable whole-page.

Anything else — an unsettled window, a page that changed between the reads,
or a fuller view that still does not place the target in the viewport — keeps
the settled observation (fail closed). The escalation is at most ONCE per
action, never loops, and is browser-only and recording-only (replay and plain
adapters never escalate). It is SIDE-EFFECT-FREE: the escalated read never
widens the settle budget, never flips the once-per-session widen gate, never
re-persists the session policy, and never replaces the session baseline — the
next action still compares against the action's own settled observation.
An accepted escalation is visible on the `qa_act` result as
`proofEscalated: true` plus the escalated window's report under
`escalatedSettle` (the action's own window stays under `settle`). QA-BL-058:
when the escalated read itself THROWS (a driver refusal such as PAGE_CHANGED /
REF_EXPIRED — previously swallowed into a silent "no escalation"), the result
DISCLOSES it as `escalationRefused: { code?, reason }`; the proof stays the
settled observation either way (fail closed). The recorder re-binds the proof
by the EXACT recorded action id carried on the receipt: a null or
non-matching id (e.g. a concurrent act settled in between) is refused and
recorded as a recording issue, never silently re-bound to the wrong action.

## Budget

`QA_ESCALATED_NODE_BUDGET` is a named constant in src/replay/assertions.ts.
Raising it is a deliberate, bounded change; escalation stays single-shot because
an unbounded retry loop would turn an honest "I cannot see the whole page" into
an expensive one.
