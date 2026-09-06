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
  QA_COVERAGE_UNVERIFIED,
  QA_INCONCLUSIVE_TRUNCATED,
  QA_SCOPE_NOT_DURABLE,
  QA_TARGET_NOT_UNIQUE,
} from '../src/contracts.ts'
import { QaSession } from '../src/session/index.ts'

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

// CHANGED (contract v9): the scope echo carries the fresh per-observation
// rootRef that binds the root even when the visibility gate excludes it.
const CONTAINER_SCOPE = { ref: 'br-c', rootRef: 'br-c', role: 'region', name: 'Deep container', tag: 'div' }

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
            scope: { ref: 'br-c', rootRef: 'br-c', role: 'region', name: 'Deep container', tag: 'div' },
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
    { ref: 'br-c', rootRef: 'br-c', role: 'region', name: 'Deep container', tag: 'div' },
    'the driver scope (rootRef included, contract v9) must be projected verbatim',
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

// CHANGED (QA-BL-052 / Codex Q4, deliberate semantics downgrade): a
// COMPLETE scoped view can no longer prove absence by itself. Closed shadow
// roots inside the container and unresolved slot assignment are invisible to
// the driver's projection, so "nothing matched" is UNPROVEN until the
// observation carries coverage.verified: true — scoped AND whole-page views
// alike.
test('node-absent on a COMPLETE scoped view is UNPROVEN without verified coverage', () => {
  const scopedComplete = view([], { scope: CONTAINER_SCOPE })
  const result = evaluateAssertion({ kind: 'node-absent', expected: { role: 'link' } }, scopedComplete)
  assert.equal(result.passed, false, 'nothing matched, but the scoped view is unverified: absence is UNPROVEN')
  assert.equal(result.inconclusive, true)
  assert.equal(result.reason, QA_COVERAGE_UNVERIFIED)
})

test('coverage.verified: true restores the node-absent PASS on a COMPLETE scoped view (the v9 restoration path)', () => {
  // CHANGED (contract v9): the evidence is the driver's REAL per-observation
  // coverage object, replacing the Phase A interim coverageVerified boolean.
  const scopedVerified = view([], { scope: CONTAINER_SCOPE, coverage: { verified: true, closedShadowRoots: 0, probedNodes: 9 } })
  const result = evaluateAssertion({ kind: 'node-absent', expected: { role: 'link' } }, scopedVerified)
  assert.equal(result.passed, true, 'coverage.verified restores the proven absence inside the container')
  assert.equal(result.inconclusive, false)
})

