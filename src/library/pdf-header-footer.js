// src/library/pdf-header-footer.js — Standalone "Header/Footer" utility (admin-only).
//
// Separate from all other PDF tools: intentionally additive. REUSES the
// editor's limits, gate and allowlist helpers plus the split tool's strict
// page-selection parser, but never changes existing behavior.
//
// Engine: pdf-lib (`drawText` with Helvetica on loaded pages) — already
// installed, no new dependency. Headers/footers are additions: existing
// content streams are preserved, only new text is drawn. `{page}` expands to
// the document page number and `{total}` to the document page count.
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
export const PDF_HEADER_FOOTER_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_HEADER_FOOTER_MAX_FILE_MB = PDF_EDITOR_MAX_FILE_MB;
export const PDF_HEADER_FOOTER_MAX_PAGES = PDF_EDITOR_MAX_PAGES;
// A single job handles exactly one file; the editor's multi-file cap is
// intentionally NOT reused here (route enforces "exactly one").
export const PDF_HEADER_FOOTER_ALIGNS = ['left', 'center', 'right'];
export const PDF_HEADER_FOOTER_DEFAULT_ALIGN = 'center';
export const PDF_HEADER_FOOTER_MIN_SIZE = 6;
export const PDF_HEADER_FOOTER_MAX_SIZE = 48;
export const PDF_HEADER_FOOTER_DEFAULT_SIZE = 10;
export const PDF_HEADER_FOOTER_MAX_TEXT = 200;
export const PDF_HEADER_FOOTER_MARGIN = 36;

export function isPdfHeaderFooterAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfHeaderFooterMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate the single uploaded file (pure; { name, size }).
export function validatePdfHeaderFooterUpload(file) {
  if (!file) return fail('Upload one PDF file for headers/footers.');
  if (!isAllowedPdfInput(String(file.name || ''))) {
    return fail(`"${String(file.name || 'unnamed').slice(0, 100)}" must be a .pdf file.`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return fail('PDF file is empty.');
  if (size > PDF_HEADER_FOOTER_MAX_FILE_BYTES) {
    return fail(`PDF file exceeds ${PDF_HEADER_FOOTER_MAX_FILE_MB} MB.`);
  }
  return { ok: true };
}

function checkLine(value, label) {
  const text = value === undefined || value === null ? '' : String(value);
  if (text.length > PDF_HEADER_FOOTER_MAX_TEXT || /[\r\n]/.test(text)) {
    return { error: `${label} must be a single line of at most ${PDF_HEADER_FOOTER_MAX_TEXT} characters.` };
  }
  return { text };
}

// Validate header/footer options (pure). At least one of header/footer must
// be non-empty. `{page}` and `{total}` tokens are allowed.
export function validatePdfHeaderFooterOptions(opts = {}) {
  const header = checkLine(opts.header, 'header');
  if (header.error) return fail(header.error);
  const footer = checkLine(opts.footer, 'footer');
  if (footer.error) return fail(footer.error);
  if (!header.text && !footer.text) {
    return fail('Enter header text, footer text, or both.');
  }
  const align = opts.align === undefined || opts.align === null || opts.align === ''
    ? PDF_HEADER_FOOTER_DEFAULT_ALIGN : String(opts.align);
  if (!PDF_HEADER_FOOTER_ALIGNS.includes(align)) {
    return fail(`align must be one of: ${PDF_HEADER_FOOTER_ALIGNS.join(', ')}.`);
  }
  const sizeRaw = opts.fontSize === undefined || opts.fontSize === null || opts.fontSize === '' ? PDF_HEADER_FOOTER_DEFAULT_SIZE : Number(opts.fontSize);
  if (!Number.isFinite(sizeRaw) || sizeRaw < PDF_HEADER_FOOTER_MIN_SIZE || sizeRaw > PDF_HEADER_FOOTER_MAX_SIZE) {
    return fail(`fontSize must be between ${PDF_HEADER_FOOTER_MIN_SIZE} and ${PDF_HEADER_FOOTER_MAX_SIZE}pt.`);
  }
  return { ok: true, options: { header: header.text, footer: footer.text, align, fontSize: sizeRaw } };
}

// Expand {page} and {total} tokens (pure).
export function expandHeaderFooterTokens(text, page, total) {
  return String(text).split('{page}').join(String(page)).split('{total}').join(String(total));
}

// Build a safe download name `<original>-header-footer.pdf` (pure).
export function headerFooterDownloadName(originalName) {
  let base = String(originalName || 'document.pdf').split(/[\\/]/).pop() || 'document.pdf';
  base = base.replace(/\.pdf$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'document';
  return `${base.slice(0, 80)}-header-footer.pdf`;
}

// Stamp headers/footers. `opts`: { header, footer, align, fontSize,
// scope: 'all'|'range', selectionText }. Resolves to Buffer. Throws
// user-friendly errors. Never mutates `pdfBytes`.
export async function addHeaderFooter(pdfBytes, opts = {}) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  const checkedFile = validatePdfHeaderFooterUpload({ name: 'document.pdf', size: bytes.length });
  if (!checkedFile.ok) throw new Error(checkedFile.error);
  const checkedOpts = validatePdfHeaderFooterOptions(opts);
  if (!checkedOpts.ok) throw new Error(checkedOpts.error);
  const { header, footer, align, fontSize } = checkedOpts.options;
  const scope = opts?.scope === 'range' ? 'range' : 'all';

  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (err) {
    if (/encrypted/i.test(err?.message || '')) {
      throw new Error('This PDF is password-protected. Unlock it first.');
    }
    throw new Error('PDF could not be read (not a valid PDF, corrupt or unsupported).');
  }
  const pages = doc.getPages();
  if (pages.length > PDF_HEADER_FOOTER_MAX_PAGES) {
    throw new Error(`Source PDF has ${pages.length} pages (max ${PDF_HEADER_FOOTER_MAX_PAGES}).`);
  }
  let targets = pages.map((_, i) => i);
  if (scope === 'range') {
    const parsed = parsePageSelection(opts?.selectionText, pages.length);
    if (!parsed.ok) throw new Error(parsed.error);
    targets = parsed.pages;
  }

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const color = rgb(0.25, 0.25, 0.25);
  const m = PDF_HEADER_FOOTER_MARGIN;
  const drawLine = (page, text, y) => {
    const { width: W } = page.getSize();
    const tw = font.widthOfTextAtSize(text, fontSize);
    let x = m;
    if (align === 'center') x = W / 2 - tw / 2;
    else if (align === 'right') x = W - m - tw;
    page.drawText(text, { x, y, size: fontSize, font, color });
  };
  for (const pi of targets) {
    const page = pages[pi];
    const { height: H } = page.getSize();
    if (header) drawLine(page, expandHeaderFooterTokens(header, pi + 1, pages.length), H - m - fontSize);
    if (footer) drawLine(page, expandHeaderFooterTokens(footer, pi + 1, pages.length), m);
  }

  const out = await doc.save();
  if (!out || out.length === 0) throw new Error('Header/footer produced no output.');
  return Buffer.from(out);
}
