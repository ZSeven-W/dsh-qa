import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createQaMcpServer } from '../src/mcp-server.ts'

function fakeAdapter(kind = 'ios') {
  let disposed = 0
  let started = false
  const adapter = {
    kind,
    async start() { started = true; return { page: { url: 'ios://fixture', title: 'fixture' } } },
    async observe() { return { page: { url: 'ios://fixture', title: 'fixture' }, nodes: [], truncated: false } },
    async act() { return { status: 'confirmed', dispatched: true, nativeAccepted: true } },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'mock-stop' } },
    async dispose() { disposed += 1 },
    get started() { return started },
    get disposed() { return disposed },
  }
  return adapter
}

function fakeBackend(dispose) {
  return {
    async launchApp() { return { ok: true, udid: 'device', backend: 'simulator', action: 'launchApp' } },
    async observe() { return { udid: 'device', backend: 'simulator', app: { verified: true, bundleId: 'fixture' }, screen: { width: 1, height: 1 }, nodes: [], truncated: false, depth: 0, maxNodes: 10 } },
    async dispose() { await dispose() },
  }
}

const replayScenario = {
  meta: { name: 'shutdown-replay', description: 'test', driver: 'browser', createdAt: '2026-01-01T00:00:00.000Z' },
  target: { launch: 'http://127.0.0.1:1/' },
  steps: [{ index: 1, intent: 'click', action: { kind: 'click', target: { role: 'button', name: 'Go' } }, assert: { kind: 'node-present', expected: { role: 'status', name: 'Done' } } }],
  assertions: [],
}

function iosReplayScenario(deviceId) {
  return {
    meta: { name: 'shutdown-ios-replay', description: 'test', driver: 'ios', createdAt: '2026-01-01T00:00:00.000Z' },
    target: { launch: 'fixture', deviceId },
    steps: [],
    assertions: [],
  }
}

function replayManager({ onObserve, onDispose } = {}) {
  let clicked = false
  const node = (role, name) => ({ ref: role + name, role, name, tag: '', frame: { x: 0, y: 0, width: 10, height: 10 }, enabled: true, focused: false, secure: false, value: null, actions: [] })
  return {
    async start() { return { page: { url: 'http://127.0.0.1:1/', title: 'fixture' }, headless: true } },
    async observe() { await onObserve?.(); return { page: { url: 'http://127.0.0.1:1/', title: 'fixture' }, targets: [node('button', 'Go'), ...(clicked ? [node('status', 'Done')] : [])], truncated: false, limits: { maxDepth: 4, maxNodes: 100, ttlMs: 10000 } } },
    async act(action) { clicked = action.kind === 'click'; return { receiptId: 'r', sequence: 1, status: 'confirmed', action: action.kind, dispatched: true, startedAt: 'a', finishedAt: 'b', nativeAccepted: true, postAction: null } },
    async evidence() { return { contractVersion: 4, bounded: true, receipts: [] } },
    async disposeScope() {},
    async dispose() { await onDispose?.() },
  }
}

async function connectMcp(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'replay-shutdown-test', version: '1' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, clientTransport }
}

async function writeReplayScenario() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-replay-shutdown-'))
  const path = join(dir, 'scenario.json')
  await writeFile(path, JSON.stringify(replayScenario))
  return { dir, path }
}

test('MCP close awaits every initialized manager disposal exactly once', async () => {
  const adapter = fakeAdapter()
  const server = createQaMcpServer({ adapters: { ios: adapter } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'shutdown-test', version: '1' }, { capabilities: {} })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  await client.callTool({ name: 'qa_session_start', arguments: { owner: 'one', driver: 'ios', bundle_id: 'fixture' } })
  await client.callTool({ name: 'qa_session_start', arguments: { owner: 'two', driver: 'ios', bundle_id: 'fixture' } })
  assert.equal(adapter.started, true)
  await server.close()
  assert.equal(adapter.disposed, 1)
  await server.dispose()
  assert.equal(adapter.disposed, 1)
  await client.close()
})

test('MCP close disposes managers still being created and exposes disposal failures', async () => {
  let disposed = 0
  const adapter = fakeAdapter()
  adapter.dispose = async () => { disposed += 1; throw new Error('cleanup failed') }
  const server = createQaMcpServer({ adapters: { ios: adapter } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'shutdown-test', version: '1' }, { capabilities: {} })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  await client.callTool({ name: 'qa_session_start', arguments: { owner: 'one', driver: 'ios', bundle_id: 'fixture' } })
  await assert.rejects(() => server.close(), /cleanup failed/)
  assert.equal(disposed, 1)
  await client.close()
})

