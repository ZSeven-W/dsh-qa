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
  assert.equal(obs.maxNodes, 60, 'the budget the driver APPLIED travels through, never the requested 5')
  assert.equal(obs.truncationReasons, undefined, 'an unreported reason list is never invented')

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

test('BrowserAdapter carries the APPLIED budget and the driver-named truncation reasons', async () => {
  const driver = {
    kind: 'browser',
    contractVersion: 7,
    async start() { return { ownerId: 'a', state: 'running', headless: true, browser: { channel: 'chrome', version: 'fixture' }, page: { url: 'about:blank', title: '' }, isolation: 'ephemeral-user-data', navigationPolicy: { mode: 'unrestricted', allowedOrigins: [] } } },
    async observe() {
      return {
        ownerId: 'a', epoch: 1, fingerprint: 'fp', expiresAt: 'x',
        page: { url: 'about:blank', title: '', viewport: { width: 1, height: 1 } },
        nodes: [{ ref: 'br_1', role: 'button', name: 'Publish release', tag: 'button', interactive: true, editable: false, disabled: false }],
        truncated: true,
        truncationReasons: ['node-budget-exceeded', 'iframe-not-traversed'],
        limits: { maxNodes: 100, maxBytes: 4096 },
      }
    },
    async act() { throw new Error('not exercised') },
    async evidence() { return { ownerId: 'a', page: { url: 'about:blank', title: '' }, console: [], network: [], bounded: true, limits: { console: 1, network: 1 }, dropped: { console: 0, network: 0 } } },
    async stop() { return { ownerId: 'a', stopped: true, reason: 'requested' } },
    async dispose() {},
  }
  const adapter = new BrowserAdapter(driver)
  const obs = await adapter.observe('a', { maxNodes: 500 })
  assert.equal(obs.truncated, true)
  assert.equal(obs.maxNodes, 100, 'the budget the driver APPLIED travels through, never the requested 500')
  assert.deepEqual(obs.truncationReasons, ['node-budget-exceeded', 'iframe-not-traversed'], 'every driver-named reason is carried verbatim')
})

test('BrowserAdapter passes scroll/select/hover through and rejects computer verbs', async () => {
  const calls = []
  const page = { url: 'about:blank', title: '' }
  const driver = {
    kind: 'browser',
    contractVersion: 3,
    async start(ownerId, options) {
      return {
        ownerId, state: 'running', headless: options?.headless !== false,
        browser: { channel: 'chrome', version: 'fixture' }, page,
        isolation: 'ephemeral-user-data',
        navigationPolicy: { mode: 'unrestricted', allowedOrigins: [] },
      }
    },
    async observe() {
      return {
        ownerId: 'a', epoch: 1, fingerprint: 'fp', expiresAt: 'x',
        page: { url: 'about:blank', title: '', viewport: { width: 1, height: 1 } },
        nodes: [], truncated: false, limits: { maxNodes: 60, maxBytes: 1 },
      }
    },
    async act(ownerId, action) {
      calls.push(action)
      return {
        receiptId: 'r', ownerId, action: action.kind, status: 'confirmed',
        startedAt: 'a', completedAt: 'b', dispatched: true, pageBefore: page, pageAfter: page,
      }
    },
    async evidence() {
      return { ownerId: 'a', page, console: [], network: [], bounded: true, limits: { console: 1, network: 1 }, dropped: { console: 0, network: 0 } }
    },
    async stop() { return { ownerId: 'a', stopped: true, reason: 'requested' } },
    async dispose() {},
  }
  const adapter = new BrowserAdapter(driver)

  await adapter.act('a', { kind: 'scroll', ref: 'br_1' })
  await adapter.act('a', { kind: 'scroll', direction: 'down', amount: 'page' })
  await adapter.act('a', { kind: 'select', ref: 'br_1', option: 'Alpha' })
  await adapter.act('a', { kind: 'hover', ref: 'br_1' })
  assert.deepEqual(calls[0], { kind: 'scroll', ref: 'br_1' })
  assert.deepEqual(calls[1], { kind: 'scroll', direction: 'down', amount: 'page' })
  assert.deepEqual(calls[2], { kind: 'select', ref: 'br_1', option: 'Alpha' })
  assert.deepEqual(calls[3], { kind: 'hover', ref: 'br_1' })

  // Computer-only verbs and the computer scroll shape are rejected, naming the driver.
  await assert.rejects(adapter.act('a', { kind: 'focus', ref: 'br_1' }), /browser driver/)
  await assert.rejects(adapter.act('a', { kind: 'scroll', ref: 'br_1', direction: 'down' }), /browser driver/)
})
