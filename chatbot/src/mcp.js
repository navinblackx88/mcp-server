// MCP client. Connects to a remote MCP server over Streamable HTTP when MCP_SERVER_URL /
// MCP_SERVER_HOST is set (e.g. another Railway service), otherwise starts the local
// mcp-server as a child process over stdio.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTransport() {
  if (config.mcpServerUrl) {
    return new StreamableHTTPClientTransport(new URL(config.mcpServerUrl), {
      requestInit: { headers: config.mcpAuthToken ? { Authorization: `Bearer ${config.mcpAuthToken}` } : {} },
    });
  }
  return new StdioClientTransport({
    command: process.execPath,
    args: [config.mcpServerPath],
    env: { ...process.env, MCP_TRANSPORT: 'stdio', FILE_SERVER_URL: config.fileServerUrl },
    stderr: 'ignore',
  });
}

async function open() {
  const client = new Client({ name: 'file-reader-chatbot', version: '3.0.0' });
  await client.connect(makeTransport());
  const { tools } = await client.listTools();
  return { client, tools };
}

/** Connect, retrying while the MCP server starts up (services on Railway boot in parallel). */
async function openWithRetry(attempts = 20) {
  for (let i = 1; ; i++) {
    try {
      return await open();
    } catch (e) {
      if (i >= attempts) throw new Error(`Could not connect to the MCP server (${config.mcpServerUrl || 'stdio'}): ${e.message}`);
      console.warn(`[mcp] connect attempt ${i} failed (${e.message}); retrying…`);
      await sleep(Math.min(1000 * i, 5000));
    }
  }
}

export async function connectMcp() {
  let { client, tools } = await openWithRetry();
  let reconnecting = null;

  const reconnect = async () => {
    reconnecting ??= (async () => {
      await client.close().catch(() => {});
      ({ client, tools } = await openWithRetry(5));
    })().finally(() => { reconnecting = null; });
    return reconnecting;
  };

  const truncate = (text) => (text.length > config.maxToolResultChars
    ? text.slice(0, config.maxToolResultChars) + `\n…[truncated ${text.length - config.maxToolResultChars} chars; request fewer pages/paragraphs or use maxChars]`
    : text);

  return {
    transport: config.mcpServerUrl ? `http ${config.mcpServerUrl}` : 'stdio',

    // Provider-neutral tool list: { name, description, inputSchema (JSON Schema) }
    get tools() {
      return tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema }));
    },

    /** Call a tool. Always resolves: { ok, text } where text is what the LLM sees. */
    async call(name, args) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await client.callTool({ name, arguments: args ?? {} });
          const text = (res.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          return { ok: !res.isError, text: truncate(text || '(empty result)') };
        } catch (e) {
          // Connection-level failure (server restarted, child process died): reconnect once and retry.
          if (attempt === 0) { try { await reconnect(); continue; } catch { /* fall through */ } }
          return { ok: false, text: `Tool call failed: ${e.message}` };
        }
      }
      return { ok: false, text: 'Tool call failed' };
    },

    close: () => client.close(),
  };
}
