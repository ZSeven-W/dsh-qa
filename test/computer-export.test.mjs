// Computer (CU) trajectory EXPORT closure tests (WP6). These prove the
// previously-rejected computer trajectory now exports through the SAME
// fail-closed buildScenario path the browser trajectory uses:
//
//   - a computer trajectory exports (no DRIVER_NOT_REPLAYABLE gate);
//   - the scenario target carries the durable window TITLE (never PID / window
//     number / coordinates) alongside the bundle id launch;
//   - focus / type / key / scroll verbs are preserved, and computer targets
//     keep role + name + Accessibility identifier (tag) semantics;
//   - a computer container scroll is proven by a semantic DELTA (node-present),
//     never a node-in-viewport assertion the computer driver cannot satisfy;
//   - an action whose target has NO stable metadata (empty role/name/identifier)
//     is disclosed as a SPECIFIC exclusion, never blindly accepted.
//
// The adapter here is a QA-level fake (kind 'computer'), exactly like the
// browser fakes in export-proof-selection.test.mjs; the real ComputerAdapter is
// exercised separately by computer-replay.test.mjs.

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
import { QaSession } from '../src/session/index.ts'

const BUNDLE = 'dev.zseven-w.dshqa.fixture'
const WINDOW_TITLE = 'dsh-qa native fixture'
const SETTLE = { budgetMs: 400, quietMs: 40, postChangeQuietMs: 40, intervalMs: 5, adaptiveBudgetMs: 0 }

function cnode(ref, role, name, tag, extra = {}) {
  return {
    ref,
    role,
    name,
    tag,
    interactive: role !== 'AXStaticText',
    editable: role === 'AXTextField',
    disabled: false,
    ...extra,
  }
}

const FOCUS = { ref: 'f', role: 'AXButton', name: 'Focus target', tag: 'fixture.focusButton' }
const LIST_ITEM = { ref: 'li', role: 'AXStaticText', name: 'List item one', tag: 'fixture.itemOne', interactive: false, editable: false }
const PUBLISH = { ref: 'p', role: 'AXButton', name: 'Publish', tag: 'fixture.publish' }

