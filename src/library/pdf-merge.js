// src/library/pdf-merge.js — Standalone "Merge PDF" utility.
//
// Separate from the PDF Editor (src/library/pdf-editor.js): this module is
// intentionally additive. It REUSES the editor's limits/gate/allowlist
// helpers but never changes editor behavior.
//
// Semantics:
// - Pure + in-memory (pdf-lib): no fs, no shell, no network.
// - Inputs are never mutated; output is a NEW PDF.
// - Merge order = order of `pdfBytesList` supplied by the caller (the UI
//   sends parts already in displayed order, optionally with an explicit
//   `order` index map validated here).

import { PDFDocument } from 'pdf-lib';
import {
  isPdfEditorAvailable,
  isAllowedPdfInput,
  pdfEditorMaxRequestBytes,
  PDF_EDITOR_MAX_FILES,
  PDF_EDITOR_MAX_FILE_BYTES,
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from './pdf-editor.js';

// Re-export editor-consistent limits so routes/tests share one source.
export const PDF_MERGE_MAX_FILES = PDF_EDITOR_MAX_FILES;
export const PDF_MERGE_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_MERGE_MAX_FILE_MB = PDF_EDITOR_MAX_FILE_MB;
export const PDF_MERGE_MAX_PAGES = PDF_EDITOR_MAX_PAGES;
export const PDF_MERGE_MIN_FILES = 2;

export function isPdfMergeAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfMergeMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate filenames + sizes before touching pdf-lib. `files` is an array of
// { name, size } (size in bytes). Pure — suitable for client pre-checks too.
export function validatePdfMergeSelection(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return fail('Select at least 2 PDF files to merge.');
  }
  if (files.length < PDF_MERGE_MIN_FILES) {
    return fail(`Select at least ${PDF_MERGE_MIN_FILES} PDF files to merge (currently ${files.length}).`);
  }
  if (files.length > PDF_MERGE_MAX_FILES) {
    return fail(`At most ${PDF_MERGE_MAX_FILES} PDF files can be merged at once.`);
  }
  for (let i = 0; i < files.length; i++) {
    const f = files[i] || {};
    if (!isAllowedPdfInput(String(f.name || ''))) {
      return fail(`File ${i + 1} ("${String(f.name || 'unnamed').slice(0, 100)}") must be a .pdf file.`);
    }
    const size = Number(f.size);
    if (!Number.isFinite(size) || size <= 0) {
      return fail(`File ${i + 1} is empty.`);
    }
    if (size > PDF_MERGE_MAX_FILE_BYTES) {
      return fail(`File ${i + 1} exceeds ${PDF_MERGE_MAX_FILE_MB} MB.`);
    }
  }
  return { ok: true };
}

// Validate an explicit reorder map (e.g. client sends order=[2,0,1]).
// Returns normalized order or an error. Pure.
export function validatePdfMergeOrder(order, fileCount) {
  if (order === undefined || order === null) return { ok: true, order: null };
  if (!Array.isArray(order)) return fail('order must be an array of file indexes.');
  if (order.length !== fileCount) return fail('order must list every uploaded file exactly once.');
  const seen = new Set();
  for (const v of order) {
    if (!Number.isInteger(v) || v < 0 || v >= fileCount) {
      return fail('order contains an invalid file index.');
    }
    if (seen.has(v)) return fail('order must list every uploaded file exactly once.');
    seen.add(v);
  }
  return { ok: true, order: [...order] };
}

// Merge PDFs strictly in the given list order. Throws Error on any invalid
// input (count, size, non-PDF/malformed/encrypted, page-cap overflow).
// Never mutates the source buffers.
export async function mergePdfs(pdfBytesList) {
  const selection = validatePdfMergeSelection(
    (Array.isArray(pdfBytesList) ? pdfBytesList : []).map((b, i) => ({
      name: `file${i + 1}.pdf`,
      size: b ? b.length : 0
    }))
  );
  // validatePdfMergeSelection uses generic .pdf names; the route performs
  // the stricter filename allowlist check with real names before calling.
  if (!selection.ok) throw new Error(selection.error);

  const sources = [];
  let totalPages = 0;
  for (let i = 0; i < pdfBytesList.length; i++) {
    const bytes = pdfBytesList[i];
    if (!bytes || bytes.length === 0) throw new Error(`PDF file ${i + 1} is empty.`);
    if (bytes.length > PDF_MERGE_MAX_FILE_BYTES) {
      throw new Error(`PDF file ${i + 1} exceeds ${PDF_MERGE_MAX_FILE_MB} MB.`);
    }
    let doc;
    try {
      doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
    } catch {
      throw new Error(`PDF file ${i + 1} could not be read (not a valid PDF, corrupt or encrypted).`);
    }
    totalPages += doc.getPageCount();
    sources.push(doc);
  }
  if (totalPages > PDF_MERGE_MAX_PAGES) {
    throw new Error(`Merged PDF would have ${totalPages} pages (max ${PDF_MERGE_MAX_PAGES}).`);
  }
  if (totalPages === 0) throw new Error('Source PDFs contain no pages.');

  const out = await PDFDocument.create();
  for (const src of sources) {
    const count = src.getPageCount();
    const idx = Array.from({ length: count }, (_, k) => k);
    const copied = await out.copyPages(src, idx);
    for (const p of copied) out.addPage(p);
  }
  return out.save();
}
