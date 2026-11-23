#!/usr/bin/env node
// Single entry point for the root Dockerfile and `npm start`.
// Picks what to run from SERVICE, or from Railway's RAILWAY_SERVICE_NAME:
//
//   file-server | mcp-server | chatbot   run that one service (three-service deployment)
//   anything else / unset                all-in-one: file server + chatbot in this container,
//                                        chatbot runs the MCP server itself over stdio
//
// All-in-one is what you get when you deploy the repo as a single Railway service.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const normalize = (s) => String(s || '').trim().toLowerCase().replace(/[\s_]+/g, '-');

const ENTRY = {
  'file-server': 'file-server/src/server.js',
  'mcp-server': 'mcp-server/src/index.js',
  chatbot: 'chatbot/src/server.js',
};
const ALIASES = { fileserver: 'file-server', files: 'file-server', mcpserver: 'mcp-server', mcp: 'mcp-server', chat: 'chatbot', web: 'chatbot' };

const requested = normalize(env.SERVICE || env.RAILWAY_SERVICE_NAME);
const service = ENTRY[requested] ? requested : ALIASES[requested.replace(/-/g, '')] ?? 'all-in-one';
const dataDir = env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || path.join(root, 'data');
// Listen on all interfaces (IPv4 + IPv6) so a platform proxy can reach us. Railway returns 502
// if the app listens on 127.0.0.1 only. Servers fall back to 0.0.0.0 when IPv6 is unavailable.
const publicHost = env.HOST || '::';
const portNote = () => console.log(`[start] listening port: ${env.PORT || 3000} (point your Railway domain at this port)`);

const children = new Set();
function run(name, file, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(root, file)], { stdio: 'inherit', env: { ...env, ...extraEnv } });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    // If any part dies, stop everything so the platform restarts the whole container.
    console.error(`[start] ${name} exited (${signal ?? code}); stopping.`);
    shutdown(typeof code === 'number' && code !== 0 ? code : 1);
  });
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 8000).unref();
  const done = () => { if (!children.size) process.exit(code); };
  for (const c of children) c.once('exit', done);
  done();
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

console.log(`[start] mode: ${service}${requested ? ` (from "${env.SERVICE ? 'SERVICE' : 'RAILWAY_SERVICE_NAME'}=${requested}")` : ''}`);

if (service === 'file-server') {
  run('file-server', ENTRY['file-server'], { DATA_DIR: dataDir, HOST: publicHost });
} else if (service === 'mcp-server') {
  run('mcp-server', ENTRY['mcp-server'], { MCP_TRANSPORT: env.MCP_TRANSPORT || 'http', HOST: publicHost });
} else if (service === 'chatbot') {
  portNote();
  run('chatbot', ENTRY.chatbot, { HOST: publicHost });
} else {
  // All-in-one: the file server stays private on localhost; only the chatbot listens on $PORT.
  const publicPort = Number(env.PORT || 3000);
  const filePort = Number(env.FILE_SERVER_PORT || (publicPort === 4000 ? 4001 : 4000));
  const token = env.FILE_SERVER_TOKEN || crypto.randomBytes(24).toString('hex');
  const fileServerUrl = `http://127.0.0.1:${filePort}`;
  run('file-server', ENTRY['file-server'], {
    HOST: '127.0.0.1', FILE_SERVER_PORT: String(filePort), DATA_DIR: dataDir, FILE_SERVER_TOKEN: token,
  });
  portNote();
  run('chatbot', ENTRY.chatbot, {
    PORT: String(publicPort), HOST: publicHost, FILE_SERVER_URL: fileServerUrl, FILE_SERVER_TOKEN: token,
    // No remote MCP server: the chatbot starts mcp-server over stdio and passes these on.
    MCP_SERVER_URL: '', MCP_SERVER_HOST: '',
  });
}
