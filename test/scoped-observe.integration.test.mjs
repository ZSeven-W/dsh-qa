import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager, discoverInstalledBrowser } from '@zseven-w/dsh-browser'
import { BrowserAdapter } from '../src/adapters/index.ts'
import { QaSession } from '../src/session/index.ts'

// Real-Chrome integration for scoped observation (browser driver contract v8):
// a target unreachable in the whole-page window becomes reachable — and its
// subtree provably complete — by observing within a container. Driver refusals
// must propagate as themselves, never degrade into a whole-page view.

const FIXTURE_HTML = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'web', 'observe-scoped.html')

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withServer(fn) {
  const html = await readFile(FIXTURE_HTML, 'utf8')
  let port = 0
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  try {
    return await fn(origin)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

test('scoped observe reaches a deep target beyond the whole-page window and proves its subtree fits', { timeout: 120_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  await withServer(async (origin) => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-qa-scoped-'))
    const driver = new BrowserManager({ rootDir, allowedOrigins: [origin] })
    const session = new QaSession(new BrowserAdapter(driver), 'qa-scoped-integration')
    try {
      await session.start({ url: origin })

      // Whole-page observations at every shipped budget never reach the
      // container or its deep target, and never carry a scope.
      const wholeDefault = await session.observe()
      const whole100 = await session.observe({ maxNodes: 100 })
      for (const observed of [wholeDefault, whole100]) {
        assert.equal(observed.nodes.some((node) => node.name === 'Deep container'), false, 'the container sits beyond the whole-page window')
        assert.equal(observed.nodes.some((node) => node.name === 'Deep scoped target'), false, 'the deep target sits beyond the whole-page window')
        assert.equal(observed.scope, undefined, 'whole-page observations must not carry a scope')
      }
      assert.ok(whole100.truncated, 'the whole-page 100-node view is truncated')
      assert.ok(whole100.truncationReasons?.includes('node-budget-exceeded'), JSON.stringify(whole100.truncationReasons))

      // Narrow to the main region: the container lands exactly at the 100th node.
      // The within ref must come from the CURRENT (latest) observation — the
      // wholeDefault refs were consumed by the whole100 observe above.
      const anchorView = await session.observe()
      const anchor = anchorView.nodes.find((node) => node.name === 'Scope anchor region')
      assert.ok(anchor, 'the scope anchor is inside the whole-page window')
      const narrow = await session.observe({ withinRef: anchor.ref, maxNodes: 100 })
      // The driver's scope echo is projected VERBATIM; Phase B adds a FRESH
      // rootRef field (contract v9), so pin the stable identity fields and
      // tolerate the additive one rather than freezing the in-flight shape.
      assert.equal(narrow.scope?.ref, anchor.ref, 'the scope echoes the passed within ref')
      assert.equal(narrow.scope?.role, 'region')
      assert.equal(narrow.scope?.name, 'Scope anchor region')
      assert.equal(narrow.scope?.tag, 'main')
      assert.ok(
        narrow.scope?.rootRef === undefined || typeof narrow.scope.rootRef === 'string',
        'an additive rootRef (driver contract v9) is a string when present',
      )
      const container = narrow.nodes.find((node) => node.name === 'Deep container')
      assert.ok(container, 'the narrow observation reaches the container')
      assert.equal(narrow.nodes.length, 100, 'main + 98 probes + container fill the 100-node scoped budget')
      assert.ok(narrow.truncated, 'the main-scoped view is partial')
      assert.ok(narrow.truncationReasons?.includes('node-budget-exceeded'), JSON.stringify(narrow.truncationReasons))
      assert.ok(narrow.truncationReasons?.includes('iframe-not-traversed'), 'the iframe inside main must flag the main-scoped view: ' + JSON.stringify(narrow.truncationReasons))

      // Scope to the container: the whole subtree fits, truncated false with no
      // reasons. (Absence inside it passes only with verified coverage —
      // QA-BL-052 / C2 — but the deep target is now REACHABLE.)
      const scoped = await session.observe({ withinRef: container.ref, maxNodes: 40 })
      const deep = scoped.nodes.find((node) => node.name === 'Deep scoped target')
      assert.ok(deep, 'the scoped observe returns the deep target: ' + JSON.stringify(scoped.nodes.map((node) => node.name)))
      assert.equal(scoped.truncated, false, 'a subtree that fits must report truncated false')
      assert.equal(scoped.truncationReasons, undefined, 'no reasons when the subtree fits: ' + JSON.stringify(scoped.truncationReasons))
      assert.equal(scoped.maxNodes, 40, 'the applied budget keeps reporting')
      // Same tolerance as above: the driver's scope echo is verbatim, and
      // Phase B adds an additive fresh rootRef (contract v9).
      assert.equal(scoped.scope?.ref, container.ref, 'the scope echoes the passed within ref')
      assert.equal(scoped.scope?.role, 'region')
      assert.equal(scoped.scope?.name, 'Deep container')
      assert.equal(scoped.scope?.tag, 'div')
      assert.ok(
        scoped.scope?.rootRef === undefined || typeof scoped.scope.rootRef === 'string',
        'an additive rootRef (driver contract v9) is a string when present',
      )
      assert.equal(scoped.nodes.length, 32, 'the container subtree holds 32 semantic matches')
      assert.ok(!scoped.nodes.some((node) => node.name.startsWith('probe-')), 'the scoped view must contain subtree nodes only')
      assert.ok(scoped.nodes.some((node) => node.name.startsWith('shadow-deep-')), 'open shadow roots must pierce inside the scope')
      assert.ok(scoped.nodes.every((node) => node.name !== 'anchor-prev'), 'nodes outside the subtree must not leak in')
      assert.equal(deep.href, 'https://example.com/scoped/page', 'the deep target keeps its scrubbed href')

      // A SETTLED scoped read polls several times; each poll must re-key the
      // within ref to the re-collected scope root (the previous observation was
      // consumed by the poll before it). passes >= 2 proves the second poll
      // succeeded instead of refusing REF_UNKNOWN.
      const scopedRoot = scoped.nodes.find((node) => node.role === 'region' && node.name === 'Deep container')
      assert.ok(scopedRoot, 'the scope root node is re-collected with a fresh ref')
      const settledScoped = await session.observeSettled({ withinRef: scopedRoot.ref, maxNodes: 40 })
      assert.equal(settledScoped.stable, true)
      assert.ok(settledScoped.passes >= 2, 'the settled scoped read must poll more than once: ' + String(settledScoped.passes))
      assert.equal(settledScoped.observation.truncated, false)
      assert.ok(settledScoped.observation.nodes.some((node) => node.name === 'Deep scoped target'), 'the settled scoped view keeps the deep target')
      // The scope echo carries the ref of the LAST poll's resolution (each
      // poll re-keys), while role/name/tag always name the same container.
      assert.equal(settledScoped.observation.scope.role, 'region')
      assert.equal(settledScoped.observation.scope.name, 'Deep container')
      assert.equal(settledScoped.observation.scope.tag, 'div')
      assert.ok(typeof settledScoped.observation.scope.ref === 'string' && settledScoped.observation.scope.ref.length > 0)
    } finally {
      await session.stop().catch(() => {})
      await driver.dispose()
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

test('scoped observe driver refusals propagate verbatim and never fall back to a whole-page view', { timeout: 120_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  await withServer(async (origin) => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-qa-scoped-refusals-'))
    // The driver clamps the observation TTL to a 1000ms minimum; sleep past
    // it so the captured ref is genuinely expired.
    const driver = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 1000 })
    const session = new QaSession(new BrowserAdapter(driver), 'qa-scoped-refusals')
    try {
      await session.start({ url: origin })
      const fresh = await session.observe()
      assert.ok(fresh.nodes.length > 0)

      // A ref that is not part of the current observation: REF_UNKNOWN.
      await assert.rejects(
        session.observe({ withinRef: 'br_bogus_ref' }),
        (error) => error.code === 'REF_UNKNOWN' && error.name === 'DriverIssue',
      )

      // A malformed ref: REF_INVALID.
      await assert.rejects(
        session.observe({ withinRef: 'x'.repeat(200) }),
        (error) => error.code === 'REF_INVALID' && error.name === 'DriverIssue',
      )

      // An expired ref (the observation TTL elapsed): REF_EXPIRED.
      const doomed = fresh.nodes.find((node) => node.name === 'Scope anchor region')
      assert.ok(doomed)
      await sleep(1200)
      await assert.rejects(
        session.observe({ withinRef: doomed.ref }),
        (error) => error.code === 'REF_EXPIRED' && error.name === 'DriverIssue',
      )

      // A refusal never breaks the next legitimate observation.
      const after = await session.observe()
      assert.ok(after.nodes.some((node) => node.name === 'Scope anchor region'), 'the session still observes normally after refusals')
    } finally {
      await session.stop().catch(() => {})
      await driver.dispose()
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
