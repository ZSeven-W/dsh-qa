import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverInstalledBrowser } from '@zseven-w/dsh-browser'
import { normalizeReportForDeterminism, validateScenario } from '../src/replay/index.ts'
import { createQaTools, QaToolHost } from '../src/tools.ts'

// End-to-end regression for the Explore -> Replay settle contract against a
// REAL browser and genuinely asynchronous fixtures. The unit-level twins live
// in test/settle.test.mjs; these prove the same two real-world failure modes
// observed on live Wikipedia:
//
//   A. the fill's only semantic outcome (a suggestion list) arrives late, so a
//      single-shot proof observation excludes the step and replay can never
//      reach the suggestion;
//   B. unrelated late hydration renames a far-away element ("[o]" becoming
//      "[ctrl-option-o]") and gets mistaken for the fill's proof.
//
// A third fixture never holds still at all, and must fail closed on both sides.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = join(ROOT, 'fixtures', 'web')

// Delays are injected per request path, so no fixture URL ever carries a query
// string (the Replay URL projection rejects those).
const ROUTES = {
  '/': { file: 'async-suggest.html', values: { __SUGGEST_DELAY_MS__: '350' } },
  // Deliberately close to the 2500ms default budget: the outcome is still
  // proven, but the margin is visible.
  '/near-budget': { file: 'async-suggest.html', values: { __SUGGEST_DELAY_MS__: '1800' } },
  '/churn': {
    file: 'hydration-churn.html',
    values: { __CHURN_DELAY_MS__: '10', __SUGGEST_DELAY_MS__: '220' },
  },
  '/never': { file: 'never-settles.html', values: { __TICK_MS__: '90' } },
}

async function startFixtureServer() {
  const cache = new Map()
  for (const [route, spec] of Object.entries(ROUTES)) {
    let html = await readFile(join(WEB, spec.file), 'utf8')
    for (const [token, value] of Object.entries(spec.values)) html = html.split(token).join(value)
    cache.set(route, html)
  }
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const html = cache.get(path)
    if (html === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, origin: 'http://127.0.0.1:' + server.address().port }
}

function deterministicProjection(report) {
  return JSON.stringify(normalizeReportForDeterminism(report))
}

