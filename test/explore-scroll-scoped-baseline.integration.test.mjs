// QA-BL-067 closed loop against a REAL headless Chrome, over the real tool
// surface (createQaTools). A scroll acted from a SCOPED baseline (the acted
// ref came from a scoped qa_observe) takes its proof settle INSIDE the
// baseline's container. FLIPPED for the real driver at contract v9,
// dsh-browser d069f4f: a dispatched action that consumed a SCOPED observation
// and did NOT navigate RETAINS that observation's scope root until the next
// successful observe, so the first proof poll — keyed by the EXPLICIT baseline
// scope.rootRef (deliberately not 'last-scope': a stale baseline must be
// refused, never silently rebound to whatever root was last acted and judged
// contained inside the WRONG container) — resolves through the retained
// handle, consumes the retention, and mints the fresh scope.rootRef the
// settle loop re-keys every later poll to. The accepted proof surfaces as
// proofScope + anchor on the qa_act result, the recorder binds the scoped
// observation as the action's proof, and the export carries the scope with
// scope.path. Three real-Chrome outcomes, plus the converted fallback:
//
//  1. SCOPED-BASELINE-SMALL (fixtures/web/scoped-baseline-small.html): the
//     whole page fits the default window COMPLETELY, so replay PROVES the
//     container unique and the run PASSES twice (scopeResolution proven).
//  2. SCOPED-BASELINE-DEEP (fixtures/web/scoped-baseline-deep-target.html):
//     the Wikipedia History_of_China shape — the container sits beyond the
//     60-node settle window and the target beyond the CLAMPED 100-node
//     whole-page maximum. The scoped proof is ACCEPTED (proofScope names the
//     container, anchor.contained:true, the anchored node inViewport:true),
//     qa_assert(within_ref = the result observation's scope.rootRef) passes,
//     the export carries the scope with scope.path, and qa_replay_run is
//     INCONCLUSIVE twice, deterministically (QA-BL-062 provisional rules).
//  3. SCOPED-BASELINE-NAVBOX (fixtures/web/scoped-baseline-navbox.html): the
//     Wikipedia-shaped NAVBOX case over the REAL MCP surface — the navbox-like
//     container sits at emitted position 101, BEYOND the clamped 100-node
//     whole-page window, reachable only by scoping to its zone ancestor
//     (position 100). Full loop: qa_observe -> qa_observe(within_ref) ->
//     qa_act scroll to a ref from the scoped view -> proofScope/anchor ->
//     qa_assert(within_ref = result scope.rootRef) -> qa_record_export (scope
//     with scope.path) -> qa_replay_run x2 INCONCLUSIVE. Local fixture: no
//     network.
//  4. The disclosed FALLBACK that remains on the real driver: a scroll acted
//     ON the scope root itself. The driver's design note (d069f4f): the root's
//     handle is single-owner, so retention is NOT created — the explicit
//     rootRef attempt refuses OBSERVATION_REQUIRED, disclosed as
//     escalationRefused { reason: 'container-not-in-view', code:
//     'OBSERVATION_REQUIRED' }, and the whole-page fallback proves the scroll.
//     The driver-WITHOUT-retention fallback and the navigation-released
//     SCOPE_UNAVAILABLE refusal are pinned with fake adapters in
//     test/scroll-proof-scoped-baseline.test.mjs.

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
const NAVBOX_HTML = join(ROOT, 'fixtures', 'web', 'scoped-baseline-navbox.html')

const TARGET = { role: 'link', name: 'Deep Target' }
const CONTAINER = { role: 'region', name: 'Deep zone' }
const WRAPPER = { role: 'region', name: 'Deep zone wrapper' }
const NAVBOX = { role: 'navigation', name: 'History of China' }
// The recorded ancestor path both fixtures now record: the wrapper region is
// the container's emitted ancestor in the whole-page view (the stronger
// replay locator, outermost first).
const SCOPE_WITH_PATH = { role: 'region', name: 'Deep zone', path: [WRAPPER] }
// The converted fallback condition on the REAL driver (single-owner handle:
// the acted ref IS the scope root, so no retention is ever created).
const ROOT_ACTED_REFUSAL = { reason: 'container-not-in-view', code: 'OBSERVATION_REQUIRED' }

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
    scopeResolution: step.scopeResolution,
    escalationRefused: step.escalationRefused,
    observed: step.observed,
    expected: step.expected,
  }))
}

