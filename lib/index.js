var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};

// src/loginState.ts
import { readFile } from "node:fs/promises";
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(message) {
  throw new LoginStateError(message);
}
function normalizeAuthorizedOrigin(value, position) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(position + " must be a non-empty exact origin");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(position + " must be an exact http(s) origin (scheme + host + optional port)");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(position + " must use http or https");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    fail(position + " must be an exact origin (scheme + host + optional port, no path/query/userinfo)");
  }
  return parsed.origin;
}
function validateLoginStateConfig(value, position = "loginState") {
  if (!isPlainObject2(value)) fail(position + " must be an object with { source, origins }");
  const obj = value;
  for (const key of Object.keys(obj)) {
    if (key !== "source" && key !== "origins") fail(position + " has an unexpected field");
  }
  const source = obj.source;
  if (typeof source !== "string" || source.trim() === "") {
    fail(position + ".source must be a non-empty path string");
  }
  const originsRaw = obj.origins;
  if (!Array.isArray(originsRaw) || originsRaw.length === 0) {
    fail(position + ".origins must be a non-empty array of exact origins");
  }
  const origins = [];
  const seen = /* @__PURE__ */ new Set();
  for (let i = 0; i < originsRaw.length; i += 1) {
    const normalized = normalizeAuthorizedOrigin(originsRaw[i], position + ".origins[" + i + "]");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    origins.push(normalized);
  }
  return { source, origins };
}
function hostnameOf(origin) {
  return new URL(origin).hostname.toLowerCase();
}
function cookieDomainMatches(domain, hosts) {
  const bare = domain.startsWith(".") ? domain.slice(1) : domain;
  return hosts.has(bare);
}
function expectStringField(obj, key, position) {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail(position + "." + key + " must be a non-empty string");
  }
  return value;
}
function expectBooleanField(obj, key, position) {
  const value = obj[key];
  if (typeof value !== "boolean") fail(position + "." + key + " must be a boolean");
  return value;
}
function expectFiniteNumberField(obj, key, position) {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(position + "." + key + " must be a finite number");
  }
  return value;
}
function validateCookie(value, position) {
  if (!isPlainObject2(value)) fail(position + " must be an object");
  const obj = value;
  const name2 = expectStringField(obj, "name", position);
  const rawValue = obj.value;
  if (typeof rawValue !== "string") fail(position + ".value must be a string");
  const domain = expectStringField(obj, "domain", position).toLowerCase();
  if (/[\/\s:;,]/.test(domain)) fail(position + ".domain is not classifiable as a host");
  const path2 = expectStringField(obj, "path", position);
  const expires = expectFiniteNumberField(obj, "expires", position);
  const httpOnly = expectBooleanField(obj, "httpOnly", position);
  const secure = expectBooleanField(obj, "secure", position);
  const sameSite = obj.sameSite;
  if (sameSite !== "Strict" && sameSite !== "Lax" && sameSite !== "None") {
    fail(position + '.sameSite must be "Strict", "Lax", or "None"');
  }
  return { name: name2, value: rawValue, domain, path: path2, expires, httpOnly, secure, sameSite };
}
function validateLocalStorageItem(value, position) {
  if (!isPlainObject2(value)) fail(position + " must be an object");
  const obj = value;
  const name2 = expectStringField(obj, "name", position);
  const rawValue = obj.value;
  if (typeof rawValue !== "string") fail(position + ".value must be a string");
  return { name: name2, value: rawValue };
}
function validateOriginStorage(value, position) {
  if (!isPlainObject2(value)) fail(position + " must be an object");
  const obj = value;
  const origin = normalizeAuthorizedOrigin(obj.origin, position + ".origin");
  const localStorageRaw = obj.localStorage;
  if (!Array.isArray(localStorageRaw)) fail(position + ".localStorage must be an array");
  const localStorage = localStorageRaw.map(
    (item, i) => validateLocalStorageItem(item, position + ".localStorage[" + i + "]")
  );
  return { origin, localStorage };
}
function validateStateShape(value) {
  if (!isPlainObject2(value)) fail("login-state file must be a JSON object");
  const obj = value;
  const cookiesRaw = obj.cookies;
  const originsRaw = obj.origins;
  if (!Array.isArray(cookiesRaw)) fail("login-state file must contain a cookies array");
  if (!Array.isArray(originsRaw)) fail("login-state file must contain an origins array");
  const cookies = cookiesRaw.map((item, i) => validateCookie(item, "cookies[" + i + "]"));
  const origins = originsRaw.map((item, i) => validateOriginStorage(item, "origins[" + i + "]"));
  return { cookies, origins };
}
async function loadLoginState(config) {
  const { source, origins } = validateLoginStateConfig(config);
  const hosts = new Set(origins.map(hostnameOf));
  const originSet = new Set(origins);
  let text;
  try {
    text = await readFile(source, "utf8");
  } catch {
    fail("login-state source file is not readable");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("login-state source file is not valid JSON");
  }
  const { cookies, origins: stateOrigins } = validateStateShape(parsed);
  const authorizedCookies = cookies.filter((cookie) => cookieDomainMatches(cookie.domain, hosts));
  const authorizedOrigins = stateOrigins.filter((entry) => originSet.has(entry.origin));
  const totalEntries = cookies.length + stateOrigins.length;
  const injectedEntries = authorizedCookies.length + authorizedOrigins.length;
  if (injectedEntries === 0) {
    fail(
      "login-state file contains no entries for the authorized origins (" + totalEntries + " entr" + (totalEntries === 1 ? "y" : "ies") + " examined; " + origins.length + " origin" + (origins.length === 1 ? "" : "s") + " authorized)"
    );
  }
  return { cookies: authorizedCookies, origins: authorizedOrigins };
}
var LoginStateError;
var init_loginState = __esm({
  "src/loginState.ts"() {
    "use strict";
    LoginStateError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "LoginStateError";
      }
    };
  }
});

// src/adapters/browser.ts
var BrowserAdapter;
var init_browser = __esm({
  "src/adapters/browser.ts"() {
    "use strict";
    init_loginState();
    BrowserAdapter = class {
      kind = "browser";
      #driver;
      constructor(driver) {
        this.#driver = driver;
      }
      async start(ownerId, options) {
        const storageState = options?.loginState === void 0 ? void 0 : await loadLoginState(options.loginState);
        const driverOptions = {
          ...options?.url === void 0 ? {} : { url: options.url },
          ...options?.headless === void 0 ? {} : { headless: options.headless },
          ...storageState === void 0 ? {} : { storageState }
        };
        const info = await this.#driver.start(ownerId, driverOptions);
        return { page: info.page, headless: info.headless };
      }
      async observe(ownerId, options) {
        const driverOptions = {
          ...options?.maxNodes === void 0 ? {} : { maxNodes: options.maxNodes },
          // v8 scoped observation: the driver resolves the ref exactly as actions
          // do and REFUSES (REF_INVALID / REF_UNKNOWN / REF_EXPIRED / PAGE_CHANGED
          // / TARGET_CHANGED / WITHIN_NOT_ELEMENT / OBSERVATION_REQUIRED /
          // SCOPE_UNAVAILABLE — contract v9, dsh-browser d069f4f: a retained scope
          // root was released by navigation or an intervening observe) instead of
          // falling back to a whole-page view. The refusal propagates verbatim —
          // this adapter never catches, retries, or reroutes it.
          ...options?.withinRef === void 0 ? {} : { within: options.withinRef },
          // v9 Phase C: the bounded coverage probe runs ONLY on the terminal
          // absence-proof path (never on settle polls); the evidence travels
          // verbatim into QaObservation.coverage.
          ...options?.verifyCoverage === true ? { verifyCoverage: true } : {},
          // v9 Phase B: the identity anchor for the element the driver last
          // dispatched an action on; a request with no retained target REJECTS
          // with ANCHOR_UNAVAILABLE and that refusal propagates verbatim.
          ...options?.anchorLastAction === true ? { anchorLastAction: true } : {}
        };
        const observation = await this.#driver.observe(ownerId, driverOptions);
        return {
          page: observation.page,
          nodes: observation.nodes,
          truncated: observation.truncated,
          // The budget the driver ACTUALLY applied (its own 1..100 clamp), so
          // completeness reporting never confuses the 500-node request with fact.
          maxNodes: observation.limits.maxNodes,
          // Driver-named reasons travel verbatim (a driver that reports none
          // leaves the field absent; the QA layer never invents reasons).
          ...observation.truncationReasons === void 0 ? {} : { truncationReasons: observation.truncationReasons },
          // v8: the driver echoes the root it observed. Honest-optional: absent
          // means the view was NOT scoped (scope null for whole-page views, or a
          // pre-v8 driver that reports no scope). A scoped observation's budgets
          // and truncation are subtree-relative.
          ...observation.scope === void 0 || observation.scope === null ? {} : { scope: observation.scope },
          // v9 Phase C: per-observation coverage evidence, projected verbatim.
          ...observation.coverage === void 0 ? {} : { coverage: observation.coverage },
          // v9 Phase B: the identity anchor, present exactly when requested.
          ...observation.anchor === void 0 ? {} : { anchor: observation.anchor },
          // v9 gate diagnostics: hidden semantic-selector candidates the
          // visibility gate skipped, and whether the count is a lower bound.
          ...observation.hiddenMatches === void 0 ? {} : { hiddenMatches: observation.hiddenMatches },
          ...observation.hiddenMatchesPartial === void 0 ? {} : { hiddenMatchesPartial: observation.hiddenMatchesPartial }
        };
      }
      // The approval gate only applies to the computer driver. The browser driver
      // has no approval gate, so the parameter is accepted and deliberately ignored
      // here to keep the session core driver-agnostic.
      async act(ownerId, action, _approval) {
        const receipt = await this.#driver.act(ownerId, this.#mapAction(action));
        const projected = {
          status: receipt.status,
          ...receipt.code === void 0 ? {} : { code: receipt.code },
          ...receipt.reason === void 0 ? {} : { reason: receipt.reason },
          dispatched: receipt.dispatched
        };
        const DRIVER_BOOKKEEPING = /* @__PURE__ */ new Set([
          "receiptId",
          "ownerId",
          "action",
          "startedAt",
          "completedAt",
          "dispatched",
          "pageBefore",
          "pageAfter",
          "target",
          "observation",
          "verification",
          "code",
          "reason",
          "status"
        ]);
        for (const [key, value] of Object.entries(receipt)) {
          if (DRIVER_BOOKKEEPING.has(key) || value === void 0) continue;
          projected[key] = value;
        }
        return projected;
      }
      #mapAction(action) {
        switch (action.kind) {
          case "click":
            return { kind: "click", ref: action.ref };
          case "fill":
            return { kind: "fill", ref: action.ref, text: action.text };
          case "press":
            return { kind: "press", ref: action.ref, key: action.key };
          case "navigate":
            return { kind: "navigate", url: action.url };
          case "scroll": {
            if ("ref" in action && "direction" in action) {
              throw new Error(
                'browser driver does not support the computer "scroll" shape (ref + direction); use scroll by ref alone or by direction alone'
              );
            }
            if ("ref" in action) return { kind: "scroll", ref: action.ref };
            return {
              kind: "scroll",
              direction: action.direction,
              ...action.amount === void 0 ? {} : { amount: action.amount }
            };
          }
          case "select":
            return { kind: "select", ref: action.ref, option: action.option };
          case "hover":
            return { kind: "hover", ref: action.ref };
          case "focus":
          case "type":
          case "key":
            throw new Error('browser driver does not support the computer "' + action.kind + '" action');
          case "visual_click":
          case "visual_drag":
          case "visual_scroll":
            throw new Error('browser driver does not support the CU visual fallback action "' + action.kind + '"');
          default:
            throw new Error("browser driver does not support the unknown action kind");
        }
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
  }
});

// src/adapters/computer.ts
function receiptCode(receipt) {
  if (receipt.reason.includes("secure text entry")) return "secure-text";
  if (receipt.reason.includes("host approval")) return "APPROVAL_REQUIRED";
  if (receipt.reason.includes("approval was not granted") || receipt.reason.includes("approval unavailable") || receipt.reason.includes("approval cancelled")) {
    return "APPROVAL_REQUIRED";
  }
  if (receipt.reason.includes("OBSERVATION_EVICTED")) return "OBSERVATION_EVICTED";
  if (receipt.status === "rejected" && receipt.reason.includes("unknown reference")) return "UNKNOWN_REF";
  if (receipt.reason.includes("stale")) return "STALE_OBSERVATION";
  if (receipt.reason.includes("observation expired before action dispatch")) return "STALE_OBSERVATION";
  if (receipt.reason.includes("session_locked")) return "SESSION_LOCKED";
  if (receipt.reason.includes("live application identity changed") || receipt.reason.includes("live window identity changed") || receipt.reason.includes("live target identity changed") || receipt.reason.includes("live observation fingerprint changed")) {
    return "IDENTITY_CHANGED";
  }
  return void 0;
}
var EDITABLE_ROLES, ComputerAdapter;
var init_computer = __esm({
  "src/adapters/computer.ts"() {
    "use strict";
    EDITABLE_ROLES = /* @__PURE__ */ new Set(["AXTextField", "AXTextArea", "AXSearchField"]);
    ComputerAdapter = class {
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
        if (options?.withinRef !== void 0) {
          throw new Error(
            "the computer driver does not support scoped observation (withinRef); observe the whole accessibility tree or narrow it with maxDepth instead"
          );
        }
        void options?.verifyCoverage;
        void options?.anchorLastAction;
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
        const context = {
          scopeId: ownerId,
          ...approval === void 0 ? {} : { approval }
        };
        if (action.kind === "visual_click" || action.kind === "visual_drag" || action.kind === "visual_scroll") {
          const visualAction = this.#mapVisualAction(action);
          const receipt2 = await this.#driver.visualAct(visualAction, context);
          return this.#projectVisualReceipt(receipt2);
        }
        const computerAction = this.#mapAction(action);
        const receipt = await this.#driver.act(computerAction, context);
        const code = receiptCode(receipt);
        const projected = {
          status: receipt.status,
          ...code === void 0 ? {} : { code },
          ...receipt.reason === "" ? {} : { reason: receipt.reason },
          dispatched: receipt.nativeAccepted || receipt.status === "confirmed" || receipt.status === "unknown"
        };
        const DRIVER_BOOKKEEPING = /* @__PURE__ */ new Set([
          "receiptId",
          "sequence",
          "status",
          "action",
          "ref",
          "observationId",
          "observationFingerprint",
          "startedAt",
          "finishedAt",
          "reason",
          "nativeAccepted",
          "postAction"
        ]);
        for (const [key, value] of Object.entries(receipt)) {
          if (DRIVER_BOOKKEEPING.has(key) || value === void 0) continue;
          projected[key] = value;
        }
        return projected;
      }
      #projectVisualReceipt(receipt) {
        const code = receiptCode(receipt);
        const projected = {
          status: receipt.status,
          ...code === void 0 ? {} : { code },
          ...receipt.reason === "" ? {} : { reason: receipt.reason },
          dispatched: receipt.nativeAccepted || receipt.status === "confirmed" || receipt.status === "unknown",
          ...receipt.captureSha256 === null || receipt.captureSha256 === void 0 ? {} : { captureSha256: receipt.captureSha256 }
        };
        const DRIVER_BOOKKEEPING = /* @__PURE__ */ new Set([
          "receiptId",
          "sequence",
          "status",
          "action",
          "observationId",
          "observationFingerprint",
          "captureSha256",
          "startedAt",
          "finishedAt",
          "reason",
          "nativeAccepted",
          "postAction"
        ]);
        for (const [key, value] of Object.entries(receipt)) {
          if (DRIVER_BOOKKEEPING.has(key) || value === void 0) continue;
          projected[key] = value;
        }
        return projected;
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
        const raw = evidence;
        const hasReceiptCounters = typeof raw.receipts_total === "number" && typeof raw.receipts_dropped === "number" && typeof raw.receipts_returned === "number";
        return {
          console: [],
          network: [],
          bounded: true,
          computer: {
            contractVersion: evidence.contractVersion,
            scope: evidence.scope,
            status: evidence.status,
            activeObservations: evidence.activeObservations,
            activeNativeRequests: evidence.activeNativeRequests,
            receipts: evidence.receipts,
            ...hasReceiptCounters ? {
              receiptsTotal: raw.receipts_total,
              receiptsDropped: raw.receipts_dropped,
              receiptsReturned: raw.receipts_returned,
              receiptsBounded: raw.bounded === true
            } : {
              receiptsTotal: null,
              receiptsDropped: null,
              receiptsReturned: null,
              receiptsBounded: null,
              receiptsCountersUnavailableReason: "the computer driver contract is older than v4 and does not expose per-receipt counters; receipt truncation is unknown"
            }
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
      #mapVisualAction(action) {
        const point = { x: action.point.x, y: action.point.y };
        if (action.kind === "visual_click") {
          return {
            kind: "point",
            op: "click",
            observationId: action.observationId,
            captureSha256: action.captureSha256,
            point
          };
        }
        if (action.kind === "visual_drag") {
          return {
            kind: "point",
            op: "drag",
            observationId: action.observationId,
            captureSha256: action.captureSha256,
            point,
            to: { x: action.to.x, y: action.to.y }
          };
        }
        return {
          kind: "point",
          op: "scroll",
          observationId: action.observationId,
          captureSha256: action.captureSha256,
          point,
          direction: action.direction,
          ...action.amount === void 0 ? {} : { amount: action.amount }
        };
      }
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
          case "scroll": {
            if ("ref" in action && "direction" in action) {
              return {
                kind: "scroll",
                ref: action.ref,
                direction: action.direction,
                ...action.amount === void 0 ? {} : { amount: action.amount }
              };
            }
            throw new Error(
              "computer driver scroll requires both ref and direction (the browser-only ref-only or direction-only scroll shapes are not computer actions)"
            );
          }
          case "fill":
            throw new Error('computer driver does not support the browser "fill" action; use "type"');
          case "press":
            throw new Error('computer driver does not support the browser "press" action; use "key"');
          case "navigate":
            throw new Error('computer driver does not support the "navigate" action');
          case "select":
            throw new Error('computer driver does not support the "select" action (browser-only)');
          case "hover":
            throw new Error('computer driver does not support the "hover" action (browser-only)');
          case "visual_click":
          case "visual_drag":
          case "visual_scroll":
            throw new Error("computer driver visual actions must go through driver.visualAct");
          default:
            throw new Error("computer driver does not support the unknown action kind");
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
          // The budget the driver ACTUALLY applied (its own 1..500 clamp). The
          // computer driver reports no truncation-reason vocabulary, so no
          // truncationReasons field is synthesized here.
          maxNodes: observation.limits.maxNodes,
          observationId: observation.observationId,
          fingerprint: observation.fingerprint,
          // Vacuously verified coverage (browser driver contract v9 shape):
          // the computer driver's accessibility projection has NO shadow-DOM
          // boundary, so zero closed shadow roots can hide content from it. The
          // tree's own truncated flag remains the completeness gate. probedNodes
          // is honestly 0 — no probe ever runs, and none is needed.
          coverage: { verified: true, closedShadowRoots: 0, probedNodes: 0 },
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
  }
});

// src/adapters/mobile-types.ts
var QaCodeError;
var init_mobile_types = __esm({
  "src/adapters/mobile-types.ts"() {
    "use strict";
    QaCodeError = class extends Error {
      code;
      constructor(code, message) {
        super(message);
        this.name = "QaCodeError";
        this.code = code;
      }
    };
  }
});

// src/adapters/mobile.ts
function leaseKey(kind, deviceId) {
  return `${kind}:${deviceId}`;
}
function acquireLease(kind, deviceId, ownerId) {
  const key = leaseKey(kind, deviceId);
  const existing = leases.get(key);
  if (existing !== void 0 && existing.owner !== ownerId) {
    throw new Error(
      `device ${deviceId} is already leased by QA owner ${existing.owner} in this process; stop that session first. This lease is in-process only and is not a cluster-wide guarantee.`
    );
  }
  if (existing === void 0) {
    leases.set(key, { key, kind, deviceId, owner: ownerId, count: 1 });
    return;
  }
  existing.count += 1;
}
function releaseLease(kind, deviceId, ownerId) {
  const key = leaseKey(kind, deviceId);
  const existing = leases.get(key);
  if (existing === void 0 || existing.owner !== ownerId) return;
  existing.count -= 1;
  if (existing.count <= 0) leases.delete(key);
}
function frameKey(frame) {
  return [Math.round(frame.x), Math.round(frame.y), Math.round(frame.width), Math.round(frame.height)].join("x");
}
function framesClose(a, b) {
  return Math.abs(a.x - b.x) <= MAX_BOUNDS_SHIFT && Math.abs(a.y - b.y) <= MAX_BOUNDS_SHIFT && Math.abs(a.width - b.width) <= MAX_BOUNDS_SHIFT && Math.abs(a.height - b.height) <= MAX_BOUNDS_SHIFT;
}
function pointInside(frame, screen) {
  return frame.x >= 0 && frame.y >= 0 && frame.width > 0 && frame.height > 0 && frame.x + frame.width <= screen.width && frame.y + frame.height <= screen.height;
}
function center(frame) {
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}
function isWithinScreen(point, screen) {
  return point.x >= 0 && point.x <= screen.width && point.y >= 0 && point.y <= screen.height;
}
function nativeIdentifier(node) {
  const value = node.identifier?.trim();
  return value !== void 0 && value !== "" ? value : void 0;
}
function emptySession(ownerId, kind, deviceId, appId) {
  return {
    ownerId,
    kind,
    deviceId,
    appId,
    epoch: 0,
    observedAt: 0,
    entries: /* @__PURE__ */ new Map(),
    previousEntries: /* @__PURE__ */ new Map()
  };
}
function rejectReceipt(code, reason) {
  return { status: "rejected", code, reason, dispatched: false };
}
function acceptedDispatchReceipt(code, reason) {
  return {
    status: "unknown",
    ...code === void 0 ? {} : { code },
    reason,
    dispatched: true
  };
}
var MOBILE_REF_TTL_MS, leases, MAX_BOUNDS_SHIFT, MobileAdapterBase;
var init_mobile = __esm({
  "src/adapters/mobile.ts"() {
    "use strict";
    init_mobile_types();
    init_mobile_types();
    MOBILE_REF_TTL_MS = 3e4;
    leases = /* @__PURE__ */ new Map();
    MAX_BOUNDS_SHIFT = 2;
    MobileAdapterBase = class {
      #sessions = /* @__PURE__ */ new Map();
      #disposed = false;
      /** Whether platform-native element-bound text is available for this mode. */
      supportsTargetedText(_mode) {
        return false;
      }
      /**
       * Platform hook for the identifier-less selector used by target-bound text.
       * Returns the exact nonempty observed accessibility name plus a NATIVE
       * semantic editable type for a fresh unique app-owned visible nonsecure
       * editable match, or undefined when the platform/target cannot carry a
       * semantic selector. The base returns undefined: only iOS overrides this
       * (Android never reaches target-bound text), and the QA layer never
       * fabricates an identifier or falls back to coordinates/global typing.
       */
      semanticTextSelector(_fresh, _original) {
        return void 0;
      }
      /** Runs the platform-native element-bound text primitive selected by mode. */
      async runTargetedText(_mode, _target) {
        return {
          status: "rejected",
          dispatched: false,
          nativeAccepted: false,
          code: "TYPING_PRIMITIVE_UNAVAILABLE",
          reason: `${this.kind} backend does not expose a native element-bound text primitive`
        };
      }
      /**
       * Per-owner cleanup before a stop releases the lease. Implementations must
       * release exactly their own device/session scope; a failure propagates and
       * leaves the in-process device lease busy so the caller can retry stop.
       */
      async cleanupDeviceForStop(_session) {
      }
      session(ownerId) {
        return this.#sessions.get(ownerId);
      }
      requireStarted(ownerId) {
        const session = this.#sessions.get(ownerId);
        if (session === void 0) {
          const crossOwner = [...this.#sessions.values()].some((other) => other.ownerId !== ownerId && other.entries.size > 0);
          throw new QaCodeError(
            crossOwner ? "CROSS_OWNER" : "NOT_STARTED",
            crossOwner ? `no QA session is started for owner ${ownerId}; refs belong to another owner` : `no QA session is started for owner ${ownerId}; call start() first`
          );
        }
        return session;
      }
      get disposed() {
        return this.#disposed;
      }
      async start(ownerId, options) {
        this.#assertUsable();
        const owner = ownerId.trim();
        if (owner === "") throw new TypeError("owner id must be a non-empty string");
        const deviceId = options?.deviceId?.trim() ?? "";
        if (deviceId === "") {
          throw new Error("mobile sessions require an explicit deviceId; refusing to choose a default device");
        }
        const appId = this.appIdFromOptions(options);
        const existing = this.#sessions.get(owner);
        if (existing !== void 0) {
          throw new Error(`QA owner ${owner} already has a ${this.kind} session; stop it before starting another`);
        }
        acquireLease(this.kind, deviceId, owner);
        try {
          await this.launchApp(deviceId, appId);
          this.#sessions.set(owner, emptySession(owner, this.kind, deviceId, appId));
          return { page: { url: appId, title: appId }, headless: false };
        } catch (error) {
          releaseLease(this.kind, deviceId, owner);
          throw error;
        }
      }
      async observe(ownerId, options) {
        this.#assertUsable();
        if (options?.withinRef !== void 0) {
          throw new Error(`the ${this.kind} driver does not support scoped observation (withinRef)`);
        }
        const session = this.requireStarted(ownerId);
        const native = await this.readNativeObservation(session.deviceId, options ?? {}, session);
        session.epoch += 1;
        session.observedAt = Date.now();
        const entries = this.#entriesFromNative(native.nodes, session.ownerId, session.epoch, session.observedAt, native.coordinateSpace, native.screen);
        session.previousEntries = new Map([...session.previousEntries, ...session.entries]);
        session.entries = entries.byRef;
        const projected = this.#projectObservation(session, native, entries.byIndex);
        session.lastObservation = projected;
        return projected;
      }
      async act(ownerId, action, _approval) {
        this.#assertUsable();
        try {
          return await this.#act(ownerId, action);
        } catch (error) {
          if (error instanceof QaCodeError) {
            return rejectReceipt(error.code, error.message);
          }
          throw error;
        }
      }
      async evidence(ownerId, _options) {
        this.#assertUsable();
        const session = this.requireStarted(ownerId);
        let foreground;
        try {
          foreground = await this.readNativeForeground(session.deviceId, session.appId);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          foreground = { backendKind: "unknown", verified: false, detail: `foreground read failed: ${detail}` };
        }
        return {
          console: [],
          network: [],
          bounded: true,
          mobile: {
            kind: this.kind,
            deviceId: session.deviceId,
            appId: session.appId,
            backend: foreground.backendKind,
            foregroundVerified: foreground.verified,
            detail: foreground.detail
          }
        };
      }
      async visualObserve(ownerId, options) {
        this.#assertUsable();
        const session = this.requireStarted(ownerId);
        const png = await this.capturePng(session.deviceId);
        return {
          driver: this.kind,
          observationFingerprint: null,
          observationId: null,
          png: png.png,
          width: png.width,
          height: png.height,
          sha256: png.sha256,
          usable: true,
          marks: 0,
          omitted: 0,
          artifactPath: png.artifactPath,
          ...options?.fingerprint === void 0 ? {} : { observationFingerprint: options.fingerprint }
        };
      }
      async stop(ownerId) {
        const session = this.#sessions.get(ownerId);
        if (session === void 0) return { stopped: false, reason: "not-running" };
        try {
          await this.cleanupDeviceForStop(session);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new QaCodeError(
            `${this.kind === "ios" ? "IOS_STOP_CLEANUP_FAILED" : "MOBILE_STOP_CLEANUP_FAILED"}`,
            `${this.kind} stop cleanup failed for device ${session.deviceId} (owner ${session.ownerId}): ${detail}. The in-process lease is still held; retry qa_session_stop.`
          );
        }
        this.#sessions.delete(ownerId);
        releaseLease(this.kind, session.deviceId, session.ownerId);
        return { stopped: true, reason: "mobile-scope-released" };
      }
      async dispose() {
        if (this.#disposed) return;
        this.#disposed = true;
        for (const session of [...this.#sessions.values()]) {
          releaseLease(this.kind, session.deviceId, session.ownerId);
        }
        this.#sessions.clear();
        await this.disposeBackend();
      }
      #assertUsable() {
        if (this.#disposed) throw new Error(`the ${this.kind} adapter has been disposed`);
      }
      async #act(ownerId, action) {
        const owner = ownerId.trim();
        const session = this.requireStarted(owner);
        if (session.kind !== this.kind) {
          return rejectReceipt("CROSS_OWNER", `owner ${owner} is bound to a ${session.kind} session, not this ${this.kind} adapter`);
        }
        switch (action.kind) {
          case "navigate":
          case "select":
          case "hover":
            throw new Error(`the ${this.kind} driver does not support the "${action.kind}" action`);
          case "fill":
            return this.#fillAction(session, action);
          case "type":
            return this.#typeAction(session, action);
          case "click":
            return this.#clickAction(session, action);
          case "scroll":
            return this.#scrollAction(session, action);
          case "key":
          case "press":
            return this.#keyAction(session, action);
          case "focus":
            return rejectReceipt("FOCUS_UNSUPPORTED", `the ${this.kind} driver has no target-bound focus action; tap the target and re-observe instead`);
          default:
            throw new Error(`unsupported ${this.kind} action kind`);
        }
      }
      #requireCurrentEntry(session, ref) {
        const entry = session.entries.get(ref);
        if (entry === void 0) {
          if (session.previousEntries.has(ref)) {
            throw new QaCodeError("STALE_OBSERVATION", "the ref is from an earlier observation epoch; call observe() to re-resolve it");
          }
          const otherOwner = [...this.#sessions.values()].find(
            (other) => other !== session && (other.entries.has(ref) || other.previousEntries.has(ref))
          );
          if (otherOwner !== void 0) {
            throw new QaCodeError("CROSS_OWNER", `the ref belongs to owner ${otherOwner.ownerId}; mobile refs are not shareable across owners`);
          }
          throw new QaCodeError("UNKNOWN_REF", "the ref is not in the current observation");
        }
        if (Date.now() - entry.observedAt > MOBILE_REF_TTL_MS) {
          throw new QaCodeError("STALE_OBSERVATION", "the mobile observation expired; call observe() again");
        }
        return entry;
      }
      #projectObservation(session, native, entries) {
        const pageTitle = native.actualAppId ?? session.appId;
        const nodes = entries.map((entry) => {
          const node = {
            ref: entry.ref,
            role: entry.role,
            name: entry.name,
            tag: entry.tag ?? "",
            ...entry.identifier === void 0 ? {} : { identifier: entry.identifier },
            interactive: entry.interactive ?? false,
            editable: entry.editable,
            disabled: entry.disabled,
            ...entry.parentRef === void 0 ? {} : { parentRef: entry.parentRef },
            ...entry.secure === null ? {} : { secure: entry.secure },
            ...entry.value === void 0 ? {} : { value: entry.value }
          };
          return node;
        });
        return {
          page: { url: session.appId, title: pageTitle },
          nodes,
          truncated: native.truncated,
          mobile: {
            deviceId: session.deviceId,
            appId: session.appId,
            kind: this.kind,
            backend: native.backendKind,
            verified: native.verified,
            coordinateSpace: native.coordinateSpace,
            screen: { ...native.screen }
          },
          ...native.maxNodes === void 0 ? {} : { maxNodes: native.maxNodes }
        };
      }
      #entriesFromNative(nodes, ownerId, epoch, observedAt, coordinateSpace, screen) {
        const byRef = /* @__PURE__ */ new Map();
        const byIndex = [];
        const walk = (items, parentRef) => {
          for (const node of items) {
            const index = byIndex.length;
            const ref = `mob:${this.kind}:${ownerId}:${epoch}:${index}`;
            const identifier = nativeIdentifier(node);
            const identity = {
              ref,
              ...identifier === void 0 ? {} : { identifier },
              role: node.role,
              name: node.name,
              tag: node.tag,
              frame: { ...node.frame },
              enabled: node.enabled,
              disabled: node.disabled,
              editable: node.editable,
              interactive: node.interactive,
              focused: node.focused,
              secure: node.secure,
              ...node.value === void 0 ? {} : { value: node.value },
              clickable: node.clickable,
              scrollable: node.scrollable,
              ...parentRef === void 0 ? {} : { parentRef },
              coordinateSpace,
              screen: { ...screen },
              observedAt
            };
            byRef.set(ref, identity);
            byIndex.push(identity);
            if (node.children !== void 0 && node.children.length > 0) {
              walk(node.children, ref);
            }
          }
        };
        walk(nodes);
        return { byRef, byIndex };
      }
      #clickAction(session, action) {
        return this.#coordinateAction(session, action.ref, async (deviceId, point) => {
          await this.nativeTap(deviceId, point.x, point.y);
          return acceptedDispatchReceipt(void 0, `native tap dispatched to ${this.kind} device ${deviceId}; outcome requires re-observation`);
        });
      }
      #fillAction(session, action) {
        if (this.supportsTargetedText("fill")) {
          return this.#targetedTextAction(session, action, "fill");
        }
        return Promise.resolve(rejectReceipt(
          "FILL_PRIMITIVE_UNAVAILABLE",
          `${this.kind} mobile adapter has no safe replace primitive: native backend text input appends and cannot implement fill (replace) semantics, and no safe target-bound replace primitive is available.`
        ));
      }
      #typeAction(session, action) {
        if (this.supportsTargetedText("type")) {
          return this.#targetedTextAction(session, action, "type");
        }
        this.#requireCurrentEntry(session, action.ref);
        if (!this.canTypeSafely(session)) {
          return Promise.resolve(rejectReceipt(
            "TYPING_PRIMITIVE_UNAVAILABLE",
            `${this.kind} mobile adapter has no safe target-bound typing primitive: raw ${this.kind === "ios" ? "AXe" : "uiautomator"} observations do not prove the text will land in the requested field. Type after tapping only when focus can be verified, or use a backend primitive that binds text to a native target.`
          ));
        }
        return this.#coordinateAction(session, action.ref, async (deviceId, point) => {
          const before = await this.readNativeObservation(deviceId, {}, session);
          const beforeTarget = this.#findFreshTarget(session, before, action.ref);
          if (beforeTarget.secure === true) {
            throw new QaCodeError("SECURE_TARGET", "refusing to type into a secure field");
          }
          if (beforeTarget.focused === true && !beforeTarget.disabled) {
            await this.nativeType(deviceId, action.text);
            return acceptedDispatchReceipt(void 0, `native type dispatched to focused ${this.kind} target; outcome requires re-observation`);
          }
          if (beforeTarget.focused !== false) {
            throw new QaCodeError("FOCUS_UNVERIFIED", "the backend did not expose a known focused flag for the target; refusing unverifiable typing");
          }
          await this.nativeTap(deviceId, point.x, point.y);
          const after = await this.readNativeObservation(deviceId, {}, session);
          const afterTarget = this.#findFreshTarget(session, after, action.ref);
          if (afterTarget.focused !== true || afterTarget.disabled || afterTarget.secure === true) {
            throw new QaCodeError("FOCUS_NOT_ESTABLISHED", "tap was dispatched but the requested target is not verifiably focused; no text was typed");
          }
          await this.nativeType(deviceId, action.text);
          return acceptedDispatchReceipt(void 0, `native type dispatched to verified focused ${this.kind} target; outcome requires re-observation`);
        });
      }
      /**
       * Fresh owner/app/ref/unique/frame/secure validation, then a platform-native
       * target-bound text mutation. The native target carries the fresh stable
       * identifier when one exists (always preferred); only an identifier-less iOS
       * target may instead carry the exact nonempty observed accessibility name
       * plus a native semantic editable type (TextField/TextView/SearchField). No
       * fake identifier, no coordinate-only selector, no raw global type fallback.
       * This is the ONLY iOS type/fill route when the native methods are present;
       * it never sets focus.
       */
      async #targetedTextAction(session, action, mode) {
        this.#requireCurrentEntry(session, action.ref);
        const native = await this.readNativeObservation(session.deviceId, {}, session);
        this.#assertNativeSession(session, native);
        const fresh = this.#findFreshTarget(session, native, action.ref);
        const original = session.entries.get(action.ref);
        if (original === void 0) throw new QaCodeError("UNKNOWN_REF", "the ref is not in the current observation");
        if (!framesClose(original.frame, fresh.frame)) {
          throw new QaCodeError("TARGET_CHANGED", `target bounds changed from ${frameKey(original.frame)} to ${frameKey(fresh.frame)} between observations; refusing stale target`);
        }
        if (!pointInside(fresh.frame, native.screen)) {
          throw new QaCodeError("TARGET_OUT_OF_BOUNDS", `target frame ${frameKey(fresh.frame)} is not inside screen ${native.screen.width}x${native.screen.height}`);
        }
        if (!isWithinScreen(center(fresh.frame), native.screen)) {
          throw new QaCodeError("TARGET_OUT_OF_BOUNDS", "target center is outside the device screen");
        }
        const identifier = nativeIdentifier(fresh);
        const semantic = identifier === void 0 ? this.semanticTextSelector(fresh, original) : void 0;
        if (identifier === void 0 && semantic === void 0) {
          const code = mode === "fill" ? "FILL_PRIMITIVE_UNAVAILABLE" : "TYPING_PRIMITIVE_UNAVAILABLE";
          throw new QaCodeError(
            code,
            `${this.kind} target-bound text requires a native stable accessibility identifier or, on iOS, an exact nonempty accessible name with a TextField/TextView/SearchField native semantic type; this target has none, so the primitive is unavailable and no raw fallback is used.`
          );
        }
        const target = {
          udid: session.deviceId,
          bundleId: session.appId,
          ...identifier === void 0 ? {} : { identifier },
          ...semantic === void 0 ? {} : { semantic },
          frame: { ...fresh.frame },
          text: action.text,
          ...native.appPid === void 0 ? {} : { expectedPID: native.appPid },
          ...fresh.secure === true ? { secure: true } : fresh.secure === false ? { secure: false } : {}
        };
        let result;
        try {
          result = await this.runTargetedText(mode, target);
        } catch {
          throw new Error(
            `${this.kind} native target-bound text invocation failed with unknown dispatch state; treating it as thrown, not as a no-dispatch rejection`
          );
        }
        return this.#targetedTextReceipt(result);
      }
      #targetedTextReceipt(result) {
        if (result.dispatched) {
          return {
            status: "unknown",
            dispatched: true,
            ...result.code === void 0 ? {} : { code: result.code },
            ...result.reason === void 0 ? {} : { reason: result.reason }
          };
        }
        if (result.status === "rejected") {
          return rejectReceipt(
            result.code ?? "TARGETED_TEXT_REJECTED",
            result.reason ?? "native target-bound text mutation was rejected before dispatch"
          );
        }
        return rejectReceipt(
          "TARGETED_TEXT_UNKNOWN_WITHOUT_DISPATCH",
          result.reason ?? "native result reported neither dispatch nor an explicit no-dispatch rejection"
        );
      }
      #scrollAction(session, action) {
        if (!("direction" in action) || action.direction === void 0) {
          return Promise.resolve(rejectReceipt(
            "UNSUPPORTED_ACTION",
            `${this.kind} mobile scroll requires a screen direction; ref-only scroll-into-view is not supported`
          ));
        }
        if ("ref" in action && action.ref !== void 0) {
          return Promise.resolve(rejectReceipt(
            "UNSUPPORTED_ACTION",
            `${this.kind} mobile driver has no target-bound scroll primitive; use direction-only scroll`
          ));
        }
        const direction = action.direction === "up" ? "up" : "down";
        const amount = "amount" in action && typeof action.amount === "number" ? action.amount : void 0;
        return this.#validatedSessionAction(session, async (deviceId) => {
          await this.nativeScroll(deviceId, direction, amount);
          return acceptedDispatchReceipt(void 0, `native scroll (${direction}) dispatched to ${this.kind} device ${deviceId}; outcome requires re-observation`);
        });
      }
      #keyAction(session, action) {
        this.#requireCurrentEntry(session, action.ref);
        return this.#validatedSessionAction(session, async (deviceId) => {
          await this.nativeKey(deviceId, action.key);
          return acceptedDispatchReceipt(void 0, `native key ${action.key} dispatched to ${this.kind} device ${deviceId}; outcome requires re-observation`);
        });
      }
      /**
       * Fresh native read + app/device validation, then run a coordinate-based
       * dispatch against the resolved fresh target's center.
       */
      async #coordinateAction(session, ref, run) {
        this.#requireCurrentEntry(session, ref);
        const native = await this.readNativeObservation(session.deviceId, {}, session);
        this.#assertNativeSession(session, native);
        const fresh = this.#findFreshTarget(session, native, ref);
        const original = session.entries.get(ref);
        if (original === void 0) throw new QaCodeError("UNKNOWN_REF", "the ref is not in the current observation");
        if (!framesClose(original.frame, fresh.frame)) {
          throw new QaCodeError("TARGET_CHANGED", `target bounds changed from ${frameKey(original.frame)} to ${frameKey(fresh.frame)} between observations; refusing stale coordinates`);
        }
        if (!pointInside(fresh.frame, native.screen)) {
          throw new QaCodeError("TARGET_OUT_OF_BOUNDS", `target frame ${frameKey(fresh.frame)} is not inside screen ${native.screen.width}x${native.screen.height}`);
        }
        const point = center(fresh.frame);
        if (!isWithinScreen(point, native.screen)) {
          throw new QaCodeError("TARGET_OUT_OF_BOUNDS", "target center is outside the device screen");
        }
        return run(session.deviceId, point);
      }
      /**
       * Fresh native foreground/read validation for non-coordinate actions (key).
       */
      async #validatedSessionAction(session, run) {
        const native = await this.readNativeObservation(session.deviceId, {}, session);
        this.#assertNativeSession(session, native);
        return run(session.deviceId);
      }
      #assertNativeSession(session, native) {
        if (native.deviceId !== session.deviceId) {
          throw new QaCodeError("DEVICE_CHANGED", `backend observed ${native.deviceId} but session is bound to ${session.deviceId}`);
        }
        if (!native.verified) {
          const detail = native.detail === void 0 ? "no native app identity" : native.detail;
          throw new QaCodeError("APP_IDENTITY_UNVERIFIED", detail);
        }
      }
      #findFreshTarget(session, native, ref) {
        const original = session.entries.get(ref);
        if (original === void 0) throw new QaCodeError("UNKNOWN_REF", "the ref is not in the current observation");
        const flat = [];
        const flatten = (items) => {
          for (const item of items) {
            flat.push(item);
            if (item.children !== void 0) flatten(item.children);
          }
        };
        flatten(native.nodes);
        const stable = original.identifier;
        const candidates = stable === void 0 ? flat.filter((node) => node.role === original.role && node.name === original.name && node.visible !== false) : flat.filter((node) => node.identifier === stable);
        if (candidates.length === 0) {
          throw new QaCodeError("TARGET_CHANGED", "the requested target was not found in the fresh native tree");
        }
        if (candidates.length > 1) {
          throw new QaCodeError("TARGET_NOT_UNIQUE", "the requested target is ambiguous in the fresh native tree; refusing to guess");
        }
        const fresh = candidates[0];
        if (fresh.disabled) throw new QaCodeError("TARGET_DISABLED", "the target is disabled in the fresh native tree");
        if (fresh.secure === true) throw new QaCodeError("SECURE_TARGET", "refusing a coordinate-derived action on a secure field");
        return fresh;
      }
    };
  }
});

// src/adapters/ios.ts
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function normalizedRole(role) {
  return role.startsWith("AX") ? role.slice(2) : role;
}
function editableRole(role) {
  const normalized = normalizedRole(role);
  return normalized === "TextField" || normalized === "TextArea" || normalized === "TextView" || normalized === "SearchField" || normalized === "SecureTextField";
}
function secureRole(role) {
  return normalizedRole(role) === "SecureTextField";
}
function semanticTextType(role) {
  const normalized = normalizedRole(role);
  if (normalized === "TextField") return "TextField";
  if (normalized === "TextArea" || normalized === "TextView") return "TextView";
  if (normalized === "SearchField") return "SearchField";
  return void 0;
}
function clean(value) {
  return value === void 0 ? "" : value.trim();
}
var IOS_KEYS, IosAdapter;
var init_ios = __esm({
  "src/adapters/ios.ts"() {
    "use strict";
    init_mobile();
    IOS_KEYS = /* @__PURE__ */ new Set(["home", "lock", "unlock", "siri", "volumeUp", "volumeDown"]);
    IosAdapter = class extends MobileAdapterBase {
      kind = "ios";
      #backend;
      constructor(backend) {
        super();
        this.#backend = backend;
      }
      appIdFromOptions(options) {
        const bundleId = options?.bundleId?.trim() ?? "";
        if (bundleId === "") {
          throw new Error("iOS sessions require an explicit bundleId; refusing to infer an app from the connected device");
        }
        return bundleId;
      }
      async launchApp(deviceId, appId) {
        const result = await this.#backend.launchApp(deviceId, appId);
        if (!result.ok) {
          throw new QaCodeError(
            result.unsupported?.capability ?? "IOS_LAUNCH_UNSUPPORTED",
            result.unsupported?.reason ?? `iOS launch refused for ${appId}`
          );
        }
      }
      async readNativeObservation(deviceId, options, _session) {
        const raw = await this.#backend.observe(deviceId, {
          ...options.maxNodes === void 0 ? {} : { maxNodes: options.maxNodes },
          ...options.maxDepth === void 0 ? {} : { maxDepth: options.maxDepth }
        });
        if (raw.udid !== deviceId) {
          throw new QaCodeError("DEVICE_CHANGED", `backend observed udid ${raw.udid} but session is bound to ${deviceId}`);
        }
        const actualAppId = raw.app.bundleId === void 0 ? void 0 : raw.app.bundleId;
        const appPid = raw.app.pid;
        const verified = raw.app.verified === true && actualAppId === _session.appId;
        const detail = raw.app.verified === true ? verified ? `native foreground ${actualAppId}` : `native foreground is ${actualAppId ?? "unknown"}, expected ${_session.appId}` : raw.app.name === void 0 ? "iOS backend did not provide a verified foreground app identity" : `iOS foreground unverified (name ${raw.app.name})`;
        return {
          deviceId: raw.udid,
          backendKind: raw.backend,
          ...actualAppId === void 0 ? {} : { actualAppId },
          ...appPid === void 0 ? {} : { appPid },
          verified,
          detail,
          screen: { width: raw.screen.width, height: raw.screen.height },
          coordinateSpace: "point",
          nodes: raw.nodes.map((node) => this.#normalizeNode(node)),
          truncated: raw.truncated,
          maxNodes: raw.maxNodes,
          ...raw.maxDepth === void 0 ? {} : { maxDepth: raw.maxDepth }
        };
      }
      async readNativeForeground(deviceId, appId) {
        const foreground = await this.#backend.foregroundApp(deviceId);
        const verified = foreground.app.verified === true && foreground.app.bundleId === appId;
        const detail = foreground.app.verified === true ? `native foreground ${foreground.app.bundleId ?? foreground.app.name ?? ""}` : foreground.unsupported?.reason ?? "iOS backend could not verify the foreground app";
        return { backendKind: foreground.backend, verified, detail };
      }
      async nativeTap(deviceId, x, y) {
        const result = await this.#backend.tap(deviceId, x, y);
        this.#assertOk("tap", result);
      }
      async nativeType(deviceId, text) {
        const result = await this.#backend.type(deviceId, text);
        this.#assertOk("type", result);
      }
      async nativeScroll(deviceId, direction, amount) {
        const result = await this.#backend.scroll(deviceId, direction, amount);
        this.#assertOk("scroll", result);
      }
      async nativeKey(deviceId, key) {
        if (!IOS_KEYS.has(key)) {
          throw new QaCodeError("UNSUPPORTED_KEY", `iOS driver key must be one of ${[...IOS_KEYS].join(", ")}`);
        }
        const result = await this.#backend.key(deviceId, key);
        this.#assertOk("key", result);
      }
      canTypeSafely(_session) {
        return false;
      }
      supportsTargetedText(mode) {
        return mode === "type" ? typeof this.#backend.typeTarget === "function" : typeof this.#backend.fillTarget === "function";
      }
      /**
       * iOS identifier-less selector: the exact nonempty observed accessibility
       * name plus a native semantic editable type. The fresh node already
       * survived #findFreshTarget (unique role+name in the session's verified
       * app-owned fresh tree, enabled, nonsecure, frame-close); this additionally
       * requires a native semantic text role, editability, a non-hidden visibility
       * claim, and the exact observed name. No other platform, role, or label
       * ever yields a semantic selector — an identifier is never fabricated and
       * SecureTextField is never a candidate.
       */
      semanticTextSelector(fresh, original) {
        const type = semanticTextType(fresh.role);
        if (type === void 0 || fresh.name.trim() === "") return void 0;
        if (!fresh.editable) return void 0;
        if (fresh.visible === false) return void 0;
        if (fresh.disabled || fresh.secure === true) return void 0;
        if (original.name !== fresh.name) return void 0;
        return { label: fresh.name, type };
      }
      async runTargetedText(mode, target) {
        const nativeTarget = {
          udid: target.udid,
          bundleId: target.bundleId,
          ...target.identifier === void 0 ? {} : { identifier: target.identifier },
          ...target.semantic === void 0 ? {} : { semantic: { label: target.semantic.label, type: target.semantic.type } },
          frame: { x: target.frame.x, y: target.frame.y, width: target.frame.width, height: target.frame.height },
          text: target.text,
          ...target.expectedPID === void 0 ? {} : { expectedPID: target.expectedPID },
          ...target.secure === void 0 ? {} : { secure: target.secure }
        };
        const result = mode === "type" ? await this.#backend.typeTarget(nativeTarget) : await this.#backend.fillTarget(nativeTarget);
        return {
          status: result.status,
          dispatched: result.dispatched,
          nativeAccepted: result.nativeAccepted,
          ...result.code === void 0 ? {} : { code: result.code },
          ...result.reason === void 0 ? {} : { reason: result.reason }
        };
      }
      async cleanupDeviceForStop(session) {
        if (typeof this.#backend.releaseDevice !== "function") return;
        await this.#backend.releaseDevice(session.deviceId);
      }
      async capturePng(deviceId) {
        const shot = await this.#backend.screenshot(deviceId);
        const png = Buffer.from(shot.pngBase64, "base64");
        const size = this.#pngSize(png, shot.width, shot.height);
        const artifactPath = join(tmpdir(), `dsh-qa-ios-${deviceId.replace(/[^A-Za-z0-9_.-]/g, "_")}-${Date.now()}.png`);
        writeFileSync(artifactPath, png);
        return {
          png: new Uint8Array(png),
          width: size.width,
          height: size.height,
          sha256: createHash("sha256").update(png).digest("hex"),
          artifactPath
        };
      }
      async disposeBackend() {
        await this.#backend.dispose();
      }
      #normalizeNode(node) {
        const role = clean(node.type);
        const editable = editableRole(role);
        const secure = node.secure === true || secureRole(role) ? true : node.secure === false ? false : null;
        const enabled = node.enabled !== false;
        const clickable = enabled && (role.startsWith("AXButton") || role.includes("Button") || role.includes("Cell") || role.includes("Link") || role.includes("MenuItem") || role.includes("Tab"));
        const identifier = clean(node.identifier);
        const raw = {
          ...identifier === "" ? {} : { identifier },
          role: role || "AXUnknown",
          name: clean(node.name),
          tag: identifier,
          frame: { x: node.frame.x, y: node.frame.y, width: node.frame.width, height: node.frame.height },
          enabled,
          disabled: node.enabled === false,
          editable,
          interactive: enabled && (editable || clickable || role !== ""),
          ...node.visible === void 0 ? {} : { visible: node.visible },
          focused: node.focused === true ? true : node.focused === false ? false : null,
          secure,
          ...node.value !== void 0 && secure !== true ? { value: node.value } : {},
          clickable,
          scrollable: false
        };
        return raw;
      }
      #assertOk(action, result) {
        if (!result.ok) {
          throw new QaCodeError(
            result.unsupported?.capability ?? `IOS_${action.toUpperCase()}_UNSUPPORTED`,
            result.unsupported?.reason ?? `iOS ${action} was refused by the backend`
          );
        }
      }
      #pngSize(png, width, height) {
        if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
          return { width, height };
        }
        if (png.length >= 24 && png.toString("ascii", 1, 4) === "PNG") {
          const parsedWidth = png.readUInt32BE(16);
          const parsedHeight = png.readUInt32BE(20);
          if (parsedWidth > 0 && parsedHeight > 0) return { width: parsedWidth, height: parsedHeight };
        }
        throw new Error("iOS screenshot did not include dimensions and the bytes are not a parseable PNG");
      }
    };
  }
});

// src/adapters/android.ts
import { createHash as createHash2 } from "node:crypto";
import { writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join2 } from "node:path";
function clean2(value) {
  return value === void 0 ? "" : value.trim();
}
function androidBackendKind(serial) {
  return serial.startsWith("emulator-") ? "emulator" : "device";
}
function editableNode(node) {
  return node.role === "EditText" || node.className.includes("EditText");
}
var AndroidAdapter;
var init_android = __esm({
  "src/adapters/android.ts"() {
    "use strict";
    init_mobile();
    AndroidAdapter = class extends MobileAdapterBase {
      kind = "android";
      #backend;
      constructor(backend) {
        super();
        this.#backend = backend;
      }
      appIdFromOptions(options) {
        const packageName = options?.packageName?.trim() ?? options?.bundleId?.trim() ?? "";
        if (packageName === "") {
          throw new Error("Android sessions require an explicit packageName (or bundleId fallback); refusing to infer an app");
        }
        return packageName;
      }
      async launchApp(deviceId, appId) {
        await this.#backend.launchApp(deviceId, appId);
      }
      async readNativeObservation(deviceId, options, session) {
        const raw = await this.#backend.observe(deviceId, {
          ...options.maxDepth === void 0 ? {} : { maxDepth: options.maxDepth }
        });
        if (raw.serial !== deviceId) {
          throw new QaCodeError("DEVICE_CHANGED", `backend observed serial ${raw.serial} but session is bound to ${deviceId}`);
        }
        const actualAppId = raw.packageName ?? raw.foreground?.packageName;
        const verified = raw.readError === void 0 && actualAppId !== void 0 && actualAppId === session.appId && (raw.foreground !== void 0 || raw.packageName !== void 0);
        const detail = raw.readError === void 0 ? verified ? `native foreground ${actualAppId}` : `native foreground is ${actualAppId ?? "unknown"}, expected ${session.appId}` : raw.readError;
        return {
          deviceId: raw.serial,
          backendKind: androidBackendKind(raw.serial),
          ...actualAppId === void 0 ? {} : { actualAppId },
          verified,
          detail,
          screen: { width: raw.screen.width, height: raw.screen.height },
          coordinateSpace: raw.coordinateSpace,
          nodes: raw.nodes.map((node) => this.#normalizeNode(node)),
          truncated: raw.truncated
        };
      }
      async readNativeForeground(deviceId, appId) {
        const foreground = await this.#backend.foregroundApp(deviceId);
        const verified = foreground.packageName !== void 0 && foreground.packageName === appId;
        const detail = foreground.packageName === void 0 ? `Android foreground read returned no package name (raw: ${foreground.raw || ""})` : `native foreground ${foreground.packageName}${foreground.activity === void 0 ? "" : ` (${foreground.activity})`}`;
        return { backendKind: androidBackendKind(deviceId), verified, detail };
      }
      async nativeTap(deviceId, x, y) {
        await this.#backend.tap(deviceId, x, y);
      }
      async nativeType(deviceId, text) {
        await this.#backend.type(deviceId, text);
      }
      async nativeScroll(deviceId, direction, amount) {
        await this.#backend.scroll(deviceId, direction, amount);
      }
      async nativeKey(deviceId, key) {
        await this.#backend.key(deviceId, key);
      }
      canTypeSafely(_session) {
        return true;
      }
      async capturePng(deviceId) {
        const shot = await this.#backend.screenshot(deviceId);
        const png = shot.png;
        const size = this.#pngSize(png, shot.width, shot.height);
        const artifactPath = join2(tmpdir2(), `dsh-qa-android-${deviceId.replace(/[^A-Za-z0-9_.-]/g, "_")}-${Date.now()}.png`);
        writeFileSync2(artifactPath, png);
        return {
          png: new Uint8Array(png),
          width: size.width,
          height: size.height,
          sha256: createHash2("sha256").update(png).digest("hex"),
          artifactPath
        };
      }
      async disposeBackend() {
        await this.#backend.dispose();
      }
      #normalizeNode(node) {
        const role = node.role;
        const resourceId = clean2(node.resourceId);
        const secure = node.password === true;
        const editable = editableNode(node);
        const name2 = secure ? "" : clean2(node.name ?? node.text ?? node.contentDesc);
        const value = secure ? void 0 : node.text === void 0 ? void 0 : node.text;
        const clickable = node.clickable === true;
        const raw = {
          ...resourceId === "" ? {} : { identifier: resourceId },
          role: role || "android.widget.View",
          name: name2,
          tag: resourceId,
          frame: { x: node.frame.x, y: node.frame.y, width: node.frame.width, height: node.frame.height },
          enabled: node.enabled,
          disabled: !node.enabled,
          editable,
          interactive: node.enabled && (clickable || editable || node.scrollable || role === "Button"),
          focused: typeof node.focused === "boolean" ? node.focused : null,
          secure: secure ? true : false,
          ...value === void 0 ? {} : { value },
          clickable,
          scrollable: node.scrollable === true,
          ...node.children.length > 0 ? { children: node.children.map((child) => this.#normalizeNode(child)) } : {}
        };
        return raw;
      }
      #pngSize(png, width, height) {
        if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
          return { width, height };
        }
        if (png.length >= 24 && png.toString("ascii", 1, 4) === "PNG") {
          const parsedWidth = png.readUInt32BE(16);
          const parsedHeight = png.readUInt32BE(20);
          if (parsedWidth > 0 && parsedHeight > 0) return { width: parsedWidth, height: parsedHeight };
        }
        throw new Error("Android screenshot did not include dimensions and the bytes are not a parseable PNG");
      }
    };
  }
});

// src/adapters/loadBrowser.ts
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
var BROWSER_DRIVER_SPECIFIER;
var init_loadBrowser = __esm({
  "src/adapters/loadBrowser.ts"() {
    "use strict";
    BROWSER_DRIVER_SPECIFIER = "@zseven-w/dsh-browser";
  }
});

// src/adapters/loadComputer.ts
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
var COMPUTER_DRIVER_SPECIFIER;
var init_loadComputer = __esm({
  "src/adapters/loadComputer.ts"() {
    "use strict";
    init_loadBrowser();
    COMPUTER_DRIVER_SPECIFIER = "@zseven-w/dsh-computer";
  }
});

// src/adapters/loadIos.ts
function missingIosDriverMessage(cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return 'Cannot load the iOS driver @zseven-w/dsh-ios/driver: it is not installed or the package does not export /driver. dsh-qa loads it lazily and keeps it external in the bundle, so initialize and tools/list work without it, but qa_* ios tools need it at runtime. Provide @zseven-w/dsh-ios alongside this plugin (local development: keep the "link:../dsh-ios" devDependency; host installs: the DSH host supplies it). Underlying error: ' + detail;
}
async function loadIosBackend(specifier = IOS_DRIVER_SPECIFIER) {
  try {
    const { createIosQaBackend } = await import(specifier);
    return createIosQaBackend();
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new Error(missingIosDriverMessage(error), { cause: error });
    }
    throw error;
  }
}
var IOS_DRIVER_SPECIFIER;
var init_loadIos = __esm({
  "src/adapters/loadIos.ts"() {
    "use strict";
    init_loadBrowser();
    IOS_DRIVER_SPECIFIER = "@zseven-w/dsh-ios/driver";
  }
});

// src/adapters/loadAndroid.ts
function missingAndroidDriverMessage(cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return 'Cannot load the Android driver @zseven-w/dsh-android/driver: it is not installed or the package does not export /driver. dsh-qa loads it lazily and keeps it external in the bundle, so initialize and tools/list work without it, but qa_* android tools need it at runtime. Provide @zseven-w/dsh-android alongside this plugin (local development: keep the "link:../dsh-android" devDependency; host installs: the DSH host supplies it). Underlying error: ' + detail;
}
async function loadAndroidBackend(specifier = ANDROID_DRIVER_SPECIFIER) {
  try {
    const { createAndroidQaBackend } = await import(specifier);
    return createAndroidQaBackend();
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new Error(missingAndroidDriverMessage(error), { cause: error });
    }
    throw error;
  }
}
var ANDROID_DRIVER_SPECIFIER;
var init_loadAndroid = __esm({
  "src/adapters/loadAndroid.ts"() {
    "use strict";
    init_loadBrowser();
    ANDROID_DRIVER_SPECIFIER = "@zseven-w/dsh-android/driver";
  }
});

// src/adapters/index.ts
var adapters_exports = {};
__export(adapters_exports, {
  ANDROID_DRIVER_SPECIFIER: () => ANDROID_DRIVER_SPECIFIER,
  AndroidAdapter: () => AndroidAdapter,
  BrowserAdapter: () => BrowserAdapter,
  COMPUTER_DRIVER_SPECIFIER: () => COMPUTER_DRIVER_SPECIFIER,
  ComputerAdapter: () => ComputerAdapter,
  IOS_DRIVER_SPECIFIER: () => IOS_DRIVER_SPECIFIER,
  IosAdapter: () => IosAdapter,
  loadAndroidBackend: () => loadAndroidBackend,
  loadComputerDriver: () => loadComputerDriver,
  loadIosBackend: () => loadIosBackend,
  missingAndroidDriverMessage: () => missingAndroidDriverMessage,
  missingComputerDriverMessage: () => missingComputerDriverMessage,
  missingIosDriverMessage: () => missingIosDriverMessage
});
var init_adapters = __esm({
  "src/adapters/index.ts"() {
    "use strict";
    init_browser();
    init_computer();
    init_ios();
    init_android();
    init_loadComputer();
    init_loadIos();
    init_loadAndroid();
  }
});

// src/contracts.ts
var QA_DRIVERS = ["browser", "computer", "ios", "android"];
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
var QA_SETTLE_SCHEMA_BUDGET_MAX = 15e3;
var QA_ADVISORY_REASONING_TRUST = "unverified-model-narration";
var QA_INCONCLUSIVE_TRUNCATED = "INCONCLUSIVE_TRUNCATED";
var QA_INCONCLUSIVE_UNSTABLE = "INCONCLUSIVE_UNSTABLE";
var QA_TARGET_NOT_UNIQUE = "TARGET_NOT_UNIQUE";
var QA_INCONCLUSIVE_SCOPE = "INCONCLUSIVE_SCOPE";
var QA_COVERAGE_UNVERIFIED = "COVERAGE_UNVERIFIED";
var QA_SCOPE_NOT_DURABLE = "SCOPE_NOT_DURABLE";
var QA_NO_CONFIRMED_RECEIPTS_WARNING = "no action dispatch was confirmed by the driver; outcomes were decided by settled observation only";

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

// src/replay/assertions.ts
var QA_VALUE_WITHHELD = "VALUE_WITHHELD";
var QA_VALUE_SECURE = "VALUE_SECURE";
var QA_VALUE_TRUNCATED = "VALUE_TRUNCATED";
function valueFlagReason(node) {
  if (node.valueWithheld === true) return QA_VALUE_WITHHELD;
  if (node.secure === true) return QA_VALUE_SECURE;
  return QA_VALUE_TRUNCATED;
}
function isFlaggedValueNode(node) {
  return node.valueWithheld === true || node.secure === true || node.valueTruncated === true;
}
function matchesNode(node, predicate) {
  if (predicate.role !== void 0 && node.role !== predicate.role) return false;
  if (predicate.name !== void 0 && node.name !== predicate.name) return false;
  if (predicate.tag !== void 0 && node.tag !== predicate.tag) return false;
  if (predicate.identifier !== void 0 && node.identifier !== predicate.identifier) return false;
  return true;
}
function toObservedNode(node) {
  return {
    role: node.role,
    name: node.name,
    tag: node.tag,
    ...node.identifier === void 0 ? {} : { identifier: node.identifier }
  };
}
function toObservedValueNode(node) {
  return {
    role: node.role,
    name: node.name,
    tag: node.tag,
    ...node.identifier === void 0 ? {} : { identifier: node.identifier },
    value: node.value ?? null,
    ...node.valueWithheld === true ? { valueWithheld: true } : {},
    ...node.secure === true ? { secure: true } : {},
    ...node.valueTruncated === true ? { valueTruncated: true } : {}
  };
}
var QA_ESCALATED_NODE_BUDGET = 500;
function evaluateAssertion(assertion, observation) {
  const kind = assertion.kind;
  if (kind === "node-present") {
    const predicate = assertion.expected;
    const matches = observation.nodes.filter((node) => matchesNode(node, predicate));
    const found = matches.length > 0;
    return { passed: found, observed: matches.map(toObservedNode), inconclusive: !found && observation.truncated };
  }
  if (kind === "node-absent") {
    const predicate = assertion.expected;
    const match = observation.nodes.find((node) => matchesNode(node, predicate));
    const found = match !== void 0;
    if (found) {
      return { passed: false, observed: toObservedNode(match), inconclusive: false };
    }
    if (observation.truncated) {
      return { passed: false, observed: null, inconclusive: true };
    }
    if (observation.coverage?.verified !== true) {
      return { passed: false, observed: null, inconclusive: true, reason: QA_COVERAGE_UNVERIFIED };
    }
    return { passed: true, observed: null, inconclusive: false };
  }
  if (kind === "node-in-viewport") {
    const predicate = assertion.expected;
    const matches = observation.nodes.filter((node) => matchesNode(node, predicate) && node.inViewport === true);
    const found = matches.length > 0;
    return { passed: found, observed: matches.map(toObservedNode), inconclusive: !found && observation.truncated };
  }
  if (kind === "node-value") {
    const expectation = assertion.expected;
    const predicateMatches = observation.nodes.filter((node) => matchesNode(node, expectation));
    if (predicateMatches.length > 1) {
      return {
        passed: false,
        observed: predicateMatches.map(toObservedValueNode),
        inconclusive: false,
        reason: QA_TARGET_NOT_UNIQUE
      };
    }
    const match = observation.nodes.find(
      (node) => matchesNode(node, expectation) && node.value === expectation.value
    );
    if (match !== void 0 && isFlaggedValueNode(match)) {
      return {
        passed: false,
        observed: [toObservedValueNode(match)],
        inconclusive: false,
        reason: valueFlagReason(match)
      };
    }
    const found = match !== void 0;
    return {
      passed: found,
      observed: match === void 0 ? [] : [toObservedValueNode(match)],
      inconclusive: !found && observation.truncated
    };
  }
  const expected = assertion.expected;
  const actual = observation.page.url;
  let passed;
  if (expected.url !== void 0) passed = actual === expected.url;
  else if (expected.contains !== void 0) passed = actual.includes(expected.contains);
  else passed = false;
  return { passed, observed: actual, inconclusive: false };
}
function readsNodes(kind) {
  return kind !== "page-url";
}
function scopeRootRef(observation) {
  const scope = observation.scope;
  if (scope === void 0) return void 0;
  const rootRef = scope.rootRef;
  return typeof rootRef === "string" && rootRef !== "" ? rootRef : void 0;
}
function budgetLabel(nodeBudget) {
  return nodeBudget === null ? "driver-default" : String(nodeBudget) + "-node";
}
function hasReason(reasons, reason) {
  return reasons !== void 0 && reasons.includes(reason);
}
function escalationClause(context) {
  if (context.escalationFailed) {
    return "the bounded escalation to the " + String(QA_ESCALATED_NODE_BUDGET) + "-node budget could not be observed, so the outcome was decided against the truncated view; ";
  }
  if (!context.escalated) return "";
  const applied = context.nodeBudget;
  const prior = context.priorBudget;
  if (applied !== null && prior !== null && applied === prior) {
    return "one bounded re-observation was taken at the driver maximum of " + String(applied) + " nodes \u2014 the same budget the prior observation applied, so no wider view exists from this driver; ";
  }
  if (applied !== null && prior !== null) {
    return "one bounded re-observation was taken, and the driver applied " + String(applied) + " nodes instead of the prior " + String(prior) + "; ";
  }
  if (applied !== null) {
    return "one bounded re-observation was taken, and the driver applied " + String(applied) + " nodes; ";
  }
  return "one bounded re-observation was taken, and the driver did not report the budget it applied; ";
}
function truncationAdvice(context) {
  if (hasReason(context.truncationReasons, "iframe-not-traversed")) {
    return "the driver reported iframe-not-traversed: part of the page lives in an iframe the driver does not traverse, so a node budget cannot help \u2014 narrow the page to the top-level document, or assert only against nodes the driver can return,";
  }
  if (hasReason(context.truncationReasons, "scan-window-exceeded")) {
    return "the driver reported scan-window-exceeded: the page has more selector matches than the driver's fixed scan window, so raising the node budget cannot help \u2014 narrow the page or scroll the target into a smaller view,";
  }
  if (context.escalated && context.nodeBudget !== null && context.priorBudget !== null && context.nodeBudget === context.priorBudget) {
    return "the re-observation applied the same " + String(context.nodeBudget) + "-node budget the driver already allowed (its maximum), so raising qa_observe max_nodes cannot help \u2014 narrow the page or region, or scroll the target into a smaller view,";
  }
  if (context.escalated) {
    return "the driver already applied the widest node budget it accepts and the view is still truncated, so raising qa_observe max_nodes cannot help \u2014 narrow the page or region, or scroll the target into a smaller view,";
  }
  return "raise the observation node budget (qa_observe max_nodes) or narrow the page,";
}
function scopeClause(scope) {
  if (scope === void 0) return "";
  return "the deciding view was scoped to the " + scope.role + ' named "' + scope.name + '"; ';
}
function describePredicate(predicate) {
  if (predicate === void 0) return "(no predicate)";
  const parts = [];
  if (predicate.role !== void 0) parts.push('role "' + predicate.role + '"');
  if (predicate.name !== void 0) parts.push('name "' + predicate.name + '"');
  if (predicate.tag !== void 0) parts.push('tag "' + predicate.tag + '"');
  return parts.length === 0 ? "(no fields)" : parts.join(", ");
}
function absencePassDetail(context) {
  const scope = context.scope === void 0 ? "the whole page" : "the " + context.scope.role + ' named "' + context.scope.name + '"';
  const probed = context.coverage?.probedNodes ?? 0;
  let detail = "No driver-observable semantic node matching " + describePredicate(context.predicate) + " was found within " + scope + "; coverage verified (" + String(probed) + " nodes probed).";
  if (context.hiddenMatches !== void 0) {
    detail += " " + String(context.hiddenMatches) + " hidden candidates excluded" + (context.hiddenMatchesPartial === true ? " (lower bound)" : "") + ".";
  }
  return detail;
}
function coverageClause(context) {
  const coverage = context.coverage;
  if (coverage === void 0) return "the driver reported no coverage evidence";
  if (coverage.reason === void 0) {
    return "the driver reported coverage verified:false with " + String(coverage.closedShadowRoots) + " closed shadow root(s) in the observed subtree";
  }
  return "the driver reported coverage verified:false with reason '" + coverage.reason + "'";
}
function completenessDetail(kind, predicate, deciding, truncated, nodeBudget, priorBudget, truncationReasons, scope, coverage, hiddenMatches, hiddenMatchesPartial, escalated, escalationFailed) {
  const context = {
    kind,
    predicate,
    deciding,
    truncated,
    nodeBudget,
    priorBudget,
    truncationReasons,
    scope,
    coverage,
    hiddenMatches,
    hiddenMatchesPartial,
    escalated,
    escalationFailed
  };
  const budget = budgetLabel(nodeBudget);
  const escalation = escalationClause(context);
  const scoped = scopeClause(scope);
  if (!readsNodes(kind)) {
    return "the observation was truncated at its " + budget + " budget, but this assertion reads the page URL only and does not depend on node completeness.";
  }
  if (kind === "node-absent" && deciding.passed) {
    return escalation + scoped + absencePassDetail(context);
  }
  if (deciding.inconclusive) {
    if (deciding.reason === QA_COVERAGE_UNVERIFIED) {
      return escalation + scoped + "no observable node matched the assertion, but the observation's boundaries (closed shadow roots, slot assignment) were not verified (" + coverageClause(context) + '), so the absence is UNPROVEN \u2014 not "not present". The driver must report coverage.verified:true (its bounded closed-shadow-root probe) before a node-absent assertion can pass.';
    }
    let coverageProbe = "";
    if (hasReason(truncationReasons, "closed-shadow-root")) {
      coverageProbe = " The coverage probe found a closed shadow root (reason 'closed-shadow-root') in the observed subtree \u2014 the content it renders is missing from the projection.";
    } else if (hasReason(truncationReasons, "shadow-coverage-unverified")) {
      coverageProbe = " The coverage probe did not run to completion (shadow-coverage-unverified; probe reason '" + (coverage?.reason === void 0 ? "none reported" : coverage.reason) + "'), so closed-shadow-root absence is unproven.";
    }
    return escalation + scoped + "the view was STILL truncated at its " + budget + ' budget, so "' + kind + '" cannot be proven from it: a matching node may exist outside the returned window' + (scope === void 0 ? "" : " of that container's subtree") + "." + coverageProbe + ' This is not "not present" \u2014 ' + truncationAdvice(context) + " then re-run.";
  }
  if (truncated) {
    return escalation + scoped + "the deciding view was truncated at its " + budget + " budget, but a matching node was RETURNED by it, and a returned node is sound evidence of presence even in an incomplete view.";
  }
  return escalation + scoped + "the deciding view was COMPLETE, so the outcome is proven against " + (scope === void 0 ? "the whole view." : "the whole subtree of that container.");
}
async function decideAssertion(assertion, observation, reobserve) {
  const first = evaluateAssertion(assertion, observation);
  if (!observation.truncated && observation.scope === void 0 && !first.inconclusive && assertion.kind !== "node-absent") {
    return {
      passed: first.passed,
      observed: first.observed,
      observation,
      completeness: null,
      ...first.reason === void 0 ? {} : { reason: first.reason }
    };
  }
  let deciding = observation;
  let evaluation = first;
  let escalated = false;
  let escalationFailed = false;
  const terminalAbsenceRead = assertion.kind === "node-absent" && first.inconclusive;
  if (first.inconclusive && (observation.truncated || terminalAbsenceRead)) {
    const withinRef = scopeRootRef(observation);
    if (observation.scope !== void 0 && withinRef === void 0) {
      escalationFailed = true;
    } else {
      const escalationOptions = {
        maxNodes: QA_ESCALATED_NODE_BUDGET,
        ...withinRef === void 0 ? {} : { withinRef },
        ...terminalAbsenceRead ? { verifyCoverage: true } : {}
      };
      try {
        const fuller = await reobserve(escalationOptions);
        deciding = fuller;
        evaluation = evaluateAssertion(assertion, fuller);
        escalated = true;
      } catch {
        escalationFailed = true;
      }
    }
  }
  const nodeBudget = deciding.maxNodes ?? null;
  const priorBudget = observation.maxNodes ?? null;
  const coverageUnverified = evaluation.inconclusive && evaluation.reason === QA_COVERAGE_UNVERIFIED;
  const predicate = assertion.kind === "node-absent" ? assertion.expected : void 0;
  const completeness = {
    truncated: deciding.truncated,
    nodeBudget,
    escalated,
    outcomeDependsOnCompleteView: evaluation.inconclusive && !coverageUnverified,
    ...deciding.scope === void 0 ? {} : { scope: { role: deciding.scope.role, name: deciding.scope.name } },
    ...deciding.truncationReasons === void 0 ? {} : { truncationReasons: deciding.truncationReasons },
    // Contract v9 gate diagnostics: the deciding view's hidden
    // semantic-selector candidates and the lower-bound marker, when the
    // driver reported them.
    ...deciding.hiddenMatches === void 0 ? {} : { hiddenMatches: deciding.hiddenMatches },
    ...deciding.hiddenMatchesPartial === void 0 ? {} : { hiddenMatchesPartial: deciding.hiddenMatchesPartial },
    // The deciding coverage evidence, reported exactly for ABSENCE decisions
    // (it is the gate that decides them); other kinds carry it only in prose.
    ...assertion.kind === "node-absent" && deciding.coverage !== void 0 ? { coverage: deciding.coverage } : {},
    ...evaluation.inconclusive ? { reason: coverageUnverified ? QA_COVERAGE_UNVERIFIED : QA_INCONCLUSIVE_TRUNCATED } : {},
    detail: completenessDetail(
      assertion.kind,
      predicate,
      evaluation,
      deciding.truncated,
      nodeBudget,
      priorBudget,
      deciding.truncationReasons,
      deciding.scope,
      deciding.coverage,
      deciding.hiddenMatches,
      deciding.hiddenMatchesPartial,
      escalated,
      escalationFailed
    )
  };
  return {
    passed: evaluation.passed,
    observed: evaluation.observed,
    observation: deciding,
    completeness,
    ...evaluation.reason === void 0 ? {} : { reason: evaluation.reason }
  };
}
var RETRIABLE_KINDS = /* @__PURE__ */ new Set(["node-present", "node-value", "node-in-viewport", "page-url"]);
var NON_RETRIABLE_REASONS = /* @__PURE__ */ new Set([
  QA_TARGET_NOT_UNIQUE,
  QA_VALUE_WITHHELD,
  QA_VALUE_SECURE,
  QA_VALUE_TRUNCATED
]);
async function decideAssertionWithRetry(assertion, observation, reobserve, budget) {
  const startedAt = Date.now();
  const currentBudget = () => typeof budget === "number" ? budget : budget.settlePolicy.budgetMs;
  const tryWiden = () => typeof budget === "number" ? null : budget.widenForRetry();
  let attempts = 1;
  let decision = await decideAssertion(assertion, observation, reobserve);
  if (decision.passed) return { ...decision, attempts, elapsedMs: Date.now() - startedAt, widened: null };
  if (!RETRIABLE_KINDS.has(assertion.kind)) {
    return { ...decision, attempts, elapsedMs: Date.now() - startedAt, widened: null };
  }
  if (decision.reason !== void 0 && NON_RETRIABLE_REASONS.has(decision.reason)) {
    return { ...decision, attempts, elapsedMs: Date.now() - startedAt, widened: null };
  }
  let widened = null;
  for (; ; ) {
    if (Date.now() - startedAt >= currentBudget()) {
      if (widened === null) {
        widened = tryWiden();
        if (widened !== null) continue;
      }
      break;
    }
    let next;
    const withinRef = scopeRootRef(decision.observation);
    if (decision.observation.scope !== void 0 && withinRef === void 0) {
      break;
    }
    try {
      next = await reobserve({
        maxNodes: QA_ESCALATED_NODE_BUDGET,
        ...withinRef === void 0 ? {} : { withinRef }
      });
    } catch {
      break;
    }
    attempts += 1;
    decision = await decideAssertion(assertion, next, reobserve);
    if (decision.passed) break;
    if (decision.reason !== void 0 && NON_RETRIABLE_REASONS.has(decision.reason)) break;
  }
  return { ...decision, attempts, elapsedMs: Date.now() - startedAt, widened };
}
function sessionReobserve(session) {
  return async (options) => {
    const settled = await session.observeSettled(options);
    if (!settled.stable) {
      throw new Error(
        "the budget-escalated observation never settled within the " + String(settled.budgetMs) + "ms settle budget"
      );
    }
    return settled.observation;
  };
}

// src/session/settle.ts
function normalizeObservableValue(raw) {
  return raw.slice(0, 720).replace(/\s+/gu, " ").trim().slice(0, 180);
}
var QA_SETTLE_BUDGET_MS = 2500;
var QA_SETTLE_ADAPTIVE_BUDGET_MS = 6e3;
var QA_SETTLE_QUIET_MS = 300;
var QA_SETTLE_POST_CHANGE_QUIET_MS = 2 * QA_SETTLE_QUIET_MS;
var QA_SETTLE_INTERVAL_MS = 50;
var BUDGET_MIN_MS = 20;
var BUDGET_MAX_MS = 6e4;
var QUIET_MIN_MS = 10;
var QUIET_MAX_MS = 1e4;
var INTERVAL_MIN_MS = 1;
var INTERVAL_MAX_MS = 1e3;
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function fromEnv(name2) {
  const raw = process.env[name2];
  if (raw === void 0 || raw.trim() === "") return void 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return void 0;
  return parsed;
}
function adaptiveEnvValue(name2) {
  const raw = process.env[name2];
  if (raw === void 0 || raw.trim() === "") return void 0;
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === "off") return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function resolveAdaptiveBudgetMs(explicit, budgetMs) {
  const raw = explicit !== void 0 ? explicit : adaptiveEnvValue("DSH_QA_SETTLE_ADAPTIVE_BUDGET_MS") ?? QA_SETTLE_ADAPTIVE_BUDGET_MS;
  if (raw === 0) return 0;
  if (!Number.isFinite(raw) || raw < 0) return QA_SETTLE_ADAPTIVE_BUDGET_MS;
  return clamp(raw, budgetMs, QA_SETTLE_SCHEMA_BUDGET_MAX);
}
function resolveSettlePolicy(options) {
  const budgetRaw = options?.budgetMs ?? fromEnv("DSH_QA_SETTLE_BUDGET_MS") ?? QA_SETTLE_BUDGET_MS;
  const quietRaw = options?.quietMs ?? fromEnv("DSH_QA_SETTLE_QUIET_MS") ?? QA_SETTLE_QUIET_MS;
  const intervalRaw = options?.intervalMs ?? fromEnv("DSH_QA_SETTLE_INTERVAL_MS") ?? QA_SETTLE_INTERVAL_MS;
  const budgetMs = clamp(Number.isFinite(budgetRaw) ? budgetRaw : QA_SETTLE_BUDGET_MS, BUDGET_MIN_MS, BUDGET_MAX_MS);
  const quietMs = Math.min(
    clamp(Number.isFinite(quietRaw) ? quietRaw : QA_SETTLE_QUIET_MS, QUIET_MIN_MS, QUIET_MAX_MS),
    budgetMs
  );
  const intervalMs = Math.min(
    clamp(Number.isFinite(intervalRaw) ? intervalRaw : QA_SETTLE_INTERVAL_MS, INTERVAL_MIN_MS, INTERVAL_MAX_MS),
    quietMs
  );
  const postChangeRaw = options?.postChangeQuietMs ?? fromEnv("DSH_QA_SETTLE_POST_CHANGE_QUIET_MS") ?? 2 * quietMs;
  const postChangeQuietMs = clamp(
    Number.isFinite(postChangeRaw) ? postChangeRaw : 2 * quietMs,
    quietMs,
    budgetMs
  );
  const adaptiveBudgetMs = resolveAdaptiveBudgetMs(options?.adaptiveBudgetMs, budgetMs);
  return { budgetMs, quietMs, postChangeQuietMs, intervalMs, adaptiveBudgetMs };
}
function clampOverrideValue(value, ceiling) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError("settle_budget_ms and settle_quiet_ms must be positive integers (milliseconds)");
  }
  return Math.min(value, ceiling);
}
function clampAdaptiveOverrideValue(value) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError("settle_adaptive_budget_ms must be a non-negative integer (milliseconds)");
  }
  return Math.min(value, QA_SETTLE_SCHEMA_BUDGET_MAX);
}
function settleStartOverride(args) {
  const budgetMs = args.settle_budget_ms === void 0 ? void 0 : clampOverrideValue(args.settle_budget_ms, QA_SETTLE_SCHEMA_BUDGET_MAX);
  const quietMs = args.settle_quiet_ms === void 0 ? void 0 : clampOverrideValue(args.settle_quiet_ms, budgetMs ?? QA_SETTLE_SCHEMA_BUDGET_MAX);
  const adaptiveBudgetMs = args.settle_adaptive_budget_ms === void 0 ? void 0 : clampAdaptiveOverrideValue(args.settle_adaptive_budget_ms);
  if (budgetMs === void 0 && quietMs === void 0 && adaptiveBudgetMs === void 0) return void 0;
  return {
    ...budgetMs === void 0 ? {} : { budgetMs },
    ...quietMs === void 0 ? {} : { quietMs },
    ...adaptiveBudgetMs === void 0 ? {} : { adaptiveBudgetMs }
  };
}
function matchesEchoPredicate(node, predicate) {
  if (predicate.role !== void 0 && node.role !== predicate.role) return false;
  if (predicate.name !== void 0 && node.name !== predicate.name) return false;
  if (predicate.tag !== void 0 && node.tag !== predicate.tag) return false;
  if (predicate.identifier !== void 0 && node.identifier !== predicate.identifier) return false;
  return true;
}
function isEchoMasked(node, echo, predicateMatchCount) {
  if (node.ref === echo.ref) return true;
  const matches = matchesEchoPredicate(node, echo.predicate);
  if (echo.value !== null) {
    const roleTag = echo.predicate.role !== void 0 && echo.predicate.tag !== void 0 && node.role === echo.predicate.role && node.tag === echo.predicate.tag || echo.predicate.identifier !== void 0 && node.identifier === echo.predicate.identifier;
    if (node.value === echo.value && (matches || roleTag)) return true;
    if (roleTag && node.name.includes(echo.value)) return true;
  }
  if (matches && predicateMatchCount === 1) return true;
  if (matches && (node.value === void 0 || node.value === null || node.value === "")) return true;
  return false;
}
function projectSemanticView(observation, echo) {
  const predicateMatchCount = echo === void 0 ? 0 : observation.nodes.reduce(
    (count, node) => count + (matchesEchoPredicate(node, echo.predicate) ? 1 : 0),
    0
  );
  return JSON.stringify({
    url: observation.page.url,
    title: observation.page.title,
    truncated: observation.truncated,
    app: observation.app === void 0 ? null : { bundleId: observation.app.bundleId, name: observation.app.name },
    window: observation.window === void 0 ? null : {
      role: observation.window.role,
      subrole: observation.window.subrole,
      title: observation.window.title,
      identity: observation.window.identity
    },
    mobile: observation.mobile === void 0 ? null : {
      deviceId: observation.mobile.deviceId,
      appId: observation.mobile.appId,
      kind: observation.mobile.kind,
      backend: observation.mobile.backend,
      verified: observation.mobile.verified
    },
    nodes: observation.nodes.map((node) => {
      const masked = echo !== void 0 && isEchoMasked(node, echo, predicateMatchCount);
      return [
        node.role,
        // The echo target's accessible NAME is masked together with its value:
        // a fill that rewrites the target's name as part of its own echo
        // ("Search" -> "Search: async") must not satisfy awaitChange through
        // the name drift either. The full (quiet-window) projection still
        // carries the real name, so the rename restarts the quiet window.
        masked ? null : node.name,
        node.tag,
        node.identifier ?? null,
        node.interactive,
        node.editable,
        node.disabled,
        node.href ?? null,
        node.inViewport ?? null,
        node.secure ?? null,
        masked ? null : node.value ?? null
      ];
    })
  });
}
function sleep(ms) {
  return new Promise((resolve2) => {
    setTimeout(resolve2, ms);
  });
}
async function observeUntilStable(observe, policy = resolveSettlePolicy(), options = {}, gate) {
  const awaitChange = options.awaitChange === true;
  const echo = options.echo;
  const startedAt = Date.now();
  let latest = await observe();
  let scopeNameChanged = latest.scope?.nameChanged === true;
  let projection = projectSemanticView(latest);
  let changedProjection = projectSemanticView(latest, echo);
  let unchangedSince = Date.now();
  let changed = options.baselineView !== void 0 && options.baselineView !== changedProjection;
  let passes = 1;
  let widened = null;
  for (; ; ) {
    const now = Date.now();
    const quietRequiredMs = changed ? policy.postChangeQuietMs : policy.quietMs;
    const quiet = now - unchangedSince >= quietRequiredMs;
    if (quiet && (changed || !awaitChange)) {
      return {
        observation: latest,
        stable: true,
        passes,
        elapsedMs: now - startedAt,
        budgetMs: policy.budgetMs,
        quietRequiredMs,
        widened,
        ...scopeNameChanged ? { scopeNameChanged } : {}
      };
    }
    const remaining = policy.budgetMs - (now - startedAt);
    if (remaining <= 0) {
      if (gate !== void 0 && !gate.widened && !quiet && policy.adaptiveBudgetMs > policy.budgetMs) {
        const fromMs = policy.budgetMs;
        const toMs = policy.adaptiveBudgetMs;
        policy.budgetMs = toMs;
        gate.widened = true;
        widened = { fromMs, toMs, cause: "unstable" };
        continue;
      }
      return {
        observation: latest,
        // Quiet at the deadline: the view is stable, it simply never moved.
        // Still moving at the deadline: honestly unstable.
        stable: quiet,
        passes,
        elapsedMs: now - startedAt,
        budgetMs: policy.budgetMs,
        quietRequiredMs,
        widened,
        ...scopeNameChanged ? { scopeNameChanged } : {}
      };
    }
    await sleep(Math.min(policy.intervalMs, remaining));
    const next = await observe();
    passes += 1;
    if (next.scope?.nameChanged === true) scopeNameChanged = true;
    const nextProjection = projectSemanticView(next);
    const nextChangedProjection = projectSemanticView(next, echo);
    if (nextChangedProjection !== changedProjection) {
      changedProjection = nextChangedProjection;
      changed = true;
    }
    if (nextProjection !== projection) {
      projection = nextProjection;
      unchangedSince = Date.now();
    }
    latest = next;
  }
}

// src/session/session.ts
function normalizeOwner(ownerId) {
  if (typeof ownerId !== "string" || ownerId.trim() === "") {
    throw new TypeError("owner id must be a non-empty string");
  }
  return ownerId.trim();
}
function actionEcho(action, before) {
  const valueWrite = action.kind === "fill" || action.kind === "type" || action.kind === "select";
  const keyLike = action.kind === "key" || action.kind === "press";
  if (!valueWrite && !keyLike) return null;
  if (before === null) return null;
  const node = before.nodes.find((candidate) => candidate.ref === action.ref);
  if (node === void 0) return null;
  if (node.role === "" && node.name === "" && node.tag === "" && node.identifier === void 0) return null;
  const value = valueWrite ? normalizeObservableValue(action.kind === "select" ? action.option : action.text) : null;
  return {
    predicate: {
      role: node.role,
      name: node.name,
      tag: node.tag,
      ...node.identifier === void 0 ? {} : { identifier: node.identifier }
    },
    ref: action.ref,
    // An empty written value is as good as unknowable: masking every empty
    // value-bearing node would be over-masking, so it degrades to the
    // unique-target rule.
    value: value === "" ? null : value
  };
}
function scrollProofNodeEquivalent(left, right) {
  return left.role === right.role && left.name === right.name && left.tag === right.tag && left.interactive === right.interactive && left.editable === right.editable && left.disabled === right.disabled && (left.href ?? null) === (right.href ?? null) && (left.inViewport ?? null) === (right.inViewport ?? null) && (left.secure ?? null) === (right.secure ?? null) && (left.identifier ?? null) === (right.identifier ?? null) && (left.value ?? null) === (right.value ?? null) && (left.valueWithheld ?? false) === (right.valueWithheld ?? false) && (left.valueTruncated ?? false) === (right.valueTruncated ?? false);
}
function scrollProofExtends(settled, escalated) {
  if (settled.page.url !== escalated.page.url) return false;
  if (settled.page.title !== escalated.page.title) return false;
  if (escalated.nodes.length < settled.nodes.length) return false;
  for (let index = 0; index < settled.nodes.length; index += 1) {
    const left = settled.nodes[index];
    const right = escalated.nodes[index];
    if (left === void 0 || right === void 0 || !scrollProofNodeEquivalent(left, right)) return false;
  }
  return true;
}
var QA_CONTAINER_ROLES = /* @__PURE__ */ new Set([
  "region",
  "main",
  "navigation",
  "list",
  "table",
  "form",
  "group",
  "complementary",
  "article",
  "section"
]);
function scrollProofContainer(baseline, targetIndex) {
  if (baseline === null) return void 0;
  const targetNode = baseline.nodes[targetIndex];
  if (targetNode === void 0) return void 0;
  const byRef = new Map(baseline.nodes.map((node) => [node.ref, node]));
  let current = targetNode;
  for (let hops = 0; hops < baseline.nodes.length; hops += 1) {
    const parentRef = typeof current.parentRef === "string" && current.parentRef !== "" ? current.parentRef : null;
    if (parentRef === null) return void 0;
    const parent = byRef.get(parentRef);
    if (parent === void 0) return void 0;
    if (QA_CONTAINER_ROLES.has(parent.role)) return parent;
    current = parent;
  }
  return void 0;
}
function scopedRootRefOf(observation) {
  const scope = observation.scope;
  if (scope === void 0) return void 0;
  const rootRef = scope.rootRef;
  return typeof rootRef === "string" && rootRef !== "" ? rootRef : void 0;
}
var QA_REFUSAL_CONTAINER_CODES = /* @__PURE__ */ new Set([
  "REF_INVALID",
  "REF_UNKNOWN",
  "REF_EXPIRED",
  "PAGE_CHANGED",
  "TARGET_CHANGED",
  "TARGET_DETACHED",
  "WITHIN_NOT_ELEMENT",
  "OBSERVATION_REQUIRED",
  "SCOPE_UNAVAILABLE"
]);
function scrollProofRefusalFromError(error, fallback) {
  const code = error.code;
  if (typeof code === "string" && code !== "") {
    if (code === "ANCHOR_UNAVAILABLE") return { code, reason: "anchor-unavailable" };
    if (QA_REFUSAL_CONTAINER_CODES.has(code)) return { code, reason: "container-not-in-view" };
    return { code, reason: fallback };
  }
  return { reason: fallback };
}
function scopedProofVerdict(observation) {
  const anchor = observation.anchor;
  const anchoredNode = anchor?.ref === null || anchor?.ref === void 0 ? void 0 : observation.nodes.find((candidate) => candidate.ref === anchor.ref);
  if (anchor === void 0) {
    return { accepted: false, refusal: { reason: "anchor-unavailable" } };
  }
  if (anchor.connected !== true) {
    return { accepted: false, refusal: { reason: "anchor-not-connected" } };
  }
  if (anchor.contained !== true) {
    return { accepted: false, refusal: { reason: "anchor-not-contained" } };
  }
  if (anchor.ref === null) {
    return { accepted: false, refusal: { reason: "anchor-unavailable" } };
  }
  if (anchoredNode === void 0 || anchoredNode.inViewport !== true) {
    return { accepted: false, refusal: { reason: "target-not-in-viewport" } };
  }
  return { accepted: true };
}
function settleReportOf(result) {
  return {
    stable: result.stable,
    passes: result.passes,
    elapsedMs: result.elapsedMs,
    budgetMs: result.budgetMs,
    quietRequiredMs: result.quietRequiredMs,
    widened: result.widened
  };
}
var QaSession = class {
  #adapter;
  #ownerId;
  #settle;
  /** Once-per-session widening gate: flips after the session's first widen. */
  #widenGate = { widened: false };
  /** Semantic projection of the last observed view (the settle baseline). */
  #lastView = null;
  /** The last raw observation, so an echo-masked baseline can be recomputed. */
  #lastObservation = null;
  #started = false;
  #stopped = false;
  #stopPromise = null;
  constructor(adapter, ownerId, options = {}) {
    this.#adapter = adapter;
    this.#ownerId = normalizeOwner(ownerId);
    this.#settle = resolveSettlePolicy(options.settle);
  }
  /** The resolved settle policy this session applies to every proof observation. */
  get settlePolicy() {
    return { ...this.#settle };
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
    this.#adapter.noteSettlePolicy?.(this.#ownerId, this.#settle);
    return info;
  }
  /** One raw observation. Callers proving an outcome must use observeSettled(). */
  async observe(options) {
    this.#assertStarted();
    const observation = await this.#adapter.observe(this.#ownerId, options);
    this.#lastView = projectSemanticView(observation);
    this.#lastObservation = observation;
    return observation;
  }
  /**
   * Observe until the semantic view is stable or the bounded budget is spent.
   * This is the ONE proof/verification observation used by both Explore export
   * and Replay, so the two sides never judge different views of the same page.
   */
  async observeSettled(options, settle) {
    this.#assertStarted();
    const verifyCoverage = options?.verifyCoverage === true;
    const pollOptions = { ...options ?? {} };
    if (verifyCoverage) delete pollOptions.verifyCoverage;
    let withinRef = options?.withinRef;
    const result = await observeUntilStable(
      async () => {
        const observation2 = await this.#adapter.observe(
          this.#ownerId,
          { ...pollOptions, ...withinRef === void 0 ? {} : { withinRef } }
        );
        if (withinRef !== void 0) {
          const rootRef = scopedRootRefOf(observation2);
          if (rootRef === void 0) {
            throw new Error(
              "the scoped observation carries no rootRef, so its scope root cannot be re-chained; re-observe and retry"
            );
          }
          withinRef = rootRef;
        }
        return observation2;
      },
      this.#settle,
      settle ?? {},
      this.#widenGate
    );
    let observation = result.observation;
    if (verifyCoverage && result.stable) {
      observation = await this.#adapter.observe(
        this.#ownerId,
        {
          ...pollOptions,
          verifyCoverage: true,
          ...withinRef === void 0 ? {} : { withinRef }
        }
      );
      if (observation.scope?.nameChanged === true) result.scopeNameChanged = true;
    }
    this.#lastView = projectSemanticView(observation);
    this.#lastObservation = observation;
    result.observation = observation;
    try {
      this.#adapter.noteSettle?.(this.#ownerId, {
        stable: result.stable,
        passes: result.passes,
        elapsedMs: result.elapsedMs,
        budgetMs: result.budgetMs,
        quietRequiredMs: result.quietRequiredMs,
        widened: result.widened
      });
      if (result.widened !== null) {
        this.#adapter.noteSettlePolicy?.(this.#ownerId, this.#settle);
      }
    } catch {
    }
    return result;
  }
  /**
   * One bounded settle window that is SIDE-EFFECT-FREE for the session: the
   * record-time scroll-proof escalation uses this instead of observeSettled,
   * so the proof re-read can never
   *
   *  - replace #lastView / #lastObservation (the baseline for the next
   *    action stays the action's own settled observation), or
   *  - widen the settle budget or flip the once-per-session gate (no widen
   *    gate is passed — a churning escalated window returns stable:false at
   *    budgetMs instead of mutating the policy; the policy object is also
   *    handed over as a shallow copy so no widening path could ever touch
   *    the session's), or
   *  - re-persist the policy via noteSettlePolicy.
   *
   * The passive noteSettle IS still emitted, so the Explore recorder records
   * the window's observations and can re-bind the accepted proof to the last
   * of them.
   */
  async #observeEscalated(options) {
    this.#assertStarted();
    let withinRef = options?.withinRef;
    const result = await observeUntilStable(
      async () => {
        const pollOptions = options ?? {};
        const observation = await this.#adapter.observe(
          this.#ownerId,
          { ...pollOptions, ...withinRef === void 0 ? {} : { withinRef } }
        );
        if (withinRef !== void 0) {
          const rootRef = scopedRootRefOf(observation);
          if (rootRef === void 0) {
            throw new Error(
              "the escalated scoped observation carries no rootRef, so its scope root cannot be re-chained; the proof re-read cannot continue"
            );
          }
          withinRef = rootRef;
        }
        return observation;
      },
      { ...this.#settle },
      {},
      void 0
    );
    try {
      this.#adapter.noteSettle?.(this.#ownerId, settleReportOf(result));
    } catch {
    }
    return result;
  }
  /**
   * Widen the settle budget for an assertion retry that exhausted its budget
   * without finding a positive-existence target. Uses the SAME once-per-session
   * gate as the unstable settle path, so a session widens at most once,
   * whichever path gets there first. Returns null when the gate already fired
   * or widening is inapplicable (adaptiveBudgetMs <= budgetMs).
   *
   * Mutates the session budget in place exactly like the unstable path and
   * re-persists the policy to the recorder, so export records the widened
   * budget into meta.settle.
   */
  widenForRetry() {
    if (this.#widenGate.widened) return null;
    if (this.#settle.adaptiveBudgetMs <= this.#settle.budgetMs) return null;
    const fromMs = this.#settle.budgetMs;
    const toMs = this.#settle.adaptiveBudgetMs;
    this.#settle.budgetMs = toMs;
    this.#widenGate.widened = true;
    try {
      this.#adapter.noteSettlePolicy?.(this.#ownerId, this.#settle);
    } catch {
    }
    return { fromMs, toMs, cause: "assertion-retry" };
  }
  async act(action, approval) {
    this.#assertStarted();
    const receipt = await this.#adapter.act(this.#ownerId, action, approval);
    if (receipt.status === "rejected" || receipt.status === "failed") {
      return { receipt, observation: null, outcome: "failed", evidence: [receipt], settle: null };
    }
    const baselineObservation = this.#lastObservation;
    const echo = actionEcho(action, baselineObservation);
    const baselineView = baselineObservation === null ? null : echo === null ? this.#lastView : projectSemanticView(baselineObservation, echo);
    const settleOptions = {
      awaitChange: true,
      ...baselineView === null ? {} : { baselineView },
      ...echo === null ? {} : { echo }
    };
    const recordingSession = typeof this.#adapter.noteEscalatedScrollProof === "function";
    const baselineScopeRootRef = !recordingSession || baselineObservation === null ? void 0 : scopedRootRefOf(baselineObservation);
    let scopedProofRefusal;
    let settled;
    if (baselineScopeRootRef !== void 0) {
      try {
        settled = await this.observeSettled({ withinRef: baselineScopeRootRef, anchorLastAction: true }, settleOptions);
      } catch (error) {
        scopedProofRefusal = scrollProofRefusalFromError(error, "container-not-in-view");
        if (typeof this.#adapter.noteScopedProofFallback === "function") {
          try {
            this.#adapter.noteScopedProofFallback(this.#ownerId, receipt.actionId ?? null);
          } catch {
          }
        }
        settled = await this.observeSettled(void 0, settleOptions);
      }
    } else {
      settled = await this.observeSettled(void 0, settleOptions);
    }
    const outcome = receipt.status === "confirmed" ? "ok" : "unknown";
    let proofObservation = settled.observation;
    let proofScope2;
    let anchor;
    let scopedProofAccepted = false;
    if (settled.stable && baselineScopeRootRef !== void 0 && proofObservation.scope !== void 0) {
      const verdict = scopedProofVerdict(proofObservation);
      if (verdict.accepted) {
        scopedProofAccepted = true;
        proofScope2 = { role: proofObservation.scope.role, name: proofObservation.scope.name };
        anchor = proofObservation.anchor;
      } else if (scopedProofRefusal === void 0) {
        scopedProofRefusal = verdict.refusal;
      }
    }
    let escalatedSettle = null;
    let escalationRefused;
    if (!scopedProofAccepted && settled.stable && proofObservation.truncated && typeof this.#adapter.noteEscalatedScrollProof === "function") {
      const escalated = await this.#escalateScrollProof(
        action,
        baselineObservation,
        proofObservation,
        receipt.actionId ?? null
      );
      if (escalated !== null) {
        if (escalated.accepted) {
          proofObservation = escalated.observation;
          escalatedSettle = escalated.settle;
          scopedProofRefusal = void 0;
        } else {
          escalationRefused = escalated.refusal;
        }
      }
    }
    if (escalationRefused === void 0) escalationRefused = scopedProofRefusal;
    const scopedProof = proofScope2 !== void 0 && anchor !== void 0 ? { proofScope: proofScope2, anchor } : null;
    if (escalationRefused !== void 0 && typeof this.#adapter.noteScrollProofRefusal === "function") {
      try {
        this.#adapter.noteScrollProofRefusal(this.#ownerId, receipt.actionId ?? null, escalationRefused);
      } catch {
      }
    }
    return {
      receipt,
      observation: proofObservation,
      outcome,
      evidence: [receipt],
      // The FIRST window's report; an accepted escalation's window rides in
      // escalatedSettle (see QaActResult) instead of shadowing this one.
      settle: settleReportOf(settled),
      ...escalatedSettle === null ? {} : { proofEscalated: true, escalatedSettle },
      ...scopedProof === null ? {} : scopedProof,
      ...escalationRefused === void 0 ? {} : { escalationRefused },
      // A confirmed/unknown receipt still describes a dispatch, but an unstable
      // proof window means the CONSEQUENCE is unproven: `outcome` stays honest
      // about the dispatch ('ok'/'unknown') while `proven: false` + the code
      // tell the caller nothing in the view can be attributed to the action.
      ...settled.stable ? {} : { proven: false, code: QA_INCONCLUSIVE_UNSTABLE }
    };
  }
  /**
   * ONE bounded escalation for a browser scroll-by-ref whose settled proof
   * view is truncated and still lacks the action target in the viewport.
   * Live evidence (Wikipedia History_of_China navbox): the target is deep in
   * composed-tree DOM order, so the default-budget window never returns it
   * even though the scroll placed it in the viewport — the exact gap the
   * live assertion path already closes with its own bounded re-observation
   * (replay/assertions.ts decideAssertion).
   *
   * B3 (contract v9, Phase B) — re-enables QA-BL-050 WITHOUT the retired
   * heuristic: the container is picked by ANCESTRY, walking the target's
   * parentRef chain in the BASELINE observation to the first node whose role
   * is a container role (region/main/navigation/list/table/form/group/
   * complementary/article/section), then re-keyed into the settled view by
   * its unique role+name+tag match. The escalated read is SCOPED to that
   * container and requests the driver's identity anchor (anchorLastAction).
   * IDENTITY COMES FROM THE ANCHOR, never from matching role/name/tag: the
   * read is accepted ONLY when its window settled AND the anchor reports the
   * ORIGINAL acted element connected, contained in the within subtree, and
   * emitted with a fresh ref whose node is in the viewport. No container on
   * the chain, an un-re-keyable container (zero or twin matches in the
   * settled view), and every refusal fall back to — or keep — the settled
   * observation; the WHOLE-PAGE escalation (QA-BL-045/047) runs when no
   * container applies, keeping its prefix-extension acceptance rule
   * (scrollProofExtends), which is meaningless across scopes for the scoped
   * form (the anchor replaces it there).
   *
   * The escalated read is taken SIDE-EFFECT-FREE (see #observeEscalated): it
   * never widens the session policy, never flips the widen gate, and never
   * replaces the session baseline, whether it is accepted or refused. On
   * acceptance the recording adapter is notified with the EXACT recorded
   * action id (carried on the receipt by the recording adapter) so it can
   * re-bind exactly this action's proof — a mismatch is refused by the
   * recorder and never silently re-bound. An unsettled window, a changed
   * page, a still-off-viewport target, or a missing pre-action target all
   * keep the settled observation — at most ONE escalation per action, no
   * loop, fail closed. QA-BL-058: an escalated read that THROWS (a driver
   * refusal such as ANCHOR_UNAVAILABLE / PAGE_CHANGED / REF_EXPIRED) — and a
   * scoped read whose anchor reports connected:false, contained:false, or a
   * null ref, or whose anchored node is not in the viewport — is DISCLOSED
   * through the returned `refusal` instead of being swallowed into a silent
   * null; the fail-closed outcome is unchanged, only the observability is
   * new.
   */
  async #escalateScrollProof(action, baselineObservation, settledObservation, actionId) {
    if (this.#adapter.kind !== "browser") return null;
    if (action.kind !== "scroll" || !("ref" in action)) return null;
    const targetIndex = baselineObservation?.nodes.findIndex((candidate) => candidate.ref === action.ref) ?? -1;
    const targetNode = targetIndex === -1 ? void 0 : baselineObservation?.nodes[targetIndex];
    if (targetNode === void 0) {
      return { accepted: false, refusal: { reason: "target-not-in-baseline" } };
    }
    const target = {
      role: targetNode.role,
      name: targetNode.name,
      tag: targetNode.tag,
      ...targetNode.identifier === void 0 ? {} : { identifier: targetNode.identifier }
    };
    const alreadyInViewport = settledObservation.nodes.some(
      (candidate) => matchesNode(candidate, target) && candidate.inViewport === true
    );
    if (alreadyInViewport) return null;
    const container = scrollProofContainer(baselineObservation, targetIndex);
    if (container !== void 0) {
      const predicate = {
        role: container.role,
        name: container.name,
        tag: container.tag,
        ...container.identifier === void 0 ? {} : { identifier: container.identifier }
      };
      const settledMatches = settledObservation.nodes.filter((candidate) => matchesNode(candidate, predicate));
      const containerRefInSettled = settledMatches.length === 1 ? settledMatches[0].ref : void 0;
      if (containerRefInSettled !== void 0) {
        return this.#escalateScopedScrollProof(containerRefInSettled, actionId);
      }
    }
    try {
      const escalated = await this.#observeEscalated({ maxNodes: QA_ESCALATED_NODE_BUDGET });
      if (!escalated.stable) {
        return { accepted: false, refusal: { reason: "escalated-window-unstable" } };
      }
      if (!scrollProofExtends(settledObservation, escalated.observation)) {
        return { accepted: false, refusal: { reason: "escalated-window-unstable" } };
      }
      const targetMatches = escalated.observation.nodes.filter((candidate) => matchesNode(candidate, target));
      if (targetMatches.length === 0) {
        return { accepted: false, refusal: { reason: "target-not-returned" } };
      }
      if (targetMatches.every((candidate) => candidate.inViewport !== true)) {
        return { accepted: false, refusal: { reason: "target-not-in-viewport" } };
      }
      try {
        this.#adapter.noteEscalatedScrollProof?.(this.#ownerId, actionId);
      } catch {
      }
      return { accepted: true, observation: escalated.observation, settle: settleReportOf(escalated) };
    } catch (error) {
      return { accepted: false, refusal: scrollProofRefusalFromError(error, "escalated-window-unstable") };
    }
  }
  /**
   * The ONE identity-anchored SCOPED escalated read (B3): observe within the
   * re-keyed container with anchorLastAction, and accept the read as the
   * action's proof ONLY when its window settled AND the driver's identity
   * anchor reports the ORIGINAL acted element connected, contained in the
   * within subtree, and emitted with a fresh ref whose node is in the
   * viewport. Identity comes from the anchor — the original handle the
   * driver dispatched the scroll on — never from matching role/name/tag.
   * Refusals (ANCHOR_UNAVAILABLE, connected:false, contained:false, a null
   * anchor ref, an off-viewport anchored node) are DISCLOSED as
   * escalationRefused and the proof stays the settled observation.
   */
  async #escalateScopedScrollProof(withinRef, actionId) {
    try {
      const escalated = await this.#observeEscalated({
        withinRef,
        anchorLastAction: true,
        maxNodes: QA_ESCALATED_NODE_BUDGET
      });
      if (!escalated.stable) {
        return { accepted: false, refusal: { reason: "escalated-window-unstable" } };
      }
      const anchor = escalated.observation.anchor;
      const anchoredNode = anchor?.ref === null || anchor?.ref === void 0 ? void 0 : escalated.observation.nodes.find((candidate) => candidate.ref === anchor.ref);
      let refusal;
      if (anchor === void 0) {
        refusal = { reason: "anchor-unavailable" };
      } else if (anchor.connected !== true) {
        refusal = { reason: "anchor-not-connected" };
      } else if (anchor.contained !== true) {
        refusal = { reason: "anchor-not-contained" };
      } else if (anchor.ref === null) {
        refusal = { reason: "anchor-unavailable" };
      } else if (anchoredNode === void 0 || anchoredNode.inViewport !== true) {
        refusal = { reason: "target-not-in-viewport" };
      }
      if (refusal !== void 0) {
        return { accepted: false, refusal };
      }
      try {
        this.#adapter.noteEscalatedScrollProof?.(this.#ownerId, actionId);
      } catch {
      }
      return { accepted: true, observation: escalated.observation, settle: settleReportOf(escalated) };
    } catch (error) {
      return { accepted: false, refusal: scrollProofRefusalFromError(error, "anchor-unavailable") };
    }
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
  #options;
  #disposed = false;
  constructor(adapter, options = {}) {
    this.#adapter = adapter;
    this.#options = options;
  }
  session(ownerId, options = {}) {
    if (this.#disposed) throw new Error("session manager is disposed");
    const owner = normalizeOwner(ownerId);
    let session = this.#sessions.get(owner);
    if (!session) {
      session = new QaSession(this.#adapter, owner, {
        ...this.#options,
        ...options,
        settle: { ...this.#options.settle ?? {}, ...options.settle ?? {} }
      });
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
  const pinned = session.kind === "computer" ? options?.observationId !== void 0 : options?.fingerprint !== void 0;
  if (pinned) return { capture: await session.visualObserve(options), settle: null };
  const settled = await session.observeSettled();
  const observation = settled.observation;
  const settle = { stable: settled.stable, passes: settled.passes, budgetMs: settled.budgetMs };
  if (session.kind === "computer") {
    const observationId = observation.observationId;
    if (observationId === void 0) {
      throw new Error("computer visual capture requires an observation id from the latest observation");
    }
    const capture2 = await session.visualObserve({ ...options ?? {}, observationId });
    return { capture: capture2, settle };
  }
  const capture = await session.visualObserve(options);
  return { capture, settle };
}

// src/index.ts
init_adapters();

// src/explore/export.ts
import { lstat, realpath, writeFile as writeFile2 } from "node:fs/promises";
import { tmpdir as tmpdir4 } from "node:os";
import { basename, dirname, isAbsolute, join as join5, relative, resolve } from "node:path";

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
var ANDROID_IDENTIFIER_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/u;
var ANDROID_RESOURCE_SEPARATOR = ":id/";
function androidResourceShape(value) {
  const marker = value.indexOf(ANDROID_RESOURCE_SEPARATOR);
  if (marker <= 0) return null;
  if (value.indexOf(ANDROID_RESOURCE_SEPARATOR, marker + 1) !== -1) return null;
  const pkg = value.slice(0, marker);
  const resource = value.slice(marker + ANDROID_RESOURCE_SEPARATOR.length);
  if (pkg === "" || resource === "") return null;
  if (pkg.includes("/") || resource.includes("/") || resource.includes(".")) return null;
  const packageSegments = pkg.split(".");
  for (const segment of packageSegments) {
    if (!ANDROID_IDENTIFIER_SEGMENT.test(segment)) return null;
  }
  if (!ANDROID_IDENTIFIER_SEGMENT.test(resource)) return null;
  return { pkg, resource, packageSegments };
}
function isAndroidResourceId(value) {
  const shape = androidResourceShape(value);
  if (shape === null) return false;
  for (const segment of shape.packageSegments) {
    if (isSensitiveKey(segment)) return false;
  }
  if (isSensitiveKey(shape.resource)) return false;
  return true;
}
function isRejectedAndroidResourceId(value) {
  const shape = androidResourceShape(value);
  if (shape === null) return false;
  for (const segment of shape.packageSegments) {
    if (isSensitiveKey(segment)) return true;
  }
  return isSensitiveKey(shape.resource);
}
function isStableIdentifierPosition(segments) {
  const last = segments[segments.length - 1];
  return last === "identifier" || last === "tag";
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
    if (isStableIdentifierPosition(segments)) {
      if (isAndroidResourceId(value)) {
        return value;
      }
      if (isRejectedAndroidResourceId(value)) {
        return "[REDACTED]";
      }
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

// src/replay/loader.ts
import { readFileSync } from "node:fs";
init_loginState();
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
function fail2(position, reason) {
  throw new ScenarioValidationError(position, reason);
}
function isPlainObject3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function expectObject(value, position) {
  if (!isPlainObject3(value)) fail2(position, "expected an object");
  return value;
}
function expectArray(value, position) {
  if (!Array.isArray(value)) fail2(position, "expected an array");
  return value;
}
function expectString(value, position) {
  if (typeof value !== "string") fail2(position, "expected a string");
  return value;
}
function expectNonEmptyString(value, position) {
  const s = expectString(value, position);
  if (s.trim() === "") fail2(position, "expected a non-empty string");
  return s;
}
function assertKnownFields(obj, allowed, position) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail2(position, "unexpected field");
  }
}
function assertLossless(value, position) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail2(position, "number is not lossless JSON (non-finite or negative zero)");
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
      if (child === void 0) fail2(position, "object contains a key with an undefined value");
      assertLossless(child, position);
    }
    return;
  }
  fail2(position, "value is not lossless JSON");
}
var DRIVER_KINDS = ["browser", "computer", "ios", "android"];
var ASSERTION_KINDS = ["node-present", "node-absent", "page-url", "node-in-viewport", "node-value"];
var ROOT_FIELDS = ["meta", "target", "steps", "assertions", "advisory"];
var META_FIELDS = ["name", "description", "driver", "createdAt", "notes", "settle"];
var SETTLE_OVERRIDE_FIELDS = ["budgetMs", "quietMs", "postChangeQuietMs", "intervalMs", "adaptiveBudgetMs"];
var TARGET_FIELDS = ["launch", "loginState", "windowTitle", "deviceId"];
var STEP_FIELDS = ["index", "intent", "action", "assert", "escalationRefused"];
var ASSERTION_FIELDS = ["kind", "expected", "description", "scope"];
var ASSERTION_SCOPE_FIELDS = ["role", "name", "tag", "path"];
var ASSERTION_SCOPE_PATH_ITEM_FIELDS = ["role", "name", "tag"];
var NODE_VALUE_EXPECTATION_FIELDS = ["role", "name", "tag", "identifier", "value"];
var VISUAL_ASSERTION_FIELDS = ["kind", "question", "description"];
var PREDICATE_FIELDS = ["role", "name", "tag", "roleHint", "identifier"];
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
  if (!isDriverKind(driver)) fail2(position + ".driver", "unsupported driver");
  const createdAt = expectNonEmptyString(obj.createdAt, position + ".createdAt");
  if (Number.isNaN(Date.parse(createdAt))) fail2(position + ".createdAt", "expected an ISO 8601 timestamp");
  let notes;
  if (obj.notes !== void 0) {
    notes = expectArray(obj.notes, position + ".notes").map(
      (item, i) => expectNonEmptyString(item, position + ".notes[" + i + "]")
    );
  }
  let settle;
  if (obj.settle !== void 0) settle = validateSettleOverride(obj.settle, position + ".settle");
  return {
    name: name2,
    description,
    driver,
    createdAt,
    ...notes === void 0 ? {} : { notes },
    ...settle === void 0 ? {} : { settle }
  };
}
function validateSettleMs(value, position, ceiling) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    fail2(position, "expected a positive integer number of milliseconds");
  }
  return Math.min(value, ceiling);
}
function validateSettleOverride(value, position) {
  const obj = expectObject(value, position);
  assertKnownFields(obj, SETTLE_OVERRIDE_FIELDS, position);
  const budgetMs = obj.budgetMs === void 0 ? void 0 : validateSettleMs(obj.budgetMs, position + ".budgetMs", QA_SETTLE_SCHEMA_BUDGET_MAX);
  const ceiling = budgetMs ?? QA_SETTLE_SCHEMA_BUDGET_MAX;
  const out = {};
  if (budgetMs !== void 0) out.budgetMs = budgetMs;
  if (obj.quietMs !== void 0) out.quietMs = validateSettleMs(obj.quietMs, position + ".quietMs", ceiling);
  if (obj.postChangeQuietMs !== void 0) {
    out.postChangeQuietMs = validateSettleMs(obj.postChangeQuietMs, position + ".postChangeQuietMs", ceiling);
  }
  if (obj.intervalMs !== void 0) out.intervalMs = validateSettleMs(obj.intervalMs, position + ".intervalMs", ceiling);
  if (obj.adaptiveBudgetMs !== void 0) {
    const adaptive = obj.adaptiveBudgetMs;
    if (typeof adaptive !== "number" || !Number.isFinite(adaptive) || !Number.isInteger(adaptive) || adaptive < 0) {
      fail2(position + ".adaptiveBudgetMs", "expected a non-negative integer number of milliseconds");
    }
    out.adaptiveBudgetMs = Math.min(adaptive, QA_SETTLE_SCHEMA_BUDGET_MAX);
  }
  return out;
}
function validateTarget(value, position, driver) {
  const obj = expectObject(value, position);
  assertKnownFields(obj, TARGET_FIELDS, position);
  const launch = expectNonEmptyString(obj.launch, position + ".launch");
  if (driver === "browser" && !isValidHttpUrl(launch)) {
    fail2(position + ".launch", "expected an http(s) URL");
  }
  let loginState;
  if (obj.loginState !== void 0) {
    if (driver !== "browser") fail2(position + ".loginState", "browser-only field");
    try {
      loginState = validateLoginStateConfig(obj.loginState, position + ".loginState");
    } catch (error) {
      if (error instanceof LoginStateError) fail2(position + ".loginState", error.message);
      throw error;
    }
  }
  let windowTitle;
  if (obj.windowTitle !== void 0) {
    if (driver !== "computer") fail2(position + ".windowTitle", "computer-only field");
    windowTitle = expectNonEmptyString(obj.windowTitle, position + ".windowTitle");
  }
  let deviceId;
  if (obj.deviceId !== void 0) {
    if (driver !== "ios" && driver !== "android") fail2(position + ".deviceId", "mobile-only field");
    deviceId = expectNonEmptyString(obj.deviceId, position + ".deviceId");
  }
  return {
    launch,
    ...loginState === void 0 ? {} : { loginState },
    ...windowTitle === void 0 ? {} : { windowTitle },
    ...deviceId === void 0 ? {} : { deviceId }
  };
}
function validatePredicate(value, position) {
  const obj = expectObject(value, position);
  assertKnownFields(obj, PREDICATE_FIELDS, position);
  const out = {};
  if (obj.role !== void 0) out.role = expectNonEmptyString(obj.role, position + ".role");
  if (obj.name !== void 0) out.name = expectNonEmptyString(obj.name, position + ".name");
  if (obj.tag !== void 0) out.tag = expectNonEmptyString(obj.tag, position + ".tag");
  if (obj.roleHint !== void 0) out.roleHint = expectNonEmptyString(obj.roleHint, position + ".roleHint");
  if (obj.identifier !== void 0) out.identifier = expectNonEmptyString(obj.identifier, position + ".identifier");
  if (out.role === void 0 && out.name === void 0 && out.tag === void 0 && out.identifier === void 0) {
    fail2(position, "expected at least one of role/name/tag/identifier");
  }
  return out;
}
function validateNodeValueExpectation(value, position) {
  const obj = expectObject(value, position);
  assertKnownFields(obj, NODE_VALUE_EXPECTATION_FIELDS, position);
  const out = {
    // An observed empty value is distinct from an absent/withheld value.
    value: expectString(obj.value, position + ".value")
  };
  if (obj.role !== void 0) out.role = expectNonEmptyString(obj.role, position + ".role");
  if (obj.name !== void 0) out.name = expectNonEmptyString(obj.name, position + ".name");
  if (obj.tag !== void 0) out.tag = expectNonEmptyString(obj.tag, position + ".tag");
  if (obj.identifier !== void 0) out.identifier = expectNonEmptyString(obj.identifier, position + ".identifier");
  if (out.role === void 0 && out.name === void 0 && out.tag === void 0 && out.identifier === void 0) {
    fail2(position, "expected at least one of role/name/tag/identifier");
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
      text: expectString(obj.text, position + ".text")
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
  if (kind === "focus") {
    assertKnownFields(obj, ["kind", "target"], position);
    return { kind: "focus", target: validatePredicate(obj.target, position + ".target") };
  }
  if (kind === "type") {
    assertKnownFields(obj, ["kind", "target", "text"], position);
    return {
      kind: "type",
      target: validatePredicate(obj.target, position + ".target"),
      text: expectNonEmptyString(obj.text, position + ".text")
    };
  }
  if (kind === "key") {
    assertKnownFields(obj, ["kind", "target", "key", "modifiers"], position);
    const modifiers = obj.modifiers === void 0 ? void 0 : expectArray(obj.modifiers, position + ".modifiers").map(
      (item, i) => expectNonEmptyString(item, position + ".modifiers[" + i + "]")
    );
    return {
      kind: "key",
      target: validatePredicate(obj.target, position + ".target"),
      key: expectNonEmptyString(obj.key, position + ".key"),
      ...modifiers === void 0 ? {} : { modifiers }
    };
  }
  if (kind === "navigate") {
    assertKnownFields(obj, ["kind", "url"], position);
    return { kind: "navigate", url: expectNonEmptyString(obj.url, position + ".url") };
  }
  if (kind === "scroll") {
    const hasTarget = obj.target !== void 0;
    const hasDirection = obj.direction !== void 0;
    if (!hasTarget && !hasDirection) {
      fail2(position, "scroll must specify a target (scroll-to-target or computer container scroll) and/or a direction (viewport scroll)");
    }
    if (hasTarget) {
      assertKnownFields(obj, ["kind", "target", "direction", "amount"], position);
      const target = validatePredicate(obj.target, position + ".target");
      const direction2 = obj.direction;
      const amount2 = obj.amount;
      if (direction2 === void 0) {
        if (amount2 !== void 0) fail2(position + ".amount", "amount requires direction");
        return { kind: "scroll", target };
      }
      if (direction2 !== "up" && direction2 !== "down") {
        fail2(position + ".direction", 'expected "up" or "down"');
      }
      const validatedAmount = amount2 === void 0 ? void 0 : validateScrollAmount(amount2, position + ".amount", true);
      return {
        kind: "scroll",
        target,
        direction: direction2,
        ...validatedAmount === void 0 ? {} : { amount: validatedAmount }
      };
    }
    assertKnownFields(obj, ["kind", "direction", "amount"], position);
    const direction = expectNonEmptyString(obj.direction, position + ".direction");
    if (direction !== "up" && direction !== "down") {
      fail2(position + ".direction", 'expected "up" or "down"');
    }
    const amount = validateScrollAmount(obj.amount, position + ".amount");
    return { kind: "scroll", direction, ...amount === void 0 ? {} : { amount } };
  }
  if (kind === "select") {
    assertKnownFields(obj, ["kind", "target", "option"], position);
    return {
      kind: "select",
      target: validatePredicate(obj.target, position + ".target"),
      option: expectNonEmptyString(obj.option, position + ".option")
    };
  }
  if (kind === "hover") {
    assertKnownFields(obj, ["kind", "target"], position);
    return { kind: "hover", target: validatePredicate(obj.target, position + ".target") };
  }
  if (kind === "visual_click") {
    assertKnownFields(obj, ["kind", "targetDescription", "provenance"], position);
    const out = {
      kind: "visual_click",
      targetDescription: expectNonEmptyString(obj.targetDescription, position + ".targetDescription")
    };
    if (obj.provenance !== void 0) out.provenance = validateVisualProvenance(obj.provenance, position + ".provenance");
    return out;
  }
  if (kind === "visual_drag") {
    assertKnownFields(obj, ["kind", "targetDescription", "toDescription", "provenance"], position);
    const out = {
      kind: "visual_drag",
      targetDescription: expectNonEmptyString(obj.targetDescription, position + ".targetDescription"),
      toDescription: expectNonEmptyString(obj.toDescription, position + ".toDescription")
    };
    if (obj.provenance !== void 0) out.provenance = validateVisualProvenance(obj.provenance, position + ".provenance");
    return out;
  }
  if (kind === "visual_scroll") {
    assertKnownFields(obj, ["kind", "targetDescription", "direction", "amount", "provenance"], position);
    const direction = obj.direction;
    if (direction !== "up" && direction !== "down") fail2(position + ".direction", 'expected "up" or "down"');
    const amount = obj.amount === void 0 ? void 0 : validateScrollAmount(obj.amount, position + ".amount", true);
    const out = {
      kind: "visual_scroll",
      targetDescription: expectNonEmptyString(obj.targetDescription, position + ".targetDescription"),
      direction,
      ...amount === void 0 ? {} : { amount }
    };
    if (obj.provenance !== void 0) out.provenance = validateVisualProvenance(obj.provenance, position + ".provenance");
    return out;
  }
  fail2(position + ".kind", "unsupported action kind");
}
function validateVisualProvenance(value, position) {
  const obj = expectObject(value, position);
  assertKnownFields(obj, ["source", "provider", "model", "confidence"], position);
  const source = obj.source;
  if (source !== "model-grounding" && source !== "harness-point" && source !== "replay-grounding") {
    fail2(position + ".source", "expected model-grounding, harness-point, or replay-grounding");
  }
  const out = {
    source
  };
  if (obj.provider !== void 0) out.provider = expectNonEmptyString(obj.provider, position + ".provider");
  if (obj.model !== void 0) out.model = expectNonEmptyString(obj.model, position + ".model");
  if (obj.confidence !== void 0) {
    const confidence = obj.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      fail2(position + ".confidence", "expected a number between 0 and 1");
    }
    out.confidence = confidence;
  }
  return out;
}
function validateScrollAmount(value, position, allowLine = false) {
  if (value === void 0) return void 0;
  if (value === "page") return "page";
  if (allowLine && value === "line") return "line";
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && !Object.is(value, -0)) {
    return value;
  }
  fail2(position, 'expected "page"' + (allowLine ? ', "line",' : "") + " or a finite non-negative number");
}
function validateScopePath(value, position) {
  const items = expectArray(value, position);
  if (items.length === 0) fail2(position, "expected at least one path item (an empty path proves nothing)");
  return items.map((item, index) => {
    const itemPosition = position + "[" + index + "]";
    const obj = expectObject(item, itemPosition);
    assertKnownFields(obj, ASSERTION_SCOPE_PATH_ITEM_FIELDS, itemPosition);
    const out = { role: expectNonEmptyString(obj.role, itemPosition + ".role") };
    if (obj.name !== void 0) {
      out.name = expectString(obj.name, itemPosition + ".name");
    }
    if (obj.tag !== void 0) {
      out.tag = expectNonEmptyString(obj.tag, itemPosition + ".tag");
    }
    return out;
  });
}
function validateAssertionScope(value, position) {
  const obj = expectObject(value, position);
  assertKnownFields(obj, ASSERTION_SCOPE_FIELDS, position);
  const role = expectNonEmptyString(obj.role, position + ".role");
  const name2 = expectString(obj.name, position + ".name");
  const out = { role, name: name2 };
  if (obj.tag !== void 0) {
    out.tag = expectNonEmptyString(obj.tag, position + ".tag");
  }
  if (obj.path !== void 0) {
    out.path = validateScopePath(obj.path, position + ".path");
  }
  return out;
}
function validateAssertion(value, position = "assertion") {
  const obj = expectObject(value, position);
  assertKnownFields(obj, ASSERTION_FIELDS, position);
  const rawKind = obj.kind;
  if (!isAssertionKind(rawKind)) fail2(position + ".kind", "unsupported assertion kind");
  const kind = rawKind;
  if (obj.expected === void 0) fail2(position + ".expected", "required");
  assertLossless(obj.expected, position + ".expected");
  if (kind === "node-present" || kind === "node-absent" || kind === "node-in-viewport") {
    validatePredicate(obj.expected, position + ".expected");
  } else if (kind === "node-value") {
    validateNodeValueExpectation(obj.expected, position + ".expected");
  } else {
    const expected = expectObject(obj.expected, position + ".expected");
    assertKnownFields(expected, ["url", "contains"], position + ".expected");
    const hasUrl = expected.url !== void 0;
    const hasContains = expected.contains !== void 0;
    if (hasUrl === hasContains) {
      fail2(position + ".expected", "expected exactly one of url or contains");
    }
    if (hasUrl) expectNonEmptyString(expected.url, position + ".expected.url");
    else expectNonEmptyString(expected.contains, position + ".expected.contains");
  }
  const out = { kind, expected: obj.expected };
  if (obj.description !== void 0) {
    out.description = expectNonEmptyString(obj.description, position + ".description");
  }
  if (obj.scope !== void 0) {
    out.scope = validateAssertionScope(obj.scope, position + ".scope");
  }
  return out;
}
function validateVisualAssertion(value, position = "advisory") {
  const obj = expectObject(value, position);
  assertKnownFields(obj, VISUAL_ASSERTION_FIELDS, position);
  if (obj.kind !== "visual") fail2(position + ".kind", 'expected kind "visual"');
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
    fail2(position + ".index", "expected a positive integer");
  }
  const intent = expectNonEmptyString(obj.intent, position + ".intent");
  const action = validateAction(obj.action, position + ".action");
  const assert = validateAssertion(obj.assert, position + ".assert");
  let escalationRefused;
  if (obj.escalationRefused !== void 0) {
    const refusal = expectObject(obj.escalationRefused, position + ".escalationRefused");
    assertKnownFields(refusal, ["reason", "code"], position + ".escalationRefused");
    escalationRefused = {
      reason: expectNonEmptyString(refusal.reason, position + ".escalationRefused.reason"),
      ...refusal.code === void 0 ? {} : { code: expectString(refusal.code, position + ".escalationRefused.code") }
    };
  }
  return { index: indexValue, intent, action, assert, ...escalationRefused === void 0 ? {} : { escalationRefused } };
}
function validateSteps(value, position) {
  const arr = expectArray(value, position);
  if (arr.length === 0) fail2(position, "expected at least one step");
  return arr.map((item, i) => {
    const step = validateStep(item, position + "[" + i + "]");
    if (step.index !== i + 1) {
      fail2(position + "[" + i + "].index", "expected the 1-based step index to match its position");
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
var RETRY_FIELDS = /* @__PURE__ */ new Set(["attempts", "elapsedMs", "targetChangedRetries", "message", "scopeIdentityRefusal"]);
function stripRetryFields(value) {
  if (Array.isArray(value)) return value.map(stripRetryFields);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (RETRY_FIELDS.has(key)) continue;
      out[key] = stripRetryFields(child);
    }
    return out;
  }
  return value;
}
function normalizeReportForDeterminism(report) {
  const record = report;
  const projected = {};
  for (const key of Object.keys(record)) {
    if (EXCLUDED_FIELDS.has(key)) continue;
    if (key === "startedAt" || key === "finishedAt") {
      projected[key] = FIXED_TIMESTAMP;
      continue;
    }
    if (key === "steps" || key === "assertions") {
      projected[key] = stripRetryFields(record[key]);
      continue;
    }
    projected[key] = record[key];
  }
  return projected;
}

// src/replay/runner.ts
import { tmpdir as tmpdir3 } from "node:os";
import { join as join4 } from "node:path";

// src/replay/drivers.ts
init_browser();
init_computer();
init_loadBrowser();
init_loadComputer();
init_loadAndroid();
init_loadIos();
async function loadMobileAdapter(kind) {
  const barrel = await Promise.resolve().then(() => (init_adapters(), adapters_exports));
  const exportName = kind === "ios" ? "IosAdapter" : "AndroidAdapter";
  const ctor = barrel[exportName];
  if (typeof ctor !== "function") {
    const missing = kind === "ios" ? missingIosDriverMessage : missingAndroidDriverMessage;
    throw new Error(missing(new Error(exportName + " is not exported by src/adapters/index.ts yet; the adapter worker must add it before mobile replay can run.")));
  }
  return ctor;
}
function scenarioStartOptions(scenario, launch, headless, deviceOverride) {
  if (scenario.meta.driver === "computer") {
    return {
      bundleId: launch,
      ...scenario.target.windowTitle === void 0 ? {} : { windowTitle: scenario.target.windowTitle }
    };
  }
  if (scenario.meta.driver === "ios") {
    return {
      bundleId: launch,
      ...deviceOverride === void 0 && scenario.target.deviceId === void 0 ? {} : { deviceId: deviceOverride ?? scenario.target.deviceId }
    };
  }
  if (scenario.meta.driver === "android") {
    return {
      packageName: launch,
      ...deviceOverride === void 0 && scenario.target.deviceId === void 0 ? {} : { deviceId: deviceOverride ?? scenario.target.deviceId }
    };
  }
  return {
    url: launch,
    ...headless === void 0 ? {} : { headless },
    ...scenario.target.loginState === void 0 ? {} : { loginState: scenario.target.loginState }
  };
}
async function loadReplayDriver(scenario, options = {}) {
  const loaders = options.loaders ?? {};
  if (scenario.meta.driver === "computer") {
    const load2 = loaders.computer ?? loadComputerDriver;
    const driver = await load2(COMPUTER_DRIVER_SPECIFIER);
    const adapter2 = new ComputerAdapter(driver);
    return { adapter: adapter2, dispose: () => driver.dispose() };
  }
  if (scenario.meta.driver === "ios") {
    const load2 = loaders.ios ?? loadIosBackend;
    const backend = await load2(IOS_DRIVER_SPECIFIER);
    const IosAdapter2 = await loadMobileAdapter("ios");
    const adapter2 = new IosAdapter2(backend);
    return { adapter: adapter2, dispose: () => backend.dispose() };
  }
  if (scenario.meta.driver === "android") {
    const load2 = loaders.android ?? loadAndroidBackend;
    const backend = await load2(ANDROID_DRIVER_SPECIFIER);
    const AndroidAdapter2 = await loadMobileAdapter("android");
    const adapter2 = new AndroidAdapter2(backend);
    return { adapter: adapter2, dispose: () => backend.dispose() };
  }
  const load = loaders.browser ?? loadBrowserManager;
  let origin;
  try {
    origin = new URL(scenario.target.launch).origin;
  } catch {
    origin = void 0;
  }
  const manager = await load(BROWSER_DRIVER_SPECIFIER, origin === void 0 ? void 0 : { allowedOrigins: [origin] });
  const adapter = new BrowserAdapter(manager);
  return { adapter, dispose: () => manager.dispose() };
}

// src/vision.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join as join3 } from "node:path";
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
  const failure2 = reason.failure;
  if (failure2 === null || typeof failure2 !== "object") return JSON.stringify(reason);
  const code = failure2.code;
  const message = failure2.message;
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
  const path2 = join3(capturesDir, "dsh-qa-visual-" + capture.sha256.slice(0, 16) + ".png");
  await writeFile(path2, capture.png);
  return path2;
}

// src/visual-grounding.ts
import { createHash as createHash3 } from "node:crypto";

// src/grounding.ts
var MAX_GROUNDING_REPLY_LENGTH = 4096;
var GROUNDING_MAX = 1e3;
var CONFIDENCE_MAX = 1;
var GROUNDING_ERR_INPUT_TOO_LARGE = "GROUNDING_INPUT_TOO_LARGE";
var GROUNDING_ERR_PARSE = "GROUNDING_PARSE";
var GROUNDING_ERR_SCHEMA = "GROUNDING_SCHEMA";
var GROUNDING_ERR_NON_FINITE = "GROUNDING_NON_FINITE";
var GROUNDING_ERR_OUT_OF_RANGE = "GROUNDING_OUT_OF_RANGE";
var GROUNDING_ERR_CAPTURE = "GROUNDING_CAPTURE_DIMENSIONS";
var GroundingError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "GroundingError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
function normalizeZero(value) {
  return Object.is(value, -0) ? 0 : value;
}
function stripSingleWholeFence(text) {
  const trimmed = text.trim();
  const open = /^(`{3,}|~{3,})/.exec(trimmed);
  const openFence = open?.[1];
  if (!openFence) return text;
  if (!trimmed.endsWith(openFence)) return text;
  const bare = trimmed.slice(openFence.length, trimmed.length - openFence.length);
  const firstNewline = bare.indexOf("\n");
  if (firstNewline !== -1) {
    const firstLine = bare.slice(0, firstNewline).trim();
    if (/^[A-Za-z0-9_+.-]*$/.test(firstLine)) {
      const body = bare.slice(firstLine.length).trim();
      return body;
    }
  }
  const inline2 = bare.trim().match(/^[A-Za-z0-9_+.-]*(?:[ \t]+)?([\s\S]*)$/);
  return (inline2?.[1] ?? bare).trim();
}
function isPlainObject4(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readNormalizedNumber(source, field, maxInclusive) {
  const value = source[field];
  if (typeof value !== "number") {
    throw new GroundingError(
      GROUNDING_ERR_SCHEMA,
      `grounding field "${field}" must be a JSON number`
    );
  }
  if (!Number.isFinite(value)) {
    throw new GroundingError(GROUNDING_ERR_NON_FINITE, `grounding field "${field}" must be finite`);
  }
  if (value < 0 || value > maxInclusive) {
    throw new GroundingError(
      GROUNDING_ERR_OUT_OF_RANGE,
      `grounding field "${field}" must be between 0 and ${maxInclusive} inclusive`
    );
  }
  return normalizeZero(value);
}
function requireNumber(record, field, errorCode) {
  if (!(field in record)) return void 0;
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GroundingError(errorCode, `point field "${field}" must be a finite number`);
  }
  return value;
}
function assertInRange(field, value, maxInclusive) {
  if (value < 0 || value > maxInclusive) {
    throw new GroundingError(
      GROUNDING_ERR_OUT_OF_RANGE,
      `point field "${field}" must be between 0 and ${maxInclusive} inclusive`
    );
  }
}
function validatePointLike(point) {
  if (!isPlainObject4(point)) {
    throw new GroundingError(GROUNDING_ERR_SCHEMA, "grounding point must be an object with x and y");
  }
  const xVal = requireNumber(point, "x", GROUNDING_ERR_SCHEMA);
  const yVal = requireNumber(point, "y", GROUNDING_ERR_SCHEMA);
  if (xVal === void 0) throw new GroundingError(GROUNDING_ERR_SCHEMA, 'grounding point is missing "x"');
  if (yVal === void 0) throw new GroundingError(GROUNDING_ERR_SCHEMA, 'grounding point is missing "y"');
  assertInRange("x", xVal, GROUNDING_MAX);
  assertInRange("y", yVal, GROUNDING_MAX);
  let confidence;
  if ("confidence" in point) {
    const confidenceVal = requireNumber(point, "confidence", GROUNDING_ERR_SCHEMA);
    if (confidenceVal === void 0 || !Number.isFinite(confidenceVal) || confidenceVal < 0 || confidenceVal > CONFIDENCE_MAX) {
      throw new GroundingError(
        GROUNDING_ERR_OUT_OF_RANGE,
        `point field "confidence" must be between 0 and ${CONFIDENCE_MAX} inclusive`
      );
    }
    confidence = normalizeZero(confidenceVal);
  }
  if (confidence === void 0) {
    return { x: normalizeZero(xVal), y: normalizeZero(yVal) };
  }
  return { x: normalizeZero(xVal), y: normalizeZero(yVal), confidence };
}
function validateCapture(trustedCapture) {
  if (!isPlainObject4(trustedCapture)) {
    throw new GroundingError(GROUNDING_ERR_CAPTURE, "trustedCapture must be an object with width and height");
  }
  const { width, height } = trustedCapture;
  for (const [name2, value] of [["width", width], ["height", height]]) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new GroundingError(GROUNDING_ERR_CAPTURE, `trustedCapture.${name2} must be a finite number`);
    }
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new GroundingError(
        GROUNDING_ERR_CAPTURE,
        `trustedCapture.${name2} must be a positive safe integer; got ${String(value)}`
      );
    }
  }
  return { width, height };
}
function parseGroundingReply(text) {
  if (typeof text !== "string") {
    throw new GroundingError(GROUNDING_ERR_PARSE, "parseGroundingReply expects a string input");
  }
  if (text.length > MAX_GROUNDING_REPLY_LENGTH) {
    throw new GroundingError(
      GROUNDING_ERR_INPUT_TOO_LARGE,
      `grounding reply exceeds ${MAX_GROUNDING_REPLY_LENGTH} characters; refusing to parse oversized input`
    );
  }
  const candidate = stripSingleWholeFence(text).trim();
  if (candidate === "") {
    throw new GroundingError(GROUNDING_ERR_PARSE, "grounding reply is empty after trimming");
  }
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new GroundingError(
      GROUNDING_ERR_PARSE,
      "grounding reply is not valid strict JSON (and no JSON was extracted from surrounding prose)"
    );
  }
  if (!isPlainObject4(parsed)) {
    throw new GroundingError(GROUNDING_ERR_SCHEMA, "grounding reply must be a JSON object, not array/null/primitive");
  }
  const keys = Object.keys(parsed).sort();
  const expected = ["confidence", "x", "y"];
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new GroundingError(
      GROUNDING_ERR_SCHEMA,
      `grounding reply must have exactly the three fields x, y, confidence; got ${JSON.stringify(Object.keys(parsed))}`
    );
  }
  const x = readNormalizedNumber(parsed, "x", GROUNDING_MAX);
  const y = readNormalizedNumber(parsed, "y", GROUNDING_MAX);
  const confidence = readNormalizedNumber(parsed, "confidence", CONFIDENCE_MAX);
  return { x, y, confidence };
}
function groundingToNativePoint(point, trustedCapture) {
  const normalized = validatePointLike(point);
  const { width, height } = validateCapture(trustedCapture);
  const nativeX = Math.round(normalized.x / GROUNDING_MAX * (width - 1));
  const nativeY = Math.round(normalized.y / GROUNDING_MAX * (height - 1));
  return { x: nativeX, y: nativeY };
}
function buildGroundingPrompt(targetDescription, instruction = "Return JSON.") {
  return `Look at the provided screenshot and find the exact center of: ${String(targetDescription).trim()}
Reply with exactly one JSON object and nothing else. The object must have exactly three fields: "x" and "y" are the normalized coordinates of that center from 0 to 1000 inclusive (0 is the left/top edge, 1000 is the right/bottom edge), and "confidence" is a number from 0 to 1 expressing how sure you are. Do not include an image size, nativepixel, imageWidth, or imageHeight field. Confidence does not prove the tap succeeded. ${instruction}`;
}

// src/visual-grounding.ts
var GROUNDING_SERVICE_DEFAULT_TIMEOUT_MS = 3e4;
var GROUNDING_SERVICE_MAX_REPLY_LENGTH = MAX_GROUNDING_REPLY_LENGTH;
var GROUNDING_FAILURE_SERVICES_UNAVAILABLE = "services-unavailable";
var GROUNDING_FAILURE_UNUSABLE_CAPTURE = "unusable-capture";
var GROUNDING_FAILURE_INVALID_PNG = "invalid-png";
var GROUNDING_FAILURE_DIMENSION_MISMATCH = "dimension-mismatch";
var GROUNDING_FAILURE_SHA_MISMATCH = "sha-mismatch";
var GROUNDING_FAILURE_IMAGE_PERSIST_FAILED = "image-persist-failed";
var GROUNDING_FAILURE_INVALID_IMAGE_REF = "invalid-image-ref";
var GROUNDING_FAILURE_PROVIDER_STREAM_ERROR = "provider-stream-error";
var GROUNDING_FAILURE_INVALID_MODEL_REPLY = "invalid-model-reply";
var GROUNDING_FAILURE_RESPONSE_TOO_LARGE = "response-too-large";
var GROUNDING_FAILURE_NO_TEXT = "no-text";
var GROUNDING_FAILURE_TIMEOUT = "timeout";
var GROUNDING_FAILURE_CANCELLED = "cancelled";
var PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function failure(reason) {
  return { ok: false, reason };
}
function isAborted(signal) {
  return signal?.aborted === true;
}
function readPngDimensions(bytes) {
  if (bytes.byteLength < 8) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  if (bytes.byteLength < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdrLength = view.getUint32(8, false);
  if (ihdrLength < 13) return null;
  if (bytes.byteLength < 16 + ihdrLength) return null;
  const type0 = bytes[12];
  const type1 = bytes[13];
  const type2 = bytes[14];
  const type3 = bytes[15];
  if (type0 !== 73 || type1 !== 72 || type2 !== 68 || type3 !== 82) return null;
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}
function isValidCaptureMetadata(capture) {
  if (!isRecord(capture)) return false;
  if (capture.usable !== true) return false;
  if (!(capture.png instanceof Uint8Array) || capture.png.byteLength === 0) return false;
  const { width, height, sha256, observationId } = capture;
  if (typeof width !== "number" || !Number.isSafeInteger(width) || width <= 0) return false;
  if (typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0) return false;
  if (typeof sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(sha256)) return false;
  if (observationId !== null && typeof observationId !== "string") return false;
  return true;
}
function captureFailureReason(capture) {
  if (!isRecord(capture)) return GROUNDING_FAILURE_UNUSABLE_CAPTURE;
  if (capture.usable !== true) return GROUNDING_FAILURE_UNUSABLE_CAPTURE;
  if (!(capture.png instanceof Uint8Array) || capture.png.byteLength === 0) return GROUNDING_FAILURE_INVALID_PNG;
  return GROUNDING_FAILURE_INVALID_PNG;
}
async function groundVisualTarget(targetDescription, capture, services, options = {}) {
  const attachments = services?.attachments;
  const llm = services?.llm;
  if (attachments === void 0 || llm === void 0 || typeof attachments.saveImage !== "function" || typeof llm.stream !== "function") {
    return failure(GROUNDING_FAILURE_SERVICES_UNAVAILABLE);
  }
  const callerSignal = options.signal;
  if (isAborted(callerSignal)) {
    return failure(GROUNDING_FAILURE_CANCELLED);
  }
  if (!isValidCaptureMetadata(capture)) {
    return failure(captureFailureReason(capture));
  }
  const dims = readPngDimensions(capture.png);
  if (dims === null) return failure(GROUNDING_FAILURE_INVALID_PNG);
  if (dims.width !== capture.width || dims.height !== capture.height) {
    return failure(GROUNDING_FAILURE_DIMENSION_MISMATCH);
  }
  const hash = createHash3("sha256").update(capture.png).digest("hex");
  if (hash !== capture.sha256.toLowerCase()) return failure(GROUNDING_FAILURE_SHA_MISMATCH);
  let saved;
  try {
    saved = await attachments.saveImage({
      data: capture.png,
      mediaType: "image/png",
      name: "dsh-qa-visual.png"
    });
  } catch {
    if (isAborted(callerSignal)) {
      return failure(GROUNDING_FAILURE_CANCELLED);
    }
    return failure(GROUNDING_FAILURE_IMAGE_PERSIST_FAILED);
  }
  if (isAborted(callerSignal)) {
    return failure(GROUNDING_FAILURE_CANCELLED);
  }
  let ref;
  try {
    ref = normalizeImageRef(saved);
  } catch {
    return failure(GROUNDING_FAILURE_INVALID_IMAGE_REF);
  }
  const provider = services?.provider ?? DEFAULT_VISION_PROVIDER;
  const model = services?.model ?? DEFAULT_VISION_MODEL;
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: buildGroundingPrompt(targetDescription) },
        { type: "image", attachment: ref }
      ]
    }
  ];
  const timeoutMs = options.timeoutMs === void 0 ? GROUNDING_SERVICE_DEFAULT_TIMEOUT_MS : Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : GROUNDING_SERVICE_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => {
    controller.abort(new DOMException("The grounding caller aborted the request", "AbortError"));
  };
  if (callerSignal !== void 0) {
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Grounding provider timed out", "AbortError"));
  }, timeoutMs);
  let text = "";
  try {
    const stream = llm.stream({ provider, model, messages, signal: controller.signal });
    for await (const raw of stream) {
      if (controller.signal.aborted) {
        return timedOut ? failure(GROUNDING_FAILURE_TIMEOUT) : failure(GROUNDING_FAILURE_CANCELLED);
      }
      const chunk = raw;
      if (chunk.type === "text-delta" && typeof chunk.text === "string") {
        text += chunk.text;
        if (text.length > GROUNDING_SERVICE_MAX_REPLY_LENGTH) {
          controller.abort(new DOMException("Grounding provider response is too large", "AbortError"));
          return failure(GROUNDING_FAILURE_RESPONSE_TOO_LARGE);
        }
      } else if (chunk.type === "finish" && chunk.reason !== void 0) {
        const reason = chunk.reason;
        if (reason.kind === "error") {
          if (controller.signal.aborted) {
            return timedOut ? failure(GROUNDING_FAILURE_TIMEOUT) : failure(GROUNDING_FAILURE_CANCELLED);
          }
          return failure(GROUNDING_FAILURE_PROVIDER_STREAM_ERROR);
        }
        if (reason.kind === "aborted") {
          if (controller.signal.aborted) {
            return timedOut ? failure(GROUNDING_FAILURE_TIMEOUT) : failure(GROUNDING_FAILURE_CANCELLED);
          }
          return failure(GROUNDING_FAILURE_PROVIDER_STREAM_ERROR);
        }
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      return timedOut ? failure(GROUNDING_FAILURE_TIMEOUT) : failure(GROUNDING_FAILURE_CANCELLED);
    }
    void error;
    return failure(GROUNDING_FAILURE_PROVIDER_STREAM_ERROR);
  } finally {
    clearTimeout(timer);
    if (callerSignal !== void 0) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }
  if (controller.signal.aborted) {
    return timedOut ? failure(GROUNDING_FAILURE_TIMEOUT) : failure(GROUNDING_FAILURE_CANCELLED);
  }
  if (text.trim() === "") {
    return failure(GROUNDING_FAILURE_NO_TEXT);
  }
  let parsed;
  try {
    parsed = parseGroundingReply(text);
  } catch {
    return failure(GROUNDING_FAILURE_INVALID_MODEL_REPLY);
  }
  const nativePoint = groundingToNativePoint(parsed, { width: capture.width, height: capture.height });
  return {
    ok: true,
    normalized: parsed,
    nativePoint,
    confidence: parsed.confidence,
    provider,
    model,
    captureSha: capture.sha256,
    observationId: capture.observationId
  };
}

// src/visual-action.ts
var HEX64 = /^[a-fA-F0-9]{64}$/u;
function isPlainObject5(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function imagePoint(value, label, width, height) {
  if (!isPlainObject5(value)) {
    throw new Error("qa_act visual " + label + " must be an object with numeric x and y");
  }
  const x = value.x;
  const y = value.y;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("qa_act visual " + label + " must carry finite numeric x and y");
  }
  if (x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error("qa_act visual " + label + " is outside the delivered image bounds; the visual action was not dispatched");
  }
  return { x, y };
}
function imageToNativePoint(point, metadata, label) {
  const sourceWidth = metadata.attachmentWidth ?? metadata.pixelWidth;
  const sourceHeight = metadata.attachmentHeight ?? metadata.pixelHeight;
  const validated = imagePoint(point, label, sourceWidth, sourceHeight);
  const scaleX = sourceWidth / metadata.pixelWidth;
  const scaleY = sourceHeight / metadata.pixelHeight;
  const native = {
    x: Math.round(validated.x / scaleX),
    y: Math.round(validated.y / scaleY)
  };
  if (!Number.isSafeInteger(native.x) || !Number.isSafeInteger(native.y) || native.x < 0 || native.y < 0 || native.x >= metadata.pixelWidth || native.y >= metadata.pixelHeight) {
    throw new Error("qa_act visual " + label + " maps outside the native captured window bounds; the visual action was not dispatched");
  }
  return native;
}
function buildVisualRuntimeAction(op, capture, targetDescription, nativePoint, options = {}) {
  if (capture.observationId === null || capture.observationId === "") {
    throw new Error("qa_act visual action requires a computer capture with a non-empty observationId");
  }
  return buildVisualRuntimeActionFromMetadata(op, {
    sha256: capture.sha256,
    observationId: capture.observationId,
    pixelWidth: capture.width,
    pixelHeight: capture.height
  }, targetDescription, nativePoint, options);
}
function buildVisualRuntimeActionFromMetadata(op, metadata, targetDescription, nativePoint, options = {}) {
  const observationId = metadata.observationId;
  if (observationId === "") {
    throw new Error("qa_act visual action requires a computer capture with a non-empty observationId");
  }
  const base = {
    targetDescription,
    observationId,
    captureSha256: metadata.sha256,
    point: nativePoint,
    ...options.provenance === void 0 ? {} : { grounding: options.provenance }
  };
  if (op === "click") return { kind: "visual_click", ...base };
  if (op === "drag") {
    if (options.nativeTo === void 0 || options.toDescription === void 0) {
      throw new Error("qa_act visual drag requires a destination description and point");
    }
    return {
      kind: "visual_drag",
      ...base,
      toDescription: options.toDescription,
      to: options.nativeTo
    };
  }
  if (options.direction === void 0) {
    throw new Error("qa_act visual scroll requires direction");
  }
  return {
    kind: "visual_scroll",
    ...base,
    direction: options.direction,
    ...options.amount === void 0 ? {} : { amount: options.amount }
  };
}
function validateVisualToolArgs(value) {
  if (!isPlainObject5(value)) throw new Error("qa_act visual arguments must be an object");
  const actionValue = value.action;
  const opValue = value.op;
  let op;
  if (opValue === "click" || opValue === "drag" || opValue === "scroll") {
    op = opValue;
  } else if (actionValue === "visual_click" || actionValue === "visual_drag" || actionValue === "visual_scroll") {
    op = actionValue.slice("visual_".length);
  } else {
    throw new Error("qa_act visual op must be click, drag, or scroll");
  }
  const targetDescription = value.target_description;
  if (typeof targetDescription !== "string" || targetDescription.trim() === "") {
    throw new Error("qa_act visual action requires a non-empty target_description");
  }
  let direction;
  if (op === "scroll") {
    if (value.direction !== "up" && value.direction !== "down") {
      throw new Error('qa_act visual scroll requires direction "up" or "down"');
    }
    direction = value.direction;
  }
  let amount;
  if (value.amount !== void 0) {
    if (value.amount !== "line" && value.amount !== "page" && (typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount <= 0)) {
      throw new Error("qa_act visual amount must be line, page, or a positive number");
    }
    amount = value.amount;
  }
  const toDescription = value.to_description;
  if (op === "drag" && (typeof toDescription !== "string" || toDescription.trim() === "")) {
    throw new Error("qa_act visual drag requires a non-empty to_description");
  }
  const point = value.point;
  const to = value.to;
  const observationId = value.observation_id;
  const captureSha256 = value.capture_sha256;
  const trimmedToDescription = typeof toDescription === "string" && toDescription.trim() !== "" ? toDescription.trim() : void 0;
  return {
    op,
    targetDescription: targetDescription.trim(),
    ...trimmedToDescription === void 0 ? {} : { toDescription: trimmedToDescription },
    ...direction === void 0 ? {} : { direction },
    ...amount === void 0 ? {} : { amount },
    ...isPlainObject5(point) ? { point } : {},
    ...isPlainObject5(to) ? { to } : {},
    ...typeof observationId === "string" && observationId !== "" ? { observationId } : {},
    ...typeof captureSha256 === "string" && HEX64.test(captureSha256) ? { captureSha256 } : {}
  };
}
function requireVisualPointBinding(args, metadata) {
  if (args.point === void 0) {
    throw new Error("qa_act visual point route requires point for the supplied capture");
  }
  const point = imageToNativePoint(args.point, metadata, "point");
  if (args.to === void 0) return { point };
  return { point, to: imageToNativePoint(args.to, metadata, "to") };
}
function visualCaptureMetadata(capture) {
  if (capture.observationId === null || capture.observationId === "") {
    throw new Error("visual capture is not bound to a computer observation; cannot use it for visual action routing");
  }
  return {
    sha256: capture.sha256,
    observationId: capture.observationId,
    pixelWidth: capture.width,
    pixelHeight: capture.height
  };
}
var QaVisualCaptureStore = class {
  #metadata = /* @__PURE__ */ new Map();
  put(metadata) {
    this.#metadata.set(metadata.sha256.toLowerCase(), metadata);
  }
  get(sha256) {
    return this.#metadata.get(sha256.toLowerCase());
  }
  has(sha256) {
    return this.get(sha256) !== void 0;
  }
  clear() {
    this.#metadata.clear();
  }
};
async function captureAndGroundVisualTarget(session, targetDescription, services, signal) {
  const { capture } = await captureLatestVisual(session);
  const result = await groundVisualTarget(
    targetDescription,
    capture,
    services,
    signal === void 0 ? {} : { signal }
  );
  if (!result.ok) {
    throw new Error("qa_act visual grounding failed: " + result.reason);
  }
  return {
    capture,
    nativePoint: result.nativePoint,
    grounding: {
      source: "model-grounding",
      ...result.provider === "" ? {} : { provider: result.provider },
      ...result.model === "" ? {} : { model: result.model },
      ...result.confidence === void 0 ? {} : { confidence: result.confidence }
    }
  };
}
function approvalGateFromHost(host, exec, toolName) {
  const callId = exec.callId;
  if (typeof callId !== "string" || callId === "") return void 0;
  const raw = host.getService?.("approval");
  const service = raw;
  if (service === void 0 || typeof service.request !== "function") return void 0;
  const agent = exec.agent;
  return {
    async request(reason) {
      try {
        const outcome = await service.request({
          agent,
          toolName,
          callId,
          reason,
          ...exec.signal === void 0 ? {} : { signal: exec.signal }
        });
        if (outcome === "allowed-once" || outcome === "rejected" || outcome === "cancelled" || outcome === "unavailable") {
          return outcome;
        }
        return "unavailable";
      } catch {
        return "unavailable";
      }
    }
  };
}
function assertCaptureBinding(metadata, observationId) {
  if (metadata.observationId !== observationId) {
    throw new Error("qa_act visual capture_sha256 is not bound to observation_id " + observationId + "; run qa_evidence visual again for the current observation");
  }
}

// src/replay/runner.ts
function unsettledMessage(what, budgetMs) {
  return "the " + what + " observation never settled within the " + String(budgetMs) + "ms settle budget";
}
function identityExhaustionMessage(subject, between, retries, widened) {
  return subject + " kept changing identity" + (between === void 0 ? "" : " " + between) + " for the whole settle budget (" + String(retries) + " retries): the page did not hold still, so the step is unproven" + (widened === null ? "" : " \u2014 the settle budget was widened once from " + String(widened.fromMs) + " to " + String(widened.toMs) + "ms and still exhausted");
}
async function runBoundedIdentityRetry(session, account, attempt, opts) {
  const startedAt = Date.now();
  for (; ; ) {
    const outcome = await attempt();
    if (outcome.ok || outcome.refusal.code !== "TARGET_CHANGED") return outcome;
    account.retries += 1;
    account.lastRefusal = outcome.refusal;
    if (Date.now() - startedAt >= session.settlePolicy.budgetMs) {
      if (account.widened === null) {
        const widened = session.widenForRetry();
        if (widened !== null) {
          account.widened = widened;
          opts.onWidened?.(widened);
        } else {
          account.exhausted = identityExhaustionMessage(opts.subject, opts.between, account.retries, account.widened);
          return { exhausted: true };
        }
      } else {
        account.exhausted = identityExhaustionMessage(opts.subject, opts.between, account.retries, account.widened);
        return { exhausted: true };
      }
    }
    const prepareMessage = await opts.prepare();
    if (prepareMessage !== null) {
      account.exhausted = prepareMessage;
      return { exhausted: true };
    }
  }
}
function refusalDetailOf(error) {
  const record = error;
  return {
    code: typeof record.code === "string" ? record.code : "TARGET_CHANGED",
    ...error instanceof Error && error.message !== "" ? { reason: error.message } : {},
    ...record.changed === void 0 ? {} : { changed: record.changed },
    ...record.before === void 0 ? {} : { before: record.before },
    ...record.after === void 0 ? {} : { after: record.after }
  };
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
var QaCodeError2 = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "QaCodeError";
    this.code = code;
  }
};
function failureCodeFor(error) {
  if (error instanceof QaCodeError2) return error.code;
  if (error instanceof Error) {
    const code = error.code;
    if (typeof code === "string" && code !== "") return code;
  }
  return void 0;
}
function describeTarget(target) {
  const parts = [];
  if (target.role !== void 0) parts.push('role "' + target.role + '"');
  if (target.name !== void 0) parts.push('name "' + target.name + '"');
  if (target.tag !== void 0) parts.push('tag "' + target.tag + '"');
  if (target.identifier !== void 0) parts.push('identifier "' + target.identifier + '"');
  return parts.length === 0 ? "no fields" : parts.join(", ");
}
function scopePredicate(scope) {
  return { role: scope.role, name: scope.name, ...scope.tag === void 0 ? {} : { tag: scope.tag } };
}
function describeScope(scope) {
  const parts = ['role "' + scope.role + '"', 'name "' + scope.name + '"'];
  if (scope.tag !== void 0) parts.push('tag "' + scope.tag + '"');
  return parts.join(", ");
}
function levelSummary(levels) {
  return levels.map((level) => "level " + String(level.level) + " (" + level.what + "): " + level.resolution).join("; ");
}
function scopeNotLocatedMessage(levels, escalated, view) {
  const applied = escalated ? view.maxNodes === void 0 ? "the escalated budget (the driver did not report the budget it applied)" : "the applied " + String(view.maxNodes) + "-node escalated budget" : "the driver-default budget";
  const failedLevel = levels[levels.length - 1];
  const atLevel = failedLevel === void 0 ? "" : " (level " + String(failedLevel.level) + ": " + failedLevel.what + ")";
  return "the container could not be located in the truncated view; it may exist outside the returned window" + atLevel + " \u2014 the view was still truncated at " + applied + " (" + QA_INCONCLUSIVE_TRUNCATED + ")";
}
function pathItemPredicate(item) {
  return {
    role: item.role,
    ...item.name === void 0 ? {} : { name: item.name },
    ...item.tag === void 0 ? {} : { tag: item.tag }
  };
}
function describePathItem(item) {
  const parts = ['role "' + item.role + '"'];
  if (item.name !== void 0) parts.push('name "' + item.name + '"');
  if (item.tag !== void 0) parts.push('tag "' + item.tag + '"');
  return parts.join(", ");
}
var ScopeNotLocatedError = class extends Error {
  scopeNotLocated = true;
  levels;
  escalated;
  view;
  constructor(levels, escalated, view) {
    super(scopeNotLocatedMessage(levels, escalated, view));
    this.name = "ScopeNotLocatedError";
    this.levels = levels;
    this.escalated = escalated;
    this.view = view;
  }
};
var ScopeIdentityExhaustedError = class extends Error {
  scopeIdentityExhausted = true;
  levels;
  escalated;
  view;
  refusal;
  retries;
  nameChanged;
  constructor(levels, escalated, nameChanged, view, refusal, message, retries) {
    super(message);
    this.name = "ScopeIdentityExhaustedError";
    this.levels = levels;
    this.escalated = escalated;
    this.nameChanged = nameChanged;
    this.view = view;
    this.refusal = refusal;
    this.retries = retries;
  }
};
async function observeScopeView(scope, wholePage, session, reobserve, options = {}) {
  const path2 = scope.path;
  const levels = [];
  let escalated = false;
  let view = wholePage;
  let scopeNameChanged = false;
  const resolveLevel = async (predicate, level, what, escalate, flat = false) => {
    let matches = view.nodes.filter((node) => matchesNode(node, predicate));
    if (escalate && view.truncated && matches.length <= 1) {
      try {
        view = await reobserve({ maxNodes: QA_ESCALATED_NODE_BUDGET });
        escalated = true;
        matches = view.nodes.filter((node) => matchesNode(node, predicate));
      } catch {
      }
    }
    for (let i = levels.length - 1; i >= 0; i -= 1) {
      if (levels[i]?.level === level) levels.splice(i, 1);
    }
    if (matches.length === 0) {
      levels.push({ level, what, resolution: "not-located" });
      return { zero: true, truncated: view.truncated };
    }
    if (matches.length > 1) {
      throw new QaCodeError2(
        QA_TARGET_NOT_UNIQUE,
        flat ? QA_TARGET_NOT_UNIQUE + ": " + String(matches.length) + " nodes match the assertion scope (" + describeScope(scope) + "); the scoped container is not uniquely identifiable, so the assertion was not decided" : QA_TARGET_NOT_UNIQUE + ": " + String(matches.length) + " nodes match path level " + String(level) + " (" + what + "), so the recorded ancestor path is ambiguous and the scoped container was not decided"
      );
    }
    levels.push({ level, what, resolution: view.truncated ? "provisional" : "proven" });
    const only = matches[0];
    if (only === void 0) {
      throw new Error("no observable node matches the assertion scope");
    }
    return { node: only };
  };
  const notLocated = () => ({ kind: "not-located", view, escalated, levels });
  const widenParent = async () => {
    if (!view.truncated) return;
    const rootRef = scopeRootRef(view);
    if (rootRef === void 0) return;
    try {
      view = await reobserve({ maxNodes: QA_ESCALATED_NODE_BUDGET, withinRef: rootRef });
      escalated = true;
    } catch {
    }
  };
  const observeLevel = async (predicate, level, what, escalate, flat = false, withinOptions = {}, subject = "path level " + String(level) + " (" + what + ")") => {
    const account = options.identity ?? { retries: 0, widened: null, lastRefusal: null, exhausted: null };
    const outcome = await runBoundedIdentityRetry(
      session,
      account,
      async () => {
        const resolved = await resolveLevel(predicate, level, what, escalate, flat);
        if ("zero" in resolved) return { ok: true, value: { zero: true, truncated: resolved.truncated } };
        try {
          const settled = await session.observeSettled({
            withinRef: resolved.node.ref,
            ...withinOptions
          });
          if (!settled.stable) {
            throw new Error(unsettledMessage("scoped", settled.budgetMs));
          }
          if (settled.scopeNameChanged === true) scopeNameChanged = true;
          return { ok: true, value: { settled } };
        } catch (error) {
          if (failureCodeFor(error) === "TARGET_CHANGED") {
            return { ok: false, refusal: refusalDetailOf(error) };
          }
          throw error;
        }
      },
      {
        subject,
        ...options.onSettleWidened === void 0 ? {} : { onWidened: options.onSettleWidened },
        prepare: async () => {
          const parentRoot = scopeRootRef(view);
          let parentRead;
          try {
            parentRead = parentRoot === void 0 ? await session.observeSettled() : await session.observeSettled({ withinRef: parentRoot });
          } catch (parentError) {
            if (failureCodeFor(parentError) === "TARGET_CHANGED") {
              return "the fresh read of " + (parentRoot === void 0 ? "the whole page" : "path level " + String(level - 1)) + " needed to re-resolve " + subject + " was itself refused TARGET_CHANGED \u2014 the level above kept changing identity, so the page did not hold still and the step is unproven";
            }
            throw parentError;
          }
          if (parentRead.widened !== null) options.onSettleWidened?.(parentRead.widened);
          if (!parentRead.stable) {
            return "the fresh " + (parentRoot === void 0 ? "whole-page" : "path level " + String(level - 1)) + " read needed to re-resolve " + subject + " never settled within the " + String(parentRead.budgetMs) + "ms settle budget (after " + String(account.retries) + " retries): the page did not hold still, so the step is unproven";
          }
          view = parentRead.observation;
          return null;
        }
      }
    );
    if ("exhausted" in outcome) {
      const last = account.lastRefusal;
      throw new ScopeIdentityExhaustedError(
        levels,
        escalated,
        scopeNameChanged,
        view,
        {
          level,
          what,
          code: "TARGET_CHANGED",
          ...last === null ? {} : {
            ...last.reason === void 0 ? {} : { reason: last.reason },
            ...last.changed === void 0 ? {} : { changed: last.changed },
            ...last.before === void 0 ? {} : { before: last.before },
            ...last.after === void 0 ? {} : { after: last.after }
          }
        },
        account.exhausted ?? identityExhaustionMessage(subject, void 0, account.retries, account.widened),
        account.retries
      );
    }
    if (outcome.ok) return outcome.value;
    throw new Error("unexpected identity refusal during the scoped path walk: " + outcome.refusal.code);
  };
  if (path2 !== void 0 && path2.length > 0) {
    for (let index = 0; index < path2.length; index += 1) {
      const item = path2[index];
      if (item === void 0) continue;
      const resolved = await observeLevel(
        pathItemPredicate(item),
        index + 1,
        describePathItem(item),
        index === 0
      );
      if ("zero" in resolved) {
        if (resolved.truncated) return notLocated();
        throw new Error(
          "no observable node matches path level " + String(index + 1) + " (" + describePathItem(item) + ") in a complete view: the ancestor is not on the page, so the scoped container (" + describeScope(scope) + ") cannot be there"
        );
      }
      view = resolved.settled.observation;
      if (view.truncated && view.nodes.filter((node) => matchesNode(node, pathItemPredicate(path2[index + 1] ?? item))).length <= 1) {
        await widenParent();
      }
    }
    if (view.truncated && view.nodes.filter((node) => matchesNode(node, scopePredicate(scope))).length <= 1) {
      await widenParent();
    }
    const containerLevel = path2.length + 1;
    const container2 = await observeLevel(
      scopePredicate(scope),
      containerLevel,
      describeScope(scope),
      false,
      false,
      options.scopedObserve ?? {}
    );
    if ("zero" in container2) {
      if (container2.truncated) return notLocated();
      throw new Error(
        "no observable node matches the assertion scope (" + describeScope(scope) + ", ancestor path " + JSON.stringify(path2) + ") inside a complete view of its last ancestor: the container is not on the page"
      );
    }
    return {
      kind: "resolved",
      observation: container2.settled.observation,
      resolution: levels.every((level) => level.resolution === "proven") ? "proven" : "provisional",
      escalated,
      levels,
      nameChanged: scopeNameChanged
    };
  }
  const container = await observeLevel(
    scopePredicate(scope),
    1,
    describeScope(scope),
    true,
    true,
    options.scopedObserve ?? {},
    "scope level 1 (" + describeScope(scope) + ")"
  );
  if ("zero" in container) {
    if (container.truncated) return notLocated();
    throw new Error(
      "no observable node matches the assertion scope (" + describeScope(scope) + ")"
    );
  }
  if (view.truncated && options.provisionalScope !== true) {
    const applied = escalated ? view.maxNodes === void 0 ? "the escalated budget (the driver did not report the budget it applied)" : "the applied " + String(view.maxNodes) + "-node escalated budget" : "the driver-default budget";
    throw new Error(
      "one observable node matches the assertion scope (" + describeScope(scope) + "), but the view was still truncated at " + applied + " (" + QA_INCONCLUSIVE_TRUNCATED + "): a twin container may exist outside the returned window, so the scoped container is not uniquely identifiable"
    );
  }
  return {
    kind: "resolved",
    observation: container.settled.observation,
    resolution: view.truncated ? "provisional" : "proven",
    escalated,
    levels,
    nameChanged: scopeNameChanged
  };
}
function provisionalScopeCompleteness(assertion, scoped) {
  const view = scoped.observation;
  return {
    truncated: view.truncated,
    nodeBudget: view.maxNodes ?? null,
    escalated: scoped.escalated,
    outcomeDependsOnCompleteView: false,
    ...view.scope === void 0 ? {} : { scope: { role: view.scope.role, name: view.scope.name } },
    ...view.truncationReasons === void 0 ? {} : { truncationReasons: view.truncationReasons },
    detail: "the scoped container was resolved PROVISIONALLY (" + levelSummary(scoped.levels) + "), so the container's uniqueness is unproven and the " + assertion.kind + " assertion was NOT decided as proven (" + QA_INCONCLUSIVE_SCOPE + ")."
  };
}
async function decideAssertionScoped(assertion, observation, reobserve, session, options = {}) {
  if (assertion.scope === void 0) {
    return decideAssertionWithRetry(assertion, observation, reobserve, session);
  }
  let scoped;
  try {
    scoped = await observeScopeView(assertion.scope, observation, session, reobserve, options);
  } catch (error) {
    if (error instanceof ScopeIdentityExhaustedError) {
      return {
        passed: false,
        observed: null,
        observation: error.view,
        completeness: null,
        reason: QA_INCONCLUSIVE_UNSTABLE,
        scopeIdentityExhausted: true,
        scopeIdentityRefusal: error.refusal,
        ...error.nameChanged ? { scopeNameChanged: true } : {},
        message: error.message,
        scopeLevels: error.levels,
        attempts: 1,
        elapsedMs: 0,
        widened: null
      };
    }
    throw error;
  }
  if (scoped.kind === "not-located") {
    return {
      passed: false,
      observed: null,
      observation: scoped.view,
      completeness: {
        truncated: true,
        nodeBudget: scoped.view.maxNodes ?? null,
        escalated: scoped.escalated,
        outcomeDependsOnCompleteView: false,
        reason: QA_INCONCLUSIVE_TRUNCATED,
        detail: scopeNotLocatedMessage(scoped.levels, scoped.escalated, scoped.view) + ". The recorded path is a discriminator, never a proof. Levels: " + levelSummary(scoped.levels) + "."
      },
      reason: QA_INCONCLUSIVE_TRUNCATED,
      scopeNotLocated: true,
      scopeLevels: scoped.levels,
      attempts: 1,
      elapsedMs: 0,
      widened: null
    };
  }
  if (scoped.resolution === "provisional") {
    const evaluation = evaluateAssertion(assertion, scoped.observation);
    return {
      passed: false,
      observed: evaluation.observed,
      observation: scoped.observation,
      completeness: provisionalScopeCompleteness(assertion, scoped),
      reason: QA_INCONCLUSIVE_SCOPE,
      scopeResolution: "provisional",
      scopeLevels: scoped.levels,
      ...scoped.nameChanged ? { scopeNameChanged: true } : {},
      attempts: 1,
      elapsedMs: 0,
      widened: null
    };
  }
  const decision = await decideAssertionWithRetry(assertion, scoped.observation, reobserve, session);
  return {
    ...decision,
    scopeResolution: "proven",
    scopeLevels: scoped.levels,
    ...scoped.nameChanged ? { scopeNameChanged: true } : {}
  };
}
function matchActionTarget(target, view) {
  const strict = view.nodes.filter((node) => matchesNode(node, target));
  if (strict.length > 0) {
    const first = strict[0];
    if (first === void 0) return { kind: "absent", nameMatches: [] };
    return { kind: "matched", predicate: target, node: first, disclosure: null };
  }
  const name2 = target.name;
  if (name2 === void 0 || name2 === "") return { kind: "absent", nameMatches: [] };
  const nameMatches = view.nodes.filter((node) => node.name === name2);
  if (nameMatches.length === 1) {
    const drifted = nameMatches[0];
    if (drifted === void 0) return { kind: "absent", nameMatches: [] };
    return {
      kind: "matched",
      predicate: { name: name2 },
      node: drifted,
      disclosure: {
        mode: "name-only",
        recordedRole: target.role ?? "",
        observedRole: drifted.role
      }
    };
  }
  return { kind: "absent", nameMatches };
}
function absentActionTargetError(target, nameMatches, truncated, budgetText, container) {
  if (nameMatches.length >= 2) {
    const recordedRole = target.role ?? "(no role recorded)";
    const observedRoles = [...new Set(nameMatches.map((node) => node.role))].map((role) => '"' + role + '"').join(", ");
    return new QaCodeError2(
      QA_TARGET_NOT_UNIQUE,
      QA_TARGET_NOT_UNIQUE + ": the action target (" + describeTarget(target) + ') is present under a different role: recorded "' + recordedRole + '", observed ' + observedRoles + " \u2014 " + String(nameMatches.length) + " nodes carry the accessible name, so the name-only fallback was refused rather than guessed" + (container ? " inside the scoped container" : "")
    );
  }
  if (truncated) {
    return new Error(
      "no observable node matches the action target" + (container ? " inside the scoped container" : "") + ": the target is absent from the returned window" + (container ? " of that container" : "") + " \u2014 the view was still truncated at " + budgetText + " (" + QA_INCONCLUSIVE_TRUNCATED + "), so the target may exist outside the returned " + (container ? "subtree " : "") + "window rather than be missing from the page"
    );
  }
  return new Error(
    "no observable node matches the action target" + (container ? " inside the scoped container" : "") + ": the target is absent from a complete view" + (container ? " of that container" : "")
  );
}
function resolveRef(target, observation) {
  const matches = observation.nodes.filter((node) => matchesNode(node, target));
  if (matches.length === 0) {
    throw new Error("no observable node matches the action target");
  }
  if (matches.length > 1) {
    const first = matches[0];
    if (first === void 0) throw new Error("no observable node matches the action target");
    throw new QaCodeError2(
      QA_TARGET_NOT_UNIQUE,
      QA_TARGET_NOT_UNIQUE + ": " + String(matches.length) + " nodes match the action target (" + describeTarget(target) + "); the recorded target is not uniquely identifiable, so no action was dispatched"
    );
  }
  const only = matches[0];
  if (only === void 0) throw new Error("no observable node matches the action target");
  return only.ref;
}
function targetOf(action) {
  if (action.kind === "navigate") return null;
  if (action.kind === "scroll" && !("target" in action)) return null;
  if (action.kind === "visual_click" || action.kind === "visual_drag" || action.kind === "visual_scroll") return null;
  return action.target;
}
async function resolveActionWithBudget(action, observation, reobserve) {
  const target = targetOf(action);
  let view = observation;
  let escalated = false;
  const missing = (candidate) => target !== null && !candidate.nodes.some((node) => matchesNode(node, target));
  if (missing(view) && view.truncated) {
    try {
      view = await reobserve({ maxNodes: QA_ESCALATED_NODE_BUDGET });
      escalated = true;
    } catch {
    }
  }
  if (target === null || !missing(view)) {
    return { resolved: resolveAction(action, view), observation: view, targetResolution: null };
  }
  const match = matchActionTarget(target, view);
  if (match.kind === "matched") {
    const override = match.disclosure === null ? void 0 : match.predicate;
    return {
      resolved: resolveAction(action, view, override),
      observation: view,
      targetResolution: match.disclosure
    };
  }
  const applied = escalated ? view.maxNodes === void 0 ? "the escalated budget (the driver did not report the budget it applied)" : "the applied " + String(view.maxNodes) + "-node escalated budget" : "the driver-default budget";
  throw absentActionTargetError(target, match.nameMatches, view.truncated, applied, false);
}
function resolveAction(action, observation, targetOverride) {
  const target = (recorded) => resolveRef(targetOverride ?? recorded, observation);
  if (action.kind === "navigate") return { kind: "navigate", url: action.url };
  if (action.kind === "visual_click" || action.kind === "visual_drag" || action.kind === "visual_scroll") {
    throw new Error("visual action must be resolved through the visual grounding path, not resolveAction");
  }
  if (action.kind === "click") return { kind: "click", ref: target(action.target) };
  if (action.kind === "focus") return { kind: "focus", ref: target(action.target) };
  if (action.kind === "fill") {
    return { kind: "fill", ref: target(action.target), text: action.text };
  }
  if (action.kind === "type") {
    return { kind: "type", ref: target(action.target), text: action.text };
  }
  if (action.kind === "press") {
    return { kind: "press", ref: target(action.target), key: action.key };
  }
  if (action.kind === "key") {
    return {
      kind: "key",
      ref: target(action.target),
      key: action.key,
      ...action.modifiers === void 0 ? {} : { modifiers: [...action.modifiers] }
    };
  }
  if (action.kind === "scroll") {
    if ("target" in action) {
      return action.direction === void 0 ? { kind: "scroll", ref: target(action.target) } : {
        kind: "scroll",
        ref: target(action.target),
        direction: action.direction,
        ...action.amount === void 0 ? {} : { amount: action.amount }
      };
    }
    return {
      kind: "scroll",
      direction: action.direction,
      ...action.amount === void 0 ? {} : { amount: action.amount }
    };
  }
  if (action.kind === "select") {
    return { kind: "select", ref: target(action.target), option: action.option };
  }
  return { kind: "hover", ref: target(action.target) };
}
async function resolveVisualStepAction(action, session, visual, wholePage) {
  if (action.kind === "visual_click" || action.kind === "visual_scroll") {
    const targetDescription = action.targetDescription;
    const grounded2 = await captureAndGroundVisualTarget(session, targetDescription, visual);
    if (action.kind === "visual_click") {
      return {
        resolved: buildVisualRuntimeAction("click", grounded2.capture, targetDescription, grounded2.nativePoint, { provenance: grounded2.grounding }),
        observation: wholePage,
        targetResolution: null
      };
    }
    return {
      resolved: buildVisualRuntimeAction("scroll", grounded2.capture, targetDescription, grounded2.nativePoint, {
        direction: action.direction,
        ...action.amount === void 0 ? {} : { amount: action.amount },
        provenance: grounded2.grounding
      }),
      observation: wholePage,
      targetResolution: null
    };
  }
  if (action.kind !== "visual_drag") {
    throw new Error("unsupported visual action kind");
  }
  const grounded = await captureAndGroundVisualTarget(session, action.targetDescription, visual);
  const result = await groundVisualTarget(action.toDescription, grounded.capture, visual, {});
  if (!result.ok) {
    throw new Error("qa_act visual drag destination grounding failed: " + result.reason);
  }
  return {
    resolved: buildVisualRuntimeAction("drag", grounded.capture, action.targetDescription, grounded.nativePoint, {
      toDescription: action.toDescription,
      nativeTo: result.nativePoint,
      provenance: grounded.grounding
    }),
    observation: wholePage,
    targetResolution: null
  };
}
async function resolveStepAction(action, assert, wholePage, session, reobserve, options = {}, visual) {
  if (action.kind === "visual_click" || action.kind === "visual_drag" || action.kind === "visual_scroll") {
    return { ...await resolveVisualStepAction(action, session, visual, wholePage), scopeNameChanged: false };
  }
  if (assert.scope === void 0) {
    return { ...await resolveActionWithBudget(action, wholePage, reobserve), scopeNameChanged: false };
  }
  const scoped = await observeScopeView(assert.scope, wholePage, session, reobserve, options);
  if (scoped.kind === "not-located") {
    throw new ScopeNotLocatedError(scoped.levels, scoped.escalated, scoped.view);
  }
  const scopedView = scoped.observation;
  const target = targetOf(action);
  let view = scopedView;
  if (target !== null && !view.nodes.some((node) => matchesNode(node, target)) && view.truncated) {
    const withinRef = scopeRootRef(view);
    if (withinRef === void 0) {
      throw new Error(
        "no observable node matches the action target inside the scoped container, and the scoped view cannot be re-chained (its root is not among the returned nodes) (" + QA_INCONCLUSIVE_TRUNCATED + ")"
      );
    }
    view = await reobserve({ maxNodes: QA_ESCALATED_NODE_BUDGET, withinRef });
  }
  if (target !== null && !view.nodes.some((node) => matchesNode(node, target))) {
    const match = matchActionTarget(target, view);
    if (match.kind === "matched") {
      const override = match.disclosure === null ? void 0 : match.predicate;
      return {
        resolved: resolveAction(action, view, override),
        observation: wholePage,
        targetResolution: match.disclosure,
        scopeNameChanged: scoped.nameChanged
      };
    }
    throw absentActionTargetError(target, match.nameMatches, view.truncated, "the applied budget", true);
  }
  return { resolved: resolveAction(action, view), observation: wholePage, targetResolution: null, scopeNameChanged: scoped.nameChanged };
}
function scopedScrollProofStep(step) {
  return step.action.kind === "scroll" && "target" in step.action && step.assert.kind === "node-in-viewport" && step.assert.scope !== void 0;
}
function sameJsonShape(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function verifyScopedScrollAnchor(view, targetNode) {
  const anchor = view.anchor;
  if (anchor === void 0) {
    return { ok: false, reason: "the driver reported no identity anchor for the scoped verifying read" };
  }
  if (anchor.connected !== true) {
    return { ok: false, reason: "the identity anchor reported the acted element no longer connected (connected: false)" };
  }
  if (anchor.contained !== true) {
    return { ok: false, reason: "the identity anchor reported the acted element outside the scoped container (contained: false)" };
  }
  if (anchor.ref === null) {
    return { ok: false, reason: "the identity anchor excluded the acted element from the scoped view (anchor ref null)" };
  }
  const anchored = view.nodes.find((node) => node.ref === anchor.ref);
  if (anchored === void 0) {
    return { ok: false, reason: "the identity anchor ref did not resolve to an emitted node in the scoped view" };
  }
  if (anchored.ref !== targetNode.ref) {
    return {
      ok: false,
      reason: "the identity anchor bound a different element than the asserted scroll target (same-node-ref identity failed); never reselecting by predicate"
    };
  }
  if (anchored.inViewport !== true) {
    return { ok: false, reason: "the anchored element is not in the viewport, so the scoped scroll proof is unproven" };
  }
  return { ok: true };
}
function decideScopedScrollProof(assertion, target, scoped) {
  const view = scoped.observation;
  const completenessBase = {
    truncated: view.truncated,
    nodeBudget: view.maxNodes ?? null,
    escalated: scoped.escalated,
    outcomeDependsOnCompleteView: false,
    ...view.scope === void 0 ? {} : { scope: { role: view.scope.role, name: view.scope.name } },
    ...view.truncationReasons === void 0 ? {} : { truncationReasons: view.truncationReasons }
  };
  const matches = view.nodes.filter((node) => matchesNode(node, target));
  let targetNode;
  let targetResolution = null;
  if (matches.length === 0) {
    const fallback = matchActionTarget(target, view);
    if (fallback.kind === "absent") {
      throw absentActionTargetError(target, fallback.nameMatches, view.truncated, "the applied budget", true);
    }
    targetNode = fallback.node;
    targetResolution = fallback.disclosure;
  } else if (matches.length > 1) {
    return {
      kind: "failure",
      error: new QaCodeError2(
        QA_TARGET_NOT_UNIQUE,
        QA_TARGET_NOT_UNIQUE + ": " + String(matches.length) + " nodes match the scroll target (" + describeTarget(target) + ") inside the scoped container, so the replayed target is not uniquely identifiable"
      )
    };
  } else {
    const only = matches[0];
    if (only === void 0) {
      return {
        kind: "failure",
        error: new Error("no observable node matches the action target inside the scoped container")
      };
    }
    targetNode = only;
  }
  const evaluation = evaluateAssertion(assertion, view);
  const anchor = verifyScopedScrollAnchor(view, targetNode);
  if (!anchor.ok) {
    return {
      kind: "inconclusive",
      observed: evaluation.observed,
      completeness: {
        ...completenessBase,
        detail: "the scoped scroll proof was REFUSED by the identity anchor: " + anchor.reason + " (" + QA_INCONCLUSIVE_SCOPE + ")."
      },
      targetResolution,
      refusal: { reason: anchor.reason }
    };
  }
  const subtreeComplete = !view.truncated;
  const coverageVerified = view.coverage?.verified === true;
  if (scoped.resolution === "proven" && subtreeComplete && coverageVerified && targetNode.inViewport === true) {
    return {
      kind: "pass",
      observed: evaluation.observed,
      completeness: {
        ...completenessBase,
        detail: "the container was resolved PROVEN (" + levelSummary(scoped.levels) + "), the scoped subtree is complete with verified coverage, and the identity anchor confirmed the asserted target is the anchored node in the viewport."
      },
      targetResolution
    };
  }
  const why = scoped.resolution === "provisional" ? "the scoped container was resolved PROVISIONALLY (" + levelSummary(scoped.levels) + ")" : subtreeComplete ? "the scoped subtree was complete but its coverage was not verified (coverage.verified !== true), so target uniqueness inside the scope is unproven" : "the scoped subtree was still truncated at its budget, so target uniqueness inside the scope is unproven";
  return {
    kind: "inconclusive",
    observed: evaluation.observed,
    completeness: {
      ...completenessBase,
      detail: why + ": the scoped scroll proof cannot earn a pass (" + QA_INCONCLUSIVE_SCOPE + ")."
    },
    targetResolution
  };
}
function buildStepResult(base, assertion, receipt, outcome, assertionPassed, observed, completeness = null, reason, attempts, elapsedMs, scope = {}, targetResolution = null, targetChangedRetries = 0, message) {
  return {
    index: base.index,
    intent: base.intent,
    // QA-BL-067: the scenario step's recorded record-time proof refusal rides
    // onto the step result so report.md's step lines surface it.
    ...base.escalationRefused === void 0 ? {} : { escalationRefused: base.escalationRefused },
    // QA-BL-062/069/070/073 three-state: INCONCLUSIVE_SCOPE is a
    // provisional non-result, a container not located in a still-truncated
    // view is an inconclusive non-result (INCONCLUSIVE_TRUNCATED), and an
    // identity retry (dispatch OR path walk) that exhausted the whole settle
    // budget is an inconclusive non-result (INCONCLUSIVE_UNSTABLE) — never
    // green, and never an ordinary failure.
    status: assertionPassed ? "pass" : reason === QA_INCONCLUSIVE_SCOPE || reason === QA_INCONCLUSIVE_UNSTABLE || scope.scopeNotLocated === true ? "inconclusive" : "fail",
    action: base.action,
    receipt,
    outcome,
    assertion,
    assertionPassed,
    observed,
    expected: assertion.expected,
    ...completeness === null ? {} : { completeness },
    ...reason === void 0 ? {} : { reason },
    ...attempts === void 0 || attempts <= 1 ? {} : { attempts, elapsedMs: elapsedMs ?? 0 },
    ...scope.scopeResolution === void 0 ? {} : { scopeResolution: scope.scopeResolution },
    ...scope.scopeRefusal === void 0 ? {} : { scopeRefusal: scope.scopeRefusal },
    ...scope.scopeNotLocated === true ? { scopeNotLocated: true } : {},
    ...scope.scopeLevels === void 0 ? {} : { scopeLevels: scope.scopeLevels },
    ...scope.scopeIdentityRefusal === void 0 ? {} : { scopeIdentityRefusal: scope.scopeIdentityRefusal },
    ...scope.scopeNameChanged === true ? { scopeNameChanged: true } : {},
    // QA-BL-064: disclosed only when the name-only fallback resolved the action target.
    ...targetResolution === null ? {} : { targetResolution },
    // QA-BL-070: the bounded identity-staleness retry count (replaces the
    // QA-BL-064 boolean) and its exhaustion message.
    ...targetChangedRetries > 0 ? { targetChangedRetries } : {},
    ...message === void 0 ? {} : { message }
  };
}
function assertionFailureMessage(what, decision) {
  const completeness = decision.completeness;
  if (completeness?.reason !== void 0) {
    return what + " is " + completeness.reason + ": " + completeness.detail;
  }
  if (decision.reason !== void 0) {
    return what + " failed (" + decision.reason + ")";
  }
  return what + " failed";
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
function summarizeReceipts(steps) {
  const summary = { confirmed: 0, unknown: 0, rejected: 0, failed: 0, total: 0 };
  for (const step of steps) {
    const receipt = step.receipt;
    if (receipt === null) continue;
    summary.total += 1;
    if (receipt.status === "confirmed") summary.confirmed += 1;
    else if (receipt.status === "unknown") summary.unknown += 1;
    else if (receipt.status === "rejected") summary.rejected += 1;
    else summary.failed += 1;
  }
  if (summary.confirmed === 0 && summary.total > 0) {
    summary.warning = QA_NO_CONFIRMED_RECEIPTS_WARNING;
  }
  return summary;
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
    receiptSummary: { confirmed: 0, unknown: 0, rejected: 0, failed: 0, total: 0 },
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
    reasoningTrust: QA_ADVISORY_REASONING_TRUST,
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
  let captureSettle;
  try {
    const latest = await captureLatestVisual(session);
    capture = latest.capture;
    captureSettle = latest.settle;
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
      reasoningTrust: QA_ADVISORY_REASONING_TRUST,
      ...finding.reason === void 0 ? {} : { reason: finding.reason },
      ...assertion.description === void 0 ? {} : { description: assertion.description },
      // The capture's settle window travels beside the advisory verdict
      // (additive, excluded from determinism by schema): stable === false means
      // the view never stopped changing, so the advisory verdict is over an
      // unstable view and is marked as such in report.md / report.json.
      ...captureSettle === null ? {} : {
        settle: captureSettle,
        ...captureSettle.stable ? {} : { captureSettled: false }
      },
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
  const session = new QaSession(adapter, ownerId, {
    settle: { ...options.settle ?? {}, ...scenario.meta.settle ?? {} }
  });
  const stepResults = [];
  const assertionResults = [];
  const artifacts = [];
  const advisoryResults = [];
  let evidence = null;
  let failure2 = null;
  let settleWidened = null;
  let unprovenCount = 0;
  let identityExhaustedStep = false;
  try {
    await session.start(scenarioStartOptions(scenario, launch, options.headless, options.deviceId));
  } catch (error) {
    await session.stop().catch(() => {
    });
    return blockedReport(scenario, startedAt, "failed to start driver: " + errorMessage(error));
  }
  const reobserve = sessionReobserve(session);
  try {
    if (scenario.meta.driver === "ios") await session.observe();
    const initial = await session.observeSettled();
    if (settleWidened === null && initial.widened !== null) {
      settleWidened = { ...initial.widened, at: "initial" };
    }
    let current = initial.observation;
    if (!initial.stable) {
      failure2 = {
        stepIndex: null,
        message: unsettledMessage("initial", initial.budgetMs),
        code: QA_INCONCLUSIVE_UNSTABLE,
        reproduction: []
      };
    }
    let lastScrollProofStep = null;
    let lastScrollProofDecision = null;
    for (let stepIndex = 0; stepIndex < scenario.steps.length; stepIndex += 1) {
      if (failure2 !== null) break;
      const step = scenario.steps[stepIndex];
      if (step === void 0) continue;
      const base = {
        index: step.index,
        intent: step.intent,
        action: step.action,
        ...step.escalationRefused === void 0 ? {} : { escalationRefused: step.escalationRefused }
      };
      const scopedScrollProof = scopedScrollProofStep(step);
      if (scopedScrollProof) lastScrollProofStep = step;
      let resolved;
      let targetResolution = null;
      const identityAccount = { retries: 0, widened: null, lastRefusal: null, exhausted: null };
      let targetChangedLastReceipt = null;
      let identityExhausted = null;
      let stepScopeNameChanged = false;
      const mirrorSettleWidening = (widened) => {
        if (settleWidened === null) settleWidened = { ...widened, at: step.index };
      };
      const stepScopeOptions = () => ({
        provisionalScope: scopedScrollProof,
        identity: identityAccount,
        onSettleWidened: mirrorSettleWidening
      });
      try {
        const resolution = await resolveStepAction(
          step.action,
          step.assert,
          current,
          session,
          reobserve,
          stepScopeOptions(),
          options.visual
        );
        resolved = resolution.resolved;
        current = resolution.observation;
        targetResolution = resolution.targetResolution;
        if (resolution.scopeNameChanged) stepScopeNameChanged = true;
      } catch (error) {
        if (error instanceof ScopeIdentityExhaustedError) {
          stepResults.push(buildStepResult(
            base,
            step.assert,
            null,
            "unknown",
            false,
            null,
            null,
            QA_INCONCLUSIVE_UNSTABLE,
            void 0,
            void 0,
            {
              scopeLevels: error.levels,
              scopeIdentityRefusal: error.refusal,
              ...stepScopeNameChanged || error.nameChanged ? { scopeNameChanged: true } : {}
            },
            null,
            identityAccount.retries,
            error.message
          ));
          unprovenCount += 1;
          identityExhaustedStep = true;
          break;
        }
        if (error instanceof ScopeNotLocatedError) {
          stepResults.push(buildStepResult(
            base,
            step.assert,
            null,
            "unknown",
            false,
            null,
            {
              truncated: true,
              nodeBudget: error.view.maxNodes ?? null,
              escalated: error.escalated,
              outcomeDependsOnCompleteView: false,
              reason: QA_INCONCLUSIVE_TRUNCATED,
              detail: error.message + ". Levels: " + levelSummary(error.levels) + "."
            },
            QA_INCONCLUSIVE_TRUNCATED,
            1,
            0,
            { scopeNotLocated: true, scopeLevels: error.levels },
            null,
            0
          ));
          unprovenCount += 1;
          break;
        }
        stepResults.push(buildStepResult(base, step.assert, null, "failed", false, null));
        const code = failureCodeFor(error);
        failure2 = {
          stepIndex: step.index,
          message: errorMessage(error),
          ...code === void 0 ? {} : { code },
          reproduction: toReproduction(stepResults)
        };
        break;
      }
      let result;
      try {
        const retry = await runBoundedIdentityRetry(
          session,
          identityAccount,
          async () => {
            const attempt = await session.act(resolved, options.approval);
            if (attempt.outcome === "failed" && attempt.receipt.code === "TARGET_CHANGED") {
              targetChangedLastReceipt = attempt.receipt;
              return {
                ok: false,
                refusal: {
                  code: attempt.receipt.code,
                  ...attempt.receipt.reason === void 0 ? {} : { reason: attempt.receipt.reason }
                }
              };
            }
            return { ok: true, value: attempt };
          },
          {
            subject: "the target",
            between: "between resolution and dispatch",
            onWidened: mirrorSettleWidening,
            prepare: async () => {
              const refresh = await session.observeSettled();
              if (settleWidened === null && refresh.widened !== null) {
                settleWidened = { ...refresh.widened, at: step.index };
              }
              if (!refresh.stable) {
                return "the post-TARGET_CHANGED refresh observation never settled within the " + String(refresh.budgetMs) + "ms settle budget (after " + String(identityAccount.retries) + " retries): the page did not hold still, so the step is unproven";
              }
              const retryResolution = await resolveStepAction(
                step.action,
                step.assert,
                refresh.observation,
                session,
                reobserve,
                stepScopeOptions(),
                options.visual
              );
              resolved = retryResolution.resolved;
              if (retryResolution.targetResolution !== null) {
                targetResolution = retryResolution.targetResolution;
              }
              if (retryResolution.scopeNameChanged) stepScopeNameChanged = true;
              return null;
            }
          }
        );
        if ("exhausted" in retry) {
          identityExhausted = identityAccount.exhausted ?? identityExhaustionMessage("the target", "between resolution and dispatch", identityAccount.retries, identityAccount.widened);
          stepResults.push(buildStepResult(
            base,
            step.assert,
            targetChangedLastReceipt,
            "failed",
            false,
            null,
            null,
            QA_INCONCLUSIVE_UNSTABLE,
            void 0,
            void 0,
            {},
            null,
            identityAccount.retries,
            identityExhausted
          ));
          unprovenCount += 1;
          identityExhaustedStep = true;
          break;
        }
        if (retry.ok) {
          result = retry.value;
        } else {
          throw new Error("unexpected non-TARGET_CHANGED identity refusal: " + retry.refusal.code);
        }
      } catch (error) {
        if (error instanceof ScopeIdentityExhaustedError) {
          stepResults.push(buildStepResult(
            base,
            step.assert,
            null,
            "unknown",
            false,
            null,
            null,
            QA_INCONCLUSIVE_UNSTABLE,
            void 0,
            void 0,
            {
              scopeLevels: error.levels,
              scopeIdentityRefusal: error.refusal,
              ...stepScopeNameChanged || error.nameChanged ? { scopeNameChanged: true } : {}
            },
            null,
            identityAccount.retries,
            error.message
          ));
          unprovenCount += 1;
          identityExhaustedStep = true;
          break;
        }
        if (error instanceof ScopeNotLocatedError) {
          stepResults.push(buildStepResult(
            base,
            step.assert,
            null,
            "unknown",
            false,
            null,
            {
              truncated: true,
              nodeBudget: error.view.maxNodes ?? null,
              escalated: error.escalated,
              outcomeDependsOnCompleteView: false,
              reason: QA_INCONCLUSIVE_TRUNCATED,
              detail: error.message + ". Levels: " + levelSummary(error.levels) + "."
            },
            QA_INCONCLUSIVE_TRUNCATED,
            1,
            0,
            { scopeNotLocated: true, scopeLevels: error.levels },
            null,
            identityAccount.retries
          ));
          unprovenCount += 1;
          break;
        }
        stepResults.push(buildStepResult(base, step.assert, null, "failed", false, null));
        failure2 = {
          stepIndex: step.index,
          message: errorMessage(error),
          reproduction: toReproduction(stepResults)
        };
        break;
      }
      if (settleWidened === null && result.settle !== null && result.settle.widened !== null) {
        settleWidened = { ...result.settle.widened, at: step.index };
      }
      if (result.outcome === "failed" || result.observation === null) {
        stepResults.push(
          buildStepResult(
            base,
            step.assert,
            result.receipt,
            result.outcome,
            false,
            null,
            null,
            void 0,
            void 0,
            void 0,
            {},
            null,
            identityAccount.retries
          )
        );
        failure2 = {
          stepIndex: step.index,
          message: "action receipt " + result.receipt.status + (result.receipt.code !== void 0 ? " (" + result.receipt.code + ")" : ""),
          reproduction: toReproduction(stepResults)
        };
        break;
      }
      if (result.settle !== null && !result.settle.stable) {
        stepResults.push(buildStepResult(base, step.assert, result.receipt, result.outcome, false, null));
        failure2 = {
          stepIndex: step.index,
          message: unsettledMessage("post-action", result.settle.budgetMs),
          code: QA_INCONCLUSIVE_UNSTABLE,
          reproduction: toReproduction(stepResults)
        };
        break;
      }
      let decision;
      try {
        if (scopedScrollProof) {
          const target = step.action.target;
          const verifying = await observeScopeView(
            step.assert.scope,
            result.observation,
            session,
            reobserve,
            {
              provisionalScope: true,
              identity: identityAccount,
              onSettleWidened: mirrorSettleWidening,
              scopedObserve: {
                anchorLastAction: true,
                verifyCoverage: true,
                // The record-time escalated read ran at the same budget: the
                // container subtree can exceed the default window (61 nodes in
                // the deep-target fixture), and the verifying read must see
                // the whole subtree to count target matches honestly.
                maxNodes: QA_ESCALATED_NODE_BUDGET
              }
            }
          );
          if (verifying.kind === "not-located") {
            decision = {
              passed: false,
              observed: null,
              observation: verifying.view,
              completeness: {
                truncated: true,
                nodeBudget: verifying.view.maxNodes ?? null,
                escalated: verifying.escalated,
                outcomeDependsOnCompleteView: false,
                reason: QA_INCONCLUSIVE_TRUNCATED,
                detail: scopeNotLocatedMessage(verifying.levels, verifying.escalated, verifying.view) + ". The recorded path is a discriminator, never a proof. Levels: " + levelSummary(verifying.levels) + "."
              },
              reason: QA_INCONCLUSIVE_TRUNCATED,
              scopeNotLocated: true,
              scopeLevels: verifying.levels,
              attempts: 1,
              elapsedMs: 0,
              widened: null
            };
          } else {
            const outcome = decideScopedScrollProof(step.assert, target, verifying);
            if (outcome.kind === "failure") throw outcome.error;
            if (outcome.targetResolution !== null) targetResolution = outcome.targetResolution;
            decision = {
              passed: outcome.kind === "pass",
              observed: outcome.observed,
              observation: verifying.observation,
              completeness: outcome.completeness,
              ...outcome.kind === "pass" ? {} : { reason: QA_INCONCLUSIVE_SCOPE },
              ...outcome.kind === "inconclusive" && outcome.refusal !== void 0 ? { scopeRefusal: outcome.refusal } : {},
              scopeResolution: verifying.resolution,
              scopeLevels: verifying.levels,
              ...verifying.nameChanged ? { scopeNameChanged: true } : {},
              attempts: 1,
              elapsedMs: 0,
              widened: null
            };
          }
        } else {
          decision = await decideAssertionScoped(
            step.assert,
            result.observation,
            reobserve,
            session,
            stepScopeOptions()
          );
        }
      } catch (error) {
        if (error instanceof ScopeIdentityExhaustedError) {
          decision = {
            passed: false,
            observed: null,
            observation: error.view,
            completeness: null,
            reason: QA_INCONCLUSIVE_UNSTABLE,
            scopeIdentityExhausted: true,
            scopeIdentityRefusal: error.refusal,
            ...error.nameChanged ? { scopeNameChanged: true } : {},
            message: error.message,
            scopeLevels: error.levels,
            attempts: 1,
            elapsedMs: 0,
            widened: null
          };
        } else {
          stepResults.push(buildStepResult(base, step.assert, result.receipt, result.outcome, false, null));
          const code = failureCodeFor(error);
          failure2 = {
            stepIndex: step.index,
            message: errorMessage(error),
            ...code === void 0 ? {} : { code },
            reproduction: toReproduction(stepResults)
          };
          break;
        }
      }
      if (settleWidened === null && decision.widened !== null) {
        settleWidened = { ...decision.widened, at: step.index };
      }
      stepResults.push(
        buildStepResult(
          base,
          step.assert,
          result.receipt,
          result.outcome,
          decision.passed,
          decision.observed,
          decision.completeness,
          decision.reason,
          decision.attempts,
          decision.elapsedMs,
          {
            ...decision.scopeResolution === void 0 ? {} : { scopeResolution: decision.scopeResolution },
            ...decision.scopeRefusal === void 0 ? {} : { scopeRefusal: decision.scopeRefusal },
            ...decision.scopeNotLocated === true ? { scopeNotLocated: true } : {},
            ...decision.scopeLevels === void 0 ? {} : { scopeLevels: decision.scopeLevels },
            ...decision.scopeIdentityRefusal === void 0 ? {} : { scopeIdentityRefusal: decision.scopeIdentityRefusal },
            ...stepScopeNameChanged || decision.scopeNameChanged === true ? { scopeNameChanged: true } : {}
          },
          targetResolution,
          identityAccount.retries,
          decision.message
        )
      );
      if (scopedScrollProof) lastScrollProofDecision = decision;
      if (decision.scopeIdentityExhausted === true) identityExhaustedStep = true;
      if (decision.reason === QA_INCONCLUSIVE_SCOPE || decision.reason === QA_INCONCLUSIVE_UNSTABLE || decision.scopeNotLocated === true) unprovenCount += 1;
      if (step.assert.scope === void 0) {
        current = decision.observation;
      } else if (stepIndex < scenario.steps.length - 1) {
        const refresh = await session.observeSettled();
        if (settleWidened === null && refresh.widened !== null) {
          settleWidened = { ...refresh.widened, at: step.index };
        }
        if (!refresh.stable) {
          failure2 = {
            stepIndex: step.index,
            message: unsettledMessage("post-scoped-assertion", refresh.budgetMs),
            code: QA_INCONCLUSIVE_UNSTABLE,
            reproduction: toReproduction(stepResults)
          };
          break;
        }
        current = refresh.observation;
      }
      if (!decision.passed) {
        if (decision.reason === QA_INCONCLUSIVE_SCOPE || decision.reason === QA_INCONCLUSIVE_UNSTABLE || decision.scopeNotLocated === true) {
        } else {
          failure2 = {
            stepIndex: step.index,
            message: assertionFailureMessage("assertion " + step.assert.kind, decision),
            reproduction: toReproduction(stepResults)
          };
          break;
        }
      }
    }
    if (failure2 === null && !identityExhaustedStep) {
      const finalSettle = await session.observeSettled();
      if (settleWidened === null && finalSettle.widened !== null) {
        settleWidened = { ...finalSettle.widened, at: "final" };
      }
      let finalObservation = finalSettle.observation;
      if (!finalSettle.stable) {
        failure2 = {
          stepIndex: null,
          message: unsettledMessage("final", finalSettle.budgetMs),
          code: QA_INCONCLUSIVE_UNSTABLE,
          reproduction: toReproduction(stepResults)
        };
      }
      for (let i = 0; failure2 === null && i < scenario.assertions.length; i += 1) {
        const assertion = scenario.assertions[i];
        if (assertion === void 0) continue;
        if (lastScrollProofStep !== null && lastScrollProofDecision !== null) {
          const scrollProofStep = lastScrollProofStep;
          const stepDecision = lastScrollProofDecision;
          const isCopy = assertion.kind === "node-in-viewport" && assertion.scope !== void 0 && sameJsonShape(assertion.scope, scrollProofStep.assert.scope) && sameJsonShape(assertion.expected, scrollProofStep.assert.expected);
          if (isCopy) {
            assertionResults.push({
              kind: assertion.kind,
              ...assertion.description === void 0 ? {} : { description: assertion.description },
              passed: stepDecision.passed,
              expected: assertion.expected,
              observed: stepDecision.observed,
              ...assertion.scope === void 0 ? {} : { scope: assertion.scope },
              ...stepDecision.completeness === null ? {} : { completeness: stepDecision.completeness },
              ...stepDecision.reason === void 0 ? {} : { reason: stepDecision.reason },
              ...stepDecision.scopeResolution === void 0 ? {} : { scopeResolution: stepDecision.scopeResolution },
              ...stepDecision.scopeRefusal === void 0 ? {} : { scopeRefusal: stepDecision.scopeRefusal },
              ...stepDecision.scopeLevels === void 0 ? {} : { scopeLevels: stepDecision.scopeLevels },
              ...stepDecision.scopeNotLocated === true ? { scopeNotLocated: true } : {},
              ...stepDecision.scopeNameChanged === true ? { scopeNameChanged: true } : {}
            });
            if (stepDecision.reason === QA_INCONCLUSIVE_SCOPE || stepDecision.reason === QA_INCONCLUSIVE_UNSTABLE || stepDecision.scopeNotLocated === true) {
              unprovenCount += 1;
            }
            continue;
          }
        }
        const provisionalScope = lastScrollProofStep !== null && assertion.kind === "node-in-viewport" && assertion.scope !== void 0 && sameJsonShape(assertion.scope, lastScrollProofStep.assert.scope) && sameJsonShape(assertion.expected, lastScrollProofStep.assert.expected);
        let decision;
        const identityAccount = { retries: 0, widened: null, lastRefusal: null, exhausted: null };
        try {
          decision = await decideAssertionScoped(
            assertion,
            finalObservation,
            reobserve,
            session,
            {
              provisionalScope,
              identity: identityAccount,
              onSettleWidened: (widened) => {
                if (settleWidened === null) settleWidened = { ...widened, at: "final" };
              }
            }
          );
        } catch (error) {
          const code = failureCodeFor(error);
          assertionResults.push({
            kind: assertion.kind,
            ...assertion.description === void 0 ? {} : { description: assertion.description },
            passed: false,
            expected: assertion.expected,
            observed: null,
            ...assertion.scope === void 0 ? {} : { scope: assertion.scope },
            ...code === void 0 ? {} : { reason: code }
          });
          failure2 = {
            stepIndex: null,
            message: errorMessage(error),
            ...code === void 0 ? {} : { code },
            reproduction: toReproduction(stepResults)
          };
          break;
        }
        if (settleWidened === null && decision.widened !== null) {
          settleWidened = { ...decision.widened, at: "final" };
        }
        assertionResults.push({
          kind: assertion.kind,
          ...assertion.description === void 0 ? {} : { description: assertion.description },
          passed: decision.passed,
          expected: assertion.expected,
          observed: decision.observed,
          ...assertion.scope === void 0 ? {} : { scope: assertion.scope },
          ...decision.completeness === null ? {} : { completeness: decision.completeness },
          ...decision.reason === void 0 ? {} : { reason: decision.reason },
          ...decision.attempts <= 1 ? {} : { attempts: decision.attempts, elapsedMs: decision.elapsedMs },
          ...decision.scopeResolution === void 0 ? {} : { scopeResolution: decision.scopeResolution },
          ...decision.scopeLevels === void 0 ? {} : { scopeLevels: decision.scopeLevels },
          ...decision.scopeNotLocated === true ? { scopeNotLocated: true } : {},
          ...decision.scopeIdentityRefusal === void 0 ? {} : { scopeIdentityRefusal: decision.scopeIdentityRefusal },
          ...decision.scopeNameChanged === true ? { scopeNameChanged: true } : {},
          ...decision.message === void 0 ? {} : { message: decision.message },
          ...identityAccount.retries > 0 ? { targetChangedRetries: identityAccount.retries } : {}
        });
        if (decision.reason === QA_INCONCLUSIVE_SCOPE || decision.reason === QA_INCONCLUSIVE_UNSTABLE || decision.scopeNotLocated === true) unprovenCount += 1;
        if (assertion.scope === void 0) {
          finalObservation = decision.observation;
        } else if (i + 1 < scenario.assertions.length) {
          const refresh = await session.observeSettled();
          if (settleWidened === null && refresh.widened !== null) {
            settleWidened = { ...refresh.widened, at: "final" };
          }
          if (!refresh.stable) {
            failure2 = {
              stepIndex: null,
              message: unsettledMessage("post-scoped-assertion", refresh.budgetMs),
              code: QA_INCONCLUSIVE_UNSTABLE,
              reproduction: toReproduction(stepResults)
            };
            break;
          }
          finalObservation = refresh.observation;
        }
        if (!decision.passed) {
          if (decision.reason === QA_INCONCLUSIVE_SCOPE || decision.reason === QA_INCONCLUSIVE_UNSTABLE || decision.scopeNotLocated === true) {
          } else {
            failure2 = {
              stepIndex: null,
              message: assertionFailureMessage("final assertion " + (i + 1) + " (" + assertion.kind + ")", decision),
              reproduction: toReproduction(stepResults)
            };
            break;
          }
        }
      }
    }
    try {
      evidence = await session.evidence();
    } catch (error) {
      evidence = { status: "collection-failed", reason: errorMessage(error) };
    }
    try {
      const outcome = await executeAdvisory(
        scenario,
        session,
        options.visual,
        options.visual?.capturesDir ?? join4(tmpdir3(), "dsh-qa-visual-captures")
      );
      artifacts.push(...outcome.artifacts);
      advisoryResults.push(...outcome.advisory);
    } catch {
    }
  } catch (error) {
    failure2 = {
      stepIndex: null,
      message: errorMessage(error),
      reproduction: toReproduction(stepResults)
    };
  } finally {
    try {
      await session.stop();
    } catch (error) {
      const cleanupMessage = "session cleanup failed: " + errorMessage(error);
      if (failure2 === null) {
        failure2 = {
          stepIndex: null,
          message: cleanupMessage,
          reproduction: toReproduction(stepResults)
        };
      } else {
        failure2 = { ...failure2, message: failure2.message + "; " + cleanupMessage };
      }
    }
  }
  const report = {
    schemaVersion: 1,
    scenario: scenario.meta.name,
    driver: scenario.meta.driver,
    // QA-BL-062/069 three-state aggregation: PASS only when every required
    // step and final assertion is fully proven (failure === null AND nothing
    // was unproven); INCONCLUSIVE when at least one required result is
    // provisional (scopeResolution 'provisional' / INCONCLUSIVE_SCOPE) or a
    // scoped container could not be located in a still-truncated view
    // (INCONCLUSIVE_TRUNCATED) and nothing definitely failed; FAIL otherwise.
    status: failure2 === null ? unprovenCount > 0 ? "inconclusive" : "pass" : "fail",
    startedAt,
    finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
    settle: session.settlePolicy,
    steps: stepResults,
    assertions: assertionResults,
    evidence,
    receiptSummary: summarizeReceipts(stepResults),
    ...settleWidened === null ? {} : { settleWidened },
    ...artifacts.length === 0 ? {} : { artifacts },
    ...advisoryResults.length === 0 ? {} : { advisory: advisoryResults }
  };
  if (failure2 !== null) {
    report.failure = failure2;
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
function clean3(value) {
  return value.trim();
}
function containsRedactionMarker(value) {
  return value.includes("[REDACTED");
}
function visualDescriptionIsSafe(value) {
  return clean3(value) !== "" && !containsRedactionMarker(value) && redactText(value) === value;
}
function predicateFor(node, driver) {
  const role = clean3(node.role);
  const name2 = clean3(node.name);
  if (driver === "computer") {
    const tag = clean3(node.tag);
    const predicate = {};
    if (role !== "") predicate.role = role;
    if (name2 !== "") predicate.name = name2;
    if (tag !== "") predicate.tag = tag;
    if (predicate.role === void 0 && predicate.name === void 0 && predicate.tag === void 0) return null;
    for (const value of [predicate.role, predicate.name, predicate.tag]) {
      if (value !== void 0 && containsRedactionMarker(value)) return null;
    }
    return predicate;
  }
  if (driver === "ios" || driver === "android") {
    const identifier = clean3(node.identifier ?? "");
    const predicate = {};
    if (role !== "") predicate.role = role;
    if (name2 !== "") predicate.name = name2;
    if (identifier !== "") predicate.identifier = identifier;
    if (predicate.role === void 0 && predicate.name === void 0 && predicate.identifier === void 0) return null;
    for (const value of [predicate.role, predicate.name, predicate.identifier]) {
      if (value !== void 0 && containsRedactionMarker(value)) return null;
    }
    return predicate;
  }
  if (role === "" || name2 === "") return null;
  if (containsRedactionMarker(role) || containsRedactionMarker(name2)) return null;
  return { role, name: name2 };
}
function matchesPredicate(node, predicate) {
  return (predicate.role === void 0 || node.role === predicate.role) && (predicate.name === void 0 || node.name === predicate.name) && (predicate.tag === void 0 || node.tag === predicate.tag) && (predicate.identifier === void 0 || node.identifier === predicate.identifier);
}
function countMatches(observation, predicate) {
  return observation.nodes.filter((node) => matchesPredicate(node, predicate)).length;
}
function predicateName(predicate) {
  return predicate.name ?? predicate.role ?? predicate.tag ?? predicate.identifier ?? "semantic target";
}
function isRevealed(before, after, predicate) {
  const beforeNode = before.nodes.find((node) => matchesPredicate(node, predicate));
  const afterNode = after.nodes.find((node) => matchesPredicate(node, predicate));
  return afterNode !== void 0 && afterNode.inViewport === true && (beforeNode === void 0 || beforeNode.inViewport !== true);
}
function firstRevealedPredicate(before, after, driver) {
  const present = after.nodes.filter((node) => node.inViewport === true).map((node) => ({ node, predicate: predicateFor(node, driver) })).filter((item) => item.predicate !== null && countMatches(after, item.predicate) === 1).filter((item) => {
    const beforeNode = before.nodes.find((node) => matchesPredicate(node, item.predicate));
    return beforeNode !== void 0 && beforeNode.inViewport !== true;
  });
  return present[0]?.predicate ?? null;
}
function exclusion(recorded, reason, detail) {
  return {
    actionId: recorded.actionId,
    reason,
    detail: redactText(detail),
    receipt: recorded.receipt
  };
}
function durableAction(recorded, before, driver) {
  const action = recorded.action;
  if (action.kind === "navigate") {
    return { action: { kind: "navigate", url: action.url }, target: null };
  }
  if (action.kind === "scroll" && !("ref" in action)) {
    return {
      action: {
        kind: "scroll",
        direction: action.direction,
        ...action.amount === void 0 ? {} : { amount: action.amount }
      },
      target: null
    };
  }
  if (action.kind === "visual_click" || action.kind === "visual_drag" || action.kind === "visual_scroll") {
    const descriptions = action.kind === "visual_drag" ? [action.targetDescription, action.toDescription] : [action.targetDescription];
    if (descriptions.some((description) => !visualDescriptionIsSafe(description))) {
      return exclusion(
        recorded,
        "ACTION_PAYLOAD_REDACTED",
        "A visual replay description was rejected by redaction; no sensitive text is retained."
      );
    }
    const provenance = action.grounding === void 0 ? void 0 : {
      source: action.grounding.source,
      ...action.grounding.provider === void 0 ? {} : { provider: action.grounding.provider },
      ...action.grounding.model === void 0 ? {} : { model: action.grounding.model },
      ...action.grounding.confidence === void 0 ? {} : { confidence: action.grounding.confidence }
    };
    if (action.kind === "visual_click") {
      return {
        action: {
          kind: "visual_click",
          targetDescription: action.targetDescription,
          ...provenance === void 0 ? {} : { provenance }
        },
        target: null
      };
    }
    if (action.kind === "visual_drag") {
      return {
        action: {
          kind: "visual_drag",
          targetDescription: action.targetDescription,
          toDescription: action.toDescription,
          ...provenance === void 0 ? {} : { provenance }
        },
        target: null
      };
    }
    return {
      action: {
        kind: "visual_scroll",
        targetDescription: action.targetDescription,
        direction: action.direction,
        ...action.amount === void 0 ? {} : { amount: action.amount },
        ...provenance === void 0 ? {} : { provenance }
      },
      target: null
    };
  }
  if (before === null) {
    return exclusion(recorded, "TARGET_OBSERVATION_MISSING", "No observation preceded this action.");
  }
  const node = before.nodes.find((candidate) => candidate.ref === action.ref);
  if (node === void 0) {
    return exclusion(
      recorded,
      "TARGET_REF_NOT_FOUND",
      before.truncated ? "The action ref was not present in its preceding observation, which was truncated at the driver node budget, so the target may have fallen outside the returned window." : "The action ref was not present in its preceding observation."
    );
  }
  const target = predicateFor(node, driver);
  if (target === null) {
    return exclusion(
      recorded,
      "TARGET_HAS_NO_ACCESSIBLE_NAME",
      driver === "computer" ? "Replay export requires a non-empty, unredacted role, accessible name, or Accessibility identifier." : driver === "ios" || driver === "android" ? "Replay export requires a non-empty, unredacted stable identifier (Android resourceId / iOS AXUniqueId), role, or accessible name." : "Replay export requires a non-empty, unredacted role plus accessible name."
    );
  }
  const name2 = target.name;
  const role = target.role;
  const nameOnly = driver === "browser" && name2 !== void 0 && countMatches(before, { name: name2 }) === 1;
  const exportedTarget = nameOnly && role !== void 0 ? { name: name2, roleHint: role } : target;
  if (!nameOnly && countMatches(before, target) !== 1) {
    return exclusion(
      recorded,
      QA_TARGET_NOT_UNIQUE,
      driver === "computer" ? "The role/name/identifier predicate did not uniquely identify the action target." : driver === "ios" || driver === "android" ? "The stable-identifier/role/name predicate did not uniquely identify the action target." : "Role plus accessible name did not uniquely identify the action target."
    );
  }
  if (action.kind === "click") return { action: { kind: "click", target: exportedTarget }, target };
  if (action.kind === "focus") return { action: { kind: "focus", target: exportedTarget }, target };
  if (action.kind === "type") {
    if (clean3(action.text) === "") {
      return exclusion(recorded, "UNSUPPORTED_REPLAY_ACTION", "Replay type text must be non-empty.");
    }
    return { action: { kind: "type", target: exportedTarget, text: action.text }, target };
  }
  if (action.kind === "fill") {
    return { action: { kind: "fill", target: exportedTarget, text: action.text }, target };
  }
  if (action.kind === "key") {
    if (clean3(action.key) === "") {
      return exclusion(recorded, "UNSUPPORTED_REPLAY_ACTION", "Replay key key must be non-empty.");
    }
    return {
      action: {
        kind: "key",
        target: exportedTarget,
        key: action.key,
        ...action.modifiers === void 0 ? {} : { modifiers: [...action.modifiers] }
      },
      target
    };
  }
  if (action.kind === "select") {
    if (clean3(action.option) === "") {
      return exclusion(recorded, "UNSUPPORTED_REPLAY_ACTION", "Replay select option must be non-empty.");
    }
    return { action: { kind: "select", target: exportedTarget, option: action.option }, target };
  }
  if (action.kind === "hover") {
    return { action: { kind: "hover", target: exportedTarget }, target };
  }
  if (action.kind === "scroll") {
    return "direction" in action ? {
      action: {
        kind: "scroll",
        target: exportedTarget,
        direction: action.direction,
        ...action.amount === void 0 ? {} : { amount: action.amount }
      },
      target
    } : { action: { kind: "scroll", target: exportedTarget }, target };
  }
  if (clean3(action.key) === "") {
    return exclusion(recorded, "UNSUPPORTED_REPLAY_ACTION", "Replay press key must be non-empty.");
  }
  return { action: { kind: "press", target: exportedTarget, key: action.key }, target };
}
var PROXIMATE_NODE_DISTANCE = 6;
var FRAGILE_PROOF_NAME_CAP = 80;
var CONTENT_NAMED_CONTAINER_ROLES = /* @__PURE__ */ new Set([
  "search",
  "region",
  "list",
  "listbox",
  "group",
  "navigation",
  "main",
  "form",
  "table",
  "menu"
]);
function targetAnchor(before, after, target) {
  if (target === null) return null;
  const afterIndex = after.nodes.findIndex((node) => matchesPredicate(node, target));
  if (afterIndex >= 0) return afterIndex;
  if (before === null) return null;
  const beforeIndex = before.nodes.findIndex((node) => matchesPredicate(node, target));
  return beforeIndex >= 0 ? beforeIndex : null;
}
function isFragileProofDelta(node) {
  if (!CONTENT_NAMED_CONTAINER_ROLES.has(clean3(node.role))) return false;
  return clean3(node.name).length > FRAGILE_PROOF_NAME_CAP;
}
function semanticDelta(before, after, target, driver) {
  if (before === null) return { delta: null, rejectedFragile: null };
  const anchor = targetAnchor(before, after, target);
  const candidates = after.nodes.map((node, order) => {
    const base = predicateFor(node, driver);
    if (base === null) return null;
    const baseName = base.name;
    if (driver === "browser" && baseName === void 0) return null;
    const roleDrifted = driver === "browser" && baseName !== void 0 && before.nodes.some(
      (candidate) => candidate.name === baseName && candidate.role !== base.role
    );
    const predicate = roleDrifted && baseName !== void 0 && countMatches(after, { name: baseName }) === 1 ? { name: baseName } : base;
    return { node, order, base, predicate };
  }).filter((item) => item !== null && countMatches(after, item.base) === 1 && countMatches(before, item.base) === 0).map((item) => ({
    ...item,
    proximity: anchor === null ? "not-applicable" : Math.abs(item.order - anchor) <= PROXIMATE_NODE_DISTANCE ? "target-proximate" : "distant"
  }));
  candidates.sort((left, right) => {
    const leftProximity = left.proximity === "distant" ? 1 : 0;
    const rightProximity = right.proximity === "distant" ? 1 : 0;
    const leftPriority = OUTCOME_ROLE_PRIORITY.get(left.node.role) ?? 10;
    const rightPriority = OUTCOME_ROLE_PRIORITY.get(right.node.role) ?? 10;
    return leftProximity - rightProximity || leftPriority - rightPriority || left.order - right.order;
  });
  const best = candidates.find((item) => !isFragileProofDelta(item.node));
  if (best !== void 0) {
    return {
      delta: { predicate: best.predicate, proximity: best.proximity, name: predicateName(best.predicate) },
      rejectedFragile: null
    };
  }
  const fragile = candidates.find((item) => isFragileProofDelta(item.node));
  if (fragile === void 0) return { delta: null, rejectedFragile: null };
  return {
    delta: null,
    rejectedFragile: { role: clean3(fragile.node.role), name: predicateName(fragile.predicate) }
  };
}
function valueDiscriminator(after, node, target, roleChanged) {
  const role = clean3(node.role);
  const name2 = clean3(node.name);
  if (!roleChanged) {
    if (role === "" || name2 === "") return null;
    if (countMatches(after, { role, name: name2 }) !== 1) return null;
    return {
      predicate: { role, name: name2 },
      explanation: "role+name: the role stayed stable across the action, so the predicate keeps the role."
    };
  }
  if (name2 !== "" && countMatches(after, { name: name2 }) === 1) {
    return {
      predicate: { name: name2 },
      explanation: 'name-only: the role changed from "' + (target.role ?? "") + '" to "' + role + '" during the action, and the accessible name is unique among all nodes, so the role is omitted to keep replay stable across the role switch.'
    };
  }
  if (name2 !== "" && role !== "" && countMatches(after, { role, name: name2 }) === 1) {
    return {
      predicate: { role, name: name2 },
      explanation: 'role+name: the role changed from "' + (target.role ?? "") + '" to "' + role + '" during the action and the accessible name is ambiguous, so role+name is the only unique key (the changed role is used only because nothing else uniquely identifies the node).'
    };
  }
  return null;
}
function synthesizeValueAssertion(after, target, action) {
  if (action === null || action.kind !== "fill" && action.kind !== "type" || target === null) return null;
  const expected = normalizeObservableValue(action.text);
  const node = after.nodes.find((candidate) => matchesPredicate(candidate, target));
  if (node === void 0) {
    const candidates = after.nodes.filter((candidate) => typeof candidate.value === "string" && candidate.value === expected && candidate.valueWithheld !== true && candidate.secure !== true && candidate.valueTruncated !== true && (target.name !== void 0 && candidate.name === target.name || target.role !== void 0 && candidate.role === target.role));
    if (candidates.length !== 1) return null;
    const renamed = candidates[0];
    if (renamed === void 0) return null;
    const roleChanged = target.role !== void 0 && clean3(renamed.role) !== target.role;
    const discriminator = valueDiscriminator(after, renamed, target, roleChanged);
    if (discriminator === null) return null;
    const description = roleChanged ? "Settled post-action observation confirmed the typed value on the action target. Discriminator: " + discriminator.explanation : "Settled post-action observation confirmed the typed value on the action target, whose accessible name the fill rewrote.";
    return {
      assertion: {
        kind: "node-value",
        expected: { ...discriminator.predicate, value: expected },
        description
      },
      weakness: null
    };
  }
  if (node.valueWithheld === true || node.secure === true) return null;
  if (node.valueTruncated === true) return null;
  if (typeof node.value !== "string") return null;
  if (node.value !== expected) return null;
  return {
    assertion: {
      kind: "node-value",
      expected: { ...target, value: expected },
      description: "Settled post-action observation confirmed the typed value on the action target."
    },
    weakness: null
  };
}
function explicitValueProof(recorded, trajectory, before, after) {
  for (const candidate of trajectory.assertions) {
    if (candidate.actionId !== recorded.actionId || !candidate.passed || candidate.assertion.kind !== "node-value") continue;
    const proof = explicitValueCandidateProof(recorded, trajectory, before, after, candidate);
    if (proof !== null) return proof;
  }
  return null;
}
function explicitValueCandidateProof(recorded, trajectory, before, after, candidate) {
  if (recorded.action.kind !== "click" && recorded.action.kind !== "visual_click" && recorded.action.kind !== "visual_drag" && recorded.action.kind !== "visual_scroll") return null;
  if (recorded.receipt === null || !recorded.receipt.dispatched || recorded.receipt.status === "rejected" || recorded.receipt.status === "failed") return null;
  if (recorded.afterObservationId === null || candidate.decidingObservationId === null) return null;
  const deciding = trajectory.observations[candidate.decidingObservationId];
  if (deciding === void 0) return null;
  const observationSequence = new Map(
    trajectory.events.filter((event) => event.kind === "observation").map((event) => [event.observationId, event.sequence])
  );
  const afterSequence = observationSequence.get(recorded.afterObservationId);
  const decidingSequence = observationSequence.get(candidate.decidingObservationId);
  if (afterSequence === void 0 || decidingSequence === void 0 || decidingSequence < afterSequence) return null;
  if (trajectory.events.some((event) => event.kind === "action" && event.sequence > afterSequence && event.sequence <= decidingSequence && event.actionId !== recorded.actionId)) return null;
  const assertionSequence = trajectory.events.find((event) => event.kind === "assertion" && event.actionId === recorded.actionId && event.decidingObservationId === candidate.decidingObservationId && JSON.stringify(event.assertion) === JSON.stringify(candidate.assertion) && event.passed)?.sequence;
  if (assertionSequence === void 0) return null;
  if (trajectory.events.some((event) => event.kind === "action" && event.sequence > decidingSequence && event.sequence < assertionSequence && event.actionId !== recorded.actionId)) return null;
  if (!trajectory.events.some((event) => event.kind === "settle" && event.observationId === candidate.decidingObservationId && event.stable === true && (event.actionId === null || event.actionId === recorded.actionId) && event.sequence > decidingSequence && event.sequence < assertionSequence)) return null;
  if (recorded.afterObservationStable !== true || before === null || before.scope !== void 0 || after.scope !== void 0 || deciding.scope !== void 0) return null;
  const expected = candidate.assertion.expected;
  if (typeof expected.value !== "string" || expected.value.includes("[REDACTED") || redactText(expected.value) !== expected.value) return null;
  const stableIdentifier = typeof expected.tag === "string" && expected.tag.trim() !== "" || typeof expected.identifier === "string" && expected.identifier.trim() !== "";
  if ((before.truncated || after.truncated || deciding.truncated) && !stableIdentifier) return null;
  const predicate = { ...expected };
  delete predicate.value;
  const beforeMatches = before.nodes.filter((node) => matchesPredicate(node, predicate));
  const afterMatches = after.nodes.filter((node) => matchesPredicate(node, predicate));
  const decidingMatches = deciding.nodes.filter((node) => matchesPredicate(node, predicate));
  if (beforeMatches.length !== 1 || afterMatches.length !== 1 || decidingMatches.length !== 1) return null;
  const beforeNode = beforeMatches[0];
  const afterNode = afterMatches[0];
  const decidingNode = decidingMatches[0];
  if (beforeNode === void 0 || afterNode === void 0 || decidingNode === void 0) return null;
  if (beforeNode.secure === true || beforeNode.valueWithheld === true || beforeNode.valueTruncated === true) return null;
  if (afterNode.secure === true || afterNode.valueWithheld === true || afterNode.valueTruncated === true) return null;
  if (decidingNode.secure === true || decidingNode.valueWithheld === true || decidingNode.valueTruncated === true) return null;
  if (typeof beforeNode.value !== "string" || beforeNode.value === expected.value) return null;
  if (evaluateAssertion(candidate.assertion, before).passed) return null;
  if (!evaluateAssertion(candidate.assertion, after).passed) return null;
  if (!evaluateAssertion(candidate.assertion, deciding).passed) return null;
  return candidate.assertion;
}
function synthesizeAssertion(before, after, target, action, driver) {
  const valueAssertion = synthesizeValueAssertion(after, target, action);
  if (valueAssertion !== null) return { assertion: valueAssertion, fragileOnly: null };
  if (before !== null && before.page.url !== after.page.url && clean3(after.page.url) !== "") {
    return {
      assertion: {
        assertion: {
          kind: "page-url",
          expected: { url: after.page.url },
          description: "Settled post-action observation reached the recorded URL."
        },
        weakness: null
      },
      fragileOnly: null
    };
  }
  const evidence = semanticDelta(before, after, target, driver);
  if (evidence.delta !== null) {
    const delta = evidence.delta;
    const distant = delta.proximity === "distant";
    return {
      assertion: {
        assertion: {
          kind: "node-present",
          expected: delta.predicate,
          description: distant ? "Settled post-action observation exposed a new semantic state, but only away from the action target." : "Settled post-action observation exposed a new semantic state."
        },
        weakness: distant ? 'the only observable change was away from the action target ("' + delta.name + '")' : null
      },
      fragileOnly: null
    };
  }
  if (evidence.rejectedFragile !== null) {
    return { assertion: null, fragileOnly: evidence.rejectedFragile };
  }
  return { assertion: null, fragileOnly: null };
}
var TRUNCATED_PROOF_WEAKNESS = "the proof observation was truncated at the driver node budget, so nodes outside the returned window were never seen (an apparently new node may have been there all along, and the semantic target may not be unique)";
var TRUNCATED_EXPLICIT_VALUE_WEAKNESS = "the positive node-value proof was observed in a truncated view; the matching stable target/value is proven, but the full accessibility tree is not claimed complete";
function proofWasTruncated(before, after) {
  return before?.truncated === true || after.truncated === true;
}
function pathItemFor(ancestor) {
  const role = clean3(ancestor.role);
  const name2 = clean3(ancestor.name);
  const tag = clean3(ancestor.tag);
  const omitName = name2 === "" || CONTENT_NAMED_CONTAINER_ROLES.has(role) && name2.length > FRAGILE_PROOF_NAME_CAP;
  if (omitName) return { role, ...tag === "" ? {} : { tag } };
  return { role, name: name2 };
}
function ancestorPathOf(view, node) {
  const byRef = new Map(view.nodes.map((candidate) => [candidate.ref, candidate]));
  const chain = [];
  let current = node;
  for (let hops = 0; hops <= view.nodes.length; hops += 1) {
    const parentRef = typeof current.parentRef === "string" && current.parentRef !== "" ? current.parentRef : null;
    if (parentRef === null) {
      return chain.length === 0 ? null : chain.reverse();
    }
    const parent = byRef.get(parentRef);
    if (parent === void 0) return null;
    chain.push(pathItemFor(parent));
    current = parent;
  }
  return null;
}
function recordedContainerEvidence(observations, baseline, role, name2, tag) {
  const seen = /* @__PURE__ */ new Set();
  const sources = [baseline, ...Object.values(observations)];
  for (const observation of sources) {
    if (observation === null || seen.has(observation)) continue;
    seen.add(observation);
    for (const node of observation.nodes) {
      if (node.role !== role || node.name !== name2) continue;
      if (tag !== "" && node.tag !== tag) continue;
      if (ancestorPathOf(observation, node) !== null) return { view: observation, node };
    }
  }
  return null;
}
function recordedContainerPath(observations, baseline, role, name2, tag) {
  const evidence = recordedContainerEvidence(observations, baseline, role, name2, tag);
  if (evidence === null) return null;
  return ancestorPathOf(evidence.view, evidence.node);
}
function anchoredScrollProof(recorded, proof) {
  if (proof === null || proof.scope === void 0) return false;
  if (recorded.action.kind !== "scroll" || !("ref" in recorded.action)) return false;
  const anchor = proof.anchor;
  return anchor !== void 0 && anchor.connected === true && anchor.contained === true && anchor.ref !== null;
}
function scopePathFor(trajectory, proof, baseline) {
  if (proof === null || proof.scope === void 0) return null;
  const echo = proof.scope;
  return recordedContainerPath(
    trajectory.observations,
    baseline,
    clean3(echo.role),
    clean3(echo.name),
    clean3(echo.tag)
  );
}
function pathItemMatchesNode(item, node) {
  if (clean3(node.role) !== item.role) return false;
  if (item.name !== void 0 && clean3(node.name) !== item.name) return false;
  if (item.tag !== void 0 && clean3(node.tag) !== item.tag) return false;
  return true;
}
function scopeEchoesPathItem(view, item) {
  const scope = view.scope;
  if (scope === void 0) return false;
  if (clean3(scope.role) !== item.role) return false;
  if (item.name !== void 0 && clean3(scope.name) !== item.name) return false;
  if (item.tag !== void 0 && clean3(scope.tag) !== item.tag) return false;
  return true;
}
function classifyPathLevel(count, truncated) {
  if (count >= 2) return "ambiguous";
  if (count === 1) return truncated ? "provisional" : "proven";
  return truncated ? "provisional" : "absent";
}
function describePathItemExport(item) {
  const parts = ['role "' + item.role + '"'];
  if (item.name !== void 0) parts.push('name "' + item.name + '"');
  if (item.tag !== void 0) parts.push('tag "' + item.tag + '"');
  return parts.join(", ");
}
function proofScope(proof, baseline, anchored, path2, observations) {
  if (proof === null || proof.scope === void 0) return null;
  const echo = proof.scope;
  const role = clean3(echo.role);
  const name2 = clean3(echo.name);
  if (role === "") {
    return {
      durable: false,
      detail: "the scoped proof's container has no role, so the scope cannot be recorded durably.",
      provisional: null
    };
  }
  const tag = clean3(echo.tag);
  const describe = 'the container role "' + role + '" named "' + name2 + '"' + (tag === "" ? "" : ' (tag "' + tag + '")');
  const scopeValue = (withTag) => ({
    role,
    name: name2,
    ...withTag ? { tag } : {},
    ...path2 === null ? {} : { path: path2 }
  });
  const provisionalWeakness = (why, anchoredStep) => "the scope is PROVISIONAL: " + why + (anchoredStep ? " The step is an identity-anchored scroll proof, so the scope is exported explicitly provisional; replay reports INCONCLUSIVE_SCOPE (scopeResolution provisional) unless it proves the container unique at replay time." : " The scope is exported explicitly provisional (QA-BL-069: a level of the recorded ancestor path stayed unproven); replay reports INCONCLUSIVE_SCOPE (scopeResolution provisional) unless it proves the container unique at replay time.");
  const unproven = (why) => {
    if (!anchored) {
      return {
        durable: false,
        detail: why + " \u2014 uniqueness is unproven, so the scope is never silently dropped.",
        provisional: null
      };
    }
    return {
      durable: false,
      detail: why + " \u2014 uniqueness is unproven.",
      provisional: { scope: scopeValue(false), weakness: provisionalWeakness(why, true) }
    };
  };
  if (path2 !== null && path2.length > 0) {
    const orderedViews = () => {
      const seen = /* @__PURE__ */ new Set();
      const out = [];
      if (baseline !== null && !seen.has(baseline)) {
        seen.add(baseline);
        out.push(baseline);
      }
      for (const observation of Object.values(observations)) {
        if (!seen.has(observation)) {
          seen.add(observation);
          out.push(observation);
        }
      }
      return out;
    };
    const views = orderedViews();
    const levels = [];
    const wholePage = views.find((view) => view.scope === void 0);
    const itemLevel = (item, view) => {
      if (view === void 0) return "provisional";
      return classifyPathLevel(
        view.nodes.filter((node) => pathItemMatchesNode(item, node)).length,
        view.truncated
      );
    };
    const firstItem = path2[0];
    if (firstItem !== void 0) {
      levels.push({ what: describePathItemExport(firstItem), resolution: itemLevel(firstItem, wholePage) });
      for (let index = 1; index < path2.length; index += 1) {
        const item = path2[index];
        const parentItem = path2[index - 1];
        if (item === void 0 || parentItem === void 0) continue;
        const parentView = views.find((view) => scopeEchoesPathItem(view, parentItem));
        levels.push({ what: describePathItemExport(item), resolution: itemLevel(item, parentView) });
      }
    }
    const evidence = recordedContainerEvidence(observations, baseline, role, name2, tag);
    const containerCount = (view, withTag2) => {
      if (view === void 0) return 0;
      return view.nodes.filter(
        (node) => node.role === role && node.name === name2 && (!withTag2 || node.tag === tag)
      ).length;
    };
    let containerResolution = classifyPathLevel(
      containerCount(evidence?.view, false),
      evidence === null ? true : evidence.view.truncated
    );
    let withTag = false;
    if (containerResolution === "ambiguous" && tag !== "") {
      const tagged = classifyPathLevel(
        containerCount(evidence?.view, true),
        evidence === null ? true : evidence.view.truncated
      );
      if (tagged !== "ambiguous") {
        containerResolution = tagged;
        withTag = true;
      }
    }
    levels.push({ what: describe, resolution: containerResolution });
    const ambiguous = levels.find((level) => level.resolution === "ambiguous");
    if (ambiguous !== void 0) {
      return {
        durable: false,
        detail: "the recorded ancestor path is ambiguous: level (" + ambiguous.what + ") matches more than one node in the recorded evidence \u2014 uniqueness is unproven, so the scope is never silently dropped.",
        provisional: null
      };
    }
    const absent = levels.find((level) => level.resolution === "absent");
    if (absent !== void 0) {
      return {
        durable: false,
        detail: "the recorded ancestor path is contradicted by the recorded evidence: level (" + absent.what + ") matches nothing in a COMPLETE recorded view, so the scope is never silently dropped.",
        provisional: null
      };
    }
    if (levels.every((level) => level.resolution === "proven")) {
      return { durable: true, scope: scopeValue(withTag), weakness: null };
    }
    const why = levels.filter((level) => level.resolution === "provisional").map((level) => level.what + " is UNPROVEN in the recorded evidence").join("; ");
    return {
      durable: false,
      detail: why + " \u2014 uniqueness is unproven per level.",
      provisional: { scope: scopeValue(withTag), weakness: provisionalWeakness(why, anchored) }
    };
  }
  if (baseline === null || baseline.truncated) {
    return unproven(baseline === null ? "no recorded baseline observation precedes the scoped proof, so the uniqueness of " + describe + " cannot be proven" : "the recorded baseline observation was truncated at the driver node budget, so " + describe + " may have a twin outside the returned window");
  }
  const baselineIsOwnSubtree = baseline.scope !== void 0 && baseline.scope.role === role && baseline.scope.name === name2;
  if (baselineIsOwnSubtree) {
    return unproven(
      "the recorded baseline IS " + describe + "'s own scoped subtree, where the container is trivially its own root \u2014 that view proves nothing about uniqueness"
    );
  }
  const byRoleName = baseline.nodes.filter((node) => node.role === role && node.name === name2);
  if (byRoleName.length === 1) return { durable: true, scope: scopeValue(false), weakness: null };
  if (byRoleName.length > 1 && tag !== "") {
    const byRoleNameTag = baseline.nodes.filter(
      (node) => node.role === role && node.name === name2 && node.tag === tag
    );
    if (byRoleNameTag.length === 1) return { durable: true, scope: scopeValue(true), weakness: null };
  }
  return unproven(describe + " matches " + String(byRoleName.length) + " nodes in the recorded baseline observation");
}
function withProofScope(assertion, proof, baseline, anchored, path2, observations) {
  if (assertion.kind === "page-url") return { assertion, notDurable: null, weakness: null };
  const verdict = proofScope(proof, baseline, anchored, path2, observations);
  if (verdict === null) return { assertion, notDurable: null, weakness: null };
  if (verdict.durable) return { assertion: { ...assertion, scope: verdict.scope }, notDurable: null, weakness: null };
  if (verdict.provisional === null) return { assertion, notDurable: verdict.detail, weakness: null };
  return {
    assertion: { ...assertion, scope: verdict.provisional.scope },
    notDurable: null,
    weakness: verdict.provisional.weakness
  };
}
function scopedPrecedingViewWeakness(before) {
  if (before === null || before.scope === void 0) return null;
  const role = clean3(before.scope.role);
  if (role === "") return null;
  const name2 = clean3(before.scope.name);
  return "the action's preceding observation was scoped to the " + role + ' named "' + name2 + `", so the action target's whole-page uniqueness was not verified at export (Replay resolves the target in the whole-page view) \u2014 verify manually.`;
}
function truncationWeakensProof(assertion) {
  return assertion.kind === "node-present" || assertion.kind === "node-in-viewport";
}
function intentWithWeaknesses(base, weaknesses) {
  if (weaknesses.length === 0) return base;
  return base + " Weak proof: " + weaknesses.join("; ") + " \u2014 verify manually.";
}
function synthesizeScrollAssertion(target) {
  return {
    kind: "node-in-viewport",
    expected: target,
    description: "Settled post-scroll observation placed the target in the viewport."
  };
}
function isScrollIntoViewAction(action) {
  return action.kind === "scroll" && "target" in action && action.direction === void 0;
}
function scrollProofFailureDetail(target, after) {
  const name2 = predicateName(target);
  const returned = after.nodes.some((node) => matchesPredicate(node, target));
  if (returned) {
    return 'The settled post-action observation returned the scroll target "' + name2 + '" but did not place it in the viewport, so the scroll outcome is unproven.';
  }
  if (after.truncated) {
    return 'The settled post-action observation was truncated at the driver node budget and did not return the scroll target "' + name2 + '", so the target may have fallen outside the returned window and the scroll outcome is unproven.';
  }
  return 'The settled post-action observation was complete but did not return the scroll target "' + name2 + '", so the scroll outcome is unproven.';
}
function normalizeIntent(value) {
  return value.replace(/\r\n|\r|\n|\u000B|\u000C|\u0085|\u2028|\u2029/gu, "\u23CE");
}
function intentFor(action) {
  if (action.kind === "navigate") return "Navigate to the recorded URL.";
  if (action.kind === "scroll") {
    if ("target" in action) return 'Scroll to "' + predicateName(action.target) + '".';
    return "Scroll the viewport " + action.direction + (action.amount === void 0 ? "." : " by " + String(action.amount) + ".");
  }
  if (action.kind === "visual_click") {
    return 'Visually click "' + action.targetDescription + '" (CU visual fallback; replay re-grounds on a fresh screenshot).';
  }
  if (action.kind === "visual_drag") {
    return 'Visually drag "' + action.targetDescription + '" to "' + action.toDescription + '" (CU visual fallback; replay re-grounds on a fresh screenshot).';
  }
  if (action.kind === "visual_scroll") {
    return 'Visually scroll "' + action.targetDescription + '" ' + action.direction + (action.amount === void 0 ? "" : " by " + String(action.amount)) + " (CU visual fallback; replay re-grounds on a fresh screenshot).";
  }
  const targetName = action.target.name ?? action.target.role ?? "semantic target";
  if (action.kind === "click") return 'Click "' + targetName + '".';
  if (action.kind === "fill") return 'Fill "' + targetName + '".';
  if (action.kind === "focus") return 'Focus "' + targetName + '".';
  if (action.kind === "type") return 'Type "' + action.text + '" into "' + targetName + '".';
  if (action.kind === "key") return "Press " + action.key + ' on "' + targetName + '".';
  if (action.kind === "select") return 'Select option "' + action.option + '" on "' + targetName + '".';
  if (action.kind === "hover") return 'Hover "' + targetName + '".';
  return "Press " + action.key + ' on "' + targetName + '".';
}
function resolveDirectionScroll(candidates, index, driver) {
  const candidate = candidates[index];
  if (candidate === void 0 || candidate.before === null || candidate.after === null || candidate.action === null) {
    return null;
  }
  const { before, after } = candidate;
  const positional = candidate.action;
  for (let j = index + 1; j < candidates.length; j += 1) {
    const next = candidates[j];
    if (next === void 0 || next.exclusion !== null || next.target === null) continue;
    if (isRevealed(before, after, next.target)) {
      return {
        intent: 'Scroll to "' + predicateName(next.target) + '".',
        action: { kind: "scroll", target: next.target },
        assert: synthesizeScrollAssertion(next.target)
      };
    }
  }
  const anyRevealed = firstRevealedPredicate(before, after, driver);
  if (anyRevealed !== null) {
    return {
      intent: "Scroll the viewport " + positional.direction + (positional.amount === void 0 ? " (positional)." : " by " + String(positional.amount) + " (positional)") + ' to reveal "' + predicateName(anyRevealed) + '".',
      action: positional,
      assert: synthesizeScrollAssertion(anyRevealed)
    };
  }
  return null;
}
function defaultSettlePolicy() {
  return {
    budgetMs: QA_SETTLE_BUDGET_MS,
    quietMs: QA_SETTLE_QUIET_MS,
    postChangeQuietMs: QA_SETTLE_POST_CHANGE_QUIET_MS,
    intervalMs: QA_SETTLE_INTERVAL_MS,
    adaptiveBudgetMs: QA_SETTLE_ADAPTIVE_BUDGET_MS
  };
}
function scenarioSettleOverride(policy) {
  if (policy === null) return void 0;
  const defaults = defaultSettlePolicy();
  if (policy.budgetMs === defaults.budgetMs && policy.quietMs === defaults.quietMs && policy.postChangeQuietMs === defaults.postChangeQuietMs && policy.intervalMs === defaults.intervalMs && policy.adaptiveBudgetMs === defaults.adaptiveBudgetMs) {
    return void 0;
  }
  const budgetMs = Math.min(Math.max(1, Math.round(policy.budgetMs)), QA_SETTLE_SCHEMA_BUDGET_MAX);
  const quietMs = Math.min(Math.max(1, Math.round(policy.quietMs)), budgetMs);
  const postChangeQuietMs = Math.min(Math.max(1, Math.round(policy.postChangeQuietMs)), budgetMs);
  const intervalMs = Math.min(Math.max(1, Math.round(policy.intervalMs)), budgetMs);
  const adaptiveBudgetMs = policy.adaptiveBudgetMs === 0 ? 0 : Math.min(Math.max(1, Math.round(policy.adaptiveBudgetMs)), QA_SETTLE_SCHEMA_BUDGET_MAX);
  return { budgetMs, quietMs, postChangeQuietMs, intervalMs, adaptiveBudgetMs };
}
function buildScenario(trajectory, options) {
  const excluded = [];
  const excludedAssertions = [];
  const steps = [];
  const candidates = [];
  for (const recorded of trajectory.actions) {
    const receipt = recorded.receipt;
    let early = null;
    if (recorded.recordingIssue !== null) {
      early = exclusion(recorded, "OBSERVATION_RECORDING_FAILED", recorded.recordingIssue);
    } else if (receipt === null) {
      early = exclusion(recorded, "ACTION_RECEIPT_MISSING", "No action receipt was recorded.");
    } else if (receipt.status === "rejected") {
      early = exclusion(
        recorded,
        "ACTION_REJECTED",
        "Rejected action was not exported" + (receipt.code === void 0 ? "." : " (" + receipt.code + ").")
      );
    } else if (receipt.status === "failed") {
      early = exclusion(recorded, "ACTION_FAILED", "Failed action was not exported.");
    } else if (!receipt.dispatched) {
      early = exclusion(recorded, "ACTION_NOT_DISPATCHED", "The driver did not dispatch this action.");
    } else if (recorded.payloadRedacted) {
      early = exclusion(
        recorded,
        "ACTION_PAYLOAD_REDACTED",
        "Redaction changed a replay-relevant action field, so replay would not be faithful."
      );
    } else if (recorded.afterObservationId === null) {
      early = exclusion(
        recorded,
        "FRESH_OBSERVATION_MISSING",
        "No immediate fresh post-action observation proved the outcome."
      );
    } else if (recorded.afterObservationStable !== true) {
      early = exclusion(
        recorded,
        "ASSERTION_NOT_PROVABLE",
        recorded.afterObservationStable === null ? "No settle window was recorded for the post-action observation, so its view is unproven." : "The post-action view never stabilized within the settle budget, so no observation proves the outcome."
      );
    }
    if (early !== null) {
      candidates.push({ recorded, before: null, after: null, exclusion: early, action: null, target: null });
      continue;
    }
    const before = recorded.beforeObservationId === null ? null : trajectory.observations[recorded.beforeObservationId] ?? null;
    const afterObservationId = recorded.afterObservationId;
    if (afterObservationId === null) {
      candidates.push({
        recorded,
        before,
        after: null,
        exclusion: exclusion(
          recorded,
          "FRESH_OBSERVATION_MISSING",
          "No immediate fresh post-action observation proved the outcome."
        ),
        action: null,
        target: null
      });
      continue;
    }
    const after = trajectory.observations[afterObservationId] ?? null;
    if (after === null) {
      candidates.push({
        recorded,
        before,
        after: null,
        exclusion: exclusion(
          recorded,
          "OBSERVATION_RECORDING_FAILED",
          "The fresh observation reference has no recorded observation payload."
        ),
        action: null,
        target: null
      });
      continue;
    }
    const durable = durableAction(recorded, before, trajectory.driver);
    if ("reason" in durable) {
      candidates.push({ recorded, before, after, exclusion: durable, action: null, target: null });
      continue;
    }
    candidates.push({
      recorded,
      before,
      after,
      exclusion: null,
      action: durable.action,
      target: durable.target
    });
  }
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (candidate === void 0) continue;
    if (candidate.exclusion !== null) {
      excluded.push(candidate.exclusion);
      continue;
    }
    const recorded = candidate.recorded;
    const receipt = recorded.receipt;
    const isDirectionScroll = candidate.action !== null && candidate.action.kind === "scroll" && "direction" in candidate.action && !("target" in candidate.action);
    if (isDirectionScroll) {
      const resolved = resolveDirectionScroll(candidates, i, trajectory.driver);
      if (resolved === null) {
        excluded.push(exclusion(
          recorded,
          "ASSERTION_NOT_PROVABLE",
          "Scroll-by-direction had no observable in-viewport transition in the fresh observation."
        ));
        continue;
      }
      const scopedBeforeWeakness2 = scopedPrecedingViewWeakness(candidate.before);
      const anchored2 = anchoredScrollProof(recorded, candidate.after);
      const scopePath2 = scopePathFor(trajectory, candidate.after, candidate.before);
      const scopedStep2 = withProofScope(resolved.assert, candidate.after, candidate.before, anchored2, scopePath2, trajectory.observations);
      if (scopedStep2.notDurable !== null) {
        excluded.push(exclusion(recorded, QA_SCOPE_NOT_DURABLE, scopedStep2.notDurable));
        continue;
      }
      steps.push({
        index: steps.length + 1,
        intent: normalizeIntent(intentWithWeaknesses(
          resolved.intent,
          [
            ...candidate.after !== null && proofWasTruncated(candidate.before, candidate.after) && truncationWeakensProof(resolved.assert) ? [TRUNCATED_PROOF_WEAKNESS] : [],
            ...scopedBeforeWeakness2 === null ? [] : [scopedBeforeWeakness2],
            ...scopedStep2.weakness === null ? [] : [scopedStep2.weakness]
          ]
        )),
        action: resolved.action,
        assert: scopedStep2.assertion,
        // QA-BL-067: the recorded record-time proof refusal rides on the step
        // (additive) so report.md step lines surface it.
        ...candidate.recorded.scrollProofRefusal === null ? {} : { escalationRefused: candidate.recorded.scrollProofRefusal }
      });
      continue;
    }
    const after = candidate.after;
    if (after === null) {
      excluded.push(exclusion(
        recorded,
        "OBSERVATION_RECORDING_FAILED",
        "The fresh observation reference has no recorded observation payload."
      ));
      continue;
    }
    const stepAction = candidate.action;
    if (stepAction === null) {
      excluded.push(exclusion(recorded, "UNSUPPORTED_REPLAY_ACTION", "The action had no durable replay form."));
      continue;
    }
    const scrollIntoView = isScrollIntoViewAction(stepAction);
    const synthesized = scrollIntoView && candidate.target !== null ? { assertion: { assertion: synthesizeScrollAssertion(candidate.target), weakness: null }, fragileOnly: null } : synthesizeAssertion(candidate.before, after, candidate.target, stepAction, trajectory.driver);
    const explicitProof = synthesized.assertion === null || !evaluateAssertion(synthesized.assertion.assertion, after).passed ? explicitValueProof(recorded, trajectory, candidate.before, after) : null;
    if (synthesized.fragileOnly !== null) {
      excluded.push(exclusion(
        recorded,
        "FRAGILE_PROOF_ONLY",
        'The only observable change was the container role "' + synthesized.fragileOnly.role + '" named "' + synthesized.fragileOnly.name + '", whose accessible name concatenates child text and depends on remote content order.'
      ));
      continue;
    }
    if (synthesized.assertion === null && explicitProof === null || synthesized.assertion !== null && !evaluateAssertion(synthesized.assertion.assertion, after).passed) {
      excluded.push(exclusion(
        recorded,
        "ASSERTION_NOT_PROVABLE",
        scrollIntoView && candidate.target !== null ? scrollProofFailureDetail(candidate.target, after) : receipt?.status === "unknown" ? "Unknown receipt had no semantic state change in the settled observation." : "The settled observation had no semantic state change or URL change proving the action outcome."
      ));
      continue;
    }
    const proofAssertion = explicitProof ?? synthesized.assertion?.assertion ?? null;
    if (proofAssertion === null || !evaluateAssertion(proofAssertion, after).passed) {
      excluded.push(exclusion(
        recorded,
        "ASSERTION_NOT_PROVABLE",
        "The explicit post-action assertion did not pass on the recorded settled observation."
      ));
      continue;
    }
    const scopedBeforeWeakness = scopedPrecedingViewWeakness(candidate.before);
    const anchored = anchoredScrollProof(recorded, after);
    const scopePath = scopePathFor(trajectory, after, candidate.before);
    const scopedStep = withProofScope(proofAssertion, after, candidate.before, anchored, scopePath, trajectory.observations);
    if (scopedStep.notDurable !== null) {
      excluded.push(exclusion(recorded, QA_SCOPE_NOT_DURABLE, scopedStep.notDurable));
      continue;
    }
    const intent = normalizeIntent(intentWithWeaknesses(intentFor(stepAction), [
      ...synthesized.assertion === null || synthesized.assertion.weakness === null ? [] : [synthesized.assertion.weakness],
      ...proofWasTruncated(candidate.before, after) && truncationWeakensProof(proofAssertion) ? [TRUNCATED_PROOF_WEAKNESS] : [],
      ...explicitProof !== null && proofWasTruncated(candidate.before, after) ? [TRUNCATED_EXPLICIT_VALUE_WEAKNESS] : [],
      ...scopedBeforeWeakness === null ? [] : [scopedBeforeWeakness],
      ...scopedStep.weakness === null ? [] : [scopedStep.weakness]
    ]));
    steps.push({
      index: steps.length + 1,
      intent,
      action: stepAction,
      // A scoped proof observation exports as a scoped assertion — never as if
      // it were a whole-page proof (browser driver contract v8).
      assert: scopedStep.assertion,
      // QA-BL-067: the recorded record-time proof refusal rides on the step
      // (additive) so report.md step lines surface it.
      ...candidate.recorded.scrollProofRefusal === null ? {} : { escalationRefused: candidate.recorded.scrollProofRefusal }
    });
  }
  if (steps.length === 0) return { scenario: null, excluded, excludedAssertions };
  const recordedAssertions = [];
  for (const recorded of trajectory.assertions) {
    if (!recorded.passed) continue;
    const deciding = recorded.decidingObservationId === null ? null : trajectory.observations[recorded.decidingObservationId] ?? null;
    if (deciding === null) {
      excludedAssertions.push({
        reason: "OBSERVATION_RECORDING_FAILED",
        detail: "the assertion decision has no recorded deciding observation, so its scope cannot be proven durable."
      });
      continue;
    }
    const baseline = recorded.baselineObservationId === null ? null : trajectory.observations[recorded.baselineObservationId] ?? null;
    const scopePath = scopePathFor(trajectory, deciding, baseline);
    const scoped = withProofScope(recorded.assertion, deciding, baseline, false, scopePath, trajectory.observations);
    if (scoped.notDurable !== null) {
      excludedAssertions.push({ reason: QA_SCOPE_NOT_DURABLE, detail: scoped.notDurable });
      continue;
    }
    recordedAssertions.push(scoped.assertion);
  }
  const fallbackName = "explore-" + trajectory.driver + "-" + trajectory.startedAt.slice(0, 10);
  const visualNotes = trajectory.visualFindings.map((finding) => "visual finding: " + finding.question);
  const settleOverride = scenarioSettleOverride(trajectory.settlePolicy);
  const rawScenario = {
    meta: {
      name: redactText(options.name?.trim() || fallbackName),
      description: redactText(
        options.description?.trim() || "Scenario exported from an evidence-backed Explore trajectory."
      ),
      driver: trajectory.driver,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      ...visualNotes.length === 0 ? {} : { notes: visualNotes },
      ...settleOverride === void 0 ? {} : { settle: settleOverride }
    },
    target: {
      launch: trajectory.launch,
      ...trajectory.windowTitle === null ? {} : { windowTitle: trajectory.windowTitle },
      ...trajectory.deviceId === null ? {} : { deviceId: trajectory.deviceId }
    },
    steps,
    // The recorded (passed) qa_assert decisions replace the synthesized
    // steps-copy when any were exported; otherwise the final assertion stays
    // the last step's proof copy, exactly as before QA-BL-066.
    assertions: recordedAssertions.length > 0 ? recordedAssertions : [steps[steps.length - 1].assert]
  };
  return { scenario: validateScenario(rawScenario), excluded, excludedAssertions };
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
  let temp = await realpath(resolve(options.tempRoot ?? tmpdir4()));
  if (temp === workspace) temp = join5(workspace, ".dsh-qa-temp-root");
  if (!inside(workspace, parent) && !inside(temp, parent)) {
    throw new Error("qa_record_export output_path must be under the current workspace or temporary directory");
  }
  const actual = join5(parent, basename(requested));
  try {
    const existing = await lstat(actual);
    if (existing.isSymbolicLink()) throw new Error("qa_record_export refuses a symbolic-link output file");
  } catch (error) {
    const code = error instanceof Error ? error.code : void 0;
    if (code !== "ENOENT") throw error;
  }
  const artifacts = join5(workspace, ".dsh-qa-artifacts-root");
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
      excludedActions: [],
      excludedAssertions: []
    };
  }
  const built = buildScenario(trajectory, options);
  if (built.scenario === null) {
    return {
      ok: false,
      code: "NO_PROVEN_STEPS",
      error: "No action had both a durable semantic target and an outcome proven by a fresh observation; no file was written.",
      excludedActions: built.excluded,
      excludedAssertions: built.excludedAssertions
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
    excludedActions: built.excluded,
    excludedAssertions: built.excludedAssertions
  };
}

// src/explore/recorder.ts
import { createHash as createHash4, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
function cloneRedacted(value) {
  const projected = projectRedactedJsonValue(value);
  return { value: projected, changed: !isDeepStrictEqual(value, projected) };
}
function projectVisualAction(action) {
  const durable = action.kind === "visual_click" ? {
    kind: action.kind,
    targetDescription: action.targetDescription,
    ...action.grounding === void 0 ? {} : { grounding: action.grounding }
  } : action.kind === "visual_drag" ? {
    kind: action.kind,
    targetDescription: action.targetDescription,
    toDescription: action.toDescription,
    ...action.grounding === void 0 ? {} : { grounding: action.grounding }
  } : {
    kind: action.kind,
    targetDescription: action.targetDescription,
    direction: action.direction,
    ...action.amount === void 0 ? {} : { amount: action.amount },
    ...action.grounding === void 0 ? {} : { grounding: action.grounding }
  };
  const safeDurable = projectRedactedJsonValue(durable);
  return {
    value: {
      ...action,
      ...safeDurable
    },
    changed: !isDeepStrictEqual(durable, safeDurable)
  };
}
function safeReason(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return redactText(raw);
}
function launchFrom(options, info, kind) {
  if (kind === "computer") return options?.bundleId ?? info.page.url;
  if (kind === "ios") return options?.bundleId ?? info.page.url;
  if (kind === "android") return options?.packageName ?? options?.bundleId ?? info.page.url;
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
      const rawWindowTitle = driver === "computer" ? safeOptions.windowTitle ?? safeInfo.page.title ?? "" : "";
      const safeWindowTitle = rawWindowTitle.trim() === "" ? null : rawWindowTitle;
      const rawDeviceId = driver === "ios" || driver === "android" ? safeOptions.deviceId ?? "" : "";
      const safeDeviceId = rawDeviceId.trim() === "" ? null : rawDeviceId;
      const trajectory = {
        driver,
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        launch: safeLaunch,
        windowTitle: safeWindowTitle,
        deviceId: safeDeviceId,
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
        pendingActionId: null,
        settlingActionId: null,
        lastSettledActionId: null,
        settlePolicy: null,
        assertions: [],
        lastWholePageObservationId: null
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
      const safe = action.kind === "navigate" ? { value: aliased, changed: false } : action.kind === "visual_click" || action.kind === "visual_drag" || action.kind === "visual_scroll" ? projectVisualAction(aliased) : cloneRedacted(aliased);
      trajectory.settlingActionId = null;
      const recorded = {
        actionId,
        action: safe.value,
        beforeObservationId: trajectory.lastObservationId,
        receipt: null,
        afterObservationId: null,
        afterObservationStable: null,
        scrollProofRefusal: null,
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
      trajectory.settlingActionId = null;
      const recorded = {
        actionId,
        action: { kind: "navigate", url: "about:recording-error" },
        beforeObservationId: trajectory.lastObservationId,
        receipt: null,
        afterObservationId: null,
        afterObservationStable: null,
        scrollProofRefusal: null,
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
      if (observation.scope === void 0) {
        trajectory.lastWholePageObservationId = observationId;
      }
      trajectory.pendingActionId = null;
      if (afterActionId !== null) {
        const action = trajectory.actionById.get(afterActionId);
        if (action !== void 0) action.afterObservationId = observationId;
        trajectory.settlingActionId = afterActionId;
      } else if (trajectory.settlingActionId !== null) {
        const action = trajectory.actionById.get(trajectory.settlingActionId);
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
  /**
   * Close the bounded settle window the session core just ran. The action's
   * proof is re-bound to the SETTLED observation and the window's stability is
   * recorded, so the exporter can refuse (fail closed) a view that never
   * stabilized instead of exporting an assertion on churn.
   */
  settle(ownerId, report) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0) return;
    const actionId = trajectory.settlingActionId;
    trajectory.settlingActionId = null;
    if (actionId !== null) trajectory.lastSettledActionId = actionId;
    try {
      const safeReport = cloneRedacted(report).value;
      if (actionId !== null) {
        const action = trajectory.actionById.get(actionId);
        if (action !== void 0) {
          if (trajectory.lastObservationId !== null) {
            action.afterObservationId = trajectory.lastObservationId;
          }
          action.afterObservationStable = safeReport.stable;
        }
      }
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: (/* @__PURE__ */ new Date()).toISOString(),
        kind: "settle",
        actionId,
        observationId: trajectory.lastObservationId,
        stable: safeReport.stable,
        passes: safeReport.passes,
        budgetMs: safeReport.budgetMs
      });
    } catch (error) {
      const issue = "settle recording failed: " + safeReason(error);
      trajectory.recordingIssues.push(issue);
      if (actionId !== null) {
        const action = trajectory.actionById.get(actionId);
        if (action !== void 0) action.recordingIssue = issue;
      }
      this.#recordingError(trajectory, "settle", issue, actionId);
    }
  }
  /**
   * Re-bind EXACTLY the named action's proof observation to the last recorded
   * observation. The session core calls this exactly once per action
   * (synchronously inside act) when it accepted the ONE bounded
   * budget-escalated observation as the scroll-by-ref proof, passing the
   * exact action id this recorder stamped onto the receipt: the escalated
   * window's observations are already recorded, and the last of them is the
   * settled fuller view. The recorded observation keeps whatever truncated
   * flag the driver reported — nothing here claims or alters any budget.
   *
   * The re-bind is fail-closed: a null id, an unknown id, an action without a
   * recorded receipt, or an action that is NOT the most recently settled one
   * (a concurrent act on the same owner settled in between) is refused and
   * recorded as a recording issue instead of silently re-binding the wrong
   * action.
   */
  bindEscalatedScrollProof(ownerId, actionId) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0) return;
    const refuse = (issue) => {
      trajectory.recordingIssues.push(issue);
      const recorded = actionId === null ? void 0 : trajectory.actionById.get(actionId);
      if (recorded !== void 0) recorded.recordingIssue = issue;
      this.#recordingError(trajectory, "observation", issue, actionId);
    };
    if (actionId === null) {
      refuse("scroll-proof escalation could not be bound: the session core did not pass the recorded action id");
      return;
    }
    const action = trajectory.actionById.get(actionId);
    if (action === void 0) {
      refuse('scroll-proof escalation could not be bound: unknown action id "' + actionId + '"');
      return;
    }
    if (action.receipt === null) {
      refuse('scroll-proof escalation could not be bound: action "' + actionId + '" has no recorded receipt');
      return;
    }
    if (trajectory.lastSettledActionId !== actionId) {
      refuse('scroll-proof escalation could not be bound: action "' + actionId + '" is not the most recently settled action');
      return;
    }
    if (trajectory.lastObservationId === null) {
      refuse("scroll-proof escalation could not be bound: no observation has been recorded yet");
      return;
    }
    try {
      action.afterObservationId = trajectory.lastObservationId;
    } catch (error) {
      refuse("scroll-proof escalation recording failed: " + safeReason(error));
    }
  }
  /**
   * Attach the FINAL record-time proof refusal (QA-BL-067) to EXACTLY the
   * named recorded action. The session core calls this exactly once per act
   * whose final proof state carries an escalationRefused disclosure, passing
   * the exact action id this recorder stamped onto the receipt. Export then
   * carries the refusal on the step (additive `escalationRefused`) and
   * report.md prints it on the step line.
   *
   * The attachment is fail-closed: a null id, an unknown id, an action without
   * a recorded receipt, or an action that is NOT the most recently settled one
   * is refused and recorded as a recording issue instead of silently tagging
   * the wrong action.
   */
  recordScrollProofRefusal(ownerId, actionId, refusal) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0) return;
    const refuse = (issue) => {
      trajectory.recordingIssues.push(issue);
      const recorded = actionId === null ? void 0 : trajectory.actionById.get(actionId);
      if (recorded !== void 0) recorded.recordingIssue = issue;
      this.#recordingError(trajectory, "settle", issue, actionId);
    };
    if (actionId === null) {
      refuse("scroll-proof refusal could not be recorded: the session core did not pass the recorded action id");
      return;
    }
    const action = trajectory.actionById.get(actionId);
    if (action === void 0) {
      refuse('scroll-proof refusal could not be recorded: unknown action id "' + actionId + '"');
      return;
    }
    if (action.receipt === null) {
      refuse('scroll-proof refusal could not be recorded: action "' + actionId + '" has no recorded receipt');
      return;
    }
    if (trajectory.lastSettledActionId !== actionId) {
      refuse('scroll-proof refusal could not be recorded: action "' + actionId + '" is not the most recently settled action');
      return;
    }
    try {
      action.scrollProofRefusal = cloneRedacted(refusal).value;
    } catch (error) {
      refuse("scroll-proof refusal recording failed: " + safeReason(error));
    }
  }
  /**
   * QA-BL-067: the scoped proof attempt for the named action was REFUSED by
   * the driver — a HANDLED refusal (disclosed as escalationRefused, never a
   * recording failure) — and the session core fell back to the whole-page
   * proof read. The refused attempt's failed observation therefore cleared
   * the settle-window state: re-arm it so the FALLBACK settle binds exactly
   * this action's proof (pendingActionId -> first observation -> settle), and
   * clear the handled refusal from the action's own issue marker so the
   * exporter never excludes the action over it.
   */
  rearmSettleWindowAfterScopedProofFallback(ownerId, actionId) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0 || actionId === null) return;
    const action = trajectory.actionById.get(actionId);
    if (action === void 0) return;
    if (action.recordingIssue !== null && action.recordingIssue.startsWith("fresh observation failed:")) {
      action.recordingIssue = null;
    }
    trajectory.pendingActionId = actionId;
    trajectory.settlingActionId = null;
  }
  /** Passive: persist the session's resolved settle policy for meta.settle export. */
  recordSettlePolicy(ownerId, policy) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0) return;
    try {
      trajectory.settlePolicy = cloneRedacted(policy).value;
    } catch {
    }
  }
  /**
   * Record one deterministic qa_assert decision (QA-BL-066). The binding is
   * IDENTICAL for scoped and unscoped assertions: the tool layer calls this
   * AFTER the decision completed, when the last recorded observation IS the
   * deciding observation (the settle polls, the one bounded escalation, and
   * the terminal probed coverage read all record through the session core in
   * the same flow), and the baseline is the latest recorded WHOLE-PAGE
   * observation — the QA-BL-054 durability gate needs whole-page uniqueness,
   * which a scoped observation can never prove. Recording is passive: no
   * trajectory (or a failed record) never changes the tool result.
   */
  assertion(ownerId, assertion, passed) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0) return;
    try {
      const safeAssertion = cloneRedacted(assertion).value;
      const recorded = {
        assertion: safeAssertion,
        passed,
        actionId: trajectory.lastSettledActionId,
        decidingObservationId: trajectory.lastObservationId,
        baselineObservationId: trajectory.lastWholePageObservationId
      };
      trajectory.assertions.push(recorded);
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: (/* @__PURE__ */ new Date()).toISOString(),
        kind: "assertion",
        assertion: recorded.assertion,
        passed: recorded.passed,
        actionId: recorded.actionId,
        decidingObservationId: recorded.decidingObservationId,
        baselineObservationId: recorded.baselineObservationId
      });
    } catch (error) {
      const issue = "assertion recording failed: " + safeReason(error);
      trajectory.recordingIssues.push(issue);
      this.#recordingError(trajectory, "observation", issue, null);
    }
  }
  observationFailed(ownerId, error) {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === void 0) return;
    const actionId = trajectory.pendingActionId ?? trajectory.settlingActionId;
    const issue = "fresh observation failed: " + safeReason(error);
    trajectory.recordingIssues.push(issue);
    trajectory.pendingActionId = null;
    trajectory.settlingActionId = null;
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
      windowTitle: trajectory.windowTitle,
      deviceId: trajectory.deviceId,
      events: trajectory.events,
      observations,
      actions: trajectory.actions,
      assertions: trajectory.assertions,
      evidenceReferences: trajectory.evidenceReferences,
      visualFindings,
      recordingIssues: trajectory.recordingIssues,
      settlePolicy: trajectory.settlePolicy
    });
  }
  clear() {
    this.#trajectories.clear();
  }
  #aliasAction(trajectory, action) {
    if (action.kind === "navigate") return { kind: "navigate", url: projectReplayUrl(action.url) };
    if (action.kind === "scroll") {
      if ("ref" in action && "direction" in action) {
        return {
          kind: "scroll",
          ref: this.#refAlias(trajectory, action.ref),
          direction: action.direction,
          ...action.amount === void 0 ? {} : { amount: action.amount }
        };
      }
      if ("ref" in action) return { kind: "scroll", ref: this.#refAlias(trajectory, action.ref) };
      return {
        kind: "scroll",
        direction: action.direction,
        ...action.amount === void 0 ? {} : { amount: action.amount }
      };
    }
    if (action.kind === "visual_click") {
      return {
        kind: "visual_click",
        targetDescription: action.targetDescription,
        observationId: action.observationId,
        captureSha256: action.captureSha256,
        point: { ...action.point },
        ...action.grounding === void 0 ? {} : { grounding: { ...action.grounding } }
      };
    }
    if (action.kind === "visual_drag") {
      return {
        kind: "visual_drag",
        targetDescription: action.targetDescription,
        toDescription: action.toDescription,
        observationId: action.observationId,
        captureSha256: action.captureSha256,
        point: { ...action.point },
        to: { ...action.to },
        ...action.grounding === void 0 ? {} : { grounding: { ...action.grounding } }
      };
    }
    if (action.kind === "visual_scroll") {
      return {
        kind: "visual_scroll",
        targetDescription: action.targetDescription,
        observationId: action.observationId,
        captureSha256: action.captureSha256,
        point: { ...action.point },
        direction: action.direction,
        ...action.amount === void 0 ? {} : { amount: action.amount },
        ...action.grounding === void 0 ? {} : { grounding: { ...action.grounding } }
      };
    }
    const ref = this.#refAlias(trajectory, action.ref);
    if (action.kind === "click") return { kind: "click", ref };
    if (action.kind === "fill") return { kind: "fill", ref, text: action.text };
    if (action.kind === "press") return { kind: "press", ref, key: action.key };
    if (action.kind === "focus") return { kind: "focus", ref };
    if (action.kind === "type") return { kind: "type", ref, text: action.text };
    if (action.kind === "select") return { kind: "select", ref, option: action.option };
    if (action.kind === "hover") return { kind: "hover", ref };
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
        ref: this.#refAlias(trajectory, node.ref),
        // QA-BL-062: parentRef names another node of the SAME observation, so
        // it must be aliased through the SAME deterministic map — otherwise
        // the recorded parentRef chains point at raw driver refs while node
        // refs are aliased, and the exporter's ancestry walk (scope.path)
        // could never resolve a single hop. Aliasing both sides keeps the
        // RELATIONSHIPS intact and still hides session-local identity.
        ...node.parentRef === null || node.parentRef === void 0 ? {} : { parentRef: this.#refAlias(trajectory, node.parentRef) }
      })),
      // A scoped observation's root refs are driver refs like every node ref:
      // alias them so no session-local identity ever enters the trajectory.
      // role/name/tag pass through and are what export records as the scope.
      ...observation.scope === void 0 ? {} : {
        scope: {
          ...observation.scope,
          ref: this.#refAlias(trajectory, observation.scope.ref),
          ...typeof observation.scope.rootRef === "string" && observation.scope.rootRef !== "" ? { rootRef: this.#refAlias(trajectory, observation.scope.rootRef) } : {}
        }
      },
      // The identity anchor's ref names the anchored node of the SAME
      // observation: alias it too (export reads only its truth, never the raw
      // ref, but the trajectory must not leak session-local identity).
      ...observation.anchor === void 0 ? {} : {
        anchor: {
          ...observation.anchor,
          ...observation.anchor.ref === null ? {} : { ref: this.#refAlias(trajectory, observation.anchor.ref) }
        }
      }
    };
  }
  #refAlias(trajectory, rawRef) {
    const digest = createHash4("sha256").update(trajectory.salt).update(rawRef).digest("hex");
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
      windowTitle: null,
      deviceId: null,
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
      pendingActionId: null,
      settlingActionId: null,
      lastSettledActionId: null,
      settlePolicy: null,
      assertions: [],
      lastWholePageObservationId: null
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
      return actionId === null ? receipt : { ...receipt, actionId };
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
  /** Passive: binds the SETTLED observation as the pending action's proof. */
  noteSettle(ownerId, report) {
    this.#safe(() => this.#recorder.settle(ownerId, report));
  }
  /**
   * Passive: re-binds EXACTLY the named recorded action's proof to the
   * escalated observation the session core just accepted (see QaSession.act).
   * Its presence on this adapter is the capability gate the session core
   * checks before taking the ONE bounded scroll-proof escalation.
   */
  noteEscalatedScrollProof(ownerId, actionId) {
    this.#safe(() => this.#recorder.bindEscalatedScrollProof(ownerId, actionId));
  }
  /**
   * Passive (QA-BL-067): attaches the FINAL record-time proof refusal to
   * exactly the named recorded action, so export carries it on the step and
   * report.md prints it on the step line. Recording can never alter session
   * behavior.
   */
  noteScrollProofRefusal(ownerId, actionId, refusal) {
    this.#safe(() => this.#recorder.recordScrollProofRefusal(ownerId, actionId, refusal));
  }
  /**
   * Passive (QA-BL-067): re-arms the settle-window state after a REFUSED
   * scoped proof attempt so the fallback whole-page settle binds exactly this
   * action's proof. Recording can never alter session behavior.
   */
  noteScopedProofFallback(ownerId, actionId) {
    this.#safe(() => this.#recorder.rearmSettleWindowAfterScopedProofFallback(ownerId, actionId));
  }
  /** Passive: persists the session's resolved settle policy for meta.settle export. */
  noteSettlePolicy(ownerId, policy) {
    this.#safe(() => this.#recorder.recordSettlePolicy(ownerId, policy));
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
function completenessLine(completeness) {
  const reasons = completeness.truncationReasons;
  const hidden = completeness.hiddenMatches === void 0 ? "" : ", hidden semantic-selector candidates excluded: " + String(completeness.hiddenMatches) + (completeness.hiddenMatchesPartial === true ? " (lower bound)" : "");
  return (completeness.reason === void 0 ? "" : completeness.reason + " \u2014 ") + (completeness.scope === void 0 ? "" : "scope: " + completeness.scope.role + ' "' + completeness.scope.name + '", ') + "view truncated: " + String(completeness.truncated) + ", applied node budget: " + (completeness.nodeBudget === null ? "not reported by the driver" : String(completeness.nodeBudget)) + ", truncation reasons: " + (reasons === void 0 || reasons.length === 0 ? "not reported by the driver" : reasons.join(", ")) + hidden + ", budget escalated: " + String(completeness.escalated) + ", outcome depends on a complete view: " + String(completeness.outcomeDependsOnCompleteView) + ". " + completeness.detail;
}
var NEWLINE_MARK = "\u23CE";
function collapseLineTerminators(text) {
  return text.replace(/\r\n/gu, "\n").replace(/[\r\n\u000B\u000C\u0085\u2028\u2029]/gu, NEWLINE_MARK);
}
function escapeMarkdownInline(text) {
  let out = collapseLineTerminators(text);
  out = out.replace(/\*\*/gu, "\\*\\*");
  out = out.replace(/`/gu, "\\`");
  out = out.replace(/^(\s*)([-+])(?=\s|$)/u, "$1\\$2");
  out = out.replace(/^(\s*)(#{1,6})(?=\s|$)/u, "$1\\$2");
  out = out.replace(/^(\s*)(\d+)([.)])(?=\s|$)/u, "$1$2\\$3");
  out = out.replace(/&/gu, "&amp;");
  out = out.replace(/</gu, "&lt;");
  out = out.replace(/>/gu, "&gt;");
  out = out.replace(/javascript:/giu, "javascript&#58;");
  out = out.replace(/\]\(/gu, "]\\(");
  out = out.replace(/\[/gu, "\\[");
  out = out.replace(/\]/gu, "\\]");
  out = out.replace(/\\\[REDACTED\\\](?!\()/gu, "[REDACTED]");
  out = out.replace(/\\\[REDACTED_URL\\\](?!\()/gu, "[REDACTED_URL]");
  return out;
}
function fencedCode(text) {
  const flat = collapseLineTerminators(text);
  let maxRun = 0;
  for (const match of flat.matchAll(/`+/gu)) {
    if (match[0].length > maxRun) maxRun = match[0].length;
  }
  const fence = TICK2.repeat(maxRun + 1);
  return fence + flat + fence;
}
function isEvidenceCollectionFailure(value) {
  return value !== null && value.status === "collection-failed";
}
function renderReportMarkdown(report, roots) {
  const redact = (text) => escapeLoneSurrogates(redactText(text, roots));
  const mdInline = (text) => escapeMarkdownInline(redact(text));
  const mdCode = (text) => fencedCode(redact(text));
  const mdPath = (path2) => fencedCode(escapeLoneSurrogates(path2));
  const lines = [];
  lines.push("# QA Replay: " + mdInline(report.scenario));
  lines.push("");
  lines.push("- **Status**: " + mdInline(report.status));
  lines.push("- **Driver**: " + mdInline(report.driver));
  lines.push("- **Schema**: " + String(report.schemaVersion));
  lines.push("- **Started**: " + mdInline(report.startedAt));
  lines.push("- **Finished**: " + mdInline(report.finishedAt));
  const receipts = report.receiptSummary;
  lines.push("- **Receipts**: " + String(receipts.confirmed) + " confirmed, " + String(receipts.unknown) + " unknown, " + String(receipts.rejected) + " rejected, " + String(receipts.failed) + " failed");
  if (receipts.warning !== void 0) {
    lines.push("- **Warning**: " + mdInline(receipts.warning));
  }
  if (report.settle !== void 0) {
    const settle = report.settle;
    lines.push(
      "- **Settle policy**: budget " + String(settle.budgetMs) + "ms, quiet " + String(settle.quietMs) + "ms, post-change quiet " + String(settle.postChangeQuietMs) + "ms, interval " + String(settle.intervalMs) + "ms, adaptive " + String(settle.adaptiveBudgetMs) + "ms"
    );
  }
  if (report.settleWidened !== void 0) {
    const widened = report.settleWidened;
    const at = widened.at === "initial" ? "initial" : widened.at === "final" ? "final" : "step " + String(widened.at);
    lines.push(
      "- **Settle widened**: " + String(widened.fromMs) + "ms \u2192 " + String(widened.toMs) + "ms at " + at + " (" + widened.cause + ")"
    );
  }
  lines.push("");
  lines.push("## Steps");
  if (report.steps.length === 0) lines.push("- (none)");
  for (const step of report.steps) {
    const mark = step.status === "pass" ? "PASS" : step.status === "inconclusive" ? "INCONCLUSIVE" : "FAIL";
    lines.push("- [" + mark + "] step " + String(step.index) + ": " + mdInline(step.intent));
    lines.push("  - action: " + mdCode(inline(step.action, roots)));
    lines.push("  - receipt: " + mdInline(step.receipt === null ? "none" : step.receipt.status));
    lines.push("  - outcome: " + mdInline(step.outcome));
    lines.push(
      "  - assertion: " + mdInline(step.assertion.kind) + " -> " + (step.assertionPassed ? "PASS" : step.status === "inconclusive" ? "INCONCLUSIVE" : "FAIL")
    );
    lines.push("  - observed: " + mdCode(inline(step.observed, roots)));
    if (step.attempts !== void 0) {
      lines.push("  - assertion retries: " + String(step.attempts) + " attempt(s) over " + String(step.elapsedMs ?? 0) + "ms");
    }
    if (step.reason !== void 0) {
      lines.push("  - reason: " + mdInline(step.reason));
    }
    if (step.scopeResolution !== void 0) {
      lines.push("  - scope resolution: " + mdInline(step.scopeResolution));
    }
    if (step.scopeLevels !== void 0) {
      lines.push("  - scope levels: " + mdInline(step.scopeLevels.map((level) => "level " + String(level.level) + " (" + level.what + "): " + level.resolution).join("; ")));
    }
    if (step.scopeNotLocated === true) {
      lines.push("  - scope not located: " + mdInline(
        "the container could not be located in the truncated view; it may exist outside the returned window"
      ));
    }
    if (step.scopeRefusal !== void 0) {
      lines.push("  - scope refusal: " + mdInline(step.scopeRefusal.reason));
    }
    if (step.escalationRefused !== void 0) {
      lines.push(
        "  - proof escalation refusal: " + mdInline(step.escalationRefused.reason) + (step.escalationRefused.code === void 0 ? "" : " (" + step.escalationRefused.code + ")")
      );
    }
    if (step.targetResolution !== void 0) {
      lines.push(
        "  - target resolution: " + mdInline(
          step.targetResolution.mode + ' (recorded role "' + step.targetResolution.recordedRole + '", observed role "' + step.targetResolution.observedRole + '")'
        )
      );
    }
    if (step.targetChangedRetries !== void 0) {
      lines.push(
        "  - target changed retries: " + String(step.targetChangedRetries) + " \u2014 " + mdInline(
          "the driver refused with TARGET_CHANGED (the page replaced or renamed the bound element between resolution and its use) " + String(step.targetChangedRetries) + " time(s); the runner re-observed, re-resolved the same semantic target (at dispatch, or from the level above on a path-walk within read), and re-tried within the settle budget"
        )
      );
    }
    if (step.scopeIdentityRefusal !== void 0) {
      const refusal = step.scopeIdentityRefusal;
      lines.push(
        "  - scope identity refusal: " + mdInline(
          "the within read at path level " + String(refusal.level) + " (" + refusal.what + ") was refused " + refusal.code + (refusal.changed === void 0 ? "" : " with changed " + JSON.stringify(refusal.changed)) + (refusal.reason === void 0 ? "" : " \u2014 " + refusal.reason)
        )
      );
    }
    if (step.scopeNameChanged === true) {
      lines.push(
        "  - scope name changed: " + mdInline(
          "a scoped read resolved a content-named container whose aggregated accessible name changed since the parent read (the driver reported scope.nameChanged informationally)"
        )
      );
    }
    if (step.message !== void 0) {
      lines.push("  - message: " + mdInline(step.message));
    }
    if (step.completeness !== void 0) {
      lines.push("  - view completeness: " + mdInline(completenessLine(step.completeness)));
    }
  }
  lines.push("");
  lines.push("## Final assertions");
  if (report.assertions.length === 0) lines.push("- (none)");
  for (const assertion of report.assertions) {
    lines.push(
      "- " + mdInline(assertion.kind) + " -> " + (assertion.passed ? "PASS" : assertion.reason === QA_INCONCLUSIVE_SCOPE || assertion.reason === QA_INCONCLUSIVE_UNSTABLE || assertion.scopeNotLocated === true ? "INCONCLUSIVE" : "FAIL") + " (observed: " + mdCode(inline(assertion.observed, roots)) + ")"
    );
    if (assertion.attempts !== void 0) {
      lines.push("  - assertion retries: " + String(assertion.attempts) + " attempt(s) over " + String(assertion.elapsedMs ?? 0) + "ms");
    }
    if (assertion.reason !== void 0) {
      lines.push("  - reason: " + mdInline(assertion.reason));
    }
    if (assertion.scope !== void 0) {
      lines.push("  - assertion scope: " + mdInline(assertion.scope.role + ' "' + assertion.scope.name + '"'));
    }
    if (assertion.scopeResolution !== void 0) {
      lines.push("  - scope resolution: " + mdInline(assertion.scopeResolution));
    }
    if (assertion.scopeLevels !== void 0) {
      lines.push("  - scope levels: " + mdInline(assertion.scopeLevels.map((level) => "level " + String(level.level) + " (" + level.what + "): " + level.resolution).join("; ")));
    }
    if (assertion.scopeNotLocated === true) {
      lines.push("  - scope not located: " + mdInline(
        "the container could not be located in the truncated view; it may exist outside the returned window"
      ));
    }
    if (assertion.scopeRefusal !== void 0) {
      lines.push("  - scope refusal: " + mdInline(assertion.scopeRefusal.reason));
    }
    if (assertion.scopeIdentityRefusal !== void 0) {
      const refusal = assertion.scopeIdentityRefusal;
      lines.push(
        "  - scope identity refusal: " + mdInline(
          "the within read at path level " + String(refusal.level) + " (" + refusal.what + ") was refused " + refusal.code + (refusal.changed === void 0 ? "" : " with changed " + JSON.stringify(refusal.changed)) + (refusal.reason === void 0 ? "" : " \u2014 " + refusal.reason)
        )
      );
    }
    if (assertion.scopeNameChanged === true) {
      lines.push(
        "  - scope name changed: " + mdInline(
          "a scoped read resolved a content-named container whose aggregated accessible name changed since the parent read (the driver reported scope.nameChanged informationally)"
        )
      );
    }
    if (assertion.targetChangedRetries !== void 0) {
      lines.push(
        "  - target changed retries: " + String(assertion.targetChangedRetries) + " \u2014 " + mdInline(
          "the driver refused a within read of the scoped path walk with TARGET_CHANGED " + String(assertion.targetChangedRetries) + " time(s); the runner re-observed and re-resolved from the level above within the settle budget"
        )
      );
    }
    if (assertion.message !== void 0) {
      lines.push("  - message: " + mdInline(assertion.message));
    }
    if (assertion.completeness !== void 0) {
      lines.push("  - view completeness: " + mdInline(completenessLine(assertion.completeness)));
    }
  }
  if (report.advisory !== void 0 && report.advisory.length > 0) {
    lines.push("");
    lines.push("## Advisory (model-generated; never affects pass/fail)");
    lines.push("");
    lines.push(
      'Model-generated output from the host vision model. Trust **verdict** and **confidence**; every "model narration" block below is UNVERIFIED model narration that may contain fabricated detail and must never be quoted as observed fact.'
    );
    lines.push("");
    for (const item of report.advisory) {
      lines.push("- question: " + mdInline(item.question));
      lines.push("  - verdict: " + mdInline(item.verdict) + " (confidence " + String(item.confidence) + ")");
      if (item.captureSettled === false) {
        lines.push("  - capture settled: false (the advisory verdict is over a view that never stopped changing within the settle budget)");
      }
      lines.push("  - model narration (unverified; may contain fabricated detail):");
      const narration = redact(item.reasoning);
      for (const line of narration === "" ? ["(none)"] : narration.split("\n")) {
        lines.push("    > " + escapeMarkdownInline(line));
      }
      if (item.reason !== void 0) lines.push("  - reason: " + mdInline(item.reason));
      if (item.artifact !== void 0) {
        const projectedPath = projectArtifactPath2(item.artifact.path, roots);
        lines.push("  - artifact: " + mdPath(projectedPath));
      }
    }
  }
  if (report.failure !== void 0) {
    lines.push("");
    lines.push("## Failure");
    lines.push("- step: " + (report.failure.stepIndex === null ? "final assertion" : String(report.failure.stepIndex)));
    lines.push("- message: " + mdInline(report.failure.message));
    if (report.failure.code !== void 0) {
      lines.push("- code: " + mdInline(report.failure.code));
    }
    lines.push("- reproduction: " + String(report.failure.reproduction.length) + " step(s)");
  }
  if (report.evidence !== null) {
    lines.push("");
    lines.push("## Evidence");
    const evidence = report.evidence;
    if (isEvidenceCollectionFailure(evidence)) {
      lines.push("- collection: failed (" + mdInline(evidence.reason) + ")");
    } else {
      lines.push("- console: " + String(evidence.console.length) + " record(s)");
      lines.push("- network: " + String(evidence.network.length) + " record(s)");
      lines.push("- bounded: " + String(evidence.bounded));
      if (evidence.dropped !== void 0) {
        lines.push("- dropped: console " + String(evidence.dropped.console) + ", network " + String(evidence.dropped.network));
      }
      if (evidence.computer !== void 0) {
        const computer = evidence.computer;
        lines.push("- computer helper: " + mdInline(computer.status.helper) + " (platform " + mdInline(computer.status.platform) + ")");
        if (computer.receiptsTotal === null) {
          lines.push("- receipt counters: unavailable (" + mdInline(computer.receiptsCountersUnavailableReason ?? "unknown") + ")");
        } else {
          lines.push("- receipts: " + String(computer.receiptsReturned) + " returned (of " + String(computer.receiptsTotal) + " total; " + String(computer.receiptsDropped) + " dropped by the bounded ring)");
        }
      }
    }
  }
  if (report.artifacts !== void 0 && report.artifacts.length > 0) {
    lines.push("");
    lines.push("## Artifacts");
    for (const artifact of report.artifacts) {
      const projectedPath = projectArtifactPath2(artifact.path, roots);
      lines.push("- " + mdInline(artifact.kind) + ": " + mdPath(projectedPath));
    }
  }
  lines.push("");
  return lines.join("\n");
}

// src/reporters/write.ts
import { mkdir as mkdir2, appendFile as appendFile2, writeFile as writeFile3 } from "node:fs/promises";
import { join as join6 } from "node:path";
async function writeReports(report, options) {
  await mkdir2(options.directory, { recursive: true });
  const jsonPath = join6(options.directory, "report.json");
  const markdownPath = join6(options.directory, "report.md");
  const jsonlPath = options.jsonlPath ?? join6(options.directory, "report.jsonl");
  await writeFile3(jsonPath, renderReportJson(report, options.roots), "utf8");
  await writeFile3(markdownPath, renderReportMarkdown(report, options.roots), "utf8");
  await appendFile2(jsonlPath, renderReportJsonl(report, options.roots), "utf8");
  return { json: jsonPath, markdown: markdownPath, jsonl: jsonlPath };
}

// src/index.ts
init_loginState();

// src/tools.ts
init_browser();
init_computer();
init_loadBrowser();
init_loadComputer();
init_loadAndroid();
init_loadIos();
import { tmpdir as tmpdir5 } from "node:os";
import { join as join7 } from "node:path";

// src/tool-descriptions.ts
var QA_TOOL_DESCRIPTIONS = {
  qa_session_start: "Start one QA session for this agent scope. Choose a browser, computer, ios, or android driver; the chosen driver is bound to the owner for the session and loaded lazily on first use. Browser sessions accept an optional login_state: OWNER-AUTHORIZED, SCOPED, READ-ONLY login-state injection from an explicit Playwright storageState JSON file. Only entries whose origin/domain exactly matches the authorized origins are injected into a FRESH ephemeral profile (destroyed on stop); entries outside the list are never loaded, and a file that fails to parse, has no authorized entries, or holds unclassifiable entries fails the start. login_state is browser-only. iOS sessions use bundle_id with an explicit device_id (simulator/physical UDID); Android sessions use package_name with an explicit device_id (serial), and accept bundle_id as a package alias. There is NO default first mobile device: qa_session_start refuses to guess a connected device when device_id is omitted. The driver packages load lazily, so tool listing works without them. settle_budget_ms / settle_quiet_ms widen the settle policy for a heavy site (clamped: budgetMs <= 15000, quietMs <= budget); settle_adaptive_budget_ms sets the once-per-session widening budget (clamped to [budgetMs, 15000], 0 disables adaptation). The session's effective policy is what qa_record_export records into the scenario's meta.settle.",
  qa_observe: `Return a bounded semantic view of the current app/page, taken after a bounded settle (observe until the semantic view holds still for a quiet window, bounded by a budget). Interactive nodes carry opaque session-local refs; observe again after every action. The result carries settle.stable and settle.widened: when the view is still changing at the budget, the session widens the budget ONCE (settle.widened) instead of returning stable:false; when it is still false after widening the page never stopped changing and nothing in that view proves anything \u2014 wait for the page to stop changing and re-observe. The observation also reports the node budget the DRIVER actually applied (each driver clamps the request to its own maximum: browser 100, computer 500) and truncationReasons naming why a truncated view is partial (node-budget-exceeded, scan-window-exceeded, iframe-not-traversed, ...): never assume a requested max_nodes widened the view. The projection is of OBSERVABLE semantic nodes only: hidden and zero-rect elements are excluded, so node-absent means "no driver-observable node", never "not in the DOM". within_ref (browser-only, driver contract v8) restricts the observation to the composed subtree rooted at that element: an opaque ref from the caller's CURRENT (latest, unexpired) qa_observe result. Budgets, the byte ceiling, the scan window, and the iframe marker become SUBTREE-relative, so a subtree that fits reports truncated:false with no truncationReasons \u2014 which makes a deep target unreachable in the whole-page window reachable. ABSENCE PASSES: node-absent can pass ONLY when the deciding observation carries coverage.verified: true (driver contract v9, Phase C) \u2014 the terminal absence decision requests the bounded coverage probe on its ONE deciding re-observation (never on settle polls; ~5ms scoped, possibly over-budget whole-page on very large pages, and then the absence is UNPROVEN). A probe that finds closed shadow roots or does not complete fails the absence closed with INCONCLUSIVE_TRUNCATED / COVERAGE_UNVERIFIED naming the driver reason. The result's scope field ({ ref, rootRef, role, name, tag }) echoes the root the driver observed (rootRef is the fresh per-observation ref that chains the next scoped read); it is absent for whole-page observations. An unknown, expired, consumed, non-element, or detached within_ref REFUSES the call with its driver code (REF_UNKNOWN / REF_EXPIRED / TARGET_CHANGED / ...) \u2014 never a whole-page fallback and never a 'not found'. The computer driver does not support scoping: a within_ref there is refused.`,
  qa_act: "Perform exactly one action. Browser verbs: click/fill/press/navigate/scroll/select/hover. Computer verbs: click/focus/type/key/scroll. Mobile verbs are adapter-honest: click, direction scroll, and device keys are supported. iOS fill/type are routed only through native element-bound text primitives when the live driver exposes them (typeTarget append / fillTarget replace); missing driver methods or missing native identifiers stay explicitly unavailable, and there is no focused/global-type fallback. Android type remains append-faithful only after real focus verification, and Android fill remains FILL_PRIMITIVE_UNAVAILABLE because no safe replace primitive exists (never aliased to append-only backend.type). scroll (browser) takes ref (scroll-into-view) or direction plus an optional amount (viewport page scroll); scroll (computer) takes ref plus direction and an optional amount; select takes ref+option; hover takes ref. click/fill/press/focus/type/key/select/hover require a ref from the latest qa_observe. The session core echo-masks the action's own value write on its target (fill/type/select by the written value, key/press on a uniquely identified target, including a fill that rewrites the target's accessible name), so the fresh settled observation waits for a downstream consequence instead of concluding on the action's own echo. The result is the receipt plus that fresh settled observation: when the view is still changing at the budget, the session widens the budget ONCE (settle.widened) before giving up; when settle.stable is still false the consequence is UNPROVEN \u2014 the result adds proven:false and code INCONCLUSIVE_UNSTABLE, the receipt still describes the dispatch honestly, and nothing in that unstable view is attributable to the action (wait for the page to stop changing, re-observe, then assert). When the acted ref came from a SCOPED baseline (a qa_observe with within_ref), the proof settle is taken INSIDE that scope instead (withinRef: the baseline scope.rootRef plus anchorLastAction:true, re-keyed per poll to the driver's fresh rootRef), and the scoped proof is ACCEPTED only when the window settled AND the driver's identity anchor reports the ORIGINAL acted element connected, contained in that container, and emitted with a fresh ref whose node is in the viewport \u2014 identity from the anchor, never from matching role/name/tag; on acceptance the result adds proofScope: { role, name } plus anchor (no escalation happened, so no proofEscalated) and export carries the scope (provisional at replay on long pages). On driver >= d069f4f the dispatched action RETAINS the consumed scope root (contract v9), so the scoped proof read RESOLVES through it: the FIRST poll is keyed by the EXPLICIT baseline scope.rootRef (never 'last-scope', so a stale baseline is refused instead of silently rebinding to whatever root was last acted and judging containment against the wrong container), then the loop re-keys each later poll to the fresh rootRef that poll minted \u2014 the scroll is PROVEN inside that scope. When the driver refuses the root (a pre-retention driver, the acted ref IS the scope root itself \u2014 the single-owner handle is never retained, while the anchor still works \u2014 or a released retention after navigation: OBSERVATION_REQUIRED / SCOPE_UNAVAILABLE), the refusal is disclosed and the proof falls back to the whole-page read. A browser scroll-by-ref whose settled proof view is truncated and still lacks the target in the viewport is re-read ONCE at the driver's maximum node budget (record time, Explore recording only, side-effect-free: it never widens the settle budget or changes the session baseline). The escalation prefers an identity-anchored SCOPED read rooted at the target's nearest container-role ANCESTOR (walked on the target's parentRef chain in the baseline, contract v9), re-keyed into the settled view and accepted ONLY when the driver's identity anchor reports the ORIGINAL acted element connected, contained in that container, and in the viewport \u2014 identity comes from the anchor, never from matching role/name/tag; refusals (ANCHOR_UNAVAILABLE, connected:false, contained:false) are disclosed as escalationRefused and the settled observation stays. With no container ancestor (or an un-re-keyable one) the escalation is the WHOLE-PAGE read; when that escalated view settled AND extends the settled one AND returns the target inViewport, the result adds proofEscalated:true plus the escalated window's report in escalatedSettle (the action's own window stays under settle). EVERY non-acceptance exit is disclosed as escalationRefused: { reason, code? } with a FIXED vocabulary \u2014 target-not-in-baseline, container-not-in-view, escalated-window-unstable, target-not-returned, target-not-in-viewport, anchor-not-connected, anchor-not-contained, anchor-unavailable \u2014 plus the driver's code when it threw; already-in-viewport is NOT a refusal (the result then simply has no escalation fields). When both the scoped proof read and the escalation were refused, the escalation's refusal is the one disclosed (the more terminal truth). Fail-closed either way: the proof stays the settled observation, and the refusal rides on the exported step so report.md prints it on the step line. CU v5 visual fallback verbs are visual_click / visual_drag / visual_scroll (computer-only). They require target_description; textual grounding captures a fresh settled observation and routes through the injected llm/attachments seam. The point route instead accepts capture_sha256 + observation_id + point from qa_evidence visual (plus to for drag, direction/amount for scroll) and converts those image coordinates to native pixels using stored trusted capture metadata \u2014 never a model-supplied scale. Every visual action requires host approval; when no host approval service is available the driver rejects explicitly, never implicitly allows.",
  qa_assert: `Evaluate one assertion against a fresh SETTLED observation (observe until the semantic view holds still for a quiet window, bounded by a budget; the result carries settle.stable and settle.widened \u2014 the once-per-session budget widening ({fromMs, toMs, cause}, cause "unstable" for a churning settle window or "assertion-retry" for a retry that exhausted its budget, or null). An assertion is NEVER proven from an unstable view: when settle.stable is false the result is passed:false with inconclusive:true and code INCONCLUSIVE_UNSTABLE (the same honest non-result vocabulary as INCONCLUSIVE_TRUNCATED) \u2014 wait for the page to stop changing, then re-observe. node-present/node-absent/node-in-viewport/page-url/node-value are deterministic. node-present/node-value/node-in-viewport/page-url are POSITIVE existence assertions: when the first settled decision is "not found" they are re-observed within the settle budget (bounded retry \u2014 the node may simply be slow to render) and the result records attempts/elapsedMs; a found node is sound on any view. When the retry exhausts its budget without finding the target, it widens the settle budget ONCE through the same once-per-session gate (cause "assertion-retry") and keeps retrying until the adaptive budget, so a node slower than the budget is still found. node-absent is never retried into a pass (absence is never proven by waiting). node-value matches a node by the usual predicate AND asserts its exact value (expected: { role?, name?, tag?, value }); it proves a fill/type by the value on its own target. The predicate must identify EXACTLY ONE node \u2014 a duplicate target fails closed with TARGET_NOT_UNIQUE (a twin already holding the value proves nothing) \u2014 and a valueWithheld/secure/valueTruncated node can NEVER satisfy it (VALUE_WITHHELD/VALUE_SECURE/VALUE_TRUNCATED). kind "visual" takes its own fresh settled observation, captures the current screen from it, and asks the host vision model a question, so it works directly after qa_act or qa_evidence with no separate qa_observe. Its ADVISORY verdict (yes/no/unclear with confidence) never changes pass/fail: trust verdict and confidence, and treat the accompanying reasoning as unverified model narration (reasoningTrust "unverified-model-narration") that may contain fabricated detail and must never be quoted as observed fact. Without a mounted vision model the visual verdict degrades to "unclear" with reason "vision-model-unavailable". A truncated view that still cannot prove the assertion fails closed with completeness.reason INCONCLUSIVE_TRUNCATED; completeness.nodeBudget is the budget the DRIVER actually applied (browser maximum 100, computer 500 \u2014 never the requested number) and completeness.truncationReasons names why the view is partial (iframe-not-traversed, scan-window-exceeded, node-budget-exceeded). When the driver already applied its maximum node budget, raising qa_observe max_nodes cannot help: narrow the page or region, or scroll the target into a smaller view. node-absent PASSES exactly when nothing matched AND the deciding view is complete (truncated:false) AND its coverage is verified (coverage.verified: true \u2014 the terminal absence decision requests the driver's bounded closed-shadow-root probe on its ONE deciding re-observation, never on settle polls; the probe costs ~5ms scoped and may be over-budget whole-page on very large pages, and then the absence is UNPROVEN). A probe that found closed shadow roots or did not complete keeps the result INCONCLUSIVE_TRUNCATED / COVERAGE_UNVERIFIED with the driver's reason in completeness.detail and truncationReasons; the PASS wording says "No driver-observable semantic node matching {predicate} was found within {scope|the whole page}; coverage verified (N nodes probed). K hidden candidates excluded." A returned matching node still fails node-absent normally. within_ref (browser-only, driver contract v8) decides the assertion INSIDE the composed subtree rooted at that element instead of the whole page: the deciding read is a fresh SETTLED scoped observation (its settle polls re-key the within ref to the driver's fresh scope.rootRef), so node-absent means "absent from that container" \u2014 the result's completeness.scope names it ({ role, name }), and the PASS wording says "within the {role} named "{name}"" \u2014 while calling WITHOUT within_ref keeps the whole-page decision (no completeness.scope). Every scoped rule applies: truncation and budgets become subtree-relative, the one bounded escalation and the terminal coverage probe stay INSIDE the scope, and a scoped node-absent passes only on a complete scoped view with coverage.verified:true. The ref must come from the session's LATEST observation: a container ref from the latest whole-page qa_observe, or the scope.rootRef (equally valid: any node ref) echoed by the immediately preceding scoped qa_observe. Every observe REPLACES the driver's current observation, so a ref from any EARLIER observation \u2014 including a whole-page container ref captured before an intervening scoped observe \u2014 no longer resolves: the driver refuses it (REF_UNKNOWN / REF_EXPIRED, or TARGET_CHANGED when the element detached, WITHIN_NOT_ELEMENT for a non-element), and qa_assert surfaces the refusal as { ok:false, code, error } \u2014 NEVER a silent whole-page decision. The computer driver refuses within_ref; kind "visual" does not take it.`,
  qa_evidence: 'Read bounded, redacted evidence: browser console/network records, or computer helper status plus bounded action receipts. Set visual: true to also capture the current screen (Set-of-Mark) and return its metadata plus a structured artifact path; that capture is taken from its own fresh settled observation, so it never requires a preceding qa_observe. The capture carries settle { stable, passes, budgetMs } and, when the view never settled, captureSettled:false \u2014 the same vocabulary as qa_assert kind:"visual". visual_fingerprint instead pins the capture to one exact browser observation and is deliberately NOT auto-refreshed, so a pinned observation that has gone stale fails by design. For a computer capture qa_evidence also records the exact native capture metadata (sha256, observation_id, nativeWidth/nativeHeight, and, when the host attachment route made the model-visible image, attachmentWidth/attachmentHeight plus coordinateSpace) so a later qa_act visual point route can convert image coordinates from the TRUSTED stored capture, never from the model.',
  qa_record_export: "Export this owner's redacted Explore trajectory as a fail-closed Replay scenario JSON file. Browser targets use durable role+accessible-name predicates; computer targets use role/name plus the Accessibility identifier; mobile targets prefer the stable Android resourceId / iOS AXUniqueId identifier and never persist coordinates/refs/PID. Only actions with durable targets and outcomes proven by immediate fresh observations become steps; exclusions are returned explicitly. Role drift on real pages (a server-rendered control replaced by a hydrated component rendering the same accessible name under a different role, e.g. Wikipedia's search input textbox -> combobox) makes the LIVE role a fragile identity, so an action target whose accessible name is non-empty and unique in the recorded baseline view is exported NAME-only with the live role as an advisory roleHint (accepted and ignored for matching); a name that is empty or not unique keeps the role+name form. The Explore session's effective settle policy is recorded in meta.settle when it differs from the defaults, so replay judges the page with the same budget.",
  qa_replay_run: `Run a deterministic Replay scenario file end to end and return a pass/inconclusive/fail/blocked report (three-state, QA-BL-062): pass requires every required step AND final assertion to be fully proven; inconclusive means at least one result is provisional and nothing definitely failed; fail is everything else. Browser, computer, iOS, and Android scenarios are supported; a mobile scenario uses its recorded target.deviceId unless the caller supplies device_id, which always wins. No default mobile device is ever selected. Positive existence assertions (node-present/node-value/node-in-viewport/page-url) are re-observed within the settle budget when first not found (a slow page), with attempts/elapsedMs recorded in the step result and report.md; node-absent is never retried into a pass. The scenario's meta.settle (the policy Explore recorded) is applied over env/host defaults, and report.json/report.md print the effective policy; replay also widens its settle budget ONCE (recorded as settleWidened, step index or 'initial') when adaptation is enabled: a settle window still churning at the budget (cause "unstable"), or a positive-existence assertion retry that exhausted its budget without finding its target (cause "assertion-retry"); settleWidened records the cause. A failure carries a machine failure.code for recognized non-results (INCONCLUSIVE_UNSTABLE for a view that never settled, TARGET_NOT_UNIQUE for an ambiguous action target), so prose never has to be parsed to tell them from an ordinary assertion failure. A SCOPED step whose container is resolved provisionally (one predicate/path match in a still-truncated whole-page view, incl. the exported scoped scroll proof on a page that can never complete) carries scopeResolution: "provisional" and reason INCONCLUSIVE_SCOPE \u2014 never passed:true \u2014 and the copied final assertion inherits it; the replayed scoped scroll is verified through the driver's identity anchor (anchorLastAction) and a lost binding or mismatch is disclosed as scopeRefusal, never a predicate reselect. "proven" (unique in a complete whole-page view) may pass. A recorded role+name ACTION target with zero matches in the deciding view falls back to a NAME-only match when exactly one node carries the same non-empty accessible name (role drift on real pages: server-rendered control -> hydrated component) and discloses targetResolution: { mode: "name-only", recordedRole, observedRole } on the step and in report.md; the fallback is refused, never guessed, when the name is empty or matches two or more nodes (TARGET_NOT_UNIQUE, "present under a different role: recorded X, observed Y"), and a zero-match failure otherwise says "absent from the returned window" (truncated, INCONCLUSIVE_TRUNCATED) or "absent from a complete view". A TARGET_CHANGED refusal at dispatch (identity staleness: the page replaced the bound element between resolution and dispatch, so NOTHING was dispatched) is retried WITHIN the settle budget \u2014 a fresh settled observation, a re-resolution of the SAME semantic target, and a re-dispatch, widening the budget ONCE through the shared session gate when the retry exhausts it (cause "assertion-retry", the same machinery the assertion retries use) \u2014 with the refusal count disclosed as targetChangedRetries on the step and in report.md; only TARGET_CHANGED is ever retried (every policy/safety refusal stays a hard stop with zero retries), and when the budget is exhausted with the target still changing identity the step is inconclusive with reason INCONCLUSIVE_UNSTABLE and the driver's last refusal receipt verbatim: "the target kept changing identity between resolution and dispatch for the whole settle budget (N retries): the page did not hold still, so the step is unproven" \u2014 never a failure. The same TARGET_CHANGED refusal on a within read of the scoped path walk (QA-BL-073: an ancestor changed identity between its parent read and the scoped read) runs the SAME bounded retry \u2014 re-resolving the level from the level above with a fresh settled read, counting into the same targetChangedRetries \u2014 and its exhaustion is the same inconclusive / INCONCLUSIVE_UNSTABLE classification with a message naming the level (path level N (what) kept changing identity, with the driver's changed/before/after verbatim as scopeIdentityRefusal); only TARGET_CHANGED is ever retried (policy refusals, REF_UNKNOWN, OBSERVATION_REQUIRED, SCOPE_UNAVAILABLE stay hard). A content-named container whose aggregated name changed between reads is never a refusal at all: the driver reports it informationally (scope.nameChanged) and the step records scopeNameChanged: true \u2014 informational, never a refusal.`,
  qa_session_stop: "Stop the QA session for this owner and release the bound driver scope. Idempotent when no session is running."
};

// src/tools.ts
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
async function loadMobileAdapterClass(kind) {
  const barrel = await Promise.resolve().then(() => (init_adapters(), adapters_exports));
  const exportName = kind === "ios" ? "IosAdapter" : "AndroidAdapter";
  const ctor = barrel[exportName];
  if (typeof ctor !== "function") {
    throw new Error("Cannot load the " + kind + " QA adapter: src/adapters/index.ts does not export " + exportName + " yet; the separate adapter worker must add it before Explore can use the " + kind + " driver.");
  }
  return ctor;
}
var QaToolHost = class {
  #managers = /* @__PURE__ */ new Map();
  #ownerDrivers = /* @__PURE__ */ new Map();
  #recorder = new QaTrajectoryRecorder();
  #options;
  #visualCaptures = new QaVisualCaptureStore();
  constructor(options = {}) {
    this.#options = options;
  }
  /**
   * The Explore trajectory recorder shared by every manager this host builds
   * (the same instance the recording adapter wraps the drivers with), so a
   * qa_assert decision recorded through it binds exactly the observations the
   * session core produced. Read-only accessor: trajectory recording stays
   * passive and can never alter session behavior.
   */
  get recorder() {
    return this.#recorder;
  }
  managerFor(driver) {
    let manager = this.#managers.get(driver);
    if (manager === void 0) {
      manager = (async () => {
        const sessionOptions = this.#sessionOptions();
        const adapterOverride = this.#options.managerAdapters?.[driver];
        if (adapterOverride !== void 0) {
          if (adapterOverride.kind !== driver) {
            throw new Error("manager adapter kind " + adapterOverride.kind + " does not match requested driver " + driver);
          }
          return new QaSessionManager(new RecordingQaDriverAdapter(adapterOverride, this.#recorder), sessionOptions);
        }
        if (driver === "browser") {
          const browserManager = await loadBrowserManager();
          const adapter2 = new BrowserAdapter(browserManager);
          return new QaSessionManager(new RecordingQaDriverAdapter(adapter2, this.#recorder), sessionOptions);
        }
        if (driver === "ios") {
          const backend = await loadIosBackend();
          const IosAdapter2 = await loadMobileAdapterClass("ios");
          const adapter2 = new IosAdapter2(backend);
          return new QaSessionManager(new RecordingQaDriverAdapter(adapter2, this.#recorder), sessionOptions);
        }
        if (driver === "android") {
          const backend = await loadAndroidBackend();
          const AndroidAdapter2 = await loadMobileAdapterClass("android");
          const adapter2 = new AndroidAdapter2(backend);
          return new QaSessionManager(new RecordingQaDriverAdapter(adapter2, this.#recorder), sessionOptions);
        }
        const computerDriver = await loadComputerDriver();
        const adapter = new ComputerAdapter(computerDriver);
        return new QaSessionManager(new RecordingQaDriverAdapter(adapter, this.#recorder), sessionOptions);
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
    return this.#options.capturesDir ?? join7(tmpdir5(), "dsh-qa-visual-captures");
  }
  /** Session options (settle policy) shared by every driver manager. */
  #sessionOptions() {
    return this.#options.settle === void 0 ? {} : { settle: this.#options.settle };
  }
  /** The settle policy qa_replay_run must reuse, so replay matches export. */
  settleOptions() {
    return this.#sessionOptions();
  }
  /** Injectable replay driver loaders, or undefined to use the real lazy loaders. */
  replayLoaders() {
    return this.#options.replayLoaders;
  }
  /** Optional host approval gate for visual replay steps. Absent = unavailable. */
  approvalGate(exec) {
    return approvalGateFromHost(
      this.#options.getService === void 0 ? {} : { getService: this.#options.getService },
      exec,
      "qa_replay_run"
    );
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
    const { capture, settle } = await captureLatestVisual(session);
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
      // verdict + confidence are the model's answer; the narration beside them
      // is unverified and may contain fabricated detail, so it travels with an
      // explicit trust code (contracts.ts, QA_ADVISORY_REASONING_TRUST).
      reasoning: finding.reasoning,
      reasoningTrust: QA_ADVISORY_REASONING_TRUST,
      ...finding.reason === void 0 ? {} : { reason: finding.reason },
      artifact: { path: artifactPath, kind: "screenshot" },
      // The capture's settle window travels beside the verdict (additive):
      // `stable === false` means the view never stopped changing, so the
      // advisory verdict is over an unstable view and is marked as such.
      ...settle === null ? {} : {
        settle,
        ...settle.stable ? {} : { captureSettled: false }
      }
    };
  }
  /** Capture a visual frame for qa_evidence and return metadata + artifact path. */
  async captureVisualEvidence(session, options) {
    const { capture, settle } = await captureLatestVisual(session, options);
    const artifactPath = await persistCaptureFile(capture, this.#capturesDir());
    const info = toVisualCaptureInfo(capture);
    const computer = capture.driver === "computer";
    const metadata = computer ? visualCaptureMetadata(capture) : null;
    let coordinateSpace = "native";
    if (metadata !== null) {
      const attachments = this.#options.getService?.("attachments");
      if (attachments !== void 0 && typeof attachments.saveImage === "function") {
        try {
          const ref = normalizeImageRef(await attachments.saveImage({ data: capture.png, mediaType: "image/png", name: "dsh-qa-visual.png" }));
          metadata.attachmentWidth = ref.width;
          metadata.attachmentHeight = ref.height;
          coordinateSpace = "attachment";
        } catch {
        }
      }
      this.#visualCaptures.put(metadata);
    }
    return {
      ...info,
      artifactPath,
      ...metadata === null ? {} : {
        nativeWidth: metadata.pixelWidth,
        nativeHeight: metadata.pixelHeight,
        coordinateSpace
      },
      ...metadata === null || metadata.attachmentWidth === void 0 ? {} : { attachmentWidth: metadata.attachmentWidth, attachmentHeight: metadata.attachmentHeight },
      ...settle === null ? {} : {
        settle,
        // Same vocabulary as qa_assert kind:"visual": a capture taken from a
        // view that never settled is marked, never silently presented.
        ...settle.stable ? {} : { captureSettled: false }
      }
    };
  }
  /** Execute one qa_act visual action through the session core. */
  async actVisual(owner, session, args, exec) {
    const parsed = validateVisualToolArgs(args);
    if (session.kind !== "computer") {
      throw new Error("qa_act visual actions are computer-only (CU visual fallback)");
    }
    const approval = approvalGateFromHost(
      this.#options.getService === void 0 ? {} : { getService: this.#options.getService },
      exec,
      "qa_act"
    );
    let action;
    if (parsed.point !== void 0) {
      if (parsed.captureSha256 === void 0 || parsed.observationId === void 0) {
        throw new Error("qa_act visual point route requires capture_sha256 and observation_id from qa_evidence visual");
      }
      const metadata = this.#visualCaptures.get(parsed.captureSha256);
      if (metadata === void 0) {
        throw new Error("qa_act visual: no trusted capture metadata for this capture_sha256 in this process; run qa_evidence visual again");
      }
      assertCaptureBinding(metadata, parsed.observationId);
      const native = requireVisualPointBinding(parsed, metadata);
      const provenance = { source: "harness-point" };
      action = buildVisualRuntimeActionFromMetadata(parsed.op, metadata, parsed.targetDescription, native.point, {
        ...parsed.toDescription === void 0 ? {} : { toDescription: parsed.toDescription },
        ...native.to === void 0 ? {} : { nativeTo: native.to },
        ...parsed.direction === void 0 ? {} : { direction: parsed.direction },
        ...parsed.amount === void 0 ? {} : { amount: parsed.amount },
        provenance
      });
    } else {
      const grounded = await captureAndGroundVisualTarget(session, parsed.targetDescription, this.visualServices(), exec.signal);
      if (parsed.op === "drag") {
        if (parsed.toDescription === void 0) {
          throw new Error("qa_act visual drag requires to_description");
        }
        const destination = await groundVisualTarget(parsed.toDescription, grounded.capture, this.visualServices(), {
          ...exec.signal === void 0 ? {} : { signal: exec.signal }
        });
        if (!destination.ok) {
          throw new Error("qa_act visual drag destination grounding failed: " + destination.reason);
        }
        action = buildVisualRuntimeAction(parsed.op, grounded.capture, parsed.targetDescription, grounded.nativePoint, {
          toDescription: parsed.toDescription,
          nativeTo: destination.nativePoint,
          provenance: grounded.grounding
        });
      } else {
        action = buildVisualRuntimeAction(parsed.op, grounded.capture, parsed.targetDescription, grounded.nativePoint, {
          ...parsed.direction === void 0 ? {} : { direction: parsed.direction },
          ...parsed.amount === void 0 ? {} : { amount: parsed.amount },
          provenance: grounded.grounding
        });
      }
    }
    return session.act(action, approval);
  }
  async dispose() {
    const pending = [...this.#managers.values()];
    this.#managers.clear();
    this.#ownerDrivers.clear();
    this.#visualCaptures.clear();
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
function unstableReason(budgetMs) {
  return "the observation never settled within the " + String(budgetMs) + "ms settle budget, so nothing in it proves the assertion; wait for the page to stop changing, then re-observe";
}
function guard(handler) {
  return async (args, exec) => {
    try {
      return toLosslessJson(await handler(args, exec));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof Error && typeof error.code === "string" ? error.code : void 0;
      return toLosslessJson({ ok: false, ...code === void 0 ? {} : { code }, error: message });
    }
  };
}
function tool(spec) {
  const execute = guard(spec.execute);
  return { ...spec, execute };
}
function scrollAmountFor(value, allowLine) {
  if (value === void 0) return void 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("qa_act scroll amount must be a finite non-negative number");
    }
    return value;
  }
  if (value === "page") return "page";
  if (allowLine && value === "line") return "line";
  throw new Error('qa_act scroll amount must be "page"' + (allowLine ? ', "line",' : "") + " or a finite non-negative number");
}
function createQaTools(host) {
  const qaSessionStart = tool({
    name: "qa_session_start",
    description: QA_TOOL_DESCRIPTIONS.qa_session_start,
    parameters: closedObject({
      owner: strProp,
      driver: enumOf("browser", "computer", "ios", "android"),
      url: strProp,
      headless: { type: "boolean" },
      bundle_id: strProp,
      device_id: strProp,
      package_name: strProp,
      pid: intProp,
      window_number: intProp,
      window_title: strProp,
      login_state: closedObject({
        source: strProp,
        origins: { type: "array", items: strProp }
      }, ["source", "origins"]),
      settle_budget_ms: intProp,
      settle_quiet_ms: intProp,
      settle_adaptive_budget_ms: intProp
    }, []),
    output: outputFor(),
    timeoutMs: 6e4,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec);
      const driver = args.driver ?? "browser";
      host.bindOwner(owner, driver);
      const manager = await host.managerFor(driver);
      const settle = settleStartOverride(args);
      const startOptions = {
        ...args.url === void 0 ? {} : { url: args.url },
        ...args.headless === void 0 ? {} : { headless: args.headless },
        ...args.device_id === void 0 ? {} : { deviceId: args.device_id },
        ...driver === "ios" && args.bundle_id !== void 0 ? { bundleId: args.bundle_id } : {},
        ...driver === "android" && args.package_name !== void 0 ? { packageName: args.package_name } : {},
        ...driver === "android" && args.bundle_id !== void 0 ? { packageName: args.bundle_id } : {},
        ...driver === "computer" && args.bundle_id !== void 0 ? { bundleId: args.bundle_id } : {},
        ...args.pid === void 0 ? {} : { pid: args.pid },
        ...args.window_number === void 0 ? {} : { windowNumber: args.window_number },
        ...args.window_title === void 0 ? {} : { windowTitle: args.window_title },
        ...args.login_state === void 0 ? {} : { loginState: args.login_state }
      };
      return manager.session(owner, settle === void 0 ? {} : { settle }).start(startOptions);
    },
    presentCall: () => ({ card: "generic", title: "Start QA session" })
  });
  const qaObserve = tool({
    name: "qa_observe",
    description: QA_TOOL_DESCRIPTIONS.qa_observe,
    parameters: closedObject({
      owner: strProp,
      max_nodes: intProp,
      max_depth: intProp,
      ttl_ms: intProp,
      within_ref: strProp
    }, []),
    output: outputFor(),
    timeoutMs: 3e4,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec);
      const manager = await host.managerForOwner(owner);
      const settled = await manager.session(owner).observeSettled({
        ...args.max_nodes === void 0 ? {} : { maxNodes: args.max_nodes },
        ...args.max_depth === void 0 ? {} : { maxDepth: args.max_depth },
        ...args.ttl_ms === void 0 ? {} : { ttlMs: args.ttl_ms },
        ...args.within_ref === void 0 ? {} : { withinRef: args.within_ref }
      });
      return {
        ...settled.observation,
        settle: { stable: settled.stable, passes: settled.passes, budgetMs: settled.budgetMs, quietRequiredMs: settled.quietRequiredMs, widened: settled.widened }
      };
    },
    presentCall: () => ({ card: "generic", title: "Observe QA target" })
  });
  const qaAct = tool({
    name: "qa_act",
    description: QA_TOOL_DESCRIPTIONS.qa_act,
    parameters: closedObject({
      owner: strProp,
      action: enumOf(
        "click",
        "fill",
        "press",
        "navigate",
        "focus",
        "type",
        "key",
        "scroll",
        "select",
        "hover",
        "visual_click",
        "visual_drag",
        "visual_scroll"
      ),
      ref: strProp,
      text: strProp,
      key: strProp,
      url: strProp,
      modifiers: { type: "array", items: strProp },
      direction: enumOf("up", "down"),
      amount: { type: ["string", "number"] },
      option: strProp,
      target_description: strProp,
      to_description: strProp,
      capture_sha256: strProp,
      observation_id: strProp,
      point: closedObject({ x: intProp, y: intProp }, ["x", "y"]),
      to: closedObject({ x: intProp, y: intProp }, ["x", "y"])
    }, ["action"]),
    output: outputFor(),
    timeoutMs: 3e4,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = ownerFrom(args, exec);
      const manager = await host.managerForOwner(owner);
      if (args.action === "visual_click" || args.action === "visual_drag" || args.action === "visual_scroll") {
        return host.actVisual(owner, manager.session(owner), args, exec);
      }
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
      } else if (args.action === "scroll") {
        if (args.direction !== void 0 && args.direction !== "up" && args.direction !== "down") {
          throw new Error('qa_act scroll direction must be "up" or "down"');
        }
        if (args.ref !== void 0 && args.direction !== void 0) {
          const amount = scrollAmountFor(args.amount, true);
          action = {
            kind: "scroll",
            ref: args.ref,
            direction: args.direction,
            ...amount === void 0 ? {} : { amount }
          };
        } else if (args.ref !== void 0) {
          action = { kind: "scroll", ref: args.ref };
        } else if (args.direction !== void 0) {
          const amount = scrollAmountFor(args.amount, false);
          action = {
            kind: "scroll",
            direction: args.direction,
            ...amount === void 0 ? {} : { amount }
          };
        } else {
          throw new Error("qa_act scroll requires ref and/or direction");
        }
      } else if (args.action === "select") {
        if (args.ref === void 0 || args.option === void 0 || args.option.trim() === "") {
          throw new Error("qa_act select requires ref and a non-empty option");
        }
        action = { kind: "select", ref: args.ref, option: args.option };
      } else if (args.action === "hover") {
        if (args.ref === void 0) throw new Error("qa_act hover requires ref");
        action = { kind: "hover", ref: args.ref };
      } else {
        throw new Error("qa_act action must be click, fill, press, navigate, focus, type, key, scroll, select, or hover");
      }
      return manager.session(owner).act(action);
    },
    presentCall: () => ({ card: "generic", title: "Act on QA target" })
  });
  const qaAssert = tool({
    name: "qa_assert",
    description: QA_TOOL_DESCRIPTIONS.qa_assert,
    parameters: closedObject({
      owner: strProp,
      kind: enumOf("node-present", "node-absent", "page-url", "node-in-viewport", "node-value", "visual"),
      expected: {},
      question: strProp,
      within_ref: strProp
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
        if (args.within_ref !== void 0) {
          throw new Error('qa_assert kind "visual" does not take within_ref; observe the container with qa_observe within_ref first, then ask the visual question');
        }
        return host.assertVisual(owner, session, args.question);
      }
      const assertion = validateAssertion({ kind: args.kind, expected: args.expected }, "qa_assert");
      const settled = await session.observeSettled(args.within_ref === void 0 ? void 0 : { withinRef: args.within_ref });
      if (!settled.stable) {
        return {
          ok: true,
          passed: false,
          inconclusive: true,
          code: QA_INCONCLUSIVE_UNSTABLE,
          kind: assertion.kind,
          observed: null,
          expected: assertion.expected,
          settle: { stable: false, passes: settled.passes, budgetMs: settled.budgetMs, quietRequiredMs: settled.quietRequiredMs, widened: settled.widened },
          reason: unstableReason(settled.budgetMs)
        };
      }
      const decision = await decideAssertionWithRetry(assertion, settled.observation, sessionReobserve(session), session);
      host.recorder.assertion(owner, assertion, decision.passed);
      return {
        ok: true,
        passed: decision.passed,
        kind: assertion.kind,
        observed: decision.observed,
        expected: assertion.expected,
        settle: { stable: settled.stable, passes: settled.passes, budgetMs: session.settlePolicy.budgetMs, quietRequiredMs: settled.quietRequiredMs, widened: settled.widened ?? decision.widened },
        ...decision.completeness === null ? {} : { completeness: decision.completeness },
        ...decision.completeness?.reason === QA_COVERAGE_UNVERIFIED ? { inconclusive: true, code: QA_COVERAGE_UNVERIFIED } : {},
        ...decision.attempts <= 1 ? {} : { attempts: decision.attempts, elapsedMs: decision.elapsedMs }
      };
    },
    presentCall: () => ({ card: "generic", title: "Assert QA state" })
  });
  const qaEvidence = tool({
    name: "qa_evidence",
    description: QA_TOOL_DESCRIPTIONS.qa_evidence,
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
    description: QA_TOOL_DESCRIPTIONS.qa_record_export,
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
    description: QA_TOOL_DESCRIPTIONS.qa_replay_run,
    parameters: closedObject({
      scenario: strProp,
      owner: strProp,
      headless: { type: "boolean" },
      device_id: strProp,
      outputDir: strProp
    }, ["scenario"]),
    output: outputFor(),
    timeoutMs: 3e5,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const scenario = loadScenarioFromPath(args.scenario);
      const loaders = host.replayLoaders();
      const loaded = await loadReplayDriver(scenario, loaders === void 0 ? {} : { loaders });
      try {
        const report = await runScenario(scenario, loaded.adapter, {
          ownerId: ownerFrom(args, exec),
          ...args.headless === void 0 ? {} : { headless: args.headless },
          launchUrl: scenario.target.launch,
          ...args.device_id === void 0 ? {} : { deviceId: args.device_id },
          visual: host.visualServices(),
          ...host.approvalGate(exec) === void 0 ? {} : { approval: host.approvalGate(exec) },
          ...host.settleOptions()
        });
        if (args.outputDir !== void 0) {
          await writeReports(report, { directory: args.outputDir });
        }
        return report;
      } finally {
        await loaded.dispose();
      }
    },
    presentCall: () => ({ card: "generic", title: "Replay QA scenario" })
  });
  const qaSessionStop = tool({
    name: "qa_session_stop",
    description: QA_TOOL_DESCRIPTIONS.qa_session_stop,
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
var QA_SKILL_WHEN_TO_USE = "Any autonomous QA exploration through the qa_* tools \u2014 observing an unfamiliar UI, following semantic controls, preserving a failure, exporting a trajectory, or replaying the exported scenario \u2014 over a Browser (BU), Computer (CU), iOS, or Android driver.";
var QA_SKILL_CONTENT = `# Explore with dsh-qa

The loop is **start \u2192 observe \u2192 choose one semantic target \u2192 act \u2192 inspect the fresh observation \u2192
assert \u2192 capture evidence at the moment a problem appears \u2192 export \u2192 replay \u2192 stop**. The same
eight verbs serve Browser (BU), Computer (CU), iOS, and Android; driver safety decisions are never routed around.

## Explore method

- \`qa_session_start\` binds one owner scope to one driver. Choose an explicit owner and keep it
  unchanged through export. Browser takes \`url\`; Computer binds strong app/window identity;
  iOS/Android require an explicit \`device_id\` (no default first device) and an app/package id.
- A heavy site can widen the settle budget at start: pass \`settle_budget_ms\` (and \`settle_quiet_ms\`) to \`qa_session_start\`, clamped to the schema bounds (budget <= 15000ms). Separately, the session widens its budget ONCE automatically (the adaptive budget, \`settle_adaptive_budget_ms\` / env \`DSH_QA_SETTLE_ADAPTIVE_BUDGET_MS\`, default 6000ms, \`0\`/\`off\` disables) when a settle window is still churning at the starting budget, OR when a positive-existence assertion retry exhausts its budget without finding its target (cause "unstable" vs "assertion-retry" respectively): the same window keeps polling until the adaptive budget, and every settle result reports \`settle.widened\` (\`{ fromMs, toMs, cause }\` or \`null\`). Whatever effective policy Explore ran with (the widened budget when it widened) is what \`qa_record_export\` records into \`meta.settle\`, and \`qa_replay_run\` applies it (env/host defaults otherwise), printing the effective policy plus \`settleWidened\` in report.json / report.md.
- Begin with \`qa_observe\`. Prefer a unique role plus accessible name, take one purposeful action,
  then inspect the fresh observation returned by \`qa_act\`. Re-observe when diagnosing and never
  reuse an old ref. A truncated view is incomplete, not empty.
- Coordinates, indices, opaque refs, observation ids, and generated ids are live-session handles,
  never Replay selectors.
- \`qa_act\` returns a receipt plus, for dispatched actions, the session core's immediate fresh
  observation. An \`unknown\` receipt is NEVER success: require a semantic delta or URL change in
  that observation. A \`rejected\` / \`failed\` receipt is a hard stop. Never approve, rephrase, or
  retarget around a driver safety rejection.
- Mobile text input is conditional and driver-native: iOS \`fill\`/\`type\` use the dsh-ios
  element-bound \`fillTarget\`/\`typeTarget\` only when the live driver exposes them (never raw
  global type or invented focus), Android \`type\` is append-faithful after real focus
  verification, and Android \`fill\` remains unavailable.
- A \`fill\` is proven by its OWN target's value: when the fresh observation shows the target
  carrying the typed text, the exporter synthesizes a \`node-value\` assertion on that target (the
  most durable evidence), not on some other node that happened to change \u2014 including when the fill
  REWROTE the target's accessible name OR role (\`aria-label\` following the value, "Search" ->
  "Search: async", or \`textbox\` -> \`combobox\` once suggestions open): the exporter then follows
  the same identity rule the echo mask uses (match by name role-agnostic OR by role name-agnostic,
  unique among candidates) and binds the assertion to the node's MOST STABLE predicate: the unique accessible name alone (role omitted) when the role changed, so a fast replay still matches before the role switch; role+name only when the name alone is ambiguous. It never degrades to
  \`node-present\` of the renamed field alone. A secret-bearing control (\`valueWithheld\`,
  password/one-time-code/cc autocomplete) never carries a value, so no value assertion is
  synthesized for it.
- The settle window echo-masks the action's own value write (\`fill\`/\`type\`/\`select\`, and
  \`key\`/\`press\` on a uniquely identified target), so a downstream consequence that lands after the
  echo is still waited for \u2014 a fresh observation that only shows the echo never proves the action alone.
- After the first non-echo change is observed, the quiet window lengthens to \`postChangeQuietMs\`
  (default 2\xD7 \`quietMs\`), measured from the last change, so an outcome that lands after early
  unrelated churn (a sibling mirroring the typed value, a late hydration rename) is still captured
  rather than cut off by one short quiet window.
- \`qa_assert\` checks resulting state against a fresh observation. Do not repeat the action "to see
  if it worked". \`node-value\` (\`expected: { role?, name?, tag?, value }\`) asserts a node's exact
  current value and is deterministic, like \`node-present\` / \`node-absent\` / \`page-url\`. It demands
  the predicate identify EXACTLY ONE node (\`TARGET_NOT_UNIQUE\` otherwise \u2014 a twin already holding the
  value proves nothing), and a \`valueWithheld\`/\`secure\`/\`valueTruncated\` node can never satisfy it
  (\`VALUE_WITHHELD\` / \`VALUE_SECURE\` / \`VALUE_TRUNCATED\`).
- A POSITIVE existence assertion (\`node-present\` / \`node-value\` / \`node-in-viewport\` / \`page-url\`) that is first "not found" is re-observed within the settle budget before failing \u2014 the node may just be slow to render \u2014 and the result records \`attempts\` / \`elapsedMs\`. \`node-absent\` is never retried into a pass: absence is never proven by waiting, only by having seen the whole view. When a POSITIVE existence retry exhausts its budget without finding the target, the session widens its budget ONCE through the same gate (settle.widened with cause "assertion-retry") and keeps retrying until the adaptive budget, so a page that settles fast but renders slowly is still found.
- A view can also be UNSTABLE: when a fresh observation's \`settle.stable\` is \`false\` the page never
  stopped changing inside the settle budget, so nothing in it proves anything. \`qa_assert\` then returns
  \`passed: false\` with \`inconclusive: true\` and \`code: "INCONCLUSIVE_UNSTABLE"\` (the same non-result
  vocabulary as \`INCONCLUSIVE_TRUNCATED\`) \u2014 never a false green; wait for the page to stop changing, then
  re-observe. A \`qa_act\` on an unstable proof window keeps its receipt honest (\`confirmed\` / \`unknown\`)
  but adds \`proven: false\` plus \`code: "INCONCLUSIVE_UNSTABLE"\`: the dispatch happened, the consequence
  is unproven.
- A view can be TRUNCATED at the node budget, and a node outside that window still exists. So an
  absence can never be proven from a truncated view: \`node-absent\` re-observes once at a raised
  budget and then fails closed with \`completeness.reason: "INCONCLUSIVE_TRUNCATED"\` rather than
  reporting a false "gone". Read \`completeness\` before believing any negative result: "we did not
  see it" is not "it is not there". A found node is sound evidence of presence either way.
- Absence and coverage (contract v9, Phase C): \`node-absent\` means "no driver-OBSERVABLE
  semantic node" (hidden and zero-rect elements are excluded from the projection), and it PASSES
  only when nothing matched AND the deciding view is complete (\`truncated: false\`) AND
  \`coverage.verified: true\` \u2014 the terminal absence decision requests the driver's bounded
  closed-shadow-root probe on its ONE deciding re-observation (never on settle polls; ~5ms
  scoped, possibly over-budget whole-page on very large pages, and then the absence is
  UNPROVEN). A probe that found closed shadow roots or did not complete keeps the result
  \`INCONCLUSIVE_TRUNCATED\` / \`COVERAGE_UNVERIFIED\`, naming \`closed-shadow-root\` /
  \`shadow-coverage-unverified\` in \`completeness.detail\` and \`truncationReasons\`; a passing
  absence prints "No driver-observable semantic node matching {predicate} was found within
  {scope|the whole page}; coverage verified (N nodes probed). K hidden candidates excluded."
  Never report "absent" without that evidence; report "not observed, and absence cannot be
  proven". A returned matching node still fails \`node-absent\` normally.
  \`completeness.nodeBudget\` is the budget the DRIVER actually applied (each driver clamps the
  request to its own maximum: browser 100, computer 500 \u2014 a browser run never reports 500), and
  \`completeness.truncationReasons\` names WHY the view is partial: \`iframe-not-traversed\` means
  part of the page lives in an iframe the driver does not traverse (a budget cannot help),
  \`scan-window-exceeded\` means the fixed scan window was hit (a budget cannot help), and
  \`node-budget-exceeded\` names the node budget. When the re-observation applied the SAME budget
  as before (already at the driver maximum), raising \`qa_observe max_nodes\` cannot help \u2014 narrow
  the page or region, or scroll the target into a smaller view.
- A view can also be SCOPED (browser, driver contract v8): pass \`within_ref\` \u2014 an opaque ref
  from your CURRENT (latest, unexpired) \`qa_observe\` result \u2014 to observe only the composed
  subtree rooted at that element. Budgets, the byte ceiling, the scan window, and the iframe
  marker become SUBTREE-relative, so a container whose subtree fits reports \`truncated: false\`
  with no \`truncationReasons\`, and a deep target unreachable in the whole-page window becomes
  reachable. Absence inside it passes only with verified coverage (see the coverage rule: the
  deciding re-read probes the SUBTREE). The observation's
  \`scope\` field (\`{ ref, rootRef, role, name, tag }\`) echoes the root the driver observed;
  \`rootRef\` (contract v9) is the fresh per-observation ref that chains the next scoped read \u2014
  it is absent for whole-page observations. An unknown, expired, consumed, non-element, or
  detached ref
  REFUSES the call with its driver code (\`REF_UNKNOWN\` / \`REF_EXPIRED\` / \`TARGET_CHANGED\` /
  ...) \u2014 never a whole-page fallback and never a "not found". The computer driver does not
  support scoping and refuses \`within_ref\`. A scoped proof is exported as a scoped assertion
  (\`scope: { role, name, tag?, path? }\`, an empty name kept literally, and \`path\` the
  container's semantic ancestor chain from record-time ancestry when one was recorded) DURABLY
  ONLY when the container predicate (role+name, plus tag when needed) is unique in a COMPLETE
  recorded baseline observation that is NOT the container's own subtree \u2014 otherwise the step is
  excluded with \`SCOPE_NOT_DURABLE\`, never silently exported as a whole-page proof. The ONE
  exception is the identity-anchored scoped scroll proof (the recorded action's proof observation
  carries the driver's truthful identity anchor): it is exported explicitly PROVISIONAL (the step
  intent says so, and \`path\` is recorded when available). Replay re-derives the container in the
  whole-page view (UNIQUE predicate, plus the recorded path when present \u2014 \`TARGET_NOT_UNIQUE\`
  when ambiguous; one match in a still-truncated view resolves PROVISIONALLY for the scroll proof
  or a path-carrying scope, every other scope refuses with \`INCONCLUSIVE_TRUNCATED\` naming the
  scope) and decides inside the container; the completeness block names the scope, so "absent
  from this container" is never read as "absent from the whole page" \u2014 and absence passes only
  with verified coverage (\`coverage.verified: true\`). A PROVISIONAL resolution means
  \`scopeResolution: "provisional"\` + \`reason: "INCONCLUSIVE_SCOPE"\` on the step \u2014 never a pass \u2014
  and the run aggregates to status \`inconclusive\` unless something definitely failed.
  A browser scroll-by-ref whose settled proof view is truncated and still lacks the target in
  the viewport is re-read ONCE at record time, preferring an identity-anchored SCOPED read
  rooted at the target's nearest container-role ancestor (walked on the target's \`parentRef\`
  chain, contract v9): the escalated view is accepted only when the driver's identity anchor
  reports the ORIGINAL acted element connected, contained in that container, and in the
  viewport \u2014 identity comes from the anchor, never from matching role/name/tag. A scroll (or
  any act) whose ref came from a SCOPED baseline takes its PROOF settle inside that scope
  instead (withinRef: the baseline \`scope.rootRef\` plus \`anchorLastAction\`), accepted only on
  the same identity-anchor rule \u2014 the result then carries \`proofScope: { role, name }\` plus
  \`anchor\` (no escalation happened, so no \`proofEscalated\`), and export carries the scope
  (provisional at replay on long pages). On driver >= d069f4f the dispatched action RETAINS
  the consumed scope root (contract v9), so the scoped proof read RESOLVES through it: the
  FIRST poll is keyed by the EXPLICIT baseline \`scope.rootRef\` (never \`'last-scope'\`, so a
  stale baseline is refused instead of silently rebinding to whatever root was last acted),
  then the loop re-keys each later poll to the fresh \`rootRef\` that poll minted \u2014 the scroll
  is PROVEN inside that scope. When the driver refuses the root (a pre-retention driver, the
  acted ref IS the scope root itself \u2014 the single-owner handle is never retained, while the
  anchor still works \u2014 or a released retention after navigation: \`OBSERVATION_REQUIRED\` /
  \`SCOPE_UNAVAILABLE\`), the refusal is DISCLOSED and the proof falls back to the whole-page
  read. Every non-acceptance exit is disclosed as \`escalationRefused: { reason, code? }\` with a
  fixed vocabulary \u2014 \`target-not-in-baseline\`, \`container-not-in-view\`,
  \`escalated-window-unstable\`, \`target-not-returned\`, \`target-not-in-viewport\`,
  \`anchor-not-connected\`, \`anchor-not-contained\`, \`anchor-unavailable\` \u2014 plus the driver's
  code when it threw; \`already-in-viewport\` is NOT a refusal (the result then simply has no
  escalation fields), and the refusal rides on the exported step so report.md prints it on the
  step line.
- \`qa_assert\` takes the SAME \`within_ref\`: the assertion is decided INSIDE that container
  (the deciding read is a fresh settled scoped observation), so \`node-absent\` means "absent
  FROM THE CONTAINER" \u2014 \`completeness.scope\` names it (\`{ role, name }\`) and the PASS
  wording says "within the {role} named "{name}""; WITHOUT \`within_ref\` the decision stays
  whole-page and carries no \`completeness.scope\`. The ref must come from the LATEST
  observation: a container ref from the latest whole-page \`qa_observe\`, or the
  \`scope.rootRef\` (any node ref works) echoed by the immediately preceding scoped
  \`qa_observe\`. Every observe REPLACES the driver's current observation, so a ref from an
  earlier observation \u2014 including a whole-page container ref captured before an intervening
  scoped observe \u2014 is REFUSED as \`{ ok:false, code: "REF_UNKNOWN" | "REF_EXPIRED" | \u2026,
  error }\`, never silently re-decided against the whole page. All scoped rules apply
  (subtree budgets, in-scope escalation and coverage probe, the \`coverage.verified\` gate);
  the recorder exports a passed scoped assert with its scope (\`SCOPE_NOT_DURABLE\` exclusion
  when the container is not unique in a complete recorded baseline); the computer driver
  refuses \`within_ref\` and \`kind: "visual"\` does not take it.

- The moment a problem appears, call \`qa_evidence\` before navigating away or changing state.
  Missing permissions, truncation, and driver rejection are boundaries, never green results.

## Visual assertions: trust the verdict, never the narration

\`qa_assert kind:"visual"\` returns \`verdict\` (yes/no/unclear), \`confidence\`, and \`reasoning\`.

- **Trust \`verdict\` and \`confidence\`.** They are the model's answer to your question and the only
  part you may act on or report.
- **Never quote details from \`reasoning\` as observed fact.** It is model narration; it is not
  checked against the screenshot, and it invents detail. Measured in a live run: asked whether a
  serif "WIKIPEDIA" wordmark was present, the model answered \`yes\` at confidence 1.00 \u2014 correctly \u2014
  and then narrated "with the puzzle globe logo", which was NOT on that page; asked separately
  whether the puzzle globe was present, the same model correctly answered \`no\` at 0.97. The verdict
  was right and the story around it was invented. Every advisory record therefore carries
  \`reasoningTrust: "unverified-model-narration"\`, and report.md prints the text as a labelled
  "model narration" blockquote.
- If a detail in the narration matters, ask a separate visual question about exactly that detail, or
  prove it deterministically with \`node-present\` / \`node-absent\` / \`page-url\`. A visual verdict is
  ADVISORY: it never changes a run's pass/fail.
- A visual assertion takes its own fresh settled observation before capturing, so it works directly
  after \`qa_act\` or \`qa_evidence\` \u2014 no separate \`qa_observe\` is required first. The one exception
  is a capture you pinned yourself with \`visual_fingerprint\` on \`qa_evidence\`: a pinned observation
  is never silently refreshed, so once it goes stale the driver refuses it by design and you must
  observe and pin again.
- A visual finding carries \`settle: { stable, passes, budgetMs }\` from the observation it captured
  from. When \`settle.stable\` is \`false\` the finding also carries \`captureSettled: false\`: the
  advisory verdict is over a view that never stopped changing, so it proves nothing about the page.
  A \`qa_evidence\` visual capture carries the SAME \`settle\` + \`captureSettled: false\` vocabulary.

## Export and Replay

- Call \`qa_record_export\` with the same \`owner\` and an \`output_path\` ending in \`.json\`. Its
  parent must already exist under the current workspace or temporary directory.
- Selector durability is strict: only a target uniquely identified in the preceding observation by
  non-empty **role + accessible name** is exported. Role drift on real pages \u2014 a server-rendered
  control replaced by a hydrated component that renders the same accessible name under a
  DIFFERENT role (Wikipedia's search input: \`textbox\` -> \`combobox\` once the typeahead
  mounts) \u2014 makes the LIVE role a fragile identity, so the exported ACTION target is written
  NAME-only whenever the accessible name is non-empty and unique in the recorded baseline view,
  keeping the live role only as an advisory \`roleHint\` (the loader accepts it and ignores it
  for matching; assertions follow the same name-only rule through the QA-BL-039 value
  discriminator). A name that is empty or not unique keeps the role+name form. Unnamed, duplicate,
  coordinate/index-based, ephemeral-ref-only, redacted, or Replay-unsupported actions are excluded
  with a reason.
- Every exported step receives an assertion synthesized from and evaluated against the immediate
  fresh observation after that action. Rejected/failed actions and actions without that observation
  never become steps. A fill is proven by its own target's value (\`node-value\`); otherwise an
  unknown receipt needs a semantic delta or URL change, and target persistence alone cannot prove it.
- A delta whose accessible name is a concatenation of its children's text is ordering-fragile (a
  \`search\`/\`list\`/\`listbox\` container whose name exceeds ~80 characters) and is never
  exported as a proof: it is skipped in favour of a sound delta, and when it is the only change the
  step is excluded with \`FRAGILE_PROOF_ONLY\`.
- Inspect \`excludedActions\`. An exclusion is not a pass. If every action is unproven,
  \`qa_record_export\` returns \`NO_PROVEN_STEPS\` and writes no file.
- Run \`qa_replay_run\` on the exact exported file without hand editing it. Browser Replay is the
  supported v0.1 closed loop, and the run status is THREE-state (QA-BL-062): \`pass\` closes
  Explore\u2192Replay only when every required step and final assertion is fully proven;
  \`inconclusive\` means at least one result is provisional (a scoped container resolved
  provisionally \u2014 \`scopeResolution: "provisional"\` and \`reason: "INCONCLUSIVE_SCOPE"\` on the step,
  inherited by the copied final assertion) and nothing definitely failed; \`fail\` is everything
  else. A provisional scroll proof is still EXECUTED (the replayed scroll runs and is verified
  through the driver's identity anchor \u2014 a lost binding or mismatch is disclosed as
  \`scopeRefusal\`, never a predicate reselect), but PASS is reserved for proven resolution. A
  failed run carries a machine \`failure.code\` for recognized non-results \u2014
  \`INCONCLUSIVE_UNSTABLE\` (a view that never settled) and \`TARGET_NOT_UNIQUE\` (an ambiguous
  action target) \u2014 so you never have to parse prose to tell them from an ordinary assertion
  failure.
- Role drift on replay (QA-BL-064): a recorded role+name ACTION target that matches NOTHING in the
  deciding view (after the one escalated read when that view is truncated) falls back to a NAME-only
  match iff exactly one node carries the same non-empty accessible name \u2014 the node is present under
  a drifted role, not outside the window \u2014 and the step discloses
  \`targetResolution: { mode: "name-only", recordedRole, observedRole }\` in report.json/report.md.
  The fallback is a refusal, never a guess, when the name is empty or matches two or more nodes
  (\`TARGET_NOT_UNIQUE\` with "present under a different role: recorded X, observed Y"); a
  zero-match failure otherwise distinguishes "the target is absent from the returned window"
  (truncated, \`INCONCLUSIVE_TRUNCATED\`) from "the target is absent from a complete view".
  The same hydration swap can land BETWEEN resolution and dispatch: a \`TARGET_CHANGED\` refusal
  (identity staleness \u2014 nothing was dispatched) is retried WITHIN the settle budget, never once
  (QA-BL-070): a fresh settled observation, a re-resolution of the SAME semantic target, and a
  re-dispatch, repeated until the pair lands, widening the budget ONCE through the shared session
  gate when the retry exhausts it (the same machinery assertion retries use; cause
  \`assertion-retry\`). The step discloses \`targetChangedRetries: N\` (the refusal count) in
  report.json/report.md, and the driver's last refusal receipt (verbatim \`reason\` plus any
  additive fields such as \`changed\`) rides on the step so triage sees WHAT changed. Every other
  rejection \u2014 a policy/safety refusal, \`TARGET_NOT_UNIQUE\`, a target absent from a COMPLETE
  view \u2014 stays a hard stop with zero retries. When the budget is exhausted with the target still
  changing identity, the step is \`inconclusive\` with reason \`INCONCLUSIVE_UNSTABLE\` and
  \`assertionPassed: false\` (the run is \`inconclusive\`, NEVER \`fail\`): "the target kept
  changing identity between resolution and dispatch for the whole settle budget (N retries): the
  page did not hold still, so the step is unproven". The SAME refusal on a \`within\` read of the
  scoped path walk (QA-BL-073: an ancestor changed identity between its parent read and the scoped
  read) runs the SAME bounded retry \u2014 re-resolving the level from the level above with a fresh
  settled read, counting into the SAME \`targetChangedRetries\` \u2014 and its exhaustion is the same
  \`inconclusive\` / \`INCONCLUSIVE_UNSTABLE\` classification with a message naming the level
  ("path level N (<what>) kept changing identity \u2026") and the driver's \`changed\`/\`before\`/\`after\`
  verbatim as \`scopeIdentityRefusal\`; only \`TARGET_CHANGED\` is ever retried (policy refusals,
  \`REF_UNKNOWN\`, \`OBSERVATION_REQUIRED\`, \`SCOPE_UNAVAILABLE\` stay hard). A CONTENT-named
  container whose aggregated name changed between reads is never a refusal at all: the driver
  reports it informationally (\`scope.nameChanged\`), and the step records \`scopeNameChanged: true\`.
- \`qa_session_stop\` releases the owner scope. Stop on success and failure; the trajectory remains
  exportable until another session starts for that owner or the plugin disposes.

## Missing drivers

The Browser, Computer, iOS, and Android drivers load lazily. When one is absent, the first tool call
that needs it fails with a clear error naming the missing package. Plugin activation and tools/list
do not require the drivers to be installed.
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
  ANDROID_DRIVER_SPECIFIER,
  AndroidAdapter,
  BrowserAdapter,
  COMPUTER_DRIVER_SPECIFIER,
  ComputerAdapter,
  DEFAULT_VISION_MODEL,
  DEFAULT_VISION_PROVIDER,
  IOS_DRIVER_SPECIFIER,
  IosAdapter,
  LoginStateError,
  QA_ADVISORY_REASONING_TRUST,
  QA_COVERAGE_UNVERIFIED,
  QA_DRIVERS,
  QA_ESCALATED_NODE_BUDGET,
  QA_INCONCLUSIVE_SCOPE,
  QA_INCONCLUSIVE_TRUNCATED,
  QA_SCOPE_NOT_DURABLE,
  QA_SETTLE_ADAPTIVE_BUDGET_MS,
  QA_SETTLE_BUDGET_MS,
  QA_SETTLE_INTERVAL_MS,
  QA_SETTLE_POST_CHANGE_QUIET_MS,
  QA_SETTLE_QUIET_MS,
  QA_SKILL_CONTENT,
  QA_SKILL_DESCRIPTION,
  QA_SKILL_NAME,
  QA_SKILL_WHEN_TO_USE,
  QA_TOOL_NAMES,
  QA_VALUE_SECURE,
  QA_VALUE_TRUNCATED,
  QA_VALUE_WITHHELD,
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
  decideAssertion,
  decideAssertionWithRetry,
  evaluateAssertion,
  evaluateVisualQuestion,
  exportRecordedScenario,
  inject,
  isAndroidResourceId,
  isSensitiveKey,
  loadAndroidBackend,
  loadComputerDriver,
  loadIosBackend,
  loadLoginState,
  loadReplayDriver,
  loadScenarioFromPath,
  matchesNode,
  missingAndroidDriverMessage,
  missingComputerDriverMessage,
  missingIosDriverMessage,
  name,
  normalizeImageRef,
  normalizeObservableValue,
  normalizeReportForDeterminism,
  observeUntilStable,
  ownerFrom,
  parseScenario,
  parseVerdict,
  persistCaptureFile,
  projectArtifactPath2 as projectArtifactPath,
  projectRedactedJsonValue,
  projectSemanticView,
  qaToolList,
  redactText,
  redactTextWithRoots,
  registerQaSkill,
  renderReportJson,
  renderReportJsonl,
  renderReportMarkdown,
  resolveSettlePolicy,
  runScenario,
  scenarioStartOptions,
  sessionReobserve,
  settleStartOverride,
  toLosslessJson,
  toObservedNode,
  toVisualCaptureInfo,
  validateAssertion,
  validateLoginStateConfig,
  validateRoots,
  validateScenario,
  validateVisualAssertion,
  writeReports
};
