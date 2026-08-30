import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserAdapter } from '../src/adapters/index.ts'
import { LoginStateError } from '../src/loginState.ts'

// Proves the adapter is the fail-closed scoping boundary: it filters the
// state file IN MEMORY (via loadLoginState) and hands the driver ONLY the
// entries that matched the authorized origins. Disabling that filter would
// make the first assertion below go RED (the driver would receive 2 cookies
// instead of 1), which is the disable-it-goes-RED proof for the filter.

function fakeDriver() {
  const calls = []
  return {
    kind: 'browser',
    contractVersion: 4,
    async start(ownerId, options) {
      calls.push({ ownerId, options })
      return {
        ownerId,
        state: 'running',
        headless: options?.headless !== false,
        browser: { channel: 'custom', version: '1' },
        page: { url: options?.url ?? 'about:blank', title: '' },
        isolation: 'ephemeral-user-data',
        navigationPolicy: { mode: 'unrestricted', allowedOrigins: [] },
      }
    },
    async observe() { throw new Error('unused') },
    async visualObserve() { throw new Error('unused') },
    async act() { throw new Error('unused') },
    async evidence() { throw new Error('unused') },
    async stop(ownerId) { return { ownerId, stopped: true, reason: 'requested' } },
    async disposeScope() {},
    async dispose() {},
    _calls: calls,
  }
}

test('adapter passes only the authorized-origin entries to the driver', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-adapter-loginstate-'))
  const file = join(dir, 'state.json')
  await writeFile(file, JSON.stringify({
    cookies: [
      { name: 'qa_session', value: 'AUTH_SECRET', domain: '127.0.0.1', path: '/', expires: 4102444800, httpOnly: false, secure: false, sameSite: 'Lax' },
      { name: 'qa_session', value: 'OTHER_SECRET', domain: 'localhost', path: '/', expires: 4102444800, httpOnly: false, secure: false, sameSite: 'Lax' },
    ],
    origins: [
      { origin: 'http://127.0.0.1:8001', localStorage: [{ name: 'qa_user', value: 'alice' }] },
      { origin: 'http://127.0.0.1:8002', localStorage: [{ name: 'qa_user', value: 'mallory' }] },
    ],
  }), 'utf8')
  try {
    const driver = fakeDriver()
    const adapter = new BrowserAdapter(driver)
    const info = await adapter.start('owner-1', {
      url: 'http://127.0.0.1:8001',
      loginState: { source: file, origins: ['http://127.0.0.1:8001'] },
    })
    assert.equal(info.page.url, 'http://127.0.0.1:8001')
    assert.equal(driver._calls.length, 1)
    const storageState = driver._calls[0].options.storageState
    assert.ok(storageState, 'driver must receive a storageState')
    assert.equal(storageState.cookies.length, 1)
    assert.equal(storageState.cookies[0].value, 'AUTH_SECRET')
    assert.equal(storageState.origins.length, 1)
    assert.equal(storageState.origins[0].origin, 'http://127.0.0.1:8001')
    assert.deepEqual(storageState.origins[0].localStorage, [{ name: 'qa_user', value: 'alice' }])
    // The unauthorized cookie value must never reach the driver.
    assert.doesNotMatch(JSON.stringify(storageState), /OTHER_SECRET/)
    assert.doesNotMatch(JSON.stringify(storageState), /mallory/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('adapter start does not pass storageState when loginState is absent', async () => {
  const driver = fakeDriver()
  const adapter = new BrowserAdapter(driver)
  await adapter.start('owner-2', { url: 'http://127.0.0.1:8001' })
  assert.equal(driver._calls.length, 1)
  assert.equal(driver._calls[0].options.storageState, undefined)
})

test('adapter start fails closed when the state file has no authorized entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-adapter-loginstate-'))
  const file = join(dir, 'state.json')
  await writeFile(file, JSON.stringify({
    cookies: [{ name: 'qa_session', value: 'OTHER_SECRET', domain: 'localhost', path: '/', expires: 4102444800, httpOnly: false, secure: false, sameSite: 'Lax' }],
    origins: [],
  }), 'utf8')
  try {
    const driver = fakeDriver()
    const adapter = new BrowserAdapter(driver)
    await assert.rejects(
      () => adapter.start('owner-3', { url: 'http://127.0.0.1:8001', loginState: { source: file, origins: ['http://127.0.0.1:8001'] } }),
      (error) => {
        assert.ok(error instanceof LoginStateError)
        assert.doesNotMatch(error.message, /OTHER_SECRET/)
        return true
      },
    )
    assert.equal(driver._calls.length, 0, 'driver must never start on a failed injection')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

