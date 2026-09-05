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
  + 'scenario — over a Browser (BU) or Computer (CU) driver.'

export const QA_SKILL_CONTENT = `# Explore with dsh-qa

The loop is **start → observe → choose one semantic target → act → inspect the fresh observation →
assert → capture evidence at the moment a problem appears → export → replay → stop**. The same
eight verbs serve Browser (BU) and Computer (CU); driver safety decisions are never routed around.

## Explore method

- \`qa_session_start\` binds one owner scope to one driver. Choose an explicit owner and keep it
  unchanged through export. Browser takes \`url\`; Computer binds strong app/window identity.
- A heavy site can widen the settle budget at start: pass \`settle_budget_ms\` (and \`settle_quiet_ms\`) to \`qa_session_start\`, clamped to the schema bounds (budget <= 15000ms). Separately, the session widens its budget ONCE automatically (the adaptive budget, \`settle_adaptive_budget_ms\` / env \`DSH_QA_SETTLE_ADAPTIVE_BUDGET_MS\`, default 6000ms, \`0\`/\`off\` disables) when a settle window is still churning at the starting budget, OR when a positive-existence assertion retry exhausts its budget without finding its target (cause "unstable" vs "assertion-retry" respectively): the same window keeps polling until the adaptive budget, and every settle result reports \`settle.widened\` (\`{ fromMs, toMs, cause }\` or \`null\`). Whatever effective policy Explore ran with (the widened budget when it widened) is what \`qa_record_export\` records into \`meta.settle\`, and \`qa_replay_run\` applies it (env/host defaults otherwise), printing the effective policy plus \`settleWidened\` in report.json / report.md.
- Begin with \`qa_observe\`. Prefer a unique role plus accessible name, take one purposeful action,
  then inspect the fresh observation returned by \`qa_act\`. Re-observe when diagnosing and never
  reuse an old ref. A truncated view is incomplete, not empty.
- Coordinates, indices, opaque refs, observation ids, and generated ids are live-session handles,
  never Replay selectors.
- \`qa_act\` returns a receipt plus, for dispatched actions, the session core's immediate fresh
  observation. An \`unknown\` receipt is NEVER success: require a semantic delta or URL change in
  that observation. A \`rejected\` / \`failed\` receipt is a hard stop. Never approve, rephrase, or
  retarget around a driver safety rejection.
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
- Since QA-BL-052 even a COMPLETE view cannot currently prove an absence. \`node-absent\` means
  "no driver-OBSERVABLE semantic node" (hidden and zero-rect elements are excluded from the
  projection), and the driver does not yet verify the observation's boundaries: closed shadow
  roots are neither pierced nor counted and slot assignment may be unresolved, so a
  complete-looking view can silently miss nodes. Until the deciding observation carries
  \`coverageVerified: true\` (driver contract v9, Phase C — no driver reports it yet), an
  otherwise-passing absence fails closed with \`completeness.reason: "COVERAGE_UNVERIFIED"\`
  (scoped AND whole-page views): no observable node matched, but the boundaries were not
  verified, so the absence is UNPROVEN. Never report "absent"; report "not observed, and absence
  cannot be proven". A returned matching node still fails \`node-absent\` normally.
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
  reachable. Absence inside it is STILL UNPROVEN until the driver reports \`coverageVerified\`
  (QA-BL-052: the container's closed shadow roots and slot assignment are not verified, so a
  missing node may just be invisible — \`node-absent\` fails closed with
  \`COVERAGE_UNVERIFIED\` on a complete scoped view too). The observation's
  \`scope\` field (\`{ ref, role, name, tag }\`) echoes the root the driver observed; it is absent
  for whole-page observations. An unknown, expired, consumed, non-element, or detached ref
  REFUSES the call with its driver code (\`REF_UNKNOWN\` / \`REF_EXPIRED\` / \`TARGET_CHANGED\` /
  ...) — never a whole-page fallback and never a "not found". The computer driver does not
  support scoping and refuses \`within_ref\`. A scoped proof is exported as a scoped assertion
  (\`scope: { role, name }\`, an empty name kept literally) ONLY when the container predicate
  (role+name, plus tag when needed) is unique in a COMPLETE recorded baseline observation —
  otherwise the step is excluded with \`SCOPE_NOT_DURABLE\`, never silently exported as a
  whole-page proof. Replay re-derives the container in the whole-page view (UNIQUE predicate,
  \`TARGET_NOT_UNIQUE\` when ambiguous; one match in a truncated view is not proven unique and
  escalates once, a still-truncated view refuses with \`INCONCLUSIVE_TRUNCATED\` naming the
  scope) and decides inside the container; the completeness block names the scope, so "absent
  from this container" is never read as "absent from the whole page" — and neither is provable
  until \`coverageVerified\`.

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
  non-empty **role + accessible name** is exported. Unnamed, duplicate, coordinate/index-based,
  ephemeral-ref-only, redacted, or Replay-unsupported actions are excluded with a reason.
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
  supported v0.1 closed loop; only a \`pass\` report closes Explore→Replay. A failed run carries a
  machine \`failure.code\` for recognized non-results — \`INCONCLUSIVE_UNSTABLE\` (a view that never
  settled) and \`TARGET_NOT_UNIQUE\` (an ambiguous action target) — so you never have to parse prose
  to tell them from an ordinary assertion failure.
- \`qa_session_stop\` releases the owner scope. Stop on success and failure; the trajectory remains
  exportable until another session starts for that owner or the plugin disposes.

## Missing drivers

The Browser and Computer drivers load lazily. When one is absent, the first tool call that needs it
fails with a clear error naming the missing package. Plugin activation and tools/list do not require
the drivers to be installed.
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
