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
import { normalizeReportForDeterminism, runScenario, validateScenario } from '../src/replay/index.ts'
import {
  observeUntilStable,
  projectSemanticView,
  QaSession,
  QA_SETTLE_BUDGET_MS,
  QA_SETTLE_INTERVAL_MS,
  QA_SETTLE_POST_CHANGE_QUIET_MS,
  QA_SETTLE_QUIET_MS,
  resolveSettlePolicy,
} from '../src/session/index.ts'

// Settle regression suite. Both real-world failure modes are reproduced here
// deterministically against synthetic drivers (the browser fixtures in
// test/explore-replay-async.integration.test.mjs reproduce them end to end):
//
//   A. the action's only semantic outcome arrives AFTER a single-shot proof
//      observation, so the step is excluded and replay can never reach it;
//   B. unrelated late hydration churn arrives INSTEAD, and gets mistaken for
//      the action's proof.
//
// The policy under test is small on purpose: the contract is what matters, not
// the production budget (which the browser fixtures exercise).

const LAUNCH = 'http://127.0.0.1:7399/'
const SETTLE = { budgetMs: 900, quietMs: 120, intervalMs: 5 }
const FAST = { settle: SETTLE }
const SHORTCUT_RAW = "Editing help: press [o] to open the toolbar. It's not mandatory. [o]"
const SHORTCUT_HYDRATED = "Editing help: press [ctrl-option-o] to open the toolbar. It's not mandatory. [ctrl-option-o]"

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

/**
 * A synthetic asynchronous page. Everything is expressed in WALL-CLOCK time
 * relative to the action, exactly like a real UI: the outcome of the fill (a
 * suggestion option next to the box) lands after suggestAfterMs, unrelated
 * hydration churn (the shortcut link renaming itself) lands after churnAfterMs,
 * and an optional clock never stops ticking.
 *
 * Node order puts eight navigation links between the churning shortcut link
 * (index 0) and the fill target (index 9), so the churn is well outside the
 * target-proximate window while the suggestion (index 10) is right next to it.
 */
function asyncPageAdapter(options = {}) {
  const {
    suggestAfterMs = null,
    suggestName = 'Async rendering',
    churnAfterMs = null,
    tick = null,
    tickMs = 10,
  } = options
  let observations = 0
  let actedAt = null
  const startedAt = Date.now()
  return {
    kind: 'browser',
    async start(_owner, startOptions) {
      return { page: { url: startOptions?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      observations += 1
      const suffix = '-' + observations
      const sinceAct = actedAt === null ? null : Date.now() - actedAt
      const churned = churnAfterMs !== null && sinceAct !== null && sinceAct >= churnAfterMs
      const suggested = suggestAfterMs !== null && sinceAct !== null && sinceAct >= suggestAfterMs
      const nodes = [node('shortcut' + suffix, 'link', churned ? SHORTCUT_HYDRATED : SHORTCUT_RAW, 'a')]
      for (let i = 1; i <= 8; i += 1) nodes.push(node('nav-' + i + suffix, 'link', 'Section ' + i, 'a'))
      nodes.push(node('input' + suffix, 'textbox', 'Search articles', 'input'))
      if (suggested) nodes.push(node('option' + suffix, 'option', suggestName, 'li'))
      if (tick === 'always' || (tick === 'after-act' && actedAt !== null)) {
        const base = tick === 'always' ? startedAt : actedAt
        nodes.push(node('clock' + suffix, 'status', 'TICK ' + Math.floor((Date.now() - base) / tickMs), 'div'))
      }
      nodes.push(node('result' + suffix, 'status', 'IDLE', 'div'))
      return { page: { url: LAUNCH, title: 'fixture' }, nodes, truncated: false }
    },
    async act() {
      actedAt = Date.now()
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() {
      return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } }
    },
    async stop() {
      return { stopped: true, reason: 'requested' }
    },
  }
}

async function exploreAndExport(adapter, owner, outputPath) {
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), owner, FAST)
  await session.start({ url: LAUNCH })
  const before = await session.observeSettled()
  const input = before.observation.nodes.find((item) => item.name === 'Search articles')
  assert.ok(input, 'the fixture must expose the search box')
  const acted = await session.act({ kind: 'fill', ref: input.ref, text: 'async' })
  await session.stop()
  const exported = await exportRecordedScenario(recorder, owner, { outputPath })
  return { exported, acted, snapshot: recorder.snapshot(owner) }
}

