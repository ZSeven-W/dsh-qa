// CU v5 visual-action integration tests.
//
// These use fake ComputerDriver implementations (never a real macOS helper or
// live model) plus a structurally valid PNG generated in-process. They cover
// the qa_act visual point route in BOTH the Cordis tool surface and the MCP
// server, the ComputerAdapter -> driver.visualAct mapping, approval
// fail-closed behavior, unknown-no-retry semantics, and replay re-grounding on
// fresh screenshots with different coordinates across runs.
//
// No real host, credentials, model service, or 8-byte PNG signature is treated
// as acceptance.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createQaMcpServer } from '../src/mcp-server.ts'
import { createQaTools, QaToolHost } from '../src/tools.ts'
import { ComputerAdapter } from '../src/adapters/computer.ts'
import { runScenario } from '../src/replay/index.ts'
import { loadReplayDriver } from '../src/replay/index.ts'
import { QaSession } from '../src/session/index.ts'
import {
  exportRecordedScenario,
  QaTrajectoryRecorder,
  RecordingQaDriverAdapter,
} from '../src/explore/index.ts'

const BUNDLE = 'dev.zseven.qa.visual.fixture'
const WINDOW_TITLE = 'DSH QA Visual Fixture'
const SETTLE = { budgetMs: 300, quietMs: 20, postChangeQuietMs: 20, intervalMs: 4, adaptiveBudgetMs: 0 }

// ---------------------------------------------------------------------------
// Minimal valid PNG builder (reused from visual-grounding tests).
// ---------------------------------------------------------------------------

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function makePng(width = 400, height = 300) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) raw[y * (width * 4 + 1)] = 0
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}

// ---------------------------------------------------------------------------
// Fake ComputerDriver with optional approval behavior.
// ---------------------------------------------------------------------------

function cnode(ref, role, name, tag, extra = {}) {
  return { ref, role, subrole: null, name, identifier: tag, frame: null, enabled: role !== 'AXStaticText', focused: false, secure: false, actions: role === 'AXButton' ? ['AXPress'] : [], value: null, depth: 2, ...extra }
}

