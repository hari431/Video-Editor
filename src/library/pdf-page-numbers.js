// src/library/pdf-page-numbers.js — Standalone "Page Numbers" utility (admin-only).
//
// Separate from all other PDF tools: intentionally additive. REUSES the
// editor's limits, gate and allowlist helpers plus the split tool's strict
// page-selection parser, but never changes existing behavior. (The PDF Editor
// has its own numbering inside edit specs; this tool numbers any uploaded
// PDF directly.)
//
// Engine: pdf-lib (`drawText` with Helvetica-Bold on loaded pages) — already
// installed, no new dependency. Numbering is an addition: existing content
// streams are preserved, only new text is drawn.
//
// Semantics: pure + in-memory (no fs, no shell, no network, no binaries, no
// temp files). The input buffer is never mutated; output is a NEW pdf.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { parsePageSelection } from './pdf-split.js';
import {
  isPdfEditorAvailable,
  isAllowedPdfInput,
  pdfEditorMaxRequestBytes,
  PDF_EDITOR_MAX_FILE_BYTES,
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from './pdf-editor.js';

// Editor-consistent limits so routes/tests share one source.
export const PDF_NUMBERS_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_NUMBERS_MAX_FILE_MB = PDF_EDITOR_MAX_FILE_MB;
export const PDF_NUMBERS_MAX_PAGES = PDF_EDITOR_MAX_PAGES;
// A single job handles exactly one file; the editor's multi-file cap is
// intentionally NOT reused here (route enforces "exactly one").
export const PDF_NUMBERS_POSITIONS = [
  'top-left', 'top-center', 'top-right',
  'bottom-left', 'bottom-center', 'bottom-right'
];
export const PDF_NUMBERS_DEFAULT_POSITION = 'bottom-center';
export const PDF_NUMBERS_MIN_SIZE = 6;
export const PDF_NUMBERS_MAX_SIZE = 48;
export const PDF_NUMBERS_DEFAULT_SIZE = 11;
export const PDF_NUMBERS_MAX_START = 100000;
export const PDF_NUMBERS_MAX_PREFIX = 20;
export const PDF_NUMBERS_MARGIN = 36;

export function isPdfNumbersAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfNumbersMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate the single uploaded file (pure; { name, size }).
export function validatePdfNumbersUpload(file) {
  if (!file) return fail('Upload one PDF file to number.');
  if (!isAllowedPdfInput(String(file.name || ''))) {
    return fail(`"${String(file.name || 'unnamed').slice(0, 100)}" must be a .pdf file.`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return fail('PDF file is empty.');
  if (size > PDF_NUMBERS_MAX_FILE_BYTES) {
    return fail(`PDF file exceeds ${PDF_NUMBERS_MAX_FILE_MB} MB.`);
  }
  return { ok: true };
}

// Validate numbering options (pure).
export function validatePdfNumbersOptions(opts = {}) {
  const position = opts.position === undefined || opts.position === null || opts.position === ''
    ? PDF_NUMBERS_DEFAULT_POSITION : String(opts.position);
  if (!PDF_NUMBERS_POSITIONS.includes(position)) {
    return fail(`position must be one of: ${PDF_NUMBERS_POSITIONS.join(', ')}.`);
  }
  const startRaw = opts.start === undefined || opts.start === null || opts.start === '' ? 1 : Number(opts.start);
  if (!Number.isInteger(startRaw) || startRaw < 1 || startRaw > PDF_NUMBERS_MAX_START) {
    return fail(`start must be a whole number from 1 to ${PDF_NUMBERS_MAX_START}.`);
  }
  const sizeRaw = opts.fontSize === undefined || opts.fontSize === null || opts.fontSize === '' ? PDF_NUMBERS_DEFAULT_SIZE : Number(opts.fontSize);
  if (!Number.isFinite(sizeRaw) || sizeRaw < PDF_NUMBERS_MIN_SIZE || sizeRaw > PDF_NUMBERS_MAX_SIZE) {
    return fail(`fontSize must be between ${PDF_NUMBERS_MIN_SIZE} and ${PDF_NUMBERS_MAX_SIZE}pt.`);
  }
  const prefix = opts.prefix === undefined || opts.prefix === null ? '' : String(opts.prefix);
  if (prefix.length > PDF_NUMBERS_MAX_PREFIX || /[\r\n]/.test(prefix)) {
    return fail(`prefix must be a single line of at most ${PDF_NUMBERS_MAX_PREFIX} characters.`);
  }
  return { ok: true, options: { position, start: startRaw, fontSize: sizeRaw, prefix } };
}

// Build a safe download name `<original>-numbered.pdf` (pure).
export function numbersDownloadName(originalName) {
  let base = String(originalName || 'document.pdf').split(/[\\/]/).pop() || 'document.pdf';
  base = base.replace(/\.pdf$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'document';
  return `${base.slice(0, 80)}-numbered.pdf`;
}

// Stamp page numbers. `opts`: { position, start, fontSize, prefix,
// scope: 'all'|'range', selectionText }. Numbering counts across the selected
// pages in order (first selected page gets `start`). Resolves to Buffer.
// Throws user-friendly errors. Never mutates `pdfBytes`.
export async function addPageNumbers(pdfBytes, opts = {}) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  const checkedFile = validatePdfNumbersUpload({ name: 'document.pdf', size: bytes.length });
  if (!checkedFile.ok) throw new Error(checkedFile.error);
  const checkedOpts = validatePdfNumbersOptions(opts);
  if (!checkedOpts.ok) throw new Error(checkedOpts.error);
  const { position, start, fontSize, prefix } = checkedOpts.options;
  const scope = opts?.scope === 'range' ? 'range' : 'all';

  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (err) {
    if (/encrypted/i.test(err?.message || '')) {
      throw new Error('This PDF is password-protected. Unlock it before numbering.');
    }
    throw new Error('PDF could not be read (not a valid PDF, corrupt or unsupported).');
  }
  const pages = doc.getPages();
  if (pages.length > PDF_NUMBERS_MAX_PAGES) {
    throw new Error(`Source PDF has ${pages.length} pages (max ${PDF_NUMBERS_MAX_PAGES}).`);
  }
  let targets = pages.map((_, i) => i);
  if (scope === 'range') {
    const parsed = parsePageSelection(opts?.selectionText, pages.length);
    if (!parsed.ok) throw new Error(parsed.error);
    targets = parsed.pages;
  }

  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const color = rgb(0.2, 0.2, 0.2);
  targets.forEach((pi, k) => {
    const page = pages[pi];
    const { width: W, height: H } = page.getSize();
    const label = `${prefix}${start + k}`;
    const tw = font.widthOfTextAtSize(label, fontSize);
    const m = PDF_NUMBERS_MARGIN;
    let x = W / 2 - tw / 2;
    let y = m;
    if (position.startsWith('top-')) y = H - m - fontSize;
    if (position.endsWith('-right')) x = W - m - tw;
    else if (position.endsWith('-left')) x = m;
    page.drawText(label, { x, y, size: fontSize, font, color });
  });

  const out = await doc.save();
  if (!out || out.length === 0) throw new Error('Numbering produced no output.');
  return Buffer.from(out);
}
