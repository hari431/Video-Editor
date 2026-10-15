// src/library/pdf-watermark.js — Standalone "Watermark PDF" utility (admin-only).
//
// Separate from all other PDF tools: intentionally additive. REUSES the
// editor's limits, gate, allowlist and color helpers plus the split tool's
// strict page-selection parser, but never changes existing behavior. (The PDF
// Editor has its own watermark inside edit specs; this tool stamps any
// uploaded PDF directly.)
//
// Engine: pdf-lib (`drawText` with rotation + opacity on loaded pages) —
// already installed, no new dependency. The watermark is an addition drawn
// over the page: underlying content streams are preserved byte-for-byte, only
// new text is drawn.
//
// Semantics: pure + in-memory (no fs, no shell, no network, no binaries, no
// temp files). The input buffer is never mutated; output is a NEW pdf.

import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { parsePageSelection } from './pdf-split.js';
import {
  isPdfEditorAvailable,
  isAllowedPdfInput,
  normalizePdfColor,
  pdfEditorMaxRequestBytes,
  PDF_EDITOR_MAX_FILE_BYTES,
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from './pdf-editor.js';

// Editor-consistent limits so routes/tests share one source.
export const PDF_WATERMARK_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_WATERMARK_MAX_FILE_MB = PDF_EDITOR_MAX_FILE_MB;
export const PDF_WATERMARK_MAX_PAGES = PDF_EDITOR_MAX_PAGES;
// A single job handles exactly one file; the editor's multi-file cap is
// intentionally NOT reused here (route enforces "exactly one").
export const PDF_WATERMARK_POSITIONS = ['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
export const PDF_WATERMARK_DEFAULT_POSITION = 'center';
export const PDF_WATERMARK_MIN_SIZE = 12;
export const PDF_WATERMARK_MAX_SIZE = 200;
export const PDF_WATERMARK_DEFAULT_SIZE = 64;
export const PDF_WATERMARK_MAX_TEXT = 200;
export const PDF_WATERMARK_DEFAULT_OPACITY = 0.25;
export const PDF_WATERMARK_DEFAULT_ANGLE = -45;
export const PDF_WATERMARK_DEFAULT_COLOR = '#888888';

export function isPdfWatermarkAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfWatermarkMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate the single uploaded file (pure; { name, size }).
export function validatePdfWatermarkUpload(file) {
  if (!file) return fail('Upload one PDF file to watermark.');
  if (!isAllowedPdfInput(String(file.name || ''))) {
    return fail(`"${String(file.name || 'unnamed').slice(0, 100)}" must be a .pdf file.`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return fail('PDF file is empty.');
  if (size > PDF_WATERMARK_MAX_FILE_BYTES) {
    return fail(`PDF file exceeds ${PDF_WATERMARK_MAX_FILE_MB} MB.`);
  }
  return { ok: true };
}

// Validate watermark options (pure).
export function validatePdfWatermarkOptions(opts = {}) {
  const text = typeof opts.text === 'string' ? opts.text.trim() : '';
  if (!text || text.length > PDF_WATERMARK_MAX_TEXT || /[\r\n]/.test(text)) {
    return fail(`text must be a single line of 1–${PDF_WATERMARK_MAX_TEXT} characters.`);
  }
  const position = opts.position === undefined || opts.position === null || opts.position === ''
    ? PDF_WATERMARK_DEFAULT_POSITION : String(opts.position);
  if (!PDF_WATERMARK_POSITIONS.includes(position)) {
    return fail(`position must be one of: ${PDF_WATERMARK_POSITIONS.join(', ')}.`);
  }
  const fontSize = opts.fontSize === undefined || opts.fontSize === null || opts.fontSize === ''
    ? PDF_WATERMARK_DEFAULT_SIZE : Number(opts.fontSize);
  if (!Number.isFinite(fontSize) || fontSize < PDF_WATERMARK_MIN_SIZE || fontSize > PDF_WATERMARK_MAX_SIZE) {
    return fail(`fontSize must be between ${PDF_WATERMARK_MIN_SIZE} and ${PDF_WATERMARK_MAX_SIZE}pt.`);
  }
  const color = normalizePdfColor(opts.color === undefined || opts.color === null || opts.color === ''
    ? PDF_WATERMARK_DEFAULT_COLOR : opts.color);
  if (!color) return fail('color must be #RGB or #RRGGBB.');
  const opacity = opts.opacity === undefined || opts.opacity === null || opts.opacity === ''
    ? PDF_WATERMARK_DEFAULT_OPACITY : Number(opts.opacity);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    return fail('opacity must be between 0 and 1.');
  }
  const angle = opts.angle === undefined || opts.angle === null || opts.angle === ''
    ? PDF_WATERMARK_DEFAULT_ANGLE : Number(opts.angle);
  if (!Number.isFinite(angle) || angle < -90 || angle > 90) {
    return fail('angle must be between -90 and 90 degrees.');
  }
  return { ok: true, options: { text, position, fontSize, color, opacity, angle } };
}

function hexToRgb01(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return rgb(r, g, b);
}

// Build a safe download name `<original>-watermarked.pdf` (pure).
export function watermarkDownloadName(originalName) {
  let base = String(originalName || 'document.pdf').split(/[\\/]/).pop() || 'document.pdf';
  base = base.replace(/\.pdf$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'document';
  return `${base.slice(0, 80)}-watermarked.pdf`;
}

// Stamp a text watermark. `opts`: { text, position, fontSize, color,
// opacity, angle, scope: 'all'|'range', selectionText }. Resolves to Buffer.
// Throws user-friendly errors. Never mutates `pdfBytes`.
export async function addWatermark(pdfBytes, opts = {}) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  const checkedFile = validatePdfWatermarkUpload({ name: 'document.pdf', size: bytes.length });
  if (!checkedFile.ok) throw new Error(checkedFile.error);
  const checkedOpts = validatePdfWatermarkOptions(opts);
  if (!checkedOpts.ok) throw new Error(checkedOpts.error);
  const { text, position, fontSize, color, opacity, angle } = checkedOpts.options;
  const scope = opts?.scope === 'range' ? 'range' : 'all';

  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (err) {
    if (/encrypted/i.test(err?.message || '')) {
      throw new Error('This PDF is password-protected. Unlock it before watermarking.');
    }
    throw new Error('PDF could not be read (not a valid PDF, corrupt or unsupported).');
  }
  const pages = doc.getPages();
  if (pages.length > PDF_WATERMARK_MAX_PAGES) {
    throw new Error(`Source PDF has ${pages.length} pages (max ${PDF_WATERMARK_MAX_PAGES}).`);
  }
  let targets = pages.map((_, i) => i);
  if (scope === 'range') {
    const parsed = parsePageSelection(opts?.selectionText, pages.length);
    if (!parsed.ok) throw new Error(parsed.error);
    targets = parsed.pages;
  }

  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const fill = hexToRgb01(color);
  for (const pi of targets) {
    const page = pages[pi];
    const { width: W, height: H } = page.getSize();
    const tw = font.widthOfTextAtSize(text, fontSize);
    let x = W / 2 - tw / 2;
    let y = H / 2 - fontSize / 2;
    const m = Math.min(W, H) * 0.08;
    if (position === 'top-left') { x = m; y = H - m - fontSize; }
    else if (position === 'top-right') { x = W - m - tw; y = H - m - fontSize; }
    else if (position === 'bottom-left') { x = m; y = m; }
    else if (position === 'bottom-right') { x = W - m - tw; y = m; }
    page.drawText(text, {
      x, y, size: fontSize, font, color: fill, opacity, rotate: degrees(angle)
    });
  }

  const out = await doc.save();
  if (!out || out.length === 0) throw new Error('Watermark produced no output.');
  return Buffer.from(out);
}
