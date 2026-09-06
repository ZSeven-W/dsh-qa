// QA-BL-073 bounded identity-staleness retry for the SCOPED PATH WALK (unit
// level; the real-Chrome twin lives in test/scope-identity-retry.integration.test.mjs).
//
// hub-116 (QA-BL-070) gave the TARGET_CHANGED refusal AT DISPATCH a bounded
// retry within the session settle budget and classified its exhaustion as
// INCONCLUSIVE_UNSTABLE. The SAME driver refusal can be thrown by a within
// read during the scoped path walk (observeScopeView resolving a level via
// observe({ withinRef })): the ancestor changed identity between the parent
// read and the scoped read. Before QA-BL-073 that refusal propagated into a
// hard step fail. Now the walk shares hub-116's ONE bounded retry
// implementation: only the TARGET_CHANGED code is ever retried (every other
// refusal — REF_UNKNOWN / OBSERVATION_REQUIRED / SCOPE_UNAVAILABLE / policy —
// stays a hard stop), the retry re-resolves the level from the level ABOVE
// with a fresh settled read until the level resolves or the settle budget
// (with the shared once-per-session widening) is exhausted, the refusal
// count rides the SAME targetChangedRetries counter the dispatch retry uses,
// and exhaustion classifies the step INCONCLUSIVE_UNSTABLE with a message
// naming the level — inconclusive, never fail — carrying the driver's
// changed/before/after verbatim.

import test from 'node:test'
import assert from 'node:assert/strict'
import { runScenario, validateScenario } from '../src/replay/index.ts'
import { QA_INCONCLUSIVE_UNSTABLE } from '../src/contracts.ts'

const LAUNCH = 'http://127.0.0.1:7483/'
// Bounded-retry budget generous enough that K within flips always fit even on
// a slow CI machine; the exhaustion tests use their own tighter budget.
const RETRY_SETTLE = { budgetMs: 2000, quietMs: 40, postChangeQuietMs: 80, intervalMs: 10, adaptiveBudgetMs: 0 }
const EXHAUST_SETTLE = { budgetMs: 150, quietMs: 10, postChangeQuietMs: 20, intervalMs: 5, adaptiveBudgetMs: 0 }

const DRIVER_REASON = 'the live element no longer matches the observed semantic fingerprint'
const SIDEBAR_ITEM = { role: 'navigation', tag: 'nav' }
const SCOPE = { role: 'navigation', name: 'Navbox291', path: [SIDEBAR_ITEM] }
const TARGET = { role: 'link', name: 'Qing dynasty' }

function node(ref, role, name, tag, extra = {}) {
  return { ref, role, name, tag, interactive: role === 'link', editable: false, disabled: false, ...extra }
}

/** A scoped scroll-proof step whose 1-level path walks the sidebar ancestor. */
function scopedScenario() {
  const assert_ = { kind: 'node-in-viewport', expected: TARGET, scope: SCOPE }
  return validateScenario({
    meta: { name: 'scope identity retry', description: 'd', driver: 'browser', createdAt: '2026-09-06T05:00:00.000Z' },
    target: { launch: LAUNCH },
    steps: [{
      index: 1,
      intent: 'Scroll to "Qing dynasty" inside the China navbox.',
      action: { kind: 'scroll', target: TARGET },
      assert: assert_,
    }],
    assertions: [assert_],
  })
}

const page = () => ({ url: LAUNCH, title: 'scope identity retry' })

const wholePageView = (acted) => ({
  page: page(),
  nodes: [
    node('r-side', 'navigation', 'Part of a series on the History of China: hide', 'nav', { inViewport: true }),
    node('r-fill', 'link', 'Filler', 'a', { inViewport: true }),
    node('r-status', 'status', acted ? 'SCROLLED' : 'IDLE', 'div', { inViewport: true }),
  ],
  truncated: false,
})

const sidebarView = (options) => ({
  page: page(),
  scope: { ref: options.withinRef, rootRef: 'r-side-scoped', role: 'navigation', name: 'Part of a series on the History of China: hide', tag: 'nav' },
  nodes: [
    node('r-side-scoped', 'navigation', 'Part of a series on the History of China: hide', 'nav', { inViewport: true }),
    node('r-navbox', 'navigation', 'Navbox291', 'div', { parentRef: 'r-side-scoped', inViewport: true }),
  ],
  truncated: false,
})

const containerView = (options, acted) => ({
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
})

/** A TARGET_CHANGED error exactly shaped like the driver's within refusal. */
function targetChangedError() {
  const error = new Error(DRIVER_REASON)
  error.code = 'TARGET_CHANGED'
  error.changed = ['name']
  error.before = { name: 'Sidebar one' }
  error.after = { name: 'Sidebar two' }
  return error
}

