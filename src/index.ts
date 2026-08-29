// dsh-qa library entry. The QA session core and browser adapter are live in
// WP2; replay runner, explore tooling, and reporters land in later v0.1 work
// packages. Contracts remain the shared type vocabulary every package compiles
// against.
export {
  QA_DRIVERS,
  QA_TOOL_NAMES,
  type QaDriverKind,
  type QaScenario,
  type QaStep,
  type QaAssertion,
  type QaRunReport,
} from './contracts.ts';
export * from './session/index.ts';
export * from './adapters/index.ts';
