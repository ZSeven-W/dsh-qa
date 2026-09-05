// QA-BL-050 -> QA-BL-055 (pinned ABSENCE): the heuristic SCOPED record-time
// scroll-proof escalation is RETIRED. The audit (F4) showed the container
// heuristic can pick a NON-ancestor, and a same-identity twin inside the wrong
// container can then satisfy the proof (finding by role+name+tag across
// observations is not identity). Until contract v9's identity anchor
// (QA-BL-055, Phase B) restores the capability, the ONE record-time escalation
// is the WHOLE-PAGE read again (QA-BL-045/047 behaviour, all QA-BL-047
// acceptance properties intact).
//
// This suite CONVERTED the tests that pinned the heuristic into tests that pin
// its ABSENCE: no escalated observe may carry a withinRef, whatever the
// recorded baseline looks like (a scoped baseline, container-role
// predecessors, a scope root without a container predecessor). The whole-page
// acceptance properties themselves remain pinned in
// test/scroll-proof-escalation.test.mjs. QA-BL-058: a refused escalation (the
// escalated read threw) is now DISCLOSED on the act result as
// escalationRefused — still fail-closed, the settled observation is kept.
// The real-browser twin lives in
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
const targetOffViewport = () => node('n-target', TARGET.role, TARGET.name, 'a', { inViewport: false })
const targetInViewport = () => node('n-target', TARGET.role, TARGET.name, 'a', { inViewport: true })
const container = (ref, extra = {}) => node(ref, 'region', 'Deep zone', 'section', { interactive: false, inViewport: true, ...extra })
const outerFiller = () => node('n-outer', 'link', 'Outer 01', 'a', { inViewport: true })

/**
 * Synthetic scoped scroll page. before is the pre-action baseline (often a
 * SCOPED observation whose nodes include the target); after is the settled
 * whole-page post-action view; wholeEscalated models the ONE whole-page
 * escalated window's reads. Every escalated observe call is recorded in
 * escalatedCalls ({ maxNodes, withinRef }) so the tests can pin that NO call
 * ever carries a withinRef (the retired heuristic's absence).
 */
function scopedScrollAdapter({ before, after, wholeEscalated = null, wholeEscalatedThrows = false } = {}) {
  let acted = false
  let escalationWindows = 0
  let lastWasEscalated = false
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
          if (!lastWasEscalated) {
            escalationWindows += 1
          }
          if (wholeEscalatedThrows) {
            const error = new Error('the driver refused the escalated read: the page changed')
            error.name = 'DriverIssue'
            error.code = 'PAGE_CHANGED'
            throw error
          }
        }
        lastWasEscalated = escalatedCall
        if (!acted) return before
        if (!escalatedCall) return after
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

test('the heuristic is retired: a target beyond the whole-page window escalates WHOLE-PAGE only, never scoped (QA-BL-055)', async () => {
  // The old QA-BL-050 expectation: this exact fixture produced a SCOPED
  // escalated read rooted at the container. The converted expectation: the
  // escalation is whole-page, no withinRef anywhere, and the proof (and its
  // export) carries NO scope.
  const before = view([
    container('n-zone-before'),
    node('n-inner', 'link', 'Inner 01', 'a', { inViewport: false }),
    targetOffViewport(),
  ], false, {
    scope: { ref: 'n-zone-before', role: 'region', name: 'Deep zone', tag: 'section' },
  })
  const after = view([outerFiller(), container('n-zone-settled')], true)
  const wholeEscalated = view([outerFiller(), container('n-zone-settled'), targetInViewport()], false)

  const { acted, exported, escalationWindows, escalatedCalls } = await exploreScroll({
    before,
    after,
    wholeEscalated,
  })

  assert.equal(escalationWindows, 1, 'exactly ONE escalation, whole-page only')
  assert.ok(escalatedCalls.length >= 2, 'the escalated window polls more than once: ' + JSON.stringify(escalatedCalls))
  assert.ok(
    escalatedCalls.every((call) => call.maxNodes === QA_ESCALATED_NODE_BUDGET && call.withinRef === undefined),
    'NO escalated read may carry a withinRef — the scoped heuristic is gone: ' + JSON.stringify(escalatedCalls),
  )

  assert.equal(acted.proofEscalated, true, 'the whole-page escalation was accepted and is visible')
  assert.equal(acted.observation.scope, undefined, 'the recorded proof observation is WHOLE-PAGE, never scoped')
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
  assert.equal(
    step.assert.scope,
    undefined,
    'the whole-page proof exports WITHOUT a scope (a scoped proof is never invented, a whole-page one never decorated)',
  )
})

