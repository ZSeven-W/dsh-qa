import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager, discoverInstalledBrowser } from '@zseven-w/dsh-browser'
import { BrowserAdapter } from '../src/adapters/index.ts'
import { runScenario, validateScenario } from '../src/replay/index.ts'
import { QA_INCONCLUSIVE_UNSTABLE } from '../src/contracts.ts'

// QA-BL-073 end-to-end against REAL headless Chrome (driver 677cdc2, contract
// v9): the walk's within read on the sidebar ancestor races a churn the
// whole-page read does not see — the Wikipedia sidebar story.
//
//   content mode: the ancestor is CONTENT-named and its aggregated text flips
//     between the whole-page read and the within read. The driver reports
//     that INFORMATIONALLY (scope.nameChanged, never a refusal), so the walk
//     succeeds and the step must record scopeNameChanged: true.
//   label mode: the ancestor is LABEL-named and its label flips — the within
//     read is refused TARGET_CHANGED with changed: ["name"]. The bounded
//     walk retry re-resolves from the level above: flips=1 resolves (the
//     step passes with targetChangedRetries: 1), flips=forever exhausts the
//     settle budget and the step must be INCONCLUSIVE / INCONCLUSIVE_UNSTABLE
//     naming the level — never fail. The pre-fix runner hard-failed both.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FLIP_FIXTURE = join(ROOT, 'fixtures', 'web', 'scope-identity-flip.html')
const CONTENT_SETTLE = { budgetMs: 2000, quietMs: 150, postChangeQuietMs: 300, intervalMs: 20, adaptiveBudgetMs: 0 }
// The label-mode quiet window must comfortably outlast the fixture's 40ms
// label restore (plus any main-thread timer jank): a settle that concluded
// stable on the FLIPPED label would make the walk's re-resolution honestly
// report the recorded ancestor absent instead of retrying.
const LABEL_K1_SETTLE = { budgetMs: 2500, quietMs: 300, postChangeQuietMs: 600, intervalMs: 20, adaptiveBudgetMs: 0 }
const LABEL_FOREVER_SETTLE = { budgetMs: 900, quietMs: 300, postChangeQuietMs: 600, intervalMs: 20, adaptiveBudgetMs: 2000 }

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

function scopedScenario(pathItem) {
  const assert_ = {
    kind: 'node-in-viewport',
    scope: { role: 'navigation', name: 'China navbox', path: [pathItem] },
    expected: { role: 'link', name: 'History of China' },
  }
  return validateScenario({
    meta: {
      name: 'scope-identity-flip-' + pathItem.role + '-' + String(pathItem.name ?? 'content'),
      description: 'hand-written QA-BL-073 probe: the sidebar ancestor flips its name between the whole-page read and the within read',
      driver: 'browser',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    target: { launch: 'http://127.0.0.1:0/' },
    steps: [{
      index: 1,
      intent: 'Scroll to "History of China" inside the China navbox.',
      action: { kind: 'scroll', target: { role: 'link', name: 'History of China' } },
      assert: assert_,
    }],
    assertions: [assert_],
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

test('content-named ancestor: the aggregated-name flip is INFORMATIONAL — the walk succeeds and the step records scopeNameChanged: true', { timeout: 300_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  const html = await readFile(FLIP_FIXTURE, 'utf8')
  const { server, origin } = await startFixtureServer(html)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scope-identity-content-'))
  try {
    const report = await withDriver(join(dir, 'content'), origin, (driver) =>
      runScenario(scopedScenario({ role: 'navigation', tag: 'nav' }), new BrowserAdapter(driver), {
        ownerId: 'si-content-real',
        launchUrl: origin + '?mode=content&flips=1',
        settle: CONTENT_SETTLE,
        headless: true,
      }))
    assert.equal(report.status, 'pass', 'the informational change is never a refusal: ' + JSON.stringify(report.failure ?? {}))
    const step = report.steps[0]
    assert.equal(step.status, 'pass')
    assert.equal(step.assertionPassed, true)
    assert.equal(step.scopeNameChanged, true, 'the driver-reported name change rides on the step')
    assert.equal(step.targetChangedRetries, undefined, 'no refusal, no retries')
    assert.equal(step.scopeIdentityRefusal, undefined)
    assert.equal(step.scopeResolution, 'proven')
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('label-named ancestor, one flip: the walk within read is refused TARGET_CHANGED once, the bounded retry re-resolves, and the step passes with targetChangedRetries: 1', { timeout: 300_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  const html = await readFile(FLIP_FIXTURE, 'utf8')
  const { server, origin } = await startFixtureServer(html)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scope-identity-k1-'))
  try {
    const report = await withDriver(join(dir, 'k1'), origin, (driver) =>
      runScenario(scopedScenario({ role: 'navigation', name: 'Sidebar one' }), new BrowserAdapter(driver), {
        ownerId: 'si-k1-real',
        launchUrl: origin + '?mode=label&flips=1',
        settle: LABEL_K1_SETTLE,
        headless: true,
      }))
    assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? {}))
    const step = report.steps[0]
    assert.equal(step.status, 'pass')
    assert.equal(step.assertionPassed, true)
    assert.equal(step.targetChangedRetries, 1, 'the one walk refusal was retried and the level then resolved')
    assert.equal(step.message, undefined, 'a passed step carries no exhaustion message')
    assert.equal(step.scopeNameChanged, undefined)
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('label-named ancestor, forever flips: the exhausted walk retry is INCONCLUSIVE / INCONCLUSIVE_UNSTABLE naming the level — never fail', { timeout: 300_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  const html = await readFile(FLIP_FIXTURE, 'utf8')
  const { server, origin } = await startFixtureServer(html)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scope-identity-forever-'))
  try {
    const report = await withDriver(join(dir, 'forever'), origin, (driver) =>
      runScenario(scopedScenario({ role: 'navigation', name: 'Sidebar one' }), new BrowserAdapter(driver), {
        ownerId: 'si-forever-real',
        launchUrl: origin + '?mode=label&flips=forever',
        settle: LABEL_FOREVER_SETTLE,
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
      /path level 1 \(role "navigation", name "Sidebar one"\) kept changing identity for the whole settle budget \(\d+ retries\): the page did not hold still, so the step is unproven/,
      'the exhaustion message names the level',
    )
    assert.equal(step.scopeIdentityRefusal?.code, 'TARGET_CHANGED')
    assert.equal(step.scopeIdentityRefusal?.level, 1)
    assert.equal(step.scopeIdentityRefusal?.what, 'role "navigation", name "Sidebar one"')
    assert.deepEqual(step.scopeIdentityRefusal?.changed, ['name'], 'the driver names WHAT changed')
    assert.equal(typeof step.scopeIdentityRefusal?.before?.name, 'string', 'the before snapshot rides verbatim')
    assert.equal(typeof step.scopeIdentityRefusal?.after?.name, 'string', 'the after snapshot rides verbatim')
    assert.equal(typeof step.scopeIdentityRefusal?.reason, 'string', 'the driver reason rides verbatim')
    assert.deepEqual(
      report.settleWidened,
      { fromMs: 900, toMs: 2000, at: 1, cause: 'assertion-retry' },
      'the walk retry widened the settle budget ONCE through the shared gate',
    )
    assert.equal(report.settle.budgetMs, 2000, 'the widened budget was adopted')
    assert.equal(report.assertions.length, 0, 'final assertions are never re-decided on an unproven step')
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