test('scoped-baseline scroll on a COMPLETE page is PROVEN inside the baseline scope (proofScope + anchor) and replays PASS twice', { timeout: 300_000 }, async (t) => {
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

    // 1. Whole page -> scoped view: the acted ref comes from the SCOPED
    //    baseline, and the container carries real emitted ancestry (the
    //    wrapper region) so export records the ancestor PATH.
    const whole = await call(tools.qaObserve, { owner })
    assert.equal(whole.truncated, false, 'the small fixture fits the default window completely')
    const containerNode = whole.nodes.find((item) => item.role === CONTAINER.role && item.name === CONTAINER.name)
    assert.ok(containerNode, JSON.stringify(whole.nodes.map((node) => node.name)))
    assert.ok(
      typeof containerNode.parentRef === 'string' && containerNode.parentRef !== '',
      'the container carries real emitted ancestry (the wrapper region)',
    )
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

    // 2. Scroll to the ref taken from the SCOPED view. FLIPPED (driver
    //    d069f4f): the dispatched action RETAINS the consumed scope root, so
    //    the scoped proof read — first poll rooted at the explicit baseline
    //    scope.rootRef through the retention, then re-keyed per poll to the
    //    freshly minted rootRef — is ACCEPTED on the identity anchor. No
    //    refusal (the old OBSERVATION_REQUIRED disclosure is GONE), no
    //    escalation.
    const scrolled = await call(tools.qaAct, { owner, action: 'scroll', ref: target.ref })
    assert.equal(scrolled.outcome, 'ok', JSON.stringify(scrolled))
    assert.equal(scrolled.receipt.status, 'confirmed')
    assert.equal(scrolled.escalationRefused, undefined, 'an accepted scoped proof is never a refusal (FLIPPED: was container-not-in-view/OBSERVATION_REQUIRED)')
    assert.deepEqual(scrolled.proofScope, CONTAINER, 'the result names the proof scope (role + name)')
    assert.ok(scrolled.anchor, 'the accepted proof carries the driver identity anchor')
    assert.equal(scrolled.anchor.connected, true, 'the ORIGINAL acted element is connected')
    assert.equal(scrolled.anchor.contained, true, 'containment was measured against the retained scope root')
    assert.equal(typeof scrolled.anchor.ref, 'string', 'the anchor ref is the acted element fresh ref in this observation')
    assert.equal(scrolled.proofEscalated, undefined, 'no escalation ran: the scoped proof decided on its own')
    assert.deepEqual(
      scrolled.observation.scope === undefined
        ? undefined
        : { role: scrolled.observation.scope.role, name: scrolled.observation.scope.name },
      CONTAINER,
      'the proof observation is the SCOPED settled view',
    )
    assert.equal(typeof scrolled.observation.scope.rootRef, 'string', 'the proof observation mints a fresh rootRef')
    assert.notEqual(scrolled.observation.scope.rootRef, scoped.scope.rootRef, 'the settle loop re-keyed onto the fresh rootRef, never the baseline one')
    assert.equal(scrolled.observation.truncated, false, 'the container subtree stays complete')
    const inView = scrolled.observation.nodes.find((item) => item.ref === scrolled.anchor.ref)
    assert.ok(inView, 'the anchored node is emitted with its fresh ref')
    assert.equal(inView.role, TARGET.role)
    assert.equal(inView.name, TARGET.name)
    assert.equal(inView.inViewport, true, 'the anchored node is in the viewport')

    // 3. The live assertion passes against the RESULT observation's fresh
    //    scope.rootRef, and the export carries the scope WITH the recorded
    //    ancestor path.
    const asserted = await call(tools.qaAssert, {
      owner,
      kind: 'node-in-viewport',
      expected: TARGET,
      within_ref: scrolled.observation.scope.rootRef,
    })
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
    assert.deepEqual(
      step.assert.scope,
      SCOPE_WITH_PATH,
      'the scoped proof exports WITH its scope and the recorded ancestor path',
    )
    assert.equal(step.escalationRefused, undefined, 'no refusal rides on an accepted proof step')
    assert.match(step.intent, /PROVISIONAL/, "uniqueness was never proven at record time (the baseline is the container's own subtree)")
    const loaded = loadScenarioFromPath(scenarioPath)
    assert.deepEqual(loaded, exported.scenario)

    // 4. Replay twice: PASS with scopeResolution proven — the COMPLETE
    //    whole-page view proves the container unique (QA-BL-062 rules).
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
      assert.equal(replay.steps[0].scopeResolution, 'proven', 'the container is unique in a complete whole-page view')
      assert.equal(replay.steps[0].escalationRefused, undefined)
      projections.push(projection(replay.steps))
    }
    assert.deepEqual(projections[0], projections[1], 'two replays are deterministic')
    await call(tools.qaSessionStop, { owner })
  } finally {
    await host.dispose()
    await fixture.close()
  }
})

