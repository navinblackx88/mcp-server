// File-Reading Server: reads local files in many formats and returns details or text.
// Paths can be absolute, relative to DEFAULT_DIR, or start with ~. Only files inside
// ALLOWED_ROOTS are readable (set ALLOWED_ROOTS=* to allow everything).
//
//   GET /health
//   GET /formats                                   supported formats
//   GET /roots                                     allowed folders and default folder
//   GET /files?dir=&recursive=&formats=&limit=     list a folder
//   GET /files/details?path=                       file details
//   GET /files/text?path=&pages=|paragraphs=&maxChars=
//   GET /files/search?path=&query=&maxResults=     search one file
//   GET /search?dir=&query=&recursive=&formats=    search every readable file in a folder
//   POST /files/upload?name=report.pdf             raw file bytes -> saved under UPLOAD_DIR
//
// If FILE_SERVER_TOKEN is set, every route except /health needs "Authorization: Bearer <token>".
import express from 'express';
import path from 'node:path';
import { config } from './config.js';
import { loadDocument, parseRange } from './document.js';
import { formatFromExtension, listFormats, UNSUPPORTED_HINTS } from './extractors/index.js';
import { getRoots, HttpError, resolvePath, walk } from './paths.js';
import { requireToken, saveUpload, seedDataDir } from './storage.js';

const app = express();
app.disable('x-powered-by');
const asyncRoute = (fn) => (req, res, next) => fn(req, res).catch(next);
const bool = (v) => v === 'true' || v === '1' || v === '';

// "pdf,docx" or ".pdf,.docx" -> a predicate on file paths
function formatFilter(spec) {
  if (!spec) return () => true;
  const wanted = String(spec).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return (p) => {
    const ext = path.extname(p).toLowerCase();
    const fmt = formatFromExtension(p);
    return wanted.some((w) => w === ext || `.${w}` === ext || w === fmt);
  };
}

function snippet(text, idx, qLen, radius = 80) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + qLen + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
}

