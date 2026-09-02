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
import { runScenario } from '../src/replay/index.ts'
import { QaSession } from '../src/session/index.ts'

// Regression suite for two live-Wikipedia export defects (QA-BL-035 / QA-BL-036):
//   QA-BL-035 (HIGH): after a fill the search box's role changes textbox ->
//     combobox, so the pre-action predicate no longer matched and the exporter
//     fell to a delta that only passed because Wikipedia returned identical
//     suggestions twice. The fill must be proven by its own value on the
//     renamed node (role-agnostic identity), and a fragile aggregated-name
//     container must never be exported as a proof.
//   QA-BL-036 (LOW): the weak-proof note was attached to page-url and node-value
//     proofs, which truncation cannot weaken.

const LAUNCH = 'http://127.0.0.1:7421/'
const SETTLE = { budgetMs: 400, quietMs: 40, intervalMs: 5 }

function node(ref, role, name, tag, extra = {}) {
  return {
    ref,
    role,
    name,
    tag,
    interactive: role !== 'status',
    editable: role === 'textbox' || role === 'combobox',
    disabled: false,
    ...extra,
  }
}

// Suggestion entries whose accessible names concatenate into the container's
// name, exactly like Wikipedia's search box suggestions.
const DEFAULT_SUGGESTIONS = [
  'DeepSeek',
  'Chinese artificial intelligence company',
  'DeepSeek (chatbot)',
  'Chatbot developed by DeepSeek',
  'DeepSeek (disambiguation)',
  'Topics referred to by the same term',
  'Deep sea mining',
  'Mine',
]

/**
 * Fixture adapter mirroring Wikipedia: pre-fill the target is
 * `textbox "Search Wikipedia"` (value ""); post-fill the SAME element becomes
 * `combobox "Search Wikipedia"` carrying the typed value (rename: true), or
 * keeps its role with the value withheld, plus a `search` container whose
 * accessible name is the concatenation of every suggestion entry.
 */
