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
  'Drive acceptance runs with the qa_* tools: start a browser or computer session, observe, act, '
  + 'assert, collect evidence, and replay deterministic scenarios. Read this before the first qa_* '
  + 'call of a QA task.'

export const QA_SKILL_WHEN_TO_USE =
  'Any task that operates an app through the qa_* tools — starting a session, observing the UI, '
  + 'performing an action, asserting on state, collecting evidence, or replaying a recorded '
  + 'scenario — over a Browser (BU) or Computer (CU) driver.'

export const QA_SKILL_CONTENT = `# QA with dsh-qa

The loop is **observe once → act → observe again → assert → evidence → stop**. The tools are the
same eight verbs whether the session is Browser (BU) or Computer (CU); only the actions and
evidence shapes differ.

## Starting and stopping

- \`qa_session_start\` binds one owner scope to one driver. The driver is loaded lazily on first
  use, so starting a session does not prove the driver is present — the first real tool call does.
- Browser sessions take \`url\` and optional \`headless\`. Computer sessions bind by
  \`bundle_id\` (optionally \`pid\` / \`window_number\` / \`window_title\`) and assert strong
  identity on every observation; a missing or changed identity fails closed rather than guessing.
- \`qa_session_stop\` releases the bound scope. Stop even on failure; the session is scoped per
  agent and lingers until stopped.

## Observing

- \`qa_observe\` is the default observer. Nodes carry opaque session-local \`ref\`s; they expire, so
  re-observe after every action and never reuse a ref across observations.
- A \`max_nodes\` (browser) or \`max_depth\` / \`ttl_ms\` (computer) cap bounds the result; a
  \`truncated: true\` means the view was cut, not that the target is empty.
- For the computer driver, strong identity binding is asserted, never assumed: every observation
  must carry the launch identity, window number, and frame bound at start.

## Acting

- \`qa_act\` performs exactly one action and returns a receipt with status
  \`confirmed\` / \`unknown\` / \`rejected\` / \`failed\`.
- An \`unknown\` receipt is NEVER success. Only a fresh \`qa_observe\` — never the receipt itself —
  can settle what actually happened. Re-observe and assert before calling anything done.
- A \`rejected\` / \`failed\` receipt is a hard stop: do not retry around it. The \`code\` and
  \`reason\` are deterministic and explain why.
- Browser verbs are \`click\` / \`fill\` / \`press\` / \`navigate\`. Computer verbs are
  \`click\` / \`focus\` / \`type\` / \`key\`. Mixing them across drivers is rejected.

## Asserting

- \`qa_assert\` evaluates \`node-present\` / \`node-absent\` / \`page-url\` against a fresh
  observation. It validates the assertion shape before touching the session, so a malformed
  assertion fails closed with a structural error.
- Prefer asserting on state over re-tapping "to see if it worked".

## Evidence and replay

- \`qa_evidence\` returns bounded, already-redacted evidence: browser console/network records, or
  computer helper status plus bounded action receipts. A missing Accessibility or Screen Recording
  grant shows up here — assert on it, never silently green.
- \`qa_replay_run\` runs a deterministic scenario file end to end (browser only in v0.1) and returns
  a \`pass\` / \`fail\` / \`blocked\` report with per-step receipts and a reproduction trail.
- \`qa_record_export\` is not implemented yet (WP6).

## Missing drivers

The Browser and Computer drivers are separate plugins and load lazily. When one is absent, the
first tool call that needs it fails with a clear, actionable error naming the missing package —
never a bare module-resolution crash. Registering the tools and loading the plugin never requires
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
