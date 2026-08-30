export { toLosslessJson, type JsonValue } from './lossless.ts';
export type {
  QaAction,
  QaActionReceipt,
  QaApprovalGate,
  QaApprovalOutcome,
  QaComputerAppIdentity,
  QaComputerEvidence,
  QaComputerHelperStatus,
  QaComputerWindowIdentity,
  QaDriverAdapter,
  QaEvidence,
  QaEvidenceOptions,
  QaObservation,
  QaObserveOptions,
  QaPageRef,
  QaReceiptStatus,
  QaSemanticNode,
  QaSessionInfo,
  QaStartOptions,
  QaStopResult,
  QaVisualCapture,
  QaVisualCaptureInfo,
  QaVisualObserveOptions,
} from './adapter.ts';
export { toVisualCaptureInfo } from './adapter.ts';
export {
  captureLatestVisual,
  QaSession,
  QaSessionManager,
  type QaActOutcome,
  type QaActResult,
} from './session.ts';
