// Helpers shared by the extractors.
import JSZip from 'jszip';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Strip XML tags and decode entities. */
export const xmlText = (xml) => decodeEntities(xml.replace(/<[^>]+>/g, ''));

/** Split text into paragraphs on blank lines. Keeps line breaks inside a paragraph. */
export function splitParagraphs(text, { collapse = false } = {}) {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((p) => (collapse ? p.replace(/\s*\n\s*/g, ' ') : p.replace(/[ \t]+$/gm, '')).trim())
    .filter(Boolean);
}

export const loadZip = (buffer) => JSZip.loadAsync(buffer);

export async function zipText(zip, name) {
  const f = zip.file(name);
  return f ? f.async('string') : null;
}

/** Title / author etc. from OOXML docProps/core.xml (docx, xlsx, pptx). */
export async function ooxmlCoreProps(zip) {
  const xml = await zipText(zip, 'docProps/core.xml');
  if (!xml) return {};
  const pick = (tag) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return m ? xmlText(m[1]).trim() || undefined : undefined;
  };
  return {
    title: pick('dc:title'), author: pick('dc:creator'), subject: pick('dc:subject'),
    lastModifiedBy: pick('cp:lastModifiedBy'), createdAt: pick('dcterms:created'), modifiedAt: pick('dcterms:modified'),
  };
}

/** Title / author from ODF meta.xml (odt, odp, ods). */
export async function odfMeta(zip) {
  const xml = await zipText(zip, 'meta.xml');
  if (!xml) return {};
  const pick = (tag) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return m ? xmlText(m[1]).trim() || undefined : undefined;
  };
  return {
    title: pick('dc:title'), author: pick('meta:initial-creator') || pick('dc:creator'),
    subject: pick('dc:subject'), createdAt: pick('meta:creation-date'), modifiedAt: pick('dc:date'),
  };
}

/** Sort zip entry names like slide2.xml < slide10.xml. */
export const byTrailingNumber = (a, b) => Number(a.match(/(\d+)\.\w+$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.\w+$/)?.[1] ?? 0);
