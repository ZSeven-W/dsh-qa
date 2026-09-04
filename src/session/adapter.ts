// QA session core adapter interface. The session core loops over this
// interface; concrete drivers (dsh-browser, dsh-computer) are adapted to it
// in src/adapters/. This interface is defined and implemented in this
// repository only — the driver packages never import or implement it.

import type { QaLoginStateConfig } from '../loginState.ts';
import type { QaSettlePolicy } from './settle.ts';

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
  /**
   * Browser-only: whether the element's box intersects the viewport at
   * collection time. Off-viewport nodes still carry a ref so a scroll can
   * reach them, but they are omitted from a viewport visual capture. Absent
   * for computer targets (the computer driver has no viewport notion here).
   */
  inViewport?: boolean;
  /** Computer-only: Accessibility secure (password) classification. */
  secure?: boolean;
  /**
   * Bounded observable value of a value-bearing control (browser, contract v5;
   * and computer when Accessibility exposes one). An empty string is a real
   * observation; the ABSENCE of the field means the element has no observable
   * value, or that it was withheld (see valueWithheld).
   */
  value?: string | null;
  /** Browser-only: the value exists but was deliberately never read (secret). */
  valueWithheld?: true;
  /** Browser-only: the value exceeded the driver bound and `value` is a prefix. */
  valueTruncated?: true;
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
  /**
   * v4+: receipts ever recorded in this scope (monotonically increasing).
   * null when the driver contract is older than v4 and does not expose the
   * counter, so a reader can tell "did not look" from "looked and absent".
   */
  receiptsTotal: number | null;
  /** v4+: receipts evicted from the bounded ring because it exceeded its cap. */
  receiptsDropped: number | null;
  /** v4+: receipts actually present in `receipts` (bounded by the requested limit). */
  receiptsReturned: number | null;
  /** v4+: whether the receipt ring is bounded. null pre-v4. */
  receiptsBounded: boolean | null;
  /** Present only when the v4 counters are unavailable (pre-v4 driver). */
  receiptsCountersUnavailableReason?: string;
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
  /** Browser-only: records dropped when the bounded console/network buffer exceeded its cap. */
  dropped?: { console: number; network: number };
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
  /** Browser-only: owner-authorized, scoped login state (see loginState.ts). */
  loginState?: QaLoginStateConfig;
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

/** Options for one unified visual observe across both drivers. */
export interface QaVisualObserveOptions {
  /** Browser-only: exact observation fingerprint; omit for the latest observation. */
  fingerprint?: string;
  /** Browser-only: capture the full document instead of the viewport. */
  fullPage?: boolean;
  /** Browser-only: Set-of-Mark budget (driver clamps 1..200). */
  maxMarks?: number;
  /** Browser-only: output PNG scale (driver clamps 1..3). */
  scale?: number;
  /** Computer-only: exact opaque observation id returned by observe(). */
  observationId?: string;
}

/**
 * Unified visual capture projected by both driver adapters. The PNG stays in
 * process memory for the attachment service / artifact writer; model-facing and
 * report JSON must project metadata only (see toVisualCaptureInfo).
 */
export interface QaVisualCapture {
  driver: 'browser' | 'computer';
  /** Exact observation fingerprint the capture is bound to (null when unknown). */
  observationFingerprint: string | null;
  /** Computer-only observation id the capture is bound to. */
  observationId: string | null;
  png: Uint8Array;
  width: number;
  height: number;
  sha256: string;
  usable: boolean;
  marks: number;
  omitted: number;
  /** Absolute path the driver already wrote the PNG to (browser); absent for in-memory computer captures. */
  artifactPath?: string;
}

/** Tool/report-facing capture projection: metadata only, never the raw PNG bytes. */
export interface QaVisualCaptureInfo {
  driver: 'browser' | 'computer';
  observationFingerprint: string | null;
  observationId: string | null;
  width: number;
  height: number;
  sha256: string;
  usable: boolean;
  marks: number;
  omitted: number;
  artifactPath?: string;
}

export function toVisualCaptureInfo(capture: QaVisualCapture): QaVisualCaptureInfo {
  return {
    driver: capture.driver,
    observationFingerprint: capture.observationFingerprint,
    observationId: capture.observationId,
    width: capture.width,
    height: capture.height,
    sha256: capture.sha256,
    usable: capture.usable,
    marks: capture.marks,
    omitted: capture.omitted,
    ...(capture.artifactPath === undefined ? {} : { artifactPath: capture.artifactPath }),
  };
}

/**
 * A settle budget widening, reported on the surface that performed it:
 * `fromMs` is the original budget, `toMs` is the widened budget adopted in
 * place (the session's new effective budget), and `cause` distinguishes the
 * two widening paths.
 */
export interface QaSettleWidened {
  fromMs: number;
  toMs: number;
  /**
   * Why the budget widened: `'unstable'` (a settle window still churning at
   * the budget) or `'assertion-retry'` (a positive-existence assertion retry
   * that exhausted its budget without finding its target). ADDITIVE:
   * schemaVersion stays 1.
   */
  cause: 'unstable' | 'assertion-retry';
}

