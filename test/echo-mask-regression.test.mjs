import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QaSession, resolveSettlePolicy } from '../src/session/index.ts'
import {
  exportRecordedScenario,
  QaTrajectoryRecorder,
  RecordingQaDriverAdapter,
} from '../src/explore/index.ts'

// Adversarial echo-mask regression suite, ported from
// /tmp/qa-audit3-probes/probes/settle-echo.mjs + echo-followups.mjs
// (independent audit of the settle echo mask). The three defects closed here:
//
//   1. a fill that REWRITES the target's accessible name ("Search" ->
//      "Search: async") escaped the echo mask, settle returned at ~128ms and
//      missed the 400ms suggestion, and export proved the renamed field with
//      node-present instead of the target's own value;
//   3. select and key were never echo-masked, so their own value write
//      satisfied awaitChange and the 400ms downstream consequence was missed;
//   4. a duplicate (role,name,tag) or an empty name made the predicate match
//      SIBLING nodes, so a legitimate sibling value change was masked and the
//      window burned its whole budget (over-masking).
//
// All timing is wall-clock like the probes: deterministic defects, generous
// assertion margins.

const POLICY = resolveSettlePolicy({ budgetMs: 900, quietMs: 120, intervalMs: 15 })
const FAST = resolveSettlePolicy({ budgetMs: 500, quietMs: 80, intervalMs: 10 })
const SUGGEST_AT = 400

function node(ref, role, name, tag, extra = {}) {
  return {
    ref,
    role,
    name,
    tag,
    interactive: role !== 'status' && role !== 'option',
    editable: role === 'textbox',
    disabled: false,
    ...extra,
  }
}

function observation({ url = 'https://example.test/', title = 'fixture', nodes = [] } = {}) {
  return { page: { url, title }, nodes, truncated: false }
}

function timedAdapter({ afterAct }) {
  let actedAt = null
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? 'https://example.test/', title: 'fixture' }, headless: true }
    },
    async observe() {
      const since = actedAt === null ? null : Date.now() - actedAt
      return afterAct(since)
    },
    async act() {
      actedAt = Date.now()
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'ok' } },
  }
}

async function runAct(adapter, action, settle = POLICY) {
  const session = new QaSession(adapter, 'echo-' + action.kind, { settle })
  await session.start({ url: 'https://example.test/' })
  await session.observeSettled()
  const acted = await session.act(action)
  await session.stop()
  return acted
}

async function explore(adapter, owner, outputPath, action, settle = POLICY) {
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), owner, { settle })
  await session.start({ url: 'https://example.test/' })
  await session.observeSettled()
  await session.act(action)
  await session.stop()
  return exportRecordedScenario(recorder, owner, { outputPath })
}

test('a fill that rewrites the target name keeps the echo masked; the 400ms suggestion is still observed', async () => {
  const adapter = timedAdapter({
    afterAct(since) {
      const filled = since !== null
      const nodes = [
        node('in', 'textbox', filled ? 'Search: async' : 'Search', 'input', { value: filled ? 'async' : '' }),
      ]
      if (since !== null && since >= SUGGEST_AT) nodes.push(node('opt', 'option', 'Async rendering', 'li'))
      return observation({ nodes })
    },
  })
  const acted = await runAct(adapter, { kind: 'fill', ref: 'in', text: 'async' })
  const hasSuggest = acted.observation.nodes.some((n) => n.name === 'Async rendering')
  assert.equal(acted.settle.stable, true, JSON.stringify(acted.settle))
  assert.equal(hasSuggest, true, 'the suggestion must be inside the settled proof observation')
  assert.ok(acted.settle.elapsedMs >= SUGGEST_AT, 'the window must not conclude on the renamed echo alone: ' + acted.settle.elapsedMs)
})

