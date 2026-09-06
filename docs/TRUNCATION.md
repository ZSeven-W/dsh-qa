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

## Absence passes require VERIFIED coverage (QA-BL-052 -> C2, contract v9)

Even a **complete** observation — scoped or whole-page — cannot prove an
absence by itself. The driver's projection has **boundaries**: closed shadow
roots inside the subtree are neither pierced nor counted by the in-page walk,
and slot assignment may be unresolved, so a view that reports
`truncated: false` can silently miss whole subtrees of semantic nodes. The
audit (zcode REPORT.md, F1/F2) showed the old "a complete scoped view proves
absence" claim was unsound exactly this way.

Since contract v9 Phase C the terminal absence decision requests the driver's
bounded CDP coverage probe on its ONE deciding re-observation — the budget
escalation already taken for a truncated view, or the single bounded re-read a
complete-but-unverified view triggers. The probe runs over the observed
subtree (the `within` root's subtree, or the whole document) under hard caps
(5,000 DOM nodes, 250 ms) and reports per-observation
`coverage: { verified, closedShadowRoots, probedNodes, reason? }`. It NEVER
runs on ordinary settle polls — only that one terminal re-read carries
`verifyCoverage`, and the session core applies the probe exactly once for the
whole decision (the settle window polls unprobed, then one probed deciding
read).

`node-absent` PASSES iff nothing matched AND `truncated: false` AND
`coverage.verified === true` — with the Codex-consult wording on the
completeness line: "No driver-observable semantic node matching {predicate}
was found within {scope|the whole page}; coverage verified (N nodes probed).
K hidden candidates excluded." (K is `hiddenMatches`, a diagnostic of the
visibility gate, marked "(lower bound)" when collection stopped early).

- A probe that **found closed shadow roots** arrives as a TRUNCATED view (the
  driver pushes the `closed-shadow-root` reason): the absence stays
  `INCONCLUSIVE_TRUNCATED`, with the reason in `completeness.detail` and
  `truncationReasons`.
- A probe that **did not run to completion** (`over-budget`, `cdp-unavailable`,
  `root-unresolved`, `error`) pushes `shadow-coverage-unverified`: same
  fail-closed outcome, reason named in both places.
- A COMPLETE deciding view whose coverage is unverified (reason `skipped` — no
  probe requested, or no coverage field at all) fails closed with
  `COVERAGE_UNVERIFIED`, naming the driver's coverage reason in the detail.
- A returned matching node still fails `node-absent` normally.

The gate is per-observation evidence, never a driver version. The probe's cost
is the reason it stays off the polls: ~5 ms scoped, and it may be over-budget
whole-page on very large pages — and then the absence is UNPROVEN, exactly as
reported.

The computer adapter IGNORES `verifyCoverage` explicitly and reports coverage
vacuously verified: the accessibility tree has no shadow-DOM boundary, so
nothing like a closed root can hide nodes from it, and the tree's own
`truncated` flag is the completeness gate.

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
   ordinary "not present". It can also never pass on a COMPLETE observation
   whose boundaries the driver has not verified (`coverage.verified !== true`):
   that outcome fails closed with `COVERAGE_UNVERIFIED` and a completeness
   block explaining that the absence is UNPROVEN — see the section above. The
   terminal absence decision takes exactly ONE bounded deciding
   re-observation requesting `verifyCoverage` (the escalation for a truncated
   view, or the single coverage re-read for a complete-but-unverified one).

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
(`{ ref, rootRef, role, name, tag }`) echoes the root the driver observed and
is absent for whole-page observations; `rootRef` (contract v9) is the fresh
per-observation ref that chains the next scoped read — it binds the root even
when the visibility gate excluded it from `nodes`, and a driver that mints no
rootRef makes the QA layer fail the chained read closed instead of
re-matching by role+name+tag. node `inViewport` keeps whole-page
viewport-intersection meaning.

What it changes for the soundness rules above:

