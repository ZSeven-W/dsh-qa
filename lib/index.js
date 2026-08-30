// src/contracts.ts
var QA_DRIVERS = ["browser", "computer"];
var QA_TOOL_NAMES = [
  "qa_session_start",
  "qa_observe",
  "qa_act",
  "qa_assert",
  "qa_evidence",
  "qa_record_export",
  "qa_replay_run",
  "qa_session_stop"
];

// src/session/lossless.ts
import { types } from "node:util";
function toLosslessJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value === 0 ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toLosslessJson(item));
  }
  if (typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child === void 0) continue;
      result[key] = toLosslessJson(child);
    }
    return result;
  }
  return null;
}
function isPlainObject(value) {
  if (types.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function rejectSymbolKeys(value, path2) {
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    throw new TypeError(path2 + '["<symbol>"]: symbol-keyed property is not lossless JSON');
  }
}
function rejectNonPlainPrototype(value, path2) {
  if (!isPlainObject(value)) {
    throw new TypeError(path2 + ": non-plain object is not lossless JSON");
  }
}
var MAX_NESTING_DEPTH = 256;
var CANONICAL_ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;
function isCanonicalArrayIndexKey(key, length) {
  return CANONICAL_ARRAY_INDEX.test(key) && Number(key) < length;
}
function joinPath(parent, key, isCanonicalArrayIndex) {
  if (isCanonicalArrayIndex) {
    return parent + "[" + key + "]";
  }
  return parent + '["<key>"]';
}
function rejectAccessors(value, path2, isArray) {
  const length = Array.isArray(value) ? value.length : 0;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== void 0 && (descriptor.get !== void 0 || descriptor.set !== void 0)) {
      const label = typeof key === "symbol" ? "<symbol>" : key;
      const isCanonicalIndex = isArray && typeof key === "string" && isCanonicalArrayIndexKey(key, length);
      throw new TypeError(
        joinPath(path2, label, isCanonicalIndex) + ": accessor property is not lossless JSON"
      );
    }
  }
}
function normalize(value, path2, stack, depth) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(path2 + ": non-finite number is not finite lossless JSON");
    }
    return value === 0 ? 0 : value;
  }
  if (typeof value === "object") {
    if (depth > MAX_NESTING_DEPTH) {
      throw new TypeError(path2 + ": exceeds the maximum nesting depth of " + MAX_NESTING_DEPTH);
    }
    if (stack.has(value)) {
      throw new TypeError(path2 + ": cyclic value is not lossless JSON");
    }
    if (types.isProxy(value)) {
      let isArray = false;
      try {
        isArray = Array.isArray(value);
      } catch {
      }
      if (isArray) {
        throw new TypeError(path2 + ": non-plain array is not lossless JSON");
      }
      throw new TypeError(path2 + ": non-plain object is not lossless JSON");
    }
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(path2 + ": non-plain array is not lossless JSON");
      }
      rejectSymbolKeys(value, path2);
      rejectAccessors(value, path2, true);
      stack.add(value);
      try {
        const length = value.length;
        const result = new Array(length);
        for (let index = 0; index < length; index++) {
          const indexPath = joinPath(path2, String(index), true);
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === void 0) {
            throw new TypeError(indexPath + ": sparse array is not lossless JSON");
          }
          if (!descriptor.enumerable) {
            throw new TypeError(indexPath + ": non-enumerable property is not lossless JSON");
          }
          if (descriptor.value === void 0) {
            throw new TypeError(indexPath + ": undefined is not JSON");
          }
          result[index] = normalize(descriptor.value, indexPath, stack, depth + 1);
        }
        for (const key of Object.getOwnPropertyNames(value)) {
          if (key === "length") {
            continue;
          }
          if (!isCanonicalArrayIndexKey(key, length)) {
            throw new TypeError(
              joinPath(path2, key, false) + ": array property is not lossless JSON"
            );
          }
        }
        return result;
      } finally {
        stack.delete(value);
      }
    }
    rejectNonPlainPrototype(value, path2);
    rejectSymbolKeys(value, path2);
    rejectAccessors(value, path2, false);
    stack.add(value);
    try {
      const result = {};
      const names = Object.getOwnPropertyNames(value);
      names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      for (const key of names) {
        const childPath = joinPath(path2, key, false);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor.enumerable) {
          throw new TypeError(childPath + ": non-enumerable property is not lossless JSON");
        }
        const child = descriptor.value;
        if (child === void 0) {
          throw new TypeError(childPath + ": undefined is not JSON");
        }
        Object.defineProperty(result, key, {
          value: normalize(child, childPath, stack, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true
        });
      }
      return result;
    } finally {
      stack.delete(value);
    }
  }
  const kind = typeof value === "bigint" ? "bigint" : typeof value === "function" ? "function" : typeof value === "symbol" ? "symbol" : typeof value === "undefined" ? "undefined" : "unsupported";
  throw new TypeError(path2 + ": " + kind + " is not lossless JSON");
}
function normalizeJsonValue(value, path2 = "$") {
  return normalize(value, path2, /* @__PURE__ */ new WeakSet(), 1);
}

// src/session/adapter.ts
function toVisualCaptureInfo(capture) {
  return {
    driver: capture.driver,
    observationFingerprint: capture.observationFingerprint,
    observationId: capture.observationId,
    width: capture.width,
    height: capture.height,
    sha256: capture.sha256,
    usable: capture.usable,
    marks: capture.marks,
    omitted: capture.omitted,
    ...capture.artifactPath === void 0 ? {} : { artifactPath: capture.artifactPath }
  };
}

// src/session/session.ts
function normalizeOwner(ownerId) {
  if (typeof ownerId !== "string" || ownerId.trim() === "") {
    throw new TypeError("owner id must be a non-empty string");
  }
  return ownerId.trim();
}
var QaSession = class {
  #adapter;
  #ownerId;
  #started = false;
  #stopped = false;
  #stopPromise = null;
  constructor(adapter, ownerId) {
    this.#adapter = adapter;
    this.#ownerId = normalizeOwner(ownerId);
  }
  get ownerId() {
    return this.#ownerId;
  }
  get kind() {
    return this.#adapter.kind;
  }
  get started() {
    return this.#started;
  }
  get stopped() {
    return this.#stopped;
  }
  async start(options) {
    this.#assertNotStopped();
    if (this.#started) throw new Error("session is already started");
    const info = await this.#adapter.start(this.#ownerId, options);
    this.#started = true;
    return info;
  }
  async observe(options) {
    this.#assertStarted();
    return this.#adapter.observe(this.#ownerId, options);
  }
  async act(action, approval) {
    this.#assertStarted();
    const receipt = await this.#adapter.act(this.#ownerId, action, approval);
    if (receipt.status === "rejected" || receipt.status === "failed") {
      return { receipt, observation: null, outcome: "failed", evidence: [receipt] };
    }
    const observation = await this.#adapter.observe(this.#ownerId);
    const outcome = receipt.status === "confirmed" ? "ok" : "unknown";
    return { receipt, observation, outcome, evidence: [receipt] };
  }
  async evidence(options) {
    this.#assertStarted();
    return this.#adapter.evidence(this.#ownerId, options);
  }
  async visualObserve(options) {
    this.#assertStarted();
    if (typeof this.#adapter.visualObserve !== "function") {
      throw new Error("the " + this.#adapter.kind + " driver does not support visual capture");
    }
    return this.#adapter.visualObserve(this.#ownerId, options);
  }
  stop() {
    this.#stopPromise ??= (async () => {
      const result = await this.#adapter.stop(this.#ownerId);
      this.#stopped = true;
      return result;
    })();
    return this.#stopPromise;
  }
  /** Run fn with guaranteed cleanup: stop() is awaited even when fn throws. */
  async run(fn) {
    try {
      return await fn(this);
    } finally {
      await this.stop();
    }
  }
  #assertStarted() {
    if (!this.#started) throw new Error("session is not started; call start() first");
  }
  #assertNotStopped() {
    if (this.#stopped) throw new Error("session is already stopped");
  }
};
var QaSessionManager = class {
  #adapter;
  #sessions = /* @__PURE__ */ new Map();
  #disposed = false;
  constructor(adapter) {
    this.#adapter = adapter;
  }
  session(ownerId) {
    if (this.#disposed) throw new Error("session manager is disposed");
    const owner = normalizeOwner(ownerId);
    let session = this.#sessions.get(owner);
    if (!session) {
      session = new QaSession(this.#adapter, owner);
      this.#sessions.set(owner, session);
    }
    return session;
  }
  async stop(ownerId) {
    const owner = normalizeOwner(ownerId);
    const session = this.#sessions.get(owner);
    if (!session) return { stopped: false, reason: "not-running" };
    const result = await session.stop();
    this.#sessions.delete(owner);
    return result;
  }
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const session of [...this.#sessions.values()]) {
      await session.stop();
    }
    this.#sessions.clear();
    await this.#adapter.dispose?.();
  }
};
async function captureLatestVisual(session, options) {
  if (session.kind === "computer" && options?.observationId === void 0) {
    const observation = await session.observe();
    const observationId = observation.observationId;
    if (observationId === void 0) {
      throw new Error("computer visual capture requires an observation id from the latest observation");
    }
    return session.visualObserve({ ...options ?? {}, observationId });
  }
  return session.visualObserve(options);
}

// src/adapters/browser.ts
var BrowserAdapter = class {
  kind = "browser";
  #driver;
  constructor(driver) {
    this.#driver = driver;
  }
  async start(ownerId, options) {
    const driverOptions = {
      ...options?.url === void 0 ? {} : { url: options.url },
      ...options?.headless === void 0 ? {} : { headless: options.headless }
    };
    const info = await this.#driver.start(ownerId, driverOptions);
    return { page: info.page, headless: info.headless };
  }
  async observe(ownerId, options) {
    const driverOptions = {
      ...options?.maxNodes === void 0 ? {} : { maxNodes: options.maxNodes }
    };
    const observation = await this.#driver.observe(ownerId, driverOptions);
    return {
      page: observation.page,
      nodes: observation.nodes,
      truncated: observation.truncated
    };
  }
  // The approval gate only applies to the computer driver. The browser driver
  // has no approval gate, so the parameter is accepted and deliberately ignored
  // here to keep the session core driver-agnostic.
  async act(ownerId, action, _approval) {
    const receipt = await this.#driver.act(ownerId, action);
    return {
      status: receipt.status,
      ...receipt.code === void 0 ? {} : { code: receipt.code },
      ...receipt.reason === void 0 ? {} : { reason: receipt.reason },
      dispatched: receipt.dispatched
    };
  }
  async evidence(ownerId, options) {
    const driverOptions = {
      ...options?.maxConsole === void 0 ? {} : { maxConsole: options.maxConsole },
      ...options?.maxNetwork === void 0 ? {} : { maxNetwork: options.maxNetwork }
    };
    const evidence = await this.#driver.evidence(ownerId, driverOptions);
    return {
      console: evidence.console,
      network: evidence.network,
      bounded: evidence.bounded,
      dropped: evidence.dropped
    };
  }
  async visualObserve(ownerId, options) {
    const request = {
      ...options?.fingerprint === void 0 ? {} : { fingerprint: options.fingerprint },
      ...options?.fullPage === void 0 ? {} : { fullPage: options.fullPage },
      ...options?.maxMarks === void 0 ? {} : { maxMarks: options.maxMarks },
      ...options?.scale === void 0 ? {} : { scale: options.scale }
    };
    const capture = await this.#driver.visualObserve(ownerId, request);
    return {
      driver: "browser",
      observationFingerprint: capture.observationFingerprint,
      observationId: null,
      png: capture.png,
      width: capture.capture.pixelWidth,
      height: capture.capture.pixelHeight,
      sha256: capture.capture.artifact.sha256,
      usable: capture.capture.quality.usable,
      marks: capture.marks.length,
      omitted: capture.omitted.length,
      artifactPath: capture.capture.artifact.path
    };
  }
  async stop(ownerId) {
    const result = await this.#driver.stop(ownerId);
    return { stopped: result.stopped, reason: result.reason };
  }
  async dispose() {
    await this.#driver.dispose();
  }
};

// src/adapters/computer.ts
var EDITABLE_ROLES = /* @__PURE__ */ new Set(["AXTextField", "AXTextArea", "AXSearchField"]);
function receiptCode(receipt) {
  if (receipt.reason.includes("secure text entry")) return "secure-text";
  if (receipt.reason.includes("host approval")) return "APPROVAL_REQUIRED";
  if (receipt.reason.includes("approval was not granted") || receipt.reason.includes("approval unavailable") || receipt.reason.includes("approval cancelled")) {
    return "APPROVAL_REQUIRED";
  }
  if (receipt.status === "rejected" && receipt.reason.includes("unknown reference")) return "UNKNOWN_REF";
  if (receipt.reason.includes("stale")) return "STALE_OBSERVATION";
  if (receipt.reason.includes("live application identity changed") || receipt.reason.includes("live window identity changed") || receipt.reason.includes("live target identity changed") || receipt.reason.includes("live observation fingerprint changed")) {
    return "IDENTITY_CHANGED";
  }
  return void 0;
}
var ComputerAdapter = class {
  kind = "computer";
  #driver;
  #binding = null;
  constructor(driver) {
    this.#driver = driver;
  }
  async start(ownerId, options) {
    void ownerId;
    this.#binding = {
      ...options?.bundleId === void 0 ? {} : { bundleId: options.bundleId },
      ...options?.pid === void 0 ? {} : { pid: options.pid },
      ...options?.windowNumber === void 0 ? {} : { windowNumber: options.windowNumber },
      ...options?.windowTitle === void 0 ? {} : { windowTitle: options.windowTitle }
    };
    return {
      page: { url: options?.bundleId ?? "", title: options?.windowTitle ?? "" },
      headless: false
    };
  }
  async observe(ownerId, options) {
    const binding = this.#binding;
    const request = {
      ...binding !== null && (binding.bundleId !== void 0 || binding.pid !== void 0) ? {
        app: {
          ...binding.bundleId === void 0 ? {} : { bundleId: binding.bundleId },
          ...binding.pid === void 0 ? {} : { pid: binding.pid }
        }
      } : {},
      ...binding !== null && (binding.windowNumber !== void 0 || binding.windowTitle !== void 0) ? {
        window: {
          ...binding.windowNumber === void 0 ? {} : { number: binding.windowNumber },
          ...binding.windowTitle === void 0 ? {} : { title: binding.windowTitle }
        }
      } : {},
      ...options?.maxNodes === void 0 ? {} : { maxNodes: options.maxNodes },
      ...options?.maxDepth === void 0 ? {} : { maxDepth: options.maxDepth },
      ...options?.ttlMs === void 0 ? {} : { ttlMs: options.ttlMs }
    };
    const observation = await this.#driver.observe(request, { scopeId: ownerId });
    this.#assertBinding(observation);
    return this.#projectObservation(observation);
  }
  async act(ownerId, action, approval) {
    const computerAction = this.#mapAction(action);
    const context = {
      scopeId: ownerId,
      ...approval === void 0 ? {} : { approval }
    };
    const receipt = await this.#driver.act(computerAction, context);
    const code = receiptCode(receipt);
    return {
      status: receipt.status,
      ...code === void 0 ? {} : { code },
      ...receipt.reason === "" ? {} : { reason: receipt.reason },
      dispatched: receipt.nativeAccepted || receipt.status === "confirmed" || receipt.status === "unknown"
    };
  }
  /**
   * Window-only visual observation with native Set-of-Mark labels. The PNG is
   * returned as bytes so callers can persist it as a structured artifact; only
   * the metadata (dimensions, digest, mark count) belongs in JSON. The computer
   * driver binds its capture to an exact observation id, so one is required.
   */
  async visualObserve(ownerId, options) {
    const observationId = options?.observationId;
    if (observationId === void 0 || observationId === "") {
      throw new Error("computer visual capture requires an exact observation id");
    }
    const capture = await this.#driver.visualObserve(
      { observationId, ...options?.maxMarks === void 0 ? {} : { maxMarks: options.maxMarks } },
      { scopeId: ownerId }
    );
    return {
      driver: "computer",
      observationFingerprint: capture.observationFingerprint,
      observationId: capture.observationId,
      png: capture.png,
      width: capture.capture.pixelWidth,
      height: capture.capture.pixelHeight,
      sha256: capture.capture.artifact.sha256,
      usable: capture.capture.quality.usable,
      marks: capture.marks.length,
      omitted: capture.omitted.length
    };
  }
  async evidence(ownerId, options) {
    const evidence = await this.#driver.evidence(
      { scopeId: ownerId },
      options?.maxReceipts === void 0 ? {} : { limit: options.maxReceipts }
    );
    return {
      console: [],
      network: [],
      bounded: true,
      dropped: { console: 0, network: 0 },
      computer: {
        contractVersion: evidence.contractVersion,
        scope: evidence.scope,
        status: evidence.status,
        activeObservations: evidence.activeObservations,
        activeNativeRequests: evidence.activeNativeRequests,
        receipts: evidence.receipts
      }
    };
  }
  async stop(ownerId) {
    await this.#driver.disposeScope(ownerId);
    return { stopped: true, reason: "scope-disposed" };
  }
  async dispose() {
    await this.#driver.dispose();
  }
  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------
  #mapAction(action) {
    switch (action.kind) {
      case "click":
        return { kind: "click", ref: action.ref };
      case "focus":
        return { kind: "focus", ref: action.ref };
      case "type":
        return { kind: "type", ref: action.ref, text: action.text };
      case "key":
        return {
          kind: "key",
          ref: action.ref,
          key: action.key,
          ...action.modifiers === void 0 ? {} : { modifiers: [...action.modifiers] }
        };
      case "fill":
        throw new Error('computer driver does not support the browser "fill" action; use "type"');
      case "press":
        throw new Error('computer driver does not support the browser "press" action; use "key"');
      case "navigate":
        throw new Error('computer driver does not support the "navigate" action');
    }
  }
  #assertBinding(observation) {
    const binding = this.#binding;
    if (binding !== null) {
      if (binding.bundleId !== void 0 && observation.app.bundleId !== binding.bundleId) {
        throw new Error(
          'observed app bundle id "' + observation.app.bundleId + '" does not match bound "' + binding.bundleId + '"'
        );
      }
      if (binding.pid !== void 0 && observation.app.pid !== binding.pid) {
        throw new Error(
          "observed app PID " + observation.app.pid + " does not match bound " + binding.pid
        );
      }
      if (binding.windowNumber !== void 0 && observation.window.number !== binding.windowNumber) {
        throw new Error(
          "observed window number " + observation.window.number + " does not match bound " + binding.windowNumber
        );
      }
      if (binding.windowTitle !== void 0 && observation.window.title !== binding.windowTitle) {
        throw new Error(
          'observed window title does not match the bound title "' + binding.windowTitle + '"'
        );
      }
    }
    if (observation.app.launchIdentity === null) {
      throw new Error("observed app has no launch identity; strong identity binding cannot be asserted");
    }
    if (observation.window.number === null) {
      throw new Error("observed window has no Accessibility window number; strong identity binding cannot be asserted");
    }
    if (observation.window.frame === null) {
      throw new Error("observed window has no frame; strong identity binding cannot be asserted");
    }
  }
  #projectNode(target) {
    const editable = EDITABLE_ROLES.has(target.role) && target.enabled !== false;
    return {
      ref: target.ref,
      role: target.role,
      name: target.name ?? "",
      tag: target.identifier ?? "",
      interactive: target.enabled !== false && (target.actions.length > 0 || editable),
      editable,
      disabled: target.enabled === false,
      secure: target.secure,
      value: target.value
    };
  }
  #projectObservation(observation) {
    return {
      page: { url: observation.app.bundleId, title: observation.window.title ?? "" },
      nodes: observation.targets.map((target) => this.#projectNode(target)),
      truncated: observation.truncated,
      observationId: observation.observationId,
      fingerprint: observation.fingerprint,
      app: {
        bundleId: observation.app.bundleId,
        pid: observation.app.pid,
        launchIdentity: observation.app.launchIdentity,
        name: observation.app.name
      },
      window: {
        number: observation.window.number,
        role: observation.window.role,
        subrole: observation.window.subrole,
        title: observation.window.title,
        frame: observation.window.frame === null ? null : {
          x: observation.window.frame.x,
          y: observation.window.frame.y,
          width: observation.window.frame.width,
          height: observation.window.frame.height
        },
        identity: observation.window.identity
      }
    };
  }
};

// src/adapters/loadBrowser.ts
var BROWSER_DRIVER_SPECIFIER = "@zseven-w/dsh-browser";
function isModuleNotFoundError(error) {
  return error instanceof Error && error.code === "ERR_MODULE_NOT_FOUND";
}
function missingBrowserDriverMessage(cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return 'Cannot load the browser driver @zseven-w/dsh-browser: it is not installed. dsh-qa loads it lazily and keeps it external in the bundle, so initialize and tools/list work without it, but the qa_* browser tools need it at runtime. Provide it by installing @zseven-w/dsh-browser alongside this plugin (for local development keep the "link:../dsh-browser" devDependency; for a host install the DSH host supplies it), then retry. Underlying error: ' + detail;
}
async function loadBrowserManager(specifier = BROWSER_DRIVER_SPECIFIER, options) {
  try {
    const { BrowserManager } = await import(specifier);
    return new BrowserManager(options);
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new Error(missingBrowserDriverMessage(error), { cause: error });
    }
    throw error;
  }
}

// src/adapters/loadComputer.ts
var COMPUTER_DRIVER_SPECIFIER = "@zseven-w/dsh-computer";
function missingComputerDriverMessage(cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return 'Cannot load the computer driver @zseven-w/dsh-computer: it is not installed. dsh-qa loads it lazily and keeps it external in the bundle, so initialize and tools/list work without it, but the qa_* computer tools need it at runtime. Provide it by installing @zseven-w/dsh-computer alongside this plugin (for local development keep the "link:../dsh-computer" devDependency; for a host install the DSH host supplies it), then retry. Underlying error: ' + detail;
}
async function loadComputerDriver(specifier = COMPUTER_DRIVER_SPECIFIER) {
  try {
    const { ComputerController } = await import(specifier);
    return new ComputerController();
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new Error(missingComputerDriverMessage(error), { cause: error });
    }
    throw error;
  }
}

// src/explore/export.ts
import { lstat, realpath, writeFile as writeFile2 } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { basename, dirname, isAbsolute, join as join3, relative, resolve } from "node:path";

