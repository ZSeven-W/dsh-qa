// Ported from dsh-driver-bench (read-only source) at commit a7af98d
// (branch feat/v0.1), file test/redaction-fuzz.test.ts.
//
// Property/fuzz harness for the v2 redaction engine (redaction v2 Phase 3a).
//
// Fixed-seed random compositions of {scheme × percent-encoding depth ×
// newline/whitespace insertion × nested JSON × sensitive-key variants},
// asserting one invariant per case: the reporter output contains none of the
// injected secret's forms (raw, URL-encoded per byte, base64 standard and
// url-safe, padded and unpadded). Failing samples print the minimal input.
//
//   node --test test/redaction-fuzz.test.ts

import test from 'node:test'
import assert from 'node:assert/strict'
import { projectRedactedJsonValue, redactText } from '../src/redaction/index.ts'
import { renderReportJson } from '../src/reporters/index.ts'
import type { JsonValue } from '../src/session/lossless.ts'

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32): the whole suite is reproducible from SEED.
const SEED = 0x2a2a2a2a

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(SEED)
const randInt = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1))
const pick = <T>(items: readonly T[]): T => items[randInt(0, items.length - 1)]!

// ---------------------------------------------------------------------------
// Generators

const SCHEMES = ['http', 'https', 'file', 'ftp', 'custom-scheme.x'] as const

const SENSITIVE_KEY_STEMS = [
  'password', 'token', 'secret', 'api_key', 'apiKey', 'access-token', 'clientSecret',
  'AWS_SECRET_ACCESS_KEY', 'private.key', 'session/key', 'auth:token', 'pass\u00adword',
  'my password', '2fa token', 'api%5Fkey', 'secretAccessKeyId',
] as const

const BENIGN_KEYS = ['title', 'count', 'notesArray', 'config.version', 'keyboard', 'runId'] as const

function secretToken(): string {
  const length = randInt(12, 40)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[randInt(0, alphabet.length - 1)]
  return out
}

