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
  QaScopePathItem,
  QaScopeWalkLevel,
  QaSettleWidening,
  QaStepResult,
  QaTargetResolutionDisclosure,
  QaViewCompleteness,
} from '../contracts.ts';
import type { QaAction, QaActionReceipt, QaDriverAdapter, QaEvidence, QaObservation, QaObserveOptions, QaSettleWidened, QaSemanticNode, QaVisualCapture } from '../session/adapter.ts';
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

/**
 * QA-BL-070: the required exhaustion message for the bounded identity retry.
 * The target kept changing identity between resolution and dispatch for the
 * whole settle budget — the page mutated under the runner, so nothing about
 * the scenario's claim definitely failed: the step is unproven, and the
 * message says so. The once-only widening is named when it happened.
 */
function identityExhaustionMessage(retries: number, widened: QaSettleWidened | null): string {
  return 'the target kept changing identity between resolution and dispatch for the whole settle budget ('
    + String(retries) + ' retries): the page did not hold still, so the step is unproven'
    + (widened === null ? '' : ' — the settle budget was widened once from ' + String(widened.fromMs)
      + ' to ' + String(widened.toMs) + 'ms and still exhausted');
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
   * identity anchor). QA-BL-062/069: a container resolved with at least one
   * PROVISIONAL level is then resolved PROVISIONALLY overall — the step's
   * scopeResolution is 'provisional', its outcome is INCONCLUSIVE_SCOPE,
   * and it can NEVER earn a pass. The whole page can never complete when
   * the scroll target sits beyond the driver's clamped node budget, so the
   * strict QA-BL-054 uniqueness refusal would make such exported scenarios
   * unreplayable; the scoped assertion is still decided against the
   * container's own view, the replay-side decision is bound to the replayed
   * scroll by the driver's identity anchor, and PASS stays reserved for
   * proven resolution. Every other scoped assertion keeps the strict gate
   * (a recorded ancestor path excepted: see observeScopeView).
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

/** How the container of a scoped decision was resolved (QA-BL-062/069). */
type ScopeResolutionResult =
  | {
      kind: 'resolved';
      /** The container's settled scoped deciding view. */
      observation: QaObservation;
      /** Proven only when EVERY walk level was proven; provisional otherwise. */
      resolution: 'proven' | 'provisional';
      /** Whether a bounded budget escalation ran during resolution (whole-page at the top level, within-scope at deeper levels). */
      escalated: boolean;
      /** Per-level resolutions: outermost ancestor first, the container last. */
      levels: QaScopeWalkLevel[];
    }
  | {
      /**
       * QA-BL-069 (C): zero matches at some level in a STILL-truncated view.
       * Nothing definitely failed — the container may exist outside the
       * returned window — so the caller reports the step INCONCLUSIVE_TRUNCATED
       * (inconclusive), never an ordinary failure.
       */
      kind: 'not-located';
      /** The still-truncated view the failing level was matched in. */
      view: QaObservation;
      escalated: boolean;
      /** Levels resolved before the zero-match (the last entry is the failing one). */
      levels: QaScopeWalkLevel[];
    };

/** Prose naming each level's resolution, for completeness details and report.md. */
function levelSummary(levels: QaScopeWalkLevel[]): string {
  return levels
    .map((level) => 'level ' + String(level.level) + ' (' + level.what + '): ' + level.resolution)
    .join('; ');
}

/** The honest zero-in-a-still-truncated-view wording (QA-BL-069, C). */
function scopeNotLocatedMessage(levels: QaScopeWalkLevel[], escalated: boolean, view: QaObservation): string {
  const applied = escalated
    ? view.maxNodes === undefined
      ? 'the escalated budget (the driver did not report the budget it applied)'
      : 'the applied ' + String(view.maxNodes) + '-node escalated budget'
    : 'the driver-default budget';
  const failedLevel = levels[levels.length - 1];
  const atLevel = failedLevel === undefined ? '' : ' (level ' + String(failedLevel.level) + ': ' + failedLevel.what + ')';
  return 'the container could not be located in the truncated view; it may exist outside the returned window'
    + atLevel + ' — the view was still truncated at ' + applied + ' (' + QA_INCONCLUSIVE_TRUNCATED + ')';
}

/**
 * The semantic ancestor path of `node` inside `view`: every emitted
 * ancestor on its parentRef chain, outermost first, carrying role + name +
 * tag so a recorded path item (which may omit the name, QA-BL-069) can be
 * compared against it. Null when the node has no emitted ancestor in this
 * view or a hop does not resolve inside the same observation (fail closed:
 * a partial chain matches nothing).
 */
function ancestorPathIn(view: QaObservation, node: QaSemanticNode): { role: string; name: string; tag: string }[] | null {
  const byRef = new Map(view.nodes.map((candidate) => [candidate.ref, candidate]));
  const chain: { role: string; name: string; tag: string }[] = [];
  let current = node;
  for (let hops = 0; hops <= view.nodes.length; hops += 1) {
    const parentRef = typeof current.parentRef === 'string' && current.parentRef !== '' ? current.parentRef : null;
    if (parentRef === null) {
      return chain.length === 0 ? null : chain.reverse();
    }
    const parent = byRef.get(parentRef);
    if (parent === undefined) return null;
    chain.push({ role: parent.role, name: parent.name, tag: parent.tag });
    current = parent;
  }
  return null;
}

/**
 * Path comparison for container resolution: when the recorded scope carries
 * an ancestor path, a candidate matches only when its own parentRef chain
 * yields the same sequence — relationships compared, never refs. QA-BL-069:
 * the role always matches, while name and tag are compared ONLY when the
 * recorded item carries them (a content-named ancestor's aggregated name is
 * order-fragile and is deliberately not recorded). No recorded path means
 * predicate-only matching.
 */
