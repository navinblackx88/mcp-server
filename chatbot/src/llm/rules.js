// Offline fallback "provider": no LLM, just keyword rules that map common requests to
// one tool call and format the result. Lets the chatbot run with no API key. Real
// understanding (follow-ups, summaries, multi-step reasoning) needs an LLM provider.

const RANGE = String.raw`(\d+(?:\s*(?:-|–|to|and|,|&)\s*\d+)*)`;
const normRange = (s) => s.replace(/\s*(?:to|–)\s*/g, '-').replace(/\s*(?:and|&)\s*/g, ',').replace(/\s+/g, '');

function findPath(text) {
  const quoted = text.match(/["'`]([^"'`]+)["'`]/);
  if (quoted) return quoted[1];
  const withExt = text.match(/(?:~|\.{1,2}|[A-Za-z]:)?[\w.\-~/\\]*[\w\-]\.[A-Za-z0-9]{1,6}(?=$|[\s,?!;:)]|\.(?:\s|$))/);
  if (withExt) return withExt[0];
  const pathLike = text.match(/(?:~|\/|[A-Za-z]:\\)[\w.\-~/\\]+/);
  return pathLike?.[0];
}

const isFile = (p) => p && /\.[A-Za-z0-9]{1,6}$/.test(p);

/** Map one message to { name, args } or null. */
export function parseIntent(text) {
  const t = text.trim();
  const lower = t.toLowerCase();
  const target = findPath(t);

  const search = t.match(/\b(?:search|find|look|grep)\b\s+(?:for\s+)?["']?(.+?)["']?\s+in\s+(.+?)\s*[?.!]*$/i)
    || t.match(/\b(?:search|find|look|grep)\b\s+(?:for\s+)?["']?(.+?)["']?\s*[?.!]*$/i);
  if (search && !/\bfiles?\b\s*$/i.test(search[1])) {
    const query = search[1].replace(/^(the\s+)?(word|phrase|term)\s+/i, '');
    const where = search[2] ? findPath(search[2]) ?? search[2].trim() : undefined;
    if (where && isFile(where)) return { name: 'search_file', args: { path: where, query } };
    return { name: 'search_directory', args: { query, recursive: true, ...(where && !/^(all|every|my)\b/i.test(where) ? { dir: where } : {}) } };
  }

  if (/\b(formats?|supported|allowed|roots?|which folders|what folders|can you read)\b/.test(lower) && !isFile(target)) {
    return { name: 'get_server_info', args: {} };
  }

  if (!isFile(target) && /\b(list|show|what|which)\b.*\b(files?|folders?|directory|documents?|contents)\b|\bls\b/.test(lower)) {
    // "list files in office" → dir "office" (a bare folder name after in/inside/under/from)
    const dir = target ?? t.match(/\b(?:in|inside|under|from)\s+(?:the\s+)?["']?([\w.~/\\:-]+?)["']?(?:\s+folder)?\s*[?.!]*$/i)?.[1];
    return { name: 'list_files', args: { ...(dir && !/^(all|my|every)$/i.test(dir) ? { dir } : {}), recursive: /\b(all|every|recursive|subfolders?|everything)\b/.test(lower) } };
  }

  if (!target) return null;

  const pages = lower.match(new RegExp(String.raw`\b(?:pages?|sheets?|slides?|chapters?)\s+${RANGE}`));
  const paras = lower.match(new RegExp(String.raw`\b(?:paragraphs?|paras?|rows?|¶)\s*${RANGE}`));
  if (pages) return { name: 'extract_text', args: { path: target, pages: normRange(pages[1]) } };
  if (paras) return { name: 'extract_text', args: { path: target, paragraphs: normRange(paras[1]) } };
  const first = lower.match(/\bfirst\s+(page|sheet|slide|chapter|paragraph|row)\b/);
  if (first) return { name: 'extract_text', args: { path: target, [/paragraph|row/.test(first[1]) ? 'paragraphs' : 'pages']: '1' } };

  if (/\b(details?|info|information|metadata|how many|size|author|title|pages?\b.*\bhave|properties|stats?)\b/.test(lower)) {
    return { name: 'get_file_details', args: { path: target } };
  }
  return { name: 'extract_text', args: { path: target, maxChars: 4000 } };
}

const UNIT = { page: 'Page', sheet: 'Sheet', slide: 'Slide', chapter: 'Chapter' };
const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

function format(name, ok, text) {
  if (!ok) return `Sorry, that didn't work: ${text}`;
  let d;
  try { d = JSON.parse(text); } catch { return text; }
  switch (name) {
    case 'get_server_info':
      return `I can read files in:\n${d.roots.map((r) => `- \`${r}\``).join('\n') || '- any folder'}\n\nRelative paths start from \`${d.defaultDir}\`.\n\n**Formats:** ${d.formats.supported.map((f) => f.label).join('; ')}.`;
    case 'list_files': {
      const files = d.entries.filter((e) => e.kind === 'file');
      const dirs = d.entries.filter((e) => e.kind === 'directory');
      if (!d.entries.length) return `\`${d.dir}\` is empty.`;
      const rel = (p) => p.slice(d.dir.length + 1) || p;
      return `**${d.dir}** — ${files.length} file(s)${dirs.length ? `, ${dirs.length} folder(s)` : ''}:\n\n| File | Format | Size |\n|---|---|---|\n` +
        files.map((f) => `| ${rel(f.path)} | ${f.format} | ${kb(f.sizeBytes)} |`).join('\n') +
        (dirs.length && !d.recursive ? `\n\nFolders: ${dirs.map((x) => rel(x.path) + '/').join(', ')}` : '');
    }
    case 'get_file_details': {
      if (!d.supported) return `**${d.name}** (${kb(d.sizeBytes)}) can't be read: ${d.reason}`;
      const u = UNIT[d.unit];
      const meta = Object.entries(d.metadata ?? {}).filter(([k]) => k !== 'sheets').map(([k, v]) => `${k}: ${v}`).join(', ');
      return `**${d.name}** is a ${d.formatLabel}, ${kb(d.sizeBytes)}.\n\n- ${d.pageCount} ${u.toLowerCase()}(s)${d.pageSource === 'virtual' ? ' (virtual pages)' : ''}` +
        (d.pageLabels ? `: ${d.pageLabels.filter(Boolean).join(', ')}` : '') +
        `\n- ${d.paragraphCount} paragraph(s), ${d.wordCount} words\n- Modified ${new Date(d.modified).toLocaleString()}` +
        (meta ? `\n- ${meta}` : '');
    }
    case 'extract_text': {
      const name = d.path.split(/[\\/]/).pop();
      const u = UNIT[d.unit];
      const body = d.sections
        ? d.sections.map((s) => `**${s.paragraph ? `Paragraph ${s.paragraph} (${u.toLowerCase()} ${s.page})` : `${u} ${s.page}${s.label ? `: ${s.label}` : ''}`}**\n\n${s.text}`).join('\n\n')
        : d.text;
      return `From **${name}**:\n\n${body}${d.truncated ? '\n\n_(truncated — ask for specific pages or paragraphs)_' : ''}`;
    }
    case 'search_file':
      return d.matchCount
        ? `Found "${d.query}" ${d.matchCount} time(s):\n\n${d.matches.map((m) => `- ${UNIT[d.unit]} ${m.page}, paragraph ${m.paragraph}: ${m.snippet}`).join('\n')}`
        : `No matches for "${d.query}".`;
    case 'search_directory':
      return d.matchCount
        ? `Found "${d.query}" in ${d.filesMatched} file(s):\n\n${d.results.map((r) => r.matches.map((m) => `- **${r.path.split(/[\\/]/).pop()}** — ${UNIT[r.unit]} ${m.page}: ${m.snippet}`).join('\n')).join('\n')}`
        : `No matches for "${d.query}" in ${d.filesScanned} file(s) under \`${d.dir}\`.`;
    default:
      return '```json\n' + JSON.stringify(d, null, 2) + '\n```';
  }
}

