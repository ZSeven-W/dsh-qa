// MCP stdio server exposing the dsh-qa tool surface to Claude Code / Codex.
// WP1 scaffold: the full Explore/Replay implementation lands in later work
// packages; every tool is registered now so the smoke handshake and the
// plugin surface are stable, and unimplemented tools fail with a clear
// error instead of being missing.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = readVersion();
const server = new McpServer({ name: 'dsh-qa', version: VERSION });

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

// Placeholder handler shared by every not-yet-implemented tool. The error
// name is stable so later work packages replace handlers one by one without
// touching the registration shape.
function notImplemented(tool) {
  return () => textResult({ ok: false, error: `tool ${tool} is not implemented yet (planned for a later dsh-qa v0.1 work package)` });
}

// SDK >=1.30 freezes the positional tool() overloads: the input schema must
// be a Zod RAW SHAPE (plain object of Zod schemas), not a z.object() instance.
// An empty object declares a no-input tool. Later work packages pass real
// raw shapes, e.g. { scenario: z.string() }.
const NO_INPUT = {};

server.tool('qa_session_start', NO_INPUT, notImplemented('qa_session_start'));
server.tool('qa_observe', NO_INPUT, notImplemented('qa_observe'));
server.tool('qa_act', NO_INPUT, notImplemented('qa_act'));
server.tool('qa_assert', NO_INPUT, notImplemented('qa_assert'));
server.tool('qa_evidence', NO_INPUT, notImplemented('qa_evidence'));
server.tool('qa_record_export', NO_INPUT, notImplemented('qa_record_export'));
server.tool('qa_replay_run', NO_INPUT, notImplemented('qa_replay_run'));
server.tool('qa_session_stop', NO_INPUT, notImplemented('qa_session_stop'));

await server.connect(new StdioServerTransport());
