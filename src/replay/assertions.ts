import { QA_INCONCLUSIVE_TRUNCATED, QA_TARGET_NOT_UNIQUE } from '../contracts.ts';
import type { QaObservation, QaObserveOptions, QaSemanticNode } from '../session/adapter.ts';

/**
 * Distinct refusal codes for a node-value assertion matched against a node the
 * driver FLAGGED: a withheld (secret), secure, or truncated value can never
 * satisfy node-value, even when a leaked value field happens to carry the
 * expected string (defense in depth for hand-written scenarios; export already
 * refuses to synthesize such assertions).
 */
export const QA_VALUE_WITHHELD = 'VALUE_WITHHELD';
export const QA_VALUE_SECURE = 'VALUE_SECURE';
export const QA_VALUE_TRUNCATED = 'VALUE_TRUNCATED';

/** The refusal code for a flagged node, in severity order. */
function valueFlagReason(node: QaSemanticNode): string {
  if (node.valueWithheld === true) return QA_VALUE_WITHHELD;
  if (node.secure === true) return QA_VALUE_SECURE;
  return QA_VALUE_TRUNCATED;
}

/** True when the driver flagged the node's value as never assertable. */
function isFlaggedValueNode(node: QaSemanticNode): boolean {
  return node.valueWithheld === true || node.secure === true || node.valueTruncated === true;
}
import type {
  QaAssertion,
  QaAssertionKind,
  QaNodePredicate,
  QaObservedNode,
  QaViewCompleteness,
} from '../contracts.ts';

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

/**
 * Projection of a node whose observable value was asserted, for report/triage.
 * The driver flags travel alongside the value so a human reading a refusal can
 * tell WHY the value never satisfied the assertion.
 */
function toObservedValueNode(node: QaSemanticNode): QaObservedNode & {
  value: string | null;
  valueWithheld?: true;
  secure?: true;
  valueTruncated?: true;
} {
  return {
    role: node.role,
    name: node.name,
    tag: node.tag,
    value: node.value ?? null,
    ...(node.valueWithheld === true ? { valueWithheld: true as const } : {}),
    ...(node.secure === true ? { secure: true as const } : {}),
    ...(node.valueTruncated === true ? { valueTruncated: true as const } : {}),
  };
}

/**
 * Node budget requested for the ONE bounded re-observation performed when an
 * assertion's outcome would otherwise be decided against a truncated view.
 *
 * Live evidence (Wikipedia /wiki/HTML at 1280x800): the default view returned
 * 60 nodes with truncated: true, and after a scroll the scroll target was NOT
 * among them — not because it was invisible (it was in the viewport) but
 * because newly visible nodes had consumed the budget. At a 100-node budget it
 * came back with inViewport: true. So a single raised-budget re-read is what
 * separates "not there" from "outside the window".
 *
 * The value is the largest budget any v0.1 driver accepts; every driver clamps
 * it to its own maximum (browser: 1..100, default 60; computer: 1..500, default
 * 200), and each also enforces its own byte ceiling. Escalation therefore
 * cannot guarantee a complete view — which is exactly why a still-truncated
 * view fails CLOSED instead of being retried. It happens at most ONCE per
 * decision: no loop, no unbounded growth, no second escalation.
 */
export const QA_ESCALATED_NODE_BUDGET = 500;

export interface AssertionEval {
  passed: boolean;
  observed: unknown;
  /**
   * True when this outcome rests on NOT having seen a matching node in a view
   * that was truncated: the claim is unproven, never "passed". Absence of
   * evidence in an incomplete view is not evidence of absence.
   */
  inconclusive: boolean;
  /**
   * Stable machine code when the assertion was refused for a structural reason
   * (TARGET_NOT_UNIQUE, VALUE_WITHHELD / VALUE_SECURE / VALUE_TRUNCATED, ...)
   * rather than an ordinary value mismatch. Undefined for ordinary outcomes.
   */
  reason?: string;
}

/** A bounded re-observation at a raised node budget (may reject; never loops). */
export type QaReobserve = (options: QaObserveOptions) => Promise<QaObservation>;

export interface QaAssertionDecision {
  passed: boolean;
  observed: unknown;
  /** The view the decision was finally made against (escalated when one was taken). */
  observation: QaObservation;
  /** Present only when truncation touched the decision (report/triage context). */
  completeness: QaViewCompleteness | null;
  /**
   * Stable machine code when the assertion was refused for a structural reason
   * (TARGET_NOT_UNIQUE, VALUE_WITHHELD / VALUE_SECURE / VALUE_TRUNCATED, ...)
   * rather than an ordinary value mismatch. ADDITIVE: ordinary outcomes omit it.
   */
  reason?: string;
}

