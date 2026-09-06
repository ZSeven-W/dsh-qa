// QA-BL-050 re-enabled via B3 (contract v9 identity anchor): the record-time
// scroll-proof escalation PREFERS a SCOPED read rooted at the scroll target's
// nearest container-role ANCESTOR — found by walking the target's parentRef
// chain in the BASELINE observation (no more DOM-order heuristic), re-keyed
// into the settled view by its unique role+name+tag identity, and accepted
// ONLY on the driver's identity anchor: anchorLastAction reports, in-page
// against the ORIGINAL acted element's handle, that it is still connected,
// lies inside the within subtree (contained), was emitted with a fresh ref,
// and that anchored node is in the viewport. Identity comes from the anchor —
// never from matching role/name/tag. Refusals (ANCHOR_UNAVAILABLE,
// contained:false, connected:false, a null anchor ref) are DISCLOSED as
// escalationRefused and the proof stays the settled observation.
//
// Every QA-BL-047 property stays: the escalated read is side-effect-free
// (never widens the settle policy, never flips the widen gate, never replaces
// the session baseline), the acceptance is re-bound by the EXACT recorded
// action id, the refusal keeps the settled observation, and at most ONE
// escalation runs per action (scoped OR whole-page, never both). The
// whole-page form and its acceptance rule are unchanged and pinned in
// test/scroll-proof-escalation.test.mjs. The real-Chrome twin lives in
// test/explore-scroll-scoped-deep-target.integration.test.mjs.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exportRecordedScenario,
  QaTrajectoryRecorder,
  RecordingQaDriverAdapter,
} from '../src/explore/index.ts'
import { QaSession } from '../src/session/index.ts'
import { QA_ESCALATED_NODE_BUDGET } from '../src/replay/index.ts'

const LAUNCH = 'http://127.0.0.1:7456/'
const SETTLE = { budgetMs: 400, quietMs: 40, intervalMs: 5 }

function node(ref, role, name, tag, extra = {}) {
  return {
    ref,
    role,
    name,
    tag,
    interactive: role === 'link',
    editable: false,
    disabled: false,
    ...extra,
  }
}

function view(nodes, truncated, extra = {}) {
  return { page: { url: LAUNCH, title: 'scoped scroll fixture' }, nodes, truncated, ...extra }
}

const TARGET = { role: 'link', name: 'Deep Target' }
const targetOffViewport = (ref, parentRef) => node(ref, TARGET.role, TARGET.name, 'a', { inViewport: false, ...(parentRef === undefined ? {} : { parentRef }) })
const targetInViewport = (ref, extra = {}) => node(ref, TARGET.role, TARGET.name, 'a', { inViewport: true, ...extra })
const container = (ref, extra = {}) => node(ref, 'region', 'Deep zone', 'section', { interactive: false, inViewport: true, ...extra })
const outerFiller = () => node('n-outer', 'link', 'Outer 01', 'a', { inViewport: true })

/**
 * Synthetic scoped scroll page. before is the pre-action BASELINE (with the
 * target plus its parentRef chain); after is the settled WHOLE-PAGE post-
 * action view; scopedEscalated models the ONE escalated SCOPED window's
 * reads (the adapter re-mints scope.rootRef per poll, exactly like the
 * driver). Every escalated observe call is recorded in escalatedCalls
 * ({ maxNodes, withinRef, anchorLastAction }) so the tests can pin what the
 * escalated read carried.
 */
