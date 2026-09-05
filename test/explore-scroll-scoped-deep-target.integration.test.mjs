// QA-BL-050 closed loop against a REAL headless Chrome: a page whose unique
// scroll target sits beyond the driver's CLAMPED 100-node whole-page window
// (so no whole-page budget — not even the record-time escalation at
// QA_ESCALATED_NODE_BUDGET — can ever return it) but inside a container that
// IS inside the default window. The pre-fix defect: the one whole-page
// re-observation #escalateScrollProof takes is clamped to 100 nodes, the
// target at emitted position 102 is never returned no matter the budget, and
// the scroll step is excluded (NO_PROVEN_STEPS) — the scenario is impossible
// to export today. The fix: when the settled whole-page proof view is
// truncated and lacks the target in the viewport, the escalation prefers a
// SCOPED read rooted at the scroll target's nearest suitable container (the
// region at position 42), whose subtree (61 nodes) fits the subtree budget
// COMPLETELY. The exported scenario's scroll step then asserts
// node-in-viewport carrying the container scope, and replay passes twice
// deterministically.
//
// Explore flow: whole-page observe (find the container) -> scoped observe
// within the container (find the target's ref) -> scroll to the ref -> the
// recording session takes exactly ONE SCOPED escalated read and records it as
// the proof -> export -> replay twice.

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
const FIXTURE_HTML = join(ROOT, 'fixtures', 'web', 'scoped-deep-target.html')

const TARGET = { role: 'link', name: 'Deep Target' }
const CONTAINER = { role: 'region', name: 'Deep zone' }

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

