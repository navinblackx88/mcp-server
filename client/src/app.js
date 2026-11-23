#!/usr/bin/env node
// MCP Client Application: launches the MCP server (stdio), calls its tools,
// and prints file details and extracted content. Paths can be absolute, ~/..., or relative.
//
//   node src/app.js                                  interactive menu
//   node src/app.js demo                             tour of every format in sample-files
//   node src/app.js info                             allowed folders + supported formats
//   node src/app.js list [dir] [-r] [--formats pdf,docx]
//   node src/app.js details <path> [<path> ...]
//   node src/app.js text <path> [<path> ...] [--pages 1-2 | --paragraphs 3,5] [--max 5000]
//   node src/app.js search <path> <query>
//   node src/app.js grep <query> [--dir <dir>] [-r] [--formats pdf,docx]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = process.env.MCP_SERVER_PATH || path.join(__dirname, '../../mcp-server/src/index.js');
const FILE_SERVER_URL = process.env.FILE_SERVER_URL || 'http://localhost:4000';

// ---------- display ----------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { bold: paint(1), dim: paint(2), cyan: paint(36), green: paint(32), red: paint(31), yellow: paint(33) };
const header = (t) => console.log('\n' + c.cyan(c.bold(`== ${t} ${'='.repeat(Math.max(0, 66 - t.length))}`)));
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtDate = (d) => new Date(d).toLocaleString();
const UNIT = { page: 'Page', sheet: 'Sheet', slide: 'Slide', chapter: 'Chapter' };
const unitName = (u, n) => `${UNIT[u] ?? 'Page'}${n === 1 ? '' : 's'}`;

function showInfo(info) {
  header('Server info');
  console.log(`  ${c.bold('Allowed folders')} ${info.allowAll ? 'any path (*)' : ''}`);
  for (const r of info.roots) console.log(`    ${r}`);
  console.log(`  ${c.bold('Default folder ')} ${info.defaultDir}  ${c.dim('(relative paths resolve here)')}`);
  console.log(`  ${c.bold('Supported formats')}`);
  for (const f of info.formats.supported) console.log(`    ${f.label.padEnd(52)} ${c.dim(f.extensions.slice(0, 10).join(' ') + (f.extensions.length > 10 ? ' …' : ''))}`);
}

function showList(d) {
  header(`${d.dir}${d.recursive ? ' (recursive)' : ''}: ${d.count} entr${d.count === 1 ? 'y' : 'ies'}${d.truncated ? ' (truncated)' : ''}`);
  const base = d.dir;
  console.table(d.entries.map((e) => (e.kind === 'directory'
    ? { name: path.relative(base, e.path) + '/', format: 'folder', size: '', modified: '' }
    : { name: path.relative(base, e.path), format: e.supported === true ? e.format : e.supported === false ? `${e.format} ✗` : 'unknown ?', size: fmtBytes(e.sizeBytes), modified: fmtDate(e.modified) })));
}

function showDetails(d) {
  header(`Details: ${d.name}`);
  const rows = [['Path', d.path], ['Size', fmtBytes(d.sizeBytes)], ['Created', fmtDate(d.created)], ['Modified', fmtDate(d.modified)]];
  if (d.supported) {
    rows.push(
      ['Format', `${d.formatLabel}${d.extensionMismatch ? c.dim(` (detected from content; extension "${d.extension || 'none'}")`) : ''}`],
      [unitName(d.unit, 2), `${d.pageCount}${d.pageSource === 'virtual' ? c.dim(' (virtual, ~3000 chars each)') : d.pageSource === 'page-breaks' ? c.dim(' (from page breaks)') : ''}`],
    );
    if (d.pageLabels) rows.push(['', d.pageLabels.map((l, i) => `${i + 1}. ${l ?? '—'}`).join('   ')]);
    rows.push([d.unit === 'sheet' ? 'Rows' : 'Paragraphs', d.paragraphCount], ['Words', d.wordCount], ['Characters', d.characterCount]);
    for (const [k, v] of Object.entries(d.metadata || {})) {
      if (k === 'sheets') rows.push(['Sheet sizes', v.map((s) => `${s.name} (${s.rows}×${s.columns})`).join(', ')]);
      else rows.push([k[0].toUpperCase() + k.slice(1), typeof v === 'object' ? JSON.stringify(v) : v]);
    }
  } else {
    rows.push(['Readable', c.red('no') + ' — ' + d.reason]);
  }
  for (const [k, v] of rows) console.log(`  ${c.bold(String(k).padEnd(14))} ${v}`);
}

