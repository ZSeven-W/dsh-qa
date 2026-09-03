import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQaTools, QaToolHost } from '../src/tools.ts'
import {
  QaSession,
  QaSessionManager,
  resolveSettlePolicy,
  settleStartOverride,
  QA_SETTLE_ADAPTIVE_BUDGET_MS,
} from '../src/session/index.ts'
import { exportRecordedScenario, QaTrajectoryRecorder, RecordingQaDriverAdapter } from '../src/explore/index.ts'
import { runScenario, validateScenario } from '../src/replay/index.ts'
import { QA_INCONCLUSIVE_UNSTABLE } from '../src/contracts.ts'

// QA-BL-040 (option c): adaptive settle budget. A genuinely slow page is not
// silently accepted, but the session widens its settle budget ONCE (in place)
// from the starting 2500ms to the adaptive 6000ms when a settle window is still
// churning at the budget. Export persists the WIDENED budget into meta.settle so
// replay starts widened; replay also widens once when it has to. Absence
// (node-absent) is still never proven by waiting.

const LAUNCH = 'http://127.0.0.1:7422/'

function node(ref, role, name, tag, extra = {}) {
  return { ref, role, name, tag, interactive: role !== 'status' && role !== 'option', editable: role === 'textbox', disabled: false, ...extra }
}