- `node-absent` with nothing matched **passes on a COMPLETE scoped view only
with verified coverage** (C2): closed shadow roots inside the container and
unresolved slot assignment are unverified by the in-page walk, so the
deciding re-observation requests the bounded coverage probe over the SUBTREE.
`coverage.verified: true` + `truncated: false` is the pass; a probe that
found roots or did not complete keeps it `INCONCLUSIVE_TRUNCATED` naming
`closed-shadow-root` / `shadow-coverage-unverified` — exactly like
whole-page absence claims.
- A scoped view that is STILL truncated escalates **within the same scope**
(one bounded re-read at `QA_ESCALATED_NODE_BUDGET` carrying the same
`withinRef`), never by widening to the whole page; a still-truncated scoped
view fails closed with `INCONCLUSIVE_TRUNCATED` exactly like an unscoped
one. Unscoped truncated views keep their exact escalation and
`INCONCLUSIVE_TRUNCATED` semantics.
- `completeness` now names the scope whenever the deciding view was scoped
(additive `scope: { role, name }`), and a scoped deciding view ALWAYS
reports completeness — complete or truncated — so "absent from this
container" can never be read as "absent from the whole page". Absence
decisions also carry the deciding view's `coverage` evidence and the gate
diagnostics `hiddenMatches`/`hiddenMatchesPartial` (contract v9): report.md
names them as "hidden semantic-selector candidates excluded: N (lower
bound)", and a proven absence prints the Codex-consult PASS wording with
"coverage verified (N nodes probed)". The
detail string and report.md say which container the outcome was decided
inside.
- Replay: a scenario assertion may carry `scope: { role, name, tag?, path? }`
(loader-validated fail-closed; the name may be empty; `path` is the
container's semantic ancestor chain, outermost first). **A `path` is a
DISCRIMINATOR, never a proof**: it can only ever LOCATE the container;
uniqueness is proven per level at replay time, and `PASS` stays reserved
for proven resolution. QA-BL-069 path durability: a path item may OMIT its
`name` — export omits it exactly for a CONTENT-NAMED container role
(search/region/list/listbox/group/navigation/main/form/table/menu — the
same rule as `FRAGILE_PROOF_ONLY`) whose aggregated accessible name
concatenates its children's text and exceeds 80 chars (it changes with
collapse state / render timing), or for an EMPTY name; such an item
records `{ role, tag }` only, and replay compares the name only when it
was recorded.

  QA-BL-069 top-down path WALK: the outermost ancestor is matched in the
