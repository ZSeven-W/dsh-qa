import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager, discoverInstalledBrowser } from '@zseven-w/dsh-browser'
import { BrowserAdapter } from '../src/adapters/index.ts'
import { runScenario, validateScenario, QA_ESCALATED_NODE_BUDGET } from '../src/replay/index.ts'
import { QaSession } from '../src/session/index.ts'
import { QA_COVERAGE_UNVERIFIED, QA_INCONCLUSIVE_TRUNCATED } from '../src/contracts.ts'

// End-to-end truncation regression against a REAL browser and a real page with
// far more semantic nodes (73) than the default observation budget (60).
//
// Live evidence this reproduces (Wikipedia /wiki/HTML at 1280x800): the first
// observation returned 60 nodes with truncated: true, and after a scroll the
// scroll target was NOT among them — not because it was invisible (it was in
// the viewport) but because newly visible nodes had consumed the budget. At a
// 100-node budget it came back with inViewport: true.
//
// The unit-level twins live in test/truncation.test.mjs.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'fixtures', 'web', 'node-budget.html')
const DEEP = { role: 'button', name: 'Deep control' }
const ABSENT = { role: 'button', name: 'Nowhere control' }

async function startFixtureServer() {
  const html = await readFile(FIXTURE, 'utf8')
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, origin: 'http://127.0.0.1:' + server.address().port }
}

function scenario(origin, assertions) {
  return validateScenario({
    meta: {
      name: 'node-budget-truncation',
      description: 'hand-written: the fixture has more semantic nodes than the default observation budget',
      driver: 'browser',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    target: { launch: origin },
    steps: [{
      index: 1,
      // The scroll target itself sits outside the default budget: without the
      // budget escalation the runner cannot even resolve it.
      intent: 'Scroll to "Deep control".',
      action: { kind: 'scroll', target: DEEP },
      assert: { kind: 'node-in-viewport', expected: DEEP },
    }],
    assertions,
  })
}

test('a page larger than the node budget never yields a false "absent"', { timeout: 300_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  const { server, origin } = await startFixtureServer()
  const drivers = []
  const roots = []
  const newDriver = async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-qa-node-budget-'))
    roots.push(rootDir)
    const driver = new BrowserManager({ rootDir, allowedOrigins: [origin] })
    drivers.push(driver)
    return driver
  }

  try {
    // -----------------------------------------------------------------
    // 1. The defect's precondition, observed for real: the default view is
    //    truncated and does NOT contain a button that genuinely exists.
    // -----------------------------------------------------------------
    const session = new QaSession(new BrowserAdapter(await newDriver()), 'node-budget-observe')
    await session.start({ url: origin, headless: true })
    const defaultView = await session.observe()
    assert.equal(defaultView.truncated, true, 'the fixture must exceed the default node budget')
    assert.equal(defaultView.nodes.length, 60, 'the driver default budget is 60 nodes')
    assert.equal(
      defaultView.nodes.some((item) => item.name === 'Deep control'),
      false,
      'the existing button falls outside the default window: this is the false-pass trap',
    )

    const escalatedView = await session.observe({ maxNodes: QA_ESCALATED_NODE_BUDGET })
    assert.equal(escalatedView.truncated, false, 'the escalated view sees the whole page')
    const deepNode = escalatedView.nodes.find((item) => item.name === 'Deep control')
    assert.ok(deepNode, 'the button was there all along, only beyond the budget')
    await session.stop()

    // -----------------------------------------------------------------
    // 2. THE FALSE PASS: node-absent for that existing-but-unseen button.
    //    It must not pass; escalation finds it and the run fails correctly.
    // -----------------------------------------------------------------
    const falsePass = await runScenario(
      scenario(origin, [{ kind: 'node-absent', expected: DEEP }]),
      new BrowserAdapter(await newDriver()),
      { ownerId: 'node-budget-absent', launchUrl: origin, headless: true },
    )
    assert.notEqual(falsePass.status, 'pass', 'a node beyond the budget must never be reported as gone')
    assert.equal(falsePass.steps[0].assertionPassed, true, 'the scroll step itself is provable')
    const absent = falsePass.assertions[0]
    assert.equal(absent.passed, false)
    assert.deepEqual(absent.observed, { role: 'button', name: 'Deep control', tag: 'button' })
    assert.equal(absent.completeness.escalated, true)
    assert.equal(absent.completeness.nodeBudget, 100, 'the browser applied its own 100-node maximum; the requested 500 is never reported as applied')
    assert.match(absent.completeness.detail, /applied 100 nodes instead of the prior 60/, 'the detail names the applied and the prior budget')
    assert.equal(absent.completeness.truncated, false)
    assert.equal(absent.completeness.reason, undefined, 'the escalated view decided it: not inconclusive')
    assert.doesNotMatch(falsePass.failure.message, new RegExp(QA_INCONCLUSIVE_TRUNCATED))

    // -----------------------------------------------------------------
    // 3. The recovery: the scroll target outside the budget still resolves,
    //    the in-viewport claim is proven, and a present-claim outside the
    //    initial budget passes. CHANGED (QA-BL-052 / Codex Q4, deliberate
    //    semantics downgrade): the genuinely-absent claim NO LONGER passes —
    //    the real browser never reports coverageVerified yet, so the absence
    //    is UNPROVEN and the run fails closed with QA_COVERAGE_UNVERIFIED.
    // -----------------------------------------------------------------
    const recovered = await runScenario(
      scenario(origin, [
        { kind: 'node-present', expected: DEEP },
        { kind: 'node-absent', expected: ABSENT },
      ]),
      new BrowserAdapter(await newDriver()),
      { ownerId: 'node-budget-recovery', launchUrl: origin, headless: true },
    )
    assert.notEqual(recovered.status, 'pass', 'an unverified absence must never pass the run')
    // The owner's scroll scenario: found without a human raising max_nodes.
    assert.equal(recovered.steps[0].assertionPassed, true)
    assert.equal(recovered.steps[0].completeness.escalated, true)
    assert.deepEqual(recovered.steps[0].observed, [{ role: 'button', name: 'Deep control', tag: 'button' }])
    // The PRESENT claim is asserted FIRST: it passes (found by escalation), so
    // the runner still reaches the absence claim after it (a failed assertion
    // stops the loop, so the ordering is part of the pin).
    assert.equal(recovered.assertions[0].passed, true, 'presence outside the initial budget is found by escalation')
    assert.equal(recovered.assertions[1].passed, false, 'a genuinely absent node is UNPROVEN until the driver verifies coverage')
    assert.equal(recovered.assertions[1].completeness.truncated, false)
    assert.equal(recovered.assertions[1].completeness.reason, QA_COVERAGE_UNVERIFIED)
    assert.match(recovered.assertions[1].completeness.detail, /closed shadow roots, slot assignment/)
  } finally {
    for (const driver of drivers) await driver.dispose().catch(() => {})
    for (const rootDir of roots) await rm(rootDir, { recursive: true, force: true })
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})
