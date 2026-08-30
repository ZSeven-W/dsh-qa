import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LoginStateError,
  loadLoginState,
  validateLoginStateConfig,
} from '../src/loginState.ts'

async function tempStateFile(contents) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-loginstate-'))
  const file = join(dir, 'state.json')
  await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8')
  return { dir, file }
}

function cookie(overrides = {}) {
  return {
    name: 'session_token',
    value: 'SECRET_COOKIE_VALUE',
    domain: '127.0.0.1',
    path: '/',
    expires: 4102444800,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
    ...overrides,
  }
}

test('validateLoginStateConfig accepts a well-formed config and normalizes origins', () => {
  const config = validateLoginStateConfig({
    source: '/tmp/state.json',
    origins: ['https://app.example.com/', 'http://127.0.0.1:8080'],
  })
  assert.deepEqual(config.origins, ['https://app.example.com', 'http://127.0.0.1:8080'])
})

test('validateLoginStateConfig rejects malformed shapes without echoing values', () => {
  assert.throws(() => validateLoginStateConfig(null), LoginStateError)
  assert.throws(() => validateLoginStateConfig('x'), LoginStateError)
  assert.throws(() => validateLoginStateConfig({ source: 'x' }), LoginStateError)
  assert.throws(() => validateLoginStateConfig({ source: 'x', origins: [] }), LoginStateError)
  assert.throws(() => validateLoginStateConfig({ source: 'x', origins: ['not-a-url'] }), LoginStateError)
  assert.throws(() => validateLoginStateConfig({ source: 'x', origins: ['file:///etc'] }), LoginStateError)
  assert.throws(() => validateLoginStateConfig({ source: 'x', origins: ['https://app.example.com/path'] }), LoginStateError)
  assert.throws(() => validateLoginStateConfig({ source: 'x', origins: ['https://app.example.com?q=1'] }), LoginStateError)
  assert.throws(() => validateLoginStateConfig({ source: 'x', origins: ['https://user:pass@example.com'] }), LoginStateError)
  assert.throws(() => validateLoginStateConfig({ source: 'x', origins: ['https://app.example.com'], extra: 1 }), LoginStateError)
})

test('loadLoginState injects only entries matching the authorized origins', async () => {
  const { dir, file } = await tempStateFile({
    cookies: [
      cookie({ name: 'qa_session', value: 'AUTH_SECRET', domain: '127.0.0.1' }),
      cookie({ name: 'qa_session', value: 'OTHER_SECRET', domain: 'localhost' }),
    ],
    origins: [
      { origin: 'http://127.0.0.1:8001', localStorage: [{ name: 'qa_user', value: 'alice' }] },
      { origin: 'http://127.0.0.1:8002', localStorage: [{ name: 'qa_user', value: 'mallory' }] },
    ],
  })
  try {
    const state = await loadLoginState({ source: file, origins: ['http://127.0.0.1:8001'] })
    assert.equal(state.cookies.length, 1)
    assert.equal(state.cookies[0].value, 'AUTH_SECRET')
    assert.equal(state.origins.length, 1)
    assert.equal(state.origins[0].origin, 'http://127.0.0.1:8001')
    assert.deepEqual(state.origins[0].localStorage, [{ name: 'qa_user', value: 'alice' }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadLoginState cookie domain matching: exact host and dot-prefix only', async () => {
  // Matching domains inject; non-matching domains leave zero authorized entries
  // and fail closed (never a silently-partial state).
  const matching = ['app.example.com', '.app.example.com']
  for (const domain of matching) {
    const { dir, file } = await tempStateFile({
      cookies: [cookie({ domain })],
      origins: [],
    })
    try {
      const state = await loadLoginState({ source: file, origins: ['https://app.example.com'] })
      assert.equal(state.cookies.length, 1, 'domain ' + domain + ' must inject')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const nonMatching = ['example.com', 'sub.app.example.com', 'other.com']
  for (const domain of nonMatching) {
    const { dir, file } = await tempStateFile({
      cookies: [cookie({ domain })],
      origins: [],
    })
    try {
      await assert.rejects(
        () => loadLoginState({ source: file, origins: ['https://app.example.com'] }),
        /no entries for the authorized origins/,
        'domain ' + domain + ' must not inject and must fail closed',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

test('loadLoginState fails when the file has no authorized entries', async () => {
  const { dir, file } = await tempStateFile({
    cookies: [cookie({ domain: 'localhost', value: 'OTHER_SECRET' })],
    origins: [{ origin: 'http://127.0.0.1:8002', localStorage: [{ name: 'qa_user', value: 'mallory' }] }],
  })
  try {
    await assert.rejects(
      () => loadLoginState({ source: file, origins: ['http://127.0.0.1:8001'] }),
      (error) => {
        assert.ok(error instanceof LoginStateError)
        assert.match(error.message, /no entries for the authorized origins/)
        assert.doesNotMatch(error.message, /OTHER_SECRET/)
        assert.doesNotMatch(error.message, /localhost/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadLoginState fails closed on unreadable, invalid, and malformed files', async () => {
  await assert.rejects(
    () => loadLoginState({ source: '/nonexistent/dsh-qa-state.json', origins: ['https://app.example.com'] }),
    /not readable/,
  )

  const invalid = await tempStateFile('{ not valid json')
  try {
    await assert.rejects(
      () => loadLoginState({ source: invalid.file, origins: ['https://app.example.com'] }),
      /not valid JSON/,
    )
  } finally {
    await rm(invalid.dir, { recursive: true, force: true })
  }

  const malformedCookie = await tempStateFile({
    cookies: [{ name: 'x' }],
    origins: [],
  })
  try {
    await assert.rejects(
      () => loadLoginState({ source: malformedCookie.file, origins: ['https://app.example.com'] }),
      /cookies\[0\]\.value must be a string/,
    )
  } finally {
    await rm(malformedCookie.dir, { recursive: true, force: true })
  }

  const malformedOrigin = await tempStateFile({
    cookies: [],
    origins: [{ origin: 'http://127.0.0.1:8001' }],
  })
  try {
    await assert.rejects(
      () => loadLoginState({ source: malformedOrigin.file, origins: ['http://127.0.0.1:8001'] }),
      /origins\[0\]\.localStorage must be an array/,
    )
  } finally {
    await rm(malformedOrigin.dir, { recursive: true, force: true })
  }
})

test('loadLoginState error paths never echo cookie names or values', async () => {
  const secret = 'qa_cookie_SUPER_SECRET_9f3a'
  const { dir, file } = await tempStateFile({
    cookies: [cookie({ name: 'session_token', value: secret, domain: 'evil.invalid' })],
    origins: [],
  })
  try {
    await assert.rejects(
      () => loadLoginState({ source: file, origins: ['https://app.example.com'] }),
      (error) => {
        assert.ok(error instanceof LoginStateError)
        assert.doesNotMatch(error.message, new RegExp(secret))
        assert.doesNotMatch(error.message, /session_token/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

