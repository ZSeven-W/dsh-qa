import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exportRecordedScenario,
  QaTrajectoryRecorder,
  RecordingQaDriverAdapter,
} from '../src/explore/index.ts'
import { loadScenarioFromPath } from '../src/replay/index.ts'
import { QaSession } from '../src/session/index.ts'

// These unit tests drive synthetic adapters, so they run the real settle loop
// under a deliberately small policy: the behaviour under test is the settle
// CONTRACT, not the production budget (exercised by the browser fixtures).
const FAST_SETTLE = { settle: { budgetMs: 400, quietMs: 30, intervalMs: 5 } }

function node(ref, role, name, tag, extra = {}) {
  return {
    ref,
    role,
    name,
    tag,
    interactive: role === 'button' || role === 'textbox',
    editable: role === 'textbox',
    disabled: false,
    ...extra,
  }
}

function fixtureAdapter({
  receiptStatus = 'confirmed',
  duplicateTarget = false,
  reject = false,
  changeOnFill = true,
} = {}) {
  let observation = 0
  let result = 'IDLE'
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? 'http://127.0.0.1:7399/', title: 'fixture' }, headless: true }
    },
    async observe() {
      observation += 1
      const suffix = '-' + observation
      const buttons = duplicateTarget
        ? [node('button-a' + suffix, 'button', 'Duplicate', 'button'), node('button-b' + suffix, 'button', 'Duplicate', 'button')]
        : [node('validate' + suffix, 'button', 'Run validation', 'button')]
      return {
        page: { url: 'http://127.0.0.1:7399/', title: 'fixture' },
        nodes: [
          node('input' + suffix, 'textbox', 'Release name', 'input'),
          ...buttons,
          node('status' + suffix, 'status', result, 'div'),
        ],
        truncated: false,
      }
    },
    async act(_owner, action) {
      if (reject) {
        return {
          status: 'rejected',
          code: 'EXTERNAL_COMMIT_TARGET',
          reason: 'target semantics indicate publishing externally',
          dispatched: false,
        }
      }
      if (action.kind === 'fill' && changeOnFill) result = 'READY'
      if (action.kind === 'click' && !duplicateTarget) result = 'PASS'
      return { status: receiptStatus, dispatched: true }
    },
    async evidence() {
      return {
        console: [{ text: 'Authorization: Bearer explore_SECRET_20260830' }],
        network: [],
        bounded: true,
        dropped: { console: 0, network: 0 },
      }
    },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

function assertLosslessJson(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), path + ' must be finite')
    assert.equal(Object.is(value, -0), false, path + ' must not be negative zero')
    return
  }
  assert.ok(typeof value === 'object', path + ' must be JSON')
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLosslessJson(item, path + '[' + index + ']'))
    return
  }
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(child, undefined, path + '.' + key + ' must not be undefined')
    assertLosslessJson(child, path + '.' + key)
  }
}

