// QA-BL-069: the scoped path walk + path durability + the C classification.
//
// Three causes on the real Wikipedia History_of_China run (d5-redo artifacts,
// dsh-qa v18): (1) `scope.path` recorded the collapsible sidebar's full
// aggregated accessible name, which concatenates its children's text and
// changes with collapse state / render timing — exact-name matching failed
// intermittently; (2) the container was resolved by ONE flat predicate match
// over the ≤100-node whole-page window, so a deep container was found or not
// depending on what else rendered first; (3) "container not found in a
// still-truncated view" was misclassified as a step FAIL although nothing
// definitely failed.
//
// Pins here (unit level; the real-Chrome twin lives in
// test/scoped-path-walk.integration.test.mjs):
//   A. Export path durability: a content-named container ancestor (> 80-char
//      aggregated name, or an empty name) records { role, tag } ONLY — the
//      name is omitted, so the path survives the collapse-state flip between
//      page loads. Other ancestors keep { role, name }.
//   B. Replay walks the path TOP-DOWN: each level is matched INSIDE its
//      parent's settled scoped view (the whole-page view for level 1, with
//      today's ONE escalation), so a deep container is located by its
//      ancestry instead of a whole-page window race. Exactly one match in a
//      COMPLETE view → proven at that level; one match in a truncated view →
//      provisional; ≥2 → TARGET_NOT_UNIQUE (definite failure); zero in a
//      complete view → definite failure; zero in a still-truncated view →
//      INCONCLUSIVE_TRUNCATED. Overall 'proven' requires EVERY level proven.
//   C. Zero matches in a still-truncated view (any level, flat included) is
//      an INCONCLUSIVE step (assertionPassed:false, run status
//      'inconclusive', NEVER 'fail') with the honest wording "the container
//      could not be located in the truncated view; it may exist outside the
//      returned window". Definite failures (zero in a complete view,
//      TARGET_NOT_UNIQUE) stay fail.
//   D. Export durability is judged PER LEVEL from recorded evidence, so an
//      explicit scoped assertion whose whole-page baseline was truncated is
//      no longer excluded with SCOPE_NOT_DURABLE merely for that: the path
//      levels that are proven inside their ancestor's COMPLETE recorded
//      scoped view keep it exportable (provisional exactly where the top
//      level is unproven).

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runScenario,
  validateAssertion,
  ScenarioValidationError,
  QA_ESCALATED_NODE_BUDGET,
} from '../src/replay/index.ts'
import { exportRecordedScenario, QaTrajectoryRecorder } from '../src/explore/index.ts'
import { renderReportMarkdown } from '../src/reporters/index.ts'
import {
  QA_INCONCLUSIVE_SCOPE,
  QA_INCONCLUSIVE_TRUNCATED,
  QA_TARGET_NOT_UNIQUE,
} from '../src/contracts.ts'

const LAUNCH = 'http://127.0.0.1:7481/'
const SETTLE = { budgetMs: 400, quietMs: 40, intervalMs: 5 }
const TARGET = { role: 'link', name: 'Qing dynasty' }
// The durable path shape the export records for a collapsible content-named
// sidebar ancestor: role + tag, name DELIBERATELY omitted (QA-BL-069).
const SIDEBAR_ITEM = { role: 'navigation', tag: 'nav' }
const SCOPE = { role: 'navigation', name: 'Navbox291', path: [SIDEBAR_ITEM] }
// The aggregated name of the sidebar in the EXPANDED state (concatenated
// child text, > 80 chars) — a name that changes with the collapse toggle.
const SIDEBAR_NAME_EXPANDED =
  'Part of a series on the History of China: timeline, dynasties, historiography, prehistoric China, neolithic China hide Timeline Dynasties Historiography Prehistoric'
