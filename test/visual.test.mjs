// WP9 visual-assertion tests: adapter visual capture for both drivers, the
// structural vision seam (fake llm verdicts, garbage -> unclear, absent
// services -> vision-model-unavailable), advisory-never-flips-pass/fail,
// determinism with advisory content excluded by schema, and redaction of
// advisory text. No live vision model is required: the seam is exercised with
// a fake llm service; the live call is a separate integration test.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserAdapter, ComputerAdapter } from '../src/adapters/index.ts'
import { exportRecordedScenario, QaTrajectoryRecorder, RecordingQaDriverAdapter } from '../src/explore/index.ts'
import { captureLatestVisual, QaSession } from '../src/session/index.ts'
import {
  evaluateVisualQuestion,
  parseVerdict,
  persistCaptureFile,
  VISION_MODEL_UNAVAILABLE,
} from '../src/vision.ts'
import {
  normalizeReportForDeterminism,
  runScenario,
  validateScenario,
  validateVisualAssertion,
} from '../src/replay/index.ts'
import { renderReportJson, renderReportJsonl, renderReportMarkdown, writeReports } from '../src/reporters/index.ts'
import { QaToolHost } from '../src/tools.ts'

const CAPTURE = {
  driver: 'browser',
  observationFingerprint: 'fp',
  observationId: null,
  png: new Uint8Array([1, 2, 3, 4]),
  width: 10,
  height: 10,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb924',
  usable: true,
  marks: 0,
  omitted: 0,
}

// ---------------------------------------------------------------------------
// 1. Adapter visual capture (both drivers, fake drivers).
// ---------------------------------------------------------------------------

function fakeBrowserDriver() {
  const calls = []
  const driver = {
    kind: 'browser',
    contractVersion: 2,
    async visualObserve(ownerId, request) {
      calls.push(['visualObserve', ownerId, request])
      return {
        ownerId, epoch: 1, observationFingerprint: 'fp-latest', capturedAt: 'x', expiresAt: 'y',
        page: { url: 'http://127.0.0.1/', title: 'fixture', viewport: { width: 100, height: 50 } },
        png: new Uint8Array([1, 2, 3]),
        capture: {
          artifact: { format: 'png', byteLength: 3, sha256: 'abc123', path: '/tmp/captures/frame.png' },
          pointFrame: { x: 0, y: 0, width: 100, height: 50 },
          pixelWidth: 100, pixelHeight: 50, scaleX: 1, scaleY: 1, fullPage: false,
          quality: { classification: 'usable', usable: true, sampleCount: 1, visibleFraction: 1, meanLuminance: 0.5, luminanceVariance: 0.1, luminanceRange: 0.9, darkFraction: 0, lightFraction: 0.1, distinctColorBuckets: 2 },
        },
        marks: [{ number: 1, ref: 'br_1', sourceIndex: 0, nativePixelFrame: { x: 0, y: 0, width: 10, height: 10 } }],
        omitted: [],
      }
    },
  }
  return { driver, calls }
}

test('BrowserAdapter.visualObserve passes through request and projects a unified capture', async () => {
  const { driver, calls } = fakeBrowserDriver()
  const adapter = new BrowserAdapter(driver)
  const capture = await adapter.visualObserve('a', { maxMarks: 5, fullPage: true })
  assert.equal(capture.driver, 'browser')
  assert.equal(capture.observationFingerprint, 'fp-latest')
  assert.equal(capture.observationId, null)
  assert.equal(capture.artifactPath, '/tmp/captures/frame.png')
  assert.equal(capture.marks, 1)
  assert.equal(capture.omitted, 0)
  assert.equal(capture.usable, true)
  assert.ok(capture.png instanceof Uint8Array)
  const request = calls[0][2]
  assert.equal(request.maxMarks, 5)
  assert.equal(request.fullPage, true)
  assert.equal(request.fingerprint, undefined)
})

