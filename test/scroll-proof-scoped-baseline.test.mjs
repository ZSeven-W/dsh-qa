// QA-BL-067: actions taken from a SCOPED baseline take their proof settle
// INSIDE the baseline's own container (the settle loop re-keys the within ref
// per poll to the driver's fresh scope.rootRef), and the acceptance is decided
// by the driver's identity anchor — never by matching role/name/tag. The
// accepted proof is the settled SCOPED observation, surfaced as
// proofScope: { role, name } plus anchor on the act result (NO escalation
// happened, so there is no proofEscalated), and the recorder binds it as the
// action's proof through the ordinary settle binding so export carries the
// scope (withProofScope, QA-BL-054/062 rules unchanged).
//
// Verified against the REAL driver (contract v9, dsh-browser a17727a): a
// dispatched browser action consumes the ENTIRE latest observation — every
// ref it minted, including the scope rootRef — so the baseline root no longer
// resolves immediately after the action (OBSERVATION_REQUIRED, pinned by
// test/explore-scroll-scoped-baseline.integration.test.mjs). The session core
// therefore ATTEMPTS the scoped proof settle and, when the driver refuses the
// root, DISCLOSES the fallback (reason 'container-not-in-view' plus the
// driver's code) and takes today's whole-page proof read instead. Every
// non-acceptance exit is disclosed through escalationRefused with the fixed
// vocabulary (QA-BL-067 completes QA-BL-058): target-not-in-baseline,
// container-not-in-view, escalated-window-unstable, target-not-returned,
// target-not-in-viewport, anchor-not-connected, anchor-not-contained,
// anchor-unavailable, plus the driver's code when it threw. An escalation
// refusal supersedes the scoped-proof refusal (the more terminal truth); an
// accepted escalation supersedes both (the proof succeeded).

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
import { QaSession } from '../src/session/index.ts'
import { QA_ESCALATED_NODE_BUDGET } from '../src/replay/index.ts'

const LAUNCH = 'http://127.0.0.1:7457/'
const SETTLE = { budgetMs: 400, quietMs: 40, intervalMs: 5 }

function node(ref, role, name, tag, extra = {}) {
  return {
    ref,
    role,
    name,
    tag,
    interactive: role === 'link',
    editable: false,
    disabled: false,
    ...extra,
  }
}

const TARGET = { role: 'link', name: 'Deep Target' }
const CONTAINER = { role: 'region', name: 'Deep zone' }
const targetOffViewport = (ref, parentRef) => node(ref, TARGET.role, TARGET.name, 'a', { inViewport: false, parentRef })
const targetInViewport = (ref) => node(ref, TARGET.role, TARGET.name, 'a', { inViewport: true })
const container = (ref) => node(ref, CONTAINER.role, CONTAINER.name, 'section', { interactive: false, inViewport: true })
const outerFiller = () => node('n-outer', 'link', 'Outer 01', 'a', { inViewport: true })

/** The SCOPED baseline the acted ref came from (scope.rootRef chains the proof settle). */
function scopedBaseline() {
  return {
    page: { url: LAUNCH, title: 'scoped baseline fixture' },
    nodes: [container('n-zone-before'), targetOffViewport('n-target', 'n-zone-before')],
    truncated: false,
    scope: { ref: 'n-zone-before', rootRef: 'n-zone-before', role: CONTAINER.role, name: CONTAINER.name, tag: 'section' },
  }
}

function wholePage(nodes, truncated) {
  return { page: { url: LAUNCH, title: 'scoped baseline fixture' }, nodes, truncated }
}

/**
 * Fake browser adapter modelling a scoped baseline whose post-action polls
 * behave per option:
 *  - scopedThrows { code, message }: the driver REFUSES the scoped proof root
 *    (the verified real-driver behaviour after a dispatched action);
 *  - postScoped: the scoped post-action view (scope.rootRef re-minted per poll
 *    exactly like the driver); its anchor rides verbatim;
 *  - after: the whole-page post-action view for whole-page polls;
 *  - wholeEscalated: the ONE whole-page escalated read (maxNodes === budget).
 * Every observe call is recorded in calls.
 */