const SIDEBAR_NAME_COLLAPSED =
  'Part of a series on the History of China: timeline, dynasties, historiography, prehistoric China, neolithic China show'

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
    meta: { name: 'scoped path walk', description: 'd', driver: 'browser', createdAt: '2026-09-06T05:00:00.000Z' },
    target: { launch: LAUNCH },
    steps: [{
      index: 1,
      intent: 'Scroll to "Qing dynasty".',
      action: { kind: 'scroll', target: TARGET },
      assert: assert_,
    }],
    assertions: [assert_],
  }
}

const page = () => ({ url: LAUNCH, title: 'scoped path walk' })

/**
 * Synthetic Wikipedia-shaped page. wholePage(escalated) returns the whole-page
 * view; scopedFor(options, acted) returns the scoped read whose root matches
 * the withinRef (the sidebar read, or the container's verifying read with the
 * identity anchor + coverage). The sidebar carries the EXPANDED aggregated
 * name; the container (Navbox291) sits beyond the whole-page window.
 */
function walkAdapter({ wholePage, sidebarView, containerView }) {
  let acted = false
  let escalatedReads = 0
  const observeCalls = []
  return {
    adapter: {
      kind: 'browser',
      async start(_owner, options) {
        return { page: { url: options?.url ?? LAUNCH, title: 'scoped path walk' }, headless: true }
      },
      async observe(_owner, options) {
        observeCalls.push({
          maxNodes: options?.maxNodes,
          withinRef: options?.withinRef,
          anchorLastAction: options?.anchorLastAction,
          verifyCoverage: options?.verifyCoverage,
        })
        if (options?.withinRef !== undefined) {
          return String(options.withinRef).includes('navbox') || String(options.withinRef).includes('box')
            ? containerView(options, acted)
            : sidebarView(options)
        }
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

function wholePageComplete(sidebarName = SIDEBAR_NAME_EXPANDED) {
  return {
    page: page(),
    nodes: [
      node('r-side', 'navigation', sidebarName, 'nav', { inViewport: true }),
      node('r-fill', 'link', 'Filler', 'a', { inViewport: true }),
      node('r-status', 'status', 'IDLE', 'div', { inViewport: true }),
    ],
    truncated: false,
  }
}

function wholePageTruncated(sidebarName = SIDEBAR_NAME_EXPANDED) {
  return {
    page: page(),
    nodes: [
      node('r-side', 'navigation', sidebarName, 'nav', { inViewport: true }),
      node('r-fill', 'link', 'Filler', 'a', { inViewport: true }),
      node('r-status', 'status', 'IDLE', 'div', { inViewport: true }),
    ],
    truncated: true,
  }
}

function acceptedSidebarView(options) {
  return {
    page: page(),
    scope: { ref: options.withinRef, rootRef: 'r-side-scoped', role: 'navigation', name: SIDEBAR_NAME_EXPANDED, tag: 'nav' },
    nodes: [
      node('r-side-scoped', 'navigation', SIDEBAR_NAME_EXPANDED, 'nav', { inViewport: true }),
      node('r-navbox', 'navigation', 'Navbox291', 'div', { parentRef: 'r-side-scoped', inViewport: true }),
    ],
    truncated: false,
  }
}

function acceptedContainerView(options, acted) {
  return {
    page: page(),
    scope: { ref: options.withinRef, rootRef: 'r-navbox-scoped', role: 'navigation', name: 'Navbox291', tag: 'div' },
    nodes: [
      node('r-navbox-scoped', 'navigation', 'Navbox291', 'div', { inViewport: true }),
      node('r-target', TARGET.role, TARGET.name, 'a', { inViewport: acted }),
    ],
    truncated: false,
    ...(options.anchorLastAction === true
      ? {
          coverage: { verified: true, closedShadowRoots: 0, probedNodes: 5 },
          anchor: { ref: 'r-target', connected: true, contained: true },
        }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// A. Export path durability (scopePathFor / pathItemFor)
// ---------------------------------------------------------------------------

/** One exported scoped click step whose before/after observations are configurable. */
async function exportScopedStep(dir, before, after) {
  const recorder = new QaTrajectoryRecorder()
  recorder.start('sc', 'browser', { url: LAUNCH }, { page: { url: LAUNCH, title: 'scoped path walk' }, headless: true })
  recorder.observation('sc', before)
  const actionId = recorder.action('sc', { kind: 'click', ref: 'r-anchor' })
  recorder.receipt('sc', actionId, { status: 'confirmed', dispatched: true })
  recorder.observation('sc', after)
  recorder.settle('sc', { stable: true, passes: 2, elapsedMs: 10, budgetMs: 400, quietRequiredMs: 40, widened: null })
  return exportRecordedScenario(recorder, 'sc', { outputPath: join(dir, 'scoped.json') })
}

function exportStepViews({ ancestor }) {
  const before = {
    page: page(),
    nodes: [
      ancestor,
      node('r-navbox', 'navigation', 'Navbox291', 'div', { parentRef: ancestor.ref, inViewport: true }),
      node('r-anchor', 'button', 'anchor', 'button', { inViewport: true }),
      node('r-status', 'status', 'IDLE', 'div', { inViewport: true }),
    ],
    truncated: false,
  }
  const after = {
    page: page(),
    scope: { ref: 'r-navbox', role: 'navigation', name: 'Navbox291', tag: 'div' },
    nodes: [
      node('r-navbox', 'navigation', 'Navbox291', 'div', { inViewport: true }),
      node('r-anchor', 'button', 'anchor', 'button', { inViewport: true }),
      node('r-status', 'status', 'READY', 'div', { inViewport: true }),
    ],
    truncated: false,
  }
  return { before, after }
}

test('A: a content-named ancestor with a >80-char aggregated name records { role, tag } ONLY (the name is order-fragile)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-path-durable-'))
  try {
    const { before, after } = exportStepViews({
      ancestor: node('r-side', 'navigation', SIDEBAR_NAME_EXPANDED, 'nav', { inViewport: true }),
    })
    const exported = await exportScopedStep(dir, before, after)
    assert.equal(exported.ok, true, JSON.stringify(exported))
    const scope = exported.scenario.steps[0].assert.scope
    assert.deepEqual(
      scope,
      { role: 'navigation', name: 'Navbox291', path: [SIDEBAR_ITEM] },
      'the fragile aggregated name is OMITTED from the path; role+tag survive the collapse flip',
    )
    assert.doesNotMatch(JSON.stringify(scope.path), new RegExp(SIDEBAR_NAME_EXPANDED.slice(0, 20)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('A: an EMPTY-named ancestor records { role, tag } only (an empty name discriminates nothing)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-path-empty-'))
  try {
    const { before, after } = exportStepViews({
      ancestor: node('r-side', 'navigation', '', 'nav', { inViewport: true }),
    })
    const exported = await exportScopedStep(dir, before, after)
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.deepEqual(
      exported.scenario.steps[0].assert.scope,
      { role: 'navigation', name: 'Navbox291', path: [SIDEBAR_ITEM] },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('A: a short-named ancestor keeps { role, name } (its authored label is stable)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-path-short-'))
  try {
    const { before, after } = exportStepViews({
      ancestor: node('r-shelf', 'region', 'Deep shelf', 'section', { inViewport: true }),
    })
    const exported = await exportScopedStep(dir, before, after)
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.deepEqual(
      exported.scenario.steps[0].assert.scope,
      { role: 'navigation', name: 'Navbox291', path: [{ role: 'region', name: 'Deep shelf' }] },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('A: a LONG-named ancestor whose role is NOT content-named keeps its name (an authored leaf-style label)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-path-long-noncontainer-'))
  try {
    const longName = 'W ' + 'x'.repeat(120)
    const { before, after } = exportStepViews({
      ancestor: node('r-w', 'generic', longName, 'div', { inViewport: true }),
    })
    const exported = await exportScopedStep(dir, before, after)
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.deepEqual(
      exported.scenario.steps[0].assert.scope,
      { role: 'navigation', name: 'Navbox291', path: [{ role: 'generic', name: longName }] },
      'only CONTENT-NAMED container roles lose their long aggregated name',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// B. Level-wise uniqueness classification (the replay walk)
// ---------------------------------------------------------------------------

test('B: every level proven in COMPLETE parent views -> PASS with scopeResolution proven and per-level proven', async () => {
  const { adapter, escalatedReads } = walkAdapter({
    wholePage: () => wholePageComplete(),
    sidebarView: (options) => acceptedSidebarView(options),
    containerView: (options, acted) => acceptedContainerView(options, acted),
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'walk-proven', settle: SETTLE })
  assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? report))
  assert.equal(escalatedReads(), 0, 'a complete whole-page view needs no escalation')
  const step = report.steps[0]
  assert.equal(step.status, 'pass')
  assert.equal(step.assertionPassed, true)
  assert.equal(step.reason, undefined)
  assert.equal(step.scopeResolution, 'proven')
  assert.deepEqual(
    step.scopeLevels,
    [
      { level: 1, what: 'role "navigation", tag "nav"', resolution: 'proven' },
      { level: 2, what: 'role "navigation", name "Navbox291"', resolution: 'proven' },
    ],
    'every level names its proven resolution',
  )
  assert.equal(report.assertions[0].passed, true)
  assert.equal(report.assertions[0].scopeResolution, 'proven')
  assert.equal(report.failure, undefined)
  const md = renderReportMarkdown(report)
  assert.match(md, /scope levels: level 1 \(role "navigation", tag "nav"\): proven; level 2 \(role "navigation", name "Navbox291"\): proven/)
})

test('B: a TRUNCATED whole-page top level resolves PROVISIONALLY even when deeper levels are proven -> INCONCLUSIVE_SCOPE', async () => {
  const { adapter, escalatedReads } = walkAdapter({
    wholePage: () => wholePageTruncated(),
    sidebarView: (options) => acceptedSidebarView(options),
    containerView: (options, acted) => acceptedContainerView(options, acted),
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'walk-provisional', settle: SETTLE })
  assert.equal(report.status, 'inconclusive', JSON.stringify(report.failure ?? report))
  assert.ok(escalatedReads() >= 2, 'the whole-page top level escalates ONCE per decision: ' + String(escalatedReads()))
  const step = report.steps[0]
  assert.equal(step.status, 'inconclusive')
  assert.equal(step.assertionPassed, false, 'never passed:true for a provisionally resolved scope')
  assert.equal(step.reason, QA_INCONCLUSIVE_SCOPE)
  assert.equal(step.scopeResolution, 'provisional')
  assert.deepEqual(
    step.scopeLevels,
    [
      { level: 1, what: 'role "navigation", tag "nav"', resolution: 'provisional' },
      { level: 2, what: 'role "navigation", name "Navbox291"', resolution: 'proven' },
    ],
    'the top level is provisional (truncated whole page), the container level proven (complete scoped view)',
  )
  assert.match(step.completeness?.detail ?? '', /level 1 .*provisional/)
  assert.match(step.completeness?.detail ?? '', /level 2 .*proven/)
  assert.deepEqual(
    step.observed.map((item) => ({ role: item.role, name: item.name })),
    [TARGET],
    'the observed fragment still reports what the verifying view returned (transparency)',
  )
  assert.equal(report.assertions[0].passed, false, 'the copied final assertion inherits the provisional outcome')
  assert.equal(report.assertions[0].reason, QA_INCONCLUSIVE_SCOPE)
  assert.equal(report.assertions[0].scopeResolution, 'provisional')
  assert.equal(report.failure, undefined, 'nothing definitely failed: no failure block')
})

test('B: TWO matches at a deeper level -> TARGET_NOT_UNIQUE (a KNOWN twin is never guessed), a definite failure', async () => {
  const { adapter } = walkAdapter({
    wholePage: () => wholePageTruncated(),
    sidebarView: () => ({
      page: page(),
      scope: { ref: 'r-side', rootRef: 'r-side-scoped', role: 'navigation', name: SIDEBAR_NAME_EXPANDED, tag: 'nav' },
      nodes: [
        node('r-side-scoped', 'navigation', SIDEBAR_NAME_EXPANDED, 'nav', { inViewport: true }),
        node('r-navbox', 'navigation', 'Navbox291', 'div', { parentRef: 'r-side-scoped', inViewport: true }),
        node('r-navbox-twin', 'navigation', 'Navbox291', 'div', { parentRef: 'r-side-scoped', inViewport: true }),
      ],
      truncated: false,
    }),
    containerView: (options, acted) => acceptedContainerView(options, acted),
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'walk-twin', settle: SETTLE })
  assert.equal(report.status, 'fail', 'a known twin is a definite structural refusal')
  assert.equal(report.failure?.code, QA_TARGET_NOT_UNIQUE)
  assert.match(report.failure?.message ?? '', /2 nodes match path level 2/)
})

test('B: ZERO matches at a deeper level inside a COMPLETE scoped view -> definite failure (the container is not on the page)', async () => {
  const { adapter } = walkAdapter({
    wholePage: () => wholePageTruncated(),
    sidebarView: () => ({
      page: page(),
      scope: { ref: 'r-side', rootRef: 'r-side-scoped', role: 'navigation', name: SIDEBAR_NAME_EXPANDED, tag: 'nav' },
      nodes: [
        node('r-side-scoped', 'navigation', SIDEBAR_NAME_EXPANDED, 'nav', { inViewport: true }),
      ],
      truncated: false,
    }),
    containerView: (options, acted) => acceptedContainerView(options, acted),
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'walk-absent-complete', settle: SETTLE })
  assert.equal(report.status, 'fail', 'zero matches in a COMPLETE parent view is a definite failure')
  assert.match(report.failure?.message ?? '', /no observable node matches the assertion scope .*inside a complete view of its last ancestor/)
})

test('B: ZERO matches at the TOP level inside a COMPLETE whole-page view -> definite failure', async () => {
  const { adapter } = walkAdapter({
    wholePage: () => ({
      page: page(),
      nodes: [
        node('r-fill', 'link', 'Filler', 'a', { inViewport: true }),
        node('r-status', 'status', 'IDLE', 'div', { inViewport: true }),
      ],
      truncated: false,
    }),
    sidebarView: (options) => acceptedSidebarView(options),
    containerView: (options, acted) => acceptedContainerView(options, acted),
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'walk-absent-top', settle: SETTLE })
  assert.equal(report.status, 'fail')
  assert.match(report.failure?.message ?? '', /no observable node matches path level 1/)
})

// ---------------------------------------------------------------------------
// C. The classification: zero-in-truncated is INCONCLUSIVE, never fail
// ---------------------------------------------------------------------------

test('C: ZERO matches at a deeper level in a STILL-truncated scoped view -> step inconclusive INCONCLUSIVE_TRUNCATED, run inconclusive, never fail', async () => {
  const { adapter } = walkAdapter({
    wholePage: () => wholePageTruncated(),
    sidebarView: () => ({
      page: page(),
      scope: { ref: 'r-side', rootRef: 'r-side-scoped', role: 'navigation', name: SIDEBAR_NAME_EXPANDED, tag: 'nav' },
      nodes: [
        node('r-side-scoped', 'navigation', SIDEBAR_NAME_EXPANDED, 'nav', { inViewport: true }),
        node('r-fill', 'link', 'Filler', 'a', { inViewport: true }),
      ],
      truncated: true, // the sidebar subtree exceeds its budget: Navbox291 may exist beyond it
    }),
    containerView: (options, acted) => acceptedContainerView(options, acted),
  })
  const report = await runScenario(scopedScrollScenario(), adapter, { ownerId: 'walk-not-located', settle: SETTLE })
  assert.equal(report.status, 'inconclusive', 'NOTHING definitely failed: ' + JSON.stringify(report.failure ?? {}))
  const step = report.steps[0]
  assert.equal(step.status, 'inconclusive')
  assert.equal(step.assertionPassed, false)
  assert.equal(step.reason, QA_INCONCLUSIVE_TRUNCATED)
  assert.equal(step.scopeNotLocated, true)
  assert.equal(step.scopeResolution, undefined, 'a container that was NOT located carries no scopeResolution')
  assert.deepEqual(
    step.scopeLevels.map((level) => level.resolution),
    ['provisional', 'not-located'],
    'the walk names the provisional top level and the not-located container level',
  )
  assert.match(
    step.completeness?.detail ?? '',
    /the container could not be located in the truncated view; it may exist outside the returned window/,
    'the honest C wording travels into the completeness detail (report.md)',
  )
  assert.equal(report.assertions[0].passed, false, 'the copied final assertion inherits the inconclusive outcome')
  assert.equal(report.assertions[0].reason, QA_INCONCLUSIVE_TRUNCATED)
  assert.equal(report.assertions[0].scopeNotLocated, true)
  assert.equal(report.failure, undefined, 'no failure block: nothing definitely failed')
  const md = renderReportMarkdown(report)
  assert.match(md, /\[INCONCLUSIVE\] step 1/)
  assert.match(md, /node-in-viewport -> INCONCLUSIVE/)
  assert.match(md, /scope not located: the container could not be located in the truncated view; it may exist outside the returned window/)
  assert.match(md, /scope levels: level 1 .*: provisional; level 2 .*: not-located/)
  assert.match(md, /Status\*\*: inconclusive/)
})

test('C: the FLAT resolution (no recorded path) keeps its zero-in-truncated classification change: inconclusive, never fail', async () => {
  // A scope WITHOUT a path whose container the still-truncated whole-page
  // view (after the ONE escalation) does not return: pre-QA-BL-069 this was a
  // step FAIL with "no observable node matches the assertion scope, and the
  // view was still truncated" — misclassified, because nothing definitely
  // failed. It is now INCONCLUSIVE_TRUNCATED.
  const flatScope = { role: 'navigation', name: 'Navbox291' }
  const assert_ = { kind: 'node-in-viewport', expected: TARGET, scope: flatScope }
  const scenario = {
    meta: { name: 'flat not located', description: 'd', driver: 'browser', createdAt: '2026-09-06T05:00:00.000Z' },
    target: { launch: LAUNCH },
    steps: [{
      index: 1,
      intent: 'Scroll to "Qing dynasty".',
      action: { kind: 'scroll', target: TARGET },
      assert: assert_,
    }],
    assertions: [assert_],
  }
  const { adapter } = walkAdapter({
    wholePage: () => ({
      page: page(),
      nodes: [
        node('r-fill', 'link', 'Filler', 'a', { inViewport: true }),
        node('r-status', 'status', 'IDLE', 'div', { inViewport: true }),
      ],
      truncated: true, // Navbox291 may exist beyond the window
    }),
    sidebarView: (options) => acceptedSidebarView(options),
    containerView: (options, acted) => acceptedContainerView(options, acted),
  })
  const report = await runScenario(scenario, adapter, { ownerId: 'flat-not-located', settle: SETTLE })
  assert.equal(report.status, 'inconclusive', JSON.stringify(report.failure ?? {}))
  const step = report.steps[0]
  assert.equal(step.status, 'inconclusive')
  assert.equal(step.reason, QA_INCONCLUSIVE_TRUNCATED)
  assert.equal(step.scopeNotLocated, true)
  assert.deepEqual(
    step.scopeLevels,
    [{ level: 1, what: 'role "navigation", name "Navbox291"', resolution: 'not-located' }],
  )
  assert.match(step.completeness?.detail ?? '', /may exist outside the returned window/)
  assert.equal(report.failure, undefined)
})

test('C: ZERO matches in a COMPLETE view stays a definite failure (the flat case)', async () => {
  const flatScope = { role: 'navigation', name: 'Navbox291' }
  const assert_ = { kind: 'node-in-viewport', expected: TARGET, scope: flatScope }
  const scenario = {
    meta: { name: 'flat absent', description: 'd', driver: 'browser', createdAt: '2026-09-06T05:00:00.000Z' },
    target: { launch: LAUNCH },
    steps: [{
      index: 1,
      intent: 'Scroll to "Qing dynasty".',
      action: { kind: 'scroll', target: TARGET },
      assert: assert_,
    }],
    assertions: [assert_],
  }
  const { adapter } = walkAdapter({
    wholePage: () => ({
      page: page(),
      nodes: [
        node('r-fill', 'link', 'Filler', 'a', { inViewport: true }),
        node('r-status', 'status', 'IDLE', 'div', { inViewport: true }),
      ],
      truncated: false,
    }),
    sidebarView: (options) => acceptedSidebarView(options),
    containerView: (options, acted) => acceptedContainerView(options, acted),
  })
  const report = await runScenario(scenario, adapter, { ownerId: 'flat-absent-complete', settle: SETTLE })
  assert.equal(report.status, 'fail', 'a COMPLETE view that lacks the container is a definite failure')
  assert.match(report.failure?.message ?? '', /no observable node matches the assertion scope/)
})

// ---------------------------------------------------------------------------
// D. Export durability is judged per level (the owner's explicit assertion)
// ---------------------------------------------------------------------------

test('D: an explicit scoped assertion whose whole-page baseline was TRUNCATED exports its scope (with the durable path) instead of SCOPE_NOT_DURABLE', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-path-assert-export-'))
  try {
    const recorder = new QaTrajectoryRecorder()
    recorder.start('sc', 'browser', { url: LAUNCH }, { page: { url: LAUNCH, title: 'scoped path walk' }, headless: true })
    // The whole-page baseline is TRUNCATED and does NOT return the container
    // (it sits beyond the window) — the owner's exact precondition. The
    // sidebar IS inside the window (one match, truncated -> provisional top
    // level at export, decision (b)).
    recorder.observation('sc', {
      page: page(),
      nodes: [
        node('r-side', 'navigation', SIDEBAR_NAME_EXPANDED, 'nav', { inViewport: true }),
        node('r-fill', 'link', 'Filler', 'a', { inViewport: true }),
      ],
      truncated: true,
    })
    // A COMPLETE scoped view of the sidebar: the container is unique inside
    // its ancestor's complete scoped view -> durable at that level.
    recorder.observation('sc', {
      page: page(),
      scope: { ref: 'r-side', rootRef: 'r-side-scoped', role: 'navigation', name: SIDEBAR_NAME_EXPANDED, tag: 'nav' },
      nodes: [
        node('r-side-scoped', 'navigation', SIDEBAR_NAME_EXPANDED, 'nav', { inViewport: true }),
        node('r-navbox', 'navigation', 'Navbox291', 'div', { parentRef: 'r-side-scoped', inViewport: true }),
      ],
      truncated: false,
    })
    // The deciding observation: scoped to the container itself.
    recorder.observation('sc', {
      page: page(),
      scope: { ref: 'r-navbox', role: 'navigation', name: 'Navbox291', tag: 'div' },
      nodes: [
        node('r-navbox', 'navigation', 'Navbox291', 'div', { inViewport: true }),
        node('r-target', TARGET.role, TARGET.name, 'a', { inViewport: true }),
      ],
      truncated: false,
    })
    recorder.assertion('sc', { kind: 'node-in-viewport', expected: TARGET }, true)
    const exported = await exportRecordedScenario(recorder, 'sc', { outputPath: join(dir, 'scoped.json') })
    // No PROVEN steps (no action recorded) — the scenario is null, but the
    // exclusion verdict is what D pins: the passed assertion must NOT be
    // excluded with SCOPE_NOT_DURABLE merely because the whole-page baseline
    // was truncated.
    assert.equal(exported.ok, false, 'no proven step: the scenario is not built')
    assert.equal(exported.excludedAssertions.length, 0, JSON.stringify(exported.excludedAssertions))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('D: the SAME recorded shape WITH a proven action exports the scope provisionally (top level unproven), never SCOPE_NOT_DURABLE', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-path-assert-export-step-'))
  try {
    const recorder = new QaTrajectoryRecorder()
    recorder.start('sc', 'browser', { url: LAUNCH }, { page: { url: LAUNCH, title: 'scoped path walk' }, headless: true })
    recorder.observation('sc', {
      page: page(),
      nodes: [
        node('r-side', 'navigation', SIDEBAR_NAME_EXPANDED, 'nav', { inViewport: true }),
        node('r-fill', 'link', 'Filler', 'a', { inViewport: true }),
      ],
      truncated: true,
    })
    recorder.observation('sc', {
      page: page(),
      scope: { ref: 'r-side', rootRef: 'r-side-scoped', role: 'navigation', name: SIDEBAR_NAME_EXPANDED, tag: 'nav' },
      nodes: [
        node('r-side-scoped', 'navigation', SIDEBAR_NAME_EXPANDED, 'nav', { inViewport: true }),
        node('r-navbox', 'navigation', 'Navbox291', 'div', { parentRef: 'r-side-scoped', inViewport: true }),
        node('r-target', TARGET.role, TARGET.name, 'a', { parentRef: 'r-navbox', inViewport: false }),
      ],
      truncated: false,
    })
    const actionId = recorder.action('sc', { kind: 'scroll', ref: 'r-target' })
    recorder.receipt('sc', actionId, { status: 'confirmed', dispatched: true })
    recorder.observation('sc', {
      page: page(),
      scope: { ref: 'r-navbox', role: 'navigation', name: 'Navbox291', tag: 'div' },
      nodes: [
        node('r-navbox', 'navigation', 'Navbox291', 'div', { inViewport: true }),
        node('r-target', TARGET.role, TARGET.name, 'a', { inViewport: true }),
      ],
      truncated: false,
      anchor: { ref: 'r-target', connected: true, contained: true },
    })
    recorder.settle('sc', { stable: true, passes: 2, elapsedMs: 10, budgetMs: 400, quietRequiredMs: 40, widened: null })
    const exported = await exportRecordedScenario(recorder, 'sc', { outputPath: join(dir, 'scoped.json') })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.excludedActions.length, 0, JSON.stringify(exported.excludedActions))
    const step = exported.scenario.steps[0]
    assert.deepEqual(
      step.assert.scope,
      { role: 'navigation', name: 'Navbox291', path: [SIDEBAR_ITEM] },
      'the scope rides WITH the durable (name-less) ancestor path',
    )
    assert.match(step.intent, /PROVISIONAL/, 'the top level is unproven (truncated whole-page baseline): explicitly provisional')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Loader: name-less and tag-carrying path items are accepted fail-closed
// ---------------------------------------------------------------------------

test('the loader accepts path items WITHOUT a name (role + optional tag) and keeps the empty name as a value', () => {
  const valid = validateAssertion({
    kind: 'node-in-viewport',
    expected: { role: 'link', name: 'x' },
    scope: {
      role: 'navigation',
      name: 'Navbox291',
      path: [
        { role: 'navigation', tag: 'nav' },
        { role: 'main', name: '' },
        { role: 'region', name: 'Page' },
      ],
    },
  })
  assert.deepEqual(valid.scope, {
    role: 'navigation',
    name: 'Navbox291',
    path: [
      { role: 'navigation', tag: 'nav' },
      { role: 'main', name: '' },
      { role: 'region', name: 'Page' },
    ],
  }, 'the QA-BL-069 path items round-trip (name optional; empty name kept literally)')

  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'x' }, scope: { role: 'region', name: 'x', path: [{ tag: 'nav' }] } }),
    ScenarioValidationError,
    'role stays required',
  )
  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'x' }, scope: { role: 'region', name: 'x', path: [{ role: 'navigation', tag: '' }] } }),
    ScenarioValidationError,
    'a recorded tag must be a non-empty string',
  )
  assert.throws(
    () => validateAssertion({ kind: 'node-absent', expected: { role: 'x' }, scope: { role: 'region', name: 'x', path: [{ role: 'navigation', name: 'x', extra: true }] } }),
    ScenarioValidationError,
    'unknown fields stay rejected',
  )
})
