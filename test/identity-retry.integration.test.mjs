import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager, discoverInstalledBrowser } from '@zseven-w/dsh-browser'
import { BrowserAdapter } from '../src/adapters/index.ts'
import { normalizeReportForDeterminism, runScenario, validateScenario } from '../src/replay/index.ts'
import { QA_INCONCLUSIVE_UNSTABLE } from '../src/contracts.ts'

// QA-BL-070 end-to-end bounded identity-staleness retry against REAL headless
// Chrome and a real page whose target link flips a semantic-fingerprint field
// (aria-disabled) once per driver DISPATCH attempt for `flips` rounds — the
// Wikipedia mw-collapsible navbox story (History_of_China): the page toggles
// past the settle window, so the resolved link's fingerprint changes between
// resolveStepAction and session.act dispatch. K=2 must PASS with
// targetChangedRetries: 2 (the old one-shot retry FAILED this); "forever"
// must be INCONCLUSIVE / INCONCLUSIVE_UNSTABLE with the retry count — never
// fail; a policy refusal (a risk-gated click) stays a hard fail with ZERO
// retries.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FLIP_FIXTURE = join(ROOT, 'fixtures', 'web', 'identity-flip.html')
const POLICY_FIXTURE = join(ROOT, 'fixtures', 'web', 'index.html')
const K2_SETTLE = { budgetMs: 1500, quietMs: 100, postChangeQuietMs: 200, intervalMs: 25, adaptiveBudgetMs: 0 }
const FOREVER_SETTLE = { budgetMs: 600, quietMs: 60, postChangeQuietMs: 120, intervalMs: 15, adaptiveBudgetMs: 1400 }
const POLICY_SETTLE = { budgetMs: 2000, quietMs: 100, postChangeQuietMs: 200, intervalMs: 25, adaptiveBudgetMs: 0 }

