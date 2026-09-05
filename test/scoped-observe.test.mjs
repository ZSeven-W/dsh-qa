import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserAdapter, ComputerAdapter } from '../src/adapters/index.ts'
import {
  exportRecordedScenario,
  QaTrajectoryRecorder,
} from '../src/explore/index.ts'
import {
  decideAssertion,
  decideAssertionWithRetry,
  evaluateAssertion,
  runScenario,
  validateAssertion,
  validateScenario,
  ScenarioValidationError,
  QA_ESCALATED_NODE_BUDGET,
} from '../src/replay/index.ts'
import {
  QA_INCONCLUSIVE_TRUNCATED,
  QA_TARGET_NOT_UNIQUE,
} from '../src/contracts.ts'

// Scoped-observation unit suite (browser driver contract v8). The real-Chrome
// twin lives in test/scoped-observe.integration.test.mjs.

const LAUNCH = 'http://127.0.0.1:7466/'
const SETTLE = { budgetMs: 400, quietMs: 40, intervalMs: 5 }

function node(ref, role, name, tag, extra = {}) {
  return {
    ref,
    role,
    name,
    tag,
    interactive: role !== 'status' && role !== 'region',
    editable: false,
    disabled: false,
    ...extra,
  }
}

function view(nodes, extra = {}) {
  return { page: { url: LAUNCH, title: 'scoped fixture' }, nodes, truncated: false, ...extra }
}

const CONTAINER_SCOPE = { ref: 'br-c', role: 'region', name: 'Deep container', tag: 'div' }

// ---------------------------------------------------------------------------
// 1. Adapter plumbing: withinRef -> within, driver scope -> QaObservation.scope
// ---------------------------------------------------------------------------

function fakeV8Driver() {
  const calls = []
  const page = { url: LAUNCH, title: 'scoped fixture' }
  return {
    calls,
    driver: {
      kind: 'browser',
      contractVersion: 8,
      async start(ownerId, options) {
        return {
          ownerId, state: 'running', headless: options?.headless !== false,
          browser: { channel: 'chrome', version: 'fixture' }, page,
          isolation: 'ephemeral-user-data',
          navigationPolicy: { mode: 'unrestricted', allowedOrigins: [] },
        }
      },
      async observe(ownerId, options) {
        calls.push(options ?? {})
        if (options?.within === 'br-c') {
          return {
            ownerId, epoch: 2, fingerprint: 'fp2', expiresAt: 'x',
            page: { url: LAUNCH, title: 'scoped fixture', viewport: { width: 1, height: 1 } },
            scope: { ref: 'br-c', role: 'region', name: 'Deep container', tag: 'div' },
            nodes: [node('br-c', 'region', 'Deep container', 'div'), node('br-s', 'status', 'READY', 'div')],
            truncated: false,
            limits: { maxNodes: 40, maxBytes: 4096 },
          }
        }
        return {
          ownerId, epoch: 1, fingerprint: 'fp1', expiresAt: 'x',
          page: { url: LAUNCH, title: 'scoped fixture', viewport: { width: 1, height: 1 } },
          scope: null,
          nodes: [node('br-f', 'button', 'Filler 01', 'button')],
          truncated: true,
          limits: { maxNodes: 60, maxBytes: 4096 },
        }
      },
      async act() {
        return { receiptId: 'r', ownerId: 'a', action: 'click', status: 'confirmed', startedAt: 'a', completedAt: 'b', dispatched: true, pageBefore: page, pageAfter: page }
      },
      async evidence() {
        return { ownerId: 'a', page, console: [], network: [], bounded: true, limits: { console: 1, network: 1 }, dropped: { console: 0, network: 0 } }
      },
      async stop() { return { ownerId: 'a', stopped: true, reason: 'requested' } },
      async dispose() {},
    },
  }
}

