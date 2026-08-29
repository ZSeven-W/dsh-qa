import type {
  BrowserAction,
  BrowserEvidenceOptions,
  BrowserObservationOptions,
  BrowserSessionStartOptions,
  ZSevenBrowserDriver,
} from '@zseven-w/dsh-browser';
import type {
  QaAction,
  QaActionReceipt,
  QaDriverAdapter,
  QaEvidence,
  QaEvidenceOptions,
  QaObservation,
  QaObserveOptions,
  QaSessionInfo,
  QaStartOptions,
  QaStopResult,
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

  async act(ownerId: string, action: QaAction): Promise<QaActionReceipt> {
    const receipt = await this.#driver.act(ownerId, action as BrowserAction);
    return {
      status: receipt.status,
      ...(receipt.code === undefined ? {} : { code: receipt.code }),
      ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
      dispatched: receipt.dispatched,
    };
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

  async stop(ownerId: string): Promise<QaStopResult> {
    const result = await this.#driver.stop(ownerId);
    return { stopped: result.stopped, reason: result.reason };
  }

  async dispose(): Promise<void> {
    await this.#driver.dispose();
  }
}
