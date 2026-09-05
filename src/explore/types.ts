import type { QaDriverKind, QaScenario } from '../contracts.ts';
import type { QaSettlePolicy } from '../session/settle.ts';
import type {
  QaAction,
  QaActionReceipt,
  QaDriverAdapter,
  QaEvidence,
  QaObservation,
  QaSessionInfo,
  QaStartOptions,
  QaStopResult,
  QaVisualCaptureInfo,
} from '../session/adapter.ts';

export interface QaTrajectoryStartEvent {
  sequence: number;
  at: string;
  kind: 'start';
  driver: QaDriverKind;
  options: QaStartOptions;
  info: QaSessionInfo;
}

export interface QaTrajectoryObservationEvent {
  sequence: number;
  at: string;
  kind: 'observation';
  observationId: string;
  /**
   * Present only for the FIRST observation of the session core's bounded
   * post-action settle window. The action's proof is re-bound to the settled
   * (last) observation of that window; see QaTrajectorySettleEvent.
   */
  afterActionId: string | null;
  observation: QaObservation;
}

export interface QaTrajectoryActionEvent {
  sequence: number;
  at: string;
  kind: 'action';
  actionId: string;
  beforeObservationId: string | null;
  action: QaAction;
  /** True when redaction changed a replay-relevant action field. */
  payloadRedacted: boolean;
}

export interface QaTrajectoryReceiptEvent {
  sequence: number;
  at: string;
  kind: 'receipt';
  actionId: string;
  receipt: QaActionReceipt;
}

export interface QaTrajectoryEvidenceEvent {
  sequence: number;
  at: string;
  kind: 'evidence';
  evidenceId: string;
  evidence: QaEvidence;
}

export interface QaTrajectoryStopEvent {
  sequence: number;
  at: string;
  kind: 'stop';
  result: QaStopResult;
}

/**
 * One bounded settle window closed by the session core. `observationId` is the
 * SETTLED observation (the action's proof when `actionId` is set); `stable`
 * false means the view never stopped changing inside `budgetMs`.
 */
export interface QaTrajectorySettleEvent {
  sequence: number;
  at: string;
  kind: 'settle';
  /** The action this window proved, or null for a standalone observation. */
  actionId: string | null;
  observationId: string | null;
  stable: boolean;
  passes: number;
  budgetMs: number;
}

export interface QaTrajectoryRecordingErrorEvent {
  sequence: number;
  at: string;
  kind: 'recording-error';
  operation: 'start' | 'observation' | 'action' | 'receipt' | 'evidence' | 'stop' | 'visual' | 'settle';
  /** Redacted structural reason; raw payload bytes are never retained. */
  reason: string;
  actionId: string | null;
}

/** A visual capture recorded during Explore (metadata only, never the raw PNG). */
export interface QaTrajectoryVisualCaptureEvent {
  sequence: number;
  at: string;
  kind: 'visual-capture';
  capture: QaVisualCaptureInfo;
}

/**
 * An advisory visual finding recorded during Explore. `verdict`/`confidence`
 * are the model's answer; `reasoning` is unverified model narration that may
 * contain fabricated detail (see QA_ADVISORY_REASONING_TRUST in contracts.ts).
 * Export never carries it into a scenario: only the question becomes a note.
 */
export interface QaTrajectoryVisualFindingEvent {
  sequence: number;
  at: string;
  kind: 'visual-finding';
  question: string;
  verdict: 'yes' | 'no' | 'unclear';
  confidence: number;
  reasoning: string;
}

export type QaTrajectoryEvent =
  | QaTrajectoryStartEvent
  | QaTrajectoryObservationEvent
  | QaTrajectoryActionEvent
  | QaTrajectoryReceiptEvent
  | QaTrajectorySettleEvent
  | QaTrajectoryEvidenceEvent
  | QaTrajectoryVisualCaptureEvent
  | QaTrajectoryVisualFindingEvent
  | QaTrajectoryStopEvent
  | QaTrajectoryRecordingErrorEvent;

export interface QaRecordedAction {
  actionId: string;
  action: QaAction;
  beforeObservationId: string | null;
  receipt: QaActionReceipt | null;
  /** The SETTLED post-action observation (last one of the settle window). */
  afterObservationId: string | null;
  /**
   * Whether that settle window reached a stable semantic view. null means no
   * settle window was reported at all. Anything other than true is refused by
   * the exporter: an unstable view proves nothing.
   */
  afterObservationStable: boolean | null;
  payloadRedacted: boolean;
  recordingIssue: string | null;
}

/** Immutable, already-redacted view consumed by the exporter. */
export interface QaTrajectorySnapshot {
  schemaVersion: 1;
  driver: QaDriverKind;
  startedAt: string;
  launch: string;
  events: readonly QaTrajectoryEvent[];
  observations: Readonly<Record<string, QaObservation>>;
  actions: readonly QaRecordedAction[];
  evidenceReferences: readonly string[];
  visualFindings: readonly QaTrajectoryVisualFindingEvent[];
  recordingIssues: readonly string[];
  /** The session's resolved settle policy (null when no session ever started). */
  settlePolicy: QaSettlePolicy | null;
}

export interface QaExportExclusion {
  actionId: string;
  reason:
    | 'ACTION_REJECTED'
    | 'ACTION_FAILED'
    | 'ACTION_NOT_DISPATCHED'
    | 'ACTION_RECEIPT_MISSING'
    | 'FRESH_OBSERVATION_MISSING'
    | 'OBSERVATION_RECORDING_FAILED'
    | 'ACTION_PAYLOAD_REDACTED'
    | 'UNSUPPORTED_REPLAY_ACTION'
    | 'TARGET_OBSERVATION_MISSING'
    | 'TARGET_REF_NOT_FOUND'
    | 'TARGET_HAS_NO_ACCESSIBLE_NAME'
    | 'TARGET_NOT_UNIQUE'
    | 'ASSERTION_NOT_PROVABLE'
    | 'FRAGILE_PROOF_ONLY'
    /**
     * QA-BL-054: the proof observation was SCOPED but its container predicate
     * is not proven durable (not unique in a complete recorded baseline, or
     * no usable baseline). The step is excluded — a scoped proof is never
     * silently exported as a whole-page one.
     */
    | 'SCOPE_NOT_DURABLE';
  detail: string;
  receipt: QaActionReceipt | null;
}

export interface QaRecordExportOptions {
  outputPath: string;
  name?: string;
  description?: string;
  overwrite?: boolean;
  workspaceRoot?: string;
  tempRoot?: string;
}

export interface QaRecordExportSuccess {
  ok: true;
  artifact: { path: string; kind: 'scenario' };
  scenario: QaScenario;
  trajectory: {
    events: number;
    observations: number;
    actions: number;
    evidenceReferences: readonly string[];
  };
  excludedActions: readonly QaExportExclusion[];
}

export interface QaRecordExportFailure {
  ok: false;
  code: 'NO_TRAJECTORY' | 'DRIVER_NOT_REPLAYABLE' | 'NO_PROVEN_STEPS';
  error: string;
  excludedActions: readonly QaExportExclusion[];
}

export type QaRecordExportResult = QaRecordExportSuccess | QaRecordExportFailure;

/** Adapter wrapper is exported as a type anchor for downstream host tests. */
export type QaRecordingAdapter = QaDriverAdapter;