test('trajectory recording is passive, ordered, redacted, and exports fresh-observation assertions', async () => {
  const recorder = new QaTrajectoryRecorder()
  const adapter = new RecordingQaDriverAdapter(fixtureAdapter(), recorder)
  const session = new QaSession(adapter, 'explore-unit', FAST_SETTLE)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-explore-unit-'))
  const path = join(dir, 'scenario.json')
  try {
    await session.start({ url: 'http://127.0.0.1:7399/' })
    const before = await session.observe()
    const input = before.nodes.find((item) => item.name === 'Release name')
    assert.ok(input)
    const filled = await session.act({ kind: 'fill', ref: input.ref, text: 'v1.0.0' })
    assert.ok(filled.observation)
    const validate = filled.observation.nodes.find((item) => item.name === 'Run validation')
    assert.ok(validate)
    const clicked = await session.act({ kind: 'click', ref: validate.ref })
    assert.ok(clicked.observation?.nodes.some((item) => item.name === 'PASS'))
    await session.evidence()

    const snapshot = recorder.snapshot('explore-unit')
    assert.ok(snapshot)
    assert.deepEqual(snapshot.events.map((event) => event.sequence), snapshot.events.map((_, index) => index + 1))
    const eventKinds = snapshot.events.map((event) => event.kind)
    // One settle window per act (this test's first observe is the raw
    // single-shot primitive). Each window polls until the view holds still, so
    // the observation count is a duration, not an outcome: assert the window
    // structure instead of a fixed count.
    assert.equal(eventKinds.filter((kind) => kind === 'settle').length, 2)
    assert.ok(eventKinds.filter((kind) => kind === 'observation').length >= 5)
    assert.equal(eventKinds.filter((kind) => kind === 'action').length, 2)
    assert.equal(eventKinds.filter((kind) => kind === 'receipt').length, 2)
    assert.equal(eventKinds.filter((kind) => kind === 'evidence').length, 1)
    assert.equal(snapshot.actions.length, 2)
    assert.ok(snapshot.actions.every((action) => action.afterObservationId !== null))
    assert.ok(
      snapshot.actions.every((action) => action.afterObservationStable === true),
      'every exported action must be proven on a settled observation',
    )
    // Each action's proof is the LAST observation of its settle window.
    for (const settle of snapshot.events.filter((event) => event.kind === 'settle')) {
      if (settle.actionId === null) continue
      const action = snapshot.actions.find((item) => item.actionId === settle.actionId)
      assert.equal(action.afterObservationId, settle.observationId)
    }
    assert.deepEqual(snapshot.evidenceReferences, ['evidence-1'])
    const encodedSnapshot = JSON.stringify(snapshot)
    assert.doesNotMatch(encodedSnapshot, /explore_SECRET_20260830/)
    assert.match(encodedSnapshot, /\[REDACTED\]/)
    assert.doesNotMatch(encodedSnapshot, /input-1|validate-2/, 'raw ephemeral refs must not enter the trajectory')

    const exported = await exportRecordedScenario(recorder, 'explore-unit', {
      outputPath: path,
      name: 'unit-explore-loop',
    })
    assert.equal(exported.ok, true)
    assert.equal(exported.scenario.steps.length, 2)
    // QA-BL-064: the action target is NAME-only (the name is non-empty and
    // unique in the recorded baseline view); the live role rides as roleHint.
    assert.deepEqual(exported.scenario.steps[0].action.target, { name: 'Release name', roleHint: 'textbox' })
    assert.deepEqual(exported.scenario.steps[0].assert.expected, { role: 'status', name: 'READY' })
    assert.deepEqual(exported.scenario.steps[1].assert.expected, { role: 'status', name: 'PASS' })
    assert.equal(exported.excludedActions.length, 0)
    assert.equal(exported.trajectory.evidenceReferences.length, 1)
    assert.match(exported.artifact.path, /^\$(?:TMP|WORKSPACE)\//)
    assertLosslessJson(exported)

    const loaded = loadScenarioFromPath(path)
    assert.deepEqual(loaded, exported.scenario)
    const bytes = await readFile(path, 'utf8')
    assert.doesNotMatch(bytes, /ref-\d|input-\d|validate-\d/)
  } finally {
    await session.stop().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejected-only trajectory returns NO_PROVEN_STEPS and writes no scenario', async () => {
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(
    new RecordingQaDriverAdapter(fixtureAdapter({ reject: true }), recorder),
    'rejected-only',
    FAST_SETTLE,
  )
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-explore-rejected-'))
  const path = join(dir, 'must-not-exist.json')
  try {
    await session.start({ url: 'http://127.0.0.1:7399/' })
    const observed = await session.observe()
    const target = observed.nodes.find((item) => item.name === 'Run validation')
    assert.ok(target)
    const acted = await session.act({ kind: 'click', ref: target.ref })
    assert.equal(acted.receipt.code, 'EXTERNAL_COMMIT_TARGET')
    assert.equal(acted.observation, null)

    const exported = await exportRecordedScenario(recorder, 'rejected-only', { outputPath: path })
    assert.equal(exported.ok, false)
    assert.equal(exported.code, 'NO_PROVEN_STEPS')
    assert.equal(exported.excludedActions.length, 1)
    assert.equal(exported.excludedActions[0].reason, 'ACTION_REJECTED')
    assert.equal(exported.excludedActions[0].receipt.code, 'EXTERNAL_COMMIT_TARGET')
    assert.equal(existsSync(path), false)
    assertLosslessJson(exported)
  } finally {
    await session.stop().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

test('unknown receipt needs a fresh semantic delta; duplicate semantic targets are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-explore-durability-'))
  try {
    const provenRecorder = new QaTrajectoryRecorder()
    const provenSession = new QaSession(
      new RecordingQaDriverAdapter(fixtureAdapter({ receiptStatus: 'unknown' }), provenRecorder),
      'unknown-proven',
      FAST_SETTLE,
    )
    await provenSession.start({ url: 'http://127.0.0.1:7399/' })
    const provenObserved = await provenSession.observe()
    const provenInput = provenObserved.nodes.find((item) => item.name === 'Release name')
    assert.ok(provenInput)
    const provenResult = await provenSession.act({ kind: 'fill', ref: provenInput.ref, text: 'v1.0.0' })
    assert.equal(provenResult.outcome, 'unknown')
    const provenExport = await exportRecordedScenario(provenRecorder, 'unknown-proven', {
      outputPath: join(dir, 'unknown-proven.json'),
    })
    assert.equal(provenExport.ok, true)
    assert.deepEqual(provenExport.scenario.steps[0].assert.expected, { role: 'status', name: 'READY' })
    await provenSession.stop()

    const unknownRecorder = new QaTrajectoryRecorder()
    const unknownSession = new QaSession(
      new RecordingQaDriverAdapter(
        fixtureAdapter({ receiptStatus: 'unknown', changeOnFill: false }),
        unknownRecorder,
      ),
      'unknown-no-delta',
      FAST_SETTLE,
    )
    await unknownSession.start({ url: 'http://127.0.0.1:7399/' })
    const unknownObserved = await unknownSession.observe()
    const input = unknownObserved.nodes.find((item) => item.name === 'Release name')
    assert.ok(input)
    const result = await unknownSession.act({ kind: 'fill', ref: input.ref, text: 'v1.0.0' })
    assert.equal(result.outcome, 'unknown')
    const unknownExport = await exportRecordedScenario(unknownRecorder, 'unknown-no-delta', {
      outputPath: join(dir, 'unknown.json'),
    })
    assert.equal(unknownExport.ok, false)
    assert.equal(unknownExport.excludedActions[0].reason, 'ASSERTION_NOT_PROVABLE')
    await unknownSession.stop()

    const duplicateRecorder = new QaTrajectoryRecorder()
    const duplicateSession = new QaSession(
      new RecordingQaDriverAdapter(fixtureAdapter({ duplicateTarget: true }), duplicateRecorder),
      'duplicate-target',
      FAST_SETTLE,
    )
    await duplicateSession.start({ url: 'http://127.0.0.1:7399/' })
    const duplicateObserved = await duplicateSession.observe()
    const duplicate = duplicateObserved.nodes.find((item) => item.name === 'Duplicate')
    assert.ok(duplicate)
    await duplicateSession.act({ kind: 'click', ref: duplicate.ref })
    const duplicateExport = await exportRecordedScenario(duplicateRecorder, 'duplicate-target', {
      outputPath: join(dir, 'duplicate.json'),
    })
    assert.equal(duplicateExport.ok, false)
    assert.equal(duplicateExport.excludedActions[0].reason, 'TARGET_NOT_UNIQUE')
    await duplicateSession.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('redaction-changing action payload is retained safely but never exported as a replay step', async () => {
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(
    new RecordingQaDriverAdapter(fixtureAdapter(), recorder),
    'redacted-action',
    FAST_SETTLE,
  )
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-explore-redacted-'))
  const secret = 'ACTION_SECRET_7f92a11'
  try {
    await session.start({ url: 'http://127.0.0.1:7399/' })
    const observed = await session.observe()
    const input = observed.nodes.find((item) => item.name === 'Release name')
    assert.ok(input)
    await session.act({ kind: 'fill', ref: input.ref, text: 'Authorization: Bearer ' + secret })
    const snapshot = recorder.snapshot('redacted-action')
    assert.ok(snapshot)
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret))
    const exported = await exportRecordedScenario(recorder, 'redacted-action', {
      outputPath: join(dir, 'redacted.json'),
    })
    assert.equal(exported.ok, false)
    assert.equal(exported.excludedActions[0].reason, 'ACTION_PAYLOAD_REDACTED')
  } finally {
    await session.stop().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})