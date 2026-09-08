import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseGroundingReply,
  groundingToNativePoint,
  GroundingError,
  GROUNDING_ERR_INPUT_TOO_LARGE,
  GROUNDING_ERR_PARSE,
  GROUNDING_ERR_SCHEMA,
  GROUNDING_ERR_NON_FINITE,
  GROUNDING_ERR_OUT_OF_RANGE,
  GROUNDING_ERR_CAPTURE,
} from '../src/grounding.ts'

/*
 * QA grounding pure helper suite (WP-GRND). No hosts, no providers, no side
 * effects: only strict JSON parsing into a normalized point and mapping that
 * point onto caller-trusted native-pixel capture dimensions.
 */

function expectGroundingCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof GroundingError, `expected GroundingError, got ${err?.constructor?.name}`)
    assert.equal(err.code, code)
    return true
  })
}

test('parseGroundingReply parses a plain strict JSON object', () => {
  const p = parseGroundingReply('{"x":500,"y":286,"confidence":0.97}')
  assert.deepEqual(p, { x: 500, y: 286, confidence: 0.97 })
})

test('parseGroundingReply accepts fractional normalized values and decimals', () => {
  const p = parseGroundingReply('{"x":0.5,"y":999.9,"confidence":0.12345}')
  assert.equal(p.x, 0.5)
  assert.equal(p.y, 999.9)
  assert.equal(p.confidence, 0.12345)
})

test('parseGroundingReply accepts both coordinate edges 0 and 1000', () => {
  const low = parseGroundingReply('{"x":0,"y":0,"confidence":0}')
  const high = parseGroundingReply('{"x":1000,"y":1000,"confidence":1}')
  assert.deepEqual(low, { x: 0, y: 0, confidence: 0 })
  assert.deepEqual(high, { x: 1000, y: 1000, confidence: 1 })
})

test('parseGroundingReply normalizes -0 to 0 for all numeric fields', () => {
  const p = parseGroundingReply('{"x":-0,"y":-0,"confidence":-0}')
  assert.ok(Object.is(p.x, 0))
  assert.ok(Object.is(p.y, 0))
  assert.ok(Object.is(p.confidence, 0))
})

test('parseGroundingReply strips one whole enclosing json code fence', () => {
  const p = parseGroundingReply('```json\n{"x":500,"y":286,"confidence":0.97}\n```')
  assert.deepEqual(p, { x: 500, y: 286, confidence: 0.97 })
})

test('parseGroundingReply strips one whole bare code fence', () => {
  const p = parseGroundingReply('```\n{"x":3,"y":4,"confidence":0.5}\n```')
  assert.deepEqual(p, { x: 3, y: 4, confidence: 0.5 })
})

test('parseGroundingReply strips one whole tilde code fence', () => {
  const p = parseGroundingReply('~~~json\n{"x":10,"y":20,"confidence":0.4}\n~~~')
  assert.deepEqual(p, { x: 10, y: 20, confidence: 0.4 })
})

test('parseGroundingReply does not extract JSON from surrounding prose', () => {
  const prose = 'The button is here {"x":500,"y":286,"confidence":0.97}'
  expectGroundingCode(() => parseGroundingReply(prose), GROUNDING_ERR_PARSE)
})

test('parseGroundingReply does not extract from prose plus a nested fence', () => {
  const text = 'I found it:\n```json\n{"x":500,"y":286,"confidence":0.97}\n```'
  expectGroundingCode(() => parseGroundingReply(text), GROUNDING_ERR_PARSE)
})

test('parseGroundingReply rejects double/nested whole fences (strips only one)', () => {
  const nested = '```json\n```json\n{"x":1,"y":2,"confidence":0.3}\n```\n```'
  expectGroundingCode(() => parseGroundingReply(nested), GROUNDING_ERR_PARSE)
})

test('parseGroundingReply rejects arrays, null, and primitives', () => {
  expectGroundingCode(() => parseGroundingReply('[1,2,3]'), GROUNDING_ERR_SCHEMA)
  expectGroundingCode(() => parseGroundingReply('null'), GROUNDING_ERR_SCHEMA)
  expectGroundingCode(() => parseGroundingReply('"text"'), GROUNDING_ERR_SCHEMA)
  expectGroundingCode(() => parseGroundingReply('42'), GROUNDING_ERR_SCHEMA)
})