// src/redaction/engine.ts
import { realpathSync } from "node:fs";
import path from "node:path";
import { types as types2 } from "node:util";
var ROOT_KEYS = ["workspace", "temp", "artifacts"];
var ROOT_ALIAS_PREFIX = "";
var ROOT_ALIAS_PREFIX_CODE = 1;
var ALIASES = {
  workspace: `${ROOT_ALIAS_PREFIX}WORKSPACE`,
  temp: `${ROOT_ALIAS_PREFIX}TMP`,
  artifacts: `${ROOT_ALIAS_PREFIX}ARTIFACTS`
};
var WINDOWS_DRIVE_ROOT = /^[A-Za-z]:[\\/]/;
var WINDOWS_UNC_ROOT = /^\\\\/;
function isUnsafeRootControlCharCode(code) {
  return code < 32 || // all C0 controls, including LF/CR
  code >= 127 && code <= 159;
}
function hasUnsafeRootCharacter(value) {
  for (let i = 0; i < value.length; i++) {
    if (isUnsafeRootControlCharCode(value.charCodeAt(i)) || isFormatCharacterAt(value, i)) {
      return true;
    }
  }
  return false;
}
function assertAbsolutePath(value, key) {
  if (WINDOWS_DRIVE_ROOT.test(value) || WINDOWS_UNC_ROOT.test(value)) {
    throw new Error(
      `redactText: roots.${key} must be an absolute POSIX path (Windows drive/UNC roots are not supported in v0.1)`
    );
  }
  if (hasUnsafeRootCharacter(value)) {
    throw new TypeError(`redactText: roots.${key} must not contain NUL, control, or format characters`);
  }
  if (value.length === 0 || !value.startsWith("/")) {
    throw new Error(`redactText: roots.${key} must be a non-empty absolute path`);
  }
}
function normalizeRoot(value) {
  const resolved = path.resolve(value);
  return resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved;
}
function isFilesystemRoot(value) {
  return value === path.parse(value).root;
}
function canonicalRootPath(resolved) {
  try {
    return normalizeRoot(realpathSync(resolved));
  } catch {
    return resolved;
  }
}
function buildRootAliases(normalized, supplied) {
  const aliases = {};
  for (const key of ROOT_KEYS) {
    const resolved = normalized[key];
    const canonical = canonicalRootPath(resolved);
    const spelling = supplied[key];
    const unique = /* @__PURE__ */ new Set([resolved]);
    if (canonical !== resolved) {
      unique.add(canonical);
    }
    if (spelling !== resolved) {
      unique.add(spelling);
    }
    aliases[key] = [...unique];
  }
  return aliases;
}
function validateRoots(roots) {
  if (roots === null || typeof roots !== "object") {
    throw new TypeError("redactText: roots must be an object");
  }
  if (types2.isProxy(roots)) {
    throw new TypeError("redactText: roots must be a plain object, not a Proxy");
  }
  if (Array.isArray(roots)) {
    throw new TypeError("redactText: roots must be an object");
  }
  const record = roots;
  const normalized = {};
  const supplied = {};
  for (const key of ROOT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === void 0) {
      throw new TypeError(`redactText: roots.${key} must be a string`);
    }
    if (descriptor.get !== void 0 || descriptor.set !== void 0) {
      throw new TypeError(
        `redactText: roots.${key} must be a plain data property, not an accessor`
      );
    }
    if (!("value" in descriptor)) {
      throw new TypeError(`redactText: roots.${key} must be a string`);
    }
    const value = descriptor.value;
    if (typeof value !== "string") {
      throw new TypeError(`redactText: roots.${key} must be a string`);
    }
    assertAbsolutePath(value, key);
    supplied[key] = value;
    normalized[key] = normalizeRoot(value);
    if (isFilesystemRoot(normalized[key])) {
      throw new Error(`redactText: roots.${key} must not be a filesystem root`);
    }
  }
  const canonical = {};
  for (const key of ROOT_KEYS) {
    canonical[key] = canonicalRootPath(normalized[key]);
  }
  if (canonical.workspace === canonical.temp) {
    throw new Error("redactText: ambiguous roots: roots.temp duplicates roots.workspace");
  }
  if (canonical.temp === canonical.artifacts) {
    throw new Error("redactText: ambiguous roots: roots.artifacts duplicates roots.temp");
  }
  if (canonical.workspace === canonical.artifacts) {
    throw new Error("redactText: ambiguous roots: roots.artifacts duplicates roots.workspace");
  }
  normalized.aliases = buildRootAliases(normalized, supplied);
  return normalized;
}
function isUnsafeControlCharCode(code) {
  return code < 32 && code !== 10 || // C0 controls except LF (tab, CR, ESC, ...)
  code >= 127 && code <= 159 || // DEL and C1 controls
  code === 8232 || code === 8233 || code === 8203 || // zero-width space
  code === 8204 || // zero-width non-joiner
  code === 8205 || // zero-width joiner
  code === 65279;
}
var FORMAT_CHARACTER = new RegExp("\\p{Cf}", "u");
var SEPARATOR_SENTINEL = "\0";
var SEPARATOR_SENTINEL_CODE = 0;
function isSeparatorSentinelCode(code) {
  return code === SEPARATOR_SENTINEL_CODE;
}
function isFormatCharacterAt(text, index) {
  const code = text.charCodeAt(index);
  if (code < 128) {
    return false;
  }
  if (code >= 55296 && code <= 56319) {
    const next = text.charCodeAt(index + 1);
    if (next >= 56320 && next <= 57343) {
      const codePoint = (code - 55296) * 1024 + (next - 56320) + 65536;
      return FORMAT_CHARACTER.test(String.fromCodePoint(codePoint));
    }
    return false;
  }
  if (code >= 56320 && code <= 57343) {
    return false;
  }
  return FORMAT_CHARACTER.test(String.fromCharCode(code));
}
function isUrlSchemeGap(text, index) {
  const before = text.slice(Math.max(0, index - 8), index).toLowerCase();
  const after = text.slice(index + 1, index + 9).toLowerCase();
  return (before.endsWith("http") || before.endsWith("https") || before.endsWith("file")) && after.startsWith("://");
}
function isUrlSchemeComplete(recent) {
  return recent.includes("http://") || recent.includes("https://") || recent.includes("file://");
}
function isUrlDelimiterCode(code) {
  return code === 34 || code === 39 || code === 60 || code === 62 || code === 96 || code === 91 || code === 93 || code === 40 || code === 41 || code === 123 || code === 125 || // Path separators delimit filesystem paths (root aliases and their
  // children are trusted output); credential blobs spanning slashes are
  // still caught segment-by-segment.
  code === 47;
}
function normalizeSeparators(text) {
  let result = "";
  let unsafeRun = false;
  let urlActive = false;
  let recent = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const ch = text[i] ?? "";
    if (code === 10) {
      if (unsafeRun) {
        result += SEPARATOR_SENTINEL;
        unsafeRun = false;
      }
      urlActive = false;
      result += "\n";
      recent = (recent + "\n").slice(-8);
    } else if (code === 13 && text.charCodeAt(i + 1) === 10) {
      urlActive = false;
    } else if (isUnsafeControlCharCode(code) || isFormatCharacterAt(text, i)) {
      if (urlActive || isUrlSchemeGap(text, i)) {
        if (code >= 55296 && code <= 56319) {
          i += 1;
        }
      } else {
        unsafeRun = true;
        if (code >= 55296 && code <= 56319) {
          i += 1;
        }
      }
    } else if (code === 32) {
      if (urlActive) {
        urlActive = false;
      }
      if (!unsafeRun) {
        result += ch;
        recent = (recent + ch).slice(-8);
      }
    } else {
      if (urlActive && isUrlDelimiterCode(code)) {
        urlActive = false;
      }
      if (unsafeRun) {
        result += SEPARATOR_SENTINEL;
        unsafeRun = false;
      }
      result += ch;
      recent = (recent + ch).slice(-8);
      if (!urlActive && isUrlSchemeComplete(recent)) {
        urlActive = true;
      }
    }
  }
  if (unsafeRun) {
    result += SEPARATOR_SENTINEL;
  }
  return result;
}
function splitTrailingPunctuation(text, isPunctuation) {
  let start = text.length;
  while (start > 0 && isPunctuation(text.charCodeAt(start - 1))) {
    start -= 1;
  }
  return { core: text.slice(0, start), trailing: text.slice(start) };
}
function isRootAfterPeriodBoundary(code) {
  return isAuthWhitespaceCode(code) || code === 34 || // "
  code === 39 || // '
  code === 96 || // `
  code === 60 || // <
  code === 44 || // ,
  code === 59 || // ;
  code === 58 || // :
  code === 33 || // !
  code === 63 || // ?
  code === 41 || // )
  code === 93 || // ]
  code === 125;
}
function isRootFollowingBoundaryChar(code) {
  return code === 47 || // /
  code === 35 || // #
  code === 39 || // '
  code === 34 || // "
  code === 96 || // `
  code === 42 || // *
  code === 126 || // ~
  code === 43 || // +
  isAuthWhitespaceCode(code) || code === 44 || // ,
  code === 59 || // ;
  code === 58 || // :
  code === 33 || // !
  code === 63 || // ?
  code === 60 || // <
  code === 41 || // )
  code === 93 || // ]
  code === 125 || // }
  code === 62;
}
function isRootFollowingBoundary(text, end) {
  if (end >= text.length) {
    return true;
  }
  const code = text.charCodeAt(end);
  if (code === 46) {
    return end + 1 >= text.length || isRootAfterPeriodBoundary(text.charCodeAt(end + 1));
  }
  if (code === 95) {
    let p = end;
    while (p < text.length && text.charCodeAt(p) === 95) {
      p += 1;
    }
    return p >= text.length || !isAsciiWordCharCode(text.charCodeAt(p));
  }
  return isRootFollowingBoundaryChar(code);
}
function isRootPrecedingBoundary(code) {
  return isAuthWhitespaceCode(code) || code === 34 || // "
  code === 39 || // '
  code === 96 || // `
  code === 42 || // *
  code === 126 || // ~
  code === 43 || // +
  code === 35 || // #
  code === 63 || // ?
  code === 33 || // !
  code === 40 || // (
  code === 91 || // [
  code === 123 || // {
  code === 60 || // <
  code === 61 || // =
  code === 58 || // :
  code === 44 || // ,
  code === 59 || // ;
  code === 41 || // )
  code === 93 || // ]
  code === 125 || // }
  code === 62;
}
function isRootPrecedingBoundaryAt(text, index, regionStart) {
  const code = text.charCodeAt(index);
  if (code !== 95) {
    return isRootPrecedingBoundary(code);
  }
  let p = index;
  while (p >= regionStart && text.charCodeAt(p) === 95) {
    p -= 1;
  }
  if (p < regionStart) {
    return regionStart === 0;
  }
  return !isAsciiWordCharCode(text.charCodeAt(p));
}
function rootEntries(roots) {
  const entries = [];
  for (const key of ROOT_KEYS) {
    for (const path2 of roots.aliases[key]) {
      entries.push({ key, path: path2 });
    }
  }
  return entries.sort((left, right) => right.path.length - left.path.length);
}
function startsWithIgnoringSentinelEndAt(text, position, prefix) {
  let p = position;
  for (let k = 0; k < prefix.length; k++) {
    while (p < text.length && isSeparatorSentinelCode(text.charCodeAt(p))) {
      p += 1;
    }
    if (p >= text.length || text.charCodeAt(p) !== prefix.charCodeAt(k)) {
      return -1;
    }
    p += 1;
  }
  return p;
}
function findRootAt(text, position, entries) {
  for (const entry of entries) {
    const end = startsWithIgnoringSentinelEndAt(text, position, entry.path);
    if (end >= 0 && isRootFollowingBoundary(text, end)) {
      return { key: entry.key, end };
    }
  }
  return null;
}
function redactRoots(text, roots) {
  const entries = rootEntries(roots);
  let result = "";
  let lastCopied = 0;
  let p = 0;
  const length = text.length;
  while (p < length) {
    if (text.charCodeAt(p) === 47) {
      let boundaryOk = false;
      if (p === 0) {
        boundaryOk = true;
      } else {
        boundaryOk = isRootPrecedingBoundaryAt(text, p - 1, 0);
      }
      if (boundaryOk) {
        const match = findRootAt(text, p, entries);
        if (match !== null) {
          result += text.slice(lastCopied, p);
          result += ALIASES[match.key];
          p = match.end;
          lastCopied = p;
          continue;
        }
      }
    }
    p += 1;
  }
  result += text.slice(lastCopied);
  return result;
}
var BEARER_SCHEMES = [
  ["bearer", 6],
  ["basic", 5]
];
function matchesAsciiWordIgnoringSentinelEndAt(text, index, word, allowWhitespace = false) {
  let p = index;
  for (let k = 0; k < word.length; k++) {
    if (k > 0) {
      while (p < text.length && (allowWhitespace ? isAuthWhitespaceCode(text.charCodeAt(p)) : isSeparatorSentinelCode(text.charCodeAt(p)))) {
        p += 1;
      }
    }
    if (p >= text.length) {
      return -1;
    }
    const code = text.charCodeAt(p);
    const target = word.charCodeAt(k);
    if (code !== target && code !== target - 32) {
      return -1;
    }
    p += 1;
  }
  return p;
}
function authSchemeLengthAt(text, index) {
  for (const entry of BEARER_SCHEMES) {
    const end = matchesAsciiWordIgnoringSentinelEndAt(text, index, entry[0], true);
    if (end >= 0) {
      return end - index;
    }
  }
  return 0;
}
function isAsciiWordCharCode(code) {
  return code >= 48 && code <= 57 || // 0-9
  code >= 65 && code <= 90 || // A-Z
  code >= 97 && code <= 122 || // a-z
  code === 95;
}
function findSchemeClosingUnderscoreAt(text, index) {
  if (index === 0 || text.charCodeAt(index - 1) !== 95) {
    return -1;
  }
  let p = index - 1;
  while (p >= 0 && text.charCodeAt(p) === 95) {
    p -= 1;
  }
  if (p >= 0 && isAsciiWordCharCode(text.charCodeAt(p))) {
    return -1;
  }
  const openerLength = index - 1 - p;
  for (let q = index; q < text.length; q++) {
    if (text.charCodeAt(q) !== 95) {
      continue;
    }
    let r = q;
    while (r < text.length && text.charCodeAt(r) === 95) {
      r += 1;
    }
    if (r < text.length && isAsciiWordCharCode(text.charCodeAt(r))) {
      continue;
    }
    const runLength = r - q;
    if (openerLength === 1 ? runLength === 1 : runLength >= 2) {
      return q;
    }
  }
  return -1;
}
function isSchemePrecedingBoundaryAt(text, index) {
  if (index === 0) {
    return true;
  }
  if (index >= 3 && (encodedAuthWhitespaceLengthAt(text, index - 3) === 3 || encodedAssignmentSeparatorLengthAt(text, index - 3) === 3) || index >= 5 && encodedAssignmentSeparatorLengthAt(text, index - 5) === 5) {
    return true;
  }
  const code = text.charCodeAt(index - 1);
  if (code !== 95) {
    return !isAsciiWordCharCode(code);
  }
  let p = index - 1;
  while (p >= 0 && text.charCodeAt(p) === 95) {
    p -= 1;
  }
  if (p >= 0 && isAsciiWordCharCode(text.charCodeAt(p))) {
    return false;
  }
  const runLength = index - 1 - p;
  if (runLength >= 2) {
    return true;
  }
  return findSchemeClosingUnderscoreAt(text, index) >= 0;
}
function isAsciiKeyCharCode(code) {
  return isAsciiWordCharCode(code) || code === 45;
}
function hexDigitValue(code) {
  if (code >= 48 && code <= 57) {
    return code - 48;
  }
  if (code >= 65 && code <= 70) {
    return code - 65 + 10;
  }
  if (code >= 97 && code <= 102) {
    return code - 97 + 10;
  }
  return -1;
}
function percentEscapeByteAt(text, index) {
  if (index + 2 >= text.length || text.charCodeAt(index) !== 37) {
    return -1;
  }
  const high = hexDigitValue(text.charCodeAt(index + 1));
  const low = hexDigitValue(text.charCodeAt(index + 2));
  if (high < 0 || low < 0) {
    return -1;
  }
  return high * 16 + low;
}
function encodedAssignmentSeparatorAt(text, index) {
  const first = percentEscapeByteAt(text, index);
  if (first === 61 || first === 58) {
    return { byte: first, length: 3 };
  }
  if (first === 37 && index + 4 < text.length) {
    const high = hexDigitValue(text.charCodeAt(index + 3));
    const low = hexDigitValue(text.charCodeAt(index + 4));
    if (high >= 0 && low >= 0) {
      const byte = high * 16 + low;
      if (byte === 61 || byte === 58) {
        return { byte, length: 5 };
      }
    }
  }
  return null;
}
function encodedAssignmentSeparatorByteAt(text, index) {
  return encodedAssignmentSeparatorAt(text, index)?.byte ?? -1;
}
function encodedAssignmentSeparatorLengthAt(text, index) {
  return encodedAssignmentSeparatorAt(text, index)?.length ?? 0;
}
function collectSplitHexByte(text, start) {
  const length = text.length;
  let p = start;
  let digits = 0;
  let value = 0;
  while (p < length && digits < 2) {
    const code = text.charCodeAt(p);
    if (isAuthWhitespaceCode(code)) {
      p += 1;
      continue;
    }
    const h = hexDigitValue(code);
    if (h < 0) {
      return null;
    }
    value = value * 16 + h;
    digits += 1;
    p += 1;
  }
  if (digits < 2) {
    return null;
  }
  return { byte: value, end: p };
}
function encodedAssignmentSeparatorSplitLengthAt(text, index) {
  if (text.charCodeAt(index) !== 37) {
    return 0;
  }
  const first = collectSplitHexByte(text, index + 1);
  if (first === null) {
    return 0;
  }
  if (first.byte === 61 || first.byte === 58) {
    return first.end - index;
  }
  if (first.byte === 37) {
    const second = collectSplitHexByte(text, first.end);
    if (second === null) {
      return 0;
    }
    if (second.byte === 61 || second.byte === 58) {
      return second.end - index;
    }
  }
  return 0;
}
function encodedAssignmentSeparatorSplitByteAt(text, index) {
  if (text.charCodeAt(index) !== 37) {
    return -1;
  }
  const first = collectSplitHexByte(text, index + 1);
  if (first === null) {
    return -1;
  }
  if (first.byte === 61 || first.byte === 58) {
    return first.byte;
  }
  if (first.byte === 37) {
    const second = collectSplitHexByte(text, first.end);
    if (second !== null && (second.byte === 61 || second.byte === 58)) {
      return second.byte;
    }
  }
  return -1;
}
function encodedAuthWhitespaceAt(text, index) {
  const first = percentEscapeByteAt(text, index);
  if (first === 32 || first === 9) {
    return { byte: first, length: 3 };
  }
  return null;
}
function encodedAuthWhitespaceLengthAt(text, index) {
  return encodedAuthWhitespaceAt(text, index)?.length ?? 0;
}
function skipAuthWhitespaceEncoded(text, index) {
  let i = index;
  while (i < text.length) {
    if (isAuthWhitespaceCode(text.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const encoded = encodedAuthWhitespaceAt(text, i);
    if (encoded !== null) {
      i += encoded.length;
      continue;
    }
    break;
  }
  return i;
}
function isEncodedStructuralBoundaryAt(text, index) {
  if (index < 3) {
    return false;
  }
  const high = hexDigitValue(text.charCodeAt(index - 2));
  const low = hexDigitValue(text.charCodeAt(index - 1));
  if (high < 0 || low < 0 || text.charCodeAt(index - 3) !== 37) {
    return false;
  }
  const byte = high * 16 + low;
  return byte === 123 || // {
  byte === 91 || // [
  byte === 44 || // ,
  byte === 59 || // ;
  byte === 58 || // :
  byte === 125 || // }
  byte === 93 || // ]
  byte === 41;
}
function isAuthWhitespaceCode(code) {
  return isSeparatorSentinelCode(code) || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32 || code === 160 || code === 5760 || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}
function isAuthTokenCharCode(code) {
  return isSeparatorSentinelCode(code) || // internal joining material
  code >= 48 && code <= 57 || // 0-9
  code >= 65 && code <= 90 || // A-Z
  code >= 97 && code <= 122 || // a-z
  code === 43 || // +
  code === 47 || // /
  code === 95 || // _
  code === 61 || // =
  code === 45 || // -
  code === 126;
}
function scanAuthToken(text, start) {
  let i = start;
  const length = text.length;
  while (i < length && isAuthTokenCharCode(text.charCodeAt(i))) {
    i += 1;
  }
  if (i === start) {
    return start;
  }
  for (; ; ) {
    if (i >= length || text.charCodeAt(i) !== 46) {
      return i;
    }
    let j = i + 1;
    while (j < length && isAuthTokenCharCode(text.charCodeAt(j))) {
      j += 1;
    }
    if (j === i + 1) {
      return i;
    }
    i = j;
  }
}
function isQuotedCredentialTailBoundaryCode(code, stopCode) {
  return isAuthWhitespaceCode(code) || code === 34 || // "
  code === 39 || // '
  isChainDelimiterCode(code) || code === 91 || // [
  code === 93 || // ]
  code === 123 || // {
  code === 125 || // }
  code === 62 || // >
  isCredentialTrailingPunctuationCode(code) || stopCode !== void 0 && code === stopCode;
}
function scanQuotedAuthTokenEnd(text, start, quote) {
  const length = text.length;
  let i = start + 1;
  let candidateEnd = -1;
  while (i < length) {
    const code = text.charCodeAt(i);
    if (candidateEnd !== -1 && isChainDelimiterCode(code) && isChainedAssignmentLookahead(text, i)) {
      break;
    }
    if (code === 92) {
      if (i + 1 < length) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (text[i] === quote) {
      const afterQuote = i + 1;
      if (afterQuote < length && !isQuotedCredentialTailBoundaryCode(text.charCodeAt(afterQuote))) {
        if (candidateEnd === -1) {
          candidateEnd = afterQuote;
        }
        i += 1;
        continue;
      }
      return { end: afterQuote, closed: true };
    }
    i += 1;
  }
  if (candidateEnd !== -1) {
    let tailEnd = candidateEnd;
    while (tailEnd < length && !isQuotedCredentialTailBoundaryCode(text.charCodeAt(tailEnd))) {
      tailEnd += 1;
    }
    return { end: tailEnd, closed: false };
  }
  return { end: length, closed: false };
}
function isTokenShaped(token) {
  let hasLower = false;
  let hasInteriorUpper = false;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i] ?? "";
    if (ch >= "a" && ch <= "z") {
      hasLower = true;
    } else if (ch >= "A" && ch <= "Z") {
      if (i > 0) {
        hasInteriorUpper = true;
      }
    } else if (ch >= "0" && ch <= "9") {
      return true;
    } else if (ch === "." || ch === "_" || ch === "~" || ch === "+" || ch === "/" || ch === "-" || ch === "=") {
      return true;
    }
  }
  return hasLower && hasInteriorUpper;
}
var AUTH_CONTEXT_NONE = 0;
var AUTH_CONTEXT_AFTER_KEY = 1;
var AUTH_CONTEXT_KEY_WS = 2;
var AUTH_CONTEXT_SEP_WS = 3;
var AUTH_CONTEXT_SEP_QUOTE = 4;
var AUTH_CONTEXT_SEP_QUOTE_WS = 5;
function isAuthContextDirectState(state) {
  return state === AUTH_CONTEXT_SEP_WS || state === AUTH_CONTEXT_SEP_QUOTE || state === AUTH_CONTEXT_SEP_QUOTE_WS;
}
function nextAuthContextState(state, code) {
  switch (state) {
    case AUTH_CONTEXT_NONE:
      return AUTH_CONTEXT_NONE;
    case AUTH_CONTEXT_AFTER_KEY:
      if (isAuthWhitespaceCode(code)) {
        return AUTH_CONTEXT_KEY_WS;
      }
      if (code === 58 || code === 61) {
        return AUTH_CONTEXT_SEP_WS;
      }
      return AUTH_CONTEXT_NONE;
    case AUTH_CONTEXT_KEY_WS:
      if (isAuthWhitespaceCode(code)) {
        return AUTH_CONTEXT_KEY_WS;
      }
      if (code === 58 || code === 61) {
        return AUTH_CONTEXT_SEP_WS;
      }
      return AUTH_CONTEXT_NONE;
    case AUTH_CONTEXT_SEP_WS:
      if (isAuthWhitespaceCode(code)) {
        return AUTH_CONTEXT_SEP_WS;
      }
      if (code === 34 || code === 39) {
        return AUTH_CONTEXT_SEP_QUOTE;
      }
      return AUTH_CONTEXT_NONE;
    case AUTH_CONTEXT_SEP_QUOTE:
      if (isAuthWhitespaceCode(code)) {
        return AUTH_CONTEXT_SEP_QUOTE_WS;
      }
      return AUTH_CONTEXT_NONE;
    case AUTH_CONTEXT_SEP_QUOTE_WS:
      if (isAuthWhitespaceCode(code)) {
        return AUTH_CONTEXT_SEP_QUOTE_WS;
      }
      return AUTH_CONTEXT_NONE;
    default:
      return AUTH_CONTEXT_NONE;
  }
}
function buildAuthorizationContexts(text) {
  const length = text.length;
  const direct = new Uint8Array(length);
  const folded = new Uint8Array(length);
  const quoted = new Uint8Array(length);
  const keyEnd = new Uint8Array(length);
  let lineStart = 0;
  let pendingAuth = false;
  while (lineStart <= length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) {
      lineEnd = length;
    }
    let cursor = lineStart;
    while (cursor < lineEnd) {
      const end = matchesAsciiWordIgnoringSentinelEndAt(text, cursor, "authorization");
      if (end >= 0) {
        const followedByKeyChar = end < lineEnd && isAsciiKeyCharCode(text.charCodeAt(end));
        if (!followedByKeyChar) {
          const before = cursor > 0 ? text.charCodeAt(cursor - 1) : -1;
          const isExact = before === -1 || !isAsciiKeyCharCode(before);
          const isHyphenPrefixed = before === 45 && cursor >= 2 && isAsciiKeyCharCode(text.charCodeAt(cursor - 2));
          if ((isExact || isHyphenPrefixed) && end < length) {
            keyEnd[end] = 1;
          }
        }
        cursor = end;
      } else {
        cursor += 1;
      }
    }
    let state = AUTH_CONTEXT_NONE;
    let isBlank = true;
    let firstNonWhitespace = lineEnd;
    let lineHasAuthOpener = false;
    let quoteCode = 0;
    let escaped = false;
    for (let p = lineStart; p < lineEnd; p++) {
      const code = text.charCodeAt(p);
      const encodedWsLen = quoteCode === 0 ? encodedAuthWhitespaceLengthAt(text, p) : 0;
      const encodedSepLen = quoteCode === 0 ? encodedAssignmentSeparatorLengthAt(text, p) : 0;
      const virtualCode = encodedWsLen > 0 ? 32 : encodedSepLen > 0 ? encodedAssignmentSeparatorByteAt(text, p) : code;
      if (quoteCode !== 0) {
        quoted[p] = quoteCode;
        if (escaped) {
          escaped = false;
        } else if (code === 92) {
          escaped = true;
        } else if (code === quoteCode) {
          quoteCode = 0;
        }
      } else if (code === 34 || code === 39 || code === 96) {
        quoteCode = code;
      }
      if (!isAuthWhitespaceCode(virtualCode)) {
        if (firstNonWhitespace === lineEnd) {
          firstNonWhitespace = p;
        }
        isBlank = false;
      }
      if (keyEnd[p] === 1) {
        state = AUTH_CONTEXT_AFTER_KEY;
      }
      if (isAuthContextDirectState(state)) {
        direct[p] = 1;
        lineHasAuthOpener = true;
      }
      state = nextAuthContextState(state, virtualCode);
      if (encodedWsLen > 0 || encodedSepLen > 0) {
        p += Math.max(encodedWsLen, encodedSepLen) - 1;
      }
    }
    const opensAuth = isAuthContextDirectState(state);
    if (isBlank) {
      pendingAuth = false;
    } else {
      const startsIndented = lineStart < lineEnd && isAuthWhitespaceCode(text.charCodeAt(lineStart));
      if (pendingAuth && startsIndented) {
        let foldedAt = firstNonWhitespace;
        if (foldedAt < lineEnd) {
          const quote = text[foldedAt];
          if (quote === '"' || quote === "'") {
            foldedAt += 1;
            while (foldedAt < lineEnd && isAuthWhitespaceCode(text.charCodeAt(foldedAt))) {
              foldedAt += 1;
            }
          }
          if (foldedAt < lineEnd) {
            folded[foldedAt] = 1;
          }
        }
        pendingAuth = true;
      } else {
        pendingAuth = opensAuth || lineHasAuthOpener;
      }
    }
    if (lineEnd === length) {
      break;
    }
    lineStart = lineEnd + 1;
  }
  return { direct, folded, quoted };
}
function scanAuthSchemeSeparator(text, afterScheme) {
  const length = text.length;
  let j = afterScheme;
  if (j < length && text.charCodeAt(j) === 58) {
    j += 1;
    return skipAuthWhitespaceEncoded(text, j);
  }
  if (j < length && text.charCodeAt(j) === 61) {
    j += 1;
    return skipAuthWhitespaceEncoded(text, j);
  }
  if (j < length && encodedAssignmentSeparatorLengthAt(text, j) > 0) {
    j += encodedAssignmentSeparatorLengthAt(text, j);
    return skipAuthWhitespaceEncoded(text, j);
  }
  if (j < length && (isAuthWhitespaceCode(text.charCodeAt(j)) || encodedAuthWhitespaceLengthAt(text, j) > 0)) {
    j = skipAuthWhitespaceEncoded(text, j);
    if (j < length && text.charCodeAt(j) === 58) {
      j += 1;
      return skipAuthWhitespaceEncoded(text, j);
    }
    if (j < length && text.charCodeAt(j) === 61) {
      j += 1;
      return skipAuthWhitespaceEncoded(text, j);
    }
    if (j < length && encodedAssignmentSeparatorLengthAt(text, j) > 0) {
      j += encodedAssignmentSeparatorLengthAt(text, j);
      return skipAuthWhitespaceEncoded(text, j);
    }
    return j;
  }
  return -1;
}
function findAuthHeaderQuotedValueStart(text, schemeIndex) {
  let p = schemeIndex - 1;
  while (p >= 0 && isAuthWhitespaceCode(text.charCodeAt(p))) {
    p -= 1;
  }
  if (p < 0) {
    return -1;
  }
  const quote = text[p] ?? "";
  if (quote !== '"' && quote !== "'") {
    return -1;
  }
  let before = p - 1;
  while (before >= 0 && isAuthWhitespaceCode(text.charCodeAt(before))) {
    before -= 1;
  }
  if (before < 0) {
    return -1;
  }
  const code = text.charCodeAt(before);
  return code === 58 || code === 61 ? p : -1;
}
function scanAuthorizationHeaderValueEnd(text, start, stopAtQuoteCode = 0) {
  const length = text.length;
  let i = start;
  if (stopAtQuoteCode !== 0) {
    while (i < length) {
      const code = text.charCodeAt(i);
      if (code === stopAtQuoteCode) {
        return i;
      }
      if (code === 92 && i + 1 < length) {
        i += 2;
        continue;
      }
      i += 1;
    }
    return length;
  }
  while (i < length && text.charCodeAt(i) !== 10) {
    i += 1;
  }
  while (i < length && text.charCodeAt(i) === 10) {
    const lineStart = i + 1;
    let p = lineStart;
    if (p >= length || !isAuthWhitespaceCode(text.charCodeAt(p))) {
      break;
    }
    while (p < length && isAuthWhitespaceCode(text.charCodeAt(p))) {
      if (text.charCodeAt(p) === 10) {
        return i;
      }
      p += 1;
    }
    if (p >= length || text.charCodeAt(p) === 10) {
      return i;
    }
    i = lineStart;
    while (i < length && text.charCodeAt(i) !== 10) {
      i += 1;
    }
  }
  return i;
}
function hasAuthorizationExtraToken(text, start) {
  const end = scanAuthorizationHeaderValueEnd(text, start, 0);
  let p = start;
  while (p < end && isAuthWhitespaceCode(text.charCodeAt(p))) {
    p += 1;
  }
  if (p >= end) {
    return false;
  }
  const tail = text.slice(p, end);
  const { core } = splitTrailingPunctuation(tail, isCredentialTrailingPunctuationCode);
  return core.length > 0;
}
function scanOutsideAuthCredentialTailEnd(text, start) {
  let i = start;
  const length = text.length;
  while (i < length) {
    const code = text.charCodeAt(i);
    if (code < 128 && !isAuthTokenCharCode(code)) {
      return i;
    }
    i += 1;
  }
  return length;
}
function redactBearerAndBasic(text) {
  const contexts = buildAuthorizationContexts(text);
  const isAuthorizationContext = (offset) => contexts.direct[offset] === 1 || contexts.folded[offset] === 1;
  const segments = [];
  let resultLength = 0;
  const append = (part) => {
    if (part.length > 0) {
      segments.push(part);
      resultLength += part.length;
    }
  };
  const truncateTo = (target) => {
    while (resultLength > target) {
      const last = segments[segments.length - 1];
      if (last === void 0) {
        throw new Error("redactBearerAndBasic: output segment underflow");
      }
      const excess = resultLength - target;
      if (last.length > excess) {
        segments[segments.length - 1] = last.slice(0, last.length - excess);
        resultLength = target;
      } else {
        segments.pop();
        resultLength -= last.length;
      }
    }
  };
  let i = 0;
  const length = text.length;
  let carriedAuth = false;
  while (i < length) {
    const schemeLength = authSchemeLengthAt(text, i);
    const schemeBoundary = isSchemePrecedingBoundaryAt(text, i);
    const closingUnderscoreStart = schemeBoundary ? findSchemeClosingUnderscoreAt(text, i) : -1;
    if (schemeLength === 0 || !schemeBoundary) {
      append(text[i] ?? "");
      i += 1;
      continue;
    }
    const scheme = text.slice(i, i + schemeLength);
    const afterScheme = i + schemeLength;
    const tokenStart = scanAuthSchemeSeparator(text, afterScheme);
    if (tokenStart < 0) {
      append(text[i] ?? "");
      i += 1;
      continue;
    }
    const quote = tokenStart < length ? text[tokenStart] : void 0;
    const inHeaderContext = carriedAuth || isAuthorizationContext(i);
    if (inHeaderContext) {
      const quotedHeaderStart = findAuthHeaderQuotedValueStart(text, i);
      if (quotedHeaderStart >= 0) {
        const headerQuote = text[quotedHeaderStart];
        const scanned = scanQuotedAuthTokenEnd(text, quotedHeaderStart, headerQuote);
        const outputQuoteStart = resultLength - (i - quotedHeaderStart);
        truncateTo(outputQuoteStart);
        append(`${headerQuote}[REDACTED]${headerQuote}`);
        i = scanned.end;
        carriedAuth = false;
        continue;
      }
    }
    if (inHeaderContext && quote !== '"' && quote !== "'") {
      const credentialEnd = scanAuthorizationHeaderValueEnd(
        text,
        tokenStart,
        contexts.quoted[tokenStart] ?? 0
      );
      if (credentialEnd > tokenStart) {
        const separator = text.slice(afterScheme, tokenStart);
        const credential = text.slice(tokenStart, credentialEnd);
        const { core, trailing } = splitTrailingPunctuation(
          credential,
          isCredentialTrailingPunctuationCode
        );
        if (core.length > 0) {
          append(`${scheme}${separator}[REDACTED]${trailing}`);
        } else {
          append(`${scheme}${separator}[REDACTED]`);
        }
        i = credentialEnd;
        carriedAuth = false;
        continue;
      }
    }
    if (quote === '"' || quote === "'") {
      const scanned = scanQuotedAuthTokenEnd(text, tokenStart, quote);
      const quotedEnd = closingUnderscoreStart >= 0 ? Math.min(scanned.end, closingUnderscoreStart) : scanned.end;
      const token2 = scanned.closed ? text.slice(tokenStart + 1, quotedEnd - 1) : text.slice(tokenStart + 1, quotedEnd);
      if (token2.length === 0) {
        append(text.slice(i, quotedEnd));
        i = quotedEnd;
        carriedAuth = false;
        continue;
      }
      const alreadyRedacted = scanned.closed && token2 === "[REDACTED]";
      const shouldRedact = scanned.closed ? inHeaderContext || isTokenShaped(token2) : true;
      if (closingUnderscoreStart < 0 && inHeaderContext && contexts.quoted[tokenStart] === 0 && hasAuthorizationExtraToken(text, scanned.end)) {
        const credentialEnd = scanAuthorizationHeaderValueEnd(text, tokenStart, 0);
        if (credentialEnd > tokenStart) {
          const separator = text.slice(afterScheme, tokenStart);
          const credential = text.slice(tokenStart, credentialEnd);
          const { core, trailing } = splitTrailingPunctuation(
            credential,
            isCredentialTrailingPunctuationCode
          );
          if (core.length > 0) {
            append(`${scheme}${separator}[REDACTED]${trailing}`);
          } else {
            append(`${scheme}${separator}[REDACTED]`);
          }
          i = credentialEnd;
          carriedAuth = false;
          continue;
        }
      }
      if (alreadyRedacted) {
        append(text.slice(i, quotedEnd));
      } else if (shouldRedact) {
        const separator = text.slice(afterScheme, tokenStart);
        append(`${scheme}${separator}${quote}[REDACTED]${quote}`);
      } else {
        append(text.slice(i, quotedEnd));
      }
      i = quotedEnd;
      carriedAuth = false;
      continue;
    }
    let tokenEnd = scanAuthToken(text, tokenStart);
    if (closingUnderscoreStart >= 0 && closingUnderscoreStart > tokenStart && closingUnderscoreStart < tokenEnd) {
      tokenEnd = closingUnderscoreStart;
    }
    const token = text.slice(tokenStart, tokenEnd);
    const nestedSchemeLength = authSchemeLengthAt(text, tokenStart);
    if (nestedSchemeLength > 0) {
      const nestedTokenStart = scanAuthSchemeSeparator(text, tokenStart + nestedSchemeLength);
      if (nestedTokenStart >= 0) {
        const nestedQuote = nestedTokenStart < length ? text[nestedTokenStart] : void 0;
        let nestedHasToken = false;
        if (nestedQuote === '"' || nestedQuote === "'") {
          const nestedScan = scanQuotedAuthTokenEnd(text, nestedTokenStart, nestedQuote);
          nestedHasToken = nestedScan.end > nestedTokenStart + 2;
        } else if (scanAuthToken(text, nestedTokenStart) > nestedTokenStart) {
          nestedHasToken = true;
        } else if (text.startsWith("[REDACTED]", nestedTokenStart)) {
          nestedHasToken = true;
        }
        if (nestedHasToken) {
          append(text.slice(i, tokenStart));
          carriedAuth = inHeaderContext;
          i = tokenStart;
          continue;
        }
      }
    }
    if (inHeaderContext) {
      const scannedCredentialEnd = scanAuthorizationHeaderValueEnd(
        text,
        tokenStart,
        contexts.quoted[tokenStart] ?? 0
      );
      const credentialEnd = closingUnderscoreStart >= 0 ? Math.min(scannedCredentialEnd, closingUnderscoreStart) : scannedCredentialEnd;
      if (credentialEnd > tokenStart) {
        const separator = text.slice(afterScheme, tokenStart);
        const credential = text.slice(tokenStart, credentialEnd);
        const { core, trailing } = splitTrailingPunctuation(
          credential,
          isCredentialTrailingPunctuationCode
        );
        if (core.length > 0) {
          append(`${scheme}${separator}[REDACTED]${trailing}`);
        } else {
          append(`${scheme}${separator}[REDACTED]`);
        }
        i = credentialEnd;
        carriedAuth = false;
        continue;
      }
    }
    if (token.length === 0) {
      append(text.slice(i, tokenEnd));
      i = tokenEnd;
      carriedAuth = false;
      continue;
    }
    if (inHeaderContext || isTokenShaped(token)) {
      const separator = text.slice(afterScheme, tokenStart);
      const credentialEnd = closingUnderscoreStart >= 0 ? closingUnderscoreStart : inHeaderContext ? tokenEnd : scanOutsideAuthCredentialTailEnd(text, tokenEnd);
      append(`${scheme}${separator}[REDACTED]`);
      i = credentialEnd;
    } else {
      append(text.slice(i, tokenEnd));
      i = tokenEnd;
    }
    carriedAuth = false;
  }
  return segments.join("");
}
function isAsciiAlnumCharCode(code) {
  return code >= 48 && code <= 57 || // 0-9
  code >= 65 && code <= 90 || // A-Z
  code >= 97 && code <= 122;
}
function isCredentialKeyRunCharCode(code) {
  return isAsciiKeyCharCode(code) || isSeparatorSentinelCode(code) || code === 37 || // %
  code === 46 || // .
  code === 47;
}
function isFlattenedCredentialKeyRunCharCode(code) {
  return isCredentialKeyRunCharCode(code) || code === 58;
}
function isCredentialKeySuffixPunctuationCode(code) {
  return code === 33 || // !
  code === 63 || // ?
  code === 46 || // .
  code === 44 || // ,
  code === 59 || // ;
  code === 58 || // :
  code === 39 || // '
  code === 34;
}
function stripSingleCredentialKeySuffixPunctuation(key) {
  if (key.length === 0) {
    return key;
  }
  const last = key.charCodeAt(key.length - 1);
  return isCredentialKeySuffixPunctuationCode(last) ? key.slice(0, -1) : key;
}
function scanCredentialKeySuffixSeparator(text, punctuationPos) {
  if (punctuationPos >= text.length || punctuationPos + 1 >= text.length || !isCredentialKeySuffixPunctuationCode(text.charCodeAt(punctuationPos)) || !isAuthWhitespaceCode(text.charCodeAt(punctuationPos + 1)) && encodedAuthWhitespaceLengthAt(text, punctuationPos + 1) === 0) {
    return -1;
  }
  return scanCredentialSeparator(text, punctuationPos + 1);
}
function scanCredentialKeyRun(text, start) {
  const length = text.length;
  let runEnd = start + 1;
  let lastAlnum = isAsciiAlnumCharCode(text.charCodeAt(start)) ? start : -1;
  while (runEnd < length) {
    if (encodedAssignmentSeparatorLengthAt(text, runEnd) > 0) {
      break;
    }
    if (encodedAssignmentSeparatorSplitLengthAt(text, runEnd) > 0) {
      break;
    }
    if (!isCredentialKeyRunCharCode(text.charCodeAt(runEnd))) {
      break;
    }
    if (isAsciiAlnumCharCode(text.charCodeAt(runEnd))) {
      lastAlnum = runEnd;
    }
    runEnd += 1;
  }
  return { runEnd, lastAlnum };
}
function scanCredentialKeyRunFlattened(text, start) {
  const length = text.length;
  let runEnd = start + 1;
  let lastAlnum = isAsciiAlnumCharCode(text.charCodeAt(start)) ? start : -1;
  while (runEnd < length) {
    if (encodedAssignmentSeparatorByteAt(text, runEnd) === 61) {
      break;
    }
    if (encodedAssignmentSeparatorSplitByteAt(text, runEnd) === 61) {
      break;
    }
    if (!isFlattenedCredentialKeyRunCharCode(text.charCodeAt(runEnd))) {
      break;
    }
    if (isAsciiAlnumCharCode(text.charCodeAt(runEnd))) {
      lastAlnum = runEnd;
    }
    runEnd += 1;
  }
  return { runEnd, lastAlnum };
}
function hasSensitiveColonPrefix(keyText) {
  let segmentStart = 0;
  for (let i = 0; i < keyText.length; i++) {
    if (keyText[i] === ":") {
      const prefix = keyText.slice(segmentStart, i);
      if (isSensitiveKey(prefix)) {
        return true;
      }
      segmentStart = i + 1;
    }
  }
  return false;
}
var MAX_CREDENTIAL_KEY_SPACED_SEGMENTS = 4;
var MAX_CREDENTIAL_KEY_SPACED_WHITESPACE = 32;
function isCredentialKeySpacedSeparatorCode(code) {
  return code === 32 || // space
  code === 160 || // NBSP
  code === 5760 || // Ogham space mark
  code >= 8192 && code <= 8202 || // en/em/quad spaces
  code === 8239 || // narrow no-break space
  code === 8287 || // medium mathematical space
  code === 12288;
}
function scanCredentialKeyRunSpaced(text, start, allowNewlines = false) {
  const length = text.length;
  let runEnd = start + 1;
  let lastAlnum = isAsciiAlnumCharCode(text.charCodeAt(start)) ? start : -1;
  let segmentCount = 1;
  let whitespaceStart = -1;
  while (runEnd < length) {
    if (encodedAssignmentSeparatorLengthAt(text, runEnd) > 0) {
      break;
    }
    if (encodedAssignmentSeparatorSplitLengthAt(text, runEnd) > 0) {
      break;
    }
    const code = text.charCodeAt(runEnd);
    if (isCredentialKeyRunCharCode(code)) {
      if (whitespaceStart !== -1) {
        if (segmentCount >= MAX_CREDENTIAL_KEY_SPACED_SEGMENTS) {
          return { runEnd: whitespaceStart, lastAlnum };
        }
        segmentCount += 1;
        whitespaceStart = -1;
      }
      if (isAsciiAlnumCharCode(code)) {
        lastAlnum = runEnd;
      }
      runEnd += 1;
    } else if (isCredentialKeySpacedSeparatorCode(code) || allowNewlines && code === 10) {
      if (segmentCount >= MAX_CREDENTIAL_KEY_SPACED_SEGMENTS) {
        break;
      }
      if (whitespaceStart === -1) {
        whitespaceStart = runEnd;
      }
      runEnd += 1;
      if (runEnd - whitespaceStart > MAX_CREDENTIAL_KEY_SPACED_WHITESPACE) {
        return { runEnd: whitespaceStart, lastAlnum };
      }
    } else {
      break;
    }
  }
  if (whitespaceStart !== -1) {
    return { runEnd: whitespaceStart, lastAlnum };
  }
  return { runEnd, lastAlnum };
}
function scanCredentialSeparator(text, start) {
  const length = text.length;
  let j = skipAuthWhitespaceEncoded(text, start);
  if (j >= length) {
    return -1;
  }
  const split = encodedAssignmentSeparatorSplitLengthAt(text, j);
  if (split > 0) {
    j += split;
  } else {
    const encoded = encodedAssignmentSeparatorLengthAt(text, j);
    if (encoded > 0) {
      j += encoded;
    } else {
      const code = text.charCodeAt(j);
      if (code !== 58 && code !== 61) {
        return -1;
      }
      j += 1;
    }
  }
  return skipAuthWhitespaceEncoded(text, j);
}
function scanRepeatedCredentialSeparatorEnd(text, start) {
  const length = text.length;
  let j = start;
  while (j < length) {
    const encoded = encodedAssignmentSeparatorLengthAt(text, j);
    if (encoded > 0) {
      j += encoded;
      j = skipAuthWhitespaceEncoded(text, j);
      continue;
    }
    const code = text.charCodeAt(j);
    if (code !== 58 && code !== 61) {
      break;
    }
    j += 1;
    j = skipAuthWhitespaceEncoded(text, j);
  }
  return j;
}
function isChainDelimiterCode(code) {
  return code === 44 || code === 59 || code === 58;
}
function isChainedAssignmentLookahead(text, delimiterPos) {
  const length = text.length;
  if (!isChainDelimiterCode(text.charCodeAt(delimiterPos))) {
    return false;
  }
  let j = delimiterPos + 1;
  while (j < length && isAuthWhitespaceCode(text.charCodeAt(j))) {
    j += 1;
  }
  if (j >= length) {
    return false;
  }
  const quote = text[j] ?? "";
  if (quote === '"' || quote === "'") {
    const keyStart = j + 1;
    if (keyStart >= length || !isAsciiWordCharCode(text.charCodeAt(keyStart))) {
      return false;
    }
    const run = scanCredentialKeyRunSpaced(text, keyStart);
    if (run.lastAlnum < keyStart + 1) {
      return false;
    }
    const closingQuote = run.lastAlnum + 1;
    if (closingQuote >= length || text.charCodeAt(closingQuote) !== text.charCodeAt(j)) {
      return false;
    }
    j = closingQuote + 1;
  } else if (isAsciiWordCharCode(text.charCodeAt(j))) {
    const run = scanCredentialKeyRunSpaced(text, j);
    if (run.lastAlnum < j + 1) {
      return false;
    }
    j = run.lastAlnum + 1;
  } else {
    return false;
  }
  while (j < length && isAuthWhitespaceCode(text.charCodeAt(j))) {
    j += 1;
  }
  if (j >= length) {
    return false;
  }
  const code = text.charCodeAt(j);
  if (code === 61 || code === 58) {
    return true;
  }
  return encodedAssignmentSeparatorLengthAt(text, j) > 0 || encodedAssignmentSeparatorSplitLengthAt(text, j) > 0;
}
function scanNestedSensitiveAssignmentStart(text, valueStart) {
  const length = text.length;
  if (valueStart >= length) {
    return null;
  }
  const first = text[valueStart] ?? "";
  let keyText;
  let afterKey;
  if (first === '"' || first === "'") {
    const keyStart = valueStart + 1;
    if (keyStart >= length || !isAsciiWordCharCode(text.charCodeAt(keyStart))) {
      return null;
    }
    const run = scanCredentialKeyRun(text, keyStart);
    if (run.lastAlnum < keyStart + 1) {
      return null;
    }
    const closingQuote = run.lastAlnum + 1;
    if (closingQuote >= length || text.charCodeAt(closingQuote) !== text.charCodeAt(valueStart)) {
      return null;
    }
    keyText = text.slice(keyStart, run.lastAlnum + 1);
    afterKey = closingQuote + 1;
  } else if (isAsciiWordCharCode(text.charCodeAt(valueStart))) {
    const run = scanCredentialKeyRun(text, valueStart);
    if (run.lastAlnum < valueStart + 1) {
      return null;
    }
    keyText = text.slice(valueStart, run.lastAlnum + 1);
    afterKey = run.lastAlnum + 1;
  } else {
    return null;
  }
  const keyQuote = first === '"' || first === "'" ? first : "";
  if (!isCredentialAssignmentSensitiveKey(keyText, keyQuote)) {
    return null;
  }
  const nestedValueStart = scanCredentialSeparator(text, afterKey);
  if (nestedValueStart < 0) {
    return null;
  }
  return {
    keyQuote,
    keyText,
    separator: text.slice(afterKey, nestedValueStart),
    valueStart: nestedValueStart
  };
}
function isSensitiveQuoteBoundary(text, quotePos, quote) {
  const length = text.length;
  if (quotePos + 1 < length && isAsciiWordCharCode(text.charCodeAt(quotePos + 1))) {
    const run = scanCredentialKeyRun(text, quotePos + 1);
    if (run.lastAlnum >= quotePos + 2) {
      const closingQuote = run.lastAlnum + 1;
      if (closingQuote < length && text.charCodeAt(closingQuote) === text.charCodeAt(quotePos) && isSensitiveKey(text.slice(quotePos + 1, run.lastAlnum + 1)) && scanCredentialSeparator(text, closingQuote + 1) >= 0) {
        return true;
      }
    }
  }
  let p = quotePos - 1;
  while (p >= 0 && isAuthWhitespaceCode(text.charCodeAt(p))) {
    p -= 1;
  }
  if (p < 0) {
    return false;
  }
  const separatorCode = text.charCodeAt(p);
  if (separatorCode !== 61 && separatorCode !== 58) {
    return false;
  }
  const keyEnd = p;
  p -= 1;
  while (p >= 0 && isAuthWhitespaceCode(text.charCodeAt(p))) {
    p -= 1;
  }
  const keyLast = p;
  while (p >= 0 && isCredentialKeyRunCharCode(text.charCodeAt(p))) {
    p -= 1;
  }
  const keyStart = p + 1;
  if (keyStart >= keyEnd || keyLast < keyStart || !isAsciiWordCharCode(text.charCodeAt(keyStart)) || !isAsciiAlnumCharCode(text.charCodeAt(keyLast)) || !isCredentialAssignmentSensitiveKey(text.slice(keyStart, keyEnd), "")) {
    return false;
  }
  const lineEnd = text.indexOf("\n", quotePos);
  const searchEnd = lineEnd === -1 ? length : lineEnd;
  const nextQuote = text.indexOf(quote, quotePos + 1);
  return nextQuote !== -1 && nextQuote < searchEnd;
}
function scanCredentialValue(text, start, stopCode, guardSensitiveBoundary = false) {
  const length = text.length;
  if (start >= length) {
    return null;
  }
  const quote = text[start] ?? "";
  if (quote === '"' || quote === "'") {
    let i2 = start + 1;
    let candidateEnd = -1;
    while (i2 < length) {
      const code = text.charCodeAt(i2);
      if (candidateEnd !== -1 && isChainDelimiterCode(code) && isChainedAssignmentLookahead(text, i2)) {
        break;
      }
      if (code === 10) {
        if (!guardSensitiveBoundary) {
          return { end: i2, value: text.slice(start, i2) };
        }
        i2 += 1;
        continue;
      }
      if (code === 92) {
        if (i2 + 1 >= length) {
          return { end: length, value: text.slice(start, length) };
        }
        i2 += 2;
        continue;
      }
      if (text[i2] === quote) {
        if (guardSensitiveBoundary && isSensitiveQuoteBoundary(text, i2, quote)) {
          const lineEnd = text.indexOf("\n", i2);
          const end = lineEnd === -1 ? length : lineEnd;
          return { end, value: text.slice(start, end) };
        }
        const afterQuote = i2 + 1;
        if (guardSensitiveBoundary && afterQuote < length && !isQuotedCredentialTailBoundaryCode(text.charCodeAt(afterQuote), stopCode)) {
          if (candidateEnd === -1) {
            candidateEnd = afterQuote;
          }
          i2 += 1;
          continue;
        }
        return { end: afterQuote, value: text.slice(start, afterQuote) };
      }
      i2 += 1;
    }
    if (candidateEnd !== -1) {
      let tailEnd = candidateEnd;
      while (tailEnd < length && !isQuotedCredentialTailBoundaryCode(text.charCodeAt(tailEnd), stopCode)) {
        tailEnd += 1;
      }
      return { end: tailEnd, value: text.slice(start, tailEnd) };
    }
    return { end: length, value: text.slice(start, length) };
  }
  if (isAuthWhitespaceCode(text.charCodeAt(start))) {
    return null;
  }
  let i = start;
  while (i < length) {
    const code = text.charCodeAt(i);
    if (code === 37 && guardSensitiveBoundary) {
      const h1 = i + 1 < length ? hexDigitValue(text.charCodeAt(i + 1)) : -1;
      const h2 = i + 2 < length ? hexDigitValue(text.charCodeAt(i + 2)) : -1;
      if (h1 < 0 || h2 < 0) {
        const end = scanAuthorizationWholeValueEnd(text, i, stopCode);
        return { end, value: text.slice(start, end) };
      }
      i += 3;
      continue;
    }
    if (isAuthWhitespaceCode(code) || code === 34 || code === 39 || stopCode !== void 0 && code === stopCode || // A chain delimiter followed by `key<ws>[=:]` starts an independent
    // next assignment: stop the value at the delimiter so the outer
    // scanner redacts the second assignment on its own (and so the first
    // value is redacted without swallowing `,key` or leaking ` = value`).
    isChainDelimiterCode(code) && isChainedAssignmentLookahead(text, i)) {
      break;
    }
    i += 1;
  }
  return { end: i, value: text.slice(start, i) };
}
function isOpenStructureCharCode(code) {
  return code === 91 || code === 123;
}
function isCloseStructureCharCode(code) {
  return code === 93 || code === 125;
}
function matchesStructureCloser(open, close) {
  return open === 91 && close === 93 || open === 123 && close === 125;
}
function scanStructuredCredentialValue(text, start) {
  const length = text.length;
  let i = start;
  let end = -1;
  for (; ; ) {
    const open = text.charCodeAt(i);
    if (!isOpenStructureCharCode(open)) {
      break;
    }
    const stack = [open];
    let j = i + 1;
    let closed = false;
    while (j < length) {
      const code = text.charCodeAt(j);
      if (code === 34 || code === 39) {
        const quote = code;
        j += 1;
        for (; ; ) {
          if (j >= length) {
            return { end: length };
          }
          const inner = text.charCodeAt(j);
          if (inner === 92) {
            if (j + 1 >= length) {
              return { end: length };
            }
            j += 2;
            continue;
          }
          if (inner === quote) {
            break;
          }
          j += 1;
        }
        j += 1;
        continue;
      }
      if (isOpenStructureCharCode(code)) {
        stack.push(code);
        j += 1;
        continue;
      }
      if (isCloseStructureCharCode(code)) {
        const top = stack[stack.length - 1];
        if (top !== void 0 && matchesStructureCloser(top, code)) {
          stack.pop();
          if (stack.length === 0) {
            closed = true;
            break;
          }
          j += 1;
          continue;
        }
        const lineEnd = text.indexOf("\n", j);
        return { end: lineEnd === -1 ? length : lineEnd };
      }
      j += 1;
    }
    if (!closed) {
      return { end: length };
    }
    end = j + 1;
    if (isOpenStructureCharCode(text.charCodeAt(end)) && !text.startsWith("[REDACTED_URL]", end)) {
      i = end;
      continue;
    }
    if (text.charCodeAt(end) === 44 && isOpenStructureCharCode(text.charCodeAt(end + 1)) && !text.startsWith("[REDACTED_URL]", end + 1)) {
      i = end + 1;
      continue;
    }
    break;
  }
  return { end };
}
function isTerminalDelimiterRunBoundary(followingCode, stopCode) {
  return followingCode === -1 || isAuthWhitespaceCode(followingCode) || followingCode === 34 || followingCode === 39 || stopCode !== void 0 && followingCode === stopCode;
}
var SAFE_STRUCTURED_TAIL_DELIMITERS = /* @__PURE__ */ new Set([
  46,
  // .
  44,
  // ,
  59,
  // ;
  58,
  // :
  33,
  // !
  63,
  // ?
  41
  // )
]);
function isSafeTerminalDelimiterRun(tail) {
  if (tail.length === 0) {
    return false;
  }
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i] ?? "";
    if (ch !== "." && ch !== "," && ch !== ";" && ch !== ":" && ch !== "!" && ch !== "?" && ch !== ")") {
      return false;
    }
  }
  return true;
}
function consumeStructuredValueTail(text, end, stopCode) {
  const length = text.length;
  if (end >= length) {
    return end;
  }
  const code = text.charCodeAt(end);
  if (stopCode !== void 0 && code === stopCode) {
    return end;
  }
  if (isAuthWhitespaceCode(code) || code === 34 || code === 39) {
    return end;
  }
  if (isChainDelimiterCode(code)) {
    const next = end + 1;
    if (next >= length) {
      return end;
    }
    const nextCode = text.charCodeAt(next);
    if (isAuthWhitespaceCode(nextCode) || nextCode === 34 || nextCode === 39) {
      return end;
    }
    if (isChainedAssignmentLookahead(text, end)) {
      return end;
    }
    if (text.startsWith("[REDACTED_URL]", next)) {
      return end;
    }
    if (SAFE_STRUCTURED_TAIL_DELIMITERS.has(code)) {
      let runEnd = end + 1;
      while (runEnd < length && SAFE_STRUCTURED_TAIL_DELIMITERS.has(text.charCodeAt(runEnd))) {
        runEnd += 1;
      }
      const following = runEnd >= length ? -1 : text.charCodeAt(runEnd);
      if (isTerminalDelimiterRunBoundary(following, stopCode)) {
        return end;
      }
    }
    return consumeStructuredValueScalarTail(text, end, stopCode);
  }
  if (SAFE_STRUCTURED_TAIL_DELIMITERS.has(code)) {
    let runEnd = end + 1;
    while (runEnd < length && SAFE_STRUCTURED_TAIL_DELIMITERS.has(text.charCodeAt(runEnd))) {
      runEnd += 1;
    }
    const following = runEnd >= length ? -1 : text.charCodeAt(runEnd);
    if (isTerminalDelimiterRunBoundary(following, stopCode)) {
      return end;
    }
    return consumeStructuredValueScalarTail(text, end, stopCode);
  }
  return consumeStructuredValueScalarTail(text, end, stopCode);
}
function consumeStructuredValueScalarTail(text, start, stopCode) {
  const length = text.length;
  let i = start;
  while (i < length) {
    const code = text.charCodeAt(i);
    if (isAuthWhitespaceCode(code) || code === 34 || code === 39 || stopCode !== void 0 && code === stopCode || isChainDelimiterCode(code) && isChainedAssignmentLookahead(text, i)) {
      break;
    }
    i += 1;
  }
  return i;
}
function isBareAuthSchemeOwnedValue(text, keyQuote, keyText, valueStart) {
  if (keyQuote !== "" || !isAuthorizationFamilyKey(keyText)) {
    return false;
  }
  const schemeLength = authSchemeLengthAt(text, valueStart);
  if (schemeLength === 0) {
    return false;
  }
  return scanAuthSchemeSeparator(text, valueStart + schemeLength) >= 0;
}
function isMultiTokenAuthorizationValue(text, keyQuote, keyText, valueStart, stopCode, ignoreBareAuthSchemeOwnedValue = false) {
  if (keyQuote !== "" || !isAuthorizationFamilyKey(keyText)) {
    return false;
  }
  if (!ignoreBareAuthSchemeOwnedValue && isBareAuthSchemeOwnedValue(text, keyQuote, keyText, valueStart)) {
    return false;
  }
  const first = text[valueStart] ?? "";
  if (first === '"' || first === "'" || first === "[" || first === "{") {
    return false;
  }
  const scanned = scanCredentialValue(text, valueStart, stopCode);
  if (scanned === null) {
    return false;
  }
  let j = scanned.end;
  while (j < text.length && isAuthWhitespaceCode(text.charCodeAt(j))) {
    j += 1;
  }
  if (j >= text.length) {
    return false;
  }
  if (isChainDelimiterCode(text.charCodeAt(j)) && isChainedAssignmentLookahead(text, j)) {
    return false;
  }
  return true;
}
function scanAuthorizationWholeValueEnd(text, start, stopCode) {
  const length = text.length;
  let i = start;
  let openQuote = "";
  while (i < length) {
    const code = text.charCodeAt(i);
    if (openQuote === "" && (code === 34 || code === 39)) {
      openQuote = text[i] ?? "";
      i += 1;
      continue;
    }
    if (openQuote !== "" && text[i] === openQuote) {
      openQuote = "";
      i += 1;
      continue;
    }
    if (code === 92 && openQuote !== "") {
      i += 2;
      continue;
    }
    if (code === 10) {
      const next = i + 1 < length ? text.charCodeAt(i + 1) : -1;
      if (openQuote !== "" || next === 32 || next === 9 || next === 34 || // "
      next === 39 || // '
      next === 96 || // `
      next === 37 || // %
      isAsciiWordCharCode(next)) {
        i += 1;
        continue;
      }
      break;
    }
    if (openQuote === "" && stopCode !== void 0 && code === stopCode) {
      break;
    }
    i += 1;
  }
  return i;
}
function consumeCredentialValue(text, valueStart, keyQuote, keyText, separator, stopCode) {
  let currentValueStart = valueStart;
  let currentKeyQuote = keyQuote;
  let currentKeyText = keyText;
  let currentSeparator = separator;
  let outerKeyQuote = keyQuote;
  let outerKeyText = keyText;
  let outerSeparator = separator;
  let advancedThroughNestedSensitive = false;
  let malformedSensitiveValue = false;
  const finish = (rendered, end) => {
    if (!advancedThroughNestedSensitive) {
      return { rendered, end };
    }
    const outerKey = outerKeyQuote === "" ? outerKeyText : `${outerKeyQuote}${outerKeyText}${outerKeyQuote}`;
    return { rendered: `${outerKey}${outerSeparator}[REDACTED]`, end };
  };
  while (true) {
    if (currentValueStart >= text.length) {
      return null;
    }
    const first = text[currentValueStart] ?? "";
    const key = currentKeyQuote === "" ? currentKeyText : `${currentKeyQuote}${currentKeyText}${currentKeyQuote}`;
    const credentialSensitive = (malformedSensitiveValue || isCredentialAssignmentSensitiveKey(currentKeyText, currentKeyQuote)) && (malformedSensitiveValue || !isBareAuthSchemeOwnedValue(text, currentKeyQuote, currentKeyText, currentValueStart));
    if (credentialSensitive && currentValueStart < text.length && (text.charCodeAt(currentValueStart) === 61 || text.charCodeAt(currentValueStart) === 58 || encodedAssignmentSeparatorLengthAt(text, currentValueStart) > 0)) {
      malformedSensitiveValue = true;
      const afterRun = scanRepeatedCredentialSeparatorEnd(text, currentValueStart);
      if (afterRun >= text.length) {
        return finish(`${key}${currentSeparator}[REDACTED]`, afterRun);
      }
      currentValueStart = afterRun;
      continue;
    }
    const nestedStart = scanNestedSensitiveAssignmentStart(text, currentValueStart);
    if (nestedStart !== null) {
      if (credentialSensitive) {
        if (!advancedThroughNestedSensitive) {
          outerKeyQuote = currentKeyQuote;
          outerKeyText = currentKeyText;
          outerSeparator = currentSeparator;
          advancedThroughNestedSensitive = true;
        }
        currentKeyQuote = nestedStart.keyQuote;
        currentKeyText = nestedStart.keyText;
        currentSeparator = nestedStart.separator;
        currentValueStart = nestedStart.valueStart;
        continue;
      }
      return { rendered: `${key}${currentSeparator}`, end: currentValueStart };
    }
    if (credentialSensitive && isMultiTokenAuthorizationValue(text, currentKeyQuote, currentKeyText, currentValueStart, stopCode, malformedSensitiveValue)) {
      const end = scanAuthorizationWholeValueEnd(text, currentValueStart, stopCode);
      return finish(`${key}${currentSeparator}[REDACTED]`, end);
    }
    if (first === "[" || first === "{") {
      if (credentialSensitive) {
        const structured = scanStructuredCredentialValue(text, currentValueStart);
        const end = consumeStructuredValueTail(text, structured.end, stopCode);
        return finish(`${key}${currentSeparator}[REDACTED]`, end);
      }
      return { rendered: `${key}${currentSeparator}`, end: currentValueStart };
    }
    if (!credentialSensitive) {
      if (first === '"' || first === "'") {
        const value2 = scanCredentialValue(text, currentValueStart, stopCode);
        if (value2 === null) {
          return null;
        }
        const quote = value2.value[0] ?? "";
        const closed = value2.value.length >= 2 && value2.value[value2.value.length - 1] === quote;
        const interior = closed ? value2.value.slice(1, -1) : value2.value.slice(1);
        const redactedInterior = redactCredentialAssignments(interior);
        return finish(
          `${key}${currentSeparator}${quote}${redactedInterior}${closed ? quote : ""}`,
          value2.end
        );
      }
      return { rendered: `${key}${currentSeparator}`, end: currentValueStart };
    }
    const value = scanCredentialValue(text, currentValueStart, stopCode, true);
    if (value === null) {
      return null;
    }
    const followingCode = value.end >= text.length ? -1 : text.charCodeAt(value.end);
    return finish(
      renderCredentialAssignment(
        {
          keyQuote: currentKeyQuote,
          keyText: currentKeyText,
          separator: currentSeparator,
          value: value.value
        },
        followingCode,
        stopCode
      ),
      value.end
    );
  }
}
function renderCredentialAssignment(match, followingCode, stopCode) {
  const { keyQuote, keyText, separator, value } = match;
  if (!isCredentialAssignmentSensitiveKey(keyText, keyQuote)) {
    return `${keyQuote}${keyText}${keyQuote}${separator}${value}`;
  }
  const key = keyQuote === "" ? keyText : `${keyQuote}${keyText}${keyQuote}`;
  const quote = value[0] ?? "";
  if (quote === '"' || quote === "'") {
    return `${key}${separator}${quote}[REDACTED]${quote}`;
  }
  if (value.startsWith("[REDACTED]")) {
    const tail = value.slice("[REDACTED]".length);
    if (isSafeTerminalDelimiterRun(tail) && isTerminalDelimiterRunBoundary(followingCode, stopCode)) {
      return `${key}${separator}[REDACTED]${tail}`;
    }
    return `${key}${separator}[REDACTED]`;
  }
  const { core, trailing } = splitTrailingPunctuation(
    value,
    isCredentialTrailingPunctuationCode
  );
  if (core.length === 0) {
    return `${key}${separator}[REDACTED]`;
  }
  if (trailing.length > 0 && !isTerminalDelimiterRunBoundary(followingCode, stopCode)) {
    return `${key}${separator}[REDACTED]`;
  }
  return `${key}${separator}[REDACTED]${trailing}`;
}
function redactCredentialAssignments(text) {
  let result = "";
  let i = 0;
  const length = text.length;
  const containerClosers = [];
  while (i < length) {
    const code = text.charCodeAt(i);
    const ch = text[i] ?? "";
    const topCloser = containerClosers[containerClosers.length - 1];
    if (ch === '"' || ch === "'") {
      const precededByWordChar = i > 0 && isAsciiWordCharCode(text.charCodeAt(i - 1));
      const encodedBoundary = precededByWordChar && isEncodedStructuralBoundaryAt(text, i);
      const keyStart = i + 1;
      if (keyStart < length && isAsciiWordCharCode(text.charCodeAt(keyStart))) {
        const spacedRun = scanCredentialKeyRunSpaced(text, keyStart, true);
        const spacedClosingQuote = spacedRun.lastAlnum + 1;
        if (spacedRun.lastAlnum >= keyStart + 1 && spacedClosingQuote < length && text.charCodeAt(spacedClosingQuote) === code) {
          const afterKey = spacedClosingQuote + 1;
          const valueStart = scanCredentialSeparator(text, afterKey);
          if (valueStart >= 0) {
            const keyText = text.slice(keyStart, spacedClosingQuote);
            if (isSensitiveKey(keyText)) {
              const consumed = consumeCredentialValue(
                text,
                valueStart,
                ch,
                keyText,
                text.slice(afterKey, valueStart),
                topCloser
              );
              if (consumed !== null) {
                result += consumed.rendered;
                i = consumed.end;
                continue;
              }
            }
          }
        }
        const flattenedRun = scanCredentialKeyRunFlattened(text, keyStart);
        const flattenedClosingQuote = flattenedRun.lastAlnum + 1;
        if (flattenedRun.lastAlnum >= keyStart + 1 && flattenedClosingQuote < length && text.charCodeAt(flattenedClosingQuote) === code) {
          const afterKey = flattenedClosingQuote + 1;
          const valueStart = scanCredentialSeparator(text, afterKey);
          if (valueStart >= 0) {
            const keyText = text.slice(keyStart, flattenedClosingQuote);
            if (!hasSensitiveColonPrefix(keyText) && isSensitiveKey(keyText)) {
              const consumed = consumeCredentialValue(
                text,
                valueStart,
                ch,
                keyText,
                text.slice(afterKey, valueStart),
                topCloser
              );
              if (consumed !== null) {
                result += consumed.rendered;
                i = consumed.end;
                continue;
              }
            }
          }
        }
        const run = scanCredentialKeyRun(text, keyStart);
        const closingQuote = run.lastAlnum + 1;
        if (run.lastAlnum >= keyStart + 1 && closingQuote < length && text.charCodeAt(closingQuote) === code) {
          const afterKey = closingQuote + 1;
          const valueStart = scanCredentialSeparator(text, afterKey);
          if (valueStart >= 0) {
            const keyText = text.slice(keyStart, closingQuote);
            const sensitive = isSensitiveKey(keyText);
            if (!precededByWordChar || encodedBoundary || sensitive) {
              if (!encodedBoundary || sensitive) {
                const consumed = consumeCredentialValue(
                  text,
                  valueStart,
                  ch,
                  keyText,
                  text.slice(afterKey, valueStart),
                  topCloser
                );
                if (consumed !== null) {
                  result += consumed.rendered;
                  i = consumed.end;
                  continue;
                }
              }
            }
          }
        }
      }
      result += ch;
      i += 1;
      continue;
    }
    if (isAsciiWordCharCode(code)) {
      if (i > 0 && isAsciiWordCharCode(text.charCodeAt(i - 1))) {
        result += ch;
        i += 1;
        continue;
      }
      const spacedRun = scanCredentialKeyRunSpaced(text, i, true);
      if (spacedRun.lastAlnum >= i + 1) {
        const identifierEnd = spacedRun.lastAlnum + 1;
        let keyEnd = identifierEnd;
        let spacedValueStart = -1;
        if (keyEnd < length && isCredentialKeySuffixPunctuationCode(text.charCodeAt(keyEnd))) {
          const suffixedValueStart = scanCredentialKeySuffixSeparator(text, keyEnd);
          if (suffixedValueStart >= 0) {
            keyEnd += 1;
            spacedValueStart = suffixedValueStart;
          }
        }
        if (spacedValueStart < 0) {
          spacedValueStart = scanCredentialSeparator(text, identifierEnd);
        }
        if (spacedValueStart >= 0) {
          const keyText = text.slice(i, keyEnd);
          if (isSensitiveKey(stripSingleCredentialKeySuffixPunctuation(keyText))) {
            const consumed = consumeCredentialValue(
              text,
              spacedValueStart,
              "",
              keyText,
              text.slice(keyEnd, spacedValueStart),
              topCloser
            );
            if (consumed !== null) {
              result += consumed.rendered;
              i = consumed.end;
              continue;
            }
          }
        }
      }
      const flattenedRun = scanCredentialKeyRunFlattened(text, i);
      if (flattenedRun.lastAlnum >= i + 1) {
        const identifierEnd = flattenedRun.lastAlnum + 1;
        let keyEnd = identifierEnd;
        let flattenedValueStart = -1;
        if (keyEnd < length && isCredentialKeySuffixPunctuationCode(text.charCodeAt(keyEnd))) {
          const suffixedValueStart = scanCredentialKeySuffixSeparator(text, keyEnd);
          if (suffixedValueStart >= 0) {
            keyEnd += 1;
            flattenedValueStart = suffixedValueStart;
          }
        }
        if (flattenedValueStart < 0) {
          flattenedValueStart = scanCredentialSeparator(text, identifierEnd);
        }
        if (flattenedValueStart >= 0) {
          const keyText = text.slice(i, keyEnd);
          if (!hasSensitiveColonPrefix(keyText) && isSensitiveKey(stripSingleCredentialKeySuffixPunctuation(keyText))) {
            const consumed = consumeCredentialValue(
              text,
              flattenedValueStart,
              "",
              keyText,
              text.slice(keyEnd, flattenedValueStart),
              topCloser
            );
            if (consumed !== null) {
              result += consumed.rendered;
              i = consumed.end;
              continue;
            }
          }
        }
      }
      const run = scanCredentialKeyRun(text, i);
      if (run.lastAlnum >= i + 1) {
        const identifierEnd = run.lastAlnum + 1;
        let keyEnd = identifierEnd;
        let valueStart = -1;
        if (keyEnd < length && isCredentialKeySuffixPunctuationCode(text.charCodeAt(keyEnd))) {
          const suffixedValueStart = scanCredentialKeySuffixSeparator(text, keyEnd);
          if (suffixedValueStart >= 0) {
            keyEnd += 1;
            valueStart = suffixedValueStart;
          }
        }
        if (valueStart < 0) {
          valueStart = scanCredentialSeparator(text, identifierEnd);
        }
        if (valueStart >= 0) {
          const keyText = text.slice(i, keyEnd);
          const consumed = consumeCredentialValue(
            text,
            valueStart,
            "",
            keyText,
            text.slice(keyEnd, valueStart),
            topCloser
          );
          if (consumed !== null) {
            result += consumed.rendered;
            i = consumed.end;
            continue;
          }
        }
      }
      result += text.slice(i, run.runEnd);
      i = run.runEnd;
      continue;
    }
    if (isOpenStructureCharCode(code)) {
      containerClosers.push(code === 91 ? 93 : 125);
    } else if (isCloseStructureCharCode(code) && topCloser !== void 0 && topCloser === code) {
      containerClosers.pop();
    }
    result += ch;
    i += 1;
  }
  return result;
}
var SECRET_TERMINALS = /* @__PURE__ */ new Set([
  "key",
  "keys",
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwords",
  "passphrase",
  "passphrases",
  "passwd"
]);
var SECRET_KEY_QUALIFIERS = /* @__PURE__ */ new Set([
  "secret",
  "access",
  "api",
  "private",
  "public",
  "session",
  "client",
  "consumer",
  "app",
  "auth",
  "id",
  "refresh",
  "bearer",
  "aws"
]);
var SECRET_PAIRS = [
  ["api", "key"],
  ["api", "keys"],
  ["access", "token"],
  ["refresh", "token"],
  ["client", "secret"],
  ["db", "password"]
];
var SENSITIVE_KEY_NORM_BASES = [
  "privatekey",
  "secretkey",
  "accesskey",
  "credential",
  "jwt",
  "authtoken",
  "idtoken",
  "sessiontoken",
  "sessionkey",
  "passphrase",
  "apikey",
  "password",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "dbpassword"
];
var SENSITIVE_KEY_NORMS = /* @__PURE__ */ new Set(["authorization", "bearer"]);
for (const base of SENSITIVE_KEY_NORM_BASES) {
  SENSITIVE_KEY_NORMS.add(base);
  SENSITIVE_KEY_NORMS.add(`${base}s`);
}
function isSensitiveKeyIgnorableAt(text, index) {
  const code = text.charCodeAt(index);
  return isSeparatorSentinelCode(code) || isUnsafeControlCharCode(code) || isAuthWhitespaceCode(code) || isFormatCharacterAt(text, index);
}
function isSensitiveKeyBoundaryAt(text, index) {
  const code = text.charCodeAt(index);
  return isSeparatorSentinelCode(code) || isUnsafeControlCharCode(code) || isAuthWhitespaceCode(code) || isFormatCharacterAt(text, index) || code === 46 || // .
  code === 47 || // /
  code === 58;
}
function stripSensitiveKeyIgnorables(key) {
  let result = "";
  for (let i = 0; i < key.length; i++) {
    if (isSensitiveKeyIgnorableAt(key, i)) {
      if (key.charCodeAt(i) >= 55296 && key.charCodeAt(i) <= 56319 && isFormatCharacterAt(key, i)) {
        i += 1;
      }
      continue;
    }
    result += key[i] ?? "";
  }
  return result;
}
function decodePercentForClassification(key) {
  if (!key.includes("%")) {
    return key;
  }
  let result = "";
  for (let i = 0; i < key.length; i++) {
    const ch = key[i] ?? "";
    if (ch === "%" && i + 2 < key.length) {
      const high = hexDigitValue(key.charCodeAt(i + 1));
      const low = hexDigitValue(key.charCodeAt(i + 2));
      if (high >= 0 && low >= 0) {
        result += String.fromCharCode(high * 16 + low);
        i += 2;
        continue;
      }
    }
    result += ch;
  }
  return result;
}
function splitKeySegments(key) {
  key = decodePercentForClassification(key);
  let normalized = "";
  for (let i = 0; i < key.length; i++) {
    if (isSensitiveKeyBoundaryAt(key, i)) {
      if (normalized.length > 0 && normalized[normalized.length - 1] !== "_") {
        normalized += "_";
      }
      if (key.charCodeAt(i) >= 55296 && key.charCodeAt(i) <= 56319 && isFormatCharacterAt(key, i)) {
        i += 1;
      }
    } else {
      normalized += key[i] ?? "";
    }
  }
  const segments = [];
  for (const raw of normalized.split(/[_-]+/)) {
    let word = "";
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i] ?? "";
      const prev = raw[i - 1] ?? "";
      const next = raw[i + 1] ?? "";
      const upper = ch >= "A" && ch <= "Z";
      const prevUpper = prev >= "A" && prev <= "Z";
      const nextLower = next >= "a" && next <= "z";
      if (word.length > 0 && upper && (!prevUpper || nextLower)) {
        segments.push(word.toLowerCase());
        word = ch;
      } else {
        word += ch;
      }
    }
    if (word.length > 0) {
      segments.push(word.toLowerCase());
    }
  }
  return segments;
}
function isAuthorizationFamilyKey(key) {
  const cleaned = stripSingleCredentialKeySuffixPunctuation(key);
  const segments = splitKeySegments(cleaned);
  if ((segments[segments.length - 1] ?? "") === "authorization") {
    return true;
  }
  const merged = splitKeySegments(stripSensitiveKeyIgnorables(cleaned));
  return (merged[merged.length - 1] ?? "") === "authorization";
}
function isCredentialAssignmentSensitiveKey(keyText, keyQuote) {
  const classifiedKey = keyQuote === "" ? stripSingleCredentialKeySuffixPunctuation(keyText) : keyText;
  if (!isSensitiveKey(classifiedKey)) {
    return false;
  }
  if (keyQuote === "") {
    const norm = splitKeySegments(classifiedKey).join("");
    return norm !== "bearer";
  }
  return true;
}
function isSensitiveKeySegments(segments) {
  if (segments.join("") === "apikey") {
    return true;
  }
  const last = segments[segments.length - 1] ?? "";
  if (last === "authorization") {
    return true;
  }
  if (SENSITIVE_KEY_NORMS.has(segments.join(""))) {
    return true;
  }
  if (SECRET_TERMINALS.has(last)) {
    if (last === "key" || last === "keys") {
      for (const segment of segments) {
        if (segment !== last && SECRET_KEY_QUALIFIERS.has(segment)) {
          return true;
        }
      }
    } else {
      return true;
    }
  }
  if (last === "id" || last === "ids") {
    for (const segment of segments) {
      if (segment !== last && (SECRET_KEY_QUALIFIERS.has(segment) || SECRET_TERMINALS.has(segment))) {
        return true;
      }
    }
  }
  if (segments.length >= 2) {
    const head = segments[segments.length - 2] ?? "";
    for (const [first, second] of SECRET_PAIRS) {
      if (head === first && last === second) {
        return true;
      }
    }
  }
  return false;
}
function isSensitiveKey(key) {
  const segments = splitKeySegments(key);
  if (isSensitiveKeySegments(segments)) {
    return true;
  }
  const mergedSegments = splitKeySegments(stripSensitiveKeyIgnorables(key));
  return isSensitiveKeySegments(mergedSegments);
}
function isCredentialTrailingPunctuationCode(code) {
  return code === 46 || // .
  code === 44 || // ,
  code === 59 || // ;
  code === 58 || // :
  code === 33 || // !
  code === 63 || // ?
  code === 41;
}
var URL_SPAN_SCHEME_ENCODED = /^[A-Za-z][A-Za-z0-9+.-]*%3[aA]%2[fF]%2[fF]/;
var lastSchemeMatchHadGap = false;
function rawUrlSpanSchemeLengthAt(text, index) {
  lastSchemeMatchHadGap = false;
  const length = text.length;
  let i = index;
  if (i >= length) return 0;
  let c = text.charCodeAt(i);
  if (!(c >= 65 && c <= 90 || c >= 97 && c <= 122)) return 0;
  i += 1;
  const isSchemeTailGapCode = (code) => isSeparatorSentinelCode(code) || code === 32 || code === 10;
  let sawColon = false;
  let slashes = 0;
  let schemeChars = 0;
  while (i < length) {
    c = text.charCodeAt(i);
    if (isSchemeTailGapCode(c)) {
      if (sawColon || slashes > 0) {
        lastSchemeMatchHadGap = true;
        i += 1;
        continue;
      }
      let peek = i;
      while (peek < length && isSchemeTailGapCode(text.charCodeAt(peek))) {
        peek += 1;
      }
      if (peek < length && text.charCodeAt(peek) === 58) {
        lastSchemeMatchHadGap = true;
        i = peek;
        continue;
      }
      return 0;
    }
    if (!sawColon) {
      if (c === 58) {
        sawColon = true;
        i += 1;
        continue;
      }
      if (c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c === 43 || c === 45 || c === 46) {
        schemeChars += 1;
        if (schemeChars > 24) return 0;
        i += 1;
        continue;
      }
      return 0;
    }
    if (c === 47) {
      slashes += 1;
      i += 1;
      if (slashes === 2) return i - index;
      continue;
    }
    return 0;
  }
  return 0;
}
function encodedUrlSpanSchemeLengthAt(text, index) {
  if (index >= text.length || text[index] !== "%") {
    const match = URL_SPAN_SCHEME_ENCODED.exec(text.slice(index, index + 32));
    return match === null ? 0 : match[0].length;
  }
  return 0;
}
function isUrlSpanSchemeStartAt(text, index) {
  return rawUrlSpanSchemeLengthAt(text, index) > 0 || encodedUrlSpanSchemeLengthAt(text, index) > 0;
}
function hasProtocolRelativeUserinfoAt(text, index) {
  const length = text.length;
  if (index + 2 > length || text.charCodeAt(index) !== 47 || text.charCodeAt(index + 1) !== 47) {
    return false;
  }
  if (index > 0 && isAsciiWordCharCode(text.charCodeAt(index - 1))) {
    return false;
  }
  let i = index + 2;
  while (i < length) {
    const code = text.charCodeAt(i);
    if (code === 64) return true;
    if (code === 47 || isUrlSpanBoundaryCode(code)) return false;
    i += 1;
  }
  return false;
}
function isUrlSpanBoundaryCode(code) {
  return isSeparatorSentinelCode(code) || code === 32 || code === 10 || code === 34 || code === 39 || code === 96 || code === 60 || code === 62;
}
function scanUrlAuthorityReassembly(text, from, gapStart, seenAt) {
  const length = text.length;
  let k = from;
  let lastGap = -1;
  let sawColon = false;
  let sawPercent = gapStart > 0 && text.charCodeAt(gapStart - 1) === 37;
  while (k < length) {
    while (k < length && !isUrlSpanBoundaryCode(text.charCodeAt(k))) {
      const code = text.charCodeAt(k);
      if (code === 64) {
        return { swallow: true, next: k + 1, seenAt: true };
      }
      if (code === 58) sawColon = true;
      if (code === 37) sawPercent = true;
      k += 1;
    }
    if (k >= length) break;
    const boundary = text.charCodeAt(k);
    if (boundary !== 32 && boundary !== 10 && !isSeparatorSentinelCode(boundary)) {
      break;
    }
    lastGap = k;
    while (k < length && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 10 || isSeparatorSentinelCode(text.charCodeAt(k)))) {
      k += 1;
    }
    if (k >= length) break;
    const nextCode = text.charCodeAt(k);
    if (nextCode === 47 || nextCode === 63 || nextCode === 35) break;
    if (isUrlSpanSchemeStartAt(text, k)) break;
  }
  if (!seenAt && (sawColon || sawPercent)) {
    return { swallow: true, next: lastGap >= 0 ? lastGap : k, seenAt: false };
  }
  return { swallow: false, next: 0, seenAt: false };
}
function findUrlSpanEnd(text, start, schemeLength) {
  const length = text.length;
  let seenAt = false;
  let i = start + schemeLength;
  while (i < length) {
    const code = text.charCodeAt(i);
    if (!isUrlSpanBoundaryCode(code)) {
      if (code === 64) seenAt = true;
      i += 1;
      continue;
    }
    let j = i;
    while (j < length && isUrlSpanBoundaryCode(text.charCodeAt(j))) j += 1;
    if (j >= length) return i;
    const tailCode = text.charCodeAt(j);
    if (tailCode === 64) {
      i = j;
      seenAt = true;
      continue;
    }
    if (tailCode === 47 || tailCode === 63 || tailCode === 35) {
      return i;
    }
    if (isUrlSpanSchemeStartAt(text, j)) {
      return i;
    }
    const reassembly = scanUrlAuthorityReassembly(text, j, i, seenAt);
    if (reassembly.swallow) {
      i = reassembly.next;
      seenAt = reassembly.seenAt;
      continue;
    }
    return i;
  }
  return length;
}
function isUrlSpanTrailingPunctuationCode(code) {
  return code === 33 || // !
  code === 44 || // ,
  code === 46 || // .
  code === 58 || // :
  code === 59 || // ;
  code === 63 || // ?
  code === 41 || // )
  code === 93 || // ]
  code === 125;
}
function redactUrlSpans(text) {
  let result = "";
  let cursor = 0;
  const length = text.length;
  for (; ; ) {
    let start = -1;
    let startSchemeLength = 0;
    let scan = cursor;
    while (scan < length) {
      const c0 = text.charCodeAt(scan);
      if (c0 >= 65 && c0 <= 90 || c0 >= 97 && c0 <= 122) {
        const rawLength = rawUrlSpanSchemeLengthAt(text, scan);
        const schemeLength = rawLength > 0 ? rawLength : encodedUrlSpanSchemeLengthAt(text, scan);
        if (schemeLength > 0) {
          start = scan;
          startSchemeLength = schemeLength;
          break;
        }
      } else if (c0 === 47 && hasProtocolRelativeUserinfoAt(text, scan)) {
        start = scan;
        startSchemeLength = 2;
        break;
      }
      scan += 1;
    }
    if (start === -1) {
      result += text.slice(cursor);
      return result;
    }
    result += text.slice(cursor, start);
    let end = findUrlSpanEnd(text, start, startSchemeLength);
    while (end > start && isUrlSpanTrailingPunctuationCode(text.charCodeAt(end - 1))) {
      end -= 1;
    }
    result += "[REDACTED_URL]";
    cursor = end;
  }
}
var HIGH_ENTROPY_TOKEN_MIN_LENGTH = 20;
var HIGH_ENTROPY_TOKEN_MIN_ENTROPY_BITS_PER_CHAR = 4;
function isHighEntropyTokenBoundaryCode(code) {
  return isUrlSpanBoundaryCode(code) || code === 40 || code === 41 || code === 91 || code === 93 || code === 123 || code === 125;
}
function shannonEntropyBitsPerChar(token) {
  const counts = /* @__PURE__ */ new Map();
  let total = 0;
  for (const ch of token) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
    total += 1;
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
function markerLengthAt(text, index) {
  if (text.startsWith("[REDACTED_URL]", index)) return 14;
  if (text.startsWith("[REDACTED]", index)) return 10;
  return 0;
}
function rootAliasLengthAt(text, index) {
  const code = text.charCodeAt(index);
  if (code !== ROOT_ALIAS_PREFIX_CODE && code !== 36) return 0;
  const next = index + 1;
  if (text.startsWith("WORKSPACE", next)) return 1 + "WORKSPACE".length;
  if (text.startsWith("ARTIFACTS", next)) return 1 + "ARTIFACTS".length;
  if (text.startsWith("TMP", next)) return 1 + "TMP".length;
  return 0;
}
function trustedAtomLengthAt(text, index) {
  return markerLengthAt(text, index) || rootAliasLengthAt(text, index);
}
function redactHighEntropyTokens(text) {
  let result = "";
  let cursor = 0;
  const length = text.length;
  while (cursor < length) {
    const atom = trustedAtomLengthAt(text, cursor);
    if (atom > 0) {
      result += text.slice(cursor, cursor + atom);
      cursor += atom;
      continue;
    }
    if (isHighEntropyTokenBoundaryCode(text.charCodeAt(cursor))) {
      result += text[cursor];
      cursor += 1;
      continue;
    }
    let end = cursor;
    while (end < length && !isHighEntropyTokenBoundaryCode(text.charCodeAt(end))) {
      if (trustedAtomLengthAt(text, end) > 0) break;
      end += 1;
    }
    const token = text.slice(cursor, end);
    let codePoints = 0;
    for (const _ of token) codePoints += 1;
    if (codePoints >= HIGH_ENTROPY_TOKEN_MIN_LENGTH && shannonEntropyBitsPerChar(token) >= HIGH_ENTROPY_TOKEN_MIN_ENTROPY_BITS_PER_CHAR) {
      result += "[REDACTED]";
    } else {
      result += token;
    }
    cursor = end;
  }
  return result;
}
function redactTextWithRoots(text, normalized) {
  let result = normalizeSeparators(text);
  result = redactUrlSpans(result);
  result = redactBearerAndBasic(result);
  result = redactCredentialAssignments(result);
  if (normalized !== void 0) {
    result = redactRoots(result, normalized);
  }
  result = redactHighEntropyTokens(result);
  return result.replaceAll(SEPARATOR_SENTINEL, " ").replaceAll(ROOT_ALIAS_PREFIX, "$");
}
function redactText(text, roots) {
  if (typeof text !== "string") {
    throw new TypeError("redactText: text must be a string");
  }
  const normalized = roots === void 0 ? void 0 : validateRoots(roots);
  return redactTextWithRoots(text, normalized);
}
var ROOT_ALIAS_RENDERED = {
  workspace: "$WORKSPACE",
  temp: "$TMP",
  artifacts: "$ARTIFACTS"
};
function isPathWithin(base, candidate) {
  return candidate === base || candidate.startsWith(base + "/");
}
function projectArtifactPath(value, normalized) {
  if (normalized === void 0) {
    return "[REDACTED]";
  }
  if (typeof value !== "string" || value.length === 0) {
    return "[REDACTED]";
  }
  if (WINDOWS_DRIVE_ROOT.test(value) || WINDOWS_UNC_ROOT.test(value)) {
    return "[REDACTED]";
  }
  if (hasUnsafeRootCharacter(value) || !value.startsWith("/")) {
    return "[REDACTED]";
  }
  let resolved;
  try {
    resolved = normalizeRoot(value);
  } catch {
    return "[REDACTED]";
  }
  let candidate;
  try {
    candidate = normalizeRoot(realpathSync(resolved));
  } catch {
    candidate = resolved;
  }
  for (const key of ROOT_KEYS) {
    for (const alias of normalized.aliases[key]) {
      if (isPathWithin(alias, candidate)) {
        const relative2 = candidate.slice(alias.length).replace(/^\/+/, "");
        return relative2.length === 0 ? ROOT_ALIAS_RENDERED[key] : ROOT_ALIAS_RENDERED[key] + "/" + relative2;
      }
    }
  }
  return "[REDACTED]";
}

// src/redaction/index.ts
function projectArtifactPath2(value, roots) {
  if (typeof value !== "string") {
    throw new TypeError("projectArtifactPath: value must be a string");
  }
  const normalized = roots === void 0 ? void 0 : validateRoots(roots);
  return projectArtifactPath(value, normalized);
}
function joinProjectionPath(parent, _key) {
  return parent + '["<key>"]';
}
function isArtifactPathPosition(segments) {
  if (segments.length === 3 && segments[0] === "artifacts" && typeof segments[1] === "number" && segments[2] === "path") {
    return true;
  }
  return segments.length === 4 && segments[0] === "advisory" && typeof segments[1] === "number" && segments[2] === "artifact" && segments[3] === "path";
}
function projectJsonValue(value, roots, path2, segments = []) {
  if (typeof value === "string") {
    if (isArtifactPathPosition(segments)) {
      return projectArtifactPath(value, roots);
    }
    return redactTextWithRoots(value, roots);
  }
  if (Array.isArray(value)) {
    const result = new Array(value.length);
    for (let index = 0; index < value.length; index++) {
      result[index] = projectJsonValue(value[index], roots, path2 + "[" + index + "]", [...segments, index]);
    }
    return result;
  }
  if (value !== null && typeof value === "object") {
    const entries = [];
    const projected = /* @__PURE__ */ new Set();
    for (const originalKey of Object.keys(value)) {
      const projectedKey = redactTextWithRoots(originalKey, roots);
      if (projected.has(projectedKey)) {
        throw new TypeError("projectRedactedJsonValue: key collision at " + path2);
      }
      projected.add(projectedKey);
      const descriptor = Object.getOwnPropertyDescriptor(value, originalKey);
      const child = descriptor === void 0 ? void 0 : descriptor.value;
      const projectedValue = isSensitiveKey(originalKey) || projectedKey !== originalKey ? "[REDACTED]" : projectJsonValue(child, roots, joinProjectionPath(path2, projectedKey), [...segments, originalKey]);
      entries.push([projectedKey, projectedValue]);
    }
    entries.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
    const result = {};
    for (const [key, value2] of entries) {
      Object.defineProperty(result, key, {
        value: value2,
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
    return result;
  }
  return value;
}
function projectRedactedJsonValue(value, roots) {
  const normalized = normalizeJsonValue(value);
  const validatedRoots = roots === void 0 ? void 0 : validateRoots(roots);
  return projectJsonValue(normalized, validatedRoots, "$");
}

// src/replay/assertions.ts
function matchesNode(node, predicate) {
  if (predicate.role !== void 0 && node.role !== predicate.role) return false;
  if (predicate.name !== void 0 && node.name !== predicate.name) return false;
  if (predicate.tag !== void 0 && node.tag !== predicate.tag) return false;
  return true;
}
function toObservedNode(node) {
  return { role: node.role, name: node.name, tag: node.tag };
}
function evaluateAssertion(assertion, observation) {
  const kind = assertion.kind;
  if (kind === "node-present") {
    const predicate = assertion.expected;
    const matches = observation.nodes.filter((node) => matchesNode(node, predicate));
    return { passed: matches.length > 0, observed: matches.map(toObservedNode) };
  }
  if (kind === "node-absent") {
    const predicate = assertion.expected;
    const match = observation.nodes.find((node) => matchesNode(node, predicate));
    return { passed: match === void 0, observed: match === void 0 ? null : toObservedNode(match) };
  }
  const expected = assertion.expected;
  const actual = observation.page.url;
  let passed;
  if (expected.url !== void 0) passed = actual === expected.url;
  else if (expected.contains !== void 0) passed = actual.includes(expected.contains);
  else passed = false;
  return { passed, observed: actual };
}

// src/replay/loader.ts
import { readFileSync } from "node:fs";
var ScenarioValidationError = class extends Error {
  position;
  reason;
  constructor(position, reason) {
    super("scenario validation failed at " + position + ": " + reason);
    this.name = "ScenarioValidationError";
    this.position = position;
    this.reason = reason;
  }
};
function fail(position, reason) {
  throw new ScenarioValidationError(position, reason);
}
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function expectObject(value, position) {
  if (!isPlainObject2(value)) fail(position, "expected an object");
  return value;
}
function expectArray(value, position) {
  if (!Array.isArray(value)) fail(position, "expected an array");
  return value;
}
function expectString(value, position) {
  if (typeof value !== "string") fail(position, "expected a string");
  return value;
}
function expectNonEmptyString(value, position) {
  const s = expectString(value, position);
  if (s.trim() === "") fail(position, "expected a non-empty string");
  return s;
}
function assertKnownFields(obj, allowed, position) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(position, "unexpected field");
  }
}
function assertLossless(value, position) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail(position, "number is not lossless JSON (non-finite or negative zero)");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertLossless(value[i], position + "[" + i + "]");
    return;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child === void 0) fail(position, "object contains a key with an undefined value");
      assertLossless(child, position);
    }
    return;
  }
  fail(position, "value is not lossless JSON");
}
var DRIVER_KINDS = ["browser", "computer"];
var ASSERTION_KINDS = ["node-present", "node-absent", "page-url"];
var ROOT_FIELDS = ["meta", "target", "steps", "assertions", "advisory"];
var META_FIELDS = ["name", "description", "driver", "createdAt", "notes"];
var TARGET_FIELDS = ["launch"];
var STEP_FIELDS = ["index", "intent", "action", "assert"];
var ASSERTION_FIELDS = ["kind", "expected", "description"];
var VISUAL_ASSERTION_FIELDS = ["kind", "question", "description"];
var PREDICATE_FIELDS = ["role", "name", "tag"];
function isDriverKind(value) {
  return typeof value === "string" && DRIVER_KINDS.includes(value);
}
function isAssertionKind(value) {
  return typeof value === "string" && ASSERTION_KINDS.includes(value);
}
function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
function validateMeta(value, position) {
  const obj = expectObject(value, position);
  assertKnownFields(obj, META_FIELDS, position);
  const name2 = expectNonEmptyString(obj.name, position + ".name");
  const description = expectString(obj.description, position + ".description");
  const driver = obj.driver;
  if (!isDriverKind(driver)) fail(position + ".driver", "unsupported driver");
  const createdAt = expectNonEmptyString(obj.createdAt, position + ".createdAt");
  if (Number.isNaN(Date.parse(createdAt))) fail(position + ".createdAt", "expected an ISO 8601 timestamp");
  let notes;
  if (obj.notes !== void 0) {
    notes = expectArray(obj.notes, position + ".notes").map(
      (item, i) => expectNonEmptyString(item, position + ".notes[" + i + "]")
    );
  }
  return { name: name2, description, driver, createdAt, ...notes === void 0 ? {} : { notes } };
}
function validateTarget(value, position, driver) {
  const obj = expectObject(value, position);
  assertKnownFields(obj, TARGET_FIELDS, position);
  const launch = expectNonEmptyString(obj.launch, position + ".launch");
  if (driver === "browser" && !isValidHttpUrl(launch)) {
    fail(position + ".launch", "expected an http(s) URL");
  }
  return { launch };
}
function validatePredicate(value, position) {
  const obj = expectObject(value, position);
  assertKnownFields(obj, PREDICATE_FIELDS, position);
  const out = {};
  if (obj.role !== void 0) out.role = expectNonEmptyString(obj.role, position + ".role");
  if (obj.name !== void 0) out.name = expectNonEmptyString(obj.name, position + ".name");
  if (obj.tag !== void 0) out.tag = expectNonEmptyString(obj.tag, position + ".tag");
  if (out.role === void 0 && out.name === void 0 && out.tag === void 0) {
    fail(position, "expected at least one of role/name/tag");
  }
  return out;
}
function validateAction(value, position) {
  const obj = expectObject(value, position);
  const kind = expectNonEmptyString(obj.kind, position + ".kind");
  if (kind === "click") {
    assertKnownFields(obj, ["kind", "target"], position);
    return { kind: "click", target: validatePredicate(obj.target, position + ".target") };
  }
  if (kind === "fill") {
    assertKnownFields(obj, ["kind", "target", "text"], position);
    return {
      kind: "fill",
      target: validatePredicate(obj.target, position + ".target"),
      text: expectNonEmptyString(obj.text, position + ".text")
    };
  }
  if (kind === "press") {
    assertKnownFields(obj, ["kind", "target", "key"], position);
    return {
      kind: "press",
      target: validatePredicate(obj.target, position + ".target"),
      key: expectNonEmptyString(obj.key, position + ".key")
    };
  }
  if (kind === "navigate") {
    assertKnownFields(obj, ["kind", "url"], position);
    return { kind: "navigate", url: expectNonEmptyString(obj.url, position + ".url") };
  }
  fail(position + ".kind", "unsupported action kind");
}
function validateAssertion(value, position = "assertion") {
  const obj = expectObject(value, position);
  assertKnownFields(obj, ASSERTION_FIELDS, position);
  const rawKind = obj.kind;
  if (!isAssertionKind(rawKind)) fail(position + ".kind", "unsupported assertion kind");
  const kind = rawKind;
  if (obj.expected === void 0) fail(position + ".expected", "required");
  assertLossless(obj.expected, position + ".expected");
  if (kind === "node-present" || kind === "node-absent") {
    validatePredicate(obj.expected, position + ".expected");
  } else {
    const expected = expectObject(obj.expected, position + ".expected");
    assertKnownFields(expected, ["url", "contains"], position + ".expected");
    const hasUrl = expected.url !== void 0;
    const hasContains = expected.contains !== void 0;
    if (hasUrl === hasContains) {
      fail(position + ".expected", "expected exactly one of url or contains");
    }
    if (hasUrl) expectNonEmptyString(expected.url, position + ".expected.url");
    else expectNonEmptyString(expected.contains, position + ".expected.contains");
  }
  const out = { kind, expected: obj.expected };
  if (obj.description !== void 0) {
    out.description = expectNonEmptyString(obj.description, position + ".description");
  }
  return out;
}
function validateVisualAssertion(value, position = "advisory") {
  const obj = expectObject(value, position);
  assertKnownFields(obj, VISUAL_ASSERTION_FIELDS, position);
  if (obj.kind !== "visual") fail(position + ".kind", 'expected kind "visual"');
  const question = expectNonEmptyString(obj.question, position + ".question");
  const out = { kind: "visual", question };
  if (obj.description !== void 0) {
    out.description = expectNonEmptyString(obj.description, position + ".description");
  }
  return out;
}
function validateAdvisory(value, position) {
  const arr = expectArray(value, position);
  return arr.map((item, i) => validateVisualAssertion(item, position + "[" + i + "]"));
}
function validateStep(value, position) {
  const obj = expectObject(value, position);
  assertKnownFields(obj, STEP_FIELDS, position);
  const indexValue = obj.index;
  if (typeof indexValue !== "number" || !Number.isInteger(indexValue) || indexValue < 1) {
    fail(position + ".index", "expected a positive integer");
  }
  const intent = expectNonEmptyString(obj.intent, position + ".intent");
  const action = validateAction(obj.action, position + ".action");
  const assert = validateAssertion(obj.assert, position + ".assert");
  return { index: indexValue, intent, action, assert };
}
function validateSteps(value, position) {
  const arr = expectArray(value, position);
  if (arr.length === 0) fail(position, "expected at least one step");
  return arr.map((item, i) => {
    const step = validateStep(item, position + "[" + i + "]");
    if (step.index !== i + 1) {
      fail(position + "[" + i + "].index", "expected the 1-based step index to match its position");
    }
    return step;
  });
}
function validateAssertions(value, position) {
  const arr = expectArray(value, position);
  return arr.map((item, i) => validateAssertion(item, position + "[" + i + "]"));
}
function validateScenario(value) {
  const root = expectObject(value, "$");
  assertKnownFields(root, ROOT_FIELDS, "$");
  const meta = validateMeta(root.meta, "meta");
  const target = validateTarget(root.target, "target", meta.driver);
  const steps = validateSteps(root.steps, "steps");
  const assertions = validateAssertions(root.assertions, "assertions");
  const advisory = root.advisory === void 0 ? void 0 : validateAdvisory(root.advisory, "advisory");
  return { meta, target, steps, assertions, ...advisory === void 0 ? {} : { advisory } };
}
function jsonPosition(error) {
  if (error instanceof Error) {
    const m = /position (\d+)/.exec(error.message);
    if (m !== null && m[1] !== void 0) return " at character " + m[1];
  }
  return "";
}
function parseScenario(text, source) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ScenarioValidationError(source, "invalid JSON" + jsonPosition(error));
  }
  try {
    return validateScenario(value);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      throw new ScenarioValidationError(source + ":" + error.position, error.reason);
    }
    throw error;
  }
}
function loadScenarioFromPath(path2) {
  let text;
  try {
    text = readFileSync(path2, "utf8");
  } catch {
    throw new ScenarioValidationError(path2, "cannot read file");
  }
  return parseScenario(text, path2);
}

