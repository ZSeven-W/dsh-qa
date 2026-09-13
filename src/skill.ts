// The plugin's bundled QA playbook, contributed through ctx.skills.register().
//
// Tool descriptions answer "what does this argument mean", one tool at a time.
// What agents re-derive every session is the WORKFLOW between the tools: which
// observer to reach for, how to confirm an action landed, and what "unknown"
// means for a driver receipt. This skill hands that up front, exactly like the
// dsh-android / dsh-ios playbooks.
//
// Registration is DEFENSIVE: a profile without the skill service still loads
// the plugin, it just does not advertise the playbook. The ONLY safe optional-
// service form is ctx.inject(['skills'], cb): ctx.skills?.register throws on
// the property access itself, and the { required, optional } inject-declaration
// form fails the same way. ctx.inject returns the scoped FIBER (not a
// disposer), so teardown calls fiber.dispose().

import type { StructuralCordisContext } from './host.ts'

export const QA_SKILL_NAME = 'qa-orchestration'

export const QA_SKILL_DESCRIPTION =
  'Explore an app autonomously with the qa_* tools, preserve evidence and driver safety decisions, '
  + 'then export the proven trajectory as a deterministic Replay scenario. Read this before the '
  + 'first qa_* call of an Explore task.'

export const QA_SKILL_WHEN_TO_USE =
  'Any autonomous QA exploration through the qa_* tools — observing an unfamiliar UI, following '
  + 'semantic controls, preserving a failure, exporting a trajectory, or replaying the exported '
  + 'scenario — over a Browser (BU), Computer (CU), iOS, or Android driver.'