test('export of the renaming fill prefers node-value on the renamed target, never node-present of the renamed field', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-echo-name-'))
  try {
    const adapter = timedAdapter({
      afterAct(since) {
        const filled = since !== null
        const nodes = [
          node('in', 'textbox', filled ? 'Search: async' : 'Search', 'input', { value: filled ? 'async' : '' }),
        ]
        if (since !== null && since >= SUGGEST_AT) nodes.push(node('opt', 'option', 'Async rendering', 'li'))
        return observation({ nodes })
      },
    })
    const exported = await explore(adapter, 'namechg', join(dir, 'namechg.json'), { kind: 'fill', ref: 'in', text: 'async' })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    const step = exported.scenario.steps[0]
    assert.equal(step.assert.kind, 'node-value', 'the renamed field alone must not become node-present')
    assert.equal(step.assert.expected.role, 'textbox')
    assert.equal(step.assert.expected.name, 'Search: async', 'the proof binds the CURRENT (renamed) predicate')
    assert.equal(step.assert.expected.value, 'async')
    assert.equal(step.action.target.name, 'Search', 'the action target keeps the pre-action name replay resolves against')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('duplicate (role,name,tag) twins: a sibling mirror must not be masked; the suggestion is still waited for', async () => {
  const adapter = timedAdapter({
    afterAct(since) {
      const aVal = since === null ? '' : 'typed'
      const bVal = since !== null && since >= 80 ? 'mirror-of-typed' : ''
      const nodes = [
        node('a', 'textbox', 'Email', 'input', { value: aVal }),
        node('b', 'textbox', 'Email', 'input', { value: bVal }),
      ]
      if (since !== null && since >= SUGGEST_AT) nodes.push(node('opt', 'option', 'Async rendering', 'li'))
      return observation({ nodes })
    },
  })
  const acted = await runAct(adapter, { kind: 'fill', ref: 'a', text: 'typed' })
  const bVal = acted.observation.nodes.find((n) => n.ref === 'b')?.value
  assert.equal(bVal, 'mirror-of-typed', 'the sibling value must be observed unmasked')
  assert.equal(acted.settle.stable, true)
  // The sibling's value change is legitimate evidence: the window must conclude
  // from it (~quietMs after 80ms), never burn the whole budget. A later
  // suggestion landing outside the quiet window is the documented settle bound
  // (SETTLE.md), not over-masking.
  assert.ok(
    acted.settle.elapsedMs < POLICY.budgetMs - 50,
    'the window must not spend the budget (elapsed ' + acted.settle.elapsedMs + 'ms)',
  )
})

test('duplicate twins with ONLY a sibling value downstream: the window concludes ~quietMs after it, not the whole budget', async () => {
  const adapter = timedAdapter({
    afterAct(since) {
      const aVal = since === null ? '' : 'typed'
      const bVal = since !== null && since >= 80 ? 'mirror-of-typed' : ''
      return observation({
        nodes: [
          node('a', 'textbox', 'Email', 'input', { value: aVal }),
          node('b', 'textbox', 'Email', 'input', { value: bVal }),
        ],
      })
    },
  })
  const acted = await runAct(adapter, { kind: 'fill', ref: 'a', text: 'typed' }, FAST)
  const bVal = acted.observation.nodes.find((n) => n.ref === 'b')?.value
  assert.equal(bVal, 'mirror-of-typed', 'a value change on another node is legitimate evidence')
  assert.equal(acted.settle.stable, true)
  assert.ok(
    acted.settle.elapsedMs < FAST.budgetMs - 50,
    'the sibling value change must unblock awaitChange (elapsed ' + acted.settle.elapsedMs + 'ms of ' + FAST.budgetMs + 'ms)',
  )
})

test('an empty-named textbox echo must not mask a named sibling textbox', async () => {
  const adapter = timedAdapter({
    afterAct(since) {
      const aVal = since === null ? '' : 'typed'
      const searchVal = since !== null && since >= 80 ? 'live-query' : ''
      const nodes = [
        node('a', 'textbox', '', 'input', { value: aVal }),
        node('s', 'textbox', 'Search articles', 'input', { value: searchVal }),
      ]
      if (since !== null && since >= SUGGEST_AT) nodes.push(node('opt', 'option', 'Async rendering', 'li'))
      return observation({ nodes })
    },
  })
  const acted = await runAct(adapter, { kind: 'fill', ref: 'a', text: 'typed' })
  const searchVal = acted.observation.nodes.find((n) => n.ref === 's')?.value
  assert.equal(searchVal, 'live-query', 'the named sibling value must be observed unmasked')
  assert.equal(acted.settle.stable, true)
  // Same contract as the duplicate-twins test: the sibling change unblocks
  // awaitChange; the window never burns its budget.
  assert.ok(
    acted.settle.elapsedMs < POLICY.budgetMs - 50,
    'the window must not spend the budget (elapsed ' + acted.settle.elapsedMs + 'ms)',
  )
})

test('empty-named target with ONLY the named sibling downstream does not spend the budget', async () => {
  const adapter = timedAdapter({
    afterAct(since) {
      const aVal = since === null ? '' : 'typed'
      const searchVal = since !== null && since >= 80 ? 'live-query' : ''
      return observation({
        nodes: [
          node('a', 'textbox', '', 'input', { value: aVal }),
          node('s', 'textbox', 'Search articles', 'input', { value: searchVal }),
        ],
      })
    },
  })
  const acted = await runAct(adapter, { kind: 'fill', ref: 'a', text: 'typed' }, FAST)
  const searchVal = acted.observation.nodes.find((n) => n.ref === 's')?.value
  assert.equal(searchVal, 'live-query', 'the named sibling value change is legitimate awaitChange evidence')
  assert.equal(acted.settle.stable, true)
  assert.ok(
    acted.settle.elapsedMs < FAST.budgetMs - 50,
    'the sibling value change must unblock awaitChange (elapsed ' + acted.settle.elapsedMs + 'ms of ' + FAST.budgetMs + 'ms)',
  )
})

test('type keeps the echo mask: the 400ms suggestion is still observed', async () => {
  const adapter = timedAdapter({
    afterAct(since) {
      const nodes = [node('in', 'textbox', 'Search', 'input', { value: since === null ? '' : 'async' })]
      if (since !== null && since >= SUGGEST_AT) nodes.push(node('opt', 'option', 'Async rendering', 'li'))
      return observation({ nodes })
    },
  })
  const acted = await runAct(adapter, { kind: 'type', ref: 'in', text: 'async' })
  const hasSuggest = acted.observation.nodes.some((n) => n.name === 'Async rendering')
  assert.equal(acted.settle.stable, true)
  assert.equal(hasSuggest, true, 'the window must wait past the type echo')
})

test('key is echo-masked on a unique target: the 400ms suggestion is still observed', async () => {
  const adapter = timedAdapter({
    afterAct(since) {
      const nodes = [node('in', 'textbox', 'Search', 'input', { value: since === null ? '' : 'async' })]
      if (since !== null && since >= SUGGEST_AT) nodes.push(node('opt', 'option', 'Async rendering', 'li'))
      return observation({ nodes })
    },
  })
  const acted = await runAct(adapter, { kind: 'key', ref: 'in', key: 'a' })
  const hasSuggest = acted.observation.nodes.some((n) => n.name === 'Async rendering')
  assert.equal(acted.settle.stable, true)
  assert.equal(hasSuggest, true, 'the window must wait past the key echo')
})

test('select is echo-masked: the 400ms downstream option is still observed', async () => {
  const adapter = timedAdapter({
    afterAct(since) {
      const nodes = [node('s', 'combobox', 'Country', 'select', { value: since === null ? 'Pick' : 'US' })]
      if (since !== null && since >= SUGGEST_AT) nodes.push(node('opt', 'option', 'Cities loaded', 'li'))
      return observation({ nodes })
    },
  })
  const acted = await runAct(adapter, { kind: 'select', ref: 's', option: 'US' })
  const hasCities = acted.observation.nodes.some((n) => n.name === 'Cities loaded')
  assert.equal(acted.settle.stable, true)
  assert.equal(hasCities, true, 'the window must wait past the select value write')
})

test('an inert fill spends the budget and still exports node-value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-echo-inert-'))
  try {
    const adapter = timedAdapter({
      afterAct(since) {
        return observation({
          nodes: [node('in', 'textbox', 'Release name', 'input', { value: since === null ? '' : 'v1.0.0' })],
        })
      },
    })
    const recorder = new QaTrajectoryRecorder()
    const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'inert', { settle: POLICY })
    await session.start({ url: 'https://example.test/' })
    await session.observeSettled()
    const acted = await session.act({ kind: 'fill', ref: 'in', text: 'v1.0.0' })
    await session.stop()
    const exported = await exportRecordedScenario(recorder, 'inert', { outputPath: join(dir, 'inert.json') })
    assert.equal(acted.settle.stable, true)
    assert.ok(
      acted.settle.elapsedMs >= POLICY.budgetMs - 50,
      'an echo-only fill must not end the wait early (elapsed ' + acted.settle.elapsedMs + 'ms)',
    )
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.scenario.steps[0].assert.kind, 'node-value', 'the inert fill is proven by its own value')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('early distant churn plus a late suggestion: export proves the target value, never the churn rename', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-echo-proof-'))
  try {
    const adapter = timedAdapter({
      afterAct(since) {
        const nodes = [node('in', 'textbox', 'Search articles', 'input', { value: since === null ? '' : 'async' })]
        if (since !== null && since >= 20) {
          nodes.unshift(node('far', 'link', 'Hydrated shortcut', 'a'))
        }
        if (since !== null && since >= SUGGEST_AT) {
          nodes.push(node('opt', 'option', 'Async rendering', 'li'))
        }
        return observation({ nodes })
      },
    })
    const exported = await explore(adapter, 'proof', join(dir, 'proof.json'), { kind: 'fill', ref: 'in', text: 'async' })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    const step = exported.scenario.steps[0]
    assert.equal(step.assert.kind, 'node-value', 'the proof is the target value')
    assert.equal(step.assert.expected.name, 'Search articles')
    assert.notEqual(step.assert.expected.name, 'Hydrated shortcut', 'the 20ms distant rename must never be the proof')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

