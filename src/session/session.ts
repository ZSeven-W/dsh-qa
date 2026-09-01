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
  observeUntilStable,
  projectSemanticView,
  resolveSettlePolicy,
  type QaSettleCallOptions,
  type QaSettlePolicy,
  type QaSettleResult,
} from './settle.ts';

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
  /** Semantic projection of the last observed view (the settle baseline). */
  #lastView: string | null = null;
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
    return info;
  }

  /** One raw observation. Callers proving an outcome must use observeSettled(). */
  async observe(options?: QaObserveOptions): Promise<QaObservation> {
    this.#assertStarted();
    const observation = await this.#adapter.observe(this.#ownerId, options);
    this.#lastView = projectSemanticView(observation);
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
    );
    this.#lastView = projectSemanticView(result.observation);
    // Passive notification only (the Explore recorder binds the settled
    // observation here); a recorder failure can never alter session behavior.
    try {
      this.#adapter.noteSettle?.(this.#ownerId, {
        stable: result.stable,
        passes: result.passes,
        elapsedMs: result.elapsedMs,
        budgetMs: result.budgetMs,
      });
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
    const baselineView = this.#lastView;
    const settled = await this.observeSettled(undefined, {
      awaitChange: true,
      ...(baselineView === null ? {} : { baselineView }),
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
      },
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

  session(ownerId: string): QaSession {
    if (this.#disposed) throw new Error('session manager is disposed');
    const owner = normalizeOwner(ownerId);
    let session = this.#sessions.get(owner);
    if (!session) {
      session = new QaSession(this.#adapter, owner, this.#options);
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
export async function captureLatestVisual(
  session: QaSession,
  options?: QaVisualObserveOptions,
): Promise<QaVisualCapture> {
  const pinned = session.kind === 'computer'
    ? options?.observationId !== undefined
    : options?.fingerprint !== undefined;
  if (pinned) return session.visualObserve(options);
  const observation = (await session.observeSettled()).observation;
  if (session.kind === 'computer') {
    const observationId = observation.observationId;
    if (observationId === undefined) {
      throw new Error('computer visual capture requires an observation id from the latest observation');
    }
    return session.visualObserve({ ...(options ?? {}), observationId });
  }
  return session.visualObserve(options);
}
