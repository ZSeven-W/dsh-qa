import { QA_INCONCLUSIVE_TRUNCATED, QA_TARGET_NOT_UNIQUE } from '../contracts.ts';
import type {
  QaObservation,
  QaObservationScope,
  QaObserveOptions,
  QaSemanticNode,
  QaSettleWidened,
} from '../session/adapter.ts';

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
 *
 * REPORTING HONESTY (QA-BL-043): this constant is a REQUEST. Every completeness
 * block reports the budget the deciding observation ACTUALLY applied
 * (QaObservation.maxNodes, the driver's own clamp) — a browser clamps this
 * request to 100 and the report must say 100 (and, when that equals the prior
 * applied budget, that no wider view exists from this driver), never 500.
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
 * The ref that chains the NEXT scoped read: the re-collected scope root node's
 * FRESH ref inside a scoped observation. The observation's scope.ref echoes
 * the ref the caller PASSED — which belonged to the observation the scoped
 * read just replaced, so it never resolves again. The root node is found by
 * the scope echo's role+name+tag identity (the driver emits the root first,
 * and a caller can only have scoped to a node it observed, so the root is
 * selectable); undefined when the view is whole-page or the root is absent.
 */
export function scopeRootRef(observation: QaObservation): string | undefined {
  const scope = observation.scope;
  if (scope === undefined) return undefined;
  const root = observation.nodes.find(
    (node) => node.role === scope.role && node.name === scope.name && node.tag === scope.tag,
  );
  return root?.ref;
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

/** Everything the completeness detail needs, in one honest context. */
interface CompletenessContext {
  kind: QaAssertionKind;
  deciding: AssertionEval;
  truncated: boolean;
  /** Budget the DECIDING observation actually applied (driver-reported). */
  nodeBudget: number | null;
  /** Budget the FIRST observation actually applied (driver-reported). */
  priorBudget: number | null;
  /** Driver-named reasons the deciding view is partial (absent = not reported). */
  truncationReasons: readonly string[] | undefined;
  /** The scope of the deciding view when it was a scoped observation. */
  scope: QaObservationScope | undefined;
  escalated: boolean;
  escalationFailed: boolean;
}

function hasReason(reasons: readonly string[] | undefined, reason: string): boolean {
  return reasons !== undefined && reasons.includes(reason);
}

/**
 * Names the bounded re-observation by what the driver APPLIED, never by the
 * requested constant. A driver that clamps the 500 request back to the
 * budget it already used widened nothing, and the detail must say so.
 */
function escalationClause(context: CompletenessContext): string {
  if (context.escalationFailed) {
    return 'the bounded escalation to the ' + String(QA_ESCALATED_NODE_BUDGET)
      + '-node budget could not be observed, so the outcome was decided against the truncated view; ';
  }
  if (!context.escalated) return '';
  const applied = context.nodeBudget;
  const prior = context.priorBudget;
  if (applied !== null && prior !== null && applied === prior) {
    return 'one bounded re-observation was taken at the driver maximum of ' + String(applied)
      + ' nodes — the same budget the prior observation applied, so no wider view exists from this driver; ';
  }
  if (applied !== null && prior !== null) {
    return 'one bounded re-observation was taken, and the driver applied ' + String(applied)
      + ' nodes instead of the prior ' + String(prior) + '; ';
  }
  if (applied !== null) {
    return 'one bounded re-observation was taken, and the driver applied ' + String(applied) + ' nodes; ';
  }
  return 'one bounded re-observation was taken, and the driver did not report the budget it applied; ';
}

/**
 * The recovery advice for an unprovable truncated view, chosen by WHY the
 * view is partial: a budget raise cannot fix an iframe or a scan window, and
 * after an escalation the driver already applied the widest budget it accepts.
 */
function truncationAdvice(context: CompletenessContext): string {
  if (hasReason(context.truncationReasons, 'iframe-not-traversed')) {
    return 'the driver reported iframe-not-traversed: part of the page lives in an iframe the driver does not traverse, '
      + 'so a node budget cannot help — narrow the page to the top-level document, '
      + 'or assert only against nodes the driver can return,';
  }
  if (hasReason(context.truncationReasons, 'scan-window-exceeded')) {
    return 'the driver reported scan-window-exceeded: the page has more selector matches than the driver\'s fixed scan window, '
      + 'so raising the node budget cannot help — narrow the page or scroll the target into a smaller view,';
  }
  if (context.escalated && context.nodeBudget !== null && context.priorBudget !== null
    && context.nodeBudget === context.priorBudget) {
    return 'the re-observation applied the same ' + String(context.nodeBudget)
      + '-node budget the driver already allowed (its maximum), so raising qa_observe max_nodes cannot help — '
      + 'narrow the page or region, or scroll the target into a smaller view,';
  }
  if (context.escalated) {
    return 'the driver already applied the widest node budget it accepts and the view is still truncated, '
      + 'so raising qa_observe max_nodes cannot help — narrow the page or region, '
      + 'or scroll the target into a smaller view,';
  }
  return 'raise the observation node budget (qa_observe max_nodes) or narrow the page,';
}

/** Names the deciding view's scope (browser contract v8) when it has one. */
function scopeClause(scope: QaObservationScope | undefined): string {
  if (scope === undefined) return '';
  return 'the deciding view was scoped to the ' + scope.role + ' named "' + scope.name + '"; ';
}

function completenessDetail(
  kind: QaAssertionKind,
  deciding: AssertionEval,
  truncated: boolean,
  nodeBudget: number | null,
  priorBudget: number | null,
  truncationReasons: readonly string[] | undefined,
  scope: QaObservationScope | undefined,
  escalated: boolean,
  escalationFailed: boolean,
): string {
  const context: CompletenessContext = {
    kind,
    deciding,
    truncated,
    nodeBudget,
    priorBudget,
    truncationReasons,
    scope,
    escalated,
    escalationFailed,
  };
  const budget = budgetLabel(nodeBudget);
  const escalation = escalationClause(context);
  const scoped = scopeClause(scope);
  if (!readsNodes(kind)) {
    return 'the observation was truncated at its ' + budget
      + ' budget, but this assertion reads the page URL only and does not depend on node completeness.';
  }
  if (deciding.inconclusive) {
    return escalation + scoped
      + 'the view was STILL truncated at its ' + budget + ' budget, so "' + kind
      + '" cannot be proven from it: a matching node may exist outside the returned window'
      + (scope === undefined ? '' : ' of that container\'s subtree') + '. '
      + 'This is not "not present" — ' + truncationAdvice(context) + ' then re-run.';
  }
  if (truncated) {
    return escalation + scoped
      + 'the deciding view was truncated at its ' + budget
      + ' budget, but a matching node was RETURNED by it, and a returned node is sound evidence '
      + 'of presence even in an incomplete view.';
  }
  return escalation + scoped
    + 'the deciding view was COMPLETE, so the outcome is proven against '
    + (scope === undefined ? 'the whole view.' : 'the whole subtree of that container.');
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
  if (!observation.truncated && observation.scope === undefined) {
    // A complete WHOLE-PAGE view decides everything on its own; nothing to
    // escalate or report. A complete SCOPED view still reports completeness:
    // its scope must be named, so a container-scoped absence is never read as
    // a whole-page absence.
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
  let escalated = false;
  let escalationFailed = false;
  if (observation.truncated && needsFullerView(assertion.kind, first)) {
    // A scoped decision escalates WITHIN the same scope: the escalated view is
    // a strictly fuller read of the same subtree (same container, bigger
    // budget), never a whole-page widening that would change what the claim
    // is about. The chain key is the re-collected ROOT NODE's fresh ref (the
    // scope.ref echo is the passed ref, which the scoped read just consumed).
    // An unscoped decision escalates exactly as before.
    const withinRef = scopeRootRef(observation);
    if (observation.scope !== undefined && withinRef === undefined) {
      // The scoped view cannot be re-chained (its root is not among the
      // returned nodes): decide against the scoped view, fail closed.
      escalationFailed = true;
    } else {
      const escalationOptions: QaObserveOptions = {
        maxNodes: QA_ESCALATED_NODE_BUDGET,
        ...(withinRef === undefined ? {} : { withinRef }),
      };
      try {
        const fuller = await reobserve(escalationOptions);
        deciding = fuller;
        evaluation = evaluateAssertion(assertion, fuller);
        escalated = true;
      } catch {
        // No fuller view is available: decide against what we have, fail closed.
        escalationFailed = true;
      }
    }
  }

  // The budget the DECIDING observation actually applied (the driver's own
  // clamp, reported in its limits) — never the requested constant.
  const nodeBudget: number | null = deciding.maxNodes ?? null;
  const priorBudget: number | null = observation.maxNodes ?? null;

  const completeness: QaViewCompleteness = {
    truncated: deciding.truncated,
    nodeBudget,
    escalated,
    outcomeDependsOnCompleteView: evaluation.inconclusive,
    ...(deciding.scope === undefined
      ? {}
      : { scope: { role: deciding.scope.role, name: deciding.scope.name } }),
    ...(deciding.truncationReasons === undefined ? {} : { truncationReasons: deciding.truncationReasons }),
    ...(evaluation.inconclusive ? { reason: QA_INCONCLUSIVE_TRUNCATED } : {}),
    detail: completenessDetail(
      assertion.kind,
      evaluation,
      deciding.truncated,
      nodeBudget,
      priorBudget,
      deciding.truncationReasons,
      deciding.scope,
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

/** Assertion kinds whose "not found" outcome may be retried (positive existence). */
const RETRIABLE_KINDS = new Set<QaAssertionKind>(['node-present', 'node-value', 'node-in-viewport', 'page-url']);

/** Structural refusal codes waiting can never fix (a twin, or a flagged value). */
const NON_RETRIABLE_REASONS = new Set<string>([
  QA_TARGET_NOT_UNIQUE,
  QA_VALUE_WITHHELD,
  QA_VALUE_SECURE,
  QA_VALUE_TRUNCATED,
]);

export interface QaRetriedDecision extends QaAssertionDecision {
  /** Settled observations the assertion was evaluated against (always >= 1). */
  attempts: number;
  /** Wall-clock milliseconds from the first decision until the loop stopped. */
  elapsedMs: number;
  /** The widening this retry performed (once), or null when none happened. */
  widened: QaSettleWidened | null;
}

/**
 * The live-session surface the bounded retry reads its budget from and widens
 * through. QaSession satisfies it: the budget is re-read every iteration so a
 * widening takes effect for the in-flight retry, and the widening goes through
 * the SAME once-per-session gate as the unstable settle path.
 */
export interface QaRetryBudgetSource {
  /** The session's CURRENT settle policy (budgetMs re-read every iteration). */
  settlePolicy: { budgetMs: number };
  /** Widen the budget ONCE through the shared gate; null when not applicable. */
  widenForRetry(): QaSettleWidened | null;
}

/**
 * Decide a positive-existence assertion with a BOUNDED retry.
 *
 * Real sites are slow: after the post-action settle concludes, the asserted
 * node (a lazy-loaded suggestion, a late-hydrated role switch) may not have
 * rendered yet. When the first settled decision is "not found" — including the
 * INCONCLUSIVE_TRUNCATED branch taken after the single budget escalation — do
 * NOT conclude immediately. Re-observe (settled, at the escalated node budget)
 * and re-evaluate until the assertion is found (sound on any view, complete or
 * truncated) or the budget is exhausted, then return the existing outcome with
 * the attempt/elapsed counts attached.
 *
 * When `budget` is a live session (QaRetryBudgetSource) and the retry exhausts
 * the current budget without finding its target, it widens the budget ONCE
 * through the session's gate — the same once-per-session rule as the unstable
 * settle path, so a session widens at most once whichever path gets there first
 * — and keeps retrying until the adaptive (widened) budget measured from the
 * retry's ORIGINAL start. The budget is re-read every iteration, so a widening
 * takes effect immediately for the in-flight retry.
 *
 * `node-absent` is NEVER retried into a pass: absence is never proven by
 * waiting, only by having seen the whole view. A structural refusal
 * (TARGET_NOT_UNIQUE, VALUE_WITHHELD / VALUE_SECURE / VALUE_TRUNCATED) is
 * deterministic and never resolves by waiting either — and never triggers a
 * widen.
 */
export async function decideAssertionWithRetry(
  assertion: QaAssertion,
  observation: QaObservation,
  reobserve: QaReobserve,
  budget: number | QaRetryBudgetSource,
): Promise<QaRetriedDecision> {
  const startedAt = Date.now();
  const currentBudget = (): number =>
    typeof budget === 'number' ? budget : budget.settlePolicy.budgetMs;
  const tryWiden = (): QaSettleWidened | null =>
    typeof budget === 'number' ? null : budget.widenForRetry();

  let attempts = 1;
  let decision = await decideAssertion(assertion, observation, reobserve);
  if (decision.passed) return { ...decision, attempts, elapsedMs: Date.now() - startedAt, widened: null };
  if (!RETRIABLE_KINDS.has(assertion.kind)) {
    return { ...decision, attempts, elapsedMs: Date.now() - startedAt, widened: null };
  }
  if (decision.reason !== undefined && NON_RETRIABLE_REASONS.has(decision.reason)) {
    return { ...decision, attempts, elapsedMs: Date.now() - startedAt, widened: null };
  }
  let widened: QaSettleWidened | null = null;
  for (;;) {
    if (Date.now() - startedAt >= currentBudget()) {
      // Exhausted the budget without finding the target. Widen ONCE through the
      // same session gate as the unstable path (a session widens at most once,
      // whichever path gets there first) and keep retrying; otherwise stop.
      if (widened === null) {
        widened = tryWiden();
        if (widened !== null) continue;
      }
      break;
    }
    let next: QaObservation;
    // Each retry re-reads the LATEST deciding view's container: the chain key
    // is the re-collected scope root NODE's fresh ref (the scope.ref echo is
    // the passed ref, which the last read consumed). An unscoped retry keeps
    // looking at the whole page (unchanged).
    const withinRef = scopeRootRef(decision.observation);
    if (decision.observation.scope !== undefined && withinRef === undefined) {
      // The scoped view cannot be re-chained: keep the existing outcome,
      // fail closed (never widen a scoped retry to the whole page).
      break;
    }
    try {
      next = await reobserve({
        maxNodes: QA_ESCALATED_NODE_BUDGET,
        ...(withinRef === undefined ? {} : { withinRef }),
      });
    } catch {
      // No settled fuller view is available: keep the existing outcome.
      break;
    }
    attempts += 1;
    decision = await decideAssertion(assertion, next, reobserve);
    if (decision.passed) break;
    if (decision.reason !== undefined && NON_RETRIABLE_REASONS.has(decision.reason)) break;
  }
  return { ...decision, attempts, elapsedMs: Date.now() - startedAt, widened };
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
