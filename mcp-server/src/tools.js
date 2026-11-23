// MCP tool definitions. Each tool forwards to the File-Reading Server over HTTP.
// Logs go to stderr: in stdio mode stdout carries MCP protocol messages only.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const env = process.env;
const urlFromParts = (host, port) => `http://${host.includes(':') ? `[${host}]` : host}:${port}`;

// FILE_SERVER_URL, or FILE_SERVER_HOST + FILE_SERVER_PORT (e.g. a Railway private domain).
export const FILE_SERVER_URL = (env.FILE_SERVER_URL
  || (env.FILE_SERVER_HOST ? urlFromParts(env.FILE_SERVER_HOST, env.FILE_SERVER_PORT || 4000) : 'http://localhost:4000')).replace(/\/$/, '');
const FILE_SERVER_TOKEN = env.FILE_SERVER_TOKEN || '';
export const log = (...args) => console.error('[mcp-server]', ...args);

async function callFileServer(route, params = {}) {
  const url = new URL(FILE_SERVER_URL + route);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(120000),
      headers: FILE_SERVER_TOKEN ? { Authorization: `Bearer ${FILE_SERVER_TOKEN}` } : {},
    });
  } catch (e) {
    throw new Error(`Cannot reach File-Reading Server at ${FILE_SERVER_URL} (${e.cause?.code || e.message}). Is it running?`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `File-Reading Server returned HTTP ${res.status}`);
  return body;
}

// Results go back as JSON text plus structuredContent; failures become MCP tool errors.
const tool = (fn) => async (args) => {
  try {
    const data = await fn(args);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  } catch (e) {
    log('tool error:', e.message);
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
};

const range = z.string().regex(/^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/, 'Use forms like "2", "1-3" or "1,4,6-8"');
const filePath = z.string().min(1).describe(
  'Path to the file: absolute (/Users/me/docs/a.pdf, C:\\docs\\a.pdf), home-relative (~/docs/a.pdf), ' +
  'or relative to the server default folder. Must be inside an allowed folder (see get_server_info).');
const dirPath = z.string().optional().describe('Folder path (absolute, ~/..., or relative). Defaults to the server default folder.');
const formats = z.array(z.string()).optional().describe('Only these formats or extensions, e.g. ["pdf","docx"] or [".xlsx"]');

export function buildServer() {
    const server = new McpServer({ name: 'file-reader-mcp', version: '3.0.0' });

  server.registerTool('get_server_info', {
    title: 'Server info',
    description: 'Show which folders can be read, the default folder for relative paths, and all supported file formats.',
    inputSchema: {},
  }, tool(async () => {
    const [roots, fmts] = await Promise.all([callFileServer('/roots'), callFileServer('/formats')]);
    return { ...roots, formats: fmts };
  }));

  server.registerTool('list_files', {
    title: 'List files',
    description: 'List files and subfolders in a folder, with format, size and modified date. Use recursive to include subfolders.',
    inputSchema: {
      dir: dirPath,
      recursive: z.boolean().optional().describe('Include subfolders (default false)'),
      formats,
      limit: z.number().int().positive().max(2000).optional().describe('Max entries (default 500)'),
    },
  }, tool(({ dir, recursive, formats: f, limit }) => callFileServer('/files', { dir, recursive, formats: f, limit })));

  server.registerTool('get_file_details', {
    title: 'Get file details',
    description:
      'Get details for any file: size, dates, detected format, and for readable formats the number of pages ' +
      '(or sheets / slides / chapters), paragraphs, words and document metadata such as title and author.',
    inputSchema: { path: filePath },
  }, tool(({ path }) => callFileServer('/files/details', { path })));

  server.registerTool('extract_text', {
    title: 'Extract text',
    description:
      'Extract text from a file. Optionally restrict to pages OR paragraphs (1-based, ranges allowed). ' +
      'A "page" is a PDF/Word page, a spreadsheet sheet, a presentation slide or an e-book chapter. ' +
      'Formats: PDF, DOCX, DOC, ODT, RTF, XLSX, XLS, ODS, CSV, TSV, PPTX, ODP, HTML, EPUB, Markdown, JSON, code and other text.',
    inputSchema: {
      path: filePath,
      pages: range.optional().describe('Pages / sheets / slides / chapters, e.g. "1", "2-4", "1,3"'),
      paragraphs: range.optional().describe('Paragraphs (spreadsheet rows), e.g. "1", "2-5"'),
      maxChars: z.number().int().positive().max(500000).optional().describe('Truncate output (default 20000)'),
    },
  }, tool(({ path, pages, paragraphs, maxChars }) => {
    if (pages && paragraphs) throw new Error('Provide either "pages" or "paragraphs", not both.');
    return callFileServer('/files/text', { path, pages, paragraphs, maxChars });
  }));

  server.registerTool('search_file', {
    title: 'Search in a file',
    description: 'Find paragraphs in one file that contain a word or phrase. Returns page and paragraph numbers with snippets.',
    inputSchema: {
      path: filePath,
      query: z.string().min(1),
      caseSensitive: z.boolean().optional(),
      maxResults: z.number().int().positive().max(1000).optional(),
    },
  }, tool((a) => callFileServer('/files/search', a)));

  server.registerTool('search_directory', {
    title: 'Search in a folder',
    description: 'Search every readable file in a folder (any supported format) for a word or phrase.',
    inputSchema: {
      dir: dirPath,
      query: z.string().min(1),
      recursive: z.boolean().optional().describe('Include subfolders (default false)'),
      formats,
      caseSensitive: z.boolean().optional(),
      maxResults: z.number().int().positive().max(1000).optional(),
    },
  }, tool(({ formats: f, ...a }) => callFileServer('/search', { ...a, formats: f })));

  return server;
}
