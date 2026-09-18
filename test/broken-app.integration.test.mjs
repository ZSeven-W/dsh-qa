// Acceptance against a DELIBERATELY BROKEN application, in a real browser.
//
// Every other integration test drives a fixture that works and asserts the
// loop reaches PASS. That proves the happy path and nothing about the product's
// actual claim, which is a negative one: a known-bad application must not come
// out green. The fixtures/web/broken-app.html controls all dispatch
// successfully and then fail to do their job — a receipt proves dispatch, never
// the application's outcome.
//
// These are the shapes that produced false greens before (Codex gpt-6 astra
// consult, 2026-09-18), re-checked here end to end through the real tool
// surface and a real Chrome rather than through synthetic adapters:
//
//   - an ineffective fill next to an unrelated field that already holds the
//     same text (the export used to bind its proof to that other field);
//   - a dead button whose click changes nothing;
//   - a control that is REPLACED by a same-role twin when used.
//
// Deliberately no skip: a green suite must have executed this.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverInstalledBrowser } from '@zseven-w/dsh-browser'
import { runScenario } from '../src/replay/index.ts'
import { createQaTools, QaToolHost } from '../src/tools.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_HTML = join(ROOT, 'fixtures', 'web', 'broken-app.html')
const WORKING_HTML = join(ROOT, 'fixtures', 'web', 'index.html')

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function serveFixtureHtml(html) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  const port = await listen(server)
  return { server, origin: 'http://127.0.0.1:' + port }
}

async function serveFixture(path) {
  return serveFixtureHtml(await readFile(path, 'utf8'))
}

/** A fresh browser driver for a replay run. */
async function browserAdapter() {
  const { BrowserAdapter } = await import('../src/adapters/index.ts')
  const { loadBrowserManager } = await import('../src/adapters/loadBrowser.ts')
  return new BrowserAdapter(await loadBrowserManager())
}

