import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQaTools, QaToolHost } from '../src/tools.ts'
import { QaSessionManager, settleStartOverride } from '../src/session/index.ts'
import { exportRecordedScenario, QaTrajectoryRecorder, RecordingQaDriverAdapter } from '../src/explore/index.ts'
import { runScenario } from '../src/replay/index.ts'

// QA-BL-039 meta.settle round-trip. qa_session_start can widen the settle
// budget for a heavy site; qa_record_export persists the session's EFFECTIVE
// policy into meta.settle; qa_replay_run applies it so replay judges the page
// with the same settle policy Explore used.

const LAUNCH = 'http://127.0.0.1:7421/'

function node(ref, role, name, tag, extra = {}) {
  return { ref, role, name, tag, interactive: role !== 'status', editable: role === 'textbox', disabled: false, ...extra }
}

function fillAdapter() {
  let value = ''
  let result = 'IDLE'
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      return {
        page: { url: LAUNCH, title: 'fixture' },
        nodes: [
          node('input', 'textbox', 'Search articles', 'input', { value }),
          node('status', 'status', result, 'div'),
        ],
        truncated: false,
      }
    },
    async act(_owner, action) {
      if (action.kind === 'fill') { value = action.text; result = 'READY' }
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

function hostWith(adapter) {
  const recorder = new QaTrajectoryRecorder()
  const manager = new QaSessionManager(new RecordingQaDriverAdapter(adapter, recorder))
  const host = new QaToolHost()
  host.managerFor = async () => manager
  host.managerForOwner = async () => manager
  host.exportRecord = (owner, options) => exportRecordedScenario(recorder, owner, options)
  return { host, tools: createQaTools(host) }
}

test('C1: settle_budget_ms 6000 round-trips Explore -> meta.settle -> replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-meta-settle-'))
  const { host, tools } = hostWith(fillAdapter())
  const call = (definition, args) => definition.execute(args, { agent: { id: 'meta-settle-agent' } })
  try {
    const owner = 'meta-settle-explore'
    await call(tools.qaSessionStart, { owner, driver: 'browser', url: LAUNCH, headless: true, settle_budget_ms: 6000 })
    const before = await call(tools.qaObserve, { owner })
    const input = before.nodes.find((item) => item.name === 'Search articles')
    assert.ok(input, 'the fixture must expose the input')
    await call(tools.qaAct, { owner, action: 'fill', ref: input.ref, text: 'v1' })

    const path = join(dir, 'meta-settle.json')
    const exported = await call(tools.qaRecordExport, { owner, output_path: path })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.scenario.meta.settle.budgetMs, 6000, JSON.stringify(exported.scenario.meta))
    assert.equal(exported.scenario.meta.settle.quietMs, 300)

    await call(tools.qaSessionStop, { owner })

    // Replay applies meta.settle over the caller's (env/host) budget.
    const report = await runScenario(exported.scenario, fillAdapter(), {
      ownerId: 'meta-settle-replay',
      settle: { budgetMs: 2500 },
    })
    assert.equal(report.status, 'pass', JSON.stringify(report.failure))
    assert.equal(report.settle.budgetMs, 6000, 'meta.settle wins over the caller budget')
    assert.equal(report.settle.quietMs, 300)
  } finally {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('C3: qa_session_start settle args clamp and widen the budget', async () => {
  // The clamping helper behind qa_session_start (unit): budget <= 15000, the
  // others <= budget, garbage rejected.
  assert.deepEqual(settleStartOverride({ settle_budget_ms: 20000 }), { budgetMs: 15000 })
  assert.deepEqual(settleStartOverride({ settle_quiet_ms: 90000 }), { quietMs: 15000 })
  assert.deepEqual(settleStartOverride({ settle_budget_ms: 6000, settle_quiet_ms: 9000 }), { budgetMs: 6000, quietMs: 6000 })
  assert.equal(settleStartOverride({}), undefined)
  assert.throws(() => settleStartOverride({ settle_budget_ms: -1 }), /positive integers/)
  assert.throws(() => settleStartOverride({ settle_quiet_ms: 1.5 }), /positive integers/)

  // Integration: the tool surface passes the (clamped) budget to the session.
  const { host, tools } = hostWith(fillAdapter())
  const call = (definition, args) => definition.execute(args, { agent: { id: 'meta-settle-clamp' } })
  try {
    await call(tools.qaSessionStart, {
      owner: 'clamp',
      driver: 'browser',
      url: LAUNCH,
      headless: true,
      settle_budget_ms: 20000,
    })
    const observed = await call(tools.qaObserve, { owner: 'clamp' })
    assert.equal(observed.settle.budgetMs, 15000, 'settle_budget_ms clamps to 15000 on the live session')
    await call(tools.qaSessionStop, { owner: 'clamp' })
  } finally {
    await host.dispose()
  }
})
