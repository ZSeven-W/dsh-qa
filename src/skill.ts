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
- Begin with \`qa_observe\`. Prefer a unique role plus accessible name, take one purposeful action,
  then inspect the fresh observation returned by \`qa_act\`. Re-observe when diagnosing and never
  reuse an old ref. A truncated view is incomplete, not empty.
- Coordinates, indices, opaque refs, observation ids, and generated ids are live-session handles,
  never Replay selectors.
- \`qa_act\` returns a receipt plus, for dispatched actions, the session core's immediate fresh
  observation. An \`unknown\` receipt is NEVER success: require a semantic delta or URL change in
  that observation. A \`rejected\` / \`failed\` receipt is a hard stop. Never approve, rephrase, or
  retarget around a driver safety rejection.
- \`qa_assert\` checks resulting state against a fresh observation. Do not repeat the action "to see
  if it worked".
- The moment a problem appears, call \`qa_evidence\` before navigating away or changing state.
  Missing permissions, truncation, and driver rejection are boundaries, never green results.

## Export and Replay

- Call \`qa_record_export\` with the same \`owner\` and an \`output_path\` ending in \`.json\`. Its
  parent must already exist under the current workspace or temporary directory.
- Selector durability is strict: only a target uniquely identified in the preceding observation by
  non-empty **role + accessible name** is exported. Unnamed, duplicate, coordinate/index-based,
  ephemeral-ref-only, redacted, or Replay-unsupported actions are excluded with a reason.
- Every exported step receives an assertion synthesized from and evaluated against the immediate
  fresh observation after that action. Rejected/failed actions and actions without that observation
  never become steps. An unknown receipt needs a semantic delta or URL change; target persistence
  alone cannot prove it.
- Inspect \`excludedActions\`. An exclusion is not a pass. If every action is unproven,
  \`qa_record_export\` returns \`NO_PROVEN_STEPS\` and writes no file.
- Run \`qa_replay_run\` on the exact exported file without hand editing it. Browser Replay is the
  supported v0.1 closed loop; only a \`pass\` report closes Explore→Replay.
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
