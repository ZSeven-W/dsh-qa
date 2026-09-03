import type {
  QaAction,
  QaActionReceipt,
  QaApprovalGate,
  QaDriverAdapter,
  QaEvidence,
  QaEvidenceOptions,
  QaObservation,
  QaObserveOptions,
  QaSessionInfo,
  QaStartOptions,
  QaStopResult,
  QaSettleReport,
  QaVisualCapture,
  QaVisualObserveOptions,
} from './adapter.ts';
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
   * Settle window that produced `observation`. Null for rejected/failed
   * receipts. `settle.stable === false` means the view never stabilized and
   * the observation proves nothing — callers must fail closed on it.
   */
  settle: QaSettleReport | null;
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
    const result = await observeUntilStable(
      () => this.#adapter.observe(this.#ownerId, options),
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
    return {
      receipt,
      observation: settled.observation,
      outcome,
      evidence: [receipt],
      settle: {
        stable: settled.stable,
        passes: settled.passes,
        elapsedMs: settled.elapsedMs,
        budgetMs: settled.budgetMs,
        quietRequiredMs: settled.quietRequiredMs,
        widened: settled.widened,
      },
      // A confirmed/unknown receipt still describes a dispatch, but an unstable
      // proof window means the CONSEQUENCE is unproven: `outcome` stays honest
      // about the dispatch ('ok'/'unknown') while `proven: false` + the code
      // tell the caller nothing in the view can be attributed to the action.
      ...(settled.stable ? {} : { proven: false as const, code: QA_INCONCLUSIVE_UNSTABLE }),
    };
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
