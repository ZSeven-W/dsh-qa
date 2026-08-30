// Unit tests for the computer adapter against a fake ComputerDriver. These
// prove the adapter is a non-weakening passthrough WITHOUT needing a native
// macOS fixture: secure fields stay permanently rejected even with an approval
// gate, the gate is forwarded verbatim, an unknown receipt is never promoted,
// strong identity binding is asserted (not assumed), and each act maps to
// exactly one driver dispatch. The real native flow is covered by
// computer-integration.test.mjs.

import test from 'node:test'
import assert from 'node:assert/strict'
import { ComputerAdapter } from '../src/adapters/index.ts'

const APP = { bundleId: 'dev.zseven-w.dshqa.fixture', pid: 4242, launchIdentity: 'exec:123', name: 'Fixture' }
const WINDOW = { number: 7, role: 'AXWindow', subrole: 'AXStandardWindow', title: 'dsh-qa native fixture', frame: { x: 0, y: 0, width: 400, height: 300 }, identity: 'win-id' }

function target(overrides) {
  return {
    ref: 'r', role: 'AXButton', subrole: null, name: 'Publish release', identifier: 'fixture.publish',
    frame: null, enabled: true, focused: false, secure: false, actions: ['AXPress'], value: null, depth: 2,
    ...overrides,
  }
}

function fakeDriver(overrides = {}) {
  const calls = []
  const driver = {
    kind: 'computer',
    platform: 'macos',
    contractVersion: 2,
    async observe(request, context) {
      calls.push(['observe', request, context])
      return {
        observationId: 'obs_1', fingerprint: 'fp1', capturedAt: 'x', expiresAt: 'y',
        app: overrides.app ?? APP,
        window: overrides.window ?? WINDOW,
        targets: [
          target({ ref: 'r1', role: 'AXTextField', subrole: null, name: 'Plain text', identifier: 'fixture.plainText', secure: false, actions: [], value: 'v1' }),
          target({ ref: 'r2', role: 'AXTextField', subrole: 'AXSecureTextField', name: 'Secure password', identifier: 'fixture.securePassword', secure: true, actions: [], value: null }),
          target({ ref: 'r3', role: 'AXButton', name: 'Publish release', identifier: 'fixture.publish', actions: ['AXPress'] }),
        ],
        truncated: false,
        limits: { maxDepth: 4, maxNodes: 200, ttlMs: 15000 },
      }
    },
    async act(action, context) {
      calls.push(['act', action, context])
      if (overrides.act) return overrides.act(action, context)
      if (action.kind === 'type' && action.ref === 'r2') {
        return receipt({ status: 'rejected', action: 'type', ref: 'r2', reason: 'secure text entry is permanently blocked', nativeAccepted: false })
      }
      if (action.kind === 'click' && action.ref === 'r3' && context.approval === undefined) {
        return receipt({ status: 'rejected', action: 'click', ref: 'r3', reason: 'approval unavailable: no approval gate was supplied', nativeAccepted: false })
      }
      if (action.kind === 'click' && action.ref === 'r3') {
        return receipt({ status: 'unknown', action: 'click', ref: 'r3', reason: 'AXPress attempted; visible outcome is unknown', nativeAccepted: true })
      }
      return receipt({ status: 'confirmed', action: action.kind, ref: action.ref, reason: 'ok', nativeAccepted: true })
    },
    async visualObserve() { throw new Error('not exercised by adapter unit tests') },
    async evidence(context, options) {
      calls.push(['evidence', context, options])
      return {
        contractVersion: 2, scope: 'sc',
        status: { platform: 'macos', helper: 'ready', accessibilityTrusted: true, screenRecordingTrusted: true, sessionLocked: false, interactiveSessionAvailable: true, helperVersion: '0.1.0-rc.1', helperExecutable: '/x', identityStable: false, detail: 'ok' },
        activeObservations: 0, activeNativeRequests: 0, receipts: [],
      }
    },
    async disposeScope(scopeId) { calls.push(['disposeScope', scopeId]) },
    async dispose() { calls.push(['dispose']) },
  }
  return { driver, calls }
}

function receipt(overrides) {
  return {
    receiptId: 'rc', sequence: 1, status: 'confirmed', action: 'click', ref: 'r',
    observationId: null, observationFingerprint: null, startedAt: 'a', finishedAt: 'b',
    reason: '', nativeAccepted: true, postAction: null,
    ...overrides,
  }
}

test('projects observation, asserts identity, and maps a type action verbatim', async () => {
  const { driver, calls } = fakeDriver()
  const adapter = new ComputerAdapter(driver)
  assert.equal(adapter.kind, 'computer')

  const info = await adapter.start('a', { bundleId: APP.bundleId, pid: APP.pid, windowTitle: WINDOW.title })
  assert.deepEqual(info, { page: { url: APP.bundleId, title: WINDOW.title }, headless: false })

  const obs = await adapter.observe('a')
  assert.equal(obs.app.bundleId, APP.bundleId)
  assert.equal(obs.app.pid, APP.pid)
  assert.equal(obs.app.launchIdentity, APP.launchIdentity)
  assert.equal(obs.window.number, 7)
  assert.equal(obs.window.title, WINDOW.title)
  assert.ok(obs.window.frame, 'window frame is asserted, not assumed')
  const secure = obs.nodes.find((n) => n.secure === true)
  assert.ok(secure, 'secure field is classified')
  assert.equal(secure.value, null, 'secure value is never exposed')
  const plain = obs.nodes.find((n) => n.role === 'AXTextField' && !n.secure)
  assert.equal(plain.value, 'v1', 'non-secure value is projected')
  assert.equal(calls.filter((c) => c[0] === 'observe').length, 1)
})

