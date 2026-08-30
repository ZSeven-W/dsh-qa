// Flagship WP14 closed loop: real Headless Chrome explore-with-scroll reaches a
// below-the-fold form, selects an option, hover-reveals and clicks a menu item,
// then qa_record_export produces a valid scenario and qa_replay_run passes twice
// deterministically WITHOUT hand-editing the exported file.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverInstalledBrowser } from '@zseven-w/dsh-browser'
import { loadScenarioFromPath } from '../src/replay/index.ts'
import { createQaTools, QaToolHost } from '../src/tools.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_HTML = join(ROOT, 'fixtures', 'web', 'index.html')

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

test('explore scroll/select/hover -> export -> replay PASS twice deterministically', { timeout: 300_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  const html = await readFile(FIXTURE_HTML, 'utf8')
  let port = 0
  const fixture = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    if (requestUrl.pathname === '/api/probe') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  port = await listen(fixture)
  const origin = 'http://127.0.0.1:' + port
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scroll-loop-'))
  const scenarioPath = join(dir, 'explored.json')
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const call = (definition, args) => definition.execute(args, { agent: { id: 'scroll-loop-agent' } })

  try {
    const owner = 'scroll-loop-explore'
    const started = await call(tools.qaSessionStart, { owner, driver: 'browser', url: origin, headless: true })
    assert.equal(started.headless, true)

    // Initial observation: the below-fold select exists but is off-viewport.
    const initial = await call(tools.qaObserve, { owner })
    const belowFoldSelect = initial.nodes.find((item) => item.role === 'combobox' && item.name === 'Second select')
    assert.ok(belowFoldSelect, 'below-fold select is observable before scrolling')
    assert.equal(belowFoldSelect.inViewport, false, 'below-fold select starts off-viewport')

    // Direction scroll: the inherently positional verb whose export durability
    // this work package exercises.
    const scrolled = await call(tools.qaAct, { owner, action: 'scroll', direction: 'down', amount: 'page' })
    assert.equal(scrolled.outcome, 'ok')
    assert.equal(scrolled.receipt.status, 'confirmed')
    const select = scrolled.observation.nodes.find((item) => item.role === 'combobox' && item.name === 'Second select')
    assert.ok(select, 'select present after scroll')
    assert.equal(select.inViewport, true, 'select is in viewport after scroll')

    // Select an option: changes visible state (SECOND_IDLE -> SECOND_ALPHA).
    const selected = await call(tools.qaAct, { owner, action: 'select', ref: select.ref, option: 'Alpha' })
    assert.equal(selected.outcome, 'ok')
    assert.ok(selected.observation.nodes.some((item) => item.role === 'status' && item.name === 'SECOND_ALPHA'), 'select changed visible state')

    // Hover reveals the menu item.
    const menuTrigger = selected.observation.nodes.find((item) => item.role === 'button' && item.name === 'Menu')
    assert.ok(menuTrigger, 'Menu trigger present')
    const hovered = await call(tools.qaAct, { owner, action: 'hover', ref: menuTrigger.ref })
    assert.equal(hovered.outcome, 'ok')
    const menuItem = hovered.observation.nodes.find((item) => item.role === 'menuitem' && item.name === 'Menu item')
    assert.ok(menuItem, 'hover revealed the menu item')

    // Click the hover-revealed item.
    const clicked = await call(tools.qaAct, { owner, action: 'click', ref: menuItem.ref })
    assert.equal(clicked.outcome, 'ok')
    assert.ok(clicked.observation.nodes.some((item) => item.role === 'status' && item.name === 'MENU_CLICKED'), 'menu item click changed visible state')

    const exported = await call(tools.qaRecordExport, { owner, output_path: scenarioPath, name: 'fixture-scroll-loop' })
    assert.equal(exported.ok, true)
    assert.equal(exported.scenario.steps.length, 4, 'scroll + select + hover + click all become steps')

    const [scrollStep, selectStep, hoverStep, clickStep] = exported.scenario.steps
    assert.equal(scrollStep.action.kind, 'scroll', 'scroll step is scroll-by-target, not positional')
    assert.ok('target' in scrollStep.action, 'scroll exported as scroll-by-ref against the following action target')
    assert.equal(scrollStep.action.target.name, 'Second select', 'scroll target is the below-fold element the exploration reached')
    assert.equal(scrollStep.assert.kind, 'node-in-viewport', 'scroll is proven by a node-in-viewport assertion')
    assert.equal(selectStep.action.kind, 'select')
    assert.equal(selectStep.action.option, 'Alpha')
    assert.equal(hoverStep.action.kind, 'hover')
    assert.equal(clickStep.action.kind, 'click')

    const loaded = loadScenarioFromPath(scenarioPath)
    assert.deepEqual(loaded, exported.scenario)

    // Replay twice; both runs PASS with byte-identical deterministic projections.
    const projections = []
    for (let run = 0; run < 2; run += 1) {
      const replay = await call(tools.qaReplayRun, { scenario: scenarioPath, owner: 'scroll-loop-replay-' + run, headless: true })
      assert.equal(replay.status, 'pass', 'replay ' + (run + 1) + ' must PASS')
      assert.equal(replay.steps.length, 4)
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
