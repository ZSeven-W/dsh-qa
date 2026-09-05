import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QA_ADVISORY_REASONING_TRUST, QA_INCONCLUSIVE_SCOPE, QA_INCONCLUSIVE_TRUNCATED, QA_INCONCLUSIVE_UNSTABLE, QA_NO_CONFIRMED_RECEIPTS_WARNING, QA_TARGET_NOT_UNIQUE } from '../contracts.ts';
import type {
  QaAdvisoryResult,
  QaArtifact,
  QaAssertionResult,
  QaEvidenceCollectionFailure,
  QaNodePredicate,
  QaReceiptSummary,
  QaReproductionStep,
  QaRunFailure,
  QaRunReport,
  QaScenario,
  QaScenarioAction,
  QaScenarioAssertionScope,
  QaSettleWidening,
  QaStepResult,
  QaViewCompleteness,
} from '../contracts.ts';
import type { QaAction, QaActionReceipt, QaDriverAdapter, QaEvidence, QaObservation, QaObserveOptions, QaSemanticNode, QaVisualCapture } from '../session/adapter.ts';
import { captureLatestVisual, QaSession, type QaActResult } from '../session/session.ts';
import type { QaSettlePolicy } from '../session/settle.ts';
import { evaluateVisualQuestion, persistCaptureFile, type QaVisualServices } from '../vision.ts';
import {
  decideAssertionWithRetry,
  evaluateAssertion,
  matchesNode,
  scopeRootRef,
  sessionReobserve,
  QA_ESCALATED_NODE_BUDGET,
  type QaAssertionDecision,
  type QaReobserve,
  type QaRetriedDecision,
} from './assertions.ts';

export interface ReplayRunOptions {
  ownerId?: string;
  headless?: boolean;
  /** Override target.launch (e.g. a dynamically bound fixture port). */
  launchUrl?: string;
  /** Optional vision services for advisory visual assertions. */
  visual?: QaVisualServices;
  /**
   * Bounded settle policy for every verification observation. It MUST match the
   * policy Explore used at export time (both default to resolveSettlePolicy):
   * if one side settles and the other does not, they judge different views of
   * the same page and disagree by construction.
   */
  settle?: Partial<QaSettlePolicy>;
}

/** Deterministic, honest failure message for a view that never stabilized. */
function unsettledMessage(what: string, budgetMs: number): string {
  return 'the ' + what + ' observation never settled within the ' + String(budgetMs) + 'ms settle budget';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Error carrying a machine failure code into QaRunFailure.code. */
class QaCodeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'QaCodeError';
    this.code = code;
  }
}

/** The failure code an error carries, when it carries one. */
function failureCodeFor(error: unknown): string | undefined {
  if (error instanceof QaCodeError) return error.code;
  // Driver-issued errors (the browser driver's DriverIssue) carry a
  // structured code (REF_INVALID / REF_EXPIRED / TARGET_CHANGED / ...): it
  // must survive into the report, so a driver refusal is never read as an
  // ordinary assertion failure or a "not found".
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return undefined;
}

/** Human-readable spelling of an action-target predicate, for failure messages. */
function describeTarget(target: QaNodePredicate): string {
  const parts: string[] = [];
  if (target.role !== undefined) parts.push('role "' + target.role + '"');
  if (target.name !== undefined) parts.push('name "' + target.name + '"');
  if (target.tag !== undefined) parts.push('tag "' + target.tag + '"');
  return parts.length === 0 ? 'no fields' : parts.join(', ');
}

/** The matching predicate of an assertion scope (role+name, plus tag when carried). */
function scopePredicate(scope: QaScenarioAssertionScope): QaNodePredicate {
  return { role: scope.role, name: scope.name, ...(scope.tag === undefined ? {} : { tag: scope.tag }) };
}

/** Human-readable spelling of an assertion scope, for refusal messages. */
function describeScope(scope: QaScenarioAssertionScope): string {
  const parts = ['role "' + scope.role + '"', 'name "' + scope.name + '"'];
  if (scope.tag !== undefined) parts.push('tag "' + scope.tag + '"');
  return parts.join(', ');
}

/** Options threading the scoped scroll-proof (provisional) resolution. */
interface ScopeResolutionOptions {
  /**
   * True ONLY for a scoped SCROLL step whose proof is the exported
   * node-in-viewport (the record side established it through the driver's
   * identity anchor). QA-BL-062: a single container match in a
   * STILL-truncated whole-page view is then resolved PROVISIONALLY — the
   * step's scopeResolution is 'provisional', its outcome is
   * INCONCLUSIVE_SCOPE, and it can NEVER earn a pass. The whole page can
   * never complete when the scroll target sits beyond the driver's clamped
   * node budget, so the strict QA-BL-054 uniqueness refusal would make such
   * exported scenarios unreplayable; the scoped assertion is still decided
   * against the container's own view, the replay-side decision is bound to
   * the replayed scroll by the driver's identity anchor, and PASS stays
   * reserved for proven resolution. Every other scoped assertion keeps the
   * strict gate (a recorded ancestor path excepted: see observeScopeView).
   */
  provisionalScope?: boolean;
  /**
   * Extra options for the scoped read itself. The verifying read of a
   * replayed scoped scroll proof requests anchorLastAction (the identity
   * anchor of the EXACT action) and verifyCoverage (the coverage evidence
   * target uniqueness inside the scope needs to be proven).
   */
  scopedObserve?: Partial<QaObserveOptions>;
}

/** How the container of a scoped decision was resolved (QA-BL-062). */
interface ScopeResolutionResult {
  observation: QaObservation;
  resolution: 'proven' | 'provisional';
  /** Whether the whole-page budget escalation ran during resolution. */
  escalated: boolean;
}

/**
 * The semantic ancestor path of `node` inside `view`: every emitted
 * ancestor on its parentRef chain, outermost first. Null when the node has
 * no emitted ancestor in this view or a hop does not resolve inside the same
 * observation (fail closed: a partial chain matches nothing).
 */
function ancestorPathIn(view: QaObservation, node: QaSemanticNode): { role: string; name: string }[] | null {
  const byRef = new Map(view.nodes.map((candidate) => [candidate.ref, candidate]));
  const chain: { role: string; name: string }[] = [];
  let current = node;
  for (let hops = 0; hops <= view.nodes.length; hops += 1) {
    const parentRef = typeof current.parentRef === 'string' && current.parentRef !== '' ? current.parentRef : null;
    if (parentRef === null) {
      return chain.length === 0 ? null : chain.reverse();
    }
    const parent = byRef.get(parentRef);
    if (parent === undefined) return null;
    chain.push({ role: parent.role, name: parent.name });
    current = parent;
  }
  return null;
}

/**
 * Path comparison for container resolution: when the recorded scope carries
 * an ancestor path, a candidate matches only when its own parentRef chain
 * yields the SAME { role, name } sequence — relationships compared, never
 * refs. No recorded path means predicate-only matching.
 */