// src/replay/determinism.ts
var FIXED_TIMESTAMP = "<timestamp>";
var EXCLUDED_FIELDS = /* @__PURE__ */ new Set(["advisory", "artifacts", "evidence"]);
function normalizeReportForDeterminism(report) {
  const record = report;
  const projected = {};
  for (const key of Object.keys(record)) {
    if (EXCLUDED_FIELDS.has(key)) continue;
    if (key === "startedAt" || key === "finishedAt") {
      projected[key] = FIXED_TIMESTAMP;
      continue;
    }
    projected[key] = record[key];
  }
  return projected;
}

// src/replay/runner.ts
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";

// src/vision.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
var DEFAULT_VISION_PROVIDER = "deepseek-official";
var DEFAULT_VISION_MODEL = "deepseek-v4-flash-vision-exp";
var VISION_MODEL_UNAVAILABLE = "vision-model-unavailable";
var TICK = String.fromCharCode(96);
var FENCE = TICK + TICK + TICK;
function buildPrompt(question) {
  return question + '\n\nAnswer with exactly one JSON object and nothing else. The object must have exactly these three fields: "verdict" is one of "yes", "no", or "unclear"; "confidence" is a number between 0 and 1; "reasoning" is a short string explaining the verdict.';
}
function stripFence(text) {
  let candidate = text.trim();
  if (candidate.startsWith(FENCE)) {
    const firstNewline = candidate.indexOf("\n");
    if (firstNewline !== -1) {
      candidate = candidate.slice(firstNewline + 1);
    } else {
      candidate = candidate.slice(FENCE.length);
    }
    if (candidate.endsWith(FENCE)) candidate = candidate.slice(0, -FENCE.length);
    candidate = candidate.trim();
  }
  return candidate;
}
function extractJsonObject(text) {
  const candidate = stripFence(text);
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return candidate;
  return candidate.slice(start, end + 1);
}
function clampConfidence(value) {
  return Math.min(1, Math.max(0, value));
}
function parseVerdict(text) {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { verdict: "unclear", confidence: 0, reasoning: "", reason: "empty-response" };
  }
  let value;
  try {
    value = JSON.parse(extractJsonObject(trimmed));
  } catch {
    return { verdict: "unclear", confidence: 0, reasoning: trimmed, reason: "unparseable-output" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { verdict: "unclear", confidence: 0, reasoning: trimmed, reason: "unparseable-output" };
  }
  const record = value;
  const verdict = record.verdict;
  if (verdict !== "yes" && verdict !== "no" && verdict !== "unclear") {
    const reasoning2 = typeof record.reasoning === "string" ? record.reasoning : trimmed;
    return { verdict: "unclear", confidence: 0, reasoning: reasoning2, reason: "invalid-verdict" };
  }
  const rawConfidence = record.confidence;
  const confidence = typeof rawConfidence === "number" && Number.isFinite(rawConfidence) ? clampConfidence(rawConfidence) : verdict === "unclear" ? 0 : 0.5;
  const reasoning = typeof record.reasoning === "string" ? record.reasoning : "";
  return { verdict, confidence, reasoning };
}
function normalizeImageRef(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("attachment service returned no image reference");
  }
  const ref = value;
  if (typeof ref.attachmentId !== "string" || ref.attachmentId === "") {
    throw new Error("attachment service returned an invalid attachmentId");
  }
  const mediaType = ref.mediaType;
  if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp" && mediaType !== "image/gif") {
    throw new Error("attachment service returned an unsupported image mediaType");
  }
  const bytes = ref.bytes;
  const width = ref.width;
  const height = ref.height;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("attachment bytes must be a positive safe integer");
  if (!Number.isSafeInteger(width) || width <= 0) throw new Error("attachment width must be a positive safe integer");
  if (!Number.isSafeInteger(height) || height <= 0) throw new Error("attachment height must be a positive safe integer");
  return {
    attachmentId: ref.attachmentId,
    mediaType,
    bytes,
    width,
    height,
    ...typeof ref.name === "string" ? { name: ref.name } : {}
  };
}
function describeFailure(reason) {
  if (reason === null || typeof reason !== "object") return String(reason);
  const failure = reason.failure;
  if (failure === null || typeof failure !== "object") return JSON.stringify(reason);
  const code = failure.code;
  const message = failure.message;
  return String(code ?? "") + (message === void 0 ? "" : ": " + String(message));
}
async function evaluateVisualQuestion(question, capture, services) {
  const attachments = services?.attachments;
  const llm = services?.llm;
  if (attachments === void 0 || llm === void 0 || typeof attachments.saveImage !== "function" || typeof llm.stream !== "function") {
    return { verdict: "unclear", confidence: 0, reasoning: "vision model unavailable", reason: VISION_MODEL_UNAVAILABLE };
  }
  let ref;
  try {
    ref = normalizeImageRef(await attachments.saveImage({ data: capture.png, mediaType: "image/png", name: "dsh-qa-visual.png" }));
  } catch (error) {
    return {
      verdict: "unclear",
      confidence: 0,
      reasoning: "could not persist the captured image: " + (error instanceof Error ? error.message : String(error)),
      reason: "image-persist-failed"
    };
  }
  const provider = services?.provider ?? DEFAULT_VISION_PROVIDER;
  const model = services?.model ?? DEFAULT_VISION_MODEL;
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: buildPrompt(question) },
        { type: "image", attachment: ref }
      ]
    }
  ];
  let text = "";
  try {
    const stream = llm.stream({ provider, model, messages });
    for await (const raw of stream) {
      const chunk = raw;
      if (chunk.type === "text-delta" && typeof chunk.text === "string") {
        text += chunk.text;
      } else if (chunk.type === "finish" && chunk.reason !== void 0) {
        const reason = chunk.reason;
        if (reason.kind === "error" || reason.kind === "aborted") {
          throw new Error("vision model stream " + reason.kind + ": " + describeFailure(chunk.reason));
        }
      }
    }
  } catch (error) {
    return {
      verdict: "unclear",
      confidence: 0,
      reasoning: "vision model call failed: " + (error instanceof Error ? error.message : String(error)),
      reason: "vision-model-error"
    };
  }
  return parseVerdict(text);
}
async function persistCaptureFile(capture, capturesDir) {
  if (capture.artifactPath !== void 0 && capture.artifactPath !== "") {
    return capture.artifactPath;
  }
  await mkdir(capturesDir, { recursive: true });
  const path2 = join(capturesDir, "dsh-qa-visual-" + capture.sha256.slice(0, 16) + ".png");
  await writeFile(path2, capture.png);
  return path2;
}

