// Loads any supported file into one normalized shape:
// { format, unit, pageSource, pages: [{number,label,text}], paragraphs: [{number,page,text}], fullText, metadata }
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { decodeText, detectFormat } from './extractors/index.js';
import { HttpError } from './paths.js';

// Break up very long paragraphs (e.g. a log file with no blank lines) at line or word boundaries.
function splitOversized(text, max) {
  if (text.length <= max * 1.5) return [text];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

// Group paragraphs into virtual pages of roughly charsPerVirtualPage characters.
function paginate(paragraphs, cpp) {
  const pages = [];
  let cur = [], len = 0;
  for (const p of paragraphs) {
    if (cur.length && len + p.length > cpp) { pages.push({ paragraphs: cur }); cur = []; len = 0; }
    cur.push(p);
    len += p.length + 2;
  }
  if (cur.length || !pages.length) pages.push({ paragraphs: cur });
  return pages;
}

const UNIT_NAMES = { page: 'Page', sheet: 'Sheet', slide: 'Slide', chapter: 'Chapter' };

function normalize(raw, cpp) {
  let rawPages = raw.pages;
  let pageSource = raw.pageSource ?? 'native';
  const max = cpp;
  if (!rawPages) {
    rawPages = paginate(raw.paragraphs.flatMap((p) => splitOversized(p, max)), cpp);
    pageSource = 'virtual';
  } else {
    rawPages = rawPages.map((p) => ({ ...p, paragraphs: p.paragraphs.flatMap((x) => splitOversized(x, max)) }));
  }
  const pages = [];
  const paragraphs = [];
  rawPages.forEach((p, i) => {
    const number = i + 1;
    pages.push({ number, label: p.label || undefined, text: p.text ?? p.paragraphs.join('\n\n') });
    for (const t of p.paragraphs) paragraphs.push({ number: paragraphs.length + 1, page: number, text: t });
  });
  const unit = raw.unit ?? 'page';
  const fullText = unit === 'page'
    ? pages.map((p) => p.text).join('\n\n')
    : pages.map((p) => `[${UNIT_NAMES[unit]} ${p.number}${p.label ? `: ${p.label}` : ''}]\n${p.text}`).join('\n\n');
  const metadata = Object.fromEntries(Object.entries(raw.metadata ?? {}).filter(([, v]) => v !== undefined && v !== ''));
  return { unit, pageSource, pages, paragraphs, fullText, metadata };
}

const cache = new Map();
const CACHE_MAX = 100;

export async function loadDocument(abs, stat) {
  const key = `${abs}|${stat.mtimeMs}|${stat.size}`;
  if (cache.has(key)) return cache.get(key);
  if (stat.size > config.maxFileBytes) {
    throw new HttpError(413, `File is ${(stat.size / 1048576).toFixed(1)} MB; the limit is ${config.maxFileBytes / 1048576} MB (MAX_FILE_MB).`);
  }
  const buffer = await fs.readFile(abs);
  const detected = await detectFormat(buffer, abs);
  if (!detected.extractor) {
    throw new HttpError(415, `Unsupported format (${detected.format}). ${detected.hint ?? ''}`.trim());
  }
  let raw;
  try {
    raw = await detected.extractor.extract(buffer, { ext: path.extname(abs).toLowerCase(), path: abs, decodeText });
  } catch (e) {
    throw new HttpError(e.status ?? 422, `Could not read ${path.basename(abs)} as ${detected.extractor.label}: ${e.message}`);
  }
  const doc = {
    format: detected.format,
    formatLabel: detected.extractor.label,
    detectedBy: detected.detectedBy,
    ...normalize(raw, config.charsPerVirtualPage),
  };
  cache.set(key, doc);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return doc;
}

/** Parses "3", "1-4", "1,3,5-7" into sorted 1-based indices within [1, max]. */
export function parseRange(spec, max) {
  if (spec === undefined || spec === null || spec === '') return null;
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m || Number(m[1]) < 1 || (m[2] && Number(m[2]) < Number(m[1]))) {
      throw new HttpError(400, `Invalid range "${part.trim()}". Use forms like 2, 1-3 or 1,4,6-8.`);
    }
    const end = Math.min(m[2] ? Number(m[2]) : Number(m[1]), max);
    for (let i = Number(m[1]); i <= end; i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}