test('the semantic projection ignores session-local identity but never semantics', () => {
  const base = {
    page: { url: LAUNCH, title: 'fixture' },
    nodes: [node('ref-1', 'textbox', 'Search articles', 'input')],
    truncated: false,
  }
  const reobserved = structuredClone(base)
  reobserved.nodes[0].ref = 'ref-2'
  reobserved.fingerprint = 'different-fingerprint'
  reobserved.observationId = 'observation-9'
  assert.equal(
    projectSemanticView(base),
    projectSemanticView(reobserved),
    'refs/fingerprints/observation ids change on every read and must not look like churn',
  )

  for (const mutate of [
    (view) => { view.nodes[0].name = 'Search topics' },
    (view) => { view.nodes[0].role = 'searchbox' },
    (view) => { view.nodes[0].disabled = true },
    (view) => { view.nodes[0].inViewport = false },
    (view) => { view.page.url = LAUNCH + 'next' },
    (view) => { view.nodes.push(node('ref-3', 'option', 'Async rendering', 'li')) },
  ]) {
    const changed = structuredClone(base)
    mutate(changed)
    assert.notEqual(projectSemanticView(base), projectSemanticView(changed))
  }
})

test('the settle policy is a named, clamped, configurable constant set', () => {
  assert.deepEqual(resolveSettlePolicy(), {
    budgetMs: QA_SETTLE_BUDGET_MS,
    quietMs: QA_SETTLE_QUIET_MS,
    postChangeQuietMs: QA_SETTLE_POST_CHANGE_QUIET_MS,
    intervalMs: QA_SETTLE_INTERVAL_MS,
  })
  assert.deepEqual(resolveSettlePolicy({ budgetMs: 1, quietMs: 1, intervalMs: 99_999 }), {
    budgetMs: 20,
    quietMs: 10,
    postChangeQuietMs: 20,
    intervalMs: 10,
  })
  process.env.DSH_QA_SETTLE_BUDGET_MS = '900'
  process.env.DSH_QA_SETTLE_QUIET_MS = '120'
  try {
    assert.equal(resolveSettlePolicy().budgetMs, 900)
    assert.equal(resolveSettlePolicy().quietMs, 120)
    assert.equal(resolveSettlePolicy().postChangeQuietMs, 240, 'the default post-change quiet scales with the resolved quietMs (2 × 120)')
    process.env.DSH_QA_SETTLE_BUDGET_MS = 'whenever'
    assert.equal(resolveSettlePolicy().budgetMs, QA_SETTLE_BUDGET_MS, 'garbage falls back, never fails open')
  } finally {
    delete process.env.DSH_QA_SETTLE_BUDGET_MS
    delete process.env.DSH_QA_SETTLE_QUIET_MS
  }
})

test('settling waits for a change that has not started yet, and gives up honestly', async () => {
  // Two back-to-back reads of a page whose change has not begun agree with each
  // other; the quiet window is what stops that from counting as settled.
  const startedAt = Date.now()
  let reads = 0
  const observe = async () => {
    reads += 1
    const arrived = Date.now() - startedAt >= 150
    return {
      page: { url: LAUNCH, title: 'fixture' },
      nodes: arrived ? [node('option-' + reads, 'option', 'Async rendering', 'li')] : [],
      truncated: false,
    }
  }
  // awaitChange: this is a PROOF window, so silence is not a conclusion.
  const settled = await observeUntilStable(observe, resolveSettlePolicy(SETTLE), { awaitChange: true })
  assert.equal(settled.stable, true)
  assert.ok(settled.observation.nodes.some((item) => item.name === 'Async rendering'))
  assert.ok(settled.passes > 2, 'a settled view is several agreeing observations, not one')
  assert.ok(reads === settled.passes)

  const ticking = async () => ({
    page: { url: LAUNCH, title: 'fixture' },
    nodes: [node('clock', 'status', 'TICK ' + Date.now(), 'div')],
    truncated: false,
  })
  const never = await observeUntilStable(ticking, resolveSettlePolicy(SETTLE), { awaitChange: true })
  assert.equal(never.stable, false, 'a page that never holds still is never called settled')
  assert.ok(never.elapsedMs >= SETTLE.budgetMs - 20)
  assert.equal(never.budgetMs, SETTLE.budgetMs)
})