test('BrowserAdapter maps withinRef to the driver within and projects the driver scope', async () => {
  const { driver, calls } = fakeV8Driver()
  const adapter = new BrowserAdapter(driver)

  const scoped = await adapter.observe('a', { withinRef: 'br-c', maxNodes: 40 })
  assert.deepEqual(calls[0], { within: 'br-c', maxNodes: 40 }, 'withinRef must travel to the driver as within')
  assert.deepEqual(
    scoped.scope,
    { ref: 'br-c', role: 'region', name: 'Deep container', tag: 'div' },
    'the driver scope must be projected verbatim',
  )
  assert.equal(scoped.truncated, false)
  assert.equal(scoped.maxNodes, 40)

  // Whole-page observations (scope null) must NOT project a scope field: the
  // field is honest-optional, absent means "no scoped view was observed".
  const whole = await adapter.observe('a', { maxNodes: 60 })
  assert.deepEqual(calls[1], { maxNodes: 60 })
  assert.equal(whole.scope, undefined, 'a whole-page observation must not carry scope')
  assert.equal(whole.truncated, true)
})

test('ComputerAdapter refuses a withinRef instead of silently ignoring it', async () => {
  let observed = 0
  const driver = {
    kind: 'computer',
    contractVersion: 4,
    async observe() { observed += 1; throw new Error('the computer driver must not be called for a scoped observe') },
  }
  const adapter = new ComputerAdapter(driver)
  await assert.rejects(
    adapter.observe('c', { withinRef: 'some-ref' }),
    /computer driver does not support scoped observation/,
  )
  assert.equal(observed, 0, 'the refusal must happen before the driver is touched')
})

// ---------------------------------------------------------------------------
// 2. Assertion soundness on scoped views
// ---------------------------------------------------------------------------

test('node-absent passes on a COMPLETE scoped view (absence is provable inside the container)', () => {
  const scopedComplete = view([], { scope: CONTAINER_SCOPE })
  const result = evaluateAssertion({ kind: 'node-absent', expected: { role: 'link' } }, scopedComplete)
  assert.equal(result.passed, true, 'nothing matched in a complete container view: provable absence')
  assert.equal(result.inconclusive, false)
})

test('decideAssertion names the scope whenever the deciding view was scoped, complete or truncated', async () => {
  const scopedComplete = view([], { scope: CONTAINER_SCOPE })
  const pass = await decideAssertion(
    { kind: 'node-absent', expected: { role: 'link' } },
    scopedComplete,
    async () => { throw new Error('a complete view must never escalate') },
  )
  assert.equal(pass.passed, true)
  assert.ok(pass.completeness !== null, 'a scoped deciding view always carries completeness')
  assert.deepEqual(pass.completeness.scope, { role: 'region', name: 'Deep container' }, 'the completeness block names the scope')
  assert.equal(pass.completeness.truncated, false)
  assert.equal(pass.completeness.reason, undefined)
  assert.match(pass.completeness.detail, /scoped to the region named "Deep container"/)
})

test('node-absent on a TRUNCATED scoped view escalates WITHIN the scope and still fails closed INCONCLUSIVE_TRUNCATED', async () => {
  // Every scoped view includes its scope root node: that node's fresh ref is
  // the chain key for the next within (the scope.ref echo is the CONSUMED
  // ref), exactly as the driver re-collects it.
  const scopedTruncated = view([node('br-c', 'region', 'Deep container', 'div')], {
    scope: CONTAINER_SCOPE,
    truncated: true,
    maxNodes: 40,
    truncationReasons: ['node-budget-exceeded'],
  })
  const escalationCalls = []
  const reobserve = async (options) => {
    escalationCalls.push(options)
    return view([node('br-c', 'region', 'Deep container', 'div')], { scope: CONTAINER_SCOPE, truncated: true, maxNodes: 40, truncationReasons: ['node-budget-exceeded'] })
  }
  const decision = await decideAssertion(
    { kind: 'node-absent', expected: { role: 'link' } },
    scopedTruncated,
    reobserve,
  )
  assert.equal(decision.passed, false)
  assert.deepEqual(escalationCalls, [
    { maxNodes: QA_ESCALATED_NODE_BUDGET, withinRef: 'br-c' },
  ], 'the one bounded escalation must stay inside the scope, never widen to the whole page')
  assert.equal(decision.completeness.reason, QA_INCONCLUSIVE_TRUNCATED)
  assert.deepEqual(decision.completeness.scope, { role: 'region', name: 'Deep container' })
  assert.match(decision.completeness.detail, /scoped to the region named "Deep container"/)
})

