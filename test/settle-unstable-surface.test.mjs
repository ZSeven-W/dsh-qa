import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQaTools, QaToolHost } from '../src/tools.ts'
import { QaSessionManager } from '../src/session/index.ts'
import { QaTrajectoryRecorder, RecordingQaDriverAdapter } from '../src/explore/index.ts'
import { QA_INCONCLUSIVE_UNSTABLE } from '../src/contracts.ts'

// Explore-side settle soundness. Three independent audits reproduced that the
// live Explore tools returned a false green from a view that never stopped
// changing, while the replay runner treated the identical situation as a hard
// failure. These tests drive the REAL tool surface (createQaTools / QaToolHost)
// with a synthetic churning adapter and lock the fail-closed parity.

const SETTLE = { budgetMs: 120, quietMs: 40, intervalMs: 10 }

/** Observation flips every call (title ticks), so the view never settles. */
function churningAdapter() {
  let n = 0
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? 'https://example.test/churn', title: 'churn' }, headless: true }
    },
    async observe() {
      n += 1
      return {
        fingerprint: 'fp-' + n,
        page: { url: 'https://example.test/churn', title: 'tick-' + n },
        nodes: [
          { ref: 'r1', role: 'button', name: 'Save', tag: 'button', interactive: true, editable: false, disabled: false },
        ],
        truncated: false,
      }
    },
    async act() {
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() {
      return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } }
    },
    async visualObserve() {
      return {
        driver: 'browser',
        observationFingerprint: 'fp-' + n,
        observationId: null,
        png: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        width: 1,
        height: 1,
        sha256: 'a'.repeat(64),
        usable: true,
        marks: 0,
        omitted: 0,
      }
    },
    async stop() {
      return { stopped: true, reason: 'requested' }
    },
  }
}

/** Fixed view, so settle succeeds; the tool surface must still pass normally. */
function stableAdapter() {
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? 'https://example.test/stable', title: 'stable' }, headless: true }
    },
    async observe() {
      return {
        fingerprint: 'fp-stable',
        page: { url: 'https://example.test/stable', title: 'stable' },
        nodes: [
          { ref: 'r1', role: 'button', name: 'Save', tag: 'button', interactive: true, editable: false, disabled: false },
        ],
        truncated: false,
      }
    },
    async act() {
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

async function hostWith(adapter, owner, options = {}) {
  const recorder = new QaTrajectoryRecorder()
  const manager = new QaSessionManager(new RecordingQaDriverAdapter(adapter, recorder), { settle: SETTLE })
  const host = new QaToolHost({ settle: SETTLE, ...options })
  // Inject the synthetic session manager into the REAL tool host: every tool
  // then runs the same code path a production qa_* call runs.
  host.managerFor = async () => manager
  host.managerForOwner = async () => manager
  const tools = createQaTools(host)
  await tools.qaSessionStart.execute({ owner, driver: 'browser', url: 'https://example.test/start' }, {})
  return { host, tools }
}

test('qa_assert never reports passed:true from a view that never settled', async () => {
  const { tools } = await hostWith(churningAdapter(), 'probe-assert')
  const result = await tools.qaAssert.execute(
    { owner: 'probe-assert', kind: 'node-present', expected: { role: 'button', name: 'Save' } },
    {},
  )
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.settle.stable, false, JSON.stringify(result))
  assert.equal(result.passed, false, 'an unstable view must never yield passed:true')
  assert.equal(result.inconclusive, true, JSON.stringify(result))
  assert.equal(result.code, QA_INCONCLUSIVE_UNSTABLE, JSON.stringify(result))
  assert.equal(result.observed, null, 'nothing is observed as proof from churn')
  assert.match(result.reason, /never settled within the 120ms settle budget/)
  assert.match(result.reason, /re-observe/)
})

test('qa_act keeps its receipt honest but marks the consequence unproven on an unstable view', async () => {
  const { tools } = await hostWith(churningAdapter(), 'probe-act')
  const result = await tools.qaAct.execute({ owner: 'probe-act', action: 'click', ref: 'r1' }, {})
  assert.equal(result.settle.stable, false, JSON.stringify(result))
  assert.equal(result.receipt.status, 'confirmed', 'the dispatch DID happen')
  assert.equal(result.outcome, 'ok', 'the dispatch outcome stays honest')
  assert.equal(result.proven, false, 'the consequence is NOT proven from an unstable view')
  assert.equal(result.code, QA_INCONCLUSIVE_UNSTABLE, JSON.stringify(result))
})

test('visual assertion carries settle + captureSettled marker from an unstable capture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-unstable-visual-'))
  try {
    const { tools } = await hostWith(churningAdapter(), 'probe-visual', { capturesDir: dir })
    const result = await tools.qaAssert.execute(
      { owner: 'probe-visual', kind: 'visual', question: 'Is the Save button visible?' },
      {},
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.kind, 'visual')
    assert.equal(result.settle.stable, false, 'the capture was taken from an unstable view')
    assert.equal(typeof result.settle.passes, 'number')
    assert.equal(typeof result.settle.budgetMs, 'number')
    assert.equal(result.captureSettled, false, 'the finding is marked as captured from an unstable view')
    // Advisory semantics are unchanged: the verdict is present and never affects pass/fail.
    assert.equal(result.verdict, 'unclear')
    assert.equal(result.reason, 'vision-model-unavailable')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a settled view still passes through the tool surface unchanged', async () => {
  const { tools } = await hostWith(stableAdapter(), 'probe-stable')
  const result = await tools.qaAssert.execute(
    { owner: 'probe-stable', kind: 'node-present', expected: { role: 'button', name: 'Save' } },
    {},
  )
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.settle.stable, true, JSON.stringify(result))
  assert.equal(result.passed, true, JSON.stringify(result))
  assert.equal(result.inconclusive, undefined, 'no inconclusive marker on a settled view')
  assert.equal(result.code, undefined)
})