test('decideAssertion names the scope whenever the deciding view was scoped — and the coverage gate applies there too', async () => {
  const scopedComplete = view([], { scope: CONTAINER_SCOPE })
  const decision = await decideAssertion(
    { kind: 'node-absent', expected: { role: 'link' } },
    scopedComplete,
    async () => { throw new Error('a complete view must never escalate') },
  )
  assert.equal(decision.passed, false, 'unverified scoped view: absence is UNPROVEN')
  assert.ok(decision.completeness !== null, 'a scoped deciding view always carries completeness')
  assert.deepEqual(decision.completeness.scope, { role: 'region', name: 'Deep container' }, 'the completeness block names the scope')
  assert.equal(decision.completeness.truncated, false)
  assert.equal(decision.completeness.reason, QA_COVERAGE_UNVERIFIED)
  assert.match(decision.completeness.detail, /scoped to the region named "Deep container"/)
  assert.match(decision.completeness.detail, /not "not present"/)

  const verified = await decideAssertion(
    { kind: 'node-absent', expected: { role: 'link' } },
    view([], { scope: CONTAINER_SCOPE, coverage: { verified: true, closedShadowRoots: 0, probedNodes: 9 } }),
    async () => { throw new Error('a complete view must never escalate') },
  )
  assert.equal(verified.passed, true, 'coverage.verified restores the scoped absence pass')
  assert.ok(verified.completeness !== null, 'a scoped deciding view always carries completeness')
  assert.equal(verified.completeness.reason, undefined)
  assert.deepEqual(verified.completeness.scope, { role: 'region', name: 'Deep container' })
  assert.match(verified.completeness.detail, /within the region named "Deep container"/)
  assert.match(verified.completeness.detail, new RegExp('coverage verified \\(9 nodes probed\\)'))
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
  // CHANGED (contract v9, C2): the terminal absence re-read also requests the
  // coverage probe, inside the same scope.
  assert.deepEqual(escalationCalls, [
    { maxNodes: QA_ESCALATED_NODE_BUDGET, withinRef: 'br-c', verifyCoverage: true },
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
  assert.deepEqual(
    escalationCalls,
    [{ maxNodes: QA_ESCALATED_NODE_BUDGET, verifyCoverage: true }],
    'no withinRef for a whole-page escalation, and the terminal absence re-read requests coverage',
  )
  assert.equal(decision.completeness.reason, QA_INCONCLUSIVE_TRUNCATED)
  assert.equal(decision.completeness.scope, undefined, 'an unscoped deciding view never names a scope')
})

// CHANGED (QA-BL-052 / Codex Q4): the escalated view is COMPLETE and scoped,
// but its boundaries are unverified — the absence stays UNPROVEN. The
// escalation still happens exactly once, within the same scope.
test('a scoped decision whose deciding view is COMPLETE does not escalate further — and without coverage the absence stays UNPROVEN', async () => {
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
  assert.equal(decision.passed, false, 'complete scoped escalation, unverified coverage: absence is UNPROVEN')
  assert.deepEqual(
    escalationCalls,
    [{ maxNodes: QA_ESCALATED_NODE_BUDGET, withinRef: 'br-c', verifyCoverage: true }],
    'the terminal absence re-read requests the coverage probe inside the scope',
  )
  assert.equal(decision.completeness.reason, QA_COVERAGE_UNVERIFIED)
  assert.deepEqual(decision.completeness.scope, { role: 'region', name: 'Deep container' })
  assert.match(decision.completeness.detail, /not "not present"/)
})

test('coverage.verified on the complete scoped escalation restores the pass inside the scope (the v9 restoration path)', async () => {
  const scopedTruncatedFirst = view([node('br-c', 'region', 'Deep container', 'div')], { scope: CONTAINER_SCOPE, truncated: true, maxNodes: 40 })
  const escalationCalls = []
  const decision = await decideAssertion(
    { kind: 'node-absent', expected: { role: 'link' } },
    scopedTruncatedFirst,
    async (options) => {
      escalationCalls.push(options)
      return view([node('br-c', 'region', 'Deep container', 'div')], {
        scope: CONTAINER_SCOPE,
        truncated: false,
        maxNodes: QA_ESCALATED_NODE_BUDGET,
        coverage: { verified: true, closedShadowRoots: 0, probedNodes: 8 },
      })
    },
  )
  assert.equal(decision.passed, true, 'coverage.verified restores the proven scoped absence')
  assert.deepEqual(
    escalationCalls,
    [{ maxNodes: QA_ESCALATED_NODE_BUDGET, withinRef: 'br-c', verifyCoverage: true }],
  )
  assert.equal(decision.completeness.reason, undefined)
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

  // CHANGED (QA-BL-054): an empty accessible NAME is a legitimate exact-match
  // predicate value (unnamed containers are the common case) and is kept
  // literally; the loader no longer rejects it.
  const emptyName = validateAssertion({
    kind: 'node-absent',
    expected: { role: 'button', name: 'x' },
    scope: { role: 'region', name: '' },
  })
  assert.deepEqual(emptyName.scope, { role: 'region', name: '' })

  // CHANGED (QA-BL-054): an optional tag may disambiguate the container
  // predicate ("role+name, plus tag when needed"); the loader accepts it.
  const withTag = validateAssertion({
    kind: 'node-absent',
    expected: { role: 'button', name: 'x' },
    scope: { role: 'region', name: 'x', tag: 'div' },
  })
  assert.deepEqual(withTag.scope, { role: 'region', name: 'x', tag: 'div' })

  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'button' }, scope: { role: 'region' } }),
    ScenarioValidationError,
  )
  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'button' }, scope: { role: '', name: 'x' } }),
    ScenarioValidationError,
  )
  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'button' }, scope: { role: 'region', name: 'x', tag: '' } }),
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

