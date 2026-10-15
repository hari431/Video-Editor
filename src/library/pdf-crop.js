// src/library/pdf-crop.js — Standalone "Crop PDF" utility (admin-only).
//
// Separate from all other PDF tools: intentionally additive. REUSES the
// editor's limits, gate and allowlist helpers plus the split tool's strict
// page-selection parser, but never changes existing behavior.
//
// Engine: pdf-lib (`getCropBox`/`setCropBox`, MediaBox fallback) — already
// installed, no new dependency. Cropping only narrows the visible page
// rectangle; content streams are never touched or re-rendered (verified by
// spike: decoded operator lists identical before/after).
//
// Margins are in PDF points applied inside the page's current crop region
// (PDF bottom-left origin: left/bottom raise the origin, right/top shrink
// the far edges). The result must keep at least 36pt in each dimension.
//
// Semantics: pure + in-memory (no fs, no shell, no network, no binaries, no
// temp files). The input buffer is never mutated; output is a NEW pdf.

import { PDFDocument } from 'pdf-lib';
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
export const PDF_CROP_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_CROP_MAX_FILE_MB = PDF_EDITOR_MAX_FILE_MB;
export const PDF_CROP_MAX_PAGES = PDF_EDITOR_MAX_PAGES;
// A single crop handles exactly one file; the editor's multi-file cap is
// intentionally NOT reused here (route enforces "exactly one").
export const PDF_CROP_MAX_MARGIN = 360;
export const PDF_CROP_MIN_DIMENSION = 36;

export function isPdfCropAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfCropMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate the single uploaded file (pure; { name, size }).
export function validatePdfCropUpload(file) {
  if (!file) return fail('Upload one PDF file to crop.');
  if (!isAllowedPdfInput(String(file.name || ''))) {
    return fail(`"${String(file.name || 'unnamed').slice(0, 100)}" must be a .pdf file.`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return fail('PDF file is empty.');
  if (size > PDF_CROP_MAX_FILE_BYTES) {
    return fail(`PDF file exceeds ${PDF_CROP_MAX_FILE_MB} MB.`);
  }
  return { ok: true };
}

// Validate per-edge margins in points (pure).
export function validatePdfCropMargins(margins = {}) {
  const out = {};
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    const raw = margins[edge];
    const n = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > PDF_CROP_MAX_MARGIN) {
      return fail(`${edge} margin must be between 0 and ${PDF_CROP_MAX_MARGIN} points.`);
    }
    out[edge] = n;
  }
  if (out.top + out.right + out.bottom + out.left === 0) {
    return fail('Set at least one margin greater than 0.');
  }
  return { ok: true, margins: out };
}

// Build a safe download name `<original>-cropped.pdf` (pure).
export function cropDownloadName(originalName) {
  let base = String(originalName || 'document.pdf').split(/[\\/]/).pop() || 'document.pdf';
  base = base.replace(/\.pdf$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'document';
  return `${base.slice(0, 80)}-cropped.pdf`;
}

// Crop pages to the given margins. `opts`: { margins: {top,right,bottom,
// left}, scope: 'all'|'range', selectionText }. Resolves to Buffer. Throws
// user-friendly errors. Never mutates `pdfBytes`. Encrypted inputs rejected.
export async function cropPdf(pdfBytes, opts = {}) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  const checkedFile = validatePdfCropUpload({ name: 'document.pdf', size: bytes.length });
  if (!checkedFile.ok) throw new Error(checkedFile.error);
  const checkedMargins = validatePdfCropMargins(opts?.margins);
  if (!checkedMargins.ok) throw new Error(checkedMargins.error);
  const { top, right, bottom, left } = checkedMargins.margins;
  const scope = opts?.scope === 'range' ? 'range' : 'all';

  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (err) {
    if (/encrypted/i.test(err?.message || '')) {
      throw new Error('This PDF is password-protected. Unlock it before cropping.');
    }
    throw new Error('PDF could not be read (not a valid PDF, corrupt or unsupported).');
  }
  const pages = doc.getPages();
  if (pages.length > PDF_CROP_MAX_PAGES) {
    throw new Error(`Source PDF has ${pages.length} pages (max ${PDF_CROP_MAX_PAGES}).`);
  }
  let targets = pages.map((_, i) => i);
  if (scope === 'range') {
    const parsed = parsePageSelection(opts?.selectionText, pages.length);
    if (!parsed.ok) throw new Error(parsed.error);
    targets = parsed.pages;
  }

  for (const i of targets) {
    const page = pages[i];
    // Crop inside the current visible region (explicit CropBox if present,
    // otherwise the MediaBox). pdf-lib exposes both.
    let region;
    try {
      region = page.getCropBox();
    } catch {
      region = page.getMediaBox();
    }
    const nx = region.x + left;
    const ny = region.y + bottom;
    const nw = region.width - left - right;
    const nh = region.height - top - bottom;
    if (nw < PDF_CROP_MIN_DIMENSION || nh < PDF_CROP_MIN_DIMENSION) {
      throw new Error(`Margins too large for page ${i + 1} (keeps less than ${PDF_CROP_MIN_DIMENSION}pt).`);
    }
    page.setCropBox(nx, ny, nw, nh);
  }

  const out = await doc.save();
  if (!out || out.length === 0) throw new Error('Crop produced no output.');
  return Buffer.from(out);
}
