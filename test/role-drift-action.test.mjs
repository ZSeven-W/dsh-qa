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
import { loadScenarioFromPath, runScenario, validateScenario } from '../src/replay/index.ts'
import { renderReportMarkdown } from '../src/reporters/index.ts'
import { QaSession } from '../src/session/index.ts'
import { QA_INCONCLUSIVE_TRUNCATED, QA_INCONCLUSIVE_UNSTABLE, QA_TARGET_NOT_UNIQUE } from '../src/contracts.ts'

// QA-BL-064 role-drift ACTION-target regression (unit level; the real-Chrome
// twins live in test/role-drift-action.integration.test.mjs). The recorded
// press target's role was live when the owner pressed Enter — AFTER
// Wikipedia's Vector skin mounted its Vue typeahead over the server-rendered
// input (textbox -> combobox). A fast replay observes the PRE-swap textbox,
// so the role+name predicate matches nothing: the target is present under a
// DRIFTED role, not outside the observation window. The runner must fall back
// to a NAME-only match iff exactly one node in the deciding view carries the
// same non-empty name, disclose targetResolution, and refuse (never guess)
// when the name is empty or matches >= 2 nodes. The exporter must emit
// NAME-only action targets with the live role as an advisory roleHint.

const LAUNCH = 'http://127.0.0.1:7423/'
const SETTLE = { budgetMs: 400, quietMs: 40, postChangeQuietMs: 80, intervalMs: 5, adaptiveBudgetMs: 0 }

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

function pressScenario() {
  return validateScenario({
    meta: {
      name: 'role-drift-press',
      description: 'hand-written QA-BL-064 probe: recorded role combobox, live role textbox',
      driver: 'browser',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    target: { launch: LAUNCH },
    steps: [{
      index: 1,
      intent: 'Press Enter on "Search site".',
      action: { kind: 'press', target: { role: 'combobox', name: 'Search site' }, key: 'Enter' },
      assert: { kind: 'node-present', expected: { role: 'status', name: 'PRESSED' } },
    }],
    assertions: [{ kind: 'node-present', expected: { role: 'status', name: 'PRESSED' } }],
  })
}

/** The target exists under the DRIFTED role textbox (plus a status node). */
function textboxAdapter(truncated) {
  let pressed = false
  let value = ''
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      return {
        page: { url: LAUNCH, title: 'fixture' },
        nodes: [
          node('input', 'textbox', 'Search site', 'input', { value }),
          node('status', 'status', pressed ? 'PRESSED' : 'IDLE', 'div'),
        ],
        truncated,
      }
    },
    async act(_owner, action) {
      if (action.kind === 'press') pressed = true
      if (action.kind === 'fill') value = action.text
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

/** Two same-named nodes of different roles; no combobox exists at all. */
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
          node('tbox', 'textbox', 'Search site', 'input'),
          node('btn', 'button', 'Search site', 'button'),
          node('status', 'status', 'IDLE', 'div'),
        ],
        truncated: false,
      }
    },
    async act() { return { status: 'confirmed', dispatched: true } },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

/** The first press dispatch is refused with TARGET_CHANGED; the retry lands. */
function targetChangedOnceAdapter() {
  let pressed = false
  let attempts = 0
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      return {
        page: { url: LAUNCH, title: 'fixture' },
        nodes: [
          node('input', 'textbox', 'Search site', 'input'),
          node('status', 'status', pressed ? 'PRESSED' : 'IDLE', 'div'),
        ],
        truncated: false,
      }
    },
    async act(_owner, action) {
      if (action.kind === 'press') {
        attempts += 1
        if (attempts === 1) {
          return { status: 'rejected', dispatched: false, code: 'TARGET_CHANGED' }
        }
        pressed = true
      }
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

/** Every press dispatch is refused (TARGET_CHANGED twice, or a policy refusal). */
function rejectingAdapter(code) {
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      return {
        page: { url: LAUNCH, title: 'fixture' },
        nodes: [
          node('input', 'textbox', 'Search site', 'input'),
          node('status', 'status', 'IDLE', 'div'),
        ],
        truncated: false,
      }
    },
    async act() {
      return { status: 'rejected', dispatched: false, code }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

/** The target is genuinely absent (no node carries the accessible name). */
function absentAdapter(truncated) {
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
    },
    async observe() {
      return {
        page: { url: LAUNCH, title: 'fixture' },
        nodes: [node('status', 'status', 'IDLE', 'div')],
        truncated,
      }
    },
    async act() { return { status: 'confirmed', dispatched: true } },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

test('fallback: a role+name target with zero matches resolves NAME-only when exactly one node carries the name', async () => {
  const report = await runScenario(pressScenario(), textboxAdapter(false), {
    ownerId: 'rd-fallback',
    settle: SETTLE,
  })
  assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? {}))
  const step = report.steps[0]
  assert.equal(step.status, 'pass')
  assert.equal(step.assertionPassed, true, 'the press dispatched on the drifted textbox and its proof passed')
  assert.deepEqual(
    step.targetResolution,
    { mode: 'name-only', recordedRole: 'combobox', observedRole: 'textbox' },
    'the fallback is disclosed with the recorded and the observed role',
  )
  const md = renderReportMarkdown(report)
  assert.match(
    md,
    /target resolution: name-only \(recorded role "combobox", observed role "textbox"\)/,
    'report.md discloses the name-only resolution',
  )
})

