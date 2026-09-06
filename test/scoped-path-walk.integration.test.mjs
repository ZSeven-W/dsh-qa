// QA-BL-069 closed loop against a REAL headless Chrome, over the real tool
// surface (createQaTools): the Wikipedia History_of_China defect shape —
// an identity-anchored scoped scroll whose container (navigation
// "Navbox291") sits inside a COLLAPSIBLE content-named sidebar (role
// navigation, no aria-label: its accessible name concatenates its children's
// text and changes with the hide/show toggle between page loads, via
// ?collapsed=1 — carried in the launch PATH here, /collapsed, because the
// recorder's replay-URL projection rejects query strings). The recorded ancestor PATH therefore records { role, tag }
// ONLY (the aggregated name is order-fragile, QA-BL-069), replay walks the
// path TOP-DOWN (the whole-page top level is PROVISIONAL on a >100-node
// page, the container level is PROVEN inside the sidebar's complete scoped
// view), and both replay runs — different collapse states, different
// aggregated names — land INCONCLUSIVE_SCOPE deterministically, naming each
// level's resolution in report.md. The <100-node twin (?small=1) proves
// every level and PASSES twice with scopeResolution 'proven'.
//
// RED (the defect): replay #1 (?collapsed=0, the recorded name matches) was
// 'inconclusive' while replay #2 (?collapsed=1, the aggregated name differs)
// FAILED with "no observable node matches the assertion scope, and the view
// was still truncated ... (INCONCLUSIVE_TRUNCATED)" — the exact-name path
// failed intermittently and zero-in-a-truncated-view was misclassified as a
// definite failure. This test pins the two-run DETERMINISTIC inconclusive
// pair instead.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverInstalledBrowser } from '@zseven-w/dsh-browser'
import { loadScenarioFromPath } from '../src/replay/index.ts'
import { createQaTools, QaToolHost } from '../src/tools.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NAV_HTML = join(ROOT, 'fixtures', 'web', 'scoped-path-nav.html')

const TARGET = { role: 'link', name: 'Qing dynasty' }
const NAVBOX = { role: 'navigation', name: 'Navbox291' }
// The durable path item (QA-BL-069): role + tag, the fragile aggregated name
// deliberately omitted.
const SIDEBAR_ITEM = { role: 'navigation', tag: 'nav' }

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scoped-path-'))
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
    scopeLevels: step.scopeLevels,
    observed: step.observed,
    expected: step.expected,
  }))
}

/** Record the owner flow: whole-page -> sidebar -> Navbox291 -> scroll -> assert -> export. */
async function recordFlow(t, fixture, tools, call, owner, scenarioPath, launchUrl = fixture.origin, expectTruncated = true) {
  const started = await call(tools.qaSessionStart, { owner, driver: 'browser', url: launchUrl, headless: true })
  assert.equal(started.headless, true)

  // 1. The collapsible sidebar is inside the window; on the large page the
  //    whole page exceeds the clamped 100-node budget and the target link
  //    sits beyond it, while the small page fits completely.
  const whole = await call(tools.qaObserve, { owner, max_nodes: 100 })
  assert.equal(whole.truncated, expectTruncated, expectTruncated ? 'the fixture must exceed the 100-node budget' : 'the small fixture must fit the window completely')
  const sidebarNode = whole.nodes.find(
    (item) => item.role === 'navigation' && item.tag === 'nav' && item.name.length > 80,
  )
  assert.ok(sidebarNode, 'the collapsible sidebar (aggregated name) is inside the window: ' + JSON.stringify(whole.nodes.map((item) => ({ role: item.role, name: (item.name || '').slice(0, 30), tag: item.tag }))))
  assert.match(sidebarNode.name, /hide/, 'the EXPANDED state name includes the hide-toggle text')
  if (expectTruncated) {
    assert.equal(
      whole.nodes.some((item) => item.role === TARGET.role && item.name === TARGET.name),
      false,
      'the target sits beyond the clamped 100-node whole-page window',
    )
  } else {
    const wholeTarget = whole.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
    assert.ok(wholeTarget, 'the small page returns the target whole-page')
    assert.equal(wholeTarget.inViewport, false, 'the target is below the fold on the small page')
  }

  // 2. Scope into the sidebar: the Navbox291 container becomes reachable.
  const scopedSidebar = await call(tools.qaObserve, { owner, within_ref: sidebarNode.ref, max_nodes: 100 })
  assert.equal(scopedSidebar.truncated, false, 'the sidebar subtree fits its budget completely')
  const navboxNode = scopedSidebar.nodes.find((item) => item.role === NAVBOX.role && item.name === NAVBOX.name)
  assert.ok(navboxNode, 'the scoped sidebar view returns the Navbox291 container')

  // 3. Scope into Navbox291: the target link becomes reachable.
  const scopedNavbox = await call(tools.qaObserve, { owner, within_ref: navboxNode.ref })
  assert.equal(scopedNavbox.truncated, false, 'the container subtree fits completely')
  const target = scopedNavbox.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
  assert.ok(target, 'the scoped container view returns the target')
  assert.equal(target.inViewport, false, 'the target starts below the fold')

  // 4. Scroll to the ref taken from the SCOPED view: the driver retains the
  //    consumed scope root, the scoped proof is ACCEPTED on the identity
  //    anchor, and the result carries proofScope + anchor.
  const scrolled = await call(tools.qaAct, { owner, action: 'scroll', ref: target.ref })
  assert.equal(scrolled.outcome, 'ok', JSON.stringify(scrolled))
  assert.equal(scrolled.receipt.status, 'confirmed')
  assert.deepEqual(scrolled.proofScope, NAVBOX, 'the proof names the Navbox291 container')
  assert.ok(scrolled.anchor, 'the accepted proof carries the driver identity anchor')
  assert.equal(scrolled.anchor.connected, true)
  assert.equal(scrolled.anchor.contained, true, 'containment was measured against the retained Navbox291 root')
  const inView = scrolled.observation.nodes.find((item) => item.ref === scrolled.anchor.ref)
  assert.ok(inView, 'the anchored node is emitted with its fresh ref')
  assert.equal(inView.name, TARGET.name)
  assert.equal(inView.inViewport, true, 'the anchored node is in the viewport after the scroll')

  // 5. qa_assert through the RESULT observation's fresh scope.rootRef.
  const asserted = await call(tools.qaAssert, {
    owner,
    kind: 'node-in-viewport',
    expected: TARGET,
    within_ref: scrolled.observation.scope.rootRef,
  })
  assert.equal(asserted.passed, true, JSON.stringify(asserted))

  // 6. Export: the scoped step rides WITH the scope and the durable ancestor
  //    path (the fragile aggregated name is omitted).
  const exported = await call(tools.qaRecordExport, {
    owner,
    output_path: scenarioPath,
    name: 'scoped-path-nav',
  })
  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(exported.excludedActions.length, 0, JSON.stringify(exported.excludedActions))
  assert.equal(exported.scenario.steps.length, 1)
  const [step] = exported.scenario.steps
  assert.equal(step.action.kind, 'scroll')
  assert.equal(step.assert.kind, 'node-in-viewport')
  assert.deepEqual(step.assert.expected, TARGET)
  const loaded = loadScenarioFromPath(scenarioPath)
  assert.deepEqual(loaded, exported.scenario)
  await call(tools.qaSessionStop, { owner })
  return exported
}