function fakeDriver({ approval = 'unavailable', onVisualAct } = {}) {
  const calls = { observe: 0, visualObserve: 0, visualAct: [], act: [], disposeScope: [], dispose: 0 }
  const png = makePng(400, 300)
  const sha256 = createHash('sha256').update(png).digest('hex')
  let clicked = false
  let sequence = 0
  const driver = {
    kind: 'computer',
    platform: 'macos',
    contractVersion: 5,
    async observe(request, context) {
      calls.observe += 1
      const observationId = 'obs_' + calls.observe
      const targets = [cnode('press', 'AXButton', 'Press Me', 'qa.visual.press'), cnode('status', 'AXStaticText', clicked ? 'Changed' : 'Ready', 'qa.visual.status', { enabled: false, actions: [] })]
      return {
        observationId,
        fingerprint: 'fp_' + calls.observe,
        capturedAt: '2026-09-07T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        app: { bundleId: BUNDLE, pid: 42, launchIdentity: 'exec:42', name: 'QA Visual Fixture' },
        window: { number: 1, role: 'AXWindow', subrole: null, title: WINDOW_TITLE, frame: { x: 0, y: 0, width: 400, height: 300 }, identity: 'win' },
        targets,
        truncated: false,
        limits: { maxDepth: 8, maxNodes: 500, ttlMs: 30000 },
      }
    },
    async visualObserve(request, context) {
      calls.visualObserve += 1
      return {
        observationId: request.observationId,
        observationFingerprint: 'fp_visual_' + calls.visualObserve,
        capturedAt: '2026-09-07T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        app: { bundleId: BUNDLE, pid: 42, launchIdentity: 'exec:42', name: 'QA Visual Fixture' },
        window: { number: 1, role: 'AXWindow', subrole: null, title: WINDOW_TITLE, frame: { x: 0, y: 0, width: 400, height: 300 }, identity: 'win' },
        png,
        capture: {
          artifact: { format: 'png', byteLength: png.byteLength, sha256 },
          pointFrame: { x: 0, y: 0, width: 400, height: 300 },
          pixelWidth: 400,
          pixelHeight: 300,
          scaleX: 1,
          scaleY: 1,
          quality: { classification: 'usable', usable: true, sampleCount: 1, visibleFraction: 1, meanLuminance: 0, luminanceVariance: 0, luminanceRange: 0, darkFraction: 0, lightFraction: 0, distinctColorBuckets: 1 },
        },
        marks: [],
        omitted: [],
      }
    },
    async act(action, context) {
      calls.act.push(action)
      if (action.kind === 'click') clicked = true
      return { receiptId: 'r' + (++sequence), sequence, status: 'confirmed', action: action.kind, ref: action.ref, observationId: null, observationFingerprint: null, startedAt: 'a', finishedAt: 'b', reason: '', nativeAccepted: true, postAction: null }
    },
    async visualAct(action, context) {
      calls.visualAct.push({ action, approvalPresent: context?.approval !== undefined })
      if (context?.approval === undefined) {
        return { receiptId: 'r' + (++sequence), sequence, status: 'rejected', action: action.op, observationId: action.observationId, observationFingerprint: null, captureSha256: action.captureSha256, startedAt: 'a', finishedAt: 'b', reason: 'host approval is unavailable', nativeAccepted: false, postAction: null }
      }
      const outcome = await context.approval.request('visual action ' + action.op)
      if (outcome !== 'allowed-once') {
        return { receiptId: 'r' + (++sequence), sequence, status: 'rejected', action: action.op, observationId: action.observationId, observationFingerprint: null, captureSha256: action.captureSha256, startedAt: 'a', finishedAt: 'b', reason: 'approval was not granted (' + outcome + ')', nativeAccepted: false, postAction: null }
      }
      clicked = true
      if (onVisualAct) onVisualAct(action)
      return { receiptId: 'r' + (++sequence), sequence, status: 'unknown', action: action.op, observationId: action.observationId, observationFingerprint: 'fp_visual', captureSha256: action.captureSha256, startedAt: 'a', finishedAt: 'b', reason: 'dispatched', nativeAccepted: true, postAction: null }
    },
    async evidence(context, options) {
      return {
        contractVersion: 5,
        scope: context.scopeId,
        status: { platform: 'macos', helper: 'ready', accessibilityTrusted: true, screenRecordingTrusted: true, sessionLocked: false, interactiveSessionAvailable: true, helperVersion: '0.1.0-rc.1', helperExecutable: '/x', identityStable: false, detail: 'ok' },
        activeObservations: 0,
        activeNativeRequests: 0,
        receipts: [],
        receipts_total: sequence,
        receipts_dropped: 0,
        receipts_returned: sequence,
        bounded: true,
      }
    },
    async disposeScope(scopeId) { calls.disposeScope.push(scopeId) },
    async dispose() { calls.dispose += 1 },
  }
  return { driver, calls }
}

// ---------------------------------------------------------------------------
// Fake llm/attachments services for textual grounding.
// ---------------------------------------------------------------------------

function fakeAttachments() {
  return {
    async saveImage(input) {
      return { attachmentId: 'att_visual', mediaType: 'image/png', bytes: input.data.byteLength, width: 400, height: 300, name: input.name }
    },
  }
}

