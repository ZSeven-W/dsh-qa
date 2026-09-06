// QA-BL-062 (Codex consult #2, decision (b)): PASS is reserved for PROVEN
// scoped-scroll resolution. A scoped SCROLL-proof step whose container is
// resolved provisionally (exactly one predicate/path match in a still-truncated
// whole-page view) is INCONCLUSIVE_SCOPE with scopeResolution 'provisional' —
// never passed:true — and the run aggregates to the NEW three-state status:
// 'pass' only when every required result is fully proven, 'inconclusive' when
// at least one result is provisional and nothing definitely failed, 'fail'
// otherwise. The replay side additionally:
//   - matches the container by the recorded ancestor PATH (scope.path) when
//     present (relationships, never refs);
//   - counts target predicate matches inside the scoped view BEFORE filtering
//     by inViewport (>=2 -> TARGET_NOT_UNIQUE; exactly 1 in a truncated or
//     coverage-unverified subtree cannot earn pass);
//   - verifies the replayed scroll through the driver's identity anchor
//     (anchorLastAction) and REFUSES (escalationRefused-style disclosure on the
//     step, never a predicate reselect) on a lost binding or mismatch.
// The real-Chrome twin lives in test/explore-scroll-scoped-deep-target.
// integration.test.mjs and test/explore-scroll-scoped-proof.integration.test.mjs.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  runScenario,
  validateAssertion,
  ScenarioValidationError,
  QA_ESCALATED_NODE_BUDGET,
} from '../src/replay/index.ts'
import { renderReportMarkdown } from '../src/reporters/index.ts'
import {
  QA_INCONCLUSIVE_SCOPE,
  QA_TARGET_NOT_UNIQUE,
} from '../src/contracts.ts'

const LAUNCH = 'http://127.0.0.1:7481/'
const SETTLE = { budgetMs: 400, quietMs: 40, intervalMs: 5 }
const TARGET = { role: 'link', name: 'Deep Target' }
const SCOPE = { role: 'region', name: 'Deep zone', path: [{ role: 'region', name: 'Page' }] }

function node(ref, role, name, tag, extra = {}) {
  return { ref, role, name, tag, interactive: role === 'link', editable: false, disabled: false, ...extra }
}

function scopedScrollScenario() {
  const assert_ = {
    kind: 'node-in-viewport',
    expected: TARGET,
    scope: SCOPE,
  }
  return {
    meta: { name: 'scoped scroll proof', description: 'd', driver: 'browser', createdAt: '2026-09-06T05:00:00.000Z' },
    target: { launch: LAUNCH },
    steps: [{
      index: 1,
      intent: 'Scroll to "Deep Target".',
      action: { kind: 'scroll', target: TARGET },
      assert: assert_,
    }],
    assertions: [assert_],
  }
}

/**
 * Synthetic scoped scroll page. wholePage(escalated) is the whole-page view
 * (the recorded path matches when the container's parentRef chain resolves to
 * the 'Page' region); scopedFor(options, acted) is the scoped read — pre-action
 * (no anchorLastAction) it returns the target off-viewport, post-action (with
 * anchorLastAction) it returns the target in viewport plus the identity anchor
 * and coverage evidence unless the case under test overrides them.
 */
function replayAdapter({ wholePage, scopedFor }) {
  let acted = false
  let escalatedReads = 0
  const observeCalls = []
  return {
    adapter: {
      kind: 'browser',
      async start(_owner, options) {
        return { page: { url: options?.url ?? LAUNCH, title: 'scoped scroll replay' }, headless: true }
      },
      async observe(_owner, options) {
        observeCalls.push({
          maxNodes: options?.maxNodes,
          withinRef: options?.withinRef,
          anchorLastAction: options?.anchorLastAction,
          verifyCoverage: options?.verifyCoverage,
        })
        if (options?.withinRef !== undefined) return scopedFor(options, acted)
        if (options?.maxNodes === QA_ESCALATED_NODE_BUDGET) escalatedReads += 1
        return wholePage(options?.maxNodes === QA_ESCALATED_NODE_BUDGET)
      },
      async act(_owner, action) {
        if (action.kind === 'scroll') acted = true
        return { status: 'confirmed', dispatched: true }
      },
      async evidence() {
        return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } }
      },
      async stop() { return { stopped: true, reason: 'requested' } },
    },
    observeCalls: () => observeCalls,
    escalatedReads: () => escalatedReads,
  }
}

