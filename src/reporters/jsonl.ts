import { appendFile } from 'node:fs/promises';
import { projectRedactedJsonValue, type RedactionRoots } from '../redaction/index.ts';
import type { QaRunReport } from '../contracts.ts';

/** One compact, redacted JSON object + LF, for the append-only report.jsonl. */
export function renderReportJsonl(report: QaRunReport, roots?: RedactionRoots): string {
  return JSON.stringify(projectRedactedJsonValue(report, roots)) + '\n';
}

export async function appendReportJsonl(
  report: QaRunReport,
  jsonlPath: string,
  roots?: RedactionRoots,
): Promise<void> {
  await appendFile(jsonlPath, renderReportJsonl(report, roots), 'utf8');
}
