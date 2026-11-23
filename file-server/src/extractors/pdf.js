// pdf-parse is loaded on first use: if its native helper can't load on some platform,
// only PDF reading fails (with a clear error) instead of the whole server.
let pdfParseModule;
async function loadPdfParse() {
  try {
    pdfParseModule ??= await import('pdf-parse');
    return pdfParseModule.PDFParse;
  } catch (e) {
    pdfParseModule = undefined;
    throw Object.assign(new Error(`PDF support is unavailable on this server: ${e.message}`), { status: 501 });
  }
}
import { splitParagraphs } from './util.js';

// PDFs have no paragraph markers. Heuristic: a line ending in . ! ? : or a short line
// (heading / last line of a paragraph) closes the current paragraph.
function pdfParagraphs(pageText) {
  if (/\n\s*\n/.test(pageText)) return splitParagraphs(pageText, { collapse: true });
  const out = [];
  let buf = [];
  for (const raw of pageText.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    buf.push(line);
    if (/[.!?:]["')\]]?$/.test(line) || line.length < 50) {
      out.push(buf.join(' '));
      buf = [];
    }
  }
  if (buf.length) out.push(buf.join(' '));
  return out;
}

export default {
  id: 'pdf',
  label: 'PDF document',
  extensions: ['.pdf'],
  async extract(buffer) {
    const PDFParse = await loadPdfParse();
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      let info = {};
      try { info = (await parser.getInfo())?.info ?? {}; } catch { /* optional */ }
      return {
        unit: 'page',
        pageSource: 'native',
        pages: result.pages.map((p) => ({ text: p.text.trim(), paragraphs: pdfParagraphs(p.text) })),
        metadata: { title: info.Title, author: info.Author, subject: info.Subject, creator: info.Creator, producer: info.Producer },
      };
    } catch (e) {
      if (/password/i.test(e.message)) throw Object.assign(new Error('PDF is password-protected'), { status: 422 });
      throw e;
    } finally {
      await parser.destroy();
    }
  },
};
