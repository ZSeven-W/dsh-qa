import type {
  QaAction,
  QaActionReceipt,
  QaApprovalGate,
  QaDriverAdapter,
  QaEvidence,
  QaEvidenceOptions,
  QaObservation,
  QaObserveOptions,
  QaSemanticNode,
  QaSessionInfo,
  QaStartOptions,
  QaStopResult,
  QaSettleReport,
  QaSettleWidened,
  QaVisualCapture,
  QaVisualObserveOptions,
} from './adapter.ts';
// The ONE bounded node-budget escalation the live assertion path already takes
// (decideAssertion) is reused here for the Explore recorder's scroll proof.
// Direct module import: the replay barrel re-exports the runner, which imports
// this module, so importing the barrel would create a cycle.
import { matchesNode, QA_ESCALATED_NODE_BUDGET } from '../replay/assertions.ts';
import {
  normalizeObservableValue,
  observeUntilStable,
  projectSemanticView,
  resolveSettlePolicy,
  type QaEchoMask,
  type QaSettleCallOptions,
  type QaSettlePolicy,
  type QaSettleResult,
  type QaSettleWidenGate,
} from './settle.ts';
import { QA_INCONCLUSIVE_UNSTABLE } from '../contracts.ts';

/** Outcome the session core resolves for one act step. */
export type QaActOutcome = 'ok' | 'unknown' | 'failed';

export interface QaActResult {
  receipt: QaActionReceipt;
  /**
   * Fresh SETTLED observation taken after a confirmed or unknown receipt (see
   * session/settle.ts). Null for rejected/failed receipts, where no action was
   * dispatched and no state change can be attributed to it.
   */
  observation: QaObservation | null;
  outcome: QaActOutcome;
  /** Receipts attached as evidence for this step. */
  evidence: QaActionReceipt[];
  /**
   * Settle window that produced the action's own proof baseline: the FIRST
   * post-action window. Null for rejected/failed receipts.
   * `settle.stable === false` means the view never stabilized and the
   * observation proves nothing — callers must fail closed on it. When an
   * accepted escalation replaced the proof observation, that window's report
   * lives in `escalatedSettle` instead; `settle` still reports the window
   * the baseline was taken from.
   */
  settle: QaSettleReport | null;
  /**
   * ADDITIVE, present exactly when the record-time scroll-proof escalation
   * was ACCEPTED (see #escalateScrollProof): `observation` is then the
   * escalated proof view — a fuller whole-page view, or (QA-BL-050) a SCOPED
   * view rooted at the target's container, whose own `scope` and `truncated`
   * fields travel verbatim — and `escalatedSettle` reports the escalated
   * window that produced it. Absent when the escalation never ran or was
   * refused (the proof then stays the settled observation).
   */
  proofEscalated?: true;
  /**
   * The escalated window's report; present exactly when `proofEscalated`
   * is. `stable` is always true here (an unsettled escalated window is
   * refused), and `widened` is always null (the escalated re-read never
   * widens the session policy).
   */
  escalatedSettle?: QaSettleReport;
  /**
   * ADDITIVE, present exactly when the dispatch was confirmed/unknown but the
   * proof settle window never stabilized (`settle.stable === false`). `false`
   * means the CONSEQUENCE of the action is unproven: the receipt itself is
   * still what it says (the dispatch DID happen), but nothing observed in the
   * unstable view can be attributed to it. Absent (and therefore implicitly
   * proven) when the window settled.
   */
  proven?: false;
  /** Machine code carried beside `proven: false` (see QA_INCONCLUSIVE_UNSTABLE). */
  code?: typeof QA_INCONCLUSIVE_UNSTABLE;
}

export interface QaSessionOptions {
  /** Override the bounded settle policy (defaults come from resolveSettlePolicy). */
  settle?: Partial<QaSettlePolicy>;
}

function normalizeOwner(ownerId: string): string {
  if (typeof ownerId !== 'string' || ownerId.trim() === '') {
    throw new TypeError('owner id must be a non-empty string');
  }
  return ownerId.trim();
}

/**
 * The action's own direct echo, as a QaEchoMask (see settle.ts). Built for
 * every action that writes a value onto its own target:
 *
 *  - fill/type/select: the written value is known and normalized exactly like
 *    the driver normalizes observable values, so the mask can follow the echo
 *    across observations by VALUE even when the action rewrites the target's
 *    accessible name ("Search" -> "Search: async") or when several nodes share
 *    the same role/name/tag (only the twin carrying the written value is
 *    masked);
 *  - key/press: the written value is unknowable ahead of time, so the mask
 *    degrades to the unique-predicate rule (see settle.ts isEchoMasked).
 *
 * The pre-action predicate keeps EMPTY role/name/tag fields as exact matchers:
 * an unnamed textbox must not mask named siblings that merely share its role
 * and tag.
 */
