// MCP stdio server exposing the dsh-qa tool surface to Claude Code / Codex.
// WP2: qa_session_start / qa_observe / qa_act / qa_evidence / qa_session_stop
// are wired to the QA session core + browser adapter. qa_assert / qa_replay_run
// land in WP4 (Replay), qa_record_export in WP6 (Explore).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserAdapter } from './adapters/browser.ts';
import { QaSessionManager, toLosslessJson } from './session/index.ts';

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

// One QA session per plugin process; the optional owner argument lets a later
// Work Package multiplex distinct agent scopes without changing this shape.
const DEFAULT_OWNER = 'dsh-qa';

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(toLosslessJson(value)) }] };
}

// Lazily construct the browser-backed session manager. The sibling driver is
// kept external in the bundle and resolved only when a qa_* tool actually
// runs, so a node_modules-free plugin copy still serves initialize and
// tools/list without it.
let managerPromise;
async function getManager() {
  if (!managerPromise) {
    managerPromise = (async () => {
      const { BrowserManager } = await import('@zseven-w/dsh-browser');
      return new QaSessionManager(new BrowserAdapter(new BrowserManager()));
    })();
    managerPromise = managerPromise.catch((error) => {
      managerPromise = undefined;
      throw error;
    });
  }
  return managerPromise;
}

function ownerFrom(args) {
  const raw = args && typeof args.owner === 'string' ? args.owner : DEFAULT_OWNER;
  const owner = raw.trim();
  if (owner === '') throw new Error('owner must not be empty');
  return owner;
}

function guard(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult({ ok: false, error: message });
    }
  };
}

function stubFor(tool, workPackage) {
  return () => textResult({ ok: false, error: `tool ${tool} is not implemented yet (planned for ${workPackage})` });
}

server.tool(
  'qa_session_start',
  { owner: z.string().optional(), url: z.string().optional(), headless: z.boolean().optional() },
  guard(async (args) => {
    const manager = await getManager();
    const info = await manager.session(ownerFrom(args)).start({
      ...(args.url === undefined ? {} : { url: args.url }),
      ...(args.headless === undefined ? {} : { headless: args.headless }),
    });
    return textResult(info);
  }),
);

server.tool(
  'qa_observe',
  { owner: z.string().optional(), max_nodes: z.number().int().optional() },
  guard(async (args) => {
    const manager = await getManager();
    const observation = await manager.session(ownerFrom(args)).observe(
      args.max_nodes === undefined ? undefined : { maxNodes: args.max_nodes },
    );
    return textResult(observation);
  }),
);

server.tool(
  'qa_act',
  {
    owner: z.string().optional(),
    action: z.enum(['click', 'fill', 'press', 'navigate']),
    ref: z.string().optional(),
    text: z.string().optional(),
    key: z.string().optional(),
    url: z.string().optional(),
  },
  guard(async (args) => {
    const manager = await getManager();
    let action;
    if (args.action === 'click') {
      if (args.ref === undefined) throw new Error('qa_act click requires ref');
      action = { kind: 'click', ref: args.ref };
    } else if (args.action === 'fill') {
      if (args.ref === undefined || args.text === undefined) throw new Error('qa_act fill requires ref and text');
      action = { kind: 'fill', ref: args.ref, text: args.text };
    } else if (args.action === 'press') {
      if (args.ref === undefined || args.key === undefined) throw new Error('qa_act press requires ref and key');
      action = { kind: 'press', ref: args.ref, key: args.key };
    } else {
      if (args.url === undefined) throw new Error('qa_act navigate requires url');
      action = { kind: 'navigate', url: args.url };
    }
    const result = await manager.session(ownerFrom(args)).act(action);
    return textResult(result);
  }),
);

server.tool(
  'qa_evidence',
  { owner: z.string().optional(), max_console: z.number().int().optional(), max_network: z.number().int().optional() },
  guard(async (args) => {
    const manager = await getManager();
    const evidence = await manager.session(ownerFrom(args)).evidence({
      ...(args.max_console === undefined ? {} : { maxConsole: args.max_console }),
      ...(args.max_network === undefined ? {} : { maxNetwork: args.max_network }),
    });
    return textResult(evidence);
  }),
);

server.tool(
  'qa_session_stop',
  { owner: z.string().optional() },
  guard(async (args) => {
    const manager = await getManager();
    const result = await manager.stop(ownerFrom(args));
    return textResult(result);
  }),
);

server.tool('qa_assert', {}, stubFor('qa_assert', 'WP4 (Replay runner + assertions)'));
server.tool('qa_record_export', {}, stubFor('qa_record_export', 'WP6 (Explore tooling)'));
server.tool('qa_replay_run', {}, stubFor('qa_replay_run', 'WP4 (Replay runner)'));

await server.connect(new StdioServerTransport());