test('a container-role predecessor in the baseline changes nothing: still whole-page (QA-BL-055)', async () => {
  // The old heuristic picked the NEAREST preceding container-role node
  // (navigation) over the scoped baseline root. The converted expectation:
  // neither matters — the escalation never scopes.
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
  const wholeEscalated = view([
    node('n-zone-a-s', 'region', 'Zone A', 'section', { interactive: false, inViewport: true }),
    node('n-nav-s', 'navigation', 'Primary nav', 'nav', { interactive: false, inViewport: true }),
    targetInViewport(),
  ], false)

  const { escalationWindows, escalatedCalls, exported } = await exploreScroll({
    before,
    after,
    wholeEscalated,
  })

  assert.equal(escalationWindows, 1)
  assert.ok(escalatedCalls.length > 0)
  assert.ok(
    escalatedCalls.every((call) => call.withinRef === undefined),
    'the nearest-container heuristic is retired: no withinRef: ' + JSON.stringify(escalatedCalls),
  )
  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(exported.scenario.steps[0].assert.scope, undefined)
})

test('a scoped baseline without a container predecessor changes nothing: still whole-page (QA-BL-055)', async () => {
  // The old rule fell back to the scoped baseline's root as the container.
  // The converted expectation: the escalation stays whole-page.
  const before = view([
    node('n-wrap', 'generic', 'Wrapper', 'div', { interactive: false, inViewport: true }),
    targetOffViewport(),
  ], false, {
    scope: { ref: 'n-wrap', role: 'generic', name: 'Wrapper', tag: 'div' },
  })
  const after = view([node('n-wrap-s', 'generic', 'Wrapper', 'div', { interactive: false, inViewport: true })], true)
  const wholeEscalated = view([
    node('n-wrap-s', 'generic', 'Wrapper', 'div', { interactive: false, inViewport: true }),
    targetInViewport(),
  ], false)

  const { escalationWindows, escalatedCalls, exported } = await exploreScroll({
    before,
    after,
    wholeEscalated,
  })

  assert.equal(escalationWindows, 1)
  assert.ok(
    escalatedCalls.every((call) => call.withinRef === undefined),
    'the scope-root fallback is retired: no withinRef: ' + JSON.stringify(escalatedCalls),
  )
  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(exported.scenario.steps[0].assert.scope, undefined)
})

