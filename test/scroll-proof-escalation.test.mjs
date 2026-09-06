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
  assert.deepEqual(
    acted.escalationRefused,
    { reason: 'target-not-returned' },
    'QA-BL-067: the refused escalation is DISCLOSED with the fixed vocabulary, never a silent exit',
  )
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
  assert.deepEqual(
    acted.escalationRefused,
    { reason: 'escalated-window-unstable' },
    'QA-BL-067: a view that changed between the two reads is disclosed (the escalated window is not the stable page state), never a silent exit',
  )
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
  assert.deepEqual(
    acted.escalationRefused,
    { reason: 'escalated-window-unstable' },
    'QA-BL-067: a churning escalated window is DISCLOSED, never a silent exit',
  )
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

// ---------------------------------------------------------------------------
// QA-BL-047: the record-time escalation must be side-effect-free (F1/F2),
// target-gated (F3), explicitly re-bound (F6), and visible on the result (F4).
// ---------------------------------------------------------------------------

test('after an ACCEPTED escalation the next act baseline stays the original settled view', async () => {
  const before = view([filler(), targetOffViewport()], true)
  const after = view([filler()], true)
  const escalated = view([filler(), targetInViewport()], false)
  let acted = false
  let escalationWindows = 0
  let lastHadMaxNodes = false
  const adapter = {
    kind: 'browser',
    async start(_owner, startOptions) {
      return { page: { url: startOptions?.url ?? LAUNCH, title: 'scroll fixture' }, headless: true }
    },
    async observe(_owner, observeOptions) {
      const escalatedCall = observeOptions?.maxNodes === QA_ESCALATED_NODE_BUDGET
      if (!acted) {
        lastHadMaxNodes = escalatedCall
        return before
      }
      if (escalatedCall) {
        if (!lastHadMaxNodes) escalationWindows += 1
        lastHadMaxNodes = escalatedCall
        return escalated
      }
      lastHadMaxNodes = escalatedCall
      return after
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
  }
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(
    new RecordingQaDriverAdapter(adapter, recorder),
    'baseline-after-escalation',
    { settle: SETTLE },
  )
  await session.start({ url: LAUNCH })
  try {
    const beforeObs = await session.observeSettled()
    const targetNode = beforeObs.observation.nodes.find((item) => item.name === 'Deep Target')
    assert.ok(targetNode, 'the fixture must expose the scroll target before the action')
    const scrolled = await session.act({ kind: 'scroll', ref: targetNode.ref })
    assert.equal(escalationWindows, 1, 'precondition: the escalation was taken exactly once')
    assert.ok(
      scrolled.observation.nodes.some((item) => item.name === 'Deep Target' && item.inViewport === true),
      'precondition: the escalated view was accepted as the proof',
    )
    // The page does NOT change afterwards. The next act's proof window must
    // therefore wait out its full budget: a baseline polluted with the
    // 100-node escalated projection would satisfy awaitChange through the
    // budget mismatch alone and conclude on the first poll instead of waiting
    // for an outcome that may still be in flight.
    const fillerNode = beforeObs.observation.nodes.find((item) => item.name === 'Filler 01')
    assert.ok(fillerNode)
    const clicked = await session.act({ kind: 'click', ref: fillerNode.ref })
    assert.ok(clicked.settle, 'the click has a settle window')
    assert.ok(
      clicked.settle.elapsedMs >= SETTLE.budgetMs,
      'the next act baseline must be the ORIGINAL settled view: the window waited the budget ('
        + clicked.settle.elapsedMs + 'ms) instead of concluding on the first poll',
    )
  } finally {
    await session.stop().catch(() => {})
  }
})

test('a churning escalated window never widens the session policy or flips the gate', async () => {
  const before = view([filler(), targetOffViewport()], true)
  const after = view([filler()], true)
  const churnA = view([filler()], true)
  const churnB = view([filler(), targetOffViewport()], true)
  let acted = false
  let escalationReads = 0
  const adapter = {
    kind: 'browser',
    async start(_owner, startOptions) {
      return { page: { url: startOptions?.url ?? LAUNCH, title: 'scroll fixture' }, headless: true }
    },
    async observe(_owner, observeOptions) {
      if (!acted) return before
      if (observeOptions?.maxNodes === QA_ESCALATED_NODE_BUDGET) {
        escalationReads += 1
        return escalationReads % 2 === 1 ? churnA : churnB
      }
      return after
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
  }
  const CHURN_SETTLE = { budgetMs: 200, quietMs: 30, intervalMs: 10, adaptiveBudgetMs: 400 }
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(
    new RecordingQaDriverAdapter(adapter, recorder),
    'churning-escalation',
    { settle: CHURN_SETTLE },
  )
  await session.start({ url: LAUNCH })
  try {
    const beforeObs = await session.observeSettled()
    const targetNode = beforeObs.observation.nodes.find((item) => item.name === 'Deep Target')
    assert.ok(targetNode)
    const actedResult = await session.act({ kind: 'scroll', ref: targetNode.ref })
    // The churning escalated window is refused: the proof stays the settled view.
    assert.equal(
      actedResult.observation.nodes.some((item) => item.name === 'Deep Target'),
      false,
      'the refused escalation keeps the settled observation',
    )
    // The refused proof re-read must not have widened the session budget,
    // re-persisted the policy, or flipped the once-per-session gate.
    assert.equal(
      session.settlePolicy.budgetMs,
      CHURN_SETTLE.budgetMs,
      'a proof re-read never changes the session policy',
    )
    assert.equal(
      recorder.snapshot('churning-escalation').settlePolicy.budgetMs,
      CHURN_SETTLE.budgetMs,
      'the persisted policy stays the original: the refused escalation never re-persists a widened one',
    )
    assert.notEqual(
      session.widenForRetry(),
      null,
      'the once-per-session gate is still open for the real widen paths',
    )
    assert.equal(
      session.settlePolicy.budgetMs,
      CHURN_SETTLE.adaptiveBudgetMs,
      'widenForRetry itself still widens through the gate',
    )
  } finally {
    await session.stop().catch(() => {})
  }
})

test('an escalated view that extends the settled view but still lacks the target in the viewport is refused', async () => {
  const { acted, exported, escalationWindows } = await exploreScroll({
    before: view([filler(), targetOffViewport()], true),
    after: view([filler()], true),
    // Extends the settled view (the filler node is unchanged) and returns the
    // target, but NOT in the viewport: a useless escalation must be refused.
    escalated: view([filler(), targetOffViewport()], false),
  })

  assert.equal(escalationWindows, 1, 'the escalation still ran exactly once')
  assert.deepEqual(
    acted.escalationRefused,
    { reason: 'target-not-in-viewport' },
    'QA-BL-067: a returned-but-off-viewport target is DISCLOSED with the fixed vocabulary, never a silent exit',
  )
  assert.equal(
    acted.observation.nodes.some((item) => item.name === 'Deep Target'),
    false,
    'the proof stays the settled observation: the escalated view proves nothing new',
  )

  assert.equal(exported.ok, false, JSON.stringify(exported))
  const exclusion = exported.excludedActions[0]
  assert.equal(exclusion.reason, 'ASSERTION_NOT_PROVABLE')
  assert.match(exclusion.detail, /truncated at the driver node budget and did not return the scroll target "Deep Target"/)
  assert.doesNotMatch(exclusion.detail, /no semantic state change or URL change/)
})

test('an accepted escalation is visible on the act result', async () => {
  const { acted, exported, escalationWindows } = await exploreScroll({
    before: view([filler(), targetOffViewport()], true),
    after: view([filler()], true),
    escalated: view([filler(), targetInViewport()], false),
  })

  assert.equal(escalationWindows, 1)
  assert.equal(acted.proofEscalated, true, 'the additive marker names the escalated proof')
  assert.ok(acted.escalatedSettle, 'the escalated window report rides alongside')
  assert.equal(acted.escalatedSettle.stable, true)
  assert.ok(acted.escalatedSettle.passes >= 1)
  assert.ok(acted.escalatedSettle.budgetMs > 0)
  assert.ok(acted.escalatedSettle.elapsedMs >= 0)
  assert.equal(acted.escalatedSettle.widened, null, 'the escalated re-read never widens')
  assert.ok(acted.settle, 'the action\'s own settle report stays the FIRST window')
  assert.equal(acted.settle.stable, true)
  assert.equal(exported.ok, true, JSON.stringify(exported))
})

test('an action whose ref is absent from the baseline is refused as target-not-in-baseline (disclosed)', async () => {
  const before = view([filler(), targetOffViewport()], true)
  const after = view([filler()], true)
  let escalationWindows = 0
  const adapter = {
    kind: 'browser',
    async start(_owner, startOptions) {
      return { page: { url: startOptions?.url ?? LAUNCH, title: 'scroll fixture' }, headless: true }
    },
    async observe(_owner, observeOptions) {
      if (observeOptions?.maxNodes === QA_ESCALATED_NODE_BUDGET) escalationWindows += 1
      return observeOptions?.maxNodes === QA_ESCALATED_NODE_BUDGET ? after : before
    },
    async act(_owner, action) {
      if (action.kind === 'scroll') return { status: 'confirmed', dispatched: true }
      throw new Error('unexpected action ' + action.kind)
    },
    async evidence() {
      return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } }
    },
    async stop() {
      return { stopped: true, reason: 'requested' }
    },
  }
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'baseline-ghost', { settle: SETTLE })
  await session.start({ url: LAUNCH })
  try {
    await session.observeSettled()
    // The acted ref belongs to NO node of the baseline observation.
    const acted = await session.act({ kind: 'scroll', ref: 'n-ghost' })
    assert.equal(escalationWindows, 0, 'no escalation read ever happens when the target is not in the baseline')
    assert.deepEqual(
      acted.escalationRefused,
      { reason: 'target-not-in-baseline' },
      'QA-BL-067: the silent exit is DISCLOSED with the fixed vocabulary',
    )
  } finally {
    await session.stop().catch(() => {})
  }
})