test('parseGroundingReply rejects missing or extra keys (incl image schema)', () => {
  expectGroundingCode(() => parseGroundingReply('{"x":1,"y":2}'), GROUNDING_ERR_SCHEMA)
  expectGroundingCode(() => parseGroundingReply('{"x":1,"y":2,"confidence":0.5,"extra":1}'), GROUNDING_ERR_SCHEMA)
  expectGroundingCode(
    () => parseGroundingReply('{"x":1,"y":2,"confidence":0.5,"imageWidth":1206,"imageHeight":2622}'),
    GROUNDING_ERR_SCHEMA,
  )
  expectGroundingCode(
    () => parseGroundingReply('{"x":1,"y":2,"confidence":0.5,"nativepixel":"542x1178"}'),
    GROUNDING_ERR_SCHEMA,
  )
  expectGroundingCode(() => parseGroundingReply('{"x":1,"confidence":0.5}'), GROUNDING_ERR_SCHEMA)
})

test('parseGroundingReply rejects non-number / quoted values', () => {
  expectGroundingCode(() => parseGroundingReply('{"x":"500","y":1,"confidence":0.5}'), GROUNDING_ERR_SCHEMA)
  expectGroundingCode(() => parseGroundingReply('{"x":500,"y":null,"confidence":0.5}'), GROUNDING_ERR_SCHEMA)
  expectGroundingCode(() => parseGroundingReply('{"x":500,"y":[1],"confidence":0.5}'), GROUNDING_ERR_SCHEMA)
})

test('parseGroundingReply rejects out-of-range x/y/confidence', () => {
  expectGroundingCode(() => parseGroundingReply('{"x":1001,"y":1,"confidence":0.5}'), GROUNDING_ERR_OUT_OF_RANGE)
  expectGroundingCode(() => parseGroundingReply('{"x":-1,"y":1,"confidence":0.5}'), GROUNDING_ERR_OUT_OF_RANGE)
  expectGroundingCode(() => parseGroundingReply('{"x":500,"y":1500,"confidence":0.5}'), GROUNDING_ERR_OUT_OF_RANGE)
  expectGroundingCode(() => parseGroundingReply('{"x":500,"y":1,"confidence":1.1}'), GROUNDING_ERR_OUT_OF_RANGE)
  expectGroundingCode(() => parseGroundingReply('{"x":500,"y":1,"confidence":-0.01}'), GROUNDING_ERR_OUT_OF_RANGE)
})

test('parseGroundingReply rejects NaN/Infinity literals (invalid strict JSON)', () => {
  expectGroundingCode(() => parseGroundingReply('{"x":NaN,"y":1,"confidence":0.5}'), GROUNDING_ERR_PARSE)
  expectGroundingCode(() => parseGroundingReply('{"x":Infinity,"y":1,"confidence":0.5}'), GROUNDING_ERR_PARSE)
  expectGroundingCode(() => parseGroundingReply('{"x":500,"y":1,"confidence":Infinity}'), GROUNDING_ERR_PARSE)
})

test('parseGroundingReply rejects oversized input', () => {
  const big = '{"x":1,"y":2,"confidence":0.5}' + ' '.repeat(10_000)
  expectGroundingCode(() => parseGroundingReply(big), GROUNDING_ERR_INPUT_TOO_LARGE)
})

test('parseGroundingReply rejects empty input and non-string input', () => {
  expectGroundingCode(() => parseGroundingReply(''), GROUNDING_ERR_PARSE)
  expectGroundingCode(() => parseGroundingReply('   '), GROUNDING_ERR_PARSE)
  expectGroundingCode(() => parseGroundingReply(undefined), GROUNDING_ERR_PARSE)
})

test('groundingToNativePoint maps normalized point onto trusted native pixels', () => {
  // x: round(500/1000*1205) = 603, y: round(286/1000*2621) = 750
  const pt = groundingToNativePoint({ x: 500, y: 286, confidence: 0.9 }, { width: 1206, height: 2622 })
  assert.deepEqual(pt, { x: 603, y: 750 })
})

