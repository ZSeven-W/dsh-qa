// QA-BL-045 closed loop against a REAL headless Chrome: a page whose unique
// scroll target sits beyond the driver default 60-node window (composed-tree
// DOM order) but inside the clamped 100-node escalated window. The pre-fix
// defect: the recorded settled post-scroll observation never returned the
// target, so qa_record_export excluded the scroll step with the click/fill
// wording "no semantic state change or URL change" (NO_PROVEN_STEPS, no file).
// The fix: the recording session escalates the node budget ONCE and records
// the fuller view as the proof, so the exported scenario carries the
// node-in-viewport step and replays PASS twice deterministically — exactly the
// live Wikipedia History_of_China "Three Kingdoms" navbox failure.

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
const FIXTURE_HTML = join(ROOT, 'fixtures', 'web', 'long-page.html')

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

test('explore a deep scroll target -> export node-in-viewport step -> replay PASS twice', { timeout: 300_000 }, async (t) => {
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-deep-scroll-'))
  const scenarioPath = join(dir, 'explored.json')
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const call = (definition, args) => definition.execute(args, { agent: { id: 'deep-scroll-agent' } })

  try {
    const owner = 'deep-scroll-explore'
    const started = await call(tools.qaSessionStart, { owner, driver: 'browser', url: origin, headless: true })
    assert.equal(started.headless, true)

    // 1. The defect precondition, observed for real: the default window is
    //    truncated and does NOT return the target that genuinely exists.
    const initial = await call(tools.qaObserve, { owner })
    assert.equal(initial.truncated, true, 'the fixture must exceed the default 60-node budget')
    assert.equal(initial.nodes.length, 60, 'the driver default budget is 60 nodes')
    assert.equal(
      initial.nodes.some((item) => item.name === 'Deep Target'),
      false,
      'the target sits beyond the default window: this is the export trap',
    )

    // 2. Exactly like the live flow (qa_observe with 100 nodes): the wider view
    //    is still truncated but returns the target, off-viewport.
    const wide = await call(tools.qaObserve, { owner, max_nodes: 100 })
    assert.equal(wide.truncated, true, 'the fixture also exceeds the escalated budget')
    const target = wide.nodes.find((item) => item.role === 'link' && item.name === 'Deep Target')
    assert.ok(target, 'the wider view returns the unique target')
    assert.equal(target.inViewport, false, 'the target starts below the fold')

    // 3. Scroll to the target's ref.
    const scrolled = await call(tools.qaAct, { owner, action: 'scroll', ref: target.ref })
    assert.equal(scrolled.outcome, 'ok')
    assert.equal(scrolled.receipt.status, 'confirmed')
    const inView = scrolled.observation.nodes.find((item) => item.role === 'link' && item.name === 'Deep Target')
    assert.ok(inView, 'the proof observation returns the target (record-time escalation)')
    assert.equal(inView.inViewport, true, 'the target is in the viewport after the scroll')
    assert.equal(
      scrolled.observation.truncated,
      true,
      'the recorded proof observation keeps its honest truncated flag at the clamped budget',
    )

    // 4. Mirror the live assertion path: node-in-viewport passes.
    const asserted = await call(tools.qaAssert, {
      owner,
      kind: 'node-in-viewport',
      expected: { role: 'link', name: 'Deep Target' },
    })
    assert.equal(asserted.passed, true, JSON.stringify(asserted))

    // 5. Export: the scroll step must be PROVEN, not excluded.
    const exported = await call(tools.qaRecordExport, {
      owner,
      output_path: scenarioPath,
      name: 'fixture-deep-scroll',
    })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.excludedActions.length, 0)
    assert.equal(exported.scenario.steps.length, 1, 'exactly the scroll step')
    const [scrollStep] = exported.scenario.steps
    assert.equal(scrollStep.action.kind, 'scroll')
    assert.ok('target' in scrollStep.action, 'scroll is exported by target, not positionally')
    assert.equal(scrollStep.action.target.name, 'Deep Target')
    // QA-BL-064: NAME-only action target with the live role as an advisory hint.
    assert.equal(scrollStep.action.target.role, undefined)
    assert.equal(scrollStep.action.target.roleHint, 'link')
    assert.equal(scrollStep.assert.kind, 'node-in-viewport')
    assert.deepEqual(scrollStep.assert.expected, { role: 'link', name: 'Deep Target' })
    assert.match(
      scrollStep.intent,
      /Weak proof: .*truncated at the driver node budget/,
      'the truncation of the pre-action view must not be silently hidden in the intent',
    )

    const loaded = loadScenarioFromPath(scenarioPath)
    assert.deepEqual(loaded, exported.scenario)

    // 6. Replay twice; both runs PASS with byte-identical deterministic
    //    projections (replay has its own bounded escalation for resolution and
    //    assertion, unchanged by this fix).
    const projections = []
    for (let run = 0; run < 2; run += 1) {
      const replay = await call(tools.qaReplayRun, {
        scenario: scenarioPath,
        owner: 'deep-scroll-replay-' + run,
        headless: true,
      })
      assert.equal(replay.status, 'pass', 'replay ' + (run + 1) + ' must PASS: ' + JSON.stringify(replay.failure ?? {}))
      assert.equal(replay.steps.length, 1)
      assert.ok(replay.steps.every((step) => step.status === 'pass' && step.assertionPassed === true))
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
