// Real DSH bootstrap + ToolRuntime acceptance. No model request is made:
// headless-startup and headless-runner are disabled before boot, then the
// installed qa_* definitions are called directly through ctx.get('tools').
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const DRIVERS = ['dsh-browser', 'dsh-computer', 'dsh-ios', 'dsh-android']
const QA_NAMES = ['qa_session_start', 'qa_observe', 'qa_act', 'qa_assert', 'qa_evidence', 'qa_record_export', 'qa_replay_run', 'qa_session_stop'].sort()
const argv = process.argv.slice(2)
const valueAfter = flag => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1] }
const evidencePath = valueAfter('--evidence')
const selected = valueAfter('--driver')
const browserLoop = argv.includes('--browser-loop')
const qaOnly = argv.includes('--qa-only')
const worker = argv.includes('--worker')
const runDirArg = valueAfter('--run-dir')
if (argv.includes('--help')) {
  console.error('usage: host-direct.mjs --evidence PATH [--driver dsh-browser|dsh-computer|dsh-ios|dsh-android] [--browser-loop] [--qa-only]')
  process.exit(0)
}
if (evidencePath === undefined || (argv.includes('--evidence') && valueAfter('--evidence') === undefined)) throw new Error('missing --evidence PATH')
if (argv.includes('--driver') && selected === undefined) throw new Error('missing value for --driver')
if (selected !== undefined && !DRIVERS.includes(selected)) throw new Error('unknown --driver: ' + selected)
if (browserLoop && selected !== undefined && selected !== 'dsh-browser') throw new Error('--browser-loop requires --driver dsh-browser')

const evidence = JSON.parse(readFileSync(resolve(evidencePath), 'utf8'))
if (typeof evidence.outDir !== 'string' || evidence.outDir.trim() === '' || !evidence.packages) throw new Error('evidence must contain non-empty outDir and packages')
const outDir = resolve(evidence.outDir)
mkdirSync(outDir, { recursive: true })
const qa = evidence.packages['@zseven-w/dsh-qa']
if (!qa?.tarball) throw new Error('INPUT_MISSING: @zseven-w/dsh-qa tarball')
const targets = selected === undefined ? DRIVERS : [selected]
if (!qaOnly) for (const driver of targets) if (!evidence.packages['@zseven-w/' + driver]?.tarball) throw new Error('INPUT_MISSING: @zseven-w/' + driver + ' tarball')

function findDshAnchor(explicit) {
  let file = explicit
  if (file === undefined) {
    const which = spawnSync('which', ['dsh'], { encoding: 'utf8' })
    if (which.status !== 0) throw new Error('DSH CLI not found on PATH')
    file = which.stdout.trim()
  }
  let current = dirname(realpathSync(file))
  for (;;) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@deepseek-ai/dsh') return { root: current, packageJson: manifest }
    const parent = dirname(current); if (parent === current) break; current = parent
  }
  throw new Error('installed DSH package anchor not found from ' + file)
}

async function findRunProfile(anchor) {
  for (const name of readdirSync(join(anchor.root, 'lib')).filter(name => /^profile-boot-.*\.js$/.test(name)).sort()) {
    const module = await import(pathToFileURL(join(anchor.root, 'lib', name)).href)
    if (typeof module.runProfile === 'function') return module.runProfile
  }
  throw new Error('unsupported installed DSH: no profile-boot wrapper exporting runProfile')
}

function isolatedEnv(dir) {
  const env = {}
  for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'LANG']) if (process.env[key] !== undefined) env[key] = process.env[key]
  Object.assign(env, { DSH_HOME: join(dir, 'home'), DSH_TELEMETRY_DISABLED: '1', TMPDIR: join(dir, 'tmp'), PNPM_HOME: join(dir, 'pnpm-home'), npm_config_cache: join(dir, 'npm-cache'), npm_config_store_dir: join(dir, 'pnpm-store') })
  for (const value of [env.DSH_HOME, env.TMPDIR, env.PNPM_HOME]) mkdirSync(value, { recursive: true, mode: 0o700 })
  return env
}

function installProfile(dir, env, driverPkg) {
  const args = ['plugin', '--profile', 'headless', '--store-dir', env.npm_config_store_dir, 'add', qa.tarball]
  if (driverPkg?.tarball) args.push(driverPkg.tarball)
  const result = spawnSync('dsh', args, { cwd: dir, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) throw new Error('isolated dsh plugin install failed: ' + String(result.stderr ?? '').slice(-2000))
}

function withDeadline(promise, ms, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' deadline exceeded')), ms) })]).finally(() => clearTimeout(timer))
}

