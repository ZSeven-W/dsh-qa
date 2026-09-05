import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exportRecordedScenario,
  QaTrajectoryRecorder,
  RecordingQaDriverAdapter,
} from '../src/explore/index.ts'
import {
  decideAssertion,
  evaluateAssertion,
  normalizeReportForDeterminism,
  runScenario,
  validateScenario,
  QA_ESCALATED_NODE_BUDGET,
} from '../src/replay/index.ts'
import { QaSession, QaSessionManager } from '../src/session/index.ts'
import { writeReports } from '../src/reporters/index.ts'
import { createQaTools, QaToolHost } from '../src/tools.ts'
import { QA_COVERAGE_UNVERIFIED, QA_INCONCLUSIVE_TRUNCATED } from '../src/contracts.ts'

// Truncation soundness suite.
//
// Observations are budget-limited and carry `truncated`. A node that genuinely
// exists can fall outside the returned window, so "not in the returned nodes"
// is NOT "not on the page". The defect these tests lock down is a silent false
// green: a node-absent assertion passing against a truncated view (a QA tool
// reporting "the error banner is gone" when the banner merely fell outside the
// node budget). The twin, weaker failure is a present-claim or an action target
// going missing for the same reason.
//
// Everything here is synthetic and deterministic; the same contract is proven
// against a real browser and a real oversized page in
// test/truncation-browser.integration.test.mjs.

const LAUNCH = 'http://127.0.0.1:7411/'
// Static synthetic page: a PROOF window legitimately spends its whole budget
// waiting for an outcome, so keep the window small (as in session.test.mjs).
const SETTLE = { budgetMs: 120, quietMs: 20, intervalMs: 5 }
const DEEP = { role: 'button', name: 'Deep control' }
const REVEAL = { role: 'button', name: 'Reveal panel' }

function node(ref, role, name, tag, extra = {}) {
  return {
    ref,
    role,
    name,
    tag,
    interactive: role !== 'status',
    editable: false,
    disabled: false,
    ...extra,
  }
}

/**
 * A synthetic budget-limited driver. It models the ONE thing that matters here:
 * the driver returns at most `maxNodes` nodes in document order, clamps the
 * requested budget to its own maximum (the browser driver clamps to 100), and
 * reports `truncated` when anything was left out.
 *
 * "Deep control" sits at `deepAt`, deliberately beyond the default budget, so
 * it EXISTS but is never in the default view.
 */
