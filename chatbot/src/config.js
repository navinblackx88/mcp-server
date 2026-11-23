// Chatbot configuration (environment variables).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load chatbot/.env if present (Node 20.12+). Variables already set in the shell win.
try { process.loadEnvFile?.(path.join(__dirname, '../.env')); } catch { /* no .env file */ }
const env = process.env;

// LLM_PROVIDER: anthropic | openai | ollama | rules. If unset, picked from the API keys present;
// with no key it falls back to "rules" (offline, keyword-based, no LLM).
function pickProvider() {
  if (env.LLM_PROVIDER) return env.LLM_PROVIDER.toLowerCase();
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  return 'rules';
}

const provider = pickProvider();
const DEFAULT_MODELS = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-4.1-mini', ollama: 'qwen2.5:7b', rules: 'keyword-rules' };

const urlFromParts = (host, port) => `http://${host.includes(':') ? `[${host}]` : host}:${port}`;

export const config = {
  port: Number(env.CHATBOT_PORT || env.PORT || 3000),
  // Locally 127.0.0.1; in Docker/Railway set HOST=:: (IPv4 + IPv6).
  host: env.CHATBOT_HOST || env.HOST || '127.0.0.1',
  // Optional login for the whole site (HTTP Basic auth). Strongly recommended on a public URL.
  password: env.CHATBOT_PASSWORD || '',
  username: env.CHATBOT_USERNAME || 'admin',
  rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MIN || 20), // chat messages per IP per minute
  trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY === 'true' : Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME),
  provider,
  model: env.LLM_MODEL || DEFAULT_MODELS[provider],
  // Base URL override: any OpenAI-compatible server (Ollama, LM Studio, vLLM, Groq, Azure…) or an Anthropic proxy.
  baseURL: env.LLM_BASE_URL || (provider === 'ollama' ? 'http://localhost:11434/v1' : undefined),
  apiKey: provider === 'anthropic' ? env.ANTHROPIC_API_KEY : provider === 'ollama' ? env.OPENAI_API_KEY || 'ollama' : env.OPENAI_API_KEY,
  maxTokens: Number(env.LLM_MAX_TOKENS || 2048),
  temperature: env.LLM_TEMPERATURE === undefined ? 0.2 : Number(env.LLM_TEMPERATURE),
  maxToolRounds: Number(env.MAX_TOOL_ROUNDS || 8),       // tool-call rounds per user message
  maxToolResultChars: Number(env.MAX_TOOL_RESULT_CHARS || 15000),
  maxHistoryMessages: Number(env.MAX_HISTORY_MESSAGES || 40),
  // MCP server: remote over HTTP (MCP_SERVER_URL, or MCP_SERVER_HOST + MCP_SERVER_PORT),
  // otherwise started locally as a child process over stdio.
  mcpServerUrl: env.MCP_SERVER_URL
    || (env.MCP_SERVER_HOST ? `${urlFromParts(env.MCP_SERVER_HOST, env.MCP_SERVER_PORT || 8080)}/mcp` : ''),
  mcpAuthToken: env.MCP_AUTH_TOKEN || '',
  mcpServerPath: env.MCP_SERVER_PATH || path.join(__dirname, '../../mcp-server/src/index.js'),
  // File server: used by the local stdio MCP server, and directly for uploads.
  fileServerUrl: (env.FILE_SERVER_URL
    || (env.FILE_SERVER_HOST ? urlFromParts(env.FILE_SERVER_HOST, env.FILE_SERVER_PORT || 4000) : 'http://localhost:4000')).replace(/\/$/, ''),
  fileServerToken: env.FILE_SERVER_TOKEN || '',
};

export const SYSTEM_PROMPT = `You are a helpful assistant that answers questions about the user's local files.
You can only see files through the tools provided. Never invent file contents.

How to work:
- Users may give an absolute path, a ~/ path, a relative path, or just a file name. If you are unsure where a file is, use list_files (recursive) or search_directory to find it. If a path is refused, call get_server_info to see the allowed folders and tell the user.
- Files the user uploads in the chat are saved in the "uploads" folder (e.g. uploads/report.pdf).
- Start with get_file_details for unfamiliar files: it tells you the format and how many pages / sheets / slides / chapters / paragraphs there are.
- For large files, read only the pages or paragraphs you need (extract_text with "pages" or "paragraphs"), or use search_file to locate the relevant part first.
- In spreadsheets a "page" is a sheet and a "paragraph" is a row; in presentations a page is a slide; in EPUB a page is a chapter.
- When you quote or summarize, say where it came from (file name and page/sheet/slide number).
- If a tool returns an error, explain it plainly and suggest a fix.
- Keep answers concise. Use short lists or small tables when they help.`;
