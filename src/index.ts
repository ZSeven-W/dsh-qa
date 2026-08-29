// dsh-qa library entry. The QA session core, adapters, replay runner, explore
// tooling, and reporters land in later v0.1 work packages; contracts are
// already exported so the type surface is visible from day one.
export {
  QA_DRIVERS,
  QA_TOOL_NAMES,
  type QaDriverKind,
  type QaScenario,
  type QaStep,
  type QaAssertion,
  type QaRunReport,
} from './contracts.ts';
