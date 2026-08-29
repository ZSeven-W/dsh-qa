import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager, discoverInstalledBrowser } from '@zseven-w/dsh-browser'
import { BrowserAdapter } from '../src/adapters/index.ts'
import { QaSession } from '../src/session/index.ts'

const FIXTURE_HTML = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'web', 'index.html')

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

test('fixture flow: observe/fill/click/re-observe PASS; publish rejected; evidence redacted; profile cleaned', { timeout: 120_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  const html = await readFile(FIXTURE_HTML, 'utf8')
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    if (requestUrl.pathname === '/api/probe') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port

  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-qa-browser-'))
  const driver = new BrowserManager({ rootDir, allowedOrigins: [origin] })
  const session = new QaSession(new BrowserAdapter(driver), 'qa-integration')

  try {
    const info = await session.start({ url: origin })
    assert.equal(info.headless, true)

    // observe -> find the labeled input and the validate button
    const observed = await session.observe()
    const nameInput = observed.nodes.find((n) => n.role === 'textbox' && n.name === 'Release name')
    const validate = observed.nodes.find((n) => n.name === 'Run validation')
    assert.ok(nameInput, 'labeled name input present')
    assert.ok(validate, 'Run validation button present')

    // fill
    const filled = await session.act({ kind: 'fill', ref: nameInput.ref, text: 'v1.0.0' })
    assert.equal(filled.outcome, 'ok')
    assert.equal(filled.receipt.status, 'confirmed')

    // re-observe -> click validate
    const afterFill = await session.observe()
    const validateAgain = afterFill.nodes.find((n) => n.name === 'Run validation')
    assert.ok(validateAgain, 'validate button present after fill')
    const clicked = await session.act({ kind: 'click', ref: validateAgain.ref })
    assert.equal(clicked.outcome, 'ok')
    assert.equal(clicked.receipt.status, 'confirmed')

    // re-observe -> PASS
    const reObserved = await session.observe()
    assert.ok(reObserved.nodes.some((n) => n.role === 'status' && n.name === 'PASS'), 'result region flipped to PASS')

    // Publish release is rejected from live target semantics
    const publish = reObserved.nodes.find((n) => n.name === 'Publish release')
    assert.ok(publish, 'Publish release control present')
    const publishResult = await session.act({ kind: 'click', ref: publish.ref })
    assert.equal(publishResult.outcome, 'failed')
    assert.equal(publishResult.receipt.status, 'rejected')
    assert.equal(publishResult.receipt.code, 'EXTERNAL_COMMIT_TARGET')
    assert.equal(publishResult.receipt.dispatched, false)
    assert.ok(publishResult.evidence.some((e) => e.code === 'EXTERNAL_COMMIT_TARGET'), 'receipt attached as evidence')

    // bounded, redacted evidence
    const evidence = await session.evidence({ maxConsole: 20, maxNetwork: 20 })
    const encoded = JSON.stringify(evidence)
    assert.equal(evidence.bounded, true)
    assert.ok(Array.isArray(evidence.console))
    assert.ok(Array.isArray(evidence.network))
    assert.ok(evidence.console.some((c) => typeof c.text === 'string' && c.text.includes('REDACTED')), 'console evidence carries a redaction marker')
    assert.ok(evidence.network.some((n) => typeof n.url === 'string' && n.url.includes('/api/probe')), 'network evidence captures the probe')
    assert.doesNotMatch(encoded, /qa_bearer_SECRET_20260825/)
    assert.doesNotMatch(encoded, /qa_query_SECRET_20260825/)
    for (const record of evidence.network) {
      if (typeof record.url === 'string') assert.doesNotMatch(record.url, /token=/, 'network URLs omit query secrets')
    }

    // stop -> no temporary browser profile remains
    const stop = await session.stop()
    assert.equal(stop.stopped, true)
    assert.deepEqual(await readdir(rootDir), [], 'no temporary browser profile remains after stop')
    assert.deepEqual(driver.activeOwners(), [])
  } finally {
    await session.stop().catch(() => {})
    await driver.dispose()
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true })
  }
})
