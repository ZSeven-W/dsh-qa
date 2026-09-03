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

// QA-BL-039 role-drift regression. The fill target's role changes over time
// (Wikipedia's search input: textbox -> combobox once the lazy typeahead module
// loads). A node-value predicate pinned to the POST-switch role ("combobox")
// can never be re-matched by a fast replay, which still observes the pre-switch
// "textbox". The exporter must therefore synthesize the MOST STABLE
// discriminator: { name, value } (role omitted) when the accessible name is
// unique among all nodes in the settled observation.

const LAUNCH = 'http://127.0.0.1:7421/'
// Explore / FAST replay settle: budget long enough to observe a 600ms role
// switch. SLOW replay uses the SAME budget, so a 3000ms switch lands after it.
const SETTLE = { budgetMs: 1500, quietMs: 50, postChangeQuietMs: 100, intervalMs: 10 }

function node(ref, role, name, tag, extra = {}) {
  return {
    ref,
    role,
    name,
    tag,
    interactive: role !== 'status' && role !== 'listbox',
    editable: role === 'textbox' || role === 'combobox',
    disabled: false,
    ...extra,
  }
}

// A role-drift driver: after a fill the same element carries the typed value,
// but switchAfterMs later its role changes textbox -> combobox and the
// suggestions appear. The view is truncated (like live Wikipedia).
function roleDriftAdapter(switchAfterMs) {
  let filledAt = null
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      const switched = filledAt !== null && Date.now() - filledAt >= switchAfterMs
      const input = node('input', switched ? 'combobox' : 'textbox', 'Search Wikipedia', 'input', {
        value: filledAt === null ? '' : 'DeepSeek',
      })
      const nodes = [input]
      if (switched) {
        nodes.push(node('opt', 'option', 'DeepSeek', 'li', { interactive: true, editable: false }))
        nodes.push(node('list', 'listbox', 'Suggestions', 'ul', { interactive: false, editable: false }))
      }
      return { page: { url: LAUNCH, title: 'fixture' }, nodes, truncated: true }
    },
    async act(_owner, action) {
      if (action.kind === 'fill') filledAt = Date.now()
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

async function exploreRoleDrift(outputPath) {
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(new RecordingQaDriverAdapter(roleDriftAdapter(600), recorder), 'role-drift', { settle: SETTLE })
  await session.start({ url: LAUNCH })
  const before = await session.observeSettled()
  const input = before.observation.nodes.find((item) => item.name === 'Search Wikipedia')
  assert.ok(input, 'the fixture must expose the search input')
  await session.act({ kind: 'fill', ref: input.ref, text: 'DeepSeek' })
  await session.stop()
  return exportRecordedScenario(recorder, 'role-drift', { outputPath })
}

test('A: a role-drift fill exports a name-only node-value predicate (role omitted)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-role-drift-'))
  try {
    const exported = await exploreRoleDrift(join(dir, 'role-drift.json'))
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.excludedActions.length, 0, JSON.stringify(exported.excludedActions))
    const step = exported.scenario.steps[0]
    assert.equal(step.assert.kind, 'node-value')
    assert.deepEqual(step.assert.expected, { name: 'Search Wikipedia', value: 'DeepSeek' })
    assert.equal(step.assert.expected.role, undefined, 'the predicate must omit the drifted role')
    assert.match(step.assert.description, /Discriminator: name-only/)

    // FAST replay: the switch (600ms) is inside the settle budget, so the
    // settled observation is already the combobox; name-only still matches.
    const fast = await runScenario(exported.scenario, roleDriftAdapter(600), { ownerId: 'role-drift-fast', settle: SETTLE })
    assert.equal(fast.status, 'pass', JSON.stringify(fast.failure))

    // SLOW replay: the switch (3000ms) is AFTER the settle budget, so the
    // settled observation is still the textbox holding the typed value. The
    // name-only predicate matches the textbox, so replay still passes.
    const slow = await runScenario(exported.scenario, roleDriftAdapter(3000), { ownerId: 'role-drift-slow', settle: SETTLE })
    assert.equal(slow.status, 'pass', JSON.stringify(slow.failure))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