test('scoped-baseline scroll with the target beyond every whole-page window is PROVEN inside the baseline scope and replays INCONCLUSIVE twice (the Wikipedia shape)', { timeout: 300_000 }, async (t) => {
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
    assert.ok(
      wide.nodes.some((item) => item.role === WRAPPER.role && item.name === WRAPPER.name),
      'the wrapper ancestor is inside the 100-node window (it records the ancestor path)',
    )

    // 2. Scoped view -> scroll to the ref taken from it. FLIPPED (driver
    //    d069f4f): the retained scope root resolves the first proof poll, so
    //    the scoped proof is ACCEPTED — the old target-not-returned
    //    disclosure is GONE, and the step that used to be excluded is now
    //    PROVEN inside the container.
    const scoped = await call(tools.qaObserve, { owner, within_ref: containerNode.ref, max_nodes: 100 })
    assert.equal(scoped.truncated, false, 'the container subtree fits completely')
    const target = scoped.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
    assert.ok(target, 'the scoped view returns the target')
    assert.equal(target.inViewport, false)
    const scrolled = await call(tools.qaAct, { owner, action: 'scroll', ref: target.ref })
    assert.equal(scrolled.outcome, 'ok', JSON.stringify(scrolled))
    assert.equal(scrolled.receipt.status, 'confirmed')
    assert.equal(
      scrolled.escalationRefused,
      undefined,
      'FLIPPED: the scoped proof read resolves through the retained scope root (was container-not-in-view / target-not-returned)',
    )
    assert.deepEqual(scrolled.proofScope, CONTAINER, 'the result names the proof scope (role + name)')
    assert.ok(scrolled.anchor, 'the accepted proof carries the driver identity anchor')
    assert.equal(scrolled.anchor.connected, true)
    assert.equal(scrolled.anchor.contained, true, 'containment was measured against the retained scope root')
    const inView = scrolled.observation.nodes.find((item) => item.ref === scrolled.anchor.ref)
    assert.ok(inView, 'the anchored node is emitted with its fresh ref')
    assert.equal(inView.name, TARGET.name)
    assert.equal(inView.inViewport, true, 'the anchored node is in the viewport after the scroll')
    assert.equal(scrolled.proofEscalated, undefined, 'no escalation ran')
    assert.deepEqual(
      scrolled.observation.scope === undefined
        ? undefined
        : { role: scrolled.observation.scope.role, name: scrolled.observation.scope.name },
      CONTAINER,
      'the proof observation is the SCOPED settled view, never a whole-page view',
    )
    assert.equal(typeof scrolled.observation.scope.rootRef, 'string')
    assert.notEqual(scrolled.observation.scope.rootRef, scoped.scope.rootRef, 'the settle loop re-keyed onto the fresh rootRef')
    assert.equal(scrolled.observation.truncated, false, 'the container subtree stays complete')

    // 3. The live assertion passes against the RESULT observation's fresh
    //    scope.rootRef (the exact Wikipedia-case flow).
    const asserted = await call(tools.qaAssert, {
      owner,
      kind: 'node-in-viewport',
      expected: TARGET,
      within_ref: scrolled.observation.scope.rootRef,
    })
    assert.equal(asserted.passed, true, JSON.stringify(asserted))

    // 4. Export: FLIPPED — the proven scoped step IS exported, with the scope
    //    and the recorded ancestor path (was: ok:false NO_PROVEN_STEPS with
    //    the action excluded as ASSERTION_NOT_PROVABLE).
    const scenarioPath = join(fixture.dir, 'scoped-baseline-deep.json')
    const exported = await call(tools.qaRecordExport, {
      owner,
      output_path: scenarioPath,
      name: 'scoped-baseline-deep',
    })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.excludedActions.length, 0)
    assert.equal(exported.scenario.steps.length, 1)
    const [step] = exported.scenario.steps
    assert.equal(step.action.kind, 'scroll')
    assert.equal(step.assert.kind, 'node-in-viewport')
    assert.deepEqual(step.assert.expected, TARGET)
    assert.deepEqual(
      step.assert.scope,
      SCOPE_WITH_PATH,
      'the scoped proof exports WITH its scope and the recorded ancestor path',
    )
    assert.equal(step.escalationRefused, undefined, 'no refusal rides on an accepted proof step')
    assert.match(step.intent, /PROVISIONAL/, 'explicitly provisional: the whole page can never complete (QA-BL-062)')
    const loaded = loadScenarioFromPath(scenarioPath)
    assert.deepEqual(loaded, exported.scenario)

    // 5. Replay twice: INCONCLUSIVE, deterministically. The whole page can
    //    never complete, so the container resolution is provisional and the
    //    step is INCONCLUSIVE_SCOPE — never a pass, nothing definitely
    //    failed. report.md says WHY.
    const projections = []
    for (let run = 0; run < 2; run += 1) {
      const replay = await call(tools.qaReplayRun, {
        scenario: scenarioPath,
        owner: 'scoped-baseline-deep-replay-' + run,
        headless: true,
        outputDir: join(fixture.dir, 'deep-report-' + run),
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
      const md = await readFile(join(fixture.dir, 'deep-report-' + run, 'report.md'), 'utf8')
      assert.match(md, /Status\*\*: inconclusive/, 'report.md states the three-state status')
      assert.match(md, /INCONCLUSIVE_SCOPE/, 'report.md says WHY the step is inconclusive')
      assert.match(md, /scope resolution: provisional/)
      projections.push(projection(replay.steps))
    }
    assert.deepEqual(projections[0], projections[1], 'two replays are deterministic')
    await call(tools.qaSessionStop, { owner })
  } finally {
    await host.dispose()
    await fixture.close()
  }
})

