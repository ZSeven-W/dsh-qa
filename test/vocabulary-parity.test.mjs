import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createQaTools, QaToolHost } from '../src/tools.ts'
import { QaSessionManager } from '../src/session/index.ts'
import { QaTrajectoryRecorder, RecordingQaDriverAdapter } from '../src/explore/index.ts'
import { runScenario } from '../src/replay/index.ts'
import { renderReportJson, renderReportMarkdown } from '../src/reporters/index.ts'
import { QA_INCONCLUSIVE_UNSTABLE } from '../src/contracts.ts'

// Vocabulary-parity regression, ported from
// /tmp/qa-audit3-probes/probes/settle-unstable.mjs (qa-evidence-unstable,
// replay-unstable-vocabulary, tools-vs-server). Three gaps closed:
//   (a) qa_evidence visual must carry captureSettled:false exactly like
//       qa_assert kind:"visual" does when its capture never settled;
//   (b) a replay run that fails on an unsettled observation must carry the
//       machine code INCONCLUSIVE_UNSTABLE in report.json failure.code and
//       render it in report.md — not prose only;
//   (c) qa_replay_run in src/server.mjs must pass the same settle policy and
//       visual services the cordis tool layer (src/tools.ts) passes, so MCP
//       and cordis replay behave identically.

const SETTLE = { budgetMs: 160, quietMs: 50, intervalMs: 10, adaptiveBudgetMs: 0 }

function churningAdapter() {
  let n = 0
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? 'https://example.test/churn', title: 'churn' }, headless: true }
    },
    async observe() {
      n += 1
      return {
        fingerprint: 'fp-' + n,
        page: { url: 'https://example.test/churn', title: 'tick-' + n },
        nodes: [{ ref: 'r1', role: 'button', name: 'Save', tag: 'button', interactive: true, editable: false, disabled: false }],
        truncated: false,
      }
    },
    async act() { return { status: 'confirmed', dispatched: true } },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async visualObserve() {
      return {
        driver: 'browser',
        observationFingerprint: 'fp-' + n,
        observationId: null,
        png: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        width: 1, height: 1, sha256: 'a'.repeat(64), usable: true, marks: 0, omitted: 0,
      }
    },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

async function hostWith(adapter, owner, options = {}) {
  const recorder = new QaTrajectoryRecorder()
  const manager = new QaSessionManager(new RecordingQaDriverAdapter(adapter, recorder), { settle: SETTLE })
  const host = new QaToolHost({ settle: SETTLE, ...options })
  host.managerFor = async () => manager
  host.managerForOwner = async () => manager
  const tools = createQaTools(host)
  await tools.qaSessionStart.execute({ owner, driver: 'browser', url: 'https://example.test/start' }, {})
  return { tools, recorder }
}

test('qa_evidence visual carries captureSettled:false from an unstable capture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-ev-vocab-'))
  try {
    const { tools } = await hostWith(churningAdapter(), 'ev-vocab', { capturesDir: dir })
    const result = await tools.qaEvidence.execute({ owner: 'ev-vocab', visual: true }, {})
    const visual = result.visual
    assert.equal(visual.settle.stable, false, 'the capture observation never settled')
    assert.equal(visual.captureSettled, false, 'qa_evidence visual must carry the same marker as qa_assert visual')
    assert.equal(visual.usable, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a replay run that never settles fails with failure.code INCONCLUSIVE_UNSTABLE in json and md', async () => {
  const scenario = {
    meta: { name: 'churn-replay', description: 'x', driver: 'browser', createdAt: '2026-01-01T00:00:00.000Z' },
    target: { launch: 'https://example.test/churn' },
    steps: [{
      index: 1,
      intent: 'Click "Save".',
      action: { kind: 'click', target: { role: 'button', name: 'Save' } },
      assert: { kind: 'node-present', expected: { role: 'button', name: 'Save' } },
    }],
    assertions: [],
  }
  const report = await runScenario(scenario, churningAdapter(), { ownerId: 'replay-vocab', settle: SETTLE })
  assert.equal(report.status, 'fail')
  assert.equal(report.failure?.code, QA_INCONCLUSIVE_UNSTABLE, 'the machine code travels in report.json')
  const json = JSON.parse(renderReportJson(report))
  assert.equal(json.failure.code, QA_INCONCLUSIVE_UNSTABLE)
  const md = renderReportMarkdown(report)
  assert.match(md, new RegExp('- code: ' + QA_INCONCLUSIVE_UNSTABLE), 'report.md renders the code')
})

test('src/server.mjs qa_replay_run passes settle policy and visual services like src/tools.ts', () => {
  const serverSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs'), 'utf8')
  const replayRegion = serverSource.slice(serverSource.indexOf("server.tool(\n  'qa_replay_run'"), serverSource.indexOf('await server.connect'))
  assert.match(replayRegion, /runScenario\(scenario, adapter, \{[\s\S]*settle/, 'the MCP replay must pass the settle policy')
  assert.ok(replayRegion.includes('visual:'), 'the MCP replay must pass visual services')
  const evidenceRegion = serverSource.slice(serverSource.indexOf('captureVisualEvidenceMCP'), serverSource.indexOf('function guard'))
  assert.ok(evidenceRegion.includes('captureSettled'), 'the MCP qa_evidence visual must carry the captureSettled marker')
})