whole-page view (with today's ONE bounded budget escalation), observed
within (settled), the next path item matched inside that scoped view (one
bounded WITHIN-SCOPE escalation when the parent subtree exceeds the default
window, re-chained through the driver's fresh `scope.rootRef`), and so on,
until the container itself is matched inside its last ancestor's view; the
container's own settled scoped view is then the deciding view. Uniqueness
is judged at EACH level inside its PARENT's view — the classification
table:

  | level evidence | classification |
  | --- | --- |
  | exactly 1 match in a COMPLETE parent view | `proven` at that level |
  | exactly 1 match in a still-truncated parent view | `provisional` at that level |
  | ≥ 2 matches | `TARGET_NOT_UNIQUE` — a KNOWN twin is never guessed (definite failure) |
  | zero matches in a still-truncated parent view | `INCONCLUSIVE_TRUNCATED` — the step is **inconclusive**, never a failure |
  | zero matches in a COMPLETE parent view | definite failure — the ancestor/container is not on the page |

  The overall resolution is `proven` only when EVERY level was proven — on a
>100-node page the whole-page top level never completes, so the result is
provisional, exactly as Codex consult #2 decision (b) requires. Without a
recorded path the flat resolution stays (QA-BL-054/062): ONE match in a
still-truncated whole-page view resolves PROVISIONALLY for the scoped
SCROLL-proof step (B3), and refuses with `INCONCLUSIVE_TRUNCATED` naming
the scope for every other scope. A PROVISIONAL resolution means the step
carries `scopeResolution: 'provisional'` and `reason: INCONCLUSIVE_SCOPE` —
**never a pass** — and the run aggregates to the three-state `inconclusive`
when nothing definitely failed. QA-BL-069 (C) classification: ZERO matches
in a still-truncated view AT ANY LEVEL (flat included) is NOT a definite
failure — the step carries `reason: INCONCLUSIVE_TRUNCATED`,
`scopeNotLocated: true`, `assertionPassed: false`, the run status
`inconclusive` (never `fail`), and report.md says "the container could not
be located in the truncated view; it may exist outside the returned
window"; the `scopeLevels` field and report.md name EACH level's resolution
(outermost ancestor first, the container last). Definite failures (zero in
a complete view, `TARGET_NOT_UNIQUE`) remain `fail`. The replayed scrolled
proof is still executed; its verifying scoped read requests
`anchorLastAction` + `verifyCoverage`, and the decision requires the
identity anchor to be connected, contained, bound to the SAME node ref as
the asserted target, and in the viewport — a lost binding or mismatch is
disclosed as `scopeRefusal` (escalationRefused-style) on the step, never a
predicate reselect. Target predicate matches are counted BEFORE the
`inViewport` filter inside the scope: ≥2 → `TARGET_NOT_UNIQUE`; exactly 1
in a truncated or coverage-unverified subtree stays provisional; exactly 1
in a complete verified subtree MAY be proven (given a proven container
resolution). Driver refusals on the scoped read surface as themselves
(their code rides into `failure.code`), never as a "not found". After a
scoped decision the runner refreshes the whole-page view (settled,
fail-closed on an unstable refresh) because the scoped read consumed the
observation the container was resolved from.
- Export records the scope when the explorer used one AND the scope is
PROVEN durable (QA-BL-054, amended by QA-BL-062/069). WITH a recorded
ancestor path, durability is judged PER LEVEL from the recorded evidence —
the same top-down walk replay performs: level 1 in a whole-page recorded
view, each next level inside a recorded observation scoped within its
parent item, and the container inside the first recorded view that
contained it as a NON-root node (its own subtree never counts — the
scoped-complete-baseline trick stays closed). A container unique inside its
ancestor's COMPLETE scoped view is durable at that level; the export is
PROVISIONAL exactly where a level stays unproven (on a >100-node page the
whole-page top level always is) — the scope (with the path) is still
EXPORTED, so an explicit scoped assertion whose whole-page baseline was
truncated is no longer excluded with `SCOPE_NOT_DURABLE` merely for that;
an AMBIGUOUS or definitely-absent level IS excluded, never guessed.
WITHOUT a path the flat rule applies: the predicate (role+name, plus tag
when needed to disambiguate) must match EXACTLY ONE node in the recorded
BASELINE observation (the action's pre-action view), that baseline must be
COMPLETE (`truncated: false`), and must NOT be the container's OWN scoped
subtree. `path` is the container's ancestor chain from an observation that
contained it as a NON-root node, recorded when available — never
manufactured from a scoped root's `parentRef: null`. An empty accessible
NAME is a legitimate predicate value and is kept literally (`name: ''`).
QA-BL-062: when uniqueness is UNPROVEN and the recorded action is an
identity-anchored scroll proof (its proof observation carries the driver's
truthful identity anchor — the acceptance marker hub-107's re-bind
produced), the scope is exported explicitly PROVISIONAL (the step intent
names the weakness) instead of being excluded; every other unproven scope
EXCLUDES the step with `SCOPE_NOT_DURABLE` — a scoped proof is never
silently exported as if it were a whole-page proof. `page-url` is never
scoped (the URL travels on every observation). When the action's PRECEDING
observation was scoped, the step intent records that the target's
whole-page uniqueness was not verified at export.
- The computer driver has no scoping: a `withinRef` there is REFUSED with a
clear error, never silently ignored.

## Record-time scroll-proof escalation (Explore recording only)

Explore cannot re-observe a recorded trajectory, so the recording session
takes the ONE bounded escalation at RECORD time instead: a browser
`scroll`-by-ref whose settled post-action proof observation is truncated AND
still lacks the action target in the viewport gets one more SETTLED read at
`QA_ESCALATED_NODE_BUDGET`.

**Scoped-baseline proof read (QA-BL-067).** When the acted ref came from a
SCOPED baseline (the observation the ref belongs to carries `scope`), the
action's PROOF settle itself is taken INSIDE that scope:
`observeSettled({ withinRef: <baseline scope.rootRef>, anchorLastAction: true })`
with the same settle options — the settle loop re-keys the within ref per poll
to the driver's fresh `scope.rootRef`. The acceptance is decided by the
driver's identity anchor, never by matching role/name/tag: the scoped window
settled AND `anchor.connected && anchor.contained === true && anchor.ref !==
null` AND the anchored node has `inViewport: true`. On acceptance the result
carries `proofScope: { role, name }` plus `anchor` (NO escalation happened, so
there is deliberately no `proofEscalated`), the recorder binds the scoped
observation as the action's proof through the ordinary settle binding, and
export carries the scope through the unchanged `withProofScope` path
(QA-BL-054/062: `scope.path` recorded from record-time ancestry, PROVISIONAL
at replay on pages that can never complete). VERIFIED against the real driver
(contract v9, dsh-browser `d069f4f`): a dispatched action that consumed a
SCOPED observation and did NOT navigate RETAINS that observation's scope
root until the next successful observe, so a scroll from a scoped view is
PROVEN inside that scope. The FIRST poll is keyed by the EXPLICIT baseline
`scope.rootRef` — deliberately not the `'last-scope'` alias, which would
silently rebind a stale baseline to whatever root was last acted and measure
the anchor's containment against the WRONG container (a false scoped proof);
the explicit rootRef is refused instead. That poll resolves through the
retained handle and CONSUMES the retention, minting a fresh `rootRef` in
its observation; the settle loop re-keys every later poll to that fresh
`rootRef` (`scopedRootRefOf`), riding the driver's transition from the
retained root to a live observation. When the driver refuses the root, the
refusal is DISCLOSED with the driver's code and the proof falls back to
today's whole-page read: `OBSERVATION_REQUIRED` when nothing was retained
(a pre-retention driver, a plain node ref from the consumed observation, or
the acted ref IS the scope root itself — the driver deliberately creates no
retention for that single-owner handle, while the anchor still works), and
`SCOPE_UNAVAILABLE` when a retained root was released (navigation,
dispose, or an intervening observe).

**Scoped escalation RE-ENABLED via the identity anchor (B3, contract v9).**
The QA-BL-050 container-heuristic is still RETIRED: the audit (F4) showed the
nearest-container heuristic can pick a NON-ancestor (the driver exposed no
ancestry), and a same-identity twin inside the wrong container can then
satisfy the proof — matching by role+name+tag across observations is not
identity. Its replacement picks the container by **ancestry**: the target's
`parentRef` chain in the BASELINE observation, up to the first container-
role node (region/main/navigation/list/table/form/group/complementary/
article/section). The container is re-keyed into the settled view by its
unique role+name+tag match, and the ONE escalated read is
`observe({ withinRef, anchorLastAction: true, maxNodes:
QA_ESCALATED_NODE_BUDGET })` — accepted ONLY when the window settled AND the
driver's identity anchor reports the ORIGINAL acted element connected,
contained in the within subtree, emitted with a fresh ref, and that anchored
node in the viewport. **Identity comes from the anchor, never from matching
role/name/tag.** Refusals (ANCHOR_UNAVAILABLE, connected:false,
contained:false, a null anchor ref) are disclosed as `escalationRefused` and
the proof stays the settled observation. No container on the chain, or an
un-re-keyable container (zero/twin matches in the settled view), falls back
to the whole-page read:

**Whole-page acceptance rule (unchanged).** The escalated view must EXTEND
the settled one (same page URL/title and every settled node unchanged at the
front in the same order — the page is still the exact state the settle window
proved), the window must have settled (`stable`), and the target must be
returned with `inViewport: true`. The scoped form drops the prefix-extension
check (it is meaningless across scopes) — the anchor is the stronger
replacement.

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
`escalatedSettle` (the action's own window stays under `settle`).

**Every non-acceptance exit is disclosed (QA-BL-058, completed by
QA-BL-067).** `escalationRefused: { reason, code? }` carries one of a FIXED
vocabulary words — `target-not-in-baseline` (the acted ref is absent from the
baseline), `container-not-in-view` (the scope root / container can no longer
be re-keyed into any fresh view — including the post-action refusal of the
baseline rootRef: `OBSERVATION_REQUIRED` when no scope root was retained and
`SCOPE_UNAVAILABLE` when a retained root was released by navigation or an
intervening observe),
`escalated-window-unstable` (the escalated window never settled, or the
escalated view does not stably extend the settled one), `target-not-returned`
/ `target-not-in-viewport` (the escalated view lacks the target / returned it
off-viewport),
`anchor-not-connected`, `anchor-not-contained`, `anchor-unavailable` (the
identity anchor's truth) — plus the driver's machine `code` when the driver
THREW. `already-in-viewport` is deliberately NOT a refusal: no escalation is
needed, and the result then simply has no escalation fields. When both the
scoped proof read and the escalation were refused, the escalation's refusal
is the one disclosed (the more terminal truth); an accepted escalation
supersedes the earlier refusal. The refusal rides on the `qa_act` result and,
through the recording adapter, on the exported scenario step (additive
`escalationRefused`), so report.md prints it on the step line. The proof
stays the settled observation either way (fail closed). The recorder re-binds
the proof by the EXACT recorded action id carried on the receipt: a null or
non-matching id (e.g. a concurrent act settled in between) is refused and
recorded as a recording issue, never silently re-bound to the wrong action.

## Role drift on real pages: server-rendered → hydrated (QA-BL-039 / QA-BL-064)

A control's role is not stable over time on a real page. The canonical case is
Wikipedia's search box: the server renders a plain `<input>` (`textbox`), and
once Vector's Vue typeahead module mounts it replaces the control with a
same-named component carrying `role="combobox"`. The owner's release blocker
(QA-BL-064) pressed Enter while the combobox role was live; a fast replay loads
the page quickly enough that step 2 still observes the server-rendered
`textbox` — the node is **present in every observation under a drifted role**,
not outside the observation window. Pin the LIVE role and a fast replay
fails with a misleading "no observable node matches"; pin only the name and
the same target resolves on both sides of the switch.

The **name-only rule** therefore applies to BOTH selector families:

- **Assertions (QA-BL-039).** The exporter synthesizes a drifted
  `node-value` assertion on the name-only predicate (`{ name, value }`,
  role omitted) when the target's role changed during the action and the
  accessible name is unique among all nodes in the settled view; role+name is
  kept only when the name alone is ambiguous. The same discriminator logic
  drives every proof predicate on a role-drifted node.
- **Action targets (QA-BL-064).** The exporter writes the action target
  NAME-only whenever the accessible name is non-empty and unique in the
  recorded BASELINE view, keeping the live role only as an advisory
  `roleHint` (additive schema; the loader accepts it and replay IGNORES it
  for matching). A name that is empty or not unique keeps the role+name form
  and its `TARGET_NOT_UNIQUE` exclusion.
- **Replay fallback.** When a recorded role+name action target has ZERO
  matches in the DECIDING view (after the existing one escalated read when
  that view is truncated), the runner falls back to a NAME-only match **iff
  exactly one node in that view carries the same non-empty name**, and
  discloses `targetResolution: { mode: "name-only", recordedRole,
  observedRole }` on the step result and in report.md. The fallback is a
  refusal, never a guess, when the name is empty or matches two or more
  nodes: two or more same-named nodes fail closed with `TARGET_NOT_UNIQUE`
  and the wording "the action target is present under a different role:
  recorded X, observed Y — N nodes carry the accessible name, so the
  name-only fallback was refused rather than guessed". A zero-match failure
  otherwise distinguishes the other two cases honestly: "the target is
  absent from the returned window" (the view was still truncated —
  `INCONCLUSIVE_TRUNCATED`, the target may exist outside it) from "the
  target is absent from a complete view" (the absence is proven). Existing
  scenario files with role+name targets keep replaying through the same
  fallback.
- **Dispatch-time drift.** The same hydration swap can land BETWEEN target
  resolution and dispatch: the driver then REFUSES the action with
  `TARGET_CHANGED` (identity staleness — the page replaced the bound element
  mid-flight, and NOTHING was dispatched). Only that one code is retried, and
  exactly ONCE: a fresh settled observation, a re-resolution of the SAME
  semantic target, and a second dispatch. The step discloses
  `targetChangedRetry: true` in report.json/report.md. Every other
  rejection (a safety/policy refusal) stays a hard stop, and a second
  `TARGET_CHANGED` fails honestly — the retry never loops.

## Budget

`QA_ESCALATED_NODE_BUDGET` is a named constant in src/replay/assertions.ts.
Raising it is a deliberate, bounded change; escalation stays single-shot because
an unbounded retry loop would turn an honest "I cannot see the whole page" into
an expensive one.
