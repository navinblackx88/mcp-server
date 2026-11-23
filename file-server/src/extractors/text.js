// Plain text and source/config files, with encoding detection.
import chardet from 'chardet';
import iconv from 'iconv-lite';
import { splitParagraphs } from './util.js';

export const TEXT_EXTENSIONS = [
  '.txt', '.text', '.md', '.markdown', '.rst', '.adoc', '.log', '.json', '.jsonl', '.ndjson', '.xml', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.env', '.properties', '.sql', '.graphql', '.srt', '.vtt', '.tex', '.bib',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.java', '.kt', '.go', '.rs', '.rb', '.php', '.c', '.h',
  '.cpp', '.hpp', '.cs', '.swift', '.scala', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.css', '.scss', '.less',
  '.vue', '.svelte', '.dockerfile', '.gitignore', '.svg',
];

/** Decode bytes: honours BOMs, otherwise UTF-8, otherwise a guessed encoding. Returns { text, encoding }. */
export function decodeWithEncoding(buffer) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return { text: buffer.subarray(3).toString('utf8'), encoding: 'UTF-8 (BOM)' };
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return { text: iconv.decode(buffer.subarray(2), 'utf16le'), encoding: 'UTF-16LE' };
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return { text: iconv.decode(buffer.subarray(2), 'utf16be'), encoding: 'UTF-16BE' };
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) return { text: utf8, encoding: 'UTF-8' };
  const guess = chardet.detect(buffer.subarray(0, 64 * 1024));
  return guess && iconv.encodingExists(guess) ? { text: iconv.decode(buffer, guess), encoding: guess } : { text: utf8, encoding: 'UTF-8 (with invalid bytes)' };
}

export const decodeText = (buffer) => decodeWithEncoding(buffer).text;

/** Heuristic: does this look like text rather than binary? */
export function looksLikeText(buffer) {
  const sample = buffer.subarray(0, 8192);
  if (sample.length === 0) return true;
  if ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff)) return true;
  let suspicious = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) suspicious++;
  }
  return suspicious / sample.length < 0.05;
}

export default {
  id: 'text',
  label: 'Plain text, Markdown, JSON, XML, code and config files',
  extensions: TEXT_EXTENSIONS,
  async extract(buffer) {
    const { text: raw, encoding } = decodeWithEncoding(buffer);
    const text = raw.replace(/\r\n?/g, '\n');
    const lineCount = text.split('\n').length;
    if (text.includes('\f')) {
      return {
        unit: 'page',
        pageSource: 'form-feed',
        pages: text.split('\f').map((t) => ({ text: t.trim(), paragraphs: splitParagraphs(t) })),
        metadata: { encoding, lineCount },
      };
    }
    return { unit: 'page', paragraphs: splitParagraphs(text), metadata: { encoding, lineCount } };
  },
};