test('fallback: the name-only match in a STILL-truncated view resolves after the one escalated read', async () => {
  const report = await runScenario(pressScenario(), textboxAdapter(true), {
    ownerId: 'rd-fallback-truncated',
    settle: SETTLE,
  })
  assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? {}))
  const step = report.steps[0]
  assert.equal(step.status, 'pass')
  assert.deepEqual(
    step.targetResolution,
    { mode: 'name-only', recordedRole: 'combobox', observedRole: 'textbox' },
    'the escalated read still lacks the combobox, and the unique name match resolves it',
  )
})

test('refusal: two same-named nodes of different roles refuse the fallback with the ambiguous-role wording', async () => {
  const report = await runScenario(pressScenario(), ambiguousAdapter(), {
    ownerId: 'rd-ambiguous',
    settle: SETTLE,
  })
  assert.equal(report.status, 'fail')
  assert.equal(report.failure?.code, QA_TARGET_NOT_UNIQUE, 'the refusal carries the machine code')
  assert.match(
    report.failure?.message ?? '',
    /present under a different role: recorded "combobox", observed "textbox", "button"/,
    'wording (a): the target is present, but under ambiguous roles',
  )
  assert.match(report.failure?.message ?? '', /name-only fallback was refused rather than guessed/)
  const step = report.steps[0]
  assert.equal(step.receipt, null, 'never a guess: no action was dispatched')
  assert.equal(step.assertionPassed, false)
})

test('zero matches in a still-truncated view fail with "absent from the returned window"', async () => {
  const report = await runScenario(pressScenario(), absentAdapter(true), {
    ownerId: 'rd-truncated-absent',
    settle: SETTLE,
  })
  assert.equal(report.status, 'fail')
  assert.match(
    report.failure?.message ?? '',
    /the target is absent from the returned window/,
    'wording (b): the view was truncated, so absence is window-relative',
  )
  assert.match(report.failure?.message ?? '', new RegExp(QA_INCONCLUSIVE_TRUNCATED))
})

test('zero matches in a complete view fail with "absent from a complete view"', async () => {
  const report = await runScenario(pressScenario(), absentAdapter(false), {
    ownerId: 'rd-complete-absent',
    settle: SETTLE,
  })
  assert.equal(report.status, 'fail')
  assert.match(
    report.failure?.message ?? '',
    /the target is absent from a complete view/,
    'wording (c): the complete view proves the absence',
  )
  assert.doesNotMatch(report.failure?.message ?? '', /truncated/, 'a complete view is never called truncated')
})

test('a TARGET_CHANGED refusal is retried within the settle budget and discloses the retry count', async () => {
  const report = await runScenario(pressScenario(), targetChangedOnceAdapter(), {
    ownerId: 'rd-target-changed-retry',
    settle: SETTLE,
  })
  assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? {}))
  const step = report.steps[0]
  assert.equal(step.status, 'pass')
  assert.equal(step.assertionPassed, true, 'the retried dispatch landed and its proof passed')
  // QA-BL-070: the boolean one-shot disclosure is now the retry COUNT (one
  // TARGET_CHANGED refusal, one bounded re-dispatch) — renamed field only.
  assert.equal(step.targetChangedRetries, 1, 'the identity-staleness retry is disclosed as a count')
  assert.deepEqual(
    step.targetResolution,
    { mode: 'name-only', recordedRole: 'combobox', observedRole: 'textbox' },
    'the retry re-resolved the same semantic target (name-only fallback again)',
  )
  const md = renderReportMarkdown(report)
  assert.match(md, /target changed retries: 1/, 'report.md discloses the retry count (renamed from the boolean targetChangedRetry, QA-BL-070)')
  assert.match(md, /the driver refused the dispatch with TARGET_CHANGED/)
})

