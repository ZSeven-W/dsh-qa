// QA-BL-050 re-enabled via B3 (contract v9 identity anchor) — closed loop
// against a REAL headless Chrome: a page whose unique scroll target sits at
// whole-page emitted position 102 (beyond the driver's CLAMPED 100-node
// window, so no whole-page budget can ever return it) but inside a region
// container at position 42. CHANGED (Phase B, B3): the exclusion this file
// pinned in Phase A (QA-BL-055) FLIPS BACK to the positive outcome — the
// record-time escalation is again SCOPED, but now identity-safe: the
// container is picked by walking the target's parentRef chain in the BASELINE
// observation, and the escalated scoped read is accepted ONLY on the driver's
// identity anchor (anchorLastAction: the ORIGINAL acted element is connected,
// contained in the within subtree, emitted with a fresh ref, and that
// anchored node is in the viewport) — never on a role+name+tag re-match.
// Export yields a scoped node-in-viewport step under the EXPLICITLY
// PROVISIONAL gate (the scoped baseline is the container's own subtree, so
// uniqueness was never proven; QA-BL-062), and replay is INCONCLUSIVE twice
// deterministically: the >100-node page can never complete, so the container
// is resolved provisionally and the step carries INCONCLUSIVE_SCOPE /
// scopeResolution 'provisional' — never a pass.
//
// Explore flow: whole-page observe (find the container) -> scoped observe
// within the container (find the target's ref) -> scroll to the ref -> the
// recording session takes exactly ONE anchor-verified SCOPED escalated read
// and records it as the proof -> export -> replay twice.

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

test('explore a container-scoped deep scroll target -> scoped node-in-viewport step -> replay INCONCLUSIVE twice (QA-BL-062)', { timeout: 300_000 }, async (t) => {
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
    //    target's ref (exactly like a scoped Explore read). The within ref
    //    must come from the CURRENT (latest) observation — the wide observe
    //    above consumed the initial one's refs.
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
    assert.ok(
      typeof scoped.scope?.rootRef === 'string',
      'the scoped observation carries the fresh rootRef (contract v9)',
    )
    assert.equal(scoped.truncated, false, 'the container subtree fits the subtree budget completely')
    const target = scoped.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
    assert.ok(target, 'the scoped view returns the unique target')
    assert.equal(target.inViewport, false, 'the target starts below the fold')
    assert.ok(
      'parentRef' in target && target.parentRef !== null,
      'the target carries its composed ancestry (contract v9)',
    )

    // 3. Scroll to the target's ref. CHANGED (B3): the record-time escalation
    //    takes the ONE SCOPED read rooted at the parentRef-derived container
    //    and is accepted on the identity anchor — so the deep target IS
    //    proven, qa_act shows proofEscalated, and the recorded proof is the
    //    SCOPED escalated view.
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

    // 4. Export: the scroll step is exported with the container scope under
    //    the explicitly PROVISIONAL gate, never excluded and never silently
    //    downgraded to a whole-page proof. The fixture container has NO
    //    emitted ancestor (its DOM parent <main> carries no [role]
    //    attribute), so no faithful ancestor path exists and scope.path is
    //    omitted (the fail-closed rule: never manufacture a path from a
    //    scoped root's parentRef:null).
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
      'the scoped proof exports with the container scope (no path: the container has no emitted ancestry in this fixture)',
    )
    assert.match(
      scrollStep.intent,
      /PROVISIONAL/,
      'the export is explicitly provisional: uniqueness was never proven at record time (the baseline is the container\'s own subtree)',
    )

    const loaded = loadScenarioFromPath(scenarioPath)
    assert.deepEqual(loaded, exported.scenario)

    // 5. Replay twice; both runs are INCONCLUSIVE with byte-identical
    //    deterministic projections: the whole page can never complete, so the
    //    container resolution is provisional and the step is INCONCLUSIVE_SCOPE
    //    — never a pass, and nothing definitely failed. report.md says WHY.
    const projections = []
    for (let run = 0; run < 2; run += 1) {
      const replay = await call(tools.qaReplayRun, {
        scenario: scenarioPath,
        owner: 'scoped-deep-scroll-replay-' + run,
        headless: true,
        outputDir: join(dir, 'deep-report-' + run),
      })
      assert.equal(
        replay.status,
        'inconclusive',
        'replay ' + (run + 1) + ' must be INCONCLUSIVE, never PASS: ' + JSON.stringify(replay.failure ?? {}),
      )
      assert.equal(replay.steps.length, 1)
      assert.equal(replay.steps[0].status, 'inconclusive')
      assert.equal(replay.steps[0].assertionPassed, false, 'a provisionally resolved scope is never passed:true')
      assert.equal(replay.steps[0].reason, 'INCONCLUSIVE_SCOPE')
      assert.equal(replay.steps[0].scopeResolution, 'provisional')
      assert.deepEqual(
        replay.steps[0].completeness?.scope,
        CONTAINER,
        'the replay step was decided inside the container scope',
      )
      assert.deepEqual(
        replay.steps[0].observed.map((item) => ({ role: item.role, name: item.name })),
        [TARGET],
        'the verifying read returned the target in the viewport (transparently recorded)',
      )
      assert.equal(replay.assertions[0].passed, false, 'the copied final assertion inherits the provisional outcome')
      assert.equal(replay.assertions[0].reason, 'INCONCLUSIVE_SCOPE')
      assert.equal(replay.assertions[0].scopeResolution, 'provisional')
      assert.equal(replay.failure, undefined, 'nothing definitely failed: no failure block')
      const md = await readFile(join(dir, 'deep-report-' + run, 'report.md'), 'utf8')
      assert.match(md, /Status\*\*: inconclusive/, 'report.md states the three-state status')
      assert.match(md, /INCONCLUSIVE_SCOPE/, 'report.md says WHY the step is inconclusive')
      assert.match(md, /scope resolution: provisional/)
      projections.push(replay.steps.map((step) => ({
        index: step.index,
        status: step.status,
        intent: step.intent,
        action: step.action,
        assertionPassed: step.assertionPassed,
        reason: step.reason,
        scopeResolution: step.scopeResolution,
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
