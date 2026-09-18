// Verdict integrity: a green result must mean the DECLARED assertion held.
//
// Codex gpt-6 astra consult, 2026-09-18, reproduced three paths that return a
// green verdict without proving the claimed assertion or action. All three are
// regressions against the product's headline claim ("no false green"), so they
// live together here:
//
//   1. decideScopedScrollProof() computes evaluateAssertion() but never
//      requires evaluation.passed. PASS is decided by the ACTION target being
//      in the viewport, so a step whose ASSERTION names a different node
//      passed with observed: [].
//   2. The runner copies a scoped-scroll step decision into a matching FINAL
//      assertion, so a final assertion can report pass without ever being
//      evaluated against the final observation — even after a later step
//      invalidated it.
//   3. synthesizeValueAssertion() falls back to a node matching by ROLE alone
//      (name-agnostic) when the fill target drifts, so an unrelated textbox
//      that already contained the typed text becomes the exported proof.
//
// Each test states the user-visible lie it prevents. None of them assert on
// internal call counts: they assert on the verdict a user would read.

import test from 'node:test'
import assert from 'node:assert/strict'
import { runScenario, QA_ESCALATED_NODE_BUDGET } from '../src/replay/index.ts'

const LAUNCH = 'http://127.0.0.1:7499/'
const SETTLE = { budgetMs: 400, quietMs: 40, intervalMs: 5 }

const SCROLLED = { role: 'link', name: 'Actual target' }
const ASSERTED = { role: 'link', name: 'Missing target' }
const SCOPE = { role: 'region', name: 'Deep zone', path: [{ role: 'region', name: 'Page' }] }

function node(ref, role, name, tag, extra = {}) {
  return { ref, role, name, tag, interactive: role === 'link', editable: false, disabled: false, ...extra }
}

const page = () => ({ url: LAUNCH, title: 'verdict integrity' })

function completeWholePage() {
  return {
    page: page(),
    nodes: [
      node('r-page', 'region', 'Page', 'section', { inViewport: true }),
      node('r-zone', 'region', 'Deep zone', 'section', { parentRef: 'r-page', inViewport: true }),
    ],
    truncated: false,
  }
}

/**
 * The scoped subtree holds ONLY the node the scroll actually targets. The
 * asserted node ("Missing target") is not in it, so the declared assertion
 * cannot hold — while every condition the scroll-proof path looks at (proven
 * container, complete subtree, verified coverage, truthful anchor, action
 * target in viewport) is satisfied.
 */
function scopedWithoutAssertedNode(options, acted) {
  return {
    page: page(),
    scope: { ref: options.withinRef, rootRef: 'r-zone-scoped', role: 'region', name: 'Deep zone', tag: 'section' },
    nodes: [
      node('r-zone-scoped', 'region', 'Deep zone', 'section', { inViewport: true }),
      node('r-scrolled', SCROLLED.role, SCROLLED.name, 'a', { inViewport: acted }),
    ],
    truncated: false,
    ...(options.anchorLastAction === true
      ? {
          coverage: { verified: true, closedShadowRoots: 0, probedNodes: 5 },
          anchor: { ref: 'r-scrolled', connected: true, contained: true },
        }
      : {}),
  }
}

function replayAdapter({ wholePage, scopedFor }) {
  let acted = false
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'verdict integrity' }, headless: true }
    },
    async observe(_owner, options) {
      if (options?.withinRef !== undefined) return scopedFor(options, acted)
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
  }
}

test('a scoped scroll step whose ASSERTION names a different node than the action target is never pass', async () => {
  // The lie this prevents: "step 1 passed, so 'Missing target' was in the
  // viewport" — when the scroll moved 'Actual target' and 'Missing target' was
  // never observed at all. A pass here would be a green verdict for an
  // assertion whose own evaluator returns false.
  const assertion = { kind: 'node-in-viewport', expected: ASSERTED, scope: SCOPE }
  const scenario = {
    meta: {
      name: 'assertion does not match the scrolled target',
      description: 'd',
      driver: 'browser',
      createdAt: '2026-09-18T03:00:00.000Z',
    },
    target: { launch: LAUNCH },
    steps: [{
      index: 1,
      intent: 'Scroll to "Actual target".',
      action: { kind: 'scroll', target: SCROLLED },
      assert: assertion,
    }],
    assertions: [assertion],
  }

  const report = await runScenario(
    scenario,
    replayAdapter({ wholePage: () => completeWholePage(), scopedFor: scopedWithoutAssertedNode }),
    { ownerId: 'verdict-scroll-mismatch', settle: SETTLE },
  )

  assert.notEqual(
    report.steps[0].assertionPassed,
    true,
    'the step must not report a passed assertion when the asserted node was never observed',
  )
  // A complete, coverage-verified subtree under a PROVEN container is good
  // enough to refute the assertion, so this is a definite failure — not
  // `inconclusive`, which would read as "we could not tell".
  assert.equal(report.status, 'fail', 'the run must be fail: ' + JSON.stringify(report.steps[0]))
  assert.equal(report.steps[0].status, 'fail')
  assert.equal(
    report.steps[0].reason,
    undefined,
    'a refuted assertion must NOT be stamped INCONCLUSIVE_SCOPE — that would downgrade a failure to "unproven"',
  )
  assert.deepEqual(
    report.steps[0].observed,
    [],
    'nothing matching the asserted predicate was observed, and the report must say so',
  )
  assert.match(
    report.steps[0].completeness?.detail ?? '',
    /DISPROVEN, not merely unproven/,
    'the report must distinguish a refuted assertion from missing evidence',
  )
  // The failed step stops the run, so the final assertions never execute.
  // Reporting a green final assertion here would be the same lie one level up.
  assert.equal(report.assertions.length, 0, 'a failed step stops the run before final assertions')
})