function actionEcho(action: QaAction, before: QaObservation | null): QaEchoMask | null {
  const valueWrite = action.kind === 'fill' || action.kind === 'type' || action.kind === 'select';
  const keyLike = action.kind === 'key' || action.kind === 'press';
  if (!valueWrite && !keyLike) return null;
  if (before === null) return null;
  const node = before.nodes.find((candidate) => candidate.ref === action.ref);
  if (node === undefined) return null;
  if (node.role === '' && node.name === '' && node.tag === '') return null;
  const value = valueWrite
    ? normalizeObservableValue(action.kind === 'select' ? action.option : action.text)
    : null;
  return {
    predicate: { role: node.role, name: node.name, tag: node.tag },
    ref: action.ref,
    // An empty written value is as good as unknowable: masking every empty
    // value-bearing node would be over-masking, so it degrades to the
    // unique-target rule.
    value: value === '' ? null : value,
  };
}

/** Field-level equivalence of two semantic nodes, ignoring per-observation refs. */
function scrollProofNodeEquivalent(left: QaSemanticNode, right: QaSemanticNode): boolean {
  return left.role === right.role
    && left.name === right.name
    && left.tag === right.tag
    && left.interactive === right.interactive
    && left.editable === right.editable
    && left.disabled === right.disabled
    && (left.href ?? null) === (right.href ?? null)
    && (left.inViewport ?? null) === (right.inViewport ?? null)
    && (left.secure ?? null) === (right.secure ?? null)
    && (left.value ?? null) === (right.value ?? null)
    && (left.valueWithheld ?? false) === (right.valueWithheld ?? false)
    && (left.valueTruncated ?? false) === (right.valueTruncated ?? false);
}

/**
 * Whether an escalated (higher node budget) observation is acceptable as the
 * proof observation of a settled post-scroll view — the "stable-equivalent"
 * decision.
 *
 * The escalated read is taken AFTER the settle window closed, so it is only
 * sound evidence for the action when the page is still in the exact state that
 * window proved. The browser driver emits semantic nodes in composed-tree DOM
 * order, so a view with a larger budget is a strict superset window of the
 * same page state. The escalated view therefore must EXTEND the settled one:
 * identical page URL and title, and every node the settled view returned must
 * appear unchanged (same role/name/tag/interactive/editable/disabled/href/
 * inViewport/secure/value/flags — per-observation refs excluded) in the same
 * order at the front of the escalated node list. Anything else means the page
 * changed between the two reads, and the proof stays the settled observation
 * (fail closed). The escalated observation's own truncated flag is kept
 * exactly as the driver reported it: a still-truncated fuller view that now
 * RETURNS the target in the viewport is sound evidence of presence, exactly
 * like any other returned node.
 */
function scrollProofExtends(settled: QaObservation, escalated: QaObservation): boolean {
  if (settled.page.url !== escalated.page.url) return false;
  if (settled.page.title !== escalated.page.title) return false;
  if (escalated.nodes.length < settled.nodes.length) return false;
  for (let index = 0; index < settled.nodes.length; index += 1) {
    const left = settled.nodes[index];
    const right = escalated.nodes[index];
    if (left === undefined || right === undefined || !scrollProofNodeEquivalent(left, right)) return false;
  }
  return true;
}

/**
 * QA-BL-050: the roles a scroll-target container may have. The ARIA landmark
 * and structure roles that (a) the browser driver actually emits for real
 * pages and (b) unambiguously "open a region" in composed-tree DOM order.
 */
const SCROLL_TARGET_CONTAINER_ROLES: ReadonlySet<string> = new Set([
  'region',
  'main',
  'navigation',
  'list',
  'table',
  'form',
  'group',
  'complementary',
  'article',
  'section',
]);

