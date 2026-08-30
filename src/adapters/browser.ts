import type {
  BrowserAction,
  BrowserEvidenceOptions,
  BrowserObservationOptions,
  BrowserSessionStartOptions,
  BrowserVisualObserveRequest,
  ZSevenBrowserDriver,
} from '@zseven-w/dsh-browser';
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
    const driverOptions: BrowserSessionStartOptions = {
      ...(options?.url === undefined ? {} : { url: options.url }),
      ...(options?.headless === undefined ? {} : { headless: options.headless }),
    };
    const info = await this.#driver.start(ownerId, driverOptions);
    return { page: info.page, headless: info.headless };
  }

  async observe(ownerId: string, options?: QaObserveOptions): Promise<QaObservation> {
    const driverOptions: BrowserObservationOptions = {
      ...(options?.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
    };
    const observation = await this.#driver.observe(ownerId, driverOptions);
    return {
      page: observation.page,
      nodes: observation.nodes,
      truncated: observation.truncated,
    };
  }

  // The approval gate only applies to the computer driver. The browser driver
  // has no approval gate, so the parameter is accepted and deliberately ignored
  // here to keep the session core driver-agnostic.
  async act(ownerId: string, action: QaAction, _approval?: QaApprovalGate): Promise<QaActionReceipt> {
    const receipt = await this.#driver.act(ownerId, this.#mapAction(action));
    return {
      status: receipt.status,
      ...(receipt.code === undefined ? {} : { code: receipt.code }),
      ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
      dispatched: receipt.dispatched,
    };
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
