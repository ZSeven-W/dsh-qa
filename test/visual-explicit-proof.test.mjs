import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportRecordedScenario, QaTrajectoryRecorder } from '../src/explore/index.ts'

const SETTLE = { budgetMs: 300, quietMs: 20, postChangeQuietMs: 20, intervalMs: 4, adaptiveBudgetMs: 0 }
const launch = 'http://127.0.0.1:1/'
const action = {
  kind: 'visual_click',
  targetDescription: 'the Run validation button',
  observationId: 'capture-1',
  captureSha256: 'a'.repeat(64),
  point: { x: 20, y: 20 },
  grounding: { source: 'harness-point' },
}
const receipt = {
  receiptId: 'receipt-1', sequence: 1, status: 'unknown', action: 'visual_click',
  observationId: 'capture-1', observationFingerprint: null, captureSha256: 'a'.repeat(64),
  dispatched: true, startedAt: 'a', finishedAt: 'b', reason: 'dispatched', nativeAccepted: true, postAction: null,
}
function view(value, ref = 'status', truncated = false) {
  return {
    page: { url: launch, title: 'fixture' },
    nodes: [{ ref, role: 'AXStaticText', name: 'Status', tag: 'qa.visual.status', value, secure: false, valueWithheld: false, valueTruncated: false }],
    truncated,
  }
}
function recorderWithValue(beforeValue, afterValue, truncated = false, withTag = true) {
  const recorder = new QaTrajectoryRecorder()
  recorder.start('owner', 'computer', { bundleId: 'fixture', windowTitle: 'fixture' }, { page: { url: launch, title: 'fixture' } })
    recorder.observation('owner', withTag ? view(beforeValue, 'before', truncated) : { ...view(beforeValue, 'before', truncated), nodes: [{ ref: 'before', role: 'AXStaticText', name: 'Status', tag: '', value: beforeValue }] })
  const actionId = recorder.action('owner', action)
  recorder.receipt('owner', actionId, receipt)
  recorder.observation('owner', withTag ? view(afterValue, 'after', truncated) : { ...view(afterValue, 'after', truncated), nodes: [{ ref: 'after', role: 'AXStaticText', name: 'Status', tag: '', value: afterValue }] })
  recorder.settle('owner', { stable: true, passes: 2, budgetMs: SETTLE.budgetMs, quietMs: SETTLE.quietMs, postChangeQuietMs: SETTLE.postChangeQuietMs, intervalMs: SETTLE.intervalMs, adaptiveBudgetMs: 0 })
  recorder.assertion('owner', { kind: 'node-value', expected: { role: 'AXStaticText', name: 'Status', ...(withTag ? { tag: 'qa.visual.status' } : {}), value: afterValue } }, true)
  return recorder
}

test('explicit passed node-value proves a visual action when semantic synthesis has no delta', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-explicit-proof-'))
  try {
    const exported = await exportRecordedScenario(recorderWithValue('Ready', 'PASS clicks=1 received=1'), 'owner', { outputPath: join(dir, 'scenario.json') })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.scenario.steps[0].assert.kind, 'node-value')
    assert.equal(exported.scenario.steps[0].assert.expected.value, 'PASS clicks=1 received=1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('explicit proof refuses an assertion that was already true before the action', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-explicit-no-change-'))
  try {
    const exported = await exportRecordedScenario(recorderWithValue('PASS clicks=1 received=1', 'PASS clicks=1 received=1'), 'owner', { outputPath: join(dir, 'scenario.json') })
    assert.equal(exported.ok, false)
    assert.equal(exported.code, 'NO_PROVEN_STEPS')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('explicit positive value proof may use truncated views only with a stable tag', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-explicit-truncated-'))
  try {
    const exported = await exportRecordedScenario(recorderWithValue('Ready', 'PASS clicks=1 received=1', true), 'owner', { outputPath: join(dir, 'scenario.json') })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.scenario.steps[0].assert.kind, 'node-value')
    assert.match(exported.scenario.steps[0].intent, /truncated/i)

    const noTag = await exportRecordedScenario(recorderWithValue('Ready', 'PASS clicks=1 received=1', true, false), 'owner', { outputPath: join(dir, 'no-tag.json') })
    assert.equal(noTag.ok, false)
    assert.equal(noTag.code, 'NO_PROVEN_STEPS')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('explicit proof still requires a fresh settled observation and safe value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-explicit-guards-'))
  try {
    const noFresh = new QaTrajectoryRecorder()
    noFresh.start('owner', 'computer', { bundleId: 'fixture', windowTitle: 'fixture' }, { page: { url: launch, title: 'fixture' } })
    noFresh.observation('owner', view('Ready', 'before'))
    const id = noFresh.action('owner', action)
    noFresh.receipt('owner', id, receipt)
    noFresh.assertion('owner', { kind: 'node-value', expected: { role: 'AXStaticText', name: 'Status', tag: 'qa.visual.status', value: 'PASS clicks=1 received=1' } }, true)
    const missing = await exportRecordedScenario(noFresh, 'owner', { outputPath: join(dir, 'missing.json') })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'NO_PROVEN_STEPS')

    const secret = await exportRecordedScenario(recorderWithValue('Ready', 'Authorization: Bearer secret-proof'), 'owner', { outputPath: join(dir, 'secret.json') })
    assert.equal(secret.ok, false)
    assert.doesNotMatch(JSON.stringify(secret), /secret-proof/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
