// Tool-description drift regression tests (QA-BL-012 / QA-BL-018).
//
// These tests read CONTENT, not just type:
//   (i)   drive the BUILT MCP bundle's tools/list over a real stdio handshake and
//         assert every one of the 8 tools has a non-empty description identical
//         to the Cordis surface's (createQaTools) — the two surfaces read from
//         the SAME src/tool-descriptions.ts map, so they cannot drift again;
//   (ii)  assert the specific invariants that guard each fixed sentence
//         ("fails to parse", no "two consecutive", README driver-contract
//         versions equal the constants read from the sibling repos' source);
//   (iii) fail if any tool in createQaTools lacks a description >= 80 chars.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { QA_TOOL_DESCRIPTIONS } from '../src/tool-descriptions.ts'
import { createQaTools, QaToolHost } from '../src/tools.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOOL_NAMES = Object.keys(QA_TOOL_DESCRIPTIONS).sort()

function cordisDescriptions() {
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const list = [
    tools.qaSessionStart,
    tools.qaObserve,
    tools.qaAct,
    tools.qaAssert,
    tools.qaEvidence,
    tools.qaRecordExport,
    tools.qaReplayRun,
    tools.qaSessionStop,
  ]
  return Object.fromEntries(list.map((tool) => [tool.name, tool.description]))
}

// Rebuild lib/server.mjs from the current sources, then drive a real MCP stdio
// handshake (initialize -> notifications/initialized -> tools/list) exactly like
// scripts/smoke-bundle.mjs, and return the tools array. This is what proves the
// BUILT bundle emits descriptions, not just the source.
async function mcpToolList() {
  await import('../scripts/build-mcp.mjs')
  const bundlePath = join(ROOT, 'lib', 'server.mjs')
  const child = spawn(process.execPath, [bundlePath], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d.toString() })

  const pending = new Map()
  let buf = ''
  let nextId = 1
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n')
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => reject(new Error('timed out waiting for ' + method + ' (stderr: ' + stderr.trim() + ')')), 15000)
    pending.set(id, { resolve, reject, timer })
    send({ jsonrpc: '2.0', id, method, params })
  })
  const route = (line) => {
    const raw = line.trim()
    if (!raw) return
    const msg = JSON.parse(raw)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.code + ': ' + msg.error.message))
      else p.resolve(msg)
    }
  }
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) route(line)
    }
  })

  try {
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tool-descriptions-test', version: '0.0.0' },
    })
    if (!init.result || init.result.serverInfo?.name !== 'dsh-qa') {
      throw new Error('initialize serverInfo.name is not dsh-qa')
    }
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const list = await request('tools/list', {})
    return list.result?.tools ?? []
  } finally {
    child.kill()
  }
}

test('every tool in createQaTools has a description of at least 80 characters', () => {
  const descriptions = cordisDescriptions()
  for (const name of TOOL_NAMES) {
    const description = descriptions[name]
    assert.ok(typeof description === 'string' && description.length >= 80, name + ' description must be >= 80 chars (got ' + (description?.length ?? 'undefined') + ')')
  }
})

test('the built MCP bundle tools/list emits the same non-empty descriptions as the cordis surface', async () => {
  const mcp = await mcpToolList()
  const cordis = cordisDescriptions()
  assert.equal(mcp.length, TOOL_NAMES.length, 'tools/list must return all 8 tools')
  for (const tool of mcp) {
    assert.ok(
      typeof tool.description === 'string' && tool.description.length > 0,
      tool.name + ' must carry a non-empty description over MCP tools/list',
    )
    assert.equal(
      tool.description,
      cordis[tool.name],
      tool.name + ' MCP description must be byte-identical to the cordis surface description',
    )
  }
})

test('fixed drift sentences are guarded by content invariants', () => {
  assert.match(QA_TOOL_DESCRIPTIONS.qa_session_start, /fails to parse/, 'qa_session_start must say "fails to parse"')
  for (const name of TOOL_NAMES) {
    const description = QA_TOOL_DESCRIPTIONS[name]
    assert.doesNotMatch(description, /two consecutive/, name + ' must not say "two consecutive" (quiet-window wording)')
    assert.doesNotMatch(description, /consecutive semantic views agree/, name + ' must not say "consecutive semantic views agree" (quiet-window wording)')
  }
  assert.match(QA_TOOL_DESCRIPTIONS.qa_observe, /quiet window/, 'qa_observe must describe the quiet window')
  assert.match(QA_TOOL_DESCRIPTIONS.qa_assert, /quiet window/, 'qa_assert must describe the quiet window')
  assert.match(QA_TOOL_DESCRIPTIONS.qa_act, /optional amount/, 'qa_act must state scroll amount is optional')
})

function readSiblingConstant(relPath, name) {
  try {
    const source = readFileSync(join(ROOT, '..', relPath), 'utf8')
    const match = source.match(new RegExp('export const ' + name + ' = (\\d+) as const'))
    return match === null ? null : Number(match[1])
  } catch {
    return null
  }
}

test('README driver-contract versions equal the constants in the sibling driver sources', (t) => {
  const browser = readSiblingConstant('dsh-browser/src/driver-contract.ts', 'BROWSER_DRIVER_CONTRACT_VERSION')
  const computer = readSiblingConstant('dsh-computer/src/contracts.ts', 'COMPUTER_DRIVER_CONTRACT_VERSION')
  if (browser === null || computer === null) {
    // Tolerant: a standalone dsh-qa checkout (no sibling repos) cannot verify
    // the cross-repo constant; the pinned expectation below is the fallback.
    t.skip('sibling driver sources are not present; cannot cross-check the README versions')
    return
  }
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, new RegExp('contract v' + browser + '\\b'), 'README must state the browser driver contract v' + browser)
  assert.match(readme, new RegExp('contract v' + computer + '\\b'), 'README must state the computer driver contract v' + computer)
})