function scopedBaselineAdapter({ before, after, postScoped = null, scopedThrows = null, wholeEscalated = null } = {}) {
  let acted = false
  let escalationWindows = 0
  let lastWasEscalated = false
  let scopedPoll = 0
  const calls = []
  return {
    adapter: {
      kind: 'browser',
      async start(_owner, startOptions) {
        return { page: { url: startOptions?.url ?? LAUNCH, title: 'scoped baseline fixture' }, headless: true }
      },
      async observe(_owner, observeOptions) {
        const escalatedCall = observeOptions?.maxNodes === QA_ESCALATED_NODE_BUDGET
        if (escalatedCall) {
          if (!lastWasEscalated) {
            escalationWindows += 1
            scopedPoll = 0
          }
          scopedPoll += 1
        }
        lastWasEscalated = escalatedCall
        if (acted) {
          calls.push({
            withinRef: observeOptions?.withinRef,
            anchorLastAction: observeOptions?.anchorLastAction,
            maxNodes: observeOptions?.maxNodes,
          })
        }
        if (!acted) return before
        if (escalatedCall) {
          return wholeEscalated ?? after
        }
        if (observeOptions?.withinRef !== undefined) {
          if (scopedThrows !== null) {
            const error = new Error(scopedThrows.message)
            error.name = 'DriverIssue'
            error.code = scopedThrows.code
            throw error
          }
          return {
            ...postScoped,
            scope: {
              ref: observeOptions.withinRef,
              rootRef: 'n-zone-es-' + String(calls.length),
              role: CONTAINER.role,
              name: CONTAINER.name,
              tag: 'section',
            },
          }
        }
        return after
      },
      async act(_owner, action) {
        if (action.kind === 'scroll') acted = true
        return { status: 'confirmed', dispatched: true }
      },
      async evidence() {
        return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } }
      },
      async stop() {
        return { stopped: true, reason: 'requested' }
      },
    },
    escalationWindows: () => escalationWindows,
    calls: () => calls,
  }
}

