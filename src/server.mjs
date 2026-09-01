// MCP stdio server exposing the dsh-qa tool surface to Claude Code / Codex.
// WP2: qa_session_start / qa_observe / qa_act / qa_evidence / qa_session_stop
// are wired to the QA session core + browser adapter. WP4: qa_assert and
// qa_replay_run are wired to the Replay runner + assertions. WP5: qa_session_start
// takes a driver selector and the same session tools serve the computer driver.
// WP6 records every Explore trajectory and exports it through the same
// fail-closed Replay loader used by qa_replay_run.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserAdapter } from './adapters/browser.ts';
import { ComputerAdapter } from './adapters/computer.ts';
import { BROWSER_DRIVER_SPECIFIER, loadBrowserManager } from './adapters/loadBrowser.ts';
import { loadComputerDriver } from './adapters/loadComputer.ts';
import { QA_ADVISORY_REASONING_TRUST } from './contracts.ts';
import {
  exportRecordedScenario,
  QaTrajectoryRecorder,
  RecordingQaDriverAdapter,
} from './explore/index.ts';
import { decideAssertion, loadScenarioFromPath, runScenario, sessionReobserve, validateAssertion } from './replay/index.ts';
import { writeReports } from './reporters/index.ts';
import { captureLatestVisual, QaSessionManager, toLosslessJson } from './session/index.ts';
import { toVisualCaptureInfo } from './session/adapter.ts';
import { evaluateVisualQuestion, persistCaptureFile } from './vision.ts';

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
const recorder = new QaTrajectoryRecorder();