const page = () => ({ url: LAUNCH, title: 'scoped scroll replay' })

function completeWholePage(acted, extra = {}) {
  return {
    page: page(),
    nodes: [
      node('r-page', 'region', 'Page', 'section', { inViewport: true }),
      node('r-zone', 'region', 'Deep zone', 'section', { parentRef: 'r-page', inViewport: true }),
      node('r-status', 'status', acted ? 'READY' : 'IDLE', 'div', { inViewport: true }),
    ],
    truncated: false,
    ...extra,
  }
}

function truncatedWholePage(extra = {}) {
  return {
    page: page(),
    nodes: [
      node('r-page', 'region', 'Page', 'section', { inViewport: true }),
      node('r-zone', 'region', 'Deep zone', 'section', { parentRef: 'r-page', inViewport: true }),
      node('r-fill', 'link', 'Filler', 'a', { inViewport: true }),
    ],
    truncated: true,
    ...extra,
  }
}

function acceptedScoped(options, acted, extra = {}) {
  return {
    page: page(),
    scope: { ref: options.withinRef, rootRef: 'r-zone-scoped', role: 'region', name: 'Deep zone', tag: 'section' },
    nodes: [
      node('r-zone-scoped', 'region', 'Deep zone', 'section', { inViewport: true }),
      node('r-target', TARGET.role, TARGET.name, 'a', { inViewport: acted }),
    ],
    truncated: false,
    ...(options.anchorLastAction === true
      ? {
          coverage: { verified: true, closedShadowRoots: 0, probedNodes: 5 },
          anchor: { ref: 'r-target', connected: true, contained: true },
        }
      : {}),
    ...extra,
  }
}

test('a scoped scroll proof resolved PROVEN in a complete whole-page view PASSES with scopeResolution proven', async () => {
  const { adapter, observeCalls } = replayAdapter({
    wholePage: (escalated) => {
      void escalated
      return completeWholePage(false)
    },
    scopedFor: (options, acted) => acceptedScoped(options, acted),
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'unit-proven', settle: SETTLE })
  assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? report))
  assert.equal(report.steps.length, 1)
  assert.equal(report.steps[0].status, 'pass')
  assert.equal(report.steps[0].assertionPassed, true)
  assert.equal(report.steps[0].reason, undefined, 'a proven decision carries no INCONCLUSIVE reason')
  assert.equal(report.steps[0].scopeResolution, 'proven')
  assert.equal(report.assertions[0].passed, true)
  assert.equal(report.assertions[0].scopeResolution, 'proven')
  assert.equal(report.failure, undefined)
  // The verifying scoped read must request BOTH the identity anchor and the
  // coverage probe (the anchor binds the evidence to the exact replayed scroll;
  // verified coverage is what lets target uniqueness inside the scope be proven).
  // Contract v9 Phase C: the anchor rides every poll, the coverage probe rides
  // exactly the ONE probed deciding read after the window settles.
  const anchored = observeCalls().filter((call) => call.anchorLastAction === true)
  assert.ok(anchored.length >= 2, 'the verifying read requests anchorLastAction on its polls')
  assert.ok(
    anchored.some((call) => call.withinRef === 'r-zone-scoped'),
    'the verifying read re-chains through the scoped rootRef',
  )
  assert.ok(
    anchored.some((call) => call.verifyCoverage === true),
    'the deciding verifying read requests the coverage probe: ' + JSON.stringify(anchored),
  )
})