function sameScopePath(
  recorded: QaScopePathItem[] | undefined,
  candidate: { role: string; name: string; tag: string }[] | null,
): boolean {
  if (recorded === undefined) return true;
  if (candidate === null) return false;
  return recorded.length === candidate.length
    && recorded.every((item, index) => {
      const actual = candidate[index];
      if (actual === undefined) return false;
      if (item.role !== actual.role) return false;
      if (item.name !== undefined && item.name !== actual.name) return false;
      if (item.tag !== undefined && item.tag !== actual.tag) return false;
      return true;
    });
}

/** The matching predicate of ONE recorded path item: role, plus name/tag only when recorded. */
function pathItemPredicate(item: QaScopePathItem): QaNodePredicate {
  return {
    role: item.role,
    ...(item.name === undefined ? {} : { name: item.name }),
    ...(item.tag === undefined ? {} : { tag: item.tag }),
  };
}

/** Human-readable spelling of one recorded path item, for level-naming messages. */
function describePathItem(item: QaScopePathItem): string {
  const parts = ['role "' + item.role + '"'];
  if (item.name !== undefined) parts.push('name "' + item.name + '"');
  if (item.tag !== undefined) parts.push('tag "' + item.tag + '"');
  return parts.join(', ');
}

/**
 * Internal marker for the QA-BL-069 (C) classification: a container the
 * runner could not locate in a still-truncated view — an inconclusive
 * non-result, never an ordinary failure, never a dispatched action.
 */
class ScopeNotLocatedError extends Error {
  readonly scopeNotLocated: true = true;
  readonly levels: QaScopeWalkLevel[];
  readonly escalated: boolean;
  readonly view: QaObservation;

  constructor(levels: QaScopeWalkLevel[], escalated: boolean, view: QaObservation) {
    super(scopeNotLocatedMessage(levels, escalated, view));
    this.name = 'ScopeNotLocatedError';
    this.levels = levels;
    this.escalated = escalated;
    this.view = view;
  }
}

/**
 * Observe WITHIN the container an assertion is scoped to (browser driver
 * contract v8). A driver refusal on any scoped read (REF_INVALID /
 * REF_EXPIRED / TARGET_CHANGED / ...) propagates as itself, never degraded
 * into a "not found"; every scoped read is SETTLED like every other
 * verification observation.
 *
 * QA-BL-069 path walk: when the scope carries a recorded ancestor PATH, the
 * container is resolved TOP-DOWN instead of by one flat whole-page match —
 * the outermost ancestor is matched in the whole-page view (with today's ONE
 * bounded budget escalation), observed within (settled), the next path item
 * is matched inside that scoped view, and so on, until the container itself
 * is matched inside its last ancestor's view; the container's own settled
 * scoped view then becomes the deciding view, exactly as before. Uniqueness
 * is judged at EACH level inside its PARENT's view: exactly one match in a
 * COMPLETE view → proven at that level; one match in a still-truncated view
 * → provisional; two or more → TARGET_NOT_UNIQUE (a known twin is never
 * guessed); zero matches in a still-truncated view → the whole resolution is
 * kind 'not-located' (QA-BL-069, C: the caller reports INCONCLUSIVE_TRUNCATED,
 * never a failure); zero matches in a complete view → a definite failure
 * (the ancestor/container is not on the page). The overall resolution is
 * 'proven' only when EVERY level was proven — on a >100-node page the
 * whole-page top level never completes, so the result is provisional, exactly
 * as Codex consult #2 decision (b) requires.
 *
 * Without a recorded path the flat resolution stays (QA-BL-054 / QA-BL-062):
 * the container is matched by UNIQUE predicate in the whole-page view, with
 * the ONE budget escalation, zero-in-truncated now classifies as
 * 'not-located' (C), and exactly one match in a still-truncated view
 * resolves PROVISIONALLY for the scoped scroll-proof step
 * (options.provisionalScope) — the caller must then report INCONCLUSIVE_SCOPE,
 * never a pass — and refuses with INCONCLUSIVE_TRUNCATED naming the scope for
 * every other scope.
 */