test('explore a container-scoped deep scroll target -> scoped node-in-viewport step -> replay PASS twice', { timeout: 300_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  const html = await readFile(FIXTURE_HTML, 'utf8')
  let port = 0
  const fixture = createServer((req, res) => {
    void req
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  port = await listen(fixture)
  const origin = 'http://127.0.0.1:' + port
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scoped-deep-scroll-'))
  const scenarioPath = join(dir, 'explored.json')
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const call = (definition, args) => definition.execute(args, { agent: { id: 'scoped-deep-scroll-agent' } })

  try {
    const owner = 'scoped-deep-scroll-explore'
    const started = await call(tools.qaSessionStart, { owner, driver: 'browser', url: origin, headless: true })
    assert.equal(started.headless, true)

    // 1. The defect precondition, observed for real: NO whole-page budget can
    //    return the target. The default window is truncated without it, and
    //    the clamped 100-node window is truncated without it too — this is the
    //    case the whole-page escalation can never prove.
    const initial = await call(tools.qaObserve, { owner })
    assert.equal(initial.truncated, true, 'the fixture must exceed the default 60-node budget')
    assert.equal(
      initial.nodes.some((item) => item.name === 'Deep Target'),
      false,
      'the target sits beyond the default window',
    )
    const wide = await call(tools.qaObserve, { owner, max_nodes: 100 })
    assert.equal(wide.truncated, true, 'the fixture also exceeds the clamped 100-node budget')
    assert.equal(
      wide.nodes.some((item) => item.name === 'Deep Target'),
      false,
      'the target sits beyond the clamped 100-node whole-page window: no whole-page escalation can prove it',
    )

    // 2. The container IS inside the default window: scope to it and read the
    //    target's ref (exactly like a scoped Explore read). The within ref must
    //    come from the CURRENT (latest) observation — the wide observe above
    //    consumed the initial one's refs.
    const containerNode = wide.nodes.find(
      (item) => item.role === CONTAINER.role && item.name === CONTAINER.name,
    )
    assert.ok(containerNode, 'the container must be inside the whole-page windows')
    const scoped = await call(tools.qaObserve, { owner, within_ref: containerNode.ref, max_nodes: 100 })
    assert.deepEqual(
      scoped.scope === undefined ? undefined : { role: scoped.scope.role, name: scoped.scope.name },
      CONTAINER,
      'the scoped observe echoes the container root',
    )
    assert.equal(scoped.truncated, false, 'the container subtree fits the subtree budget completely')
    const target = scoped.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
    assert.ok(target, 'the scoped view returns the unique target')
    assert.equal(target.inViewport, false, 'the target starts below the fold')

    // 3. Scroll to the target's ref: the record-time escalation must take the
    //    ONE SCOPED read (the whole-page escalation is impossible here), and
    //    the recorded proof observation must be the scoped one.
    const scrolled = await call(tools.qaAct, { owner, action: 'scroll', ref: target.ref })
    assert.equal(scrolled.outcome, 'ok')
    assert.equal(scrolled.receipt.status, 'confirmed')
    assert.equal(scrolled.proofEscalated, true, 'the record-time escalation was accepted')
    assert.deepEqual(
      scrolled.observation.scope === undefined
        ? undefined
        : { role: scrolled.observation.scope.role, name: scrolled.observation.scope.name },
      CONTAINER,
      'the recorded proof observation is the SCOPED escalated view, never a whole-page view',
    )
    assert.equal(
      scrolled.observation.truncated,
      false,
      'the recorded proof observation keeps its own honest truncated flag: the container subtree is complete',
    )
    const inView = scrolled.observation.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
    assert.ok(inView, 'the proof observation returns the target')
    assert.equal(inView.inViewport, true, 'the target is in the viewport after the scroll')

    // 4. Export: the scroll step must be PROVEN with the container scope, not
    //    excluded and never exported as a whole-page proof.
    const exported = await call(tools.qaRecordExport, {
      owner,
      output_path: scenarioPath,
      name: 'fixture-scoped-deep-scroll',
    })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.excludedActions.length, 0, JSON.stringify(exported.excludedActions))
    assert.equal(exported.scenario.steps.length, 1, 'exactly the scroll step')
    const [scrollStep] = exported.scenario.steps
    assert.equal(scrollStep.action.kind, 'scroll')
    assert.ok('target' in scrollStep.action, 'scroll is exported by target, not positionally')
    assert.equal(scrollStep.action.target.name, TARGET.name)
    assert.equal(scrollStep.action.target.role, TARGET.role)
    assert.equal(scrollStep.assert.kind, 'node-in-viewport')
    assert.deepEqual(scrollStep.assert.expected, TARGET)
    assert.deepEqual(
      scrollStep.assert.scope,
      CONTAINER,
      'the scoped proof exports with the container scope, never as a whole-page proof',
    )

    const loaded = loadScenarioFromPath(scenarioPath)
    assert.deepEqual(loaded, exported.scenario)

    // 5. Replay twice; both runs PASS with byte-identical deterministic
    //    projections, the step resolved inside the container scope.
    const projections = []
    for (let run = 0; run < 2; run += 1) {
      const replay = await call(tools.qaReplayRun, {
        scenario: scenarioPath,
        owner: 'scoped-deep-scroll-replay-' + run,
        headless: true,
      })
      assert.equal(replay.status, 'pass', 'replay ' + (run + 1) + ' must PASS: ' + JSON.stringify(replay.failure ?? {}))
      assert.equal(replay.steps.length, 1)
      assert.ok(replay.steps.every((step) => step.status === 'pass' && step.assertionPassed === true))
      assert.deepEqual(
        replay.steps[0].completeness?.scope,
        CONTAINER,
        'the replay step was decided inside the container scope',
      )
      projections.push(replay.steps.map((step) => ({
        index: step.index,
        status: step.status,
        intent: step.intent,
        action: step.action,
        assertionPassed: step.assertionPassed,
        observed: step.observed,
        expected: step.expected,
      })))
    }
    assert.deepEqual(projections[0], projections[1], 'two replays are deterministic')
    await call(tools.qaSessionStop, { owner })
  } finally {
    await host.dispose()
    fixture.closeAllConnections?.()
    await new Promise((resolve) => fixture.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