async function startFixtureServer(html) {
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

function identityScenario() {
  return validateScenario({
    meta: {
      name: 'identity-flip-scroll',
      description: 'hand-written QA-BL-070 probe: the navbox link flips its fingerprint past the settle window',
      driver: 'browser',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    target: { launch: 'http://127.0.0.1:0/' },
    steps: [{
      index: 1,
      intent: 'Scroll to "History of China" inside the China navbox.',
      action: { kind: 'scroll', target: { role: 'link', name: 'History of China' } },
      assert: {
        kind: 'node-in-viewport',
        scope: { role: 'navigation', name: 'China navbox' },
        expected: { role: 'link', name: 'History of China' },
      },
    }],
    assertions: [{
      kind: 'node-in-viewport',
      scope: { role: 'navigation', name: 'China navbox' },
      expected: { role: 'link', name: 'History of China' },
    }],
  })
}

function policyScenario() {
  return validateScenario({
    meta: {
      name: 'policy-refusal-click',
      description: 'hand-written QA-BL-070 probe: a risk-gated click is refused by policy',
      driver: 'browser',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    target: { launch: 'http://127.0.0.1:0/' },
    steps: [{
      index: 1,
      intent: 'Click "Publish release".',
      action: { kind: 'click', target: { role: 'button', name: 'Publish release' } },
      assert: { kind: 'node-present', expected: { role: 'status', name: 'PASS' } },
    }],
    assertions: [],
  })
}

async function withDriver(rootDir, origin, fn) {
  const driver = new BrowserManager({ rootDir, allowedOrigins: [origin] })
  try {
    return await fn(driver)
  } finally {
    await driver.dispose().catch(() => {})
  }
}

test('K=2 flips: the bounded identity retry passes with targetChangedRetries: 2, deterministically', { timeout: 300_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  const html = await readFile(FLIP_FIXTURE, 'utf8')
  const { server, origin } = await startFixtureServer(html)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-identity-flip-'))
  try {
    const reports = []
    for (const run of [1, 2]) {
      const report = await withDriver(join(dir, 'k2-' + run), origin, (driver) =>
        runScenario(identityScenario(), new BrowserAdapter(driver), {
          ownerId: 'ir-k2-real-' + run,
          launchUrl: origin + '?flips=2',
          settle: K2_SETTLE,
          headless: true,
        }))
      assert.equal(report.status, 'pass', 'K=2 run ' + run + ' must PASS: ' + JSON.stringify(report.failure ?? {}))
      const step = report.steps[0]
      assert.equal(step.status, 'pass')
      assert.equal(step.assertionPassed, true)
      assert.equal(step.targetChangedRetries, 2, 'K=2 run ' + run + ': two TARGET_CHANGED refusals were retried, then it passed')
      assert.equal(step.message, undefined, 'a passed step carries no exhaustion message')
      reports.push(report)
    }
    assert.deepEqual(
      normalizeReportForDeterminism(reports[0]),
      normalizeReportForDeterminism(reports[1]),
      'the two K=2 runs are deterministic',
    )
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('forever flips: the exhausted budget is INCONCLUSIVE / INCONCLUSIVE_UNSTABLE with the retry count — never fail', { timeout: 300_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  const html = await readFile(FLIP_FIXTURE, 'utf8')
  const { server, origin } = await startFixtureServer(html)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-identity-forever-'))
  try {
    const report = await withDriver(join(dir, 'forever'), origin, (driver) =>
      runScenario(identityScenario(), new BrowserAdapter(driver), {
        ownerId: 'ir-forever-real',
        launchUrl: origin + '?flips=forever',
        settle: FOREVER_SETTLE,
        headless: true,
      }))
    assert.equal(report.status, 'inconclusive', 'the run is inconclusive, NEVER fail: ' + JSON.stringify(report.failure ?? {}))
    assert.equal(report.failure, undefined, 'nothing definitely failed: no failure record')
    const step = report.steps[0]
    assert.equal(step.status, 'inconclusive')
    assert.equal(step.reason, QA_INCONCLUSIVE_UNSTABLE)
    assert.equal(step.assertionPassed, false)
    assert.ok(step.targetChangedRetries >= 1, 'the retry count is disclosed, got ' + step.targetChangedRetries)
    assert.match(
      step.message ?? '',
      /the target kept changing identity between resolution and dispatch for the whole settle budget \(\d+ retries\): the page did not hold still, so the step is unproven/,
    )
    assert.equal(step.receipt.code, 'TARGET_CHANGED', 'the refusal rides verbatim on the step')
    assert.equal(typeof step.receipt.reason, 'string', 'the driver reason rides verbatim')
    assert.match(step.receipt.reason ?? '', /fingerprint|removed from the page/, 'the reason names WHAT changed')
    assert.deepEqual(
      report.settleWidened,
      { fromMs: 600, toMs: 1400, at: 1, cause: 'assertion-retry' },
      'the identity retry widened the settle budget ONCE through the shared gate',
    )
    assert.equal(report.settle.budgetMs, 1400, 'the widened budget was adopted')
    assert.equal(report.assertions.length, 0, 'final assertions are never re-decided on an unproven step')
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a policy refusal (risk-gated click) is still a hard fail with ZERO retries', { timeout: 300_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  const html = await readFile(POLICY_FIXTURE, 'utf8')
  const { server, origin } = await startFixtureServer(html)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-identity-policy-'))
  try {
    const report = await withDriver(join(dir, 'policy'), origin, (driver) =>
      runScenario(policyScenario(), new BrowserAdapter(driver), {
        ownerId: 'ir-policy-real',
        launchUrl: origin,
        settle: POLICY_SETTLE,
        headless: true,
      }))
    assert.equal(report.status, 'fail', 'the policy refusal stays a hard fail: ' + JSON.stringify(report))
    assert.match(report.failure?.message ?? '', /action receipt rejected \(EXTERNAL_COMMIT_TARGET\)/)
    const step = report.steps[0]
    assert.equal(step.status, 'fail')
    assert.equal(step.assertionPassed, false)
    assert.equal(step.targetChangedRetries, undefined, 'only TARGET_CHANGED is ever retried')
    assert.equal(step.receipt.code, 'EXTERNAL_COMMIT_TARGET')
    assert.equal(typeof step.receipt.reason, 'string', 'the refusal reason rides verbatim')
    assert.equal(step.receipt.dispatched, false)
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
