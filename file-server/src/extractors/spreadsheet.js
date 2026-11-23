// Spreadsheets: xlsx, xlsm, xls, ods, csv, tsv. Each sheet is a "page"; each non-empty row is a "paragraph".
import * as XLSX from 'xlsx';

export default {
  id: 'spreadsheet',
  label: 'Spreadsheet (Excel, OpenDocument, CSV/TSV)',
  extensions: ['.xlsx', '.xlsm', '.xlsb', '.xls', '.ods', '.csv', '.tsv'],
  async extract(buffer, { ext }) {
    const opts = { type: 'buffer', cellDates: true, dense: true };
    if (ext === '.tsv') opts.FS = '\t';
    if (ext === '.csv' || ext === '.tsv') opts.raw = false; // keep text cells as written
    const wb = XLSX.read(buffer, opts);
    const sheets = [];
    const pages = wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false })
        .map((r) => r.map((v) => String(v).trim()))
        .filter((r) => r.some(Boolean));
      const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
      sheets.push({ name, rows: rows.length, columns, range: ws['!ref'] ?? null });
      return {
        label: name,
        paragraphs: rows.map((r) => r.join(' | ')),
        text: rows.map((r) => r.join('\t')).join('\n'),
      };
    });
    const p = wb.Props ?? {};
    return {
      unit: 'sheet',
      pageSource: 'native',
      pages,
      metadata: { title: p.Title, author: p.Author, lastModifiedBy: p.LastAuthor, sheets },
    };
  },
};
