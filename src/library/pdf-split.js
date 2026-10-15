// src/library/pdf-split.js — Standalone "Split PDF" utility (admin-only).
//
// Separate from the PDF Editor (pdf-editor.js), Merge PDFs (pdf-merge.js),
// Unlock PDF (pdf-unlock.js), Protect PDF (pdf-protect.js) and Compress PDF
// (pdf-compress.js): this module is intentionally additive. It REUSES the
// editor's limits, gate and allowlist helpers but never changes
// editor/merge/unlock/protect/compress behavior.
//
// Engine: `pdfstudio` (qpdf 12.3.2 compiled to WebAssembly, Apache-2.0) —
// `extractPages()` for page/range extraction and `split()` for every-N-pages
// and individual-page splitting. Both are structural qpdf operations, so
// pages, images, vectors, annotations, forms, fonts and metadata survive.
// Validated by an isolated spike (11/11 checks: order-preserving extraction,
// identical operator lists, annotations/widgets/metadata intact).
//
// Multi-file results are packed with a minimal dependency-free ZIP writer
// below (deflate via node:zlib, CRC-32 inline; verified against Python's
// zipfile) — no new dependency was needed.
//
// Semantics: pure + in-memory (qpdf runs in a WASM heap; no fs, no shell, no
// network, no binaries, no temp files). The input buffer is never mutated
// (the engine receives a defensive copy).

import { deflateRawSync } from 'node:zlib';
import { createPdfToolkit, PdfPasswordError } from 'pdfstudio';
import {
  isPdfEditorAvailable,
  isAllowedPdfInput,
  pdfEditorMaxRequestBytes,
  PDF_EDITOR_MAX_FILE_BYTES,
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from './pdf-editor.js';

// Editor-consistent limits so routes/tests share one source.
export const PDF_SPLIT_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_SPLIT_MAX_FILE_MB = PDF_EDITOR_MAX_FILE_MB;
export const PDF_SPLIT_MAX_PAGES = PDF_EDITOR_MAX_PAGES;
// A single split handles exactly one file; the editor's multi-file cap is
// intentionally NOT reused here (route enforces "exactly one").
export const PDF_SPLIT_MODES = ['extract', 'every', 'pages'];
export const PDF_SPLIT_DEFAULT_MODE = 'extract';
// Upper bound on pages pulled into one extraction (mirrors the page cap).
export const PDF_SPLIT_MAX_SELECTION = PDF_EDITOR_MAX_PAGES;

export function isPdfSplitAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfSplitMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate the single uploaded file (pure; { name, size }).
export function validatePdfSplitUpload(file) {
  if (!file) return fail('Upload one PDF file to split.');
  if (!isAllowedPdfInput(String(file.name || ''))) {
    return fail(`"${String(file.name || 'unnamed').slice(0, 100)}" must be a .pdf file.`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return fail('PDF file is empty.');
  if (size > PDF_SPLIT_MAX_FILE_BYTES) {
    return fail(`PDF file exceeds ${PDF_SPLIT_MAX_FILE_MB} MB.`);
  }
  return { ok: true };
}

export function validatePdfSplitMode(mode) {
  if (typeof mode !== 'string' || !PDF_SPLIT_MODES.includes(mode)) {
    return fail(`mode must be one of: ${PDF_SPLIT_MODES.join(', ')}.`);
  }
  return { ok: true, mode };
}

// Parse a 1-based page selection like "1-3,5,8-10" against a document with
// `pageCount` pages. Returns 0-based page numbers in the GIVEN order.
// Strict: empty tokens, non-numeric parts, reversed ranges, out-of-range
// pages and duplicates are all rejected with a specific message.
export function parsePageSelection(text, pageCount) {
  if (typeof text !== 'string' || text.trim() === '') {
    return fail('Enter pages to extract, e.g. 1-3,5,8-10.');
  }
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return fail('Invalid page count.');
  }
  const pages = [];
  const seen = new Set();
  const tokens = text.split(',');
  for (let ti = 0; ti < tokens.length; ti++) {
    const token = tokens[ti].trim();
    if (token === '') return fail(`Empty entry in pages (near comma ${ti + 1}).`);
    const range = token.split('-').map(s => s.trim());
    if (range.length > 2 || range.some(s => s === '')) {
      return fail(`Invalid pages entry "${token.slice(0, 40)}". Use numbers like 5 or ranges like 1-3.`);
    }
    const nums = [];
    for (const part of range) {
      if (!/^\d+$/.test(part)) {
        return fail(`Invalid page "${part.slice(0, 40)}" — pages are positive numbers.`);
      }
      nums.push(Number(part));
    }
    let from = nums[0];
    let to = nums.length === 2 ? nums[1] : nums[0];
    if (nums.length === 2 && to < from) {
      return fail(`Reversed range "${token.slice(0, 40)}" — write the lower page first.`);
    }
    for (let p = from; p <= to; p++) {
      if (p < 1 || p > pageCount) {
        return fail(`Page ${p} is out of range (this PDF has ${pageCount} pages).`);
      }
      if (seen.has(p)) return fail(`Duplicate page ${p} — list each page once.`);
      seen.add(p);
      pages.push(p - 1);
    }
    if (pages.length > PDF_SPLIT_MAX_SELECTION) {
      return fail(`Too many pages selected (max ${PDF_SPLIT_MAX_SELECTION}).`);
    }
  }
  if (pages.length === 0) return fail('Enter pages to extract, e.g. 1-3,5,8-10.');
  return { ok: true, pages };
}

// Validate the "every N pages" chunk size against the document.
export function validatePdfSplitEvery(value, pageCount) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1) {
    return fail('Every-N must be a positive whole number of pages.');
  }
  if (n > PDF_SPLIT_MAX_PAGES) {
    return fail(`Every-N must be at most ${PDF_SPLIT_MAX_PAGES}.`);
  }
  if (!Number.isInteger(pageCount) || pageCount < 1) return fail('Invalid page count.');
  return { ok: true, every: n };
}