/**
 * Evaluates a validated assertion against ONE observation (lossless output).
 *
 * Truncation rule, applied here and not left to callers: evidence of presence
 * is sound even in an incomplete view (a node that was returned really is
 * there), while the absence of a match in a TRUNCATED view proves nothing. So
 * a node-absent claim can never pass on a truncated observation, and a
 * node-present / node-in-viewport claim that found nothing on one is reported
 * as inconclusive rather than as a plain "not present".
 */
export function evaluateAssertion(assertion: QaAssertion, observation: QaObservation): AssertionEval {
  const kind = assertion.kind;
  if (kind === 'node-present') {
    const predicate = assertion.expected as QaNodePredicate;
    const matches = observation.nodes.filter((node) => matchesNode(node, predicate));
    const found = matches.length > 0;
    return { passed: found, observed: matches.map(toObservedNode), inconclusive: !found && observation.truncated };
  }
  if (kind === 'node-absent') {
    const predicate = assertion.expected as QaNodePredicate;
    const match = observation.nodes.find((node) => matchesNode(node, predicate));
    const found = match !== undefined;
    // Absence is a claim about the WHOLE view: a truncated view cannot support
    // it, so it fails closed instead of silently passing.
    return {
      passed: !found && !observation.truncated,
      observed: found ? toObservedNode(match) : null,
      inconclusive: !found && observation.truncated,
    };
  }
  if (kind === 'node-in-viewport') {
    const predicate = assertion.expected as QaNodePredicate;
    const matches = observation.nodes.filter((node) => matchesNode(node, predicate) && node.inViewport === true);
    const found = matches.length > 0;
    return { passed: found, observed: matches.map(toObservedNode), inconclusive: !found && observation.truncated };
  }
  if (kind === 'node-value') {
    const expectation = assertion.expected as QaNodePredicate & { value: string };
    // Unlike node-present, node-value must identify EXACTLY ONE node: the
    // assertion claims a specific recorded node carries the value, and with
    // several same-named nodes a twin that already holds the value proves
    // nothing about the recorded target (the same uniqueness export demands,
    // re-checked here and in resolveRef). More than one predicate match fails
    // closed instead of passing on whichever twin happens to hold the value.
    const predicateMatches = observation.nodes.filter((node) => matchesNode(node, expectation));
    if (predicateMatches.length > 1) {
      return {
        passed: false,
        observed: predicateMatches.map(toObservedValueNode),
        inconclusive: false,
        reason: QA_TARGET_NOT_UNIQUE,
      };
    }
    // Presence of the value is exactly as sound as presence of the node: a
    // returned node really does carry the value the driver reported for it.
    // NOT finding it in a truncated view is unproven, never "absent".
    const match = observation.nodes.find(
      (node) => matchesNode(node, expectation) && node.value === expectation.value,
    );
    if (match !== undefined && isFlaggedValueNode(match)) {
      // A withheld/secure/truncated control can never satisfy node-value, even
      // when a leaked value field happens to carry the expected string.
      return {
        passed: false,
        observed: [toObservedValueNode(match)],
        inconclusive: false,
        reason: valueFlagReason(match),
      };
    }
    const found = match !== undefined;
    return {
      passed: found,
      observed: match === undefined ? [] : [toObservedValueNode(match)],
      inconclusive: !found && observation.truncated,
    };
  }
  const expected = assertion.expected as { url?: string; contains?: string };
  const actual = observation.page.url;
  let passed: boolean;
  if (expected.url !== undefined) passed = actual === expected.url;
  else if (expected.contains !== undefined) passed = actual.includes(expected.contains);
  else passed = false;
  // The page URL is carried by every observation whatever the node budget did.
  return { passed, observed: actual, inconclusive: false };
}

/** True when this kind's outcome can be decided by node membership at all. */
function readsNodes(kind: QaAssertionKind): boolean {
  return kind !== 'page-url';
}

/**
 * Would this outcome be decided against a truncated view? An absent-claim on
 * ANY truncated view qualifies (the claim is about the whole view), and so does
 * a present/in-viewport claim that found NO match. A present-claim that already
 * found its match needs nothing more: the node was returned, so it exists.
 */
function needsFullerView(kind: QaAssertionKind, evaluation: AssertionEval): boolean {
  if (!readsNodes(kind)) return false;
  return kind === 'node-absent' || evaluation.inconclusive;
}

function budgetLabel(nodeBudget: number | null): string {
  return nodeBudget === null ? 'driver-default' : String(nodeBudget) + '-node';
}