test('a final assertion is re-decided against the FINAL view when steps ran after the scroll proof', async () => {
  // The lie this prevents: step 1 scrolls "Actual target" into view and passes;
  // step 2 then pushes it back out; the final assertion — a copy of step 1's —
  // inherits step 1's verdict and reports the target still in the viewport.
  // Inheriting is sound only when nothing happened afterwards.
  const scrollAssert = { kind: 'node-in-viewport', expected: SCROLLED, scope: SCOPE }
  const scenario = {
    meta: {
      name: 'a later step invalidates the scroll proof',
      description: 'd',
      driver: 'browser',
      createdAt: '2026-09-18T03:10:00.000Z',
    },
    target: { launch: LAUNCH },
    steps: [
      {
        index: 1,
        intent: 'Scroll to "Actual target".',
        action: { kind: 'scroll', target: SCROLLED },
        assert: scrollAssert,
      },
      {
        index: 2,
        intent: 'Collapse the zone, which pushes the target out of the viewport.',
        action: { kind: 'click', target: { role: 'button', name: 'Collapse' } },
        assert: { kind: 'node-present', expected: { role: 'button', name: 'Collapse' } },
      },
    ],
    assertions: [scrollAssert],
  }

  let scrolled = false
  let collapsed = false
  const adapter = {
    kind: 'browser',
    async start() { return { page: page(), headless: true } },
    async observe(_owner, options) {
      // In the viewport only after the scroll and before the collapse.
      const visible = scrolled && !collapsed
      if (options?.withinRef !== undefined) {
        return {
          page: page(),
          scope: { ref: options.withinRef, rootRef: 'r-zone-scoped', role: 'region', name: 'Deep zone', tag: 'section' },
          nodes: [
            node('r-zone-scoped', 'region', 'Deep zone', 'section', { inViewport: true }),
            node('r-scrolled', SCROLLED.role, SCROLLED.name, 'a', { inViewport: visible }),
          ],
          truncated: false,
          ...(options.anchorLastAction === true
            ? {
                coverage: { verified: true, closedShadowRoots: 0, probedNodes: 5 },
                anchor: { ref: 'r-scrolled', connected: true, contained: true },
              }
            : {}),
        }
      }
      return {
        page: page(),
        nodes: [
          node('r-page', 'region', 'Page', 'section', { inViewport: true }),
          node('r-zone', 'region', 'Deep zone', 'section', { parentRef: 'r-page', inViewport: true }),
          node('r-collapse', 'button', 'Collapse', 'button', { inViewport: true }),
          node('r-scrolled', SCROLLED.role, SCROLLED.name, 'a', { parentRef: 'r-zone', inViewport: visible }),
        ],
        truncated: false,
        coverage: { verified: true, closedShadowRoots: 0, probedNodes: 7 },
      }
    },
    async act(_owner, action) {
      if (action.kind === 'scroll') scrolled = true
      if (action.kind === 'click') collapsed = true
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() {
      return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } }
    },
    async stop() { return { stopped: true, reason: 'requested' } },
  }

  const report = await runScenario(scenario, adapter, { ownerId: 'verdict-stale-final', settle: SETTLE })

  assert.equal(report.steps[0].assertionPassed, true, 'step 1 legitimately passed when it ran')
  assert.equal(report.assertions.length, 1)
  assert.notEqual(
    report.assertions[0].passed,
    true,
    'the final assertion must reflect the FINAL view, where the target is no longer in the viewport: '
      + JSON.stringify(report.assertions[0]),
  )
  assert.notEqual(report.status, 'pass', 'a run whose final assertion no longer holds must not be green')
})

// --- false green 3: export manufacturing a value proof from the wrong field ---

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exportRecordedScenario,
  QaTrajectoryRecorder,
  RecordingQaDriverAdapter,
} from '../src/explore/index.ts'
import { QaSession } from '../src/session/index.ts'

function field(ref, name, value, extra = {}) {
  return {
    ref,
    role: 'textbox',
    name,
    tag: 'input',
    interactive: true,
    editable: true,
    disabled: false,
    value,
    inViewport: true,
    ...extra,
  }
}