function assertToolResult(result, name) {
  assert.equal(typeof result, 'object', name + ' did not return ToolExecutionResult')
  assert.equal(typeof result.isError, 'boolean', name + ' missing isError')
  assert.ok(Array.isArray(result.content), name + ' missing content')
  if (result.isError) throw new Error(name + ': ' + JSON.stringify(result.error))
  if (result.value?.ok === false) throw new Error(name + ': ' + JSON.stringify(result.value))
  return result.value
}

async function serveFixture(fixtureDir) {
  const index = readFileSync(join(fixtureDir, 'index.html'))
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/probe') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return }
    const path = resolve(fixtureDir, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
    if (path.startsWith(fixtureDir + '/') && existsSync(path) && statSync(path).isFile()) { res.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream' }); res.end(readFileSync(path)); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(index)
  })
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise) })
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('fixture server did not bind')
  return { server, url: 'http://127.0.0.1:' + address.port }
}

async function runTarget(anchor, target, dir, env, runProfile) {
  installProfile(dir, env, target === null ? undefined : evidence.packages['@zseven-w/' + target])
  const noModel = join(dir, 'no-model.patch.yml')
  writeFileSync(noModel, '- id: headless-startup\n  disabled: true\n- id: headless-runner\n  disabled: true\n')
  const require = createRequire(anchor.packageJson)
  const { createLaunchEnvironmentSnapshot } = await import(require.resolve('@deepseek-ai/dsh-launch-environment'))
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: env }])
  const previousHome = process.env.DSH_HOME; const previousTelemetry = process.env.DSH_TELEMETRY_DISABLED
  process.env.DSH_HOME = env.DSH_HOME; process.env.DSH_TELEMETRY_DISABLED = '1'
  let booted
  try { booted = await withDeadline(runProfile({ profile: 'headless', patchFiles: [noModel], args: [], environment }), 120_000, 'profile bootstrap') } catch (error) {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
    if (previousTelemetry === undefined) delete process.env.DSH_TELEMETRY_DISABLED; else process.env.DSH_TELEMETRY_DISABLED = previousTelemetry
    throw error
  }
  const { ctx, shutdown } = booted
  const owner = 'qa-direct-' + randomUUID(); const controller = new AbortController(); const trace = []
  async function call(name, args = {}) {
    const callId = 'qa-direct-' + randomUUID()
    const response = await withDeadline(ctx.get('tools').execute({ callId, name, arguments: { owner, ...args }, signal: controller.signal }), 90_000, name)
    trace.push({ callId, name, response }); return assertToolResult(response, name)
  }
  async function callExpectedRefusal(name, args = {}) {
    const callId = 'qa-direct-' + randomUUID()
    const response = await withDeadline(ctx.get('tools').execute({ callId, name, arguments: { owner, ...args }, signal: controller.signal }), 90_000, name)
    trace.push({ callId, name, response })
    assert.equal(response.isError, false, name + ' unexpectedly failed at ToolRuntime boundary')
    assert.equal(response.value?.ok, false, name + ' did not return an expected refusal')
    return response.value
  }
  let server
  try {
    const tools = ctx.get('tools'); if (tools === undefined) throw new Error('real ToolRuntime service missing')
    const names = tools.schemas().map(item => item.name).filter(name => name.startsWith('qa_')).sort(); assert.deepEqual(names, QA_NAMES)
    const stopBefore = await call('qa_session_stop'); assert.deepEqual(stopBefore, { stopped: false, reason: 'not-running' })
    const row = { verdict: 'PASS', driver: target ?? 'qa-only', names, stopBefore, trace }
    if (target !== null && !browserLoop) {
      const driver = target.replace(/^dsh-/, '')
      if (driver === 'ios' || driver === 'android') {
        const refusal = await callExpectedRefusal('qa_session_start', { driver })
        const text = JSON.stringify(refusal)
        assert.match(text, /device.?id/i, driver + ' must fail closed on missing deviceId')
        assert.doesNotMatch(text, /cannot load|package_path_not_exported/i, driver + ' driver import failed')
        row.driverProbe = { kind: 'missing-device-refusal', refusal }
      } else {
        await call('qa_session_start', { driver, ...(driver === 'browser' ? { headless: true } : {}) })
        const stopped = await call('qa_session_stop')
        row.driverProbe = { kind: 'start-stop', stopped }
      }
    }
    if (browserLoop) {
      const requireProfile = createRequire(join(env.DSH_HOME, 'profiles', 'headless', 'package.json'))
      const fixtureDir = join(dirname(requireProfile.resolve('@zseven-w/dsh-qa/package.json')), 'fixtures', 'web')
      const served = await serveFixture(fixtureDir); server = served.server; const scenario = join(dir, 'browser-scenario.json'); const reports = join(dir, 'browser-replay')
      await call('qa_session_start', { driver: 'browser', url: served.url, headless: true })
      let observation = await call('qa_observe'); const field = observation.nodes.find(node => node.role === 'textbox' && node.name === 'Release name'); assert.ok(field)
      await call('qa_act', { action: 'fill', ref: field.ref, text: 'QA-HOST-PROBE' })
      observation = await call('qa_observe'); const button = observation.nodes.find(node => node.name === 'Run validation'); assert.ok(button)
      await call('qa_act', { action: 'click', ref: button.ref })
      assert.equal((await call('qa_assert', { kind: 'node-present', expected: { role: 'status', name: 'PASS' } })).passed, true)
      await call('qa_evidence'); assert.equal((await call('qa_record_export', { output_path: scenario, name: 'Installed stock-host browser' })).ok, true); await call('qa_session_stop')
      const replay = await call('qa_replay_run', { scenario, outputDir: reports }); assert.equal(replay.status, 'pass'); assert.equal(replay.steps.length, 2)
      row.browser = { status: 'pass', scenario, replaySteps: replay.steps.length, calls: trace.length }
    }
    writeFileSync(join(dir, 'tool-execution.json'), JSON.stringify(row, null, 2), { mode: 0o600 }); return row
  } finally {
    try { await call('qa_session_stop') } catch {}
    if (server !== undefined) await new Promise(resolveClose => server.close(resolveClose))
    await shutdown.shutdown(0)
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
    if (previousTelemetry === undefined) delete process.env.DSH_TELEMETRY_DISABLED; else process.env.DSH_TELEMETRY_DISABLED = previousTelemetry
  }
}

