import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QaSession } from '../src/session/index.ts'
import { exportRecordedScenario, QaTrajectoryRecorder, RecordingQaDriverAdapter } from '../src/explore/index.ts'
import { evaluateAssertion, runScenario } from '../src/replay/index.ts'

const SETTLE = { budgetMs: 100, quietMs: 5, postChangeQuietMs: 5, intervalMs: 2, adaptiveBudgetMs: 0 }
const URL = 'http://127.0.0.1:1/'
const EXPECTED = 'Hello SIM-DEFAULT'
const TARGET = { role: 'AXStaticText', name: 'Status', tag: 'qa.status.result' }

function observation(value, options = {}) {
  const status = { ref: 'status', role: TARGET.role, name: TARGET.name, ...(Object.hasOwn(options, 'tag') ? { tag: options.tag } : { tag: TARGET.tag }), value, ...(options.secure ? { secure: true } : {}), ...(options.withheld ? { valueWithheld: true } : {}), ...(options.valueTruncated ? { valueTruncated: true } : {}) }
  const nodes = [
    ...(options.filled ? [{ ref: 'input', role: 'AXTextField', name: 'Name', tag: 'qa.input', value: 'SIM-DEFAULT' }] : [{ ref: 'input', role: 'AXTextField', name: 'Name', tag: 'qa.input', value: '' }]),
    { ref: 'apply', role: 'AXButton', name: 'Apply', tag: 'qa.apply' },
    status,
    ...(options.duplicate ? [{ ...status, ref: 'status-2' }] : []),
  ]
  return { page: { url: URL, title: 'fixture' }, nodes, truncated: options.truncated === true }
}

function receipt() {
  return {
    receiptId: 'click-receipt', sequence: 1, status: 'unknown', action: 'click',
    observationId: 'after', observationFingerprint: null, dispatched: true,
    startedAt: 'a', finishedAt: 'b', reason: 'dispatched', nativeAccepted: true, postAction: null,
  }
}

function directClickRecorder(options = {}) {
  const recorder = new QaTrajectoryRecorder()
  recorder.start('owner', 'computer', { bundleId: 'fixture', windowTitle: 'fixture' }, { page: { url: URL, title: 'fixture' } })
  recorder.observation('owner', observation(options.beforeValue ?? 'Ready', options))
  const actionId = recorder.action('owner', { kind: 'click', ref: 'apply' })
  recorder.receipt('owner', actionId, receipt())
  recorder.observation('owner', observation(options.afterValue ?? EXPECTED, options))
  recorder.settle('owner', { stable: true, passes: 2, ...SETTLE })
  recorder.observation('owner', observation(options.afterValue ?? EXPECTED, options))
  recorder.settle('owner', { stable: true, passes: 2, ...SETTLE })
  const target = { ...TARGET }
  if (Object.hasOwn(options, 'tag')) {
    if (options.tag === undefined) delete target.tag
    else target.tag = options.tag
  }
  recorder.assertion('owner', { kind: 'node-value', expected: { ...target, value: options.afterValue ?? EXPECTED } }, true)
  return recorder
}

async function exportDirect(dir, options = {}, mutate) {
  const recorder = directClickRecorder(options)
  const snapshot = recorder.snapshot('owner')
  if (mutate !== undefined) mutate(snapshot)
  return exportRecordedScenario({ snapshot: () => snapshot }, 'owner', { outputPath: join(dir, options.file ?? 'scenario.json') })
}

