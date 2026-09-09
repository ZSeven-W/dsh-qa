// MCP stdio entrypoint. Tool registration and per-server session state live in
// src/mcp-server.ts (createQaMcpServer), so the exact same handlers a stdio
// client hits can be driven in-process by tests over an InMemoryTransport with
// an injected fake driver loader. This file only constructs the server and
// connects it to stdio.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createQaMcpServer } from './mcp-server.ts';

const server = createQaMcpServer();
let shutdownPromise;
const transport = new StdioServerTransport();
const shutdown = () => {
  if (shutdownPromise !== undefined) return shutdownPromise;
  shutdownPromise = (async () => {
    await server.close();
    await server.dispose();
  })();
  return shutdownPromise;
};
const reportShutdownFailure = (error) => {
  console.error('[dsh-qa] shutdown failed');
  process.exitCode = 1;
};
process.stdin.once('end', () => { void shutdown().catch(reportShutdownFailure); });
process.on('SIGTERM', () => { void shutdown().catch(reportShutdownFailure); });
process.on('SIGINT', () => { void shutdown().catch(reportShutdownFailure); });
await server.connect(transport);
