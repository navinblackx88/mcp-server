// Other document formats: OpenDocument text, RTF, HTML, EPUB.
import path from 'node:path';
import iconv from 'iconv-lite';
import { convert as htmlToText } from 'html-to-text';
import { odfParagraphs } from './presentation.js';
import { loadZip, odfMeta, splitParagraphs, xmlText, zipText } from './util.js';

const HTML_OPTS = {
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'h3', options: { uppercase: false } },
    { selector: 'table', format: 'dataTable', options: { uppercaseHeaderCells: false } },
  ],
};

export const odt = {
  id: 'odt',
  label: 'OpenDocument text (.odt)',
  extensions: ['.odt', '.ott'],
  async extract(buffer) {
    const zip = await loadZip(buffer);
    const xml = await zipText(zip, 'content.xml');
    if (!xml) throw new Error('Not a valid OpenDocument file (content.xml missing)');
    let body = xml.match(/<office:text\b[^>]*>([\s\S]*)<\/office:text>/)?.[1] ?? xml;
    // Turn each table row into one paragraph: "cell 1 | cell 2 | ...".
    body = body.replace(/<table:table-row\b[^>]*>[\s\S]*?<\/table:table-row>/g, (row) => {
      const cells = [...row.matchAll(/<table:table-cell\b[^>]*?(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)]
        .map((m) => odfParagraphs(m[1] ?? '').join(' '));
      while (cells.length && !cells.at(-1)) cells.pop();
      const esc = cells.join(' | ').replace(/&/g, '&amp;').replace(/</g, '&lt;');
      return `<text:p>${esc}</text:p>`;
    });
    const metadata = await odfMeta(zip);
    // LibreOffice records where pages ended last time it laid out the document.
    const chunks = body.split(/<text:soft-page-break\/>/);
    if (chunks.length > 1) {
      const pages = chunks.map((c) => ({ paragraphs: odfParagraphs(c) })).filter((p) => p.paragraphs.length);
      return { unit: 'page', pageSource: 'page-breaks', pages, metadata };
    }
    return { unit: 'page', paragraphs: odfParagraphs(body), metadata };
  },
};

// Minimal RTF reader: control words, groups, \'hh and \uN escapes, skipped destinations.
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer',
  'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf', 'themedata', 'colorschememapping', 'datastore',
  'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'mmathPr', 'fldinst',
  'filetbl', 'revtbl', 'pgdsctbl', 'wgrffmtfilter', 'bkmkstart', 'bkmkend', 'nonshppict', 'shppict', 'userprops']);

export function rtfToText(rtf) {
  let out = '';
  const stack = [];
  let skip = false, uc = 1, toSkip = 0, codepage = 'win1252';
  const re = /\\([a-zA-Z]{1,32})(-?\d{1,10})? ?|\\'([0-9a-fA-F]{2})|\\([^a-zA-Z])|([{}])|([\r\n]+)|([^\\{}\r\n]+)/gy;
  let m;
  const emit = (s) => {
    if (skip) return;
    if (toSkip > 0) { const n = Math.min(toSkip, s.length); toSkip -= n; s = s.slice(n); }
    out += s;
  };
  while ((m = re.exec(rtf))) {
    const [, word, arg, hex, sym, brace, , text] = m;
    if (brace === '{') stack.push({ skip, uc });
    else if (brace === '}') ({ skip, uc } = stack.pop() ?? { skip: false, uc: 1 });
    else if (hex) { if (toSkip > 0) toSkip--; else if (!skip) out += iconv.decode(Buffer.from([parseInt(hex, 16)]), codepage); }
    else if (sym) {
      if (sym === '*') skip = true;
      else if (sym === '~') emit(' ');
      else if (sym === '\n' || sym === '\r') emit('\n');
      else if ('\\{}'.includes(sym)) emit(sym);
    } else if (word) {
      if (RTF_SKIP.has(word)) { skip = true; continue; }
      if (word === 'ansicpg' && arg && iconv.encodingExists(`cp${arg}`)) codepage = `cp${arg}`;
      if (skip) continue;
      switch (word) {
        case 'par': case 'sect': out += '\n'; break;
        case 'line': out += '\u2028'; break; // soft line break inside a paragraph
        case 'page': out += '\f'; break;
        case 'pagebb': out += out.endsWith('\n') || !out ? '\f' : '\n\f'; break; // "page break before" paragraph
        case 'tab': out += '\t'; break;
        case 'cell': out += ' | '; break;
        case 'row': out += '\n'; break;
        case 'emdash': out += '—'; break;
        case 'endash': out += '–'; break;
        case 'lquote': out += '‘'; break;
        case 'rquote': out += '’'; break;
        case 'ldblquote': out += '“'; break;
        case 'rdblquote': out += '”'; break;
        case 'bullet': out += '•'; break;
        case 'uc': uc = Number(arg ?? 1); break;
        case 'u': { let n = Number(arg); if (n < 0) n += 65536; out += String.fromCharCode(n); toSkip = uc; break; }
        default: break;
      }
    } else if (text) emit(text);
  }
  return out;
}

