// MCP stdio server exposing the dsh-qa tool surface to Claude Code / Codex.
// This module owns the tool REGISTRATION and the per-server session state;
// src/server.mjs is now a thin entrypoint that constructs one and connects it
// to stdio. Keeping registration behind createQaMcpServer() lets tests drive
// the EXACT same tool handlers in-process over an InMemoryTransport with an
// injected fake driver loader, instead of spawning a real stdio subprocess
// (which would require the real sibling drivers / a macOS computer fixture).
//
// WP2: qa_session_start / qa_observe / qa_act / qa_evidence / qa_session_stop
// are wired to the QA session core + browser adapter. WP4: qa_assert and
// qa_replay_run are wired to the Replay runner + assertions. WP5: qa_session_start
// takes a driver selector and the same session tools serve the computer driver.
// WP6 records every Explore trajectory and exports it through the same
// fail-closed Replay loader used by qa_replay_run. WP6-closure: qa_replay_run
// routes all four driver kinds through the shared loadReplayDriver factory
// seam; session managers also cover iOS/Android lazily.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserAdapter } from './adapters/browser.ts';
import { ComputerAdapter } from './adapters/computer.ts';
import { loadBrowserManager } from './adapters/loadBrowser.ts';
import { loadComputerDriver } from './adapters/loadComputer.ts';
import { loadAndroidBackend } from './adapters/loadAndroid.ts';
import { loadIosBackend } from './adapters/loadIos.ts';
import { QA_ADVISORY_REASONING_TRUST, QA_INCONCLUSIVE_UNSTABLE } from './contracts.ts';
import { QA_TOOL_DESCRIPTIONS } from './tool-descriptions.ts';
import {
  exportRecordedScenario,
  QaTrajectoryRecorder,
  RecordingQaDriverAdapter,
} from './explore/index.ts';
import {
  decideAssertionWithRetry,
  loadReplayDriver,
  loadScenarioFromPath,
  runScenario,
  sessionReobserve,
  validateAssertion,
} from './replay/index.ts';
import type { ReplayDriverLoaders } from './replay/index.ts';
import { writeReports } from './reporters/index.ts';
import { captureLatestVisual, QaSessionManager, resolveSettlePolicy, settleStartOverride, toLosslessJson } from './session/index.ts';
import type { QaSession } from './session/index.ts';
import { toVisualCaptureInfo, type QaDriverAdapter, type QaVisualObserveOptions } from './session/adapter.ts';
import { evaluateVisualQuestion, persistCaptureFile } from './vision.ts';
import {
  buildVisualRuntimeActionFromMetadata,
  captureAndGroundVisualTarget,
  requireVisualPointBinding,
  validateVisualToolArgs,
  visualCaptureMetadata,
  QaVisualCaptureStore,
  assertCaptureBinding,
  type QaTrustedVisualCaptureMetadata,
} from './visual-action.ts';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

type QaDriverKind = 'browser' | 'computer' | 'ios' | 'android';

export interface QaMcpServerOptions {
  /** Injectable replay driver loaders (test/di seam), threaded into loadReplayDriver. */
  loaders?: ReplayDriverLoaders;
  /**
   * Injectable Explore session adapters (test/di seam). When an adapter is
   * present for a driver, qa_session_start/observe/act/evidence use it instead
   * of lazily loading the real sibling driver package. Additive and optional.
   */
  adapters?: Partial<Record<QaDriverKind, QaDriverAdapter>>;
}

interface QaMobileAdapterConstructor {
  new (backend: unknown): QaDriverAdapter;
}

async function loadMobileAdapterClass(kind: 'ios' | 'android'): Promise<QaMobileAdapterConstructor> {
  const barrel = await import('./adapters/index.ts');
  const exportName = kind === 'ios' ? 'IosAdapter' : 'AndroidAdapter';
  const ctor = (barrel as unknown as Record<string, unknown>)[exportName];
  if (typeof ctor !== 'function') {
    throw new Error('Cannot load the ' + kind + ' QA adapter: src/adapters/index.ts does not export ' + exportName + ' yet; the separate adapter worker must add it before mobile Explore can use the ' + kind + ' driver.');
  }
  return ctor as QaMobileAdapterConstructor;
}

