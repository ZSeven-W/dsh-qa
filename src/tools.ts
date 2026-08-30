// dsh-qa cordis tool layer: the same 8-tool QA surface the MCP server exposes
// (src/server.mjs), expressed as host StructuralToolDefinitions so the DSH
// host registers them in-process. Behavior is kept IDENTICAL to the server:
// the same owner scoping, the same lazy per-driver session managers, the same
// lazy sibling-driver loading (with the same clear error when one is absent),
// and the same { ok: false, error } failure convention.
//
// The sibling drivers stay external and are imported only when a tool actually
// runs, so loading the plugin and registering the tools never requires them.

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserAdapter } from './adapters/browser.ts'
import { ComputerAdapter } from './adapters/computer.ts'
import { BROWSER_DRIVER_SPECIFIER, loadBrowserManager } from './adapters/loadBrowser.ts'
import { loadComputerDriver } from './adapters/loadComputer.ts'
import type { QaDriverKind } from './contracts.ts'
import {
  exportRecordedScenario,
  QaTrajectoryRecorder,
  RecordingQaDriverAdapter,
} from './explore/index.ts'
import type { QaRecordExportOptions, QaRecordExportResult } from './explore/index.ts'
import { evaluateAssertion, loadScenarioFromPath, runScenario, validateAssertion } from './replay/index.ts'
import { writeReports } from './reporters/index.ts'
import { captureLatestVisual, QaSessionManager, toLosslessJson } from './session/index.ts'
import type { QaAction, QaVisualObserveOptions } from './session/adapter.ts'
import { toVisualCaptureInfo } from './session/adapter.ts'
import type { QaSession } from './session/session.ts'
import {
  evaluateVisualQuestion,
  persistCaptureFile,
  type QaVisualServices,
  type StructuralAttachmentStore,
  type StructuralLlmService,
} from './vision.ts'

/** Structural host execution context (mirrors dsh-browser/dsh-computer). */
export interface ToolExecutionContext {
  signal?: AbortSignal
  agent?: { id?: unknown }
}

/** The tool shape the DSH host's tools service registers. */
export interface StructuralToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  timeoutMs: number
  isConcurrencySafe: () => boolean
  execute: (args: never, exec: ToolExecutionContext) => Promise<unknown>
  presentCall: () => { card: 'generic'; title: string }
}

export interface QaTools {
  qaSessionStart: StructuralToolDefinition
  qaObserve: StructuralToolDefinition
  qaAct: StructuralToolDefinition
  qaAssert: StructuralToolDefinition
  qaEvidence: StructuralToolDefinition
  qaRecordExport: StructuralToolDefinition
  qaReplayRun: StructuralToolDefinition
  qaSessionStop: StructuralToolDefinition
}

export function qaToolList(tools: QaTools): StructuralToolDefinition[] {
  return [
    tools.qaSessionStart,
    tools.qaObserve,
    tools.qaAct,
    tools.qaAssert,
    tools.qaEvidence,
    tools.qaRecordExport,
    tools.qaReplayRun,
    tools.qaSessionStop,
  ]
}

const renderJson = (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]

const outputFor = (schema: Record<string, unknown> = { type: 'object' }) => ({ schema, render: renderJson })

const closedObject = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
})

const enumOf = (...values: string[]) => ({ type: 'string', enum: values })

const intProp = { type: 'integer' }
const strProp = { type: 'string' }

export interface QaToolHostOptions {
  /** Lazy structural service resolution (host ctx.get), like dsh-computer. */
  getService?: (name: 'llm' | 'attachments') => unknown
  /** Vision route defaults come from configuration, not inline constants. */
  visionProvider?: string
  visionModel?: string
  /** Directory for writing a PNG when the driver did not persist one. */
  capturesDir?: string
}

/** One lazy QaSessionManager per driver, mirroring src/server.mjs getManager(). */
export class QaToolHost {
  readonly #managers = new Map<QaDriverKind, Promise<QaSessionManager>>()
  readonly #ownerDrivers = new Map<string, QaDriverKind>()
  readonly #recorder = new QaTrajectoryRecorder()
  readonly #options: QaToolHostOptions

  constructor(options: QaToolHostOptions = {}) {
    this.#options = options
  }