test('an UNscoped truncated view keeps its exact escalation and INCONCLUSIVE_TRUNCATED semantics', async () => {
  const wholeTruncated = view([], { truncated: true, maxNodes: 100, truncationReasons: ['node-budget-exceeded'] })
  const escalationCalls = []
  const decision = await decideAssertion(
    { kind: 'node-absent', expected: { role: 'link' } },
    wholeTruncated,
    async (options) => {
      escalationCalls.push(options)
      return view([], { truncated: true, maxNodes: 100, truncationReasons: ['node-budget-exceeded'] })
    },
  )
  assert.deepEqual(escalationCalls, [{ maxNodes: QA_ESCALATED_NODE_BUDGET }], 'no withinRef for a whole-page escalation')
  assert.equal(decision.completeness.reason, QA_INCONCLUSIVE_TRUNCATED)
  assert.equal(decision.completeness.scope, undefined, 'an unscoped deciding view never names a scope')
})

test('a scoped decision whose deciding view is COMPLETE does not escalate and passes inside the scope', async () => {
  const scopedTruncatedFirst = view([node('br-c', 'region', 'Deep container', 'div')], { scope: CONTAINER_SCOPE, truncated: true, maxNodes: 40 })
  const escalationCalls = []
  const decision = await decideAssertion(
    { kind: 'node-absent', expected: { role: 'link' } },
    scopedTruncatedFirst,
    async (options) => {
      escalationCalls.push(options)
      return view([node('br-c', 'region', 'Deep container', 'div')], { scope: CONTAINER_SCOPE, truncated: false, maxNodes: QA_ESCALATED_NODE_BUDGET })
    },
  )
  assert.equal(decision.passed, true, 'the complete scoped escalation proves the absence')
  assert.deepEqual(escalationCalls, [{ maxNodes: QA_ESCALATED_NODE_BUDGET, withinRef: 'br-c' }])
  assert.deepEqual(decision.completeness.scope, { role: 'region', name: 'Deep container' })
})

test('the positive-existence retry keeps re-observing WITHIN the scope', async () => {
  const scopedCompleteWithout = view([node('br-c', 'region', 'Deep container', 'div')], { scope: CONTAINER_SCOPE })
  const scopedWithReady = view(
    [node('br-c', 'region', 'Deep container', 'div'), node('br-s', 'status', 'READY', 'div')],
    { scope: CONTAINER_SCOPE },
  )
  const retryCalls = []
  let reads = 0
  const decision = await decideAssertionWithRetry(
    { kind: 'node-present', expected: { role: 'status', name: 'READY' } },
    scopedCompleteWithout,
    async (options) => {
      retryCalls.push(options)
      reads += 1
      return reads >= 1 ? scopedWithReady : scopedCompleteWithout
    },
    1_000,
  )
  assert.equal(decision.passed, true)
  assert.ok(retryCalls.length >= 1)
  for (const call of retryCalls) {
    assert.equal(call.withinRef, 'br-c', 'every retry read must stay inside the scope: ' + JSON.stringify(call))
    assert.equal(call.maxNodes, QA_ESCALATED_NODE_BUDGET)
  }
})

// ---------------------------------------------------------------------------
// 3. Loader validation of the new scope field (fail-closed)
// ---------------------------------------------------------------------------

test('the loader accepts a scope predicate on an assertion and rejects malformed ones', () => {
  const valid = validateAssertion({
    kind: 'node-absent',
    expected: { role: 'button', name: 'x' },
    scope: { role: 'region', name: 'Deep container' },
  })
  assert.deepEqual(valid.scope, { role: 'region', name: 'Deep container' })

  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'button' }, scope: { role: 'region' } }),
    ScenarioValidationError,
  )
  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'button' }, scope: { role: 'region', name: 'x', tag: 'div' } }),
    ScenarioValidationError,
  )
  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'button' }, scope: { role: '', name: 'x' } }),
    ScenarioValidationError,
  )
  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'button' }, scope: 'region' }),
    ScenarioValidationError,
  )
  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'button' }, scope: { role: 'region', name: 7 } }),
    ScenarioValidationError,
  )
})

