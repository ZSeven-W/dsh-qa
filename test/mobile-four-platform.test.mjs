// Four-platform tool/replay/export integration tests for the mobile routes.
//
// These tests exercise the REAL mobile adapters (IosAdapter / AndroidAdapter
// from src/adapters) against fake backends injected through the same lazy
// loader seams used by production. They prove:
//
//   - qa_replay_run routes ios/android scenarios through the mobile loader,
//     not browser/computer;
//   - explicit device_id reaches QaStartOptions and overrides recorded IDs;
//   - stable identifier predicates (resourceId / AXUniqueId) survive
//     export->file->replay;
//   - missing driver/failed launch are fail-closed and cleanup still runs.
//
// These are deterministic unit/integration tests, not live four-platform runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createQaMcpServer } from '../src/mcp-server.ts';
import { createQaTools, QaToolHost } from '../src/tools.ts';
import { QaTrajectoryRecorder, RecordingQaDriverAdapter } from '../src/explore/index.ts';
import { QaSession } from '../src/session/session.ts';
import { exportRecordedScenario } from '../src/explore/index.ts';

const SETTLE = { budgetMs: 500, quietMs: 30, postChangeQuietMs: 30, intervalMs: 5, adaptiveBudgetMs: 0 };

const IOS_DEVICE = 'UDID-FAKE-0001';
const IOS_BUNDLE = 'com.example.qa.ios';
const ANDROID_DEVICE = 'emulator-5554';
const ANDROID_PACKAGE = 'com.example.qa.android';

function iosScenario(deviceId = IOS_DEVICE, bundleId = IOS_BUNDLE) {
  return {
    meta: { name: 'ios-replay', description: 'd', driver: 'ios', createdAt: '2026-01-01T00:00:00.000Z' },
    target: { launch: bundleId, deviceId },
    steps: [
      {
        index: 1,
        intent: 'tap the action',
        action: { kind: 'click', target: { identifier: 'button.action' } },
        assert: { kind: 'node-present', expected: { role: 'AXStaticText', name: 'Done', identifier: 'label.done' } },
      },
    ],
    assertions: [],
  };
}

function androidScenario(deviceId = ANDROID_DEVICE, packageName = ANDROID_PACKAGE) {
  return {
    meta: { name: 'android-replay', description: 'd', driver: 'android', createdAt: '2026-01-01T00:00:00.000Z' },
    target: { launch: packageName, deviceId },
    steps: [
      {
        index: 1,
        intent: 'tap the action',
        action: { kind: 'click', target: { identifier: 'button.action' } },
        assert: { kind: 'node-present', expected: { role: 'android.widget.TextView', name: 'Done', identifier: 'label.done' } },
      },
    ],
    assertions: [],
  };
}

function fakeIosBackend({ deviceId = IOS_DEVICE, bundleId = IOS_BUNDLE, failLaunch = false, useObservedDevice = deviceId } = {}) {
  let clicked = false;
  const calls = { launch: [], observe: 0, tap: 0, dispose: 0 };
  const backend = {
    async launchApp(udid, appId) {
      calls.launch.push({ udid, appId });
      if (failLaunch) throw new Error('iOS launch failed');
      return { ok: true, udid, backend: 'simulator', action: 'launch' };
    },
    async observe(udid) {
      calls.observe += 1;
      const observed = useObservedDevice;
      if (udid !== observed) throw new Error('wrong device: expected ' + observed + ' but got ' + udid);
      return {
        udid: observed,
        backend: 'simulator',
        app: { bundleId, verified: true },
        screen: { width: 390, height: 844 },
        truncated: false,
        depth: 1,
        maxNodes: 100,
        nodes: [
          { identifier: 'button.action', type: 'AXButton', name: 'Action', frame: { x: 10, y: 10, width: 100, height: 40 }, enabled: true },
          ...(clicked ? [{ identifier: 'label.done', type: 'AXStaticText', name: 'Done', frame: { x: 10, y: 60, width: 50, height: 20 }, enabled: true }] : []),
        ],
      };
    },
    async tap(udid) {
      calls.tap += 1;
      clicked = true;
      return { ok: true, udid, backend: 'simulator', action: 'tap' };
    },
    async type() { return { ok: true, udid: deviceId, backend: 'simulator', action: 'type' }; },
    async scroll() { return { ok: true, udid: deviceId, backend: 'simulator', action: 'scroll' }; },
    async key() { return { ok: true, udid: deviceId, backend: 'simulator', action: 'key' }; },
    async foregroundApp() { return { udid: deviceId, backend: 'simulator', app: { bundleId, verified: true } }; },
    async screenshot() { throw new Error('screenshot not expected'); },
    async dispose() { calls.dispose += 1; },
  };
  return { backend, calls };
}