test('Wikipedia-shaped NAVBOX case (QA-BL-067, real MCP surface): a navbox-like container beyond position 100 is reached by scoping, proven inside the scope, exported with scope.path, and replays INCONCLUSIVE twice', { timeout: 300_000 }, async (t) => {
  let fixture
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  fixture = await withFixture(t, NAVBOX_HTML)
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const call = (definition, args) => definition.execute(args, { agent: { id: 'scoped-baseline-navbox-agent' } })
  try {
    const owner = 'scoped-baseline-navbox'
    const started = await call(tools.qaSessionStart, { owner, driver: 'browser', url: fixture.origin, headless: true })
    assert.equal(started.headless, true)

    // 1. The navbox sits at emitted position 101 — BEYOND the clamped
    //    100-node whole-page window, exactly like a Wikipedia navbox at the
    //    tail of a long article: no whole-page read can ever return it. Its
    //    zone ancestor is the LAST node inside the window, so scoping is the
    //    only way in. No network: the whole page is a local fixture.
    const initial = await call(tools.qaObserve, { owner, max_nodes: 100 })
    assert.equal(initial.truncated, true, 'the fixture exceeds the clamped 100-node budget')
    assert.equal(
      initial.nodes.some((item) => item.role === NAVBOX.role && item.name === NAVBOX.name),
      false,
      'the navbox container sits beyond position 100: no whole-page read can return it',
    )
    const zoneNode = initial.nodes.find((item) => item.role === CONTAINER.role && item.name === CONTAINER.name)
    assert.ok(zoneNode, 'the zone ancestor is inside the 100-node window')
    assert.ok(
      typeof zoneNode.parentRef === 'string' && zoneNode.parentRef !== '',
      'the zone carries real emitted ancestry (the wrapper region)',
    )
    assert.equal(
      initial.nodes[initial.nodes.length - 1].ref,
      zoneNode.ref,
      'the zone is the window tail: the navbox is the very next emitted node',
    )

    // 2. Scope into the zone: the navbox container becomes reachable.
    const scoped = await call(tools.qaObserve, { owner, within_ref: zoneNode.ref, max_nodes: 100 })
    assert.equal(scoped.truncated, false, 'the zone subtree fits completely')
    const navboxNode = scoped.nodes.find((item) => item.role === NAVBOX.role && item.name === NAVBOX.name)
    assert.ok(navboxNode, 'the scoped view returns the navbox container')
    const target = scoped.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
    assert.ok(target, 'the scoped view returns the target inside the navbox')
    assert.equal(target.inViewport, false)

    // 3. Scroll to the ref taken from the SCOPED view: the driver retains the
    //    consumed scope root, the scoped proof is ACCEPTED on the identity
    //    anchor, and the result carries proofScope + anchor.
    const scrolled = await call(tools.qaAct, { owner, action: 'scroll', ref: target.ref })
    assert.equal(scrolled.outcome, 'ok', JSON.stringify(scrolled))
    assert.equal(scrolled.receipt.status, 'confirmed')
    assert.equal(scrolled.escalationRefused, undefined)
    assert.deepEqual(scrolled.proofScope, CONTAINER, 'the proof names the baseline scope (the zone)')
    assert.ok(scrolled.anchor, 'the accepted proof carries the driver identity anchor')
    assert.equal(scrolled.anchor.connected, true)
    assert.equal(scrolled.anchor.contained, true, 'containment was measured against the retained zone root')
    const inView = scrolled.observation.nodes.find((item) => item.ref === scrolled.anchor.ref)
    assert.ok(inView, 'the anchored node is emitted with its fresh ref')
    assert.equal(inView.name, TARGET.name)
    assert.equal(inView.inViewport, true, 'the anchored node is in the viewport after the scroll')

    // 4. qa_assert through the RESULT observation's fresh scope.rootRef.
    const asserted = await call(tools.qaAssert, {
      owner,
      kind: 'node-in-viewport',
      expected: TARGET,
      within_ref: scrolled.observation.scope.rootRef,
    })
    assert.equal(asserted.passed, true, JSON.stringify(asserted))

    // 5. Export: the scoped step rides WITH the scope and the recorded
    //    ancestor path (the wrapper chain).
    const scenarioPath = join(fixture.dir, 'scoped-baseline-navbox.json')
    const exported = await call(tools.qaRecordExport, {
      owner,
      output_path: scenarioPath,
      name: 'scoped-baseline-navbox',
    })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.excludedActions.length, 0)
    assert.equal(exported.scenario.steps.length, 1)
    const [step] = exported.scenario.steps
    assert.equal(step.action.kind, 'scroll')
    assert.equal(step.assert.kind, 'node-in-viewport')
    assert.deepEqual(step.assert.expected, TARGET)
    assert.deepEqual(step.assert.scope, SCOPE_WITH_PATH, 'the navbox-case export carries the scope with the recorded ancestor path')
    assert.match(step.intent, /PROVISIONAL/)
    const loaded = loadScenarioFromPath(scenarioPath)
    assert.deepEqual(loaded, exported.scenario)

    // 6. qa_replay_run twice: INCONCLUSIVE, deterministically (the page can
    //    never complete, so the scope resolves provisionally).
    const projections = []
    for (let run = 0; run < 2; run += 1) {
      const replay = await call(tools.qaReplayRun, {
        scenario: scenarioPath,
        owner: 'scoped-baseline-navbox-replay-' + run,
        headless: true,
        outputDir: join(fixture.dir, 'navbox-report-' + run),
      })
      assert.equal(replay.status, 'inconclusive', 'replay ' + (run + 1) + ': ' + JSON.stringify(replay.failure ?? {}))
      assert.equal(replay.steps.length, 1)
      assert.equal(replay.steps[0].status, 'inconclusive')
      assert.equal(replay.steps[0].assertionPassed, false)
      assert.equal(replay.steps[0].reason, 'INCONCLUSIVE_SCOPE')
      assert.equal(replay.steps[0].scopeResolution, 'provisional')
      assert.equal(replay.failure, undefined)
      projections.push(projection(replay.steps))
    }
    assert.deepEqual(projections[0], projections[1], 'two replays are deterministic')
    await call(tools.qaSessionStop, { owner })
  } finally {
    await host.dispose()
    await fixture.close()
  }
})