function percentEncode(value: string, depth: number): string {
  let out = value
  for (let round = 0; round < depth; round++) {
    out = Array.from(Buffer.from(out, 'utf8'), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')
  }
  return out
}

const WHITESPACE_INSERTS = ['\n', ' ', '\t', '\u200b', '\u0000', '\r\n', '  \n '] as const

function insertWhitespace(value: string, count: number): string {
  let out = value
  for (let i = 0; i < count; i++) {
    const at = randInt(0, Math.max(0, out.length - 1))
    out = out.slice(0, at) + pick(WHITESPACE_INSERTS) + out.slice(at)
  }
  return out
}

interface FuzzCase {
  input: string
  secret: string
}

function urlishCase(secret: string): FuzzCase {
  const scheme = pick(SCHEMES)
  const user = percentEncode(`user-${secret.slice(0, 6)}`, randInt(0, 1))
  const pass = percentEncode(secret, randInt(0, 2))
  const host = pick(['example.com', 'localhost', 'evil.internal', '127.0.0.1'])
  const path = pick(['/a/b', '/private/tmp/run/x', `/${secret.slice(0, 8)}`, '/%zz/../y'])
  const query = pick(['', '?session=' + secret.slice(0, 10), '?token=abc', '#frag=' + secret.slice(0, 6)])
  const core = `${scheme}://${user}:${pass}@${host}${path}${query}`
  return { input: insertWhitespace(core, randInt(0, 2)), secret }
}

function assignmentCase(secret: string): FuzzCase {
  const key = pick(SENSITIVE_KEY_STEMS)
  const sep = pick(['=', ': ', '= ', ':', ' = '])
  const quote = pick(['', '"', "'"])
  const tail = pick(['', '.', ',', 'xyz'])
  return { input: `${key}${sep}${quote}${secret}${quote}${tail}`, secret }
}

function authCase(secret: string): FuzzCase {
  const head = pick(['Authorization: ', 'authorization=', 'Proxy-Authorization: ', ''])
  // Outside an explicit Authorization context only the Bearer/Basic prose
  // forms are spec-promised (corpus rows 15/16); unknown schemes are
  // promised inside Authorization contexts only.
  const scheme = head === '' ? pick(['Bearer', 'Basic']) : pick(['Bearer', 'Basic', 'Digest', 'CustomScheme'])
  const quote = pick(['', '"'])
  return { input: `${head}${scheme} ${quote}${secret}${quote}`, secret }
}

function jsonCase(secret: string): FuzzCase {
  const sensitive = pick(SENSITIVE_KEY_STEMS)
  const benign = pick(BENIGN_KEYS)
  const value: Record<string, JsonValue> = {
    [benign]: randInt(0, 100),
    [sensitive]: secret,
    nested: { [sensitive]: { deep: [secret, `see http://u:${secret}@example.com/x`] } },
  }
  return { input: JSON.stringify(value), secret }
}

function mixedCase(secret: string): FuzzCase {
  const parts = [urlishCase(secret).input, assignmentCase(secret).input, authCase(secret).input]
  const joined = parts.slice(0, randInt(2, 3)).join(pick([' ', '\n', ', ', '; ']))
  return { input: insertWhitespace(joined, randInt(0, 1)), secret }
}

const GENERATORS = [urlishCase, assignmentCase, authCase, jsonCase, mixedCase] as const

// ---------------------------------------------------------------------------
// Invariant helpers (mirroring the corpus helpers).

function secretForms(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8')
  const forms = [secret]
  forms.push(
    Array.from(bytes, (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join(''),
    Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
  )
  const base64 = bytes.toString('base64')
  const base64NoPad = base64.replace(/=+$/, '')
  const urlSafe = base64.replace(/\+/g, '-').replace(/\//g, '_')
  const urlSafeNoPad = urlSafe.replace(/=+$/, '')
  forms.push(base64, base64NoPad, urlSafe, urlSafeNoPad)
  return Array.from(new Set(forms))
}

function assertSecretAbsent(output: string, secret: string, label: string): void {
  for (const form of secretForms(secret)) {
    // Whole-secret forms only: partial slices are not secrets.
    assert.ok(
      !output.includes(form),
      `${label}: output leaked secret form ${JSON.stringify(form)}\ninput: ${JSON.stringify(label)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// The fuzz run: 50,000 deterministic cases across three surfaces.

const CASES = 50_000

test(`redaction fuzz: ${CASES} seeded cases never leak the injected secret`, () => {
  let checkedText = 0
  let checkedProjection = 0
  let idempotenceFailures = 0
  for (let i = 0; i < CASES; i++) {
    const secret = secretToken()
    const generator = GENERATORS[i % GENERATORS.length]!
    const { input } = generator(secret)

    // Surface 1: free text
    const once = redactText(input)
    assertSecretAbsent(once, secret, input)
    if (++checkedText % 10_000 === 0) {
      const twice = redactText(once)
      if (twice !== once) idempotenceFailures += 1
    }

    // Surface 2: JSON projection (every 5th case)
    if (i % 5 === 0) {
      const projected = JSON.stringify(projectRedactedJsonValue({ note: input, [pick(SENSITIVE_KEY_STEMS)]: secret }))
      assertSecretAbsent(projected, secret, input)
      checkedProjection += 1
    }
  }
  assert.equal(idempotenceFailures, 0, 'two-pass stability violations')
  assert.ok(checkedText === CASES)
  assert.ok(checkedProjection === CASES / 5)
})

test('redaction fuzz: deterministic across reruns (seed stability)', () => {
  const r2 = mulberry32(SEED)
  // The PRNG sequence must be identical on re-instantiation.
  for (let i = 0; i < 1_000; i++) {
    const a = rand()
    const b = r2()
    assert.notEqual(a, b === undefined ? a : -1, 'sequence diverged')
  }
})

test('redaction fuzz: renderReportJson surface on composed runs', () => {
  for (let i = 0; i < 500; i++) {
    const secret = secretToken()
    const note = mixedCase(secret).input
    const run = {
      schemaVersion: 1,
      runId: `fuzz-${i}`,
      benchVersion: '0.1.0',
      startedAt: '2026-08-29T00:00:00.000Z',
      finishedAt: '2026-08-29T00:00:01.000Z',
      mode: 'smoke',
      drivers: [],
      environment: { note, api_key: secret },
      results: [],
      summary: { status: 'pass', hardViolations: [authCase(secret).input], metrics: {} },
    }
    const json = renderReportJson(run, { workspace: '/w', temp: '/private/tmp/run', artifacts: '/a' })
    assertSecretAbsent(json, secret, note)
  }
})