function showText(r) {
  const what = r.mode === 'full' ? 'full text'
    : r.mode === 'pages' ? `${unitName(r.unit, r.sections.length).toLowerCase()} ${r.sections.map((s) => s.page).join(', ')}`
    : `paragraphs ${r.sections.map((s) => s.paragraph).join(', ')}`;
  header(`Text: ${path.basename(r.path)} — ${what}`);
  console.log(c.dim(`  (${r.totalPages} ${unitName(r.unit, r.totalPages).toLowerCase()}, ${r.totalParagraphs} paragraphs in file)`));
  if (r.sections) {
    for (const s of r.sections) {
      const title = s.paragraph
        ? `--- Paragraph ${s.paragraph} (${UNIT[r.unit].toLowerCase()} ${s.page}) ---`
        : `--- ${UNIT[r.unit]} ${s.page}${s.label ? `: ${s.label}` : ''} ---`;
      console.log('\n' + c.yellow(title));
      console.log(s.text);
    }
  } else console.log('\n' + r.text);
  if (r.truncated) console.log(c.red('\n[output truncated — use --max to raise the limit]'));
}

function showMatches(file, unit, matches) {
  for (const m of matches) {
    const where = `${UNIT[unit] ?? 'Page'} ${m.page}${m.pageLabel ? ` (${m.pageLabel})` : ''}, ¶${m.paragraph}`;
    console.log(`  ${c.yellow(where.padEnd(28))} ${m.snippet}`);
  }
}

function showSearch(r) {
  header(`"${r.query}" in ${path.basename(r.path)}: ${r.matchCount} match(es)`);
  showMatches(r.path, r.unit, r.matches);
}

function showGrep(r) {
  header(`"${r.query}" in ${r.dir}: ${r.matchCount} match(es) in ${r.filesMatched} of ${r.filesScanned} files`);
  for (const f of r.results) {
    console.log('\n' + c.bold(path.relative(r.dir, f.path)) + c.dim(`  [${f.format}]`));
    showMatches(f.path, f.unit, f.matches);
  }
  for (const s of r.skipped) console.log(c.dim(`  skipped ${path.relative(r.dir, s.path)}: ${s.reason}`));
}

// ---------- MCP plumbing ----------
// Remote MCP server over HTTP when MCP_SERVER_URL is set (e.g. https://your-mcp.up.railway.app/mcp),
// otherwise start the local mcp-server as a child process over stdio.
async function connect() {
  const transport = process.env.MCP_SERVER_URL
    ? new StreamableHTTPClientTransport(new URL(process.env.MCP_SERVER_URL), {
      requestInit: { headers: process.env.MCP_AUTH_TOKEN ? { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } : {} },
    })
    : new StdioClientTransport({
      command: process.execPath,
      args: [MCP_SERVER_PATH],
      env: { ...process.env, MCP_TRANSPORT: 'stdio', FILE_SERVER_URL },
      stderr: 'ignore',
    });
  const client = new Client({ name: 'file-reader-client', version: '3.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.map((p) => p.text).join('\n') ?? '';
  if (res.isError) throw new Error(text);
  return res.structuredContent ?? JSON.parse(text);
}

// Run fn for each path, reporting per-file errors without stopping.
async function forEach(paths, fn) {
  for (const p of paths) {
    try { await fn(p); } catch (e) { console.log(c.red(`\n✗ ${p}: `) + e.message); }
  }
}

const actions = {
  info: async (cl) => showInfo(await call(cl, 'get_server_info')),
  list: async (cl, dir, opts = {}) => showList(await call(cl, 'list_files', { dir: dir || undefined, ...opts })),
  details: (cl, paths) => forEach(paths, async (p) => showDetails(await call(cl, 'get_file_details', { path: p }))),
  text: (cl, paths, opts = {}) => forEach(paths, async (p) => showText(await call(cl, 'extract_text', { path: p, ...opts }))),
  search: async (cl, p, query) => showSearch(await call(cl, 'search_file', { path: p, query })),
  grep: async (cl, query, opts = {}) => showGrep(await call(cl, 'search_directory', { query, ...opts })),
};

// Splits argv into positional args and options.
function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pages') opts.pages = argv[++i];
    else if (a === '--paragraphs') opts.paragraphs = argv[++i];
    else if (a === '--max') opts.maxChars = Number(argv[++i]);
    else if (a === '--formats') opts.formats = argv[++i].split(',');
    else if (a === '--dir') opts.dir = argv[++i];
    else if (a === '-r' || a === '--recursive') opts.recursive = true;
    else pos.push(a);
  }
  return { pos, opts };
}