async function exploreScopedBaseline(options) {
  const { adapter, escalationWindows, calls } = scopedBaselineAdapter(options)
  const recorder = new QaTrajectoryRecorder()
  const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'scoped-baseline', { settle: SETTLE })
  await session.start({ url: LAUNCH })
  const before = await session.observeSettled()
  const targetNode = before.observation.nodes.find(
    (item) => item.role === TARGET.role && item.name === TARGET.name,
  )
  assert.ok(targetNode, 'the scoped baseline must expose the scroll target')
  const acted = await session.act({ kind: 'scroll', ref: targetNode.ref })
  await session.stop()
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scoped-baseline-'))
  try {
    const exported = await exportRecordedScenario(recorder, 'scoped-baseline', {
      outputPath: join(dir, 'scoped-baseline.json'),
    })
    return { acted, exported, escalationWindows: escalationWindows(), calls: calls() }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const ACCEPTED_POST_SCOPED = {
  page: { url: LAUNCH, title: 'scoped baseline fixture' },
  nodes: [container('n-zone-es'), targetInViewport('n-target-es')],
  truncated: false,
  anchor: { ref: 'n-target-es', connected: true, contained: true },
}

test('QA-BL-067: an accepted scoped proof settle surfaces proofScope + anchor, never proofEscalated', async () => {
  const before = scopedBaseline()
  const after = wholePage([outerFiller()], true)
  const { acted, exported, escalationWindows, calls } = await exploreScopedBaseline({
    before,
    after,
    postScoped: ACCEPTED_POST_SCOPED,
  })

  const proofCalls = calls.filter((call) => call.maxNodes === undefined)
  assert.ok(proofCalls.length >= 2, 'the proof settle polls: ' + JSON.stringify(proofCalls))
  assert.ok(
    proofCalls.every((call) => call.withinRef !== undefined && call.anchorLastAction === true),
    'every proof poll is SCOPED to the baseline container with the identity anchor requested: ' + JSON.stringify(proofCalls),
  )
  assert.equal(proofCalls[0].withinRef, 'n-zone-before', 'the first poll roots at the baseline scope.rootRef')
  for (let i = 1; i < proofCalls.length; i += 1) {
    assert.equal(proofCalls[i].withinRef, 'n-zone-es-' + String(i), 'each poll re-keys through the previous rootRef')
  }
  assert.equal(escalationWindows, 0, 'an accepted scoped proof needs NO escalation, ever')

  assert.deepEqual(acted.proofScope, CONTAINER, 'the result names the proof scope (role + name)')
  assert.deepEqual(
    acted.anchor,
    { ref: 'n-target-es', connected: true, contained: true },
    'the result carries the driver identity anchor verbatim',
  )
  assert.equal(acted.proofEscalated, undefined, 'no escalation happened: proofEscalated is the WRONG word')
  assert.equal(acted.escalationRefused, undefined, 'an accepted proof is never a refusal')
  assert.equal(acted.observation.scope.name, CONTAINER.name, 'the proof observation is the SCOPED settled view')
  assert.equal(acted.observation.truncated, false)
  const inView = acted.observation.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
  assert.ok(inView, 'the proof observation returns the target')
  assert.equal(inView.inViewport, true)

  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(exported.excludedActions.length, 0)
  const step = exported.scenario.steps[0]
  assert.equal(step.action.kind, 'scroll')
  assert.equal(step.assert.kind, 'node-in-viewport')
  assert.deepEqual(step.assert.expected, TARGET)
  assert.deepEqual(
    step.assert.scope,
    CONTAINER,
    'the scoped proof exports WITH its scope through the ordinary withProofScope path',
  )
  assert.match(step.intent, /PROVISIONAL/, 'the scoped baseline is the container\'s own subtree: explicitly provisional (QA-BL-062)')
  assert.equal(step.escalationRefused, undefined, 'no refusal rides on an accepted proof step')
})

test('QA-BL-067: an unresolvable baseline rootRef discloses container-not-in-view + the driver code and falls back whole-page', async () => {
  const before = scopedBaseline()
  const after = wholePage([outerFiller(), targetInViewport('n-target-after')], false)
  const { acted, exported, escalationWindows, calls } = await exploreScopedBaseline({
    before,
    after,
    scopedThrows: { code: 'OBSERVATION_REQUIRED', message: 'call browser_observe and use a ref from the latest observation' },
  })

  const proofCalls = calls.filter((call) => call.maxNodes === undefined)
  assert.equal(
    proofCalls.filter((call) => call.withinRef !== undefined).length,
    1,
    'exactly ONE scoped proof attempt, then whole-page polls: ' + JSON.stringify(proofCalls),
  )
  assert.equal(
    proofCalls[0].withinRef,
    'n-zone-before',
    'the refused attempt rooted at the baseline scope.rootRef: ' + JSON.stringify(proofCalls[0]),
  )
  assert.ok(
    calls.slice(1).every((call) => call.withinRef === undefined && call.anchorLastAction === undefined),
    'the fallback is today\'s WHOLE-PAGE proof read: ' + JSON.stringify(calls.slice(1)),
  )
  assert.equal(escalationWindows, 0, 'a complete whole-page proof needs no escalation')
  assert.deepEqual(
    acted.escalationRefused,
    { reason: 'container-not-in-view', code: 'OBSERVATION_REQUIRED' },
    'the scoped proof root no longer resolves: disclosed with the fixed vocabulary plus the driver code',
  )
  assert.equal(acted.proofEscalated, undefined)
  assert.equal(acted.proofScope, undefined)
  assert.equal(acted.observation.scope, undefined, 'the proof is the whole-page settled view')
  assert.ok(
    acted.observation.nodes.some((item) => item.name === TARGET.name && item.inViewport === true),
    'the whole-page fallback still proves the scroll',
  )

  assert.equal(exported.ok, true, JSON.stringify(exported))
  const step = exported.scenario.steps[0]
  assert.equal(step.assert.scope, undefined, 'the whole-page proof exports unscoped')
  assert.deepEqual(
    step.escalationRefused,
    { reason: 'container-not-in-view', code: 'OBSERVATION_REQUIRED' },
    'the refusal rides on the exported step (report.md step lines surface it)',
  )
})

test('QA-BL-067: an escalation refusal supersedes the scoped-proof refusal; exactly ONE escalation ever runs', async () => {
  const before = scopedBaseline()
  const after = wholePage([outerFiller()], true)
  const wholeEscalated = wholePage([outerFiller(), targetOffViewport('n-target-es', null)], false)
  const { acted, escalationWindows } = await exploreScopedBaseline({
    before,
    after,
    scopedThrows: { code: 'OBSERVATION_REQUIRED', message: 'call browser_observe and use a ref from the latest observation' },
    wholeEscalated,
  })

  assert.equal(escalationWindows, 1, 'the ONE whole-page escalation ran after the fallback')
  assert.deepEqual(
    acted.escalationRefused,
    { reason: 'target-not-in-viewport' },
    'the escalation refusal is the FINAL disclosed truth (the scoped-proof refusal is superseded)',
  )
  assert.equal(acted.proofEscalated, undefined)
  assert.equal(acted.observation.scope, undefined, 'the proof stays the whole-page settled view')
})

test('QA-BL-067: a scoped proof settle whose anchor reports connected:false is disclosed as anchor-not-connected', async () => {
  const before = scopedBaseline()
  const after = wholePage([outerFiller()], true)
  const { acted, escalationWindows } = await exploreScopedBaseline({
    before,
    after,
    postScoped: { ...ACCEPTED_POST_SCOPED, anchor: { ref: 'n-target-es', connected: false, contained: true } },
  })

  assert.equal(escalationWindows, 0, 'a refused scoped proof on a complete view takes no escalation read')
  assert.deepEqual(acted.escalationRefused, { reason: 'anchor-not-connected' })
  assert.equal(acted.proofScope, undefined)
  assert.equal(acted.observation.scope.name, CONTAINER.name, 'the proof stays the settled scoped observation')
})

test('QA-BL-067: a scoped proof settle whose anchor reports contained:false is disclosed as anchor-not-contained', async () => {
  const before = scopedBaseline()
  const after = wholePage([outerFiller()], true)
  const { acted } = await exploreScopedBaseline({
    before,
    after,
    postScoped: { ...ACCEPTED_POST_SCOPED, anchor: { ref: 'n-target-es', connected: true, contained: false } },
  })

  assert.deepEqual(acted.escalationRefused, { reason: 'anchor-not-contained' })
  assert.equal(acted.proofScope, undefined)
})

test('QA-BL-067: a scoped proof settle with NO anchor is disclosed as anchor-unavailable', async () => {
  const before = scopedBaseline()
  const after = wholePage([outerFiller()], true)
  const { acted } = await exploreScopedBaseline({
    before,
    after,
    postScoped: { ...ACCEPTED_POST_SCOPED, anchor: undefined },
  })

  assert.deepEqual(acted.escalationRefused, { reason: 'anchor-unavailable' })
  assert.equal(acted.proofScope, undefined)
})

test('QA-BL-067: a scoped proof settle whose anchor ref is null is disclosed as anchor-unavailable', async () => {
  const before = scopedBaseline()
  const after = wholePage([outerFiller()], true)
  const { acted } = await exploreScopedBaseline({
    before,
    after,
    postScoped: { ...ACCEPTED_POST_SCOPED, anchor: { ref: null, connected: true, contained: true } },
  })

  assert.deepEqual(acted.escalationRefused, { reason: 'anchor-unavailable' })
  assert.equal(acted.proofScope, undefined)
})

test('QA-BL-067: a scoped proof settle whose anchored node is off-viewport is disclosed as target-not-in-viewport', async () => {
  const before = scopedBaseline()
  const after = wholePage([outerFiller()], true)
  const { acted } = await exploreScopedBaseline({
    before,
    after,
    postScoped: {
      page: { url: LAUNCH, title: 'scoped baseline fixture' },
      nodes: [container('n-zone-es'), targetOffViewport('n-target-es', 'n-zone-es')],
      truncated: false,
      anchor: { ref: 'n-target-es', connected: true, contained: true },
    },
  })

  assert.deepEqual(acted.escalationRefused, { reason: 'target-not-in-viewport' })
  assert.equal(acted.proofScope, undefined)
})

test('QA-BL-067: a scoped proof settle refused with ANCHOR_UNAVAILABLE discloses the driver code', async () => {
  const before = scopedBaseline()
  const after = wholePage([outerFiller(), targetInViewport('n-target-after')], false)
  const { acted, escalationWindows } = await exploreScopedBaseline({
    before,
    after,
    scopedThrows: { code: 'ANCHOR_UNAVAILABLE', message: 'no element has been acted on in this session yet' },
  })

  assert.equal(escalationWindows, 0)
  assert.deepEqual(
    acted.escalationRefused,
    { reason: 'anchor-unavailable', code: 'ANCHOR_UNAVAILABLE' },
    'the driver code rides along with the fixed vocabulary word',
  )
  assert.equal(acted.observation.scope, undefined, 'the proof falls back to the whole-page read')
})

test('QA-BL-067: a WHOLE-PAGE baseline keeps today\'s proof settle byte-identical (never a scoped attempt)', async () => {
  const before = wholePage([outerFiller(), targetOffViewport('n-target', null)], true)
  const after = wholePage([outerFiller()], true)
  const { acted, calls } = await exploreScopedBaseline({
    before,
    after,
    wholeEscalated: wholePage([outerFiller(), targetInViewport('n-target-es')], false),
  })

  const proofCalls = calls.filter((call) => call.maxNodes === undefined)
  assert.ok(
    proofCalls.every((call) => call.withinRef === undefined && call.anchorLastAction === undefined),
    'a whole-page baseline never takes a scoped proof read: ' + JSON.stringify(proofCalls),
  )
  assert.equal(acted.proofEscalated, true, 'the whole-page escalation path is unchanged')
  assert.equal(acted.proofScope, undefined)
  assert.equal(acted.observation.scope, undefined)
})