function completenessDetail(
  kind: QaAssertionKind,
  deciding: AssertionEval,
  truncated: boolean,
  nodeBudget: number | null,
  escalated: boolean,
  escalationFailed: boolean,
): string {
  const budget = budgetLabel(nodeBudget);
  const escalation = escalationFailed
    ? 'the bounded escalation to the ' + String(QA_ESCALATED_NODE_BUDGET)
      + '-node budget could not be observed, so the outcome was decided against the truncated view; '
    : escalated
      ? 'one bounded re-observation at the ' + String(QA_ESCALATED_NODE_BUDGET) + '-node budget was taken; '
      : '';
  if (!readsNodes(kind)) {
    return 'the observation was truncated at its ' + budget
      + ' budget, but this assertion reads the page URL only and does not depend on node completeness.';
  }
  if (deciding.inconclusive) {
    return escalation
      + 'the view was STILL truncated at its ' + budget + ' budget, so "' + kind
      + '" cannot be proven from it: a matching node may exist outside the returned window. '
      + 'This is not "not present" — raise the observation node budget (qa_observe max_nodes) '
      + 'or narrow the page, then re-run.';
  }
  if (truncated) {
    return escalation
      + 'the deciding view was truncated at its ' + budget
      + ' budget, but a matching node was RETURNED by it, and a returned node is sound evidence '
      + 'of presence even in an incomplete view.';
  }
  return escalation
    + 'the first view was truncated at its node budget; the deciding view at the ' + budget
    + ' budget was COMPLETE, so the outcome is proven against the whole view.';
}

/**
 * Decide an assertion, escalating the node budget ONCE when the outcome would
 * otherwise rest on a truncated view (see QA_ESCALATED_NODE_BUDGET).
 *
 * The escalation is bounded and single: if the fuller view is still truncated
 * and the outcome still depends on completeness, the decision fails CLOSED with
 * QA_INCONCLUSIVE_TRUNCATED instead of passing or pretending to be an ordinary
 * "not present". A re-observation that throws (for example an escalated view
 * that never settled) is not fatal either: the decision falls back to the
 * original view, still fail-closed.
 */
export async function decideAssertion(
  assertion: QaAssertion,
  observation: QaObservation,
  reobserve: QaReobserve,
): Promise<QaAssertionDecision> {
  const first = evaluateAssertion(assertion, observation);
  if (!observation.truncated) {
    // A complete view decides everything on its own; nothing to escalate or report.
    return {
      passed: first.passed,
      observed: first.observed,
      observation,
      completeness: null,
      ...(first.reason === undefined ? {} : { reason: first.reason }),
    };
  }

  let deciding = observation;
  let evaluation = first;
  let nodeBudget: number | null = null;
  let escalated = false;
  let escalationFailed = false;
  if (needsFullerView(assertion.kind, first)) {
    try {
      const fuller = await reobserve({ maxNodes: QA_ESCALATED_NODE_BUDGET });
      deciding = fuller;
      evaluation = evaluateAssertion(assertion, fuller);
      nodeBudget = QA_ESCALATED_NODE_BUDGET;
      escalated = true;
    } catch {
      // No fuller view is available: decide against what we have, fail closed.
      escalationFailed = true;
    }
  }

  const completeness: QaViewCompleteness = {
    truncated: deciding.truncated,
    nodeBudget,
    escalated,
    outcomeDependsOnCompleteView: evaluation.inconclusive,
    ...(evaluation.inconclusive ? { reason: QA_INCONCLUSIVE_TRUNCATED } : {}),
    detail: completenessDetail(
      assertion.kind,
      evaluation,
      deciding.truncated,
      nodeBudget,
      escalated,
      escalationFailed,
    ),
  };
  return {
    passed: evaluation.passed,
    observed: evaluation.observed,
    observation: deciding,
    completeness,
    ...(evaluation.reason === undefined ? {} : { reason: evaluation.reason }),
  };
}

/** Minimal settled-observation surface decideAssertion escalates through. */
export interface QaSettledObserver {
  observeSettled(options?: QaObserveOptions): Promise<{ observation: QaObservation; stable: boolean; budgetMs: number }>;
}

/**
 * Budget escalation backed by a live session. The escalated view is SETTLED
 * exactly like every other proof observation, and an unsettled one is refused
 * (the caller then decides fail-closed against the original view) rather than
 * being accepted as a fuller truth.
 */
export function sessionReobserve(session: QaSettledObserver): QaReobserve {
  return async (options) => {
    const settled = await session.observeSettled(options);
    if (!settled.stable) {
      throw new Error(
        'the budget-escalated observation never settled within the ' + String(settled.budgetMs) + 'ms settle budget',
      );
    }
    return settled.observation;
  };
}