/**
 * A scoped walk whose path level 1 (within on the sidebar ref) throws the
 * given refusal flips times before succeeding (flips = Infinity throws
 * forever; a code other than TARGET_CHANGED is thrown every time).
 */
function withinFlappingAdapter({ flips = 0, code = 'TARGET_CHANGED' } = {}) {
  let acted = false
  let level1WithinCalls = 0
  return {
    adapter: {
      kind: 'browser',
      async start(_owner, options) {
        return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
      },
      async observe(_owner, options) {
        if (options?.withinRef !== undefined) {
          const ref = String(options.withinRef)
          if (ref.includes('side')) {
            level1WithinCalls += 1
            if (level1WithinCalls <= flips) {
              if (code === 'TARGET_CHANGED') throw targetChangedError()
              const error = new Error('the ref is not part of the latest observation')
              error.code = code
              throw error
            }
            return sidebarView(options)
          }
          return containerView(options, acted)
        }
        return wholePageView(acted)
      },
      async act(_owner, action) {
        if (action.kind === 'scroll') acted = true
        return { status: 'confirmed', dispatched: true }
      },
      async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
      async stop() { return { stopped: true, reason: 'requested' } },
    },
    level1WithinCalls: () => level1WithinCalls,
  }
}

/**
 * The shared-counter adapter: the path level 1 within read flaps ONCE (walk
 * retry), and the first scroll dispatch is refused TARGET_CHANGED once
 * (dispatch retry). Both refusals must land in the SAME targetChangedRetries.
 */
function walkAndDispatchAdapter() {
  let acted = false
  let dispatches = 0
  let level1WithinCalls = 0
  return {
    adapter: {
      kind: 'browser',
      async start(_owner, options) {
        return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
      },
      async observe(_owner, options) {
        if (options?.withinRef !== undefined) {
          const ref = String(options.withinRef)
          if (ref.includes('side')) {
            level1WithinCalls += 1
            if (level1WithinCalls === 1) throw targetChangedError()
            return sidebarView(options)
          }
          return containerView(options, acted)
        }
        return wholePageView(acted)
      },
      async act(_owner, action) {
        if (action.kind !== 'scroll') return { status: 'confirmed', dispatched: true }
        dispatches += 1
        if (dispatches === 1) {
          return { status: 'rejected', dispatched: false, code: 'TARGET_CHANGED', reason: DRIVER_REASON, changed: ['name'] }
        }
        acted = true
        return { status: 'confirmed', dispatched: true }
      },
      async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
      async stop() { return { stopped: true, reason: 'requested' } },
    },
    dispatches: () => dispatches,
    level1WithinCalls: () => level1WithinCalls,
  }
}

test('K within refusals then a stable level: the walk retry re-resolves from the level above and passes with targetChangedRetries: K', async () => {
  const { adapter, level1WithinCalls } = withinFlappingAdapter({ flips: 2 })
  const report = await runScenario(scopedScenario(), adapter, { ownerId: 'sw-k2', settle: RETRY_SETTLE })
  assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? {}))
  const step = report.steps[0]
  assert.equal(step.status, 'pass')
  assert.equal(step.assertionPassed, true, 'the third within read resolved and the proof passed')
  assert.equal(step.targetChangedRetries, 2, 'the walk refusals count into the SAME targetChangedRetries')
  assert.equal(step.message, undefined, 'a passed step carries no exhaustion message')
  assert.equal(step.scopeIdentityRefusal, undefined, 'a resolved level discloses no refusal')
  assert.ok(level1WithinCalls() >= 3, 'two refused reads, then the resolved one (plus the verifying walk)')
})

test('the walk retry shares ONE counter with the dispatch retry (1 walk + 1 dispatch = targetChangedRetries: 2)', async () => {
  const { adapter, dispatches, level1WithinCalls } = walkAndDispatchAdapter()
  const report = await runScenario(scopedScenario(), adapter, { ownerId: 'sw-shared', settle: RETRY_SETTLE })
  assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? {}))
  const step = report.steps[0]
  assert.equal(step.status, 'pass')
  assert.equal(step.targetChangedRetries, 2, 'one walk refusal + one dispatch refusal share the counter')
  assert.equal(dispatches(), 2, 'one refused dispatch, one landed')
  assert.ok(level1WithinCalls() >= 4, 'the walk ran once per resolution (initial + dispatch retry) plus the verifying walk')
})

