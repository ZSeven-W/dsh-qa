import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAssertion, matchesNode } from '../src/replay/index.ts';
import { QA_COVERAGE_UNVERIFIED } from '../src/contracts.ts';

const observation = {
  page: { url: 'http://127.0.0.1:1234/', title: 'fixture' },
  nodes: [
    { ref: 'a', role: 'textbox', name: 'Release name', tag: 'input', interactive: true, editable: true, disabled: false },
    { ref: 'b', role: 'button', name: 'Run validation', tag: 'button', interactive: true, editable: false, disabled: false },
    { ref: 'c', role: 'status', name: 'PASS', tag: 'div', interactive: false, editable: false, disabled: false },
  ],
  truncated: false,
};

test('matchesNode matches on role/name/tag and rejects mismatches', () => {
  assert.equal(matchesNode(observation.nodes[0], { role: 'textbox', name: 'Release name' }), true);
  assert.equal(matchesNode(observation.nodes[0], { role: 'button' }), false);
  assert.equal(matchesNode(observation.nodes[1], { tag: 'button' }), true);
});

test('evaluateAssertion node-present passes with the matched semantic nodes', () => {
  const result = evaluateAssertion({ kind: 'node-present', expected: { role: 'status', name: 'PASS' } }, observation);
  assert.equal(result.passed, true);
  assert.deepEqual(result.observed, [{ role: 'status', name: 'PASS', tag: 'div' }]);
});

test('evaluateAssertion node-present fails when nothing matches', () => {
  const result = evaluateAssertion({ kind: 'node-present', expected: { role: 'status', name: 'FAIL' } }, observation);
  assert.equal(result.passed, false);
  assert.deepEqual(result.observed, []);
});

// CHANGED (QA-BL-052 / Codex Q4, deliberate semantics downgrade): a
// complete view can no longer prove absence by itself. The deciding
// observation must carry affirmative coverage evidence (coverage.verified:
// true — the driver's bounded closed-shadow-root probe, contract v9 Phase C),
// because closed shadow roots and unresolved slot assignment can silently
// hide nodes from a complete-looking view. A returned matching node still
// FAILS the assertion normally (presence is sound evidence), never
// inconclusive. CHANGED (contract v9 consumption): the evidence shape is the
// driver's real per-observation coverage object, not the Phase A interim
// coverageVerified boolean.
test('evaluateAssertion node-absent fails a match normally and gates every unverified absence', () => {
  const present = evaluateAssertion({ kind: 'node-absent', expected: { role: 'status' } }, observation);
  assert.equal(present.passed, false);
  assert.deepEqual(present.observed, { role: 'status', name: 'PASS', tag: 'div' });
  assert.equal(present.inconclusive, false, 'a returned matching node is sound evidence of presence, whatever the coverage state');
  assert.equal(present.reason, undefined);

  // Nothing matched, the view is complete, but its boundaries were not
  // verified: the absence is UNPROVEN and must fail closed with the new
  // machine code — never a false "gone".
  const absent = evaluateAssertion({ kind: 'node-absent', expected: { role: 'link' } }, observation);
  assert.equal(absent.passed, false);
  assert.equal(absent.inconclusive, true);
  assert.equal(absent.reason, QA_COVERAGE_UNVERIFIED);
  assert.equal(absent.observed, null);
});

test('coverage.verified: true restores the node-absent PASS on a complete view (the v9 restoration path)', () => {
  // The restoration path must exist and stay pinned: per-observation
  // affirmative coverage evidence (the driver's REAL per-observation shape,
  // contract v9 Phase C) brings back the proven absence. CHANGED: the
  // Phase A interim coverageVerified boolean is replaced by the coverage
  // object — coverage.verified === true is the single source of truth.
  const verified = {
    ...observation,
    coverage: { verified: true, closedShadowRoots: 0, probedNodes: 12 },
  };
  const absent = evaluateAssertion({ kind: 'node-absent', expected: { role: 'link' } }, verified);
  assert.equal(absent.passed, true);
  assert.equal(absent.inconclusive, false);
  assert.equal(absent.observed, null);
});

test('node-absent on a complete view with the probe skipped (coverage verified:false, reason skipped) stays UNPROVEN', () => {
  const skipped = {
    ...observation,
    coverage: { verified: false, closedShadowRoots: 0, probedNodes: 0, reason: 'skipped' },
  };
  const absent = evaluateAssertion({ kind: 'node-absent', expected: { role: 'link' } }, skipped);
  assert.equal(absent.passed, false, 'a skipped probe is never affirmative evidence');
  assert.equal(absent.inconclusive, true);
  assert.equal(absent.reason, QA_COVERAGE_UNVERIFIED);
});

test('node-absent on a view whose probe FAILED to run to completion stays UNPROVEN', () => {
  const overBudget = {
    ...observation,
    coverage: { verified: false, closedShadowRoots: 0, probedNodes: 5001, reason: 'over-budget' },
  };
  const absent = evaluateAssertion({ kind: 'node-absent', expected: { role: 'link' } }, overBudget);
  assert.equal(absent.passed, false, 'an over-budget probe is never affirmative evidence');
  assert.equal(absent.inconclusive, true);
  assert.equal(absent.reason, QA_COVERAGE_UNVERIFIED);
});

test('evaluateAssertion page-url matches exact and contains', () => {
  const exact = evaluateAssertion({ kind: 'page-url', expected: { url: 'http://127.0.0.1:1234/' } }, observation);
  assert.equal(exact.passed, true);
  assert.equal(exact.observed, 'http://127.0.0.1:1234/');

  const contains = evaluateAssertion({ kind: 'page-url', expected: { contains: '127.0.0.1' } }, observation);
  assert.equal(contains.passed, true);

  const miss = evaluateAssertion({ kind: 'page-url', expected: { contains: 'example.com' } }, observation);
  assert.equal(miss.passed, false);
});

test('evaluateAssertion node-in-viewport requires the node to be in the viewport', () => {
  const obs = {
    page: observation.page,
    nodes: [
      { ...observation.nodes[0], inViewport: false },
      { ...observation.nodes[1], inViewport: true },
    ],
    truncated: false,
  };
  const pass = evaluateAssertion({ kind: 'node-in-viewport', expected: { role: 'button', name: 'Run validation' } }, obs);
  assert.equal(pass.passed, true);
  assert.deepEqual(pass.observed, [{ role: 'button', name: 'Run validation', tag: 'button' }]);

  const offViewport = evaluateAssertion({ kind: 'node-in-viewport', expected: { role: 'textbox', name: 'Release name' } }, obs);
  assert.equal(offViewport.passed, false);
  assert.deepEqual(offViewport.observed, []);
});