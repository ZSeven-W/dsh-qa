import { projectRedactedJsonValue, redactText, type RedactionRoots } from '../redaction/index.ts';
import type { QaRunReport } from '../contracts.ts';

// Backtick character for inline code spans (built from a code point so the
// source stays free of markdown-confusable delimiters).
const TICK = String.fromCharCode(96);

function inline(value: unknown, roots?: RedactionRoots): string {
  return JSON.stringify(projectRedactedJsonValue(value, roots));
}

/** Deterministic, redacted report.md content (human-readable). */
export function renderReportMarkdown(report: QaRunReport, roots?: RedactionRoots): string {
  const md = (text: string) => redactText(text, roots);
  const lines: string[] = [];
  lines.push('# QA Replay: ' + md(report.scenario));
  lines.push('');
  lines.push('- **Status**: ' + md(report.status));
  lines.push('- **Driver**: ' + md(report.driver));
  lines.push('- **Schema**: ' + String(report.schemaVersion));
  lines.push('- **Started**: ' + md(report.startedAt));
  lines.push('- **Finished**: ' + md(report.finishedAt));
  lines.push('');
  lines.push('## Steps');
  if (report.steps.length === 0) lines.push('- (none)');
  for (const step of report.steps) {
    const mark = step.status === 'pass' ? 'PASS' : 'FAIL';
    lines.push('- [' + mark + '] step ' + String(step.index) + ': ' + md(step.intent));
    lines.push('  - action: ' + TICK + md(inline(step.action, roots)) + TICK);
    lines.push('  - receipt: ' + md(step.receipt === null ? 'none' : step.receipt.status));
    lines.push('  - assertion: ' + md(step.assertion.kind) + ' -> ' + (step.assertionPassed ? 'PASS' : 'FAIL'));
    lines.push('  - observed: ' + TICK + md(inline(step.observed, roots)) + TICK);
  }
  lines.push('');
  lines.push('## Final assertions');
  if (report.assertions.length === 0) lines.push('- (none)');
  for (const assertion of report.assertions) {
    lines.push(
      '- ' + md(assertion.kind) + ' -> ' + (assertion.passed ? 'PASS' : 'FAIL') +
      ' (observed: ' + TICK + md(inline(assertion.observed, roots)) + TICK + ')',
    );
  }
  if (report.failure !== undefined) {
    lines.push('');
    lines.push('## Failure');
    lines.push('- step: ' + (report.failure.stepIndex === null ? 'final assertion' : String(report.failure.stepIndex)));
    lines.push('- message: ' + md(report.failure.message));
    lines.push('- reproduction: ' + String(report.failure.reproduction.length) + ' step(s)');
  }
  lines.push('');
  return lines.join('\n');
}