function budgetAdapter(options = {}) {
  const {
    total = 80,
    deepAt = 70,
    defaultBudget = 60,
    driverMax = 100,
    withDeep = true,
    inViewport = true,
    // CHANGED (contract v9): the REAL per-observation coverage evidence shape
    // replaces the Phase A interim coverageVerified boolean.
    coverage = null,
    hiddenMatches = 0,
    hiddenMatchesPartial = false,
  } = options
  const observed = []
  let revealed = false
  const build = () => {
    const nodes = [
      node('n-reveal', 'button', 'Reveal panel', 'button', { inViewport: true }),
      node('n-status', 'status', revealed ? 'PANEL OPEN' : 'IDLE', 'div', { inViewport: true }),
    ]
    for (let i = nodes.length; i < total; i += 1) {
      if (withDeep && i === deepAt) {
        nodes.push(node('n-deep', 'button', 'Deep control', 'button', { inViewport }))
        continue
      }
      nodes.push(node('n-' + i, 'link', 'Filter ' + String(i), 'a', { inViewport: i < 20 }))
    }
    return nodes
  }
  return {
    kind: 'browser',
    /** Every node budget the driver was asked for, in call order. */
    observed,
    async start(_owner, startOptions) {
      return { page: { url: startOptions?.url ?? LAUNCH, title: 'budget fixture' }, headless: true }
    },
    async observe(_owner, observeOptions) {
      const requested = observeOptions?.maxNodes
      observed.push(requested ?? null)
      const budget = Math.min(requested ?? defaultBudget, driverMax)
      const all = build()
      const nodes = all.slice(0, budget)
      const truncated = all.length > nodes.length
      return {
        page: { url: LAUNCH, title: 'budget fixture' },
        nodes,
        truncated,
        // What the driver ACTUALLY applied (its own clamp), plus the reason it
        // names — exactly the shape the real browser driver reports.
        maxNodes: budget,
        ...(truncated ? { truncationReasons: ['node-budget-exceeded'] } : {}),
        // Affirmative coverage evidence (driver contract v9, Phase C); the
        // restoration-path tests set this to the driver's real shape to pin
        // the future pass. Absent models a driver that reports no evidence.
        ...(coverage === null ? {} : { coverage }),
        // v9 gate diagnostics (honest-optional): hidden semantic-selector
        // candidates the visibility gate skipped, and whether the count is a
        // lower bound.
        ...(hiddenMatches > 0
          ? { hiddenMatches, hiddenMatchesPartial }
          : {}),
      }
    },
    async act(_owner, action) {
      if (action.ref === 'n-reveal') revealed = true
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

function view(nodes, truncated, extras = {}) {
  // extras carries what the DRIVER reports back: the budget it actually
  // applied (its own clamp) and the reasons it names for a partial view.
  return { page: { url: LAUNCH, title: 'budget fixture' }, nodes, truncated, ...extras }
}

function scenario(steps, assertions) {
  return validateScenario({
    meta: {
      name: 'budget-truncation',
      description: 'hand-written: the page under test has more nodes than the observation budget',
      driver: 'browser',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    target: { launch: LAUNCH },
    steps,
    assertions,
  })
}

const REVEAL_STEP = {
  index: 1,
  intent: 'Click "Reveal panel".',
  action: { kind: 'click', target: REVEAL },
  assert: { kind: 'node-present', expected: { role: 'status', name: 'PANEL OPEN' } },
}

// ---------------------------------------------------------------------------
// 1. The pure evaluator is sound on its own.
// ---------------------------------------------------------------------------

test('node-absent can never pass on a truncated observation', () => {
  const nodes = [node('a', 'status', 'IDLE', 'div')]
  const truncatedView = view(nodes, true)
  const completeView = view(nodes, false)

  const onTruncated = evaluateAssertion({ kind: 'node-absent', expected: DEEP }, truncatedView)
  assert.equal(onTruncated.passed, false, 'absence is a claim about the WHOLE view')
  assert.equal(onTruncated.inconclusive, true)
  assert.equal(onTruncated.observed, null)

  // CHANGED (QA-BL-052 / Codex Q4): a complete view no longer proves
  // absence by itself. The observation's boundaries (closed shadow roots,
  // slot assignment) must be VERIFIED first — until then the absence is
  // UNPROVEN and fails closed with QA_COVERAGE_UNVERIFIED, never a false
  // "gone".
  const onComplete = evaluateAssertion({ kind: 'node-absent', expected: DEEP }, completeView)
  assert.equal(onComplete.passed, false, 'a complete but UNVERIFIED view cannot prove absence')
  assert.equal(onComplete.inconclusive, true)
  assert.equal(onComplete.reason, QA_COVERAGE_UNVERIFIED)

  // The restoration path: per-observation affirmative coverage evidence
  // brings back the proven absence (pinned here, provided by the driver in
  // contract v9 Phase C). CHANGED: the evidence is the driver's REAL
  // per-observation coverage object — coverage.verified === true is the
  // single source of truth (the Phase A interim coverageVerified boolean is
  // gone).
  const onVerifiedComplete = evaluateAssertion(
    { kind: 'node-absent', expected: DEEP },
    { ...completeView, coverage: { verified: true, closedShadowRoots: 0, probedNodes: 11 } },
  )
  assert.equal(onVerifiedComplete.passed, true, 'coverage.verified restores the proven absence on a complete view')
  assert.equal(onVerifiedComplete.inconclusive, false)
})

test('a match in a truncated view is still sound evidence of presence', () => {
  const present = view([node('n-deep', 'button', 'Deep control', 'button', { inViewport: true })], true)
  const found = evaluateAssertion({ kind: 'node-present', expected: DEEP }, present)
  assert.equal(found.passed, true, 'a returned node really is there, budget or not')
  assert.equal(found.inconclusive, false)

  const inViewport = evaluateAssertion({ kind: 'node-in-viewport', expected: DEEP }, present)
  assert.equal(inViewport.passed, true)
  assert.equal(inViewport.inconclusive, false)

  // A match that DISPROVES absence is equally sound.
  const absent = evaluateAssertion({ kind: 'node-absent', expected: DEEP }, present)
  assert.equal(absent.passed, false)
  assert.equal(absent.inconclusive, false)

  // Not finding it in a truncated view proves nothing in either direction.
  const missing = evaluateAssertion({ kind: 'node-present', expected: DEEP }, view([], true))
  assert.equal(missing.passed, false)
  assert.equal(missing.inconclusive, true)
})

test('page-url never depends on node completeness', () => {
  const result = evaluateAssertion({ kind: 'page-url', expected: { url: LAUNCH } }, view([], true))
  assert.equal(result.passed, true)
  assert.equal(result.inconclusive, false)
})

test('node-value obeys the same presence/inconclusive discipline as node-present', async () => {
  const deepWithValue = node('n-deep', 'button', 'Deep control', 'button', { inViewport: true, value: 'ON' })

  // Found in a truncated view: sound evidence of both presence and value.
  const found = evaluateAssertion(
    { kind: 'node-value', expected: { role: 'button', name: 'Deep control', value: 'ON' } },
    view([deepWithValue], true),
  )
  assert.equal(found.passed, true)
  assert.equal(found.inconclusive, false)

  // Not found in a truncated view: unproven, never "not there".
  const missing = evaluateAssertion(
    { kind: 'node-value', expected: { role: 'button', name: 'Deep control', value: 'ON' } },
    view([], true),
  )
  assert.equal(missing.passed, false)
  assert.equal(missing.inconclusive, true)

  // Escalates once; a still-truncated view fails closed with the distinct reason.
  const { calls, reobserve } = escalator(view([node('a', 'status', 'IDLE', 'div')], true))
  const decision = await decideAssertion(
    { kind: 'node-value', expected: { role: 'button', name: 'Deep control', value: 'ON' } },
    view([], true),
    reobserve,
  )
  assert.deepEqual(calls, [QA_ESCALATED_NODE_BUDGET], 'exactly ONE bounded escalation')
  assert.equal(decision.passed, false)
  assert.equal(decision.completeness.reason, QA_INCONCLUSIVE_TRUNCATED)
  assert.equal(decision.completeness.truncated, true)
  assert.match(decision.completeness.detail, /cannot be proven/)
})

// ---------------------------------------------------------------------------
// 2. Bounded escalation before concluding.
// ---------------------------------------------------------------------------

function escalator(fuller) {
  const calls = []
  // CHANGED (contract v9): the FULL option object is recorded too, so the
  // tests can pin that the terminal absence re-read requests the coverage
  // probe (verifyCoverage: true) — and only that re-read does.
  const optionCalls = []
  return {
    calls,
    optionCalls,
    reobserve: async (options) => {
      calls.push(options.maxNodes)
      optionCalls.push(options)
      return fuller
    },
  }
}

test('an absent-claim escalates once and then fails correctly when the node exists', async () => {
  const deep = node('n-deep', 'button', 'Deep control', 'button', { inViewport: true })
  const { calls, reobserve } = escalator(view([node('a', 'status', 'IDLE', 'div'), deep], false, { maxNodes: 100 }))
  const decision = await decideAssertion(
    { kind: 'node-absent', expected: DEEP },
    view([node('a', 'status', 'IDLE', 'div')], true, { maxNodes: 60 }),
    reobserve,
  )

  assert.deepEqual(calls, [QA_ESCALATED_NODE_BUDGET], 'exactly ONE bounded escalation')
  assert.equal(decision.passed, false, 'the node exists: absence must fail, never pass')
  assert.deepEqual(decision.observed, { role: 'button', name: 'Deep control', tag: 'button' })
  assert.equal(decision.completeness.escalated, true)
  assert.equal(decision.completeness.truncated, false)
  assert.equal(decision.completeness.nodeBudget, 100, 'the budget the driver APPLIED is reported, never the requested 500')
  assert.match(decision.completeness.detail, /applied 100 nodes instead of the prior 60/, 'a wider applied budget names both numbers')
  assert.equal(decision.completeness.reason, undefined, 'a decided outcome is not inconclusive')
})

// CHANGED (QA-BL-052 / Codex Q4, deliberate semantics downgrade): the
// escalated view is COMPLETE, but the driver never verified its boundaries,
// so the genuinely absent node is still UNPROVEN. The decision fails closed
// with QA_COVERAGE_UNVERIFIED and a detail that says so in plain words.
test('a genuinely absent node on a complete escalated view is still UNPROVEN without verified coverage', async () => {
  const { calls, optionCalls, reobserve } = escalator(view([node('a', 'status', 'IDLE', 'div')], false, { maxNodes: 100 }))
  const decision = await decideAssertion({ kind: 'node-absent', expected: DEEP }, view([], true, { maxNodes: 60 }), reobserve)

  assert.deepEqual(calls, [QA_ESCALATED_NODE_BUDGET])
  // CHANGED (contract v9, C2): the terminal absence decision requests the
  // driver's bounded coverage probe on its ONE deciding re-observation — the
  // escalated re-read already taken, never the settle polls.
  assert.deepEqual(
    optionCalls,
    [{ maxNodes: QA_ESCALATED_NODE_BUDGET, verifyCoverage: true }],
    'the deciding re-observation must request verifyCoverage exactly once',
  )
  assert.equal(decision.passed, false, 'absence on an unverified view is UNPROVEN')
  assert.equal(decision.observed, null)
  assert.equal(decision.completeness.escalated, true)
  assert.equal(decision.completeness.truncated, false)
  assert.equal(decision.completeness.nodeBudget, 100, 'the applied budget is reported, never the requested 500')
  assert.equal(decision.completeness.reason, QA_COVERAGE_UNVERIFIED)
  assert.equal(
    decision.completeness.outcomeDependsOnCompleteView,
    false,
    'the view WAS complete: what is missing is coverage verification, not nodes',
  )
  assert.match(decision.completeness.detail, /no observable node matched/)
  assert.match(decision.completeness.detail, /closed shadow roots, slot assignment/)
  assert.match(decision.completeness.detail, /UNPROVEN/)
  assert.match(decision.completeness.detail, /not "not present"/)
})

test('coverage.verified: true on the escalated observation RESTORES the proven absence (the v9 restoration path)', async () => {
  const verifiedFuller = view([node('a', 'status', 'IDLE', 'div')], false, {
    maxNodes: 100,
    coverage: { verified: true, closedShadowRoots: 0, probedNodes: 15 },
  })
  const { calls, reobserve } = escalator(verifiedFuller)
  const decision = await decideAssertion({ kind: 'node-absent', expected: DEEP }, view([], true, { maxNodes: 60 }), reobserve)

  assert.deepEqual(calls, [QA_ESCALATED_NODE_BUDGET])
  assert.equal(decision.passed, true, 'coverage.verified restores the proven absence')
  assert.equal(decision.completeness.escalated, true)
  assert.equal(decision.completeness.truncated, false)
  assert.equal(decision.completeness.nodeBudget, 100)
  assert.equal(decision.completeness.reason, undefined, 'a decided outcome is not inconclusive')
  assert.equal(decision.completeness.outcomeDependsOnCompleteView, false)
  // The proven absence PASS carries the Codex-consult wording, machine-checked.
  assert.match(decision.completeness.detail, /No driver-observable semantic node matching/)
  assert.match(decision.completeness.detail, /within the whole page/)
  assert.match(decision.completeness.detail, new RegExp('coverage verified \\(15 nodes probed\\)'))
  assert.deepEqual(
    decision.completeness.coverage,
    { verified: true, closedShadowRoots: 0, probedNodes: 15 },
    'the deciding coverage evidence travels in the completeness block',
  )
})

test('a still-truncated view fails closed with a distinct, budget-naming reason', async () => {
  // The agent was already at the driver maximum (100): the escalation requests
  // 500, the driver clamps to 100, and the completeness block must say so.
  const fuller = view([node('a', 'status', 'IDLE', 'div')], true, { maxNodes: 100, truncationReasons: ['node-budget-exceeded'] })
  const { calls, reobserve } = escalator(fuller)
  for (const kind of ['node-absent', 'node-present', 'node-in-viewport']) {
    const decision = await decideAssertion({ kind, expected: DEEP }, view([], true, { maxNodes: 100, truncationReasons: ['node-budget-exceeded'] }), reobserve)
    assert.equal(decision.passed, false, kind + ' must never pass from an incomplete view')
    assert.equal(decision.completeness.reason, QA_INCONCLUSIVE_TRUNCATED)
    assert.equal(decision.completeness.truncated, true)
    assert.equal(decision.completeness.outcomeDependsOnCompleteView, true)
    assert.equal(decision.completeness.nodeBudget, 100, 'the applied budget is reported, never the requested 500')
    assert.deepEqual(decision.completeness.truncationReasons, ['node-budget-exceeded'], 'the driver-reported reasons travel in the completeness block')
    assert.match(decision.completeness.detail, /no wider view exists from this driver/, 'a same-budget re-read is reported for what it is')
    assert.ok(!decision.completeness.detail.includes(String(QA_ESCALATED_NODE_BUDGET)), 'the requested constant never masquerades as the applied budget')
    assert.match(decision.completeness.detail, /cannot be proven/)
  }
  assert.equal(calls.length, 3, 'one escalation per decision, never a loop')
})

test('a present-claim that already found its match never escalates', async () => {
  const deep = node('n-deep', 'button', 'Deep control', 'button', { inViewport: true })
  const { calls, reobserve } = escalator(view([deep], false))
  const present = await decideAssertion({ kind: 'node-present', expected: DEEP }, view([deep], true), reobserve)
  assert.equal(present.passed, true)
  assert.equal(present.completeness.escalated, false)
  assert.equal(present.completeness.truncated, true)
  assert.match(present.completeness.detail, /sound evidence/)

  const url = await decideAssertion({ kind: 'page-url', expected: { url: LAUNCH } }, view([], true), reobserve)
  assert.equal(url.passed, true)
  assert.match(url.completeness.detail, /does not depend on node completeness/)

  // CHANGED (contract v9, C2): a complete whole-page view WITHOUT verified
  // coverage can no longer prove absence by itself — the terminal absence
  // decision takes ONE bounded re-observation REQUESTING the coverage probe
  // (the one bounded re-read; never the settle polls). The stub re-read
  // returns the same unverified complete view, so the absence stays UNPROVEN
  // (COVERAGE_UNVERIFIED) — never a pass, never a second re-read.
  const absenceEscalator = escalator(view([], false))
  const complete = await decideAssertion(
    { kind: 'node-absent', expected: DEEP },
    view([], false),
    absenceEscalator.reobserve,
  )
  assert.equal(complete.passed, false, 'unverified boundaries: absence is UNPROVEN')
  assert.ok(complete.completeness !== null, 'the coverage refusal is reported, not silent')
  assert.equal(complete.completeness.reason, QA_COVERAGE_UNVERIFIED)
  assert.equal(complete.completeness.truncated, false)
  assert.equal(complete.completeness.escalated, true, 'the ONE deciding re-observation ran')
  assert.deepEqual(
    absenceEscalator.optionCalls,
    [{ maxNodes: QA_ESCALATED_NODE_BUDGET, verifyCoverage: true }],
    'the complete-but-unverified absence requests verifyCoverage on its one bounded re-read',
  )
  assert.match(complete.completeness.detail, /not "not present"/)

  // The restoration path: with affirmative coverage evidence the complete
  // view decides the absence with NO re-read, and the PASS carries the
  // Codex-consult completeness wording (CHANGED: the Phase A expectation of
  // completeness null is gone — a proven absence now REPORTs its proof).
  const verifiedEscalator = escalator(view([], false))
  const verifiedComplete = await decideAssertion(
    { kind: 'node-absent', expected: DEEP },
    view([], false, { coverage: { verified: true, closedShadowRoots: 0, probedNodes: 12 } }),
    verifiedEscalator.reobserve,
  )
  assert.equal(verifiedComplete.passed, true, 'coverage.verified restores the pass on a complete whole-page view')
  assert.ok(verifiedComplete.completeness !== null, 'a proven absence PASS carries its completeness wording')
  assert.equal(verifiedComplete.completeness.reason, undefined)
  assert.equal(verifiedComplete.completeness.escalated, false, 'an already-verified view needs no re-read')
  assert.match(verifiedComplete.completeness.detail, /No driver-observable semantic node matching/)
  assert.match(verifiedComplete.completeness.detail, /within the whole page/)
  assert.match(verifiedComplete.completeness.detail, new RegExp('coverage verified \\(12 nodes probed\\)'))
  assert.deepEqual(verifiedEscalator.optionCalls, [], 'verified evidence: nothing to re-read')

  assert.deepEqual(calls, [], 'evidence of presence is sound; nothing to escalate')
})

test('an escalation that cannot be observed still fails closed, exactly once', async () => {
  let calls = 0
  const reobserve = async () => {
    calls += 1
    throw new Error('the budget-escalated observation never settled within the 900ms settle budget')
  }
  const decision = await decideAssertion({ kind: 'node-absent', expected: DEEP }, view([], true), reobserve)
  assert.equal(calls, 1)
  assert.equal(decision.passed, false)
  assert.equal(decision.completeness.reason, QA_INCONCLUSIVE_TRUNCATED)
  assert.equal(decision.completeness.escalated, false)
  assert.match(decision.completeness.detail, /could not be observed/)
})

// ---------------------------------------------------------------------------
// 2c. Contract v9 (Phase C): the deciding coverage probe's outcomes.
// ---------------------------------------------------------------------------

test('a probe that found closed shadow roots keeps the absence INCONCLUSIVE_TRUNCATED and names closed-shadow-root', async () => {
  // The driver marks the observation truncated with the closed-shadow-root
  // reason; the QA layer must keep the INCONCLUSIVE_TRUNCATED result and let
  // the driver's reason and evidence travel verbatim into the completeness
  // block (detail + truncationReasons + coverage).
  const probed = view([node('a', 'status', 'IDLE', 'div')], true, {
    maxNodes: 100,
    truncationReasons: ['closed-shadow-root'],
    coverage: { verified: false, closedShadowRoots: 2, probedNodes: 40 },
  })
  const { optionCalls, reobserve } = escalator(probed)
  const decision = await decideAssertion({ kind: 'node-absent', expected: DEEP }, view([], true, { maxNodes: 60 }), reobserve)

  assert.deepEqual(optionCalls, [{ maxNodes: QA_ESCALATED_NODE_BUDGET, verifyCoverage: true }])
  assert.equal(decision.passed, false)
  assert.equal(decision.completeness.reason, QA_INCONCLUSIVE_TRUNCATED)
  assert.equal(decision.completeness.truncated, true)
  assert.deepEqual(decision.completeness.truncationReasons, ['closed-shadow-root'])
  assert.match(decision.completeness.detail, /closed-shadow-root/, 'the driver reason is named in the detail')
  assert.deepEqual(
    decision.completeness.coverage,
    { verified: false, closedShadowRoots: 2, probedNodes: 40 },
    'the probe evidence travels in the completeness block',
  )
})

test('a probe that did not run to completion names shadow-coverage-unverified plus the coverage reason', async () => {
  const probed = view([node('a', 'status', 'IDLE', 'div')], true, {
    maxNodes: 100,
    truncationReasons: ['shadow-coverage-unverified'],
    coverage: { verified: false, closedShadowRoots: 0, probedNodes: 5001, reason: 'over-budget' },
  })
  const { reobserve } = escalator(probed)
  const decision = await decideAssertion({ kind: 'node-absent', expected: DEEP }, view([], true, { maxNodes: 60 }), reobserve)

  assert.equal(decision.passed, false)
  assert.equal(decision.completeness.reason, QA_INCONCLUSIVE_TRUNCATED)
  assert.deepEqual(decision.completeness.truncationReasons, ['shadow-coverage-unverified'])
  assert.match(decision.completeness.detail, /shadow-coverage-unverified/)
  assert.match(decision.completeness.detail, /over-budget/, 'the probe reason is named in the detail')
})

test('a COMPLETE deciding view whose probe was skipped stays COVERAGE_UNVERIFIED and names reason skipped', async () => {
  const skipped = view([node('a', 'status', 'IDLE', 'div')], false, {
    maxNodes: 100,
    coverage: { verified: false, closedShadowRoots: 0, probedNodes: 0, reason: 'skipped' },
  })
  const { reobserve } = escalator(skipped)
  const decision = await decideAssertion({ kind: 'node-absent', expected: DEEP }, view([], true, { maxNodes: 60 }), reobserve)

  assert.equal(decision.passed, false)
  assert.equal(decision.completeness.reason, QA_COVERAGE_UNVERIFIED)
  assert.equal(decision.completeness.truncated, false)
  assert.match(decision.completeness.detail, /reason 'skipped'/, 'the driver reason is named in the detail')
})

// ---------------------------------------------------------------------------
// 2b. QA-BL-043 / QA-BL-044: the completeness block reports what the driver
//     APPLIED, never the requested constant, and names which truncation hit.
// ---------------------------------------------------------------------------

test('QA-BL-043: a same-budget escalation reports the driver maximum and never the requested 500', async () => {
  // The agent was already at the driver maximum (100): the escalation requests
  // 500, the driver clamps to 100, and the completeness block must say so.
  const fuller = view([node('a', 'status', 'IDLE', 'div')], true, { maxNodes: 100, truncationReasons: ['node-budget-exceeded'] })
  const { calls, reobserve } = escalator(fuller)
  const decision = await decideAssertion(
    { kind: 'node-absent', expected: DEEP },
    view([], true, { maxNodes: 100, truncationReasons: ['node-budget-exceeded'] }),
    reobserve,
  )
  assert.deepEqual(calls, [QA_ESCALATED_NODE_BUDGET], 'the escalation still REQUESTS the bounded constant')
  assert.equal(decision.completeness.nodeBudget, 100, 'the APPLIED budget is reported')
  assert.match(decision.completeness.detail, /driver maximum of 100 nodes/)
  assert.match(decision.completeness.detail, /no wider view exists from this driver/)
  assert.ok(!decision.completeness.detail.includes('500'), 'the requested 500 must never appear as if applied')
  assert.doesNotMatch(decision.completeness.detail, /raise the observation node budget/, 'the advice must not tell the agent to raise past the driver maximum')
  assert.match(decision.completeness.detail, /narrow the page or region, or scroll the target into a smaller view/)
})

test('QA-BL-043: a wider applied budget names both numbers in the detail', async () => {
  const { calls, reobserve } = escalator(view([node('a', 'status', 'IDLE', 'div')], false, { maxNodes: 100 }))
  const decision = await decideAssertion({ kind: 'node-absent', expected: DEEP }, view([], true, { maxNodes: 60 }), reobserve)
  // CHANGED (QA-BL-052 / Codex Q4): the escalated view is complete but its
  // boundaries are unverified, so the absence stays UNPROVEN; the detail
  // still names both budgets and now the unverified-boundaries cause.
  assert.equal(decision.passed, false, 'unverified coverage: absence cannot pass')
  assert.equal(decision.completeness.reason, QA_COVERAGE_UNVERIFIED)
  assert.equal(decision.completeness.nodeBudget, 100, 'the APPLIED budget is reported')
  assert.match(decision.completeness.detail, /applied 100 nodes instead of the prior 60/, 'the detail names the applied and the prior budget')
  assert.match(decision.completeness.detail, /closed shadow roots, slot assignment/)
  assert.equal(decision.completeness.truncationReasons, undefined, 'a complete deciding view carries no reasons')
})

test('QA-BL-044: iframe-not-traversed picks reason-specific advice (a budget cannot help)', async () => {
  const fuller = view([node('a', 'status', 'IDLE', 'div')], true, { maxNodes: 100, truncationReasons: ['iframe-not-traversed'] })
  const { calls, reobserve } = escalator(fuller)
  const decision = await decideAssertion(
    { kind: 'node-absent', expected: DEEP },
    view([], true, { maxNodes: 100, truncationReasons: ['iframe-not-traversed'] }),
    reobserve,
  )
  assert.equal(decision.completeness.reason, QA_INCONCLUSIVE_TRUNCATED)
  assert.match(decision.completeness.detail, /iframe-not-traversed/, 'the reason is named in the detail')
  assert.match(decision.completeness.detail, /does not traverse/)
  assert.match(decision.completeness.detail, /node budget cannot help/)
  assert.doesNotMatch(decision.completeness.detail, /raise the observation node budget/)
})

test('QA-BL-044: scan-window-exceeded names the scan window, not the node budget', async () => {
  const fuller = view([node('a', 'status', 'IDLE', 'div')], true, { maxNodes: 100, truncationReasons: ['scan-window-exceeded'] })
  const { calls, reobserve } = escalator(fuller)
  const decision = await decideAssertion(
    { kind: 'node-absent', expected: DEEP },
    view([], true, { maxNodes: 100, truncationReasons: ['scan-window-exceeded'] }),
    reobserve,
  )
  assert.match(decision.completeness.detail, /scan-window-exceeded/, 'the reason is named in the detail')
  assert.match(decision.completeness.detail, /fixed scan window/)
  assert.match(decision.completeness.detail, /raising the node budget cannot help/)
  assert.doesNotMatch(decision.completeness.detail, /raise the observation node budget/)
})

test('QA-BL-044: the qa_assert tool result carries truncationReasons and the applied budget', async () => {
  const owner = 'truncation-tool'
  const adapter = {
    kind: 'browser',
    async start() { return { page: { url: LAUNCH, title: 'iframe fixture' }, headless: true } },
    async observe() {
      return {
        page: { url: LAUNCH, title: 'iframe fixture' },
        nodes: [node('n-status', 'status', 'IDLE', 'div')],
        truncated: true,
        maxNodes: 100,
        truncationReasons: ['iframe-not-traversed'],
      }
    },
    async act() { return { status: 'confirmed', dispatched: true } },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
  const recorder = new QaTrajectoryRecorder()
  const manager = new QaSessionManager(new RecordingQaDriverAdapter(adapter, recorder), { settle: SETTLE })
  const host = new QaToolHost({ settle: SETTLE })
  host.managerFor = async () => manager
  host.managerForOwner = async () => manager
  const tools = createQaTools(host)
  try {
    await tools.qaSessionStart.execute({ owner, driver: 'browser', url: LAUNCH }, {})
    const result = await tools.qaAssert.execute(
      { owner, kind: 'node-absent', expected: { role: 'button', name: 'Lives in an iframe' } },
      { agent: { id: 'truncation-tool-agent' } },
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.passed, false)
    assert.equal(result.completeness.reason, QA_INCONCLUSIVE_TRUNCATED)
    assert.equal(result.completeness.nodeBudget, 100, 'the tool result reports the APPLIED budget')
    assert.deepEqual(result.completeness.truncationReasons, ['iframe-not-traversed'], 'the tool result names WHY the view is partial')
    assert.match(result.completeness.detail, /iframe-not-traversed/)
  } finally {
    await host.dispose()
  }
})

test('QA-BL-052: the qa_assert tool result surfaces COVERAGE_UNVERIFIED on a complete unverified view', async () => {
  const owner = 'coverage-tool'
  const adapter = {
    kind: 'browser',
    async start() { return { page: { url: LAUNCH, title: 'coverage fixture' }, headless: true } },
    async observe() {
      return {
        page: { url: LAUNCH, title: 'coverage fixture' },
        nodes: [node('n-status', 'status', 'IDLE', 'div')],
        truncated: false,
      }
    },
    async act() { return { status: 'confirmed', dispatched: true } },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
  const recorder = new QaTrajectoryRecorder()
  const manager = new QaSessionManager(new RecordingQaDriverAdapter(adapter, recorder), { settle: SETTLE })
  const host = new QaToolHost({ settle: SETTLE })
  host.managerFor = async () => manager
  host.managerForOwner = async () => manager
  const tools = createQaTools(host)
  try {
    await tools.qaSessionStart.execute({ owner, driver: 'browser', url: LAUNCH }, {})
    const result = await tools.qaAssert.execute(
      { owner, kind: 'node-absent', expected: { role: 'button', name: 'Nowhere' } },
      { agent: { id: 'coverage-tool-agent' } },
    )
    // The view is COMPLETE, so the absence can no longer pass: the tool result
    // must carry the new machine code and the honest detail — never a false
    // "absent".
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.passed, false)
    assert.equal(result.inconclusive, true)
    assert.equal(result.code, QA_COVERAGE_UNVERIFIED)
    assert.equal(result.completeness.reason, QA_COVERAGE_UNVERIFIED)
    assert.equal(result.completeness.truncated, false)
    assert.match(result.completeness.detail, /closed shadow roots, slot assignment/)
    assert.match(result.completeness.detail, /not "not present"/)
  } finally {
    await host.dispose()
  }
})

// ---------------------------------------------------------------------------
// 3. The replay runner: the false pass, and the recovery.
// ---------------------------------------------------------------------------

test('REGRESSION: node-absent for an existing-but-unseen node never passes', async () => {
  const adapter = budgetAdapter({ total: 80, deepAt: 70 })
  const report = await runScenario(
    scenario([REVEAL_STEP], [{ kind: 'node-absent', expected: DEEP }]),
    adapter,
    { ownerId: 'truncation-false-pass', settle: SETTLE },
  )

  assert.notEqual(report.status, 'pass', 'a node beyond the budget must never be reported as gone')
  assert.equal(report.status, 'fail')
  const [assertionResult] = report.assertions
  assert.equal(assertionResult.passed, false)
  assert.deepEqual(assertionResult.observed, { role: 'button', name: 'Deep control', tag: 'button' })
  assert.equal(assertionResult.completeness.escalated, true)
  assert.equal(assertionResult.completeness.truncated, false)
  assert.ok(adapter.observed.includes(QA_ESCALATED_NODE_BUDGET), 'the budget was escalated before concluding')
})

test('an unprovable absence is reported as INCONCLUSIVE, not as an ordinary failure', async () => {
  const adapter = budgetAdapter({ total: 300, deepAt: 250 })
  const report = await runScenario(
    scenario([REVEAL_STEP], [{ kind: 'node-absent', expected: { role: 'button', name: 'Never rendered' } }]),
    adapter,
    { ownerId: 'truncation-inconclusive', settle: SETTLE },
  )

  assert.equal(report.status, 'fail')
  assert.equal(report.assertions[0].passed, false)
  assert.equal(report.assertions[0].completeness.reason, QA_INCONCLUSIVE_TRUNCATED)
  assert.match(report.failure.message, new RegExp(QA_INCONCLUSIVE_TRUNCATED))
  assert.match(report.failure.message, /may exist outside the returned window/)
})

// CHANGED (QA-BL-052 / Codex Q4): the runner can no longer produce a PASS
// for a genuinely absent node — the escalated view is complete but the
// driver never verified its boundaries, so the run fails closed with the
// new reason code and the honest detail.
test('a genuinely absent node after escalation is still UNPROVEN without verified coverage', async () => {
  const adapter = budgetAdapter({ total: 80, deepAt: 70 })
  const report = await runScenario(
    scenario([REVEAL_STEP], [{ kind: 'node-absent', expected: { role: 'button', name: 'Never rendered' } }]),
    adapter,
    { ownerId: 'truncation-true-absence', settle: SETTLE },
  )

  assert.notEqual(report.status, 'pass', 'an unverified absence must never pass the run')
  assert.equal(report.assertions[0].passed, false)
  assert.equal(report.assertions[0].completeness.escalated, true)
  assert.equal(report.assertions[0].completeness.truncated, false)
  assert.equal(report.assertions[0].completeness.reason, QA_COVERAGE_UNVERIFIED)
  assert.equal(report.assertions[0].reason, QA_COVERAGE_UNVERIFIED)
  assert.match(report.assertions[0].completeness?.detail ?? '', /closed shadow roots, slot assignment/)
  assert.match(report.failure?.message ?? '', new RegExp(QA_COVERAGE_UNVERIFIED))
})

test('coverage.verified on the driver restores the genuinely-absent PASS (the v9 restoration path)', async () => {
  const adapter = budgetAdapter({
    total: 80,
    deepAt: 70,
    coverage: { verified: true, closedShadowRoots: 0, probedNodes: 26 },
    hiddenMatches: 4,
    hiddenMatchesPartial: true,
  })
  const report = await runScenario(
    scenario([REVEAL_STEP], [{ kind: 'node-absent', expected: { role: 'button', name: 'Never rendered' } }]),
    adapter,
    { ownerId: 'truncation-verified-absence', settle: SETTLE },
  )

  assert.equal(report.status, 'pass', JSON.stringify(report.failure))
  assert.equal(report.assertions[0].passed, true)
  assert.equal(report.assertions[0].completeness.escalated, true)
  assert.equal(report.assertions[0].completeness.truncated, false)
  assert.equal(report.assertions[0].completeness.reason, undefined)
  // The proven absence PASS reports its proof: the Codex-consult wording,
  // the deciding coverage evidence, and the gate-excluded candidates.
  assert.match(report.assertions[0].completeness.detail, /No driver-observable semantic node matching/)
  assert.match(report.assertions[0].completeness.detail, new RegExp('coverage verified \\(26 nodes probed\\)'))
  assert.match(report.assertions[0].completeness.detail, new RegExp('4 hidden candidates excluded \\(lower bound\\)'))
  assert.equal(report.assertions[0].completeness.hiddenMatches, 4)
  assert.equal(report.assertions[0].completeness.hiddenMatchesPartial, true)
  assert.deepEqual(
    report.assertions[0].completeness.coverage,
    { verified: true, closedShadowRoots: 0, probedNodes: 26 },
  )
})

test('a target outside the initial budget is found by escalation (the scroll scenario)', async () => {
  const adapter = budgetAdapter({ total: 80, deepAt: 70, inViewport: true })
  const report = await runScenario(
    scenario(
      [{
        index: 1,
        intent: 'Scroll to "Deep control".',
        action: { kind: 'scroll', target: DEEP },
        assert: { kind: 'node-in-viewport', expected: DEEP },
      }],
      [{ kind: 'node-present', expected: DEEP }],
    ),
    adapter,
    { ownerId: 'truncation-scroll-target', settle: SETTLE },
  )

  assert.equal(report.status, 'pass', 'the human must not have to raise max_nodes by hand')
  assert.equal(report.steps[0].assertionPassed, true)
  assert.equal(report.steps[0].completeness.escalated, true)
  assert.equal(report.assertions[0].passed, true)
  assert.ok(adapter.observed.includes(QA_ESCALATED_NODE_BUDGET))
})

test('the truncation decision is deterministic across two runs', async () => {
  const runs = []
  for (let i = 0; i < 2; i += 1) {
    runs.push(await runScenario(
      scenario([REVEAL_STEP], [{ kind: 'node-absent', expected: DEEP }]),
      budgetAdapter({ total: 80, deepAt: 70 }),
      { ownerId: 'truncation-determinism-' + i, settle: SETTLE },
    ))
  }
  assert.equal(
    JSON.stringify(normalizeReportForDeterminism(runs[0])),
    JSON.stringify(normalizeReportForDeterminism(runs[1])),
    'escalation changes duration, not outcome',
  )
})

// ---------------------------------------------------------------------------
// 4. The three report artifacts carry the truncation context.
// ---------------------------------------------------------------------------

test('report.md names the gate-excluded candidates and the coverage-verified absence PASS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-truncation-pass-report-'))
  try {
    const report = await runScenario(
      scenario([REVEAL_STEP], [{ kind: 'node-absent', expected: { role: 'button', name: 'Never rendered' } }]),
      budgetAdapter({
        total: 80,
        deepAt: 70,
        coverage: { verified: true, closedShadowRoots: 0, probedNodes: 21 },
        hiddenMatches: 4,
        hiddenMatchesPartial: true,
      }),
      { ownerId: 'truncation-pass-reports', settle: SETTLE },
    )
    assert.equal(report.status, 'pass', JSON.stringify(report.failure))
    const paths = await writeReports(report, { directory: dir })

    const md = await readFile(paths.markdown, 'utf8')
    assert.match(md, /view completeness:/)
    assert.match(md, /No driver-observable semantic node matching/)
    assert.match(md, new RegExp('coverage verified \\(21 nodes probed\\)'))
    assert.match(
      md,
      new RegExp('hidden semantic-selector candidates excluded: 4 \\(lower bound\\)'),
      'report.md names the gate-excluded candidates and the lower-bound status',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('report.json, report.md and report.jsonl all explain a truncation-affected result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-truncation-report-'))
  try {
    const report = await runScenario(
      scenario([REVEAL_STEP], [{ kind: 'node-absent', expected: { role: 'button', name: 'Never rendered' } }]),
      budgetAdapter({ total: 300, deepAt: 250 }),
      { ownerId: 'truncation-reports', settle: SETTLE },
    )
    const paths = await writeReports(report, { directory: dir })

    const json = JSON.parse(await readFile(paths.json, 'utf8'))
    const completeness = json.assertions[0].completeness
    assert.equal(completeness.reason, QA_INCONCLUSIVE_TRUNCATED)
    assert.equal(completeness.truncated, true)
    assert.equal(completeness.nodeBudget, 100, 'the budget the driver APPLIED (its 100-node clamp), never the requested 500')
    assert.deepEqual(completeness.truncationReasons, ['node-budget-exceeded'], 'the driver-named reason travels in report.json')
    assert.equal(completeness.escalated, true)

    const md = await readFile(paths.markdown, 'utf8')
    assert.match(md, /view completeness:/)
    assert.match(md, new RegExp(QA_INCONCLUSIVE_TRUNCATED))
    assert.match(md, /applied node budget: 100/)
    assert.match(md, /truncation reasons: node-budget-exceeded/, 'report.md names WHICH truncation applied')

    const jsonl = JSON.parse((await readFile(paths.jsonl, 'utf8')).trim())
    assert.equal(jsonl.assertions[0].completeness.reason, QA_INCONCLUSIVE_TRUNCATED)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. Export never synthesizes confident proof from an incomplete view.
// ---------------------------------------------------------------------------

test('a truncated proof observation is recorded as a weak proof in the exported intent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-truncation-export-'))
  try {
    const recorder = new QaTrajectoryRecorder()
    const adapter = new RecordingQaDriverAdapter(budgetAdapter({ total: 80, deepAt: 70 }), recorder)
    const session = new QaSession(adapter, 'truncation-export', { settle: SETTLE })
    await session.start({ url: LAUNCH })
    const before = await session.observeSettled()
    assert.equal(before.observation.truncated, true, 'the fixture must exceed the default budget')
    const target = before.observation.nodes.find((item) => item.name === 'Reveal panel')
    await session.act({ kind: 'click', ref: target.ref })
    await session.stop()

    const exported = await exportRecordedScenario(recorder, 'truncation-export', {
      outputPath: join(dir, 'truncated-proof.json'),
    })
    assert.equal(exported.ok, true, 'a provable step is still exported, never silently dropped')
    const step = exported.scenario.steps[0]
    assert.match(step.intent, /Weak proof: .*truncated at the driver node budget/)
    assert.match(step.intent, /verify manually/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
