// Targeted unit tests for the mobile adapters (iOS/Android) against fake
// driver backends. These intentionally do not require a real simulator,
// emulator, AXe, adb, or WDA. They cover the adapter safety contract:
// explicit device+app binding, per-owner ref epochs, stable native IDs,
// stale/cross-owner/mismatch/secure/disabled/ambiguous/out-of-bounds refusal,
// coordinate space, screenshot metadata/path, lease cleanup and dispose.
//
// Full native coverage is owned by the parent/live-driver flow; this file does
// not try to fake a real device pass.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { IosAdapter, AndroidAdapter } from '../src/adapters/index.ts'

const APP_IOS = 'dev.zseven.qa.fixture.ios'
const APP_ANDROID = 'dev.zseven.qa.fixture.android'
const DEVICE_IOS = '7028B135-A568-4E7F-B47A-539C8710136D'
const DEVICE_ANDROID = 'emulator-5554'

function iosNode(overrides = {}) {
  return {
    type: 'AXTextField',
    name: 'Name',
    identifier: 'qa.input.name',
    value: '',
    frame: { x: 10, y: 20, width: 200, height: 50 },
    enabled: true,
    secure: false,
    ...overrides,
  }
}

function makeIosBackend(overrides = {}) {
  const calls = []
  const state = {
    appId: APP_IOS,
    verified: true,
    observedAppId: APP_IOS,
    observeCount: 0,
    nodes: [iosNode(), iosNode({ type: 'AXStaticText', name: 'Label', identifier: undefined, editable: false, value: undefined })],
    disposeCount: 0,
  }
  const backend = {
    async discover() { return [{ udid: DEVICE_IOS, kind: 'simulator', name: 'fixture', state: 'Booted' }] },
    async launchApp(udid, bundleId) {
      calls.push(['launch', udid, bundleId])
      return { ok: true, udid, backend: 'simulator', action: 'launchApp' }
    },
    async observe(udid, options = {}) {
      calls.push(['observe', udid, options])
      state.observeCount += 1
      if (overrides.observe) return overrides.observe({ state, udid, options, calls })
      return {
        udid,
        backend: 'simulator',
        app: state.verified ? { bundleId: state.observedAppId, name: 'Fixture', pid: 10, verified: true } : { verified: false },
        screen: { width: 1206, height: 2622 },
        nodes: state.nodes,
        truncated: false,
        depth: 1,
        maxNodes: 500,
      }
    },
    async tap(udid, x, y) {
      calls.push(['tap', udid, x, y])
      if (overrides.tap) return overrides.tap(udid, x, y)
      return { ok: true, udid, backend: 'simulator', action: 'tap' }
    },
    async type(udid, text) {
      calls.push(['type', udid, text])
      if (overrides.type) return overrides.type(udid, text)
      return { ok: true, udid, backend: 'simulator', action: 'type' }
    },
    async typeTarget(target) {
      calls.push(['typeTarget', target])
      if (overrides.typeTarget) return overrides.typeTarget(target)
      return { udid: target.udid, backend: 'simulator', action: 'typeTarget', mode: 'append', status: 'unknown', dispatched: true, nativeAccepted: true }
    },
    async fillTarget(target) {
      calls.push(['fillTarget', target])
      if (overrides.fillTarget) return overrides.fillTarget(target)
      return { udid: target.udid, backend: 'simulator', action: 'fillTarget', mode: 'replace', status: 'unknown', dispatched: true, nativeAccepted: true }
    },
    async releaseDevice(udid) {
      calls.push(['releaseDevice', udid])
      if (overrides.releaseDevice) return overrides.releaseDevice(udid)
    },
    async scroll(udid, direction, amount) {
      calls.push(['scroll', udid, direction, amount])
      return { ok: true, udid, backend: 'simulator', action: 'scroll' }
    },
    async key(udid, key) {
      calls.push(['key', udid, key])
      return { ok: true, udid, backend: 'simulator', action: 'key' }
    },
    async foregroundApp(udid) {
      calls.push(['foreground', udid])
      return {
        udid,
        backend: 'simulator',
        app: state.verified ? { bundleId: state.observedAppId, name: 'Fixture', pid: 10, verified: true } : { verified: false },
      }
    },
    async screenshot(udid) {
      calls.push(['screenshot', udid])
      return { udid, backend: 'simulator', pngBase64: 'aGVsbG8=', width: 1206, height: 2622 }
    },
    async dispose() { calls.push(['dispose']); state.disposeCount += 1 },
  }
  return { backend, calls, state }
}

function androidNode(overrides = {}) {
  return {
    role: 'EditText',
    className: 'android.widget.EditText',
    resourceId: 'qa.input.name',
    name: 'Name',
    text: 'Hello',
    contentDesc: null,
    frame: { x: 20, y: 30, width: 300, height: 80 },
    enabled: true,
    focused: false,
    clickable: false,
    scrollable: false,
    password: false,
    packageName: APP_ANDROID,
    children: [],
    ...overrides,
  }
}