test('collapsible-sidebar scoped scroll on a >100-node page: the durable path replays INCONCLUSIVE twice across collapse states (QA-BL-069)', { timeout: 300_000 }, async (t) => {
  let fixture
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  fixture = await withFixture(t, NAV_HTML)
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const call = (definition, args) => definition.execute(args, { agent: { id: 'scoped-path-nav-agent' } })
  try {
    const scenarioPath = join(fixture.dir, 'scoped-path-nav.json')
    const exported = await recordFlow(t, fixture, tools, call, 'scoped-path-nav', scenarioPath)
    const scenarioJson = JSON.parse(await readFile(scenarioPath, 'utf8'))

    // 7. Replay twice with DIFFERENT collapse states (the aggregated sidebar
    //    name differs between loads): both must be INCONCLUSIVE_SCOPE,
    //    deterministically — the top level is provisional (truncated whole
    //    page), the container level proven (complete scoped view), and the
    //    fragile name is never compared.
    const projections = []
    const replays = {}
    for (const [label, suffix] of [['expanded', ''], ['collapsed', '/collapsed']]) {
      const runScenarioPath = join(fixture.dir, 'scoped-path-nav-' + label + '.json')
      await writeFile(
        runScenarioPath,
        JSON.stringify({ ...scenarioJson, target: { ...scenarioJson.target, launch: fixture.origin + suffix } }, null, 2) + '\n',
      )
      const replay = await call(tools.qaReplayRun, {
        scenario: runScenarioPath,
        owner: 'scoped-path-nav-replay-' + label,
        headless: true,
        outputDir: join(fixture.dir, 'nav-report-' + label),
      })
      // The status assertions run FIRST so the RED defect surfaces as the
      // two-run mismatch (run 1 inconclusive, run 2 fail on the exact-name
      // path) instead of stopping on the missing scopeLevels field.
      assert.equal(
        replay.status,
        'inconclusive',
        label + ' replay must be INCONCLUSIVE, never fail, never pass: ' + JSON.stringify(replay.failure ?? {}),
      )
      assert.equal(replay.steps.length, 1)
      const step = replay.steps[0]
      assert.equal(step.status, 'inconclusive', label)
      assert.equal(step.assertionPassed, false, label)
      assert.equal(step.reason, 'INCONCLUSIVE_SCOPE', label)
      assert.equal(step.scopeResolution, 'provisional', label)
      assert.deepEqual(
        step.observed.map((item) => ({ role: item.role, name: item.name })),
        [TARGET],
        label + ': the verifying read still reports the target (transparency)',
      )
      assert.equal(replay.assertions[0].passed, false, label)
      assert.equal(replay.assertions[0].reason, 'INCONCLUSIVE_SCOPE', label)
      assert.equal(replay.assertions[0].scopeResolution, 'provisional', label)
      assert.equal(replay.failure, undefined, label + ': nothing definitely failed')
      const md = await readFile(join(fixture.dir, 'nav-report-' + label, 'report.md'), 'utf8')
      assert.match(md, /Status\*\*: inconclusive/)
      assert.match(md, /INCONCLUSIVE_SCOPE/, label + ': report.md says WHY the step is inconclusive')
      assert.match(md, /scope resolution: provisional/)
      projections.push(projection(replay.steps))
      replays[label] = { step, md }
    }
    assert.deepEqual(projections[0], projections[1], 'the two collapse-state replays are deterministic')

    // Per-level resolutions + report.md level naming, asserted AFTER the
    // two-run status checks (RED stops at the mismatch first).
    for (const label of ['expanded', 'collapsed']) {
      const { step, md } = replays[label]
      assert.deepEqual(
        step.scopeLevels,
        [
          { level: 1, what: 'role "navigation", tag "nav"', resolution: 'provisional' },
          { level: 2, what: 'role "navigation", name "Navbox291"', resolution: 'proven' },
        ],
        label + ': the top level is provisional (truncated whole page), the container level proven (complete scoped view)',
      )
      assert.match(
        md,
        /scope levels: level 1 \(role "navigation", tag "nav"\): provisional; level 2 \(role "navigation", name "Navbox291"\): proven/,
        label + ': report.md names each level\'s resolution',
      )
    }

    // 8. The exported scope (asserted AFTER the replays so the RED defect
    //    surfaces as the two-run mismatch first): the durable name-less path.
    const [step] = exported.scenario.steps
    assert.deepEqual(
      step.assert.scope,
      { role: 'navigation', name: 'Navbox291', path: [SIDEBAR_ITEM] },
      'the exported path records { role, tag } ONLY — the fragile aggregated name is omitted',
    )
    assert.match(step.intent, /PROVISIONAL/, 'the export is explicitly provisional (the top level can never be proven on this page)')
  } finally {
    await host.dispose()
    await fixture.close()
  }
})

