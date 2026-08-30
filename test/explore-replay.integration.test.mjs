import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

test('qa tools explore fixture, export without edits, and replay PASS; rejected publish is excluded', { timeout: 240_000 }, async () => {
  // Deliberately no skip: a green suite must have executed this closed loop.
  await discoverInstalledBrowser()

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-closed-loop-'))
  const scenarioPath = join(dir, 'explored.json')
  const rejectedOnlyPath = join(dir, 'rejected-only.json')
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const call = (definition, args) => definition.execute(args, { agent: { id: 'closed-loop-agent' } })

  try {
    const owner = 'closed-loop-explore'
    const started = await call(tools.qaSessionStart, { owner, driver: 'browser', url: origin, headless: true })
    assert.equal(started.headless, true)

    const observed = await call(tools.qaObserve, { owner })
    const input = observed.nodes.find((item) => item.role === 'textbox' && item.name === 'Release name')
    assert.ok(input)
    const filled = await call(tools.qaAct, { owner, action: 'fill', ref: input.ref, text: 'v1.0.0' })
    assert.equal(filled.outcome, 'ok')
    const validate = filled.observation.nodes.find((item) => item.name === 'Run validation')
    assert.ok(validate)
    const clicked = await call(tools.qaAct, { owner, action: 'click', ref: validate.ref })
    assert.equal(clicked.outcome, 'ok')
    assert.ok(clicked.observation.nodes.some((item) => item.role === 'status' && item.name === 'PASS'))

    const publish = clicked.observation.nodes.find((item) => item.name === 'Publish release')
    assert.ok(publish)
    const rejected = await call(tools.qaAct, { owner, action: 'click', ref: publish.ref })
    assert.equal(rejected.outcome, 'failed')
    assert.equal(rejected.receipt.code, 'EXTERNAL_COMMIT_TARGET')
    assert.equal(rejected.observation, null)

    await call(tools.qaEvidence, { owner, max_console: 20, max_network: 20 })
    const exported = await call(tools.qaRecordExport, {
      owner,
      output_path: scenarioPath,
      name: 'fixture-explore-closed-loop',
    })
    assert.equal(exported.ok, true)
    assert.equal(exported.scenario.steps.length, 2, 'rejected publish must not become a Replay step')
    assert.equal(exported.excludedActions.length, 1)
    assert.equal(exported.excludedActions[0].reason, 'ACTION_REJECTED')
    assert.equal(exported.excludedActions[0].receipt.code, 'EXTERNAL_COMMIT_TARGET')
    assert.equal(exported.trajectory.evidenceReferences.length, 1)
    assert.equal(existsSync(scenarioPath), true)

    // Exact exported bytes go into the existing fail-closed loader and tool.
    const loaded = loadScenarioFromPath(scenarioPath)
    assert.deepEqual(loaded, exported.scenario)
    const replay = await call(tools.qaReplayRun, {
      scenario: scenarioPath,
      owner: 'closed-loop-replay',
      headless: true,
    })
    assert.equal(replay.status, 'pass')
    assert.equal(replay.steps.length, 2)
    assert.ok(replay.steps.every((step) => step.status === 'pass' && step.assertionPassed === true))
    await call(tools.qaSessionStop, { owner })

    // A trajectory containing only the safety-rejected control writes nothing.
    const rejectedOwner = 'closed-loop-rejected-only'
    await call(tools.qaSessionStart, { owner: rejectedOwner, driver: 'browser', url: origin, headless: true })
    const rejectedObserved = await call(tools.qaObserve, { owner: rejectedOwner })
    const rejectedPublish = rejectedObserved.nodes.find((item) => item.name === 'Publish release')
    assert.ok(rejectedPublish)
    const rejectedAct = await call(tools.qaAct, {
      owner: rejectedOwner,
      action: 'click',
      ref: rejectedPublish.ref,
    })
    assert.equal(rejectedAct.receipt.code, 'EXTERNAL_COMMIT_TARGET')
    const refusedExport = await call(tools.qaRecordExport, {
      owner: rejectedOwner,
      output_path: rejectedOnlyPath,
    })
    assert.equal(refusedExport.ok, false)
    assert.equal(refusedExport.code, 'NO_PROVEN_STEPS')
    assert.equal(refusedExport.excludedActions[0].reason, 'ACTION_REJECTED')
    assert.equal(existsSync(rejectedOnlyPath), false)
    await call(tools.qaSessionStop, { owner: rejectedOwner })
  } finally {
    await host.dispose()
    fixture.closeAllConnections?.()
    await new Promise((resolve) => fixture.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