if (worker) {
  if (runDirArg === undefined || (selected === undefined && !qaOnly)) throw new Error('worker requires --run-dir and --driver')
  if (process.env.DSH_HOME !== join(resolve(runDirArg), 'home')) throw new Error('worker requires an isolated environment before importing DSH')
  const anchor = findDshAnchor(valueAfter('--dsh-anchor')); const runProfile = await findRunProfile(anchor)
  try {
    const row = await runTarget(anchor, qaOnly ? null : selected, resolve(runDirArg), isolatedEnv(resolve(runDirArg)), runProfile)
    console.log(JSON.stringify({ verdict: 'PASS', row }))
  } catch (error) {
    writeFileSync(join(resolve(runDirArg), 'tool-execution-error.json'), JSON.stringify({ verdict: 'FAIL', error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n', { mode: 0o600 })
    console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1
  }
} else {
  const results = {}
  for (const target of qaOnly ? [null] : targets) {
    const name = target ?? 'qa-only'; const dir = mkdtempSync(join(outDir, 'host-direct-')); const env = isolatedEnv(dir)
    const args = [fileURLToPath(import.meta.url), '--worker', '--evidence', resolve(evidencePath), '--driver', target ?? 'dsh-browser', '--run-dir', dir]
    if (browserLoop) args.push('--browser-loop')
    if (qaOnly) args.push('--qa-only')
    const child = spawn(process.execPath, args, { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''; child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    const outcome = await new Promise(resolveOutcome => {
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} resolveOutcome({ code: null, error: 'worker deadline exceeded' }) }, 1_200_000)
      child.on('error', error => { clearTimeout(timer); resolveOutcome({ code: null, error: error.message }) })
      child.on('close', code => { clearTimeout(timer); resolveOutcome({ code }) })
    })
    writeFileSync(join(dir, 'worker.stdout'), stdout, { mode: 0o600 }); writeFileSync(join(dir, 'worker.stderr'), stderr, { mode: 0o600 })
    if (outcome.code === 0) {
      try { results[name] = JSON.parse(readFileSync(join(dir, 'tool-execution.json'), 'utf8')) } catch { results[name] = { verdict: 'FAIL', error: 'worker passed without tool-execution.json' } }
    } else results[name] = { verdict: 'FAIL', error: outcome.error ?? stderr.slice(-2000), workerCode: outcome.code }
  }
  const failed = Object.values(results).some(row => row.verdict !== 'PASS')
  const output = join(outDir, browserLoop ? 'browser-loop.json' : 'host-matrix.json')
  writeFileSync(output, JSON.stringify({ verdict: failed ? 'FAIL' : 'PASS', results }, null, 2) + '\n')
  console.log(JSON.stringify({ verdict: failed ? 'FAIL' : 'PASS', output, results }, null, 2)); process.exitCode = failed ? 1 : 0
}
