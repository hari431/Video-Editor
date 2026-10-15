/**
 * Spreadsheet tool: inspect CSV/XLSX without dumping whole files to the model.
 * CSV is parsed directly; XLSX cells are extracted with a small dependency-free
 * reader (ZIP stored/deflated + shared/inline strings). Legacy .xls (BIFF)
 * has no reader and stays an honest capability note.
 */
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { readLibraryContent } from '../content-reader.js';
import { contentRouteForPath, resolveLibraryPath } from '../../library/local.js';

const MAX_ROWS = 30;
const MAX_CELL_CHARS = 200;
const MAX_CONTENT_CHARS = 4000;

function parseCsv(text) {
  const rows = [];
  let current = [];
  let field = '';
  let inQuotes = false;
  const push = () => { current.push(field); field = ''; };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') push();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      push();
      if (current.some(c => String(c).trim())) rows.push(current);
      current = [];
      if (rows.length >= MAX_ROWS) break;
    } else field += ch;
  }
  push();
  if (current.some(c => String(c).trim()) && rows.length < MAX_ROWS) rows.push(current);
  return rows.filter(r => r.length);
}

function formatRows(rows, query) {
  const q = String(query || '').toLowerCase();
  const scored = rows.map((row, index) => ({
    row,
    index,
    score: index === 0 ? 5 : row.filter(c => q && String(c).toLowerCase().includes(q)).length * 10
  }));
  const head = scored[0];
  const rest = scored.slice(1).sort((a, b) => b.score - a.score).slice(0, MAX_ROWS - 1);
  const picked = head ? [head, ...rest].sort((a, b) => a.index - b.index) : rest;
  return picked
    .map(({ row, index }) =>
      `${index === 0 ? 'header' : `row ${index}`}: ${row.map(c => String(c).slice(0, MAX_CELL_CHARS)).join(' | ')}`
    )
    .join('\n')
    .slice(0, MAX_CONTENT_CHARS);
}

export async function inspectSpreadsheet({ relPath, node = null, query = '' }) {
  const ext = String(relPath || '').toLowerCase().split('.').pop();
  const readable = await readLibraryContent(relPath, node);
  const text = String(readable.text || '');
  const title = String(relPath).split('/').at(-1) || relPath;
  const href = contentRouteForPath(relPath) + String(relPath).split('/').map(encodeURIComponent).join('/');

  if (ext === 'csv' || readable.meta?.extension === '.csv') {
    const rows = parseCsv(text);
    if (!rows.length) return { evidence: [], readable: false, error: 'empty' };
    return {
      readable: true,
      evidence: [{
        source: 'spreadsheet',
        title,
        path: relPath,
        href,
        content: `CSV preview (first ${Math.min(rows.length, MAX_ROWS)} of ${rows.length}+ rows):\n${formatRows(rows, query)}`,
        page: null,
        metadata: { ...readable.meta, rowsPreviewed: Math.min(rows.length, MAX_ROWS) }
      }]
    };
  }

  // XLSX: dependency-free cell extraction. Falls back to an honest note.
  if (ext === 'xlsx') {
    try {
      const rows = await readXlsxRows(relPath);
      if (!rows.length) return { evidence: [], readable: false, error: 'empty' };
      return {
        readable: true,
        evidence: [{
          source: 'spreadsheet',
          title,
          path: relPath,
          href,
          content: `XLSX preview (first ${Math.min(rows.length, MAX_ROWS)} of ${rows.length}+ rows):\n${formatRows(rows, query)}`,
          page: null,
          metadata: { type: 'spreadsheet', format: 'xlsx', rowsPreviewed: Math.min(rows.length, MAX_ROWS) }
        }]
      };
    } catch {
      return {
        readable: true,
        evidence: [{
          source: 'spreadsheet',
          title,
          path: relPath,
          href,
          content: `Spreadsheet file: ${title}. Luna could not parse its cells; only the file identity is available.`,
          page: null,
          metadata: { type: 'spreadsheet', format: 'xlsx', parsed: false }
        }]
      };
    }
  }

  // XLS and anything else: honest capability note, never a crash.
  return {
    readable: false,
    evidence: [{
      source: 'spreadsheet',
      title,
      path: relPath,
      href,
      content: `Spreadsheet file: ${title}. Cell-level reading is available for CSV and XLSX; this format can only be identified, not searched.`,
      page: null,
      metadata: { ...readable.meta, parsed: false }
    }]
  };
}

/* ---- Minimal XLSX reader (ZIP + sheet XML, stdlib only) ---- */

function unzipFiles(buffer) {
  let eocd = -1;
  const scanFrom = Math.max(0, buffer.length - 22 - 65536);
  for (let i = buffer.length - 22; i >= scanFrom; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive.');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Bad ZIP central directory.');
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Bad ZIP local header.');
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(dataStart, dataStart + compSize);
    // Sizes come from the central directory, so this also handles
    // entries written with a data descriptor.
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`Unsupported ZIP method ${method}.`);
    files.set(name, data);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function unescapeXml(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

function readSharedStrings(xml) {
  const items = xml.match(/<si>[\s\S]*?<\/si>/g) || [];
  return items.map(si => {
    const runs = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
    return unescapeXml(runs.map(run => run.replace(/^<t[^>]*>|<\/t>$/g, '')).join(''));
  });
}

function readSheetGrid(xml, shared) {
  const grid = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml)) && grid.length < MAX_ROWS) {
    const cells = [];
    const cellRe = /<c([^>]*?)\/>|<c([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const attrs = cellMatch[1] ?? cellMatch[2] ?? '';
      const inner = cellMatch[3] ?? '';
      const kind = /t="(\w+)"/.exec(attrs)?.[1];
      if (kind === 's') {
        const index = Number.parseInt((/<v>(\d+)<\/v>/.exec(inner) || [])[1] ?? '-1', 10);
        cells.push(shared[index] ?? '');
      } else if (kind === 'inlineStr') {
        const text = (/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner) || [])[1] ?? '';
        cells.push(unescapeXml(text));
      } else {
        cells.push(unescapeXml((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] ?? ''));
      }
    }
    if (cells.some(cell => String(cell).trim())) grid.push(cells);
  }
  return grid;
}

async function readXlsxRows(relPath) {
  const absPath = resolveLibraryPath(relPath);
  if (!absPath) throw new Error('Invalid library path.');
  const files = unzipFiles(await readFile(absPath));
  const shared = files.has('xl/sharedStrings.xml')
    ? readSharedStrings(files.get('xl/sharedStrings.xml').toString('utf8'))
    : [];
  const sheetName = [...files.keys()].find(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (!sheetName) throw new Error('No worksheet found.');
  return readSheetGrid(files.get(sheetName).toString('utf8'), shared);
}