export const HELP = `I'm running in **offline rules mode** (no LLM configured), so I understand simple requests like:

- "what formats can you read?"
- "list all files"
- "show details of report.pdf"
- "read page 2 of report.pdf" · "show sheet 2 of office/budget.xlsx" · "paragraphs 1-3 of ~/notes.txt"
- "search for battery" · "find Pune in office/budget.xlsx"

For real conversation, summaries and follow-up questions, set \`ANTHROPIC_API_KEY\` or \`OPENAI_API_KEY\`, or run a local model with \`LLM_PROVIDER=ollama\`.`;

export class RulesProvider {
  constructor() {
    this.name = 'rules';
    this.model = 'keyword-rules';
    this.counter = 0;
  }

  userMessage(text) { return { role: 'user', content: text }; }

  isTurnStart(msg) { return msg.role === 'user'; }

  async step({ messages }) {
    const last = messages.at(-1);
    if (last.role === 'tool') {
      const results = [];
      for (let i = messages.length - 1; i >= 0 && messages[i].role === 'tool'; i--) results.unshift(messages[i]);
      const text = results.map((r) => format(r.name, r.ok, r.text)).join('\n\n');
      return { text, toolCalls: [], assistantMessage: { role: 'assistant', content: text } };
    }
    const intent = parseIntent(last.content);
    if (!intent) return { text: HELP, toolCalls: [], assistantMessage: { role: 'assistant', content: HELP } };
    const call = { id: `call_${++this.counter}`, ...intent };
    return { text: '', toolCalls: [{ id: call.id, name: call.name, args: call.args }], assistantMessage: { role: 'assistant', content: '', toolCalls: [call] } };
  }

  toolResultMessages(results) {
    return results.map((r) => ({ role: 'tool', id: r.id, name: r.name, ok: r.ok, text: r.text }));
  }
}
