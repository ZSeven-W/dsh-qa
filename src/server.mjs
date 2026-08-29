// MCP stdio server exposing the dsh-qa tool surface to Claude Code / Codex.
// WP2: qa_session_start / qa_observe / qa_act / qa_evidence / qa_session_stop
// are wired to the QA session core + browser adapter. WP4: qa_assert and
// qa_replay_run are wired to the Replay runner + assertions. WP5: qa_session_start
// takes a driver selector and the same session tools serve the computer driver.
// qa_record_export lands in WP6 (Explore).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserAdapter } from './adapters/browser.ts';
import { ComputerAdapter } from './adapters/computer.ts';
import { BROWSER_DRIVER_SPECIFIER, loadBrowserManager } from './adapters/loadBrowser.ts';
import { loadComputerDriver } from './adapters/loadComputer.ts';
import { evaluateAssertion, loadScenarioFromPath, runScenario, validateAssertion } from './replay/index.ts';
import { writeReports } from './reporters/index.ts';
import { QaSessionManager, toLosslessJson } from './session/index.ts';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = readVersion();
const server = new McpServer({ name: 'dsh-qa', version: VERSION });

// One QA session per plugin process; the optional owner argument lets a later
// Work Package multiplex distinct agent scopes without changing this shape.
const DEFAULT_OWNER = 'dsh-qa';

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(toLosslessJson(value)) }] };
}

// Lazily construct one session manager per driver. The sibling drivers are
// kept external in the bundle and resolved only when a qa_* tool actually
// runs, so a node_modules-free plugin copy still serves initialize and
// tools/list without them. Each owner's driver is chosen once at
// qa_session_start and remembered so observe/act/evidence/stop stay consistent.
const managers = { browser: undefined, computer: undefined };
const ownerDrivers = new Map();

async function getManager(kind) {
  if (!managers[kind]) {
    managers[kind] = (async () => {
      if (kind === 'browser') {
        const browserManager = await loadBrowserManager();
        return new QaSessionManager(new BrowserAdapter(browserManager));
      }
      const computerDriver = await loadComputerDriver();
      return new QaSessionManager(new ComputerAdapter(computerDriver));
    })();
    managers[kind] = managers[kind].catch((error) => {
      managers[kind] = undefined;
      throw error;
    });
  }
  return managers[kind];
}

async function managerForOwner(owner) {
  return getManager(ownerDrivers.get(owner) ?? 'browser');
}

function ownerFrom(args) {
  const raw = args && typeof args.owner === 'string' ? args.owner : DEFAULT_OWNER;
  const owner = raw.trim();
  if (owner === '') throw new Error('owner must not be empty');
  return owner;
}

function guard(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult({ ok: false, error: message });
    }
  };
}

function stubFor(tool, workPackage) {
  return () => textResult({ ok: false, error: `tool ${tool} is not implemented yet (planned for ${workPackage})` });
}

server.tool(
  'qa_session_start',
  {
    owner: z.string().optional(),
    driver: z.enum(['browser', 'computer']).optional(),
    url: z.string().optional(),
    headless: z.boolean().optional(),
    bundle_id: z.string().optional(),
    pid: z.number().int().optional(),
    window_number: z.number().int().optional(),
    window_title: z.string().optional(),
  },
  guard(async (args) => {
    const owner = ownerFrom(args);
    const driver = args.driver ?? 'browser';
    ownerDrivers.set(owner, driver);
    const manager = await getManager(driver);
    const info = await manager.session(owner).start({
      ...(args.url === undefined ? {} : { url: args.url }),
      ...(args.headless === undefined ? {} : { headless: args.headless }),
      ...(args.bundle_id === undefined ? {} : { bundleId: args.bundle_id }),
      ...(args.pid === undefined ? {} : { pid: args.pid }),
      ...(args.window_number === undefined ? {} : { windowNumber: args.window_number }),
      ...(args.window_title === undefined ? {} : { windowTitle: args.window_title }),
    });
    return textResult(info);
  }),
);

server.tool(
  'qa_observe',
  {
    owner: z.string().optional(),
    max_nodes: z.number().int().optional(),
    max_depth: z.number().int().optional(),
    ttl_ms: z.number().int().optional(),
  },
  guard(async (args) => {
    const owner = ownerFrom(args);
    const manager = await managerForOwner(owner);
    const observation = await manager.session(owner).observe({
      ...(args.max_nodes === undefined ? {} : { maxNodes: args.max_nodes }),
      ...(args.max_depth === undefined ? {} : { maxDepth: args.max_depth }),
      ...(args.ttl_ms === undefined ? {} : { ttlMs: args.ttl_ms }),
    });
    return textResult(observation);
  }),
);

