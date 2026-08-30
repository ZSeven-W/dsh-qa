import type { QaObservation, QaSemanticNode } from '../session/adapter.ts';
import type { QaAssertion, QaNodePredicate, QaObservedNode } from '../contracts.ts';

export function matchesNode(node: QaSemanticNode, predicate: QaNodePredicate): boolean {
  if (predicate.role !== undefined && node.role !== predicate.role) return false;
  if (predicate.name !== undefined && node.name !== predicate.name) return false;
  if (predicate.tag !== undefined && node.tag !== predicate.tag) return false;
  return true;
}

/** Semantic projection of a node: no ref, href, or other session-local data. */
export function toObservedNode(node: QaSemanticNode): QaObservedNode {
  return { role: node.role, name: node.name, tag: node.tag };
}

export interface AssertionEval {
  passed: boolean;
  observed: unknown;
}

/** Evaluates a validated assertion against an observation (lossless output). */
export function evaluateAssertion(assertion: QaAssertion, observation: QaObservation): AssertionEval {
  const kind = assertion.kind;
  if (kind === 'node-present') {
    const predicate = assertion.expected as QaNodePredicate;
    const matches = observation.nodes.filter((node) => matchesNode(node, predicate));
    return { passed: matches.length > 0, observed: matches.map(toObservedNode) };
  }
  if (kind === 'node-absent') {
    const predicate = assertion.expected as QaNodePredicate;
    const match = observation.nodes.find((node) => matchesNode(node, predicate));
    return { passed: match === undefined, observed: match === undefined ? null : toObservedNode(match) };
  }
  if (kind === 'node-in-viewport') {
    const predicate = assertion.expected as QaNodePredicate;
    const matches = observation.nodes.filter((node) => matchesNode(node, predicate) && node.inViewport === true);
    return { passed: matches.length > 0, observed: matches.map(toObservedNode) };
  }
  const expected = assertion.expected as { url?: string; contains?: string };
  const actual = observation.page.url;
  let passed: boolean;
  if (expected.url !== undefined) passed = actual === expected.url;
  else if (expected.contains !== undefined) passed = actual.includes(expected.contains);
  else passed = false;
  return { passed, observed: actual };
}