test('one container match in a STILL-truncated whole-page view is PROVISIONAL: INCONCLUSIVE_SCOPE, never pass', async () => {
  const { adapter, escalatedReads } = replayAdapter({
    wholePage: () => truncatedWholePage(),
    scopedFor: (options, acted) => acceptedScoped(options, acted),
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'unit-provisional', settle: SETTLE })
  assert.equal(report.status, 'inconclusive', JSON.stringify(report.failure ?? report))
  assert.ok(escalatedReads() >= 2, 'the truncated whole-page view escalates ONCE: ' + String(escalatedReads()))
  const step = report.steps[0]
  assert.equal(step.status, 'inconclusive')
  assert.equal(step.assertionPassed, false, 'never passed:true for a provisionally resolved scope')
  assert.equal(step.reason, QA_INCONCLUSIVE_SCOPE)
  assert.equal(step.scopeResolution, 'provisional')
  assert.deepEqual(
    step.observed.map((item) => ({ role: item.role, name: item.name })),
    [TARGET],
    'the observed fragment still reports what the view returned (transparency)',
  )
  assert.match(step.completeness?.detail ?? '', /PROVISIONALLY/)
  assert.equal(report.assertions[0].passed, false, 'the copied final assertion inherits the provisional outcome')
  assert.equal(report.assertions[0].reason, QA_INCONCLUSIVE_SCOPE)
  assert.equal(report.assertions[0].scopeResolution, 'provisional')
  assert.equal(report.failure, undefined, 'nothing definitely failed: no failure block')
  assert.equal(report.receiptSummary.confirmed, 1)
})

test('a contained:false identity anchor REFUSES the step and is DISCLOSED (scopeRefusal), never a predicate reselect', async () => {
  const { adapter } = replayAdapter({
    wholePage: () => completeWholePage(false),
    scopedFor: (options, acted) => acceptedScoped(options, acted, {
      anchor: { ref: null, connected: true, contained: false },
    }),
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'unit-anchor-refused', settle: SETTLE })
  assert.equal(report.status, 'inconclusive', JSON.stringify(report.failure ?? report))
  const step = report.steps[0]
  assert.equal(step.assertionPassed, false, 'a refused anchor can never pass')
  assert.equal(step.reason, QA_INCONCLUSIVE_SCOPE)
  assert.equal(step.scopeResolution, 'proven', 'the container itself was proven unique; the ANCHOR refused')
  assert.ok(step.scopeRefusal, 'the refusal is disclosed escalationRefused-style on the step')
  assert.match(step.scopeRefusal.reason, /contained/)
  assert.equal(step.completeness?.scope !== undefined, true)
  assert.equal(report.failure, undefined, 'a refused anchor is unproven evidence, not a definite failure')
})

test('an anchor bound to a DIFFERENT node than the asserted target REFUSES (same-node-ref identity)', async () => {
  const { adapter } = replayAdapter({
    wholePage: () => completeWholePage(false),
    scopedFor: (options, acted) => acceptedScoped(options, acted, {
      anchor: { ref: 'r-zone-scoped', connected: true, contained: true },
    }),
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'unit-anchor-mismatch', settle: SETTLE })
  assert.equal(report.status, 'inconclusive')
  const step = report.steps[0]
  assert.equal(step.assertionPassed, false)
  assert.equal(step.reason, QA_INCONCLUSIVE_SCOPE)
  assert.ok(step.scopeRefusal, 'the mismatch is disclosed')
  assert.match(step.scopeRefusal.reason, /different element|asserted scroll target/)
})

test('a missing identity anchor REFUSES the step (the driver reported none)', async () => {
  const { adapter } = replayAdapter({
    wholePage: () => completeWholePage(false),
    scopedFor: (options, acted) => {
      const view = acceptedScoped(options, acted)
      delete view.anchor
      return view
    },
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'unit-anchor-missing', settle: SETTLE })
  assert.equal(report.status, 'inconclusive')
  const step = report.steps[0]
  assert.equal(step.assertionPassed, false)
  assert.equal(step.reason, QA_INCONCLUSIVE_SCOPE)
  assert.ok(step.scopeRefusal)
  assert.match(step.scopeRefusal.reason, /no identity anchor/)
})

test('TWO target predicate matches inside the scope (counted BEFORE inViewport) refuse with TARGET_NOT_UNIQUE', async () => {
  const { adapter } = replayAdapter({
    wholePage: () => completeWholePage(false),
    scopedFor: (options, acted) => {
      const view = acceptedScoped(options, acted)
      // A same-identity twin outside the viewport: the pre-action read (no
      // anchorLastAction) keeps a single target so the ACTION can dispatch; the
      // verifying read returns both, so the DECISION counts two and refuses.
      view.nodes = [
        node('r-zone-scoped', 'region', 'Deep zone', 'section', { inViewport: true }),
        node('r-target', TARGET.role, TARGET.name, 'a', { inViewport: true }),
        node('r-target-twin', TARGET.role, TARGET.name, 'a', { inViewport: false }),
      ]
      return view
    },
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'unit-target-twin', settle: SETTLE })
  assert.equal(report.status, 'fail', 'a KNOWN twin is a definite structural refusal, never pass, never a guess')
  assert.equal(report.failure?.code, QA_TARGET_NOT_UNIQUE)
  assert.match(report.failure?.message ?? '', /2 nodes match/)
})