function sameScopePath(
  recorded: { role: string; name: string }[] | undefined,
  candidate: { role: string; name: string }[] | null,
): boolean {
  if (recorded === undefined) return true;
  if (candidate === null) return false;
  return recorded.length === candidate.length
    && recorded.every((item, index) => item.role === candidate[index]!.role && item.name === candidate[index]!.name);
}

/**
 * Observe WITHIN the container an assertion is scoped to (browser driver
 * contract v8). The container is resolved in the WHOLE-PAGE view — by UNIQUE
 * predicate, and, when the scope carries a recorded ancestor PATH
 * (QA-BL-062), additionally by that path: a candidate matches only when its
 * own parentRef chain yields the same { role, name } sequence (relationships
 * compared, never refs). An ambiguous container is refused with the existing
 * TARGET_NOT_UNIQUE vocabulary, never guessed — and the scoped read is
 * SETTLED like every other verification observation. A driver refusal on
 * the scoped read (REF_INVALID / REF_EXPIRED / TARGET_CHANGED / ...)
 * propagates as itself, never degraded into a "not found".
 *
 * QA-BL-054 / QA-BL-062: uniqueness must be PROVEN. ZERO matches in a
 * truncated whole-page view may mean the container sits outside the window,
 * and ONE match in a truncated view is NOT proven unique (a twin may sit
 * outside the window). Both escalate the whole-page node budget ONCE (the
 * existing mechanism, the same settled way as action targets) before
 * concluding. Two or more matches are proven non-unique and never escalate.
 * A still-truncated view with exactly ONE match resolves PROVISIONALLY for
 * the scoped scroll-proof step (options.provisionalScope) and for any scope
 * that carries a recorded ancestor path (a stronger locator, still not
 * proof); the caller must then report INCONCLUSIVE_SCOPE — never a pass.
 * Every other one-match-in-a-truncated-view resolution refuses with
 * INCONCLUSIVE_TRUNCATED naming the scope.
 */
async function observeScopeView(
  scope: QaScenarioAssertionScope,
  wholePage: QaObservation,
  session: QaSession,
  reobserve: QaReobserve,
  options: ScopeResolutionOptions = {},
): Promise<ScopeResolutionResult> {
  const predicate = scopePredicate(scope);
  const path = scope.path;
  const matchesIn = (view: QaObservation): typeof view.nodes =>
    view.nodes.filter(
      (node) => matchesNode(node, predicate) && sameScopePath(path, ancestorPathIn(view, node)),
    );
  let view = wholePage;
  let matches = matchesIn(view);
  let escalated = false;
  if (view.truncated && matches.length <= 1) {
    try {
      view = await reobserve({ maxNodes: QA_ESCALATED_NODE_BUDGET });
      escalated = true;
      matches = matchesIn(view);
    } catch {
      // No fuller view: fall through and report honestly against the truncated one.
    }
  }
  if (matches.length === 0) {
    if (view.truncated) {
      const applied = escalated
        ? view.maxNodes === undefined
          ? 'the escalated budget (the driver did not report the budget it applied)'
          : 'the applied ' + String(view.maxNodes) + '-node escalated budget'
        : 'the driver-default budget';
      throw new Error(
        'no observable node matches the assertion scope, and the view was still truncated at '
        + applied + ' (' + QA_INCONCLUSIVE_TRUNCATED
        + '): the container may exist outside the returned window rather than be missing from the page',
      );
    }
    throw new Error(
      'no observable node matches the assertion scope (' + describeScope(scope)
      + (path === undefined ? '' : ', ancestor path ' + JSON.stringify(path)) + ')',
    );
  }
  if (matches.length > 1) {
    throw new QaCodeError(
      QA_TARGET_NOT_UNIQUE,
      QA_TARGET_NOT_UNIQUE + ': ' + String(matches.length) + ' nodes match the assertion scope ('
      + describeScope(scope) + '); the scoped container is not uniquely identifiable, so the assertion was not decided',
    );
  }
  if (view.truncated && options.provisionalScope !== true && path === undefined) {
    // QA-BL-054: exactly ONE match in a STILL-truncated view is not proven
    // uniqueness — a twin container may sit outside the returned window.
    // Refuse, naming the scope and the code. (A scroll-proof step, or a
    // recorded ancestor path, resolves provisionally instead — see
    // ScopeResolutionOptions / QA-BL-062.)
    const applied = escalated
      ? view.maxNodes === undefined
        ? 'the escalated budget (the driver did not report the budget it applied)'
        : 'the applied ' + String(view.maxNodes) + '-node escalated budget'
      : 'the driver-default budget';
    throw new Error(
      'one observable node matches the assertion scope (' + describeScope(scope)
      + '), but the view was still truncated at ' + applied + ' (' + QA_INCONCLUSIVE_TRUNCATED
      + '): a twin container may exist outside the returned window, so the scoped container is not uniquely identifiable',
    );
  }
  const container = matches[0];
  if (container === undefined) {
    throw new Error('no observable node matches the assertion scope');
  }
  const settled = await session.observeSettled({
    withinRef: container.ref,
    ...(options.scopedObserve === undefined ? {} : options.scopedObserve),
  });
  if (!settled.stable) {
    throw new Error(unsettledMessage('scoped', settled.budgetMs));
  }
  return {
    observation: settled.observation,
    resolution: view.truncated ? 'provisional' : 'proven',
    escalated,
  };
}

/**
 * Completeness block for a decision the scope resolution made PROVISIONAL
 * (QA-BL-062): the deciding view itself is reported honestly, and the detail
 * names the provisional resolution — the container matched exactly once in a
 * still-truncated whole-page view, so uniqueness is unproven and the outcome
 * is INCONCLUSIVE_SCOPE, never a pass.
 */
function provisionalScopeCompleteness(
  assertion: QaScenario['assertions'][number] | QaScenario['steps'][number]['assert'],
  scoped: ScopeResolutionResult,
): QaViewCompleteness {
  const view = scoped.observation;
  return {
    truncated: view.truncated,
    nodeBudget: view.maxNodes ?? null,
    escalated: scoped.escalated,
    outcomeDependsOnCompleteView: false,
    ...(view.scope === undefined ? {} : { scope: { role: view.scope.role, name: view.scope.name } }),
    ...(view.truncationReasons === undefined ? {} : { truncationReasons: view.truncationReasons }),
    detail: 'the scoped container was resolved PROVISIONALLY: exactly one observable node matched the assertion scope'
      + (assertion.scope?.path === undefined ? '' : ' (the recorded ancestor path matched)')
      + ' in a still-truncated whole-page view, so the container\'s uniqueness is unproven and the '
      + assertion.kind + ' assertion was NOT decided as proven (' + QA_INCONCLUSIVE_SCOPE + ').',
  };
}

