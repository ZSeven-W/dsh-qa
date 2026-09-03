import test from 'node:test'
import assert from 'node:assert/strict'
import { decideAssertionWithRetry, runScenario } from '../src/replay/index.ts'

// QA-BL-039 bounded-retry regression. A positive-existence assertion
// (node-present / node-value / node-in-viewport / page-url) whose first settled
// decision is "not found" must be re-observed within the settle budget instead
// of concluding immediately: the node may simply not have rendered yet. The
// retry is sound (a found node is sound on any view) and BOUNDED (the settle
// budget), and node-absent is never retried into a pass.

const LAUNCH = 'http://127.0.0.1:7421/'
const SETTLE = { budgetMs: 1500, quietMs: 40, postChangeQuietMs: 80, intervalMs: 10 }

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

// A click shows an immediate "Working" status (so the post-action settle
// concludes early), then reveals the asserted node appearAfterMs later — or
// never, when neverAppear.
function lateAppearAdapter({ appearAfterMs = 800, neverAppear = false } = {}) {
  let clickedAt = null
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      const since = clickedAt === null ? null : Date.now() - clickedAt
      const nodes = [node('btn', 'button', 'Go', 'button')]
      if (clickedAt !== null) {
        nodes.push(node('working', 'status', 'Working', 'div'))
        const appeared = since !== null && since >= appearAfterMs && !neverAppear
        if (appeared) {
          nodes.push(node('done', 'status', 'Done', 'div'))
          nodes.push(node('result', 'textbox', 'Result', 'input', { value: 'READY' }))
        }
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

function scenario(assertion) {
  return {
    meta: { name: 'bounded-retry', description: 'd', driver: 'browser', createdAt: '2026-01-01T00:00:00.000Z' },
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

test('B1: node-present appearing late passes with attempts >= 2 recorded', async () => {
  const report = await runScenario(
    scenario({ kind: 'node-present', expected: { role: 'status', name: 'Done' } }),
    lateAppearAdapter(),
    { ownerId: 'retry-present', settle: SETTLE },
  )
  assert.equal(report.status, 'pass', JSON.stringify(report.failure))
  assert.ok(report.steps[0].attempts >= 2, 'retry accounting recorded, got ' + report.steps[0].attempts)
  assert.ok(report.steps[0].elapsedMs > 0)
})

test('B2: node-value appearing late passes with attempts >= 2 recorded', async () => {
  const report = await runScenario(
    scenario({ kind: 'node-value', expected: { role: 'textbox', name: 'Result', value: 'READY' } }),
    lateAppearAdapter(),
    { ownerId: 'retry-value', settle: SETTLE },
  )
  assert.equal(report.status, 'pass', JSON.stringify(report.failure))
  assert.ok(report.steps[0].attempts >= 2, 'retry accounting recorded, got ' + report.steps[0].attempts)
})

test('B3: node-absent is never retried into a pass', async () => {
  let reobservations = 0
  const observation = {
    page: { url: LAUNCH, title: 'fixture' },
    nodes: [node('s', 'status', 'Working', 'div')],
    truncated: false,
  }
  const reobserve = async () => {
    reobservations += 1
    // If re-observed, the node would be gone and node-absent could pass — but it
    // must never be re-observed.
    return { page: { url: LAUNCH, title: 'fixture' }, nodes: [], truncated: false }
  }
  const decision = await decideAssertionWithRetry(
    { kind: 'node-absent', expected: { role: 'status', name: 'Working' } },
    observation,
    reobserve,
    1500,
  )
  assert.equal(decision.passed, false, 'node-absent with the node present must fail')
  assert.equal(decision.attempts, 1, 'node-absent must never be retried')
  assert.equal(reobservations, 0, 'node-absent must never trigger a re-observation')
})

test('B4: a node that never appears keeps the existing failure outcome with attempts recorded', async () => {
  const report = await runScenario(
    scenario({ kind: 'node-present', expected: { role: 'status', name: 'Done' } }),
    lateAppearAdapter({ neverAppear: true }),
    { ownerId: 'retry-never', settle: SETTLE },
  )
  assert.equal(report.status, 'fail')
  assert.equal(report.steps[0].status, 'fail')
  assert.ok(report.steps[0].attempts >= 2, 'the exhausted retry is recorded, got ' + report.steps[0].attempts)
  assert.ok(report.failure.message.includes('assertion node-present failed'), JSON.stringify(report.failure))
})
