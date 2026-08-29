import test from 'node:test'
import assert from 'node:assert/strict'
import { toLosslessJson } from '../src/session/index.ts'

test('toLosslessJson strips undefined-valued keys and normalizes -0 / non-finite numbers', () => {
  const out = toLosslessJson({
    keep: 1,
    drop: undefined,
    negZero: -0,
    nan: NaN,
    inf: Infinity,
    negInf: -Infinity,
    nested: { a: undefined, b: [1, undefined, -0, NaN] },
    ok: 'x',
    yes: true,
    nothing: null,
  })
  assert.equal(Object.hasOwn(out, 'drop'), false)
  assert.equal(Object.is(out.negZero, 0), true)
  assert.equal(out.nan, null)
  assert.equal(out.inf, null)
  assert.equal(out.negInf, null)
  assert.equal(Object.hasOwn(out.nested, 'a'), false)
  assert.deepEqual(out.nested.b, [1, null, 0, null])
  assert.equal(out.keep, 1)
  assert.equal(out.nothing, null)
})

test('toLosslessJson passes plain JSON through unchanged and round-trips', () => {
  const value = { a: [1, 'x', true, null], b: { c: 2.5 } }
  assert.deepEqual(toLosslessJson(value), value)
  assert.equal(JSON.stringify(toLosslessJson(value)), JSON.stringify(JSON.parse(JSON.stringify(value))))
})