// src/replay/runner.ts
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function resolveRef(target, observation) {
  const node = observation.nodes.find((n) => matchesNode(n, target));
  if (node === void 0) {
    throw new Error("no observable node matches the action target");
  }
  return node.ref;
}
function resolveAction(action, observation) {
  if (action.kind === "navigate") return { kind: "navigate", url: action.url };
  if (action.kind === "click") return { kind: "click", ref: resolveRef(action.target, observation) };
  if (action.kind === "fill") {
    return { kind: "fill", ref: resolveRef(action.target, observation), text: action.text };
  }
  return { kind: "press", ref: resolveRef(action.target, observation), key: action.key };
}
function buildStepResult(base, assertion, receipt, outcome, assertionPassed, observed) {
  return {
    index: base.index,
    intent: base.intent,
    status: assertionPassed ? "pass" : "fail",
    action: base.action,
    receipt,
    outcome,
    assertion,
    assertionPassed,
    observed,
    expected: assertion.expected
  };
}
function toReproduction(steps) {
  return steps.map((s) => ({
    index: s.index,
    intent: s.intent,
    action: s.action,
    observed: s.observed,
    expected: s.expected,
    receipt: s.receipt
  }));
}
function blockedReport(scenario, startedAt, message) {
  return {
    schemaVersion: 1,
    scenario: scenario.meta.name,
    driver: scenario.meta.driver,
    status: "blocked",
    startedAt,
    finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
    steps: [],
    assertions: [],
    evidence: null,
    failure: { stepIndex: null, message, reproduction: [] }
  };
}
function advisoryUnclear(question, reasoning, reason, description) {
  return {
    kind: "visual",
    question,
    verdict: "unclear",
    confidence: 0,
    reasoning,
    reason,
    ...description === void 0 ? {} : { description }
  };
}
async function executeAdvisory(scenario, session, services, capturesDir) {
  const advisory = scenario.advisory ?? [];
  const artifacts = [];
  const results = [];
  if (advisory.length === 0) return { artifacts, advisory: results };
  let capture;
  try {
    capture = await captureLatestVisual(session);
  } catch (error) {
    for (const assertion of advisory) {
      results.push(advisoryUnclear(assertion.question, errorMessage(error), "visual-capture-failed", assertion.description));
    }
    return { artifacts, advisory: results };
  }
  let artifactPath;
  try {
    artifactPath = await persistCaptureFile(capture, capturesDir);
  } catch (error) {
    for (const assertion of advisory) {
      results.push(advisoryUnclear(assertion.question, errorMessage(error), "visual-capture-failed", assertion.description));
    }
    return { artifacts, advisory: results };
  }
  const artifact = { path: artifactPath, kind: "screenshot" };
  artifacts.push(artifact);
  for (const assertion of advisory) {
    const finding = await evaluateVisualQuestion(assertion.question, capture, services);
    results.push({
      kind: "visual",
      question: assertion.question,
      verdict: finding.verdict,
      confidence: finding.confidence,
      reasoning: finding.reasoning,
      ...finding.reason === void 0 ? {} : { reason: finding.reason },
      ...assertion.description === void 0 ? {} : { description: assertion.description },
      artifact
    });
  }
  return { artifacts, advisory: results };
}
async function runScenario(scenario, adapter, options = {}) {
  if (adapter.kind !== scenario.meta.driver) {
    throw new Error(
      "scenario driver (" + scenario.meta.driver + ") does not match adapter driver (" + adapter.kind + ")"
    );
  }
  const ownerId = options.ownerId ?? "dsh-qa-replay";
  const launch = options.launchUrl ?? scenario.target.launch;
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const session = new QaSession(adapter, ownerId);
  const stepResults = [];
  const assertionResults = [];
  const artifacts = [];
  const advisoryResults = [];
  let evidence = null;
  let failure = null;
  try {
    await session.start({
      url: launch,
      ...options.headless === void 0 ? {} : { headless: options.headless }
    });
  } catch (error) {
    await session.stop().catch(() => {
    });
    return blockedReport(scenario, startedAt, "failed to start driver: " + errorMessage(error));
  }
  try {
    let current = await session.observe();
    for (const step of scenario.steps) {
      const base = { index: step.index, intent: step.intent, action: step.action };
      let resolved;
      try {
        resolved = resolveAction(step.action, current);
      } catch (error) {
        stepResults.push(buildStepResult(base, step.assert, null, "failed", false, null));
        failure = {
          stepIndex: step.index,
          message: errorMessage(error),
          reproduction: toReproduction(stepResults)
        };
        break;
      }
      let result;
      try {
        result = await session.act(resolved);
      } catch (error) {
        stepResults.push(buildStepResult(base, step.assert, null, "failed", false, null));
        failure = {
          stepIndex: step.index,
          message: errorMessage(error),
          reproduction: toReproduction(stepResults)
        };
        break;
      }
      if (result.outcome === "failed" || result.observation === null) {
        stepResults.push(buildStepResult(base, step.assert, result.receipt, result.outcome, false, null));
        failure = {
          stepIndex: step.index,
          message: "action receipt " + result.receipt.status + (result.receipt.code !== void 0 ? " (" + result.receipt.code + ")" : ""),
          reproduction: toReproduction(stepResults)
        };
        break;
      }
      const evaluation = evaluateAssertion(step.assert, result.observation);
      stepResults.push(
        buildStepResult(base, step.assert, result.receipt, result.outcome, evaluation.passed, evaluation.observed)
      );
      current = result.observation;
      if (!evaluation.passed) {
        failure = {
          stepIndex: step.index,
          message: "assertion " + step.assert.kind + " failed",
          reproduction: toReproduction(stepResults)
        };
        break;
      }
    }
    if (failure === null) {
      const finalObservation = await session.observe();
      for (let i = 0; i < scenario.assertions.length; i += 1) {
        const assertion = scenario.assertions[i];
        if (assertion === void 0) continue;
        const evaluation = evaluateAssertion(assertion, finalObservation);
        assertionResults.push({
          kind: assertion.kind,
          ...assertion.description === void 0 ? {} : { description: assertion.description },
          passed: evaluation.passed,
          expected: assertion.expected,
          observed: evaluation.observed
        });
        if (!evaluation.passed) {
          failure = {
            stepIndex: null,
            message: "final assertion " + (i + 1) + " (" + assertion.kind + ") failed",
            reproduction: toReproduction(stepResults)
          };
          break;
        }
      }
    }
    try {
      evidence = await session.evidence();
    } catch {
      evidence = null;
    }
    try {
      const outcome = await executeAdvisory(
        scenario,
        session,
        options.visual,
        options.visual?.capturesDir ?? join2(tmpdir(), "dsh-qa-visual-captures")
      );
      artifacts.push(...outcome.artifacts);
      advisoryResults.push(...outcome.advisory);
    } catch {
    }
  } catch (error) {
    failure = {
      stepIndex: null,
      message: errorMessage(error),
      reproduction: toReproduction(stepResults)
    };
  } finally {
    await session.stop().catch(() => {
    });
  }
  const report = {
    schemaVersion: 1,
    scenario: scenario.meta.name,
    driver: scenario.meta.driver,
    status: failure === null ? "pass" : "fail",
    startedAt,
    finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
    steps: stepResults,
    assertions: assertionResults,
    evidence,
    ...artifacts.length === 0 ? {} : { artifacts },
    ...advisoryResults.length === 0 ? {} : { advisory: advisoryResults }
  };
  if (failure !== null) {
    report.failure = failure;
  }
  return report;
}