function fakeAndroidBackend({ deviceId = ANDROID_DEVICE, packageName = ANDROID_PACKAGE, failLaunch = false, useObservedDevice = deviceId } = {}) {
  let clicked = false;
  const calls = { launch: [], observe: 0, tap: 0, dispose: 0 };
  const node = (id, role, name) => ({
    role,
    className: role,
    resourceId: id,
    name,
    text: name,
    contentDesc: name,
    frame: { x: 10, y: 10, width: 100, height: 40 },
    enabled: true,
    focused: false,
    clickable: true,
    scrollable: false,
    password: false,
    packageName,
    children: [],
  });
  const backend = {
    async launchApp(serial, appId) {
      calls.launch.push({ serial, appId });
      if (failLaunch) throw new Error('Android launch failed');
    },
    async observe(serial) {
      calls.observe += 1;
      const observed = useObservedDevice;
      if (serial !== observed) throw new Error('wrong device: expected ' + observed + ' but got ' + serial);
      return {
        serial: observed,
        packageName,
        foreground: { packageName, activity: '.Main', raw: 'x' },
        screen: { width: 1080, height: 2400 },
        coordinateSpace: 'display-pixels',
        nodes: [node('button.action', 'android.widget.Button', 'Action'), ...(clicked ? [node('label.done', 'android.widget.TextView', 'Done')] : [])],
        nodeCount: clicked ? 2 : 1,
        truncated: false,
        budgetBytes: 1_000_000,
      };
    },
    async tap() { calls.tap += 1; clicked = true; },
    async type() {},
    async scroll() {},
    async key() {},
    async foregroundApp() { return { packageName, activity: '.Main', raw: 'x' }; },
    async screenshot() { throw new Error('screenshot not expected'); },
    async dispose() { calls.dispose += 1; },
  };
  return { backend, calls };
}

async function writeScenario(dir, scenario) {
  const path = join(dir, 'scenario.json');
  await writeFile(path, JSON.stringify(scenario));
  return path;
}

test('Cordis qa_replay_run replays an iOS scenario through the mobile ios loader and disposes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-ios-cordis-'));
  try {
    const scenarioPath = await writeScenario(dir, iosScenario());
    const { backend, calls } = fakeIosBackend();
    const host = new QaToolHost({
      settle: SETTLE,
      replayLoaders: { ios: async () => backend },
    });
    const tools = createQaTools(host);
    const report = await tools.qaReplayRun.execute({ scenario: scenarioPath, owner: 'cordis-ios' }, {});
    assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? report.steps));
    assert.equal(report.driver, 'ios');
    assert.deepEqual(calls.launch[0], { udid: IOS_DEVICE, appId: IOS_BUNDLE });
    assert.equal(calls.tap, 1);
    assert.equal(calls.dispose, 1, 'seam teardown disposes the mobile backend');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Cordis qa_replay_run replays an Android scenario through the mobile android loader and disposes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-android-cordis-'));
  try {
    const scenarioPath = await writeScenario(dir, androidScenario());
    const { backend, calls } = fakeAndroidBackend();
    const host = new QaToolHost({
      settle: SETTLE,
      replayLoaders: { android: async () => backend },
    });
    const tools = createQaTools(host);
    const report = await tools.qaReplayRun.execute({ scenario: scenarioPath, owner: 'cordis-android' }, {});
    assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? report.steps));
    assert.equal(report.driver, 'android');
    assert.deepEqual(calls.launch[0], { serial: ANDROID_DEVICE, appId: ANDROID_PACKAGE });
    assert.equal(calls.tap, 1);
    assert.equal(calls.dispose, 1, 'seam teardown disposes the mobile backend');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function mcpReplayCall(server, scenarioPath, extra = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'dsh-qa-mobile-mcp', version: '0.1.0' });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'qa_replay_run',
      arguments: { scenario: scenarioPath, owner: 'mcp-mobile', ...extra },
    });
    const text = result.content.find((item) => item.type === 'text')?.text;
    assert.equal(typeof text, 'string');
    return JSON.parse(text);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