test('recorded click with explicit status value exports and replays as a two-step scenario', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-click-explicit-'))
  try {
    let clicked = false
    let filled = false
    const adapter = {
      kind: 'computer',
      async start() { return { page: { url: URL, title: 'fixture' } } },
      async observe() { return observation(clicked ? EXPECTED : 'Ready', { filled }) },
      async act(_owner, action) {
        if (action.kind === 'fill') { assert.equal(action.ref, 'input'); filled = true }
        else { assert.equal(action.kind, 'click'); assert.equal(action.ref, 'apply'); clicked = true }
        return receipt()
      },
      async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
      async stop() { return { stopped: true, reason: 'requested' } },
    }
    const recorder = new QaTrajectoryRecorder()
    const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'owner', { settle: SETTLE })
    await session.start({ bundleId: 'fixture', windowTitle: 'fixture' })
    await session.observeSettled()
    await session.act({ kind: 'fill', ref: 'input', text: 'SIM-DEFAULT' })
    await session.act({ kind: 'click', ref: 'apply' })
    const decision = await session.observeSettled()
    const assertion = { kind: 'node-value', expected: { ...TARGET, value: EXPECTED } }
    const evaluated = evaluateAssertion(assertion, decision.observation)
    assert.equal(evaluated.passed, true)
    recorder.assertion('owner', assertion, evaluated.passed)
    // DEBUG
    await session.stop()
    const exported = await exportRecordedScenario(recorder, 'owner', { outputPath: join(dir, 'scenario.json') })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.scenario.steps.length, 2, JSON.stringify(exported))
    assert.equal(exported.scenario.steps[1].action.kind, 'click')
    assert.equal(exported.scenario.steps[1].assert.kind, 'node-value')
    assert.equal(exported.scenario.steps[1].assert.expected.value, EXPECTED)

    let replayClicked = false
    let replayFilled = false
    const replay = await runScenario(exported.scenario, {
      kind: 'computer',
      async start() { return { page: { url: URL, title: 'fixture' } } },
      async observe() { return observation(replayClicked ? EXPECTED : 'Ready', { filled: replayFilled }) },
      async act(_owner, action) {
        if (action.kind === 'fill') { assert.equal(action.ref, 'input'); replayFilled = true }
        else { assert.equal(action.kind, 'click'); assert.equal(action.ref, 'apply'); replayClicked = true }
        return { status: 'confirmed', dispatched: true, nativeAccepted: true }
      },
      async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
      async stop() { return { stopped: true, reason: 'requested' } },
    }, { ownerId: 'replay', settle: SETTLE })
    assert.equal(replay.status, 'pass', JSON.stringify(replay))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('click explicit proof remains fail-closed for stale/mismatched, duplicate, unchanged, secure, withheld, and truncated evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-click-explicit-guards-'))
  try {
    const cases = [
      ['stale action id', {}, snapshot => { snapshot.assertions[0].actionId = 'action-999' }],
      ['stale observation id', {}, snapshot => { snapshot.assertions[0].decidingObservationId = 'observation-999' }],
      ['earlier deciding view', {}, snapshot => { snapshot.assertions[0].decidingObservationId = Object.keys(snapshot.observations)[0] }],
      ['unsettled deciding view', {}, snapshot => {
        const id = snapshot.assertions[0].decidingObservationId
        for (const event of snapshot.events) if (event.kind === 'settle' && event.observationId === id) event.stable = false
      }],
      ['unsafe deciding view', {}, snapshot => {
        const deciding = snapshot.observations[snapshot.assertions[0].decidingObservationId]
        deciding.nodes.find(node => node.tag === TARGET.tag).valueWithheld = true
      }],
      ['duplicate target', { duplicate: true }, undefined],
      ['unchanged value', { beforeValue: EXPECTED, afterValue: EXPECTED }, undefined],
      ['secure value', { secure: true }, undefined],
      ['withheld value', { withheld: true }, undefined],
      ['truncated value', { valueTruncated: true }, undefined],
      ['truncated without stable target', { truncated: true, tag: undefined }, undefined],
    ]
    for (const [name, options, mutate] of cases) {
      const exported = await exportDirect(dir, { ...options, file: name.replace(/\s+/g, '-') + '.json' }, mutate)
      assert.equal(exported.ok, false, name)
      assert.equal(exported.code, 'NO_PROVEN_STEPS', name)
    }
    const validAfterInvalid = await exportDirect(dir, { file: 'valid-after-invalid.json' }, snapshot => {
      snapshot.assertions.unshift({ ...snapshot.assertions[0], decidingObservationId: 'missing-decision' })
    })
    assert.equal(validAfterInvalid.ok, true, 'an invalid earlier candidate must not shadow a later fully proven assertion')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
