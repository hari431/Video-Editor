// src/library/pdf-metadata.js — Standalone "PDF Metadata" utility (admin-only).
//
// Separate from all other PDF tools: intentionally additive. REUSES the
// editor's limits, gate and allowlist helpers, but never changes existing
// behavior.
//
// Engine: pdf-lib document-info getters/setters — already installed, no new
// dependency. Editing metadata round-trips the document: everything else
// (pages, content, annotations, forms) is preserved. Verified by test:
// decoded operator lists identical before/after a metadata edit.
//
// Editable fields: title, author, subject, keywords (comma-separated),
// creator, producer. An empty value clears that field. Dates and all other
// document structure are left untouched.
//
// Semantics: pure + in-memory (no fs, no shell, no network, no binaries, no
// temp files). The input buffer is never mutated; output is a NEW pdf.

import { PDFDocument } from 'pdf-lib';
import {
  isPdfEditorAvailable,
  isAllowedPdfInput,
  pdfEditorMaxRequestBytes,
  PDF_EDITOR_MAX_FILE_BYTES,
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from './pdf-editor.js';

// Editor-consistent limits so routes/tests share one source.
export const PDF_METADATA_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_METADATA_MAX_FILE_MB = PDF_EDITOR_MAX_FILE_MB;
export const PDF_METADATA_MAX_PAGES = PDF_EDITOR_MAX_PAGES;
// A single job handles exactly one file; the editor's multi-file cap is
// intentionally NOT reused here (route enforces "exactly one").
export const PDF_METADATA_FIELDS = ['title', 'author', 'subject', 'keywords', 'creator', 'producer'];
export const PDF_METADATA_MAX_LEN = 500;

export function isPdfMetadataAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfMetadataMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate the single uploaded file (pure; { name, size }).
export function validatePdfMetadataUpload(file) {
  if (!file) return fail('Upload one PDF file to edit metadata.');
  if (!isAllowedPdfInput(String(file.name || ''))) {
    return fail(`"${String(file.name || 'unnamed').slice(0, 100)}" must be a .pdf file.`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return fail('PDF file is empty.');
  if (size > PDF_METADATA_MAX_FILE_BYTES) {
    return fail(`PDF file exceeds ${PDF_METADATA_MAX_FILE_MB} MB.`);
  }
  return { ok: true };
}

// Validate editable metadata fields (pure). `keywords` accepts a
// comma-separated string or an array. Empty string clears a field.
export function validatePdfMetadataFields(raw = {}) {
  const fields = {};
  for (const key of PDF_METADATA_FIELDS) {
    let value = raw[key];
    if (value === undefined || value === null) continue;
    if (key === 'keywords' && Array.isArray(value)) {
      value = value.join(', ');
    }
    if (typeof value !== 'string') return fail(`${key} must be text.`);
    if (/[\r\n]/.test(value)) return fail(`${key} must be a single line.`);
    if (value.length > PDF_METADATA_MAX_LEN) {
      return fail(`${key} must be at most ${PDF_METADATA_MAX_LEN} characters.`);
    }
    fields[key] = value;
  }
  for (const key of Object.keys(raw)) {
    if (!PDF_METADATA_FIELDS.includes(key)) return fail(`Unknown metadata field "${String(key).slice(0, 40)}".`);
  }
  return { ok: true, fields };
}

// Build a safe download name `<original>-metadata.pdf` (pure).
export function metadataDownloadName(originalName) {
  let base = String(originalName || 'document.pdf').split(/[\\/]/).pop() || 'document.pdf';
  base = base.replace(/\.pdf$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'document';
  return `${base.slice(0, 80)}-metadata.pdf`;
}

function readMeta(doc) {
  // The PDF Keywords entry is a single text string; pdf-lib joins arrays with
  // spaces on write, so normalize back to individual keywords here.
  let keywords = [];
  try {
    const kw = doc.getKeywords();
    const parts = Array.isArray(kw) ? kw : (typeof kw === 'string' ? [kw] : []);
    keywords = parts
      .flatMap(k => String(k).split(/[,\s]+/))
      .map(k => k.trim())
      .filter(Boolean);
  } catch {
    keywords = [];
  }
  const str = fn => {
    try {
      const v = doc[fn]();
      return typeof v === 'string' ? v : (v === undefined ? undefined : String(v));
    } catch {
      return undefined;
    }
  };
  return {
    title: str('getTitle'),
    author: str('getAuthor'),
    subject: str('getSubject'),
    keywords,
    creator: str('getCreator'),
    producer: str('getProducer')
  };
}

async function loadDoc(pdfBytes) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  const checkedFile = validatePdfMetadataUpload({ name: 'document.pdf', size: bytes.length });
  if (!checkedFile.ok) throw new Error(checkedFile.error);
  try {
    // updateMetadata: false stops pdf-lib stamping its own Producer/
    // ModificationDate on save, so explicit edits (and untouched dates)
    // round-trip exactly.
    return await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  } catch (err) {
    if (/encrypted/i.test(err?.message || '')) {
      throw new Error('This PDF is password-protected. Unlock it before editing metadata.');
    }
    throw new Error('PDF could not be read (not a valid PDF, corrupt or unsupported).');
  }
}

// Read current metadata (pure read; never modifies anything).
export async function getPdfMetadata(pdfBytes) {
  const doc = await loadDoc(pdfBytes);
  if (doc.getPageCount() > PDF_METADATA_MAX_PAGES) {
    throw new Error(`Source PDF has ${doc.getPageCount()} pages (max ${PDF_METADATA_MAX_PAGES}).`);
  }
  return readMeta(doc);
}

// Write metadata fields, preserving everything else. Empty string clears a
// field. Resolves to Buffer. Never mutates `pdfBytes`.
export async function setPdfMetadata(pdfBytes, rawFields = {}) {
  const checked = validatePdfMetadataFields(rawFields);
  if (!checked.ok) throw new Error(checked.error);
  const doc = await loadDoc(pdfBytes);
  if (doc.getPageCount() > PDF_METADATA_MAX_PAGES) {
    throw new Error(`Source PDF has ${doc.getPageCount()} pages (max ${PDF_METADATA_MAX_PAGES}).`);
  }
  const setters = {
    title: 'setTitle', author: 'setAuthor', subject: 'setSubject',
    creator: 'setCreator', producer: 'setProducer'
  };
  for (const [key, value] of Object.entries(checked.fields)) {
    if (key === 'keywords') {
      const list = value.split(',').map(s => s.trim()).filter(Boolean);
      doc.setKeywords(list);
    } else {
      doc[setters[key]](value);
    }
  }
  const out = await doc.save();
  if (!out || out.length === 0) throw new Error('Metadata edit produced no output.');
  return Buffer.from(out);
}
