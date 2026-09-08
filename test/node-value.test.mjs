import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exportRecordedScenario,
  QaTrajectoryRecorder,
  RecordingQaDriverAdapter,
} from '../src/explore/index.ts'
import { evaluateAssertion, runScenario } from '../src/replay/index.ts'
import { QaSession } from '../src/session/index.ts'

const LAUNCH = 'http://127.0.0.1:7421/'
const SETTLE = { budgetMs: 400, quietMs: 40, intervalMs: 5 }

function node(ref, role, name, tag, extra = {}) {
  return {
    ref,
    role,
    name,
    tag,
    interactive: role !== 'status',
    editable: role === 'textbox',
    disabled: false,
    ...extra,
  }
}

test('evaluateAssertion node-value matches the predicate AND the exact value', () => {
  const observation = {
    page: { url: LAUNCH, title: 'fixture' },
    nodes: [
      node('a', 'textbox', 'Release name', 'input', { value: 'v1.0.0' }),
      node('b', 'button', 'Run validation', 'button'),
    ],
    truncated: false,
  }
  const pass = evaluateAssertion(
    { kind: 'node-value', expected: { role: 'textbox', name: 'Release name', value: 'v1.0.0' } },
    observation,
  )
  assert.equal(pass.passed, true)
  assert.deepEqual(pass.observed, [{ role: 'textbox', name: 'Release name', tag: 'input', value: 'v1.0.0' }])

  const wrongValue = evaluateAssertion(
    { kind: 'node-value', expected: { role: 'textbox', name: 'Release name', value: 'v2.0.0' } },
    observation,
  )
  assert.equal(wrongValue.passed, false, 'exact match only')

  const noValue = evaluateAssertion(
    { kind: 'node-value', expected: { role: 'button', name: 'Run validation', value: 'v1.0.0' } },
    observation,
  )
  assert.equal(noValue.passed, false, 'a node without the expected value is not a match')
})

test('empty value proof requires an observed exact value, never absence or withheld data', () => {
  const assertion = { kind: 'node-value', expected: { role: 'textbox', name: 'Search', value: '' } }
  for (const [extra, expected] of [
    [{ value: '' }, true],
    [{}, false],
    [{ value: null }, false],
    [{ value: ' ' }, false],
    [{ value: '', secure: true }, false],
    [{ value: '', valueWithheld: true }, false],
    [{ value: '', valueTruncated: true }, false],
  ]) {
    const observation = { page: { url: LAUNCH, title: 'fixture' }, nodes: [node('a', 'textbox', 'Search', 'input', extra)], truncated: false }
    assert.equal(evaluateAssertion(assertion, observation).passed, expected, JSON.stringify(extra))
  }
})

function fillValueAdapter({ withheld = false, changeOnFill = false } = {}) {
  let inputValue = ''
  let result = 'IDLE'
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      return {
        page: { url: LAUNCH, title: 'fixture' },
        nodes: [
          node('input', 'textbox', 'Release name', 'input', withheld ? { valueWithheld: true } : { value: inputValue }),
          node('status', 'status', result, 'div'),
        ],
        truncated: false,
      }
    },
    async act(_owner, action) {
      if (action.kind === 'fill') {
        if (!withheld) inputValue = action.text
        if (changeOnFill) result = 'READY'
      }
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

async function exploreFill(adapter, owner, outputPath) {
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), owner, { settle: SETTLE })
  await session.start({ url: LAUNCH })
  const before = await session.observeSettled()
  const input = before.observation.nodes.find((item) => item.name === 'Release name')
  assert.ok(input, 'the fixture must expose the input')
  await session.act({ kind: 'fill', ref: input.ref, text: 'v1.0.0' })
  await session.stop()
  return exportRecordedScenario(recorder, owner, { outputPath })
}