/** Decide one assertion, honoring its optional container scope. */
async function decideAssertionScoped(
  assertion: QaScenario['assertions'][number] | QaScenario['steps'][number]['assert'],
  observation: QaObservation,
  reobserve: QaReobserve,
  session: QaSession,
  options: ScopeResolutionOptions = {},
): Promise<QaRetriedDecision> {
  if (assertion.scope === undefined) {
    return decideAssertionWithRetry(assertion, observation, reobserve, session);
  }
  const scoped = await observeScopeView(assertion.scope, observation, session, reobserve, options);
  if (scoped.resolution === 'provisional') {
    // QA-BL-062: a provisionally resolved container can never earn a pass.
    // The assertion is still evaluated against the scoped view so the report
    // shows what WAS observed, but the outcome is INCONCLUSIVE_SCOPE — the
    // container may be the wrong one (a twin outside the window).
    const evaluation = evaluateAssertion(assertion, scoped.observation);
    return {
      passed: false,
      observed: evaluation.observed,
      observation: scoped.observation,
      completeness: provisionalScopeCompleteness(assertion, scoped),
      reason: QA_INCONCLUSIVE_SCOPE,
      scopeResolution: 'provisional',
      attempts: 1,
      elapsedMs: 0,
      widened: null,
    };
  }
  const decision = await decideAssertionWithRetry(assertion, scoped.observation, reobserve, session);
  return { ...decision, scopeResolution: 'proven' };
}

function resolveRef(target: QaNodePredicate, observation: QaObservation): string {
  const matches = observation.nodes.filter((node) => matchesNode(node, target));
  if (matches.length === 0) {
    throw new Error('no observable node matches the action target');
  }
  if (matches.length > 1) {
    // Export refuses a non-unique (role, name) target; replay re-checks the
    // same uniqueness before dispatching. Acting on the FIRST of several
    // same-named nodes would be a guess — a twin that already holds the
    // recorded value would turn the step's node-value into a false green
    // while the recorded target stays empty. Fail closed instead.
    const first = matches[0];
    if (first === undefined) throw new Error('no observable node matches the action target');
    throw new QaCodeError(
      QA_TARGET_NOT_UNIQUE,
      QA_TARGET_NOT_UNIQUE + ': ' + String(matches.length) + ' nodes match the action target ('
      + describeTarget(target) + '); the recorded target is not uniquely identifiable, so no action was dispatched',
    );
  }
  const only = matches[0];
  if (only === undefined) throw new Error('no observable node matches the action target');
  return only.ref;
}

/** The semantic target an action resolves to a ref, or null when it needs none. */
function targetOf(action: QaScenarioAction): QaNodePredicate | null {
  if (action.kind === 'navigate') return null;
  if (action.kind === 'scroll' && !('target' in action)) return null;
  return action.target;
}

/**
 * Resolve an action's target, escalating the node budget ONCE when the target
 * is missing from a TRUNCATED view.
 *
 * Same blind spot as an assertion, opposite direction: "the target is not in
 * the returned nodes" does not mean the target is not on the page — it can
 * simply have fallen outside the budget (live evidence: after a scroll, the
 * scroll target was absent from the 60-node view and present at 100). Without
 * this, a scenario fails with a misleading "no observable node matches" and a
 * human has to raise max_nodes by hand.
 */
async function resolveActionWithBudget(
  action: QaScenarioAction,
  observation: QaObservation,
  reobserve: QaReobserve,
): Promise<{ resolved: QaAction; observation: QaObservation }> {
  const target = targetOf(action);
  let view = observation;
  let escalated = false;
  const missing = (candidate: QaObservation): boolean =>
    target !== null && !candidate.nodes.some((node) => matchesNode(node, target));
  if (missing(view) && view.truncated) {
    try {
      view = await reobserve({ maxNodes: QA_ESCALATED_NODE_BUDGET });
      escalated = true;
    } catch {
      // No fuller view: fall through and report honestly against the truncated one.
    }
  }
  if (missing(view)) {
    if (view.truncated) {
      // Same honesty rule as the completeness block: name the budget the
      // driver APPLIED (its own clamp), never the requested constant.
      const applied = escalated
        ? view.maxNodes === undefined
          ? 'the escalated budget (the driver did not report the budget it applied)'
          : 'the applied ' + String(view.maxNodes) + '-node escalated budget'
        : 'the driver-default budget';
      throw new Error(
        'no observable node matches the action target, and the view was still truncated at '
        + applied + ' (' + QA_INCONCLUSIVE_TRUNCATED
        + '): the target may exist outside the returned window rather than be missing from the page',
      );
    }
    throw new Error('no observable node matches the action target');
  }
  return { resolved: resolveAction(action, view), observation: view };
}

function resolveAction(action: QaScenarioAction, observation: QaObservation): QaAction {
  if (action.kind === 'navigate') return { kind: 'navigate', url: action.url };
  if (action.kind === 'click') return { kind: 'click', ref: resolveRef(action.target, observation) };
  if (action.kind === 'fill') {
    return { kind: 'fill', ref: resolveRef(action.target, observation), text: action.text };
  }
  if (action.kind === 'press') {
    return { kind: 'press', ref: resolveRef(action.target, observation), key: action.key };
  }
  if (action.kind === 'scroll') {
    if ('target' in action) return { kind: 'scroll', ref: resolveRef(action.target, observation) };
    return {
      kind: 'scroll',
      direction: action.direction,
      ...(action.amount === undefined ? {} : { amount: action.amount }),
    };
  }
  if (action.kind === 'select') {
    return { kind: 'select', ref: resolveRef(action.target, observation), option: action.option };
  }
  return { kind: 'hover', ref: resolveRef(action.target, observation) };
}

/**
 * Resolve a step's action, honoring the assertion's container scope (browser
 * driver contract v8). A scoped assertion names the container the recorded
 * proof was taken in, so the action's target is resolved INSIDE that
 * container — the same window the recording used — instead of only in the
 * whole-page view: a target that sits beyond the driver's clamped 100-node
 * whole-page window (reachable only by scoping) is still dispatchable. The
 * container itself is resolved from the whole-page view exactly like the
 * assertion path (unique predicate, one bounded escalation, fail-closed
 * refusals). A target missing from a still-truncated scoped view escalates
 * WITHIN the same scope (one bounded re-read), never by widening to the whole
 * page; a target missing from a complete scoped view fails closed naming the
 * target. The whole-page observation stays the returned observation for the
 * next step (the scoped reads consumed the session's latest observation; the
 * post-action settle refreshes it regardless). Steps whose assertion carries
 * no scope resolve exactly as before.
 */
async function resolveStepAction(
  action: QaScenarioAction,
  assert: QaScenario['steps'][number]['assert'],
  wholePage: QaObservation,
  session: QaSession,
  reobserve: QaReobserve,
  options: ScopeResolutionOptions = {},
): Promise<{ resolved: QaAction; observation: QaObservation }> {
  if (assert.scope === undefined) {
    return resolveActionWithBudget(action, wholePage, reobserve);
  }
  const scoped = await observeScopeView(assert.scope, wholePage, session, reobserve, options);
  const scopedView = scoped.observation;
  const target = targetOf(action);
  let view = scopedView;
  if (target !== null && !view.nodes.some((node) => matchesNode(node, target)) && view.truncated) {
    const withinRef = scopeRootRef(view);
    if (withinRef === undefined) {
      // The scoped view cannot be re-chained (its root is not among the
      // returned nodes): fail closed like the assertion path.
      throw new Error(
        'no observable node matches the action target inside the scoped container, and the scoped view '
        + 'cannot be re-chained (its root is not among the returned nodes) (' + QA_INCONCLUSIVE_TRUNCATED + ')',
      );
    }
    view = await reobserve({ maxNodes: QA_ESCALATED_NODE_BUDGET, withinRef });
  }
  if (target !== null && !view.nodes.some((node) => matchesNode(node, target))) {
    if (view.truncated) {
      throw new Error(
        'no observable node matches the action target inside the scoped container, and the scoped view was still '
        + 'truncated at the applied budget (' + QA_INCONCLUSIVE_TRUNCATED
        + '): the target may exist outside the returned subtree window rather than be missing from the page',
      );
    }
    throw new Error('no observable node matches the action target inside the scoped container');
  }
  return { resolved: resolveAction(action, view), observation: wholePage };
}