server.tool(
  'qa_act',
  {
    owner: z.string().optional(),
    action: z.enum(['click', 'fill', 'press', 'navigate', 'focus', 'type', 'key']),
    ref: z.string().optional(),
    text: z.string().optional(),
    key: z.string().optional(),
    url: z.string().optional(),
    modifiers: z.array(z.string()).optional(),
  },
  guard(async (args) => {
    const owner = ownerFrom(args);
    const manager = await managerForOwner(owner);
    let action;
    if (args.action === 'click') {
      if (args.ref === undefined) throw new Error('qa_act click requires ref');
      action = { kind: 'click', ref: args.ref };
    } else if (args.action === 'fill') {
      if (args.ref === undefined || args.text === undefined) throw new Error('qa_act fill requires ref and text');
      action = { kind: 'fill', ref: args.ref, text: args.text };
    } else if (args.action === 'press') {
      if (args.ref === undefined || args.key === undefined) throw new Error('qa_act press requires ref and key');
      action = { kind: 'press', ref: args.ref, key: args.key };
    } else if (args.action === 'focus') {
      if (args.ref === undefined) throw new Error('qa_act focus requires ref');
      action = { kind: 'focus', ref: args.ref };
    } else if (args.action === 'type') {
      if (args.ref === undefined || args.text === undefined) throw new Error('qa_act type requires ref and text');
      action = { kind: 'type', ref: args.ref, text: args.text };
    } else if (args.action === 'key') {
      if (args.ref === undefined || args.key === undefined) throw new Error('qa_act key requires ref and key');
      action = {
        kind: 'key',
        ref: args.ref,
        key: args.key,
        ...(args.modifiers === undefined ? {} : { modifiers: args.modifiers }),
      };
    } else {
      if (args.url === undefined) throw new Error('qa_act navigate requires url');
      action = { kind: 'navigate', url: args.url };
    }
    const result = await manager.session(owner).act(action);
    return textResult(result);
  }),
);

server.tool(
  'qa_evidence',
  {
    owner: z.string().optional(),
    max_console: z.number().int().optional(),
    max_network: z.number().int().optional(),
    max_receipts: z.number().int().optional(),
  },
  guard(async (args) => {
    const owner = ownerFrom(args);
    const manager = await managerForOwner(owner);
    const evidence = await manager.session(owner).evidence({
      ...(args.max_console === undefined ? {} : { maxConsole: args.max_console }),
      ...(args.max_network === undefined ? {} : { maxNetwork: args.max_network }),
      ...(args.max_receipts === undefined ? {} : { maxReceipts: args.max_receipts }),
    });
    return textResult(evidence);
  }),
);

server.tool(
  'qa_session_stop',
  { owner: z.string().optional() },
  guard(async (args) => {
    const owner = ownerFrom(args);
    const manager = await managerForOwner(owner);
    const result = await manager.stop(owner);
    ownerDrivers.delete(owner);
    return textResult(result);
  }),
);

server.tool(
  'qa_assert',
  {
    owner: z.string().optional(),
    kind: z.enum(['node-present', 'node-absent', 'page-url']),
    expected: z.unknown(),
  },
  guard(async (args) => {
    // Fail-closed: validate the assertion shape before touching the session.
    const assertion = validateAssertion({ kind: args.kind, expected: args.expected }, 'qa_assert');
    const owner = ownerFrom(args);
    const manager = await managerForOwner(owner);
    const observation = await manager.session(owner).observe();
    const evaluation = evaluateAssertion(assertion, observation);
    return textResult({
      ok: true,
      passed: evaluation.passed,
      kind: assertion.kind,
      observed: evaluation.observed,
      expected: assertion.expected,
    });
  }),
);

server.tool('qa_record_export', {}, stubFor('qa_record_export', 'WP6 (Explore tooling)'));

server.tool(
  'qa_replay_run',
  {
    scenario: z.string(),
    owner: z.string().optional(),
    headless: z.boolean().optional(),
    outputDir: z.string().optional(),
  },
  guard(async (args) => {
    const scenario = loadScenarioFromPath(args.scenario);
    if (scenario.meta.driver !== 'browser') {
      return textResult({ ok: false, error: 'scenario driver is not supported yet (computer replay lands in a later WP)' });
    }
    let origin;
    try {
      origin = new URL(scenario.target.launch).origin;
    } catch {
      origin = undefined;
    }
    const browserManager = await loadBrowserManager(BROWSER_DRIVER_SPECIFIER, {
      allowedOrigins: origin === undefined ? undefined : [origin],
    });
    const adapter = new BrowserAdapter(browserManager);
    try {
      const report = await runScenario(scenario, adapter, {
        ownerId: ownerFrom(args),
        ...(args.headless === undefined ? {} : { headless: args.headless }),
        launchUrl: scenario.target.launch,
      });
      if (args.outputDir !== undefined) {
        await writeReports(report, { directory: args.outputDir });
      }
      return textResult(report);
    } finally {
      await browserManager.dispose();
    }
  }),
);

await server.connect(new StdioServerTransport());
