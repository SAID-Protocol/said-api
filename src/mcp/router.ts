/**
 * Mounts the MCP server over Streamable HTTP at /mcp.
 *
 * Stateless: every request gets a fresh server and transport, so there is no
 * session table to lose on a restart and nothing for one client to exhaust.
 * The tools are read-only, so statelessness costs nothing.
 *
 *   POST /mcp        JSON-RPC (initialize, tools/list, tools/call)
 *   GET  /mcp/info   plain JSON: what this is and how to connect
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { StreamableHTTPTransport } from '@hono/mcp';
import type { PrismaClient } from '@prisma/client';
import { createMcpServer } from './server.js';

export function createMcpRouter(prisma: PrismaClient): Hono {
  const app = new Hono();

  app.use(
    '/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'],
      exposeHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version'],
    }),
  );

  app.get('/info', (c) =>
    c.json({
      name: 'said-protocol',
      transport: 'streamable-http',
      url: 'https://api.saidprotocol.com/mcp',
      tools: ['check_wallet', 'check_token', 'find_agent'],
      auth: 'none',
      price: 'free; rate limited per IP',
      docs: 'https://www.saidprotocol.com/skill.md',
    }),
  );

  app.all('/', async (c) => {
    const server = createMcpServer(prisma);
    // JSON responses (not SSE) so the reply is complete when handleRequest
    // returns and the transport can be closed straight after.
    const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c);
    } finally {
      // Stateless: tear down after the response so nothing accumulates.
      void transport.close().catch(() => {});
    }
  });

  return app;
}
