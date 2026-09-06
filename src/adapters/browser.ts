import type {
  BrowserAction,
  BrowserEvidenceOptions,
  BrowserObservationOptions,
  BrowserSessionStartOptions,
  BrowserVisualObserveRequest,
  ZSevenBrowserDriver,
} from '@zseven-w/dsh-browser';
import { loadLoginState } from '../loginState.ts';
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
} from '../session/adapter.ts';

/**
 * Adapts the @zseven-w/dsh-browser ZSevenBrowserDriver to the QA session
 * adapter interface. This is a thin, non-weakening passthrough: action
 * receipts (including EXTERNAL_COMMIT_TARGET and every other deterministic
 * risk rejection) surface verbatim and are never retried around, and evidence
 * redaction stays entirely in the driver.
 */
export class BrowserAdapter implements QaDriverAdapter {
  readonly kind = 'browser' as const;
  readonly #driver: ZSevenBrowserDriver;

  constructor(driver: ZSevenBrowserDriver) {
    this.#driver = driver;
  }

  async start(ownerId: string, options?: QaStartOptions): Promise<QaSessionInfo> {
    // WP11: owner-authorized login-state injection is filtered FAIL-CLOSED here,
    // before any entry reaches the driver. The driver receives only the entries
    // whose domain/origin exactly matched the authorized origins.
    const storageState =
      options?.loginState === undefined ? undefined : await loadLoginState(options.loginState);
    const driverOptions: BrowserSessionStartOptions = {
      ...(options?.url === undefined ? {} : { url: options.url }),
      ...(options?.headless === undefined ? {} : { headless: options.headless }),
      ...(storageState === undefined ? {} : { storageState }),
    };
    const info = await this.#driver.start(ownerId, driverOptions);
    return { page: info.page, headless: info.headless };
  }

  async observe(ownerId: string, options?: QaObserveOptions): Promise<QaObservation> {
    const driverOptions: BrowserObservationOptions = {
      ...(options?.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
      // v8 scoped observation: the driver resolves the ref exactly as actions
      // do and REFUSES (REF_INVALID / REF_UNKNOWN / REF_EXPIRED / PAGE_CHANGED
      // / TARGET_CHANGED / WITHIN_NOT_ELEMENT / OBSERVATION_REQUIRED /
      // SCOPE_UNAVAILABLE — contract v9, dsh-browser d069f4f: a retained scope
      // root was released by navigation or an intervening observe) instead of
      // falling back to a whole-page view. The refusal propagates verbatim —
      // this adapter never catches, retries, or reroutes it.
      ...(options?.withinRef === undefined ? {} : { within: options.withinRef }),
      // v9 Phase C: the bounded coverage probe runs ONLY on the terminal
      // absence-proof path (never on settle polls); the evidence travels
      // verbatim into QaObservation.coverage.
      ...(options?.verifyCoverage === true ? { verifyCoverage: true } : {}),
      // v9 Phase B: the identity anchor for the element the driver last
      // dispatched an action on; a request with no retained target REJECTS
      // with ANCHOR_UNAVAILABLE and that refusal propagates verbatim.
      ...(options?.anchorLastAction === true ? { anchorLastAction: true } : {}),
    };
    const observation = await this.#driver.observe(ownerId, driverOptions);
    return {
      page: observation.page,
      nodes: observation.nodes,
      truncated: observation.truncated,
      // The budget the driver ACTUALLY applied (its own 1..100 clamp), so
      // completeness reporting never confuses the 500-node request with fact.
      maxNodes: observation.limits.maxNodes,
      // Driver-named reasons travel verbatim (a driver that reports none
      // leaves the field absent; the QA layer never invents reasons).
      ...(observation.truncationReasons === undefined ? {} : { truncationReasons: observation.truncationReasons }),
      // v8: the driver echoes the root it observed. Honest-optional: absent
      // means the view was NOT scoped (scope null for whole-page views, or a
      // pre-v8 driver that reports no scope). A scoped observation's budgets
      // and truncation are subtree-relative.
      ...(observation.scope === undefined || observation.scope === null ? {} : { scope: observation.scope }),
      // v9 Phase C: per-observation coverage evidence, projected verbatim.
      ...(observation.coverage === undefined ? {} : { coverage: observation.coverage }),
      // v9 Phase B: the identity anchor, present exactly when requested.
      ...(observation.anchor === undefined ? {} : { anchor: observation.anchor }),
      // v9 gate diagnostics: hidden semantic-selector candidates the
      // visibility gate skipped, and whether the count is a lower bound.
      ...(observation.hiddenMatches === undefined ? {} : { hiddenMatches: observation.hiddenMatches }),
      ...(observation.hiddenMatchesPartial === undefined ? {} : { hiddenMatchesPartial: observation.hiddenMatchesPartial }),
    };
  }

  // The approval gate only applies to the computer driver. The browser driver
  // has no approval gate, so the parameter is accepted and deliberately ignored
  // here to keep the session core driver-agnostic.
  async act(ownerId: string, action: QaAction, _approval?: QaApprovalGate): Promise<QaActionReceipt> {
    const receipt = await this.#driver.act(ownerId, this.#mapAction(action));
    const projected: QaActionReceipt = {
      status: receipt.status,
      ...(receipt.code === undefined ? {} : { code: receipt.code }),
      ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
      dispatched: receipt.dispatched,
    };
    // QA-BL-070: additive driver fields ride through VERBATIM (e.g. a
    // `changed` field naming WHAT the driver saw change), so triage can read
    // the refusal detail on the step result. Driver-native bookkeeping
    // (timestamps, page refs, verification internals) stays excluded.
    const DRIVER_BOOKKEEPING = new Set([
      'receiptId', 'ownerId', 'action', 'startedAt', 'completedAt', 'dispatched',
      'pageBefore', 'pageAfter', 'target', 'observation', 'verification', 'code', 'reason', 'status',
    ]);
    for (const [key, value] of Object.entries(receipt as unknown as Record<string, unknown>)) {
      if (DRIVER_BOOKKEEPING.has(key) || value === undefined) continue;
      (projected as unknown as Record<string, unknown>)[key] = value;
    }
    return projected;
  }

  #mapAction(action: QaAction): BrowserAction {
    switch (action.kind) {
      case 'click':
        return { kind: 'click', ref: action.ref };
      case 'fill':
        return { kind: 'fill', ref: action.ref, text: action.text };
      case 'press':
        return { kind: 'press', ref: action.ref, key: action.key };
      case 'navigate':
        return { kind: 'navigate', url: action.url };
      case 'scroll': {
        if ('ref' in action && 'direction' in action) {
          throw new Error(
            'browser driver does not support the computer "scroll" shape (ref + direction); use scroll by ref alone or by direction alone',
          );
        }
        if ('ref' in action) return { kind: 'scroll', ref: action.ref };
        return {
          kind: 'scroll',
          direction: action.direction,
          ...(action.amount === undefined ? {} : { amount: action.amount }),
        };
      }
      case 'select':
        return { kind: 'select', ref: action.ref, option: action.option };
      case 'hover':
        return { kind: 'hover', ref: action.ref };
      case 'focus':
      case 'type':
      case 'key':
        throw new Error('browser driver does not support the computer "' + action.kind + '" action');
    }
  }