test('bindEscalatedScrollProof re-binds exactly the recorded action id and refuses a non-matching one', () => {
  const recorder = new QaTrajectoryRecorder()
  const owner = 'bind-explicit'
  recorder.start(owner, 'browser', {}, { page: { url: LAUNCH, title: 'scroll fixture' }, headless: true })
  const scrollId = recorder.action(owner, { kind: 'scroll', ref: 'n-target' })
  recorder.receipt(owner, scrollId, { status: 'confirmed', dispatched: true })
  recorder.observation(owner, view([filler()], true))
  recorder.observation(owner, view([filler()], true))
  recorder.settle(owner, { stable: true, passes: 2, elapsedMs: 45, budgetMs: 400, quietRequiredMs: 40, widened: null })
  const settledProofId = recorder.snapshot(owner).actions[0].afterObservationId
  // The escalated window records its own observations before the notification.
  recorder.observation(owner, view([filler(), targetInViewport()], false))

  // A non-matching id is refused AND recorded as an issue; the binding stays put.
  recorder.bindEscalatedScrollProof(owner, 'action-404')
  const refused = recorder.snapshot(owner)
  assert.ok(
    refused.recordingIssues.some((issue) => issue.includes('action-404')),
    'the refusal is recorded: ' + refused.recordingIssues.join(' | '),
  )
  assert.equal(refused.actions[0].afterObservationId, settledProofId, 'a refused re-bind never moves the proof')

  // The exact recorded id re-binds the proof to the escalated observation.
  recorder.bindEscalatedScrollProof(owner, scrollId)
  const rebound = recorder.snapshot(owner)
  const lastObservation = [...rebound.events].reverse().find((event) => event.kind === 'observation')
  assert.equal(rebound.actions[0].afterObservationId, lastObservation.observationId, 'the proof is re-bound to the escalated observation')
})

