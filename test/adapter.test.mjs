import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserAdapter } from '../src/adapters/index.ts'

function fakeDriver() {
  const calls = []
  const page = { url: 'about:blank', title: '' }
  const driver = {
    kind: 'browser',
    contractVersion: 1,
    async start(ownerId, options) {
      calls.push(['start', ownerId, options])
      return {
        ownerId, state: 'running', headless: options?.headless !== false,
        browser: { channel: 'chrome', version: 'fixture' }, page,
        isolation: 'ephemeral-user-data',
        navigationPolicy: { mode: 'unrestricted', allowedOrigins: [] },
      }
    },
    async observe(ownerId, options) {
      calls.push(['observe', ownerId, options])
      return {
        ownerId, epoch: 1, fingerprint: 'fp', expiresAt: 'x',
        page: { url: 'about:blank', title: '', viewport: { width: 1, height: 1 } },
        nodes: [{ ref: 'br_1', role: 'button', name: 'Publish release', tag: 'button', interactive: true, editable: false, disabled: false }],
        truncated: false, limits: { maxNodes: 60, maxBytes: 1 },
      }
    },
    async act(ownerId, action) {
      calls.push(['act', ownerId, action])
      return {
        receiptId: 'r', ownerId, action: action.kind, status: 'rejected',
        startedAt: 'a', completedAt: 'b', dispatched: false,
        pageBefore: page, pageAfter: page,
        code: 'EXTERNAL_COMMIT_TARGET', reason: 'publish semantics',
      }
    },
    async evidence(ownerId, options) {
      calls.push(['evidence', ownerId, options])
      return {
        ownerId, page, console: [], network: [], bounded: true,
        limits: { console: 1, network: 1 }, dropped: { console: 0, network: 0 },
      }
    },
    async stop(ownerId) {
      calls.push(['stop', ownerId])
      return { ownerId, stopped: true, reason: 'requested' }
    },
    async disposeScope() { calls.push(['disposeScope']) },
    async dispose() { calls.push(['dispose']) },
  }
  return { driver, calls }
}

test('BrowserAdapter maps driver results and never retries a risk rejection', async () => {
  const { driver, calls } = fakeDriver()
  const adapter = new BrowserAdapter(driver)
  assert.equal(adapter.kind, 'browser')

  const info = await adapter.start('a', { url: 'http://127.0.0.1:1', headless: true })
  assert.deepEqual(info.page, { url: 'about:blank', title: '' })
  assert.equal(info.headless, true)

  const obs = await adapter.observe('a', { maxNodes: 5 })
  assert.equal(obs.nodes[0].name, 'Publish release')

  const receipt = await adapter.act('a', { kind: 'click', ref: 'br_1' })
  assert.equal(receipt.status, 'rejected')
  assert.equal(receipt.code, 'EXTERNAL_COMMIT_TARGET')
  assert.equal(receipt.dispatched, false)
  // Exactly one act call — the adapter never retries around a rejection.
  assert.equal(calls.filter((c) => c[0] === 'act').length, 1)

  const evidence = await adapter.evidence('a', { maxConsole: 3, maxNetwork: 3 })
  assert.equal(evidence.bounded, true)

  const stop = await adapter.stop('a')
  assert.equal(stop.stopped, true)

  await adapter.dispose()
  assert.ok(calls.some((c) => c[0] === 'dispose'))
})