  async evidence(ownerId: string, options?: QaEvidenceOptions): Promise<QaEvidence> {
    const driverOptions: BrowserEvidenceOptions = {
      ...(options?.maxConsole === undefined ? {} : { maxConsole: options.maxConsole }),
      ...(options?.maxNetwork === undefined ? {} : { maxNetwork: options.maxNetwork }),
    };
    const evidence = await this.#driver.evidence(ownerId, driverOptions);
    return {
      console: evidence.console,
      network: evidence.network,
      bounded: evidence.bounded,
      dropped: evidence.dropped,
    };
  }

  async visualObserve(ownerId: string, options?: QaVisualObserveOptions): Promise<QaVisualCapture> {
    const request: BrowserVisualObserveRequest = {
      ...(options?.fingerprint === undefined ? {} : { fingerprint: options.fingerprint }),
      ...(options?.fullPage === undefined ? {} : { fullPage: options.fullPage }),
      ...(options?.maxMarks === undefined ? {} : { maxMarks: options.maxMarks }),
      ...(options?.scale === undefined ? {} : { scale: options.scale }),
    };
    // Passthrough: freshness discipline and capture bounds errors surface verbatim.
    const capture = await this.#driver.visualObserve(ownerId, request);
    return {
      driver: 'browser',
      observationFingerprint: capture.observationFingerprint,
      observationId: null,
      png: capture.png,
      width: capture.capture.pixelWidth,
      height: capture.capture.pixelHeight,
      sha256: capture.capture.artifact.sha256,
      usable: capture.capture.quality.usable,
      marks: capture.marks.length,
      omitted: capture.omitted.length,
      artifactPath: capture.capture.artifact.path,
    };
  }

  async stop(ownerId: string): Promise<QaStopResult> {
    const result = await this.#driver.stop(ownerId);
    return { stopped: result.stopped, reason: result.reason };
  }

  async dispose(): Promise<void> {
    await this.#driver.dispose();
  }
}