test('MCP qa_replay_run replays both mobile kinds through their mobile loaders', async () => {
  const iosDir = await mkdtemp(join(tmpdir(), 'dsh-qa-mcp-ios-'));
  const androidDir = await mkdtemp(join(tmpdir(), 'dsh-qa-mcp-android-'));
  try {
    const iosScenarioPath = await writeScenario(iosDir, iosScenario());
    const androidScenarioPath = await writeScenario(androidDir, androidScenario());
    const iosBackend = fakeIosBackend();
    const androidBackend = fakeAndroidBackend();
    const iosServer = createQaMcpServer({ loaders: { ios: async () => iosBackend.backend } });
    const androidServer = createQaMcpServer({ loaders: { android: async () => androidBackend.backend } });
    const iosReport = await mcpReplayCall(iosServer, iosScenarioPath);
    assert.equal(iosReport.status, 'pass', JSON.stringify(iosReport.failure ?? iosReport.steps));
    assert.equal(iosReport.driver, 'ios');
    assert.equal(iosBackend.calls.dispose, 1);
    const androidReport = await mcpReplayCall(androidServer, androidScenarioPath);
    assert.equal(androidReport.status, 'pass', JSON.stringify(androidReport.failure ?? androidReport.steps));
    assert.equal(androidReport.driver, 'android');
    assert.equal(androidBackend.calls.dispose, 1);
  } finally {
    await rm(iosDir, { recursive: true, force: true });
    await rm(androidDir, { recursive: true, force: true });
  }
});