// CHANGED (QA-BL-054): a scoped proof exports its scope ONLY when the
// container predicate is unique in a COMPLETE recorded baseline observation,
// so the happy-path baseline below is complete (truncated:false). The
// truncated/ambiguous baselines now pin SCOPE_NOT_DURABLE exclusions in their
// own tests.
const wholeBefore = () => view([
  node('br-c', 'region', 'Deep container', 'div'),
  node('br-a', 'button', 'anchor', 'button'),
  node('br-s', 'status', 'IDLE', 'div'),
], { truncated: false })

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
// 4b. QA-BL-054: a scope is exported only when its predicate is unique in a
//     COMPLETE recorded baseline observation — never silently dropped.
// ---------------------------------------------------------------------------

test('an empty-name container scope is kept LITERALLY when unique in a complete baseline (QA-BL-054)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scoped-export-empty-name-'))
  try {
    const before = view([
      node('br-c', 'region', '', 'div'),
      node('br-a', 'button', 'anchor', 'button'),
      node('br-s', 'status', 'IDLE', 'div'),
    ], { truncated: false })
    const after = view([
      node('br-c', 'region', '', 'div'),
      node('br-a', 'button', 'anchor', 'button'),
      node('br-s', 'status', 'READY', 'div'),
    ], { scope: { ref: 'br-c', role: 'region', name: '', tag: 'div' }, truncated: false })
    const exported = await exportScopedStep(dir, before, after)
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.deepEqual(
      exported.scenario.steps[0].assert.scope,
      { role: 'region', name: '' },
      'the empty name is a legitimate predicate value and must be kept literally, never dropped',
    )
    assert.deepEqual(exported.scenario.assertions[0].scope, { role: 'region', name: '' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a scoped proof whose baseline was TRUNCATED is excluded with SCOPE_NOT_DURABLE (uniqueness unproven)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scoped-export-truncated-baseline-'))
  try {
    const exported = await exportScopedStep(dir, view([
      node('br-c', 'region', 'Deep container', 'div'),
      node('br-a', 'button', 'anchor', 'button'),
      node('br-s', 'status', 'IDLE', 'div'),
    ], { truncated: true }), scopedAfter())
    assert.equal(exported.ok, false, 'the scope cannot be proven durable from a truncated baseline')
    assert.equal(exported.excludedActions.length, 1, JSON.stringify(exported.excludedActions))
    assert.equal(exported.excludedActions[0].reason, QA_SCOPE_NOT_DURABLE)
    assert.match(exported.excludedActions[0].detail, /truncated at the driver node budget/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a scoped proof whose container is AMBIGUOUS in the baseline is excluded with SCOPE_NOT_DURABLE', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scoped-export-ambiguous-'))
  try {
    const before = view([
      node('br-c', 'region', 'Deep container', 'div'),
      node('br-c2', 'region', 'Deep container', 'div'),
      node('br-a', 'button', 'anchor', 'button'),
      node('br-s', 'status', 'IDLE', 'div'),
    ], { truncated: false })
    const exported = await exportScopedStep(dir, before, scopedAfter())
    assert.equal(exported.ok, false, 'an ambiguous container is never exported as durable')
    assert.equal(exported.excludedActions[0].reason, QA_SCOPE_NOT_DURABLE)
    assert.match(exported.excludedActions[0].detail, /matches 2 nodes/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('role+name ambiguous but role+name+tag unique exports the scope WITH the tag (plus tag when needed)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scoped-export-tag-'))
  try {
    const before = view([
      node('br-c', 'region', 'Deep container', 'div'),
      node('br-c2', 'region', 'Deep container', 'section'),
      node('br-a', 'button', 'anchor', 'button'),
      node('br-s', 'status', 'IDLE', 'div'),
    ], { truncated: false })
    const exported = await exportScopedStep(dir, before, scopedAfter())
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.deepEqual(
      exported.scenario.steps[0].assert.scope,
      { role: 'region', name: 'Deep container', tag: 'div' },
      'the scope echo tag disambiguates the container predicate',
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
  // CHANGED (QA-BL-054): the whole-page view is now COMPLETE. Replay only
  // resolves a scope container against a view where its uniqueness is proven
  // (a complete view with exactly one match); a truncated view escalates once
  // and a still-truncated one is refused (pinned by the dedicated tests
  // below). These synthetic adapters model the proven case directly.
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
    truncated: false,
  })
  const scoped = () => ({
    page: { url: LAUNCH, title: 'scoped fixture' },
    // CHANGED (contract v9): the scoped view carries the fresh rootRef the
    // settled scoped read re-keys its polls through (no rootRef -> the
    // settle fails closed).
    scope: { ref: 'br-c', rootRef: 'br-c', role: 'region', name: 'Deep container', tag: 'div' },
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
            // Contract v9: the fresh rootRef the settled scoped read re-keys through.
            scope: { ref: 'br-c', rootRef: 'br-c', role: 'region', name: 'Deep container', tag: 'div' },
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

test('a scope container still missing after the escalation is INCONCLUSIVE_TRUNCATED, never a failure (QA-BL-069, C)', async () => {
  // CHANGED (QA-BL-069, C): the escalated whole-page read also omits the
  // container (it is beyond the driver maximum) — the runner must say so,
  // never claim the container is gone, and must NOT misclassify it as a
  // definite step failure: nothing definitely failed, so the step and the
  // run are INCONCLUSIVE with the honest wording (the action is not
  // dispatched — its container could not be located).
  const { adapter } = deepContainerAdapter({ neverEscalated: true })
  const report = await runScenario(validateScenario(SCOPED_SCENARIO), adapter, {
    ownerId: 'scoped-still-truncated',
    settle: SETTLE,
  })
  assert.equal(report.status, 'inconclusive', JSON.stringify(report.failure ?? report))
  const step = report.steps[0]
  assert.equal(step.status, 'inconclusive')
  assert.equal(step.assertionPassed, false)
  assert.equal(step.reason, QA_INCONCLUSIVE_TRUNCATED)
  assert.equal(step.scopeNotLocated, true)
  assert.match(
    step.completeness?.detail ?? '',
    /the container could not be located in the truncated view; it may exist outside the returned window/,
  )
  assert.equal(report.failure, undefined, 'nothing definitely failed: no failure block')
})

/** A page whose scope container matches ONCE in a truncated whole-page view. */
function oneMatchTruncatedAdapter(extra = {}) {
  let clicked = false
  let escalatedReads = 0
  // The DEFAULT whole-page view is truncated and returns the container ONCE
  // (uniqueness unproven, QA-BL-054). The ESCALATED read completes the view —
  // unless stillTruncated pins the refusal case, where it stays truncated.
  const whole = (escalated) => ({
    page: { url: LAUNCH, title: 'scoped fixture' },
    nodes: [
      node('br-c', 'region', 'Deep container', 'div'),
      node('br-a', 'button', 'anchor', 'button'),
      node('br-s', 'status', clicked ? 'READY' : 'IDLE', 'div'),
    ],
    truncated: extra.stillTruncated === true ? true : !escalated,
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
            // Contract v9: the fresh rootRef the settled scoped read re-keys through.
            scope: { ref: 'br-c', rootRef: 'br-c', role: 'region', name: 'Deep container', tag: 'div' },
            nodes: [
              node('br-c', 'region', 'Deep container', 'div'),
              node('br-a', 'button', 'anchor', 'button'),
              node('br-s', 'status', clicked ? 'READY' : 'IDLE', 'div'),
            ],
            truncated: false,
          }
        }
        if (options?.maxNodes === QA_ESCALATED_NODE_BUDGET) escalatedReads += 1
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
    escalatedReads: () => escalatedReads,
  }
}

test('one container match in a TRUNCATED whole-page view escalates ONCE — uniqueness is unproven there (QA-BL-054)', async () => {
  const { adapter, escalatedReads } = oneMatchTruncatedAdapter()
  const report = await runScenario(validateScenario(SCOPED_SCENARIO), adapter, {
    ownerId: 'scoped-one-match-escalate',
    settle: SETTLE,
  })
  assert.equal(report.status, 'pass', JSON.stringify(report))
  assert.ok(escalatedReads() >= 2, 'the truncated whole-page view must be re-read at the bounded budget: ' + String(escalatedReads()))
  assert.deepEqual(report.steps[0].completeness?.scope, { role: 'region', name: 'Deep container' })
})

test('one container match in a STILL-truncated escalated view refuses with INCONCLUSIVE_TRUNCATED naming the scope (QA-BL-054)', async () => {
  // CHANGED (QA-BL-054): one match in a truncated view is NOT proven
  // uniqueness — a twin may sit outside the returned window. The runner
  // refuses instead of scoping into a container it cannot identify, and the
  // refusal names the scope and the code.
  const { adapter } = oneMatchTruncatedAdapter({ stillTruncated: true })
  const report = await runScenario(validateScenario(SCOPED_SCENARIO), adapter, {
    ownerId: 'scoped-one-match-still-truncated',
    settle: SETTLE,
  })
  assert.notEqual(report.status, 'pass')
  assert.match(report.failure?.message ?? '', /one observable node matches the assertion scope/)
  assert.match(report.failure?.message ?? '', /Deep container/, 'the refusal names the scope')
  assert.match(report.failure?.message ?? '', /INCONCLUSIVE_TRUNCATED/)
  assert.match(report.failure?.message ?? '', /twin container may exist outside the returned window/)
})

// ---------------------------------------------------------------------------
// 6. Contract v9: the settled scoped read re-keys its polls through the
//    DRIVER's fresh scope.rootRef — never by role+name+tag re-matching.
// ---------------------------------------------------------------------------

test('a scoped settle whose root hides mid-window still re-keys via scope.rootRef (the v9 chain)', async () => {
  // Poll 1 returns the visible root (a fresh rootRef is minted). Polls 2+
  // hide the root (the visibility gate excludes it from nodes) but the
  // driver keeps minting a fresh rootRef for the SAME element, so the
  // settle keeps re-keying. The retired role+name+tag .find() re-keying
  // would fail closed here: the root node is ABSENT from nodes while the
  // scope still binds it.
  let reads = 0
  const adapter = {
    kind: 'browser',
    async start() { return { page: { url: LAUNCH, title: 'scoped fixture' }, headless: true } },
    async observe(_owner, options) {
      reads += 1
      assert.ok(
        options?.withinRef !== undefined,
        'every poll of the scoped settle must carry a within ref (read ' + reads + ')',
      )
      return {
        page: { url: LAUNCH, title: 'scoped fixture' },
        scope: {
          ref: options.withinRef,
          rootRef: 'br-c-r' + reads,
          role: 'region',
          name: 'Deep container',
          tag: 'div',
        },
        nodes: reads === 1 ? [node('br-c', 'region', 'Deep container', 'div')] : [],
        truncated: false,
      }
    },
    async act() { return { status: 'confirmed', dispatched: true } },
    async evidence() { return { console: [], network: [], bounded: true } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
  const session = new QaSession(adapter, 'rootref-hidden', { settle: SETTLE })
  await session.start({ url: LAUNCH })
  try {
    const settled = await session.observeSettled({ withinRef: 'br-c' })
    assert.equal(settled.stable, true, 'the hidden root must not break the rootRef chain')
    assert.ok(settled.passes >= 2, 'the window polled more than once')
    assert.equal(settled.observation.nodes.length, 0, 'the hidden root stays out of nodes')
    assert.equal(settled.observation.scope.rootRef, 'br-c-r' + reads, 'the deciding observation carries the last minted rootRef')
  } finally {
    await session.stop().catch(() => {})
  }
})

test('a scoped settle whose root carries no rootRef (vanished / pre-v9) fails closed', async () => {
  // The driver mints no rootRef for the re-collected root (a pre-v9 driver,
  // or a root the driver could no longer bind): the settled scoped read must
  // fail closed instead of silently narrowing to some other node.
  const adapter = {
    kind: 'browser',
    async start() { return { page: { url: LAUNCH, title: 'scoped fixture' }, headless: true } },
    async observe(_owner, options) {
      return {
        page: { url: LAUNCH, title: 'scoped fixture' },
        scope: { ref: options?.withinRef ?? 'br-c', role: 'region', name: 'Deep container', tag: 'div' },
        nodes: [node('br-x', 'link', 'Some other node', 'a')],
        truncated: false,
      }
    },
    async act() { return { status: 'confirmed', dispatched: true } },
    async evidence() { return { console: [], network: [], bounded: true } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
  const session = new QaSession(adapter, 'rootref-vanished', { settle: SETTLE })
  await session.start({ url: LAUNCH })
  try {
    await assert.rejects(
      session.observeSettled({ withinRef: 'br-c' }),
      /scope root/,
      'no rootRef: the settled scoped read must fail closed, never re-key by role+name+tag',
    )
  } finally {
    await session.stop().catch(() => {})
  }
})