test('bindEscalatedScrollProof refuses a valid action id once a later action settled', () => {
  const recorder = new QaTrajectoryRecorder()
  const owner = 'bind-stale'
  recorder.start(owner, 'browser', {}, { page: { url: LAUNCH, title: 'scroll fixture' }, headless: true })
  const report = { stable: true, passes: 2, elapsedMs: 45, budgetMs: 400, quietRequiredMs: 40, widened: null }
  const firstId = recorder.action(owner, { kind: 'scroll', ref: 'n-target' })
  recorder.receipt(owner, firstId, { status: 'confirmed', dispatched: true })
  recorder.observation(owner, view([filler()], true))
  recorder.observation(owner, view([filler()], true))
  recorder.settle(owner, report)
  // A concurrent act on the same owner settled in between the action's own
  // settle and the escalation notification.
  const secondId = recorder.action(owner, { kind: 'click', ref: 'n-filler' })
  recorder.receipt(owner, secondId, { status: 'confirmed', dispatched: true })
  recorder.observation(owner, view([filler()], true))
  recorder.observation(owner, view([filler()], true))
  recorder.settle(owner, report)
  const secondProofId = recorder.snapshot(owner).actions.find((item) => item.actionId === secondId).afterObservationId

  recorder.observation(owner, view([filler(), targetInViewport()], false))
  recorder.bindEscalatedScrollProof(owner, firstId)
  const after = recorder.snapshot(owner)
  assert.ok(after.recordingIssues.length > 0, 'a stale escalation is refused and recorded')
  assert.equal(
    after.actions.find((item) => item.actionId === secondId).afterObservationId,
    secondProofId,
    'the WRONG (later) action is never re-bound',
  )
})