function fakeLlm({ outputs = ['{"x":500,"y":500,"confidence":0.95}'] } = {}) {
  let i = 0
  return {
    async *stream(options) {
      const output = outputs[Math.min(i, outputs.length - 1)]
      i += 1
      yield { type: 'text-delta', text: output }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

function fakeServices({ outputs } = {}) {
  return { attachments: fakeAttachments(), llm: fakeLlm({ outputs }) }
}

const allowedApproval = { async request() { return 'allowed-once' } }
const rejectedApproval = { async request() { return 'rejected' } }

// ---------------------------------------------------------------------------
// MCP client helper.
// ---------------------------------------------------------------------------

async function callMCP(server, name, args) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'dsh-qa-cu-visual-mcp', version: '0.1.0' })
  await client.connect(clientTransport)
  try {
    const result = await client.callTool({ name, arguments: args })
    const text = result.content.find((item) => item.type === 'text')?.text
    assert.equal(typeof text, 'string')
    return JSON.parse(text)
  } finally {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

async function mcpVisualEvidence(server, owner) {
  await callMCP(server, 'qa_session_start', { owner, driver: 'computer', bundle_id: BUNDLE, window_title: WINDOW_TITLE })
  const ev = await callMCP(server, 'qa_evidence', { owner, visual: true })
  return ev.visual
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('MCP qa_act visual point route maps trusted native-file pixels to driver.visualAct and unavailable approval rejects no dispatch', async () => {
  const { driver, calls } = fakeDriver({ approval: 'unavailable' })
  const server = createQaMcpServer({ adapters: { computer: new ComputerAdapter(driver) } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'dsh-qa-cu-visual-mcp', version: '0.1.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args })
      const text = result.content.find((item) => item.type === 'text')?.text
      assert.equal(typeof text, 'string')
      return JSON.parse(text)
    }
    await call('qa_session_start', { owner: 'mcp-unavailable', driver: 'computer', bundle_id: BUNDLE, window_title: WINDOW_TITLE })
    const evidence = await call('qa_evidence', { owner: 'mcp-unavailable', visual: true })
    const visual = evidence.visual
    assert.equal(visual.coordinateSpace, 'native')
    const result = await call('qa_act', {
      owner: 'mcp-unavailable',
      action: 'visual_click',
      target_description: 'the Press Me control',
      capture_sha256: visual.sha256,
      observation_id: visual.observationId,
      point: { x: 200, y: 150 },
    })
    assert.equal(result.receipt.status, 'rejected')
    assert.equal(result.receipt.code, 'APPROVAL_REQUIRED')
    assert.equal(result.receipt.dispatched, false)
    assert.equal(calls.visualAct.length, 1)
    assert.equal(calls.visualAct[0].approvalPresent, false)
  } finally {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }
})

test('Cordis qa_act visual point route forwards host approval and dispatches exactly once; unknown receipt re-observes without retry', async () => {
  const { driver, calls } = fakeDriver()
  const host = new QaToolHost({
    managerAdapters: { computer: new ComputerAdapter(driver) },
    getService: (name) => name === 'approval' ? allowedApproval : undefined,
    settle: SETTLE,
  })
  const tools = createQaTools(host)
  const exec = { agent: { id: 'owner' }, callId: 'call-1' }
  await tools.qaSessionStart.execute({ owner: 'owner', driver: 'computer', bundle_id: BUNDLE, window_title: WINDOW_TITLE }, exec)
  const evidence = await tools.qaEvidence.execute({ owner: 'owner', visual: true }, exec)
  const visual = evidence.visual
  const result = await tools.qaAct.execute({
    owner: 'owner',
    action: 'visual_click',
    target_description: 'the Press Me control',
    capture_sha256: visual.sha256,
    observation_id: visual.observationId,
    point: { x: 100, y: 75 },
  }, exec)
  assert.equal(result.receipt.status, 'unknown')
  assert.equal(result.receipt.dispatched, true)
  assert.equal(result.outcome, 'unknown')
  assert.equal(calls.visualAct.length, 1, 'unknown is never retried')
  assert.equal(calls.visualAct[0].approvalPresent, true)
  assert.deepEqual(calls.visualAct[0].action.point, { x: 100, y: 75 }, 'native-file point route is identity mapped with no model scale')
})

test('wrong capture/observation binding and out-of-bounds points reject before any dispatch', async () => {
  const { driver, calls } = fakeDriver({ approval: 'allowed' })
  const host = new QaToolHost({ managerAdapters: { computer: new ComputerAdapter(driver) } })
  const tools = createQaTools(host)
  const exec = { agent: { id: 'owner2' }, callId: 'call-2' }
  await tools.qaSessionStart.execute({ owner: 'owner2', driver: 'computer', bundle_id: BUNDLE, window_title: WINDOW_TITLE }, exec)
  const evidence = await tools.qaEvidence.execute({ owner: 'owner2', visual: true }, exec)
  const visual = evidence.visual
  const wrongObs = await tools.qaAct.execute({
    owner: 'owner2', action: 'visual_click', target_description: 'x',
    capture_sha256: visual.sha256, observation_id: 'not-the-bound-observation', point: { x: 10, y: 10 },
  }, exec)
  assert.equal(wrongObs.ok, false)
  assert.match(wrongObs.error, /not bound to observation_id/)
  const outOfBounds = await tools.qaAct.execute({
    owner: 'owner2', action: 'visual_click', target_description: 'x',
    capture_sha256: visual.sha256, observation_id: visual.observationId, point: { x: 99999, y: 99999 },
  }, exec)
  assert.equal(outOfBounds.ok, false)
  assert.match(outOfBounds.error, /outside/)
  assert.equal(calls.visualAct.length, 0, 'no dispatch on binding or bounds failure')
})

test('textual grounding route rejects invalid model replies and never dispatches', async () => {
  const { driver, calls } = fakeDriver()
  const host = new QaToolHost({
    managerAdapters: { computer: new ComputerAdapter(driver) },
    getService: (name) => name === 'approval' ? allowedApproval : undefined,
    settle: SETTLE,
  })
  const tools = createQaTools(host)
  const exec = { agent: { id: 'owner3' }, callId: 'call-3' }
  const services = { attachments: fakeAttachments(), llm: fakeLlm({ outputs: ['{"x":10,"y":20,"width":999,"height":888}'] }) }
  const host2 = new QaToolHost({
    managerAdapters: { computer: new ComputerAdapter(driver) },
    getService: (name) => {
      if (name === 'approval') return allowedApproval
      if (name === 'attachments') return services.attachments
      if (name === 'llm') return services.llm
      return undefined
    },
    settle: SETTLE,
  })
  const tools2 = createQaTools(host2)
  await tools2.qaSessionStart.execute({ owner: 'owner3', driver: 'computer', bundle_id: BUNDLE, window_title: WINDOW_TITLE }, exec)
  const result = await tools2.qaAct.execute({
    owner: 'owner3', action: 'visual_click', target_description: 'the Press Me control',
  }, exec)
  assert.equal(result.ok, false)
  assert.match(result.error, /grounding failed/)
  assert.equal(calls.visualAct.length, 0)
})

test('scenario loader and replay re-ground a visual click on a fresh screenshot with different coordinates across runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-cu-visual-replay-'))
  try {
    const { driver: driver1, calls: calls1 } = fakeDriver()
    const { driver: driver2, calls: calls2 } = fakeDriver()
    const scenario = {
      meta: { name: 'visual-replay', description: 'd', driver: 'computer', createdAt: '2026-09-07T00:00:00.000Z' },
      target: { launch: BUNDLE, windowTitle: WINDOW_TITLE },
      steps: [
        {
          index: 1,
          intent: 'Visually click the Press Me control.',
          action: { kind: 'visual_click', targetDescription: 'the Press Me control', provenance: { source: 'model-grounding', provider: 'fake', model: 'fake-vision' } },
          assert: { kind: 'node-present', expected: { role: 'AXStaticText', name: 'Changed', tag: 'qa.visual.status' } },
        },
      ],
      assertions: [],
    }
    const path = join(dir, 'visual.json')
    await writeFile(path, JSON.stringify(scenario))

    const adapter1 = new ComputerAdapter(driver1)
    const report1 = await runScenario(scenario, adapter1, {
      ownerId: 'visual-run-1',
      visual: fakeServices({ outputs: ['{"x":500,"y":500,"confidence":0.9}'] }),
      approval: allowedApproval,
      settle: SETTLE,
    })
    assert.equal(report1.status, 'pass', JSON.stringify(report1.failure ?? report1.steps))
    const adapter2 = new ComputerAdapter(driver2)
    const report2 = await runScenario(scenario, adapter2, {
      ownerId: 'visual-run-2',
      visual: fakeServices({ outputs: ['{"x":600,"y":500,"confidence":0.8}'] }),
      approval: allowedApproval,
      settle: SETTLE,
    })
    assert.equal(report2.status, 'pass', JSON.stringify(report2.failure ?? report2.steps))
    assert.equal(calls1.visualAct.length, 1)
    assert.equal(calls2.visualAct.length, 1)
    assert.notDeepEqual(
      calls1.visualAct[0].action.point,
      calls2.visualAct[0].action.point,
      'replay re-grounds on fresh screenshots and can resolve different coordinates across runs',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('exported visual trajectory carries description/provenance, never raw coordinates or capture binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-cu-visual-export-'))
  try {
    const { driver } = fakeDriver()
    const adapter = new ComputerAdapter(driver)
    const recorder = new QaTrajectoryRecorder()
    const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'visual-export', { settle: SETTLE })
    await session.start({ bundleId: BUNDLE, windowTitle: WINDOW_TITLE })
    await session.observeSettled()
    const action = {
      kind: 'visual_click',
      targetDescription: 'the Press Me control',
      // A file-like observation binding is ephemeral runtime metadata. It is
      // intentionally redacted by the generic text projector, but must not
      // make the durable visual action ineligible for export.
      observationId: 'file:///private/tmp/capture.png',
      captureSha256: createHash('sha256').update(makePng()).digest('hex'),
      point: { x: 200, y: 150 },
      grounding: { source: 'harness-point' },
    }
    await session.act(action, allowedApproval)
    await session.stop()
    const path = join(dir, 'visual-export.json')
    const exported = await exportRecordedScenario(recorder, 'visual-export', { outputPath: path })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.scenario.steps.length, 1)
    const step = exported.scenario.steps[0]
    assert.equal(step.action.kind, 'visual_click')
    assert.equal(step.action.targetDescription, 'the Press Me control')
    assert.deepEqual(step.action.provenance, { source: 'harness-point' })
    const serialized = JSON.stringify(exported.scenario)
    assert.equal(serialized.includes('captureSha256'), false)
    assert.equal(serialized.includes('observationId'), false)
    assert.equal(serialized.includes('"point"'), false)
    assert.equal(serialized.includes('"to"'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('visual export blocks sensitive descriptions but ignores redaction of transient bindings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-cu-visual-redaction-'))
  try {
    const { driver } = fakeDriver()
    const adapter = new ComputerAdapter(driver)
    const recorder = new QaTrajectoryRecorder()
    const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'visual-redaction', { settle: SETTLE })
    await session.start({ bundleId: BUNDLE, windowTitle: WINDOW_TITLE })
    await session.observeSettled()
    await session.act({
      kind: 'visual_click',
      targetDescription: 'click secret-token=do-not-leak',
      observationId: 'file:///private/tmp/secret-capture.png',
      captureSha256: createHash('sha256').update(makePng()).digest('hex'),
      point: { x: 200, y: 150 },
      grounding: { source: 'harness-point' },
    }, allowedApproval)
    await session.stop()
    const outputPath = join(dir, 'sensitive.json')
    const exported = await exportRecordedScenario(recorder, 'visual-redaction', { outputPath })
    assert.equal(exported.ok, false)
    assert.equal(exported.code, 'NO_PROVEN_STEPS')
    assert.equal(exported.excludedActions[0].reason, 'ACTION_PAYLOAD_REDACTED')
    assert.doesNotMatch(JSON.stringify(exported), /do-not-leak|secret-token/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('visual export stays NO_PROVEN_STEPS without a fresh post-action observation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-cu-visual-no-proof-'))
  try {
    const recorder = new QaTrajectoryRecorder()
    recorder.start('visual-no-proof', 'computer', { bundleId: BUNDLE, windowTitle: WINDOW_TITLE }, { page: { url: 'http://127.0.0.1:1/', title: WINDOW_TITLE } })
    const actionId = recorder.action('visual-no-proof', {
      kind: 'visual_click',
      targetDescription: 'the Press Me control',
      observationId: 'obs_1',
      captureSha256: createHash('sha256').update(makePng()).digest('hex'),
      point: { x: 200, y: 150 },
      grounding: { source: 'harness-point' },
    })
    recorder.receipt('visual-no-proof', actionId, {
      receiptId: 'r1', sequence: 1, status: 'unknown', action: 'visual_click',
      observationId: 'obs_1', observationFingerprint: null, captureSha256: 'hash', dispatched: true,
      startedAt: 'a', finishedAt: 'b', reason: 'dispatched', nativeAccepted: true, postAction: null,
    })
    const exported = await exportRecordedScenario(recorder, 'visual-no-proof', { outputPath: join(dir, 'no-proof.json') })
    assert.equal(exported.ok, false)
    assert.equal(exported.code, 'NO_PROVEN_STEPS')
    assert.equal(exported.excludedActions[0].reason, 'FRESH_OBSERVATION_MISSING')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