test('failure mode A: an async outcome is proven, exported, and replayed deterministically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-settle-async-'))
  try {
    const { exported, acted, snapshot } = await exploreAndExport(
      asyncPageAdapter({ suggestAfterMs: 150 }),
      'settle-async',
      join(dir, 'async.json'),
    )
    assert.equal(acted.settle.stable, true)
    assert.equal(snapshot.actions[0].afterObservationStable, true)
    assert.equal(exported.ok, true, 'the fill must not be excluded as unprovable')
    assert.equal(exported.excludedActions.length, 0)
    assert.equal(exported.scenario.steps.length, 1)
    const step = exported.scenario.steps[0]
    assert.equal(step.action.kind, 'fill')
    assert.deepEqual(step.assert.expected, { role: 'option', name: 'Async rendering' })
    assert.doesNotMatch(step.intent, /Weak proof/)

    // Replay twice: same policy, same view, byte-identical deterministic result.
    const reports = []
    for (let i = 0; i < 2; i += 1) {
      reports.push(await runScenario(exported.scenario, asyncPageAdapter({ suggestAfterMs: 150 }), {
        ownerId: 'settle-async-replay-' + i,
        settle: SETTLE,
      }))
    }
    assert.equal(reports[0].status, 'pass')
    assert.equal(reports[1].status, 'pass')
    assert.equal(
      JSON.stringify(normalizeReportForDeterminism(reports[0])),
      JSON.stringify(normalizeReportForDeterminism(reports[1])),
      'settling changes duration, not outcome',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('failure mode B: unrelated hydration churn never becomes the proof', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-settle-churn-'))
  try {
    const { exported, snapshot } = await exploreAndExport(
      // The churn lands FIRST (a single-shot observation would see only it),
      // the real outcome lands later, next to the target.
      asyncPageAdapter({ churnAfterMs: 5, suggestAfterMs: 100, suggestName: 'Hydration and rendering' }),
      'settle-churn',
      join(dir, 'churn.json'),
    )
    assert.equal(exported.ok, true)
    const step = exported.scenario.steps[0]
    assert.deepEqual(step.assert.expected, { role: 'option', name: 'Hydration and rendering' })
    assert.notEqual(step.assert.expected.name, SHORTCUT_HYDRATED)
    assert.doesNotMatch(step.intent, /Weak proof/)

    // The churn really did land inside the proof observation: it was ranked
    // below the target-proximate evidence, not missed.
    const proof = snapshot.observations[snapshot.actions[0].afterObservationId]
    assert.ok(proof.nodes.some((item) => item.name === SHORTCUT_HYDRATED))

    const report = await runScenario(exported.scenario, asyncPageAdapter({
      churnAfterMs: 5,
      suggestAfterMs: 100,
      suggestName: 'Hydration and rendering',
    }), { ownerId: 'settle-churn-replay', settle: SETTLE })
    assert.equal(report.status, 'pass', 'the rename must not break replay')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a distant-only delta is still exported, with its weakness recorded in the intent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-settle-distant-'))
  try {
    const { exported } = await exploreAndExport(
      asyncPageAdapter({ churnAfterMs: 5 }),
      'settle-distant',
      join(dir, 'distant.json'),
    )
    assert.equal(exported.ok, true, 'a distant delta must never be silently dropped')
    const step = exported.scenario.steps[0]
    assert.deepEqual(step.assert.expected, { role: 'link', name: SHORTCUT_HYDRATED })
    assert.match(step.intent, /Weak proof: the only observable change was away from the action target/)
    assert.match(step.assert.description, /away from the action target/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('fail-closed: a page that never settles is unprovable at export and fails at replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-settle-never-'))
  try {
    const { exported, acted } = await exploreAndExport(
      asyncPageAdapter({ tick: 'always', suggestAfterMs: 20 }),
      'settle-never',
      join(dir, 'never.json'),
    )
    assert.equal(acted.settle.stable, false)
    assert.equal(exported.ok, false)
    assert.equal(exported.code, 'NO_PROVEN_STEPS')
    assert.equal(exported.excludedActions[0].reason, 'ASSERTION_NOT_PROVABLE')
    assert.match(exported.excludedActions[0].detail, /never stabilized within the settle budget/)

    // Replay refuses the same page just as honestly. This scenario asserts on a
    // node that IS present the whole time, so only the settle contract can stop
    // it from passing by luck.
    const scenario = validateScenario({
      meta: {
        name: 'never-settles',
        description: 'hand-written: the page under test never holds still',
        driver: 'browser',
        createdAt: new Date().toISOString(),
      },
      target: { launch: LAUNCH },
      steps: [{
        index: 1,
        intent: 'Fill "Search articles".',
        action: { kind: 'fill', target: { role: 'textbox', name: 'Search articles' }, text: 'async' },
        assert: { kind: 'node-present', expected: { role: 'option', name: 'Async rendering' } },
      }],
      assertions: [{ kind: 'node-present', expected: { role: 'textbox', name: 'Search articles' } }],
    })

    const always = await runScenario(scenario, asyncPageAdapter({ tick: 'always', suggestAfterMs: 20 }), {
      ownerId: 'settle-never-replay',
      settle: SETTLE,
    })
    assert.equal(always.status, 'fail')
    assert.equal(always.failure.stepIndex, null)
    assert.match(always.failure.message, /initial observation never settled within the 900ms settle budget/)

    // A page that only starts churning after the action fails at that step.
    const afterAct = await runScenario(scenario, asyncPageAdapter({ tick: 'after-act', suggestAfterMs: 20 }), {
      ownerId: 'settle-never-step-replay',
      settle: SETTLE,
    })
    assert.equal(afterAct.status, 'fail')
    assert.equal(afterAct.failure.stepIndex, 1)
    assert.match(afterAct.failure.message, /post-action observation never settled/)
    assert.equal(afterAct.steps[0].status, 'fail')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