function scopedScrollAdapter({ before, after, scopedEscalated = null, wholeEscalated = null, anchorThrows = null, throwSpec = null } = {}) {
  let acted = false
  let escalationWindows = 0
  let lastWasEscalated = false
  let escalatedPoll = 0
  const escalatedCalls = []
  return {
    adapter: {
      kind: 'browser',
      async start(_owner, startOptions) {
        return { page: { url: startOptions?.url ?? LAUNCH, title: 'scoped scroll fixture' }, headless: true }
      },
      async observe(_owner, observeOptions) {
        const escalatedCall = observeOptions?.maxNodes === QA_ESCALATED_NODE_BUDGET
        if (escalatedCall) {
          if (!lastWasEscalated) {
            escalationWindows += 1
            escalatedPoll = 0
          }
          escalatedPoll += 1
          escalatedCalls.push({
            maxNodes: observeOptions.maxNodes,
            withinRef: observeOptions.withinRef,
            anchorLastAction: observeOptions.anchorLastAction,
          })
          if (anchorThrows !== null) {
            const error = new Error(anchorThrows)
            error.name = 'DriverIssue'
            error.code = 'ANCHOR_UNAVAILABLE'
            throw error
          }
          if (throwSpec !== null) {
            const error = new Error(throwSpec.message)
            error.name = 'DriverIssue'
            error.code = throwSpec.code
            throw error
          }
        }
        lastWasEscalated = escalatedCall
        if (!acted) return before
        if (!escalatedCall) return after
        if (observeOptions?.withinRef !== undefined && scopedEscalated !== null) {
          return {
            ...scopedEscalated,
            scope: {
              ...scopedEscalated.scope,
              ref: observeOptions.withinRef,
              rootRef: 'n-zone-es-' + escalatedPoll,
            },
          }
        }
        return wholeEscalated ?? after
      },
      async act(_owner, action) {
        if (action.kind === 'scroll') acted = true
        return { status: 'confirmed', dispatched: true }
      },
      async evidence() {
        return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } }
      },
      async stop() {
        return { stopped: true, reason: 'requested' }
      },
    },
    escalationWindows: () => escalationWindows,
    escalatedCalls: () => escalatedCalls,
  }
}

