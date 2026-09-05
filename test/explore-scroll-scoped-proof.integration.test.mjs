// QA-BL-062 (Codex consult #2, decision (b)) — closed loop against REAL
// headless Chrome:
//   1. PROVEN fixture (fixtures/web/scoped-scroll-proof-small.html): the page
//      stays UNDER the clamped 100-node whole-page budget, so replay proves the
//      container unique in a COMPLETE whole-page view and the scoped scroll
//      proof reaches PASS end to end with scopeResolution 'proven'. The
//      container sits inside an emitted ancestor, so export records the
//      ancestor PATH — the stronger locator.
//   2. TWIN fixture (fixtures/web/twin-container.html): two same-identity
//      containers (identical ancestor paths), one beyond the 100-node window,
//      each with a same-identity target. The unseen twin means the container
//      can never be proven unique at replay: the step must be
//      INCONCLUSIVE_SCOPE / scopeResolution 'provisional' and the run
//      INCONCLUSIVE — NEVER pass — even though the identity anchor succeeds on
//      the replayed scroll (the anchor proves what happened to the element
//      replay selected, not that replay selected the recorded counterpart).

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
const PROVEN_HTML = join(ROOT, 'fixtures', 'web', 'scoped-scroll-proof-small.html')
const TWIN_HTML = join(ROOT, 'fixtures', 'web', 'twin-container.html')

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function serveFixture(t, htmlPath, owner, scenarioPath, explore) {
  await discoverInstalledBrowser().catch((error) => {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
  })
  const html = await readFile(htmlPath, 'utf8')
  const fixture = createServer((req, res) => {
    void req
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  const port = await listen(fixture)
  const origin = 'http://127.0.0.1:' + port
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-provisional-scope-'))
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const call = (definition, args) => definition.execute(args, { agent: { id: 'provisional-scope-agent' } })
  try {
    await explore(t, call, tools, origin, owner, join(dir, scenarioPath), dir)
  } finally {
    await host.dispose()
    fixture.closeAllConnections?.()
    await new Promise((resolve) => fixture.close(resolve))
  }
  return dir
}

test('proven fixture: a scoped scroll proof with a unique container in a COMPLETE whole-page view replays PASS twice (scopeResolution proven)', { timeout: 300_000 }, async (t) => {
  const scenarioPath = 'explored-proven.json'
  const dir = await serveFixture(t, PROVEN_HTML, 'proven-scroll-explore', scenarioPath, async (t, call, tools, origin, owner, outPath, dir) => {
    const started = await call(tools.qaSessionStart, { owner, driver: 'browser', url: origin, headless: true })
    assert.equal(started.headless, true)

    // 1. The whole page COMPLETES at the 100-node budget: the container is
    //    unique in a complete view, and the target (position 61) is beyond the
    //    default 60-node settle window but inside the escalation.
    const initial = await call(tools.qaObserve, { owner, max_nodes: 100 })
    assert.equal(initial.truncated, false, 'the proven fixture must fit the clamped 100-node whole-page budget')
    const containerNode = initial.nodes.find(
      (item) => item.role === 'region' && item.name === 'Scroll zone',
    )
    assert.ok(containerNode, 'the container is returned by the complete whole-page view')
    assert.ok(
      typeof containerNode.parentRef === 'string' && containerNode.parentRef !== '',
      'the container carries real emitted ancestry (the Scroll shelf region)',
    )
    const target = initial.nodes.find((item) => item.role === 'link' && item.name === 'Deep Target')
    assert.ok(target, 'the complete whole-page view returns the target')
    assert.equal(target.inViewport, false, 'the target starts below the fold')

    // 2. Scroll to the target: the record-time escalation takes the ONE
    //    identity-anchored SCOPED read and accepts it on the anchor.
    const scrolled = await call(tools.qaAct, { owner, action: 'scroll', ref: target.ref })
    assert.equal(scrolled.outcome, 'ok')
    assert.equal(scrolled.proofEscalated, true, 'the record-time escalation was accepted')
    assert.equal(scrolled.observation.scope?.role, 'region')
    assert.equal(scrolled.observation.scope?.name, 'Scroll zone')
    const inView = scrolled.observation.nodes.find((item) => item.role === 'link' && item.name === 'Deep Target')
    assert.ok(inView, 'the proof observation returns the target')
    assert.equal(inView.inViewport, true)

    // 3. Export: uniqueness IS proven (unique in the COMPLETE whole-page
    //    baseline), so the scope is DURABLE — and the recorded ancestor PATH
    //    travels as the stronger locator. The intent carries NO provisional
    //    weakness (the export is proven, not provisional).
    const exported = await call(tools.qaRecordExport, { owner, output_path: outPath, name: 'fixture-proven-scoped-scroll' })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.excludedActions.length, 0, JSON.stringify(exported.excludedActions))
    assert.equal(exported.scenario.steps.length, 1)
    const step = exported.scenario.steps[0]
    assert.equal(step.action.kind, 'scroll')
    assert.ok('target' in step.action)
    assert.equal(step.assert.kind, 'node-in-viewport')
    assert.deepEqual(step.assert.expected, { role: 'link', name: 'Deep Target' })
    assert.deepEqual(
      step.assert.scope,
      { role: 'region', name: 'Scroll zone', path: [{ role: 'region', name: 'Scroll shelf' }] },
      'a PROVEN scope records the ancestor PATH (the stronger locator, outermost first)',
    )
    assert.doesNotMatch(step.intent, /PROVISIONAL/, 'a proven export carries no provisional weakness')
    const loaded = loadScenarioFromPath(outPath)
    assert.deepEqual(loaded, exported.scenario)

    // 4. Replay twice: PASS with scopeResolution 'proven', deterministically.
    const projections = []
    for (let run = 0; run < 2; run += 1) {
      const replay = await call(tools.qaReplayRun, {
        scenario: outPath,
        owner: 'proven-scroll-replay-' + run,
        headless: true,
      })
      assert.equal(replay.status, 'pass', 'replay ' + (run + 1) + ' must PASS: ' + JSON.stringify(replay.failure ?? {}))
      assert.equal(replay.steps.length, 1)
      assert.equal(replay.steps[0].status, 'pass')
      assert.equal(replay.steps[0].assertionPassed, true)
      assert.equal(replay.steps[0].reason, undefined)
      assert.equal(replay.steps[0].scopeResolution, 'proven', 'the container was unique in a complete whole-page view')
      assert.equal(replay.assertions[0].passed, true)
      assert.equal(replay.assertions[0].scopeResolution, 'proven')
      projections.push(replay.steps.map((s) => ({
        index: s.index,
        status: s.status,
        intent: s.intent,
        action: s.action,
        assertionPassed: s.assertionPassed,
        scopeResolution: s.scopeResolution,
        observed: s.observed,
        expected: s.expected,
      })))
    }
    assert.deepEqual(projections[0], projections[1], 'two replays are deterministic')
    await call(tools.qaSessionStop, { owner })
  })
  await rm(dir, { recursive: true, force: true })
})

test('twin fixture: an unseen twin container with an identical path is INCONCLUSIVE_SCOPE — replay twice, NEVER pass', { timeout: 300_000 }, async (t) => {
  const scenarioPath = 'explored-twin.json'
  const dir = await serveFixture(t, TWIN_HTML, 'twin-scroll-explore', scenarioPath, async (t, call, tools, origin, owner, outPath, dir) => {
    const started = await call(tools.qaSessionStart, { owner, driver: 'browser', url: origin, headless: true })
    assert.equal(started.headless, true)

    // 1. The SECOND twin sits beyond the clamped 100-node whole-page window:
    //    no whole-page view can ever see it (the defect precondition).
    const initial = await call(tools.qaObserve, { owner })
    assert.equal(initial.truncated, true, 'the twin fixture must exceed the default 60-node budget')
    assert.equal(initial.nodes.filter((item) => item.role === 'region' && item.name === 'Twin zone').length, 1)
    const wide = await call(tools.qaObserve, { owner, max_nodes: 100 })
    assert.equal(wide.truncated, true, 'the twin fixture also exceeds the clamped 100-node budget')
    assert.equal(
      wide.nodes.filter((item) => item.role === 'region' && item.name === 'Twin zone').length,
      1,
      'the second twin sits beyond the clamped 100-node window and is never returned',
    )

    // 2. Scope into the FIRST twin and read its target's ref.
    const twinOne = wide.nodes.find((item) => item.role === 'region' && item.name === 'Twin zone')
    assert.ok(twinOne, 'the first twin is inside the whole-page windows')
    const scoped = await call(tools.qaObserve, { owner, within_ref: twinOne.ref, max_nodes: 100 })
    assert.equal(scoped.truncated, false, 'the first twin subtree fits its budget completely')
    const target = scoped.nodes.find((item) => item.role === 'link' && item.name === 'Twin Target')
    assert.ok(target, 'the scoped view returns the first twin target')
    assert.equal(target.inViewport, false, 'the target starts below the fold')

    // 3. Scroll: the record-time escalation scopes to the first twin and is
    //    accepted on the identity anchor (the ORIGINAL acted element is
    //    connected, contained, in the viewport) — identity-safe at record
    //    time, but it can never prove WHICH twin the recording meant.
    const scrolled = await call(tools.qaAct, { owner, action: 'scroll', ref: target.ref })
    assert.equal(scrolled.outcome, 'ok')
    assert.equal(scrolled.proofEscalated, true, 'the record-time escalation was accepted')
    assert.equal(scrolled.observation.scope?.name, 'Twin zone')

    // 4. Export: the scoped baseline is the twin's OWN subtree (the container
    //    is trivially its own root there), so uniqueness is UNPROVEN — the
    //    identity-anchored scroll proof is exported explicitly PROVISIONAL
    //    with the recorded ancestor path (identical for both twins).
    const exported = await call(tools.qaRecordExport, { owner, output_path: outPath, name: 'fixture-twin-container' })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.excludedActions.length, 0, JSON.stringify(exported.excludedActions))
    assert.equal(exported.scenario.steps.length, 1)
    const step = exported.scenario.steps[0]
    assert.deepEqual(
      step.assert.scope,
      { role: 'region', name: 'Twin zone', path: [{ role: 'region', name: 'Twin shelf' }] },
      'the provisional export records the ancestor path (identical for both twins — the honest limit)',
    )
    assert.match(step.intent, /PROVISIONAL/, 'the export is explicitly provisional (step intent/weakness says so)')
    const loaded = loadScenarioFromPath(outPath)
    assert.deepEqual(loaded, exported.scenario)

    // 5. Replay twice: INCONCLUSIVE, never pass. The anchor SUCCEEDS (the
    //    replayed scroll really scrolled the selected twin target) — and that
    //    is exactly the point: the anchor proves what happened to the element
    //    replay SELECTED, not that replay selected the recorded counterpart.
    const projections = []
    for (let run = 0; run < 2; run += 1) {
      const replay = await call(tools.qaReplayRun, {
        scenario: outPath,
        owner: 'twin-scroll-replay-' + run,
        headless: true,
        outputDir: join(dir, 'twin-report-' + run),
      })
      assert.equal(
        replay.status,
        'inconclusive',
        'replay ' + (run + 1) + ' must be INCONCLUSIVE, never PASS: ' + JSON.stringify(replay.failure ?? {}),
      )
      assert.equal(replay.steps.length, 1)
      assert.equal(replay.steps[0].status, 'inconclusive')
      assert.equal(replay.steps[0].assertionPassed, false, 'never passed:true on a provisionally resolved container')
      assert.equal(replay.steps[0].reason, 'INCONCLUSIVE_SCOPE')
      assert.equal(replay.steps[0].scopeResolution, 'provisional')
      assert.equal(replay.assertions[0].passed, false)
      assert.equal(replay.assertions[0].reason, 'INCONCLUSIVE_SCOPE')
      assert.equal(replay.assertions[0].scopeResolution, 'provisional')
      assert.equal(replay.failure, undefined, 'nothing definitely failed: no failure block')
      const md = await readFile(join(dir, 'twin-report-' + run, 'report.md'), 'utf8')
      assert.match(md, /Status\*\*: inconclusive/)
      assert.match(md, /INCONCLUSIVE_SCOPE/, 'report.md must say WHY the step is inconclusive')
      assert.match(md, /scope resolution: provisional/)
      projections.push(replay.steps.map((s) => ({
        index: s.index,
        status: s.status,
        intent: s.intent,
        action: s.action,
        assertionPassed: s.assertionPassed,
        reason: s.reason,
        scopeResolution: s.scopeResolution,
        observed: s.observed,
        expected: s.expected,
      })))
    }
    assert.deepEqual(projections[0], projections[1], 'two replays are deterministic')
    await call(tools.qaSessionStop, { owner })
  })
  await rm(dir, { recursive: true, force: true })
})