// Canonical qpdf selection string for a validated 0-based page list
// (consecutive runs regrouped into ranges, 1-based for qpdf). The GIVEN order
// is preserved — qpdf keeps the requested page order, so sorting here would
// silently reorder the user's extraction.
export function toQpdfSelection(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return '';
  const parts = [];
  let start = pages[0];
  let prev = pages[0];
  for (let i = 1; i <= pages.length; i++) {
    if (i < pages.length && pages[i] === prev + 1) {
      prev = pages[i];
      continue;
    }
    parts.push(start === prev ? String(start + 1) : `${start + 1}-${prev + 1}`);
    if (i < pages.length) {
      start = pages[i];
      prev = pages[i];
    }
  }
  return parts.join(',');
}

// Chunk a 0-based page list into groups of N (order preserved).
export function chunkPages(pages, every) {
  const groups = [];
  for (let i = 0; i < pages.length; i += every) groups.push(pages.slice(i, i + every));
  return groups;
}

function sanitizeBase(originalName) {
  let base = String(originalName || 'document.pdf').split(/[\\/]/).pop() || 'document.pdf';
  base = base.replace(/\.pdf$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'document';
  return base.slice(0, 80);
}

function slugSelection(text) {
  return String(text || '')
    .replace(/\.pdf$/i, '')
    .replace(/[^0-9,\- ]/g, '')
    .trim()
    .replace(/[\s,]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'pages';
}

// Output filenames (pure, header-safe). `pad` zero-pads part numbers.
export function splitPartNames({ originalName, mode, selectionText, groups }) {
  const base = sanitizeBase(originalName);
  const pad = String(groups.length).length;
  if (mode === 'extract') {
    return [`${base}-pages-${slugSelection(selectionText)}.pdf`];
  }
  const kind = mode === 'every' ? 'part' : 'page';
  return groups.map((_, i) => `${base}-${kind}${String(i + 1).padStart(pad, '0')}.pdf`);
}

export function splitZipName(originalName) {
  return `${sanitizeBase(originalName)}-split.zip`;
}

// Minimal ZIP writer (pure, in-memory): deflate entries via node:zlib with
// inline CRC-32, UTF-8 names. Verified against Python's zipfile.
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

export function buildZip(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('Nothing to zip.');
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    if (typeof name !== 'string' || !name) throw new Error('ZIP entry needs a name.');
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (bytes.length === 0) throw new Error(`ZIP entry "${name}" is empty.`);
    const nameB = Buffer.from(encoder.encode(name));
    const deflated = Buffer.from(deflateRawSync(bytes, { level: 6 }));
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameB, deflated);
    const cent = Buffer.alloc(46);
    cent.writeUInt32LE(0x02014b50, 0);
    cent.writeUInt16LE(20, 4);
    cent.writeUInt16LE(20, 6);
    cent.writeUInt16LE(0x0800, 8);
    cent.writeUInt16LE(8, 10);
    cent.writeUInt16LE(0, 12);
    cent.writeUInt16LE(0, 14);
    cent.writeUInt32LE(crc, 16);
    cent.writeUInt32LE(deflated.length, 20);
    cent.writeUInt32LE(bytes.length, 24);
    cent.writeUInt16LE(nameB.length, 28);
    cent.writeUInt16LE(0, 30);
    cent.writeUInt16LE(0, 32);
    cent.writeUInt16LE(0, 34);
    cent.writeUInt16LE(0, 36);
    cent.writeUInt32LE(0, 38);
    cent.writeUInt32LE(offset, 42);
    central.push(cent, nameB);
    offset += local.length + nameB.length + deflated.length;
  }
  const centralSize = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
}

