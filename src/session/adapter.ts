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
  /**
   * Browser-only (driver contract v9): the ref of the nearest ANCESTOR in the
   * composed tree that is itself an emitted node in the SAME observation;
   * null when none. Refs are re-minted per observation, so consumers compare
   * ancestry as a RELATIONSHIP (the parent's index within the same view),
   * never as raw ref strings across observations.
   */
  parentRef?: string | null;
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

/**
 * Per-observation coverage evidence (browser driver contract v9, Phase C):
 * the outcome of the driver's bounded CDP closed-shadow-root probe.
 *
 * verified === true is the ONLY evidence on which a consumer may read
 * truncated:false as "every semantic node of the observed subtree is in the
 * projection" — and therefore the only evidence on which a node-absent
 * assertion may PASS. It is true ONLY when the probe ran to completion
 * within its budgets AND found zero closed shadow roots. The computer driver
 * has no shadow DOM: its adapter reports this shape vacuously verified (see
 * ComputerAdapter), never synthesized per call.
 */
export interface QaCoverageEvidence {
  verified: boolean;
  /** Closed shadow roots found in the observed subtree. */
  closedShadowRoots: number;
  /** DOM nodes the probe walked before it finished or stopped. */
  probedNodes: number;
  /**
   * Why the probe is NOT verified evidence, absent on the two completed
   * outcomes. "skipped": verifyCoverage was not requested (ordinary polls).
   * "over-budget": the probe node (5,000) or time (250 ms) cap was hit.
   * "cdp-unavailable" / "root-unresolved" / "error": the probe could not run.
   */
  reason?: 'skipped' | 'over-budget' | 'cdp-unavailable' | 'root-unresolved' | 'error';
}

/**
 * Browser-only (driver contract v9): the identity anchor for the element the
 * driver last dispatched an action on — the ORIGINAL handle used for
 * dispatch, never a re-matched node. ref is that element's fresh ref in THIS
 * observation when it was emitted (null when the gate or a budget excluded
 * it); connected/contained stay truthful either way, and contained is null
 * for a whole-page observation.
 */
