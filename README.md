<h1 align="center">DSH QA</h1>

<p align="center">
  <strong>Explore real apps, capture evidence, and turn verified actions into repeatable QA scenarios.</strong><br />
  <sub>Agent-Led Exploration &bull; Evidence-Backed Assertions &bull; Deterministic Replay &bull; Browser, Desktop, iOS &amp; Android</sub>
</p>

<p align="center">
  <sub>Package: <code>@zseven-w/dsh-qa</code> &middot; Version: <code>0.1.0-rc.1</code> &middot; Prerelease</sub>
</p>

<p align="center">
  <a href="./README.md"><b>English</b></a> &middot; <a href="./README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> &middot; <a href="#safety-and-limitations">Safety and limitations</a> &middot; <a href="#known-gaps">Known gaps</a> &middot; <a href="#development">Development</a> &middot; <a href="#documentation">Documentation</a>
</p>

<p align="center">
  <img src="./docs/images/dsh-qa-replay-report.png" alt="Real QA browser replay report with two passing steps, final assertions, and bounded evidence" width="100%" />
</p>
<p align="center"><sub>Actual output from the shipped browser example: two steps and final assertions passed. This is a typeset view of the unedited Markdown report, not a built-in dashboard or a claim of four-platform coverage.</sub></p>

## Why DSH QA

QA orchestrator plugin for DeepSeek Harness: an agent **explores** your App like a
real user (with evidence-backed findings), then the explored path is exported as a
deterministic **Replay** scenario that runs on every release.

- **Explore mode** — the agent drives the app through a tool surface
  (`qa_session_start` / `qa_observe` / `qa_act` / `qa_assert` / `qa_evidence` /
  `qa_record_export` / `qa_replay_run` / `qa_session_stop`) and documents what it sees.
- **Replay mode** — declarative `QaScenario` files (lossless JSON) executed
  deterministically with per-step re-observe assertions, producing redacted
  JSON / Markdown / JSONL reports.
- **Drivers** — `@zseven-w/dsh-browser` (BU, contract v9),
  `@zseven-w/dsh-computer` (CU, contract v5),
  `@zseven-w/dsh-ios`, and `@zseven-w/dsh-android`.
  Driver safety semantics are inherited, never loosened:
  `EXTERNAL_COMMIT_TARGET` refused, secure fields permanently refused, approval
  gates passed through, `unknown` receipts require re-observation. Mobile
  sessions require an explicit device id and never fall back to a default
  device. Mobile text input is conditional, never blanket-implemented: iOS
  `fill`/`type` use the dsh-ios native element-bound `fillTarget`/`typeTarget`
  primitives when the live driver exposes them, with missing methods or missing
  native identifiers left explicitly unavailable and no raw global-type
  fallback; Android `type` remains append-faithful after real focus
  verification and Android `fill` remains `FILL_PRIMITIVE_UNAVAILABLE`.

QA coordinates four independent drivers; it does not replace them or grant
broader access. A passing fixture, unit suite, or device acceptance run is
evidence for that tested scope, not a claim that every app is supported.

## Quick start

Requires Node.js **24.11.0 or later**. QA orchestrates drivers it does not
contain: it loads each one lazily, by package name, only when a session asks
for that platform. **Installing `@zseven-w/dsh-qa` alone gives you no
drivers** — `qa_session_start` will report the driver as not installed. Install
the ones you need alongside it:

```bash
npm install @zseven-w/dsh-qa           # the orchestrator
npm install @zseven-w/dsh-browser      # browser sessions
npm install @zseven-w/dsh-computer     # macOS desktop sessions
npm install @zseven-w/dsh-ios          # iOS device/simulator sessions
npm install @zseven-w/dsh-android      # Android device/emulator sessions
```