test('groundingToNativePoint maps both endpoints to valid native pixels', () => {
  assert.deepEqual(
    groundingToNativePoint({ x: 0, y: 0 }, { width: 1206, height: 2622 }),
    { x: 0, y: 0 },
  )
  assert.deepEqual(
    groundingToNativePoint({ x: 1000, y: 1000 }, { width: 1206, height: 2622 }),
    { x: 1205, y: 2621 },
  )
  // odd dimensions
  assert.deepEqual(groundingToNativePoint({ x: 0, y: 0 }, { width: 3, height: 5 }), { x: 0, y: 0 })
  assert.deepEqual(groundingToNativePoint({ x: 1000, y: 1000 }, { width: 3, height: 5 }), { x: 2, y: 4 })
})

test('groundingToNativePoint handles fractional normalized values', () => {
  // width 2001 -> x: round(500.5/1000*2000)=1001, y: round(0.05/1000*41)=0
  assert.deepEqual(groundingToNativePoint({ x: 500.5, y: 0.05 }, { width: 2001, height: 42 }), { x: 1001, y: 0 })
})

test('groundingToNativePoint accepts a parseGroundingReply output object', () => {
  const parsed = parseGroundingReply('{"x":500,"y":286,"confidence":0.97}')
  assert.deepEqual(groundingToNativePoint(parsed, { width: 1206, height: 2622 }), { x: 603, y: 750 })
})

test('groundingToNativePoint rejects invalid point values again', () => {
  expectGroundingCode(() => groundingToNativePoint({ x: -1, y: 0 }, { width: 100, height: 100 }), GROUNDING_ERR_OUT_OF_RANGE)
  expectGroundingCode(() => groundingToNativePoint({ x: 1001, y: 0 }, { width: 100, height: 100 }), GROUNDING_ERR_OUT_OF_RANGE)
  expectGroundingCode(() => groundingToNativePoint({ x: '500', y: 0 }, { width: 100, height: 100 }), GROUNDING_ERR_SCHEMA)
  expectGroundingCode(() => groundingToNativePoint({ y: 0 }, { width: 100, height: 100 }), GROUNDING_ERR_SCHEMA)
  expectGroundingCode(() => groundingToNativePoint({ x: NaN, y: 0 }, { width: 100, height: 100 }), GROUNDING_ERR_SCHEMA)
  expectGroundingCode(() => groundingToNativePoint({ x: Infinity, y: 0 }, { width: 100, height: 100 }), GROUNDING_ERR_SCHEMA)
  expectGroundingCode(() => groundingToNativePoint(null, { width: 100, height: 100 }), GROUNDING_ERR_SCHEMA)
  expectGroundingCode(() => groundingToNativePoint([10, 20], { width: 100, height: 100 }), GROUNDING_ERR_SCHEMA)
})

test('groundingToNativePoint rejects invalid trusted capture dimensions', () => {
  const okPoint = { x: 500, y: 500 }
  const invalidDims = [
    0,
    -1,
    3.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 2,
    '1206',
    null,
    undefined,
  ]
  for (const bad of invalidDims) {
    expectGroundingCode(() => groundingToNativePoint(okPoint, { width: bad, height: 100 }), GROUNDING_ERR_CAPTURE)
    expectGroundingCode(() => groundingToNativePoint(okPoint, { width: 100, height: bad }), GROUNDING_ERR_CAPTURE)
  }
  expectGroundingCode(() => groundingToNativePoint(okPoint, { width: 100 }), GROUNDING_ERR_CAPTURE)
  expectGroundingCode(() => groundingToNativePoint(okPoint, null), GROUNDING_ERR_CAPTURE)
})

test('groundingToNativePoint never reads model width/height/scale off the point', () => {
  // Deliberately hostile: point carries fake model-native dims that differ
  // from the trusted capture. The trusted capture must win.
  const hostile = { x: 500, y: 286, confidence: 0.99, imageWidth: 542, imageHeight: 1178, scale: 2 }
  const pt = groundingToNativePoint(hostile, { width: 1206, height: 2622 })
  assert.deepEqual(pt, { x: 603, y: 750 })
})
