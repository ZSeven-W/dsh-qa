// Core dsh-qa v0.1 contracts. Scenario/step/assertion shapes are finalized in
// the Replay work package; these type definitions are the shared vocabulary
// every work package compiles against, matching the owner-approved plan
// (QaScenario = { meta, target, steps[], assertions[] }, lossless JSON only).

export type QaDriverKind = 'browser' | 'computer';

/** Driver kinds dsh-qa v0.1 targets, in adapter registration order. */
export const QA_DRIVERS = ['browser', 'computer'] as const;

/** The MCP tool surface the Explore agent drives; fixed for v0.1. */
export const QA_TOOL_NAMES = [
  'qa_session_start',
  'qa_observe',
  'qa_act',
  'qa_assert',
  'qa_evidence',
  'qa_record_export',
  'qa_replay_run',
  'qa_session_stop',
] as const;

export interface QaScenarioMeta {
  name: string;
  description: string;
  driver: QaDriverKind;
  /** Creation timestamp of the scenario file (ISO 8601). */
  createdAt: string;
}

export interface QaScenarioTarget {
  /** How the driver reaches the app under test (fixture URL or app bundle id). */
  launch: string;
}

export interface QaStep {
  index: number;
  action: string;
  /** Driver-native action payload (lossless JSON only). */
  argument: unknown;
  /** Natural-language intent recorded by Explore; Replay asserts on it. */
  intent: string;
}

export interface QaAssertion {
  index: number;
  kind: string;
  /** Expected observation fragment (lossless JSON only). */
  expected: unknown;
}

export interface QaScenario {
  meta: QaScenarioMeta;
  target: QaScenarioTarget;
  steps: QaStep[];
  assertions: QaAssertion[];
}

export interface QaRunReport {
  schemaVersion: 1;
  scenario: string;
  status: 'pass' | 'fail' | 'blocked';
  startedAt: string;
  finishedAt: string;
}
