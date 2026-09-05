// Contract v9 Phase C (C2) against a REAL headless Chrome: the terminal
// absence decision requests the driver's bounded coverage probe on its ONE
// deciding re-observation, and absence passes only on coverage.verified:true
// with truncated:false. A clean container PASSES (coverage.verified:true
// travels in the completeness block); a container holding a CLOSED shadow
// root keeps the absence INCONCLUSIVE_TRUNCATED naming closed-shadow-root —
// the content the root renders is missing from the projection, so the
// absence is unproven. The whole fixture page carries closed roots too, so
// a whole-page absence on it is equally unproven.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager, discoverInstalledBrowser } from '@zseven-w/dsh-browser'
import { BrowserAdapter } from '../src/adapters/index.ts'
import { QaSession } from '../src/session/index.ts'
import { decideAssertion, sessionReobserve } from '../src/replay/index.ts'
import { QA_INCONCLUSIVE_TRUNCATED } from '../src/contracts.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_HTML = join(ROOT, 'fixtures', 'web', 'coverage-closed-shadow.html')

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

test('verified coverage restores absence passes on a clean container; closed roots keep them INCONCLUSIVE_TRUNCATED', { timeout: 300_000 }, async (t) => {
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-coverage-'))

  const driver = new BrowserManager({ rootDir: dir, allowedOrigins: [origin] })
  const session = new QaSession(new BrowserAdapter(driver), 'qa-coverage-integration')

  try {
    await session.start({ url: origin, headless: true })

    // 1. The adapter-level shape: a RAW observe with verifyCoverage runs the
    //    probe and reports the real per-observation coverage evidence; an
    //    ordinary observe carries the skipped marker at no probe cost.
    const plain = await session.observe({ maxNodes: 100 })
    assert.deepEqual(
      plain.coverage,
      { verified: false, closedShadowRoots: 0, probedNodes: 0, reason: 'skipped' },
      'an ordinary observe never probes: coverage is skipped',
    )
    const probed = await session.observe({ maxNodes: 100, verifyCoverage: true })
    assert.equal(probed.coverage.verified, false, 'the whole fixture page holds closed roots')
    assert.ok(probed.coverage.closedShadowRoots >= 2, JSON.stringify(probed.coverage))
    assert.equal(probed.truncated, true)
    assert.ok(probed.truncationReasons?.includes('closed-shadow-root'), JSON.stringify(probed.truncationReasons))
    assert.ok(!probed.truncationReasons?.includes('shadow-coverage-unverified'), 'a completed probe is not unverified')
    assert.ok(typeof probed.hiddenMatches === 'number', 'v9 gate diagnostics travel')
    assert.equal(typeof probed.hiddenMatchesPartial, 'boolean')

    // 2. A clean container: a settled SCOPED observation, then the terminal
    //    absence decision. The deciding re-read probes the SUBTREE, finds no
    //    closed root, and the absence PASSES with coverage.verified:true plus
    //    the Codex wording.
    const whole = await session.observe({ maxNodes: 100 })
    const cleanZone = whole.nodes.find((item) => item.role === 'region' && item.name === 'Clean zone')
    assert.ok(cleanZone, 'the clean zone must be observable whole-page')
    const cleanScoped = await session.observeSettled({ withinRef: cleanZone.ref, maxNodes: 60 })
    assert.equal(cleanScoped.stable, true)
    assert.equal(cleanScoped.observation.truncated, false, 'the clean subtree fits')
    assert.equal(cleanScoped.observation.coverage.reason, 'skipped', 'the ordinary scoped settle never probes')

    const absentClean = await decideAssertion(
      { kind: 'node-absent', expected: { role: 'button', name: 'Nowhere button' } },
      cleanScoped.observation,
      sessionReobserve(session),
    )
    assert.equal(absentClean.passed, true, JSON.stringify(absentClean))
    assert.equal(absentClean.completeness.truncated, false)
    assert.equal(absentClean.completeness.coverage.verified, true)
    assert.equal(absentClean.completeness.coverage.closedShadowRoots, 0)
    assert.ok(absentClean.completeness.coverage.probedNodes >= 2, JSON.stringify(absentClean.completeness.coverage))
    assert.deepEqual(absentClean.completeness.scope, { role: 'region', name: 'Clean zone' })
    assert.match(absentClean.completeness.detail, /No driver-observable semantic node matching/)
    assert.match(absentClean.completeness.detail, /region named "Clean zone"/)
    assert.match(
      absentClean.completeness.detail,
      new RegExp('coverage verified \\(' + String(absentClean.completeness.coverage.probedNodes) + ' nodes probed\\)'),
      'the PASS wording names the probed node count',
    )

    // 3. A container holding a CLOSED shadow root: the probe finds it, the
    //    view turns truncated with the closed-shadow-root reason, and the
    //    absence stays INCONCLUSIVE_TRUNCATED naming that reason.
    const whole2 = await session.observe({ maxNodes: 100 })
    const closedZone = whole2.nodes.find((item) => item.role === 'region' && item.name === 'Closed zone')
    assert.ok(closedZone, 'the closed zone must be observable whole-page')
    const closedScoped = await session.observeSettled({ withinRef: closedZone.ref, maxNodes: 60 })
    assert.equal(closedScoped.stable, true)
    assert.equal(closedScoped.observation.truncated, false, 'without the probe the closed subtree looks complete')
    assert.ok(
      !closedScoped.observation.nodes.some((item) => item.name === 'hidden-in-closed-root'),
      'closed-root content is invisible to the in-page projection',
    )

    const absentClosed = await decideAssertion(
      { kind: 'node-absent', expected: { role: 'button', name: 'hidden-in-closed-root' } },
      closedScoped.observation,
      sessionReobserve(session),
    )
    assert.equal(absentClosed.passed, false, JSON.stringify(absentClosed))
    assert.equal(absentClosed.completeness.reason, QA_INCONCLUSIVE_TRUNCATED)
    assert.equal(absentClosed.completeness.truncated, true)
    assert.ok(
      absentClosed.completeness.truncationReasons?.includes('closed-shadow-root'),
      JSON.stringify(absentClosed.completeness.truncationReasons),
    )
    assert.match(absentClosed.completeness.detail, /closed-shadow-root/, 'the detail names the driver reason')
    assert.equal(absentClosed.completeness.coverage.verified, false)
    assert.ok(absentClosed.completeness.coverage.closedShadowRoots >= 1, JSON.stringify(absentClosed.completeness.coverage))

    // 4. Whole-page on the same fixture: the probe sees every closed root
    //    of the page, so a whole-page absence is equally unproven.
    const wholeSettled = await session.observeSettled()
    const absentWhole = await decideAssertion(
      { kind: 'node-absent', expected: { role: 'button', name: 'Nowhere button' } },
      wholeSettled.observation,
      sessionReobserve(session),
    )
    assert.equal(absentWhole.passed, false, JSON.stringify(absentWhole))
    assert.equal(absentWhole.completeness.reason, QA_INCONCLUSIVE_TRUNCATED)
    assert.ok(absentWhole.completeness.truncationReasons?.includes('closed-shadow-root'), JSON.stringify(absentWhole.completeness.truncationReasons))

    await session.stop()
  } finally {
    await session.stop().catch(() => {})
    await driver.dispose().catch(() => {})
    fixture.closeAllConnections?.()
    await new Promise((resolve) => fixture.close(resolve))
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
