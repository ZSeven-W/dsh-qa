// QA-BL-050 unit suite: the record-time scroll-proof escalation prefers a
// SCOPED re-read rooted at the scroll target's nearest suitable container
// when the settled whole-page proof view is truncated and lacks the target in
// the viewport (a target beyond the driver's clamped 100-node whole-page
// window is unreachable by ANY whole-page budget). The real-browser twin
// lives in test/explore-scroll-scoped-deep-target.integration.test.mjs.
//
// Rules pinned here (see QaSession.#escalateScrollProof):
//  - the browser driver's node shape exposes NO ancestry, so the container is
//    the nearest PRECEDING container-role node (region/main/navigation/list/
//    table/form/group/complementary/article/section) in the baseline view's
//    DOM order, falling back to the baseline's scope root when the baseline
//    was scoped and no container-role node precedes the target;
//  - the container's ref is re-keyed against the SETTLED view (the driver
//    resolves within only against the latest observation), never passed from
//    the baseline;
//  - at most ONE escalation per action (scoped OR whole-page, never both); a
//    refused scoped attempt keeps the settled observation and never triggers
//    a second whole-page read;
//  - a scoped escalated view is accepted only when stable, consistent with
//    the settled view (same URL/title, every SHARED node unchanged), and the
//    target is returned with inViewport === true.

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
const targetOffViewport = () => node('n-target', TARGET.role, TARGET.name, 'a', { inViewport: false })
const targetInViewport = () => node('n-target', TARGET.role, TARGET.name, 'a', { inViewport: true })
const container = (ref, extra = {}) => node(ref, 'region', 'Deep zone', 'section', { interactive: false, inViewport: true, ...extra })
const outerFiller = () => node('n-outer', 'link', 'Outer 01', 'a', { inViewport: true })

/**
 * Synthetic scoped scroll page. before is the pre-action baseline (usually
 * a SCOPED observation whose nodes include the target); after is the
 * settled whole-page post-action view; scopedEscalated / wholeEscalated
 * model the ONE escalated window's reads for scoped and whole-page calls
 * respectively. Every scoped read echoes its passed within ref as the scope
 * root ref (the driver behaviour) and returns the root node first, so the
 * settle re-keying works. All observe calls during escalation windows are
 * recorded in escalatedCalls ({ maxNodes, withinRef }).
 */
function scopedScrollAdapter({ before, after, scopedEscalated = null, wholeEscalated = null } = {}) {
  let acted = false
  let escalationWindows = 0
  let lastWasEscalation = false
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
          escalatedCalls.push({ maxNodes: observeOptions.maxNodes, withinRef: observeOptions.withinRef })
          if (!lastWasEscalation) {
            escalationWindows += 1
          }
        }
        lastWasEscalation = escalatedCall
        if (!acted) return before
        if (!escalatedCall) return after
        if (observeOptions.withinRef !== undefined) return scopedEscalated ?? after
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

/** Scoped view helper: scope echoes the passed ref; the root node is first. */
function scopedView(withinRef, nodes, truncated, extra = {}) {
  const root = nodes[0]
  return view(nodes, truncated, {
    ...extra,
    scope: { ref: withinRef, role: root.role, name: root.name, tag: root.tag },
  })
}

test('a target beyond the whole-page window but inside a container escalates SCOPED and exports with the scope', async () => {
  const before = view([
    container('n-zone-before'),
    node('n-inner', 'link', 'Inner 01', 'a', { inViewport: false }),
    targetOffViewport(),
  ], false, {
    scope: { ref: 'n-zone-before', role: 'region', name: 'Deep zone', tag: 'section' },
  })
  const after = view([outerFiller(), container('n-zone-settled')], true)
  const scopedEscalated = scopedView('n-zone-settled', [
    container('n-zone-scoped'),
    node('n-inner-scoped', 'link', 'Inner 01', 'a', { inViewport: false }),
    targetInViewport(),
  ], false)

  const { acted, exported, escalationWindows, escalatedCalls } = await exploreScroll({
    before,
    after,
    scopedEscalated,
  })

  assert.equal(escalationWindows, 1, 'exactly ONE escalation, never scoped + whole-page')
  assert.ok(escalatedCalls.length >= 2, 'the escalated window polls more than once: ' + JSON.stringify(escalatedCalls))
  assert.ok(
    escalatedCalls.every((call) => call.maxNodes === QA_ESCALATED_NODE_BUDGET && call.withinRef !== undefined),
    'every escalated read is SCOPED at the bounded budget: ' + JSON.stringify(escalatedCalls),
  )
  assert.equal(
    escalatedCalls[0].withinRef,
    'n-zone-settled',
    'the within ref is re-keyed from the SETTLED view (the driver only resolves the latest observation), never the baseline ref "n-zone-before"',
  )

  assert.equal(acted.proofEscalated, true, 'the scoped escalation was accepted and is visible')
  assert.deepEqual(
    acted.observation.scope === undefined
      ? undefined
      : { role: acted.observation.scope.role, name: acted.observation.scope.name },
    { role: 'region', name: 'Deep zone' },
    'the recorded proof observation is the SCOPED view',
  )
  assert.equal(acted.observation.truncated, false, 'the recorded proof keeps its own honest truncated flag')
  const inView = acted.observation.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
  assert.ok(inView, 'the proof observation returns the target')
  assert.equal(inView.inViewport, true)

  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(exported.excludedActions.length, 0)
  const step = exported.scenario.steps[0]
  assert.equal(step.action.kind, 'scroll')
  assert.equal(step.assert.kind, 'node-in-viewport')
  assert.deepEqual(step.assert.expected, TARGET)
  assert.deepEqual(
    step.assert.scope,
    { role: 'region', name: 'Deep zone' },
    'the scoped proof exports with the container scope, never as a whole-page proof',
  )
})

