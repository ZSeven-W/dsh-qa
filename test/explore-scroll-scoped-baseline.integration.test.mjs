// QA-BL-067 closed loop against a REAL headless Chrome, over the real tool
// surface (createQaTools). A scroll acted from a SCOPED baseline (the acted
// ref came from a scoped qa_observe) takes its proof settle INSIDE the
// baseline's container — but the REAL driver (contract v9, dsh-browser
// a17727a) consumes the ENTIRE latest observation on a dispatched action
// (verified here and in session.ts docs: every ref it minted, including the
// scope rootRef, stops resolving; observe({within}) throws
// OBSERVATION_REQUIRED), so the scoped proof read cannot be rooted and the
// session core DISCLOSES the fallback (escalationRefused with the fixed
// vocabulary + the driver's code) and takes today's whole-page proof read
// instead. Two fixtures pin the two real outcomes:
//
//  1. SCOPED-BASELINE-SMALL (fixtures/web/scoped-baseline-small.html): the
//     whole page fits the default window COMPLETELY, so the whole-page
//     fallback proof proves the scroll on its own — the result discloses
//     { reason: 'container-not-in-view', code: 'OBSERVATION_REQUIRED' }, no
//     escalation runs, qa_assert(node-in-viewport) passes, the export carries
//     the refusal on the step, and replay passes twice deterministically with
//     the refusal printed on report.md's step lines.
//  2. SCOPED-BASELINE-DEEP (fixtures/web/scoped-baseline-deep-target.html):
//     the Wikipedia History_of_China shape — the container sits beyond the
//     60-node settle window and the target beyond the CLAMPED 100-node
//     whole-page maximum, so neither the settle view nor the ONE whole-page
//     escalation can return the target. The act result discloses
//     { reason: 'target-not-returned' } (the escalation's final truth) instead
//     of today's silent exits, and the export excludes the step honestly.
//
// The ACCEPTED scoped proof read (proofScope + anchor on the act result) is
// pinned in test/scroll-proof-scoped-baseline.test.mjs with a fake adapter
// that retains the baseline rootRef: the real driver cannot accept it today,
// and the session core engages it automatically the moment a driver does.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverInstalledBrowser } from '@zseven-w/dsh-browser'
import { loadScenarioFromPath } from '../src/replay/index.ts'
import { createQaTools, QaToolHost } from '../src/tools.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SMALL_HTML = join(ROOT, 'fixtures', 'web', 'scoped-baseline-small.html')
const DEEP_HTML = join(ROOT, 'fixtures', 'web', 'scoped-baseline-deep-target.html')

