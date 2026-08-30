// Regression tests for the two redaction leaks the fuzz harness used to
// route around (docs/REDACTION_SPEC.md 1.2 "line breaks and inserted
// whitespace" + "quote nesting", and R4 fail-closed span termination). The
// fuzz generator's insertWhitespace was briefly narrowed so these shapes were
// never produced; the correct fix is in the engine (src/redaction/engine.ts),
// and these tests pin the exact shapes so a regression can never hide again.
//
//   LEAK A - an Authorization/auth-scheme span whose parameter structure
//            continues across an inserted newline (realm=<LF>"secret") failed
//            to fail closed: the quoted parameter value escaped the span and
//            the secret survived verbatim.
//   LEAK B - a quoted credential value with a glued tail, followed by a
//            chained assignment whose quoted value began with an inserted
//            control (tab/zero-width/NUL -> separator sentinel), was mis-split
//            at the later quote: the chained assignment's secret escaped.
//   Plus   - split percent-escapes in a bare value and in an encoded separator
//            (the other shapes insertWhitespace used to be able to produce).

import test from 'node:test'
import assert from 'node:assert/strict'
import { redactText } from '../src/redaction/index.ts'

const SECRET = 'hunter2hunter2hunter2'
const NL = '\n'
const TAB = '\t'
const NUL = '\u0000'
const DQ = '"'

function secretForms(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8')
  const upper = bytes.map((byte) => '%' + byte.toString(16).toUpperCase().padStart(2, '0')).join('')
  const lower = bytes.map((byte) => '%' + byte.toString(16).padStart(2, '0')).join('')
  const base64 = bytes.toString('base64')
  const base64NoPad = base64.replace(/=+$/, '')
  const urlSafe = base64.replace(/\+/g, '-').replace(/\//g, '_')
  const urlSafeNoPad = urlSafe.replace(/=+$/, '')
  return Array.from(new Set([secret, upper, lower, base64, base64NoPad, urlSafe, urlSafeNoPad]))
}

function assertSecretAbsent(output: string, secret: string): void {
  for (const form of secretForms(secret)) {
    assert.ok(!output.includes(form), 'output must not contain secret form ' + JSON.stringify(form))
  }
}

test('LEAK A: Digest parameter split across a newline fails closed whole', () => {
  const output = redactText('Authorization: Digest realm=' + NL + DQ + SECRET + DQ)
  assert.equal(output, 'Authorization: [REDACTED]')
  assertSecretAbsent(output, SECRET)
})

test('LEAK A: Digest scheme separator split across a newline fails closed whole', () => {
  const output = redactText('Authorization: Digest' + NL + 'realm=' + DQ + SECRET + DQ)
  assert.equal(output, 'Authorization: [REDACTED]')
  assertSecretAbsent(output, SECRET)
})

test('LEAK A: quoted value with an internal newline keeps its closing quote inside the span', () => {
  // The self-comparison bug in scanAuthorizationWholeValueEnd used to close the
  // quote after ONE character, so a newline before the closing quote ended the
  // span and echoed the trailing quote.
  const output = redactText('Authorization: Digest ' + DQ + SECRET + NL + DQ)
  assert.equal(output, 'Authorization: [REDACTED]')
  assertSecretAbsent(output, SECRET)
})

test('LEAK B: quoted-value glued tail never mis-splits across a chained assignment', () => {
  // The first value's glued tail ("xyz") must not be searched past the chain
  // delimiter into the next assignment's quote, or the chained secret escapes.
  const input = 'clientSecret:' + DQ + SECRET + DQ + 'xyz, authorization=Digest ' + DQ + TAB + SECRET + DQ
  const output = redactText(input)
  assertSecretAbsent(output, SECRET)
})

test('LEAK B: single-quoted glued tail never mis-splits across a chained assignment', () => {
  const input = "password:'" + SECRET + "'xyz; authorization=Digest " + DQ + TAB + SECRET + DQ
  const output = redactText(input)
  assertSecretAbsent(output, SECRET)
})

test('split percent-escape in a bare value fails closed', () => {
  const output = redactText('token=%' + NL + '09' + DQ + SECRET + DQ)
  assert.equal(output, 'token=[REDACTED]')
  assertSecretAbsent(output, SECRET)
})

test('split percent-encoded assignment separator is recognized', () => {
  // %3D (encoded '=') split as %3 + NUL + D must still terminate the key run
  // and consume the reassembled separator, so the assignment redacts.
  const output = redactText('api_key%09%3' + NUL + 'D' + DQ + SECRET + DQ)
  assertSecretAbsent(output, SECRET)
})

test('split percent-encoded separator after a flattened key is recognized', () => {
  const output = redactText('session/key%3' + NUL + 'D' + DQ + SECRET + DQ)
  assertSecretAbsent(output, SECRET)
})

test('double-encoded separator split across whitespace is recognized', () => {
  // %253D (double-encoded '=') split as %25 + space + 3D.
  const output = redactText('token%25 3D' + SECRET)
  assertSecretAbsent(output, SECRET)
})