function computerExploreAdapter() {
  // phase[i] is the observation returned after act[i-1] (phase[0] is initial).
  const phases = [
    [
      cnode('t', 'AXTextField', 'Release name', 'fixture.releaseName', { value: '' }),
      cnode(FOCUS.ref, FOCUS.role, FOCUS.name, FOCUS.tag),
      cnode(LIST_ITEM.ref, LIST_ITEM.role, LIST_ITEM.name, LIST_ITEM.tag, { interactive: false, editable: false }),
      cnode(PUBLISH.ref, PUBLISH.role, PUBLISH.name, PUBLISH.tag),
    ],
    [
      cnode('t', 'AXTextField', 'Release name', 'fixture.releaseName', { value: 'v1.0.0' }),
      cnode(FOCUS.ref, FOCUS.role, FOCUS.name, FOCUS.tag),
      cnode(LIST_ITEM.ref, LIST_ITEM.role, LIST_ITEM.name, LIST_ITEM.tag, { interactive: false, editable: false }),
      cnode(PUBLISH.ref, PUBLISH.role, PUBLISH.name, PUBLISH.tag),
      cnode('s-typed', 'AXStaticText', 'Typed', 'fixture.typed', { interactive: false, editable: false }),
    ],
    [
      cnode('t', 'AXTextField', 'Release name', 'fixture.releaseName', { value: 'v1.0.0' }),
      cnode(FOCUS.ref, FOCUS.role, FOCUS.name, FOCUS.tag),
      cnode(LIST_ITEM.ref, LIST_ITEM.role, LIST_ITEM.name, LIST_ITEM.tag, { interactive: false, editable: false }),
      cnode(PUBLISH.ref, PUBLISH.role, PUBLISH.name, PUBLISH.tag),
      cnode('s-typed', 'AXStaticText', 'Typed', 'fixture.typed', { interactive: false, editable: false }),
      cnode('s-focused', 'AXStaticText', 'Focused', 'fixture.focused', { interactive: false, editable: false }),
    ],
    [
      cnode('t', 'AXTextField', 'Release name', 'fixture.releaseName', { value: 'v1.0.0' }),
      cnode(FOCUS.ref, FOCUS.role, FOCUS.name, FOCUS.tag),
      cnode(LIST_ITEM.ref, LIST_ITEM.role, LIST_ITEM.name, LIST_ITEM.tag, { interactive: false, editable: false }),
      cnode(PUBLISH.ref, PUBLISH.role, PUBLISH.name, PUBLISH.tag),
      cnode('s-typed', 'AXStaticText', 'Typed', 'fixture.typed', { interactive: false, editable: false }),
      cnode('s-focused', 'AXStaticText', 'Focused', 'fixture.focused', { interactive: false, editable: false }),
      cnode('s-scrolled', 'AXStaticText', 'Scrolled', 'fixture.scrolled', { interactive: false, editable: false }),
    ],
    [
      cnode('t', 'AXTextField', 'Release name', 'fixture.releaseName', { value: 'v1.0.0' }),
      cnode(FOCUS.ref, FOCUS.role, FOCUS.name, FOCUS.tag),
      cnode(LIST_ITEM.ref, LIST_ITEM.role, LIST_ITEM.name, LIST_ITEM.tag, { interactive: false, editable: false }),
      cnode(PUBLISH.ref, PUBLISH.role, PUBLISH.name, PUBLISH.tag),
      cnode('s-typed', 'AXStaticText', 'Typed', 'fixture.typed', { interactive: false, editable: false }),
      cnode('s-focused', 'AXStaticText', 'Focused', 'fixture.focused', { interactive: false, editable: false }),
      cnode('s-scrolled', 'AXStaticText', 'Scrolled', 'fixture.scrolled', { interactive: false, editable: false }),
      cnode('s-keyed', 'AXStaticText', 'Keyed', 'fixture.keyed', { interactive: false, editable: false }),
    ],
  ]
  let phase = 0
  const acts = []
  return {
    kind: 'computer',
    async start(_owner, options) {
      return { page: { url: options?.bundleId ?? BUNDLE, title: options?.windowTitle ?? WINDOW_TITLE }, headless: false }
    },
    async observe() {
      return {
        page: { url: BUNDLE, title: WINDOW_TITLE },
        nodes: phases[Math.min(phase, phases.length - 1)].map((n) => ({ ...n })),
        truncated: false,
        coverage: { verified: true, closedShadowRoots: 0, probedNodes: 0 },
      }
    },
    async act(_owner, action) {
      acts.push(action)
      phase = Math.min(phase + 1, phases.length - 1)
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() {
      return { console: [], network: [], bounded: true, computer: { status: { detail: 'ok' } } }
    },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

async function exploreComputer(adapter, owner, outputPath) {
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), owner, { settle: SETTLE })
  await session.start({ bundleId: BUNDLE, windowTitle: WINDOW_TITLE })
  await session.observeSettled()
  await session.act({ kind: 'type', ref: 't', text: 'v1.0.0' })
  await session.act({ kind: 'focus', ref: FOCUS.ref })
  await session.act({ kind: 'scroll', ref: LIST_ITEM.ref, direction: 'down', amount: 'line' })
  await session.act({ kind: 'key', ref: PUBLISH.ref, key: 'Enter', modifiers: ['command'] })
  await session.stop()
  return exportRecordedScenario(recorder, owner, { outputPath })
}

test('computer trajectory exports with type/focus/scroll/key verbs and a durable window title', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-cu-export-'))
  try {
    const exported = await exploreComputer(computerExploreAdapter(), 'cu-export', join(dir, 'cu.json'))
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.excludedActions.length, 0, JSON.stringify(exported.excludedActions))
    const scenario = exported.scenario
    assert.equal(scenario.meta.driver, 'computer')
    assert.equal(scenario.target.launch, BUNDLE, 'bundle id is the launch selector')
    assert.equal(scenario.target.windowTitle, WINDOW_TITLE, 'the durable window title carries to replay')
    assert.equal(scenario.target.pid, undefined, 'no ephemeral PID is ever serialized')
    assert.equal(scenario.target.windowNumber, undefined, 'no window number is serialized')

    const byKind = Object.fromEntries(scenario.steps.map((s) => [s.action.kind, s]))
    // type: proven by node-value on the target; the predicate keeps role+name+identifier.
    const typed = byKind.type
    assert.ok(typed, 'type step exported')
    assert.equal(typed.action.text, 'v1.0.0')
    assert.deepEqual(typed.action.target, { role: 'AXTextField', name: 'Release name', tag: 'fixture.releaseName' })
    assert.equal(typed.assert.kind, 'node-value', 'type is proven by its own value, not a delta')
    assert.equal(typed.assert.expected.value, 'v1.0.0')

    // focus: verb preserved with the role+name+identifier predicate.
    const focused = byKind.focus
    assert.ok(focused, 'focus step exported')
    assert.deepEqual(focused.action.target, { role: 'AXButton', name: 'Focus target', tag: 'fixture.focusButton' })
    assert.equal(focused.assert.kind, 'node-present')
    assert.equal(focused.assert.expected.name, 'Focused')

    // scroll: computer container scroll preserves direction+amount and is proven
    // by a DELTA (node-present), never node-in-viewport.
    const scrolled = byKind.scroll
    assert.ok(scrolled, 'scroll step exported')
    assert.equal(scrolled.action.direction, 'down')
    assert.equal(scrolled.action.amount, 'line')
    assert.deepEqual(scrolled.action.target, { role: 'AXStaticText', name: 'List item one', tag: 'fixture.itemOne' })
    assert.equal(scrolled.assert.kind, 'node-present', 'computer scroll proof is a semantic delta, never node-in-viewport')
    assert.equal(scrolled.assert.expected.name, 'Scrolled')

    // key: modifiers preserved, role+name+identifier semantics kept.
    const keyed = byKind.key
    assert.ok(keyed, 'key step exported')
    assert.equal(keyed.action.key, 'Enter')
    assert.deepEqual(keyed.action.modifiers, ['command'])
    assert.deepEqual(keyed.action.target, { role: 'AXButton', name: 'Publish', tag: 'fixture.publish' })
    assert.equal(keyed.assert.kind, 'node-present')
    assert.equal(keyed.assert.expected.name, 'Keyed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a computer action target with no stable metadata is disclosed as a specific exclusion, not blind-accepted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-cu-export-nometa-'))
  try {
    const adapter = {
      kind: 'computer',
      async start(_owner, options) {
        return { page: { url: options?.bundleId ?? BUNDLE, title: options?.windowTitle ?? WINDOW_TITLE }, headless: false }
      },
      async observe() {
        return {
          page: { url: BUNDLE, title: WINDOW_TITLE },
          // A node with NO role, name, or identifier: nothing stable to export.
          nodes: [cnode('bare', '', '', '', { interactive: true })],
          truncated: false,
          coverage: { verified: true, closedShadowRoots: 0, probedNodes: 0 },
        }
      },
      async act() { return { status: 'confirmed', dispatched: true } },
      async evidence() { return { console: [], network: [], bounded: true } },
      async stop() { return { stopped: true, reason: 'requested' } },
    }
    const recorder = new QaTrajectoryRecorder()
    const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'cu-nometa', { settle: SETTLE })
    await session.start({ bundleId: BUNDLE, windowTitle: WINDOW_TITLE })
    await session.observeSettled()
    await session.act({ kind: 'click', ref: 'bare' })
    await session.stop()
    const exported = await exportRecordedScenario(recorder, 'cu-nometa', { outputPath: join(dir, 'cu-nometa.json') })
    assert.equal(exported.ok, false, 'no proven step, so no file is written')
    assert.equal(exported.code, 'NO_PROVEN_STEPS')
    assert.equal(exported.excludedActions.length, 1)
    assert.equal(exported.excludedActions[0].reason, 'TARGET_HAS_NO_ACCESSIBLE_NAME', JSON.stringify(exported.excludedActions))
    assert.match(exported.excludedActions[0].detail, /identifier/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
