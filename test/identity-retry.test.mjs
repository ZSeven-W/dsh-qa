import test from 'node:test'
import assert from 'node:assert/strict'
import { runScenario, validateScenario } from '../src/replay/index.ts'
import { QA_INCONCLUSIVE_UNSTABLE, QA_TARGET_NOT_UNIQUE } from '../src/contracts.ts'

// QA-BL-070 bounded identity-staleness retry (unit level; the real-Chrome
// twins live in test/identity-retry.integration.test.mjs). A TARGET_CHANGED
// refusal means the page replaced the bound element between resolution and
// dispatch — nothing was dispatched and nothing about the scenario's claim
// definitely failed: the page mutated under the runner. The runner must retry
// the resolve->dispatch pair WITHIN the session settle budget (re-using the
// QA-BL-039/041 bounded-retry / widenForRetry machinery — adaptive widening
// ONCE through the shared gate), disclose targetChangedRetries: N on the
// step, and — when the budget is exhausted with the target still changing
// identity — classify the step INCONCLUSIVE_UNSTABLE (inconclusive, never a
// failure). Every policy/safety refusal, TARGET_NOT_UNIQUE, and a target
// absent from a COMPLETE view stay definite failures with ZERO retries.

const LAUNCH = 'http://127.0.0.1:7425/'
// Bounded-retry budget generous enough that K dispatch flips always fit even
// on a slow CI machine; the exhaustion tests use their own tighter budget.
const RETRY_SETTLE = { budgetMs: 1500, quietMs: 40, postChangeQuietMs: 80, intervalMs: 10, adaptiveBudgetMs: 0 }
const EXHAUST_SETTLE = { budgetMs: 150, quietMs: 10, postChangeQuietMs: 20, intervalMs: 5, adaptiveBudgetMs: 0 }

const DRIVER_REASON = 'the live element no longer matches the observed semantic fingerprint'

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