test('a TRUNCATED verifying subtree cannot earn pass even with a proven container (uniqueness unproven)', async () => {
  // CHANGED (QA-BL-069): the container is now resolved through the recorded
  // ancestor path WALK — the Page region's scoped read (the container level's
  // parent view) must be COMPLETE for the container level to stay proven,
  // while the CONTAINER's own verifying read stays truncated (the test's
  // original intent: a proven container with a truncated verifying subtree
  // can still never earn a pass).
  const { adapter } = replayAdapter({
    wholePage: () => completeWholePage(false),
    // The CONTAINER's own verifying read requests anchorLastAction; the
    // walk's intermediate Page-region read does not. Branching on the anchor
    // (not the withinRef, which the settle re-keys per poll) keeps the
    // container level PROVEN in a complete parent view while the verifying
    // subtree stays truncated.
    scopedFor: (options, acted) => (options.anchorLastAction === true
      ? acceptedScoped(options, acted, { truncated: true })
      : acceptedScoped(options, acted)),
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'unit-subtree-truncated', settle: SETTLE })
  assert.equal(report.status, 'inconclusive', JSON.stringify(report.failure ?? report))
  const step = report.steps[0]
  assert.equal(step.assertionPassed, false)
  assert.equal(step.reason, QA_INCONCLUSIVE_SCOPE)
  assert.equal(step.scopeResolution, 'proven', 'the CONTAINER was proven; the subtree was not')
  assert.match(step.completeness?.detail ?? '', /truncated|unproven/i)
})

test('a COMPLETE but coverage-unverified verifying subtree cannot earn pass', async () => {
  const { adapter } = replayAdapter({
    wholePage: () => completeWholePage(false),
    scopedFor: (options, acted) => {
      const view = acceptedScoped(options, acted)
      view.coverage = { verified: false, closedShadowRoots: 0, probedNodes: 0, reason: 'skipped' }
      return view
    },
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'unit-subtree-unverified', settle: SETTLE })
  assert.equal(report.status, 'inconclusive', JSON.stringify(report.failure ?? report))
  const step = report.steps[0]
  assert.equal(step.assertionPassed, false)
  assert.equal(step.reason, QA_INCONCLUSIVE_SCOPE)
  assert.match(step.completeness?.detail ?? '', /coverage/i)
})

test('TWO path-matching container candidates refuse with TARGET_NOT_UNIQUE (a KNOWN twin is never guessed)', async () => {
  // CHANGED (QA-BL-069): uniqueness is judged PER LEVEL inside the parent's
  // view — the container level is now matched inside the Page region's SCOPED
  // view, so the twin must live THERE for the refusal to fire (the whole-page
  // twin check moved with the walk; the refusal itself is unchanged).
  const { adapter } = replayAdapter({
    wholePage: () => completeWholePage(false, {
      nodes: [
        node('r-page', 'region', 'Page', 'section', { inViewport: true }),
        node('r-zone', 'region', 'Deep zone', 'section', { parentRef: 'r-page', inViewport: true }),
        node('r-zone-twin', 'region', 'Deep zone', 'section', { parentRef: 'r-page', inViewport: true }),
        node('r-status', 'status', 'IDLE', 'div', { inViewport: true }),
      ],
    }),
    // The Page region's scoped read (no anchorLastAction) returns BOTH
    // zones; the container's verifying read requests the anchor.
    scopedFor: (options, acted) => (options.anchorLastAction === true
      ? acceptedScoped(options, acted)
      : {
          page: page(),
          scope: { ref: 'r-page', rootRef: 'r-page-scoped', role: 'region', name: 'Page', tag: 'section' },
          nodes: [
            node('r-page-scoped', 'region', 'Page', 'section', { inViewport: true }),
            node('r-zone', 'region', 'Deep zone', 'section', { parentRef: 'r-page-scoped', inViewport: true }),
            node('r-zone-twin', 'region', 'Deep zone', 'section', { parentRef: 'r-page-scoped', inViewport: true }),
          ],
          truncated: false,
        }),
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'unit-container-twin', settle: SETTLE })
  assert.equal(report.status, 'fail')
  assert.equal(report.failure?.code, QA_TARGET_NOT_UNIQUE)
  assert.match(report.failure?.message ?? '', /2 nodes match path level 2/)
})