function makeAndroidBackend(overrides = {}) {
  const calls = []
  const state = {
    appId: APP_ANDROID,
    verified: true,
    observedAppId: APP_ANDROID,
    observeCount: 0,
    focusId: null,
    nodes: [androidNode()],
    disposeCount: 0,
  }
  const backend = {
    async discover() { return [{ serial: DEVICE_ANDROID, state: 'device', emulator: true, model: 'fixture' }] },
    async launchApp(serial, packageName) {
      calls.push(['launch', serial, packageName])
      return { serial, packageName, command: ['monkey', '-p', packageName], output: 'ok' }
    },
    async observe(serial, options = {}) {
      calls.push(['observe', serial, options])
      state.observeCount += 1
      if (overrides.observe) return overrides.observe({ state, serial, options, calls })
      const nodes = state.nodes.map((node) => {
        if (state.focusId !== null && node.resourceId === state.focusId) {
          return { ...node, focused: true }
        }
        return node
      })
      const fg = state.verified
        ? { packageName: state.observedAppId, activity: '.Main', raw: 'mResumedActivity fixture' }
        : undefined
      const packageName = state.verified ? state.observedAppId : undefined
      return {
        serial,
        ...(packageName === undefined ? {} : { packageName }),
        ...(fg === undefined ? {} : { foreground: fg }),
        ...(state.verified ? {} : { readError: 'fixture foreground unreadable' }),
        screen: { width: 1080, height: 2400 },
        coordinateSpace: 'display-pixels',
        rotation: 0,
        nodes,
        nodeCount: nodes.length,
        truncated: false,
        budgetBytes: 40960,
      }
    },
    async tap(serial, x, y) {
      calls.push(['tap', serial, x, y])
      state.focusId = 'qa.input.name'
    },
    async type(serial, text) {
      calls.push(['type', serial, text])
      if (overrides.type) return overrides.type(serial, text)
    },
    async scroll(serial, direction, amount) {
      calls.push(['scroll', serial, direction, amount])
    },
    async key(serial, key) {
      calls.push(['key', serial, key])
    },
    async foregroundApp(serial) {
      calls.push(['foreground', serial])
      return state.verified
        ? { packageName: state.observedAppId, activity: '.Main', raw: 'mResumedActivity fixture' }
        : { raw: 'no focus line' }
    },
    async screenshot(serial) {
      calls.push(['screenshot', serial])
      return { serial, png: Buffer.from('fake-png-bytes'), width: 1080, height: 2400 }
    },
    async dispose() { calls.push(['dispose']); state.disposeCount += 1 },
  }
  return { backend, calls, state }
}

