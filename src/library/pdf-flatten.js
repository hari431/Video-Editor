// src/library/pdf-flatten.js — Standalone "Flatten PDF" utility (admin-only).
//
// Separate from all other PDF tools: intentionally additive. REUSES the
// editor's limits, gate and allowlist helpers, but never changes existing
// behavior.
//
// Engine: pdf-lib (`form.updateFieldAppearances()` + `form.flatten()`) —
// already installed, no new dependency. Fillable AcroForm fields are baked
// into page content; the fields themselves are removed. Verified by spike:
// field names gone afterwards, filled values present in extracted text,
// static content and page count untouched.
//
// Explicit scope (stated in the UI, never silent): only fillable form fields
// are flattened. Markup annotations (highlights, notes, stamps) are preserved
// as-is — pdf-lib cannot bake arbitrary annotations, and this tool does not
// attempt to. A document with no form fields is returned unchanged with a
// count of zero.
//
// Semantics: pure + in-memory (no fs, no shell, no network, no binaries, no
// temp files). The input buffer is never mutated; output is a NEW pdf.

import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  isPdfEditorAvailable,
  isAllowedPdfInput,
  pdfEditorMaxRequestBytes,
  PDF_EDITOR_MAX_FILE_BYTES,
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from './pdf-editor.js';

// Editor-consistent limits so routes/tests share one source.
export const PDF_FLATTEN_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_FLATTEN_MAX_FILE_MB = PDF_EDITOR_MAX_FILE_MB;
export const PDF_FLATTEN_MAX_PAGES = PDF_EDITOR_MAX_PAGES;
// A single job handles exactly one file; the editor's multi-file cap is
// intentionally NOT reused here (route enforces "exactly one").

export function isPdfFlattenAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfFlattenMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate the single uploaded file (pure; { name, size }).
export function validatePdfFlattenUpload(file) {
  if (!file) return fail('Upload one PDF file to flatten.');
  if (!isAllowedPdfInput(String(file.name || ''))) {
    return fail(`"${String(file.name || 'unnamed').slice(0, 100)}" must be a .pdf file.`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return fail('PDF file is empty.');
  if (size > PDF_FLATTEN_MAX_FILE_BYTES) {
    return fail(`PDF file exceeds ${PDF_FLATTEN_MAX_FILE_MB} MB.`);
  }
  return { ok: true };
}

// Build a safe download name `<original>-flattened.pdf` (pure).
export function flattenDownloadName(originalName) {
  let base = String(originalName || 'document.pdf').split(/[\\/]/).pop() || 'document.pdf';
  base = base.replace(/\.pdf$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'document';
  return `${base.slice(0, 80)}-flattened.pdf`;
}

// Flatten fillable form fields into page content.
// Resolves to `{ bytes: Buffer, flattened: [field names], hadForm: bool }`.
// `flattened` is empty (and bytes equal the input) when the document has no
// fillable fields. Throws user-friendly errors. Never mutates `pdfBytes`.
export async function flattenPdf(pdfBytes) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  const checkedFile = validatePdfFlattenUpload({ name: 'document.pdf', size: bytes.length });
  if (!checkedFile.ok) throw new Error(checkedFile.error);

  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (err) {
    if (/encrypted/i.test(err?.message || '')) {
      throw new Error('This PDF is password-protected. Unlock it before flattening.');
    }
    throw new Error('PDF could not be read (not a valid PDF, corrupt or unsupported).');
  }
  if (doc.getPageCount() > PDF_FLATTEN_MAX_PAGES) {
    throw new Error(`Source PDF has ${doc.getPageCount()} pages (max ${PDF_FLATTEN_MAX_PAGES}).`);
  }

  let form = null;
  let fields = [];
  try {
    form = doc.getForm();
    fields = form.getFields().map(f => {
      try { return f.getName(); } catch { return '(unnamed field)'; }
    });
  } catch {
    form = null;
    fields = [];
  }

  if (!form || fields.length === 0) {
    return { bytes: Buffer.from(bytes), flattened: [], hadForm: false };
  }

  // Regenerate appearances so filled values render, then bake them in. If
  // appearance regeneration fails for an exotic field, still flatten rather
  // than failing the whole job.
  try {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    form.updateFieldAppearances(font);
  } catch {
    // Fall through to flatten with existing appearances.
  }
  form.flatten();

  const out = await doc.save();
  if (!out || out.length === 0) throw new Error('Flatten produced no output.');
  return { bytes: Buffer.from(out), flattened: fields, hadForm: true };
}
