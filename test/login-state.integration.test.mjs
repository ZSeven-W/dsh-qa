import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserManager, BROWSER_DRIVER_CONTRACT_VERSION, discoverInstalledBrowser } from '@zseven-w/dsh-browser'
import { BrowserAdapter } from '../src/adapters/index.ts'
import { QaSession } from '../src/session/index.ts'
import { runScenario } from '../src/replay/index.ts'
import { writeReports } from '../src/reporters/index.ts'

// Two DISTINCT loopback origins: 127.0.0.1 (authorized) and localhost
// (unauthorized). They are different hosts, so BOTH cookie (host-scoped) and
// localStorage (origin-scoped) filtering are genuinely observable end to end.
// (Cookies ignore ports, so two ports on 127.0.0.1 alone could not distinguish
// cookie injection.)

const AUTH_PAGE = `<!doctype html><html><head><title>login fixture</title></head><body>
  <div id="status" role="status">boot</div>
  <script>
    (function () {
      var hasCookie = document.cookie.split(';').some(function (c) { return c.trim().indexOf('qa_session=') === 0 });
      var user = localStorage.getItem('qa_user');
      var el = document.getElementById('status');
      el.textContent = (hasCookie && user) ? ('logged in as ' + user) : 'logged out';
    })();
  </script>
</body></html>`

async function listen(server, host) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  return server.address().port
}

function cookie(domain, value) {
  return { name: 'qa_session', value, domain, path: '/', expires: 4102444800, httpOnly: false, secure: false, sameSite: 'Lax' }
}

function secretForms(secret) {
  const bytes = Buffer.from(secret, 'utf8')
  const forms = [secret]
  forms.push(
    Array.from(bytes, (b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''),
    Array.from(bytes, (b) => '%' + b.toString(16).padStart(2, '0')).join(''),
  )
  const b64 = bytes.toString('base64')
  const b64NoPad = b64.replace(/=+$/, '')
  const urlSafe = b64.replace(/\+/g, '-').replace(/\//g, '_')
  const urlSafeNoPad = urlSafe.replace(/=+$/, '')
  forms.push(b64, b64NoPad, urlSafe, urlSafeNoPad)
  return Array.from(new Set(forms))
}

function assertSecretAbsent(text, secret, label) {
  assert.ok(secret.length > 0)
  for (const form of secretForms(secret)) {
    assert.ok(!text.includes(form), label + ' must not contain ' + JSON.stringify(form))
  }
}

async function assertReportsDoNotContain(dir, secret) {
  for (const name of ['report.json', 'report.md', 'report.jsonl']) {
    const text = await readFile(join(dir, name), 'utf8')
    assertSecretAbsent(text, secret, name)
  }
}

test('login-state: authorized origin injected, other origin filtered, profile destroyed', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  if (BROWSER_DRIVER_CONTRACT_VERSION < 4) {
    t.skip('browser driver contract < 4: storageState injection not available')
    return
  }

  const serverA = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(AUTH_PAGE) })
  const serverB = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(AUTH_PAGE) })
  const portA = await listen(serverA, '127.0.0.1')
  const portB = await listen(serverB, 'localhost')
  const originA = 'http://127.0.0.1:' + portA
  const originB = 'http://localhost:' + portB

  const COOKIE_A = 'wp11_COOKIE_AUTH_8f3a7c2b'
  const COOKIE_B = 'wp11_COOKIE_OTHER_1d9e4a5f'
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-qa-loginstate-'))
  const stateFile = join(stateDir, 'state.json')
  await writeFile(stateFile, JSON.stringify({
    cookies: [cookie('127.0.0.1', COOKIE_A), cookie('localhost', COOKIE_B)],
    origins: [
      { origin: originA, localStorage: [{ name: 'qa_user', value: 'alice' }] },
      { origin: originB, localStorage: [{ name: 'qa_user', value: 'mallory' }] },
    ],
  }), 'utf8')

  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-qa-login-browser-'))
  const driver = new BrowserManager({ rootDir, allowedOrigins: [originA, originB] })
  const session = new QaSession(new BrowserAdapter(driver), 'login-integration')

  try {
    const info = await session.start({ url: originA, loginState: { source: stateFile, origins: [originA] } })
    assert.equal(info.headless, true)

    const observedA = await session.observe()
    assert.ok(
      observedA.nodes.some((n) => n.role === 'status' && n.name === 'logged in as alice'),
      'authorized origin shows logged-in (cookie + localStorage injected)',
    )

    // The OTHER origin's entries (cookie localhost + localStorage mallory) were
    // filtered out at injection time and must never be observable.
    await session.act({ kind: 'navigate', url: originB })
    const observedB = await session.observe()
    assert.ok(observedB.nodes.some((n) => n.role === 'status' && n.name === 'logged out'), 'other origin shows logged-out')
    assert.ok(!observedB.nodes.some((n) => n.name === 'logged in as mallory'), 'other origin never sees mallory')

    const stop = await session.stop()
    assert.equal(stop.stopped, true)
    assert.deepEqual(await readdir(rootDir), [], 'no temporary browser profile remains after stop')
  } finally {
    await session.stop().catch(() => {})
    await driver.dispose()
    serverA.closeAllConnections?.()
    await new Promise((resolve) => serverA.close(resolve))
    serverB.closeAllConnections?.()
    await new Promise((resolve) => serverB.close(resolve))
    await rm(stateDir, { recursive: true, force: true })
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('login-state: cookie value never reaches report artifacts (success path)', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  if (BROWSER_DRIVER_CONTRACT_VERSION < 4) {
    t.skip('browser driver contract < 4: storageState injection not available')
    return
  }

  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(AUTH_PAGE) })
  const port = await listen(server, '127.0.0.1')
  const origin = 'http://127.0.0.1:' + port
  const COOKIE_SECRET = 'wp11_REPORT_SECRET_5b6c7d8e'
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-qa-loginstate-'))
  const stateFile = join(stateDir, 'state.json')
  await writeFile(stateFile, JSON.stringify({
    cookies: [cookie('127.0.0.1', COOKIE_SECRET)],
    origins: [{ origin, localStorage: [{ name: 'qa_user', value: 'alice' }] }],
  }), 'utf8')

  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-qa-login-browser-'))
  const reportDir = await mkdtemp(join(tmpdir(), 'dsh-qa-login-report-'))
  const driver = new BrowserManager({ rootDir, allowedOrigins: [origin] })
  const adapter = new BrowserAdapter(driver)

  try {
    const scenario = {
      meta: { name: 'login-leak-success', description: 'd', driver: 'browser', createdAt: '2026-08-30T00:00:00.000Z' },
      target: { launch: origin, loginState: { source: stateFile, origins: [origin] } },
      steps: [],
      assertions: [{ kind: 'node-present', expected: { role: 'status', name: 'logged in as alice' } }],
    }
    const report = await runScenario(scenario, adapter, { ownerId: 'login-leak', launchUrl: origin, headless: true })
    assert.equal(report.status, 'pass')
    await writeReports(report, { directory: reportDir })
    await assertReportsDoNotContain(reportDir, COOKIE_SECRET)
  } finally {
    await driver.dispose()
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(stateDir, { recursive: true, force: true })
    await rm(rootDir, { recursive: true, force: true })
    await rm(reportDir, { recursive: true, force: true })
  }
})