/**
 * Outcome of one bounded settle window (see session/settle.ts). `stable` is
 * true only when two CONSECUTIVE observations had an identical semantic
 * projection; false means the view kept changing until the budget ran out and
 * every caller must fail closed on it.
 */
export interface QaSettleReport {
  stable: boolean;
  /** Observations taken inside the window (always at least 1). */
  passes: number;
  elapsedMs: number;
  /** The budget the window ran under, for honest reporting. */
  budgetMs: number;
  /**
   * The quiet requirement the window concluded under (see session/settle.ts):
   * quietMs before any (unmasked) change was observed, postChangeQuietMs once
   * the awaited change had been seen. Reported so callers/tests can see which
   * rule applied.
   */
  quietRequiredMs: number;
  /**
   * Non-null exactly when THIS window widened the budget in place (once per
   * session): the view was still churning at `budgetMs`, so the window kept
   * polling the same projection until `toMs` instead of returning stable:false.
   */
  widened: QaSettleWidened | null;
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

/** Closed scroll direction vocabulary shared by both drivers. */
export type QaScrollDirection = 'up' | 'down';

/**
 * v0.1 action union. Browser flavors (fill/press/navigate/scroll/select/hover)
 * and computer flavors (focus/type/key/scroll) share the union; the session
 * core forwards the action opaquely to the driver-specific adapter, which
 * rejects the kinds it does not support. Scroll has three disjoint shapes:
 * browser scroll-into-view (ref only), browser viewport scroll (direction
 * only), and computer container scroll (ref + direction). `select` and
 * `hover` are browser-only and are rejected by the computer adapter with a
 * driver-naming error rather than being silently dropped.
 */
export type QaAction =
  | { kind: 'click'; ref: string }
  | { kind: 'fill'; ref: string; text: string }
  | { kind: 'press'; ref: string; key: string }
  | { kind: 'navigate'; url: string }
  | { kind: 'focus'; ref: string }
  | { kind: 'type'; ref: string; text: string }
  | { kind: 'key'; ref: string; key: string; modifiers?: readonly string[] }
  /** Browser: scroll the referenced element into view (center-ish). */
  | { kind: 'scroll'; ref: string }
  /** Browser: viewport scroll without a target, for exploratory paging. */
  | { kind: 'scroll'; direction: QaScrollDirection; amount?: 'page' | number }
  /** Computer: scroll the container of the referenced element in a direction. */
  | { kind: 'scroll'; ref: string; direction: QaScrollDirection; amount?: 'line' | 'page' | number }
  /** Browser: select an option in a native <select> by label or value. */
  | { kind: 'select'; ref: string; option: string }
  /** Browser: move the pointer over the element and keep it there. */
  | { kind: 'hover'; ref: string };

export interface QaDriverAdapter {
  readonly kind: 'browser' | 'computer';
  start(ownerId: string, options?: QaStartOptions): Promise<QaSessionInfo>;
  observe(ownerId: string, options?: QaObserveOptions): Promise<QaObservation>;
  act(ownerId: string, action: QaAction, approval?: QaApprovalGate): Promise<QaActionReceipt>;
  evidence(ownerId: string, options?: QaEvidenceOptions): Promise<QaEvidence>;
  /** Optional unified visual capture (browser + computer). */
  visualObserve?(ownerId: string, options?: QaVisualObserveOptions): Promise<QaVisualCapture>;
  /**
   * Optional PASSIVE notification that the session core just closed a bounded
   * settle window over observe(). It exists so the Explore recorder can bind
   * the SETTLED observation (not the first, racing one) as an action's proof
   * and record whether it settled at all. Real drivers never implement it, it
   * must never throw, and it can never change driver behavior.
   */
  noteSettle?(ownerId: string, report: QaSettleReport): void;
  /**
   * Optional PASSIVE notification of the session's RESOLVED settle policy (the
   * exact values every proof observation runs under). It exists so the Explore
   * recorder can persist that policy into the exported scenario's meta.settle.
   * Real drivers never implement it, it must never throw, and it can never
   * change driver behavior.
   */
  noteSettlePolicy?(ownerId: string, policy: QaSettlePolicy): void;
  /**
   * Optional PASSIVE notification, implemented only by the Explore recording
   * adapter. The session core calls it exactly once when it accepted the ONE
   * bounded budget-escalated observation taken after a scroll-by-ref (see
   * QaSession.act) as that action's proof observation: the recorder re-binds
   * the action's proof to the fuller observation so export can evaluate the
   * node-in-viewport proof against it. Its PRESENCE is also the capability
   * gate — the session core never escalates through an adapter that does not
   * implement it, so Replay's plain adapters (and therefore replay behaviour)
   * are untouched. It must never throw and can never change driver behavior.
   */
  noteEscalatedScrollProof?(ownerId: string): void;
  stop(ownerId: string): Promise<QaStopResult>;
  dispose?(): Promise<void>;
}