test('MCP close awaits a delayed iOS manager creation before disposing its backend', async () => {
  let resolveLoader
  let disposed = 0
  const delayedLoader = () => new Promise(resolve => { resolveLoader = resolve })
  const server = createQaMcpServer({ loaders: { ios: delayedLoader } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'shutdown-test', version: '1' }, { capabilities: {} })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const start = client.callTool({ name: 'qa_session_start', arguments: { owner: 'late', driver: 'ios', bundle_id: 'fixture', device_id: 'device' } }).catch(() => undefined)
  await new Promise(resolve => setImmediate(resolve))
  const closing = server.close()
  resolveLoader(fakeBackend(async () => { disposed += 1 }))
  await closing
  await start
  assert.equal(disposed, 1)
  await client.close()
})

test('MCP close disposes a replay loader that resolves after shutdown and never starts its run', async () => {
  const { dir, path } = await writeReplayScenario()
  try {
    let resolveLoader
    let disposed = 0
    let observed = 0
    const server = createQaMcpServer({ loaders: { browser: async () => new Promise(resolve => { resolveLoader = resolve }) } })
    const { client } = await connectMcp(server)
    const replay = client.callTool({ name: 'qa_replay_run', arguments: { scenario: path, owner: 'pending-replay' } }).catch(() => undefined)
    await new Promise(resolve => setImmediate(resolve))
    const closing = server.close()
    resolveLoader({
      async start() { return { page: { url: 'http://127.0.0.1:1/', title: 'fixture' }, headless: true } },
      async observe() { observed += 1; return { page: { url: 'http://127.0.0.1:1/', title: 'fixture' }, targets: [], truncated: false, limits: { maxDepth: 4, maxNodes: 100, ttlMs: 10000 } } },
      async act() { throw new Error('replay must not start after close') },
      async evidence() { return { bounded: true, receipts: [] } },
      async dispose() { disposed += 1 },
    })
    await closing
    await replay
    assert.equal(disposed, 1)
    assert.equal(observed, 0)
    await client.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('MCP close disposes an active replay exactly once while its run is observing', async () => {
  const { dir, path } = await writeReplayScenario()
  try {
    let observeStarted
    const observeGate = new Promise(resolve => { observeStarted = resolve })
    let releaseObserve
    let disposed = 0
    const server = createQaMcpServer({ loaders: { browser: async () => replayManager({ onObserve: async () => { observeStarted(); await new Promise(resolve => { releaseObserve = resolve }) }, onDispose: async () => { disposed += 1; releaseObserve?.() } }) } })
    const { client } = await connectMcp(server)
    const replay = client.callTool({ name: 'qa_replay_run', arguments: { scenario: path, owner: 'active-replay' } }).catch(() => undefined)
    await observeGate
    await server.close()
    await replay
    assert.equal(disposed, 1)
    await client.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('MCP shutdown releases active replay before an unrelated Explore loader resolves', async () => {
  const { dir, path } = await writeReplayScenario()
  try {
    let resolveExplore
    const delayedExplore = () => new Promise(resolve => { resolveExplore = resolve })
    let observeStarted
    const observeGate = new Promise(resolve => { observeStarted = resolve })
    let releaseObserve
    let replayDisposed = false
    const server = createQaMcpServer({
      loaders: {
        ios: delayedExplore,
        browser: async () => replayManager({ onObserve: async () => { observeStarted(); await new Promise(resolve => { releaseObserve = resolve }) }, onDispose: async () => { replayDisposed = true; releaseObserve?.() } }),
      },
    })
    const { client } = await connectMcp(server)
    const explore = client.callTool({ name: 'qa_session_start', arguments: { owner: 'pending-explore', driver: 'ios', bundle_id: 'fixture', device_id: 'device' } }).catch(() => undefined)
    await new Promise(resolve => setImmediate(resolve))
    const replay = client.callTool({ name: 'qa_replay_run', arguments: { scenario: path, owner: 'active-replay' } }).catch(() => undefined)
    await observeGate
    const closing = server.close()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(replayDisposed, true, 'active replay must dispose while Explore loader is still pending')
    resolveExplore(fakeBackend(async () => {}))
    await closing
    await Promise.all([explore, replay])
    await client.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('MCP close completes after disposing a replay whose observe never resolves', async () => {
  const { dir, path } = await writeReplayScenario()
  try {
    let observed
    const observedGate = new Promise(resolve => { observed = resolve })
    let disposed = 0
    const server = createQaMcpServer({ loaders: { browser: async () => ({
      async start() { return { page: { url: 'http://127.0.0.1:1/', title: 'fixture' }, headless: true } },
      async observe() { observed(); return new Promise(() => {}) },
      async act() { return { status: 'confirmed', dispatched: true, nativeAccepted: true } },
      async evidence() { return { bounded: true, receipts: [] } },
      async dispose() { disposed += 1 },
    }) } })
    const { client } = await connectMcp(server)
    client.callTool({ name: 'qa_replay_run', arguments: { scenario: path, owner: 'hung-replay' } }).catch(() => undefined)
    await observedGate
    await server.close()
    assert.equal(disposed, 1)
    await client.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('MCP close disposes two active replay backends independently and only once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-replay-two-'))
  try {
    const firstPath = join(dir, 'first.json')
    const secondPath = join(dir, 'second.json')
    await writeFile(firstPath, JSON.stringify(replayScenario))
    await writeFile(secondPath, JSON.stringify(replayScenario))
    let loaderCount = 0
    let firstObserved
    let secondObserved
    const firstGate = new Promise(resolve => { firstObserved = resolve })
    const secondGate = new Promise(resolve => { secondObserved = resolve })
    let firstDisposed = 0
    let secondDisposed = 0
    const backend = (which) => ({
      async start() { return { page: { url: 'http://127.0.0.1:1/', title: 'fixture' }, headless: true } },
      async observe() {
        if (which === 'first') firstObserved()
        else secondObserved()
        return new Promise(() => {})
      },
      async dispose() {
        if (which === 'first') { firstDisposed += 1; throw new Error('first replay cleanup failed') }
        secondDisposed += 1
      },
    })
    const server = createQaMcpServer({ loaders: { browser: async () => backend(loaderCount++ === 0 ? 'first' : 'second') } })
    const { client } = await connectMcp(server)
    const first = client.callTool({ name: 'qa_replay_run', arguments: { scenario: firstPath, owner: 'replay-a', device_id: 'device-a' } }).catch(() => undefined)
    const second = client.callTool({ name: 'qa_replay_run', arguments: { scenario: secondPath, owner: 'replay-b', device_id: 'device-b' } }).catch(() => undefined)
    await Promise.all([firstGate, secondGate])
    await assert.rejects(() => server.close(), /first replay cleanup failed/)
    // The two replay promises intentionally remain blocked in observe; the
    // shutdown contract is that resource disposal completes without awaiting
    // those business promises.
    void first
    void second
    assert.equal(firstDisposed, 1)
    assert.equal(secondDisposed, 1)
    await assert.rejects(() => server.dispose(), /first replay cleanup failed/)
    assert.equal(firstDisposed, 1)
    assert.equal(secondDisposed, 1)
    await client.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('MCP disposal attempts iOS and Android managers after the first failure and repeats the same error', async () => {
  const ios = fakeAdapter()
  const android = fakeAdapter('android')
  let iosDisposed = 0
  let androidDisposed = 0
  ios.dispose = async () => { iosDisposed += 1; throw new Error('ios cleanup failed') }
  android.dispose = async () => { androidDisposed += 1 }
  const server = createQaMcpServer({ adapters: { ios, android } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'shutdown-test', version: '1' }, { capabilities: {} })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  await client.callTool({ name: 'qa_session_start', arguments: { owner: 'ios', driver: 'ios', bundle_id: 'fixture' } })
  await client.callTool({ name: 'qa_session_start', arguments: { owner: 'android', driver: 'android', package_name: 'fixture' } })
  await assert.rejects(() => server.close(), /ios cleanup failed/)
  assert.equal(iosDisposed, 1)
  assert.equal(androidDisposed, 1)
  await assert.rejects(() => server.dispose(), /ios cleanup failed/)
  assert.equal(iosDisposed, 1)
  assert.equal(androidDisposed, 1)
  await client.close()
})

test('standalone stdio entrypoint closes on EOF and SIGTERM without forced exit', async () => {
  const root = new URL('..', import.meta.url).pathname
  const runChild = async (signal) => {
    const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
    if (signal === undefined) child.stdin.end()
    else {
      await new Promise(resolve => child.once('spawn', resolve))
      await new Promise(resolve => setTimeout(resolve, 1000))
      child.kill(signal)
    }
    const result = await new Promise(resolve => {
      child.once('error', error => resolve({ error, code: null, signal: null }))
      child.once('close', (code, exitSignal) => resolve({ error: null, code, signal: exitSignal }))
    })
    clearTimeout(timeout)
    assert.equal(result.error, null)
    assert.equal(result.signal, null, `child was force-signalled: ${String(result.signal)}`)
    assert.equal(result.code, 0)
  }
  await runChild(undefined)
  await runChild('SIGTERM')
})
