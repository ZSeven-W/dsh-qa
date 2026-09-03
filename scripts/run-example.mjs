// Runs the shipped example scenario end to end against the shipped web
// fixture. This is the documented "run the example" command for a normal
// install (QA-BL-001): it needs NO files from this repository's working tree.
//
//   npm run example
//   # or, from any directory where the package is installed:
//   node node_modules/@zseven-w/dsh-qa/scripts/run-example.mjs [--output-dir <dir>]
//
// Flow:
//   1. serve fixtures/web/ on an ephemeral 127.0.0.1 port (never the hardcoded
//      7399 the scenario carries as an example default);
//   2. load scenarios/examples/fixture-web.json through the fail-closed loader;
//   3. rebind target.launch to that ephemeral origin via ReplayRunOptions
//      .launchUrl (the loader accepts any http(s) URL, so the substitution is
//      done at run time, not by weakening validation);
//   4. replay headlessly through @zseven-w/dsh-browser (installed alongside,
//      exactly as the DSH host provides it);
//   5. write report.json / report.md / report.jsonl and print the status line
//      plus the report paths. Exit code 0 iff status === "pass".

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenOnEphemeralPort, startExampleServer } from './serve-example-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIO_PATH = join(ROOT, 'scenarios', 'examples', 'fixture-web.json');

function parseArgs(argv) {
  const args = { outputDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--output-dir') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--output-dir requires a path');
      }
      args.outputDir = resolve(next);
      i += 1;
    } else {
      throw new Error('unexpected argument: ' + argv[i]);
    }
  }
  return args;
}

async function loadBrowserDriver() {
  try {
    return await import('@zseven-w/dsh-browser');
  } catch (error) {
    if (error instanceof Error && error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'Cannot run the example: @zseven-w/dsh-browser is not installed. ' +
        'Install it alongside this plugin (the DSH host normally provides it), then retry. ' +
        'Underlying error: ' + error.message,
      );
    }
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(SCENARIO_PATH)) {
    throw new Error(
      'the shipped example scenario is missing: ' + SCENARIO_PATH + ' was not found. ' +
      'This package was published without its scenarios/ directory.',
    );
  }

  const [browser, lib] = await Promise.all([
    loadBrowserDriver(),
    import('../lib/index.js'),
  ]);
  const { BrowserManager } = browser;
  const { BrowserAdapter, runScenario, loadScenarioFromPath, writeReports } = lib;

  const scenario = loadScenarioFromPath(SCENARIO_PATH);

  const { server } = startExampleServer();
  const port = await listenOnEphemeralPort(server);
  const origin = 'http://127.0.0.1:' + port;
  console.log('[example] serving fixtures/web on ' + origin);

  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-qa-example-browser-'));
  const driver = new BrowserManager({ rootDir, allowedOrigins: [origin] });
  const adapter = new BrowserAdapter(driver);

  const reportDir = args.outputDir ?? join(process.cwd(), 'dsh-qa-example-report');
  try {
    const report = await runScenario(scenario, adapter, {
      headless: true,
      launchUrl: origin,
    });
    const paths = await writeReports(report, { directory: reportDir });
    console.log('[example] scenario: ' + scenario.meta.name);
    console.log('[example] status: ' + report.status);
    console.log('[example] report: ' + paths.json);
    console.log('[example] report: ' + paths.markdown);
    console.log('[example] report: ' + paths.jsonl);
    return report.status === 'pass' ? 0 : 1;
  } finally {
    await driver.dispose().catch(() => {});
    server.closeAllConnections?.();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    rmSync(rootDir, { recursive: true, force: true });
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error('[example] FAILED: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