test('a scenario whose assertions carry scope round-trips through validateScenario', () => {
  const scenario = validateScenario({
    meta: { name: 's', description: 'd', driver: 'browser', createdAt: '2026-09-05T12:00:00.000Z' },
    target: { launch: LAUNCH },
    steps: [{
      index: 1,
      intent: 'click',
      action: { kind: 'click', target: { role: 'button', name: 'anchor' } },
      assert: {
        kind: 'node-present',
        expected: { role: 'status', name: 'READY' },
        scope: { role: 'region', name: 'Deep container' },
      },
    }],
    assertions: [
      { kind: 'node-absent', expected: { role: 'link' }, scope: { role: 'region', name: 'Deep container' } },
    ],
  })
  assert.deepEqual(scenario.steps[0].assert.scope, { role: 'region', name: 'Deep container' })
  assert.deepEqual(scenario.assertions[0].scope, { role: 'region', name: 'Deep container' })
})

// ---------------------------------------------------------------------------
// 4. Export records the scope the explorer used
// ---------------------------------------------------------------------------

const wholeBefore = () => view([
  node('br-c', 'region', 'Deep container', 'div'),
  node('br-a', 'button', 'anchor', 'button'),
  node('br-s', 'status', 'IDLE', 'div'),
], { truncated: true })

const scopedAfter = () => view([
  node('br-c', 'region', 'Deep container', 'div'),
  node('br-a', 'button', 'anchor', 'button'),
  node('br-s', 'status', 'READY', 'div'),
], { scope: CONTAINER_SCOPE, truncated: false })

const wholeAfter = () => view([
  node('br-f', 'button', 'Filler 01', 'button'),
  node('br-c', 'region', 'Deep container', 'div'),
  node('br-a', 'button', 'anchor', 'button'),
  node('br-s', 'status', 'READY', 'div'),
], { truncated: true })

/** Export one explored click step whose proof observations are configurable. */
async function exportScopedStep(dir, before, after) {
  const recorder = new QaTrajectoryRecorder()
  recorder.start('sc', 'browser', { url: LAUNCH }, { page: { url: LAUNCH, title: 'scoped fixture' }, headless: true })
  recorder.observation('sc', before)
  const actionId = recorder.action('sc', { kind: 'click', ref: 'br-a' })
  recorder.receipt('sc', actionId, { status: 'confirmed', dispatched: true })
  recorder.observation('sc', after)
  recorder.settle('sc', { stable: true, passes: 2, elapsedMs: 10, budgetMs: 400, quietRequiredMs: 40, widened: null })
  return exportRecordedScenario(recorder, 'sc', { outputPath: join(dir, 'scoped.json') })
}

test('export records the scope when the proof observation was scoped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scoped-export-'))
  try {
    const exported = await exportScopedStep(dir, wholeBefore(), scopedAfter())
    assert.equal(exported.ok, true, JSON.stringify(exported))
    const assert1 = exported.scenario.steps[0].assert
    assert.equal(assert1.kind, 'node-present')
    assert.deepEqual(
      assert1.scope,
      { role: 'region', name: 'Deep container' },
      'the exported assertion must carry the scope of its deciding proof observation',
    )
    assert.deepEqual(
      exported.scenario.assertions[0].scope,
      { role: 'region', name: 'Deep container' },
      'the final assertion (the last step proof) carries the same scope',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('export notes a scoped PRECEDING observation on the step intent instead of pretending whole-page uniqueness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scoped-export-before-'))
  try {
    const scopedBefore = view([
      node('br-c', 'region', 'Deep container', 'div'),
      node('br-a', 'button', 'anchor', 'button'),
      node('br-s', 'status', 'IDLE', 'div'),
    ], { scope: CONTAINER_SCOPE, truncated: false })
    const exported = await exportScopedStep(dir, scopedBefore, wholeAfter())
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.scenario.steps[0].assert.scope, undefined, 'the deciding (after) view was whole-page: no scope on the assertion')
    assert.match(
      exported.scenario.steps[0].intent,
      /preceding observation was scoped/,
      'the scoped before must be recorded as a weakness, never silently presented as whole-page uniqueness',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. Replay: scope resolution, refusals, and the export -> replay round trip
// ---------------------------------------------------------------------------

function scopedPageAdapter(extra = {}) {
  let clicked = false
  let observed = 0
  const wholePage = () => ({
    page: { url: LAUNCH, title: 'scoped fixture' },
    nodes: [
      node('br-f', 'button', 'Filler 01', 'button'),
      ...(extra.duplicateContainer === true
        ? [node('br-c2', 'region', 'Deep container', 'div')]
        : []),
      ...(extra.omitContainer === true ? [] : [node('br-c', 'region', 'Deep container', 'div')]),
      node('br-a', 'button', 'anchor', 'button'),
      node('br-s', 'status', clicked ? 'READY' : 'IDLE', 'div'),
    ],
    truncated: true,
  })
  const scoped = () => ({
    page: { url: LAUNCH, title: 'scoped fixture' },
    scope: { ref: 'br-c', role: 'region', name: 'Deep container', tag: 'div' },
    nodes: [
      node('br-c', 'region', 'Deep container', 'div'),
      node('br-a', 'button', 'anchor', 'button'),
      node('br-s', 'status', clicked ? 'READY' : 'IDLE', 'div'),
    ],
    truncated: false,
  })
  return {
    adapter: {
      kind: 'browser',
      async start(_owner, options) {
        return { page: { url: options?.url ?? LAUNCH, title: 'scoped fixture' }, headless: true }
      },
      async observe(_owner, options) {
        observed += 1
        if (options?.withinRef === 'br-c') {
          if (extra.refuseScoped === true) {
            const error = new Error('the within ref expired; observe again before scoping')
            error.name = 'DriverIssue'
            error.code = 'REF_EXPIRED'
            throw error
          }
          return scoped()
        }
        return wholePage()
      },
      async act(_owner, action) {
        if (action.kind === 'click') clicked = true
        return { status: 'confirmed', dispatched: true }
      },
      async evidence() {
        return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } }
      },
      async stop() { return { stopped: true, reason: 'requested' } },
    },
    observed: () => observed,
  }
}

