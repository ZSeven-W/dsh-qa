import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exportRecordedScenario,
  RecordingQaDriverAdapter,
} from '../src/explore/index.ts'
import { runScenario } from '../src/replay/index.ts'
import { QaSessionManager } from '../src/session/index.ts'
import { createQaTools, QaToolHost } from '../src/tools.ts'
import { QA_SCOPE_NOT_DURABLE } from '../src/contracts.ts'

// QA-BL-066 unit suite: qa_assert within_ref over the cordis tool layer and
// the Explore recorder/export final-assertion path, with synthetic adapters
// (the real-Chrome twin lives in test/qa-assert-within-ref.integration.test.mjs).

const LAUNCH = 'http://127.0.0.1:7467/'
const SETTLE = { budgetMs: 400, quietMs: 30, intervalMs: 5 }

function node(ref, role, name, tag, extra = {}) {
  return {
    ref,
    role,
    name,
    tag,
    interactive: role === 'button' || role === 'link',
    editable: false,
    disabled: false,
    ...extra,
  }
}

const CONTAINER_SCOPE = { ref: 'br-clean', rootRef: 'br-clean', role: 'region', name: 'Clean container', tag: 'div' }

/** Synthetic browser adapter with a clean container and a whole-page twin of the target link. */
function scopedToolAdapter() {
  const calls = []
  return {
    calls,
    adapter: {
      kind: 'browser',
      async start() { return { page: { url: LAUNCH, title: 'assert fixture' }, headless: true } },
      async observe(_owner, options) {
        calls.push(options ?? {})
        if (options?.withinRef === 'br-stale') {
          const error = new Error('the ref is not part of the latest observation')
          error.code = 'REF_UNKNOWN'
          throw error
        }
        if (options?.withinRef !== undefined) {
          return {
            page: { url: LAUNCH, title: 'assert fixture' },
            scope: CONTAINER_SCOPE,
            nodes: [
              node('br-clean', 'region', 'Clean container', 'div'),
              node('br-btn', 'button', 'Trigger check', 'button'),
              node('br-b', 'button', 'clean-1', 'button'),
            ],
            truncated: false,
            ...(options.verifyCoverage === true
              ? { coverage: { verified: true, closedShadowRoots: 0, probedNodes: 3 } }
              : {}),
          }
        }
        return {
          page: { url: LAUNCH, title: 'assert fixture' },
          nodes: [
            node('br-clean', 'region', 'Clean container', 'div'),
            node('br-deep', 'link', 'Deep scoped target', 'a'),
            node('br-btn', 'button', 'Trigger check', 'button'),
          ],
          truncated: false,
        }
      },
      async act() { return { status: 'confirmed', dispatched: true } },
      async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
      async stop() { return { stopped: true, reason: 'requested' } },
    },
  }
}

async function toolHostWith(adapter) {
  const host = new QaToolHost({ settle: SETTLE })
  const manager = new QaSessionManager(new RecordingQaDriverAdapter(adapter, host.recorder), { settle: SETTLE })
  host.managerFor = async () => manager
  host.managerForOwner = async () => manager
  const tools = createQaTools(host)
  await tools.qaSessionStart.execute({ owner: 'within-ref-unit', driver: 'browser', url: LAUNCH }, {})
  return { host, tools }
}

test('the qa_assert schema advertises an optional within_ref string', () => {
  const tools = createQaTools(new QaToolHost())
  const parameters = tools.qaAssert.parameters
  assert.ok(parameters.properties && 'within_ref' in parameters.properties, JSON.stringify(parameters.properties))
  assert.deepEqual(parameters.properties.within_ref, { type: 'string' })
  assert.deepEqual(parameters.required, ['kind'], 'within_ref must stay optional: ' + JSON.stringify(parameters.required))
})

