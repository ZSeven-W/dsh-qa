// Regression for Android fully-qualified resource IDs in the redaction seam.
//
// A real Android resourceId like
//   dev.zseven.qa.fixture.android:id/qa_input_name
// is an OPERATIONAL stable selector, not a secret or a free-text URI. The
// generic redactor had been collapsing it to [REDACTED], which made every
// mobile action that depended on the identifier unexportable
// (TARGET_HAS_NO_ACCESSIBLE_NAME). This file proves:
//   - the typed structural projection preserves real Android resource IDs under
//     identifier/tag fields,
//   - free-text occurrences still redact (no broad text redaction bypass),
//   - credential-shaped Android-looking identifiers are still fully redacted,
//   - record -> export -> exact-file replay keeps the real resourceId usable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQaTools, QaToolHost } from '../src/tools.ts';
import { QaTrajectoryRecorder, RecordingQaDriverAdapter, exportRecordedScenario } from '../src/explore/index.ts';
import { QaSession } from '../src/session/session.ts';
import { projectRedactedJsonValue, redactText } from '../src/redaction/index.ts';
import { AndroidAdapter } from '../src/adapters/android.ts';

const DEVICE = 'emulator-5554';
const PACKAGE = 'dev.zseven.qa.fixture.android';
const SETTLE = { budgetMs: 400, quietMs: 20, postChangeQuietMs: 20, intervalMs: 4, adaptiveBudgetMs: 0 };

const INPUT_RESOURCE = PACKAGE + ':id/qa_input_name';
const BUTTON_RESOURCE = PACKAGE + ':id/qa_apply_button';
const DONE_RESOURCE = PACKAGE + ':id/qa_done_label';

function node(id, role, name, extra = {}) {
  return {
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
    packageName: PACKAGE,
    children: [],
    ...extra,
  };
}

function fakeAndroidBackend() {
  let clicked = false;
  const calls = { observe: 0, tap: 0, dispose: 0 };
  const backend = {
    async launchApp(serial, appId) {
      if (serial !== DEVICE) throw new Error('wrong device ' + serial);
      if (appId !== PACKAGE) throw new Error('wrong app ' + appId);
    },
    async observe(serial) {
      calls.observe += 1;
      if (serial !== DEVICE) throw new Error('wrong device ' + serial);
      return {
        serial: DEVICE,
        packageName: PACKAGE,
        foreground: { packageName: PACKAGE, activity: '.Main', raw: 'x' },
        screen: { width: 1080, height: 2400 },
        coordinateSpace: 'display-pixels',
        nodes: [
          node(INPUT_RESOURCE, 'android.widget.EditText', 'QA Input Name', { focused: clicked ? true : false, text: clicked ? 'typed' : '' }),
          node(BUTTON_RESOURCE, 'android.widget.Button', 'Apply'),
          ...(clicked ? [node(DONE_RESOURCE, 'android.widget.TextView', 'Done', { enabled: true, clickable: false })] : []),
        ],
        nodeCount: clicked ? 3 : 2,
        truncated: false,
        budgetBytes: 1_000_000,
      };
    },
    async tap() { calls.tap += 1; clicked = true; },
    async type() {},
    async scroll() {},
    async key() {},
    async foregroundApp() { return { packageName: PACKAGE, activity: '.Main', raw: 'x' }; },
    async screenshot() { throw new Error('screenshot not expected'); },
    async dispose() { calls.dispose += 1; },
  };
  return { backend, calls };
}