test('the SAME shape on a <100-node page (?small=1): every level PROVEN -> PASS twice with scopeResolution proven', { timeout: 300_000 }, async (t) => {
  let fixture
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  fixture = await withFixture(t, NAV_HTML)
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const call = (definition, args) => definition.execute(args, { agent: { id: 'scoped-path-nav-small-agent' } })
  try {
    const recordOrigin = fixture.origin + '/small'
    const scenarioPath = join(fixture.dir, 'scoped-path-nav-small.json')
    const exported = await recordFlow(t, fixture, tools, call, 'scoped-path-nav-small', scenarioPath, recordOrigin, false)
    const scenarioJson = JSON.parse(await readFile(scenarioPath, 'utf8'))

    // The small page completes: the whole-page top level and the container
    // level are both PROVEN, so the export is DURABLE (no PROVISIONAL
    // weakness) — the QA-BL-069 walk supersedes the old flat judgment that
    // called this provisional because the action's baseline was the
    // container's own subtree.
    const [step] = exported.scenario.steps
    assert.deepEqual(
      step.assert.scope,
      { role: 'navigation', name: 'Navbox291', path: [SIDEBAR_ITEM] },
    )
    assert.doesNotMatch(step.intent, /PROVISIONAL/, 'a per-level proven export carries no provisional weakness')

    const projections = []
    for (const [label, suffix] of [['expanded', '/small'], ['collapsed', '/small/collapsed']]) {
      const runScenarioPath = join(fixture.dir, 'scoped-path-nav-small-' + label + '.json')
      await writeFile(
        runScenarioPath,
        JSON.stringify({ ...scenarioJson, target: { ...scenarioJson.target, launch: fixture.origin + suffix } }, null, 2) + '\n',
      )
      const replay = await call(tools.qaReplayRun, {
        scenario: runScenarioPath,
        owner: 'scoped-path-nav-small-replay-' + label,
        headless: true,
        outputDir: join(fixture.dir, 'small-report-' + label),
      })
      assert.equal(replay.status, 'pass', label + ': ' + JSON.stringify(replay.failure ?? {}))
      assert.equal(replay.steps.length, 1)
      assert.equal(replay.steps[0].status, 'pass', label)
      assert.equal(replay.steps[0].assertionPassed, true, label)
      assert.equal(replay.steps[0].reason, undefined, label)
      assert.equal(replay.steps[0].scopeResolution, 'proven', label)
      assert.deepEqual(
        replay.steps[0].scopeLevels,
        [
          { level: 1, what: 'role "navigation", tag "nav"', resolution: 'proven' },
          { level: 2, what: 'role "navigation", name "Navbox291"', resolution: 'proven' },
        ],
        label + ': every level proven',
      )
      assert.equal(replay.assertions[0].passed, true, label)
      assert.equal(replay.assertions[0].scopeResolution, 'proven', label)
      assert.equal(replay.failure, undefined, label)
      projections.push(projection(replay.steps))
    }
    assert.deepEqual(projections[0], projections[1], 'the two collapse-state replays are deterministic')
  } finally {
    await host.dispose()
    await fixture.close()
  }
})