test('qa_assert within_ref decides inside the container: scoped pass with scope named and coverage verified', async () => {
  const { calls, adapter } = scopedToolAdapter()
  const { host, tools } = await toolHostWith(adapter)
  try {
    const result = await tools.qaAssert.execute(
      { owner: 'within-ref-unit', kind: 'node-absent', expected: { role: 'link', name: 'Deep scoped target' }, within_ref: 'br-clean' },
      { agent: { id: 'within-ref-unit-agent' } },
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.passed, true, JSON.stringify(result))
    assert.deepEqual(result.completeness.scope, { role: 'region', name: 'Clean container' }, JSON.stringify(result.completeness))
    assert.equal(result.completeness.truncated, false)
    assert.equal(result.completeness.coverage.verified, true)
    assert.match(result.completeness.detail, /within the region named "Clean container"/)
    assert.match(result.completeness.detail, /coverage verified/)
    // The FIRST poll used the passed within ref, and the terminal absence
    // read escalated INSIDE the scope and requested the coverage probe.
    assert.equal(calls[0].withinRef, 'br-clean', JSON.stringify(calls[0]))
    assert.ok(
      calls.some((call) => call.withinRef === 'br-clean' && call.verifyCoverage === true),
      JSON.stringify(calls),
    )
    assert.ok(calls.every((call) => call.withinRef !== undefined), 'every read must stay inside the scope: ' + JSON.stringify(calls))
  } finally {
    await host.dispose()
  }
})

test('a driver refusal on within_ref surfaces as itself — never a whole-page decision', async () => {
  const { calls, adapter } = scopedToolAdapter()
  const { host, tools } = await toolHostWith(adapter)
  try {
    const result = await tools.qaAssert.execute(
      { owner: 'within-ref-unit', kind: 'node-absent', expected: { role: 'link', name: 'Deep scoped target' }, within_ref: 'br-stale' },
      { agent: { id: 'within-ref-unit-agent' } },
    )
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'REF_UNKNOWN', JSON.stringify(result))
    assert.match(result.error, /latest observation/)
    // Exactly one read was attempted, and it was the scoped one: the refusal
    // never degraded into a whole-page observation.
    assert.equal(calls.length, 1, JSON.stringify(calls))
    assert.equal(calls[0].withinRef, 'br-stale', JSON.stringify(calls[0]))
  } finally {
    await host.dispose()
  }
})

test('without within_ref the decision stays whole-page: no scoped read, no scope in the result', async () => {
  const { calls, adapter } = scopedToolAdapter()
  const { host, tools } = await toolHostWith(adapter)
  try {
    const result = await tools.qaAssert.execute(
      { owner: 'within-ref-unit', kind: 'node-absent', expected: { role: 'link', name: 'Deep scoped target' } },
      { agent: { id: 'within-ref-unit-agent' } },
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.passed, false, 'the target exists on the whole page')
    assert.deepEqual(result.observed, { role: 'link', name: 'Deep scoped target', tag: 'a' })
    assert.equal('scope' in (result.completeness ?? {}), false, JSON.stringify(result.completeness))
    assert.ok(calls.length > 0)
    assert.ok(calls.every((call) => call.withinRef === undefined), 'no read may be scoped: ' + JSON.stringify(calls))
  } finally {
    await host.dispose()
  }
})

test('kind visual refuses within_ref instead of silently ignoring it', async () => {
  const { adapter } = scopedToolAdapter()
  const { host, tools } = await toolHostWith(adapter)
  try {
    const result = await tools.qaAssert.execute(
      { owner: 'within-ref-unit', kind: 'visual', question: 'is it there?', within_ref: 'br-clean' },
      { agent: { id: 'within-ref-unit-agent' } },
    )
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.match(result.error, /within_ref/)
  } finally {
    await host.dispose()
  }
})

// ---------------------------------------------------------------------------
// Recorder/export: a scoped qa_assert binds its deciding observation exactly
// like an unscoped one, and the exported final assertion carries the scope
// through the existing withProofScope path (QA-BL-054 durability gate intact).
// ---------------------------------------------------------------------------

