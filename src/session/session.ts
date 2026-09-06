import type {
  QaAction,
  QaActionReceipt,
  QaApprovalGate,
  QaDriverAdapter,
  QaEvidence,
  QaEvidenceOptions,
  QaObservation,
  QaObservationAnchor,
  QaObserveOptions,
  QaScrollProofRefusal,
  QaScrollProofRefusalReason,
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
   * ADDITIVE (QA-BL-067): present exactly when the action was taken from a
   * SCOPED baseline (the acted ref came from a scoped observation) and its
   * PROOF settle — taken INSIDE that scope, rooted at the baseline's
   * `scope.rootRef` with the driver's identity anchor requested — was
   * ACCEPTED: the scoped window settled AND the anchor reports the ORIGINAL
   * acted element connected, contained in the scoped container, and emitted
   * with a fresh ref whose node is in the viewport (identity from the anchor,
   * never from matching role/name/tag). `observation` is then the settled
   * SCOPED view, and the recorder binds it as the action's proof through the
   * ordinary settle binding, so export carries the scope (withProofScope,
   * QA-BL-054/062 rules unchanged). No escalation happened, so there is
   * deliberately no `proofEscalated` — `anchor` rides alongside instead.
   */
  proofScope?: { role: string; name: string };
  /** The driver's identity anchor from the accepted scoped proof (QA-BL-067). */
  anchor?: QaObservationAnchor;
  /**
   * ADDITIVE, present exactly when the record-time scroll-proof escalation
   * was ACCEPTED (see #escalateScrollProof): `observation` is then the
   * escalated proof view — a fuller WHOLE-PAGE view whose own `truncated`
   * field travels verbatim — and `escalatedSettle` reports the escalated
   * window that produced it. Absent when the escalation never ran or was
   * refused (the proof then stays the settled observation).
   */
  proofEscalated?: true;
  /**
   * ADDITIVE disclosure (QA-BL-058, completed by QA-BL-067): present exactly
   * when the FINAL proof state was refused — the SCOPED proof read for an
   * action taken from a scoped baseline, or the ONE bounded record-time
   * scroll-proof escalation, could not prove the outcome. `reason` is from
   * the FIXED vocabulary (target-not-in-baseline, container-not-in-view,
   * escalated-window-unstable, target-not-returned, target-not-in-viewport,
   * anchor-not-connected, anchor-not-contained, anchor-unavailable) and
   * `code` carries the driver's machine code when the driver THREW.
   * `already-in-viewport` is deliberately NOT a refusal: no escalation is
   * needed, and the result then simply has no escalation fields. When the
   * scoped proof read was refused AND the escalation was refused, the
   * escalation's refusal is the one disclosed (the more terminal truth);
   * when the escalation was ACCEPTED the earlier refusal is superseded (the
   * proof succeeded). The fail-closed behaviour is unchanged: the proof
   * stays the settled observation.
   */
  escalationRefused?: QaScrollProofRefusal;
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

// B3 (contract v9, Phase B): the container roles the identity-anchored SCOPED
// scroll-proof escalation may root a read at. The container itself is picked
// by ANCESTRY — the target's parentRef chain in the BASELINE observation — and
// the acceptance is decided by the driver's identity anchor, never by matching
// role/name/tag across observations (the retired QA-BL-050 heuristic).
const QA_CONTAINER_ROLES = new Set([
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
 * The target's nearest container-role ANCESTOR in the BASELINE observation:
 * walk the target's parentRef chain (composed-tree ancestry, driver contract
 * v9 — each parentRef names an EARLIER node of the same observation) to the
 * first node whose role is a container role. parentRef compares as a
 * RELATIONSHIP within the baseline view only, never as a raw string across
 * observations. Undefined when the chain runs out (no container ancestor) or
 * a parentRef does not resolve inside the baseline (fail closed — the caller
 * then takes the whole-page escalation).
 */
function scrollProofContainer(baseline: QaObservation | null, targetIndex: number): QaSemanticNode | undefined {
  if (baseline === null) return undefined;
  const targetNode = baseline.nodes[targetIndex];
  if (targetNode === undefined) return undefined;
  const byRef = new Map(baseline.nodes.map((node) => [node.ref, node]));
  let current = targetNode;
  for (let hops = 0; hops < baseline.nodes.length; hops += 1) {
    const parentRef = typeof current.parentRef === 'string' && current.parentRef !== ''
      ? current.parentRef
      : null;
    if (parentRef === null) return undefined;
    const parent = byRef.get(parentRef);
    if (parent === undefined) return undefined;
    if (QA_CONTAINER_ROLES.has(parent.role)) return parent;
    current = parent;
  }
  return undefined;
}

/**
 * The ref that chains the NEXT scoped read: the DRIVER's fresh scope.rootRef
 * minted in THIS observation (driver contract v9, Phase B). The observation's
 * scope.ref echoes the ref the caller PASSED — which belonged to the
 * observation this read just replaced, so it never resolves again. rootRef
 * binds the root even when the visibility gate excluded it from nodes, so a
 * hidden root still chains. Undefined when the view is whole-page or the
 * driver minted no rootRef (pre-v9) — and then the caller fails closed:
 * re-matching the root by role+name+tag across observations is not identity
 * (QA-BL-055) and is deliberately NOT done here.
 */
function scopedRootRefOf(observation: QaObservation): string | undefined {
  const scope = observation.scope;
  if (scope === undefined) return undefined;
  const rootRef = scope.rootRef;
  return typeof rootRef === 'string' && rootRef !== '' ? rootRef : undefined;
}

// ---------------------------------------------------------------------------
// QA-BL-067: the fixed refusal vocabulary for every non-acceptance exit of the
// scoped proof read and the scroll-proof escalation (completes QA-BL-058 —
// every previously silent `return null` now discloses its reason).
// ---------------------------------------------------------------------------

/**
 * Driver codes that mean "the scoped root can no longer be re-keyed".
 * SCOPE_UNAVAILABLE (contract v9, dsh-browser d069f4f) is the retention-era
 * sibling of OBSERVATION_REQUIRED: a scope root WAS retained by the last
 * dispatched action, but its live binding was released (navigation, dispose,
 * or an intervening observe consumed the retention) — still a container
 * refusal, never a whole-page fallback.
 */
const QA_REFUSAL_CONTAINER_CODES = new Set([
  'REF_INVALID',
  'REF_UNKNOWN',
  'REF_EXPIRED',
  'PAGE_CHANGED',
  'TARGET_CHANGED',
  'TARGET_DETACHED',
  'WITHIN_NOT_ELEMENT',
  'OBSERVATION_REQUIRED',
  'SCOPE_UNAVAILABLE',
]);

/**
 * The fixed-vocabulary refusal for a driver THROW during a proof re-read:
 * ANCHOR_UNAVAILABLE means the identity anchor is gone; a scoped-root refusal
 * code means the container root cannot be re-keyed; anything else keeps the
 * caller's fallback word. The driver's machine code rides along verbatim.
 */
function scrollProofRefusalFromError(
  error: unknown,
  fallback: QaScrollProofRefusalReason,
): QaScrollProofRefusal {
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string' && code !== '') {
    if (code === 'ANCHOR_UNAVAILABLE') return { code, reason: 'anchor-unavailable' };
    if (QA_REFUSAL_CONTAINER_CODES.has(code)) return { code, reason: 'container-not-in-view' };
    return { code, reason: fallback };
  }
  return { reason: fallback };
}

/**
 * The acceptance verdict for a settled SCOPED proof observation (QA-BL-067):
 * the driver's identity anchor must report the ORIGINAL acted element
 * connected, contained in the scoped container, and emitted with a fresh ref
 * whose node is in the viewport. Identity comes from the anchor — never from
 * matching role/name/tag — and every non-acceptance maps to one fixed
 * refusal word.
 */
function scopedProofVerdict(
  observation: QaObservation,
): { accepted: true } | { accepted: false; refusal: QaScrollProofRefusal } {
  const anchor = observation.anchor;
  const anchoredNode = anchor?.ref === null || anchor?.ref === undefined
    ? undefined
    : observation.nodes.find((candidate) => candidate.ref === anchor.ref);
  if (anchor === undefined) {
    return { accepted: false, refusal: { reason: 'anchor-unavailable' } };
  }
  if (anchor.connected !== true) {
    return { accepted: false, refusal: { reason: 'anchor-not-connected' } };
  }
  if (anchor.contained !== true) {
    return { accepted: false, refusal: { reason: 'anchor-not-contained' } };
  }
  if (anchor.ref === null) {
    return { accepted: false, refusal: { reason: 'anchor-unavailable' } };
  }
  if (anchoredNode === undefined || anchoredNode.inViewport !== true) {
    return { accepted: false, refusal: { reason: 'target-not-in-viewport' } };
  }
  return { accepted: true };
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
    // poll no longer resolves. Re-key it each poll to the DRIVER's fresh
    // scope.rootRef (contract v9, Phase B) — never by role+name+tag
    // re-matching, which is not identity. A proof window opened immediately
    // after a dispatched action (see act) takes its FIRST poll through the
    // driver's post-action scope-root retention (contract v9, dsh-browser
    // d069f4f): that poll consumes the retention, and the fresh rootRef it
    // mints is what this loop re-keys from there. A fresh view whose driver minted
    // no rootRef fails closed instead of silently re-narrowing to some other
    // node. rootRef binds the root even when the visibility gate excluded it
    // from nodes, so a root that hides mid-window still chains.
    // Contract v9 Phase C: the bounded coverage probe NEVER runs on settle
    // polls — when the caller requested verifyCoverage (the terminal absence
    // decision), the polls run WITHOUT it and exactly ONE probed read is
    // taken after the window settled; that probed view is the deciding
    // observation.
    const verifyCoverage = options?.verifyCoverage === true;
    const pollOptions: QaObserveOptions = { ...(options ?? {}) };
    if (verifyCoverage) delete pollOptions.verifyCoverage;
    let withinRef = options?.withinRef;
    const result = await observeUntilStable(
      async () => {
        const observation = await this.#adapter.observe(
          this.#ownerId,
          { ...pollOptions, ...(withinRef === undefined ? {} : { withinRef }) },
        );
        if (withinRef !== undefined) {
          const rootRef = scopedRootRefOf(observation);
          if (rootRef === undefined) {
            throw new Error(
              'the scoped observation carries no rootRef, so its scope root cannot be re-chained; re-observe and retry',
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
    let observation = result.observation;
    if (verifyCoverage && result.stable) {
      // ONE probed deciding read after the window: the probe runs exactly
      // once for the whole terminal absence decision, on the deciding
      // observation — never once per settle poll.
      observation = await this.#adapter.observe(
        this.#ownerId,
        {
          ...pollOptions,
          verifyCoverage: true,
          ...(withinRef === undefined ? {} : { withinRef }),
        },
      );
    }
    this.#lastView = projectSemanticView(observation);
    this.#lastObservation = observation;
    // The deciding (probed) observation is the one the window reports.
    result.observation = observation;
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
    // A scoped escalated read re-keys its within ref each poll exactly like
    // observeSettled: every scoped observe replaces the driver's current
    // observation, so the previous poll's ref no longer resolves. The chain
    // key is the DRIVER's fresh scope.rootRef (contract v9, Phase B); a view
    // whose driver minted no rootRef fails the window (the caller keeps the
    // settled observation — fail closed, at most one escalation). The
    // whole-page form of the record-time scroll escalation passes no
    // withinRef at all.
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
              'the escalated scoped observation carries no rootRef, so its scope root cannot be re-chained; the proof re-read cannot continue',
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
    const settleOptions: QaSettleCallOptions = {
      awaitChange: true,
      ...(baselineView === null ? {} : { baselineView }),
      ...(echo === null ? {} : { echo }),
    };
    // QA-BL-067: when the acted ref came from a SCOPED baseline, the proof
    // settle is taken INSIDE that scope — rooted at the baseline's
    // scope.rootRef with the driver's identity anchor requested — so a deep
    // target unreachable whole-page stays provable inside its container.
    // VERIFIED against the real driver (contract v9, dsh-browser d069f4f):
    // a dispatched action that consumed a SCOPED observation and did NOT
    // navigate retains that observation's scope root until the next
    // successful observe. The FIRST poll is therefore keyed by the EXPLICIT
    // baseline scope.rootRef — deliberately not the 'last-scope' alias, which
    // would silently rebind a STALE baseline to whatever root was last acted
    // and measure the anchor's containment against the WRONG container (a
    // false scoped proof); the explicit rootRef is refused instead. That poll
    // resolves through the retained handle and CONSUMES the retention,
    // minting a FRESH scope.rootRef in its observation; the settle loop
    // re-keys every later poll to that fresh rootRef (scopedRootRefOf, see
    // observeSettled), riding the driver's transition from the retained root
    // to a live observation. Refusals stay DISCLOSED (reason
    // 'container-not-in-view' plus the driver's code) and the proof falls
    // back to today's whole-page read: OBSERVATION_REQUIRED when nothing was
    // retained (a pre-retention driver, a plain node ref from the consumed
    // observation, or the acted ref IS the scope root itself — the driver
    // deliberately creates no retention for that single-owner handle, while
    // the anchor still works), SCOPE_UNAVAILABLE when a retained root was
    // released (navigation, dispose, or an intervening observe).
    // RECORD-TIME ONLY: the same recording-adapter capability gate the
    // escalation uses. Replay (and every plain adapter) keeps today's
    // whole-page proof settle — the replay runner resolves scopes and verifies
    // through its OWN anchor-checked scoped reads, and a scoped proof
    // observation left in the session baseline would break that flow.
    const recordingSession = typeof this.#adapter.noteEscalatedScrollProof === 'function';
    const baselineScopeRootRef = !recordingSession || baselineObservation === null
      ? undefined
      : scopedRootRefOf(baselineObservation);
    let scopedProofRefusal: QaScrollProofRefusal | undefined;
    let settled: QaSettleResult;
    if (baselineScopeRootRef !== undefined) {
      try {
        settled = await this.observeSettled({ withinRef: baselineScopeRootRef, anchorLastAction: true }, settleOptions);
      } catch (error) {
        // The baseline scope root no longer resolves: document why, disclose,
        // and take today's whole-page proof read instead. The refused attempt
        // is a HANDLED driver refusal, never a recording failure: the
        // recording adapter re-arms its settle-window state so the FALLBACK
        // settle binds exactly this action's proof.
        scopedProofRefusal = scrollProofRefusalFromError(error, 'container-not-in-view');
        if (typeof this.#adapter.noteScopedProofFallback === 'function') {
          try {
            this.#adapter.noteScopedProofFallback(this.#ownerId, receipt.actionId ?? null);
          } catch { /* observational only */ }
        }
        settled = await this.observeSettled(undefined, settleOptions);
      }
    } else {
      settled = await this.observeSettled(undefined, settleOptions);
    }
    const outcome: QaActOutcome = receipt.status === 'confirmed' ? 'ok' : 'unknown';
    // The accepted scoped proof (QA-BL-067): the settled SCOPED view whose
    // driver identity anchor reports the acted element connected, contained,
    // and in the viewport IS the proof — no escalation happened, so the result
    // carries proofScope + anchor instead of proofEscalated.
    let proofObservation = settled.observation;
    let proofScope: { role: string; name: string } | undefined;
    let anchor: QaObservationAnchor | undefined;
    let scopedProofAccepted = false;
    if (
      settled.stable
      && baselineScopeRootRef !== undefined
      && proofObservation.scope !== undefined
    ) {
      const verdict = scopedProofVerdict(proofObservation);
      if (verdict.accepted) {
        scopedProofAccepted = true;
        proofScope = { role: proofObservation.scope.role, name: proofObservation.scope.name };
        anchor = proofObservation.anchor;
      } else if (scopedProofRefusal === undefined) {
        scopedProofRefusal = verdict.refusal;
      }
    }
    // A scroll-by-ref whose settled proof view is TRUNCATED and still lacks the
    // target in the viewport gets ONE bounded escalation (recording
    // adapters only, see #escalateScrollProof): a target deep in DOM order is
    // simply outside the default node-budget window, and without the fuller
    // view export could never evaluate the node-in-viewport proof. The ONE
    // escalation prefers the identity-anchored SCOPED read rooted at the
    // target's nearest container-role ANCESTOR (contract v9, Phase B — B3,
    // re-enabling QA-BL-050 without the retired heuristic) and falls back to
    // the WHOLE-PAGE read (QA-BL-045/047) when no container is on the
    // parentRef chain or it cannot be re-keyed. At most one escalation per
    // action; a refused one keeps the settled observation and is DISCLOSED as
    // escalationRefused with the fixed vocabulary (QA-BL-058/QA-BL-067).
    let escalatedSettle: QaSettleReport | null = null;
    let escalationRefused: QaScrollProofRefusal | undefined;
    if (
      !scopedProofAccepted
      && settled.stable
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
        if (escalated.accepted) {
          proofObservation = escalated.observation;
          escalatedSettle = escalated.settle;
          // The proof succeeded through the escalation: the earlier
          // scoped-proof refusal is superseded, not disclosed.
          scopedProofRefusal = undefined;
        } else {
          // The escalation's refusal is the more terminal truth: it
          // supersedes the scoped-proof refusal.
          escalationRefused = escalated.refusal;
        }
      }
    }
    // The FINAL refusal disclosed on the result: the escalation's when it ran
    // and was refused, otherwise the scoped-proof read's.
    if (escalationRefused === undefined) escalationRefused = scopedProofRefusal;
    const scopedProof = proofScope !== undefined && anchor !== undefined ? { proofScope, anchor } : null;
    if (escalationRefused !== undefined && typeof this.#adapter.noteScrollProofRefusal === 'function') {
      try {
        this.#adapter.noteScrollProofRefusal(this.#ownerId, receipt.actionId ?? null, escalationRefused);
      } catch { /* observational only */ }
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
      ...(scopedProof === null ? {} : scopedProof),
      ...(escalationRefused === undefined ? {} : { escalationRefused }),
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
   * B3 (contract v9, Phase B) — re-enables QA-BL-050 WITHOUT the retired
   * heuristic: the container is picked by ANCESTRY, walking the target's
   * parentRef chain in the BASELINE observation to the first node whose role
   * is a container role (region/main/navigation/list/table/form/group/
   * complementary/article/section), then re-keyed into the settled view by
   * its unique role+name+tag match. The escalated read is SCOPED to that
   * container and requests the driver's identity anchor (anchorLastAction).
   * IDENTITY COMES FROM THE ANCHOR, never from matching role/name/tag: the
   * read is accepted ONLY when its window settled AND the anchor reports the
   * ORIGINAL acted element connected, contained in the within subtree, and
   * emitted with a fresh ref whose node is in the viewport. No container on
   * the chain, an un-re-keyable container (zero or twin matches in the
   * settled view), and every refusal fall back to — or keep — the settled
   * observation; the WHOLE-PAGE escalation (QA-BL-045/047) runs when no
   * container applies, keeping its prefix-extension acceptance rule
   * (scrollProofExtends), which is meaningless across scopes for the scoped
   * form (the anchor replaces it there).
   *
   * The escalated read is taken SIDE-EFFECT-FREE (see #observeEscalated): it
   * never widens the session policy, never flips the widen gate, and never
   * replaces the session baseline, whether it is accepted or refused. On
   * acceptance the recording adapter is notified with the EXACT recorded
   * action id (carried on the receipt by the recording adapter) so it can
   * re-bind exactly this action's proof — a mismatch is refused by the
   * recorder and never silently re-bound. An unsettled window, a changed
   * page, a still-off-viewport target, or a missing pre-action target all
   * keep the settled observation — at most ONE escalation per action, no
   * loop, fail closed. QA-BL-058: an escalated read that THROWS (a driver
   * refusal such as ANCHOR_UNAVAILABLE / PAGE_CHANGED / REF_EXPIRED) — and a
   * scoped read whose anchor reports connected:false, contained:false, or a
   * null ref, or whose anchored node is not in the viewport — is DISCLOSED
   * through the returned `refusal` instead of being swallowed into a silent
   * null; the fail-closed outcome is unchanged, only the observability is
   * new.
   */
  async #escalateScrollProof(
    action: QaAction,
    baselineObservation: QaObservation | null,
    settledObservation: QaObservation,
    actionId: string | null,
  ): Promise<
    | { accepted: true; observation: QaObservation; settle: QaSettleReport }
    | { accepted: false; refusal: QaScrollProofRefusal }
    | null
  > {
    if (this.#adapter.kind !== 'browser') return null;
    if (action.kind !== 'scroll' || !('ref' in action)) return null;
    // The ref is the pre-action identity inside the baseline observation only
    // (the driver re-mints refs per observation), so the target's semantic
    // predicate is recovered there and matched by predicate afterwards.
    const targetIndex = baselineObservation?.nodes.findIndex((candidate) => candidate.ref === action.ref) ?? -1;
    const targetNode = targetIndex === -1 ? undefined : baselineObservation?.nodes[targetIndex];
    if (targetNode === undefined) {
      // QA-BL-067: the silent exit is DISCLOSED with the fixed vocabulary.
      return { accepted: false, refusal: { reason: 'target-not-in-baseline' } };
    }
    const target = { role: targetNode.role, name: targetNode.name, tag: targetNode.tag };
    const alreadyInViewport = settledObservation.nodes.some(
      (candidate) => matchesNode(candidate, target) && candidate.inViewport === true,
    );
    // Deliberately NOT a refusal (QA-BL-067): the settled view already proves
    // the outcome, so no escalation is needed and the result simply carries no
    // escalation fields.
    if (alreadyInViewport) return null;

    // B3: pick the container by ANCESTRY in the BASELINE observation (walk
    // parentRef links — composed-tree ancestors, never a DOM-order heuristic)
    // to the FIRST container-role node.
    const container = scrollProofContainer(baselineObservation, targetIndex);
    if (container !== undefined) {
      // Re-key the container into the settled view by its unique
      // role+name+tag identity — a HINT to pick the within subtree; the
      // proof itself is decided by the anchor, so a re-key can never turn a
      // non-ancestor into a false proof. Zero or twin matches: not re-keyable.
      const predicate = { role: container.role, name: container.name, tag: container.tag };
      const settledMatches = settledObservation.nodes.filter((candidate) => matchesNode(candidate, predicate));
      const containerRefInSettled = settledMatches.length === 1 ? (settledMatches[0] as QaSemanticNode).ref : undefined;
      if (containerRefInSettled !== undefined) {
        return this.#escalateScopedScrollProof(containerRefInSettled, actionId);
      }
    }
    // The ONE whole-page escalated read (QA-BL-045/047, unchanged) — taken
    // when no container-role ancestor exists or the container cannot be
    // re-keyed into the settled view. Every non-acceptance exit is DISCLOSED
    // with the fixed vocabulary (QA-BL-067): a churning window or a view that
    // does not stably extend the settled one is escalated-window-unstable, and
    // the target distinction names whether it was returned at all.
    try {
      const escalated = await this.#observeEscalated({ maxNodes: QA_ESCALATED_NODE_BUDGET });
      if (!escalated.stable) {
        return { accepted: false, refusal: { reason: 'escalated-window-unstable' } };
      }
      if (!scrollProofExtends(settledObservation, escalated.observation)) {
        // The page changed between the two reads: the escalated view is not the
        // stable state the settle window proved.
        return { accepted: false, refusal: { reason: 'escalated-window-unstable' } };
      }
      const targetMatches = escalated.observation.nodes.filter((candidate) => matchesNode(candidate, target));
      if (targetMatches.length === 0) {
        return { accepted: false, refusal: { reason: 'target-not-returned' } };
      }
      if (targetMatches.every((candidate) => candidate.inViewport !== true)) {
        return { accepted: false, refusal: { reason: 'target-not-in-viewport' } };
      }
      try {
        this.#adapter.noteEscalatedScrollProof?.(this.#ownerId, actionId);
      } catch { /* observational only */ }
      return { accepted: true, observation: escalated.observation, settle: settleReportOf(escalated) };
    } catch (error) {
      // QA-BL-058/QA-BL-067: the escalated read threw (a driver refusal such as
      // PAGE_CHANGED / REF_EXPIRED). Disclose it with the fixed vocabulary plus
      // the driver's code; the proof stays the settled observation (fail
      // closed, unchanged).
      return { accepted: false, refusal: scrollProofRefusalFromError(error, 'escalated-window-unstable') };
    }
  }

  /**
   * The ONE identity-anchored SCOPED escalated read (B3): observe within the
   * re-keyed container with anchorLastAction, and accept the read as the
   * action's proof ONLY when its window settled AND the driver's identity
   * anchor reports the ORIGINAL acted element connected, contained in the
   * within subtree, and emitted with a fresh ref whose node is in the
   * viewport. Identity comes from the anchor — the original handle the
   * driver dispatched the scroll on — never from matching role/name/tag.
   * Refusals (ANCHOR_UNAVAILABLE, connected:false, contained:false, a null
   * anchor ref, an off-viewport anchored node) are DISCLOSED as
   * escalationRefused and the proof stays the settled observation.
   */
  async #escalateScopedScrollProof(
    withinRef: string,
    actionId: string | null,
  ): Promise<
    | { accepted: true; observation: QaObservation; settle: QaSettleReport }
    | { accepted: false; refusal: QaScrollProofRefusal }
    | null
  > {
    try {
      const escalated = await this.#observeEscalated({
        withinRef,
        anchorLastAction: true,
        maxNodes: QA_ESCALATED_NODE_BUDGET,
      });
      if (!escalated.stable) {
        // QA-BL-067: the unsettled-window refusal is DISCLOSED, never a silent
        // exit (fail closed, the settled observation stays).
        return { accepted: false, refusal: { reason: 'escalated-window-unstable' } };
      }
      const anchor = escalated.observation.anchor;
      const anchoredNode = anchor?.ref === null || anchor?.ref === undefined
        ? undefined
        : escalated.observation.nodes.find((candidate) => candidate.ref === anchor.ref);
      let refusal: QaScrollProofRefusal | undefined;
      if (anchor === undefined) {
        refusal = { reason: 'anchor-unavailable' };
      } else if (anchor.connected !== true) {
        refusal = { reason: 'anchor-not-connected' };
      } else if (anchor.contained !== true) {
        refusal = { reason: 'anchor-not-contained' };
      } else if (anchor.ref === null) {
        refusal = { reason: 'anchor-unavailable' };
      } else if (anchoredNode === undefined || anchoredNode.inViewport !== true) {
        refusal = { reason: 'target-not-in-viewport' };
      }
      if (refusal !== undefined) {
        // QA-BL-058/QA-BL-067: the refusal is DISCLOSED with the fixed
        // vocabulary — the proof stays the settled observation, and the reason
        // names the anchor truth.
        return { accepted: false, refusal };
      }
      try {
        this.#adapter.noteEscalatedScrollProof?.(this.#ownerId, actionId);
      } catch { /* observational only */ }
      return { accepted: true, observation: escalated.observation, settle: settleReportOf(escalated) };
    } catch (error) {
      // QA-BL-058/QA-BL-067: the scoped escalated read threw (a driver refusal
      // such as ANCHOR_UNAVAILABLE — no retained action target — or
      // REF_EXPIRED / PAGE_CHANGED). Disclose it with the fixed vocabulary
      // plus the driver's code; the proof stays the settled observation.
      return { accepted: false, refusal: scrollProofRefusalFromError(error, 'anchor-unavailable') };
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
