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
  /** Computer-only: Accessibility secure (password) classification. */
  secure?: boolean;
  /** Computer-only: bounded, non-secure value when Accessibility exposes one. */
  value?: string | null;
}

/** Computer-only application identity, asserted (never assumed) on observation. */
export interface QaComputerAppIdentity {
  bundleId: string;
  pid: number;
  launchIdentity: string | null;
  name: string | null;
}

/** Computer-only window identity, asserted (never assumed) on observation. */
export interface QaComputerWindowIdentity {
  number: number | null;
  role: string;
  subrole: string | null;
  title: string | null;
  frame: { x: number; y: number; width: number; height: number } | null;
  identity: string;
}

/** Computer-only helper status subset the QA layer asserts on. */
export interface QaComputerHelperStatus {
  platform: 'macos' | 'unsupported';
  helper: 'ready' | 'not-built' | 'unavailable';
  accessibilityTrusted: boolean | null;
  screenRecordingTrusted: boolean | null;
  sessionLocked: boolean | null;
  interactiveSessionAvailable: boolean | null;
  helperVersion: string | null;
  helperExecutable: string | null;
  identityStable: boolean | null;
  detail: string;
}

/** Computer-only driver evidence (helper status + bounded action receipts). */
export interface QaComputerEvidence {
  contractVersion: number;
  scope: string;
  status: QaComputerHelperStatus;
  activeObservations: number;
  activeNativeRequests: number;
  receipts: unknown[];
}

export interface QaObservation {
  page: QaPageRef;
  nodes: QaSemanticNode[];
  truncated: boolean;
  /** Computer-only: opaque observation id required for visual capture. */
  observationId?: string;
  fingerprint?: string;
  app?: QaComputerAppIdentity;
  window?: QaComputerWindowIdentity;
}

export interface QaActionReceipt {
  status: QaReceiptStatus;
  /** Stable driver rejection/failure code (e.g. EXTERNAL_COMMIT_TARGET, secure-text). */
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
  /** Computer-only: full driver-native evidence (helper status + receipts). */
  computer?: QaComputerEvidence;
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
  /** Computer-only: exact bundle id the session must bind to. */
  bundleId?: string;
  /** Computer-only: exact live PID (optionally paired with bundleId). */
  pid?: number;
  /** Computer-only: exact window number. */
  windowNumber?: number;
  /** Computer-only: exact window title. */
  windowTitle?: string;
}

export interface QaObserveOptions {
  maxNodes?: number;
  /** Computer-only: accessibility traversal depth (clamped 1..8). */
  maxDepth?: number;
  /** Computer-only: observation ref lifetime in ms (clamped 1000..30000). */
  ttlMs?: number;
}

export interface QaEvidenceOptions {
  maxConsole?: number;
  maxNetwork?: number;
  /** Computer-only: maximum number of action receipts to return. */
  maxReceipts?: number;
}

/** Closed vocabulary returned by the host-owned approval service. */
export type QaApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/**
 * A one-call approval gate bound by the host tool runtime. It is passed
 * through to the computer driver VERBATIM — the adapter never interprets,
 * retries, or routes around its outcome.
 */
export interface QaApprovalGate {
  request(reason: string): Promise<QaApprovalOutcome>;
}

/**
 * v0.1 action union. Browser flavors (fill/press/navigate) and computer
 * flavors (focus/type/key) share the union; the session core forwards the
 * action opaquely to the driver-specific adapter, which rejects the kinds it
 * does not support.
 */
export type QaAction =
  | { kind: 'click'; ref: string }
  | { kind: 'fill'; ref: string; text: string }
  | { kind: 'press'; ref: string; key: string }
  | { kind: 'navigate'; url: string }
  | { kind: 'focus'; ref: string }
  | { kind: 'type'; ref: string; text: string }
  | { kind: 'key'; ref: string; key: string; modifiers?: readonly string[] };

export interface QaDriverAdapter {
  readonly kind: 'browser' | 'computer';
  start(ownerId: string, options?: QaStartOptions): Promise<QaSessionInfo>;
  observe(ownerId: string, options?: QaObserveOptions): Promise<QaObservation>;
  act(ownerId: string, action: QaAction, approval?: QaApprovalGate): Promise<QaActionReceipt>;
  evidence(ownerId: string, options?: QaEvidenceOptions): Promise<QaEvidence>;
  stop(ownerId: string): Promise<QaStopResult>;
  dispose?(): Promise<void>;
}