async function exploreScroll(options) {
  const { adapter, escalationWindows, escalatedCalls } = scopedScrollAdapter(options)
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'scoped-scroll-proof', { settle: SETTLE })
  await session.start({ url: LAUNCH })
  const before = await session.observeSettled()
  const targetNode = before.observation.nodes.find(
    (item) => item.role === TARGET.role && item.name === TARGET.name,
  )
  assert.ok(targetNode, 'the fixture must expose the scroll target before the action')
  const acted = await session.act({ kind: 'scroll', ref: targetNode.ref })
  await session.stop()
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scoped-scroll-proof-'))
  try {
    const exported = await exportRecordedScenario(recorder, 'scoped-scroll-proof', {
      outputPath: join(dir, 'scoped-scroll-proof.json'),
    })
    return { acted, exported, escalationWindows: escalationWindows(), escalatedCalls: escalatedCalls() }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const ACCEPTED_SCOPED = view(
  [
    container('n-zone-es'),
    targetInViewport('n-target-es'),
  ],
  false,
  {
    scope: { ref: 'n-zone-settled', rootRef: 'n-zone-es-1', role: 'region', name: 'Deep zone', tag: 'section' },
    anchor: { ref: 'n-target-es', connected: true, contained: true },
  },
)

test('B3: the container is picked by parentRef ANCESTRY and the anchor-verified SCOPED escalation is accepted', async () => {
  const before = view(
    [
      container('n-zone-before'),
      node('n-inner', 'link', 'Inner 01', 'a', { parentRef: 'n-zone-before', inViewport: false }),
      targetOffViewport('n-target', 'n-inner'),
    ],
    false,
  )
  const after = view([outerFiller(), container('n-zone-settled')], true)

  const { acted, exported, escalationWindows, escalatedCalls } = await exploreScroll({
    before,
    after,
    scopedEscalated: ACCEPTED_SCOPED,
  })

  assert.equal(escalationWindows, 1, 'exactly ONE escalation')
  assert.ok(escalatedCalls.length >= 2, 'the escalated window polls more than once: ' + JSON.stringify(escalatedCalls))
  assert.deepEqual(
    escalatedCalls[0],
    { maxNodes: QA_ESCALATED_NODE_BUDGET, withinRef: 'n-zone-settled', anchorLastAction: true },
    'the ONE escalated read is SCOPED to the container re-keyed into the settled view, with the identity anchor requested',
  )
  for (let i = 1; i < escalatedCalls.length; i += 1) {
    assert.equal(escalatedCalls[i].withinRef, 'n-zone-es-' + i, 'each poll re-keys through the previous rootRef')
    assert.equal(escalatedCalls[i].anchorLastAction, true)
  }

  assert.equal(acted.proofEscalated, true, 'the scoped escalation was accepted and is visible')
  assert.equal(acted.observation.scope.name, 'Deep zone', 'the recorded proof observation is SCOPED')
  assert.equal(acted.observation.scope.role, 'region')
  assert.equal(acted.observation.truncated, false, 'the recorded proof keeps its own honest truncated flag')
  const inView = acted.observation.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
  assert.ok(inView, 'the proof observation returns the target')
  assert.equal(inView.inViewport, true)
  assert.ok(acted.escalatedSettle, 'the escalated window report rides along')
  assert.equal(acted.escalatedSettle.stable, true)

  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(exported.excludedActions.length, 0)
  const step = exported.scenario.steps[0]
  assert.equal(step.action.kind, 'scroll')
  assert.equal(step.assert.kind, 'node-in-viewport')
  assert.deepEqual(step.assert.expected, TARGET)
  assert.deepEqual(
    step.assert.scope,
    { role: 'region', name: 'Deep zone' },
    'the scoped proof exports WITH its scope (a scoped proof is never silently exported whole-page)',
  )
})

test('B3: the NEAREST container-role ancestor wins, skipping non-container ancestors', async () => {
  const before = view(
    [
      container('n-zone-before'),
      node('n-nav', 'navigation', 'Primary nav', 'nav', { interactive: false, inViewport: true, parentRef: 'n-zone-before' }),
      node('n-generic', 'generic', 'Wrapper', 'div', { interactive: false, inViewport: true, parentRef: 'n-nav' }),
      node('n-status', 'status', 'IDLE', 'div', { interactive: false, inViewport: true, parentRef: 'n-generic' }),
      targetOffViewport('n-target', 'n-status'),
    ],
    false,
  )
  const after = view([
    outerFiller(),
    node('n-nav-s', 'navigation', 'Primary nav', 'nav', { interactive: false, inViewport: true }),
    container('n-zone-settled'),
  ], true)
  const scopedEscalated = {
    ...ACCEPTED_SCOPED,
    scope: { ref: 'n-nav-s', rootRef: 'n-zone-es-1', role: 'navigation', name: 'Primary nav', tag: 'nav' },
    nodes: [
      node('n-nav-es', 'navigation', 'Primary nav', 'nav', { interactive: false, inViewport: true }),
      targetInViewport('n-target-es'),
    ],
  }

  const { escalatedCalls, exported } = await exploreScroll({ before, after, scopedEscalated })

  assert.deepEqual(
    escalatedCalls[0],
    { maxNodes: QA_ESCALATED_NODE_BUDGET, withinRef: 'n-nav-s', anchorLastAction: true },
    'the escalation roots at the NEAREST container-role ancestor (navigation), never a farther region or a non-container',
  )
  assert.equal(exported.ok, true, JSON.stringify(exported))
  // CHANGED (QA-BL-062): the exported scope now also records the container's
  // semantic ancestor PATH from record-time ancestry (the stronger replay
  // locator) — outermost first: the navigation container's emitted ancestor
  // chain is the 'Deep zone' region. Compare relationships, never refs.
  assert.deepEqual(exported.scenario.steps[0].assert.scope, {
    role: 'navigation',
    name: 'Primary nav',
    path: [{ role: 'region', name: 'Deep zone' }],
  })
})

test('B3: no container-role ancestor on the parentRef chain -> the WHOLE-PAGE escalation (unchanged)', async () => {
  const before = view(
    [
      node('n-status', 'status', 'IDLE', 'div', { interactive: false, inViewport: true }),
      targetOffViewport('n-target', 'n-status'),
    ],
    false,
  )
  const after = view([outerFiller()], true)
  const wholeEscalated = view([outerFiller(), targetInViewport('n-target-es')], false)

  const { acted, exported, escalationWindows, escalatedCalls } = await exploreScroll({
    before,
    after,
    wholeEscalated,
  })

  assert.equal(escalationWindows, 1, 'exactly ONE escalation')
  assert.ok(escalatedCalls.length >= 2)
  assert.ok(
    escalatedCalls.every((call) => call.withinRef === undefined && call.anchorLastAction === undefined),
    'no container on the chain: the whole-page form runs unchanged: ' + JSON.stringify(escalatedCalls),
  )
  assert.equal(acted.proofEscalated, true)
  assert.equal(acted.observation.scope, undefined, 'the whole-page proof keeps no scope')
  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(exported.scenario.steps[0].assert.scope, undefined)
})

test('B3: a container that cannot be re-keyed into the settled view falls back to the whole-page read', async () => {
  const before = view(
    [
      container('n-zone-before'),
      targetOffViewport('n-target', 'n-zone-before'),
    ],
    false,
  )
  // The settled window no longer returns the container: no re-key possible.
  const after = view([outerFiller()], true)
  const wholeEscalated = view([outerFiller(), targetInViewport('n-target-es')], false)

  const { escalatedCalls, exported } = await exploreScroll({ before, after, wholeEscalated })

  assert.ok(
    escalatedCalls.every((call) => call.withinRef === undefined),
    'an un-re-keyable container never produces a scoped read: ' + JSON.stringify(escalatedCalls),
  )
  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(exported.scenario.steps[0].assert.scope, undefined)
})

test('B3: an AMBIGUOUS container re-key (twin match) falls back to the whole-page read', async () => {
  const before = view(
    [
      container('n-zone-before'),
      targetOffViewport('n-target', 'n-zone-before'),
    ],
    false,
  )
  const after = view([container('n-zone-settled-a'), container('n-zone-settled-b')], true)
  const wholeEscalated = view([container('n-zone-es-a'), container('n-zone-es-b'), targetInViewport('n-target-es')], false)

  const { escalatedCalls } = await exploreScroll({ before, after, wholeEscalated })

  assert.ok(
    escalatedCalls.every((call) => call.withinRef === undefined),
    'a twin container is never guessed: the whole-page form runs: ' + JSON.stringify(escalatedCalls),
  )
})

test('B3: a contained:false anchor REFUSES the scoped escalation and is DISCLOSED (identity is the anchor)', async () => {
  const before = view(
    [
      container('n-zone-before'),
      targetOffViewport('n-target', 'n-zone-before'),
    ],
    false,
  )
  const after = view([outerFiller(), container('n-zone-settled')], true)
  const scopedEscalated = view(
    [
      container('n-zone-es'),
      targetInViewport('n-target-es'),
    ],
    false,
    {
      scope: { ref: 'n-zone-settled', rootRef: 'n-zone-es-1', role: 'region', name: 'Deep zone', tag: 'section' },
      // The acted element is NOT inside the scoped container (a wrong
      // container was picked / the element moved): identity truth, never a
      // re-matched twin.
      anchor: { ref: null, connected: true, contained: false },
    },
  )

  const { acted, exported, escalationWindows } = await exploreScroll({ before, after, scopedEscalated })

  assert.equal(escalationWindows, 1, 'the ONE scoped escalation ran and was refused')
  assert.equal(acted.proofEscalated, undefined, 'a refused escalation is never a proof')
  assert.deepEqual(
    acted.escalationRefused,
    { reason: 'anchor-not-contained' },
    'the refusal is disclosed with the QA-BL-067 fixed vocabulary',
  )
  assert.equal(acted.observation.truncated, true, 'the proof stays the settled observation')
  assert.equal(acted.observation.nodes.some((item) => item.name === TARGET.name), false)

  assert.equal(exported.ok, false, JSON.stringify(exported))
  assert.equal(exported.excludedActions[0].reason, 'ASSERTION_NOT_PROVABLE')
})

test('B3: a disconnected anchor (connected:false) REFUSES the scoped escalation and is DISCLOSED', async () => {
  const before = view(
    [
      container('n-zone-before'),
      targetOffViewport('n-target', 'n-zone-before'),
    ],
    false,
  )
  const after = view([outerFiller(), container('n-zone-settled')], true)
  const scopedEscalated = view(
    [container('n-zone-es')],
    false,
    {
      scope: { ref: 'n-zone-settled', rootRef: 'n-zone-es-1', role: 'region', name: 'Deep zone', tag: 'section' },
      anchor: { ref: null, connected: false, contained: false },
    },
  )

  const { acted, escalationWindows } = await exploreScroll({ before, after, scopedEscalated })

  assert.equal(escalationWindows, 1)
  assert.equal(acted.proofEscalated, undefined)
  assert.deepEqual(
    acted.escalationRefused,
    { reason: 'anchor-not-connected' },
    'the refusal is disclosed with the QA-BL-067 fixed vocabulary',
  )
  assert.equal(acted.observation.truncated, true, 'the proof stays the settled observation')
})

test('B3: ANCHOR_UNAVAILABLE (the scoped read rejected) is DISCLOSED with the driver code', async () => {
  const before = view(
    [
      container('n-zone-before'),
      targetOffViewport('n-target', 'n-zone-before'),
    ],
    false,
  )
  const after = view([outerFiller(), container('n-zone-settled')], true)

  const { acted, escalationWindows } = await exploreScroll({
    before,
    after,
    anchorThrows: 'no action target is retained (ANCHOR_UNAVAILABLE)',
  })

  assert.equal(escalationWindows, 1, 'the one scoped escalation ran and was refused')
  assert.equal(acted.proofEscalated, undefined)
  assert.deepEqual(
    acted.escalationRefused,
    { code: 'ANCHOR_UNAVAILABLE', reason: 'anchor-unavailable' },
    'QA-BL-067: the driver refusal is disclosed with the fixed vocabulary plus the driver\'s code, never silently swallowed',
  )
  assert.equal(acted.observation.truncated, true, 'the proof stays the settled observation')
})

test('B3: a scoped escalated read rejected with REF_EXPIRED is disclosed as container-not-in-view with the driver code', async () => {
  const before = view(
    [
      container('n-zone-before'),
      targetOffViewport('n-target', 'n-zone-before'),
    ],
    false,
  )
  const after = view([outerFiller(), container('n-zone-settled')], true)

  const { acted, escalationWindows } = await exploreScroll({
    before,
    after,
    throwSpec: { code: 'REF_EXPIRED', message: 'the within ref expired; observe again' },
  })

  assert.equal(escalationWindows, 1, 'the one scoped escalation ran and was refused')
  assert.equal(acted.proofEscalated, undefined)
  assert.deepEqual(
    acted.escalationRefused,
    { code: 'REF_EXPIRED', reason: 'container-not-in-view' },
    'QA-BL-067: the container root cannot be re-keyed; the driver code rides along',
  )
  assert.equal(acted.observation.truncated, true, 'the proof stays the settled observation')
})

test('B3: a null anchor ref (the acted element excluded from the view) REFUSES the scoped escalation', async () => {
  const before = view(
    [
      container('n-zone-before'),
      targetOffViewport('n-target', 'n-zone-before'),
    ],
    false,
  )
  const after = view([outerFiller(), container('n-zone-settled')], true)
  const scopedEscalated = view(
    [container('n-zone-es')],
    false,
    {
      scope: { ref: 'n-zone-settled', rootRef: 'n-zone-es-1', role: 'region', name: 'Deep zone', tag: 'section' },
      anchor: { ref: null, connected: true, contained: true },
    },
  )

  const { acted, escalationWindows } = await exploreScroll({ before, after, scopedEscalated })

  assert.equal(escalationWindows, 1)
  assert.equal(acted.proofEscalated, undefined, 'a null anchor ref can never be the proof')
  assert.deepEqual(
    acted.escalationRefused,
    { reason: 'anchor-unavailable' },
    'the refusal is disclosed with the QA-BL-067 fixed vocabulary',
  )
  assert.equal(acted.observation.truncated, true)
})

test('B3: an anchored element that is NOT in the viewport refuses the scoped escalation', async () => {
  const before = view(
    [
      container('n-zone-before'),
      targetOffViewport('n-target', 'n-zone-before'),
    ],
    false,
  )
  const after = view([outerFiller(), container('n-zone-settled')], true)
  const scopedEscalated = view(
    [
      container('n-zone-es'),
      targetOffViewport('n-target-es'),
    ],
    false,
    {
      scope: { ref: 'n-zone-settled', rootRef: 'n-zone-es-1', role: 'region', name: 'Deep zone', tag: 'section' },
      anchor: { ref: 'n-target-es', connected: true, contained: true },
    },
  )

  const { acted, escalationWindows } = await exploreScroll({ before, after, scopedEscalated })

  assert.equal(escalationWindows, 1)
  assert.equal(acted.proofEscalated, undefined, 'an anchored element off-viewport proves nothing')
  assert.deepEqual(
    acted.escalationRefused,
    { reason: 'target-not-in-viewport' },
    'the refusal is disclosed with the QA-BL-067 fixed vocabulary',
  )
})

test('B3: a scoped escalated window that never settles is refused silently (fail closed)', async () => {
  const before = view(
    [
      container('n-zone-before'),
      targetOffViewport('n-target', 'n-zone-before'),
    ],
    false,
  )
  const after = view([outerFiller(), container('n-zone-settled')], true)
  // Two alternating scoped reads: the escalated window churns until the
  // budget and returns stable:false (the anchor never gets to decide).
  let reads = 0
  let acted = false
  let escalationWindows = 0
  let lastWasEscalated = false
  const churnA = { ...ACCEPTED_SCOPED }
  const churnB = view([container('n-zone-es')], false, {
    scope: { ref: 'n-zone-settled', rootRef: 'n-zone-es-1', role: 'region', name: 'Deep zone', tag: 'section' },
    anchor: { ref: null, connected: true, contained: true },
  })
  const { adapter } = scopedScrollAdapter({ before, after })
  const churning = {
    ...adapter,
    observe: async (_owner, observeOptions) => {
      const escalatedCall = observeOptions?.maxNodes === QA_ESCALATED_NODE_BUDGET
      if (escalatedCall && !lastWasEscalated) escalationWindows += 1
      lastWasEscalated = escalatedCall
      if (!acted) return before
      if (!escalatedCall) return after
      reads += 1
      return reads % 2 === 1 ? churnA : churnB
    },
    act: async (_owner, action) => {
      if (action.kind === 'scroll') acted = true
      return { status: 'confirmed', dispatched: true }
    },
  }
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(new RecordingQaDriverAdapter(churning, recorder), 'scoped-scroll-churn', { settle: SETTLE })
  await session.start({ url: LAUNCH })
  try {
    const beforeObs = await session.observeSettled()
    const targetNode = beforeObs.observation.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
    assert.ok(targetNode)
    const acted = await session.act({ kind: 'scroll', ref: targetNode.ref })
    assert.equal(escalationWindows, 1)
    assert.equal(acted.proofEscalated, undefined, 'an unsettled escalated window is refused')
    assert.deepEqual(
      acted.escalationRefused,
      { reason: 'escalated-window-unstable' },
      'QA-BL-067: the unsettled-window refusal is DISCLOSED, never a silent exit',
    )
    assert.equal(acted.observation.truncated, true, 'the proof stays the settled observation')
  } finally {
    await session.stop().catch(() => {})
  }
})
