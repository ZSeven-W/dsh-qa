// MCP stdio entrypoint. Tool registration and per-server session state live in
// src/mcp-server.ts (createQaMcpServer), so the exact same handlers a stdio
// client hits can be driven in-process by tests over an InMemoryTransport with
// an injected fake driver loader. This file only constructs the server and
// connects it to stdio.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createQaMcpServer } from './mcp-server.ts';

const server = createQaMcpServer();
await server.connect(new StdioServerTransport());