// src/explore/export.ts
var OUTCOME_ROLE_PRIORITY = /* @__PURE__ */ new Map([
  ["alert", 0],
  ["status", 1],
  ["dialog", 2],
  ["heading", 3]
]);
function clean(value) {
  return value.trim();
}
function containsRedactionMarker(value) {
  return value.includes("[REDACTED");
}
function predicateFor(node) {
  const role = clean(node.role);
  const name2 = clean(node.name);
  if (role === "" || name2 === "") return null;
  if (containsRedactionMarker(role) || containsRedactionMarker(name2)) return null;
  return { role, name: name2 };
}
function countMatches(observation, predicate) {
  return observation.nodes.filter((node) => (predicate.role === void 0 || node.role === predicate.role) && (predicate.name === void 0 || node.name === predicate.name) && (predicate.tag === void 0 || node.tag === predicate.tag)).length;
}
function exclusion(recorded, reason, detail) {
  return {
    actionId: recorded.actionId,
    reason,
    detail: redactText(detail),
    receipt: recorded.receipt
  };
}
function durableAction(recorded, before) {
  const action = recorded.action;
  if (action.kind === "navigate") {
    return { action: { kind: "navigate", url: action.url } };
  }
  if (action.kind === "focus" || action.kind === "type" || action.kind === "key") {
    return exclusion(
      recorded,
      "UNSUPPORTED_REPLAY_ACTION",
      "Replay v0.1 has no scenario action for " + action.kind + "; the step was not exported."
    );
  }
  if (before === null) {
    return exclusion(recorded, "TARGET_OBSERVATION_MISSING", "No observation preceded this action.");
  }
  const node = before.nodes.find((candidate) => candidate.ref === action.ref);
  if (node === void 0) {
    return exclusion(recorded, "TARGET_REF_NOT_FOUND", "The action ref was not present in its preceding observation.");
  }
  const target = predicateFor(node);
  if (target === null) {
    return exclusion(
      recorded,
      "TARGET_HAS_NO_ACCESSIBLE_NAME",
      "Replay export requires a non-empty, unredacted role plus accessible name."
    );
  }
  if (countMatches(before, target) !== 1) {
    return exclusion(
      recorded,
      "TARGET_NOT_UNIQUE",
      "Role plus accessible name did not uniquely identify the action target."
    );
  }
  if (action.kind === "click") return { action: { kind: "click", target } };
  if (action.kind === "fill") {
    if (clean(action.text) === "") {
      return exclusion(recorded, "UNSUPPORTED_REPLAY_ACTION", "Replay fill text must be non-empty.");
    }
    return { action: { kind: "fill", target, text: action.text } };
  }
  if (clean(action.key) === "") {
    return exclusion(recorded, "UNSUPPORTED_REPLAY_ACTION", "Replay press key must be non-empty.");
  }
  return { action: { kind: "press", target, key: action.key } };
}
function semanticDelta(before, after) {
  if (before === null) return null;
  const candidates = after.nodes.map((node, order) => ({ node, order, predicate: predicateFor(node) })).filter((item) => item.predicate !== null && countMatches(after, item.predicate) === 1 && countMatches(before, item.predicate) === 0);
  candidates.sort((left, right) => {
    const leftPriority = OUTCOME_ROLE_PRIORITY.get(left.node.role) ?? 10;
    const rightPriority = OUTCOME_ROLE_PRIORITY.get(right.node.role) ?? 10;
    return leftPriority - rightPriority || left.order - right.order;
  });
  return candidates[0]?.predicate ?? null;
}
function synthesizeAssertion(before, after) {
  if (before !== null && before.page.url !== after.page.url && clean(after.page.url) !== "") {
    return {
      kind: "page-url",
      expected: { url: after.page.url },
      description: "Fresh post-action observation reached the recorded URL."
    };
  }
  const delta = semanticDelta(before, after);
  if (delta !== null) {
    return {
      kind: "node-present",
      expected: delta,
      description: "Fresh post-action observation exposed a new semantic state."
    };
  }
  return null;
}
function intentFor(action) {
  if (action.kind === "navigate") return "Navigate to the recorded URL.";
  const targetName = action.target.name ?? action.target.role ?? "semantic target";
  if (action.kind === "click") return 'Click "' + targetName + '".';
  if (action.kind === "fill") return 'Fill "' + targetName + '".';
  return "Press " + action.key + ' on "' + targetName + '".';
}
function buildScenario(trajectory, options) {
  const excluded = [];
  const steps = [];
  for (const recorded of trajectory.actions) {
    const receipt = recorded.receipt;
    if (recorded.recordingIssue !== null) {
      excluded.push(exclusion(recorded, "OBSERVATION_RECORDING_FAILED", recorded.recordingIssue));
      continue;
    }
    if (receipt === null) {
      excluded.push(exclusion(recorded, "ACTION_RECEIPT_MISSING", "No action receipt was recorded."));
      continue;
    }
    if (receipt.status === "rejected") {
      excluded.push(exclusion(
        recorded,
        "ACTION_REJECTED",
        "Rejected action was not exported" + (receipt.code === void 0 ? "." : " (" + receipt.code + ").")
      ));
      continue;
    }
    if (receipt.status === "failed") {
      excluded.push(exclusion(recorded, "ACTION_FAILED", "Failed action was not exported."));
      continue;
    }
    if (!receipt.dispatched) {
      excluded.push(exclusion(recorded, "ACTION_NOT_DISPATCHED", "The driver did not dispatch this action."));
      continue;
    }
    if (recorded.payloadRedacted) {
      excluded.push(exclusion(
        recorded,
        "ACTION_PAYLOAD_REDACTED",
        "Redaction changed a replay-relevant action field, so replay would not be faithful."
      ));
      continue;
    }
    if (recorded.afterObservationId === null) {
      excluded.push(exclusion(
        recorded,
        "FRESH_OBSERVATION_MISSING",
        "No immediate fresh post-action observation proved the outcome."
      ));
      continue;
    }
    const before = recorded.beforeObservationId === null ? null : trajectory.observations[recorded.beforeObservationId] ?? null;
    const after = trajectory.observations[recorded.afterObservationId] ?? null;
    if (after === null) {
      excluded.push(exclusion(
        recorded,
        "OBSERVATION_RECORDING_FAILED",
        "The fresh observation reference has no recorded observation payload."
      ));
      continue;
    }
    const durable = durableAction(recorded, before);
    if ("reason" in durable) {
      excluded.push(durable);
      continue;
    }
    const assertion = synthesizeAssertion(before, after);
    if (assertion === null || !evaluateAssertion(assertion, after).passed) {
      excluded.push(exclusion(
        recorded,
        "ASSERTION_NOT_PROVABLE",
        receipt.status === "unknown" ? "Unknown receipt had no semantic state change in the fresh observation." : "The fresh observation had no semantic state change or URL change proving the action outcome."
      ));
      continue;
    }
    steps.push({
      index: steps.length + 1,
      intent: intentFor(durable.action),
      action: durable.action,
      assert: assertion
    });
  }
  if (steps.length === 0) return { scenario: null, excluded };
  const fallbackName = "explore-" + trajectory.driver + "-" + trajectory.startedAt.slice(0, 10);
  const visualNotes = trajectory.visualFindings.map((finding) => "visual finding: " + finding.question);
  const rawScenario = {
    meta: {
      name: redactText(options.name?.trim() || fallbackName),
      description: redactText(
        options.description?.trim() || "Scenario exported from an evidence-backed Explore trajectory."
      ),
      driver: trajectory.driver,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      ...visualNotes.length === 0 ? {} : { notes: visualNotes }
    },
    target: { launch: trajectory.launch },
    steps,
    assertions: [steps[steps.length - 1].assert]
  };
  return { scenario: validateScenario(rawScenario), excluded };
}
function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
async function safeOutputPath(options) {
  if (typeof options.outputPath !== "string" || options.outputPath.trim() === "") {
    throw new TypeError("qa_record_export output_path must be a non-empty string");
  }
  const requested = resolve(options.outputPath);
  if (!requested.endsWith(".json")) throw new Error("qa_record_export output_path must end in .json");
  const parent = await realpath(dirname(requested));
  const workspace = await realpath(resolve(options.workspaceRoot ?? process.cwd()));
  let temp = await realpath(resolve(options.tempRoot ?? tmpdir2()));
  if (temp === workspace) temp = join3(workspace, ".dsh-qa-temp-root");
  if (!inside(workspace, parent) && !inside(temp, parent)) {
    throw new Error("qa_record_export output_path must be under the current workspace or temporary directory");
  }
  const actual = join3(parent, basename(requested));
  try {
    const existing = await lstat(actual);
    if (existing.isSymbolicLink()) throw new Error("qa_record_export refuses a symbolic-link output file");
  } catch (error) {
    const code = error instanceof Error ? error.code : void 0;
    if (code !== "ENOENT") throw error;
  }
  const artifacts = join3(workspace, ".dsh-qa-artifacts-root");
  const projected = projectArtifactPath2(actual, { workspace, temp, artifacts });
  return { actual, projected };
}
async function exportRecordedScenario(recorder, ownerId, options) {
  const trajectory = recorder.snapshot(ownerId);
  if (trajectory === null) {
    return {
      ok: false,
      code: "NO_TRAJECTORY",
      error: "No Explore trajectory exists for this owner; start and explore a session first.",
      excludedActions: []
    };
  }
  if (trajectory.driver !== "browser") {
    return {
      ok: false,
      code: "DRIVER_NOT_REPLAYABLE",
      error: "Replay v0.1 supports browser scenarios only; the computer trajectory was retained but not exported.",
      excludedActions: []
    };
  }
  const built = buildScenario(trajectory, options);
  if (built.scenario === null) {
    return {
      ok: false,
      code: "NO_PROVEN_STEPS",
      error: "No action had both a durable semantic target and an outcome proven by a fresh observation; no file was written.",
      excludedActions: built.excluded
    };
  }
  const output = await safeOutputPath(options);
  await writeFile2(
    output.actual,
    JSON.stringify(built.scenario, null, 2) + "\n",
    { encoding: "utf8", flag: options.overwrite === true ? "w" : "wx" }
  );
  const loaded = loadScenarioFromPath(output.actual);
  return {
    ok: true,
    artifact: { path: output.projected, kind: "scenario" },
    scenario: loaded,
    trajectory: {
      events: trajectory.events.length,
      observations: Object.keys(trajectory.observations).length,
      actions: trajectory.actions.length,
      evidenceReferences: trajectory.evidenceReferences
    },
    excludedActions: built.excluded
  };
}

