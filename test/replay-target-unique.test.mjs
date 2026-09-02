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
import { QA_TARGET_NOT_UNIQUE } from '../src/contracts.ts'

// Adversarial replay-target-uniqueness regression, ported from
// /tmp/qa-audit3-probes/probes/node-value.mjs (non-unique-replay-false-green).
// Export demands a unique (role, name) for every action target, but replay
// resolved the FIRST match and node-value accepted ANY same-named twin, so a
// twin that already held the recorded value produced a false PASS while the
// recorded target was empty. Replay must fail closed with TARGET_NOT_UNIQUE
// (the same vocabulary as export) instead of acting on the first match.

const LAUNCH = 'http://127.0.0.1:7422/'
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

function fillValueAdapter() {
  let filled = false
  let text = ''
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      return {
        page: { url: LAUNCH, title: 'fixture' },
        nodes: [
          node('input', 'textbox', 'Release name', 'input', { value: filled ? text : '' }),
          node('status', 'status', filled ? 'READY' : 'IDLE', 'div'),
        ],
        truncated: false,
      }
    },
    async act(_owner, action) {
      if (action.kind === 'fill') { filled = true; text = action.text }
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'ok' } },
  }
}

/** Twin view: the FIRST twin already holds the recorded value; the recorded target is empty. */
function twinAdapter() {
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      return {
        page: { url: LAUNCH, title: 'fixture' },
        nodes: [
          node('old', 'textbox', 'Release name', 'input', { value: 'v1.0.0' }),
          node('input', 'textbox', 'Release name', 'input', { value: '' }),
          node('status', 'status', 'READY', 'div'),
        ],
        truncated: false,
      }
    },
    async act() { return { status: 'confirmed', dispatched: true } },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'ok' } },
  }
}

async function exploreFill(adapter, owner, outputPath) {
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), owner, { settle: SETTLE })
  await session.start({ url: LAUNCH })
  await session.observeSettled()
  await session.act({ kind: 'fill', ref: 'input', text: 'v1.0.0' })
  await session.stop()
  return exportRecordedScenario(recorder, owner, { outputPath })
}

test('replay fails closed with TARGET_NOT_UNIQUE when the action target is not unique', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-target-unique-'))
  try {
    const exported = await exploreFill(fillValueAdapter(), 'nu', join(dir, 'nu.json'))
    assert.equal(exported.ok, true, JSON.stringify(exported))
    const report = await runScenario(exported.scenario, twinAdapter(), {
      ownerId: 'nu-replay',
      settle: SETTLE,
    })
    assert.notEqual(report.status, 'pass', 'a non-unique target must never pass')
    assert.equal(report.failure?.code, QA_TARGET_NOT_UNIQUE, 'the failure carries the machine code')
    assert.match(report.failure?.message ?? '', new RegExp(QA_TARGET_NOT_UNIQUE))
    assert.equal(report.steps[0].receipt, null, 'no action was dispatched against an ambiguous target')
    assert.equal(report.steps[0].assertionPassed, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('evaluateAssertion node-value requires EXACTLY ONE match; a twin holding the value is not a pass', () => {
  const observation = {
    page: { url: LAUNCH, title: 'fixture' },
    nodes: [
      node('old', 'textbox', 'Release name', 'input', { value: 'v1.0.0' }),
      node('input', 'textbox', 'Release name', 'input', { value: '' }),
    ],
    truncated: false,
  }
  const result = evaluateAssertion(
    { kind: 'node-value', expected: { role: 'textbox', name: 'Release name', value: 'v1.0.0' } },
    observation,
  )
  assert.equal(result.passed, false, 'two same-named nodes, one already holding the value: never a pass')
  assert.equal(result.reason, QA_TARGET_NOT_UNIQUE, 'the refusal carries the machine code')
})