test('login-state: cookie value never reaches report artifacts (error path)', async () => {
  // The error path fails closed in loadLoginState BEFORE any browser launch, so
  // this runs without real Chrome against a recording fake driver.
  const COOKIE_SECRET = 'wp11_ERROR_SECRET_2a3b4c5d'
  const calls = []
  const fakeDriver = {
    kind: 'browser',
    contractVersion: 4,
    async start(ownerId, options) {
      calls.push({ ownerId, options })
      throw new Error('driver.start must never run for this error path')
    },
    async observe() { throw new Error('unused') },
    async visualObserve() { throw new Error('unused') },
    async act() { throw new Error('unused') },
    async evidence() { throw new Error('unused') },
    async stop(ownerId) { return { ownerId, stopped: true, reason: 'requested' } },
    async disposeScope() {},
    async dispose() {},
  }

  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-qa-loginstate-'))
  const stateFile = join(stateDir, 'state.json')
  await writeFile(stateFile, JSON.stringify({
    cookies: [cookie('localhost', COOKIE_SECRET)],
    origins: [],
  }), 'utf8')
  const reportDir = await mkdtemp(join(tmpdir(), 'dsh-qa-login-report-'))

  try {
    const scenario = {
      meta: { name: 'login-leak-error', description: 'd', driver: 'browser', createdAt: '2026-08-30T00:00:00.000Z' },
      target: { launch: 'http://127.0.0.1:8001', loginState: { source: stateFile, origins: ['http://127.0.0.1:8001'] } },
      steps: [],
      assertions: [],
    }
    const report = await runScenario(scenario, new BrowserAdapter(fakeDriver), { ownerId: 'login-leak-error', launchUrl: 'http://127.0.0.1:8001' })
    assert.equal(report.status, 'blocked')
    assert.equal(calls.length, 0, 'driver.start must never run for a failed injection')
    await writeReports(report, { directory: reportDir })
    await assertReportsDoNotContain(reportDir, COOKIE_SECRET)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
    await rm(reportDir, { recursive: true, force: true })
  }
})