async function observeScopeView(
  scope: QaScenarioAssertionScope,
  wholePage: QaObservation,
  session: QaSession,
  reobserve: QaReobserve,
  options: ScopeResolutionOptions = {},
): Promise<ScopeResolutionResult> {
  const path = scope.path;
  const levels: QaScopeWalkLevel[] = [];
  let escalated = false;
  let view: QaObservation = wholePage;

  // Match ONE discriminator inside `view`. Only the TOP level (the outermost
  // ancestor in the whole-page view) keeps today's ONE bounded budget
  // escalation; deeper levels are judged inside their parent's settled scoped
  // view exactly as it was returned.
  const resolveLevel = async (
    predicate: QaNodePredicate,
    level: number,
    what: string,
    escalate: boolean,
    /** True for the FLAT (no-path) container level: keep its QA-BL-054 wording. */
    flat = false,
  ): Promise<{ node: QaSemanticNode } | { zero: true; truncated: boolean }> => {
    let matches = view.nodes.filter((node) => matchesNode(node, predicate));
    if (escalate && view.truncated && matches.length <= 1) {
      try {
        view = await reobserve({ maxNodes: QA_ESCALATED_NODE_BUDGET });
        escalated = true;
        matches = view.nodes.filter((node) => matchesNode(node, predicate));
      } catch {
        // No fuller view: fall through and report honestly against the truncated one.
      }
    }
    if (matches.length === 0) {
      levels.push({ level, what, resolution: 'not-located' });
      return { zero: true, truncated: view.truncated };
    }
    if (matches.length > 1) {
      throw new QaCodeError(
        QA_TARGET_NOT_UNIQUE,
        flat
          ? QA_TARGET_NOT_UNIQUE + ': ' + String(matches.length) + ' nodes match the assertion scope ('
            + describeScope(scope) + '); the scoped container is not uniquely identifiable, so the assertion was not decided'
          : QA_TARGET_NOT_UNIQUE + ': ' + String(matches.length) + ' nodes match path level ' + String(level)
            + ' (' + what + '), so the recorded ancestor path is ambiguous and the scoped container was not decided',
      );
    }
    levels.push({ level, what, resolution: view.truncated ? 'provisional' : 'proven' });
    const only = matches[0];
    if (only === undefined) {
      throw new Error('no observable node matches the assertion scope');
    }
    return { node: only };
  };

  const notLocated = (): ScopeResolutionResult => ({ kind: 'not-located', view, escalated, levels });

  // One bounded budget escalation WITHIN a settled scoped parent view whose
  // subtree exceeds the default window (the same within-scope rule
  // decideAssertion and resolveStepAction already use): the parent's root is
  // re-chained through the driver's fresh scope.rootRef, never widened to the
  // whole page. Without this, a deep container inside a >60-node ancestor
  // subtree could never earn a proven level even on a <100-node page.
  const widenParent = async (): Promise<void> => {
    if (!view.truncated) return;
    const rootRef = scopeRootRef(view);
    if (rootRef === undefined) return; // no fresh rootRef: keep the truncated view, fail closed
    try {
      view = await reobserve({ maxNodes: QA_ESCALATED_NODE_BUDGET, withinRef: rootRef });
      escalated = true;
    } catch {
      // No wider view: keep the truncated one, report honestly against it.
    }
  };

  if (path !== undefined && path.length > 0) {
    // QA-BL-069: walk the recorded ancestor path top-down, scoping into each
    // matched ancestor (settled, one bounded within-scope escalation when
    // the parent subtree exceeds the default window) before matching the
    // next item inside it.
    for (let index = 0; index < path.length; index += 1) {
      const item = path[index];
      if (item === undefined) continue;
      const resolved = await resolveLevel(
        pathItemPredicate(item), index + 1, describePathItem(item), index === 0,
      );
      if ('zero' in resolved) {
        if (resolved.truncated) return notLocated();
        throw new Error(
          'no observable node matches path level ' + String(index + 1) + ' (' + describePathItem(item)
          + ') in a complete view: the ancestor is not on the page, so the scoped container ('
          + describeScope(scope) + ') cannot be there',
        );
      }
      const settled = await session.observeSettled({ withinRef: resolved.node.ref });
      if (!settled.stable) {
        throw new Error(unsettledMessage('scoped', settled.budgetMs));
      }
      view = settled.observation;
      if (view.truncated && view.nodes.filter((node) => matchesNode(node, pathItemPredicate(path[index + 1] ?? item))).length <= 1) {
        await widenParent();
      }
    }
    // The container level inside the last ancestor's view keeps the same
    // one bounded within-scope escalation.
    if (view.truncated && view.nodes.filter((node) => matchesNode(node, scopePredicate(scope))).length <= 1) {
      await widenParent();
    }
    const container = await resolveLevel(
      scopePredicate(scope), path.length + 1, describeScope(scope), false,
    );
    if ('zero' in container) {
      if (container.truncated) return notLocated();
      throw new Error(
        'no observable node matches the assertion scope (' + describeScope(scope)
        + ', ancestor path ' + JSON.stringify(path) + ') inside a complete view of its last ancestor: the container is not on the page',
      );
    }
    const settled = await session.observeSettled({
      withinRef: container.node.ref,
      ...(options.scopedObserve === undefined ? {} : options.scopedObserve),
    });
    if (!settled.stable) {
      throw new Error(unsettledMessage('scoped', settled.budgetMs));
    }
    return {
      kind: 'resolved',
      observation: settled.observation,
      resolution: levels.every((level) => level.resolution === 'proven') ? 'proven' : 'provisional',
      escalated,
      levels,
    };
  }

  // No recorded path: today's flat resolution stays (QA-BL-054/062), with the
  // QA-BL-069 (C) classification change: zero matches in a still-truncated
  // view is NOT a definite failure — the container may exist outside the
  // returned window.
  const container = await resolveLevel(scopePredicate(scope), 1, describeScope(scope), true, true);
  if ('zero' in container) {
    if (container.truncated) return notLocated();
    throw new Error(
      'no observable node matches the assertion scope (' + describeScope(scope) + ')',
    );
  }
  if (view.truncated && options.provisionalScope !== true) {
    // QA-BL-054: exactly ONE match in a STILL-truncated view is not proven
    // uniqueness — a twin container may sit outside the returned window.
    // Refuse, naming the scope and the code. (A scroll-proof step resolves
    // provisionally instead — see ScopeResolutionOptions / QA-BL-062.)
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
  const settled = await session.observeSettled({
    withinRef: container.node.ref,
    ...(options.scopedObserve === undefined ? {} : options.scopedObserve),
  });
  if (!settled.stable) {
    throw new Error(unsettledMessage('scoped', settled.budgetMs));
  }
  return {
    kind: 'resolved',
    observation: settled.observation,
    resolution: view.truncated ? 'provisional' : 'proven',
    escalated,
    levels,
  };
}

/**
 * Completeness block for a decision the scope resolution made PROVISIONAL
 * (QA-BL-062/069): the deciding view itself is reported honestly, and the
 * detail names EACH level's resolution (report.md prints it) — the overall
 * resolution is provisional, so uniqueness is unproven and the outcome is
 * INCONCLUSIVE_SCOPE, never a pass.
 */
function provisionalScopeCompleteness(
  assertion: QaScenario['assertions'][number] | QaScenario['steps'][number]['assert'],
  scoped: Extract<ScopeResolutionResult, { kind: 'resolved' }>,
): QaViewCompleteness {
  const view = scoped.observation;
  return {
    truncated: view.truncated,
    nodeBudget: view.maxNodes ?? null,
    escalated: scoped.escalated,
    outcomeDependsOnCompleteView: false,
    ...(view.scope === undefined ? {} : { scope: { role: view.scope.role, name: view.scope.name } }),
    ...(view.truncationReasons === undefined ? {} : { truncationReasons: view.truncationReasons }),
    detail: 'the scoped container was resolved PROVISIONALLY (' + levelSummary(scoped.levels)
      + '), so the container\'s uniqueness is unproven and the '
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
  if (scoped.kind === 'not-located') {
    // QA-BL-069 (C): the container could not be located in a still-truncated
    // view — nothing definitely failed, so the result is INCONCLUSIVE_TRUNCATED
    // (inconclusive), never an ordinary failure. report.md names each level's
    // resolution, including the failing one.
    return {
      passed: false,
      observed: null,
      observation: scoped.view,
      completeness: {
        truncated: true,
        nodeBudget: scoped.view.maxNodes ?? null,
        escalated: scoped.escalated,
        outcomeDependsOnCompleteView: false,
        reason: QA_INCONCLUSIVE_TRUNCATED,
        detail: scopeNotLocatedMessage(scoped.levels, scoped.escalated, scoped.view)
          + '. The recorded path is a discriminator, never a proof. Levels: ' + levelSummary(scoped.levels) + '.',
      },
      reason: QA_INCONCLUSIVE_TRUNCATED,
      scopeNotLocated: true,
      scopeLevels: scoped.levels,
      attempts: 1,
      elapsedMs: 0,
      widened: null,
    };
  }
  if (scoped.resolution === 'provisional') {
    // QA-BL-062/069: a provisionally resolved container can never earn a pass.
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
      scopeLevels: scoped.levels,
      attempts: 1,
      elapsedMs: 0,
      widened: null,
    };
  }
  const decision = await decideAssertionWithRetry(assertion, scoped.observation, reobserve, session);
  return { ...decision, scopeResolution: 'proven', scopeLevels: scoped.levels };
}

/**
 * QA-BL-064 role-drift fallback for ACTION targets. On a real page a
 * server-rendered control can be replaced by a hydrated component that renders
 * the same accessible name under a DIFFERENT role (Wikipedia's search input:
 * textbox -> combobox once Vector's Vue typeahead mounts over it). A recorded
 * role+name predicate then matches NOTHING on a fast replay even though the
 * same control is present — the node is present under a drifted role, not
 * outside the observation window. When the strict predicate has ZERO matches
 * in the deciding view (after the existing one escalated read when that view
 * is truncated), fall back to a NAME-only match iff exactly ONE node in that
 * view carries the same non-empty name. The fallback is a refusal, never a
 * guess, when the name is empty or matches two or more nodes.
 */
type ActionTargetMatch =
  | {
      kind: 'matched';
      /** The predicate to resolve the ref with (name-only when the fallback fired). */
      predicate: QaNodePredicate;
      /** The node the predicate matched (the fallback's single name match). */
      node: QaSemanticNode;
      disclosure: QaTargetResolutionDisclosure | null;
    }
  | {
      kind: 'absent';
      /** Nodes carrying the target's name (>= 2 proves the ambiguity refusal). */
      nameMatches: QaSemanticNode[];
    };

function matchActionTarget(target: QaNodePredicate, view: QaObservation): ActionTargetMatch {
  const strict = view.nodes.filter((node) => matchesNode(node, target));
  if (strict.length > 0) {
    const first = strict[0];
    if (first === undefined) return { kind: 'absent', nameMatches: [] };
    return { kind: 'matched', predicate: target, node: first, disclosure: null };
  }
  const name = target.name;
  if (name === undefined || name === '') return { kind: 'absent', nameMatches: [] };
  const nameMatches = view.nodes.filter((node) => node.name === name);
  if (nameMatches.length === 1) {
    const drifted = nameMatches[0];
    if (drifted === undefined) return { kind: 'absent', nameMatches: [] };
    return {
      kind: 'matched',
      predicate: { name },
      node: drifted,
      disclosure: {
        mode: 'name-only',
        recordedRole: target.role ?? '',
        observedRole: drifted.role,
      },
    };
  }
  return { kind: 'absent', nameMatches };
}

/**
 * QA-BL-064: the three honest zero-match failure wordings for an action
 * target, so a human triaging the failure can tell role drift from window
 * truncation from a proven absence:
 * (a) the target IS present, but under a different (and ambiguous) role —
 *     the name-only fallback was refused because >= 2 nodes share the name
 *     (TARGET_NOT_UNIQUE, never a guess);
 * (b) the target is absent from the RETURNED WINDOW — the deciding view was
 *     still truncated, so the target may exist outside it
 *     (INCONCLUSIVE_TRUNCATED);
 * (c) the target is absent from a COMPLETE view — the absence is proven.
 */
function absentActionTargetError(
  target: QaNodePredicate,
  nameMatches: QaSemanticNode[],
  truncated: boolean,
  budgetText: string,
  container: boolean,
): Error {
  if (nameMatches.length >= 2) {
    const recordedRole = target.role ?? '(no role recorded)';
    const observedRoles = [...new Set(nameMatches.map((node) => node.role))]
      .map((role) => '"' + role + '"')
      .join(', ');
    return new QaCodeError(
      QA_TARGET_NOT_UNIQUE,
      QA_TARGET_NOT_UNIQUE + ': the action target (' + describeTarget(target)
        + ') is present under a different role: recorded "' + recordedRole + '", observed '
        + observedRoles + ' — ' + String(nameMatches.length)
        + ' nodes carry the accessible name, so the name-only fallback was refused rather than guessed'
        + (container ? ' inside the scoped container' : ''),
    );
  }
  if (truncated) {
    return new Error(
      'no observable node matches the action target'
      + (container ? ' inside the scoped container' : '')
      + ': the target is absent from the returned window'
      + (container ? ' of that container' : '')
      + ' — the view was still truncated at ' + budgetText + ' (' + QA_INCONCLUSIVE_TRUNCATED
      + '), so the target may exist outside the returned '
      + (container ? 'subtree ' : '') + 'window rather than be missing from the page',
    );
  }
  return new Error(
    'no observable node matches the action target'
    + (container ? ' inside the scoped container' : '')
    + ': the target is absent from a complete view'
    + (container ? ' of that container' : ''),
  );
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
): Promise<{ resolved: QaAction; observation: QaObservation; targetResolution: QaTargetResolutionDisclosure | null }> {
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
  if (target === null || !missing(view)) {
    return { resolved: resolveAction(action, view), observation: view, targetResolution: null };
  }
  // QA-BL-064: zero strict matches in the DECIDING view (the escalated one
  // when an escalation ran). The target may be present under a drifted role.
  const match = matchActionTarget(target, view);
  if (match.kind === 'matched') {
    const override = match.disclosure === null ? undefined : match.predicate;
    return {
      resolved: resolveAction(action, view, override),
      observation: view,
      targetResolution: match.disclosure,
    };
  }
  // Same honesty rule as the completeness block: name the budget the
  // driver APPLIED (its own clamp), never the requested constant.
  const applied = escalated
    ? view.maxNodes === undefined
      ? 'the escalated budget (the driver did not report the budget it applied)'
      : 'the applied ' + String(view.maxNodes) + '-node escalated budget'
    : 'the driver-default budget';
  throw absentActionTargetError(target, match.nameMatches, view.truncated, applied, false);
}

function resolveAction(
  action: QaScenarioAction,
  observation: QaObservation,
  targetOverride?: QaNodePredicate,
): QaAction {
  // QA-BL-064: the override is the name-only fallback predicate; the original
  // role+name predicate stays untouched (and echoed on the step result).
  const target = (recorded: QaNodePredicate): string => resolveRef(targetOverride ?? recorded, observation);
  if (action.kind === 'navigate') return { kind: 'navigate', url: action.url };
  if (action.kind === 'click') return { kind: 'click', ref: target(action.target) };
  if (action.kind === 'fill') {
    return { kind: 'fill', ref: target(action.target), text: action.text };
  }
  if (action.kind === 'press') {
    return { kind: 'press', ref: target(action.target), key: action.key };
  }
  if (action.kind === 'scroll') {
    if ('target' in action) return { kind: 'scroll', ref: target(action.target) };
    return {
      kind: 'scroll',
      direction: action.direction,
      ...(action.amount === undefined ? {} : { amount: action.amount }),
    };
  }
  if (action.kind === 'select') {
    return { kind: 'select', ref: target(action.target), option: action.option };
  }
  return { kind: 'hover', ref: target(action.target) };
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
): Promise<{ resolved: QaAction; observation: QaObservation; targetResolution: QaTargetResolutionDisclosure | null }> {
  if (assert.scope === undefined) {
    return resolveActionWithBudget(action, wholePage, reobserve);
  }
  const scoped = await observeScopeView(assert.scope, wholePage, session, reobserve, options);
  if (scoped.kind === 'not-located') {
    // QA-BL-069 (C): the container could not be located in a still-truncated
    // view, so the action cannot be dispatched — but nothing definitely
    // failed: the step is reported INCONCLUSIVE_TRUNCATED (inconclusive),
    // never an ordinary failure.
    throw new ScopeNotLocatedError(scoped.levels, scoped.escalated, scoped.view);
  }
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
    // QA-BL-064: zero strict matches in the deciding (in-scope) view — the
    // same name-only fallback as the whole-page path, inside the container.
    const match = matchActionTarget(target, view);
    if (match.kind === 'matched') {
      const override = match.disclosure === null ? undefined : match.predicate;
      return {
        resolved: resolveAction(action, view, override),
        observation: wholePage,
        targetResolution: match.disclosure,
      };
    }
    throw absentActionTargetError(target, match.nameMatches, view.truncated, 'the applied budget', true);
  }
  return { resolved: resolveAction(action, view), observation: wholePage, targetResolution: null };
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
  | { kind: 'pass'; observed: unknown; completeness: QaViewCompleteness; targetResolution: QaTargetResolutionDisclosure | null }
  | {
      kind: 'inconclusive';
      observed: unknown;
      completeness: QaViewCompleteness;
      targetResolution: QaTargetResolutionDisclosure | null;
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
  scoped: Extract<ScopeResolutionResult, { kind: 'resolved' }>,
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
  let targetNode: QaSemanticNode;
  let targetResolution: QaTargetResolutionDisclosure | null = null;
  if (matches.length === 0) {
    // QA-BL-064: zero strict matches in the verifying scoped view — the same
    // name-only fallback as the whole-page action target, bound to the same
    // identity anchor (the anchor verifies the element replay SELECTED, so a
    // unique name match here is never a guess).
    const fallback = matchActionTarget(target, view);
    if (fallback.kind === 'absent') {
      throw absentActionTargetError(target, fallback.nameMatches, view.truncated, 'the applied budget', true);
    }
    targetNode = fallback.node;
    targetResolution = fallback.disclosure;
  } else if (matches.length > 1) {
    // Counted BEFORE the inViewport filter: a KNOWN twin refuses, never a guess.
    return {
      kind: 'failure',
      error: new QaCodeError(
        QA_TARGET_NOT_UNIQUE,
        QA_TARGET_NOT_UNIQUE + ': ' + String(matches.length) + ' nodes match the scroll target ('
        + describeTarget(target) + ') inside the scoped container, so the replayed target is not uniquely identifiable',
      ),
    };
  } else {
    const only = matches[0];
    if (only === undefined) {
      return {
        kind: 'failure',
        error: new Error('no observable node matches the action target inside the scoped container'),
      };
    }
    targetNode = only;
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
      targetResolution,
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
        detail: 'the container was resolved PROVEN (' + levelSummary(scoped.levels)
          + '), the scoped subtree is complete '
          + 'with verified coverage, and the identity anchor confirmed the asserted target is the anchored node in the viewport.',
      },
      targetResolution,
    };
  }
  const why = scoped.resolution === 'provisional'
    ? 'the scoped container was resolved PROVISIONALLY (' + levelSummary(scoped.levels) + ')'
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
    targetResolution,
  };
}