const TARGET = { role: 'link', name: 'Deep Target' }
const CONTAINER = { role: 'region', name: 'Deep zone' }
const SCOPED_PROOF_UNAVAILABLE = { reason: 'container-not-in-view', code: 'OBSERVATION_REQUIRED' }

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function withFixture(t, fixtureHtml) {
  await discoverInstalledBrowser()
  const html = await readFile(fixtureHtml, 'utf8')
  const fixture = createServer((req, res) => {
    void req
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  const port = await listen(fixture)
  const origin = 'http://127.0.0.1:' + port
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scoped-baseline-'))
  return {
    origin,
    dir,
    async close() {
      fixture.closeAllConnections?.()
      await new Promise((resolve) => fixture.close(resolve))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function projection(steps) {
  return steps.map((step) => ({
    index: step.index,
    status: step.status,
    intent: step.intent,
    action: step.action,
    assertionPassed: step.assertionPassed,
    reason: step.reason,
    observed: step.observed,
    expected: step.expected,
    escalationRefused: step.escalationRefused,
  }))
}

test('scoped-baseline scroll on a COMPLETE page discloses the scoped-proof fallback and exports a proven step', { timeout: 300_000 }, async (t) => {
  let fixture
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  fixture = await withFixture(t, SMALL_HTML)
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const call = (definition, args) => definition.execute(args, { agent: { id: 'scoped-baseline-small-agent' } })
  try {
    const owner = 'scoped-baseline-small'
    const started = await call(tools.qaSessionStart, { owner, driver: 'browser', url: fixture.origin, headless: true })
    assert.equal(started.headless, true)

    // 1. Whole page -> scoped view: the acted ref comes from the SCOPED baseline.
    const whole = await call(tools.qaObserve, { owner })
    assert.equal(whole.truncated, false, 'the small fixture fits the default window completely')
    const containerNode = whole.nodes.find((item) => item.role === CONTAINER.role && item.name === CONTAINER.name)
    assert.ok(containerNode, JSON.stringify(whole.nodes.map((node) => node.name)))
    const scoped = await call(tools.qaObserve, { owner, within_ref: containerNode.ref })
    assert.deepEqual(
      scoped.scope === undefined ? undefined : { role: scoped.scope.role, name: scoped.scope.name },
      CONTAINER,
      'the scoped observe echoes the container root',
    )
    assert.equal(typeof scoped.scope.rootRef, 'string', 'the scoped observation carries the fresh rootRef (contract v9)')
    assert.equal(scoped.truncated, false, 'the container subtree is complete')
    const target = scoped.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
    assert.ok(target, 'the scoped view returns the target')
    assert.equal(target.inViewport, false, 'the target starts below the fold')

    // 2. Scroll to the ref taken from the SCOPED view. The scoped proof read
    //    is REFUSED by the real driver (the action consumed the observation:
    //    OBSERVATION_REQUIRED) — disclosed, and the whole-page fallback proof
    //    proves the scroll on its own (complete view, target in the viewport).
    const scrolled = await call(tools.qaAct, { owner, action: 'scroll', ref: target.ref })
    assert.equal(scrolled.outcome, 'ok', JSON.stringify(scrolled))
    assert.equal(scrolled.receipt.status, 'confirmed')
    assert.deepEqual(
      scrolled.escalationRefused,
      SCOPED_PROOF_UNAVAILABLE,
      'the scoped-proof fallback is DISCLOSED with the fixed vocabulary plus the driver code',
    )
    assert.equal(scrolled.proofEscalated, undefined, 'no escalation ran: the whole-page fallback decided on its own')
    assert.equal(scrolled.proofScope, undefined)
    assert.equal(scrolled.observation.scope, undefined, 'the proof is the whole-page settled view')
    assert.equal(scrolled.observation.truncated, false, 'the small page stays complete whole-page')
    const inView = scrolled.observation.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
    assert.ok(inView, 'the fallback proof returns the target')
    assert.equal(inView.inViewport, true, 'the scroll is proven in the viewport')

    // 3. The live assertion passes, and the export carries the refusal on the
    //    proven step (whole-page proof, so no scope).
    const asserted = await call(tools.qaAssert, { owner, kind: 'node-in-viewport', expected: TARGET })
    assert.equal(asserted.passed, true, JSON.stringify(asserted))
    const scenarioPath = join(fixture.dir, 'scoped-baseline-small.json')
    const exported = await call(tools.qaRecordExport, { owner, output_path: scenarioPath, name: 'scoped-baseline-small' })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.excludedActions.length, 0)
    assert.equal(exported.scenario.steps.length, 1)
    const [step] = exported.scenario.steps
    assert.equal(step.action.kind, 'scroll')
    assert.equal(step.assert.kind, 'node-in-viewport')
    assert.deepEqual(step.assert.expected, TARGET)
    assert.equal(step.assert.scope, undefined, 'the whole-page fallback proof exports unscoped')
    assert.deepEqual(
      step.escalationRefused,
      SCOPED_PROOF_UNAVAILABLE,
      'the refusal rides on the exported step so report.md step lines can surface it',
    )
    assert.match(step.intent, /scoped/, 'the scoped preceding view is disclosed in the intent')
    const loaded = loadScenarioFromPath(scenarioPath)
    assert.deepEqual(loaded, exported.scenario)

    // 4. Replay twice: deterministic PASS, and report.md prints the refusal
    //    on the step line.
    const projections = []
    for (let run = 0; run < 2; run += 1) {
      const replay = await call(tools.qaReplayRun, {
        scenario: scenarioPath,
        owner: 'scoped-baseline-small-replay-' + run,
        headless: true,
        outputDir: join(fixture.dir, 'small-report-' + run),
      })
      assert.equal(replay.status, 'pass', JSON.stringify(replay.failure))
      assert.equal(replay.steps.length, 1)
      assert.equal(replay.steps[0].status, 'pass')
      assert.equal(replay.steps[0].assertionPassed, true)
      assert.deepEqual(
        replay.steps[0].escalationRefused,
        SCOPED_PROOF_UNAVAILABLE,
        'the replayed step carries the recorded proof refusal',
      )
      const md = await readFile(join(fixture.dir, 'small-report-' + run, 'report.md'), 'utf8')
      assert.match(md, /proof escalation refusal: container-not-in-view \(OBSERVATION_REQUIRED\)/, 'report.md step lines surface the refusal')
      projections.push(projection(replay.steps))
    }
    assert.deepEqual(projections[0], projections[1], 'two replays are deterministic')
    await call(tools.qaSessionStop, { owner })
  } finally {
    await host.dispose()
    await fixture.close()
  }
})

test('scoped-baseline scroll with the container beyond every whole-page window discloses target-not-returned (the Wikipedia case)', { timeout: 300_000 }, async (t) => {
  let fixture
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  fixture = await withFixture(t, DEEP_HTML)
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const call = (definition, args) => definition.execute(args, { agent: { id: 'scoped-baseline-deep-agent' } })
  try {
    const owner = 'scoped-baseline-deep'
    const started = await call(tools.qaSessionStart, { owner, driver: 'browser', url: fixture.origin, headless: true })
    assert.equal(started.headless, true)

    // 1. The precondition, observed for real: no whole-page budget can return
    //    the container or the target — the container sits beyond the default
    //    60-node window and the target beyond the clamped 100-node maximum.
    const initial = await call(tools.qaObserve, { owner })
    assert.equal(initial.truncated, true, 'the fixture must exceed the default 60-node budget')
    assert.equal(
      initial.nodes.some((item) => item.role === CONTAINER.role && item.name === CONTAINER.name),
      false,
      'the container sits beyond the default window',
    )
    const wide = await call(tools.qaObserve, { owner, max_nodes: 100 })
    assert.equal(wide.truncated, true, 'the fixture also exceeds the clamped 100-node budget')
    assert.equal(
      wide.nodes.some((item) => item.name === TARGET.name),
      false,
      'the target sits beyond the clamped 100-node whole-page window',
    )
    const containerNode = wide.nodes.find((item) => item.role === CONTAINER.role && item.name === CONTAINER.name)
    assert.ok(containerNode, 'the container is inside the 100-node window')

    // 2. Scoped view -> scroll to the ref taken from it.
    const scoped = await call(tools.qaObserve, { owner, within_ref: containerNode.ref, max_nodes: 100 })
    assert.equal(scoped.truncated, false, 'the container subtree fits completely')
    const target = scoped.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
    assert.ok(target, 'the scoped view returns the target')
    assert.equal(target.inViewport, false)
    const scrolled = await call(tools.qaAct, { owner, action: 'scroll', ref: target.ref })
    assert.equal(scrolled.outcome, 'ok', JSON.stringify(scrolled))
    assert.equal(scrolled.receipt.status, 'confirmed')
    assert.deepEqual(
      scrolled.escalationRefused,
      { reason: 'target-not-returned' },
      'the final truth is DISCLOSED: the ONE whole-page escalation cannot return the target (never a silent exit)',
    )
    assert.equal(scrolled.proofEscalated, undefined, 'a refused escalation is never a proof')
    assert.equal(scrolled.observation.scope, undefined, 'the proof stays the whole-page settled view')
    assert.equal(scrolled.observation.truncated, true)

    // 3. The scroll genuinely landed (the live page proves it inside the
    //    container) — while the recorded proof honestly cannot, and the
    //    export excludes the step instead of inventing one.
    const fresh = await call(tools.qaObserve, { owner, max_nodes: 100 })
    const freshContainer = fresh.nodes.find((item) => item.role === CONTAINER.role && item.name === CONTAINER.name)
    assert.ok(freshContainer)
    const asserted = await call(tools.qaAssert, {
      owner,
      kind: 'node-in-viewport',
      expected: TARGET,
      within_ref: freshContainer.ref,
    })
    assert.equal(asserted.passed, true, JSON.stringify(asserted))
    const exported = await call(tools.qaRecordExport, {
      owner,
      output_path: join(fixture.dir, 'scoped-baseline-deep.json'),
      name: 'scoped-baseline-deep',
    })
    assert.equal(exported.ok, false, JSON.stringify(exported))
    assert.equal(exported.code, 'NO_PROVEN_STEPS')
    assert.equal(exported.excludedActions.length, 1)
    assert.equal(exported.excludedActions[0].reason, 'ASSERTION_NOT_PROVABLE')
    assert.match(exported.excludedActions[0].detail, /did not return the scroll target "Deep Target"/)
    await call(tools.qaSessionStop, { owner })
  } finally {
    await host.dispose()
    await fixture.close()
  }
})