function linkScenario() {
  return validateScenario({
    meta: {
      name: 'identity-flip-click',
      description: 'hand-written QA-BL-070 probe: the target link flips its fingerprint per dispatch',
      driver: 'browser',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    target: { launch: LAUNCH },
    steps: [{
      index: 1,
      intent: 'Click "History of China".',
      action: { kind: 'click', target: { role: 'link', name: 'History of China' } },
      assert: { kind: 'node-present', expected: { role: 'status', name: 'CLICKED' } },
    }],
    assertions: [{ kind: 'node-present', expected: { role: 'status', name: 'CLICKED' } }],
  })
}

/**
 * The first `flips` click dispatches are refused with TARGET_CHANGED (the
 * driver's verbatim reason plus an additive `changed` field naming WHAT
 * changed); later dispatches land and flip the status node.
 */
function flippingAdapter(flips) {
  let clicked = false
  let attempts = 0
  return {
    kind: 'browser',
    calls: { acts: () => attempts },
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      return {
        page: { url: LAUNCH, title: 'fixture' },
        nodes: [
          node('link', 'link', 'History of China', 'a'),
          node('status', 'status', clicked ? 'CLICKED' : 'IDLE', 'div'),
        ],
        truncated: false,
      }
    },
    async act(_owner, action) {
      if (action.kind !== 'click') return { status: 'confirmed', dispatched: true }
      attempts += 1
      if (attempts <= flips) {
        return {
          status: 'rejected',
          dispatched: false,
          code: 'TARGET_CHANGED',
          reason: DRIVER_REASON,
          changed: 'aria-disabled false->true',
        }
      }
      clicked = true
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

/** Every dispatch is refused with the given receipt (policy or staleness). */
function rejectingAdapter(receipt) {
  let attempts = 0
  return {
    kind: 'browser',
    calls: { acts: () => attempts },
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      return {
        page: { url: LAUNCH, title: 'fixture' },
        nodes: [
          node('link', 'link', 'History of China', 'a'),
          node('status', 'status', 'IDLE', 'div'),
        ],
        truncated: false,
      }
    },
    async act(_owner, action) {
      if (action.kind !== 'click') return { status: 'confirmed', dispatched: true }
      attempts += 1
      return { dispatched: false, ...receipt }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

const TARGET_CHANGED_RECEIPT = { status: 'rejected', code: 'TARGET_CHANGED', reason: DRIVER_REASON, changed: 'aria-disabled false->true' }
const POLICY_RECEIPT = { status: 'rejected', code: 'DESTRUCTIVE_ACTION', reason: 'the action was refused by policy' }

/** Two same-named links of different roles: the resolve itself refuses. */
function ambiguousAdapter() {
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      return {
        page: { url: LAUNCH, title: 'fixture' },
        nodes: [
          // Neither carries the recorded 'link' role, and BOTH carry the
          // name: the strict match fails and the name-only fallback refuses
          // with TARGET_NOT_UNIQUE before any dispatch.
          node('l1', 'button', 'History of China', 'a'),
          node('l2', 'menuitem', 'History of China', 'button'),
        ],
        truncated: false,
      }
    },
    async act() { return { status: 'confirmed', dispatched: true } },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

/** The target is genuinely absent; truncated decides the failure wording. */
function absentAdapter(truncated) {
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      return { page: { url: LAUNCH, title: 'fixture' }, nodes: [node('s', 'status', 'IDLE', 'div')], truncated }
    },
    async act() { return { status: 'confirmed', dispatched: true } },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

test('K flips then holds still: the bounded retry re-resolves and passes with targetChangedRetries: K', async () => {
  const adapter = flippingAdapter(2)
  const report = await runScenario(linkScenario(), adapter, {
    ownerId: 'ir-k2',
    settle: RETRY_SETTLE,
  })
  assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? {}))
  const step = report.steps[0]
  assert.equal(step.status, 'pass')
  assert.equal(step.assertionPassed, true, 'the third dispatch landed and its proof passed')
  assert.equal(step.targetChangedRetries, 2, 'both identity-staleness refusals are disclosed')
  assert.equal(adapter.calls.acts(), 3, 'two refused dispatches, one landed')
  assert.equal(step.message, undefined, 'a passed step carries no exhaustion message')
})

test('a single flip still discloses targetChangedRetries: 1', async () => {
  const adapter = flippingAdapter(1)
  const report = await runScenario(linkScenario(), adapter, {
    ownerId: 'ir-k1',
    settle: RETRY_SETTLE,
  })
  assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? {}))
  assert.equal(report.steps[0].targetChangedRetries, 1)
})

test('budget exhaustion on identity staleness: INCONCLUSIVE_UNSTABLE, never fail, refusal detail verbatim', async () => {
  const adapter = rejectingAdapter(TARGET_CHANGED_RECEIPT)
  const report = await runScenario(linkScenario(), adapter, {
    ownerId: 'ir-exhaust',
    settle: EXHAUST_SETTLE,
  })
  assert.equal(report.status, 'inconclusive', 'the run is inconclusive, never fail: ' + JSON.stringify(report.failure ?? {}))
  assert.equal(report.failure, undefined, 'no failure record: nothing definitely failed')
  const step = report.steps[0]
  assert.equal(step.status, 'inconclusive')
  assert.equal(step.reason, QA_INCONCLUSIVE_UNSTABLE)
  assert.equal(step.assertionPassed, false)
  assert.ok(step.targetChangedRetries >= 1, 'the retry count is disclosed, got ' + step.targetChangedRetries)
  assert.equal(adapter.calls.acts(), step.targetChangedRetries, 'every dispatch failed with TARGET_CHANGED')
  assert.match(
    step.message ?? '',
    /the target kept changing identity between resolution and dispatch for the whole settle budget \(\d+ retries\): the page did not hold still, so the step is unproven/,
  )
  // The driver's refusal detail rides verbatim so triage sees WHAT changed.
  assert.equal(step.receipt.code, 'TARGET_CHANGED')
  assert.equal(step.receipt.reason, DRIVER_REASON)
  assert.equal(step.receipt.changed, 'aria-disabled false->true', 'the additive driver field survives verbatim')
  assert.equal(report.assertions.length, 0, 'the run never re-decides final assertions on an unproven step')
})

test('the identity retry widens the settle budget ONCE through the shared gate (adaptive widening)', async () => {
  const adapter = rejectingAdapter(TARGET_CHANGED_RECEIPT)
  const report = await runScenario(linkScenario(), adapter, {
    ownerId: 'ir-widen',
    settle: { ...EXHAUST_SETTLE, adaptiveBudgetMs: 400 },
  })
  assert.equal(report.status, 'inconclusive')
  assert.deepEqual(
    report.settleWidened,
    { fromMs: 150, toMs: 400, at: 1, cause: 'assertion-retry' },
    'the retry widened through the same once-per-session gate assertions use',
  )
  assert.equal(report.settle.budgetMs, 400, 'the widened budget was adopted for the session')
  assert.match(report.steps[0].message ?? '', /widened once from 150 to 400ms/)
  assert.ok(report.steps[0].targetChangedRetries >= 1)
})

test('the identity retry shares the once-per-session gate: a prior unstable widen leaves no second widening', async () => {
  const startedAt = Date.now()
  let polls = 0
  const adapter = {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      // Churn for the first 200ms — alternating the link name per poll so the
      // projection really changes (the unstable settle path widens the budget
      // and consumes the shared gate), then hold still.
      polls += 1
      const churning = Date.now() - startedAt < 200
      const name = churning && polls % 2 === 0 ? 'History of China!' : 'History of China'
      return {
        page: { url: LAUNCH, title: 'fixture' },
        nodes: [
          node('link', 'link', name, 'a'),
          node('status', 'status', 'IDLE', 'div'),
        ],
        truncated: false,
      }
    },
    async act(_owner, action) {
      if (action.kind !== 'click') return { status: 'confirmed', dispatched: true }
      return { status: 'rejected', dispatched: false, code: 'TARGET_CHANGED', reason: DRIVER_REASON }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
  const report = await runScenario(linkScenario(), adapter, {
    ownerId: 'ir-shared-gate',
    settle: { ...EXHAUST_SETTLE, adaptiveBudgetMs: 400 },
  })
  assert.equal(report.status, 'inconclusive', JSON.stringify(report.failure ?? {}))
  assert.deepEqual(
    report.settleWidened,
    { fromMs: 150, toMs: 400, at: 'initial', cause: 'unstable' },
    'the ONLY widening came from the unstable initial settle — the gate is shared',
  )
  assert.doesNotMatch(report.steps[0].message ?? '', /widened once/, 'the identity retry could not widen a second time')
})

test('classification: a policy/safety refusal is a hard fail with ZERO retries', async () => {
  const adapter = rejectingAdapter(POLICY_RECEIPT)
  const report = await runScenario(linkScenario(), adapter, {
    ownerId: 'ir-policy',
    settle: RETRY_SETTLE,
  })
  assert.equal(report.status, 'fail')
  assert.match(report.failure?.message ?? '', /action receipt rejected \(DESTRUCTIVE_ACTION\)/)
  const step = report.steps[0]
  assert.equal(step.status, 'fail')
  assert.equal(step.targetChangedRetries, undefined, 'only TARGET_CHANGED is ever retried')
  assert.equal(adapter.calls.acts(), 1, 'zero retries')
  assert.equal(step.receipt.code, 'DESTRUCTIVE_ACTION')
  assert.equal(step.receipt.reason, 'the action was refused by policy', 'the refusal detail rides verbatim')
})

test('classification: TARGET_NOT_UNIQUE stays a hard fail (never retried)', async () => {
  const report = await runScenario(linkScenario(), ambiguousAdapter(), {
    ownerId: 'ir-ambiguous',
    settle: RETRY_SETTLE,
  })
  assert.equal(report.status, 'fail')
  assert.equal(report.failure?.code, QA_TARGET_NOT_UNIQUE)
  assert.equal(report.steps[0].targetChangedRetries, undefined)
  assert.equal(report.steps[0].receipt, null, 'the resolve refused before any dispatch')
})

test('classification: a target absent from a COMPLETE view stays a hard fail (never retried)', async () => {
  const report = await runScenario(linkScenario(), absentAdapter(false), {
    ownerId: 'ir-absent-complete',
    settle: RETRY_SETTLE,
  })
  assert.equal(report.status, 'fail')
  assert.match(report.failure?.message ?? '', /the target is absent from a complete view/)
  assert.equal(report.steps[0].targetChangedRetries, undefined)
})
