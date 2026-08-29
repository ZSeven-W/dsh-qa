// QA session core adapter interface. The session core loops over this
// interface; concrete drivers (dsh-browser, dsh-computer) are adapted to it
// in src/adapters/. This interface is defined and implemented in this
// repository only — the driver packages never import or implement it.

export type QaReceiptStatus = 'confirmed' | 'unknown' | 'rejected' | 'failed';

export interface QaPageRef {
  url: string;
  title: string;
}

export interface QaSemanticNode {
  ref: string;
  role: string;
  name: string;
  tag: string;
  interactive: boolean;
  editable: boolean;
  disabled: boolean;
  href?: string;
}

export interface QaObservation {
  page: QaPageRef;
  nodes: QaSemanticNode[];
  truncated: boolean;
}

export interface QaActionReceipt {
  status: QaReceiptStatus;
  /** Stable driver rejection/failure code (e.g. EXTERNAL_COMMIT_TARGET). */
  code?: string;
  reason?: string;
  dispatched: boolean;
}

export interface QaEvidence {
  /** Driver-native, already-redacted console records. */
  console: unknown[];
  /** Driver-native, already-redacted network records. */
  network: unknown[];
  bounded: boolean;
  dropped: { console: number; network: number };
}

export interface QaSessionInfo {
  page: QaPageRef;
  headless: boolean;
}

export interface QaStopResult {
  stopped: boolean;
  reason: string;
}

export interface QaStartOptions {
  url?: string;
  headless?: boolean;
}

export interface QaObserveOptions {
  maxNodes?: number;
}

export interface QaEvidenceOptions {
  maxConsole?: number;
  maxNetwork?: number;
}

/**
 * v0.1 action union (browser flavored). The computer action shapes join this
 * union in WP5; the session core forwards the action opaquely to the adapter.
 */
export type QaAction =
  | { kind: 'click'; ref: string }
  | { kind: 'fill'; ref: string; text: string }
  | { kind: 'press'; ref: string; key: string }
  | { kind: 'navigate'; url: string };

export interface QaDriverAdapter {
  readonly kind: 'browser' | 'computer';
  start(ownerId: string, options?: QaStartOptions): Promise<QaSessionInfo>;
  observe(ownerId: string, options?: QaObserveOptions): Promise<QaObservation>;
  act(ownerId: string, action: QaAction): Promise<QaActionReceipt>;
  evidence(ownerId: string, options?: QaEvidenceOptions): Promise<QaEvidence>;
  stop(ownerId: string): Promise<QaStopResult>;
  dispose?(): Promise<void>;
}