test('a container whose ancestor PATH differs from the recorded path matches nothing', async () => {
  const { adapter } = replayAdapter({
    wholePage: () => completeWholePage(false, {
      nodes: [
        node('r-other', 'region', 'Other', 'section', { inViewport: true }),
        node('r-zone', 'region', 'Deep zone', 'section', { parentRef: 'r-other', inViewport: true }),
        node('r-status', 'status', 'IDLE', 'div', { inViewport: true }),
      ],
    }),
    scopedFor: (options, acted) => acceptedScoped(options, acted),
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'unit-path-mismatch', settle: SETTLE })
  assert.equal(report.status, 'fail')
  // CHANGED (QA-BL-069): the walk fails at the TOP level — the recorded
  // 'Page' ancestor is absent from the COMPLETE whole-page view, so the
  // container can never be there. Still a definite failure; the wording
  // names the path level instead of the flat container scope.
  assert.match(report.failure?.message ?? '', /no observable node matches path level 1/)
})

test('three-state aggregation: a proven step plus a provisional step is INCONCLUSIVE, never pass, never fail', async () => {
  const scenario = scopedScrollScenario()
  const assert2 = scenario.steps[0].assert
  scenario.steps = [
    {
      index: 1,
      intent: 'Click "Go".',
      action: { kind: 'click', target: { role: 'button', name: 'Go' } },
      assert: { kind: 'node-present', expected: { role: 'status', name: 'READY' } },
    },
    { index: 2, intent: 'Scroll to "Deep Target".', action: { kind: 'scroll', target: TARGET }, assert: assert2 },
  ]
  scenario.assertions = [assert2]
  let acted = false
  const { adapter } = replayAdapter({
    wholePage: () => truncatedWholePage({
      nodes: [
        node('r-page', 'region', 'Page', 'section', { inViewport: true }),
        node('r-zone', 'region', 'Deep zone', 'section', { parentRef: 'r-page', inViewport: true }),
        node('r-go', 'button', 'Go', 'button', { inViewport: true }),
        node('r-status', 'status', acted ? 'READY' : 'IDLE', 'div', { inViewport: true }),
      ],
    }),
    scopedFor: (options, post) => acceptedScoped(options, post),
  })
  adapter.act = async (_owner, action) => {
    if (action.kind === 'click') acted = true
    return { status: 'confirmed', dispatched: true }
  }
  const report = await runScenario(scenario, adapter, { ownerId: 'unit-aggregation', settle: SETTLE })
  assert.equal(report.status, 'inconclusive', JSON.stringify(report.failure ?? report))
  assert.equal(report.steps[0].status, 'pass', 'the whole-page step is fully proven')
  assert.equal(report.steps[0].scopeResolution, undefined, 'an unscoped step carries no scopeResolution')
  assert.equal(report.steps[1].status, 'inconclusive')
  assert.equal(report.steps[1].reason, QA_INCONCLUSIVE_SCOPE)
  assert.equal(report.steps[1].scopeResolution, 'provisional')
  assert.equal(report.assertions[0].passed, false)
  assert.equal(report.assertions[0].reason, QA_INCONCLUSIVE_SCOPE)
  assert.equal(report.failure, undefined)
})

