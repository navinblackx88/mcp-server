// Word documents: .docx (Office Open XML) and legacy .doc (binary).
import WordExtractor from 'word-extractor';
import { decodeEntities, loadZip, ooxmlCoreProps, zipText } from './util.js';

// Parse word/document.xml directly so we can honour page breaks:
// explicit <w:br w:type="page"/> and <w:lastRenderedPageBreak/> (where Word last
// laid out a page). If neither exists, pages are virtual.
function parseDocumentXml(xml) {
  // Drop fallback copies of text boxes so text isn't counted twice.
  xml = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  let body = xml.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? xml;
  // Turn each table row into one paragraph: "cell 1 | cell 2 | ...".
  body = body.replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, (row) => {
    const cells = [...row.matchAll(/<w:tc[ >]([\s\S]*?)<\/w:tc>/g)].map(([, tc]) =>
      [...tc.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(' ').trim());
    return `<w:p><w:r><w:t>${cells.join(' | ')}</w:t></w:r></w:p>`;
  });
  const pages = [[]];
  let sawBreak = false;
  for (const [, p] of body.matchAll(/<w:p[ >]([\s\S]*?)<\/w:p>/g)) {
    let text = '';
    let breakAfter = false;
    // Walk the paragraph's tokens in order.
    for (const [tok] of p.matchAll(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>|<w:tab\/>|<w:br[^>]*\/>|<w:lastRenderedPageBreak\/>|<w:cr\/>/g)) {
      if (tok.startsWith('<w:t')) text += decodeEntities(tok.replace(/<[^>]+>/g, ''));
      else if (tok === '<w:tab/>') text += '\t';
      else if (tok.startsWith('<w:lastRenderedPageBreak') || /w:type="page"/.test(tok)) {
        sawBreak = true;
        if (text.trim()) breakAfter = true; // break mid/after text: page ends after this paragraph
        else if (pages.at(-1).length) pages.push([]); // break at start: new page before it
      } else text += '\n';
    }
    if (/<w:pageBreakBefore(?:\s+w:val="(?:1|true)")?\s*\/>/.test(p) && pages.at(-1).length) { sawBreak = true; pages.push([]); }
    if (text.trim()) pages.at(-1).push(text.trim());
    if (breakAfter) pages.push([]);
  }
  const clean = pages.filter((pg) => pg.length);
  return { pages: clean, sawBreak };
}

export const docx = {
  id: 'docx',
  label: 'Word document (.docx)',
  extensions: ['.docx', '.docm', '.dotx'],
  async extract(buffer) {
    const zip = await loadZip(buffer);
    const xml = await zipText(zip, 'word/document.xml');
    if (!xml) throw new Error('Not a valid .docx file (word/document.xml missing)');
    const { pages, sawBreak } = parseDocumentXml(xml);
    const metadata = await ooxmlCoreProps(zip);
    if (sawBreak && pages.length > 1) {
      return { unit: 'page', pageSource: 'page-breaks', pages: pages.map((paragraphs) => ({ paragraphs })), metadata };
    }
    return { unit: 'page', paragraphs: pages.flat(), metadata };
  },
};

export const doc = {
  id: 'doc',
  label: 'Word 97-2003 document (.doc)',
  extensions: ['.doc', '.dot'],
  async extract(buffer) {
    const extracted = await new WordExtractor().extract(buffer);
    const body = extracted.getBody().replace(/\r\n?/g, '\n');
    // Form feeds in the body mark manual page breaks.
    const rawPages = body.split('\f');
    const toParas = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
    if (rawPages.length > 1) {
      return { unit: 'page', pageSource: 'page-breaks', pages: rawPages.map((s) => ({ paragraphs: toParas(s) })).filter((p) => p.paragraphs.length), metadata: {} };
    }
    return { unit: 'page', paragraphs: toParas(body), metadata: {} };
  },
};