test('a fill whose target carries the typed value exports a node-value assertion on the TARGET', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-node-value-export-'))
  try {
    const exported = await exploreFill(fillValueAdapter(), 'node-value-export', join(dir, 'fill.json'))
    assert.equal(exported.ok, true)
    assert.equal(exported.excludedActions.length, 0)
    const step = exported.scenario.steps[0]
    assert.equal(step.action.kind, 'fill')
    assert.equal(step.assert.kind, 'node-value')
    assert.deepEqual(step.assert.expected, { role: 'textbox', name: 'Release name', value: 'v1.0.0' })
    assert.doesNotMatch(step.intent, /Weak proof/)

    const reports = []
    for (let i = 0; i < 2; i += 1) {
      reports.push(await runScenario(exported.scenario, fillValueAdapter(), {
        ownerId: 'node-value-replay-' + i,
        settle: SETTLE,
      }))
    }
    assert.equal(reports[0].status, 'pass')
    assert.equal(reports[1].status, 'pass')
    assert.ok(reports[0].steps.every((step) => step.status === 'pass' && step.assertionPassed === true))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a withheld (secret) value is never synthesized; the fill falls back to its delta', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-node-value-withheld-'))
  try {
    const exported = await exploreFill(
      fillValueAdapter({ withheld: true, changeOnFill: true }),
      'node-value-withheld',
      join(dir, 'withheld.json'),
    )
    assert.equal(exported.ok, true, 'the fill is still proven by its downstream delta')
    const step = exported.scenario.steps[0]
    assert.equal(step.assert.kind, 'node-present', 'a withheld field must never become a node-value assertion')
    assert.deepEqual(step.assert.expected, { role: 'status', name: 'READY' })
    assert.equal(step.assert.expected.value, undefined)
    assert.doesNotMatch(JSON.stringify(exported.scenario), /node-value/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a secret-filled withheld field is redacted and never produces a value assertion or a leak', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-node-value-secret-'))
  try {
    const secretToken = 'WITHHELD_SECRET_9f3a2'
    const recorder = new QaTrajectoryRecorder()
    const session = new QaSession(
      new RecordingQaDriverAdapter(fillValueAdapter({ withheld: true, changeOnFill: true }), recorder),
      'node-value-secret',
      { settle: SETTLE },
    )
    await session.start({ url: LAUNCH })
    const before = await session.observeSettled()
    const input = before.observation.nodes.find((item) => item.name === 'Release name')
    await session.act({ kind: 'fill', ref: input.ref, text: 'Authorization: Bearer ' + secretToken })

    const snapshot = recorder.snapshot('node-value-secret')
    assert.ok(snapshot)
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secretToken), 'the secret never enters the trajectory')

    const exported = await exportRecordedScenario(recorder, 'node-value-secret', { outputPath: join(dir, 'secret.json') })
    assert.equal(exported.ok, false, 'a redaction-changing action payload is never exported')
    assert.equal(exported.excludedActions[0].reason, 'ACTION_PAYLOAD_REDACTED')
    await session.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the fill echo does not by itself satisfy awaitChange; the late outcome is still observed', async () => {
  let actedAt = null
  const suggestAfterMs = 120
  const adapter = {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      const sinceAct = actedAt === null ? null : Date.now() - actedAt
      const suggested = sinceAct !== null && sinceAct >= suggestAfterMs
      const nodes = [
        node('input', 'textbox', 'Search articles', 'input', { value: actedAt === null ? '' : 'async' }),
      ]
      if (suggested) nodes.push(node('option', 'option', 'Async rendering', 'li'))
      return { page: { url: LAUNCH, title: 'fixture' }, nodes, truncated: false }
    },
    async act() {
      actedAt = Date.now()
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }

  const session = new QaSession(adapter, 'echo-unit', { settle: SETTLE })
  await session.start({ url: LAUNCH })
  const before = await session.observeSettled()
  const input = before.observation.nodes.find((item) => item.name === 'Search articles')
  assert.ok(input)
  const acted = await session.act({ kind: 'fill', ref: input.ref, text: 'async' })
  await session.stop()

  assert.equal(acted.settle.stable, true)
  assert.ok(
    acted.observation.nodes.some((item) => item.name === 'Async rendering'),
    'the settle window must wait past the value echo for the downstream consequence',
  )
  assert.ok(acted.settle.elapsedMs >= suggestAfterMs, 'the window did not conclude on the echo alone')
})