function wikiSearchAdapter({ rename = true, withheld = false, suggestions = DEFAULT_SUGGESTIONS, truncated = true } = {}) {
  let filled = false
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      if (!filled) {
        return {
          page: { url: LAUNCH, title: 'fixture' },
          nodes: [node('input', 'textbox', 'Search Wikipedia', 'input', { value: '' })],
          truncated: false,
        }
      }
      const containerName = 'Search ' + suggestions.join('')
      return {
        page: { url: LAUNCH, title: 'fixture' },
        nodes: [
          node('input', rename ? 'combobox' : 'textbox', 'Search Wikipedia', 'input',
            withheld ? { valueWithheld: true } : { value: 'DeepSeek' }),
          node('suggestions', 'search', containerName, 'div', { interactive: false, editable: false }),
        ],
        truncated,
      }
    },
    async act(_owner, action) {
      if (action.kind === 'fill') filled = true
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

// A withheld fill whose only downstream delta is a SHORT-named status node (the
// normal delta path, never a fragile container).
function shortDeltaAdapter({ truncated = false } = {}) {
  let filled = false
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      if (!filled) {
        return {
          page: { url: LAUNCH, title: 'fixture' },
          nodes: [node('input', 'textbox', 'Search Wikipedia', 'input', { value: '' })],
          truncated: false,
        }
      }
      return {
        page: { url: LAUNCH, title: 'fixture' },
        nodes: [
          node('input', 'textbox', 'Search Wikipedia', 'input', { valueWithheld: true }),
          node('status', 'status', 'Search ready', 'div', { interactive: true, editable: false }),
        ],
        truncated,
      }
    },
    async act(_owner, action) {
      if (action.kind === 'fill') filled = true
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

// Two nodes holding the typed value with DIFFERENT names and roles, so no
// unique identity can be assigned to the value write (uniqueness fall-through).
function twinValueAdapter() {
  let filled = false
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      if (!filled) {
        return {
          page: { url: LAUNCH, title: 'fixture' },
          nodes: [node('input', 'textbox', 'Search Wikipedia', 'input', { value: '' })],
          truncated: false,
        }
      }
      return {
        page: { url: LAUNCH, title: 'fixture' },
        nodes: [
          node('a', 'combobox', 'Search Wikipedia', 'input', { value: 'DeepSeek' }),
          node('b', 'textbox', 'Other field', 'input', { value: 'DeepSeek' }),
        ],
        truncated: false,
      }
    },
    async act(_owner, action) {
      if (action.kind === 'fill') filled = true
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

function navigateAdapter() {
  let url = LAUNCH
  return {
    kind: 'browser',
    async start(_owner, options) {
      url = options?.url ?? LAUNCH
      return { page: { url, title: 'fixture' }, headless: true }
    },
    async observe() {
      return { page: { url, title: 'fixture' }, nodes: [node('go', 'button', 'Go', 'button')], truncated: true }
    },
    async act(_owner, action) {
      if (action.kind === 'navigate') url = action.url
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

async function exploreFill(adapter, owner, outputPath, text = 'DeepSeek') {
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), owner, { settle: SETTLE })
  await session.start({ url: LAUNCH })
  const before = await session.observeSettled()
  const input = before.observation.nodes.find((item) => item.name === 'Search Wikipedia')
  assert.ok(input, 'the fixture must expose the search input')
  await session.act({ kind: 'fill', ref: input.ref, text })
  await session.stop()
  return exportRecordedScenario(recorder, owner, { outputPath })
}

async function exploreNavigate(outputPath) {
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(new RecordingQaDriverAdapter(navigateAdapter(), recorder), 'nav-trunc', { settle: SETTLE })
  await session.start({ url: LAUNCH })
  await session.observeSettled()
  await session.act({ kind: 'navigate', url: 'https://example.test/target' })
  await session.stop()
  return exportRecordedScenario(recorder, 'nav-trunc', { outputPath })
}

test('A: a role-changing fill is proven by node-value on the renamed target, independent of suggestions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-wiki-fill-'))
  try {
    const exported = await exploreFill(wikiSearchAdapter(), 'wiki-fill', join(dir, 'wiki-fill.json'))
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.excludedActions.length, 0, JSON.stringify(exported.excludedActions))
    const step = exported.scenario.steps[0]
    assert.equal(step.assert.kind, 'node-value', 'the proof is the target value, never the suggestion container')
    assert.deepEqual(step.assert.expected, { role: 'combobox', name: 'Search Wikipedia', value: 'DeepSeek' })
    assert.doesNotMatch(step.intent, /Weak proof/, 'a node-value on the found target is sound even on a truncated view')

    // Replay passes against the same fixture and against a fixture whose
    // suggestion list differs: the proof depends on the target's value, never
    // on the suggestion ordering.
    const same = await runScenario(exported.scenario, wikiSearchAdapter(), { ownerId: 'wiki-replay-same', settle: SETTLE })
    assert.equal(same.status, 'pass', JSON.stringify(same.failure))

    const different = await runScenario(exported.scenario, wikiSearchAdapter({
      suggestions: ['Something else entirely', 'Another unrelated suggestion'],
    }), { ownerId: 'wiki-replay-different', settle: SETTLE })
    assert.equal(different.status, 'pass', JSON.stringify(different.failure))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('B: a withheld value whose only delta is the aggregated container excludes the step (FRAGILE_PROOF_ONLY)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-fragile-'))
  try {
    // No role change, so the target is NOT itself a delta; the search container
    // (a 150+ character concatenation of suggestion entries) is the ONLY change.
    const exported = await exploreFill(
      wikiSearchAdapter({ rename: false, withheld: true }),
      'fragile',
      join(dir, 'fragile.json'),
    )
    assert.equal(exported.ok, false, JSON.stringify(exported))
    assert.equal(exported.code, 'NO_PROVEN_STEPS')
    assert.equal(exported.excludedActions.length, 1)
    const exclusion = exported.excludedActions[0]
    assert.equal(exclusion.reason, 'FRAGILE_PROOF_ONLY')
    assert.match(exclusion.detail, /container role "search"/)
    assert.match(exclusion.detail, /DeepSeek/, 'the detail names the rejected node')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('C: a short-named unique delta is still exported as node-present (normal path)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-short-delta-'))
  try {
    const exported = await exploreFill(shortDeltaAdapter(), 'short-delta', join(dir, 'short-delta.json'))
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.excludedActions.length, 0)
    const step = exported.scenario.steps[0]
    assert.equal(step.assert.kind, 'node-present')
    assert.deepEqual(step.assert.expected, { role: 'status', name: 'Search ready' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('D: the truncation weak-proof note attaches only when truncation can weaken the proof', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-trunc-note-'))
  try {
    // D1: a page-url proof on a truncated view carries no note (the URL travels
    // on every observation).
    const d1 = await exploreNavigate(join(dir, 'd1.json'))
    assert.equal(d1.ok, true, JSON.stringify(d1))
    assert.equal(d1.scenario.steps[0].assert.kind, 'page-url')
    assert.doesNotMatch(d1.scenario.steps[0].intent, /Weak proof/)

    // D2: a delta-derived node-present on a truncated view carries the note.
    const d2 = await exploreFill(shortDeltaAdapter({ truncated: true }), 'd2', join(dir, 'd2.json'))
    assert.equal(d2.ok, true, JSON.stringify(d2))
    assert.equal(d2.scenario.steps[0].assert.kind, 'node-present')
    assert.match(d2.scenario.steps[0].intent, /Weak proof: .*truncated at the driver node budget/)

    // D3: a node-value on a found target on a truncated view carries no note.
    const d3 = await exploreFill(wikiSearchAdapter({ rename: true }), 'd3', join(dir, 'd3.json'))
    assert.equal(d3.ok, true, JSON.stringify(d3))
    assert.equal(d3.scenario.steps[0].assert.kind, 'node-value')
    assert.doesNotMatch(d3.scenario.steps[0].intent, /Weak proof/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('E: several nodes holding the typed value with different names/roles fall through (no guessed node-value)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-unique-'))
  try {
    const exported = await exploreFill(twinValueAdapter(), 'twin', join(dir, 'twin.json'))
    assert.equal(exported.ok, true, JSON.stringify(exported))
    const step = exported.scenario.steps[0]
    assert.notEqual(step.assert.kind, 'node-value', 'an ambiguous value write must never become a node-value assertion')
    assert.equal(step.assert.kind, 'node-present', 'the fill falls through to the delta ranking')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