interface StepBase {
  index: number;
  intent: string;
  action: QaScenarioAction;
  /** ADDITIVE (QA-BL-067): the scenario step's recorded record-time proof refusal. */
  escalationRefused?: { code?: string; reason: string };
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
    /** QA-BL-069: the scoped container could not be located in a still-truncated view. */
    scopeNotLocated?: boolean;
    /** QA-BL-069: per-level resolution of the scoped path walk. */
    scopeLevels?: QaScopeWalkLevel[];
  } = {},
  targetResolution: QaTargetResolutionDisclosure | null = null,
  targetChangedRetries = 0,
  message?: string,
): QaStepResult {
  return {
    index: base.index,
    intent: base.intent,
    // QA-BL-067: the scenario step's recorded record-time proof refusal rides
    // onto the step result so report.md's step lines surface it.
    ...(base.escalationRefused === undefined ? {} : { escalationRefused: base.escalationRefused }),
    // QA-BL-062/069/070 three-state: INCONCLUSIVE_SCOPE is a provisional
    // non-result, a container not located in a still-truncated view is an
    // inconclusive non-result (INCONCLUSIVE_TRUNCATED), and a target that
    // kept changing identity for the whole settle budget is an inconclusive
    // non-result (INCONCLUSIVE_UNSTABLE) — never green, and never an
    // ordinary failure.
    status: assertionPassed
      ? 'pass'
      : reason === QA_INCONCLUSIVE_SCOPE || reason === QA_INCONCLUSIVE_UNSTABLE
        || scope.scopeNotLocated === true ? 'inconclusive' : 'fail',
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
    ...(scope.scopeNotLocated === true ? { scopeNotLocated: true as const } : {}),
    ...(scope.scopeLevels === undefined ? {} : { scopeLevels: scope.scopeLevels }),
    // QA-BL-064: disclosed only when the name-only fallback resolved the action target.
    ...(targetResolution === null ? {} : { targetResolution }),
    // QA-BL-070: the bounded identity-staleness retry count (replaces the
    // QA-BL-064 boolean) and its exhaustion message.
    ...(targetChangedRetries > 0 ? { targetChangedRetries } : {}),
    ...(message === undefined ? {} : { message }),
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
  // QA-BL-062/069/070: the count of UNPROVEN required results
  // (scopeResolution 'provisional' / INCONCLUSIVE_SCOPE, a scoped container
  // not located in a still-truncated view / INCONCLUSIVE_TRUNCATED, or an
  // identity-staleness retry that exhausted its settle budget /
  // INCONCLUSIVE_UNSTABLE). Any unproven result keeps the run off 'pass' —
  // and when nothing definitely failed, the run aggregates to 'inconclusive'.
  let unprovenCount = 0;
  // QA-BL-070: a step whose target kept changing identity for the whole
  // settle budget proves nothing, so the run must NEVER re-decide its final
  // assertions (a spurious definite failure there would contradict the
  // inconclusive classification).
  let identityExhaustedStep = false;

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
      const base: StepBase = {
        index: step.index,
        intent: step.intent,
        action: step.action,
        ...(step.escalationRefused === undefined ? {} : { escalationRefused: step.escalationRefused }),
      };
      const scopedScrollProof = scopedScrollProofStep(step);
      if (scopedScrollProof) lastScrollProofStep = step;

      let resolved: QaAction;
      // QA-BL-064: disclosed on the step when the name-only fallback resolved
      // a drifted action target (see resolveStepAction).
      let targetResolution: QaTargetResolutionDisclosure | null = null;
      // QA-BL-070: the bounded identity-staleness retry accounting (replaces
      // the QA-BL-064 one-shot boolean): the TARGET_CHANGED refusal count,
      // the last verbatim refusal receipt, the once-only widening the retry
      // performed through the shared gate, the exhaustion message, and
      // whether the step was classified unproven.
      let targetChangedRetries = 0;
      let targetChangedLastReceipt: QaActionReceipt | null = null;
      let identityWidened: QaSettleWidened | null = null;
      let identityExhausted: string | null = null;
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
        targetResolution = resolution.targetResolution;
      } catch (error) {
        if (error instanceof ScopeNotLocatedError) {
          // QA-BL-069 (C): the scoped container could not be located in a
          // still-truncated view, so the action was NOT dispatched — but
          // nothing definitely failed: the step is INCONCLUSIVE_TRUNCATED
          // (inconclusive), never an ordinary failure.
          stepResults.push(buildStepResult(
            base, step.assert, null, 'unknown', false, null,
            {
              truncated: true,
              nodeBudget: error.view.maxNodes ?? null,
              escalated: error.escalated,
              outcomeDependsOnCompleteView: false,
              reason: QA_INCONCLUSIVE_TRUNCATED,
              detail: error.message + '. Levels: ' + levelSummary(error.levels) + '.',
            },
            QA_INCONCLUSIVE_TRUNCATED, 1, 0,
            { scopeNotLocated: true, scopeLevels: error.levels },
            null, 0,
          ));
          unprovenCount += 1;
          break;
        }
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
        // QA-BL-064/070: the hydration swap can also land BETWEEN target
        // resolution and dispatch — the driver then refuses the action with
        // TARGET_CHANGED (identity staleness: the page replaced the bound
        // element mid-flight, and NOTHING was dispatched). Nothing about the
        // scenario's claim definitely failed: the page mutated under the
        // runner. Retry the resolve->dispatch pair WITHIN the session settle
        // budget — a fresh settled observation, a re-resolution of the SAME
        // semantic target, and a re-dispatch — re-reading the budget every
        // iteration and widening it ONCE through the shared session gate when
        // the retry exhausts it (the QA-BL-039/041 machinery assertions use,
        // cause 'assertion-retry'). Only the identity-staleness code
        // TARGET_CHANGED is ever retried — every other rejection (a
        // safety/policy refusal) stays a hard stop. When the budget is
        // exhausted with the target still changing identity, the step is
        // INCONCLUSIVE_UNSTABLE (inconclusive, never a failure): the page did
        // not hold still, so the step is unproven.
        const identityStartedAt = Date.now();
        result = await session.act(resolved);
        while (result.outcome === 'failed' && result.receipt.code === 'TARGET_CHANGED') {
          targetChangedRetries += 1;
          targetChangedLastReceipt = result.receipt;
          if (Date.now() - identityStartedAt >= session.settlePolicy.budgetMs) {
            // Exhausted the budget without a landed dispatch. Widen ONCE
            // through the same session gate as the unstable/assertion paths
            // (a session widens at most once, whichever path gets there
            // first) and keep retrying; otherwise classify the step
            // unproven.
            if (identityWidened === null) {
              const widened = session.widenForRetry();
              if (widened !== null) {
                identityWidened = widened;
                if (settleWidened === null) settleWidened = { ...widened, at: step.index };
              } else {
                identityExhausted = identityExhaustionMessage(targetChangedRetries, identityWidened);
                break;
              }
            } else {
              identityExhausted = identityExhaustionMessage(targetChangedRetries, identityWidened);
              break;
            }
          }
          const refresh = await session.observeSettled();
          if (settleWidened === null && refresh.widened !== null) {
            settleWidened = { ...refresh.widened, at: step.index };
          }
          if (!refresh.stable) {
            // The refresh never settled: the page did not hold still, so the
            // step is unproven exactly like the budget-exhaustion exit.
            identityExhausted =
              'the post-TARGET_CHANGED refresh observation never settled within the '
              + String(refresh.budgetMs) + 'ms settle budget (after ' + String(targetChangedRetries)
              + ' retries): the page did not hold still, so the step is unproven';
            break;
          }
          const retryResolution = await resolveStepAction(
            step.action,
            step.assert,
            refresh.observation,
            session,
            reobserve,
            { provisionalScope: scopedScrollProof },
          );
          resolved = retryResolution.resolved;
          if (retryResolution.targetResolution !== null) {
            targetResolution = retryResolution.targetResolution;
          }
          result = await session.act(resolved);
        }
      } catch (error) {
        if (error instanceof ScopeNotLocatedError) {
          // QA-BL-069 (C), same classification as the first resolution: the
          // container could not be located in a still-truncated view, so the
          // action was NOT dispatched — inconclusive, never a failure.
          stepResults.push(buildStepResult(
            base, step.assert, null, 'unknown', false, null,
            {
              truncated: true,
              nodeBudget: error.view.maxNodes ?? null,
              escalated: error.escalated,
              outcomeDependsOnCompleteView: false,
              reason: QA_INCONCLUSIVE_TRUNCATED,
              detail: error.message + '. Levels: ' + levelSummary(error.levels) + '.',
            },
            QA_INCONCLUSIVE_TRUNCATED, 1, 0,
            { scopeNotLocated: true, scopeLevels: error.levels },
            null, targetChangedRetries,
          ));
          unprovenCount += 1;
          break;
        }
        stepResults.push(buildStepResult(base, step.assert, null, 'failed', false, null));
        failure = {
          stepIndex: step.index,
          message: errorMessage(error),
          reproduction: toReproduction(stepResults),
        };
        break;
      }

      // QA-BL-070 classification: the bounded identity retry exhausted its
      // budget (or its refresh never settled) with the target still changing
      // identity — the step is INCONCLUSIVE_UNSTABLE (inconclusive), NEVER an
      // ordinary failure, and the driver's last refusal rides verbatim so
      // triage sees WHAT changed. The run aggregates to 'inconclusive' and
      // never re-decides the final assertions.
      if (identityExhausted !== null) {
        stepResults.push(buildStepResult(
          base, step.assert, targetChangedLastReceipt, 'failed', false, null,
          null, QA_INCONCLUSIVE_UNSTABLE, undefined, undefined, {}, null, targetChangedRetries,
          identityExhausted,
        ));
        unprovenCount += 1;
        identityExhaustedStep = true;
        break;
      }
      if (settleWidened === null && result.settle !== null && result.settle.widened !== null) {
        settleWidened = { ...result.settle.widened, at: step.index };
      }

      if (result.outcome === 'failed' || result.observation === null) {
        stepResults.push(
          buildStepResult(
            base, step.assert, result.receipt, result.outcome, false, null,
            null, undefined, undefined, undefined, {}, null, targetChangedRetries,
          ),
        );
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
          if (verifying.kind === 'not-located') {
            // QA-BL-069 (C): the container could not be located in a
            // still-truncated view — nothing definitely failed; the step is
            // INCONCLUSIVE_TRUNCATED, never a failure.
            decision = {
              passed: false,
              observed: null,
              observation: verifying.view,
              completeness: {
                truncated: true,
                nodeBudget: verifying.view.maxNodes ?? null,
                escalated: verifying.escalated,
                outcomeDependsOnCompleteView: false,
                reason: QA_INCONCLUSIVE_TRUNCATED,
                detail: scopeNotLocatedMessage(verifying.levels, verifying.escalated, verifying.view)
                  + '. The recorded path is a discriminator, never a proof. Levels: '
                  + levelSummary(verifying.levels) + '.',
              },
              reason: QA_INCONCLUSIVE_TRUNCATED,
              scopeNotLocated: true,
              scopeLevels: verifying.levels,
              attempts: 1,
              elapsedMs: 0,
              widened: null,
            };
          } else {
            const outcome = decideScopedScrollProof(step.assert, target, verifying);
            if (outcome.kind === 'failure') throw outcome.error;
            if (outcome.targetResolution !== null) targetResolution = outcome.targetResolution;
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
              scopeLevels: verifying.levels,
              attempts: 1,
              elapsedMs: 0,
              widened: null,
            };
          }
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
            ...(decision.scopeNotLocated === true ? { scopeNotLocated: true } : {}),
            ...(decision.scopeLevels === undefined ? {} : { scopeLevels: decision.scopeLevels }),
          },
          targetResolution,
          targetChangedRetries,
        ),
      );
      if (scopedScrollProof) lastScrollProofDecision = decision;
      // Any INCONCLUSIVE_SCOPE result is provisional evidence — a provisionally
      // resolved container OR an anchor refusal — and an INCONCLUSIVE_TRUNCATED
      // result from a container the truncated view could not locate is equally
      // unproven: both keep the run off 'pass' without failing it.
      if (decision.reason === QA_INCONCLUSIVE_SCOPE || decision.scopeNotLocated === true) unprovenCount += 1;
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
        if (decision.reason === QA_INCONCLUSIVE_SCOPE || decision.scopeNotLocated === true) {
          // QA-BL-062/069: a PROVISIONAL result, or a container the
          // still-truncated view could not locate, is not a definite failure
          // — the loop continues and the run aggregates to 'inconclusive'.
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

    if (failure === null && !identityExhaustedStep) {
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
          // QA-BL-064: the copy is matched against the step's ASSERTION
          // expectation, never against the action target — the exported action
          // target is now the NAME-only predicate (+ roleHint) while the
          // scoped node-in-viewport expectation keeps the recorded role+name.
          const isCopy = assertion.kind === 'node-in-viewport'
            && assertion.scope !== undefined
            && sameJsonShape(assertion.scope, scrollProofStep.assert.scope)
            && sameJsonShape(assertion.expected, scrollProofStep.assert.expected);
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
              ...(stepDecision.scopeLevels === undefined ? {} : { scopeLevels: stepDecision.scopeLevels }),
              ...(stepDecision.scopeNotLocated === true ? { scopeNotLocated: true as const } : {}),
            });
            if (stepDecision.reason === QA_INCONCLUSIVE_SCOPE || stepDecision.scopeNotLocated === true) {
              unprovenCount += 1;
            }
            // The copy inherits the outcome: a provisional copy neither
            // fails the run nor passes it — the provisional evidence remains.
            continue;
          }
        }
        // The final assertion exported from the last scoped scroll-proof step
        // (scenario.assertions[0] === that step's assert) is decided under
        // the same provisional scope gate the step itself used.
        // QA-BL-064: same as the copy check — compare the final assertion
        // against the step's ASSERTION expectation, not the NAME-only action
        // target.
        const provisionalScope = lastScrollProofStep !== null
          && assertion.kind === 'node-in-viewport'
          && assertion.scope !== undefined
          && sameJsonShape(assertion.scope, lastScrollProofStep.assert.scope)
          && sameJsonShape(assertion.expected, lastScrollProofStep.assert.expected);
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
          ...(decision.scopeLevels === undefined ? {} : { scopeLevels: decision.scopeLevels }),
          ...(decision.scopeNotLocated === true ? { scopeNotLocated: true as const } : {}),
        });
        if (decision.reason === QA_INCONCLUSIVE_SCOPE || decision.scopeNotLocated === true) unprovenCount += 1;
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
          if (decision.reason === QA_INCONCLUSIVE_SCOPE || decision.scopeNotLocated === true) {
            // QA-BL-062/069: a PROVISIONAL final assertion, or one whose
            // container the still-truncated view could not locate, is not a
            // definite failure — the run aggregates to 'inconclusive'.
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
    // QA-BL-062/069 three-state aggregation: PASS only when every required
    // step and final assertion is fully proven (failure === null AND nothing
    // was unproven); INCONCLUSIVE when at least one required result is
    // provisional (scopeResolution 'provisional' / INCONCLUSIVE_SCOPE) or a
    // scoped container could not be located in a still-truncated view
    // (INCONCLUSIVE_TRUNCATED) and nothing definitely failed; FAIL otherwise.
    status: failure === null ? (unprovenCount > 0 ? 'inconclusive' : 'pass') : 'fail',
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