// Lazily compiled qpdf-WASM toolkit, shared across calls. Staging happens in
// the WASM in-memory filesystem; nothing touches disk.
let toolkitPromise = null;
function getToolkit() {
  if (!toolkitPromise) toolkitPromise = createPdfToolkit();
  return toolkitPromise;
}

function isPasswordError(err) {
  return !!err && (err instanceof PdfPasswordError || err?.name === 'PdfPasswordError');
}

// Split an upload. `opts`: { mode: 'extract'|'every'|'pages',
// selectionText (extract only), every (every mode only) }.
// Resolves to `{ parts: [{ bytes: Buffer, pages: [0-based...] }], mode }`.
// Throws Error with a user-friendly message on any failure. Never mutates
// `pdfBytes`. Encrypted inputs are rejected (unlock first — no password is
// collected here).
export async function splitPdf(pdfBytes, opts = {}) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  const checkedFile = validatePdfSplitUpload({ name: 'document.pdf', size: bytes.length });
  if (!checkedFile.ok) throw new Error(checkedFile.error);
  const mode = opts?.mode;
  const checkedMode = validatePdfSplitMode(mode);
  if (!checkedMode.ok) throw new Error(checkedMode.error);

  // Defensive copy: the engine stages bytes into its own memory.
  const data = new Uint8Array(bytes.length);
  data.set(bytes);

  const toolkit = await getToolkit();

  // Pre-inspection doubles as readability validation (garbage/corrupt files
  // fail here), already-encrypted detection, and page-count enforcement.
  let info;
  try {
    info = await toolkit.getInfo(data);
  } catch (err) {
    if (isPasswordError(err)) {
      throw new Error('This PDF is password-protected. Unlock it before splitting.');
    }
    throw new Error('PDF could not be read (not a valid PDF, corrupt or unsupported).');
  }
  if (info?.encrypted) {
    throw new Error('This PDF is password-protected. Unlock it before splitting.');
  }
  const numPages = info?.pageCount;
  if (!Number.isFinite(numPages) || numPages < 1) {
    throw new Error('Source PDF contains no pages.');
  }
  if (numPages > PDF_SPLIT_MAX_PAGES) {
    throw new Error(`Source PDF has ${numPages} pages (max ${PDF_SPLIT_MAX_PAGES}).`);
  }

  let groups;
  if (mode === 'extract') {
    const parsed = parsePageSelection(opts?.selectionText, numPages);
    if (!parsed.ok) throw new Error(parsed.error);
    groups = [parsed.pages];
  } else if (mode === 'every') {
    const checked = validatePdfSplitEvery(opts?.every, numPages);
    if (!checked.ok) throw new Error(checked.error);
    groups = chunkPages(Array.from({ length: numPages }, (_, i) => i), checked.every);
  } else {
    groups = chunkPages(Array.from({ length: numPages }, (_, i) => i), 1);
  }

  const parts = [];
  try {
    if (mode === 'extract') {
      const out = await toolkit.extractPages(data, { pages: toQpdfSelection(groups[0]) });
      if (!out || out.length === 0) throw new Error('Split produced no output.');
      parts.push({ bytes: Buffer.from(out), pages: groups[0] });
    } else {
      const per = mode === 'every'
        ? validatePdfSplitEvery(opts?.every, numPages).every
        : 1;
      const outParts = await toolkit.split(data, { pagesPerFile: per });
      if (!Array.isArray(outParts) || outParts.length !== groups.length) {
        throw new Error('Split produced an unexpected number of files.');
      }
      for (let i = 0; i < outParts.length; i++) {
        if (!outParts[i] || outParts[i].length === 0) throw new Error('Split produced no output.');
        parts.push({ bytes: Buffer.from(outParts[i]), pages: groups[i] });
      }
    }
  } catch (err) {
    if (err?.message === 'Split produced no output.' ||
        err?.message === 'Split produced an unexpected number of files.') throw err;
    throw new Error('Unable to split PDF.');
  }
  return { parts, mode };
}