test('the disclosed fallback that REMAINS on the real driver: a scroll acted ON the scope root itself refuses OBSERVATION_REQUIRED (single-owner handle, no retention) and falls back whole-page', { timeout: 300_000 }, async (t) => {
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
  const call = (definition, args) => definition.execute(args, { agent: { id: 'scoped-baseline-root-agent' } })
  try {
    const owner = 'scoped-baseline-root-acted'
    const started = await call(tools.qaSessionStart, { owner, driver: 'browser', url: fixture.origin, headless: true })
    assert.equal(started.headless, true)

    const whole = await call(tools.qaObserve, { owner })
    const containerNode = whole.nodes.find((item) => item.role === CONTAINER.role && item.name === CONTAINER.name)
    assert.ok(containerNode)
    const scoped = await call(tools.qaObserve, { owner, within_ref: containerNode.ref })

    // The acted ref IS the scope root itself. Driver design note (d069f4f):
    // the root's handle is single-owner, so retention is deliberately NOT
    // created — the explicit-rootRef proof attempt refuses
    // OBSERVATION_REQUIRED, disclosed with the fixed vocabulary, and the
    // whole-page fallback proves the scroll on its own. This is the converted
    // "conditions that still produce a fallback" pin on the REAL driver; the
    // retention-less-driver and navigation-released SCOPE_UNAVAILABLE pins
    // live with fake adapters in test/scroll-proof-scoped-baseline.test.mjs.
    const scrolled = await call(tools.qaAct, { owner, action: 'scroll', ref: scoped.scope.rootRef })
    assert.equal(scrolled.outcome, 'ok', JSON.stringify(scrolled))
    assert.equal(scrolled.receipt.status, 'confirmed')
    assert.deepEqual(
      scrolled.escalationRefused,
      ROOT_ACTED_REFUSAL,
      "no retention for the acted root itself: the disclosed fallback keeps today's vocabulary",
    )
    assert.equal(scrolled.proofScope, undefined)
    assert.equal(scrolled.anchor, undefined)
    assert.equal(scrolled.observation.scope, undefined, 'the proof is the whole-page settled view')
    assert.equal(scrolled.observation.truncated, false, 'the small page stays complete whole-page')
    const inView = scrolled.observation.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
    assert.ok(inView, 'the whole-page fallback returns the target')
    assert.equal(inView.inViewport, true, 'the scroll is proven whole-page')
    await call(tools.qaSessionStop, { owner })
  } finally {
    await host.dispose()
    await fixture.close()
  }
})
