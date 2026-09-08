// Adapter-backed CU replay through the shared driver factory seam (WP6 closure).
// These prove, at the source level (no Cordis/MCP dispatch, no macOS fixture):
//
//   - scenarioStartOptions maps a computer scenario's launch -> bundleId and
//     the recorded window title -> windowTitle (never PID / window number /
//     coordinates), while a browser scenario keeps url + headless + login state;
//   - loadReplayDriver routes a scenario by meta.driver: computer -> the
//     ComputerAdapter around a ComputerDriver, browser -> the BrowserAdapter,
//     and dispose() tears down the concrete driver the loader produced;
//   - a fake ComputerAdapter-compatible driver replays a computer scenario
//     END-TO-END through runScenario, with the launch identity (bundle id) and
//     window title carried from the scenario target into every observe, the
//     focus/click actions dispatched verbatim, and disposeScope + dispose
//     called on the session-stop + seam-teardown paths.
//
// The fake driver here implements the @zseven-w/dsh-computer ComputerDriver
// contract directly (see computer-adapter.test.mjs for the adapter-level
// safety proofs). The real native fixture acceptance lives in
// computer-integration.test.mjs (macOS + Accessibility grants only).

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadReplayDriver,
  loadScenarioFromPath,
  runScenario,
  scenarioStartOptions,
} from '../src/replay/index.ts'

const BUNDLE = 'dev.zseven-w.dshqa.fixture'
const WINDOW_TITLE = 'dsh-qa native fixture'
const SETTLE = { budgetMs: 500, quietMs: 30, postChangeQuietMs: 30, intervalMs: 5, adaptiveBudgetMs: 0 }

function computerScenario() {
  return {
    meta: { name: 'cu-replay', description: 'd', driver: 'computer', createdAt: '2026-01-01T00:00:00.000Z' },
    target: { launch: BUNDLE, windowTitle: WINDOW_TITLE },
    steps: [
      {
        index: 1,
        intent: 'focus the action button',
        action: { kind: 'focus', target: { role: 'AXButton', name: 'Action button', tag: 'fixture.actionButton' } },
        assert: { kind: 'node-present', expected: { role: 'AXStaticText', name: 'Focused', tag: 'fixture.focused' } },
      },
      {
        index: 2,
        intent: 'click the action button',
        action: { kind: 'click', target: { role: 'AXButton', name: 'Action button', tag: 'fixture.actionButton' } },
        assert: { kind: 'node-present', expected: { role: 'AXStaticText', name: 'Done', tag: 'fixture.done' } },
      },
    ],
    assertions: [],
  }
}

function browserScenario() {
  return {
    meta: { name: 'bu-replay', description: 'd', driver: 'browser', createdAt: '2026-01-01T00:00:00.000Z' },
    target: { launch: 'http://127.0.0.1:1/' },
    steps: [
      {
        index: 1,
        intent: 'click',
        action: { kind: 'click', target: { role: 'button', name: 'Go' } },
        assert: { kind: 'node-present', expected: { role: 'status', name: 'Done' } },
      },
    ],
    assertions: [],
  }
}

function computerTarget(ref, role, name, identifier, extra = {}) {
  return {
    ref,
    role,
    subrole: null,
    name,
    identifier,
    frame: null,
    enabled: true,
    focused: false,
    secure: false,
    actions: role === 'AXButton' ? ['AXPress'] : [],
    value: null,
    depth: 2,
    ...extra,
  }
}

// A ComputerDriver that reveals a "Focused" status after focus and a "Done"
// status after click, and records every request for the assertions below.
function replayDriver() {
  const calls = { observe: [], act: [], evidence: [], disposeScope: [], dispose: 0 }
  let focused = false
  let clicked = false
  const observation = () => {
    const targets = [computerTarget('btn', 'AXButton', 'Action button', 'fixture.actionButton')]
    if (focused) targets.push(computerTarget('s-focused', 'AXStaticText', 'Focused', 'fixture.focused', { enabled: false, actions: [] }))
    if (clicked) targets.push(computerTarget('s-done', 'AXStaticText', 'Done', 'fixture.done', { enabled: false, actions: [] }))
    return {
      observationId: 'obs_1',
      fingerprint: 'fp1',
      capturedAt: 'x',
      expiresAt: 'y',
      app: { bundleId: BUNDLE, pid: 4242, launchIdentity: 'exec:123', name: 'Fixture' },
      window: { number: 7, role: 'AXWindow', subrole: 'AXStandardWindow', title: WINDOW_TITLE, frame: { x: 0, y: 0, width: 400, height: 300 }, identity: 'win-id' },
      targets,
      truncated: false,
      limits: { maxDepth: 4, maxNodes: 200, ttlMs: 15000 },
    }
  }
  const driver = {
    kind: 'computer',
    platform: 'macos',
    contractVersion: 4,
    async observe(request, context) {
      calls.observe.push({ request, context })
      return observation()
    },
    async act(action, context) {
      calls.act.push({ action, context })
      if (action.kind === 'focus') focused = true
      if (action.kind === 'click') clicked = true
      return {
        receiptId: 'rc', sequence: 1, status: 'confirmed', action: action.kind, ref: action.ref,
        observationId: null, observationFingerprint: null, startedAt: 'a', finishedAt: 'b',
        reason: 'ok', nativeAccepted: true, postAction: null,
      }
    },
    async evidence(context, options) {
      calls.evidence.push({ context, options })
      return {
        contractVersion: 4, scope: 'sc',
        status: { platform: 'macos', helper: 'ready', accessibilityTrusted: true, screenRecordingTrusted: true, sessionLocked: false, interactiveSessionAvailable: true, helperVersion: '0.1.0-rc.1', helperExecutable: '/x', identityStable: false, detail: 'ok' },
        activeObservations: 0, activeNativeRequests: 0, receipts: [],
        receipts_total: 2, receipts_dropped: 0, receipts_returned: 2, bounded: true,
      }
    },
    async disposeScope(scopeId) { calls.disposeScope.push(scopeId) },
    async dispose() { calls.dispose += 1 },
  }
  return { driver, calls }
}

