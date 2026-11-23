// Presentations: .pptx (each slide is a page, speaker notes included) and .odp.
import path from 'node:path';
import { byTrailingNumber, loadZip, odfMeta, ooxmlCoreProps, xmlText, zipText } from './util.js';

const drawingParagraphs = (xml) =>
  [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p\s[^>]*>([\s\S]*?)<\/a:p>/g)]
    .map((m) => [...(m[1] ?? m[2]).matchAll(/<a:t>([^<]*)<\/a:t>|<a:br\/>/g)]
      .map((t) => (t[0] === '<a:br/>' ? '\n' : xmlText(t[1]))).join('').trim())
    .filter(Boolean);

export const pptx = {
  id: 'pptx',
  label: 'PowerPoint presentation (.pptx)',
  extensions: ['.pptx', '.pptm', '.ppsx', '.potx'],
  async extract(buffer) {
    const zip = await loadZip(buffer);
    const slideFiles = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byTrailingNumber);
    // Slide order comes from presentation.xml (sldIdLst -> rels), falling back to file numbering.
    let ordered = slideFiles;
    const pres = await zipText(zip, 'ppt/presentation.xml');
    const presRels = await zipText(zip, 'ppt/_rels/presentation.xml.rels');
    if (pres && presRels) {
      const relTarget = Object.fromEntries([...presRels.matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
      const ids = [...pres.matchAll(/<p:sldId [^>]*r:id="([^"]+)"/g)].map((m) => relTarget[m[1]]).filter(Boolean);
      const fromPres = ids.map((t) => path.posix.normalize(path.posix.join('ppt', t))).filter((n) => zip.file(n));
      if (fromPres.length) ordered = fromPres;
    }
    const pages = [];
    for (const file of ordered) {
      const xml = await zipText(zip, file);
      const paragraphs = drawingParagraphs(xml);
      // Speaker notes via the slide's relationships.
      const rels = await zipText(zip, file.replace('slides/', 'slides/_rels/') + '.rels');
      const notesTarget = rels?.match(/Target="([^"]*notesSlide\d+\.xml)"/)?.[1];
      let notes = [];
      if (notesTarget) {
        const notesXml = await zipText(zip, path.posix.normalize(path.posix.join('ppt/slides', notesTarget)));
        // Skip the slide-number placeholder that every notes page has.
        if (notesXml) notes = drawingParagraphs(notesXml.replace(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?type="sldNum"[\s\S]*?<\/p:sp>/g, ''));
      }
      const label = paragraphs[0]?.slice(0, 80);
      pages.push({
        label,
        paragraphs: [...paragraphs, ...notes.map((n) => `[Notes] ${n}`)],
      });
    }
    return { unit: 'slide', pageSource: 'native', pages, metadata: await ooxmlCoreProps(zip) };
  },
};

// OpenDocument text paragraphs (shared with odt).
export const odfParagraphs = (xml) =>
  [...xml.matchAll(/<text:(p|h)\b[^>]*?(?:\/>|>([\s\S]*?)<\/text:\1>)/g)]
    .map((m) => xmlText((m[2] ?? '')
      .replace(/<text:tab\/>/g, '\t')
      .replace(/<text:line-break\/>/g, '\n')
      .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, n) => ' '.repeat(Number(n || 1)))).trim())
    .filter(Boolean);

export const odp = {
  id: 'odp',
  label: 'OpenDocument presentation (.odp)',
  extensions: ['.odp'],
  async extract(buffer) {
    const zip = await loadZip(buffer);
    const xml = await zipText(zip, 'content.xml');
    if (!xml) throw new Error('Not a valid OpenDocument file (content.xml missing)');
    const pages = [...xml.matchAll(/<draw:page\b([^>]*)>([\s\S]*?)<\/draw:page>/g)].map((m) => {
      const [main, notes = ''] = m[2].split(/<presentation:notes\b/);
      const paragraphs = odfParagraphs(main);
      return {
        label: paragraphs[0]?.slice(0, 80) || m[1].match(/draw:name="([^"]*)"/)?.[1],
        // Notes pages carry a "<number>" page-number placeholder; drop it.
        paragraphs: [...paragraphs, ...odfParagraphs(notes).filter((n) => n !== '<number>').map((n) => `[Notes] ${n}`)],
      };
    });
    return { unit: 'slide', pageSource: 'native', pages, metadata: await odfMeta(zip) };
  },
};