test('an escalated view inconsistent with the settled one refuses whole-page — the retired scoped consistency rule never runs (QA-BL-055)', async () => {
  const before = view([
    container('n-zone-before'),
    targetOffViewport(),
  ], false, {
    scope: { ref: 'n-zone-before', role: 'region', name: 'Deep zone', tag: 'section' },
  })
  const after = view([outerFiller(), container('n-zone-settled')], true)
  // The escalated whole-page view is at ANOTHER URL: scrollProofExtends fails,
  // so the escalation is refused (the old SCOPED consistency rule — same
  // URL/title plus shared nodes unchanged — is retired together with the
  // scoped escalation it guarded).
  const wholeEscalated = view(
    [outerFiller(), container('n-zone-settled'), targetInViewport()],
    false,
    { page: { url: LAUNCH + 'other', title: 'scoped scroll fixture' } },
  )

  const { acted, exported, escalationWindows, escalatedCalls } = await exploreScroll({
    before,
    after,
    wholeEscalated,
  })

  assert.equal(escalationWindows, 1, 'the escalation still ran exactly once')
  assert.ok(escalatedCalls.every((call) => call.withinRef === undefined), 'the attempt was WHOLE-PAGE only')
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

test('a whole-page escalation that returns the target but NOT in the viewport is refused (QA-BL-055)', async () => {
  const before = view([
    container('n-zone-before'),
    targetOffViewport(),
  ], false, {
    scope: { ref: 'n-zone-before', role: 'region', name: 'Deep zone', tag: 'section' },
  })
  const after = view([outerFiller(), container('n-zone-settled')], true)
  const wholeEscalated = view([outerFiller(), container('n-zone-settled'), targetOffViewport()], false)

  const { acted, exported, escalationWindows, escalatedCalls } = await exploreScroll({
    before,
    after,
    wholeEscalated,
  })

  assert.equal(escalationWindows, 1, 'the escalation still ran exactly once')
  assert.ok(escalatedCalls.every((call) => call.withinRef === undefined), 'the attempt was WHOLE-PAGE only')
  assert.equal(acted.proofEscalated, undefined, 'a useless escalation is refused')
  assert.equal(acted.observation.nodes.some((item) => item.name === TARGET.name), false)

  assert.equal(exported.ok, false, JSON.stringify(exported))
  assert.match(
    exported.excludedActions[0].detail,
    /truncated at the driver node budget and did not return the scroll target "Deep Target"/,
  )
})

test('a refused (throwing) escalated read is DISCLOSED as escalationRefused and keeps the settled observation (QA-BL-058)', async () => {
  // CHANGED (QA-BL-058): the catch that used to swallow a driver refusal into
  // a silent "no escalation" now discloses it — the fail-closed behaviour is
  // unchanged, only the observability is new.
  const before = view([
    container('n-zone-before'),
    targetOffViewport(),
  ], false, {
    scope: { ref: 'n-zone-before', role: 'region', name: 'Deep zone', tag: 'section' },
  })
  const after = view([outerFiller(), container('n-zone-settled')], true)

  const { acted, exported, escalationWindows } = await exploreScroll({
    before,
    after,
    wholeEscalatedThrows: true,
  })

  assert.equal(escalationWindows, 1, 'the one escalation still ran and was refused')
  assert.deepEqual(
    acted.escalationRefused,
    { code: 'PAGE_CHANGED', reason: 'the driver refused the escalated read: the page changed' },
    'the driver refusal is disclosed, never silently swallowed',
  )
  assert.equal(acted.proofEscalated, undefined, 'a refused escalation is never a proof')
  assert.equal(acted.outcome, 'ok', 'the receipt outcome is unchanged by the refused proof escalation')
  assert.equal(acted.observation.truncated, true, 'the proof stays the settled observation')
  assert.equal(acted.observation.nodes.some((item) => item.name === TARGET.name), false)

  assert.equal(exported.ok, false, JSON.stringify(exported))
  assert.equal(exported.excludedActions[0].reason, 'ASSERTION_NOT_PROVABLE')
})

test('exactly ONE whole-page escalation per action, never a second read (QA-BL-055)', async () => {
  // The old "no suitable container" fallback test now pins the ONLY path:
  // one whole-page read, refused, and no second attempt of any kind.
  const before = view([outerFiller(), targetOffViewport()], true)
  const after = view([outerFiller()], true)
  const wholeEscalated = view([outerFiller()], true)

  const { acted, exported, escalationWindows, escalatedCalls } = await exploreScroll({
    before,
    after,
    wholeEscalated,
  })

  assert.equal(escalationWindows, 1, 'exactly ONE whole-page escalation')
  assert.ok(escalatedCalls.length > 0)
  assert.ok(
    escalatedCalls.every((call) => call.withinRef === undefined),
    'the whole-page read never carries a within ref: ' + JSON.stringify(escalatedCalls),
  )
  assert.equal(acted.proofEscalated, undefined, 'a still-truncated escalated view is refused')
  assert.equal(exported.ok, false, JSON.stringify(exported))
  assert.equal(exported.excludedActions[0].reason, 'ASSERTION_NOT_PROVABLE')
})