export interface QaObservationAnchor {
  ref: string | null;
  connected: boolean;
  contained: boolean | null;
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

// ---------------------------------------------------------------------------
// QA-BL-067 scroll-proof refusal vocabulary (completes QA-BL-058).
//
// Every non-acceptance exit of the record-time scoped/whole-page scroll-proof
// reads is DISCLOSED through `escalationRefused` with ONE of these fixed words
// (plus the driver's machine code when the driver threw). `already-in-viewport`
// is deliberately NOT a refusal: no escalation is needed, and the result then
// simply carries no escalation fields.
// ---------------------------------------------------------------------------

export type QaScrollProofRefusalReason =
  | 'target-not-in-baseline'
  | 'container-not-in-view'
  | 'escalated-window-unstable'
  | 'target-not-returned'
  | 'target-not-in-viewport'
  | 'anchor-not-connected'
  | 'anchor-not-contained'
  | 'anchor-unavailable'

export interface QaScrollProofRefusal {
  /** The fixed refusal vocabulary word (QA-BL-067). */
  reason: QaScrollProofRefusalReason;
  /** The driver's machine code when the driver THREW the refusal. */
  code?: string;
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

/**
 * Browser-only (driver contract v8): the root of a scoped observation, as the
 * driver observed it at resolution time. `ref` is the caller-passed within
 * ref (the driver echoes it back). Absent for whole-page observations and for
 * drivers that do not report a scope; when present, the observation's
 * truncation, budgets, and the iframe marker are SUBTREE-relative. NOTE
 * (QA-BL-052 / C2): subtree completeness alone does not prove absence — the
 * deciding observation must also carry `coverage.verified: true` (the
 * bounded closed-shadow-root probe, contract v9 Phase C), otherwise a
 * node-absent claim fails closed as UNPROVEN.
 */
export interface QaObservationScope {
  ref: string;
  /**
   * Browser-only (driver contract v9): a ref minted in THIS observation for
   * the root element — the ref that chains the NEXT scoped read. When the
   * root was emitted it equals that node's ref (the root is always nodes[0]
   * of a scoped view); when the visibility gate excluded the root, the root
   * may be absent from nodes while rootRef still binds it. Honest-optional:
   * absent on a pre-v9 driver — and then the QA layer can NOT re-chain the
   * scoped read and fails closed instead of re-matching by role+name+tag.
   */
  rootRef?: string;
  role: string;
  name: string;
  tag: string;
  /**
   * Browser-only (driver contract v9, dsh-browser 677cdc2): true when the
   * within resolution proceeded through an identity-EXEMPT name-only change
   * on a content-named container (the aggregated accessible name tracks
   * descendant text — Wikipedia's collapsible sidebar — while the element is
   * still the same node). The driver reports the change INFORMATIONALLY
   * instead of refusing TARGET_CHANGED, and `name` carries the NEW aggregated
   * name. Label-named nodes and non-container nodes keep the strict check
   * and never produce this flag. Honest-optional: absent means no
   * informational change was reported.
   */
  nameChanged?: true;
}
export interface QaObservation {
  page: QaPageRef;
  nodes: QaSemanticNode[];
  truncated: boolean;
  /**
   * Browser-only (driver contract v8): the scope root of a scoped observation
   * (see QaObservationScope). Honest-optional exactly like maxNodes /
   * truncationReasons: absent means the view was NOT scoped (a whole-page
   * observation, or a driver that reports no scope). When present, every
   * budget, the byte ceiling, the scan window, and the iframe marker are
   * subtree-relative, while each node's inViewport keeps whole-page
   * viewport-intersection meaning.
   */
  scope?: QaObservationScope;
  /**
   * The node budget the DRIVER actually applied (its own clamp), read from the
   * driver's limits report. Absent when the driver does not report limits.
   * This is the only honest number to report as "the" budget of the view: a
   * requested budget (e.g. the 500-node escalation) is a request, never a fact.
   */
  maxNodes?: number;
  /**
   * Names every reason the view is partial, in the DRIVER's own vocabulary
   * (browser: scan-window-exceeded | node-budget-exceeded |
   * byte-budget-exceeded | iframe-not-traversed). Present only when the driver
   * reported reasons; an absent field means "not reported", never "no
   * reasons". Never synthesized by the QA layer.
   */
  truncationReasons?: string[];
  /** Computer-only: opaque observation id required for visual capture. */
  observationId?: string;
  fingerprint?: string;
  app?: QaComputerAppIdentity;
  window?: QaComputerWindowIdentity;
  /**
   * Browser/computer coverage evidence for THIS observation (driver contract
   * v9, Phase C). This is the ONE source of truth for the absence gate:
   * coverage.verified === true — no closed shadow root exists in the
   * observed subtree — is the only evidence on which a node-absent assertion
   * may PASS on a complete view (QA-BL-052). Honest-optional: ABSENT means
   * the observation carries no coverage evidence at all (a pre-v9 driver, or
   * a test double), and a node-absent claim is then UNPROVEN — it fails
   * closed with COVERAGE_UNVERIFIED even on a complete view, scoped or
   * whole-page. The browser adapter projects the driver evidence verbatim;
   * the computer adapter reports it vacuously verified (no shadow DOM); the
   * QA layer never synthesizes it from anything else.
   */
  coverage?: QaCoverageEvidence;
  /**
   * Browser-only (driver contract v9): the identity anchor of the element
   * the driver last dispatched an action on, present exactly when the
   * observe requested anchorLastAction. Honest-optional: absent means no
   * anchor was requested or the driver reports none.
   */
  anchor?: QaObservationAnchor;
  /**
   * Browser-only (driver contract v9): count of semantic-selector matches
   * the visibility gate skipped (visibility:hidden, display:none,
   * opacity:0, zero/no client rects) within the scanned range. A diagnostic
   * of the observable-node projection, never a truncation reason.
   * Honest-optional: absent means the driver did not report a count.
   */
  hiddenMatches?: number;
  /**
   * Browser-only (driver contract v9): true whenever collection stopped
   * early (scan window, node budget, byte budget), i.e. hiddenMatches is a
   * LOWER BOUND of the subtree gate-skipped matches. False means the count
   * is exact. Honest-optional, always paired with hiddenMatches.
   */
  hiddenMatchesPartial?: boolean;
}

export interface QaActionReceipt {
  status: QaReceiptStatus;
  /** Stable driver rejection/failure code (e.g. EXTERNAL_COMMIT_TARGET, secure-text). */
  code?: string;
  reason?: string;
  dispatched: boolean;
  /**
   * Recorder-internal action identity, set ONLY by the Explore recording
   * adapter (never by a driver) so the session core can pass the EXACT
   * recorded action back through noteEscalatedScrollProof: the recorder then
   * re-binds exactly that action's proof observation instead of trusting
   * whatever action happened to settle most recently. Absent on receipts from
   * plain adapters (replay, test doubles), where the scroll-proof escalation
   * never runs anyway.
   */
  actionId?: string;
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
  /**
   * Browser-only (driver contract v8): restrict the observation to the
   * composed subtree rooted at this element. The value is an opaque ref from
   * the caller's CURRENT (latest, unexpired) observation; the driver resolves
   * it exactly as actions do and REJECTS an unknown, expired, consumed,
   * non-element, or detached ref — it never silently falls back to a
   * whole-page view. Budgets, the byte ceiling, the scan window, and the
   * iframe marker become subtree-relative, so a subtree that fits reports
   * truncated:false and a deep target unreachable whole-page becomes
   * reachable. NOTE (QA-BL-052): a complete scoped view only proves absence
   * when the deciding observation also carries coverage.verified === true.
   * The computer driver does not support scoping: a withinRef there is
   * REFUSED with a clear error, never silently ignored.
   */
  withinRef?: string;
  /**
   * Browser-only (driver contract v9, Phase C), INTERNAL: run the bounded
   * CDP closed-shadow-root coverage probe over the observed subtree and
   * report per-observation coverage evidence. Only the TERMINAL absence
   * decision requests this (its one bounded deciding re-observation);
   * ordinary settle polls never carry it. The computer adapter IGNORES it
   * explicitly (the accessibility tree has no shadow DOM).
   */
  verifyCoverage?: true;
  /**
   * Browser-only (driver contract v9), INTERNAL: request an identity anchor
   * for the element the driver last dispatched an action on (the ORIGINAL
   * handle). The record-time scoped scroll-proof escalation uses it; a
   * request without a retained action target REJECTS with ANCHOR_UNAVAILABLE.
   * The computer adapter IGNORES it explicitly.
   */
  anchorLastAction?: true;
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
   * Optional PASSIVE notification (QA-BL-067), implemented only by the Explore
   * recording adapter. The session core calls it exactly once per act whose
   * FINAL proof state carries an `escalationRefused` disclosure (the scoped
   * proof read refused for an action taken from a scoped baseline, or the ONE
   * scroll-proof escalation refused), passing the EXACT recorded action id so
   * the recorder can attach the refusal to THAT action: export then carries it
   * on the step (additive `escalationRefused`) and report.md prints it on the
   * step line. A null or non-matching action id is refused by the recorder and
   * recorded as a recording issue. It must never throw and can never change
   * driver behavior.
   */
  noteScrollProofRefusal?(ownerId: string, actionId: string | null, refusal: QaScrollProofRefusal): void;
  /**
   * Optional PASSIVE notification (QA-BL-067), implemented only by the Explore
   * recording adapter. The session core calls it exactly once per act when
   * the SCOPED proof attempt was REFUSED by the driver (the baseline root no
   * longer resolves — a HANDLED, disclosed refusal, never a recording
   * failure) and the proof is falling back to the whole-page read: the
   * recorder re-arms its settle-window state so the FALLBACK settle binds
   * exactly this action's proof, and clears the handled refusal from the
   * action's own issue marker. It must never throw and can never change
   * driver behavior.
   */
  noteScopedProofFallback?(ownerId: string, actionId: string | null): void;
  /**
   * Optional PASSIVE notification, implemented only by the Explore recording
   * adapter. The session core calls it exactly once when it accepted the ONE
   * bounded budget-escalated observation taken after a scroll-by-ref (see
   * QaSession.act) as that action's proof observation: the recorder re-binds
   * EXACTLY that action's proof (identified by the recorded action id the
   * recording adapter stamped onto the receipt) to the fuller observation, so
   * export can evaluate the node-in-viewport proof against it. A null or
   * non-matching action id is refused by the recorder and recorded as a
   * recording issue — never silently re-bound to another action. Its PRESENCE
   * is also the capability gate — the session core never escalates through an
   * adapter that does not implement it, so Replay's plain adapters (and
   * therefore replay behaviour) are untouched. It must never throw and can
   * never change driver behavior.
   */
  noteEscalatedScrollProof?(ownerId: string, actionId: string | null): void;
  stop(ownerId: string): Promise<QaStopResult>;
  dispose?(): Promise<void>;
}