/**
 * The fill targets "Primary", which DISAPPEARS when the action lands (an
 * ineffective fill that navigated the field away). "Backup" is a different
 * textbox that ALREADY held the typed text before the action ran, so it is
 * evidence of nothing.
 */
function vanishingTargetAdapter() {
  let acted = false
  return {
    kind: 'browser',
    async start() { return { page: page(), headless: true } },
    async observe() {
      return {
        page: page(),
        nodes: acted
          ? [
              node('r-form', 'region', 'Form', 'section', { inViewport: true }),
              field('r-backup', 'Backup', 'hello'),
            ]
          : [
              node('r-form', 'region', 'Form', 'section', { inViewport: true }),
              field('r-primary', 'Primary', ''),
              field('r-backup', 'Backup', 'hello'),
            ],
        truncated: false,
        coverage: { verified: true, closedShadowRoots: 0, probedNodes: 3 },
      }
    },
    async act(_owner, action) {
      if (action.kind === 'fill') acted = true
      return { status: 'unknown', dispatched: true }
    },
    async evidence() {
      return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } }
    },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

test('a fill is never proven by a field that ALREADY held the typed text before the action', async () => {
  // The lie this prevents: the exported scenario fills "Primary" but asserts on
  // "Backup", so replaying it against an app where the fill does nothing still
  // returns pass — "Backup" held "hello" all along.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-verdict-value-'))
  try {
    const recorder = new QaTrajectoryRecorder()
    const session = new QaSession(
      new RecordingQaDriverAdapter(vanishingTargetAdapter(), recorder),
      'verdict-value',
      { settle: SETTLE },
    )
    await session.start({ url: LAUNCH })
    const before = await session.observeSettled()
    const primary = before.observation.nodes.find((item) => item.name === 'Primary')
    assert.ok(primary, 'the fixture must expose the Primary field')
    await session.act({ kind: 'fill', ref: primary.ref, text: 'hello' })
    await session.stop()

    const exported = await exportRecordedScenario(recorder, 'verdict-value', {
      outputPath: join(dir, 'verdict-value.json'),
    })

    const step = exported.ok ? exported.scenario.steps[0] : undefined
    if (step !== undefined) {
      const expected = step.assert.expected ?? {}
      assert.notEqual(
        expected.name,
        'Backup',
        'the proof must never bind to a field the action never touched: ' + JSON.stringify(step.assert),
      )
      assert.ok(
        step.assert.kind !== 'node-value' || expected.value !== 'hello' || expected.name === 'Primary',
        'a node-value proof must belong to the acted element: ' + JSON.stringify(step.assert),
      )
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a FAILED explicit assertion is disclosed as an export exclusion, never silently dropped', async () => {
  // The lie this prevents: you explore, write "Order completed" as your
  // acceptance criterion, watch it FAIL, export the scenario — and the exported
  // file contains no trace of it. The committed scenario then replays green
  // forever while the criterion you actually cared about is gone.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-verdict-dropped-'))
  try {
    // A fill that genuinely lands, so the export HAS a proven step and writes a
    // file. That is the dangerous shape: a scenario that looks complete while
    // the user's failed criterion vanished from it.
    let filled = false
    const workingFillAdapter = {
      kind: 'browser',
      async start() { return { page: page(), headless: true } },
      async observe() {
        return {
          page: page(),
          nodes: [
            node('r-form', 'region', 'Form', 'section', { inViewport: true }),
            field('r-primary', 'Primary', filled ? 'hello' : ''),
          ],
          truncated: false,
          coverage: { verified: true, closedShadowRoots: 0, probedNodes: 2 },
        }
      },
      async act(_owner, action) {
        if (action.kind === 'fill') filled = true
        return { status: 'confirmed', dispatched: true }
      },
      async evidence() {
        return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } }
      },
      async stop() { return { stopped: true, reason: 'requested' } },
    }
    const recorder = new QaTrajectoryRecorder()
    const session = new QaSession(
      new RecordingQaDriverAdapter(workingFillAdapter, recorder),
      'verdict-dropped',
      { settle: SETTLE },
    )
    await session.start({ url: LAUNCH })
    const before = await session.observeSettled()
    const primary = before.observation.nodes.find((item) => item.name === 'Primary')
    await session.act({ kind: 'fill', ref: primary.ref, text: 'hello' })
    await session.observeSettled()
    // The user's own acceptance criterion, and it did not hold.
    recorder.assertion('verdict-dropped', {
      kind: 'node-present',
      expected: { role: 'status', name: 'Order completed' },
    }, false)
    await session.stop()

    const exported = await exportRecordedScenario(recorder, 'verdict-dropped', {
      outputPath: join(dir, 'verdict-dropped.json'),
    })

    assert.equal(exported.ok, true, 'the export must succeed so the dropped criterion is the only defect: '
      + JSON.stringify(exported))
    const exclusions = exported.excludedAssertions ?? []
    assert.ok(
      exclusions.some((entry) => JSON.stringify(entry).includes('Order completed')),
      'the failed assertion must appear in excludedAssertions with its identity: ' + JSON.stringify(exclusions),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