test('IosAdapter binds explicit device+bundle, exposes stable identifiers and point metadata, and unknown taps stay unknown', async () => {
  const { backend, calls } = makeIosBackend()
  const adapter = new IosAdapter(backend)
  try {
    assert.equal(adapter.kind, 'ios')
    const info = await adapter.start('owner-a', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
    assert.deepEqual(info.page, { url: APP_IOS, title: APP_IOS })
    assert.equal(info.headless, false)

    const obs = await adapter.observe('owner-a', { maxDepth: 4 })
    assert.equal(obs.mobile.kind, 'ios')
    assert.equal(obs.mobile.deviceId, DEVICE_IOS)
    assert.equal(obs.mobile.appId, APP_IOS)
    assert.equal(obs.mobile.backend, 'simulator')
    assert.equal(obs.mobile.verified, true)
    assert.equal(obs.mobile.coordinateSpace, 'point')
    assert.deepEqual(obs.mobile.screen, { width: 1206, height: 2622 })
    const node = obs.nodes.find((n) => n.identifier === 'qa.input.name')
    assert.ok(node)
    assert.equal(node.tag, 'qa.input.name')
    assert.equal(node.editable, true)
    const noId = obs.nodes.find((n) => n.identifier === undefined)
    assert.ok(noId)

    const receipt = await adapter.act('owner-a', { kind: 'click', ref: node.ref })
    assert.equal(receipt.status, 'unknown')
    assert.equal(receipt.dispatched, true)
    const tap = calls.find((call) => call[0] === 'tap')
    assert.ok(tap)
    assert.equal(tap[2], 110, 'iOS taps use point-space centers')
    assert.equal(tap[3], 45)

    await adapter.stop('owner-a')
    assert.equal(calls.some((call) => call[0] === 'dispose'), false, 'stop does not dispose the shared backend')
    await adapter.dispose()
    assert.ok(calls.some((call) => call[0] === 'dispose'))
    await assert.rejects(() => adapter.observe('owner-a'), /disposed/)
  } finally {
    await adapter.dispose().catch(() => {})
  }
})

test('AndroidAdapter exposes display-pixel coordinates and visual capture path/bytes/hash/driver', async () => {
  const { backend, calls } = makeAndroidBackend()
  const adapter = new AndroidAdapter(backend)
  try {
    await adapter.start('owner-android', { deviceId: DEVICE_ANDROID, packageName: APP_ANDROID })
    const obs = await adapter.observe('owner-android')
    assert.equal(obs.mobile.kind, 'android')
    assert.equal(obs.mobile.coordinateSpace, 'display-pixels')
    assert.deepEqual(obs.mobile.screen, { width: 1080, height: 2400 })
    const node = obs.nodes.find((n) => n.identifier === 'qa.input.name')
    assert.ok(node)
    assert.equal(node.secure, false)
    assert.equal(node.value, 'Hello')

    const receipt = await adapter.act('owner-android', { kind: 'click', ref: node.ref })
    assert.equal(receipt.status, 'unknown')
    assert.equal(receipt.dispatched, true)
    const tap = calls.find((call) => call[0] === 'tap')
    assert.ok(tap)
    assert.equal(tap[2], 170, 'Android tap uses display-pixel centers')
    assert.equal(tap[3], 70)

    const visual = await adapter.visualObserve('owner-android')
    assert.equal(visual.driver, 'android')
    assert.equal(visual.width, 1080)
    assert.equal(visual.height, 2400)
    assert.equal(visual.sha256.length, 64)
    assert.ok(visual.artifactPath)
    assert.equal(visual.png.length, Buffer.from('fake-png-bytes').length)
    assert.equal(existsSync(visual.artifactPath), true)
    assert.deepEqual(readFileSync(visual.artifactPath), Buffer.from('fake-png-bytes'))

    await adapter.stop('owner-android')
    assert.equal(calls.some((call) => call[0] === 'dispose'), false)
  } finally {
    await adapter.dispose().catch(() => {})
  }
})

test('mobile refs are owner-scoped and stale epochs are refused', async () => {
  const ios = makeIosBackend()
  const adapter = new IosAdapter(ios.backend)
  try {
    await adapter.start('owner-a', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
    const first = await adapter.observe('owner-a')
    const firstRef = first.nodes.find((n) => n.identifier === 'qa.input.name').ref

    // A different owner cannot use owner A's ref.
    const cross = await adapter.act('owner-b', { kind: 'click', ref: firstRef })
    assert.equal(cross.status, 'rejected')
    assert.equal(cross.code, 'CROSS_OWNER')

    // A new observation mints new refs; an old epoch is stale, not dispatchable.
    const second = await adapter.observe('owner-a')
    assert.notEqual(second.nodes.find((n) => n.identifier === 'qa.input.name').ref, firstRef)
    const stale = await adapter.act('owner-a', { kind: 'click', ref: firstRef })
    assert.equal(stale.status, 'rejected')
    assert.equal(stale.code, 'STALE_OBSERVATION')
    assert.equal(stale.dispatched, false)
  } finally {
    await adapter.dispose().catch(() => {})
  }
})

test('mobile act refuses app mismatch, disabled, ambiguous, and changed-bounds targets', async () => {
  // App mismatch.
  await (async () => {
    const ios = makeIosBackend()
    const adapter = new IosAdapter(ios.backend)
    try {
      await adapter.start('mismatch', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
      const obs = await adapter.observe('mismatch')
      const ref = obs.nodes.find((n) => n.identifier === 'qa.input.name').ref
      ios.state.observedAppId = 'com.other.app'
      const mismatch = await adapter.act('mismatch', { kind: 'click', ref })
      assert.equal(mismatch.status, 'rejected')
      assert.equal(mismatch.code, 'APP_IDENTITY_UNVERIFIED')
      assert.equal(mismatch.dispatched, false)
    } finally {
      await adapter.dispose().catch(() => {})
    }
  })()

  // Disabled.
  await (async () => {
    const ios = makeIosBackend()
    const adapter = new IosAdapter(ios.backend)
    try {
      await adapter.start('disabled', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
      const obs = await adapter.observe('disabled')
      const ref = obs.nodes.find((n) => n.identifier === 'qa.input.name').ref
      ios.state.nodes = [iosNode({ enabled: false })]
      const result = await adapter.act('disabled', { kind: 'click', ref })
      assert.equal(result.status, 'rejected')
      assert.equal(result.code, 'TARGET_DISABLED')
    } finally {
      await adapter.dispose().catch(() => {})
    }
  })()

  // Ambiguous stable identifier in the fresh tree.
  await (async () => {
    const android = makeAndroidBackend()
    const adapter = new AndroidAdapter(android.backend)
    try {
      await adapter.start('ambiguous', { deviceId: DEVICE_ANDROID, bundleId: APP_ANDROID })
      const obs = await adapter.observe('ambiguous')
      const ref = obs.nodes.find((n) => n.identifier === 'qa.input.name').ref
      android.state.nodes = [
        androidNode({ name: 'A' }),
        androidNode({ name: 'B' }),
      ]
      const result = await adapter.act('ambiguous', { kind: 'click', ref })
      assert.equal(result.status, 'rejected')
      assert.equal(result.code, 'TARGET_NOT_UNIQUE')
    } finally {
      await adapter.dispose().catch(() => {})
    }
  })()

  // Changed bounds between the observation and dispatch-time fresh read.
  await (async () => {
    const ios = makeIosBackend()
    const adapter = new IosAdapter(ios.backend)
    try {
      await adapter.start('moved', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
      const obs = await adapter.observe('moved')
      const ref = obs.nodes.find((n) => n.identifier === 'qa.input.name').ref
      ios.state.nodes = [iosNode({ frame: { x: 300, y: 20, width: 200, height: 50 } })]
      const result = await adapter.act('moved', { kind: 'click', ref })
      assert.equal(result.status, 'rejected')
      assert.equal(result.code, 'TARGET_CHANGED')
    } finally {
      await adapter.dispose().catch(() => {})
    }
  })()
})

test('iOS typeTarget/fillTarget route through native element-bound methods when present', async () => {
  const ios = makeIosBackend()
  const adapter = new IosAdapter(ios.backend)
  try {
    await adapter.start('ios-targeted', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
    const obs = await adapter.observe('ios-targeted')
    const node = obs.nodes.find((n) => n.identifier === 'qa.input.name')
    assert.equal(node.secure, false)

    const type = await adapter.act('ios-targeted', { kind: 'type', ref: node.ref, text: 'world' })
    assert.equal(type.status, 'unknown')
    assert.equal(type.dispatched, true)
    const typeCall = ios.calls.find((call) => call[0] === 'typeTarget')
    assert.ok(typeCall, 'typeTarget is called when present even though focus is unknown')
    assert.deepEqual(typeCall[1], {
      udid: DEVICE_IOS,
      bundleId: APP_IOS,
      identifier: 'qa.input.name',
      frame: { x: 10, y: 20, width: 200, height: 50 },
      text: 'world',
      expectedPID: 10,
      secure: false,
    })
    assert.equal(ios.calls.some((call) => call[0] === 'type'), false, 'iOS never calls raw global type')

    const fill = await adapter.act('ios-targeted', { kind: 'fill', ref: node.ref, text: 'replacement' })
    assert.equal(fill.status, 'unknown')
    assert.equal(fill.dispatched, true)
    const fillCall = ios.calls.find((call) => call[0] === 'fillTarget')
    assert.ok(fillCall, 'fillTarget is used for replace semantics')
    assert.equal(fillCall[1].text, 'replacement')
    assert.equal(fillCall[1].identifier, 'qa.input.name')
    assert.equal(ios.calls.filter((call) => call[0] === 'fillTarget').length, 1)
    assert.equal(ios.calls.filter((call) => call[0] === 'typeTarget').length, 1, 'fill does not route through append typeTarget')
    assert.equal(ios.calls.some((call) => call[0] === 'type'), false, 'fill never aliases to append/type')
  } finally {
    await adapter.dispose().catch(() => {})
  }
})

test('WDA-style roles normalize to editable/secure while identifiers stay required', async () => {
  // TextField (WDA spelling of AXTextField) is editable and typeable.
  await (async () => {
    const ios = makeIosBackend()
    const adapter = new IosAdapter(ios.backend)
    try {
      await adapter.start('wda-textfield', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
      ios.state.nodes = [iosNode({ type: 'TextField', name: 'Search conversations', identifier: 'qa.search.conversations', value: 'draft' })]
      const obs = await adapter.observe('wda-textfield')
      const node = obs.nodes.find((n) => n.identifier === 'qa.search.conversations')
      assert.ok(node)
      assert.equal(node.editable, true)
      assert.equal(node.secure, false)
      assert.equal(node.value, 'draft', 'nonsecure WDA values stay visible')
      const type = await adapter.act('wda-textfield', { kind: 'type', ref: node.ref, text: 'hello' })
      assert.equal(type.status, 'unknown')
      assert.equal(type.dispatched, true)
      const call = ios.calls.find((c) => c[0] === 'typeTarget')
      assert.ok(call, 'TextField routes through typeTarget like AXTextField')
      assert.equal(call[1].identifier, 'qa.search.conversations')
    } finally {
      await adapter.dispose().catch(() => {})
    }
  })()

  // TextView (WDA spelling of AXTextArea) is editable and fillable.
  await (async () => {
    const ios = makeIosBackend()
    const adapter = new IosAdapter(ios.backend)
    try {
      await adapter.start('wda-textview', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
      ios.state.nodes = [iosNode({ type: 'TextView', name: 'Note body', identifier: 'qa.note.body' })]
      const obs = await adapter.observe('wda-textview')
      const node = obs.nodes.find((n) => n.identifier === 'qa.note.body')
      assert.ok(node)
      assert.equal(node.editable, true)
      const fill = await adapter.act('wda-textview', { kind: 'fill', ref: node.ref, text: 'rewritten' })
      assert.equal(fill.status, 'unknown')
      assert.equal(fill.dispatched, true)
      const call = ios.calls.find((c) => c[0] === 'fillTarget')
      assert.ok(call, 'TextView routes through fillTarget')
      assert.equal(call[1].identifier, 'qa.note.body')
      assert.equal(call[1].text, 'rewritten')
    } finally {
      await adapter.dispose().catch(() => {})
    }
  })()

  // SearchField (WDA spelling of AXSearchField) is editable and typeable.
  await (async () => {
    const ios = makeIosBackend()
    const adapter = new IosAdapter(ios.backend)
    try {
      await adapter.start('wda-searchfield', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
      ios.state.nodes = [iosNode({ type: 'SearchField', name: 'Search conversations', identifier: 'qa.search.field' })]
      const obs = await adapter.observe('wda-searchfield')
      const node = obs.nodes.find((n) => n.identifier === 'qa.search.field')
      assert.ok(node)
      assert.equal(node.editable, true)
      const type = await adapter.act('wda-searchfield', { kind: 'type', ref: node.ref, text: 'chat' })
      assert.equal(type.status, 'unknown')
      assert.equal(type.dispatched, true)
      const call = ios.calls.find((c) => c[0] === 'typeTarget')
      assert.ok(call, 'SearchField routes through typeTarget')
      assert.equal(call[1].identifier, 'qa.search.field')
    } finally {
      await adapter.dispose().catch(() => {})
    }
  })()

  // SecureTextField is secure by role even when the backend flag is absent:
  // the value is withheld and typing is refused before any backend mutation.
  await (async () => {
    const ios = makeIosBackend()
    const adapter = new IosAdapter(ios.backend)
    try {
      await adapter.start('wda-secure', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
      ios.state.nodes = [iosNode({ type: 'SecureTextField', name: 'Passcode', identifier: 'qa.passcode.field', value: 'topsecret', secure: undefined })]
      const obs = await adapter.observe('wda-secure')
      const node = obs.nodes.find((n) => n.identifier === 'qa.passcode.field')
      assert.ok(node)
      assert.equal(node.editable, true, 'secure fields stay typed-as-editable but are gated by secure')
      assert.equal(node.secure, true)
      assert.equal(node.value, undefined, 'secure WDA values are withheld from observations')
      const type = await adapter.act('wda-secure', { kind: 'type', ref: node.ref, text: 'guess' })
      assert.equal(type.status, 'rejected')
      assert.equal(type.code, 'SECURE_TARGET')
      assert.equal(type.dispatched, false)
      assert.equal(ios.calls.some((c) => c[0] === 'typeTarget' || c[0] === 'fillTarget'), false, 'secure fields never reach the backend')
    } finally {
      await adapter.dispose().catch(() => {})
    }
  })()

  // Role normalization never fabricates identifiers: an identifier-less
  // TextField stays identifier-less in the observation and the action target
  // carries the EXACT observed name + native semantic type instead — the
  // backend call receives no invented identifier.
  await (async () => {
    const ios = makeIosBackend()
    const adapter = new IosAdapter(ios.backend)
    try {
      await adapter.start('wda-noid', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
      ios.state.nodes = [iosNode({ type: 'TextField', name: 'Search conversations', identifier: undefined })]
      const obs = await adapter.observe('wda-noid')
      const node = obs.nodes.find((n) => n.name === 'Search conversations')
      assert.ok(node)
      assert.equal(node.editable, true, 'WDA role marks editability without inventing identity')
      assert.equal(node.identifier, undefined, 'no identifier is fabricated for identifier-less WDA nodes')
      const type = await adapter.act('wda-noid', { kind: 'type', ref: node.ref, text: 'hello' })
      assert.equal(type.status, 'unknown')
      assert.equal(type.dispatched, true)
      const call = ios.calls.find((c) => c[0] === 'typeTarget')
      assert.ok(call, 'identifier-less TextField routes through typeTarget via the semantic selector')
      assert.equal(call[1].identifier, undefined, 'the native target carries no fabricated identifier')
      assert.deepEqual(call[1].semantic, { label: 'Search conversations', type: 'TextField' })
      assert.equal(ios.calls.some((c) => c[0] === 'type'), false, 'iOS never falls back to raw global type')
    } finally {
      await adapter.dispose().catch(() => {})
    }
  })()
})

test('iOS missing target-bound method remains TYPING_PRIMITIVE_UNAVAILABLE even when fake says focused true', async () => {
  const ios = makeIosBackend({ observe: ({ state }) => ({
    udid: DEVICE_IOS,
    backend: 'simulator',
    app: { bundleId: state.observedAppId, pid: 10, verified: true },
    screen: { width: 1206, height: 2622 },
    nodes: [iosNode({ focused: true })],
    truncated: false,
    depth: 1,
    maxNodes: 500,
  }) })
  delete ios.backend.typeTarget
  const adapter = new IosAdapter(ios.backend)
  try {
    await adapter.start('ios-type', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
    const obs = await adapter.observe('ios-type')
    const node = obs.nodes.find((n) => n.identifier === 'qa.input.name')
    assert.equal(node.secure, false)
    const result = await adapter.act('ios-type', { kind: 'type', ref: node.ref, text: 'hello' })
    assert.equal(result.status, 'rejected')
    assert.equal(result.code, 'TYPING_PRIMITIVE_UNAVAILABLE')
    assert.equal(result.dispatched, false)
    assert.equal(ios.calls.some((call) => call[0] === 'typeTarget'), false)
    assert.equal(ios.calls.some((call) => call[0] === 'type'), false)
  } finally {
    await adapter.dispose().catch(() => {})
  }
})

test('iOS secure/stale/ambiguous target-bound mutations do not call the native method', async () => {
  // Secure fresh tree refuses before backend mutation.
  await (async () => {
    const ios = makeIosBackend()
    const adapter = new IosAdapter(ios.backend)
    try {
      await adapter.start('ios-secure', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
      const obs = await adapter.observe('ios-secure')
      const ref = obs.nodes.find((n) => n.identifier === 'qa.input.name').ref
      ios.state.nodes = [iosNode({ secure: true })]
      const result = await adapter.act('ios-secure', { kind: 'type', ref, text: 'secret' })
      assert.equal(result.status, 'rejected')
      assert.equal(result.code, 'SECURE_TARGET')
      assert.equal(ios.calls.some((call) => call[0] === 'typeTarget'), false)
    } finally {
      await adapter.dispose().catch(() => {})
    }
  })()

  // Stale epoch refuses before a fresh lookup/dispatch.
  await (async () => {
    const ios = makeIosBackend()
    const adapter = new IosAdapter(ios.backend)
    try {
      await adapter.start('ios-stale', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
      const first = await adapter.observe('ios-stale')
      const oldRef = first.nodes.find((n) => n.identifier === 'qa.input.name').ref
      await adapter.observe('ios-stale')
      const result = await adapter.act('ios-stale', { kind: 'type', ref: oldRef, text: 'x' })
      assert.equal(result.status, 'rejected')
      assert.equal(result.code, 'STALE_OBSERVATION')
      assert.equal(ios.calls.some((call) => call[0] === 'typeTarget'), false)
    } finally {
      await adapter.dispose().catch(() => {})
    }
  })()

  // Ambiguous fresh identifier refuses rather than guessing.
  await (async () => {
    const ios = makeIosBackend()
    const adapter = new IosAdapter(ios.backend)
    try {
      await adapter.start('ios-ambiguous', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
      const obs = await adapter.observe('ios-ambiguous')
      const ref = obs.nodes.find((n) => n.identifier === 'qa.input.name').ref
      ios.state.nodes = [
        iosNode({ name: 'A' }),
        iosNode({ name: 'B' }),
      ]
      const result = await adapter.act('ios-ambiguous', { kind: 'type', ref, text: 'x' })
      assert.equal(result.status, 'rejected')
      assert.equal(result.code, 'TARGET_NOT_UNIQUE')
      assert.equal(ios.calls.some((call) => call[0] === 'typeTarget'), false)
    } finally {
      await adapter.dispose().catch(() => {})
    }
  })()
})

test('iOS mutation unknown/dispatched is one receipt, preserves code/reason, and is never retried', async () => {
  let typeTargetCount = 0
  const ios = makeIosBackend({
    typeTarget: async () => {
      typeTargetCount += 1
      return {
        udid: DEVICE_IOS,
        backend: 'simulator',
        action: 'typeTarget',
        mode: 'append',
        status: 'unknown',
        dispatched: true,
        nativeAccepted: false,
        code: 'MUTATION_UNCERTAIN',
        reason: 'native mutation may have reached the field; verify by observe',
      }
    },
  })
  const adapter = new IosAdapter(ios.backend)
  try {
    await adapter.start('ios-uncertain', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
    const obs = await adapter.observe('ios-uncertain')
    const node = obs.nodes.find((n) => n.identifier === 'qa.input.name')
    const result = await adapter.act('ios-uncertain', { kind: 'type', ref: node.ref, text: 'hello' })
    assert.equal(result.status, 'unknown')
    assert.equal(result.dispatched, true)
    assert.equal(result.code, 'MUTATION_UNCERTAIN')
    assert.equal(result.reason, 'native mutation may have reached the field; verify by observe')
    assert.equal(typeTargetCount, 1, 'uncertain dispatch is not retried or turned into a no-dispatch rejection')
    assert.equal(ios.calls.some((call) => call[0] === 'type'), false)
  } finally {
    await adapter.dispose().catch(() => {})
  }
})

test('Android typing verifies real focused state before dispatching type and refuses secure fields', async () => {
  // Non-focused field: tap first, fresh observe sees focused=true, then type.
  await (async () => {
    const android = makeAndroidBackend()
    const adapter = new AndroidAdapter(android.backend)
    try {
      await adapter.start('android-type', { deviceId: DEVICE_ANDROID, packageName: APP_ANDROID })
      const obs = await adapter.observe('android-type')
      const node = obs.nodes.find((n) => n.identifier === 'qa.input.name')
      const result = await adapter.act('android-type', { kind: 'type', ref: node.ref, text: 'world' })
      assert.equal(result.status, 'unknown')
      assert.equal(result.dispatched, true)
      const typeCalls = android.calls.filter((call) => call[0] === 'type')
      assert.equal(typeCalls.length, 1)
      assert.equal(typeCalls[0][2], 'world')
      const tap = android.calls.find((call) => call[0] === 'tap')
      assert.ok(tap, 'non-focused typing taps to establish focus')
      const observeCountAfterType = android.state.observeCount
      assert.ok(observeCountAfterType >= 3, 'act re-observes before and after the focus tap')
    } finally {
      await adapter.dispose().catch(() => {})
    }
  })()

  // Secure field: secure refusal before any backend type.
  await (async () => {
    const android = makeAndroidBackend()
    const adapter = new AndroidAdapter(android.backend)
    try {
      await adapter.start('android-secure', { deviceId: DEVICE_ANDROID, packageName: APP_ANDROID })
      const obs = await adapter.observe('android-secure')
      const node = obs.nodes.find((n) => n.identifier === 'qa.input.name')
      android.state.nodes = [androidNode({ password: true, text: undefined, name: undefined, contentDesc: undefined })]
      const result = await adapter.act('android-secure', { kind: 'type', ref: node.ref, text: 'secret' })
      assert.equal(result.status, 'rejected')
      assert.equal(result.code, 'SECURE_TARGET')
      assert.equal(android.calls.some((call) => call[0] === 'type'), false)
      assert.equal(android.calls.some((call) => call[0] === 'tap'), false)
    } finally {
      await adapter.dispose().catch(() => {})
    }
  })()
})

test('Android fill refuses with FILL_PRIMITIVE_UNAVAILABLE while type remains append-faithful', async () => {
  // Real Android backend.type is adb input text = APPEND. Give the fake the
  // same behaviour so a silent append on fill (instead of REPLACE) would be
  // observable. The field already has a non-empty initial value.
  const android = makeAndroidBackend({
    type: async (serial, text) => {
      const node = android.state.nodes.find((n) => n.resourceId === 'qa.input.name')
      if (node && typeof node.text === 'string') {
        node.text += text
      }
    },
  })
  const adapter = new AndroidAdapter(android.backend)
  try {
    await adapter.start('android-fill', { deviceId: DEVICE_ANDROID, packageName: APP_ANDROID })
    const obs = await adapter.observe('android-fill')
    const node = obs.nodes.find((n) => n.identifier === 'qa.input.name')
    assert.equal(node.value, 'Hello', 'fixture field starts non-empty so a silent append is visible')

    const fill = await adapter.act('android-fill', { kind: 'fill', ref: node.ref, text: 'replacement' })
    assert.equal(fill.status, 'rejected')
    assert.equal(fill.code, 'FILL_PRIMITIVE_UNAVAILABLE')
    assert.equal(fill.dispatched, false)
    assert.equal(android.calls.some((call) => call[0] === 'tap'), false, 'fill must not tap')
    assert.equal(android.calls.some((call) => call[0] === 'type'), false, 'fill must not type/append')

    // Supported Android type still routes to the append-faithful backend.
    const type = await adapter.act('android-fill', { kind: 'type', ref: node.ref, text: ' more' })
    assert.equal(type.status, 'unknown')
    assert.equal(type.dispatched, true)
    const typeCalls = android.calls.filter((call) => call[0] === 'type')
    assert.equal(typeCalls.length, 1)
    assert.equal(typeCalls[0][2], ' more')
    assert.equal(android.state.nodes[0].text, 'Hello more', 'type appends exactly like adb input text')
  } finally {
    await adapter.dispose().catch(() => {})
  }
})

test('iOS stop cleanup failure keeps the lease busy and retry stop can release it', async () => {
  let releaseAttempts = 0
  const ios = makeIosBackend({
    releaseDevice: async () => {
      releaseAttempts += 1
      if (releaseAttempts === 1) throw new Error('cleanup unavailable')
    },
  })
  const adapter = new IosAdapter(ios.backend)
  const adapter2 = new IosAdapter(ios.backend)
  try {
    await adapter.start('ios-cleanup', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
    await assert.rejects(() => adapter.stop('ios-cleanup'), /IOS_STOP_CLEANUP_FAILED|still held/)
    assert.equal(releaseAttempts, 1)
    await assert.rejects(
      () => adapter2.start('other-owner', { deviceId: DEVICE_IOS, bundleId: APP_IOS }),
      /already leased by QA owner ios-cleanup/,
    )

    const result = await adapter.stop('ios-cleanup')
    assert.deepEqual(result, { stopped: true, reason: 'mobile-scope-released' })
    assert.equal(releaseAttempts, 2)
    await adapter2.start('other-owner', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
    assert.equal((await adapter2.observe('other-owner')).mobile.deviceId, DEVICE_IOS)
  } finally {
    await adapter.dispose().catch(() => {})
    await adapter2.dispose().catch(() => {})
  }
})

test('iOS stop cleanup calls releaseDevice for exactly its own device', async () => {
  const ios = makeIosBackend()
  const adapter = new IosAdapter(ios.backend)
  const otherDevice = '7028B135-A568-4E7F-B47A-539C8710FFFF'
  try {
    await adapter.start('owner-a', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
    await adapter.start('owner-b', { deviceId: otherDevice, bundleId: APP_IOS })
    await adapter.stop('owner-a')
    assert.deepEqual(
      ios.calls.filter((call) => call[0] === 'releaseDevice'),
      [['releaseDevice', DEVICE_IOS]],
    )
    await adapter.stop('owner-b')
    assert.deepEqual(
      ios.calls.filter((call) => call[0] === 'releaseDevice'),
      [['releaseDevice', DEVICE_IOS], ['releaseDevice', otherDevice]],
    )
    assert.equal(ios.calls.some((call) => call[0] === 'dispose'), false)
  } finally {
    await adapter.dispose().catch(() => {})
  }
})

test('in-process device lease is released by stop so another adapter can bind the same device', async () => {
  const android = makeAndroidBackend()
  const adapter1 = new AndroidAdapter(android.backend)
  const adapter2 = new AndroidAdapter(android.backend)
  try {
    await adapter1.start('owner-1', { deviceId: DEVICE_ANDROID, packageName: APP_ANDROID })
    await assert.rejects(
      () => adapter2.start('owner-2', { deviceId: DEVICE_ANDROID, packageName: APP_ANDROID }),
      /already leased by QA owner owner-1/,
    )
    await adapter1.stop('owner-1')
    await adapter2.start('owner-2', { deviceId: DEVICE_ANDROID, packageName: APP_ANDROID })
    assert.equal((await adapter2.observe('owner-2')).mobile.appId, APP_ANDROID)
    await adapter2.stop('owner-2')
    await adapter2.dispose()
  } finally {
    await adapter1.dispose().catch(() => {})
    await adapter2.dispose().catch(() => {})
  }
})

test('mobile dispose releases leases and backend once', async () => {
  const ios = makeIosBackend()
  const adapter = new IosAdapter(ios.backend)
  try {
    await adapter.start('discard', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
    await adapter.dispose()
    assert.equal(ios.state.disposeCount, 1)
    await assert.rejects(
      () => adapter.start('discard2', { deviceId: DEVICE_IOS, bundleId: APP_IOS }),
      /disposed/,
    )
  } finally {
    await adapter.dispose().catch(() => {})
  }
})

test('mobile evidence reports actual native foreground, not the requested-app echo', async () => {
  const ios = makeIosBackend()
  const adapter = new IosAdapter(ios.backend)
  try {
    await adapter.start('evidence-ios', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
    await adapter.observe('evidence-ios')
    const ok = await adapter.evidence('evidence-ios')
    assert.equal(ok.mobile.kind, 'ios')
    assert.equal(ok.mobile.appId, APP_IOS)
    assert.equal(ok.mobile.foregroundVerified, true)
    assert.match(ok.mobile.detail, /native foreground/)

    ios.state.observedAppId = 'com.other'
    const bad = await adapter.evidence('evidence-ios')
    assert.equal(bad.mobile.foregroundVerified, false)
    assert.match(bad.mobile.detail, /com\.other/)
  } finally {
    await adapter.dispose().catch(() => {})
  }
})

test('iOS identifier-less targets route type/fill through the exact semantic selector, including empty fill cleanup', async () => {
  const ios = makeIosBackend()
  const adapter = new IosAdapter(ios.backend)
  try {
    await adapter.start('ios-semantic', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
    ios.state.nodes = [iosNode({ type: 'SearchField', name: 'Search conversations', identifier: undefined, value: 'draft' })]
    const obs = await adapter.observe('ios-semantic')
    const node = obs.nodes.find((n) => n.name === 'Search conversations')
    assert.ok(node)
    assert.equal(node.identifier, undefined, 'the observation still exposes no fabricated identifier')

    const type = await adapter.act('ios-semantic', { kind: 'type', ref: node.ref, text: 'chat' })
    assert.equal(type.status, 'unknown')
    assert.equal(type.dispatched, true)
    const typeCall = ios.calls.find((call) => call[0] === 'typeTarget')
    assert.ok(typeCall)
    assert.equal('identifier' in typeCall[1], false, 'the native target carries no fabricated identifier')
    assert.deepEqual(typeCall[1], {
      udid: DEVICE_IOS,
      bundleId: APP_IOS,
      semantic: { label: 'Search conversations', type: 'SearchField' },
      frame: { x: 10, y: 20, width: 200, height: 50 },
      text: 'chat',
      expectedPID: 10,
      secure: false,
    })
    assert.equal(ios.calls.some((call) => call[0] === 'type'), false, 'no raw global typing fallback')

    // Empty fill is forwarded verbatim (replace-with-empty = field cleanup);
    // the adapter never rejects it and never aliases it to append/global type.
    const fill = await adapter.act('ios-semantic', { kind: 'fill', ref: node.ref, text: '' })
    assert.equal(fill.status, 'unknown')
    assert.equal(fill.dispatched, true)
    const fillCall = ios.calls.find((call) => call[0] === 'fillTarget')
    assert.ok(fillCall)
    assert.equal('identifier' in fillCall[1], false)
    assert.deepEqual(fillCall[1].semantic, { label: 'Search conversations', type: 'SearchField' })
    assert.equal(fillCall[1].text, '', 'empty fill text reaches fillTarget for cleanup')
    assert.equal(ios.calls.some((call) => call[0] === 'type'), false)
  } finally {
    await adapter.dispose().catch(() => {})
  }
})

test('existing native identifiers stay the preferred selector and the old identifier path is unchanged', async () => {
  const ios = makeIosBackend()
  const adapter = new IosAdapter(ios.backend)
  try {
    await adapter.start('ios-id-path', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
    const obs = await adapter.observe('ios-id-path')
    const node = obs.nodes.find((n) => n.identifier === 'qa.input.name')
    const type = await adapter.act('ios-id-path', { kind: 'type', ref: node.ref, text: 'world' })
    assert.equal(type.status, 'unknown')
    assert.equal(type.dispatched, true)
    const call = ios.calls.find((c) => c[0] === 'typeTarget')
    assert.deepEqual(call[1], {
      udid: DEVICE_IOS,
      bundleId: APP_IOS,
      identifier: 'qa.input.name',
      frame: { x: 10, y: 20, width: 200, height: 50 },
      text: 'world',
      expectedPID: 10,
      secure: false,
    })
    assert.equal(call[1].semantic, undefined, 'the identifier path carries no semantic selector')
  } finally {
    await adapter.dispose().catch(() => {})
  }
})

test('a fresh identifier appearing after an identifier-less observation is preferred over the semantic selector', async () => {
  const ios = makeIosBackend()
  const adapter = new IosAdapter(ios.backend)
  try {
    await adapter.start('ios-late-id', { deviceId: DEVICE_IOS, bundleId: APP_IOS })
    ios.state.nodes = [iosNode({ type: 'TextField', name: 'Search conversations', identifier: undefined })]
    const obs = await adapter.observe('ios-late-id')
    const node = obs.nodes.find((n) => n.name === 'Search conversations')
    ios.state.nodes = [iosNode({ type: 'TextField', name: 'Search conversations', identifier: 'qa.late.id' })]
    const type = await adapter.act('ios-late-id', { kind: 'type', ref: node.ref, text: 'hi' })
    assert.equal(type.status, 'unknown')
    assert.equal(type.dispatched, true)
    const call = ios.calls.find((c) => c[0] === 'typeTarget')
    assert.equal(call[1].identifier, 'qa.late.id', 'the fresh native identifier wins over the semantic selector')
    assert.equal(call[1].semantic, undefined)
  } finally {
    await adapter.dispose().catch(() => {})
  }
})

test('iOS identifier-less semantic refusals: ambiguity, label change, frame change, secure, hidden, empty name, non-semantic role', async () => {
  const attempt = async (name, initial, mutate, expectedCode) => {
    const ios = makeIosBackend()
    const adapter = new IosAdapter(ios.backend)
    try {
      await adapter.start(name, { deviceId: DEVICE_IOS, bundleId: APP_IOS })
      ios.state.nodes = initial
      const obs = await adapter.observe(name)
      const node = obs.nodes.find((n) => n.name === initial[0].name)
      mutate(ios)
      const result = await adapter.act(name, { kind: 'type', ref: node.ref, text: 'x' })
      assert.equal(result.status, 'rejected', name + ' must refuse')
      assert.equal(result.code, expectedCode, name + ' code')
      assert.equal(result.dispatched, false)
      assert.equal(ios.calls.some((c) => c[0] === 'typeTarget' || c[0] === 'fillTarget'), false, name + ' never reaches the backend')
      assert.equal(ios.calls.some((c) => c[0] === 'type'), false, name + ' never falls back to global type')
    } finally {
      await adapter.dispose().catch(() => {})
    }
  }

  // Ambiguous fresh tree: two identifier-less nodes with the same role+name.
  await attempt('sem-ambiguous', [iosNode({ type: 'SearchField', name: 'Search conversations', identifier: undefined })], (ios) => {
    ios.state.nodes = [
      iosNode({ type: 'SearchField', name: 'Search conversations', identifier: undefined }),
      iosNode({ type: 'SearchField', name: 'Search conversations', identifier: undefined, frame: { x: 10, y: 100, width: 200, height: 50 } }),
    ]
  }, 'TARGET_NOT_UNIQUE')

  // Label change: the exact observed accessibility name no longer exists.
  await attempt('sem-labelchange', [iosNode({ type: 'SearchField', name: 'Search conversations', identifier: undefined })], (ios) => {
    ios.state.nodes = [iosNode({ type: 'SearchField', name: 'Search direct', identifier: undefined })]
  }, 'TARGET_CHANGED')

  // Frame change: same role+name, moved bounds.
  await attempt('sem-framechange', [iosNode({ type: 'SearchField', name: 'Search conversations', identifier: undefined })], (ios) => {
    ios.state.nodes = [iosNode({ type: 'SearchField', name: 'Search conversations', identifier: undefined, frame: { x: 300, y: 20, width: 200, height: 50 } })]
  }, 'TARGET_CHANGED')

  // Secure fresh target refuses before any backend mutation.
  await attempt('sem-secure', [iosNode({ type: 'SearchField', name: 'Search conversations', identifier: undefined })], (ios) => {
    ios.state.nodes = [iosNode({ type: 'SearchField', name: 'Search conversations', identifier: undefined, secure: true })]
  }, 'SECURE_TARGET')

  // Secure-by-role identifier-less field refuses the same way.
  await attempt('sem-secure-role', [iosNode({ type: 'SecureTextField', name: 'Passcode', identifier: undefined, secure: undefined })], () => {}, 'SECURE_TARGET')

  // Explicitly hidden fresh node is not a semantic candidate.
  await attempt('sem-hidden', [iosNode({ type: 'TextField', name: 'Search conversations', identifier: undefined })], (ios) => {
    ios.state.nodes = [iosNode({ type: 'TextField', name: 'Search conversations', identifier: undefined, visible: false })]
  }, 'TARGET_CHANGED')

  // Empty observed name can never form a semantic label.
  await attempt('sem-empty-name', [iosNode({ type: 'TextField', name: '', identifier: undefined })], () => {}, 'TYPING_PRIMITIVE_UNAVAILABLE')

  // Non-semantic role: no TextField/TextView/SearchField, so no selector.
  await attempt('sem-nonsemantic', [iosNode({ type: 'AXButton', name: 'Search conversations', identifier: undefined })], () => {}, 'TYPING_PRIMITIVE_UNAVAILABLE')
})

test('iOS semantic type mapping forwards TextField/TextView/SearchField for identifier-less targets', async () => {
  const cases = [
    ['AXTextField', 'TextField'],
    ['TextField', 'TextField'],
    ['AXTextArea', 'TextView'],
    ['TextView', 'TextView'],
    ['AXSearchField', 'SearchField'],
    ['SearchField', 'SearchField'],
  ]
  for (const [role, expectedType] of cases) {
    const ios = makeIosBackend()
    const adapter = new IosAdapter(ios.backend)
    try {
      await adapter.start('sem-map-' + role, { deviceId: DEVICE_IOS, bundleId: APP_IOS })
      ios.state.nodes = [iosNode({ type: role, name: 'Search conversations', identifier: undefined })]
      const obs = await adapter.observe('sem-map-' + role)
      const node = obs.nodes.find((n) => n.name === 'Search conversations')
      const result = await adapter.act('sem-map-' + role, { kind: 'type', ref: node.ref, text: 'm' })
      assert.equal(result.status, 'unknown', role + ' routes')
      const call = ios.calls.find((c) => c[0] === 'typeTarget')
      assert.ok(call, role + ' reached typeTarget')
      assert.deepEqual(call[1].semantic, { label: 'Search conversations', type: expectedType }, role + ' semantic type')
    } finally {
      await adapter.dispose().catch(() => {})
    }
  }
})

test('Android identifier-less editable keeps the raw tap-verify-type route and never builds a semantic selector', async () => {
  const android = makeAndroidBackend()
  let focused = false
  android.backend.tap = async (serial, x, y) => { android.calls.push(['tap', serial, x, y]); focused = true }
  android.backend.observe = async (serial, options = {}) => {
    android.calls.push(['observe', serial, options])
    android.state.observeCount += 1
    return {
      serial,
      packageName: APP_ANDROID,
      foreground: { packageName: APP_ANDROID, activity: '.Main', raw: 'x' },
      screen: { width: 1080, height: 2400 },
      coordinateSpace: 'display-pixels',
      nodes: [androidNode({ resourceId: undefined, name: 'Search conversations', text: 'Search conversations', focused })],
      nodeCount: 1,
      truncated: false,
      budgetBytes: 40960,
    }
  }
  const adapter = new AndroidAdapter(android.backend)
  try {
    await adapter.start('android-noid', { deviceId: DEVICE_ANDROID, packageName: APP_ANDROID })
    const obs = await adapter.observe('android-noid')
    const node = obs.nodes.find((n) => n.name === 'Search conversations')
    assert.ok(node)
    assert.equal(node.identifier, undefined)
    const result = await adapter.act('android-noid', { kind: 'type', ref: node.ref, text: 'world' })
    assert.equal(result.status, 'unknown')
    assert.equal(result.dispatched, true)
    const typeCalls = android.calls.filter((c) => c[0] === 'type')
    assert.equal(typeCalls.length, 1)
    assert.equal(typeCalls[0][2], 'world')
    assert.ok(android.calls.some((c) => c[0] === 'tap'), 'identifier-less Android typing taps first exactly like the identified path')
    assert.equal(android.calls.some((c) => c[0] === 'typeTarget' || c[0] === 'fillTarget'), false, 'Android never builds an element-bound/semantic target')
  } finally {
    await adapter.dispose().catch(() => {})
  }
})