// A page whose outcome lands at 3500ms after the fill, churning (a ticking
// clock) until then so the 2500ms budget is genuinely exhausted while the view
// is still moving. After 3500ms it holds still and the outcome is present.
function slowOutcomeAdapter() {
  let actedAt = null
  let clickedAt = null
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      const nodes = [node('in', 'textbox', 'Search articles', 'input', { value: actedAt === null ? '' : 'async' })]
      if (clickedAt !== null) {
        // After the click, a stable "opened" view for the next action.
        nodes.push(node('opened', 'status', 'OPENED Async rendering', 'div'))
      } else if (actedAt !== null && Date.now() - actedAt < 3500) {
        nodes.push(node('clock', 'status', 'TICK ' + (Date.now() - actedAt), 'div'))
      } else if (actedAt !== null) {
        nodes.push(node('out', 'option', 'Async rendering', 'li'))
      }
      return { page: { url: LAUNCH, title: 'fixture' }, nodes, truncated: false }
    },
    async act(_owner, action) {
      if (action.kind === 'fill') actedAt = Date.now()
      else if (action.kind === 'click') clickedAt = Date.now()
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

// A page that never stops churning once an action has been dispatched (stable
// before the action, ticking forever after it).
function neverAfterActAdapter() {
  let actedAt = null
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      const nodes = [node('in', 'textbox', 'Release name', 'input', { value: actedAt === null ? '' : 'v1' })]
      if (actedAt !== null) nodes.push(node('clock', 'status', 'TICK ' + (Date.now() - actedAt), 'div'))
      return { page: { url: LAUNCH, title: 'fixture' }, nodes, truncated: false }
    },
    async act() { actedAt = Date.now(); return { status: 'confirmed', dispatched: true } },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

// A page that churns from the very first observation (never settles at all).
function neverSettlingAdapter() {
  let n = 0
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      n += 1
      return {
        page: { url: LAUNCH, title: 'tick-' + n },
        nodes: [node('r1', 'button', 'Save', 'button')],
        truncated: false,
      }
    },
    async act() { return { status: 'confirmed', dispatched: true } },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

function hostWith(adapter, options = {}) {
  const recorder = new QaTrajectoryRecorder()
  const manager = new QaSessionManager(new RecordingQaDriverAdapter(adapter, recorder))
  const host = new QaToolHost({ ...options })
  host.managerFor = async () => manager
  host.managerForOwner = async () => manager
  host.exportRecord = (owner, opts) => exportRecordedScenario(recorder, owner, opts)
  return { host, tools: createQaTools(host) }
}

test('A: an outcome landing at 3500ms widens once, then the session stays widened', async () => {
  const adapter = slowOutcomeAdapter()
  const session = new QaSession(adapter, 'adaptive-a')
  await session.start({ url: LAUNCH })
  const before = await session.observeSettled()
  assert.equal(before.stable, true)
  assert.equal(before.widened, null, 'the pre-action view is stable, so nothing widens yet')
  const input = before.observation.nodes.find((n) => n.name === 'Search articles')
  assert.ok(input)

  const acted = await session.act({ kind: 'fill', ref: input.ref, text: 'async' })
  assert.equal(acted.settle.stable, true, JSON.stringify(acted.settle))
  assert.ok(acted.observation.nodes.some((n) => n.name === 'Async rendering'), 'the outcome must be inside the settled proof observation')
  assert.deepEqual(acted.settle.widened, { fromMs: 2500, toMs: 6000, cause: 'unstable' })
  assert.equal(acted.settle.budgetMs, 6000, 'the widening window ran under the widened budget')
  assert.ok(acted.settle.elapsedMs >= 3500, 'the window must keep polling past the old budget to the outcome (elapsed ' + acted.settle.elapsedMs + 'ms)')
  assert.ok(acted.settle.elapsedMs < 6000, 'but still conclude within the widened budget (elapsed ' + acted.settle.elapsedMs + 'ms)')

  // The NEXT action in the same session reports the widened budget and does NOT widen again.
  const option = acted.observation.nodes.find((n) => n.name === 'Async rendering')
  const clicked = await session.act({ kind: 'click', ref: option.ref })
  assert.equal(clicked.settle.stable, true, JSON.stringify(clicked.settle))
  assert.equal(clicked.settle.budgetMs, 6000, 'every later settle runs at the widened budget')
  assert.equal(clicked.settle.widened, null, 'never widen twice')
  await session.stop()
})

test('B: a never-settling view widens exactly once, then fails at the widened budget', async () => {
  const adapter = neverAfterActAdapter()
  const session = new QaSession(adapter, 'adaptive-b')
  await session.start({ url: LAUNCH })
  await session.observeSettled() // stable pre-action view; does not widen

  const acted = await session.act({ kind: 'fill', ref: 'in', text: 'v1' })
  assert.equal(acted.settle.stable, false, JSON.stringify(acted.settle))
  assert.deepEqual(acted.settle.widened, { fromMs: 2500, toMs: 6000, cause: 'unstable' })
  assert.equal(acted.settle.budgetMs, 6000)
  assert.ok(acted.settle.elapsedMs >= 6000 - 20, 'the window must fail at the WIDENED budget (elapsed ' + acted.settle.elapsedMs + 'ms)')

  const later = await session.act({ kind: 'fill', ref: 'in', text: 'v2' })
  assert.equal(later.settle.stable, false)
  assert.equal(later.settle.widened, null, 'never widen twice')
  assert.equal(later.settle.budgetMs, 6000, 'a later settle stays widened')
  assert.ok(later.settle.elapsedMs >= 6000 - 20, 'elapsed ' + later.settle.elapsedMs + 'ms')
  await session.stop()
})

test('C: disabled adaptation and an explicit budget >= adaptive are no-ops; clamps hold', async () => {
  // C1: adaptive 0 disables widening entirely (old behaviour).
  const adapter1 = neverAfterActAdapter()
  const s1 = new QaSession(adapter1, 'adaptive-c1', { settle: resolveSettlePolicy({ adaptiveBudgetMs: 0 }) })
  await s1.start({ url: LAUNCH })
  await s1.observeSettled()
  const a1 = await s1.act({ kind: 'fill', ref: 'in', text: 'v1' })
  assert.equal(a1.settle.stable, false)
  assert.equal(a1.settle.widened, null)
  assert.equal(a1.settle.budgetMs, 2500, 'the starting budget is kept when adaptation is disabled')
  assert.ok(a1.settle.elapsedMs < 6000, 'no widening: the view fails at the 2500ms budget')
  await s1.stop()

  // C2: explicit budget 8000 >= adaptive → nothing to widen (budget stays 8000).
  const adapter2 = neverAfterActAdapter()
  const s2 = new QaSession(adapter2, 'adaptive-c2', { settle: { budgetMs: 8000 } })
  await s2.start({ url: LAUNCH })
  await s2.observeSettled()
  const a2 = await s2.act({ kind: 'fill', ref: 'in', text: 'v1' })
  assert.equal(a2.settle.stable, false)
  assert.equal(a2.settle.widened, null, 'explicit budget >= adaptive means nothing to widen')
  assert.equal(a2.settle.budgetMs, 8000)
  await s2.stop()

  // C3: clamping on both surfaces.
  assert.deepEqual(settleStartOverride({ settle_adaptive_budget_ms: 20000 }), { adaptiveBudgetMs: 15000 })
  assert.deepEqual(settleStartOverride({ settle_adaptive_budget_ms: 0 }), { adaptiveBudgetMs: 0 })
  assert.throws(() => settleStartOverride({ settle_adaptive_budget_ms: -1 }), /non-negative integer/)
  assert.throws(() => settleStartOverride({ settle_adaptive_budget_ms: 1.5 }), /non-negative integer/)
  assert.equal(resolveSettlePolicy({ adaptiveBudgetMs: 20000 }).adaptiveBudgetMs, 15000, 'adaptive clamps to the schema maximum')
  assert.equal(resolveSettlePolicy({ adaptiveBudgetMs: 800 }).adaptiveBudgetMs, 2500, 'adaptive below the budget clamps up to the budget')
  assert.equal(resolveSettlePolicy().adaptiveBudgetMs, QA_SETTLE_ADAPTIVE_BUDGET_MS)
})

test('D: export persists the widened budget; replay starts widened and also widens once when it must', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-settle-adaptive-'))
  try {
    // D1: an Explore session that widened exports meta.settle.budgetMs = 6000.
    const recorder = new QaTrajectoryRecorder()
    const session = new QaSession(new RecordingQaDriverAdapter(slowOutcomeAdapter(), recorder), 'adaptive-d1-explore')
    await session.start({ url: LAUNCH })
    const before = await session.observeSettled()
    const input = before.observation.nodes.find((n) => n.name === 'Search articles')
    assert.ok(input)
    const acted = await session.act({ kind: 'fill', ref: input.ref, text: 'async' })
    assert.deepEqual(acted.settle.widened, { fromMs: 2500, toMs: 6000, cause: 'unstable' })
    await session.stop()
    const path = join(dir, 'd1.json')
    const exported = await exportRecordedScenario(recorder, 'adaptive-d1-explore', { outputPath: path })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.scenario.meta.settle.budgetMs, 6000, JSON.stringify(exported.scenario.meta.settle))

    // Replay starts at the widened budget and does not rediscover it.
    const report = await runScenario(exported.scenario, slowOutcomeAdapter(), {
      ownerId: 'adaptive-d1-replay',
      settle: { budgetMs: 2500 },
    })
    assert.equal(report.status, 'pass', JSON.stringify(report.failure))
    assert.equal(report.settle.budgetMs, 6000, 'meta.settle wins over the caller budget and starts widened')
    assert.equal(report.settleWidened, undefined, 'replay does not rediscover the widening')

    // D2: a scenario WITHOUT meta.settle replayed against the slow fixture widens once.
    const handWritten = validateScenario({
      meta: {
        name: 'slow-no-meta-settle',
        description: 'hand-written: the outcome lands at 3500ms',
        driver: 'browser',
        createdAt: new Date().toISOString(),
      },
      target: { launch: LAUNCH },
      steps: [{
        index: 1,
        intent: 'Fill "Search articles".',
        action: { kind: 'fill', target: { role: 'textbox', name: 'Search articles' }, text: 'async' },
        assert: { kind: 'node-present', expected: { role: 'option', name: 'Async rendering' } },
      }],
      assertions: [],
    })
    const slowReport = await runScenario(handWritten, slowOutcomeAdapter(), { ownerId: 'adaptive-d2-replay' })
    assert.equal(slowReport.status, 'pass', JSON.stringify(slowReport.failure))
    assert.equal(slowReport.settle.budgetMs, 6000, 'replay ends at the widened budget')
    assert.deepEqual(slowReport.settleWidened, { fromMs: 2500, toMs: 6000, at: 1, cause: 'unstable' }, 'replay records the widening at the step that hit it')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('E: node-absent on an unstable view is still inconclusive, never rescued by widening', async () => {
  const { host, tools } = hostWith(neverSettlingAdapter())
  const call = (definition, args) => definition.execute(args, { agent: { id: 'adaptive-e-agent' } })
  try {
    await call(tools.qaSessionStart, { owner: 'adaptive-e', driver: 'browser', url: LAUNCH, headless: true })
    const result = await call(tools.qaAssert, { owner: 'adaptive-e', kind: 'node-absent', expected: { role: 'status', name: 'READY' } })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.passed, false, 'absence is never proven from a churning view')
    assert.equal(result.inconclusive, true, JSON.stringify(result))
    assert.equal(result.code, QA_INCONCLUSIVE_UNSTABLE, JSON.stringify(result))
    assert.equal(result.observed, null)
    assert.equal(result.settle.stable, false, 'the view is still unprovable after widening')
    assert.deepEqual(result.settle.widened, { fromMs: 2500, toMs: 6000, cause: 'unstable' }, 'the settle widened but the absence is still not proven')
  } finally {
    await host.dispose()
  }
})
