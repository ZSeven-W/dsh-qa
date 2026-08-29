// Ported from dsh-driver-bench (read-only source) at commit 4642e38
// (branch feat/v0.1), file test/redaction-r3.test.ts. The only adaptation is
// the import path: dsh-qa exposes redactText from src/redaction/index.ts (the
// redaction seam), not from src/reporters/json.ts.
//
// R3 high-entropy bare-token regressions (Phase 3b).
//
// Finding 1 (Critical): isHighEntropyTokenBoundaryCode treated "/" (0x2f) as a
// token boundary, splitting a standard base64 secret into sub-20-code-point
// segments and letting it pass through byte-identical. These are explicit,
// non-fuzz regressions for the exact reproducer plus the surrounding
// bare-token behaviors.

import assert from 'node:assert/strict'
import test from 'node:test'
import { redactText } from '../src/redaction/index.ts'

test('R3: base64 token containing "/" redacts to [REDACTED]', () => {
  // 34 code points, Shannon entropy 4.653 bits/char. "/" is part of the
  // standard base64 alphabet and must not split the token.
  assert.equal(redactText('S5SuLf/MO3+5kBEReV51oeM/1hciACz6Xg'), '[REDACTED]')
  // Same shape without "/" (entropy 4.572) redacts for parity.
  assert.equal(redactText('S5SuLfXMO3+5kBEReV51oeMX1hciACz6Xg'), '[REDACTED]')
})

test('R3: bare base64 under a benign key and in free prose is redacted', () => {
  const secret = 'S5SuLf/MO3+5kBEReV51oeM/1hciACz6Xg'
  assert.equal(redactText('note: ' + secret), 'note: [REDACTED]')
  assert.equal(redactText('see ' + secret + ' here'), 'see [REDACTED] here')
})

test('R3: high-entropy token below the 20-code-point floor stays', () => {
  // 19 code points: below R3's length floor, so it passes through unchanged
  // (length, not entropy, gates R3 at this boundary).
  const below = 'S5SuLfMO3+5kBEReV51'
  assert.equal(redactText(below), below)
  assert.equal(redactText('note: ' + below), 'note: ' + below)
})