test('forever-flapping within read: the exhausted budget is INCONCLUSIVE_UNSTABLE naming the level, never fail, refusal verbatim', async () => {
  const { adapter } = withinFlappingAdapter({ flips: Infinity })
  const report = await runScenario(scopedScenario(), adapter, { ownerId: 'sw-exhaust', settle: EXHAUST_SETTLE })
  assert.equal(report.status, 'inconclusive', 'the run is inconclusive, never fail: ' + JSON.stringify(report.failure ?? {}))
  assert.equal(report.failure, undefined, 'no failure record: nothing definitely failed')
  const step = report.steps[0]
  assert.equal(step.status, 'inconclusive')
  assert.equal(step.reason, QA_INCONCLUSIVE_UNSTABLE)
  assert.equal(step.assertionPassed, false)
  assert.ok(step.targetChangedRetries >= 1, 'the retry count is disclosed, got ' + step.targetChangedRetries)
  assert.match(
    step.message ?? '',
    /path level 1 \(role "navigation", tag "nav"\) kept changing identity for the whole settle budget \(\d+ retries\): the page did not hold still, so the step is unproven/,
    'the exhaustion message names the level',
  )
  assert.deepEqual(
    step.scopeIdentityRefusal,
    {
      level: 1,
      what: 'role "navigation", tag "nav"',
      code: 'TARGET_CHANGED',
      reason: DRIVER_REASON,
      changed: ['name'],
      before: { name: 'Sidebar one' },
      after: { name: 'Sidebar two' },
    },
    "the driver's changed/before/after ride verbatim on the step result",
  )
  assert.equal(report.assertions.length, 0, 'the run never re-decides final assertions on an unproven step')
})

test('the walk identity retry widens the settle budget ONCE through the shared gate (adaptive widening)', async () => {
  const { adapter } = withinFlappingAdapter({ flips: Infinity })
  const report = await runScenario(scopedScenario(), adapter, {
    ownerId: 'sw-widen',
    settle: { ...EXHAUST_SETTLE, adaptiveBudgetMs: 400 },
  })
  assert.equal(report.status, 'inconclusive')
  assert.deepEqual(
    report.settleWidened,
    { fromMs: 150, toMs: 400, at: 1, cause: 'assertion-retry' },
    'the walk retry widened through the same once-per-session gate the dispatch retry uses',
  )
  assert.equal(report.settle.budgetMs, 400, 'the widened budget was adopted for the session')
  assert.match(report.steps[0].message ?? '', /widened once from 150 to 400ms/)
  assert.ok(report.steps[0].targetChangedRetries >= 1)
})

test('classification: a REF_UNKNOWN refusal from a within read stays a hard fail with the code (never retried)', async () => {
  const { adapter } = withinFlappingAdapter({ flips: Infinity, code: 'REF_UNKNOWN' })
  const report = await runScenario(scopedScenario(), adapter, { ownerId: 'sw-refunknown', settle: RETRY_SETTLE })
  assert.equal(report.status, 'fail', 'only TARGET_CHANGED is ever retried in the walk')
  assert.equal(report.failure?.code, 'REF_UNKNOWN', 'the driver code survives into the failure')
  assert.match(report.failure?.message ?? '', /the ref is not part of the latest observation/)
  const step = report.steps[0]
  assert.equal(step.status, 'fail')
  assert.equal(step.targetChangedRetries, undefined, 'zero retries for a non-TARGET_CHANGED walk refusal')
  assert.equal(step.scopeIdentityRefusal, undefined)
})

test('an informational scope.nameChanged (content-named container) rides on the step: scopeNameChanged true, zero retries', async () => {
  // The driver reports the aggregated-name change informationally on the
  // FIRST within poll (the later settle polls re-key by rootRef and see no
  // further change, so the settled observation alone loses the flag — the
  // session settle layer must accumulate it across polls).
  let level1WithinCalls = 0
  let acted = false
  const adapter = {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe(_owner, options) {
      if (options?.withinRef !== undefined) {
        const ref = String(options.withinRef)
        if (ref.includes('side')) {
          level1WithinCalls += 1
          const view = sidebarView(options)
          if (level1WithinCalls === 1) view.scope.nameChanged = true
          return view
        }
        return containerView(options, acted)
      }
      return wholePageView(acted)
    },
    async act(_owner, action) {
      if (action.kind === 'scroll') acted = true
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
  const report = await runScenario(scopedScenario(), adapter, { ownerId: 'sw-namechanged', settle: RETRY_SETTLE })
  assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? {}))
  const step = report.steps[0]
  assert.equal(step.status, 'pass')
  assert.equal(step.scopeNameChanged, true, 'the informational name change rides on the step')
  assert.equal(step.targetChangedRetries, undefined, 'informational changes are never refusals: zero retries')
  assert.equal(step.scopeIdentityRefusal, undefined)
})