  managerFor(driver: QaDriverKind): Promise<QaSessionManager> {
    let manager = this.#managers.get(driver)
    if (manager === undefined) {
      manager = (async () => {
        if (driver === 'browser') {
          const browserManager = await loadBrowserManager()
          const adapter = new BrowserAdapter(browserManager)
          return new QaSessionManager(new RecordingQaDriverAdapter(adapter, this.#recorder))
        }
        const computerDriver = await loadComputerDriver()
        const adapter = new ComputerAdapter(computerDriver)
        return new QaSessionManager(new RecordingQaDriverAdapter(adapter, this.#recorder))
      })()
      manager = manager.catch((error: unknown) => {
        this.#managers.delete(driver)
        throw error
      })
      this.#managers.set(driver, manager)
    }
    return manager
  }

  managerForOwner(owner: string): Promise<QaSessionManager> {
    return this.managerFor(this.#ownerDrivers.get(owner) ?? 'browser')
  }

  bindOwner(owner: string, driver: QaDriverKind): void {
    this.#ownerDrivers.set(owner, driver)
  }

  async stopOwner(owner: string): Promise<unknown> {
    const driver = this.#ownerDrivers.get(owner)
    this.#ownerDrivers.delete(owner)
    if (driver === undefined) {
      return { stopped: false, reason: 'not-running' }
    }
    return (await this.managerFor(driver)).stop(owner)
  }

  exportRecord(owner: string, options: QaRecordExportOptions): Promise<QaRecordExportResult> {
    return exportRecordedScenario(this.#recorder, owner, options)
  }

  #capturesDir(): string {
    return this.#options.capturesDir ?? join(tmpdir(), 'dsh-qa-visual-captures')
  }

  /** Lazily resolve the host vision services (llm + attachments) for one call. */
  visualServices(): QaVisualServices {
    const getService = this.#options.getService
    const attachments = getService?.('attachments') as StructuralAttachmentStore | undefined
    const llm = getService?.('llm') as StructuralLlmService | undefined
    return {
      ...(attachments === undefined ? {} : { attachments }),
      ...(llm === undefined ? {} : { llm }),
      ...(this.#options.visionProvider === undefined ? {} : { provider: this.#options.visionProvider }),
      ...(this.#options.visionModel === undefined ? {} : { model: this.#options.visionModel }),
      capturesDir: this.#capturesDir(),
    }
  }

  /** Evaluate a visual assertion in Explore: capture + model verdict + recording. */
  async assertVisual(owner: string, session: QaSession, question: string): Promise<unknown> {
    const capture = await captureLatestVisual(session)
    const artifactPath = await persistCaptureFile(capture, this.#capturesDir())
    const finding = await evaluateVisualQuestion(question, capture, this.visualServices())
    this.#recorder.visualFinding(owner, {
      question,
      verdict: finding.verdict,
      confidence: finding.confidence,
      reasoning: finding.reasoning,
    })
    return {
      ok: true,
      kind: 'visual',
      question,
      verdict: finding.verdict,
      confidence: finding.confidence,
      reasoning: finding.reasoning,
      ...(finding.reason === undefined ? {} : { reason: finding.reason }),
      artifact: { path: artifactPath, kind: 'screenshot' },
    }
  }

  /** Capture a visual frame for qa_evidence and return metadata + artifact path. */
  async captureVisualEvidence(session: QaSession, options?: QaVisualObserveOptions): Promise<unknown> {
    const capture = await captureLatestVisual(session, options)
    const artifactPath = await persistCaptureFile(capture, this.#capturesDir())
    const info = toVisualCaptureInfo(capture)
    return { ...info, artifactPath }
  }

  async dispose(): Promise<void> {
    const pending = [...this.#managers.values()]
    this.#managers.clear()
    this.#ownerDrivers.clear()
    const settled = await Promise.allSettled(pending)
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        await outcome.value.dispose()
      }
    }
    this.#recorder.clear()
  }
}

export function ownerFrom(args: { owner?: string }, exec: ToolExecutionContext): string {
  const explicit = args.owner
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const agentId = exec.agent?.id
  if (typeof agentId === 'string' && agentId.trim() !== '') return agentId.trim()
  return 'dsh-qa'
}

function guard(handler: (args: never, exec: ToolExecutionContext) => Promise<unknown>) {
  return async (args: never, exec: ToolExecutionContext): Promise<unknown> => {
    try {
      return toLosslessJson(await handler(args, exec))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return toLosslessJson({ ok: false, error: message })
    }
  }
}

function tool<TArgs, TResult>(spec: Omit<StructuralToolDefinition, 'execute'> & {
  execute: (args: TArgs, exec: ToolExecutionContext) => Promise<TResult>
}): StructuralToolDefinition {
  // Route every tool result through the lossless layer (rule: undefined-valued
  // keys, NaN/Infinity, and -0 are rejected by the host boundary) and turn any
  // thrown error into the { ok: false, error } shape the MCP server uses.
  const execute = guard(spec.execute as (args: never, exec: ToolExecutionContext) => Promise<unknown>)
  return { ...spec, execute } as unknown as StructuralToolDefinition
}

interface SessionStartArgs {
  owner?: string
  driver?: 'browser' | 'computer'
  url?: string
  headless?: boolean
  bundle_id?: string
  pid?: number
  window_number?: number
  window_title?: string
}

interface ObserveArgs {
  owner?: string
  max_nodes?: number
  max_depth?: number
  ttl_ms?: number
}

interface ActArgs {
  owner?: string
  action: 'click' | 'fill' | 'press' | 'navigate' | 'focus' | 'type' | 'key'
  ref?: string
  text?: string
  key?: string
  url?: string
  modifiers?: string[]
}

interface AssertArgs {
  owner?: string
  kind: 'node-present' | 'node-absent' | 'page-url' | 'visual'
  expected?: unknown
  question?: string
}

interface EvidenceArgs {
  owner?: string
  max_console?: number
  max_network?: number
  max_receipts?: number
  visual?: boolean
  visual_fingerprint?: string
  visual_full_page?: boolean
  visual_max_marks?: number
  visual_scale?: number
}

interface RecordExportArgs {
  owner?: string
  output_path: string
  name?: string
  description?: string
  overwrite?: boolean
}

interface StopArgs {
  owner?: string
}

interface ReplayArgs {
  scenario: string
  owner?: string
  headless?: boolean
  outputDir?: string
}

export function createQaTools(host: QaToolHost): QaTools {
  const qaSessionStart = tool<SessionStartArgs, unknown>({
    name: 'qa_session_start',
    description: 'Start one QA session for this agent scope. Choose a browser or computer driver; the chosen driver is bound to the owner for the session and loaded lazily on first use.',
    parameters: closedObject({
      owner: strProp,
      driver: enumOf('browser', 'computer'),
      url: strProp,
      headless: { type: 'boolean' },
      bundle_id: strProp,
      pid: intProp,
      window_number: intProp,
      window_title: strProp,
    }, []),
    output: outputFor(),
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec)
      const driver = args.driver ?? 'browser'
      host.bindOwner(owner, driver)
      const manager = await host.managerFor(driver)
      return manager.session(owner).start({
        ...(args.url === undefined ? {} : { url: args.url }),
        ...(args.headless === undefined ? {} : { headless: args.headless }),
        ...(args.bundle_id === undefined ? {} : { bundleId: args.bundle_id }),
        ...(args.pid === undefined ? {} : { pid: args.pid }),
        ...(args.window_number === undefined ? {} : { windowNumber: args.window_number }),
        ...(args.window_title === undefined ? {} : { windowTitle: args.window_title }),
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Start QA session' }),
  })

  const qaObserve = tool<ObserveArgs, unknown>({
    name: 'qa_observe',
    description: 'Return a bounded semantic view of the current app/page. Interactive nodes carry opaque session-local refs; observe again after every action.',
    parameters: closedObject({
      owner: strProp,
      max_nodes: intProp,
      max_depth: intProp,
      ttl_ms: intProp,
    }, []),
    output: outputFor(),
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec)
      const manager = await host.managerForOwner(owner)
      return manager.session(owner).observe({
        ...(args.max_nodes === undefined ? {} : { maxNodes: args.max_nodes }),
        ...(args.max_depth === undefined ? {} : { maxDepth: args.max_depth }),
        ...(args.ttl_ms === undefined ? {} : { ttlMs: args.ttl_ms }),
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Observe QA target' }),
  })

  const qaAct = tool<ActArgs, unknown>({
    name: 'qa_act',
    description: 'Perform exactly one action. click/fill/press/navigate are browser verbs; focus/type/key are computer verbs. click/fill/press/focus/type/key require a ref from the latest qa_observe.',
    parameters: closedObject({
      owner: strProp,
      action: enumOf('click', 'fill', 'press', 'navigate', 'focus', 'type', 'key'),
      ref: strProp,
      text: strProp,
      key: strProp,
      url: strProp,
      modifiers: { type: 'array', items: strProp },
    }, ['action']),
    output: outputFor(),
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec)
      const manager = await host.managerForOwner(owner)
      let action: QaAction
      if (args.action === 'click') {
        if (args.ref === undefined) throw new Error('qa_act click requires ref')
        action = { kind: 'click', ref: args.ref }
      } else if (args.action === 'fill') {
        if (args.ref === undefined || args.text === undefined) throw new Error('qa_act fill requires ref and text')
        action = { kind: 'fill', ref: args.ref, text: args.text }
      } else if (args.action === 'press') {
        if (args.ref === undefined || args.key === undefined) throw new Error('qa_act press requires ref and key')
        action = { kind: 'press', ref: args.ref, key: args.key }
      } else if (args.action === 'focus') {
        if (args.ref === undefined) throw new Error('qa_act focus requires ref')
        action = { kind: 'focus', ref: args.ref }
      } else if (args.action === 'type') {
        if (args.ref === undefined || args.text === undefined) throw new Error('qa_act type requires ref and text')
        action = { kind: 'type', ref: args.ref, text: args.text }
      } else if (args.action === 'key') {
        if (args.ref === undefined || args.key === undefined) throw new Error('qa_act key requires ref and key')
        action = {
          kind: 'key',
          ref: args.ref,
          key: args.key,
          ...(args.modifiers === undefined ? {} : { modifiers: args.modifiers }),
        }
      } else if (args.action === 'navigate') {
        if (args.url === undefined) throw new Error('qa_act navigate requires url')
        action = { kind: 'navigate', url: args.url }
      } else {
        throw new Error('qa_act action must be click, fill, press, navigate, focus, type, or key')
      }
      return manager.session(owner).act(action)
    },
    presentCall: () => ({ card: 'generic', title: 'Act on QA target' }),
  })

  const qaAssert = tool<AssertArgs, unknown>({
    name: 'qa_assert',
    description: 'Evaluate one assertion against a fresh observation. node-present/node-absent/page-url are deterministic; kind "visual" captures the current screen and asks the host vision model a question, returning an ADVISORY verdict (yes/no/unclear with confidence and reasoning) that never changes pass/fail. Without a mounted vision model the visual verdict degrades to "unclear" with reason "vision-model-unavailable".',
    parameters: closedObject({
      owner: strProp,
      kind: enumOf('node-present', 'node-absent', 'page-url', 'visual'),
      expected: {},
      question: strProp,
    }, ['kind']),
    output: outputFor(),
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec)
      const manager = await host.managerForOwner(owner)
      const session = manager.session(owner)
      if (args.kind === 'visual') {
        if (typeof args.question !== 'string' || args.question.trim() === '') {
          throw new Error('qa_assert visual requires a non-empty question')
        }
        return host.assertVisual(owner, session, args.question)
      }
      const assertion = validateAssertion({ kind: args.kind, expected: args.expected }, 'qa_assert')
      const observation = await session.observe()
      const evaluation = evaluateAssertion(assertion, observation)
      return {
        ok: true,
        passed: evaluation.passed,
        kind: assertion.kind,
        observed: evaluation.observed,
        expected: assertion.expected,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Assert QA state' }),
  })

  const qaEvidence = tool<EvidenceArgs, unknown>({
    name: 'qa_evidence',
    description: 'Read bounded, redacted evidence: browser console/network records, or computer helper status plus bounded action receipts. Set visual: true to also capture the current screen (Set-of-Mark) and return its metadata plus a structured artifact path.',
    parameters: closedObject({
      owner: strProp,
      max_console: intProp,
      max_network: intProp,
      max_receipts: intProp,
      visual: { type: 'boolean' },
      visual_fingerprint: strProp,
      visual_full_page: { type: 'boolean' },
      visual_max_marks: intProp,
      visual_scale: intProp,
    }, []),
    output: outputFor(),
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec)
      const manager = await host.managerForOwner(owner)
      const session = manager.session(owner)
      const evidence = await session.evidence({
        ...(args.max_console === undefined ? {} : { maxConsole: args.max_console }),
        ...(args.max_network === undefined ? {} : { maxNetwork: args.max_network }),
        ...(args.max_receipts === undefined ? {} : { maxReceipts: args.max_receipts }),
      })
      if (args.visual !== true) return evidence
      const visual = await host.captureVisualEvidence(session, {
        ...(args.visual_fingerprint === undefined ? {} : { fingerprint: args.visual_fingerprint }),
        ...(args.visual_full_page === undefined ? {} : { fullPage: args.visual_full_page }),
        ...(args.visual_max_marks === undefined ? {} : { maxMarks: args.visual_max_marks }),
        ...(args.visual_scale === undefined ? {} : { scale: args.visual_scale }),
      })
      return { ...evidence, visual }
    },
    presentCall: () => ({ card: 'generic', title: 'Collect QA evidence' }),
  })

  const qaRecordExport = tool<RecordExportArgs, unknown>({
    name: 'qa_record_export',
    description: 'Export this owner\'s redacted Explore trajectory as a fail-closed Replay scenario JSON file. Only actions with durable role+accessible-name targets and outcomes proven by immediate fresh observations become steps; exclusions are returned explicitly.',
    parameters: closedObject({
      owner: strProp,
      output_path: strProp,
      name: strProp,
      description: strProp,
      overwrite: { type: 'boolean' },
    }, ['output_path']),
    output: outputFor(),
    timeoutMs: 15_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec)
      return host.exportRecord(owner, {
        outputPath: args.output_path,
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }),
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Export QA record' }),
  })

  const qaReplayRun = tool<ReplayArgs, unknown>({
    name: 'qa_replay_run',
    description: 'Run a deterministic Replay scenario file end to end and return a pass/fail/blocked report. Browser scenarios only in v0.1.',
    parameters: closedObject({
      scenario: strProp,
      owner: strProp,
      headless: { type: 'boolean' },
      outputDir: strProp,
    }, ['scenario']),
    output: outputFor(),
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const scenario = loadScenarioFromPath(args.scenario)
      if (scenario.meta.driver !== 'browser') {
        return { ok: false, error: 'scenario driver is not supported yet (computer replay lands in a later WP)' }
      }
      let origin: string | undefined
      try {
        origin = new URL(scenario.target.launch).origin
      } catch {
        origin = undefined
      }
      const browserManager = await loadBrowserManager(BROWSER_DRIVER_SPECIFIER, {
        ...(origin === undefined ? {} : { allowedOrigins: [origin] }),
      })
      const adapter = new BrowserAdapter(browserManager)
      try {
        const report = await runScenario(scenario, adapter, {
          ownerId: ownerFrom(args, exec),
          ...(args.headless === undefined ? {} : { headless: args.headless }),
          launchUrl: scenario.target.launch,
          visual: host.visualServices(),
        })
        if (args.outputDir !== undefined) {
          await writeReports(report, { directory: args.outputDir })
        }
        return report
      } finally {
        await browserManager.dispose()
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Replay QA scenario' }),
  })

  const qaSessionStop = tool<StopArgs, unknown>({
    name: 'qa_session_stop',
    description: 'Stop the QA session for this owner and release the bound driver scope. Idempotent when no session is running.',
    parameters: closedObject({ owner: strProp }, []),
    output: outputFor(),
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec)
      return host.stopOwner(owner)
    },
    presentCall: () => ({ card: 'generic', title: 'Stop QA session' }),
  })

  return { qaSessionStart, qaObserve, qaAct, qaAssert, qaEvidence, qaRecordExport, qaReplayRun, qaSessionStop }
}