const COMPUTER_APP = { bundleId: 'dev.zseven-w.dshqa.fixture', pid: 1, launchIdentity: 'exec:1', name: 'Fixture' }
const COMPUTER_WINDOW = { number: 7, role: 'AXWindow', subrole: 'AXStandardWindow', title: 'fixture', frame: { x: 0, y: 0, width: 400, height: 300 }, identity: 'win' }

function fakeComputerDriver() {
  const calls = []
  const driver = {
    kind: 'computer',
    platform: 'macos',
    contractVersion: 2,
    async observe() {
      return {
        observationId: 'obs_1', fingerprint: 'fp1', capturedAt: 'x', expiresAt: 'y',
        app: COMPUTER_APP, window: COMPUTER_WINDOW, targets: [], truncated: false,
        limits: { maxDepth: 4, maxNodes: 200, ttlMs: 15000 },
      }
    },
    async visualObserve(request, context) {
      calls.push(['visualObserve', request, context])
      return {
        observationId: request.observationId, observationFingerprint: 'fp1', capturedAt: 'x', expiresAt: 'y',
        app: COMPUTER_APP, window: COMPUTER_WINDOW,
        png: new Uint8Array([9, 9]),
        capture: {
          artifact: { format: 'png', byteLength: 2, sha256: 'def456' },
          pointFrame: { x: 0, y: 0, width: 400, height: 300 },
          pixelWidth: 200, pixelHeight: 100, scaleX: 1, scaleY: 1,
          quality: { classification: 'usable', usable: true, sampleCount: 1, visibleFraction: 1, meanLuminance: 0.5, luminanceVariance: 0.1, luminanceRange: 0.9, darkFraction: 0, lightFraction: 0.1, distinctColorBuckets: 2 },
        },
        marks: [{ number: 1, ref: 'r1', sourceIndex: 0, nativePixelFrame: { x: 0, y: 0, width: 10, height: 10 } }],
        omitted: [],
      }
    },
  }
  return { driver, calls }
}

test('ComputerAdapter.visualObserve requires an observation id and projects a unified capture', async () => {
  const { driver, calls } = fakeComputerDriver()
  const adapter = new ComputerAdapter(driver)
  await adapter.start('a', { bundleId: COMPUTER_APP.bundleId })
  await assert.rejects(adapter.visualObserve('a', {}), /observation id/)
  const capture = await adapter.visualObserve('a', { observationId: 'obs_1', maxMarks: 7 })
  assert.equal(capture.driver, 'computer')
  assert.equal(capture.observationId, 'obs_1')
  assert.equal(capture.observationFingerprint, 'fp1')
  assert.equal(capture.artifactPath, undefined, 'computer capture is in memory')
  assert.equal(capture.marks, 1)
  assert.equal(calls[0][1].observationId, 'obs_1')
  assert.equal(calls[0][1].maxMarks, 7)
})

test('captureLatestVisual re-observes for the computer driver to bind an observation id', async () => {
  const { driver } = fakeComputerDriver()
  const adapter = new ComputerAdapter(driver)
  const session = new QaSession(adapter, 'visual-computer')
  await session.start({ bundleId: COMPUTER_APP.bundleId })
  const capture = await captureLatestVisual(session)
  assert.equal(capture.driver, 'computer')
  assert.equal(capture.observationId, 'obs_1')
})

// ---------------------------------------------------------------------------
// 2. Structural vision seam: fake llm verdicts + defensive parsing.
// ---------------------------------------------------------------------------

function fakeAttachments() {
  let calls = 0
  return {
    async saveImage(input) {
      calls += 1
      return { attachmentId: 'att_' + calls, mediaType: 'image/png', bytes: input.data.byteLength, width: 10, height: 10, name: input.name }
    },
  }
}

