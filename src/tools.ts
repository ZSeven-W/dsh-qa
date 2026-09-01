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
import { QA_ADVISORY_REASONING_TRUST } from './contracts.ts'
import type { QaDriverKind } from './contracts.ts'
import {
  exportRecordedScenario,
  QaTrajectoryRecorder,
  RecordingQaDriverAdapter,
} from './explore/index.ts'
import type { QaRecordExportOptions, QaRecordExportResult } from './explore/index.ts'
import { decideAssertion, loadScenarioFromPath, runScenario, sessionReobserve, validateAssertion } from './replay/index.ts'
import { writeReports } from './reporters/index.ts'
import { captureLatestVisual, QaSessionManager, toLosslessJson } from './session/index.ts'
import type { QaAction, QaVisualObserveOptions } from './session/adapter.ts'
import type { QaSettlePolicy } from './session/settle.ts'
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
  /**
   * Bounded settle policy for proof/verification observations. The SAME policy
   * is applied to Explore sessions and to qa_replay_run, so export and replay
   * never judge different views of the same page.
   */
  settle?: Partial<QaSettlePolicy>
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
        const sessionOptions = this.#sessionOptions()
        if (driver === 'browser') {
          const browserManager = await loadBrowserManager()
          const adapter = new BrowserAdapter(browserManager)
          return new QaSessionManager(new RecordingQaDriverAdapter(adapter, this.#recorder), sessionOptions)
        }
        const computerDriver = await loadComputerDriver()
        const adapter = new ComputerAdapter(computerDriver)
        return new QaSessionManager(new RecordingQaDriverAdapter(adapter, this.#recorder), sessionOptions)
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

  /** Session options (settle policy) shared by every driver manager. */
  #sessionOptions(): { settle?: Partial<QaSettlePolicy> } {
    return this.#options.settle === undefined ? {} : { settle: this.#options.settle }
  }

  /** The settle policy qa_replay_run must reuse, so replay matches export. */
  settleOptions(): { settle?: Partial<QaSettlePolicy> } {
    return this.#sessionOptions()
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
      // verdict + confidence are the model's answer; the narration beside them
      // is unverified and may contain fabricated detail, so it travels with an
      // explicit trust code (contracts.ts, QA_ADVISORY_REASONING_TRUST).
      reasoning: finding.reasoning,
      reasoningTrust: QA_ADVISORY_REASONING_TRUST,
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
  /** Browser-only: owner-authorized login state { source: <state-file path>, origins: [<exact origins...>] }. */
  login_state?: { source: string; origins: string[] }
}

interface ObserveArgs {
  owner?: string
  max_nodes?: number
  max_depth?: number
  ttl_ms?: number
}

interface ActArgs {
  owner?: string
  action: 'click' | 'fill' | 'press' | 'navigate' | 'focus' | 'type' | 'key' | 'scroll' | 'select' | 'hover'
  ref?: string
  text?: string
  key?: string
  url?: string
  modifiers?: string[]
  direction?: 'up' | 'down'
  amount?: string | number
  option?: string
}

/**
 * Validates a scroll amount from the flat qa_act args: "page" (both drivers),
 * "line" (computer only), or a finite non-negative pixel count. The session
 * core and driver adapters reject anything the target driver cannot execute.
 */
function scrollAmountFor(
  value: string | number | undefined,
  allowLine: boolean,
): 'page' | 'line' | number | undefined {
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

interface AssertArgs {
  owner?: string
  kind: 'node-present' | 'node-absent' | 'page-url' | 'node-in-viewport' | 'visual'
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
    description: 'Start one QA session for this agent scope. Choose a browser or computer driver; the chosen driver is bound to the owner for the session and loaded lazily on first use. Browser sessions accept an optional login_state: OWNER-AUTHORIZED, SCOPED, READ-ONLY login-state injection from an explicit Playwright storageState JSON file. Only entries whose origin/domain exactly matches the authorized origins are injected into a FRESH ephemeral profile (destroyed on stop); entries outside the list are never loaded, and a file that parses, has no authorized entries, or holds unclassifiable entries fails the start. login_state is browser-only.',
    parameters: closedObject({
      owner: strProp,
      driver: enumOf('browser', 'computer'),
      url: strProp,
      headless: { type: 'boolean' },
      bundle_id: strProp,
      pid: intProp,
      window_number: intProp,
      window_title: strProp,
      login_state: closedObject({
        source: strProp,
        origins: { type: 'array', items: strProp },
      }, ['source', 'origins']),
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
        ...(args.login_state === undefined ? {} : { loginState: args.login_state }),
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Start QA session' }),
  })

  const qaObserve = tool<ObserveArgs, unknown>({
    name: 'qa_observe',
    description: 'Return a bounded semantic view of the current app/page, taken after a bounded settle (observe until two consecutive semantic views agree). Interactive nodes carry opaque session-local refs; observe again after every action. The result carries settle.stable: when it is false the page never stopped changing inside the budget and nothing in that view proves anything.',
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
      const settled = await manager.session(owner).observeSettled({
        ...(args.max_nodes === undefined ? {} : { maxNodes: args.max_nodes }),
        ...(args.max_depth === undefined ? {} : { maxDepth: args.max_depth }),
        ...(args.ttl_ms === undefined ? {} : { ttlMs: args.ttl_ms }),
      })
      return {
        ...settled.observation,
        settle: { stable: settled.stable, passes: settled.passes, budgetMs: settled.budgetMs },
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Observe QA target' }),
  })

  const qaAct = tool<ActArgs, unknown>({
    name: 'qa_act',
    description: 'Perform exactly one action. Browser verbs: click/fill/press/navigate/scroll/select/hover. Computer verbs: click/focus/type/key/scroll. scroll (browser) takes ref (scroll-into-view) or direction+amount (viewport page scroll); scroll (computer) takes ref+direction+amount; select takes ref+option; hover takes ref. click/fill/press/focus/type/key/select/hover require a ref from the latest qa_observe.',
    parameters: closedObject({
      owner: strProp,
      action: enumOf('click', 'fill', 'press', 'navigate', 'focus', 'type', 'key', 'scroll', 'select', 'hover'),
      ref: strProp,
      text: strProp,
      key: strProp,
      url: strProp,
      modifiers: { type: 'array', items: strProp },
      direction: enumOf('up', 'down'),
      amount: { type: ['string', 'number'] },
      option: strProp,
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
      } else if (args.action === 'scroll') {
        if (args.direction !== undefined && args.direction !== 'up' && args.direction !== 'down') {
          throw new Error('qa_act scroll direction must be "up" or "down"')
        }
        if (args.ref !== undefined && args.direction !== undefined) {
          const amount = scrollAmountFor(args.amount, true)
          action = {
            kind: 'scroll',
            ref: args.ref,
            direction: args.direction,
            ...(amount === undefined ? {} : { amount }),
          }
        } else if (args.ref !== undefined) {
          action = { kind: 'scroll', ref: args.ref }
        } else if (args.direction !== undefined) {
          const amount = scrollAmountFor(args.amount, false) as 'page' | number | undefined
          action = {
            kind: 'scroll',
            direction: args.direction,
            ...(amount === undefined ? {} : { amount }),
          }
        } else {
          throw new Error('qa_act scroll requires ref and/or direction')
        }
      } else if (args.action === 'select') {
        if (args.ref === undefined || args.option === undefined || args.option.trim() === '') {
          throw new Error('qa_act select requires ref and a non-empty option')
        }
        action = { kind: 'select', ref: args.ref, option: args.option }
      } else if (args.action === 'hover') {
        if (args.ref === undefined) throw new Error('qa_act hover requires ref')
        action = { kind: 'hover', ref: args.ref }
      } else {
        throw new Error('qa_act action must be click, fill, press, navigate, focus, type, key, scroll, select, or hover')
      }
      return manager.session(owner).act(action)
    },
    presentCall: () => ({ card: 'generic', title: 'Act on QA target' }),
  })

  const qaAssert = tool<AssertArgs, unknown>({
    name: 'qa_assert',
    description: 'Evaluate one assertion against a fresh SETTLED observation (observe until two consecutive semantic views agree, bounded by a budget; the result carries settle.stable). node-present/node-absent/node-in-viewport/page-url are deterministic. kind "visual" takes its own fresh settled observation, captures the current screen from it, and asks the host vision model a question, so it works directly after qa_act or qa_evidence and needs no separate qa_observe call first. Its ADVISORY verdict (yes/no/unclear with confidence) never changes pass/fail: trust verdict and confidence, and treat the accompanying reasoning as unverified model narration (reasoningTrust "unverified-model-narration") that may contain fabricated detail and must never be quoted as observed fact. Without a mounted vision model the visual verdict degrades to "unclear" with reason "vision-model-unavailable".',
    parameters: closedObject({
      owner: strProp,
      kind: enumOf('node-present', 'node-absent', 'page-url', 'node-in-viewport', 'visual'),
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
      const settled = await session.observeSettled()
      // A truncated view can never prove an absence (and never disprove a
      // presence): the decision escalates the node budget once and fails closed
      // with INCONCLUSIVE_TRUNCATED rather than reporting a false green.
      const decision = await decideAssertion(assertion, settled.observation, sessionReobserve(session))
      return {
        ok: true,
        passed: decision.passed,
        kind: assertion.kind,
        observed: decision.observed,
        expected: assertion.expected,
        settle: { stable: settled.stable, passes: settled.passes, budgetMs: settled.budgetMs },
        ...(decision.completeness === null ? {} : { completeness: decision.completeness }),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Assert QA state' }),
  })

  const qaEvidence = tool<EvidenceArgs, unknown>({
    name: 'qa_evidence',
    description: 'Read bounded, redacted evidence: browser console/network records, or computer helper status plus bounded action receipts. Set visual: true to also capture the current screen (Set-of-Mark) and return its metadata plus a structured artifact path; that capture is taken from its own fresh settled observation, so it never requires a preceding qa_observe. visual_fingerprint instead pins the capture to one exact browser observation and is deliberately NOT auto-refreshed, so a pinned observation that has gone stale fails by design.',
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
          ...host.settleOptions(),
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