async function demo(cl) {
  await actions.info(cl);
  const listing = await call(cl, 'list_files', { recursive: true });
  showList(listing);
  const files = listing.entries.filter((e) => e.kind === 'file');
  for (const f of files) {
    await actions.details(cl, [f.path]);
    if (f.supported !== false) await actions.text(cl, [f.path], { pages: '1', maxChars: 400 });
  }
  const xlsx = files.find((f) => f.name.endsWith('.xlsx'));
  if (xlsx) await actions.text(cl, [xlsx.path], { pages: '2' });
  const pptx = files.find((f) => f.name.endsWith('.pptx'));
  if (pptx) await actions.text(cl, [pptx.path], { paragraphs: '1-3' });
  await actions.grep(cl, 'battery', { recursive: true });
  header('Error handling');
  for (const bad of ['/etc/passwd', 'does-not-exist.pdf']) {
    try { await call(cl, 'get_file_details', { path: bad }); } catch (e) { console.log('  ' + c.red('Expected error: ') + e.message); }
  }
}

async function interactive(cl) {
  // Buffer lines so it works both when typed and when input is piped in.
  const rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => {
    process.stdout.write(c.bold(q));
    const { value, done } = await lines.next();
    if (done) return 'q';
    if (!process.stdin.isTTY) process.stdout.write(value + '\n');
    return value.trim();
  };
  const askPaths = async () => (await ask('File path(s), comma-separated: ')).split(',').map((s) => s.trim()).filter(Boolean);
  try {
    while (true) {
      console.log(`\n${c.bold('1')} Info  ${c.bold('2')} List folder  ${c.bold('3')} File details  ${c.bold('4')} Extract text  ${c.bold('5')} Search file  ${c.bold('6')} Search folder  ${c.bold('q')} Quit`);
      const choice = await ask('> ');
      if (choice === 'q' || choice === '') break;
      try {
        if (choice === '1') await actions.info(cl);
        else if (choice === '2') {
          const dir = await ask('Folder (blank = default): ');
          const rec = (await ask('Include subfolders? [y/N]: ')).toLowerCase() === 'y';
          await actions.list(cl, dir, { recursive: rec });
        } else if (choice === '3') await actions.details(cl, await askPaths());
        else if (choice === '4') {
          const paths = await askPaths();
          const by = (await ask('Select by [f]ull / [p]ages / pa[r]agraphs: ')).toLowerCase();
          const opts = {};
          if (by === 'p') opts.pages = await ask('Pages / sheets / slides (e.g. 1-2): ');
          if (by === 'r') opts.paragraphs = await ask('Paragraphs (e.g. 1,3): ');
          await actions.text(cl, paths, opts);
        } else if (choice === '5') await actions.search(cl, await ask('File path: '), await ask('Search for: '));
        else if (choice === '6') {
          const query = await ask('Search for: ');
          const dir = await ask('Folder (blank = default): ');
          await actions.grep(cl, query, { dir: dir || undefined, recursive: true });
        }
      } catch (e) {
        console.log(c.red('Error: ') + e.message);
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opts } = parseArgs(rest);
  const need = (n, usage) => { if (pos.length < n) throw new Error(`Usage: ${usage}`); };
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    console.log(c.green(`Connected to MCP server. Tools: ${tools.map((t) => t.name).join(', ')}`));
    switch (cmd) {
      case undefined: await interactive(client); break;
      case 'demo': await demo(client); break;
      case 'info': await actions.info(client); break;
      case 'list': await actions.list(client, pos[0], { recursive: opts.recursive, formats: opts.formats }); break;
      case 'details': need(1, 'details <path> [<path> ...]'); await actions.details(client, pos); break;
      case 'text': need(1, 'text <path> [<path> ...] [--pages R | --paragraphs R] [--max N]'); await actions.text(client, pos, opts); break;
      case 'search': need(2, 'search <path> <query>'); await actions.search(client, pos[0], pos.slice(1).join(' ')); break;
      case 'grep': need(1, 'grep <query> [--dir D] [-r] [--formats a,b]'); await actions.grep(client, pos.join(' '), opts); break;
      default: throw new Error(`Unknown command "${cmd}". Commands: demo, info, list, details, text, search, grep`);
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(c.red('Error: ') + e.message);
  process.exit(1);
});
