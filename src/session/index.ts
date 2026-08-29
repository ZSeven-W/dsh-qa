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
} from './adapter.ts';
export {
  QaSession,
  QaSessionManager,
  type QaActOutcome,
  type QaActResult,
} from './session.ts';