test('scenarioStartOptions maps computer launch + window title and keeps browser url + headless', () => {
  assert.deepEqual(
    scenarioStartOptions(computerScenario(), BUNDLE, true),
    { bundleId: BUNDLE, windowTitle: WINDOW_TITLE },
    'computer: bundleId + durable window title; headless is ignored (no browser)',
  )
  assert.deepEqual(
    scenarioStartOptions({ ...computerScenario(), target: { launch: BUNDLE } }, BUNDLE),
    { bundleId: BUNDLE },
    'computer without a recorded window title binds bundle id only',
  )
  assert.deepEqual(
    scenarioStartOptions(browserScenario(), 'http://127.0.0.1:2/', false),
    { url: 'http://127.0.0.1:2/', headless: false },
    'browser: url + headless, no bundle/window fields',
  )
})

test('loadReplayDriver routes by driver kind and disposes the concrete driver through the seam', async () => {
  let computerDisposed = 0
  const fakeComputer = { kind: 'computer', platform: 'macos', contractVersion: 4, async disposeScope() {}, async dispose() { computerDisposed += 1 } }
  const computerLoaded = await loadReplayDriver(computerScenario(), {
    loaders: { computer: async () => fakeComputer },
  })
  assert.equal(computerLoaded.adapter.kind, 'computer')
  await computerLoaded.dispose()
  assert.equal(computerDisposed, 1, 'computer seam teardown disposes the ComputerDriver')

  let browserDisposed = 0
  let browserOptions = null
  const fakeBrowserManager = { async dispose() { browserDisposed += 1 } }
  const browserLoaded = await loadReplayDriver(browserScenario(), {
    loaders: {
      browser: async (specifier, options) => {
        browserOptions = { specifier, options }
        return fakeBrowserManager
      },
    },
  })
  assert.equal(browserLoaded.adapter.kind, 'browser')
  assert.deepEqual(browserOptions.options.allowedOrigins, ['http://127.0.0.1:1'], 'browser seam keeps origin allow-listing')
  await browserLoaded.dispose()
  assert.equal(browserDisposed, 1, 'browser seam teardown disposes the browser manager')
})

test('a throwing computer loader propagates (missing driver) instead of being swallowed', async () => {
  await assert.rejects(
    loadReplayDriver(computerScenario(), {
      loaders: { computer: async () => { throw new Error('computer driver not installed') } },
    }),
    /computer driver not installed/,
  )
})

test('a computer scenario replays end-to-end through ComputerAdapter with binding + action dispatch + cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-cu-replay-'))
  try {
    const scenarioPath = join(dir, 'cu.json')
    await writeFile(scenarioPath, JSON.stringify(computerScenario()))
    const scenario = loadScenarioFromPath(scenarioPath)

    const { driver, calls } = replayDriver()
    const loaded = await loadReplayDriver(scenario, { loaders: { computer: async () => driver } })
    try {
      const report = await runScenario(scenario, loaded.adapter, { ownerId: 'replay-cu', settle: SETTLE })
      assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? report.steps))
      assert.equal(report.driver, 'computer')
      assert.equal(report.steps.length, 2)
      assert.ok(report.steps.every((step) => step.assertionPassed === true))

      // Launch identity + window target carry from the recorded trajectory into
      // EVERY observe request (the durable selector, never a PID/coord guess).
      assert.ok(calls.observe.length >= 1)
      for (const { request } of calls.observe) {
        assert.equal(request.app.bundleId, BUNDLE, 'bundle id binding carried to observe')
        assert.equal(request.window.title, WINDOW_TITLE, 'window title binding carried to observe')
      }
      // The focus/click verbs dispatch verbatim through the adapter.
      const kinds = calls.act.map(({ action }) => action.kind)
      assert.deepEqual(kinds, ['focus', 'click'], 'focus then click dispatched verbatim')
    } finally {
      await loaded.dispose()
    }
    // session.stop() disposed the scope; the seam dispose() tore down the driver.
    assert.equal(calls.disposeScope.length, 1, 'session stop disposes the driver scope')
    assert.equal(calls.dispose, 1, 'seam teardown disposes the driver exactly once')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
