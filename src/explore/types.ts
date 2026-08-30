import type { QaDriverKind, QaScenario } from '../contracts.ts';
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
  /** Present only for the session core's immediate fresh observation after act(). */
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

export interface QaTrajectoryRecordingErrorEvent {
  sequence: number;
  at: string;
  kind: 'recording-error';
  operation: 'start' | 'observation' | 'action' | 'receipt' | 'evidence' | 'stop' | 'visual';
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

/** An advisory visual finding recorded during Explore. */
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
  afterObservationId: string | null;
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
    | 'ASSERTION_NOT_PROVABLE';
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
