import { projectRedactedJsonValue, type RedactionRoots } from '../redaction/index.ts';
import type { QaRunReport } from '../contracts.ts';

/** Deterministic, redacted report.json content (pretty-printed, trailing LF). */
export function renderReportJson(report: QaRunReport, roots?: RedactionRoots): string {
  return JSON.stringify(projectRedactedJsonValue(report, roots), null, 2) + '\n';
}
