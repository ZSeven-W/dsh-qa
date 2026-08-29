import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QaRunReport } from '../contracts.ts';
import type { RedactionRoots } from '../redaction/index.ts';
import { renderReportJson } from './json.ts';
import { renderReportJsonl } from './jsonl.ts';
import { renderReportMarkdown } from './markdown.ts';

export interface ReportOutputPaths {
  json: string;
  markdown: string;
  jsonl: string;
}

export interface WriteReportsOptions {
  directory: string;
  /** Defaults to <directory>/report.jsonl. Appended, never truncated. */
  jsonlPath?: string;
  roots?: RedactionRoots;
}

/** Emits report.json, report.md and an append-only report.jsonl for one run. */
export async function writeReports(report: QaRunReport, options: WriteReportsOptions): Promise<ReportOutputPaths> {
  await mkdir(options.directory, { recursive: true });
  const jsonPath = join(options.directory, 'report.json');
  const markdownPath = join(options.directory, 'report.md');
  const jsonlPath = options.jsonlPath ?? join(options.directory, 'report.jsonl');
  await writeFile(jsonPath, renderReportJson(report, options.roots), 'utf8');
  await writeFile(markdownPath, renderReportMarkdown(report, options.roots), 'utf8');
  await appendFile(jsonlPath, renderReportJsonl(report, options.roots), 'utf8');
  return { json: jsonPath, markdown: markdownPath, jsonl: jsonlPath };
}