test('Cordis qa_replay_run applies an explicit device_id override instead of the recorded one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-mobile-override-'));
  try {
    const scenarioPath = await writeScenario(dir, iosScenario(IOS_DEVICE + '-recorded'));
    const { backend, calls } = fakeIosBackend({ deviceId: IOS_DEVICE, useObservedDevice: IOS_DEVICE });
    const host = new QaToolHost({
      settle: SETTLE,
      replayLoaders: { ios: async () => backend },
    });
    const tools = createQaTools(host);
    const report = await tools.qaReplayRun.execute({
      scenario: scenarioPath,
      owner: 'override-ios',
      device_id: IOS_DEVICE,
    }, {});
    assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? report.steps));
    assert.deepEqual(calls.launch[0], { udid: IOS_DEVICE, appId: IOS_BUNDLE });
    assert.equal(calls.observe > 0, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing mobile driver / failed mobile launch fail closed and backend cleanup still runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-mobile-fail-'));
  try {
    const scenarioPath = await writeScenario(dir, androidScenario());
    const missingHost = new QaToolHost({
      settle: SETTLE,
      replayLoaders: { android: async () => { throw new Error('android driver not installed') } },
    });
    const missing = await createQaTools(missingHost).qaReplayRun.execute({ scenario: scenarioPath, owner: 'missing' }, {});
    assert.equal(missing.ok, false);
    assert.match(missing.error, /android driver not installed/);

    const failBackend = fakeAndroidBackend({ failLaunch: true });
    const failHost = new QaToolHost({
      settle: SETTLE,
      replayLoaders: { android: async () => failBackend.backend },
    });
    const failed = await createQaTools(failHost).qaReplayRun.execute({ scenario: scenarioPath, owner: 'launch-fail' }, {});
    assert.equal(failed.status, 'blocked');
    assert.match(failed.failure?.message ?? '', /Android launch failed/);
    assert.equal(failBackend.calls.dispose, 1, 'launch failure still disposes the backend');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Explore record/export writes stable mobile identifiers/deviceId and exact-file replay passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-mobile-export-'));
  try {
    const { backend } = fakeIosBackend();
    const recorder = new QaTrajectoryRecorder();
    // Use the real IosAdapter over the fake backend so export sees the same
    // normalization/stable identifiers as replay.
    const { IosAdapter } = await import('../src/adapters/index.ts');
    const adapter = new IosAdapter(backend);
    const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'mobile-export', { settle: SETTLE });
    await session.start({ deviceId: IOS_DEVICE, bundleId: IOS_BUNDLE });
    const initial = await session.observeSettled();
    const ref = initial.observation.nodes.find((node) => node.identifier === 'button.action')?.ref;
    assert.ok(ref, 'button ref exists');
    const acted = await session.act({ kind: 'click', ref });
    assert.equal(acted.outcome, 'unknown');
    assert.equal(acted.settle.stable, true, 'post-click observation settled');
    await session.stop();
    const outputPath = join(dir, 'mobile.json');
    const exported = await exportRecordedScenario(recorder, 'mobile-export', { outputPath });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    assert.equal(exported.excludedActions.length, 0, JSON.stringify(exported.excludedActions));
    assert.equal(exported.scenario.meta.driver, 'ios');
    assert.equal(exported.scenario.target.deviceId, IOS_DEVICE);
    assert.equal(exported.scenario.target.launch, IOS_BUNDLE);
    const step = exported.scenario.steps[0];
    assert.equal(step.action.kind, 'click');
    assert.equal(step.action.target.identifier, 'button.action', 'stable identifier is the durable selector');
    assert.equal(step.action.target.ref, undefined, 'no ephemeral ref is persisted');
    assert.equal(step.action.target.frame, undefined, 'no coordinates are persisted');

    // Exact-file replay through the shared loader seam.
    const replayBackend = fakeIosBackend();
    const host = new QaToolHost({
      settle: SETTLE,
      replayLoaders: { ios: async () => replayBackend.backend },
    });
    const report = await createQaTools(host).qaReplayRun.execute({ scenario: outputPath, owner: 'replay-exported' }, {});
    assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? report.steps));
    assert.equal(replayBackend.calls.dispose, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Explore record/export/replay keeps a durable role+name selector for identifier-less iOS input (no refs, no coordinates)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-mobile-semantic-'));
  try {
    const makeSemanticBackend = () => {
      const calls = { launch: [], observe: 0, tap: 0, rawType: 0, typeTarget: [], fillTarget: [], dispose: 0 };
      let value = '';
      const backend = {
        async launchApp(udid, appId) { calls.launch.push({ udid, appId }); return { ok: true, udid, backend: 'simulator', action: 'launch' }; },
        async observe(udid) {
          calls.observe += 1;
          return {
            udid,
            backend: 'simulator',
            app: { bundleId: IOS_BUNDLE, pid: 10, verified: true },
            screen: { width: 390, height: 844 },
            truncated: false,
            depth: 1,
            maxNodes: 100,
            nodes: [
              { type: 'SearchField', name: 'Search conversations', frame: { x: 10, y: 10, width: 200, height: 44 }, enabled: true, secure: false, value },
              { type: 'AXStaticText', name: 'Chats', frame: { x: 10, y: 60, width: 50, height: 20 }, enabled: true },
            ],
          };
        },
        async typeTarget(target) { calls.typeTarget.push(target); value = value + target.text; return { udid: target.udid, backend: 'simulator', action: 'typeTarget', mode: 'append', status: 'unknown', dispatched: true, nativeAccepted: true }; },
        async fillTarget(target) { calls.fillTarget.push(target); value = target.text; return { udid: target.udid, backend: 'simulator', action: 'fillTarget', mode: 'replace', status: 'unknown', dispatched: true, nativeAccepted: true }; },
        async tap(udid) { calls.tap += 1; return { ok: true, udid, backend: 'simulator', action: 'tap' }; },
        async type() { calls.rawType += 1; return { ok: true, udid: IOS_DEVICE, backend: 'simulator', action: 'type' }; },
        async scroll() { return { ok: true, udid: IOS_DEVICE, backend: 'simulator', action: 'scroll' }; },
        async key() { return { ok: true, udid: IOS_DEVICE, backend: 'simulator', action: 'key' }; },
        async foregroundApp() { return { udid: IOS_DEVICE, backend: 'simulator', app: { bundleId: IOS_BUNDLE, pid: 10, verified: true } }; },
        async screenshot() { throw new Error('screenshot not expected'); },
        async dispose() { calls.dispose += 1; },
      };
      return { backend, calls };
    };

    // Record a fill on the identifier-less field through the REAL adapter.
    const recorded = makeSemanticBackend();
    const recorder = new QaTrajectoryRecorder();
    const { IosAdapter } = await import('../src/adapters/index.ts');
    const adapter = new IosAdapter(recorded.backend);
    const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'semantic-export', { settle: SETTLE });
    await session.start({ deviceId: IOS_DEVICE, bundleId: IOS_BUNDLE });
    const initial = await session.observeSettled();
    const ref = initial.observation.nodes.find((n) => n.name === 'Search conversations' && n.identifier === undefined)?.ref;
    assert.ok(ref, 'identifier-less field ref exists');
    const acted = await session.act({ kind: 'fill', ref, text: 'cleared' });
    assert.equal(acted.outcome, 'unknown');
    assert.equal(acted.settle.stable, true, 'post-fill observation settled');
    await session.stop();

    const outputPath = join(dir, 'semantic.json');
    const exported = await exportRecordedScenario(recorder, 'semantic-export', { outputPath });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    assert.equal(exported.excludedActions.length, 0, JSON.stringify(exported.excludedActions));
    assert.equal(exported.scenario.meta.driver, 'ios');
    const step = exported.scenario.steps[0];
    assert.equal(step.action.kind, 'fill');
    assert.deepEqual(step.action.target, { role: 'SearchField', name: 'Search conversations' }, 'durable role+name is the missing-identifier selector');
    assert.equal(step.action.target.identifier, undefined, 'no fabricated identifier is persisted');
    assert.equal(step.action.target.ref, undefined, 'no ephemeral ref is persisted');
    assert.equal(step.action.target.frame, undefined, 'no coordinates are persisted');
    const json = JSON.stringify(exported.scenario);
    assert.equal(json.includes('mob:ios'), false, 'no transient adapter refs leak into the export');
    assert.equal(json.includes('"frame"'), false, 'no coordinate/frame data leaks into the export');

    // Exact-file replay re-resolves the role+name predicate on a fresh tree
    // and dispatches the SAME semantic selector, never a global fallback.
    const replay = makeSemanticBackend();
    const host = new QaToolHost({
      settle: SETTLE,
      replayLoaders: { ios: async () => replay.backend },
    });
    const report = await createQaTools(host).qaReplayRun.execute({ scenario: outputPath, owner: 'replay-semantic' }, {});
    assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? report.steps));
    assert.equal(replay.calls.fillTarget.length, 1, 'replay dispatched exactly one element-bound fill');
    const sent = replay.calls.fillTarget[0];
    assert.equal(sent.identifier, undefined, 'replay sends no fabricated identifier');
    assert.deepEqual(sent.semantic, { label: 'Search conversations', type: 'SearchField' });
    assert.equal(sent.text, 'cleared');
    assert.equal(replay.calls.rawType, 0, 'no raw global typing fallback during replay');
    assert.equal(replay.calls.tap, 0, 'the element-bound route taps nothing');
    assert.equal(replay.calls.dispose, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Empty fill is a legitimate clear: the export keeps the step (text: ''), the
// proof stays the target's own value, and exact-file replay dispatches both
// the fill and the empty restore with the same semantic selector.
test('Explore record/export/replay roundtrips fill + empty-fill clear for identifier-less iOS input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-mobile-clear-'));
  try {
    const makeClearBackend = () => {
      const calls = { observe: 0, rawType: 0, tap: 0, fillTarget: [], dispose: 0 };
      let value = '';
      const backend = {
        async launchApp(udid) { return { ok: true, udid, backend: 'simulator', action: 'launch' }; },
        async observe(udid) {
          calls.observe += 1;
          return {
            udid,
            backend: 'simulator',
            app: { bundleId: IOS_BUNDLE, pid: 10, verified: true },
            screen: { width: 390, height: 844 },
            truncated: false,
            depth: 1,
            maxNodes: 100,
            nodes: [{ type: 'SearchField', name: 'Search conversations', frame: { x: 10, y: 10, width: 200, height: 44 }, enabled: true, secure: false, value }],
          };
        },
        async typeTarget(target) { value = value + target.text; return { udid: target.udid, backend: 'simulator', action: 'typeTarget', mode: 'append', status: 'unknown', dispatched: true, nativeAccepted: true }; },
        async fillTarget(target) { calls.fillTarget.push(target); value = target.text; return { udid: target.udid, backend: 'simulator', action: 'fillTarget', mode: 'replace', status: 'unknown', dispatched: true, nativeAccepted: true }; },
        async tap(udid) { calls.tap += 1; return { ok: true, udid, backend: 'simulator', action: 'tap' }; },
        async type() { calls.rawType += 1; return { ok: true, udid: IOS_DEVICE, backend: 'simulator', action: 'type' }; },
        async scroll() { return { ok: true, udid: IOS_DEVICE, backend: 'simulator', action: 'scroll' }; },
        async key() { return { ok: true, udid: IOS_DEVICE, backend: 'simulator', action: 'key' }; },
        async foregroundApp() { return { udid: IOS_DEVICE, backend: 'simulator', app: { bundleId: IOS_BUNDLE, pid: 10, verified: true } }; },
        async screenshot() { throw new Error('screenshot not expected'); },
        async dispose() { calls.dispose += 1; },
      };
      return { backend, calls };
    };

    const recorded = makeClearBackend();
    const recorder = new QaTrajectoryRecorder();
    const { IosAdapter } = await import('../src/adapters/index.ts');
    const adapter = new IosAdapter(recorded.backend);
    const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'clear-export', { settle: SETTLE });
    await session.start({ deviceId: IOS_DEVICE, bundleId: IOS_BUNDLE });
    const first = await session.observeSettled();
    const firstRef = first.observation.nodes.find((n) => n.name === 'Search conversations')?.ref;
    assert.ok(firstRef);
    const filled = await session.act({ kind: 'fill', ref: firstRef, text: 'cleared' });
    assert.equal(filled.outcome, 'unknown');
    assert.equal(filled.settle.stable, true);
    const second = await session.observeSettled();
    const clearRef = second.observation.nodes.find((n) => n.name === 'Search conversations' && n.value === 'cleared')?.ref;
    assert.ok(clearRef);
    const cleared = await session.act({ kind: 'fill', ref: clearRef, text: '' });
    assert.equal(cleared.outcome, 'unknown');
    assert.equal(cleared.settle.stable, true, 'the clear settle window stabilizes');
    await session.stop();

    const outputPath = join(dir, 'clear.json');
    const exported = await exportRecordedScenario(recorder, 'clear-export', { outputPath });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    assert.equal(exported.excludedActions.length, 0, JSON.stringify(exported.excludedActions));
    assert.equal(exported.scenario.steps.length, 2, 'fill and empty clear are both exported');
    const fillStep = exported.scenario.steps[0];
    assert.equal(fillStep.action.kind, 'fill');
    assert.equal(fillStep.action.text, 'cleared');
    assert.deepEqual(fillStep.action.target, { role: 'SearchField', name: 'Search conversations' });
    assert.equal(fillStep.assert.kind, 'node-value');
    assert.equal(fillStep.assert.expected.value, 'cleared', 'the fill keeps its own-value proof');
    const clearStep = exported.scenario.steps[1];
    assert.equal(clearStep.action.kind, 'fill');
    assert.equal(clearStep.action.text, '', 'the empty fill is exported as the legitimate clear');
    assert.deepEqual(clearStep.action.target, { role: 'SearchField', name: 'Search conversations' });
    assert.equal(clearStep.assert.kind, 'node-value');
    assert.equal(clearStep.assert.expected.value, '', 'the clear keeps its own-value proof (empty value)');
    const json = JSON.stringify(exported.scenario);
    assert.equal(json.includes('mob:ios'), false);
    assert.equal(json.includes('\"frame\"'), false);

    const replay = makeClearBackend();
    const host = new QaToolHost({ settle: SETTLE, replayLoaders: { ios: async () => replay.backend } });
    const report = await createQaTools(host).qaReplayRun.execute({ scenario: outputPath, owner: 'replay-clear' }, {});
    assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? report.steps));
    assert.equal(replay.calls.fillTarget.length, 2, 'fill and empty restore both dispatch');
    assert.equal(replay.calls.fillTarget[0].text, 'cleared');
    assert.deepEqual(replay.calls.fillTarget[0].semantic, { label: 'Search conversations', type: 'SearchField' });
    assert.equal(replay.calls.fillTarget[1].text, '', 'the replay clear carries the empty text verbatim');
    assert.deepEqual(replay.calls.fillTarget[1].semantic, { label: 'Search conversations', type: 'SearchField' });
    assert.equal(replay.calls.rawType, 0, 'no raw global typing fallback');
    assert.equal(replay.calls.tap, 0);
    assert.equal(replay.calls.dispose, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Empty TYPE stays a rejected replay serialization (append-nothing is not a
// legitimate clear): the fill steps still export and the exact file replays.
test('Explore export keeps excluding empty type text while empty fill clears export', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-mobile-type-empty-'));
  try {
    const calls = { rawType: 0, typeTarget: [], fillTarget: [], dispose: 0 };
    let value = '';
    const backend = {
      async launchApp(udid) { return { ok: true, udid, backend: 'simulator', action: 'launch' }; },
      async observe(udid) {
        return {
          udid,
          backend: 'simulator',
          app: { bundleId: IOS_BUNDLE, pid: 10, verified: true },
          screen: { width: 390, height: 844 },
          truncated: false,
          depth: 1,
          maxNodes: 100,
          nodes: [{ type: 'SearchField', name: 'Search conversations', frame: { x: 10, y: 10, width: 200, height: 44 }, enabled: true, secure: false, value }],
        };
      },
      async typeTarget(target) { calls.typeTarget.push(target); value = value + target.text; return { udid: target.udid, backend: 'simulator', action: 'typeTarget', mode: 'append', status: 'unknown', dispatched: true, nativeAccepted: true }; },
      async fillTarget(target) { calls.fillTarget.push(target); value = target.text; return { udid: target.udid, backend: 'simulator', action: 'fillTarget', mode: 'replace', status: 'unknown', dispatched: true, nativeAccepted: true }; },
      async tap(udid) { return { ok: true, udid, backend: 'simulator', action: 'tap' }; },
      async type() { calls.rawType += 1; return { ok: true, udid: IOS_DEVICE, backend: 'simulator', action: 'type' }; },
      async scroll() { return { ok: true, udid: IOS_DEVICE, backend: 'simulator', action: 'scroll' }; },
      async key() { return { ok: true, udid: IOS_DEVICE, backend: 'simulator', action: 'key' }; },
      async foregroundApp() { return { udid: IOS_DEVICE, backend: 'simulator', app: { bundleId: IOS_BUNDLE, pid: 10, verified: true } }; },
      async screenshot() { throw new Error('screenshot not expected'); },
      async dispose() { calls.dispose += 1; },
    };

    const recorder = new QaTrajectoryRecorder();
    const { IosAdapter } = await import('../src/adapters/index.ts');
    const adapter = new IosAdapter(backend);
    const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'type-empty-export', { settle: SETTLE });
    await session.start({ deviceId: IOS_DEVICE, bundleId: IOS_BUNDLE });
    const first = await session.observeSettled();
    const firstRef = first.observation.nodes.find((n) => n.name === 'Search conversations')?.ref;
    await session.act({ kind: 'fill', ref: firstRef, text: 'cleared' });
    const second = await session.observeSettled();
    const typeRef = second.observation.nodes.find((n) => n.name === 'Search conversations')?.ref;
    await session.act({ kind: 'type', ref: typeRef, text: '' });
    await session.stop();

    const outputPath = join(dir, 'type-empty.json');
    const exported = await exportRecordedScenario(recorder, 'type-empty-export', { outputPath });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    assert.equal(exported.scenario.steps.length, 1, 'only the fill step is exported');
    assert.equal(exported.scenario.steps[0].action.kind, 'fill');
    assert.equal(exported.scenario.steps[0].action.text, 'cleared');
    assert.equal(exported.excludedActions.length, 1, 'the empty type is excluded');
    assert.equal(exported.excludedActions[0].reason, 'UNSUPPORTED_REPLAY_ACTION');
    assert.match(exported.excludedActions[0].detail, /type text must be non-empty/);

    const replayBackend = { ...backend, calls: { rawType: 0, typeTarget: [], fillTarget: [], dispose: 0 } };
    let replayValue = '';
    replayBackend.observe = async (udid) => ({
      udid,
      backend: 'simulator',
      app: { bundleId: IOS_BUNDLE, pid: 10, verified: true },
      screen: { width: 390, height: 844 },
      truncated: false,
      depth: 1,
      maxNodes: 100,
      nodes: [{ type: 'SearchField', name: 'Search conversations', frame: { x: 10, y: 10, width: 200, height: 44 }, enabled: true, secure: false, value: replayValue }],
    });
    replayBackend.fillTarget = async (target) => { replayBackend.calls.fillTarget.push(target); replayValue = target.text; return { udid: target.udid, backend: 'simulator', action: 'fillTarget', mode: 'replace', status: 'unknown', dispatched: true, nativeAccepted: true }; };
    const host = new QaToolHost({ settle: SETTLE, replayLoaders: { ios: async () => replayBackend } });
    const report = await createQaTools(host).qaReplayRun.execute({ scenario: outputPath, owner: 'replay-type-empty' }, {});
    assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? report.steps));
    assert.equal(replayBackend.calls.fillTarget.length, 1);
    assert.equal(replayBackend.calls.typeTarget.length, 0, 'the excluded empty type never replays');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