test('typed JSON projection preserves real Android resourceIds only in identifier/tag positions', () => {
  const nodeObj = {
    nodes: [
      {
        role: 'android.widget.EditText',
        name: 'QA Input Name',
        tag: INPUT_RESOURCE,
        identifier: INPUT_RESOURCE,
      },
    ],
  };
  const projected = projectRedactedJsonValue(nodeObj);
  assert.equal(projected.nodes[0].identifier, INPUT_RESOURCE);
  assert.equal(projected.nodes[0].tag, INPUT_RESOURCE);
  // Free-text prose is NOT exempt: the same fully-qualified resource id still
  // goes through the normal redactor outside a stable-identifier/tag field.
  const proseOut = projectRedactedJsonValue({ prose: 'use ' + INPUT_RESOURCE }).prose;
  assert.equal(typeof proseOut, 'string');
  assert.ok(!proseOut.includes(INPUT_RESOURCE), 'prose must not leak the resource id');
  assert.ok(proseOut.includes('[REDACTED]'), 'prose must carry the redaction marker');
  assert.equal(redactText(INPUT_RESOURCE), '[REDACTED]', 'direct free-text redaction is unchanged');

  // Credential-shaped Android-looking identifiers must never be preserved.
  const secretCases = [
    PACKAGE + ':id/qa_secret',
    PACKAGE + ':id/access_token',
    'com.secret:id/name',
  ];
  for (const secret of secretCases) {
    const out = projectRedactedJsonValue({ identifier: secret });
    assert.equal(out.identifier, '[REDACTED]', 'credential-shaped identifier must be fully redacted: ' + secret);
  }
  // Malformed/URI-shaped identifiers are not accepted as resource IDs.
  const uriCases = [
    'https://example.com/id/name',
    'dev.zseven.qa.fixture.android:id/qa_input_name/extra',
    'dev.zseven.qa.fixture.android/id/qa_input_name',
  ];
  for (const bad of uriCases) {
    const out = projectRedactedJsonValue({ identifier: bad });
    assert.notEqual(out.identifier, bad, 'non-resource-id URI-shaped value must not be preserved verbatim');
  }
});

test('record -> export -> exact-file replay keeps real Android fully-qualified resourceIds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-android-resource-'));
  try {
    const recorder = new QaTrajectoryRecorder();
    const backend1 = fakeAndroidBackend();
    const adapter = new AndroidAdapter(backend1.backend);
    const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'android-resource-export', { settle: SETTLE });
    await session.start({ deviceId: DEVICE, packageName: PACKAGE });
    const initial = await session.observeSettled();
    const input = initial.observation.nodes.find((n) => n.identifier === INPUT_RESOURCE);
    const button = initial.observation.nodes.find((n) => n.identifier === BUTTON_RESOURCE);
    assert.ok(input && button, 'both real resourceId nodes are present before redaction');
    const acted = await session.act({ kind: 'click', ref: button.ref });
    assert.equal(acted.outcome, 'unknown');
    assert.equal(acted.settle.stable, true, 'post-click observation settled');
    await session.stop();

    const outputPath = join(dir, 'android-resource.json');
    const exported = await exportRecordedScenario(recorder, 'android-resource-export', { outputPath });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    assert.equal(exported.excludedActions.length, 0, JSON.stringify(exported.excludedActions));
    const step = exported.scenario.steps[0];
    assert.equal(step.action.kind, 'click');
    assert.equal(step.action.target.identifier, BUTTON_RESOURCE, 'the real fully-qualified resourceId survives as the durable selector');
    assert.equal(step.action.target.role, 'android.widget.Button');
    assert.equal(step.action.target.name, 'Apply');

    // The scenario file itself must contain the real selector and no redaction
    // marker in the target/assertion identifiers.
    const fileText = await readFile(outputPath, 'utf8');
    assert.ok(fileText.includes(BUTTON_RESOURCE), 'scenario file contains the real resource id');
    assert.ok(fileText.includes(DONE_RESOURCE), 'scenario file contains the real postcondition resource id');
    assert.ok(!fileText.includes('[REDACTED]'), 'scenario file must not redact the stable Android selectors');

    // Exact-file replay through the shared loader and real AndroidAdapter.
    const backend2 = fakeAndroidBackend();
    const host = new QaToolHost({
      settle: SETTLE,
      replayLoaders: { android: async () => backend2.backend },
    });
    const tools = createQaTools(host);
    const report = await tools.qaReplayRun.execute({ scenario: outputPath, owner: 'android-resource-replay' }, {});
    assert.equal(report.status, 'pass', JSON.stringify(report.failure ?? report.steps));
    assert.equal(backend2.calls.dispose, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