// src/explore/recorder.ts
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
function cloneRedacted(value) {
  const projected = projectRedactedJsonValue(value);
  return { value: projected, changed: !isDeepStrictEqual(value, projected) };
}
function safeReason(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return redactText(raw);
}
function launchFrom(options, info, kind) {
  if (kind === "computer") return options?.bundleId ?? info.page.url;
  return options?.url || info.page.url;
}
function projectReplayUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Replay URL is malformed");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Replay URL must use http(s)");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Replay URL must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("Replay URL must not contain a query or fragment");
  }
  const components = [url.hostname, url.port];
  for (const rawSegment of url.pathname.split("/")) {
    let decoded;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      throw new Error("Replay URL path contains a malformed escape");
    }
    components.push(decoded);
  }
  for (const component of components) {
    if (redactText(component) !== component) {
      throw new Error("Replay URL contains a component rejected by redaction");
    }
  }
  return url.toString();
}
var QaTrajectoryRecorder = class {
  #trajectories = /* @__PURE__ */ new Map();
  start(ownerId, driver, options, info) {
    try {
      const safeOptions = cloneRedacted(options ?? {}).value;
      const safeInfo = cloneRedacted(info).value;
      const rawLaunch = launchFrom(options, info, driver);
      const safeLaunch = driver === "browser" ? projectReplayUrl(rawLaunch) : cloneRedacted(rawLaunch).value;
      const trajectory = {
        driver,
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        launch: safeLaunch,
        sequence: 0,
        nextObservation: 1,
        nextAction: 1,
        nextEvidence: 1,
        salt: randomBytes(32),
        refAliases: /* @__PURE__ */ new Map(),
        nextRef: 1,
        events: [],
        observations: /* @__PURE__ */ new Map(),
        actions: [],
        actionById: /* @__PURE__ */ new Map(),
        evidenceReferences: [],
        recordingIssues: [],
        lastObservationId: null,
        pendingActionId: null
      };
      this.#trajectories.set(ownerId, trajectory);
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: (/* @__PURE__ */ new Date()).toISOString(),
        kind: "start",
        driver,
        options: safeOptions,
        info: safeInfo
      });
    } catch (error) {
      const issue = "start recording failed: " + safeReason(error);
      this.#trajectories.set(ownerId, this.#failedTrajectory(driver, issue));
    }
  }
  action(ownerId, action) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0) return null;
    const actionId = "action-" + trajectory.nextAction++;
    try {
      const aliased = this.#aliasAction(trajectory, action);
      const safe = action.kind === "navigate" ? { value: aliased, changed: false } : cloneRedacted(aliased);
      const recorded = {
        actionId,
        action: safe.value,
        beforeObservationId: trajectory.lastObservationId,
        receipt: null,
        afterObservationId: null,
        payloadRedacted: safe.changed,
        recordingIssue: null
      };
      trajectory.actions.push(recorded);
      trajectory.actionById.set(actionId, recorded);
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: (/* @__PURE__ */ new Date()).toISOString(),
        kind: "action",
        actionId,
        beforeObservationId: recorded.beforeObservationId,
        action: recorded.action,
        payloadRedacted: recorded.payloadRedacted
      });
      return actionId;
    } catch (error) {
      const issue = "action recording failed: " + safeReason(error);
      trajectory.recordingIssues.push(issue);
      const recorded = {
        actionId,
        action: { kind: "navigate", url: "about:recording-error" },
        beforeObservationId: trajectory.lastObservationId,
        receipt: null,
        afterObservationId: null,
        payloadRedacted: true,
        recordingIssue: issue
      };
      trajectory.actions.push(recorded);
      trajectory.actionById.set(actionId, recorded);
      this.#recordingError(trajectory, "action", issue, actionId);
      return actionId;
    }
  }
  receipt(ownerId, actionId, receipt) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0 || actionId === null) return;
    const action = trajectory.actionById.get(actionId);
    if (action === void 0) return;
    try {
      const safeReceipt = cloneRedacted(receipt).value;
      action.receipt = safeReceipt;
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: (/* @__PURE__ */ new Date()).toISOString(),
        kind: "receipt",
        actionId,
        receipt: safeReceipt
      });
      trajectory.pendingActionId = safeReceipt.status === "confirmed" || safeReceipt.status === "unknown" ? actionId : null;
    } catch (error) {
      const issue = "receipt recording failed: " + safeReason(error);
      action.recordingIssue = issue;
      trajectory.recordingIssues.push(issue);
      trajectory.pendingActionId = null;
      this.#recordingError(trajectory, "receipt", issue, actionId);
    }
  }
  observation(ownerId, observation) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0) return;
    const observationId = "observation-" + trajectory.nextObservation++;
    const afterActionId = trajectory.pendingActionId;
    try {
      const aliased = this.#aliasObservation(trajectory, observation);
      const safeObservation = cloneRedacted(aliased).value;
      if (trajectory.driver === "browser") {
        safeObservation.page.url = projectReplayUrl(aliased.page.url);
      }
      trajectory.observations.set(observationId, safeObservation);
      trajectory.lastObservationId = observationId;
      trajectory.pendingActionId = null;
      if (afterActionId !== null) {
        const action = trajectory.actionById.get(afterActionId);
        if (action !== void 0) action.afterObservationId = observationId;
      }
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: (/* @__PURE__ */ new Date()).toISOString(),
        kind: "observation",
        observationId,
        afterActionId,
        observation: safeObservation
      });
    } catch (error) {
      const issue = "observation recording failed: " + safeReason(error);
      trajectory.recordingIssues.push(issue);
      trajectory.pendingActionId = null;
      if (afterActionId !== null) {
        const action = trajectory.actionById.get(afterActionId);
        if (action !== void 0) action.recordingIssue = issue;
      }
      this.#recordingError(trajectory, "observation", issue, afterActionId);
    }
  }
  observationFailed(ownerId, error) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0) return;
    const actionId = trajectory.pendingActionId;
    const issue = "fresh observation failed: " + safeReason(error);
    trajectory.recordingIssues.push(issue);
    trajectory.pendingActionId = null;
    if (actionId !== null) {
      const action = trajectory.actionById.get(actionId);
      if (action !== void 0) action.recordingIssue = issue;
    }
    this.#recordingError(trajectory, "observation", issue, actionId);
  }
  actionFailed(ownerId, actionId, error) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0) return;
    const issue = "driver action threw: " + safeReason(error);
    trajectory.recordingIssues.push(issue);
    if (actionId !== null) {
      const action = trajectory.actionById.get(actionId);
      if (action !== void 0) action.recordingIssue = issue;
    }
    this.#recordingError(trajectory, "action", issue, actionId);
  }
  evidence(ownerId, evidence) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0) return;
    const evidenceId = "evidence-" + trajectory.nextEvidence++;
    try {
      const safeEvidence = cloneRedacted(evidence).value;
      trajectory.evidenceReferences.push(evidenceId);
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: (/* @__PURE__ */ new Date()).toISOString(),
        kind: "evidence",
        evidenceId,
        evidence: safeEvidence
      });
    } catch (error) {
      const issue = "evidence recording failed: " + safeReason(error);
      trajectory.recordingIssues.push(issue);
      this.#recordingError(trajectory, "evidence", issue, null);
    }
  }
  visualCapture(ownerId, capture) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0) return;
    try {
      const safeCapture = cloneRedacted(toVisualCaptureInfo(capture)).value;
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: (/* @__PURE__ */ new Date()).toISOString(),
        kind: "visual-capture",
        capture: safeCapture
      });
    } catch (error) {
      const issue = "visual capture recording failed: " + safeReason(error);
      trajectory.recordingIssues.push(issue);
      this.#recordingError(trajectory, "visual", issue, null);
    }
  }
  visualFinding(ownerId, finding) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0) return;
    try {
      const safe = cloneRedacted(finding).value;
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: (/* @__PURE__ */ new Date()).toISOString(),
        kind: "visual-finding",
        question: safe.question,
        verdict: safe.verdict,
        confidence: safe.confidence,
        reasoning: safe.reasoning
      });
    } catch (error) {
      const issue = "visual finding recording failed: " + safeReason(error);
      trajectory.recordingIssues.push(issue);
      this.#recordingError(trajectory, "visual", issue, null);
    }
  }
  stop(ownerId, result) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0) return;
    try {
      const safeResult = cloneRedacted(result).value;
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: (/* @__PURE__ */ new Date()).toISOString(),
        kind: "stop",
        result: safeResult
      });
    } catch (error) {
      const issue = "stop recording failed: " + safeReason(error);
      trajectory.recordingIssues.push(issue);
      this.#recordingError(trajectory, "stop", issue, null);
    }
  }
  snapshot(ownerId) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0) return null;
    const observations = {};
    for (const [key, value] of trajectory.observations) observations[key] = value;
    const visualFindings = trajectory.events.filter(
      (event) => event.kind === "visual-finding"
    );
    return structuredClone({
      schemaVersion: 1,
      driver: trajectory.driver,
      startedAt: trajectory.startedAt,
      launch: trajectory.launch,
      events: trajectory.events,
      observations,
      actions: trajectory.actions,
      evidenceReferences: trajectory.evidenceReferences,
      visualFindings,
      recordingIssues: trajectory.recordingIssues
    });
  }
  clear() {
    this.#trajectories.clear();
  }
  #aliasAction(trajectory, action) {
    if (action.kind === "navigate") return { kind: "navigate", url: projectReplayUrl(action.url) };
    const ref = this.#refAlias(trajectory, action.ref);
    if (action.kind === "click") return { kind: "click", ref };
    if (action.kind === "fill") return { kind: "fill", ref, text: action.text };
    if (action.kind === "press") return { kind: "press", ref, key: action.key };
    if (action.kind === "focus") return { kind: "focus", ref };
    if (action.kind === "type") return { kind: "type", ref, text: action.text };
    return {
      kind: "key",
      ref,
      key: action.key,
      ...action.modifiers === void 0 ? {} : { modifiers: [...action.modifiers] }
    };
  }
  #aliasObservation(trajectory, observation) {
    return {
      ...observation,
      nodes: observation.nodes.map((node) => ({
        ...node,
        ref: this.#refAlias(trajectory, node.ref)
      }))
    };
  }
  #refAlias(trajectory, rawRef) {
    const digest = createHash("sha256").update(trajectory.salt).update(rawRef).digest("hex");
    let alias = trajectory.refAliases.get(digest);
    if (alias === void 0) {
      alias = "ref-" + trajectory.nextRef++;
      trajectory.refAliases.set(digest, alias);
    }
    return alias;
  }
  #sequence(trajectory) {
    trajectory.sequence += 1;
    return trajectory.sequence;
  }
  #push(trajectory, event) {
    trajectory.events.push(event);
  }
  #recordingError(trajectory, operation, reason, actionId) {
    this.#push(trajectory, {
      sequence: this.#sequence(trajectory),
      at: (/* @__PURE__ */ new Date()).toISOString(),
      kind: "recording-error",
      operation,
      reason,
      actionId
    });
  }
  #failedTrajectory(driver, issue) {
    const trajectory = {
      driver,
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      launch: "",
      sequence: 0,
      nextObservation: 1,
      nextAction: 1,
      nextEvidence: 1,
      salt: randomBytes(32),
      refAliases: /* @__PURE__ */ new Map(),
      nextRef: 1,
      events: [],
      observations: /* @__PURE__ */ new Map(),
      actions: [],
      actionById: /* @__PURE__ */ new Map(),
      evidenceReferences: [],
      recordingIssues: [issue],
      lastObservationId: null,
      pendingActionId: null
    };
    this.#recordingError(trajectory, "start", issue, null);
    return trajectory;
  }
};
var RecordingQaDriverAdapter = class {
  kind;
  #delegate;
  #recorder;
  constructor(delegate, recorder) {
    this.#delegate = delegate;
    this.#recorder = recorder;
    this.kind = delegate.kind;
  }
  async start(ownerId, options) {
    const info = await this.#delegate.start(ownerId, options);
    this.#safe(() => this.#recorder.start(ownerId, this.kind, options, info));
    return info;
  }
  async observe(ownerId, options) {
    try {
      const observation = await this.#delegate.observe(ownerId, options);
      this.#safe(() => this.#recorder.observation(ownerId, observation));
      return observation;
    } catch (error) {
      this.#safe(() => this.#recorder.observationFailed(ownerId, error));
      throw error;
    }
  }
  async act(ownerId, action, approval) {
    const actionId = this.#safeValue(() => this.#recorder.action(ownerId, action), null);
    try {
      const receipt = await this.#delegate.act(ownerId, action, approval);
      this.#safe(() => this.#recorder.receipt(ownerId, actionId, receipt));
      return receipt;
    } catch (error) {
      this.#safe(() => this.#recorder.actionFailed(ownerId, actionId, error));
      throw error;
    }
  }
  async evidence(ownerId, options) {
    const evidence = await this.#delegate.evidence(ownerId, options);
    this.#safe(() => this.#recorder.evidence(ownerId, evidence));
    return evidence;
  }
  async visualObserve(ownerId, options) {
    if (typeof this.#delegate.visualObserve !== "function") {
      throw new Error("the " + this.kind + " driver does not support visual capture");
    }
    const capture = await this.#delegate.visualObserve(ownerId, options);
    this.#safe(() => this.#recorder.visualCapture(ownerId, capture));
    return capture;
  }
  async stop(ownerId) {
    const result = await this.#delegate.stop(ownerId);
    this.#safe(() => this.#recorder.stop(ownerId, result));
    return result;
  }
  async dispose() {
    await this.#delegate.dispose?.();
  }
  #safe(fn) {
    try {
      fn();
    } catch {
    }
  }
  #safeValue(fn, fallback) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }
};

