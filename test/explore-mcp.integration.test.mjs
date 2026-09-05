import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { discoverInstalledBrowser } from '@zseven-w/dsh-browser'
import { loadScenarioFromPath } from '../src/replay/index.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_HTML = join(ROOT, 'fixtures', 'web', 'index.html')

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

function valueFrom(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text
  assert.equal(typeof text, 'string')
  return JSON.parse(text)
}

test('MCP surface executes the same Explore→Export→Replay closed loop', { timeout: 240_000 }, async () => {
  // Deliberately no skip: this is the actual stdio tool surface acceptance.
  await discoverInstalledBrowser()
  const html = await readFile(FIXTURE_HTML, 'utf8')
  let port = 0
  const fixture = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    if (requestUrl.pathname === '/api/probe') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  port = await listen(fixture)
  const origin = 'http://127.0.0.1:' + port
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-mcp-loop-'))
  const scenarioPath = join(dir, 'mcp-explored.json')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/server.mjs'],
    cwd: ROOT,
    env: { ...getDefaultEnvironment(), TMPDIR: tmpdir() },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'dsh-qa-mcp-acceptance', version: '0.1.0' })
  const call = async (name, args) => valueFrom(await client.callTool({ name, arguments: args }))

  try {
    await client.connect(transport)
    const listed = await client.listTools()
    const exportedTool = listed.tools.find((tool) => tool.name === 'qa_record_export')
    assert.ok(exportedTool)
    assert.ok(exportedTool.inputSchema.required.includes('output_path'))

    const owner = 'mcp-closed-loop'
    await call('qa_session_start', { owner, driver: 'browser', url: origin, headless: true })
    const observed = await call('qa_observe', { owner })
    const input = observed.nodes.find((item) => item.role === 'textbox' && item.name === 'Release name')
    assert.ok(input)
    const filled = await call('qa_act', { owner, action: 'fill', ref: input.ref, text: 'v1.0.0' })
    assert.ok(filled.observation, JSON.stringify(filled))
    const validate = filled.observation.nodes.find((item) => item.name === 'Run validation')
    assert.ok(validate)
    const clicked = await call('qa_act', { owner, action: 'click', ref: validate.ref })
    assert.ok(clicked.observation.nodes.some((item) => item.name === 'PASS'))
    const exported = await call('qa_record_export', {
      owner,
      output_path: scenarioPath,
      name: 'mcp-fixture-explore-loop',
    })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.scenario.steps.length, 2)
    assert.deepEqual(loadScenarioFromPath(scenarioPath), exported.scenario)

    // Scoped observation over the real MCP surface (driver contract v8): the
    // within ref is plumbed through qa_observe, the result echoes the scope
    // root, and a driver refusal surfaces as itself with its code — never a
    // whole-page fallback, never a "not found".
    const post = await call('qa_observe', { owner })
    const scopeTarget = post.nodes[0]
    assert.ok(scopeTarget)
    const scoped = await call('qa_observe', { owner, within_ref: scopeTarget.ref })
    // qa_observe settles (several polls); the scope echo carries the ref of
    // the LAST poll's resolution, while role/name/tag always name the root.
    assert.ok(typeof scoped.scope.ref === 'string' && scoped.scope.ref.length > 0, JSON.stringify(scoped))
    assert.equal(scoped.scope.role, scopeTarget.role)
    assert.equal(scoped.scope.name, scopeTarget.name)
    assert.equal(scoped.scope.tag, scopeTarget.tag)
    assert.ok(scoped.nodes.length > 0)
    const refused = await call('qa_observe', { owner, within_ref: 'br_bogus_ref' })
    assert.equal(refused.ok, false, JSON.stringify(refused))
    assert.equal(refused.code, 'REF_UNKNOWN', 'the driver refusal code must surface to the agent')
    await call('qa_session_stop', { owner })

    const replay = await call('qa_replay_run', {
      scenario: scenarioPath,
      owner: 'mcp-closed-loop-replay',
      headless: true,
    })
    assert.equal(replay.status, 'pass')
    assert.ok(replay.steps.every((step) => step.assertionPassed === true))
  } finally {
    await client.close().catch(() => {})
    fixture.closeAllConnections?.()
    await new Promise((resolve) => fixture.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
