import test from 'node:test'
import assert from 'node:assert/strict'
import { QaSession, QaSessionManager } from '../src/session/index.ts'

// This fake page never changes, so a PROOF observation legitimately spends its
// whole budget waiting for an outcome that never comes. These tests are about
// the receipt contract, not the production budget: keep the window small.
const FAST_SETTLE = { settle: { budgetMs: 60, quietMs: 10, intervalMs: 2 } }

function fakeAdapter(events) {
  const adapter = {
    kind: 'browser',
    actResult: { status: 'confirmed', dispatched: true },
    async start(ownerId, options) {
      events.push(['start', ownerId])
      return { page: { url: 'about:blank', title: '' }, headless: options?.headless !== false }
    },
    async observe(ownerId) {
      events.push(['observe', ownerId])
      return { page: { url: 'about:blank', title: '' }, nodes: [], truncated: false }
    },
    async act(ownerId, action) {
      events.push(['act', ownerId, action.kind])
      return { ...adapter.actResult }
    },
    async evidence(ownerId) {
      events.push(['evidence', ownerId])
      return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } }
    },
    async stop(ownerId) {
      events.push(['stop', ownerId])
      return { stopped: true, reason: 'requested' }
    },
    async dispose() {
      events.push(['dispose'])
    },
  }
  return adapter
}

test('an unknown receipt is never treated as success and forces a fresh re-observation', async () => {
  const events = []
  const adapter = fakeAdapter(events)
  adapter.actResult = { status: 'unknown', dispatched: true, code: 'DISPATCH_OUTCOME_UNKNOWN', reason: 'page outcome unknown' }
  const session = new QaSession(adapter, 'a', FAST_SETTLE)
  await session.start()
  const result = await session.act({ kind: 'click', ref: 'opaque' })
  assert.equal(result.outcome, 'unknown')
  assert.notEqual(result.outcome, 'ok')
  assert.equal(result.receipt.status, 'unknown')
  assert.ok(result.observation, 'a fresh observation must be captured to decide the outcome')
  // The proof observation is SETTLED: at least two observations are needed
  // before any view can be called stable (see src/session/settle.ts).
  assert.ok(events.filter((e) => e[0] === 'observe').length >= 2)
  assert.equal(result.settle.stable, true)
  assert.ok(result.settle.passes >= 2, 'a settled view needs consecutive agreeing observations')
})

test('a rejected receipt propagates as a step failure with the receipt attached as evidence', async () => {
  const events = []
  const adapter = fakeAdapter(events)
  adapter.actResult = { status: 'rejected', dispatched: false, code: 'EXTERNAL_COMMIT_TARGET', reason: 'target semantics indicate sending or publishing externally' }
  const session = new QaSession(adapter, 'a', FAST_SETTLE)
  await session.start()
  const result = await session.act({ kind: 'click', ref: 'opaque' })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.receipt.code, 'EXTERNAL_COMMIT_TARGET')
  assert.deepEqual(result.evidence, [result.receipt])
  assert.equal(result.observation, null)
  assert.equal(result.settle, null, 'a rejected receipt has no settle window')
  assert.equal(events.filter((e) => e[0] === 'observe').length, 0, 'rejected receipts do not re-observe')
})

test('a failed receipt propagates as a step failure', async () => {
  const events = []
  const adapter = fakeAdapter(events)
  adapter.actResult = { status: 'failed', dispatched: false, code: 'SESSION_NOT_RUNNING' }
  const session = new QaSession(adapter, 'a', FAST_SETTLE)
  await session.start()
  const result = await session.act({ kind: 'fill', ref: 'opaque', text: 'x' })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.receipt.status, 'failed')
  assert.deepEqual(result.evidence, [result.receipt])
})

test('a confirmed receipt re-observes and resolves ok', async () => {
  const events = []
  const adapter = fakeAdapter(events)
  const session = new QaSession(adapter, 'a', FAST_SETTLE)
  await session.start()
  const result = await session.act({ kind: 'click', ref: 'opaque' })
  assert.equal(result.outcome, 'ok')
  assert.ok(result.observation)
  assert.equal(result.settle.stable, true)
  assert.ok(events.filter((e) => e[0] === 'observe').length >= 2, 'the proof observation is settled, not single-shot')
})

test('run() cleans up (stop) even when a step throws', async () => {
  const events = []
  const adapter = fakeAdapter(events)
  adapter.act = async () => { throw new Error('boom') }
  const session = new QaSession(adapter, 'a', FAST_SETTLE)
  await session.start()
  await assert.rejects(session.run(async (s) => { await s.act({ kind: 'click', ref: 'x' }) }), /boom/)
  assert.ok(events.some((e) => e[0] === 'stop'), 'stop must run in finally')
})

test('stop() is idempotent and the manager removes stopped sessions', async () => {
  const events = []
  const adapter = fakeAdapter(events)
  const session = new QaSession(adapter, 'a', FAST_SETTLE)
  await session.start()
  const first = await session.stop()
  const second = await session.stop()
  assert.equal(first.stopped, true)
  assert.equal(second.stopped, true)
  assert.equal(events.filter((e) => e[0] === 'stop').length, 1, 'adapter.stop called exactly once')
})

test('QaSessionManager shares one adapter across owners, stops, and disposes', async () => {
  const events = []
  const adapter = fakeAdapter(events)
  const manager = new QaSessionManager(adapter, FAST_SETTLE)
  const a = manager.session('a')
  assert.equal(manager.session('a'), a, 'same owner returns the same session')
  assert.notEqual(manager.session('b'), a)
  await a.start()
  await manager.stop('a')
  assert.equal(a.stopped, true)
  assert.notEqual(manager.session('a'), a, 'a stopped session is removed from the manager')
  const nothing = await manager.stop('unseen-owner')
  assert.deepEqual(nothing, { stopped: false, reason: 'not-running' })
  await manager.dispose()
  assert.ok(events.some((e) => e[0] === 'dispose'))
})