/**
 * QA-BL-050: the scroll target's nearest suitable container, derived from the
 * pre-action baseline observation alone.
 *
 * WHY THIS RULE: the browser driver's node shape exposes NO ancestry
 * (BrowserSemanticNode carries ref/role/name/tag/interactive/editable/
 * disabled/inViewport/href/value/... and no parent or container field), so
 * the "nearest suitable container" cannot be walked up a parent chain. What
 * the recording DID capture is the flat composed-tree DOM order of the
 * baseline view, plus — for a scoped baseline — the root the view was
 * rooted at.
 *
 * The rule, in order:
 *  1. The nearest PRECEDING container-role node in the baseline view's DOM
 *     order: scanning from the node just before the target back to the front
 *     of the list, the first node whose role is in
 *     SCROLL_TARGET_CONTAINER_ROLES. In DOM order the nearest preceding
 *     container is the container that most tightly encloses (or ends just
 *     before) the target among those the recorded view can see.
 *  2. When no container-role node precedes the target and the baseline view
 *     is itself SCOPED, the scope root IS a recorded element that contains
 *     the target (a scoped observation returns exactly the root plus its
 *     subtree), so it is used as the container.
 *  3. Otherwise there is no suitable container: null, and the caller falls
 *     back to the whole-page escalated read.
 *
 * Returns the container's cross-observation identity ({ role, name, tag }).
 * The rule is pinned by test/scroll-proof-scoped-escalation.test.mjs.
 */
function scrollTargetContainer(
  baseline: QaObservation,
  targetIndex: number,
): { role: string; name: string; tag: string } | null {
  const nodes = baseline.nodes;
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const candidate = nodes[index];
    if (candidate !== undefined && SCROLL_TARGET_CONTAINER_ROLES.has(candidate.role)) {
      return { role: candidate.role, name: candidate.name, tag: candidate.tag };
    }
  }
  const scope = baseline.scope;
  if (scope !== undefined) {
    return { role: scope.role, name: scope.name, tag: scope.tag };
  }
  return null;
}

/**
 * QA-BL-050: acceptance of a SCOPED escalated view as the scroll proof.
 *
 * scrollProofExtends is a PREFIX-extension check and is meaningless across
 * scopes: a scoped view is a DIFFERENT WINDOW onto the page (another root,
 * subtree-relative budgets, its own node order) and is never a prefix of the
 * whole-page view. The scoped case instead requires the two windows to be
 * CONSISTENT observations of the same page state:
 *
 *  - identical page URL and title (same page), AND
 *  - every node the SCOPED view SHARES with the settled view — a scoped node
 *    whose role+name+tag identity also appears in the settled view — must be
 *    field-equivalent in both windows (scrollProofNodeEquivalent). When the
 *    settled view returns several nodes with that identity, the scoped node
 *    must be equivalent to EVERY one of them (fail closed: twins are
 *    indistinguishable without ancestry). A scoped node with no identity
 *    match in the settled view is EXPECTED (the settled window is truncated
 *    and cannot see it) and does not fail.
 *
 * At least one node is always shared: the container itself — the within ref
 * was re-keyed from a settled-view node carrying the container's identity,
 * and the scoped view returns that same root first. Any field drift on a
 * shared node (inViewport included) means the page changed between the two
 * reads, and the proof stays the settled observation (fail closed).
 */
