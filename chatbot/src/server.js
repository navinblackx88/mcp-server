// Chatbot web server: serves the chat page and streams agent progress over Server-Sent Events.
//   GET  /api/health       liveness (no auth) — used by Railway health checks
//   GET  /                 chat UI
//   GET  /api/status       provider, model, tools
//   POST /api/chat         { sessionId, message } -> text/event-stream of agent events
//   POST /api/reset        { sessionId }
//   POST /api/upload?name= raw file bytes -> forwarded to the File-Reading Server
// Set CHATBOT_PASSWORD to protect everything except /api/health with HTTP Basic auth.
import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from './agent.js';
import { config } from './config.js';
import { createProviderSafe } from './llm/index.js';
import { connectMcp } from './mcp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);

const { provider, warning: providerWarning } = createProviderSafe(config);
if (providerWarning) console.warn(`WARNING: ${providerWarning}`);
let mcp = null;
let agent = null;
let mcpError = null;

// Connect to MCP in the background so the web server (and its health check) comes up immediately.
(async function connect() {
  try {
    mcp = await connectMcp();
    agent = new Agent({ provider, mcp, maxToolRounds: config.maxToolRounds, maxHistoryMessages: config.maxHistoryMessages });
    mcpError = null;
    console.log(`MCP connected (${mcp.transport}). Tools: ${mcp.tools.map((t) => t.name).join(', ')}`);
  } catch (e) {
    mcpError = e.message;
    console.error(`[mcp] ${e.message}. Retrying in 10s.`);
    setTimeout(connect, 10000);
  }
})();
setInterval(() => agent?.prune(), 10 * 60 * 1000).unref();

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', true); // Railway's edge proxy sets X-Forwarded-For

const health = (_req, res) => res.json({ status: 'ok', service: 'chatbot', mcp: mcp ? 'ready' : 'connecting' });
app.get('/api/health', health);
app.get('/health', health); // same path as the other services, for one shared health check

// ---- optional site password (HTTP Basic auth) ----
if (config.password) {
  const expected = Buffer.from(`${config.username}:${config.password}`);
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.get('authorization') || '').split(' ');
    const given = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="File Chat", charset="UTF-8"').status(401).send('Login required');
  });
}

// ---- simple per-IP rate limit for chat messages (protects your LLM bill) ----
const hits = new Map();
function rateLimit(req, res, next) {
  if (!config.rateLimitPerMinute) return next();
  const now = Date.now();
  const recent = (hits.get(req.ip) ?? []).filter((t) => now - t < 60000);
  if (recent.length >= config.rateLimitPerMinute) {
    return res.status(429).json({ error: `Too many messages. Limit is ${config.rateLimitPerMinute} per minute.` });
  }
  recent.push(now);
  hits.set(req.ip, recent);
  next();
}
setInterval(() => { const now = Date.now(); for (const [ip, t] of hits) if (!t.some((x) => now - x < 60000)) hits.delete(ip); }, 60000).unref();

app.use(express.static(path.join(__dirname, '../public')));

const requireMcp = (_req, res, next) => (agent ? next() : res.status(503).json({ error: `Still connecting to the MCP server${mcpError ? `: ${mcpError}` : '…'} Try again in a few seconds.` }));

app.get('/api/status', (_req, res) => {
  res.json({
    provider: provider.name,
    model: provider.model,
    warning: providerWarning,
    mcp: mcp ? 'ready' : 'connecting',
    tools: mcp ? mcp.tools.map((t) => t.name) : [],
    uploads: true,
    maxUploadMB: MAX_UPLOAD_MB,
  });
});

app.post('/api/chat', express.json({ limit: '1mb' }), rateLimit, requireMcp, async (req, res) => {
  const { sessionId, message } = req.body ?? {};
  if (!sessionId || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // stop proxies from buffering the stream
  });
  res.flushHeaders?.();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  try {
    await agent.chat(String(sessionId).slice(0, 100), message.trim().slice(0, 8000), send);
  } catch (e) {
    console.error('[chat]', e);
    send({ type: 'error', message: friendlyError(e) });
  } finally {
    clearInterval(ping);
    send({ type: 'done' });
    res.end();
  }
});

app.post('/api/reset', express.json(), (req, res) => {
  agent?.reset(String(req.body?.sessionId ?? ''));
  res.json({ ok: true });
});

// Forward uploads straight to the File-Reading Server (not an MCP tool: the LLM never writes files).
app.post('/api/upload', rateLimit, express.raw({ type: () => true, limit: `${MAX_UPLOAD_MB}mb` }), async (req, res) => {
  try {
    const name = String(req.query.name || '');
    if (!name) return res.status(400).json({ error: 'Query parameter "name" is required' });
    const r = await fetch(`${config.fileServerUrl}/files/upload?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(config.fileServerToken ? { Authorization: `Bearer ${config.fileServerToken}` } : {}),
      },
      body: req.body,
      signal: AbortSignal.timeout(120000),
    });
    const body = await r.json().catch(() => ({}));
    res.status(r.status).json(r.ok ? { relativePath: body.relativePath, name: body.name, sizeBytes: body.sizeBytes, format: body.format } : { error: body.error || `Upload failed (HTTP ${r.status})` });
  } catch (e) {
    res.status(502).json({ error: `Could not reach the file server: ${e.cause?.code || e.message}` });
  }
});

app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.type === 'entity.too.large' ? `File is larger than ${MAX_UPLOAD_MB} MB` : err.message });
});

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

function friendlyError(e) {
  const status = e.status ?? e.response?.status;
  if (status === 401 || (status === 400 && /api key/i.test(e.message)) || (status === 403 && /api key|permission/i.test(e.message))) {
    return `The ${provider.name} API key was rejected (${status}). Check your API key${provider.name === 'gemini' ? ' (create one at aistudio.google.com/apikey)' : ''}.`;
  }
  if (status === 404) return `Model "${provider.model}" was not found (404). Set LLM_MODEL to a model your account can use${provider.name === 'gemini' ? ', e.g. gemini-3.6-flash' : ''}.`;
  if (status === 503 || status === 500) return `The ${provider.name} service is busy or unavailable (${status}). Try again in a moment.`;
  if (status === 429) return 'Rate limited by the LLM provider (429). Wait a moment and try again.';
  if (e.code === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed|Connection error/i.test(e.message)) {
    return `Could not reach the LLM at ${config.baseURL ?? provider.name}. ${provider.name === 'ollama' ? 'Is Ollama running (ollama serve)?' : 'Check your network.'}`;
  }
  return e.message;
}

const server = listen(app, config.port, config.host, (addr) => {
  console.log(`Chatbot on http://${addr}`);
  console.log(`LLM: ${provider.name} (${provider.model})${config.baseURL ? ` at ${config.baseURL}` : ''}`);
  console.log(`MCP: ${config.mcpServerUrl || 'local stdio'} · Login: ${config.password ? 'on' : 'OFF'} · Rate limit: ${config.rateLimitPerMinute}/min`);
  if (provider.name === 'rules') console.log('No LLM configured: running in offline rules mode. Set GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY or LLM_PROVIDER=ollama.');
  if (!config.password && config.host !== '127.0.0.1') console.log('WARNING: CHATBOT_PASSWORD is not set; anyone with the URL can use this chatbot (and your LLM quota).');
});

const shutdown = async () => { server.close(); await mcp?.close().catch(() => {}); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