test('the container rule prefers the NEAREST preceding container-role node, not the scope root', async () => {
  const before = view([
    node('n-zone-a', 'region', 'Zone A', 'section', { interactive: false, inViewport: true }),
    node('n-mid', 'link', 'Middle link', 'a', { inViewport: true }),
    node('n-nav', 'navigation', 'Primary nav', 'nav', { interactive: false, inViewport: true }),
    targetOffViewport(),
  ], false, {
    scope: { ref: 'n-zone-a', role: 'region', name: 'Zone A', tag: 'section' },
  })
  const after = view([
    node('n-zone-a-s', 'region', 'Zone A', 'section', { interactive: false, inViewport: true }),
    node('n-nav-s', 'navigation', 'Primary nav', 'nav', { interactive: false, inViewport: true }),
  ], true)
  const scopedEscalated = scopedView('n-nav-s', [
    node('n-nav-scoped', 'navigation', 'Primary nav', 'nav', { interactive: false, inViewport: true }),
    targetInViewport(),
  ], false)

  const { escalationWindows, escalatedCalls, exported } = await exploreScroll({
    before,
    after,
    scopedEscalated,
  })

  assert.equal(escalationWindows, 1)
  assert.ok(escalatedCalls.length > 0)
  assert.equal(
    escalatedCalls[0].withinRef,
    'n-nav-s',
    'the container is the NEAREST preceding container-role node (navigation), not the scoped baseline root (region "Zone A")',
  )
  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.deepEqual(
    exported.scenario.steps[0].assert.scope,
    { role: 'navigation', name: 'Primary nav' },
  )
})

test('a scoped baseline with no container-role predecessor falls back to its scope root as the container', async () => {
  const before = view([
    node('n-wrap', 'generic', 'Wrapper', 'div', { interactive: false, inViewport: true }),
    targetOffViewport(),
  ], false, {
    scope: { ref: 'n-wrap', role: 'generic', name: 'Wrapper', tag: 'div' },
  })
  const after = view([node('n-wrap-s', 'generic', 'Wrapper', 'div', { interactive: false, inViewport: true })], true)
  const scopedEscalated = scopedView('n-wrap-s', [
    node('n-wrap-scoped', 'generic', 'Wrapper', 'div', { interactive: false, inViewport: true }),
    targetInViewport(),
  ], false)

  const { escalationWindows, escalatedCalls, exported } = await exploreScroll({
    before,
    after,
    scopedEscalated,
  })

  assert.equal(escalationWindows, 1)
  assert.equal(
    escalatedCalls[0].withinRef,
    'n-wrap-s',
    'the scope root (a recorded element containing the target) is the container when no container-role node precedes the target',
  )
  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.deepEqual(exported.scenario.steps[0].assert.scope, { role: 'generic', name: 'Wrapper' })
})

test('no suitable container falls back to exactly ONE whole-page escalation, never two', async () => {
  const before = view([outerFiller(), targetOffViewport()], true)
  const after = view([outerFiller()], true)
  const wholeEscalated = view([outerFiller(), targetInViewport()], false)

  const { acted, exported, escalationWindows, escalatedCalls } = await exploreScroll({
    before,
    after,
    wholeEscalated,
  })

  assert.equal(escalationWindows, 1, 'exactly ONE whole-page escalation, never a scoped one on top')
  assert.ok(escalatedCalls.length > 0)
  assert.ok(
    escalatedCalls.every((call) => call.withinRef === undefined),
    'the whole-page fallback never carries a within ref: ' + JSON.stringify(escalatedCalls),
  )
  assert.equal(acted.proofEscalated, true)
  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(
    exported.scenario.steps[0].assert.scope,
    undefined,
    'a whole-page proof still exports without a scope',
  )
})

