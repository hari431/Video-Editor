// src/library/pdf-rotate.js — Standalone "Rotate PDF" utility (admin-only).
//
// Separate from all other PDF tools: intentionally additive. REUSES the
// editor's limits, gate and allowlist helpers plus the split tool's strict
// page-selection parser, but never changes existing behavior.
//
// Engine: `pdfstudio` (qpdf 12.3.2 WASM, Apache-2.0) `rotate()` — structural,
// relative rotation applied per page (a page already at 90° rotated by +90°
// lands at 180°). Verified by spike: relative/absolute/per-range/negative
// angles all round-trip with page content untouched.
//
// Semantics: pure + in-memory (no fs, no shell, no network, no binaries, no
// temp files). The input buffer is never mutated; output is a NEW pdf.

import { createPdfToolkit, PdfPasswordError } from 'pdfstudio';
import { parsePageSelection, toQpdfSelection } from './pdf-split.js';
import {
  isPdfEditorAvailable,
  isAllowedPdfInput,
  pdfEditorMaxRequestBytes,
  PDF_EDITOR_MAX_FILE_BYTES,
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from './pdf-editor.js';

// Editor-consistent limits so routes/tests share one source.
export const PDF_ROTATE_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_ROTATE_MAX_FILE_MB = PDF_EDITOR_MAX_FILE_MB;
export const PDF_ROTATE_MAX_PAGES = PDF_EDITOR_MAX_PAGES;
// A single rotate handles exactly one file; the editor's multi-file cap is
// intentionally NOT reused here (route enforces "exactly one").
export const PDF_ROTATE_ANGLES = [90, 180, 270, -90, -180, -270];
export const PDF_ROTATE_DEFAULT_ANGLE = 90;

export function isPdfRotateAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfRotateMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate the single uploaded file (pure; { name, size }).
export function validatePdfRotateUpload(file) {
  if (!file) return fail('Upload one PDF file to rotate.');
  if (!isAllowedPdfInput(String(file.name || ''))) {
    return fail(`"${String(file.name || 'unnamed').slice(0, 100)}" must be a .pdf file.`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return fail('PDF file is empty.');
  if (size > PDF_ROTATE_MAX_FILE_BYTES) {
    return fail(`PDF file exceeds ${PDF_ROTATE_MAX_FILE_MB} MB.`);
  }
  return { ok: true };
}

export function validatePdfRotateAngle(angle) {
  const n = typeof angle === 'string' && angle.trim() !== '' ? Number(angle) : angle;
  if (!PDF_ROTATE_ANGLES.includes(n)) {
    return fail(`angle must be one of: ${PDF_ROTATE_ANGLES.join(', ')}.`);
  }
  return { ok: true, angle: n };
}

// Build a safe download name `<original>-rotated-{angle}.pdf` (pure).
export function rotateDownloadName(originalName, angle) {
  let base = String(originalName || 'document.pdf').split(/[\\/]/).pop() || 'document.pdf';
  base = base.replace(/\.pdf$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'document';
  return `${base.slice(0, 80)}-rotated-${angle}.pdf`;
}

// Lazily compiled qpdf-WASM toolkit, shared across calls.
let toolkitPromise = null;
function getToolkit() {
  if (!toolkitPromise) toolkitPromise = createPdfToolkit();
  return toolkitPromise;
}

function isPasswordError(err) {
  return !!err && (err instanceof PdfPasswordError || err?.name === 'PdfPasswordError');
}

// Rotate pages (relative semantics). `opts`: { angle, scope: 'all'|'range',
// selectionText }. Resolves to Buffer. Throws user-friendly errors. Never
// mutates `pdfBytes`. Encrypted inputs are rejected (unlock first).
export async function rotatePdf(pdfBytes, opts = {}) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  const checkedFile = validatePdfRotateUpload({ name: 'document.pdf', size: bytes.length });
  if (!checkedFile.ok) throw new Error(checkedFile.error);
  const checkedAngle = validatePdfRotateAngle(opts?.angle ?? PDF_ROTATE_DEFAULT_ANGLE);
  if (!checkedAngle.ok) throw new Error(checkedAngle.error);
  const scope = opts?.scope === 'range' ? 'range' : 'all';

  const data = new Uint8Array(bytes.length);
  data.set(bytes);

  const toolkit = await getToolkit();

  let info;
  try {
    info = await toolkit.getInfo(data);
  } catch (err) {
    if (isPasswordError(err)) {
      throw new Error('This PDF is password-protected. Unlock it before rotating.');
    }
    throw new Error('PDF could not be read (not a valid PDF, corrupt or unsupported).');
  }
  if (info?.encrypted) {
    throw new Error('This PDF is password-protected. Unlock it before rotating.');
  }
  const numPages = info?.pageCount;
  if (!Number.isFinite(numPages) || numPages < 1) {
    throw new Error('Source PDF contains no pages.');
  }
  if (numPages > PDF_ROTATE_MAX_PAGES) {
    throw new Error(`Source PDF has ${numPages} pages (max ${PDF_ROTATE_MAX_PAGES}).`);
  }

  let out;
  try {
    if (scope === 'range') {
      const parsed = parsePageSelection(opts?.selectionText, numPages);
      if (!parsed.ok) throw new Error(parsed.error);
      out = await toolkit.rotate(data, { angle: checkedAngle.angle, pages: toQpdfSelection(parsed.pages) });
    } else {
      out = await toolkit.rotate(data, { angle: checkedAngle.angle });
    }
  } catch (err) {
    if (err?.message && /pages|range|duplicate|out of range|positive|lower page/i.test(err.message)) throw err;
    throw new Error('Unable to rotate PDF.');
  }
  if (!out || out.length === 0) throw new Error('Rotation produced no output.');
  return Buffer.from(out);
}