// src/reporters/json.ts
function renderReportJson(report, roots) {
  return JSON.stringify(projectRedactedJsonValue(report, roots), null, 2) + "\n";
}

// src/reporters/jsonl.ts
import { appendFile } from "node:fs/promises";
function renderReportJsonl(report, roots) {
  return JSON.stringify(projectRedactedJsonValue(report, roots)) + "\n";
}
async function appendReportJsonl(report, jsonlPath, roots) {
  await appendFile(jsonlPath, renderReportJsonl(report, roots), "utf8");
}

// src/reporters/markdown.ts
var TICK2 = String.fromCharCode(96);
function inline(value, roots) {
  return JSON.stringify(projectRedactedJsonValue(value, roots));
}
function escapeControlCodeUnit(code) {
  return "\\u" + code.toString(16).toUpperCase().padStart(4, "0");
}
function escapeLoneSurrogates(text) {
  let result = "";
  let index = 0;
  const length = text.length;
  while (index < length) {
    const code = text.charCodeAt(index);
    const ch = text[index];
    if (code >= 55296 && code <= 56319) {
      const next = index + 1 < length ? text.charCodeAt(index + 1) : -1;
      if (next >= 56320 && next <= 57343) {
        result += ch + text[index + 1];
        index += 2;
      } else {
        result += escapeControlCodeUnit(code);
        index += 1;
      }
    } else if (code >= 56320 && code <= 57343) {
      result += escapeControlCodeUnit(code);
      index += 1;
    } else {
      result += ch;
      index += 1;
    }
  }
  return result;
}
function renderReportMarkdown(report, roots) {
  const md = (text) => escapeLoneSurrogates(redactText(text, roots));
  const lines = [];
  lines.push("# QA Replay: " + md(report.scenario));
  lines.push("");
  lines.push("- **Status**: " + md(report.status));
  lines.push("- **Driver**: " + md(report.driver));
  lines.push("- **Schema**: " + String(report.schemaVersion));
  lines.push("- **Started**: " + md(report.startedAt));
  lines.push("- **Finished**: " + md(report.finishedAt));
  lines.push("");
  lines.push("## Steps");
  if (report.steps.length === 0) lines.push("- (none)");
  for (const step of report.steps) {
    const mark = step.status === "pass" ? "PASS" : "FAIL";
    lines.push("- [" + mark + "] step " + String(step.index) + ": " + md(step.intent));
    lines.push("  - action: " + TICK2 + md(inline(step.action, roots)) + TICK2);
    lines.push("  - receipt: " + md(step.receipt === null ? "none" : step.receipt.status));
    lines.push("  - assertion: " + md(step.assertion.kind) + " -> " + (step.assertionPassed ? "PASS" : "FAIL"));
    lines.push("  - observed: " + TICK2 + md(inline(step.observed, roots)) + TICK2);
  }
  lines.push("");
  lines.push("## Final assertions");
  if (report.assertions.length === 0) lines.push("- (none)");
  for (const assertion of report.assertions) {
    lines.push(
      "- " + md(assertion.kind) + " -> " + (assertion.passed ? "PASS" : "FAIL") + " (observed: " + TICK2 + md(inline(assertion.observed, roots)) + TICK2 + ")"
    );
  }
  if (report.advisory !== void 0 && report.advisory.length > 0) {
    lines.push("");
    lines.push("## Advisory");
    for (const item of report.advisory) {
      lines.push("- question: " + md(item.question));
      lines.push("  - verdict: " + md(item.verdict) + " (confidence " + String(item.confidence) + ")");
      lines.push("  - reasoning: " + md(item.reasoning));
      if (item.reason !== void 0) lines.push("  - reason: " + md(item.reason));
      if (item.artifact !== void 0) {
        const projectedPath = projectArtifactPath2(item.artifact.path, roots);
        lines.push("  - artifact: " + TICK2 + escapeLoneSurrogates(projectedPath) + TICK2);
      }
    }
  }
  if (report.failure !== void 0) {
    lines.push("");
    lines.push("## Failure");
    lines.push("- step: " + (report.failure.stepIndex === null ? "final assertion" : String(report.failure.stepIndex)));
    lines.push("- message: " + md(report.failure.message));
    lines.push("- reproduction: " + String(report.failure.reproduction.length) + " step(s)");
  }
  if (report.artifacts !== void 0 && report.artifacts.length > 0) {
    lines.push("");
    lines.push("## Artifacts");
    for (const artifact of report.artifacts) {
      const projectedPath = projectArtifactPath2(artifact.path, roots);
      lines.push("- " + md(artifact.kind) + ": " + TICK2 + escapeLoneSurrogates(projectedPath) + TICK2);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// src/reporters/write.ts
import { mkdir as mkdir2, appendFile as appendFile2, writeFile as writeFile3 } from "node:fs/promises";
import { join as join4 } from "node:path";
async function writeReports(report, options) {
  await mkdir2(options.directory, { recursive: true });
  const jsonPath = join4(options.directory, "report.json");
  const markdownPath = join4(options.directory, "report.md");
  const jsonlPath = options.jsonlPath ?? join4(options.directory, "report.jsonl");
  await writeFile3(jsonPath, renderReportJson(report, options.roots), "utf8");
  await writeFile3(markdownPath, renderReportMarkdown(report, options.roots), "utf8");
  await appendFile2(jsonlPath, renderReportJsonl(report, options.roots), "utf8");
  return { json: jsonPath, markdown: markdownPath, jsonl: jsonlPath };
}

// src/tools.ts
import { tmpdir as tmpdir3 } from "node:os";
import { join as join5 } from "node:path";
function qaToolList(tools) {
  return [
    tools.qaSessionStart,
    tools.qaObserve,
    tools.qaAct,
    tools.qaAssert,
    tools.qaEvidence,
    tools.qaRecordExport,
    tools.qaReplayRun,
    tools.qaSessionStop
  ];
}
var renderJson = (_args, value) => [
  { type: "text", text: JSON.stringify(value, null, 2) }
];
var outputFor = (schema = { type: "object" }) => ({ schema, render: renderJson });
var closedObject = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required
});
var enumOf = (...values) => ({ type: "string", enum: values });
var intProp = { type: "integer" };
var strProp = { type: "string" };
var QaToolHost = class {
  #managers = /* @__PURE__ */ new Map();
  #ownerDrivers = /* @__PURE__ */ new Map();
  #recorder = new QaTrajectoryRecorder();
  #options;
  constructor(options = {}) {
    this.#options = options;
  }
  managerFor(driver) {
    let manager = this.#managers.get(driver);
    if (manager === void 0) {
      manager = (async () => {
        if (driver === "browser") {
          const browserManager = await loadBrowserManager();
          const adapter2 = new BrowserAdapter(browserManager);
          return new QaSessionManager(new RecordingQaDriverAdapter(adapter2, this.#recorder));
        }
        const computerDriver = await loadComputerDriver();
        const adapter = new ComputerAdapter(computerDriver);
        return new QaSessionManager(new RecordingQaDriverAdapter(adapter, this.#recorder));
      })();
      manager = manager.catch((error) => {
        this.#managers.delete(driver);
        throw error;
      });
      this.#managers.set(driver, manager);
    }
    return manager;
  }
  managerForOwner(owner) {
    return this.managerFor(this.#ownerDrivers.get(owner) ?? "browser");
  }
  bindOwner(owner, driver) {
    this.#ownerDrivers.set(owner, driver);
  }
  async stopOwner(owner) {
    const driver = this.#ownerDrivers.get(owner);
    this.#ownerDrivers.delete(owner);
    if (driver === void 0) {
      return { stopped: false, reason: "not-running" };
    }
    return (await this.managerFor(driver)).stop(owner);
  }
  exportRecord(owner, options) {
    return exportRecordedScenario(this.#recorder, owner, options);
  }
  #capturesDir() {
    return this.#options.capturesDir ?? join5(tmpdir3(), "dsh-qa-visual-captures");
  }
  /** Lazily resolve the host vision services (llm + attachments) for one call. */
  visualServices() {
    const getService = this.#options.getService;
    const attachments = getService?.("attachments");
    const llm = getService?.("llm");
    return {
      ...attachments === void 0 ? {} : { attachments },
      ...llm === void 0 ? {} : { llm },
      ...this.#options.visionProvider === void 0 ? {} : { provider: this.#options.visionProvider },
      ...this.#options.visionModel === void 0 ? {} : { model: this.#options.visionModel },
      capturesDir: this.#capturesDir()
    };
  }
  /** Evaluate a visual assertion in Explore: capture + model verdict + recording. */
  async assertVisual(owner, session, question) {
    const capture = await captureLatestVisual(session);
    const artifactPath = await persistCaptureFile(capture, this.#capturesDir());
    const finding = await evaluateVisualQuestion(question, capture, this.visualServices());
    this.#recorder.visualFinding(owner, {
      question,
      verdict: finding.verdict,
      confidence: finding.confidence,
      reasoning: finding.reasoning
    });
    return {
      ok: true,
      kind: "visual",
      question,
      verdict: finding.verdict,
      confidence: finding.confidence,
      reasoning: finding.reasoning,
      ...finding.reason === void 0 ? {} : { reason: finding.reason },
      artifact: { path: artifactPath, kind: "screenshot" }
    };
  }
  /** Capture a visual frame for qa_evidence and return metadata + artifact path. */
  async captureVisualEvidence(session, options) {
    const capture = await captureLatestVisual(session, options);
    const artifactPath = await persistCaptureFile(capture, this.#capturesDir());
    const info = toVisualCaptureInfo(capture);
    return { ...info, artifactPath };
  }
  async dispose() {
    const pending = [...this.#managers.values()];
    this.#managers.clear();
    this.#ownerDrivers.clear();
    const settled = await Promise.allSettled(pending);
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        await outcome.value.dispose();
      }
    }
    this.#recorder.clear();
  }
};
function ownerFrom(args, exec) {
  const explicit = args.owner;
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
  const agentId = exec.agent?.id;
  if (typeof agentId === "string" && agentId.trim() !== "") return agentId.trim();
  return "dsh-qa";
}
function guard(handler) {
  return async (args, exec) => {
    try {
      return toLosslessJson(await handler(args, exec));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toLosslessJson({ ok: false, error: message });
    }
  };
}
function tool(spec) {
  const execute = guard(spec.execute);
  return { ...spec, execute };
}
function createQaTools(host) {
  const qaSessionStart = tool({
    name: "qa_session_start",
    description: "Start one QA session for this agent scope. Choose a browser or computer driver; the chosen driver is bound to the owner for the session and loaded lazily on first use.",
    parameters: closedObject({
      owner: strProp,
      driver: enumOf("browser", "computer"),
      url: strProp,
      headless: { type: "boolean" },
      bundle_id: strProp,
      pid: intProp,
      window_number: intProp,
      window_title: strProp
    }, []),
    output: outputFor(),
    timeoutMs: 6e4,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec);
      const driver = args.driver ?? "browser";
      host.bindOwner(owner, driver);
      const manager = await host.managerFor(driver);
      return manager.session(owner).start({
        ...args.url === void 0 ? {} : { url: args.url },
        ...args.headless === void 0 ? {} : { headless: args.headless },
        ...args.bundle_id === void 0 ? {} : { bundleId: args.bundle_id },
        ...args.pid === void 0 ? {} : { pid: args.pid },
        ...args.window_number === void 0 ? {} : { windowNumber: args.window_number },
        ...args.window_title === void 0 ? {} : { windowTitle: args.window_title }
      });
    },
    presentCall: () => ({ card: "generic", title: "Start QA session" })
  });
  const qaObserve = tool({
    name: "qa_observe",
    description: "Return a bounded semantic view of the current app/page. Interactive nodes carry opaque session-local refs; observe again after every action.",
    parameters: closedObject({
      owner: strProp,
      max_nodes: intProp,
      max_depth: intProp,
      ttl_ms: intProp
    }, []),
    output: outputFor(),
    timeoutMs: 3e4,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec);
      const manager = await host.managerForOwner(owner);
      return manager.session(owner).observe({
        ...args.max_nodes === void 0 ? {} : { maxNodes: args.max_nodes },
        ...args.max_depth === void 0 ? {} : { maxDepth: args.max_depth },
        ...args.ttl_ms === void 0 ? {} : { ttlMs: args.ttl_ms }
      });
    },
    presentCall: () => ({ card: "generic", title: "Observe QA target" })
  });
  const qaAct = tool({
    name: "qa_act",
    description: "Perform exactly one action. click/fill/press/navigate are browser verbs; focus/type/key are computer verbs. click/fill/press/focus/type/key require a ref from the latest qa_observe.",
    parameters: closedObject({
      owner: strProp,
      action: enumOf("click", "fill", "press", "navigate", "focus", "type", "key"),
      ref: strProp,
      text: strProp,
      key: strProp,
      url: strProp,
      modifiers: { type: "array", items: strProp }
    }, ["action"]),
    output: outputFor(),
    timeoutMs: 3e4,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec);
      const manager = await host.managerForOwner(owner);
      let action;
      if (args.action === "click") {
        if (args.ref === void 0) throw new Error("qa_act click requires ref");
        action = { kind: "click", ref: args.ref };
      } else if (args.action === "fill") {
        if (args.ref === void 0 || args.text === void 0) throw new Error("qa_act fill requires ref and text");
        action = { kind: "fill", ref: args.ref, text: args.text };
      } else if (args.action === "press") {
        if (args.ref === void 0 || args.key === void 0) throw new Error("qa_act press requires ref and key");
        action = { kind: "press", ref: args.ref, key: args.key };
      } else if (args.action === "focus") {
        if (args.ref === void 0) throw new Error("qa_act focus requires ref");
        action = { kind: "focus", ref: args.ref };
      } else if (args.action === "type") {
        if (args.ref === void 0 || args.text === void 0) throw new Error("qa_act type requires ref and text");
        action = { kind: "type", ref: args.ref, text: args.text };
      } else if (args.action === "key") {
        if (args.ref === void 0 || args.key === void 0) throw new Error("qa_act key requires ref and key");
        action = {
          kind: "key",
          ref: args.ref,
          key: args.key,
          ...args.modifiers === void 0 ? {} : { modifiers: args.modifiers }
        };
      } else if (args.action === "navigate") {
        if (args.url === void 0) throw new Error("qa_act navigate requires url");
        action = { kind: "navigate", url: args.url };
      } else {
        throw new Error("qa_act action must be click, fill, press, navigate, focus, type, or key");
      }
      return manager.session(owner).act(action);
    },
    presentCall: () => ({ card: "generic", title: "Act on QA target" })
  });
  const qaAssert = tool({
    name: "qa_assert",
    description: 'Evaluate one assertion against a fresh observation. node-present/node-absent/page-url are deterministic; kind "visual" captures the current screen and asks the host vision model a question, returning an ADVISORY verdict (yes/no/unclear with confidence and reasoning) that never changes pass/fail. Without a mounted vision model the visual verdict degrades to "unclear" with reason "vision-model-unavailable".',
    parameters: closedObject({
      owner: strProp,
      kind: enumOf("node-present", "node-absent", "page-url", "visual"),
      expected: {},
      question: strProp
    }, ["kind"]),
    output: outputFor(),
    timeoutMs: 6e4,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec);
      const manager = await host.managerForOwner(owner);
      const session = manager.session(owner);
      if (args.kind === "visual") {
        if (typeof args.question !== "string" || args.question.trim() === "") {
          throw new Error("qa_assert visual requires a non-empty question");
        }
        return host.assertVisual(owner, session, args.question);
      }
      const assertion = validateAssertion({ kind: args.kind, expected: args.expected }, "qa_assert");
      const observation = await session.observe();
      const evaluation = evaluateAssertion(assertion, observation);
      return {
        ok: true,
        passed: evaluation.passed,
        kind: assertion.kind,
        observed: evaluation.observed,
        expected: assertion.expected
      };
    },
    presentCall: () => ({ card: "generic", title: "Assert QA state" })
  });
  const qaEvidence = tool({
    name: "qa_evidence",
    description: "Read bounded, redacted evidence: browser console/network records, or computer helper status plus bounded action receipts. Set visual: true to also capture the current screen (Set-of-Mark) and return its metadata plus a structured artifact path.",
    parameters: closedObject({
      owner: strProp,
      max_console: intProp,
      max_network: intProp,
      max_receipts: intProp,
      visual: { type: "boolean" },
      visual_fingerprint: strProp,
      visual_full_page: { type: "boolean" },
      visual_max_marks: intProp,
      visual_scale: intProp
    }, []),
    output: outputFor(),
    timeoutMs: 3e4,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec);
      const manager = await host.managerForOwner(owner);
      const session = manager.session(owner);
      const evidence = await session.evidence({
        ...args.max_console === void 0 ? {} : { maxConsole: args.max_console },
        ...args.max_network === void 0 ? {} : { maxNetwork: args.max_network },
        ...args.max_receipts === void 0 ? {} : { maxReceipts: args.max_receipts }
      });
      if (args.visual !== true) return evidence;
      const visual = await host.captureVisualEvidence(session, {
        ...args.visual_fingerprint === void 0 ? {} : { fingerprint: args.visual_fingerprint },
        ...args.visual_full_page === void 0 ? {} : { fullPage: args.visual_full_page },
        ...args.visual_max_marks === void 0 ? {} : { maxMarks: args.visual_max_marks },
        ...args.visual_scale === void 0 ? {} : { scale: args.visual_scale }
      });
      return { ...evidence, visual };
    },
    presentCall: () => ({ card: "generic", title: "Collect QA evidence" })
  });
  const qaRecordExport = tool({
    name: "qa_record_export",
    description: "Export this owner's redacted Explore trajectory as a fail-closed Replay scenario JSON file. Only actions with durable role+accessible-name targets and outcomes proven by immediate fresh observations become steps; exclusions are returned explicitly.",
    parameters: closedObject({
      owner: strProp,
      output_path: strProp,
      name: strProp,
      description: strProp,
      overwrite: { type: "boolean" }
    }, ["output_path"]),
    output: outputFor(),
    timeoutMs: 15e3,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec);
      return host.exportRecord(owner, {
        outputPath: args.output_path,
        ...args.name === void 0 ? {} : { name: args.name },
        ...args.description === void 0 ? {} : { description: args.description },
        ...args.overwrite === void 0 ? {} : { overwrite: args.overwrite }
      });
    },
    presentCall: () => ({ card: "generic", title: "Export QA record" })
  });
  const qaReplayRun = tool({
    name: "qa_replay_run",
    description: "Run a deterministic Replay scenario file end to end and return a pass/fail/blocked report. Browser scenarios only in v0.1.",
    parameters: closedObject({
      scenario: strProp,
      owner: strProp,
      headless: { type: "boolean" },
      outputDir: strProp
    }, ["scenario"]),
    output: outputFor(),
    timeoutMs: 3e5,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const scenario = loadScenarioFromPath(args.scenario);
      if (scenario.meta.driver !== "browser") {
        return { ok: false, error: "scenario driver is not supported yet (computer replay lands in a later WP)" };
      }
      let origin;
      try {
        origin = new URL(scenario.target.launch).origin;
      } catch {
        origin = void 0;
      }
      const browserManager = await loadBrowserManager(BROWSER_DRIVER_SPECIFIER, {
        ...origin === void 0 ? {} : { allowedOrigins: [origin] }
      });
      const adapter = new BrowserAdapter(browserManager);
      try {
        const report = await runScenario(scenario, adapter, {
          ownerId: ownerFrom(args, exec),
          ...args.headless === void 0 ? {} : { headless: args.headless },
          launchUrl: scenario.target.launch,
          visual: host.visualServices()
        });
        if (args.outputDir !== void 0) {
          await writeReports(report, { directory: args.outputDir });
        }
        return report;
      } finally {
        await browserManager.dispose();
      }
    },
    presentCall: () => ({ card: "generic", title: "Replay QA scenario" })
  });
  const qaSessionStop = tool({
    name: "qa_session_stop",
    description: "Stop the QA session for this owner and release the bound driver scope. Idempotent when no session is running.",
    parameters: closedObject({ owner: strProp }, []),
    output: outputFor(),
    timeoutMs: 3e4,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec);
      return host.stopOwner(owner);
    },
    presentCall: () => ({ card: "generic", title: "Stop QA session" })
  });
  return { qaSessionStart, qaObserve, qaAct, qaAssert, qaEvidence, qaRecordExport, qaReplayRun, qaSessionStop };
}