const SCOPED_SCENARIO = {
  meta: { name: 'scoped replay', description: 'd', driver: 'browser', createdAt: '2026-09-05T12:00:00.000Z' },
  target: { launch: LAUNCH },
  steps: [{
    index: 1,
    intent: 'Click "anchor".',
    action: { kind: 'click', target: { role: 'button', name: 'anchor' } },
    assert: {
      kind: 'node-present',
      expected: { role: 'status', name: 'READY' },
      scope: { role: 'region', name: 'Deep container' },
    },
  }],
  assertions: [
    { kind: 'node-present', expected: { role: 'status', name: 'READY' }, scope: { role: 'region', name: 'Deep container' } },
  ],
}

test('export -> replay of a scope-carrying scenario passes twice, and completeness names the scope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scoped-replay-'))
  try {
    const exported = await exportScopedStep(dir, wholeBefore(), scopedAfter())
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.deepEqual(exported.scenario.steps[0].assert.scope, { role: 'region', name: 'Deep container' })

    const run = async () => runScenario(exported.scenario, scopedPageAdapter().adapter, {
      ownerId: 'scoped-replay',
      settle: SETTLE,
    })
    const first = await run()
    const second = await run()
    assert.equal(first.status, 'pass', JSON.stringify(first))
    assert.equal(second.status, 'pass', JSON.stringify(second))
    for (const report of [first, second]) {
      assert.deepEqual(
        report.steps[0].completeness?.scope,
        { role: 'region', name: 'Deep container' },
        'the step completeness block names the scoped deciding view',
      )
      assert.match(report.steps[0].completeness.detail, /scoped to the region named "Deep container"/)
      assert.deepEqual(
        report.assertions[0].completeness?.scope,
        { role: 'region', name: 'Deep container' },
      )
      assert.deepEqual(
        report.assertions[0].scope,
        { role: 'region', name: 'Deep container' },
        'the final assertion result echoes the scope of the scenario assertion',
      )
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('replay refuses an AMBIGUOUS scope container with TARGET_NOT_UNIQUE, never guessing', async () => {
  const { adapter } = scopedPageAdapter({ duplicateContainer: true })
  const report = await runScenario(validateScenario(SCOPED_SCENARIO), adapter, {
    ownerId: 'scoped-ambiguous',
    settle: SETTLE,
  })
  assert.notEqual(report.status, 'pass')
  assert.equal(report.failure?.code, QA_TARGET_NOT_UNIQUE)
  assert.match(report.failure?.message ?? '', /assertion scope/)
  assert.equal(report.steps[0].assertionPassed, false)
})

test('replay reports a scope container that matches nothing as a clear error', async () => {
  const { adapter } = scopedPageAdapter({ omitContainer: true })
  const report = await runScenario(validateScenario(SCOPED_SCENARIO), adapter, {
    ownerId: 'scoped-missing',
    settle: SETTLE,
  })
  assert.notEqual(report.status, 'pass')
  assert.match(report.failure?.message ?? '', /no observable node matches the assertion scope/)
  assert.equal(report.failure?.code, undefined)
})

test('a driver refusal on the scoped observe surfaces as itself, never as "not found"', async () => {
  const { adapter } = scopedPageAdapter({ refuseScoped: true })
  const report = await runScenario(validateScenario(SCOPED_SCENARIO), adapter, {
    ownerId: 'scoped-refusal',
    settle: SETTLE,
  })
  assert.notEqual(report.status, 'pass')
  assert.equal(report.failure?.code, 'REF_EXPIRED', 'the driver refusal code must survive into the report')
  assert.match(report.failure?.message ?? '', /expired/)
  assert.doesNotMatch(report.failure?.message ?? '', /no observable node matches/, 'never degraded into a not-found claim')
})

/** A page whose scope container sits outside the truncated whole-page window. */
function deepContainerAdapter(extra = {}) {
  let clicked = false
  let wholeReads = 0
  const whole = (escalated) => ({
    page: { url: LAUNCH, title: 'scoped fixture' },
    nodes: [
      ...(escalated && extra.neverEscalated !== true
        ? [node('br-c', 'region', 'Deep container', 'div')]
        : []),
      node('br-a', 'button', 'anchor', 'button'),
      node('br-s', 'status', clicked ? 'READY' : 'IDLE', 'div'),
    ],
    truncated: !(escalated && extra.neverEscalated !== true),
  })
  return {
    adapter: {
      kind: 'browser',
      async start(_owner, options) {
        return { page: { url: options?.url ?? LAUNCH, title: 'scoped fixture' }, headless: true }
      },
      async observe(_owner, options) {
        if (options?.withinRef !== undefined) {
          return {
            page: { url: LAUNCH, title: 'scoped fixture' },
            scope: { ref: 'br-c', role: 'region', name: 'Deep container', tag: 'div' },
            nodes: [
              node('br-c', 'region', 'Deep container', 'div'),
              node('br-a', 'button', 'anchor', 'button'),
              node('br-s', 'status', clicked ? 'READY' : 'IDLE', 'div'),
            ],
            truncated: false,
          }
        }
        wholeReads += 1
        return whole(options?.maxNodes === QA_ESCALATED_NODE_BUDGET)
      },
      async act(_owner, action) {
        if (action.kind === 'click') clicked = true
        return { status: 'confirmed', dispatched: true }
      },
      async evidence() {
        return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } }
      },
      async stop() { return { stopped: true, reason: 'requested' } },
    },
    wholeReads: () => wholeReads,
  }
}