test('secure field is permanently rejected even when an approval gate is supplied', async () => {
  const { driver, calls } = fakeDriver()
  const adapter = new ComputerAdapter(driver)
  await adapter.start('a', { bundleId: APP.bundleId })
  let gateCalls = 0
  const gate = { request: async () => { gateCalls += 1; return 'allowed-once' } }

  const receiptResult = await adapter.act('a', { kind: 'type', ref: 'r2', text: 'secret' }, gate)
  assert.equal(receiptResult.status, 'rejected')
  assert.equal(receiptResult.code, 'secure-text')
  assert.equal(receiptResult.dispatched, false)
  assert.equal(gateCalls, 0, 'the approval gate is never consulted for a secure field')
  assert.equal(calls.filter((c) => c[0] === 'act').length, 1, 'exactly one act, no retry')
})

test('approval gate is forwarded verbatim and an allowed-once decision is not retried', async () => {
  const { driver, calls } = fakeDriver()
  const adapter = new ComputerAdapter(driver)
  await adapter.start('a', { bundleId: APP.bundleId })
  let gateCalls = 0
  const gate = { request: async () => { gateCalls += 1; return 'allowed-once' } }

  const receiptResult = await adapter.act('a', { kind: 'click', ref: 'r3' }, gate)
  assert.equal(receiptResult.status, 'unknown', 'an unknown receipt is never promoted to success')
  assert.equal(receiptResult.dispatched, true)
  const actCall = calls.find((c) => c[0] === 'act')
  assert.equal(actCall[2].approval, gate, 'the gate object is passed through verbatim (same reference)')
  assert.equal(calls.filter((c) => c[0] === 'act').length, 1, 'exactly one act dispatch')
})

test('publish-release click is rejected without an approval gate', async () => {
  const { driver } = fakeDriver()
  const adapter = new ComputerAdapter(driver)
  await adapter.start('a', { bundleId: APP.bundleId })
  const receiptResult = await adapter.act('a', { kind: 'click', ref: 'r3' })
  assert.equal(receiptResult.status, 'rejected')
  assert.equal(receiptResult.code, 'APPROVAL_REQUIRED')
  assert.equal(receiptResult.dispatched, false)
})

test('strong identity binding is asserted, not assumed', async () => {
  const { driver } = fakeDriver({ app: { ...APP, launchIdentity: null } })
  const adapter = new ComputerAdapter(driver)
  await adapter.start('a', { bundleId: APP.bundleId })
  await assert.rejects(adapter.observe('a'), /launch identity/)

  const { driver: driver2 } = fakeDriver({ app: { ...APP, bundleId: 'other.bundle' } })
  const adapter2 = new ComputerAdapter(driver2)
  await adapter2.start('a', { bundleId: APP.bundleId })
  await assert.rejects(adapter2.observe('a'), /does not match bound/)

  const { driver: driver3 } = fakeDriver({ window: { ...WINDOW, number: null } })
  const adapter3 = new ComputerAdapter(driver3)
  await adapter3.start('a', { bundleId: APP.bundleId })
  await assert.rejects(adapter3.observe('a'), /window number/)
})

test('evidence projects helper status; stop disposes the scope and dispose the driver', async () => {
  const { driver, calls } = fakeDriver()
  const adapter = new ComputerAdapter(driver)
  await adapter.start('a', { bundleId: APP.bundleId })

  const evidence = await adapter.evidence('a', { maxReceipts: 5 })
  assert.equal(evidence.bounded, true)
  assert.deepEqual(evidence.console, [])
  assert.deepEqual(evidence.network, [])
  assert.equal(evidence.computer.status.accessibilityTrusted, true)
  assert.equal(evidence.computer.status.screenRecordingTrusted, true)

  const stop = await adapter.stop('a')
  assert.deepEqual(stop, { stopped: true, reason: 'scope-disposed' })
  assert.ok(calls.some((c) => c[0] === 'disposeScope' && c[1] === 'a'))

  await adapter.dispose()
  assert.ok(calls.some((c) => c[0] === 'dispose'))
})

test('computer adapter passes scroll through and rejects select/hover with a driver-naming error', async () => {
  const { driver, calls } = fakeDriver()
  const adapter = new ComputerAdapter(driver)
  await adapter.start('a', { bundleId: APP.bundleId })

  const receiptResult = await adapter.act('a', { kind: 'scroll', ref: 'r1', direction: 'down', amount: 'line' })
  assert.equal(receiptResult.status, 'confirmed')
  const actCall = calls.find((c) => c[0] === 'act')
  assert.deepEqual(actCall[1], { kind: 'scroll', ref: 'r1', direction: 'down', amount: 'line' })

  await assert.rejects(adapter.act('a', { kind: 'select', ref: 'r1', option: 'Alpha' }), /computer driver.*select/)
  await assert.rejects(adapter.act('a', { kind: 'hover', ref: 'r1' }), /computer driver.*hover/)
  // Browser-only scroll shapes (ref-only or direction-only) are rejected, never silently dropped.
  await assert.rejects(adapter.act('a', { kind: 'scroll', ref: 'r1' }), /computer driver.*ref/)
  await assert.rejects(adapter.act('a', { kind: 'scroll', direction: 'down' }), /computer driver.*ref/)
})