export const rtf = {
  id: 'rtf',
  label: 'Rich Text Format (.rtf)',
  extensions: ['.rtf'],
  async extract(buffer) {
    const text = rtfToText(buffer.toString('latin1'));
    const toParas = (s) => s.split('\n')
      .map((l) => l.replace(/\u2028/g, '\n').replace(/[ \t]+$/gm, '').replace(/(\s*\|\s*)+$/, '').trim())
      .filter(Boolean);
    const rawPages = text.split('\f');
    if (rawPages.length > 1) {
      return { unit: 'page', pageSource: 'page-breaks', pages: rawPages.map((s) => ({ paragraphs: toParas(s) })).filter((p) => p.paragraphs.length), metadata: {} };
    }
    return { unit: 'page', paragraphs: toParas(text), metadata: {} };
  },
};

export const html = {
  id: 'html',
  label: 'Web page (.html)',
  extensions: ['.html', '.htm', '.xhtml'],
  async extract(buffer, { decodeText }) {
    const source = decodeText(buffer);
    const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    return {
      unit: 'page',
      paragraphs: splitParagraphs(htmlToText(source, HTML_OPTS)),
      metadata: { title: title ? xmlText(title).trim() : undefined },
    };
  },
};

export const epub = {
  id: 'epub',
  label: 'E-book (.epub)',
  extensions: ['.epub'],
  async extract(buffer) {
    const zip = await loadZip(buffer);
    const container = await zipText(zip, 'META-INF/container.xml');
    const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
    const opf = opfPath && (await zipText(zip, opfPath));
    if (!opf) throw new Error('Not a valid EPUB (package file missing)');
    const base = path.posix.dirname(opfPath);
    const manifest = Object.fromEntries([...opf.matchAll(/<item\b[^>]*>/g)].map(([tag]) => [tag.match(/\bid="([^"]+)"/)?.[1], decodeURIComponent(tag.match(/\bhref="([^"]+)"/)?.[1] ?? '')]));
    const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => manifest[m[1]]).filter(Boolean);
    const pages = [];
    for (const href of spine) {
      const xhtml = await zipText(zip, path.posix.normalize(path.posix.join(base, href)));
      if (!xhtml) continue;
      const paragraphs = splitParagraphs(htmlToText(xhtml, HTML_OPTS));
      if (!paragraphs.length) continue;
      const heading = xhtml.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1];
      pages.push({ label: heading ? xmlText(heading).trim().slice(0, 80) : undefined, paragraphs });
    }
    const pick = (tag) => { const m = opf.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? xmlText(m[1]).trim() : undefined; };
    return {
      unit: 'chapter',
      pageSource: 'native',
      pages,
      metadata: { title: pick('dc:title'), author: pick('dc:creator'), language: pick('dc:language'), publisher: pick('dc:publisher') },
    };
  },
};
