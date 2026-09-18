import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
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

/**
 * Owner-only. A report carries URLs, observed values, evidence paths and
 * advisory model narration; the redaction engine decides which bytes are safe
 * to emit, and this decides that they are not readable by everyone else on the
 * machine. Existing files keep their own mode — widening someone's permissions
 * is never this function's business.
 */
const REPORT_MODE = 0o600;

/**
 * Open one report sink under the discipline docs/REDACTION_SPEC.md requires:
 * a REGULAR file, opened without following a symlink at the final component,
 * created owner-only. The caller chooses the output directory, so the path can
 * legitimately be attacker- or accident-controlled: a symlink would deliver the
 * report somewhere else entirely, and a FIFO would block the run forever on a
 * reader that never arrives.
 *
 * `append` distinguishes the two sinks: report.json / report.md are the current
 * run and are replaced, while report.jsonl is an append-only log whose
 * pre-existing bytes must survive.
 */
async function openReportSink(path: string, append: boolean): Promise<Awaited<ReturnType<typeof open>>> {
  // O_NONBLOCK is load-bearing, not decoration: opening a FIFO for writing
  // blocks until a reader appears, so without it a report path that happens to
  // be a FIFO hangs the run forever instead of failing. With it the open
  // returns ENXIO immediately and the check below turns that into a refusal.
  const base = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const flags = append ? base | constants.O_APPEND : base | constants.O_TRUNC;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, flags, REPORT_MODE);
  } catch (error) {
    const code = (error as { code?: string }).code;
    // ELOOP: the final component is a symlink and O_NOFOLLOW refused it.
    // ENXIO/EOPNOTSUPP: some platforms report a FIFO or device this way.
    if (code === 'ELOOP' || code === 'ENXIO' || code === 'EOPNOTSUPP') {
      throw new Error(
        'refusing to write the report to ' + path + ': it is not a regular file (a symlink, FIFO or device'
        + ' would deliver the report somewhere the caller did not name). Remove it or choose another'
        + ' output directory. Underlying code: ' + String(code),
      );
    }
    throw error;
  }
  // O_NOFOLLOW only covers symlinks. A FIFO, socket or device opens fine and
  // would then block or silently discard, so the descriptor itself is checked.
  const info = await handle.stat();
  if (!info.isFile()) {
    await handle.close();
    throw new Error(
      'refusing to write the report to ' + path + ': it is not a regular file. Remove it or choose'
      + ' another output directory.',
    );
  }
  return handle;
}

async function writeSink(path: string, text: string, append: boolean): Promise<void> {
  const handle = await openReportSink(path, append);
  try {
    await handle.write(text);
  } finally {
    await handle.close();
  }
}

/** Emits report.json, report.md and an append-only report.jsonl for one run. */
export async function writeReports(report: QaRunReport, options: WriteReportsOptions): Promise<ReportOutputPaths> {
  await mkdir(options.directory, { recursive: true });
  const jsonPath = join(options.directory, 'report.json');
  const markdownPath = join(options.directory, 'report.md');
  const jsonlPath = options.jsonlPath ?? join(options.directory, 'report.jsonl');
  await writeSink(jsonPath, renderReportJson(report, options.roots), false);
  await writeSink(markdownPath, renderReportMarkdown(report, options.roots), false);
  await writeSink(jsonlPath, renderReportJsonl(report, options.roots), true);
  return { json: jsonPath, markdown: markdownPath, jsonl: jsonlPath };
}