function scopedScrollProofConsistent(settled: QaObservation, scoped: QaObservation): boolean {
  if (settled.page.url !== scoped.page.url) return false;
  if (settled.page.title !== scoped.page.title) return false;
  for (const scopedNode of scoped.nodes) {
    for (const settledNode of settled.nodes) {
      if (
        settledNode.role === scopedNode.role
        && settledNode.name === scopedNode.name
        && settledNode.tag === scopedNode.tag
        && !scrollProofNodeEquivalent(settledNode, scopedNode)
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * The ref that chains the NEXT scoped read: the re-collected scope root
 * node's fresh ref inside a scoped observation. The observation's scope.ref
 * echoes the ref the caller PASSED — which belonged to the observation this
 * read just replaced, so it never resolves again. The root node is found by
 * the scope echo's role+name+tag identity (the driver emits the root first,
 * and a caller can only have scoped to a node it observed, so the root is
 * selectable); undefined when the view is whole-page or the root is absent.
 */
function scopedRootRefOf(observation: QaObservation): string | undefined {
  const scope = observation.scope;
  if (scope === undefined) return undefined;
  const root = observation.nodes.find(
    (node) => node.role === scope.role && node.name === scope.name && node.tag === scope.tag,
  );
  return root?.ref;
}

/** Field projection of one settle window result (no observation). */
function settleReportOf(result: QaSettleResult): QaSettleReport {
  return {
    stable: result.stable,
    passes: result.passes,
    elapsedMs: result.elapsedMs,
    budgetMs: result.budgetMs,
    quietRequiredMs: result.quietRequiredMs,
    widened: result.widened,
  };
}

/**
 * QA session core: observe -> act -> re-observe -> evaluate -> evidence ->
 * cleanup, on top of a QaDriverAdapter.
 *
 * Safety invariants (never relaxed):
 *  - An "unknown" receipt is NEVER treated as success; the outcome stays
 *    "unknown" and can only be resolved from a fresh observation.
 *  - "rejected"/"failed" receipts propagate as step failures with the receipt
 *    attached as evidence.
 *  - stop() is idempotent, and run() awaits cleanup in its finally so the
 *    driver is always stopped even when a step throws.
 *  - the proof observation after an act is SETTLED (observe until two
 *    consecutive observations agree, bounded by a budget) and an unsettled
 *    view is never silently accepted as proof.
 */
export class QaSession {
  readonly #adapter: QaDriverAdapter;
  readonly #ownerId: string;
  readonly #settle: QaSettlePolicy;
  /** Once-per-session widening gate: flips after the session's first widen. */
  readonly #widenGate: QaSettleWidenGate = { widened: false };
  /** Semantic projection of the last observed view (the settle baseline). */
  #lastView: string | null = null;
  /** The last raw observation, so an echo-masked baseline can be recomputed. */
  #lastObservation: QaObservation | null = null;
  #started = false;
  #stopped = false;
  #stopPromise: Promise<QaStopResult> | null = null;

  constructor(adapter: QaDriverAdapter, ownerId: string, options: QaSessionOptions = {}) {
    this.#adapter = adapter;
    this.#ownerId = normalizeOwner(ownerId);
    this.#settle = resolveSettlePolicy(options.settle);
  }

  /** The resolved settle policy this session applies to every proof observation. */
  get settlePolicy(): QaSettlePolicy {
    return { ...this.#settle };
  }

  get ownerId(): string {
    return this.#ownerId;
  }

  get kind(): QaDriverAdapter['kind'] {
    return this.#adapter.kind;
  }

  get started(): boolean {
    return this.#started;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  async start(options?: QaStartOptions): Promise<QaSessionInfo> {
    this.#assertNotStopped();
    if (this.#started) throw new Error('session is already started');
    const info = await this.#adapter.start(this.#ownerId, options);
    this.#started = true;
    // Passive: hand the recorder this session's RESOLVED settle policy so the
    // exporter can persist it into meta.settle (see adapter noteSettlePolicy).
    this.#adapter.noteSettlePolicy?.(this.#ownerId, this.#settle);
    return info;
  }

  /** One raw observation. Callers proving an outcome must use observeSettled(). */
  async observe(options?: QaObserveOptions): Promise<QaObservation> {
    this.#assertStarted();
    const observation = await this.#adapter.observe(this.#ownerId, options);
    this.#lastView = projectSemanticView(observation);
    this.#lastObservation = observation;
    return observation;
  }

  /**
   * Observe until the semantic view is stable or the bounded budget is spent.
   * This is the ONE proof/verification observation used by both Explore export
   * and Replay, so the two sides never judge different views of the same page.
   */
  async observeSettled(options?: QaObserveOptions, settle?: QaSettleCallOptions): Promise<QaSettleResult> {
    this.#assertStarted();
    // Scoped settled reads (browser driver contract v8): every poll REPLACES
    // the driver's current observation, so the within ref from the previous
    // poll no longer resolves. Re-key it each poll to the re-collected scope
    // root, found by the scope echo's role+name+tag identity in the fresh
    // view (the caller can only have scoped to a node it OBSERVED, so the
    // root is always selectable). A fresh view that no longer returns the
    // root fails closed instead of silently re-narrowing to some other node.
    let withinRef = options?.withinRef;
    const result = await observeUntilStable(
      async () => {
        const pollOptions: QaObserveOptions = options ?? {};
        const observation = await this.#adapter.observe(
          this.#ownerId,
          { ...pollOptions, ...(withinRef === undefined ? {} : { withinRef }) },
        );
        if (withinRef !== undefined) {
          const rootRef = scopedRootRefOf(observation);
          if (rootRef === undefined) {
            throw new Error(
              'the scoped observation no longer returns its scope root node, so the settled scoped read cannot continue; re-observe and retry',
            );
          }
          withinRef = rootRef;
        }
        return observation;
      },
      this.#settle,
      settle ?? {},
      this.#widenGate,
    );
    this.#lastView = projectSemanticView(result.observation);
    this.#lastObservation = result.observation;
    // Passive notification only (the Explore recorder binds the settled
    // observation here); a recorder failure can never alter session behavior.
    try {
      this.#adapter.noteSettle?.(this.#ownerId, {
        stable: result.stable,
        passes: result.passes,
        elapsedMs: result.elapsedMs,
        budgetMs: result.budgetMs,
        quietRequiredMs: result.quietRequiredMs,
        widened: result.widened,
      });
      // A widening mutated the session's effective budget in place: re-persist
      // the policy so the exporter records the WIDENED budget into meta.settle
      // (replay then starts widened and does not rediscover it).
      if (result.widened !== null) {
        this.#adapter.noteSettlePolicy?.(this.#ownerId, this.#settle);
      }
    } catch { /* observational only */ }
    return result;
  }

  /**
   * One bounded settle window that is SIDE-EFFECT-FREE for the session: the
   * record-time scroll-proof escalation uses this instead of observeSettled,
   * so the proof re-read can never
   *
   *  - replace #lastView / #lastObservation (the baseline for the next
   *    action stays the action's own settled observation), or
   *  - widen the settle budget or flip the once-per-session gate (no widen
   *    gate is passed — a churning escalated window returns stable:false at
   *    budgetMs instead of mutating the policy; the policy object is also
   *    handed over as a shallow copy so no widening path could ever touch
   *    the session's), or
   *  - re-persist the policy via noteSettlePolicy.
   *
   * The passive noteSettle IS still emitted, so the Explore recorder records
   * the window's observations and can re-bind the accepted proof to the last
   * of them.
   */
  async #observeEscalated(options?: QaObserveOptions): Promise<QaSettleResult> {
    this.#assertStarted();
    // A SCOPED escalated read (QA-BL-050) re-keys its within ref each poll
    // exactly like observeSettled: every scoped observe replaces the driver's
    // current observation, so the previous poll's ref no longer resolves. A
    // fresh view that no longer returns its scope root fails the window (the
    // caller keeps the settled observation — fail closed, at most one
    // escalation).
    let withinRef = options?.withinRef;
    const result = await observeUntilStable(
      async () => {
        const pollOptions: QaObserveOptions = options ?? {};
        const observation = await this.#adapter.observe(
          this.#ownerId,
          { ...pollOptions, ...(withinRef === undefined ? {} : { withinRef }) },
        );
        if (withinRef !== undefined) {
          const rootRef = scopedRootRefOf(observation);
          if (rootRef === undefined) {
            throw new Error(
              'the escalated scoped observation no longer returns its scope root node, so the proof re-read cannot continue',
            );
          }
          withinRef = rootRef;
        }
        return observation;
      },
      { ...this.#settle },
      {},
      undefined,
    );
    try {
      this.#adapter.noteSettle?.(this.#ownerId, settleReportOf(result));
    } catch { /* observational only */ }
    return result;
  }

  /**
   * Widen the settle budget for an assertion retry that exhausted its budget
   * without finding a positive-existence target. Uses the SAME once-per-session
   * gate as the unstable settle path, so a session widens at most once,
   * whichever path gets there first. Returns null when the gate already fired
   * or widening is inapplicable (adaptiveBudgetMs <= budgetMs).
   *
   * Mutates the session budget in place exactly like the unstable path and
   * re-persists the policy to the recorder, so export records the widened
   * budget into meta.settle.
   */
  widenForRetry(): QaSettleWidened | null {
    if (this.#widenGate.widened) return null;
    if (this.#settle.adaptiveBudgetMs <= this.#settle.budgetMs) return null;
    const fromMs = this.#settle.budgetMs;
    const toMs = this.#settle.adaptiveBudgetMs;
    this.#settle.budgetMs = toMs;
    this.#widenGate.widened = true;
    try {
      this.#adapter.noteSettlePolicy?.(this.#ownerId, this.#settle);
    } catch { /* observational only */ }
    return { fromMs, toMs, cause: 'assertion-retry' };
  }

  async act(action: QaAction, approval?: QaApprovalGate): Promise<QaActResult> {
    this.#assertStarted();
    const receipt = await this.#adapter.act(this.#ownerId, action, approval);
    if (receipt.status === 'rejected' || receipt.status === 'failed') {
      return { receipt, observation: null, outcome: 'failed', evidence: [receipt], settle: null };
    }
    // confirmed and unknown both demand a fresh re-observation. The outcome
    // of an unknown receipt is deliberately left "unknown" — only a fresh
    // observation (never the receipt) can decide it. That observation is
    // SETTLED, and as a PROOF observation it waits out an outcome that may
    // still be in flight: a single-shot read races every asynchronous UI.
    const baselineObservation = this.#lastObservation;
    const echo = actionEcho(action, baselineObservation);
    const baselineView = baselineObservation === null
      ? null
      : echo === null
        ? this.#lastView
        : projectSemanticView(baselineObservation, echo);
    const settled = await this.observeSettled(undefined, {
      awaitChange: true,
      ...(baselineView === null ? {} : { baselineView }),
      ...(echo === null ? {} : { echo }),
    });
    const outcome: QaActOutcome = receipt.status === 'confirmed' ? 'ok' : 'unknown';
    // A scroll-by-ref whose settled proof view is TRUNCATED and still lacks the
    // target in the viewport gets ONE bounded escalation (recording
    // adapters only, see #escalateScrollProof): a target deep in DOM order is
    // simply outside the default node-budget window, and without the fuller
    // view export could never evaluate the node-in-viewport proof. The
    // escalation prefers a SCOPED read rooted at the target's nearest
    // suitable container (QA-BL-050: a target beyond the driver's clamped
    // whole-page window is reachable only by scoping) and falls back to the
    // whole-page read when no container is available. At most one escalation
    // per action; a refused one keeps the settled observation.
    let proofObservation = settled.observation;
    let escalatedSettle: QaSettleReport | null = null;
    if (
      settled.stable
      && proofObservation.truncated
      && typeof this.#adapter.noteEscalatedScrollProof === 'function'
    ) {
      const escalated = await this.#escalateScrollProof(
        action,
        baselineObservation,
        proofObservation,
        receipt.actionId ?? null,
      );
      if (escalated !== null) {
        proofObservation = escalated.observation;
        escalatedSettle = escalated.settle;
      }
    }
    return {
      receipt,
      observation: proofObservation,
      outcome,
      evidence: [receipt],
      // The FIRST window's report; an accepted escalation's window rides in
      // escalatedSettle (see QaActResult) instead of shadowing this one.
      settle: settleReportOf(settled),
      ...(escalatedSettle === null ? {} : { proofEscalated: true as const, escalatedSettle }),
      // A confirmed/unknown receipt still describes a dispatch, but an unstable
      // proof window means the CONSEQUENCE is unproven: `outcome` stays honest
      // about the dispatch ('ok'/'unknown') while `proven: false` + the code
      // tell the caller nothing in the view can be attributed to the action.
      ...(settled.stable ? {} : { proven: false as const, code: QA_INCONCLUSIVE_UNSTABLE }),
    };
  }

  /**
   * ONE bounded escalation for a browser scroll-by-ref whose settled proof
   * view is truncated and still lacks the action target in the viewport.
   * Live evidence (Wikipedia History_of_China navbox): the target is deep in
   * composed-tree DOM order, so the default-budget window never returns it
   * even though the scroll placed it in the viewport — the exact gap the
   * live assertion path already closes with its own bounded re-observation
   * (replay/assertions.ts decideAssertion).
   *
   * QA-BL-050: the escalation prefers a SCOPED read rooted at the scroll
   * target's nearest suitable container (see scrollTargetContainer) and
   * falls back to today's whole-page read only when no container is
   * available. The browser driver clamps maxNodes to 100, so a target beyond
   * the 100th visible semantic node is unreachable by ANY whole-page budget —
   * scoping is the only way to return it, and a container subtree that fits
   * reports truncated:false (absence provable). The container's identity is
   * re-keyed against the SETTLED view (the driver resolves a within ref only
   * against its latest observation; a baseline ref would refuse REF_UNKNOWN).
   *
   * Accepts the escalated observation as the action's proof ONLY when
   *
   *  1. its window settled (stable),
   *  2. the escalated view is consistent with the settled one — for a
   *     whole-page escalation, stably EXTENDS it (see scrollProofExtends);
   *     for a scoped escalation, the scoped consistency rule (see
   *     scopedScrollProofConsistent: same URL/title plus every node the two
   *     windows share unchanged — the prefix rule is meaningless across
   *     scopes), AND
   *  3. the escalated view returns the action target (matched by the
   *     pre-action predicate) with inViewport === true — a fuller view that
   *     still does not place the target in the viewport is a useless
   *     escalation and is refused.
   *
   * The escalated read is taken SIDE-EFFECT-FREE (see #observeEscalated): it
   * never widens the session policy, never flips the widen gate, and never
   * replaces the session baseline, whether it is accepted or refused. On
   * acceptance the recording adapter is notified with the EXACT recorded
   * action id (carried on the receipt by the recording adapter) so it can
   * re-bind exactly this action's proof — a mismatch is refused by the
   * recorder and never silently re-bound. An unsettled window, a changed
   * page, a still-off-viewport target, or a missing pre-action target all
   * keep the settled observation — at most ONE escalation per action
   * (scoped OR whole-page, never both), no loop, fail closed.
   */
  async #escalateScrollProof(
    action: QaAction,
    baselineObservation: QaObservation | null,
    settledObservation: QaObservation,
    actionId: string | null,
  ): Promise<{ observation: QaObservation; settle: QaSettleReport } | null> {
    if (this.#adapter.kind !== 'browser') return null;
    if (action.kind !== 'scroll' || !('ref' in action)) return null;
    // The ref is the pre-action identity inside the baseline observation only
    // (the driver re-mints refs per observation), so the target's semantic
    // predicate is recovered there and matched by predicate afterwards.
    const targetIndex = baselineObservation?.nodes.findIndex((candidate) => candidate.ref === action.ref) ?? -1;
    const targetNode = targetIndex === -1 ? undefined : baselineObservation?.nodes[targetIndex];
    if (targetNode === undefined) return null;
    const target = { role: targetNode.role, name: targetNode.name, tag: targetNode.tag };
    const alreadyInViewport = settledObservation.nodes.some(
      (candidate) => matchesNode(candidate, target) && candidate.inViewport === true,
    );
    if (alreadyInViewport) return null;
    // QA-BL-050 scoped preference: root the escalated read at the target's
    // nearest suitable container when the recording captured one (see
    // scrollTargetContainer). The baseline container ref can never scope the
    // read itself — the driver resolves a within ref only against its LATEST
    // observation (the settled one) and would refuse a baseline ref with
    // REF_UNKNOWN — so the container's role+name+tag identity is re-keyed
    // into the settled view, and the FIRST node with that identity decides
    // (twins are indistinguishable without ancestry; the acceptance rule
    // fails closed on any drift).
    const container = baselineObservation === null
      ? null
      : scrollTargetContainer(baselineObservation, targetIndex);
    if (container !== null) {
      const containerNode = settledObservation.nodes.find(
        (candidate) => candidate.role === container.role
          && candidate.name === container.name
          && candidate.tag === container.tag,
      );
      if (containerNode !== undefined) {
        try {
          const escalated = await this.#observeEscalated({
            maxNodes: QA_ESCALATED_NODE_BUDGET,
            withinRef: containerNode.ref,
          });
          const scoped = escalated.observation;
          const targetInViewport = scoped.nodes.some(
            (candidate) => matchesNode(candidate, target) && candidate.inViewport === true,
          );
          if (
            escalated.stable
            && scoped.scope !== undefined
            && scopedScrollProofConsistent(settledObservation, scoped)
            && targetInViewport
          ) {
            try {
              this.#adapter.noteEscalatedScrollProof?.(this.#ownerId, actionId);
            } catch { /* observational only */ }
            return { observation: scoped, settle: settleReportOf(escalated) };
          }
          // The ONE escalation was taken and refused: keep the settled
          // observation. There is deliberately NO whole-page re-read after a
          // refused scoped attempt (at most one escalation per action).
          return null;
        } catch {
          // A refused scoped read (the page changed) also consumes the ONE
          // escalation: keep the settled observation, fail closed.
          return null;
        }
      }
      // The container is not in the settled view, so no usable within ref
      // exists: fall through to the whole-page escalated read below.
    }
    // Whole-page escalated read: the fallback when no container is available
    // or re-keyable, and the behaviour for every pre-QA-BL-050 fixture.
    try {
      const escalated = await this.#observeEscalated({ maxNodes: QA_ESCALATED_NODE_BUDGET });
      const targetInViewport = escalated.observation.nodes.some(
        (candidate) => matchesNode(candidate, target) && candidate.inViewport === true,
      );
      if (!escalated.stable || !scrollProofExtends(settledObservation, escalated.observation) || !targetInViewport) {
        return null;
      }
      try {
        this.#adapter.noteEscalatedScrollProof?.(this.#ownerId, actionId);
      } catch { /* observational only */ }
      return { observation: escalated.observation, settle: settleReportOf(escalated) };
    } catch {
      // No settled fuller view is available: keep the settled observation.
      return null;
    }
  }

  async evidence(options?: QaEvidenceOptions): Promise<QaEvidence> {
    this.#assertStarted();
    return this.#adapter.evidence(this.#ownerId, options);
  }

  async visualObserve(options?: QaVisualObserveOptions): Promise<QaVisualCapture> {
    this.#assertStarted();
    if (typeof this.#adapter.visualObserve !== 'function') {
      throw new Error('the ' + this.#adapter.kind + ' driver does not support visual capture');
    }
    return this.#adapter.visualObserve(this.#ownerId, options);
  }

  stop(): Promise<QaStopResult> {
    this.#stopPromise ??= (async () => {
      const result = await this.#adapter.stop(this.#ownerId);
      this.#stopped = true;
      return result;
    })();
    return this.#stopPromise;
  }

  /** Run fn with guaranteed cleanup: stop() is awaited even when fn throws. */
  async run<T>(fn: (session: this) => Promise<T>): Promise<T> {
    try {
      return await fn(this);
    } finally {
      await this.stop();
    }
  }

  #assertStarted(): void {
    if (!this.#started) throw new Error('session is not started; call start() first');
  }

  #assertNotStopped(): void {
    if (this.#stopped) throw new Error('session is already stopped');
  }
}

