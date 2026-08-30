import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAssertion, matchesNode } from '../src/replay/index.ts';

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

test('evaluateAssertion node-absent passes only when nothing matches', () => {
  const present = evaluateAssertion({ kind: 'node-absent', expected: { role: 'status' } }, observation);
  assert.equal(present.passed, false);
  assert.deepEqual(present.observed, { role: 'status', name: 'PASS', tag: 'div' });

  const absent = evaluateAssertion({ kind: 'node-absent', expected: { role: 'link' } }, observation);
  assert.equal(absent.passed, true);
  assert.equal(absent.observed, null);
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
