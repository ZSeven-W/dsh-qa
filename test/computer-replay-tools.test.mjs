// Dispatch-path tests for CU replay closure: the SAME adapter-backed computer
// replay must work through BOTH the Cordis tool layer (createQaTools) and the
// MCP server (createQaMcpServer), with a fake ComputerDriver injected through
// the shared loadReplayDriver seam. These prove:
//
//   - qa_replay_run routes a computer scenario to the COMPUTER loader (never
//     the browser loader) and reuses ComputerAdapter, not BrowserManager;
//   - a missing/refused driver surfaces as { ok:false, error } (fail-closed),
//     never a silent success or a swallowed exception;
//   - teardown (driver.dispose) runs on the success path for BOTH dispatch
//     surfaces, and disposeScope runs from the session stop inside runScenario.
//
// No macOS fixture and no real sibling driver is involved: the fake driver
// implements the @zseven-w/dsh-computer ComputerDriver contract directly.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createQaMcpServer } from '../src/mcp-server.ts'
import { createQaTools, QaToolHost } from '../src/tools.ts'

const BUNDLE = 'dev.zseven-w.dshqa.fixture'
const WINDOW_TITLE = 'dsh-qa native fixture'
const SETTLE = { budgetMs: 500, quietMs: 30, postChangeQuietMs: 30, intervalMs: 5, adaptiveBudgetMs: 0 }

function scenario() {
  return {
    meta: { name: 'cu-tools', description: 'd', driver: 'computer', createdAt: '2026-01-01T00:00:00.000Z' },
    target: { launch: BUNDLE, windowTitle: WINDOW_TITLE },
    steps: [
      {
        index: 1,
        intent: 'click the action button',
        action: { kind: 'click', target: { role: 'AXButton', name: 'Action button', tag: 'fixture.actionButton' } },
        assert: { kind: 'node-present', expected: { role: 'AXStaticText', name: 'Done', tag: 'fixture.done' } },
      },
    ],
    assertions: [],
  }
}

function target(ref, role, name, identifier, extra = {}) {
  return { ref, role, subrole: null, name, identifier, frame: null, enabled: true, focused: false, secure: false, actions: role === 'AXButton' ? ['AXPress'] : [], value: null, depth: 2, ...extra }
}

function singleClickDriver() {
  const calls = { observe: [], act: [], disposeScope: [], dispose: 0 }
  let clicked = false
  const driver = {
    kind: 'computer',
    platform: 'macos',
    contractVersion: 4,
    async observe(request) {
      calls.observe.push(request)
      const targets = [target('btn', 'AXButton', 'Action button', 'fixture.actionButton')]
      if (clicked) targets.push(target('done', 'AXStaticText', 'Done', 'fixture.done', { enabled: false, actions: [] }))
      return {
        observationId: 'obs_1', fingerprint: 'fp', capturedAt: 'x', expiresAt: 'y',
        app: { bundleId: BUNDLE, pid: 1, launchIdentity: 'exec:1', name: 'Fixture' },
        window: { number: 1, role: 'AXWindow', subrole: null, title: WINDOW_TITLE, frame: { x: 0, y: 0, width: 400, height: 300 }, identity: 'win' },
        targets, truncated: false, limits: { maxDepth: 4, maxNodes: 200, ttlMs: 15000 },
      }
    },
    async act(action) {
      calls.act.push(action)
      if (action.kind === 'click') clicked = true
      return { receiptId: 'r', sequence: 1, status: 'confirmed', action: action.kind, ref: action.ref, observationId: null, observationFingerprint: null, startedAt: 'a', finishedAt: 'b', reason: 'ok', nativeAccepted: true, postAction: null }
    },
    async evidence() {
      return {
        contractVersion: 4, scope: 'sc',
        status: { platform: 'macos', helper: 'ready', accessibilityTrusted: true, screenRecordingTrusted: true, sessionLocked: false, interactiveSessionAvailable: true, helperVersion: '0.1.0-rc.1', helperExecutable: '/x', identityStable: false, detail: 'ok' },
        activeObservations: 0, activeNativeRequests: 0, receipts: [], receipts_total: 1, receipts_dropped: 0, receipts_returned: 1, bounded: true,
      }
    },
    async disposeScope(scopeId) { calls.disposeScope.push(scopeId) },
    async dispose() { calls.dispose += 1 },
  }
  return { driver, calls }
}

async function writeScenario(dir) {
  const path = join(dir, 'cu.json')
  await writeFile(path, JSON.stringify(scenario()))
  return path
}

test('Cordis qa_replay_run replays a computer scenario through the computer loader and disposes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-cu-cordis-'))
  try {
    const scenarioPath = await writeScenario(dir)
    const { driver, calls } = singleClickDriver()
    let browserLoaderCalled = false
    const host = new QaToolHost({
      settle: SETTLE,
      replayLoaders: {
        browser: async () => { browserLoaderCalled = true; throw new Error('browser loader must not be used for a computer scenario') },
        computer: async () => driver,
      },
    })
    const tools = createQaTools(host)
    const report = await tools.qaReplayRun.execute({ scenario: scenarioPath, owner: 'cordis-cu' }, {})
    assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? report.steps))
    assert.equal(report.driver, 'computer')
    assert.equal(report.steps[0].assertionPassed, true)
    assert.equal(browserLoaderCalled, false, 'computer scenario must route to the computer loader only')
    assert.deepEqual(calls.act.map((a) => a.kind), ['click'])
    assert.equal(calls.disposeScope.length, 1, 'session stop disposes the driver scope')
    assert.equal(calls.dispose, 1, 'seam teardown disposes the driver')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Cordis qa_replay_run fails closed when the computer loader throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-cu-cordis-blocked-'))
  try {
    const scenarioPath = await writeScenario(dir)
    const host = new QaToolHost({
      settle: SETTLE,
      replayLoaders: {
        computer: async () => { throw new Error('computer driver not installed') },
      },
    })
    const tools = createQaTools(host)
    const result = await tools.qaReplayRun.execute({ scenario: scenarioPath, owner: 'cordis-cu-blocked' }, {})
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.match(result.error, /computer driver not installed/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function mcpReplayCall(server, scenarioPath) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'dsh-qa-cu-mcp', version: '0.1.0' })
  await client.connect(clientTransport)
  try {
    const result = await client.callTool({ name: 'qa_replay_run', arguments: { scenario: scenarioPath, owner: 'mcp-cu' } })
    const text = result.content.find((item) => item.type === 'text')?.text
    assert.equal(typeof text, 'string')
    return JSON.parse(text)
  } finally {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

test('MCP qa_replay_run replays a computer scenario through the computer loader and disposes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-cu-mcp-'))
  try {
    const scenarioPath = await writeScenario(dir)
    const { driver, calls } = singleClickDriver()
    const server = createQaMcpServer({ loaders: { computer: async () => driver } })
    const report = await mcpReplayCall(server, scenarioPath)
    assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? report.steps))
    assert.equal(report.driver, 'computer')
    assert.equal(report.steps[0].assertionPassed, true)
    assert.deepEqual(calls.act.map((a) => a.kind), ['click'])
    assert.equal(calls.disposeScope.length, 1, 'session stop disposes the driver scope')
    assert.equal(calls.dispose, 1, 'seam teardown disposes the driver')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('MCP qa_replay_run fails closed when the computer loader throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-cu-mcp-blocked-'))
  try {
    const scenarioPath = await writeScenario(dir)
    const server = createQaMcpServer({ loaders: { computer: async () => { throw new Error('computer driver not installed') } } })
    const result = await mcpReplayCall(server, scenarioPath)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.match(result.error, /computer driver not installed/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