| Driver | Package | Responsibility | Extra prerequisites |
| --- | --- | --- | --- |
| Browser (BU) | [`@zseven-w/dsh-browser`](https://github.com/ZSeven-W/dsh-browser) | Browser observation and interaction | An installed Chrome / Edge / Chromium; the driver discovers one and never downloads it |
| Computer (CU) | [`@zseven-w/dsh-computer`](https://github.com/ZSeven-W/dsh-computer) | Native desktop observation and interaction | macOS; a locally built + granted Helper (Accessibility + Screen Recording) — see [Known gaps](#known-gaps) |
| iOS | [`@zseven-w/dsh-ios`](https://github.com/ZSeven-W/dsh-ios) | Explicit-device mobile sessions | macOS + Xcode; an explicit device id |
| Android | [`@zseven-w/dsh-android`](https://github.com/ZSeven-W/dsh-android) | Explicit-device mobile sessions | adb; an explicit device id |

Verify the install by replaying the shipped browser example, which needs
nothing but `dsh-qa`, `dsh-browser`, and a local browser:

```bash
node node_modules/@zseven-w/dsh-qa/scripts/run-example.mjs
```

It serves the packaged web fixture on an ephemeral loopback port, replays a
two-step scenario headlessly, and writes JSON / Markdown / JSONL reports. A
working install prints `[example] status: pass`. See
[Running the shipped example](#running-the-shipped-example) for the details.

For DSH-host usage, install or update DSH with:

```bash
npm install -g @deepseek-ai/dsh@latest
```

Installing DSH does **not** activate this plugin. Its host entry is declared in
[`cordis.patch.yml`](./cordis.patch.yml); the standalone stdio MCP entry is
[`src/server.mjs`](./src/server.mjs), also exposed by `npm run mcp` and
[`.mcp.json`](./.mcp.json). Configure the chosen host to load the plugin/server
and provide the required drivers before starting a session. Follow the
[Explore playbook](./skills/qa-explore/SKILL.md) for the observe → act → assert
→ evidence → export workflow.

## Safety and limitations

- **No false green:** `unknown` action receipts need fresh proof. Runs report
  `pass`, `inconclusive`, or `fail`; missing coverage is not absence.
- **No authority escalation:** driver approvals remain in force. Secure fields
  and `EXTERNAL_COMMIT_TARGET` are refused; mobile sessions require an explicit
  device id, with no default-device fallback.
- **Replay needs durable targets:** coordinates, ephemeral references, and
  ambiguous selectors are not promoted into durable scenarios. An action with
  no settled, provable outcome is excluded from export.
- **Vision is advisory:** visual assertions assist triage but do not determine
  the run status. Model narration is not observed fact.
- **Mobile support is conditional:** iOS text input requires live native
  element-bound primitives and identifiers. Android `type` verifies real focus;
  Android `fill` remains unavailable.
- **Evidence needs care:** structured reports use fail-closed redaction, but
  screenshots can still contain private content. Use synthetic test data and
  inspect artifacts before sharing. Login-state injection requires explicit
  owner authorization for exact origins; see [login state](./docs/LOGIN_STATE.md).

## Known gaps

This is a developer release. The main path — Explore → evidence → Export →
Replay on browser and desktop — is exercised by the suite on every change, but
these are open, and knowing them is part of using the package honestly.

- **The Computer helper is not notarized.** It is ad-hoc signed with no
  TeamIdentifier and no stapled ticket, so there is no "install and go"
  desktop experience: you build the helper from the
  [`dsh-computer`](https://github.com/ZSeven-W/dsh-computer) checkout and grant
  it Accessibility + Screen Recording yourself. Developer ID signing and
  notarization are not done.
- **Closed shadow roots can make a scoped `node-absent` assertion wrong.** The
  browser driver pierces open shadow roots only; a closed root's content is
  never collected and no truncation reason counts it, so a scope whose light
  tree fits reports itself complete and `node-absent` can PASS on a container
  that does contain the node. Do not rely on absence assertions against UIs
  built on closed shadow roots.
- **Deep targets on large pages stay inconclusive.** Beyond the driver's
  100-node observation window, a scoped scroll proof can only reach
  `INCONCLUSIVE_SCOPE`, never `pass`. This is honest, not broken — but it means
  deep flows on big pages do not produce a green gate today.
- **Visual assertions are advisory and the live vision path is unverified
  here.** Vision never changes a Replay's pass/fail by design. The seam to a
  real host vision service (`ctx.llm` / `attachments`) is covered only by a
  fake in the suite; it has not been run against a live vision model.
- **Mobile drivers carry no contract version.** Browser pins contract v9 and
  Computer v5, but `dsh-ios` / `dsh-android` export no version from `/driver`;
  QA loads them structurally, so a drift is caught after the fact rather than
  at load.

Replay verifies five kinds of semantic assertion. A `pass` means those
assertions held on fresh observations — not that the app is correct, not that
the screen looks right, and not that coverage was complete.

## Implementation reference

<details>
<summary>Session semantics, replay, observation coverage, and host integration</summary>

### Session core

`src/session/` implements the QA loop `observe -> act -> re-observe -> evaluate ->
evidence -> cleanup` on top of a driver adapter interface, with these hard rules:

- an `unknown` action receipt is never treated as success — the outcome is decided
  only by a fresh observation;
- `rejected` / `failed` receipts propagate as step failures with the receipt
  attached as evidence;
- every session cleans up (`driver.stop`) even on failure.

`src/adapters/browser.ts` adapts `@zseven-w/dsh-browser` (declared as a
`link:../dsh-browser` dev-only `devDependencies` linkage, never a runtime
dependency and never vendored) to that interface
without weakening any driver safety semantics. `fixtures/web/index.html` is a
self-contained loopback fixture that reproduces the 2026-08-25 acceptance flow.

The native (Computer-driver) fixture `fixtures/native/` is **repository-only by
decision (QA-BL-042, 2026-09-05)**: it is a signed macOS app bundle built from
`main.swift` and is not in the published package. Build it from a checkout with
`node fixtures/native/build-fixture.mjs`, launch
`fixtures/native/build/DshQaFixture.app`, and stop it with
`pkill -x dsh-qa-fixture`. It is the only isolated target for demonstrating the
Computer driver's permanent secure-field rejection ("Secure password",
`fixture.securePassword`) and is exercised by `test/computer-integration.test.mjs`.

### Replay

Declarative `QaScenario` files (lossless JSON, `{ meta, target, steps[],
assertions[] }`) are executed deterministically by `src/replay/runner.ts` on
top of the session core. Every step carries the act plus the assertion that
must hold on the FRESH observation after it; an `unknown` receipt is never a
pass — only the re-observation decides. The fail-closed loader
(`src/replay/loader.ts`) rejects unknown fields, malformed steps, missing
fields, and non-lossless values without echoing value bytes. Reporters emit
redacted `report.json` / `report.md` / append-only `report.jsonl` through
the fail-closed v2 engine in `src/redaction`.
See `scenarios/examples/` and `qa_assert` / `qa_replay_run`.

### Explore → Replay

`src/explore/` wraps the existing driver adapter as a passive recorder. It records
ordered observations, actions, receipts, and evidence references after applying the
fail-closed redaction projection; the session core itself is unchanged. Ephemeral
driver refs are replaced by per-session correlation aliases and never enter the
trajectory.

`qa_record_export` accepts an `output_path` under the current workspace or temporary
directory, synthesizes every step assertion from the SETTLED fresh observation
after that action, writes a scenario, and reads the exact bytes back through the
existing fail-closed loader. Rejected/failed actions, actions without a fresh
observation, and actions whose view never settled are returned in
`excludedActions`, never silently promoted to steps.

Selector durability is intentionally strict. Browser targets require a unique
non-empty **role plus accessible name**; computer targets use the durable
Accessibility identifier; mobile targets prefer the stable Android resourceId /
iOS AXUniqueId identifier. Indices, coordinates, observation ids, generated ids,
duplicate names, unnamed nodes, and ephemeral refs are refused instead of
guessed. An `unknown` receipt additionally needs an observable semantic delta or
URL change; the old target merely remaining present is not proof.

The Explore methodology ships as two artifacts: a human-readable copy at
`skills/qa-explore/SKILL.md` (included in the package `files`), and the playbook
the plugin actually registers through the optional skill service — the
`QA_SKILL_CONTENT` template literal in `src/skill.ts`, registered under the
name `qa-orchestration` via `ctx.inject(['skills'], …)`.

### Bounded settle (asynchronous UIs)

Real UIs are asynchronous, so a single proof observation taken immediately after
an action is a race: it can miss the outcome that has not rendered yet, or catch
unrelated late hydration churn and mistake it for the outcome. `src/session/settle.ts`
replaces that single-shot read with a bounded settle: observe until the semantic
projection (refs and other session-local identity excluded) has held still for
`QA_SETTLE_QUIET_MS`, bounded by `QA_SETTLE_BUDGET_MS`, and — right after an
action — never conclude from silence alone.

The SAME policy is applied by the session core to Explore's proof observations
and Replay's verification observations, so the two sides can never judge
different views of the same page. A view that never settles is honestly
unprovable: export excludes the step (`ASSERTION_NOT_PROVABLE`) and replay fails
the step. Nothing is widened to make an unstable page pass. Assertion synthesis
prefers evidence on or near the action target and records the weakness in the
step intent when only a distant delta exists. A `fill`'s own value echo on its
target is masked from the change decision (it is expected, not evidence of a
downstream outcome), and the exporter proves the fill with a `node-value`
assertion on the target whenever the settled view shows it carrying the typed
text.

Configure it with `new QaToolHost({ settle: ... })`, `runScenario(..., { settle: ... })`,
or the `DSHPLUGIN_QA_SETTLE_BUDGET_MS` / `DSHPLUGIN_QA_SETTLE_QUIET_MS` / `DSHPLUGIN_QA_SETTLE_INTERVAL_MS`
environment overrides. Full rationale, both reproduced real-world failure modes,
and the regression fixtures: `docs/SETTLE.md`.

### A truncated view is incomplete, not empty

Observations are budget-limited and carry `truncated`. A node beyond the budget
still exists, so **an absence can never be proven from a truncated view**:
`node-absent` fails closed there instead of reporting a silent false green, and
any outcome that would rest on an incomplete view re-observes ONCE at
`QA_ESCALATED_NODE_BUDGET` before concluding. A claim that is still unprovable
against the fuller view carries `completeness.reason: "INCONCLUSIVE_TRUNCATED"`
— distinct from an ordinary failure — while a node that WAS returned remains
sound evidence of presence. Whenever truncation touched a decision, the
`completeness` block (budget, truncation state, escalation) is written into
`report.json`, `report.jsonl` and a "view completeness" line in `report.md`.
The replay runner resolves action targets the same way, and the exporter records
a truncated proof observation as a `Weak proof:` note in the step intent. Full
rationale: `docs/TRUNCATION.md`.

**Absence passes require VERIFIED coverage (QA-BL-052 -> C2, contract v9).**
`node-absent` means "no driver-OBSERVABLE semantic node" — the driver's
projection excludes hidden and zero-rect elements — and it PASSES iff nothing
matched AND the deciding view is complete (`truncated: false`) AND
`coverage.verified: true`: the terminal absence decision requests the
driver's bounded closed-shadow-root probe on its ONE deciding re-observation
(never on settle polls; ~5 ms scoped, possibly over-budget whole-page on very
large pages — and then the absence is UNPROVEN). A probe that found closed
shadow roots or did not complete keeps the result `INCONCLUSIVE_TRUNCATED` /
`COVERAGE_UNVERIFIED`, naming `closed-shadow-root` /
`shadow-coverage-unverified` in `completeness.detail` and
`truncationReasons`; a passing absence prints "No driver-observable semantic
node matching {predicate} was found within {scope|the whole page}; coverage
verified (N nodes probed). K hidden candidates excluded." A returned matching
node still fails `node-absent` normally, and `INCONCLUSIVE_TRUNCATED`
semantics are unchanged.

### Scoped observation (browser driver contract v9)

The browser clamp stays at 100 nodes while real pages exceed it, so `qa_observe`
accepts `within_ref` — an opaque ref from the caller's CURRENT observation — and
observes only the composed subtree rooted at that element. Budgets, the byte
ceiling, the scan window, and the iframe marker become **subtree-relative**: a
container whose subtree fits reports `truncated: false` with no
`truncationReasons`, and a deep target unreachable in the whole-page window
becomes reachable. A scoped `node-absent` passes only when the deciding
re-read's coverage probe verified the SUBTREE (see above).
The observation's `scope` field (`{ ref, rootRef, role, name, tag }`) echoes
the root the driver observed; `rootRef` (contract v9) is the fresh
per-observation ref that chains the next scoped read even when the visibility
gate hides the root. Whole-page observations carry none. An unknown, expired,
consumed, non-element, or detached ref refuses the call with its driver code
(`REF_UNKNOWN` / `REF_EXPIRED` / `TARGET_CHANGED` / …) — never a whole-page
fallback, never a "not found". The computer driver does not support scoping and
refuses `within_ref`.

Scoped observations flow into Replay: a scenario assertion may carry
`scope: { role, name, tag?, path? }` (an empty name kept literally; `path`
is the container's semantic ancestor chain from record-time ancestry,
outermost first, recorded when available — a stronger replay locator). The
runner resolves that container in the whole-page view by UNIQUE predicate
plus the recorded path when present (`TARGET_NOT_UNIQUE` when ambiguous,
never a guess). One match in a TRUNCATED whole-page view is not proven
uniqueness: a non-scroll-proof scope without a path escalates the budget once
and refuses a still-truncated view with `INCONCLUSIVE_TRUNCATED` naming the
scope, while a scoped SCROLL-proof step — or any scope carrying a recorded
path — resolves PROVISIONALLY. A provisional resolution means the step
carries `scopeResolution: 'provisional'` and `reason: INCONCLUSIVE_SCOPE`,
**never a pass**: the container may be the wrong one (a twin outside the
window), so PASS is reserved for proven resolution. The replayed scroll is
still executed and is verified through the driver's identity anchor
(`anchorLastAction` on the verifying read): the anchor must report the
original acted element connected, contained in the container, and in the
viewport, AND bound to the SAME node ref as the asserted target — a lost
binding or mismatch is disclosed as `scopeRefusal` on the step, never a
predicate reselect. Run status is now THREE-state: `pass` only when every
required step and final assertion is fully proven; `inconclusive` when at
least one result is provisional and nothing definitely failed; `fail`
otherwise. The `completeness` block names the scope when the deciding view
was scoped, so "absent from this container" is never read as "absent from the
whole page" — and absence passes only with verified coverage. Export records
a scoped proof as a scoped assertion DURABLY only when the container
predicate is unique in a COMPLETE recorded baseline observation that is NOT
the container's own subtree; the identity-anchored scroll proof is exported
explicitly PROVISIONAL (the step intent says so) when uniqueness is unproven,
and every other scoped assertion is excluded with `SCOPE_NOT_DURABLE` —
never silently exported as a whole-page proof. See `docs/TRUNCATION.md`.

### Visual assertions (advisory)

`qa_assert kind:"visual"` captures the current screen and asks the host vision
model one question. The verdict is **advisory**: it is recorded in the report and
excluded from the determinism comparison by schema, and it never changes a run's
three-state status (pass / inconclusive / fail).

Two rules come from live use against `deepseek-v4-flash-vision-exp`:

- **Trust `verdict` and `confidence`; never quote `reasoning` as observed fact.**
  In a real run the model correctly answered `yes` (confidence 1.00) to "is the
  serif WIKIPEDIA wordmark present" and then narrated "with the puzzle globe
  logo" — a logo that was not on the page. The reasoning is kept as triage
  context, but every advisory record carries
  `reasoningTrust: "unverified-model-narration"` in `report.json` /
  `report.jsonl` and the `qa_assert` result, and `report.md` renders it under a
  `## Advisory (model-generated; never affects pass/fail)` heading as a labelled
  "model narration" blockquote. Rationale and the full decision:
  `docs/REDACTION_SPEC.md` section 7.3.
- **A capture is always bound to a fresh observation.** Both drivers refuse a
  capture bound to a stale observation (the browser driver: "the semantic
  observation expired; observe again before visual capture"), because the
  Set-of-Mark annotations and the pixels must describe the same view. Rather than
  weakening that rule or reusing an older frame, `captureLatestVisual` takes a
  fresh settled observation immediately before every capture, for both drivers —
  so `qa_assert` visual and `qa_evidence visual:true` work directly after
  `qa_act` or each other, with no manual `qa_observe` in between. A capture the
  caller pinned explicitly (browser `visual_fingerprint`, computer
  `observationId`) is never silently refreshed: the pin is honored and a stale
  pin is refused by the driver, by design.

### Host runtime

This package declares **zero host packages** in `dependencies`/`peerDependencies`.
The DSH host provides the runtime services below itself. `npm install
@zseven-w/dsh-qa` must pull in no `@deepseek-ai/*` packages at all — a
packaging invariant enforced against a real packed install by
[`scripts/smoke-pack.mjs`](./scripts/smoke-pack.mjs).

```json
{
  "dshHostRuntime": {
    "services": ["tools", "attachments", "llm", "approval"],
    "typing": "structural"
  }
}
```

The optional skill service is registered exclusively through
`ctx.inject(['skills'], cb)` and torn down with `fiber.dispose()`.

</details>

## Running the shipped example

The package payload includes a self-contained browser example:
[`scenarios/examples/fixture-web.json`](./scenarios/examples/fixture-web.json)
drives the [`fixtures/web/`](./fixtures/web/) page. With `@zseven-w/dsh-qa`
and `@zseven-w/dsh-browser` installed, run it from the installed copy — no
files from this repository's working tree are needed:

```bash
node node_modules/@zseven-w/dsh-qa/scripts/run-example.mjs
```

(or, from inside the installed package directory, `npm run example`).

`run-example.mjs` serves `fixtures/web/` on an ephemeral loopback port (never
a hardcoded one), rebinds the scenario's `target.launch` to that origin, replays
it headlessly through the browser driver, and writes `report.json` / `report.md`
/ `report.jsonl`. A working install prints:

```
[example] status: pass
[example] report: <dir>/report.json
```

Exit code is `0` iff `status === "pass"`; pass `--output-dir <dir>` to choose
where reports go (default `./dsh-qa-example-report`). The browser driver is
host-provided in a DSH install; in a standalone installation, make
`@zseven-w/dsh-browser` available alongside it. `scripts/smoke-pack.mjs` runs this exact
command from the packed tarball and asserts `status: "pass"`.

## Development

Development uses **pnpm 10.34.5** and a sibling checkout layout: the four
driver repositories are `link:` dev dependencies, so clone them next to this
one (`dsh-browser`, `dsh-computer`, `dsh-ios`, `dsh-android`) and satisfy each
one's own build prerequisites. CI does not clone them — it materializes the
same directories from the published tarballs
(`.github/scripts/fetch-drivers.sh`), which is also how you reproduce a CI
failure locally against released driver bytes.

```bash
pnpm install
npm run build        # build both the MCP server and plugin entry
npm run typecheck
npm test             # everything; see the prerequisite note below
npm run test:ci      # everything a machine without a granted helper can run
npm run smoke:bundle # real stdio handshake from a node_modules-free copy
npm run smoke:pack   # prepack gates -> pack -> fresh install -> handshake + example
```

`npm test` is the acceptance command and it does not skip: it needs macOS, a
built and granted DSH Computer Helper (Accessibility + Screen Recording), and
an installed browser. `test/computer-integration.test.mjs` fails loudly rather
than passing vacuously when the grant is missing, which is why `test:ci`
excludes that one file by name rather than guarding inside it — a hosted-CI
green says "everything except that named suite passed", never "the suite
passed". Do not publish generated reports, login state, device identifiers, or
signing material.

## Documentation

- [Explore playbook](./skills/qa-explore/SKILL.md) — agent workflow and export rules.
- [Bounded settle](./docs/SETTLE.md) — asynchronous outcomes and proof timing.
- [Observation completeness](./docs/TRUNCATION.md) — truncation, scope, and absence assertions.
- [Login-state injection](./docs/LOGIN_STATE.md) — explicit-owner authorization and exact origins.
- [Redaction specification](./docs/REDACTION_SPEC.md) — report boundaries and advisory provenance.
- [Example scenarios](./scenarios/examples/) — declarative replay inputs.

`docs/` and the Explore playbook ship inside the package, so these references
are readable from an installed copy as well as from the repository.

## License

[MIT](./LICENSE).