async function getManager(kind) {
  if (!managers[kind]) {
    managers[kind] = (async () => {
      if (kind === 'browser') {
        const browserManager = await loadBrowserManager();
        return new QaSessionManager(new RecordingQaDriverAdapter(
          new BrowserAdapter(browserManager),
          recorder,
        ));
      }
      const computerDriver = await loadComputerDriver();
      return new QaSessionManager(new RecordingQaDriverAdapter(
        new ComputerAdapter(computerDriver),
        recorder,
      ));
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

// The MCP server has no host llm/attachments services, so visual capture runs
// the same path (capture + on-disk artifact) but the verdict always degrades
// to 'unclear' with reason 'vision-model-unavailable' instead of failing.
const MCP_CAPTURES_DIR = join(tmpdir(), 'dsh-qa-mcp-visual-captures');

async function captureVisualMCP(session, options) {
  const capture = await captureLatestVisual(session, options);
  const artifactPath = await persistCaptureFile(capture, MCP_CAPTURES_DIR);
  return { capture, artifactPath };
}

async function assertVisualMCP(owner, session, question) {
  const { capture, artifactPath } = await captureVisualMCP(session);
  const finding = await evaluateVisualQuestion(question, capture, undefined);
  recorder.visualFinding(owner, {
    question,
    verdict: finding.verdict,
    confidence: finding.confidence,
    reasoning: finding.reasoning,
  });
  return {
    ok: true,
    kind: 'visual',
    question,
    verdict: finding.verdict,
    confidence: finding.confidence,
    // Same trust contract as the cordis tool layer: verdict + confidence are
    // the answer, reasoning is unverified model narration.
    reasoning: finding.reasoning,
    reasoningTrust: QA_ADVISORY_REASONING_TRUST,
    ...(finding.reason === undefined ? {} : { reason: finding.reason }),
    artifact: { path: artifactPath, kind: 'screenshot' },
  };
}

async function captureVisualEvidenceMCP(session, options) {
  const { capture, artifactPath } = await captureVisualMCP(session, options);
  const info = toVisualCaptureInfo(capture);
  return { ...info, artifactPath };
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

server.tool(
  'qa_session_start',
  'Start one QA session for this agent scope. Choose a browser or computer driver; the chosen driver is bound to the owner for the session and loaded lazily on first use. Browser sessions accept an optional login_state: OWNER-AUTHORIZED, SCOPED, READ-ONLY login-state injection from an explicit Playwright storageState JSON file. Only entries whose origin/domain exactly matches the authorized origins are injected into a FRESH ephemeral profile (destroyed on stop); entries outside the list are never loaded, and a file that fails to parse, has no authorized entries, or holds unclassifiable entries fails the start. login_state is browser-only.',
  {
    owner: z.string().optional(),
    driver: z.enum(['browser', 'computer']).optional(),
    url: z.string().optional(),
    headless: z.boolean().optional(),
    bundle_id: z.string().optional(),
    pid: z.number().int().optional(),
    window_number: z.number().int().optional(),
    window_title: z.string().optional(),
    login_state: z.object({
      source: z.string(),
      origins: z.array(z.string()),
    }).optional(),
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
      ...(args.login_state === undefined ? {} : { loginState: args.login_state }),
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
    // Settled (observe until two consecutive semantic views agree), exactly
    // like the export/replay proof observations.
    const settled = await manager.session(owner).observeSettled({
      ...(args.max_nodes === undefined ? {} : { maxNodes: args.max_nodes }),
      ...(args.max_depth === undefined ? {} : { maxDepth: args.max_depth }),
      ...(args.ttl_ms === undefined ? {} : { ttlMs: args.ttl_ms }),
    });
    return textResult({
      ...settled.observation,
      settle: { stable: settled.stable, passes: settled.passes, budgetMs: settled.budgetMs },
    });
  }),
);

function scrollAmountFor(value, allowLine) {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('qa_act scroll amount must be a finite non-negative number');
    }
    return value;
  }
  if (value === 'page') return 'page';
  if (allowLine && value === 'line') return 'line';
  throw new Error('qa_act scroll amount must be "page"' + (allowLine ? ', "line",' : '') + ' or a finite non-negative number');
}

server.tool(
  'qa_act',
  {
    owner: z.string().optional(),
    action: z.enum(['click', 'fill', 'press', 'navigate', 'focus', 'type', 'key', 'scroll', 'select', 'hover']),
    ref: z.string().optional(),
    text: z.string().optional(),
    key: z.string().optional(),
    url: z.string().optional(),
    modifiers: z.array(z.string()).optional(),
    direction: z.enum(['up', 'down']).optional(),
    amount: z.union([z.string(), z.number()]).optional(),
    option: z.string().optional(),
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
    } else if (args.action === 'navigate') {
      if (args.url === undefined) throw new Error('qa_act navigate requires url');
      action = { kind: 'navigate', url: args.url };
    } else if (args.action === 'scroll') {
      if (args.direction !== undefined && args.direction !== 'up' && args.direction !== 'down') {
        throw new Error('qa_act scroll direction must be "up" or "down"');
      }
      if (args.ref !== undefined && args.direction !== undefined) {
        const amount = scrollAmountFor(args.amount, true);
        action = {
          kind: 'scroll',
          ref: args.ref,
          direction: args.direction,
          ...(amount === undefined ? {} : { amount }),
        };
      } else if (args.ref !== undefined) {
        action = { kind: 'scroll', ref: args.ref };
      } else if (args.direction !== undefined) {
        const amount = scrollAmountFor(args.amount, false);
        action = {
          kind: 'scroll',
          direction: args.direction,
          ...(amount === undefined ? {} : { amount }),
        };
      } else {
        throw new Error('qa_act scroll requires ref and/or direction');
      }
    } else if (args.action === 'select') {
      if (args.ref === undefined || args.option === undefined || args.option.trim() === '') {
        throw new Error('qa_act select requires ref and a non-empty option');
      }
      action = { kind: 'select', ref: args.ref, option: args.option };
    } else {
      if (args.ref === undefined) throw new Error('qa_act hover requires ref');
      action = { kind: 'hover', ref: args.ref };
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
    visual: z.boolean().optional(),
    visual_fingerprint: z.string().optional(),
    visual_full_page: z.boolean().optional(),
    visual_max_marks: z.number().int().optional(),
    visual_scale: z.number().int().optional(),
  },
  guard(async (args) => {
    const owner = ownerFrom(args);
    const manager = await managerForOwner(owner);
    const session = manager.session(owner);
    const evidence = await session.evidence({
      ...(args.max_console === undefined ? {} : { maxConsole: args.max_console }),
      ...(args.max_network === undefined ? {} : { maxNetwork: args.max_network }),
      ...(args.max_receipts === undefined ? {} : { maxReceipts: args.max_receipts }),
    });
    if (args.visual !== true) return textResult(evidence);
    const visual = await captureVisualEvidenceMCP(session, {
      ...(args.visual_fingerprint === undefined ? {} : { fingerprint: args.visual_fingerprint }),
      ...(args.visual_full_page === undefined ? {} : { fullPage: args.visual_full_page }),
      ...(args.visual_max_marks === undefined ? {} : { maxMarks: args.visual_max_marks }),
      ...(args.visual_scale === undefined ? {} : { scale: args.visual_scale }),
    });
    return textResult({ ...evidence, visual });
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
    kind: z.enum(['node-present', 'node-absent', 'page-url', 'node-in-viewport', 'node-value', 'visual']),
    expected: z.unknown().optional(),
    question: z.string().optional(),
  },
  guard(async (args) => {
    const owner = ownerFrom(args);
    const manager = await managerForOwner(owner);
    const session = manager.session(owner);
    if (args.kind === 'visual') {
      if (typeof args.question !== 'string' || args.question.trim() === '') {
        throw new Error('qa_assert visual requires a non-empty question');
      }
      return textResult(await assertVisualMCP(owner, session, args.question));
    }
    // Fail-closed: validate the assertion shape before touching the session.
    const assertion = validateAssertion({ kind: args.kind, expected: args.expected }, 'qa_assert');
    const settled = await session.observeSettled();
    // A truncated view can never prove an absence (and never disprove a
    // presence): the decision escalates the node budget once and fails closed
    // with INCONCLUSIVE_TRUNCATED rather than reporting a false green.
    const decision = await decideAssertion(assertion, settled.observation, sessionReobserve(session));
    return textResult({
      ok: true,
      passed: decision.passed,
      kind: assertion.kind,
      observed: decision.observed,
      expected: assertion.expected,
      settle: { stable: settled.stable, passes: settled.passes, budgetMs: settled.budgetMs },
      ...(decision.completeness === null ? {} : { completeness: decision.completeness }),
    });
  }),
);

server.tool(
  'qa_record_export',
  {
    owner: z.string().optional(),
    output_path: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    overwrite: z.boolean().optional(),
  },
  guard(async (args) => {
    const result = await exportRecordedScenario(recorder, ownerFrom(args), {
      outputPath: args.output_path,
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }),
    });
    return textResult(result);
  }),
);

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