test('the loader validates scope.path fail-closed (non-empty items, role required, no extra fields; QA-BL-069: name optional, tag allowed)', () => {
  const valid = validateAssertion({
    kind: 'node-in-viewport',
    expected: { role: 'link', name: 'x' },
    scope: { role: 'region', name: 'Deep zone', path: [{ role: 'region', name: 'Page' }, { role: 'main', name: '' }] },
  })
  assert.deepEqual(valid.scope, {
    role: 'region',
    name: 'Deep zone',
    path: [{ role: 'region', name: 'Page' }, { role: 'main', name: '' }],
  }, 'the recorded ancestor path round-trips (an empty ancestor name is an exact-match value)')

  // CHANGED (QA-BL-069 path durability): a path item may now OMIT the name
  // ({ role, tag } only for content-named ancestors whose aggregated name is
  // order-fragile or empty) and may carry a tag — both round-trip.
  const durable = validateAssertion({
    kind: 'node-in-viewport',
    expected: { role: 'link', name: 'x' },
    scope: {
      role: 'navigation',
      name: 'Navbox291',
      path: [{ role: 'navigation', tag: 'nav' }, { role: 'navigation' }],
    },
  })
  assert.deepEqual(durable.scope, {
    role: 'navigation',
    name: 'Navbox291',
    path: [{ role: 'navigation', tag: 'nav' }, { role: 'navigation' }],
  }, 'name-less path items (with and without a tag) round-trip')

  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'x' }, scope: { role: 'region', name: 'x', path: [] } }),
    ScenarioValidationError,
  )
  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'x' }, scope: { role: 'region', name: 'x', path: 'main' } }),
    ScenarioValidationError,
  )
  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'x' }, scope: { role: 'region', name: 'x', path: [{ name: 'Page' }] } }),
    ScenarioValidationError,
  )
  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'x' }, scope: { role: 'region', name: 'x', path: [{ role: '', name: 'Page' }] } }),
    ScenarioValidationError,
  )
  // CHANGED (QA-BL-069): a TAG on a path item is now ACCEPTED (it is the
  // discriminator that replaces the omitted fragile name); what stays
  // rejected is an EMPTY tag (a non-discriminating value) and unknown fields.
  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'x' }, scope: { role: 'region', name: 'x', path: [{ role: 'region', name: 'Page', tag: '' }] } }),
    ScenarioValidationError,
  )
  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'x' }, scope: { role: 'region', name: 'x', path: [{ role: 'region', name: 'Page', extra: 1 }] } }),
    ScenarioValidationError,
  )
})

test('report.md renders the three-state status, INCONCLUSIVE_SCOPE reason, scope resolution, and the refusal disclosure', () => {
  const report = {
    schemaVersion: 1,
    scenario: 'scoped scroll proof',
    driver: 'browser',
    status: 'inconclusive',
    startedAt: '2026-09-06T05:00:00.000Z',
    finishedAt: '2026-09-06T05:00:01.000Z',
    steps: [{
      index: 1,
      intent: 'Scroll to "Deep Target".',
      status: 'inconclusive',
      action: { kind: 'scroll', target: TARGET },
      receipt: { status: 'confirmed', dispatched: true },
      outcome: 'ok',
      assertion: { kind: 'node-in-viewport', expected: TARGET, scope: SCOPE },
      assertionPassed: false,
      observed: [TARGET],
      expected: TARGET,
      completeness: {
        truncated: false,
        nodeBudget: 100,
        escalated: true,
        outcomeDependsOnCompleteView: false,
        scope: { role: 'region', name: 'Deep zone' },
        detail: 'the scoped container was resolved PROVISIONALLY: one match in a still-truncated whole-page view (INCONCLUSIVE_SCOPE).',
      },
      reason: QA_INCONCLUSIVE_SCOPE,
      scopeResolution: 'provisional',
      scopeRefusal: { reason: 'the identity anchor reported the acted element outside the scoped container (contained: false)' },
    }],
    assertions: [{
      kind: 'node-in-viewport',
      passed: false,
      expected: TARGET,
      observed: [TARGET],
      scope: SCOPE,
      reason: QA_INCONCLUSIVE_SCOPE,
      scopeResolution: 'provisional',
    }],
    evidence: null,
    receiptSummary: { confirmed: 1, unknown: 0, rejected: 0, failed: 0, total: 1 },
  }
  const md = renderReportMarkdown(report)
  assert.match(md, /Status\*\*: inconclusive/)
  assert.match(md, /\[INCONCLUSIVE\] step 1/)
  assert.match(md, /node-in-viewport -> INCONCLUSIVE/)
  assert.match(md, /reason: INCONCLUSIVE_SCOPE/)
  assert.match(md, /scope resolution: provisional/)
  assert.match(md, /scope refusal: the identity anchor reported the acted element outside the scoped container \(contained: false\)/)
  assert.doesNotMatch(md, /## Failure/, 'an inconclusive run carries no failure section')
  assert.match(md, /INCONCLUSIVE \(observed:/)
})