// src/skill.ts
var QA_SKILL_NAME = "qa-orchestration";
var QA_SKILL_DESCRIPTION = "Explore an app autonomously with the qa_* tools, preserve evidence and driver safety decisions, then export the proven trajectory as a deterministic Replay scenario. Read this before the first qa_* call of an Explore task.";
var QA_SKILL_WHEN_TO_USE = "Any autonomous QA exploration through the qa_* tools \u2014 observing an unfamiliar UI, following semantic controls, preserving a failure, exporting a trajectory, or replaying the exported scenario \u2014 over a Browser (BU) or Computer (CU) driver.";
var QA_SKILL_CONTENT = `# Explore with dsh-qa

The loop is **start \u2192 observe \u2192 choose one semantic target \u2192 act \u2192 inspect the fresh observation \u2192
assert \u2192 capture evidence at the moment a problem appears \u2192 export \u2192 replay \u2192 stop**. The same
eight verbs serve Browser (BU) and Computer (CU); driver safety decisions are never routed around.

## Explore method

- \`qa_session_start\` binds one owner scope to one driver. Choose an explicit owner and keep it
  unchanged through export. Browser takes \`url\`; Computer binds strong app/window identity.
- Begin with \`qa_observe\`. Prefer a unique role plus accessible name, take one purposeful action,
  then inspect the fresh observation returned by \`qa_act\`. Re-observe when diagnosing and never
  reuse an old ref. A truncated view is incomplete, not empty.
- Coordinates, indices, opaque refs, observation ids, and generated ids are live-session handles,
  never Replay selectors.
- \`qa_act\` returns a receipt plus, for dispatched actions, the session core's immediate fresh
  observation. An \`unknown\` receipt is NEVER success: require a semantic delta or URL change in
  that observation. A \`rejected\` / \`failed\` receipt is a hard stop. Never approve, rephrase, or
  retarget around a driver safety rejection.
- \`qa_assert\` checks resulting state against a fresh observation. Do not repeat the action "to see
  if it worked".
- The moment a problem appears, call \`qa_evidence\` before navigating away or changing state.
  Missing permissions, truncation, and driver rejection are boundaries, never green results.

## Export and Replay

- Call \`qa_record_export\` with the same \`owner\` and an \`output_path\` ending in \`.json\`. Its
  parent must already exist under the current workspace or temporary directory.
- Selector durability is strict: only a target uniquely identified in the preceding observation by
  non-empty **role + accessible name** is exported. Unnamed, duplicate, coordinate/index-based,
  ephemeral-ref-only, redacted, or Replay-unsupported actions are excluded with a reason.
- Every exported step receives an assertion synthesized from and evaluated against the immediate
  fresh observation after that action. Rejected/failed actions and actions without that observation
  never become steps. An unknown receipt needs a semantic delta or URL change; target persistence
  alone cannot prove it.
- Inspect \`excludedActions\`. An exclusion is not a pass. If every action is unproven,
  \`qa_record_export\` returns \`NO_PROVEN_STEPS\` and writes no file.
- Run \`qa_replay_run\` on the exact exported file without hand editing it. Browser Replay is the
  supported v0.1 closed loop; only a \`pass\` report closes Explore\u2192Replay.
- \`qa_session_stop\` releases the owner scope. Stop on success and failure; the trajectory remains
  exportable until another session starts for that owner or the plugin disposes.

## Missing drivers

The Browser and Computer drivers load lazily. When one is absent, the first tool call that needs it
fails with a clear error naming the missing package. Plugin activation and tools/list do not require
the drivers to be installed.
`;
function registerQaSkill(ctx) {
  const fiber = ctx.inject(["skills"], (skillCtx) => {
    const { skills } = skillCtx;
    skillCtx.effect(() => skills.register({
      name: QA_SKILL_NAME,
      description: QA_SKILL_DESCRIPTION,
      whenToUse: QA_SKILL_WHEN_TO_USE,
      content: QA_SKILL_CONTENT,
      source: "bundled"
    }), "dsh-qa:skill");
  });
  return () => {
    void fiber.dispose();
  };
}

// src/plugin.ts
var name = "dsh-qa";
var inject = ["tools"];
function apply(ctx) {
  const host = new QaToolHost({ getService: (name2) => ctx.get(name2) });
  const tools = createQaTools(host);
  const disposers = [];
  disposers.push(registerQaSkill(ctx));
  for (const definition of qaToolList(tools)) {
    disposers.push(ctx.effect(() => ctx.tools.register(definition), `dsh-qa:${definition.name}`));
  }
  if (typeof ctx.on === "function") {
    disposers.push(ctx.on("agent/disposed", async ({ agent }) => {
      const id = agent?.id;
      if (typeof id !== "string" || id === "") return;
      try {
        await host.stopOwner(id);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-qa could not stop Agent scope ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }
  ctx.logger?.info?.(`dsh-qa mounted (${QA_TOOL_NAMES.join(" + ")})`);
  return async () => {
    for (const dispose of [...disposers].reverse()) await dispose();
    await host.dispose();
  };
}
export {
  BrowserAdapter,
  COMPUTER_DRIVER_SPECIFIER,
  ComputerAdapter,
  DEFAULT_VISION_MODEL,
  DEFAULT_VISION_PROVIDER,
  QA_DRIVERS,
  QA_SKILL_CONTENT,
  QA_SKILL_DESCRIPTION,
  QA_SKILL_NAME,
  QA_SKILL_WHEN_TO_USE,
  QA_TOOL_NAMES,
  QaSession,
  QaSessionManager,
  QaToolHost,
  QaTrajectoryRecorder,
  RecordingQaDriverAdapter,
  ScenarioValidationError,
  VISION_MODEL_UNAVAILABLE,
  appendReportJsonl,
  apply,
  captureLatestVisual,
  createQaTools,
  evaluateAssertion,
  evaluateVisualQuestion,
  exportRecordedScenario,
  inject,
  isSensitiveKey,
  loadComputerDriver,
  loadScenarioFromPath,
  matchesNode,
  missingComputerDriverMessage,
  name,
  normalizeReportForDeterminism,
  ownerFrom,
  parseScenario,
  parseVerdict,
  persistCaptureFile,
  projectArtifactPath2 as projectArtifactPath,
  projectRedactedJsonValue,
  qaToolList,
  redactText,
  redactTextWithRoots,
  registerQaSkill,
  renderReportJson,
  renderReportJsonl,
  renderReportMarkdown,
  runScenario,
  toLosslessJson,
  toObservedNode,
  toVisualCaptureInfo,
  validateAssertion,
  validateRoots,
  validateScenario,
  validateVisualAssertion,
  writeReports
};