test('settle: async outcomes, hydration churn, and a page that never settles', { timeout: 600_000 }, async () => {
  // Deliberately no skip: a green suite must have executed this closed loop.
  await discoverInstalledBrowser()

  const { server, origin } = await startFixtureServer()
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-settle-loop-'))
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const call = (definition, args) => definition.execute(args, { agent: { id: 'settle-loop-agent' } })

  try {
    // ---------------------------------------------------------------
    // Failure mode A: the suggestion list only exists 200ms after the fill.
    // ---------------------------------------------------------------
    const owner = 'settle-async-explore'
    await call(tools.qaSessionStart, { owner, driver: 'browser', url: origin, headless: true })
    const observed = await call(tools.qaObserve, { owner })
    assert.equal(observed.settle.stable, true)
    const box = observed.nodes.find((item) => item.role === 'textbox' && item.name === 'Search articles')
    assert.ok(box, 'fixture must expose the search box')

    const filled = await call(tools.qaAct, { owner, action: 'fill', ref: box.ref, text: 'async' })
    assert.equal(filled.outcome, 'ok')
    assert.equal(filled.settle.stable, true, 'the settled proof observation must be stable')
    const option = filled.observation.nodes.find((item) => item.name === 'Async rendering')
    assert.ok(option, 'the settled proof observation must contain the late suggestion')

    const opened = await call(tools.qaAct, { owner, action: 'click', ref: option.ref })
    assert.equal(opened.outcome, 'ok')
    assert.ok(opened.observation.nodes.some((item) => item.name === 'OPENED Async rendering'))

    const scenarioPath = join(dir, 'async.json')
    const exported = await call(tools.qaRecordExport, {
      owner,
      output_path: scenarioPath,
      name: 'settle-async-suggestion',
    })
    assert.equal(exported.ok, true, 'the fill must be exported, not excluded as unprovable')
    assert.equal(exported.excludedActions.length, 0)
    assert.equal(exported.scenario.steps.length, 2, 'fill + click on the suggestion')
    assert.equal(exported.scenario.steps[0].action.kind, 'fill')
    // The fill is proven by its OWN target's value — the most durable evidence —
    // even though the late suggestion list is also present in the settled view.
    assert.equal(exported.scenario.steps[0].assert.kind, 'node-value')
    assert.deepEqual(
      exported.scenario.steps[0].assert.expected,
      { role: 'textbox', name: 'Search articles', value: 'async' },
    )
    assert.doesNotMatch(exported.scenario.steps[0].intent, /Weak proof/)
    await call(tools.qaSessionStop, { owner })

    // Replay twice: PASS both times, byte-identical deterministic projection.
    const replays = []
    for (let i = 0; i < 2; i += 1) {
      replays.push(await call(tools.qaReplayRun, {
        scenario: scenarioPath,
        owner: 'settle-async-replay-' + i,
        headless: true,
      }))
    }
    assert.equal(replays[0].status, 'pass')
    assert.equal(replays[1].status, 'pass')
    assert.ok(replays[0].steps.every((step) => step.status === 'pass'))
    assert.equal(
      deterministicProjection(replays[0]),
      deterministicProjection(replays[1]),
      'settling changes duration, not outcome',
    )

    // ---------------------------------------------------------------
    // Same loop with the suggestion arriving close to the settle budget.
    // ---------------------------------------------------------------
    const slowOwner = 'settle-near-budget-explore'
    const slowLaunch = origin + '/near-budget'
    await call(tools.qaSessionStart, { owner: slowOwner, driver: 'browser', url: slowLaunch, headless: true })
    const slowObserved = await call(tools.qaObserve, { owner: slowOwner })
    const slowBox = slowObserved.nodes.find((item) => item.role === 'textbox' && item.name === 'Search articles')
    assert.ok(slowBox)
    const slowFilled = await call(tools.qaAct, { owner: slowOwner, action: 'fill', ref: slowBox.ref, text: 'async' })
    assert.equal(slowFilled.settle.stable, true)
    assert.ok(slowFilled.observation.nodes.some((item) => item.name === 'Async rendering'))
    const slowPath = join(dir, 'near-budget.json')
    const slowExport = await call(tools.qaRecordExport, {
      owner: slowOwner,
      output_path: slowPath,
      name: 'settle-near-budget',
    })
    assert.equal(slowExport.ok, true)
    assert.equal(slowExport.scenario.steps[0].assert.kind, 'node-value')
    assert.deepEqual(
      slowExport.scenario.steps[0].assert.expected,
      { role: 'textbox', name: 'Search articles', value: 'async' },
    )
    await call(tools.qaSessionStop, { owner: slowOwner })
    const slowReplay = await call(tools.qaReplayRun, {
      scenario: slowPath,
      owner: 'settle-near-budget-replay',
      headless: true,
    })
    assert.equal(slowReplay.status, 'pass')

    // ---------------------------------------------------------------
    // Failure mode B: a far-away link renames itself during the fill's window.
    // ---------------------------------------------------------------
    const churnOwner = 'settle-churn-explore'
    const churnLaunch = origin + '/churn'
    await call(tools.qaSessionStart, { owner: churnOwner, driver: 'browser', url: churnLaunch, headless: true })
    const churnObserved = await call(tools.qaObserve, { owner: churnOwner })
    const churnBox = churnObserved.nodes.find((item) => item.role === 'textbox' && item.name === 'Search articles')
    assert.ok(churnBox)
    const rawShortcut = churnObserved.nodes.find((item) => item.name.includes('[o]'))
    assert.ok(rawShortcut, 'the shortcut link starts with its pre-hydration name')

    const churnFilled = await call(tools.qaAct, { owner: churnOwner, action: 'fill', ref: churnBox.ref, text: 'hydra' })
    assert.equal(churnFilled.settle.stable, true)
    const hydrated = churnFilled.observation.nodes.find((item) => item.name.includes('[ctrl-option-o]'))
    assert.ok(hydrated, 'the unrelated rename really did land inside the proof window')
    assert.ok(churnFilled.observation.nodes.some((item) => item.name === 'Hydration and rendering'))

    const churnPath = join(dir, 'churn.json')
    const churnExport = await call(tools.qaRecordExport, {
      owner: churnOwner,
      output_path: churnPath,
      name: 'settle-hydration-churn',
    })
    assert.equal(churnExport.ok, true)
    const churnStep = churnExport.scenario.steps[0]
    assert.equal(churnStep.assert.kind, 'node-value')
    assert.deepEqual(churnStep.assert.expected, { role: 'textbox', name: 'Search articles', value: 'hydra' })
    assert.ok(
      !String(churnStep.assert.expected.name).includes('ctrl-option-o'),
      'the churning node must never become the proof',
    )
    assert.doesNotMatch(churnStep.intent, /Weak proof/)
    await call(tools.qaSessionStop, { owner: churnOwner })

    const churnReplay = await call(tools.qaReplayRun, {
      scenario: churnPath,
      owner: 'settle-churn-replay',
      headless: true,
    })
    assert.equal(churnReplay.status, 'pass', 'the rename must not break replay')

    // ---------------------------------------------------------------
    // Fail-closed: a page that never holds still proves nothing, ever.
    // ---------------------------------------------------------------
    const neverOwner = 'settle-never-explore'
    const neverLaunch = origin + '/never'
    await call(tools.qaSessionStart, { owner: neverOwner, driver: 'browser', url: neverLaunch, headless: true })
    const neverObserved = await call(tools.qaObserve, { owner: neverOwner })
    assert.equal(neverObserved.settle.stable, false, 'a ticking page never settles')
    const neverBox = neverObserved.nodes.find((item) => item.role === 'textbox' && item.name === 'Release name')
    assert.ok(neverBox)
    const neverFilled = await call(tools.qaAct, { owner: neverOwner, action: 'fill', ref: neverBox.ref, text: 'v1' })
    assert.equal(neverFilled.settle.stable, false)
    const neverExport = await call(tools.qaRecordExport, {
      owner: neverOwner,
      output_path: join(dir, 'never.json'),
    })
    assert.equal(neverExport.ok, false)
    assert.equal(neverExport.code, 'NO_PROVEN_STEPS')
    assert.equal(neverExport.excludedActions[0].reason, 'ASSERTION_NOT_PROVABLE')
    assert.match(neverExport.excludedActions[0].detail, /never stabilized within the settle budget/)
    await call(tools.qaSessionStop, { owner: neverOwner })

    // Hand-written scenario whose assertion IS satisfied on that page: only the
    // settle contract can stop it from passing by luck.
    const neverScenarioPath = join(dir, 'never-replay.json')
    const neverScenario = validateScenario({
      meta: {
        name: 'never-settles',
        description: 'hand-written: the fixture under test never holds still',
        driver: 'browser',
        createdAt: new Date().toISOString(),
      },
      target: { launch: neverLaunch },
      steps: [{
        index: 1,
        intent: 'Fill "Release name".',
        action: { kind: 'fill', target: { role: 'textbox', name: 'Release name' }, text: 'v1' },
        assert: { kind: 'node-present', expected: { role: 'status', name: 'READY' } },
      }],
      assertions: [{ kind: 'node-present', expected: { role: 'status', name: 'READY' } }],
    })
    await writeFile(neverScenarioPath, JSON.stringify(neverScenario, null, 2) + '\n', 'utf8')
    const neverReplay = await call(tools.qaReplayRun, {
      scenario: neverScenarioPath,
      owner: 'settle-never-replay',
      headless: true,
    })
    assert.equal(neverReplay.status, 'fail', 'replay must fail honestly, not pass by luck')
    assert.match(neverReplay.failure.message, /never settled within the 2500ms settle budget/)
  } finally {
    await host.dispose()
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
