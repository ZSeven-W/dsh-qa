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
  QaVisualCapture,
  QaVisualObserveOptions,
} from './adapter.ts';

/** Outcome the session core resolves for one act step. */
export type QaActOutcome = 'ok' | 'unknown' | 'failed';

export interface QaActResult {
  receipt: QaActionReceipt;
  /**
   * Fresh observation taken after a confirmed or unknown receipt. Null for
   * rejected/failed receipts, where no action was dispatched and no state
   * change can be attributed to it.
   */
  observation: QaObservation | null;
  outcome: QaActOutcome;
  /** Receipts attached as evidence for this step. */
  evidence: QaActionReceipt[];
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
 */
export class QaSession {
  readonly #adapter: QaDriverAdapter;
  readonly #ownerId: string;
  #started = false;
  #stopped = false;
  #stopPromise: Promise<QaStopResult> | null = null;

  constructor(adapter: QaDriverAdapter, ownerId: string) {
    this.#adapter = adapter;
    this.#ownerId = normalizeOwner(ownerId);
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

  async observe(options?: QaObserveOptions): Promise<QaObservation> {
    this.#assertStarted();
    return this.#adapter.observe(this.#ownerId, options);
  }

  async act(action: QaAction, approval?: QaApprovalGate): Promise<QaActResult> {
    this.#assertStarted();
    const receipt = await this.#adapter.act(this.#ownerId, action, approval);
    if (receipt.status === 'rejected' || receipt.status === 'failed') {
      return { receipt, observation: null, outcome: 'failed', evidence: [receipt] };
    }
    // confirmed and unknown both demand a fresh re-observation. The outcome
    // of an unknown receipt is deliberately left "unknown" — only a fresh
    // observation (never the receipt) can decide it.
    const observation = await this.#adapter.observe(this.#ownerId);
    const outcome: QaActOutcome = receipt.status === 'confirmed' ? 'ok' : 'unknown';
    return { receipt, observation, outcome, evidence: [receipt] };
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
  #disposed = false;

  constructor(adapter: QaDriverAdapter) {
    this.#adapter = adapter;
  }

  session(ownerId: string): QaSession {
    if (this.#disposed) throw new Error('session manager is disposed');
    const owner = normalizeOwner(ownerId);
    let session = this.#sessions.get(owner);
    if (!session) {
      session = new QaSession(this.#adapter, owner);
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
 * Capture the latest visual state through a session. The computer driver binds
 * its capture to an exact observation id, so it re-observes first when the
 * caller did not supply one; the browser driver captures its latest observation
 * directly (or the exact fingerprint the caller supplied).
 */
export async function captureLatestVisual(
  session: QaSession,
  options?: QaVisualObserveOptions,
): Promise<QaVisualCapture> {
  if (session.kind === 'computer' && options?.observationId === undefined) {
    const observation = await session.observe();
    const observationId = observation.observationId;
    if (observationId === undefined) {
      throw new Error('computer visual capture requires an observation id from the latest observation');
    }
    return session.visualObserve({ ...(options ?? {}), observationId });
  }
  return session.visualObserve(options);
}
