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

// QA-BL-045 unit suite. A scroll-by-ref on a long page leaves its settled
// post-action observation truncated at the driver node budget WITHOUT the
// target (the DOM-order window never reaches it), so the synthesized
// node-in-viewport proof fails against the recorded observation and the step
// was excluded with the click/fill wording "no semantic state change or URL
// change" — meaningless for a scroll. The fix:
//   1. the exclusion detail must name the ACTUAL scroll cause (target not
//      returned vs returned-but-not-in-viewport, and whether the view was
//      truncated), and
//   2. the recording session must take EXACTLY ONE bounded escalated
//      observation at QA_ESCALATED_NODE_BUDGET and, when that fuller view
//      stably EXTENDS the settled one, record it as the action's proof so the
//      node-in-viewport proof can be evaluated against it.
// The real-browser twin lives in test/explore-scroll-deep-target.integration.test.mjs.

const LAUNCH = 'http://127.0.0.1:7455/'
// Static synthetic page: settle windows conclude as fast as the quiet window.
const SETTLE = { budgetMs: 400, quietMs: 40, intervalMs: 5 }

function node(ref, role, name, tag, extra = {}) {
  return {
    ref,
    role,
    name,
    tag,
    interactive: role !== 'status',
    editable: false,
    disabled: false,
    ...extra,
  }
}

function view(nodes, truncated) {
  return { page: { url: LAUNCH, title: 'scroll fixture' }, nodes, truncated }
}

const TARGET = { role: 'link', name: 'Deep Target' }
const filler = () => node('n-filler', 'link', 'Filler 01', 'a', { inViewport: true })
const targetOffViewport = () => node('n-target', 'link', 'Deep Target', 'a', { inViewport: false })
const targetInViewport = () => node('n-target', 'link', 'Deep Target', 'a', { inViewport: true })

/**
 * Synthetic scroll page: before the action the target exists off-viewport;
 * after the action the default-budget view is truncated and may or may not
 * return the target. An observe call carrying QA_ESCALATED_NODE_BUDGET models
 * the ONE escalated window (returns `escalated`, defaulting to the settled
 * after view; `unstable` alternates the reads so the window never settles).
 */
