import test from 'node:test'
import assert from 'node:assert/strict'
import { QaSession, resolveSettlePolicy } from '../src/session/index.ts'
import { decideAssertionWithRetry, runScenario, sessionReobserve } from '../src/replay/index.ts'
import { QA_COVERAGE_UNVERIFIED } from '../src/contracts.ts'

// QA-BL-041: adaptive widening from the assertion-retry path. The 4ea9035
// widening only fired when a settle window ended UNSTABLE; when the page
// settled FAST but the asserted node simply had not loaded yet, the bounded
// retry got only budgetMs and the session never widened, so replay ended
// INCONCLUSIVE_TRUNCATED / not-found even though a widened budget would have
// found the node. Now decideAssertionWithRetry widens ONCE through the SAME
// once-per-session gate as the unstable path (a session widens at most once,
// whichever path gets there first) and keeps retrying until adaptiveBudgetMs
// measured from the retry's original start.

const LAUNCH = 'http://127.0.0.1:7423/'

function node(ref, role, name, tag, extra = {}) {
  return {
    ref,
    role,
    name,
    tag,
    interactive: role !== 'status',
    editable: role === 'textbox',
    disabled: false,
    ...extra,
  }
}

// A page that settles FAST (the view is stable immediately, so the post-action
// settle concludes at ~quiet) but whose asserted node only appears appearAfterMs
// after the first observation — or never, when neverAppear. This is the gap:
// nothing is unstable, the node just has not rendered yet.
function fastSettleLateAppearAdapter({ appearAfterMs = 4000, neverAppear = false } = {}) {
  let firstObserveAt = null
  let clickedAt = null
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      if (firstObserveAt === null) firstObserveAt = Date.now()
      const since = Date.now() - firstObserveAt
      const nodes = [node('go', 'button', 'Go', 'button')]
      if (clickedAt !== null) nodes.push(node('working', 'status', 'Working', 'div'))
      const appeared = since >= appearAfterMs && !neverAppear
      if (appeared) {
        nodes.push(node('done', 'status', 'Done', 'div'))
        nodes.push(node('result', 'textbox', 'Result', 'input', { value: 'READY' }))
      }
      return { page: { url: LAUNCH, title: 'fixture' }, nodes, truncated: false }
    },
    async act() {
      clickedAt = Date.now()
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

// A page that is stable until the first act, then churns forever (ticking clock).
// Used for the shared-gate test: the unstable settle path and the assertion-retry
// path must share ONE widening, whichever fires first.
function stableThenUnstableAdapter() {
  let churn = false
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      const nodes = [node('save', 'button', 'Save', 'button')]
      if (churn) nodes.push(node('clock', 'status', 'TICK ' + Date.now(), 'div'))
      return { page: { url: LAUNCH, title: 'fixture' }, nodes, truncated: false }
    },
    async act() {
      churn = true
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

function scenario(assertion) {
  return {
    meta: { name: 'settle-adaptive-retry', description: 'd', driver: 'browser', createdAt: '2026-01-01T00:00:00.000Z' },
    target: { launch: LAUNCH },
    steps: [{
      index: 1,
      intent: 'Click "Go".',
      action: { kind: 'click', target: { role: 'button', name: 'Go' } },
      assert: assertion,
    }],
    assertions: [],
  }
}

test('A: a fast-settling view whose node lands at 4000ms widens once through the retry and passes', async () => {
  const adapter = fastSettleLateAppearAdapter({ appearAfterMs: 4000 })
  const session = new QaSession(adapter, 'retry-a', { settle: resolveSettlePolicy({ adaptiveBudgetMs: 6000, postChangeQuietMs: 300 }) })
  await session.start({ url: LAUNCH })
  const first = await session.observe()
  assert.equal(first.nodes.some((n) => n.name === 'Done'), false, 'the node has not landed yet')
  const decision = await decideAssertionWithRetry(
    { kind: 'node-present', expected: { role: 'status', name: 'Done' } },
    first,
    sessionReobserve(session),
    session,
  )
  assert.equal(decision.passed, true, JSON.stringify(decision))
  assert.deepEqual(decision.widened, { fromMs: 2500, toMs: 6000, cause: 'assertion-retry' })
  assert.ok(decision.attempts >= 2, 'retry accounting recorded, attempts ' + decision.attempts)
  assert.ok(decision.elapsedMs >= 4000 && decision.elapsedMs < 6000, 'elapsed ' + decision.elapsedMs + 'ms')
  // The NEXT action in the same session reports the widened budget and does NOT widen again.
  const acted = await session.act({ kind: 'click', ref: 'go' })
  assert.equal(acted.settle.budgetMs, 6000, 'every later settle runs at the widened budget')
  assert.equal(acted.settle.widened, null, 'never widen twice')
  await session.stop()
})

test('B: a node that never appears widens exactly once, then fails at the widened budget', async () => {
  const report = await runScenario(
    scenario({ kind: 'node-present', expected: { role: 'status', name: 'Done' } }),
    fastSettleLateAppearAdapter({ neverAppear: true }),
    { ownerId: 'retry-b', settle: resolveSettlePolicy({ adaptiveBudgetMs: 6000, postChangeQuietMs: 300 }) },
  )
  assert.equal(report.status, 'fail', JSON.stringify(report.failure))
  assert.deepEqual(
    report.settleWidened,
    { fromMs: 2500, toMs: 6000, at: 1, cause: 'assertion-retry' },
    'exactly one widening record, on the step that hit it',
  )
  assert.equal(report.settle.budgetMs, 6000, 'the report prints the widened effective budget')
  assert.ok(report.steps[0].attempts >= 2, 'attempts ' + report.steps[0].attempts)
  assert.ok(report.steps[0].elapsedMs >= 6000 - 50 && report.steps[0].elapsedMs < 6000 + 1000, 'elapsed ' + report.steps[0].elapsedMs + 'ms')
})

async function sharedGateUnstableFirst() {
  // C1: the UNSTABLE settle path widens first; the retry path must refuse.
  const s1 = new QaSession(stableThenUnstableAdapter(), 'shared-c1', { settle: resolveSettlePolicy({ adaptiveBudgetMs: 3000 }) })
  await s1.start({ url: LAUNCH })
  await s1.observeSettled() // stable pre-action view
  const acted = await s1.act({ kind: 'click', ref: 'save' }) // churns -> unstable widen
  assert.equal(acted.settle.stable, false, JSON.stringify(acted.settle))
  assert.deepEqual(acted.settle.widened, { fromMs: 2500, toMs: 3000, cause: 'unstable' })
  // decideAssertionWithRetry widens through this SAME gate: it must refuse.
  assert.equal(s1.widenForRetry(), null, 'the retry path shares the unstable path gate')
  await s1.stop()
}

async function sharedGateRetryFirst() {
  // C2: the assertion-RETRY path widens first; the unstable path must refuse.
  const s2 = new QaSession(stableThenUnstableAdapter(), 'shared-c2', { settle: resolveSettlePolicy({ adaptiveBudgetMs: 3000 }) })
  await s2.start({ url: LAUNCH })
  const retry2 = await decideAssertionWithRetry(
    { kind: 'node-present', expected: { role: 'status', name: 'Never' } },
    await s2.observe(),
    sessionReobserve(s2),
    s2,
  )
  assert.equal(retry2.passed, false)
  assert.deepEqual(retry2.widened, { fromMs: 2500, toMs: 3000, cause: 'assertion-retry' })
  // observeUntilStable widens through this SAME gate: it must refuse.
  assert.equal(s2.widenForRetry(), null, 'the unstable path shares the retry path gate')
  await s2.stop()
}

test('C: the assertion-retry path and the unstable path share ONE widening gate', async () => {
  // A smaller adaptive budget (3000ms) keeps this gate-sharing test fast; the
  // once-per-session rule it proves is independent of the budget values. The
  // two directions are independent sessions, so they run concurrently.
  await Promise.all([sharedGateUnstableFirst(), sharedGateRetryFirst()])
})

test('D: node-absent on a fast-settling view is never widened or retried into a wait', async () => {
  const report = await runScenario(
    scenario({ kind: 'node-absent', expected: { role: 'status', name: 'Done' } }),
    fastSettleLateAppearAdapter({ appearAfterMs: 4000 }),
    { ownerId: 'retry-d', settle: resolveSettlePolicy({ adaptiveBudgetMs: 6000 }) },
  )
  // CHANGED (QA-BL-052 / Codex Q4): the node is genuinely absent from a
  // complete fast-settling view, but the observation's boundaries are
  // UNVERIFIED, so the absence is UNPROVEN — the run fails closed with
  // QA_COVERAGE_UNVERIFIED. It still must NOT wait for the 4000ms
  // appearance (which would turn absence into a waiting game) nor widen,
  // and the retry accounting must stay absent.
  assert.equal(report.status, 'fail', JSON.stringify(report.failure))
  assert.equal(report.steps[0].assertionPassed, false)
  assert.equal(report.steps[0].completeness?.reason, QA_COVERAGE_UNVERIFIED)
  assert.match(report.steps[0].completeness?.detail ?? '', /closed shadow roots, slot assignment/)
  assert.equal(report.settle.budgetMs, 2500, 'the budget is never widened by node-absent')
  assert.equal(report.settleWidened, undefined, 'node-absent never widens')
  assert.equal(report.steps[0].attempts, undefined, 'node-absent is never retried')
})

test('E: adaptiveBudgetMs 0 disables the retry-path widening (old behaviour)', async () => {
  const session = new QaSession(fastSettleLateAppearAdapter({ appearAfterMs: 4000 }), 'retry-e', {
    settle: resolveSettlePolicy({ adaptiveBudgetMs: 0 }),
  })
  await session.start({ url: LAUNCH })
  const decision = await decideAssertionWithRetry(
    { kind: 'node-present', expected: { role: 'status', name: 'Done' } },
    await session.observe(),
    sessionReobserve(session),
    session,
  )
  assert.equal(decision.passed, false, 'the node lands at 4000ms, after the 2500ms budget')
  assert.equal(decision.widened, null, 'no widening when adaptation is disabled')
  assert.ok(decision.elapsedMs >= 2500 - 20 && decision.elapsedMs < 4000, 'stops at the original budget (elapsed ' + decision.elapsedMs + 'ms)')
  await session.stop()
})
