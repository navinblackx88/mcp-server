#!/usr/bin/env node
// MCP Server entry point. Two transports:
//
//   stdio (default)      started as a child process by an MCP client (client/, chatbot/, Claude Desktop)
//   MCP_TRANSPORT=http   Streamable HTTP on PORT at POST /mcp, for running as its own service (e.g. Railway)
//
// HTTP mode is stateless: every request gets a fresh server, so it scales horizontally and
// survives restarts. Set MCP_AUTH_TOKEN to require "Authorization: Bearer <token>".
import crypto from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { buildServer, FILE_SERVER_URL, log } from './tools.js';

const env = process.env;
const transportMode = (env.MCP_TRANSPORT || 'stdio').toLowerCase();

if (transportMode === 'stdio') {
  await buildServer().connect(new StdioServerTransport());
  log(`ready on stdio (File-Reading Server: ${FILE_SERVER_URL})`);
} else if (transportMode === 'http') {
  startHttp();
} else {
  log(`Unknown MCP_TRANSPORT "${transportMode}". Use stdio or http.`);
  process.exit(1);
}

function startHttp() {
  const port = Number(env.MCP_PORT || env.PORT || 8080);
  const host = env.HOST || '127.0.0.1';
  const token = env.MCP_AUTH_TOKEN || '';

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  const auth = (req, res, next) => {
    if (!token) return next();
    const given = Buffer.from((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(token);
    if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next();
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  };

  app.post('/mcp', auth, async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log('request error:', e.message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });

  // Stateless mode has no server-initiated streams or sessions to delete.
  const notAllowed = (_req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  const server = listen(app, port, host, (addr) => {
    log(`ready on http://${addr}/mcp (File-Reading Server: ${FILE_SERVER_URL})`);
    if (!token) log('WARNING: MCP_AUTH_TOKEN is not set; anyone who can reach this port can use the tools.');
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}

// Listen on HOST; if it is "::" and this machine has no IPv6, fall back to 0.0.0.0 (IPv4 only).
function listen(app, port, host, onReady) {
  const server = app.listen(port, host);
  server.once('listening', () => {
    const a = server.address();
    onReady(`${a.family === 'IPv6' ? `[${a.address}]` : a.address}:${a.port}`);
  });
  server.once('error', (e) => {
    if (host === '::' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(e.code)) {
      console.warn('IPv6 is not available here; listening on 0.0.0.0 instead.');
      server.listen(port, '0.0.0.0');
    } else throw e;
  });
  return server;
}