function loopAdapter({ twinContainers = false } = {}) {
  let clicked = false
  return {
    kind: 'browser',
    async start(_owner, options) { return { page: { url: options?.url ?? LAUNCH, title: 'assert fixture' }, headless: true } },
    async observe(_owner, options) {
      if (options?.withinRef !== undefined) {
        return {
          page: { url: LAUNCH, title: 'assert fixture' },
          scope: CONTAINER_SCOPE,
          nodes: [
            node('br-clean', 'region', 'Clean container', 'div'),
            node('br-btn', 'button', 'Trigger check', 'button'),
            node('br-b', 'button', 'clean-1', 'button'),
          ],
          truncated: false,
          ...(options.verifyCoverage === true
            ? { coverage: { verified: true, closedShadowRoots: 0, probedNodes: 3 } }
            : {}),
        }
      }
      return {
        page: { url: LAUNCH, title: 'assert fixture' },
        nodes: [
          node('br-clean', 'region', 'Clean container', 'div'),
          ...(twinContainers ? [node('br-clean-twin', 'region', 'Clean container', 'div')] : []),
          node('br-btn', 'button', 'Trigger check', 'button'),
          node('br-status', 'status', clicked ? 'PASS' : 'IDLE', 'div'),
        ],
        truncated: false,
      }
    },
    async act(_owner, action) {
      if (action.kind === 'click') clicked = true
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

async function exploreClickAndScopedAssert(adapter, outputPath) {
  const host = new QaToolHost({ settle: SETTLE })
  const manager = new QaSessionManager(new RecordingQaDriverAdapter(adapter, host.recorder), { settle: SETTLE })
  host.managerFor = async () => manager
  host.managerForOwner = async () => manager
  const tools = createQaTools(host)
  const owner = 'within-ref-export'
  await tools.qaSessionStart.execute({ owner, driver: 'browser', url: LAUNCH }, {})
  const observed = await tools.qaObserve.execute({ owner }, {})
  const trigger = observed.nodes.find((item) => item.name === 'Trigger check')
  assert.ok(trigger, JSON.stringify(observed.nodes.map((item) => item.name)))
  await tools.qaAct.execute({ owner, action: 'click', ref: trigger.ref }, {})
  const asserted = await tools.qaAssert.execute(
    { owner, kind: 'node-absent', expected: { role: 'link', name: 'Deep scoped target' }, within_ref: 'br-clean' },
    {},
  )
  assert.equal(asserted.ok, true, JSON.stringify(asserted))
  assert.equal(asserted.passed, true, JSON.stringify(asserted))
  const exported = await exportRecordedScenario(host.recorder, owner, { outputPath })
  await host.dispose()
  return exported
}

test('a scoped qa_assert on a container unique in a COMPLETE baseline exports as a scoped assertion and replays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-assert-export-'))
  try {
    const exported = await exploreClickAndScopedAssert(loopAdapter(), join(dir, 'scoped-assert.json'))
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.scenario.steps.length, 1, JSON.stringify(exported.scenario.steps))
    assert.equal(exported.excludedAssertions.length, 0, JSON.stringify(exported.excludedAssertions))
    const scoped = exported.scenario.assertions.find((item) => item.kind === 'node-absent')
    assert.ok(scoped, JSON.stringify(exported.scenario.assertions))
    assert.deepEqual(scoped.scope, { role: 'region', name: 'Clean container' }, JSON.stringify(scoped))
    assert.deepEqual(scoped.expected, { role: 'link', name: 'Deep scoped target' })

    const report = await runScenario(exported.scenario, loopAdapter(), { ownerId: 'assert-export-replay', settle: SETTLE })
    assert.equal(report.status, 'pass', JSON.stringify(report.failure))
    const replayed = report.assertions.find((item) => item.kind === 'node-absent')
    assert.equal(replayed.passed, true, JSON.stringify(replayed))
    assert.equal(replayed.scopeResolution, 'proven', JSON.stringify(replayed))
    assert.deepEqual(replayed.scope, { role: 'region', name: 'Clean container' })
    assert.equal(replayed.completeness.scope.name, 'Clean container')
    assert.equal(replayed.completeness.coverage.verified, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a scoped qa_assert whose container is ambiguous in the baseline is excluded with SCOPE_NOT_DURABLE, never dropped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-assert-export-twin-'))
  try {
    const exported = await exploreClickAndScopedAssert(loopAdapter({ twinContainers: true }), join(dir, 'twin.json'))
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.excludedAssertions.length, 1, JSON.stringify(exported.excludedAssertions))
    assert.equal(exported.excludedAssertions[0].reason, QA_SCOPE_NOT_DURABLE, JSON.stringify(exported.excludedAssertions[0]))
    assert.match(exported.excludedAssertions[0].detail, /matches 2 nodes in the recorded baseline observation/)
    // The scope was never silently dropped into an unscoped assertion: the
    // fallback final assertion is the last step's own (unscoped) proof.
    assert.ok(
      exported.scenario.assertions.every((item) => item.scope === undefined),
      JSON.stringify(exported.scenario.assertions),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