function scrollAdapter({ before, after, escalated = null, unstable = false } = {}) {
  let acted = false
  let escalationWindows = 0
  let lastHadMaxNodes = false
  let windowReads = 0
  return {
    adapter: {
      kind: 'browser',
      async start(_owner, startOptions) {
        return { page: { url: startOptions?.url ?? LAUNCH, title: 'scroll fixture' }, headless: true }
      },
      async observe(_owner, observeOptions) {
        const escalatedCall = observeOptions?.maxNodes === QA_ESCALATED_NODE_BUDGET
        if (escalatedCall) {
          if (!lastHadMaxNodes) {
            escalationWindows += 1
            windowReads = 0
          }
          windowReads += 1
        }
        lastHadMaxNodes = escalatedCall
        if (!acted) return before
        if (!escalatedCall) return after
        if (unstable) return windowReads % 2 === 1 ? (escalated ?? after) : after
        return escalated ?? after
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
  }
}

async function exploreScroll(options) {
  const { adapter, escalationWindows } = scrollAdapter(options)
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'scroll-proof', { settle: SETTLE })
  await session.start({ url: LAUNCH })
  const before = await session.observeSettled()
  const targetNode = before.observation.nodes.find((item) => item.role === 'link' && item.name === 'Deep Target')
  assert.ok(targetNode, 'the fixture must expose the scroll target before the action')
  const acted = await session.act({ kind: 'scroll', ref: targetNode.ref })
  await session.stop()
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scroll-proof-'))
  try {
    const exported = await exportRecordedScenario(recorder, 'scroll-proof', {
      outputPath: join(dir, 'scroll-proof.json'),
    })
    return { acted, exported, escalationWindows: escalationWindows() }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a scroll whose truncated settled view lacks the target is excluded with the scroll-specific detail', async () => {
  const { acted, exported, escalationWindows } = await exploreScroll({
    before: view([filler(), targetOffViewport()], true),
    after: view([filler()], true),
  })

  // The settled view never returns the target, and the ONE escalated window
  // (modelled as the same truncated view) does not either: fail closed.
  assert.equal(exported.ok, false, JSON.stringify(exported))
  assert.equal(exported.code, 'NO_PROVEN_STEPS')
  assert.equal(exported.excludedActions.length, 1)
  const exclusion = exported.excludedActions[0]
  assert.equal(exclusion.reason, 'ASSERTION_NOT_PROVABLE')
  assert.match(
    exclusion.detail,
    /truncated at the driver node budget and did not return the scroll target "Deep Target"/,
    'the detail names the actual cause: the truncated settled observation never returned the target',
  )
  assert.doesNotMatch(
    exclusion.detail,
    /no semantic state change or URL change/,
    'the click/fill wording is wrong for a scroll and must never be used',
  )
  assert.equal(escalationWindows, 1, 'exactly ONE bounded escalation, never a loop')
  assert.equal(acted.observation.truncated, true, 'the recorded proof observation keeps its honest truncated flag')
  assert.equal(acted.observation.nodes.some((item) => item.name === 'Deep Target'), false)
})

test('a scroll whose settled view returned the target but not in the viewport names that cause', async () => {
  const { exported, escalationWindows } = await exploreScroll({
    before: view([filler(), targetOffViewport()], true),
    // Complete view: no escalation may be taken at all.
    after: view([filler(), targetOffViewport()], false),
  })

  assert.equal(exported.ok, false, JSON.stringify(exported))
  assert.equal(exported.excludedActions.length, 1)
  const exclusion = exported.excludedActions[0]
  assert.equal(exclusion.reason, 'ASSERTION_NOT_PROVABLE')
  assert.match(
    exclusion.detail,
    /returned the scroll target "Deep Target" but did not place it in the viewport/,
    'the detail names the actual cause: returned, but not in the viewport',
  )
  assert.doesNotMatch(exclusion.detail, /no semantic state change or URL change/)
  assert.equal(escalationWindows, 0, 'a complete settled view decides on its own: no escalation')
})

test('the ONE escalated observation is recorded as the proof when it extends the settled view', async () => {
  const { acted, exported, escalationWindows } = await exploreScroll({
    before: view([filler(), targetOffViewport()], true),
    after: view([filler()], true),
    escalated: view([filler(), targetInViewport()], false),
  })

  assert.equal(escalationWindows, 1, 'exactly ONE bounded escalation')
  assert.equal(acted.observation.truncated, false, 'the escalated view is the recorded proof observation')
  const inView = acted.observation.nodes.find((item) => item.name === 'Deep Target')
  assert.ok(inView, 'the escalated proof observation returns the target')
  assert.equal(inView.inViewport, true)

  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(exported.excludedActions.length, 0)
  assert.equal(exported.scenario.steps.length, 1)
  const step = exported.scenario.steps[0]
  assert.equal(step.action.kind, 'scroll')
  assert.ok('target' in step.action, 'the scroll is exported by target, not positionally')
  assert.equal(step.action.target.name, 'Deep Target')
  assert.equal(step.assert.kind, 'node-in-viewport')
  assert.deepEqual(step.assert.expected, TARGET)
  assert.match(step.intent, /Weak proof: .*truncated at the driver node budget/, 'the pre-action truncation is not silently hidden')
})

test('an escalated view that does not extend the settled view is refused (fail closed)', async () => {
  const { acted, exported, escalationWindows } = await exploreScroll({
    before: view([filler(), targetOffViewport()], true),
    after: view([filler()], true),
    // The page changed between the settle window and the escalated read: the
    // filler node drifted, so the fuller view is NOT the settled state.
    escalated: view([node('n-filler', 'link', 'Filler CHANGED', 'a', { inViewport: true }), targetInViewport()], false),
  })

  assert.equal(escalationWindows, 1, 'the escalation still ran exactly once')
  assert.equal(acted.observation.truncated, true, 'the proof stays the settled observation')
  assert.equal(acted.observation.nodes.some((item) => item.name === 'Deep Target'), false)

  assert.equal(exported.ok, false, JSON.stringify(exported))
  const exclusion = exported.excludedActions[0]
  assert.equal(exclusion.reason, 'ASSERTION_NOT_PROVABLE')
  assert.match(exclusion.detail, /truncated at the driver node budget and did not return the scroll target "Deep Target"/)
  assert.doesNotMatch(exclusion.detail, /no semantic state change or URL change/)
})

test('an escalated window that never settles is refused (fail closed)', async () => {
  const { acted, exported, escalationWindows } = await exploreScroll({
    before: view([filler(), targetOffViewport()], true),
    after: view([filler()], true),
    escalated: view([filler(), targetInViewport()], false),
    unstable: true,
  })

  assert.equal(escalationWindows, 1, 'the escalation still ran exactly once')
  assert.equal(acted.observation.truncated, true, 'the proof stays the settled observation')
  assert.equal(acted.observation.nodes.some((item) => item.name === 'Deep Target'), false)

  assert.equal(exported.ok, false, JSON.stringify(exported))
  const exclusion = exported.excludedActions[0]
  assert.equal(exclusion.reason, 'ASSERTION_NOT_PROVABLE')
  assert.match(exclusion.detail, /truncated at the driver node budget and did not return the scroll target "Deep Target"/)
})

test('no escalation when the settled view already places the target in the viewport', async () => {
  const { acted, exported, escalationWindows } = await exploreScroll({
    before: view([filler(), targetOffViewport()], true),
    after: view([filler(), targetInViewport()], true),
  })

  assert.equal(escalationWindows, 0, 'a settled view that already proves the outcome needs no escalation')
  assert.equal(acted.observation.truncated, true, 'the settled observation keeps its honest truncated flag')
  assert.ok(acted.observation.nodes.some((item) => item.name === 'Deep Target' && item.inViewport === true))

  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(exported.scenario.steps.length, 1)
  assert.equal(exported.scenario.steps[0].assert.kind, 'node-in-viewport')
  assert.deepEqual(exported.scenario.steps[0].assert.expected, TARGET)
})