export const QA_SKILL_CONTENT = `# Explore with dsh-qa

The loop is **start → observe → choose one semantic target → act → inspect the fresh observation →
assert → capture evidence at the moment a problem appears → export → replay → stop**. The same
eight verbs serve Browser (BU), Computer (CU), iOS, and Android; driver safety decisions are never routed around.

## Explore method

- \`qa_session_start\` binds one owner scope to one driver. Choose an explicit owner and keep it
  unchanged through export. Browser takes \`url\`; Computer binds strong app/window identity;
  iOS/Android require an explicit \`device_id\` (no default first device) and an app/package id.
- A heavy site can widen the settle budget at start: pass \`settle_budget_ms\` (and \`settle_quiet_ms\`) to \`qa_session_start\`, clamped to the schema bounds (budget <= 15000ms). Separately, the session widens its budget ONCE automatically (the adaptive budget, \`settle_adaptive_budget_ms\` / env \`DSHPLUGIN_QA_SETTLE_ADAPTIVE_BUDGET_MS\`, default 6000ms, \`0\`/\`off\` disables) when a settle window is still churning at the starting budget, OR when a positive-existence assertion retry exhausts its budget without finding its target (cause "unstable" vs "assertion-retry" respectively): the same window keeps polling until the adaptive budget, and every settle result reports \`settle.widened\` (\`{ fromMs, toMs, cause }\` or \`null\`). Whatever effective policy Explore ran with (the widened budget when it widened) is what \`qa_record_export\` records into \`meta.settle\`, and \`qa_replay_run\` applies it (env/host defaults otherwise), printing the effective policy plus \`settleWidened\` in report.json / report.md.
- Begin with \`qa_observe\`. Prefer a unique role plus accessible name, take one purposeful action,
  then inspect the fresh observation returned by \`qa_act\`. Re-observe when diagnosing and never
  reuse an old ref. A truncated view is incomplete, not empty.
- Coordinates, indices, opaque refs, observation ids, and generated ids are live-session handles,
  never Replay selectors.
- \`qa_act\` returns a receipt plus, for dispatched actions, the session core's immediate fresh
  observation. An \`unknown\` receipt is NEVER success: require a semantic delta or URL change in
  that observation. A \`rejected\` / \`failed\` receipt is a hard stop. Never approve, rephrase, or
  retarget around a driver safety rejection.
- Mobile text input is conditional and driver-native: iOS \`fill\`/\`type\` use the dsh-ios
  element-bound \`fillTarget\`/\`typeTarget\` only when the live driver exposes them (never raw
  global type or invented focus), Android \`type\` is append-faithful after real focus
  verification, and Android \`fill\` remains unavailable.
- A \`fill\` is proven by its OWN target's value: when the fresh observation shows the target
  carrying the typed text, the exporter synthesizes a \`node-value\` assertion on that target (the
  most durable evidence), not on some other node that happened to change — including when the fill
  REWROTE the target's accessible name OR role (\`aria-label\` following the value, "Search" ->
  "Search: async", or \`textbox\` -> \`combobox\` once suggestions open): the exporter then follows
  the same identity rule the echo mask uses (match by name role-agnostic OR by role name-agnostic,
  unique among candidates) and binds the assertion to the node's MOST STABLE predicate: the unique accessible name alone (role omitted) when the role changed, so a fast replay still matches before the role switch; role+name only when the name alone is ambiguous. It never degrades to
  \`node-present\` of the renamed field alone. A secret-bearing control (\`valueWithheld\`,
  password/one-time-code/cc autocomplete) never carries a value, so no value assertion is
  synthesized for it.
- The settle window echo-masks the action's own value write (\`fill\`/\`type\`/\`select\`, and
  \`key\`/\`press\` on a uniquely identified target), so a downstream consequence that lands after the
  echo is still waited for — a fresh observation that only shows the echo never proves the action alone.
- After the first non-echo change is observed, the quiet window lengthens to \`postChangeQuietMs\`
  (default 2× \`quietMs\`), measured from the last change, so an outcome that lands after early
  unrelated churn (a sibling mirroring the typed value, a late hydration rename) is still captured
  rather than cut off by one short quiet window.
- \`qa_assert\` checks resulting state against a fresh observation. Do not repeat the action "to see
  if it worked". \`node-value\` (\`expected: { role?, name?, tag?, value }\`) asserts a node's exact
  current value and is deterministic, like \`node-present\` / \`node-absent\` / \`page-url\`. It demands
  the predicate identify EXACTLY ONE node (\`TARGET_NOT_UNIQUE\` otherwise — a twin already holding the
  value proves nothing), and a \`valueWithheld\`/\`secure\`/\`valueTruncated\` node can never satisfy it
  (\`VALUE_WITHHELD\` / \`VALUE_SECURE\` / \`VALUE_TRUNCATED\`).
- A POSITIVE existence assertion (\`node-present\` / \`node-value\` / \`node-in-viewport\` / \`page-url\`) that is first "not found" is re-observed within the settle budget before failing — the node may just be slow to render — and the result records \`attempts\` / \`elapsedMs\`. \`node-absent\` is never retried into a pass: absence is never proven by waiting, only by having seen the whole view. When a POSITIVE existence retry exhausts its budget without finding the target, the session widens its budget ONCE through the same gate (settle.widened with cause "assertion-retry") and keeps retrying until the adaptive budget, so a page that settles fast but renders slowly is still found.
- A view can also be UNSTABLE: when a fresh observation's \`settle.stable\` is \`false\` the page never
  stopped changing inside the settle budget, so nothing in it proves anything. \`qa_assert\` then returns
  \`passed: false\` with \`inconclusive: true\` and \`code: "INCONCLUSIVE_UNSTABLE"\` (the same non-result
  vocabulary as \`INCONCLUSIVE_TRUNCATED\`) — never a false green; wait for the page to stop changing, then
  re-observe. A \`qa_act\` on an unstable proof window keeps its receipt honest (\`confirmed\` / \`unknown\`)
  but adds \`proven: false\` plus \`code: "INCONCLUSIVE_UNSTABLE"\`: the dispatch happened, the consequence
  is unproven.
- A view can be TRUNCATED at the node budget, and a node outside that window still exists. So an
  absence can never be proven from a truncated view: \`node-absent\` re-observes once at a raised
  budget and then fails closed with \`completeness.reason: "INCONCLUSIVE_TRUNCATED"\` rather than
  reporting a false "gone". Read \`completeness\` before believing any negative result: "we did not
  see it" is not "it is not there". A found node is sound evidence of presence either way.
- Absence and coverage (contract v9, Phase C): \`node-absent\` means "no driver-OBSERVABLE
  semantic node" (hidden and zero-rect elements are excluded from the projection), and it PASSES
  only when nothing matched AND the deciding view is complete (\`truncated: false\`) AND
  \`coverage.verified: true\` — the terminal absence decision requests the driver's bounded
  closed-shadow-root probe on its ONE deciding re-observation (never on settle polls; ~5ms
  scoped, possibly over-budget whole-page on very large pages, and then the absence is
  UNPROVEN). A probe that found closed shadow roots or did not complete keeps the result
  \`INCONCLUSIVE_TRUNCATED\` / \`COVERAGE_UNVERIFIED\`, naming \`closed-shadow-root\` /
  \`shadow-coverage-unverified\` in \`completeness.detail\` and \`truncationReasons\`; a passing
  absence prints "No driver-observable semantic node matching {predicate} was found within
  {scope|the whole page}; coverage verified (N nodes probed). K hidden candidates excluded."
  Never report "absent" without that evidence; report "not observed, and absence cannot be
  proven". A returned matching node still fails \`node-absent\` normally.
  \`completeness.nodeBudget\` is the budget the DRIVER actually applied (each driver clamps the
  request to its own maximum: browser 100, computer 500 — a browser run never reports 500), and
  \`completeness.truncationReasons\` names WHY the view is partial: \`iframe-not-traversed\` means
  part of the page lives in an iframe the driver does not traverse (a budget cannot help),
  \`scan-window-exceeded\` means the fixed scan window was hit (a budget cannot help), and
  \`node-budget-exceeded\` names the node budget. When the re-observation applied the SAME budget
  as before (already at the driver maximum), raising \`qa_observe max_nodes\` cannot help — narrow
  the page or region, or scroll the target into a smaller view.
- A view can also be SCOPED (browser, driver contract v8): pass \`within_ref\` — an opaque ref
  from your CURRENT (latest, unexpired) \`qa_observe\` result — to observe only the composed
  subtree rooted at that element. Budgets, the byte ceiling, the scan window, and the iframe
  marker become SUBTREE-relative, so a container whose subtree fits reports \`truncated: false\`
  with no \`truncationReasons\`, and a deep target unreachable in the whole-page window becomes
  reachable. Absence inside it passes only with verified coverage (see the coverage rule: the
  deciding re-read probes the SUBTREE). The observation's
  \`scope\` field (\`{ ref, rootRef, role, name, tag }\`) echoes the root the driver observed;
  \`rootRef\` (contract v9) is the fresh per-observation ref that chains the next scoped read —
  it is absent for whole-page observations. An unknown, expired, consumed, non-element, or
  detached ref
  REFUSES the call with its driver code (\`REF_UNKNOWN\` / \`REF_EXPIRED\` / \`TARGET_CHANGED\` /
  ...) — never a whole-page fallback and never a "not found". The computer driver does not
  support scoping and refuses \`within_ref\`. A scoped proof is exported as a scoped assertion
  (\`scope: { role, name, tag?, path? }\`, an empty name kept literally, and \`path\` the
  container's semantic ancestor chain from record-time ancestry when one was recorded) DURABLY
  ONLY when the container predicate (role+name, plus tag when needed) is unique in a COMPLETE
  recorded baseline observation that is NOT the container's own subtree — otherwise the step is
  excluded with \`SCOPE_NOT_DURABLE\`, never silently exported as a whole-page proof. The ONE
  exception is the identity-anchored scoped scroll proof (the recorded action's proof observation
  carries the driver's truthful identity anchor): it is exported explicitly PROVISIONAL (the step
  intent says so, and \`path\` is recorded when available). Replay re-derives the container in the
  whole-page view (UNIQUE predicate, plus the recorded path when present — \`TARGET_NOT_UNIQUE\`
  when ambiguous; one match in a still-truncated view resolves PROVISIONALLY for the scroll proof
  or a path-carrying scope, every other scope refuses with \`INCONCLUSIVE_TRUNCATED\` naming the
  scope) and decides inside the container; the completeness block names the scope, so "absent
  from this container" is never read as "absent from the whole page" — and absence passes only
  with verified coverage (\`coverage.verified: true\`). A PROVISIONAL resolution means
  \`scopeResolution: "provisional"\` + \`reason: "INCONCLUSIVE_SCOPE"\` on the step — never a pass —
  and the run aggregates to status \`inconclusive\` unless something definitely failed.
  A browser scroll-by-ref whose settled proof view is truncated and still lacks the target in
  the viewport is re-read ONCE at record time, preferring an identity-anchored SCOPED read
  rooted at the target's nearest container-role ancestor (walked on the target's \`parentRef\`
  chain, contract v9): the escalated view is accepted only when the driver's identity anchor
  reports the ORIGINAL acted element connected, contained in that container, and in the
  viewport — identity comes from the anchor, never from matching role/name/tag. A scroll (or
  any act) whose ref came from a SCOPED baseline takes its PROOF settle inside that scope
  instead (withinRef: the baseline \`scope.rootRef\` plus \`anchorLastAction\`), accepted only on
  the same identity-anchor rule — the result then carries \`proofScope: { role, name }\` plus
  \`anchor\` (no escalation happened, so no \`proofEscalated\`), and export carries the scope
  (provisional at replay on long pages). On driver >= d069f4f the dispatched action RETAINS
  the consumed scope root (contract v9), so the scoped proof read RESOLVES through it: the
  FIRST poll is keyed by the EXPLICIT baseline \`scope.rootRef\` (never \`'last-scope'\`, so a
  stale baseline is refused instead of silently rebinding to whatever root was last acted),
  then the loop re-keys each later poll to the fresh \`rootRef\` that poll minted — the scroll
  is PROVEN inside that scope. When the driver refuses the root (a pre-retention driver, the
  acted ref IS the scope root itself — the single-owner handle is never retained, while the
  anchor still works — or a released retention after navigation: \`OBSERVATION_REQUIRED\` /
  \`SCOPE_UNAVAILABLE\`), the refusal is DISCLOSED and the proof falls back to the whole-page
  read. Every non-acceptance exit is disclosed as \`escalationRefused: { reason, code? }\` with a
  fixed vocabulary — \`target-not-in-baseline\`, \`container-not-in-view\`,
  \`escalated-window-unstable\`, \`target-not-returned\`, \`target-not-in-viewport\`,
  \`anchor-not-connected\`, \`anchor-not-contained\`, \`anchor-unavailable\` — plus the driver's
  code when it threw; \`already-in-viewport\` is NOT a refusal (the result then simply has no
  escalation fields), and the refusal rides on the exported step so report.md prints it on the
  step line.
- \`qa_assert\` takes the SAME \`within_ref\`: the assertion is decided INSIDE that container
  (the deciding read is a fresh settled scoped observation), so \`node-absent\` means "absent
  FROM THE CONTAINER" — \`completeness.scope\` names it (\`{ role, name }\`) and the PASS
  wording says "within the {role} named \"{name}\""; WITHOUT \`within_ref\` the decision stays
  whole-page and carries no \`completeness.scope\`. The ref must come from the LATEST
  observation: a container ref from the latest whole-page \`qa_observe\`, or the
  \`scope.rootRef\` (any node ref works) echoed by the immediately preceding scoped
  \`qa_observe\`. Every observe REPLACES the driver's current observation, so a ref from an
  earlier observation — including a whole-page container ref captured before an intervening
  scoped observe — is REFUSED as \`{ ok:false, code: "REF_UNKNOWN" | "REF_EXPIRED" | …,
  error }\`, never silently re-decided against the whole page. All scoped rules apply
  (subtree budgets, in-scope escalation and coverage probe, the \`coverage.verified\` gate);
  the recorder exports a passed scoped assert with its scope (\`SCOPE_NOT_DURABLE\` exclusion
  when the container is not unique in a complete recorded baseline); the computer driver
  refuses \`within_ref\` and \`kind: "visual"\` does not take it.

- The moment a problem appears, call \`qa_evidence\` before navigating away or changing state.
  Missing permissions, truncation, and driver rejection are boundaries, never green results.

## Visual assertions: trust the verdict, never the narration

\`qa_assert kind:"visual"\` returns \`verdict\` (yes/no/unclear), \`confidence\`, and \`reasoning\`.

- **Trust \`verdict\` and \`confidence\`.** They are the model's answer to your question and the only
  part you may act on or report.
- **Never quote details from \`reasoning\` as observed fact.** It is model narration; it is not
  checked against the screenshot, and it invents detail. Measured in a live run: asked whether a
  serif "WIKIPEDIA" wordmark was present, the model answered \`yes\` at confidence 1.00 — correctly —
  and then narrated "with the puzzle globe logo", which was NOT on that page; asked separately
  whether the puzzle globe was present, the same model correctly answered \`no\` at 0.97. The verdict
  was right and the story around it was invented. Every advisory record therefore carries
  \`reasoningTrust: "unverified-model-narration"\`, and report.md prints the text as a labelled
  "model narration" blockquote.
- If a detail in the narration matters, ask a separate visual question about exactly that detail, or
  prove it deterministically with \`node-present\` / \`node-absent\` / \`page-url\`. A visual verdict is
  ADVISORY: it never changes a run's pass/fail.
- A visual assertion takes its own fresh settled observation before capturing, so it works directly
  after \`qa_act\` or \`qa_evidence\` — no separate \`qa_observe\` is required first. The one exception
  is a capture you pinned yourself with \`visual_fingerprint\` on \`qa_evidence\`: a pinned observation
  is never silently refreshed, so once it goes stale the driver refuses it by design and you must
  observe and pin again.
- A visual finding carries \`settle: { stable, passes, budgetMs }\` from the observation it captured
  from. When \`settle.stable\` is \`false\` the finding also carries \`captureSettled: false\`: the
  advisory verdict is over a view that never stopped changing, so it proves nothing about the page.
  A \`qa_evidence\` visual capture carries the SAME \`settle\` + \`captureSettled: false\` vocabulary.

## Export and Replay

- Call \`qa_record_export\` with the same \`owner\` and an \`output_path\` ending in \`.json\`. Its
  parent must already exist under the current workspace or temporary directory.
- Selector durability is strict: only a target uniquely identified in the preceding observation by
  non-empty **role + accessible name** is exported. Role drift on real pages — a server-rendered
  control replaced by a hydrated component that renders the same accessible name under a
  DIFFERENT role (Wikipedia's search input: \`textbox\` -> \`combobox\` once the typeahead
  mounts) — makes the LIVE role a fragile identity, so the exported ACTION target is written
  NAME-only whenever the accessible name is non-empty and unique in the recorded baseline view,
  keeping the live role only as an advisory \`roleHint\` (the loader accepts it and ignores it
  for matching; assertions follow the same name-only rule through the QA-BL-039 value
  discriminator). A name that is empty or not unique keeps the role+name form. Unnamed, duplicate,
  coordinate/index-based, ephemeral-ref-only, redacted, or Replay-unsupported actions are excluded
  with a reason.
- Every exported step receives an assertion synthesized from and evaluated against the immediate
  fresh observation after that action. Rejected/failed actions and actions without that observation
  never become steps. A fill is proven by its own target's value (\`node-value\`); otherwise an
  unknown receipt needs a semantic delta or URL change, and target persistence alone cannot prove it.
- A delta whose accessible name is a concatenation of its children's text is ordering-fragile (a
  \`search\`/\`list\`/\`listbox\` container whose name exceeds ~80 characters) and is never
  exported as a proof: it is skipped in favour of a sound delta, and when it is the only change the
  step is excluded with \`FRAGILE_PROOF_ONLY\`.
- Inspect \`excludedActions\`. An exclusion is not a pass. If every action is unproven,
  \`qa_record_export\` returns \`NO_PROVEN_STEPS\` and writes no file.
- Run \`qa_replay_run\` on the exact exported file without hand editing it. Browser Replay is the
  supported v0.1 closed loop, and the run status is THREE-state (QA-BL-062): \`pass\` closes
  Explore→Replay only when every required step and final assertion is fully proven;
  \`inconclusive\` means at least one result is provisional (a scoped container resolved
  provisionally — \`scopeResolution: "provisional"\` and \`reason: "INCONCLUSIVE_SCOPE"\` on the step,
  inherited by the copied final assertion) and nothing definitely failed; \`fail\` is everything
  else. A provisional scroll proof is still EXECUTED (the replayed scroll runs and is verified
  through the driver's identity anchor — a lost binding or mismatch is disclosed as
  \`scopeRefusal\`, never a predicate reselect), but PASS is reserved for proven resolution. A
  failed run carries a machine \`failure.code\` for recognized non-results —
  \`INCONCLUSIVE_UNSTABLE\` (a view that never settled) and \`TARGET_NOT_UNIQUE\` (an ambiguous
  action target) — so you never have to parse prose to tell them from an ordinary assertion
  failure.
- Role drift on replay (QA-BL-064): a recorded role+name ACTION target that matches NOTHING in the
  deciding view (after the one escalated read when that view is truncated) falls back to a NAME-only
  match iff exactly one node carries the same non-empty accessible name — the node is present under
  a drifted role, not outside the window — and the step discloses
  \`targetResolution: { mode: "name-only", recordedRole, observedRole }\` in report.json/report.md.
  The fallback is a refusal, never a guess, when the name is empty or matches two or more nodes
  (\`TARGET_NOT_UNIQUE\` with "present under a different role: recorded X, observed Y"); a
  zero-match failure otherwise distinguishes "the target is absent from the returned window"
  (truncated, \`INCONCLUSIVE_TRUNCATED\`) from "the target is absent from a complete view".
  The same hydration swap can land BETWEEN resolution and dispatch: a \`TARGET_CHANGED\` refusal
  (identity staleness — nothing was dispatched) is retried WITHIN the settle budget, never once
  (QA-BL-070): a fresh settled observation, a re-resolution of the SAME semantic target, and a
  re-dispatch, repeated until the pair lands, widening the budget ONCE through the shared session
  gate when the retry exhausts it (the same machinery assertion retries use; cause
  \`assertion-retry\`). The step discloses \`targetChangedRetries: N\` (the refusal count) in
  report.json/report.md, and the driver's last refusal receipt (verbatim \`reason\` plus any
  additive fields such as \`changed\`) rides on the step so triage sees WHAT changed. Every other
  rejection — a policy/safety refusal, \`TARGET_NOT_UNIQUE\`, a target absent from a COMPLETE
  view — stays a hard stop with zero retries. When the budget is exhausted with the target still
  changing identity, the step is \`inconclusive\` with reason \`INCONCLUSIVE_UNSTABLE\` and
  \`assertionPassed: false\` (the run is \`inconclusive\`, NEVER \`fail\`): "the target kept
  changing identity between resolution and dispatch for the whole settle budget (N retries): the
  page did not hold still, so the step is unproven". The SAME refusal on a \`within\` read of the
  scoped path walk (QA-BL-073: an ancestor changed identity between its parent read and the scoped
  read) runs the SAME bounded retry — re-resolving the level from the level above with a fresh
  settled read, counting into the SAME \`targetChangedRetries\` — and its exhaustion is the same
  \`inconclusive\` / \`INCONCLUSIVE_UNSTABLE\` classification with a message naming the level
  ("path level N (<what>) kept changing identity …") and the driver's \`changed\`/\`before\`/\`after\`
  verbatim as \`scopeIdentityRefusal\`; only \`TARGET_CHANGED\` is ever retried (policy refusals,
  \`REF_UNKNOWN\`, \`OBSERVATION_REQUIRED\`, \`SCOPE_UNAVAILABLE\` stay hard). A CONTENT-named
  container whose aggregated name changed between reads is never a refusal at all: the driver
  reports it informationally (\`scope.nameChanged\`), and the step records \`scopeNameChanged: true\`.
- \`qa_session_stop\` releases the owner scope. Stop on success and failure; the trajectory remains
  exportable until another session starts for that owner or the plugin disposes.

## Missing drivers

The Browser, Computer, iOS, and Android drivers load lazily. When one is absent, the first tool call
that needs it fails with a clear error naming the missing package. Plugin activation and tools/list
do not require the drivers to be installed.
`

/** Register the playbook when the host provides the skill service. */
export function registerQaSkill(ctx: StructuralCordisContext): () => void {
  // ctx.inject returns the scoped FIBER, not a disposer; fiber.dispose() tears
  // the scope down so the plugin's teardown list stays uniform.
  const fiber = ctx.inject(['skills'], (skillCtx) => {
    const { skills } = skillCtx
    skillCtx.effect(() => skills.register({
      name: QA_SKILL_NAME,
      description: QA_SKILL_DESCRIPTION,
      whenToUse: QA_SKILL_WHEN_TO_USE,
      content: QA_SKILL_CONTENT,
      source: 'bundled',
    }), 'dsh-qa:skill')
  })
  return () => { void fiber.dispose() }
}