/**
 * Owns QaSession instances keyed by owner id on top of one shared adapter.
 * The MCP server keeps a single manager; each agent scope gets its own
 * QaSession while sharing the underlying driver.
 */
export class QaSessionManager {
  readonly #adapter: QaDriverAdapter;
  readonly #sessions = new Map<string, QaSession>();
  readonly #options: QaSessionOptions;
  #disposed = false;

  constructor(adapter: QaDriverAdapter, options: QaSessionOptions = {}) {
    this.#adapter = adapter;
    this.#options = options;
  }

  session(ownerId: string, options: QaSessionOptions = {}): QaSession {
    if (this.#disposed) throw new Error('session manager is disposed');
    const owner = normalizeOwner(ownerId);
    let session = this.#sessions.get(owner);
    if (!session) {
      // Per-session options (a qa_session_start settle override) merge over the
      // manager defaults, field-wise for settle so a widened budget keeps the
      // manager's other settle fields.
      session = new QaSession(this.#adapter, owner, {
        ...this.#options,
        ...options,
        settle: { ...(this.#options.settle ?? {}), ...(options.settle ?? {}) },
      });
      this.#sessions.set(owner, session);
    }
    return session;
  }

  async stop(ownerId: string): Promise<QaStopResult> {
    const owner = normalizeOwner(ownerId);
    const session = this.#sessions.get(owner);
    if (!session) return { stopped: false, reason: 'not-running' };
    const result = await session.stop();
    this.#sessions.delete(owner);
    return result;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const session of [...this.#sessions.values()]) {
      await session.stop();
    }
    this.#sessions.clear();
    await this.#adapter.dispose?.();
  }
}

/**
 * Capture the latest visual state through a session.
 *
 * Both drivers bind a capture to a semantic observation and REFUSE a capture
 * bound to a stale one: the computer driver demands an exact observation id,
 * and the browser driver rejects a capture whose stored observation is older
 * than its TTL or was taken at another URL ("the semantic observation expired;
 * observe again before visual capture"). That freshness rule is what keeps the
 * Set-of-Mark annotations and the pixels describing the SAME view, so it is
 * never relaxed here and a previous capture is NEVER reused: between two tool
 * calls the screen can change, and judging a cached frame would be a silent
 * correctness bug.
 *
 * What this function does instead is SATISFY the rule rather than lean on
 * whatever observation happens to be left over: unless the caller pinned an
 * exact observation, it takes a fresh SETTLED observation immediately before
 * the capture, for both drivers. That is exactly what the driver error asks
 * for, and it makes a capture right after qa_evidence / qa_act as valid as one
 * right after qa_observe.
 *
 * A caller that DID pin an observation (browser `fingerprint`, computer
 * `observationId`) means "capture exactly this observation": re-observing would
 * silently break that pin, so the pinned request goes straight to the driver
 * and its staleness error surfaces verbatim.
 */
export interface QaLatestVisual {
  /** The captured visual frame. */
  capture: QaVisualCapture;
  /**
   * Settle window the capture's observation was taken from; null when the
   * caller pinned an exact observation (fingerprint / observationId), where no
   * settle window ran. `stable === false` means the captured view never
   * stabilized within the budget, so any verdict on it is over an unstable
   * view — advisory and unproven.
   */
  settle: { stable: boolean; passes: number; budgetMs: number } | null;
}

export async function captureLatestVisual(
  session: QaSession,
  options?: QaVisualObserveOptions,
): Promise<QaLatestVisual> {
  const pinned = session.kind === 'computer'
    ? options?.observationId !== undefined
    : options?.fingerprint !== undefined;
  if (pinned) return { capture: await session.visualObserve(options), settle: null };
  const settled = await session.observeSettled();
  const observation = settled.observation;
  const settle = { stable: settled.stable, passes: settled.passes, budgetMs: settled.budgetMs };
  if (session.kind === 'computer') {
    const observationId = observation.observationId;
    if (observationId === undefined) {
      throw new Error('computer visual capture requires an observation id from the latest observation');
    }
    const capture = await session.visualObserve({ ...(options ?? {}), observationId });
    return { capture, settle };
  }
  const capture = await session.visualObserve(options);
  return { capture, settle };
}