function searchDoc(doc, query, caseSensitive, limit) {
  const q = caseSensitive ? query : query.toLowerCase();
  const matches = [];
  for (const p of doc.paragraphs) {
    const hay = caseSensitive ? p.text : p.text.toLowerCase();
    const idx = hay.indexOf(q);
    if (idx === -1) continue;
    const page = doc.pages[p.page - 1];
    matches.push({ paragraph: p.number, page: p.page, pageLabel: page.label, snippet: snippet(p.text, idx, q.length) });
    if (matches.length >= limit) break;
  }
  return matches;
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'file-server' }));
app.get('/', (_req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><title>file server</title><body style="font:16px system-ui;max-width:640px;margin:10vh auto;padding:0 20px;line-height:1.5"><h1 style="font-size:22px">This is the file server, not the chatbot</h1><p>It reads files for the MCP server over a private API and has no web page.</p><p>The chat page is served by the <b>chatbot</b>. On Railway, either generate the public domain on the <b>chatbot</b> service, or deploy one service in all-in-one mode by setting the variable <code>SERVICE=all-in-one</code> on it.</p><p style="color:#777">Health: <a href="/health">/health</a></p></body>`));

app.use(requireToken); // everything below needs the token (if one is configured)

app.post('/files/upload', express.raw({ type: () => true, limit: config.maxFileBytes }), asyncRoute(async (req, res) => {
  const saved = await saveUpload(req.query.name, req.body);
  const relativePath = path.relative(config.defaultDir, saved).split(path.sep).join('/');
  res.status(201).json({ path: saved, relativePath, name: path.basename(saved), sizeBytes: req.body.length, format: formatFromExtension(saved) ?? 'unknown' });
}));

app.get('/formats', (_req, res) => res.json(listFormats()));

app.get('/roots', asyncRoute(async (_req, res) => res.json(await getRoots())));

app.get('/files', asyncRoute(async (req, res) => {
  const { abs } = await resolvePath(req.query.dir, 'dir');
  const recursive = bool(req.query.recursive);
  const limit = Math.min(Number(req.query.limit) || 500, config.listLimit);
  const match = formatFilter(req.query.formats);
  const entries = [];
  let truncated = false;
  for await (const e of walk(abs, { recursive })) {
    if (e.isDir) {
      if (req.query.formats) continue;
      entries.push({ path: e.path, name: e.name, kind: 'directory' });
    } else {
      if (!match(e.path)) continue;
      const format = formatFromExtension(e.path);
      const ext = path.extname(e.path).toLowerCase();
      entries.push({
        path: e.path, name: e.name, kind: 'file',
        // supported: true = known readable extension, false = known unsupported, null = unknown (checked on read)
        format: format ?? (UNSUPPORTED_HINTS[ext] ? ext.slice(1) : 'unknown'),
        supported: format ? true : UNSUPPORTED_HINTS[ext] ? false : null,
        sizeBytes: e.stat.size, modified: e.stat.mtime.toISOString(),
      });
    }
    if (entries.length >= limit) { truncated = true; break; }
  }
  res.json({ dir: abs, recursive, count: entries.length, truncated, entries });
}));

app.get('/files/details', asyncRoute(async (req, res) => {
  const { abs, stat } = await resolvePath(req.query.path);
  const details = {
    path: abs,
    name: path.basename(abs),
    directory: path.dirname(abs),
    extension: path.extname(abs).toLowerCase(),
    sizeBytes: stat.size,
    created: stat.birthtime.toISOString(),
    modified: stat.mtime.toISOString(),
  };
  try {
    const doc = await loadDocument(abs, stat);
    Object.assign(details, {
      supported: true,
      format: doc.format,
      formatLabel: doc.formatLabel,
      detectedBy: doc.detectedBy, // "content" (magic bytes) or "extension"
      // true when the extension is missing or says something else than the content
      extensionMismatch: formatFromExtension(abs) !== doc.format,
      unit: doc.unit,             // what a "page" means: page | sheet | slide | chapter
      pageSource: doc.pageSource, // native | page-breaks | form-feed | virtual
      pageCount: doc.pages.length,
      pageLabels: doc.pages.some((p) => p.label) ? doc.pages.map((p) => p.label ?? null) : undefined,
      paragraphCount: doc.paragraphs.length,
      wordCount: doc.fullText.split(/\s+/).filter(Boolean).length,
      characterCount: doc.fullText.length,
      metadata: doc.metadata,
    });
  } catch (e) {
    if (![413, 415, 422, 501].includes(e.status)) throw e;
    Object.assign(details, { supported: false, reason: e.message });
  }
  res.json(details);
}));

app.get('/files/text', asyncRoute(async (req, res) => {
  const { abs, stat } = await resolvePath(req.query.path);
  const { pages, paragraphs } = req.query;
  if (pages && paragraphs) throw new HttpError(400, 'Use either "pages" or "paragraphs", not both');
  const maxChars = Math.max(1, Number(req.query.maxChars) || config.defaultMaxChars);
  const doc = await loadDocument(abs, stat);

  let mode = 'full';
  let sections;
  if (pages) {
    mode = 'pages';
    const idx = parseRange(pages, doc.pages.length);
    if (!idx.length) throw new HttpError(416, `No such ${doc.unit}(s). The file has ${doc.pages.length} ${doc.unit}(s).`);
    sections = idx.map((n) => ({ page: n, label: doc.pages[n - 1].label, text: doc.pages[n - 1].text }));
  } else if (paragraphs) {
    mode = 'paragraphs';
    const idx = parseRange(paragraphs, doc.paragraphs.length);
    if (!idx.length) throw new HttpError(416, `No such paragraph(s). The file has ${doc.paragraphs.length} paragraph(s).`);
    sections = idx.map((n) => ({ paragraph: n, page: doc.paragraphs[n - 1].page, text: doc.paragraphs[n - 1].text }));
  }

  let text = sections ? sections.map((s) => s.text).join('\n\n') : doc.fullText;
  const truncated = text.length > maxChars;
  if (truncated) {
    text = text.slice(0, maxChars);
    if (sections) {
      let budget = maxChars;
      sections = sections.map((s) => {
        if (budget <= 0) return null;
        const t = s.text.slice(0, budget);
        budget -= t.length + 2;
        return { ...s, text: t };
      }).filter(Boolean);
    }
  }
  res.json({
    path: abs, format: doc.format, unit: doc.unit, mode,
    totalPages: doc.pages.length, totalParagraphs: doc.paragraphs.length,
    sections, text, truncated,
  });
}));

app.get('/files/search', asyncRoute(async (req, res) => {
  const query = String(req.query.query ?? '');
  if (!query) throw new HttpError(400, 'Query parameter "query" is required');
  const { abs, stat } = await resolvePath(req.query.path);
  const doc = await loadDocument(abs, stat);
  const matches = searchDoc(doc, query, bool(req.query.caseSensitive), Number(req.query.maxResults) || 100);
  res.json({ path: abs, query, unit: doc.unit, matchCount: matches.length, matches });
}));

app.get('/search', asyncRoute(async (req, res) => {
  const query = String(req.query.query ?? '');
  if (!query) throw new HttpError(400, 'Query parameter "query" is required');
  const { abs } = await resolvePath(req.query.dir, 'dir');
  const match = formatFilter(req.query.formats);
  const maxResults = Number(req.query.maxResults) || 100;
  const caseSensitive = bool(req.query.caseSensitive);
  const results = [];
  const skipped = [];
  let filesScanned = 0, total = 0;
  for await (const e of walk(abs, { recursive: bool(req.query.recursive) })) {
    if (e.isDir || !match(e.path) || e.stat.size > config.maxFileBytes) continue;
    // Unknown extensions are skipped in folder search (they are still readable one by one).
    if (!formatFromExtension(e.path)) continue;
    filesScanned++;
    try {
      const doc = await loadDocument(e.path, e.stat);
      const matches = searchDoc(doc, query, caseSensitive, maxResults - total);
      if (matches.length) { results.push({ path: e.path, format: doc.format, unit: doc.unit, matches }); total += matches.length; }
    } catch (err) {
      skipped.push({ path: e.path, reason: err.message });
    }
    if (total >= maxResults || filesScanned >= config.listLimit) break;
  }
  res.json({ dir: abs, query, filesScanned, filesMatched: results.length, matchCount: total, results, skipped });
}));

app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  const message = err.type === 'entity.too.large' ? `File is larger than ${config.maxFileBytes / 1048576} MB (MAX_FILE_MB)` : err.message;
  res.status(status).json({ error: message });
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

await seedDataDir();

const server = listen(app, config.port, config.host, (addr) => {
  console.log(`File-Reading Server on http://${addr}`);
  console.log(config.allowAll ? 'Allowed roots: * (any path)' : `Allowed roots:\n  ${config.roots.join('\n  ')}`);
  console.log(`Relative paths resolve against: ${config.defaultDir}`);
  console.log(`Uploads: ${config.uploadsEnabled ? config.uploadDir : 'disabled'} · Token auth: ${config.token ? 'on' : 'off'}`);
});

// Railway (and Docker) stop containers with SIGTERM: finish in-flight requests, then exit.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
