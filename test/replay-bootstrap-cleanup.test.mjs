import test from 'node:test'
import assert from 'node:assert/strict'
import { runScenario } from '../src/replay/index.ts'
import { QaSession } from '../src/session/index.ts'

const SCENARIO = {
  meta: { name: 'replay bootstrap', description: 'd', driver: 'browser', createdAt: '2026-09-09T00:00:00.000Z' },
  target: { launch: 'http://127.0.0.1:7411/' },
  steps: [],
  assertions: [],
}
const IOS_SCENARIO = {
  meta: { name: 'iOS replay bootstrap', description: 'd', driver: 'ios', createdAt: '2026-09-09T00:00:00.000Z' },
  target: { launch: 'dev.zseven.qa.fixture.ios', deviceId: 'SIM-UDID-EXACT' },
  steps: [],
  assertions: [],
}
const OBSERVATION = {
  page: { url: 'http://127.0.0.1:7411/', title: 'fixture' },
  nodes: [{ ref: 'status', role: 'status', name: 'READY', tag: 'div', interactive: false, editable: false, disabled: false }],
  truncated: false,
}

function adapter(options = {}) {
  const calls = []
  return {
    kind: 'browser',
    calls,
    async start() { calls.push('start'); return { page: OBSERVATION.page, headless: true } },
    async observe() { calls.push('observe'); return OBSERVATION },
    async evidence() { calls.push('evidence'); return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { calls.push('stop'); if (options.stopError !== undefined) throw options.stopError; return { stopped: true, reason: 'requested' } },
  }
}

test('browser replay does not use the iOS raw bootstrap', async (t) => {
  let rawReads = 0
  const original = QaSession.prototype.observe
  t.mock.method(QaSession.prototype, 'observe', async function (...args) { rawReads += 1; return original.apply(this, args) })
  const driver = adapter()
  const report = await runScenario(SCENARIO, driver, { settle: { budgetMs: 120, quietMs: 10, intervalMs: 2 } })
  assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? report))
  assert.equal(driver.calls[0], 'start')
  assert.ok(driver.calls.filter(call => call === 'observe').length > 1, 'browser keeps its settle/final reads')
  assert.equal(rawReads, 0)
  assert.equal(report.steps.length, 0)
})

function iosAdapter({ firstDelayMs = 0, changing = false, observeError, stopError } = {}) {
  const calls = []
  let reads = 0
  return {
    kind: 'ios',
    calls,
    async start(_owner, options) { calls.push(['start', options]); return { device: options.deviceId, bundleId: options.bundleId } },
    async observe() {
      reads += 1; calls.push(['observe', reads])
      if (reads === 1 && firstDelayMs > 0) await new Promise(resolve => setTimeout(resolve, firstDelayMs))
      if (reads === 1 && observeError !== undefined) throw observeError
      return { ...OBSERVATION, nodes: changing ? [{ ...OBSERVATION.nodes[0], name: 'READY-' + reads }] : OBSERVATION.nodes }
    },
    async evidence() { calls.push(['evidence']); return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { calls.push(['stop']); if (stopError !== undefined) throw stopError; return { stopped: true, reason: 'requested' } },
  }
}

test('iOS replay spends cold bootstrap outside settle budget and then passes', async (t) => {
  let rawReads = 0
  const original = QaSession.prototype.observe
  t.mock.method(QaSession.prototype, 'observe', async function (...args) { rawReads += 1; return original.apply(this, args) })
  const browser = adapter()
  const policy = { budgetMs: 200, quietMs: 10, intervalMs: 2, adaptiveBudgetMs: 200 }
  await runScenario(SCENARIO, browser, { settle: policy })
  assert.equal(rawReads, 0)
  const firstReadDelayMs = 350
  assert.ok(firstReadDelayMs > policy.budgetMs)
  const driver = iosAdapter({ firstDelayMs: firstReadDelayMs })
  const report = await runScenario(IOS_SCENARIO, driver, { settle: policy })
  assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? report))
  assert.equal(report.settleWidened, undefined, 'cold bootstrap must not consume/adapt the proof budget')
  assert.deepEqual(driver.calls[0], ['start', { bundleId: IOS_SCENARIO.target.launch, deviceId: IOS_SCENARIO.target.deviceId }])
  assert.equal(rawReads, 1, 'iOS performs exactly one raw bootstrap independently of variable settle polling')
})

test('iOS identity churn during settled reads stays inconclusive/fail-closed', async () => {
  const driver = iosAdapter({ changing: true })
  const report = await runScenario(IOS_SCENARIO, driver, { settle: { budgetMs: 100, quietMs: 10, intervalMs: 2, adaptiveBudgetMs: 100 } })
  assert.notEqual(report.status, 'pass')
  assert.equal(report.failure?.code, 'INCONCLUSIVE_UNSTABLE')
})

test('raw iOS bootstrap failure and cleanup failure are both retained', async () => {
  const driver = iosAdapter({ observeError: new Error('AX bootstrap failed'), stopError: new Error('BUSY cleanup') })
  const report = await runScenario(IOS_SCENARIO, driver, { settle: { budgetMs: 20, quietMs: 5, intervalMs: 2, adaptiveBudgetMs: 20 } })
  assert.equal(report.status, 'fail')
  assert.match(report.failure?.message ?? '', /AX bootstrap failed/)
  assert.match(report.failure?.message ?? '', /session cleanup failed: BUSY cleanup/)
  assert.equal(driver.calls.filter(call => call[0] === 'stop').length, 1)
})

test('cleanup failure is retained and cannot produce PASS', async () => {
  const driver = adapter({ stopError: Object.assign(new Error('BUSY cleanup'), { code: 'BUSY' }) })
  const report = await runScenario(SCENARIO, driver, { settle: { budgetMs: 120, quietMs: 10, intervalMs: 2 } })
  assert.equal(report.status, 'fail')
  assert.match(report.failure?.message ?? '', /session cleanup failed: BUSY cleanup/)
  assert.equal(driver.calls.filter(call => call === 'stop').length, 1)
})
