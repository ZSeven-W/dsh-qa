// dsh-qa library entry. WP2 ships the QA session core + browser adapter;
// WP4 adds the Replay runner, fail-closed scenario loader, and reporters.
// Contracts remain the shared type vocabulary every package compiles against.
export {
  QA_ADVISORY_REASONING_TRUST,
  QA_DRIVERS,
  QA_INCONCLUSIVE_TRUNCATED,
  QA_TOOL_NAMES,
  type QaAdvisoryReasoningTrust,
  type QaInconclusiveReason,
  type QaViewCompleteness,
  type QaDriverKind,
  type QaScenario,
  type QaScenarioMeta,
  type QaScenarioTarget,
  type QaNodePredicate,
  type QaScenarioAction,
  type QaStep,
  type QaAssertion,
  type QaAssertionKind,
  type QaVisualAssertion,
  type QaAdvisoryResult,
  type QaRunReport,
  type QaRunStatus,
  type QaStepResult,
  type QaAssertionResult,
  type QaObservedNode,
  type QaReproductionStep,
  type QaRunFailure,
} from './contracts.ts';
export * from './session/index.ts';
export * from './adapters/index.ts';
export * from './explore/index.ts';
export * from './replay/index.ts';
export * from './reporters/index.ts';
export * from './redaction/index.ts';
export * from './loginState.ts';
export * from './vision.ts';