/**
 * Build one MCP server. The returned server is NOT connected: the caller owns
 * the transport (stdio in src/server.mjs, InMemoryTransport in tests).
 */
export function createQaMcpServer(options: QaMcpServerOptions = {}): McpServer {
  const VERSION = readVersion();
  const server = new McpServer({ name: 'dsh-qa', version: VERSION });

  // One QA session per plugin process; the optional owner argument lets a later
  // Work Package multiplex distinct agent scopes without changing this shape.
  const DEFAULT_OWNER = 'dsh-qa';

  function textResult(value: unknown) {
    return { content: [{ type: 'text', text: JSON.stringify(toLosslessJson(value)) }] };
  }

  /** Honest reason for an assertion decided against a view that never stabilized. */
  function unstableReason(budgetMs: number) {
    return 'the observation never settled within the ' + String(budgetMs)
      + 'ms settle budget, so nothing in it proves the assertion; wait for the page to stop changing, then re-observe';
  }

  // Lazily construct one session manager per driver. The sibling drivers are
  // kept external in the bundle and resolved only when a qa_* tool actually
  // runs, so a node_modules-free plugin copy still serves initialize and
  // tools/list without them. Each owner's driver is chosen once at
  // qa_session_start and remembered so observe/act/evidence/stop stay consistent.
  const managers: Record<QaDriverKind, Promise<QaSessionManager> | undefined> = {
    browser: undefined,
    computer: undefined,
    ios: undefined,
    android: undefined,
  };
  const ownerDrivers = new Map<string, QaDriverKind>();
  const recorder = new QaTrajectoryRecorder();
  const visualCaptures = new QaVisualCaptureStore();

  async function getManager(kind: QaDriverKind) {
    if (!managers[kind]) {
      managers[kind] = (async () => {
        const adapterOverride = options.adapters?.[kind];
        if (adapterOverride !== undefined) {
          if (adapterOverride.kind !== kind) {
            throw new Error('manager adapter kind ' + adapterOverride.kind + ' does not match requested driver ' + kind);
          }
          return new QaSessionManager(new RecordingQaDriverAdapter(adapterOverride, recorder));
        }
        if (kind === 'browser') {
          const browserManager = await loadBrowserManager();
          return new QaSessionManager(new RecordingQaDriverAdapter(
            new BrowserAdapter(browserManager),
            recorder,
          ));
        }
        if (kind === 'ios') {
          const backend = await loadIosBackend();
          const IosAdapter = await loadMobileAdapterClass('ios');
          return new QaSessionManager(new RecordingQaDriverAdapter(
            new IosAdapter(backend),
            recorder,
          ));
        }
        if (kind === 'android') {
          const backend = await loadAndroidBackend();
          const AndroidAdapter = await loadMobileAdapterClass('android');
          return new QaSessionManager(new RecordingQaDriverAdapter(
            new AndroidAdapter(backend),
            recorder,
          ));
        }
        const computerDriver = await loadComputerDriver();
        return new QaSessionManager(new RecordingQaDriverAdapter(
          new ComputerAdapter(computerDriver),
          recorder,
        ));
      })();
      managers[kind] = managers[kind].catch((error: unknown) => {
        managers[kind] = undefined;
        throw error;
      });
    }
    return managers[kind];
  }

  async function managerForOwner(owner: string) {
    return getManager(ownerDrivers.get(owner) ?? 'browser');
  }

  function ownerFrom(args: { owner?: string }) {
    const raw = args && typeof args.owner === 'string' ? args.owner : DEFAULT_OWNER;
    const owner = raw.trim();
    if (owner === '') throw new Error('owner must not be empty');
    return owner;
  }

  // The MCP server has no host llm/attachments services, so visual capture runs
  // the same path (capture + on-disk artifact) but the verdict always degrades
  // to 'unclear' with reason 'vision-model-unavailable' instead of failing.
  const MCP_CAPTURES_DIR = join(tmpdir(), 'dsh-qa-mcp-visual-captures');

  async function captureVisualMCP(session: QaSession, options?: QaVisualObserveOptions) {
    const { capture, settle } = await captureLatestVisual(session, options);
    const artifactPath = await persistCaptureFile(capture, MCP_CAPTURES_DIR);
    return { capture, artifactPath, settle };
  }

  async function assertVisualMCP(owner: string, session: QaSession, question: string) {
    const { capture, artifactPath, settle } = await captureVisualMCP(session);
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
      reasoning: finding.reasoning,
      reasoningTrust: QA_ADVISORY_REASONING_TRUST,
      ...(finding.reason === undefined ? {} : { reason: finding.reason }),
      artifact: { path: artifactPath, kind: 'screenshot' },
      ...(settle === null ? {} : {
        settle,
        ...(settle.stable ? {} : { captureSettled: false }),
      }),
    };
  }

  async function captureVisualEvidenceMCP(session: QaSession, options?: QaVisualObserveOptions) {
    const { capture, artifactPath, settle } = await captureVisualMCP(session, options);
    const info = toVisualCaptureInfo(capture);
    if (capture.driver === 'computer') {
      const metadata = visualCaptureMetadata(capture);
      visualCaptures.put(metadata);
      return {
        ...info,
        artifactPath,
        nativeWidth: metadata.pixelWidth,
        nativeHeight: metadata.pixelHeight,
        coordinateSpace: 'native',
        ...(settle === null ? {} : {
          settle,
          ...(settle.stable ? {} : { captureSettled: false }),
        }),
      };
    }
    return {
      ...info,
      artifactPath,
      ...(settle === null ? {} : {
        settle,
        ...(settle.stable ? {} : { captureSettled: false }),
      }),
    };
  }

  async function actVisualMCP(owner: string, session: QaSession, args: any) {
    const parsed = validateVisualToolArgs(args);
    if (session.kind !== 'computer') {
      throw new Error('qa_act visual actions are computer-only (CU visual fallback)');
    }
    if (parsed.point === undefined) {
      // MCP has no injected llm/attachments service seam; text grounding is
      // only available through the DSH Cordis host route.
      throw new Error('qa_act visual textual grounding is unavailable on this MCP server (no host llm/attachments services); run qa_evidence visual and supply a trusted point');
    }
    if (parsed.captureSha256 === undefined || parsed.observationId === undefined) {
      throw new Error('qa_act visual point route requires capture_sha256 and observation_id from qa_evidence visual');
    }
    const metadata = visualCaptures.get(parsed.captureSha256);
    if (metadata === undefined) {
      throw new Error('qa_act visual: no trusted capture metadata for this capture_sha256 in this process; run qa_evidence visual again');
    }
    assertCaptureBinding(metadata, parsed.observationId);
    const native = requireVisualPointBinding(parsed, metadata);
    const action = buildVisualRuntimeActionFromMetadata(parsed.op, metadata, parsed.targetDescription, native.point, {
      ...(parsed.toDescription === undefined ? {} : { toDescription: parsed.toDescription }),
      ...(native.to === undefined ? {} : { nativeTo: native.to }),
      ...(parsed.direction === undefined ? {} : { direction: parsed.direction }),
      ...(parsed.amount === undefined ? {} : { amount: parsed.amount }),
      provenance: { source: 'harness-point' },
    });
    // No MCP host approval service exists here. The driver treats an absent
    // approval gate as unavailable (explicit rejection), never as implicit
    // allow.
    return session.act(action);
  }

  function guard(handler: (args: any) => Promise<any>) {
    return async (args: any): Promise<any> => {
      try {
        return await handler(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string' ? (error as Error & { code: string }).code : undefined;
        return textResult({ ok: false, ...(code === undefined ? {} : { code }), error: message });
      }
    };
  }

  server.tool(
    'qa_session_start',
    QA_TOOL_DESCRIPTIONS.qa_session_start,
    {
      owner: z.string().optional(),
      driver: z.enum(['browser', 'computer', 'ios', 'android']).optional(),
      url: z.string().optional(),
      headless: z.boolean().optional(),
      bundle_id: z.string().optional(),
      device_id: z.string().optional(),
      package_name: z.string().optional(),
      pid: z.number().int().optional(),
      window_number: z.number().int().optional(),
      window_title: z.string().optional(),
      login_state: z.object({
        source: z.string(),
        origins: z.array(z.string()),
      }).optional(),
      settle_budget_ms: z.number().int().optional(),
      settle_quiet_ms: z.number().int().optional(),
      settle_adaptive_budget_ms: z.number().int().optional(),
    },
    guard(async (args: any) => {
      const owner = ownerFrom(args);
      const driver = args.driver ?? 'browser';
      ownerDrivers.set(owner, driver);
      const manager = await getManager(driver);
      const settle = settleStartOverride(args);
      const info = await manager.session(owner, settle === undefined ? {} : { settle }).start({
        ...(args.url === undefined ? {} : { url: args.url }),
        ...(args.headless === undefined ? {} : { headless: args.headless }),
        ...(args.device_id === undefined ? {} : { deviceId: args.device_id }),
        ...(driver === 'ios' && args.bundle_id !== undefined ? { bundleId: args.bundle_id } : {}),
        ...(driver === 'android' && args.package_name !== undefined ? { packageName: args.package_name } : {}),
        ...(driver === 'android' && args.bundle_id !== undefined ? { packageName: args.bundle_id } : {}),
        ...(driver === 'computer' && args.bundle_id !== undefined ? { bundleId: args.bundle_id } : {}),
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
    QA_TOOL_DESCRIPTIONS.qa_observe,
    {
      owner: z.string().optional(),
      max_nodes: z.number().int().optional(),
      max_depth: z.number().int().optional(),
      ttl_ms: z.number().int().optional(),
      within_ref: z.string().optional(),
    },
    guard(async (args: any) => {
      const owner = ownerFrom(args);
      const manager = await managerForOwner(owner);
      const settled = await manager.session(owner).observeSettled({
        ...(args.max_nodes === undefined ? {} : { maxNodes: args.max_nodes }),
        ...(args.max_depth === undefined ? {} : { maxDepth: args.max_depth }),
        ...(args.ttl_ms === undefined ? {} : { ttlMs: args.ttl_ms }),
        ...(args.within_ref === undefined ? {} : { withinRef: args.within_ref }),
      });
      return textResult({
        ...settled.observation,
        settle: { stable: settled.stable, passes: settled.passes, budgetMs: settled.budgetMs, quietRequiredMs: settled.quietRequiredMs, widened: settled.widened },
      });
    }),
  );

  function scrollAmountFor(value: string | number | undefined, allowLine: boolean): 'page' | 'line' | number | undefined {
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
    QA_TOOL_DESCRIPTIONS.qa_act,
    {
      owner: z.string().optional(),
      action: z.enum(['click', 'fill', 'press', 'navigate', 'focus', 'type', 'key', 'scroll', 'select', 'hover',
        'visual_click', 'visual_drag', 'visual_scroll']),
      ref: z.string().optional(),
      text: z.string().optional(),
      key: z.string().optional(),
      url: z.string().optional(),
      modifiers: z.array(z.string()).optional(),
      direction: z.enum(['up', 'down']).optional(),
      amount: z.union([z.string(), z.number()]).optional(),
      option: z.string().optional(),
      target_description: z.string().optional(),
      to_description: z.string().optional(),
      capture_sha256: z.string().optional(),
      observation_id: z.string().optional(),
      point: z.object({ x: z.number().int(), y: z.number().int() }).optional(),
      to: z.object({ x: z.number().int(), y: z.number().int() }).optional(),
    },
    guard(async (args: any) => {
      const owner = ownerFrom(args);
      const manager = await managerForOwner(owner);
      if (args.action === 'visual_click' || args.action === 'visual_drag' || args.action === 'visual_scroll') {
        return textResult(await actVisualMCP(owner, manager.session(owner), args));
      }
      let action: any;
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
    QA_TOOL_DESCRIPTIONS.qa_evidence,
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
    guard(async (args: any) => {
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
    QA_TOOL_DESCRIPTIONS.qa_session_stop,
    { owner: z.string().optional() },
    guard(async (args: any) => {
      const owner = ownerFrom(args);
      const manager = await managerForOwner(owner);
      const result = await manager.stop(owner);
      ownerDrivers.delete(owner);
      return textResult(result);
    }),
  );

  server.tool(
    'qa_assert',
    QA_TOOL_DESCRIPTIONS.qa_assert,
    {
      owner: z.string().optional(),
      kind: z.enum(['node-present', 'node-absent', 'page-url', 'node-in-viewport', 'node-value', 'visual']),
      expected: z.unknown().optional(),
      question: z.string().optional(),
      within_ref: z.string().optional(),
    },
    guard(async (args: any) => {
      const owner = ownerFrom(args);
      const manager = await managerForOwner(owner);
      const session = manager.session(owner);
      if (args.kind === 'visual') {
        if (typeof args.question !== 'string' || args.question.trim() === '') {
          throw new Error('qa_assert visual requires a non-empty question');
        }
        if (args.within_ref !== undefined) {
          throw new Error('qa_assert kind "visual" does not take within_ref; observe the container with qa_observe within_ref first, then ask the visual question');
        }
        return textResult(await assertVisualMCP(owner, session, args.question));
      }
      const assertion = validateAssertion({ kind: args.kind, expected: args.expected }, 'qa_assert');
      const settled = await session.observeSettled(args.within_ref === undefined ? undefined : { withinRef: args.within_ref });
      if (!settled.stable) {
        return textResult({
          ok: true,
          passed: false,
          inconclusive: true,
          code: QA_INCONCLUSIVE_UNSTABLE,
          kind: assertion.kind,
          observed: null,
          expected: assertion.expected,
          settle: { stable: false, passes: settled.passes, budgetMs: settled.budgetMs, quietRequiredMs: settled.quietRequiredMs, widened: settled.widened },
          reason: unstableReason(settled.budgetMs),
        });
      }
      const decision = await decideAssertionWithRetry(assertion, settled.observation, sessionReobserve(session), session);
      recorder.assertion(owner, assertion, decision.passed);
      return textResult({
        ok: true,
        passed: decision.passed,
        kind: assertion.kind,
        observed: decision.observed,
        expected: assertion.expected,
        settle: { stable: settled.stable, passes: settled.passes, budgetMs: session.settlePolicy.budgetMs, quietRequiredMs: settled.quietRequiredMs, widened: settled.widened ?? decision.widened },
        ...(decision.completeness === null ? {} : { completeness: decision.completeness }),
        ...(decision.attempts <= 1 ? {} : { attempts: decision.attempts, elapsedMs: decision.elapsedMs }),
      });
    }),
  );

  server.tool(
    'qa_record_export',
    QA_TOOL_DESCRIPTIONS.qa_record_export,
    {
      owner: z.string().optional(),
      output_path: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      overwrite: z.boolean().optional(),
    },
    guard(async (args: any) => {
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
    QA_TOOL_DESCRIPTIONS.qa_replay_run,
    {
      scenario: z.string(),
      owner: z.string().optional(),
      headless: z.boolean().optional(),
      device_id: z.string().optional(),
      outputDir: z.string().optional(),
    },
    guard(async (args: any) => {
      const scenario = loadScenarioFromPath(args.scenario);
      // One driver factory seam for every driver kind (browser + computer, and
      // later ios/android): the MCP path and the Cordis path share
      // loadReplayDriver, so the two dispatch surfaces cannot drift on which
      // adapter/launch a scenario uses. A missing sibling driver throws here
      // and surfaces as { ok:false, error } through the guard.
      const loaders = options.loaders;
      const loaded = await loadReplayDriver(scenario, loaders === undefined ? {} : { loaders });
      try {
        const report = await runScenario(scenario, loaded.adapter, {
          ownerId: ownerFrom(args),
          ...(args.headless === undefined ? {} : { headless: args.headless }),
          launchUrl: scenario.target.launch,
          ...(args.device_id === undefined ? {} : { deviceId: args.device_id }),
          settle: resolveSettlePolicy(),
          visual: { capturesDir: MCP_CAPTURES_DIR },
        });
        if (args.outputDir !== undefined) {
          await writeReports(report, { directory: args.outputDir });
        }
        return textResult(report);
      } finally {
        await loaded.dispose();
      }
    }),
  );

  return server;
}