test('exploring a broken app REFUSES to export rather than producing a scenario', { timeout: 240_000 }, async () => {
  await discoverInstalledBrowser()
  const { server, origin } = await serveFixture(FIXTURE_HTML)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-broken-'))
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const call = (definition, args) => definition.execute(args, { agent: { id: 'broken-app-agent' } })
  const owner = 'broken-app'

  try {
    await call(tools.qaSessionStart, { owner, driver: 'browser', url: origin, headless: true })
    const observed = await call(tools.qaObserve, { owner })

    const primary = observed.nodes.find((item) => item.role === 'textbox' && item.name === 'Primary')
    assert.ok(primary, 'the fixture must expose the Primary field')
    await call(tools.qaAct, { owner, action: 'fill', ref: primary.ref, text: 'hello' })
    // Deliberately NOT asserting on the receipt. A receipt proves dispatch, not
    // outcome — that is the product's own doctrine, and the dispatch really did
    // succeed. What matters is the observable state afterwards.
    const current = await call(tools.qaObserve, { owner })
    const primaryAfter = current.nodes.find((item) => item.role === 'textbox' && item.name === 'Primary')
    assert.notEqual(primaryAfter?.value, 'hello', 'the fixture reverts the fill, so the value must not stick')
    const submit = current.nodes.find((item) => item.role === 'button' && item.name === 'Submit order')
    assert.ok(submit, 'the fixture must expose the dead Submit order button')
    await call(tools.qaAct, { owner, action: 'click', ref: submit.ref })
    const afterSubmit = await call(tools.qaObserve, { owner })
    const status = afterSubmit.nodes.find((item) => item.role === 'status')
    assert.equal(status?.name, 'Not submitted', 'the fixture is supposed to do nothing on submit')

    const exported = await call(tools.qaRecordExport, {
      owner,
      output_path: join(dir, 'broken.json'),
      name: 'broken app',
    })

    // Nothing here was provable, so nothing may be written. This branch is the
    // one this fixture actually exercises, and it is asserted rather than
    // returned from: a test that silently takes an early exit proves nothing.
    assert.equal(exported.ok, false, 'a broken app must not yield a scenario: ' + JSON.stringify(exported))
    assert.equal(exported.code, 'NO_PROVEN_STEPS')
    // Every action must be accounted for by name, not silently dropped.
    const reasons = (exported.excludedActions ?? []).map((entry) => entry.reason)
    assert.equal(
      (exported.excludedActions ?? []).length,
      2,
      'both actions must be disclosed as excluded: ' + JSON.stringify(exported.excludedActions),
    )
    assert.ok(
      reasons.every((reason) => reason === 'ACTION_FAILED' || reason === 'ASSERTION_NOT_PROVABLE'),
      'the exclusions name why nothing was provable: ' + JSON.stringify(reasons),
    )
  } finally {
    await call(tools.qaSessionStop, { owner }).catch(() => undefined)
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('a scenario that legitimately PASSED goes non-green when the app breaks', { timeout: 240_000 }, async () => {
  // The regression gate the product exists for. Explore the WORKING fixture,
  // export it, then replay the identical scenario against a variant whose
  // outcome no longer happens. Replay must refuse to stay green.
  await discoverInstalledBrowser()
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-regress-'))
  const scenarioPath = join(dir, 'working.json')
  const working = await serveFixture(WORKING_HTML)
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const call = (definition, args) => definition.execute(args, { agent: { id: 'regress-agent' } })
  const owner = 'regress-explore'
  let scenario

  try {
    await call(tools.qaSessionStart, { owner, driver: 'browser', url: working.origin, headless: true })
    const observed = await call(tools.qaObserve, { owner })
    const input = observed.nodes.find((item) => item.role === 'textbox' && item.name === 'Release name')
    assert.ok(input)
    const filled = await call(tools.qaAct, { owner, action: 'fill', ref: input.ref, text: 'v1.0.0' })
    assert.equal(filled.outcome, 'ok')
    const validate = filled.observation.nodes.find((item) => item.name === 'Run validation')
    assert.ok(validate)
    const clicked = await call(tools.qaAct, { owner, action: 'click', ref: validate.ref })
    assert.equal(clicked.outcome, 'ok')
    assert.ok(
      clicked.observation.nodes.some((item) => item.role === 'status' && item.name === 'PASS'),
      'the working fixture really does reach PASS',
    )
    const exported = await call(tools.qaRecordExport, { owner, output_path: scenarioPath, name: 'release flow' })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    scenario = exported.scenario
  } finally {
    await call(tools.qaSessionStop, { owner }).catch(() => undefined)
    await new Promise((resolve) => working.server.close(resolve))
  }

  // Sanity: the scenario is green against the app it came from. Without this,
  // a non-green result below could just mean the scenario was broken.
  const healthy = await serveFixture(WORKING_HTML)
  try {
    const good = await runScenario(scenario, await browserAdapter(), {
      ownerId: 'regress-good',
      launchUrl: healthy.origin,
    })
    assert.equal(good.status, 'pass', 'the exported scenario must pass against the working app: '
      + JSON.stringify(good.failure ?? good.steps))
  } finally {
    await new Promise((resolve) => healthy.server.close(resolve))
  }

  // Now the same scenario against an app whose validation silently stops
  // working — the single line that produces PASS is removed.
  const brokenHtml = (await readFile(WORKING_HTML, 'utf8'))
    .replace("document.getElementById('result').textContent = 'PASS';", '/* regression: never reaches PASS */')
  const regressed = await serveFixtureHtml(brokenHtml)
  try {
    const bad = await runScenario(scenario, await browserAdapter(), {
      ownerId: 'regress-bad',
      launchUrl: regressed.origin,
    })
    assert.notEqual(
      bad.status,
      'pass',
      'a regressed app must not replay green — this is the entire product claim: '
        + JSON.stringify(bad.steps?.map((step) => ({ status: step.status, reason: step.reason }))),
    )
  } finally {
    await new Promise((resolve) => regressed.server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('a control REPLACED by a same-role twin is not proven by the replacement', { timeout: 240_000 }, async () => {
  // The subtle one. Clicking "Apply changes" destroys that button and inserts a
  // different element with the same role and the same accessible name. A replay
  // that re-resolves the target by predicate finds the REPLACEMENT and could
  // call that success — the action did nothing, but something matching the
  // predicate is still on the page.
  //
  // Whatever the loop decides here, it must not be: exported a step, replayed
  // it, called it green.
  await discoverInstalledBrowser()
  const { server, origin } = await serveFixture(FIXTURE_HTML)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-swap-'))
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const call = (definition, args) => definition.execute(args, { agent: { id: 'swap-agent' } })
  const owner = 'swap-app'

  try {
    await call(tools.qaSessionStart, { owner, driver: 'browser', url: origin, headless: true })
    const observed = await call(tools.qaObserve, { owner })
    const apply = observed.nodes.find((item) => item.role === 'button' && item.name === 'Apply changes')
    assert.ok(apply, 'the fixture must expose the Apply changes button')

    const clicked = await call(tools.qaAct, { owner, action: 'click', ref: apply.ref })
    // The driver CONFIRMS the dispatch — the click really happened and really
    // did replace the button. This is the sharpest statement of the doctrine:
    // a confirmed receipt is not an outcome, and everything below follows from
    // refusing to treat it as one.
    assert.equal(clicked.outcome, 'ok')
    assert.equal(clicked.receipt?.status, 'confirmed')

    const after = await call(tools.qaObserve, { owner })
    const twins = after.nodes.filter((item) => item.role === 'button' && item.name === 'Apply changes')
    assert.equal(twins.length, 1, 'the fixture replaces the control with exactly one same-named twin')

    const exported = await call(tools.qaRecordExport, {
      owner,
      output_path: join(dir, 'swap.json'),
      name: 'swap app',
    })

    // The strongest possible outcome, and the one that actually happens: the
    // replacement is semantically indistinguishable from the original, so there
    // is no provable delta and NOTHING is exported. Replay is never reached for
    // this shape, so this test does not pretend to cover it — the replay-side
    // rule that a re-resolved twin cannot stand in as proof is pinned by
    // test/verdict-integrity.test.mjs and test/replay-target-unique.test.mjs.
    assert.equal(exported.ok, false, 'a same-role twin must not become an exportable proof: ' + JSON.stringify(exported))
    assert.equal(exported.code, 'NO_PROVEN_STEPS')
    assert.deepEqual(
      (exported.excludedActions ?? []).map((entry) => entry.reason),
      ['ASSERTION_NOT_PROVABLE'],
      'the confirmed-but-unprovable click is disclosed by name',
    )
  } finally {
    await call(tools.qaSessionStop, { owner }).catch(() => undefined)
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