function fakeLlm(output, onCall) {
  return {
    async *stream(options) {
      if (onCall) onCall(options)
      yield { type: 'text-delta', text: output }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

test('evaluateVisualQuestion calls llm.stream with a text block + image block and parses yes/no/unclear', async () => {
  let seen
  for (const verdict of ['yes', 'no', 'unclear']) {
    const llm = fakeLlm(JSON.stringify({ verdict, confidence: 0.9, reasoning: 'model says ' + verdict }), (opts) => { seen = opts })
    const finding = await evaluateVisualQuestion('Is it ok?', CAPTURE, { attachments: fakeAttachments(), llm })
    assert.equal(finding.verdict, verdict)
    assert.equal(finding.reasoning, 'model says ' + verdict)
    assert.equal(finding.confidence, 0.9)
  }
  assert.ok(seen, 'llm.stream was invoked')
  assert.equal(seen.provider, 'deepseek-official')
  assert.equal(seen.model, 'deepseek-v4-flash-vision-exp')
  assert.equal(seen.messages.length, 1)
  assert.equal(seen.messages[0].role, 'user')
  const blocks = seen.messages[0].content
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes('Is it ok?'))
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.attachmentId, 'att_1')
})

test('evaluateVisualQuestion turns garbage / invalid verdicts into unclear (never a fabricated yes)', async () => {
  const garbage = await evaluateVisualQuestion('q', CAPTURE, { attachments: fakeAttachments(), llm: fakeLlm('this is not JSON') })
  assert.equal(garbage.verdict, 'unclear')
  assert.equal(garbage.reason, 'unparseable-output')

  const invalid = await evaluateVisualQuestion('q', CAPTURE, { attachments: fakeAttachments(), llm: fakeLlm(JSON.stringify({ verdict: 'maybe', confidence: 1, reasoning: 'x' })) })
  assert.equal(invalid.verdict, 'unclear')
  assert.equal(invalid.reason, 'invalid-verdict')

  const empty = await evaluateVisualQuestion('q', CAPTURE, { attachments: fakeAttachments(), llm: fakeLlm('') })
  assert.equal(empty.verdict, 'unclear')
  assert.equal(empty.reason, 'empty-response')
})

test('parseVerdict accepts markdown-fenced JSON and clamps confidence', () => {
  const fenced = parseVerdict('```json\n{"verdict":"yes","confidence":0.8,"reasoning":"ok"}\n```')
  assert.equal(fenced.verdict, 'yes')
  assert.equal(fenced.confidence, 0.8)
  const clamped = parseVerdict('{"verdict":"no","confidence":42,"reasoning":"x"}')
  assert.equal(clamped.verdict, 'no')
  assert.equal(clamped.confidence, 1)
})

test('evaluateVisualQuestion degrades to unclear/vision-model-unavailable without services', async () => {
  const finding = await evaluateVisualQuestion('q', CAPTURE, undefined)
  assert.equal(finding.verdict, 'unclear')
  assert.equal(finding.reason, VISION_MODEL_UNAVAILABLE)
  const noLlm = await evaluateVisualQuestion('q', CAPTURE, { attachments: fakeAttachments() })
  assert.equal(noLlm.verdict, 'unclear')
  assert.equal(noLlm.reason, VISION_MODEL_UNAVAILABLE)
})

// ---------------------------------------------------------------------------
// 3. Advisory assertions never flip pass/fail; determinism excludes advisory.
// ---------------------------------------------------------------------------

function replayAdapter() {
  return {
    kind: 'browser',
    async start(_ownerId, options) { return { page: { url: options.url, title: 'fixture' }, headless: true } },
    async observe() { return { page: { url: 'http://fixture/', title: 'fixture' }, nodes: [], truncated: false } },
    async act() { return { status: 'confirmed', dispatched: true } },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async visualObserve() { return { ...CAPTURE, artifactPath: '/tmp/captures/advisory.png' } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

function advisoryScenario(question) {
  return {
    meta: { name: 'advisory', description: 'd', driver: 'browser', createdAt: '2026-01-01T00:00:00.000Z' },
    target: { launch: 'http://fixture/' },
    steps: [{
      index: 1, intent: 'navigate',
      action: { kind: 'navigate', url: 'http://fixture/' },
      assert: { kind: 'page-url', expected: { url: 'http://fixture/' } },
    }],
    assertions: [],
    advisory: [{ kind: 'visual', question }],
  }
}

test('advisory visual verdicts (yes and no) never change the run pass/fail status', async () => {
  for (const verdict of ['yes', 'no']) {
    const llm = fakeLlm(JSON.stringify({ verdict, confidence: 0.9, reasoning: 'advisory' }))
    const report = await runScenario(advisoryScenario('Is it ok?'), replayAdapter(), {
      ownerId: 'advisory-' + verdict,
      visual: { attachments: fakeAttachments(), llm, capturesDir: '/tmp/captures' },
    })
    assert.equal(report.status, 'pass', 'advisory must never flip a passing run to fail')
    assert.equal(report.advisory.length, 1)
    assert.equal(report.advisory[0].verdict, verdict)
    assert.equal(report.artifacts.length, 1)
    assert.equal(report.artifacts[0].kind, 'screenshot')
  }
})

test('normalizeReportForDeterminism excludes advisory/artifacts/evidence by schema', async () => {
  const yesLlm = fakeLlm(JSON.stringify({ verdict: 'yes', confidence: 1, reasoning: 'a' }))
  const noLlm = fakeLlm(JSON.stringify({ verdict: 'no', confidence: 0, reasoning: 'b' }))
  const run1 = await runScenario(advisoryScenario('Is it ok?'), replayAdapter(), { ownerId: 'det-1', visual: { attachments: fakeAttachments(), llm: yesLlm, capturesDir: '/tmp/c' } })
  const run2 = await runScenario(advisoryScenario('Is it ok?'), replayAdapter(), { ownerId: 'det-2', visual: { attachments: fakeAttachments(), llm: noLlm, capturesDir: '/tmp/c' } })
  assert.equal(run1.status, 'pass')
  assert.equal(run2.status, 'pass')
  // The raw advisory verdicts differ (non-deterministic model output) ...
  assert.notEqual(run1.advisory[0].verdict, run2.advisory[0].verdict)
  // ... but the deterministic projection is byte-identical because advisory is excluded BY SCHEMA.
  assert.deepEqual(normalizeReportForDeterminism(run1), normalizeReportForDeterminism(run2))
  const projected = normalizeReportForDeterminism(run1)
  assert.equal(projected.advisory, undefined)
  assert.equal(projected.artifacts, undefined)
  assert.equal(projected.evidence, undefined)
})

// ---------------------------------------------------------------------------
// 4. Redaction of advisory text in every report artifact.
// ---------------------------------------------------------------------------

test('a synthetic secret in a visual question/reasoning never reaches report artifacts', async () => {
  const secret = 'visual_SECRET_7f92a11'
  const question = 'Is the header ok? Authorization: Bearer ' + secret
  const llm = fakeLlm(JSON.stringify({ verdict: 'no', confidence: 0.2, reasoning: 'bad: ' + secret }))
  const report = await runScenario(advisoryScenario(question), replayAdapter(), {
    ownerId: 'redact-visual',
    visual: { attachments: fakeAttachments(), llm, capturesDir: '/tmp/c' },
  })
  assert.equal(report.status, 'pass')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-visual-redact-'))
  try {
    const paths = await writeReports(report, { directory: dir })
    for (const p of [paths.json, paths.markdown, paths.jsonl]) {
      const bytes = await readFile(p, 'utf8')
      assert.doesNotMatch(bytes, new RegExp(secret), p + ' must not leak the secret')
    }
    const md = await readFile(paths.markdown, 'utf8')
    assert.match(md, /## Advisory/)
    assert.match(md, /verdict: no/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. MCP parity: no host llm -> verdict 'unclear' with reason vision-model-unavailable.
// ---------------------------------------------------------------------------

test('QaToolHost.assertVisual degrades to unclear/vision-model-unavailable without host services', async () => {
  const host = new QaToolHost()
  const session = new QaSession(replayAdapter(), 'mcp-owner')
  await session.start({ url: 'http://fixture/' })
  const result = await host.assertVisual('mcp-owner', session, 'Is it ok?')
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'visual')
  assert.equal(result.verdict, 'unclear')
  assert.equal(result.reason, VISION_MODEL_UNAVAILABLE)
  assert.equal(result.artifact.kind, 'screenshot')
})

// ---------------------------------------------------------------------------
// 6. Scenario loader: advisory + meta.notes validation.
// ---------------------------------------------------------------------------

test('validateVisualAssertion and validateScenario accept advisory + meta.notes', () => {
  assert.deepEqual(validateVisualAssertion({ kind: 'visual', question: 'q' }), { kind: 'visual', question: 'q' })
  assert.throws(() => validateVisualAssertion({ kind: 'visual' }), /question/)
  assert.throws(() => validateVisualAssertion({ kind: 'node-present', question: 'q' }), /visual/)
  const scenario = validateScenario({
    meta: { name: 'n', description: 'd', driver: 'browser', createdAt: '2026-01-01T00:00:00.000Z', notes: ['visual finding: q'] },
    target: { launch: 'http://example.com' },
    steps: [{ index: 1, intent: 'i', action: { kind: 'navigate', url: 'http://example.com' }, assert: { kind: 'page-url', expected: { url: 'http://example.com' } } }],
    assertions: [],
    advisory: [{ kind: 'visual', question: 'q' }],
  })
  assert.equal(scenario.meta.notes.length, 1)
  assert.equal(scenario.advisory.length, 1)
})
// ---------------------------------------------------------------------------
// 7. Explore: visual findings are recorded but never exported as replay steps.
// ---------------------------------------------------------------------------

function exportAdapter() {
  let observation = 0
  let result = 'IDLE'
  return {
    kind: 'browser',
    async start(_owner, options) { return { page: { url: options.url ?? 'http://127.0.0.1:7399/', title: 'fixture' }, headless: true } },
    async observe() {
      observation += 1
      return {
        page: { url: 'http://127.0.0.1:7399/', title: 'fixture' },
        nodes: [
          { ref: 'input-' + observation, role: 'textbox', name: 'Release name', tag: 'input', interactive: true, editable: true, disabled: false },
          { ref: 'status-' + observation, role: 'status', name: result, tag: 'div', interactive: false, editable: false, disabled: false },
        ],
        truncated: false,
      }
    },
    async act(_owner, action) {
      if (action.kind === 'fill') result = 'READY'
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

test('qa_record_export excludes visual findings from steps and surfaces them as meta notes', async () => {
  const recorder = new QaTrajectoryRecorder()
  const adapter = new RecordingQaDriverAdapter(exportAdapter(), recorder)
  const session = new QaSession(adapter, 'visual-export')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-visual-export-'))
  const path = join(dir, 'scenario.json')
  try {
    await session.start({ url: 'http://127.0.0.1:7399/' })
    const observed = await session.observe()
    const input = observed.nodes.find((n) => n.name === 'Release name')
    assert.ok(input)
    await session.act({ kind: 'fill', ref: input.ref, text: 'v1' })
    recorder.visualFinding('visual-export', { question: 'Is the header obscured?', verdict: 'no', confidence: 0.4, reasoning: 'overlap' })
    const exported = await exportRecordedScenario(recorder, 'visual-export', { outputPath: path, name: 'visual-export' })
    assert.equal(exported.ok, true)
    assert.equal(exported.scenario.steps.length, 1, 'visual findings never become replay steps')
    assert.equal(exported.scenario.advisory, undefined, 'visual findings are not exported as advisory replay assertions')
    assert.deepEqual(exported.scenario.meta.notes, ['visual finding: Is the header obscured?'])
  } finally {
    await session.stop().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})