/** The exported scoped scroll-proof shape: a scroll-by-target step whose
 * assertion is a SCOPED node-in-viewport. The record side proved it through
 * the driver's identity anchor; the whole page can never complete when the
 * target sits beyond the driver's clamped node budget, so such steps resolve
 * and decide INSIDE the container with the provisional scope gate (see
 * ScopeResolutionOptions) instead of the strict QA-BL-054 uniqueness refusal.
 */
function scopedScrollProofStep(step: {
  action: QaScenarioAction;
  assert: QaScenario['steps'][number]['assert'];
}): boolean {
  return step.action.kind === 'scroll'
    && 'target' in step.action
    && step.assert.kind === 'node-in-viewport'
    && step.assert.scope !== undefined;
}

/** Same JSON shape (lossless scenario values), for predicate comparisons. */
function sameJsonShape(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Identity-anchor verification of a replayed scoped scroll (QA-BL-062): the
 * anchor must report the ORIGINAL acted element connected, contained in the
 * scoped container, emitted with a ref — AND that anchored node must be the
 * SAME node ref as the asserted target, in the viewport. A lost binding or a
 * mismatch REFUSES the step; the runner never reselects by predicate, because
 * the anchor proves what happened to the element replay SELECTED, not that
 * replay selected the recorded counterpart.
 */
function verifyScopedScrollAnchor(
  view: QaObservation,
  targetNode: QaSemanticNode,
): { ok: true } | { ok: false; reason: string } {
  const anchor = view.anchor;
  if (anchor === undefined) {
    return { ok: false, reason: 'the driver reported no identity anchor for the scoped verifying read' };
  }
  if (anchor.connected !== true) {
    return { ok: false, reason: 'the identity anchor reported the acted element no longer connected (connected: false)' };
  }
  if (anchor.contained !== true) {
    return { ok: false, reason: 'the identity anchor reported the acted element outside the scoped container (contained: false)' };
  }
  if (anchor.ref === null) {
    return { ok: false, reason: 'the identity anchor excluded the acted element from the scoped view (anchor ref null)' };
  }
  const anchored = view.nodes.find((node) => node.ref === anchor.ref);
  if (anchored === undefined) {
    return { ok: false, reason: 'the identity anchor ref did not resolve to an emitted node in the scoped view' };
  }
  if (anchored.ref !== targetNode.ref) {
    return {
      ok: false,
      reason: 'the identity anchor bound a different element than the asserted scroll target (same-node-ref identity failed); never reselecting by predicate',
    };
  }
  if (anchored.inViewport !== true) {
    return { ok: false, reason: 'the anchored element is not in the viewport, so the scoped scroll proof is unproven' };
  }
  return { ok: true };
}

/** Outcome of the scoped scroll-proof decision (QA-BL-062). */
type ScopedScrollProofOutcome =
  | { kind: 'pass'; observed: unknown; completeness: QaViewCompleteness }
  | {
      kind: 'inconclusive';
      observed: unknown;
      completeness: QaViewCompleteness;
      refusal?: { reason: string };
    }
  | { kind: 'failure'; error: Error };

/**
 * Decide a replayed scoped SCROLL-proof step against the anchor-verified
 * scoped view (the verifying read requested anchorLastAction + verifyCoverage):
 *
 * - count target predicate matches BEFORE filtering by inViewport: 0 -> not
 *   found (a definite failure on a complete subtree, INCONCLUSIVE_TRUNCATED
 *   on a truncated one); >=2 -> TARGET_NOT_UNIQUE (a KNOWN twin is never
 *   guessed); exactly 1 -> the unique target node.
 * - verify the identity anchor on that exact node (same node ref, connected,
 *   contained, in viewport). A lost binding or mismatch REFUSES the step
 *   (escalationRefused-style disclosure) — never a predicate reselect.
 * - PASS only when the container resolution is PROVEN, the scoped subtree is
 *   complete, its coverage is verified, the anchor is truthful, and the
 *   anchored node is the asserted target in the viewport. Everything else is
 *   INCONCLUSIVE_SCOPE (provisional): the anchor proves what happened to the
 *   element replay SELECTED, not that replay selected the recorded
 *   counterpart.
 */
function decideScopedScrollProof(
  assertion: QaScenario['steps'][number]['assert'],
  target: QaNodePredicate,
  scoped: ScopeResolutionResult,
): ScopedScrollProofOutcome {
  const view = scoped.observation;
  const completenessBase = {
    truncated: view.truncated,
    nodeBudget: view.maxNodes ?? null,
    escalated: scoped.escalated,
    outcomeDependsOnCompleteView: false,
    ...(view.scope === undefined ? {} : { scope: { role: view.scope.role, name: view.scope.name } }),
    ...(view.truncationReasons === undefined ? {} : { truncationReasons: view.truncationReasons }),
  };
  const matches = view.nodes.filter((node) => matchesNode(node, target));
  if (matches.length === 0) {
    if (view.truncated) {
      return {
        kind: 'failure',
        error: new Error(
          'no observable node matches the scroll target inside the scoped container, and the scoped view was still '
          + 'truncated at the applied budget (' + QA_INCONCLUSIVE_TRUNCATED
          + '): the target may exist outside the returned subtree window rather than be missing from the page',
        ),
      };
    }
    return {
      kind: 'failure',
      error: new Error(
        'the scoped scroll-proof assertion found no observable node matching the target (' + describeTarget(target)
        + ') inside the complete scoped container',
      ),
    };
  }
  if (matches.length > 1) {
    // Counted BEFORE the inViewport filter: a KNOWN twin refuses, never a guess.
    return {
      kind: 'failure',
      error: new QaCodeError(
        QA_TARGET_NOT_UNIQUE,
        QA_TARGET_NOT_UNIQUE + ': ' + String(matches.length) + ' nodes match the scroll target ('
        + describeTarget(target) + ') inside the scoped container, so the replayed target is not uniquely identifiable',
      ),
    };
  }
  const targetNode = matches[0];
  if (targetNode === undefined) {
    return { kind: 'failure', error: new Error('no observable node matches the scroll target') };
  }
  // The assertion is still evaluated against the scoped view so the report
  // shows what WAS observed — but only the anchor + resolution decide PASS.
  const evaluation = evaluateAssertion(assertion, view);
  const anchor = verifyScopedScrollAnchor(view, targetNode);
  if (!anchor.ok) {
    return {
      kind: 'inconclusive',
      observed: evaluation.observed,
      completeness: {
        ...completenessBase,
        detail: 'the scoped scroll proof was REFUSED by the identity anchor: ' + anchor.reason
          + ' (' + QA_INCONCLUSIVE_SCOPE + ').',
      },
      refusal: { reason: anchor.reason },
    };
  }
  const subtreeComplete = !view.truncated;
  const coverageVerified = view.coverage?.verified === true;
  if (scoped.resolution === 'proven' && subtreeComplete && coverageVerified && targetNode.inViewport === true) {
    return {
      kind: 'pass',
      observed: evaluation.observed,
      completeness: {
        ...completenessBase,
        detail: 'the container was resolved in a complete whole-page view (proven), the scoped subtree is complete '
          + 'with verified coverage, and the identity anchor confirmed the asserted target is the anchored node in the viewport.',
      },
    };
  }
  const why = scoped.resolution === 'provisional'
    ? 'the scoped container was resolved PROVISIONALLY (one match in a still-truncated whole-page view)'
    : subtreeComplete
      ? 'the scoped subtree was complete but its coverage was not verified (coverage.verified !== true), so target uniqueness inside the scope is unproven'
      : 'the scoped subtree was still truncated at its budget, so target uniqueness inside the scope is unproven';
  return {
    kind: 'inconclusive',
    observed: evaluation.observed,
    completeness: {
      ...completenessBase,
      detail: why + ': the scoped scroll proof cannot earn a pass (' + QA_INCONCLUSIVE_SCOPE + ').',
    },
  };
}

interface StepBase {
  index: number;
  intent: string;
  action: QaScenarioAction;
}

function buildStepResult(
  base: StepBase,
  assertion: QaScenario['steps'][number]['assert'],
  receipt: QaActionReceipt | null,
  outcome: 'ok' | 'unknown' | 'failed',
  assertionPassed: boolean,
  observed: unknown,
  completeness: QaViewCompleteness | null = null,
  reason?: string,
  attempts?: number,
  elapsedMs?: number,
  scope: {
    scopeResolution?: 'proven' | 'provisional';
    scopeRefusal?: { code?: string; reason: string };
  } = {},
): QaStepResult {
  return {
    index: base.index,
    intent: base.intent,
    // QA-BL-062 three-state: INCONCLUSIVE_SCOPE is a provisional non-result —
    // never green, and never an ordinary failure.
    status: assertionPassed ? 'pass' : reason === QA_INCONCLUSIVE_SCOPE ? 'inconclusive' : 'fail',
    action: base.action,
    receipt,
    outcome,
    assertion,
    assertionPassed,
    observed,
    expected: assertion.expected,
    ...(completeness === null ? {} : { completeness }),
    ...(reason === undefined ? {} : { reason }),
    ...(attempts === undefined || attempts <= 1 ? {} : { attempts, elapsedMs: elapsedMs ?? 0 }),
    ...(scope.scopeResolution === undefined ? {} : { scopeResolution: scope.scopeResolution }),
    ...(scope.scopeRefusal === undefined ? {} : { scopeRefusal: scope.scopeRefusal }),
  };
}

/**
 * Failure message for a decided assertion. An outcome that could not be proven
 * is NEVER reported as an ordinary "failed": it names the machine code —
 * QA_INCONCLUSIVE_TRUNCATED (an incomplete view) or QA_COVERAGE_UNVERIFIED
 * (a complete view whose boundaries the driver did not verify) — and the
 * honest detail, so a human triaging the report can tell "not present" from
 * "we could not see the whole page" from "the boundaries were not verified".
 */
function assertionFailureMessage(what: string, decision: QaAssertionDecision): string {
  const completeness = decision.completeness;
  if (completeness?.reason !== undefined) {
    return what + ' is ' + completeness.reason + ': ' + completeness.detail;
  }
  if (decision.reason !== undefined) {
    return what + ' failed (' + decision.reason + ')';
  }
  return what + ' failed';
}

function toReproduction(steps: QaStepResult[]): QaReproductionStep[] {
  return steps.map((s) => ({
    index: s.index,
    intent: s.intent,
    action: s.action,
    observed: s.observed,
    expected: s.expected,
    receipt: s.receipt,
  }));
}

/**
 * Deterministic receipt census over the steps that dispatched an action. A
 * step whose action failed to resolve (receipt null) is not an action dispatch
 * and is not counted. `failed` is a distinct driver status from `rejected` and
 * is counted separately so neither is silently dropped.
 */
function summarizeReceipts(steps: QaStepResult[]): QaReceiptSummary {
  const summary: QaReceiptSummary = { confirmed: 0, unknown: 0, rejected: 0, failed: 0, total: 0 };
  for (const step of steps) {
    const receipt = step.receipt;
    if (receipt === null) continue;
    summary.total += 1;
    if (receipt.status === 'confirmed') summary.confirmed += 1;
    else if (receipt.status === 'unknown') summary.unknown += 1;
    else if (receipt.status === 'rejected') summary.rejected += 1;
    else summary.failed += 1;
  }
  if (summary.confirmed === 0 && summary.total > 0) {
    summary.warning = QA_NO_CONFIRMED_RECEIPTS_WARNING;
  }
  return summary;
}
function blockedReport(scenario: QaScenario, startedAt: string, message: string): QaRunReport {
  return {
    schemaVersion: 1,
    scenario: scenario.meta.name,
    driver: scenario.meta.driver,
    status: 'blocked',
    startedAt,
    finishedAt: new Date().toISOString(),
    steps: [],
    assertions: [],
    evidence: null,
    receiptSummary: { confirmed: 0, unknown: 0, rejected: 0, failed: 0, total: 0 },
    failure: { stepIndex: null, message, reproduction: [] },
  };
}

function advisoryUnclear(question: string, reasoning: string, reason: string, description?: string): QaAdvisoryResult {
  return {
    kind: 'visual',
    question,
    verdict: 'unclear',
    confidence: 0,
    reasoning,
    reasoningTrust: QA_ADVISORY_REASONING_TRUST,
    reason,
    ...(description === undefined ? {} : { description }),
  };
}

/**
 * Execute advisory visual assertions against the final state. This never
 * throws and never changes the run status: capture failures and an absent
 * vision model degrade each finding to 'unclear' with a stable reason.
 */
async function executeAdvisory(
  scenario: QaScenario,
  session: QaSession,
  services: QaVisualServices | undefined,
  capturesDir: string,
): Promise<{ artifacts: QaArtifact[]; advisory: QaAdvisoryResult[] }> {
  const advisory = scenario.advisory ?? [];
  const artifacts: QaArtifact[] = [];
  const results: QaAdvisoryResult[] = [];
  if (advisory.length === 0) return { artifacts, advisory: results };

  let capture: QaVisualCapture;
  let captureSettle: { stable: boolean; passes: number; budgetMs: number } | null;
  try {
    const latest = await captureLatestVisual(session);
    capture = latest.capture;
    captureSettle = latest.settle;
  } catch (error) {
    for (const assertion of advisory) {
      results.push(advisoryUnclear(assertion.question, errorMessage(error), 'visual-capture-failed', assertion.description));
    }
    return { artifacts, advisory: results };
  }

  let artifactPath: string;
  try {
    artifactPath = await persistCaptureFile(capture, capturesDir);
  } catch (error) {
    for (const assertion of advisory) {
      results.push(advisoryUnclear(assertion.question, errorMessage(error), 'visual-capture-failed', assertion.description));
    }
    return { artifacts, advisory: results };
  }
  const artifact: QaArtifact = { path: artifactPath, kind: 'screenshot' };
  artifacts.push(artifact);

  for (const assertion of advisory) {
    const finding = await evaluateVisualQuestion(assertion.question, capture, services);
    results.push({
      kind: 'visual',
      question: assertion.question,
      verdict: finding.verdict,
      confidence: finding.confidence,
      reasoning: finding.reasoning,
      reasoningTrust: QA_ADVISORY_REASONING_TRUST,
      ...(finding.reason === undefined ? {} : { reason: finding.reason }),
      ...(assertion.description === undefined ? {} : { description: assertion.description }),
      // The capture's settle window travels beside the advisory verdict
      // (additive, excluded from determinism by schema): stable === false means
      // the view never stopped changing, so the advisory verdict is over an
      // unstable view and is marked as such in report.md / report.json.
      ...(captureSettle === null ? {} : {
        settle: captureSettle,
        ...(captureSettle.stable ? {} : { captureSettled: false as const }),
      }),
      artifact,
    });
  }
  return { artifacts, advisory: results };
}

// Executes a scenario step by step through the QA session core. An "unknown"
// receipt is NEVER a pass: only the fresh SETTLED re-observation decides (the
// same bounded settle policy Explore proved the scenario with). On failure,
// evidence plus reproduction steps (index, action, observed vs expected) are
// captured. The driver is always stopped, even when a step fails.
export async function runScenario(
  scenario: QaScenario,
  adapter: QaDriverAdapter,
  options: ReplayRunOptions = {},
): Promise<QaRunReport> {
  if (adapter.kind !== scenario.meta.driver) {
    throw new Error(
      'scenario driver (' + scenario.meta.driver + ') does not match adapter driver (' + adapter.kind + ')',
    );
  }
  const ownerId = options.ownerId ?? 'dsh-qa-replay';
  const launch = options.launchUrl ?? scenario.target.launch;
  const startedAt = new Date().toISOString();

  // The scenario's recorded meta.settle (the exact policy Explore used) wins
  // over the env/host defaults the tool layer passed in options.settle; a
  // scenario without meta.settle keeps the env/host defaults.
  const session = new QaSession(adapter, ownerId, {
    settle: { ...(options.settle ?? {}), ...(scenario.meta.settle ?? {}) },
  });
  // The report prints the FINAL effective policy (reflecting a widening) plus a
  // widening record (where it happened), so neither is captured up front.
  const stepResults: QaStepResult[] = [];
  const assertionResults: QaAssertionResult[] = [];
  const artifacts: QaArtifact[] = [];
  const advisoryResults: QaAdvisoryResult[] = [];
  let evidence: QaEvidence | QaEvidenceCollectionFailure | null = null;
  let failure: QaRunFailure | null = null;
  let settleWidened: QaSettleWidening | null = null;
  // QA-BL-062: the count of PROVISIONAL required results (scopeResolution
  // 'provisional'). Any provisional result keeps the run off 'pass' — and
  // when nothing definitely failed, the run aggregates to 'inconclusive'.
  let provisionalCount = 0;

  try {
    await session.start({
      url: launch,
      ...(options.headless === undefined ? {} : { headless: options.headless }),
      ...(scenario.target.loginState === undefined ? {} : { loginState: scenario.target.loginState }),
    });
  } catch (error) {
    await session.stop().catch(() => {});
    return blockedReport(scenario, startedAt, 'failed to start driver: ' + errorMessage(error));
  }

  // One bounded budget escalation per decision, taken the same SETTLED way as
  // every other verification observation (an unsettled escalated view is
  // refused, so the decision falls back and fails closed).
  const reobserve = sessionReobserve(session);

  try {
    // Symmetry with export: every verification observation is SETTLED, and an
    // unstable view is a failure, never a silent pass.
    const initial = await session.observeSettled();
    if (settleWidened === null && initial.widened !== null) {
      settleWidened = { ...initial.widened, at: 'initial' };
    }
    let current = initial.observation;
    if (!initial.stable) {
      failure = {
        stepIndex: null,
        message: unsettledMessage('initial', initial.budgetMs),
        code: QA_INCONCLUSIVE_UNSTABLE,
        reproduction: [],
      };
    }

    // The last exported scoped scroll-proof step (B3): the final assertion
    // exported from it (scenario.assertions[0] === the last step's assert) is
    // decided under the same provisional scope gate.
    let lastScrollProofStep: { action: QaScenarioAction; assert: QaScenario['steps'][number]['assert'] } | null = null;
    // The LAST scoped scroll-proof step's decision: the final assertion copied
    // from it INHERITS its outcome (QA-BL-062) instead of being re-decided.
    let lastScrollProofDecision: QaRetriedDecision | null = null;
    for (let stepIndex = 0; stepIndex < scenario.steps.length; stepIndex += 1) {
      // Fail closed: an unsettled view before the first step proves nothing.
      if (failure !== null) break;
      const step = scenario.steps[stepIndex];
      if (step === undefined) continue;
      const base: StepBase = { index: step.index, intent: step.intent, action: step.action };
      const scopedScrollProof = scopedScrollProofStep(step);
      if (scopedScrollProof) lastScrollProofStep = step;

      let resolved: QaAction;
      try {
        // A step whose assertion carries a container scope resolves its action
        // target INSIDE that container (see resolveStepAction), so a target
        // beyond the whole-page node-budget window stays reachable.
        const resolution = await resolveStepAction(
          step.action,
          step.assert,
          current,
          session,
          reobserve,
          { provisionalScope: scopedScrollProof },
        );
        resolved = resolution.resolved;
        current = resolution.observation;
      } catch (error) {
        stepResults.push(buildStepResult(base, step.assert, null, 'failed', false, null));
        const code = failureCodeFor(error);
        failure = {
          stepIndex: step.index,
          message: errorMessage(error),
          ...(code === undefined ? {} : { code }),
          reproduction: toReproduction(stepResults),
        };
        break;
      }

      let result: QaActResult;
      try {
        result = await session.act(resolved);
      } catch (error) {
        stepResults.push(buildStepResult(base, step.assert, null, 'failed', false, null));
        failure = {
          stepIndex: step.index,
          message: errorMessage(error),
          reproduction: toReproduction(stepResults),
        };
        break;
      }
      if (settleWidened === null && result.settle !== null && result.settle.widened !== null) {
        settleWidened = { ...result.settle.widened, at: step.index };
      }

      if (result.outcome === 'failed' || result.observation === null) {
        stepResults.push(buildStepResult(base, step.assert, result.receipt, result.outcome, false, null));
        failure = {
          stepIndex: step.index,
          message:
            'action receipt ' +
            result.receipt.status +
            (result.receipt.code !== undefined ? ' (' + result.receipt.code + ')' : ''),
          reproduction: toReproduction(stepResults),
        };
        break;
      }

      if (result.settle !== null && !result.settle.stable) {
        // The post-action view kept changing: nothing observed in it can be
        // attributed to this action, so the step fails honestly.
        stepResults.push(buildStepResult(base, step.assert, result.receipt, result.outcome, false, null));
        failure = {
          stepIndex: step.index,
          message: unsettledMessage('post-action', result.settle.budgetMs),
          code: QA_INCONCLUSIVE_UNSTABLE,
          reproduction: toReproduction(stepResults),
        };
        break;
      }

      // confirmed OR unknown receipt: only the fresh SETTLED re-observation
      // decides — and never a TRUNCATED one when the outcome depends on having
      // seen the whole view (see decideAssertion). A positive-existence "not
      // found" is retried within the settle budget (see decideAssertionWithRetry)
      // so a slow page's late node/role is not mistaken for absence.
      // An assertion carrying a scope (browser contract v8) is decided against
      // a settled observation WITHIN that container, resolved from this whole-
      // page view; a driver refusal on the scoped read fails the run as itself.
      let decision: QaRetriedDecision;
      try {
        if (scopedScrollProof) {
          // QA-BL-062: the replayed scoped scroll is verified through the
          // driver's identity anchor. The verifying scoped read requests
          // anchorLastAction (the binding of the EXACT action) and
          // verifyCoverage (the coverage evidence target uniqueness inside
          // the scope needs to be proven).
          const target = (step.action as { kind: 'scroll'; target: QaNodePredicate }).target;
          const verifying = await observeScopeView(
            step.assert.scope as QaScenarioAssertionScope,
            result.observation,
            session,
            reobserve,
            {
              provisionalScope: true,
              scopedObserve: {
                anchorLastAction: true,
                verifyCoverage: true,
                // The record-time escalated read ran at the same budget: the
                // container subtree can exceed the default window (61 nodes in
                // the deep-target fixture), and the verifying read must see
                // the whole subtree to count target matches honestly.
                maxNodes: QA_ESCALATED_NODE_BUDGET,
              },
            },
          );
          const outcome = decideScopedScrollProof(step.assert, target, verifying);
          if (outcome.kind === 'failure') throw outcome.error;
          decision = {
            passed: outcome.kind === 'pass',
            observed: outcome.observed,
            observation: verifying.observation,
            completeness: outcome.completeness,
            ...(outcome.kind === 'pass' ? {} : { reason: QA_INCONCLUSIVE_SCOPE }),
            ...(outcome.kind === 'inconclusive' && outcome.refusal !== undefined
              ? { scopeRefusal: outcome.refusal }
              : {}),
            scopeResolution: verifying.resolution,
            attempts: 1,
            elapsedMs: 0,
            widened: null,
          };
        } else {
          decision = await decideAssertionScoped(
            step.assert,
            result.observation,
            reobserve,
            session,
            { provisionalScope: scopedScrollProof },
          );
        }
      } catch (error) {
        stepResults.push(buildStepResult(base, step.assert, result.receipt, result.outcome, false, null));
        const code = failureCodeFor(error);
        failure = {
          stepIndex: step.index,
          message: errorMessage(error),
          ...(code === undefined ? {} : { code }),
          reproduction: toReproduction(stepResults),
        };
        break;
      }
      if (settleWidened === null && decision.widened !== null) {
        settleWidened = { ...decision.widened, at: step.index };
      }
      stepResults.push(
        buildStepResult(
          base,
          step.assert,
          result.receipt,
          result.outcome,
          decision.passed,
          decision.observed,
          decision.completeness,
          decision.reason,
          decision.attempts,
          decision.elapsedMs,
          {
            ...(decision.scopeResolution === undefined ? {} : { scopeResolution: decision.scopeResolution }),
            ...(decision.scopeRefusal === undefined ? {} : { scopeRefusal: decision.scopeRefusal }),
          },
        ),
      );
      if (scopedScrollProof) lastScrollProofDecision = decision;
      // Any INCONCLUSIVE_SCOPE result is provisional evidence — a provisionally
      // resolved container OR an anchor refusal — and keeps the run off 'pass'.
      if (decision.reason === QA_INCONCLUSIVE_SCOPE) provisionalCount += 1;
      if (step.assert.scope === undefined) {
        current = decision.observation;
      } else if (stepIndex < scenario.steps.length - 1) {
        // The scoped read consumed the observation the container was
        // resolved from, so the next action cannot reuse it (its refs are
        // stale). Take a fresh SETTLED whole-page view; an unsettled one
        // fails closed exactly like the initial view.
        const refresh = await session.observeSettled();
        if (settleWidened === null && refresh.widened !== null) {
          settleWidened = { ...refresh.widened, at: step.index };
        }
        if (!refresh.stable) {
          failure = {
            stepIndex: step.index,
            message: unsettledMessage('post-scoped-assertion', refresh.budgetMs),
            code: QA_INCONCLUSIVE_UNSTABLE,
            reproduction: toReproduction(stepResults),
          };
          break;
        }
        current = refresh.observation;
      }
      if (!decision.passed) {
        if (decision.reason === QA_INCONCLUSIVE_SCOPE) {
          // QA-BL-062: a PROVISIONAL result is not a definite failure — the
          // loop continues and the run aggregates to 'inconclusive'.
        } else {
          failure = {
            stepIndex: step.index,
            message: assertionFailureMessage('assertion ' + step.assert.kind, decision),
            reproduction: toReproduction(stepResults),
          };
          break;
        }
      }
    }

    if (failure === null) {
      const finalSettle = await session.observeSettled();
      if (settleWidened === null && finalSettle.widened !== null) {
        settleWidened = { ...finalSettle.widened, at: 'final' };
      }
      // Reassigned when a decision escalated the node budget: the remaining
      // final assertions are then judged against that fuller view instead of
      // paying for the same escalation again.
      let finalObservation = finalSettle.observation;
      if (!finalSettle.stable) {
        failure = {
          stepIndex: null,
          message: unsettledMessage('final', finalSettle.budgetMs),
          code: QA_INCONCLUSIVE_UNSTABLE,
          reproduction: toReproduction(stepResults),
        };
      }
      for (let i = 0; failure === null && i < scenario.assertions.length; i += 1) {
        const assertion = scenario.assertions[i];
        if (assertion === undefined) continue;
        // QA-BL-062: the final assertion copied from the last scoped
        // scroll-proof step (scenario.assertions[0] === that step's assert)
        // INHERITS the step's decision — including a provisional
        // INCONCLUSIVE_SCOPE outcome — instead of being re-decided (a fresh
        // re-decision could never be more proven than the step's own
        // anchor-verified decision, and re-anchoring would bind whatever
        // action happened last).
        if (lastScrollProofStep !== null && lastScrollProofDecision !== null) {
          const scrollProofStep = lastScrollProofStep;
          const stepDecision = lastScrollProofDecision;
          const isCopy = assertion.kind === 'node-in-viewport'
            && assertion.scope !== undefined
            && sameJsonShape(assertion.scope, scrollProofStep.assert.scope)
            && sameJsonShape(
              assertion.expected,
              (scrollProofStep.action as { kind: 'scroll'; target: QaNodePredicate }).target,
            );
          if (isCopy) {
            assertionResults.push({
              kind: assertion.kind,
              ...(assertion.description === undefined ? {} : { description: assertion.description }),
              passed: stepDecision.passed,
              expected: assertion.expected,
              observed: stepDecision.observed,
              ...(assertion.scope === undefined ? {} : { scope: assertion.scope }),
              ...(stepDecision.completeness === null ? {} : { completeness: stepDecision.completeness }),
              ...(stepDecision.reason === undefined ? {} : { reason: stepDecision.reason }),
              ...(stepDecision.scopeResolution === undefined ? {} : { scopeResolution: stepDecision.scopeResolution }),
              ...(stepDecision.scopeRefusal === undefined ? {} : { scopeRefusal: stepDecision.scopeRefusal }),
            });
            if (stepDecision.reason === QA_INCONCLUSIVE_SCOPE) provisionalCount += 1;
            // The copy inherits the outcome: a provisional copy neither
            // fails the run nor passes it — the provisional evidence remains.
            continue;
          }
        }
        // The final assertion exported from the last scoped scroll-proof step
        // (scenario.assertions[0] === that step's assert) is decided under
        // the same provisional scope gate the step itself used.
        const provisionalScope = lastScrollProofStep !== null
          && assertion.kind === 'node-in-viewport'
          && assertion.scope !== undefined
          && sameJsonShape(assertion.scope, lastScrollProofStep.assert.scope)
          && sameJsonShape(
            assertion.expected,
            (lastScrollProofStep.action as { kind: 'scroll'; target: QaNodePredicate }).target,
          );
        let decision: QaRetriedDecision;
        try {
          decision = await decideAssertionScoped(
            assertion,
            finalObservation,
            reobserve,
            session,
            { provisionalScope },
          );
        } catch (error) {
          const code = failureCodeFor(error);
          assertionResults.push({
            kind: assertion.kind,
            ...(assertion.description === undefined ? {} : { description: assertion.description }),
            passed: false,
            expected: assertion.expected,
            observed: null,
            ...(assertion.scope === undefined ? {} : { scope: assertion.scope }),
            ...(code === undefined ? {} : { reason: code }),
          });
          failure = {
            stepIndex: null,
            message: errorMessage(error),
            ...(code === undefined ? {} : { code }),
            reproduction: toReproduction(stepResults),
          };
          break;
        }
        if (settleWidened === null && decision.widened !== null) {
          settleWidened = { ...decision.widened, at: 'final' };
        }
        assertionResults.push({
          kind: assertion.kind,
          ...(assertion.description === undefined ? {} : { description: assertion.description }),
          passed: decision.passed,
          expected: assertion.expected,
          observed: decision.observed,
          ...(assertion.scope === undefined ? {} : { scope: assertion.scope }),
          ...(decision.completeness === null ? {} : { completeness: decision.completeness }),
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
          ...(decision.attempts <= 1 ? {} : { attempts: decision.attempts, elapsedMs: decision.elapsedMs }),
          ...(decision.scopeResolution === undefined ? {} : { scopeResolution: decision.scopeResolution }),
        });
        if (decision.reason === QA_INCONCLUSIVE_SCOPE) provisionalCount += 1;
        if (assertion.scope === undefined) {
          finalObservation = decision.observation;
        } else if (i + 1 < scenario.assertions.length) {
          // Same discipline as the step loop: a scoped read consumes the
          // view the container was resolved from; refresh whole-page (when
          // another final assertion still needs it) and fail closed on an
          // unsettled refresh.
          const refresh = await session.observeSettled();
          if (settleWidened === null && refresh.widened !== null) {
            settleWidened = { ...refresh.widened, at: 'final' };
          }
          if (!refresh.stable) {
            failure = {
              stepIndex: null,
              message: unsettledMessage('post-scoped-assertion', refresh.budgetMs),
              code: QA_INCONCLUSIVE_UNSTABLE,
              reproduction: toReproduction(stepResults),
            };
            break;
          }
          finalObservation = refresh.observation;
        }
        if (!decision.passed) {
          if (decision.reason === QA_INCONCLUSIVE_SCOPE) {
            // QA-BL-062: a PROVISIONAL final assertion is not a definite
            // failure — the run aggregates to 'inconclusive'.
          } else {
            failure = {
              stepIndex: null,
              message: assertionFailureMessage('final assertion ' + (i + 1) + ' (' + assertion.kind + ')', decision),
              reproduction: toReproduction(stepResults),
            };
            break;
          }
        }
      }
    }

    try {
      evidence = await session.evidence();
    } catch (error) {
      // A failed evidence collection must be a visible, redacted marker — never
      // a silent null a reader mistakes for "no evidence was collected".
      evidence = { status: 'collection-failed', reason: errorMessage(error) };
    }

    // Advisory visual assertions: executed and recorded, never changing status.
    try {
      const outcome = await executeAdvisory(
        scenario,
        session,
        options.visual,
        options.visual?.capturesDir ?? join(tmpdir(), 'dsh-qa-visual-captures'),
      );
      artifacts.push(...outcome.artifacts);
      advisoryResults.push(...outcome.advisory);
    } catch {
      // Advisory execution must never fail the run.
    }
  } catch (error) {
    // An unexpected error mid-run (not a step failure) still fails the run.
    failure = {
      stepIndex: null,
      message: errorMessage(error),
      reproduction: toReproduction(stepResults),
    };
  } finally {
    await session.stop().catch(() => {});
  }

  const report: QaRunReport = {
    schemaVersion: 1,
    scenario: scenario.meta.name,
    driver: scenario.meta.driver,
    // QA-BL-062 three-state aggregation: PASS only when every required step
    // and final assertion is fully proven (failure === null AND nothing was
    // provisional); INCONCLUSIVE when at least one required result is
    // provisional (scopeResolution 'provisional' / INCONCLUSIVE_SCOPE) and
    // nothing definitely failed; FAIL otherwise.
    status: failure === null ? (provisionalCount > 0 ? 'inconclusive' : 'pass') : 'fail',
    startedAt,
    finishedAt: new Date().toISOString(),
    settle: session.settlePolicy,
    steps: stepResults,
    assertions: assertionResults,
    evidence,
    receiptSummary: summarizeReceipts(stepResults),
    ...(settleWidened === null ? {} : { settleWidened }),
    ...(artifacts.length === 0 ? {} : { artifacts }),
    ...(advisoryResults.length === 0 ? {} : { advisory: advisoryResults }),
  };
  if (failure !== null) {
    report.failure = failure;
  }
  return report;
}