test('a non-TARGET_CHANGED rejection stays a hard stop (never retried)', async () => {
  const report = await runScenario(pressScenario(), rejectingAdapter('DESTRUCTIVE_ACTION'), {
    ownerId: 'rd-hard-stop',
    settle: SETTLE,
  })
  assert.equal(report.status, 'fail')
  assert.match(report.failure?.message ?? '', /action receipt rejected \(DESTRUCTIVE_ACTION\)/)
  assert.equal(report.steps[0].targetChangedRetries, undefined, 'only TARGET_CHANGED is ever retried (renamed field, QA-BL-070)')
  assert.equal(report.steps[0].receipt.status, 'rejected')
})

test('a target that keeps changing identity exhausts the settle budget: INCONCLUSIVE_UNSTABLE, never fail', async () => {
  const report = await runScenario(pressScenario(), rejectingAdapter('TARGET_CHANGED'), {
    ownerId: 'rd-target-changed-twice',
    settle: SETTLE,
  })
  // QA-BL-070: identity staleness is now retried WITHIN the settle budget
  // (not once); exhausting the budget with the target still changing means
  // the page did not hold still — the step is unproven, so the run is
  // INCONCLUSIVE, never a failure. (SETTLE.adaptiveBudgetMs is 0, so the
  // once-per-session widening is a no-op here, exactly like assertions.)
  assert.equal(report.status, 'inconclusive')
  assert.equal(report.failure, undefined, 'nothing definitely failed')
  const step = report.steps[0]
  assert.equal(step.status, 'inconclusive')
  assert.equal(step.reason, QA_INCONCLUSIVE_UNSTABLE)
  assert.equal(step.assertionPassed, false)
  assert.ok(step.targetChangedRetries >= 1, 'the retry count is disclosed even on exhaustion')
  assert.equal(step.receipt.code, 'TARGET_CHANGED', 'the last refusal rides verbatim')
  assert.match(
    step.message ?? '',
    /the target kept changing identity between resolution and dispatch for the whole settle budget \(\d+ retries\): the page did not hold still, so the step is unproven/,
  )
})

test('export: a role-drift action target exports NAME-only with the live role as roleHint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-rd-export-'))
  try {
    const switchAfterMs = 600
    let filledAt = null
    const adapter = {
      kind: 'browser',
      async start(_owner, options) {
        return { page: { url: options?.url ?? LAUNCH, title: 'fixture' }, headless: true }
      },
      async observe() {
        const switched = filledAt !== null && Date.now() - filledAt >= switchAfterMs
        const input = node('input', switched ? 'combobox' : 'textbox', 'Search site', 'input', {
          value: filledAt === null ? '' : 'DeepSeek',
        })
        const nodes = [input]
        if (switched) {
          nodes.push(node('opt', 'option', 'DeepSeek', 'li', { interactive: true, editable: false }))
          nodes.push(node('list', 'listbox', 'Suggestions', 'ul', { interactive: false, editable: false }))
        }
        return { page: { url: LAUNCH, title: 'fixture' }, nodes, truncated: true }
      },
      async act(_owner, action) {
        if (action.kind === 'fill') filledAt = Date.now()
        return { status: 'confirmed', dispatched: true }
      },
      async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
      async stop() { return { stopped: true, reason: 'requested' } },
    }
    const recorder = new QaTrajectoryRecorder()
    const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'rd-export', {
      settle: { budgetMs: 1500, quietMs: 50, postChangeQuietMs: 100, intervalMs: 10 },
    })
    await session.start({ url: LAUNCH })
    const before = await session.observeSettled()
    const input = before.observation.nodes.find((item) => item.name === 'Search site')
    assert.ok(input, 'the fixture must expose the search input')
    await session.act({ kind: 'fill', ref: input.ref, text: 'DeepSeek' })
    await session.stop()
    const outputPath = join(dir, 'role-drift-export.json')
    const exported = await exportRecordedScenario(recorder, 'rd-export', { outputPath })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.excludedActions.length, 0, JSON.stringify(exported.excludedActions))
    const step = exported.scenario.steps[0]
    assert.equal(step.action.kind, 'fill')
    assert.deepEqual(
      step.action.target,
      { name: 'Search site', roleHint: 'textbox' },
      'the action target is NAME-only; the live baseline role rides as an advisory roleHint',
    )
    // QA-BL-039 already covers the drifted node-value assertion; the loader
    // must accept roleHint and round-trip it losslessly.
    const loaded = loadScenarioFromPath(outputPath)
    assert.deepEqual(loaded, exported.scenario, 'roleHint survives the fail-closed loader')
    // The name-only target replays against BOTH sides of the drift.
    const preSwap = await runScenario(exported.scenario, textboxAdapter(false), {
      ownerId: 'rd-export-replay-preswap',
      settle: SETTLE,
    })
    assert.equal(preSwap.status, 'pass', JSON.stringify(preSwap.failure ?? {}))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
