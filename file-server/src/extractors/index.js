// Format registry + detection. To add a format: write an extractor
// ({ id, label, extensions, extract(buffer, ctx) }) and add it to EXTRACTORS.
import path from 'node:path';
import pdf from './pdf.js';
import { doc, docx } from './word.js';
import spreadsheet from './spreadsheet.js';
import { odp, pptx } from './presentation.js';
import { epub, html, odt, rtf } from './documents.js';
import text, { decodeText, looksLikeText } from './text.js';
import { loadZip, zipText } from './util.js';

export const EXTRACTORS = [pdf, docx, doc, spreadsheet, pptx, odp, odt, rtf, html, epub, text];
const byId = Object.fromEntries(EXTRACTORS.map((e) => [e.id, e]));
const byExt = {};
for (const e of EXTRACTORS) for (const x of e.extensions) byExt[x] = e;

// Known formats we can't read, with advice.
export const UNSUPPORTED_HINTS = {
  '.ppt': 'Legacy PowerPoint (.ppt) is not supported. Save it as .pptx.',
  '.pps': 'Legacy PowerPoint (.pps) is not supported. Save it as .pptx.',
  '.pages': 'Apple Pages is not supported. Export to .docx or .pdf.',
  '.numbers': 'Apple Numbers is not supported. Export to .xlsx or .csv.',
  '.key': 'Apple Keynote is not supported. Export to .pptx or .pdf.',
  '.png': 'Images need OCR, which is not included.',
  '.jpg': 'Images need OCR, which is not included.',
  '.jpeg': 'Images need OCR, which is not included.',
  '.gif': 'Images need OCR, which is not included.',
  '.tif': 'Images need OCR, which is not included.',
  '.tiff': 'Images need OCR, which is not included.',
  '.webp': 'Images need OCR, which is not included.',
  '.zip': 'Archives are not opened. Extract the files first.',
};

/** Fast guess from the extension only (used for directory listings). */
export function formatFromExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return byExt[ext]?.id ?? null;
}

const startsWith = (buf, sig) => buf.length >= sig.length && sig.every((b, i) => buf[i] === b);
const containsUtf16 = (buf, s) => buf.includes(Buffer.from(s, 'utf16le'));

/**
 * Detect the real format from content, falling back to the extension.
 * Returns { extractor, format, detectedBy, hint? }.
 */
export async function detectFormat(buffer, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const hit = (id, detectedBy) => ({ extractor: byId[id], format: id, detectedBy });

  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return hit('pdf', 'content'); // %PDF
  if (buffer.subarray(0, 6).toString('latin1') === '{\\rtf1' || buffer.subarray(0, 5).toString('latin1') === '{\\rtf') return hit('rtf', 'content');

  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) { // ZIP container: look inside
    try {
      const zip = await loadZip(buffer);
      if (zip.file('word/document.xml')) return hit('docx', 'content');
      if (zip.file('xl/workbook.xml') || zip.file('xl/workbook.bin')) return hit('spreadsheet', 'content');
      if (zip.file('ppt/presentation.xml')) return hit('pptx', 'content');
      const mime = (await zipText(zip, 'mimetype'))?.trim();
      if (mime === 'application/epub+zip') return hit('epub', 'content');
      if (mime?.startsWith('application/vnd.oasis.opendocument.text')) return hit('odt', 'content');
      if (mime?.startsWith('application/vnd.oasis.opendocument.spreadsheet')) return hit('spreadsheet', 'content');
      if (mime?.startsWith('application/vnd.oasis.opendocument.presentation')) return hit('odp', 'content');
    } catch { /* not a readable zip */ }
    return { extractor: null, format: 'zip', detectedBy: 'content', hint: UNSUPPORTED_HINTS['.zip'] };
  }

  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) { // OLE2 (old Office)
    if (containsUtf16(buffer, 'WordDocument')) return hit('doc', 'content');
    if (containsUtf16(buffer, 'Workbook') || containsUtf16(buffer, 'Book')) return hit('spreadsheet', 'content');
    if (containsUtf16(buffer, 'PowerPoint Document')) return { extractor: null, format: 'ppt', detectedBy: 'content', hint: UNSUPPORTED_HINTS['.ppt'] };
    if (byExt[ext]) return hit(byExt[ext].id, 'extension');
    return { extractor: null, format: 'ole', detectedBy: 'content', hint: 'Unrecognised legacy Office file.' };
  }

  if (byExt[ext]) return hit(byExt[ext].id, 'extension');
  if (UNSUPPORTED_HINTS[ext]) return { extractor: null, format: ext.slice(1), detectedBy: 'extension', hint: UNSUPPORTED_HINTS[ext] };

  if (looksLikeText(buffer)) {
    const head = decodeText(buffer.subarray(0, 2048)).trimStart().toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) return hit('html', 'content');
    return hit('text', 'content');
  }
  return { extractor: null, format: ext ? ext.slice(1) : 'binary', detectedBy: 'content', hint: 'Binary file in an unsupported format.' };
}

export function listFormats() {
  return {
    supported: EXTRACTORS.map(({ id, label, extensions }) => ({ id, label, extensions })),
    unsupported: UNSUPPORTED_HINTS,
    notes: 'Files with a wrong or missing extension are identified by their content.',
  };
}

export { decodeText };