test('a container absent from the settled view cannot be re-keyed: whole-page fallback, exactly one escalation', async () => {
  const before = view([container('n-zone-before'), targetOffViewport()], false)
  const after = view([outerFiller()], true)
  const wholeEscalated = view([outerFiller(), targetInViewport()], false)

  const { escalationWindows, escalatedCalls, exported } = await exploreScroll({
    before,
    after,
    wholeEscalated,
  })

  assert.equal(escalationWindows, 1)
  assert.ok(
    escalatedCalls.every((call) => call.withinRef === undefined),
    'the container is not in the settled view, so the escalation is whole-page: ' + JSON.stringify(escalatedCalls),
  )
  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(exported.scenario.steps[0].assert.scope, undefined)
})

test('a scoped escalated view inconsistent with the settled view is refused and the settled observation is kept', async () => {
  const before = view([
    container('n-zone-before'),
    targetOffViewport(),
  ], false, {
    scope: { ref: 'n-zone-before', role: 'region', name: 'Deep zone', tag: 'section' },
  })
  const after = view([outerFiller(), container('n-zone-settled')], true)
  // The container root the scoped view SHARES with the settled view drifted
  // (inViewport flipped): the two windows disagree on the same node, so the
  // page changed between the reads and the escalation must be refused.
  const scopedEscalated = scopedView('n-zone-settled', [
    container('n-zone-scoped', { inViewport: false }),
    targetInViewport(),
  ], false)

  const { acted, exported, escalationWindows, escalatedCalls } = await exploreScroll({
    before,
    after,
    scopedEscalated,
  })

  assert.equal(escalationWindows, 1, 'the escalation still ran exactly once')
  assert.ok(escalatedCalls.every((call) => call.withinRef !== undefined), 'the attempt was SCOPED')
  assert.equal(acted.proofEscalated, undefined, 'a refused escalation is not visible as proofEscalated')
  assert.equal(acted.observation.truncated, true, 'the proof stays the settled observation')
  assert.equal(
    acted.observation.nodes.some((item) => item.name === TARGET.name),
    false,
    'the refused escalation keeps the settled observation',
  )
  assert.equal(acted.observation.scope, undefined, 'the settled whole-page observation keeps no scope')

  assert.equal(exported.ok, false, JSON.stringify(exported))
  const exclusion = exported.excludedActions[0]
  assert.equal(exclusion.reason, 'ASSERTION_NOT_PROVABLE')
  assert.match(exclusion.detail, /truncated at the driver node budget and did not return the scroll target "Deep Target"/)
})

test('a scoped escalated view at another URL is refused (the consistency rule names the page identity)', async () => {
  const before = view([
    container('n-zone-before'),
    targetOffViewport(),
  ], false, {
    scope: { ref: 'n-zone-before', role: 'region', name: 'Deep zone', tag: 'section' },
  })
  const after = view([outerFiller(), container('n-zone-settled')], true)
  const scopedEscalated = scopedView('n-zone-settled', [
    container('n-zone-scoped'),
    targetInViewport(),
  ], false, { page: { url: LAUNCH + 'other', title: 'scoped scroll fixture' } })

  const { acted, escalationWindows } = await exploreScroll({ before, after, scopedEscalated })

  assert.equal(escalationWindows, 1)
  assert.equal(acted.proofEscalated, undefined)
  assert.equal(acted.observation.nodes.some((item) => item.name === TARGET.name), false)
})

test('a scoped escalated view that returns the target but NOT in the viewport is refused', async () => {
  const before = view([
    container('n-zone-before'),
    targetOffViewport(),
  ], false, {
    scope: { ref: 'n-zone-before', role: 'region', name: 'Deep zone', tag: 'section' },
  })
  const after = view([outerFiller(), container('n-zone-settled')], true)
  const scopedEscalated = scopedView('n-zone-settled', [
    container('n-zone-scoped'),
    targetOffViewport(),
  ], false)

  const { acted, exported, escalationWindows } = await exploreScroll({ before, after, scopedEscalated })

  assert.equal(escalationWindows, 1, 'the escalation still ran exactly once')
  assert.equal(acted.proofEscalated, undefined, 'a useless escalation is refused')
  assert.equal(acted.observation.nodes.some((item) => item.name === TARGET.name), false)

  assert.equal(exported.ok, false, JSON.stringify(exported))
  assert.match(
    exported.excludedActions[0].detail,
    /truncated at the driver node budget and did not return the scroll target "Deep Target"/,
  )
})