test('replay escalates the whole-page read ONCE to find a scope container outside the truncated window', async () => {
  const { adapter, wholeReads } = deepContainerAdapter()
  const report = await runScenario(validateScenario(SCOPED_SCENARIO), adapter, {
    ownerId: 'scoped-escalate',
    settle: SETTLE,
  })
  assert.equal(report.status, 'pass', JSON.stringify(report))
  assert.ok(wholeReads() >= 4, 'the escalated whole-page read must have happened: ' + String(wholeReads()))
  assert.deepEqual(
    report.steps[0].completeness?.scope,
    { role: 'region', name: 'Deep container' },
  )
})

test('a scope container still missing after the escalation fails closed naming INCONCLUSIVE_TRUNCATED', async () => {
  // The escalated whole-page read also omits the container (it is beyond the
  // driver maximum): the runner must say so, never claim the container is gone.
  const { adapter } = deepContainerAdapter({ neverEscalated: true })
  const report = await runScenario(validateScenario(SCOPED_SCENARIO), adapter, {
    ownerId: 'scoped-still-truncated',
    settle: SETTLE,
  })
  assert.notEqual(report.status, 'pass')
  assert.match(report.failure?.message ?? '', /no observable node matches the assertion scope, and the view was still truncated/)
  assert.match(report.failure?.message ?? '', /INCONCLUSIVE_TRUNCATED/)
})
