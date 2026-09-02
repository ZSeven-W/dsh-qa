// Fail-closed structural regression tests (spec §2.0 / R4, ported from
// dsh-driver-bench @ a7af98d). These pin the three protections WP3 dropped in
// the dsh-qa redaction port, plus the broader structural boundary the
// driver-bench normalizer enforces.

import test from 'node:test'
import assert from 'node:assert/strict'
import { projectRedactedJsonValue } from '../src/redaction/index.ts'
import { renderReportMarkdown } from '../src/reporters/index.ts'
import type { JsonValue } from '../src/session/lossless.ts'

function makeRun(extra: Record<string, JsonValue> = {}) {
  return {
    schemaVersion: 1,
    scenario: 'corpus-run',
    driver: 'browser',
    status: 'pass',
    startedAt: '2026-08-29T00:00:00.000Z',
    finishedAt: '2026-08-29T00:00:01.000Z',
    steps: [],
    assertions: [],
    evidence: null,
    receiptSummary: { confirmed: 0, unknown: 0, rejected: 0, failed: 0, total: 0 },
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Regression 1 (CRITICAL): accessors are rejected, never invoked, and their
// value never lands in the artifact.
// ---------------------------------------------------------------------------
test('projection rejects accessors without invoking the getter or serializing its value', () => {
  let calls = 0
  const obj: Record<string, unknown> = {}
  Object.defineProperty(obj, 'boom', {
    enumerable: true,
    configurable: true,
    get() {
      calls += 1
      return 'SECRET'
    },
  })

  let message = ''
  try {
    projectRedactedJsonValue(obj)
  } catch (error) {
    message = (error as Error).message
  }

  assert.ok(message.length > 0, 'projection must reject the accessor')
  assert.match(message, /accessor/)
  assert.equal(calls, 0, 'the getter must never be invoked')
  assert.equal(message.includes('SECRET'), false, 'the getter value must never surface')
  assert.equal(message.includes('boom'), false, 'the key spelling must never surface')
})

// ---------------------------------------------------------------------------
// Regression 2 (HIGH): cycles reject with a deterministic structural error,
// never an uncontrolled stack overflow.
// ---------------------------------------------------------------------------
test('projection rejects cyclic values with a deterministic structural error', () => {
  const obj: Record<string, unknown> = { safe: 1 }
  obj.self = obj

  let caught: unknown
  try {
    projectRedactedJsonValue(obj)
  } catch (error) {
    caught = error
  }

  assert.ok(caught instanceof TypeError, 'must throw a TypeError')
  assert.ok(!(caught instanceof RangeError), 'must not be an uncontrolled stack overflow')
  assert.match((caught as Error).message, /cyclic/)
  assert.equal((caught as Error).message.includes('self'), false, 'key spelling must not surface')
})

// ---------------------------------------------------------------------------
// Regression 3 (MEDIUM) + corpus r11 original surface: the Markdown reporter
// escapes lone surrogates to a visible \uXXXX escape, never raw bytes.
// ---------------------------------------------------------------------------
test('renderReportMarkdown escapes lone surrogates and preserves valid pairs', () => {
  // Lone high surrogate (0xDBFF) and lone low surrogate (0xDFFF) plus a valid
  // surrogate pair (U+1F600 😀, D83D DE00).
  const output = renderReportMarkdown(makeRun({ scenario: 'x\uDBFFy\uDFFFz\uD83D\uDE00ok' }))

  assert.equal(output.includes('\uDBFF'), false, 'lone high surrogate reached report.md raw')
  assert.equal(output.includes('\uDFFF'), false, 'lone low surrogate reached report.md raw')
  assert.ok(output.includes('\\uDBFF'), 'lone high surrogate must render as \\uDBFF')
  assert.ok(output.includes('\\uDFFF'), 'lone low surrogate must render as \\uDFFF')
  assert.ok(output.includes('\uD83D\uDE00'), 'a valid surrogate pair must survive as-is')
})

// ---------------------------------------------------------------------------
// Structural boundary: non-plain objects, sparse arrays, non-finite numbers,
// and excessive depth all reject with structural-only errors.
// ---------------------------------------------------------------------------
test('projection rejects non-plain objects', () => {
  assert.throws(
    () => projectRedactedJsonValue(Object.create({ inherited: 1 })),
    /non-plain object/,
  )
})

test('projection rejects sparse arrays', () => {
  const sparse: unknown[] = [1]
  sparse.length = 3
  assert.throws(() => projectRedactedJsonValue(sparse), /sparse array/)
})

test('projection rejects non-finite numbers', () => {
  assert.throws(() => projectRedactedJsonValue({ n: NaN }), /non-finite number/)
  assert.throws(() => projectRedactedJsonValue(Infinity), /non-finite number/)
})

test('projection rejects excessive nesting depth', () => {
  let deep: JsonValue = 'leaf'
  for (let i = 0; i < 300; i++) deep = { child: deep }
  assert.throws(() => projectRedactedJsonValue(deep), /maximum nesting depth/)
})

// ---------------------------------------------------------------------------
// Regression 4: a structural rejection's error message carries only structural
// position — never a key spelling and never value bytes.
// ---------------------------------------------------------------------------
test('projection structural errors never leak key spellings or value bytes', () => {
  const secretKey = 'api_hunter2_password'
  const secretValue = 'S3CR3T-VALUE-BYTES-9f8e7d'
  const inputs: Array<() => unknown> = [
    () => {
      const o: Record<string, unknown> = {}
      Object.defineProperty(o, secretKey, {
        enumerable: true,
        configurable: true,
        get: () => secretValue,
      })
      return o
    },
    () => {
      const o: Record<string, unknown> = { [secretKey]: secretValue }
      o.self = o
      return o
    },
    () => {
      const arr: unknown[] = [secretValue]
      arr.length = 3
      return arr
    },
  ]

  for (const make of inputs) {
    let message = ''
    try {
      projectRedactedJsonValue(make())
    } catch (error) {
      message = (error as Error).message
    }
    assert.ok(message.length > 0, 'projection must fail closed')
    assert.equal(message.includes(secretKey), false, 'key spelling leaked: ' + message)
    assert.equal(message.includes(secretValue), false, 'value bytes leaked: ' + message)
  }
})

// ---------------------------------------------------------------------------
// Restored corpus r17 surface: an own __proto__ data key survives projection
// without ever invoking the prototype setter.
// ---------------------------------------------------------------------------
test('projection preserves an own __proto__ data key without the prototype setter', () => {
  const obj = JSON.parse('{"__proto__": {"token": "S3CR3T"}, "keep": 1}') as Record<string, unknown>
  const originalProto = Object.getOwnPropertyDescriptor(Object.prototype, '__proto__')!
  Object.defineProperty(Object.prototype, '__proto__', {
    configurable: true,
    enumerable: false,
    get() {
      return Object.getPrototypeOf(this)
    },
    set() {
      throw new Error('__proto__ setter invoked')
    },
  })
  try {
    const projected = projectRedactedJsonValue(obj) as Record<string, unknown>
    assert.equal(Object.prototype.hasOwnProperty.call(projected, '__proto__'), true)
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(projected, '__proto__')!.value,
      { token: '[REDACTED]' },
    )
  } finally {
    Object.defineProperty(Object.prototype, '__proto__', originalProto)
  }
})