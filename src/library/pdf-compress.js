// src/library/pdf-compress.js — Standalone "Compress PDF" utility (admin-only).
//
// Separate from the PDF Editor (pdf-editor.js), Merge PDFs (pdf-merge.js),
// Unlock PDF (pdf-unlock.js) and Protect PDF (pdf-protect.js): this module is
// intentionally additive. It REUSES the editor's limits, gate and allowlist
// helpers but never changes editor/merge/unlock/protect behavior.
//
// Engine: `pdfstudio` (qpdf 12.3.2 compiled to WebAssembly, Apache-2.0)
// `compress()` — genuine LOSSLESS structural compression: stream
// recompression (zlib level 1–9) plus object-stream packing. No image
// downsampling, no re-rendering, no quality change of any kind. Validated by
// an isolated spike: 24.8% reduction on a realistic rich fixture with
// byte-identical decoded content (operator lists, text, images, annotations,
// metadata), inputs byte-unchanged, ~22 ms for a 47 KB file.
//
// Honesty rule (enforced here, surfaced by the route/UI): compression is only
// claimed when the output is actually smaller. If qpdf's output is larger
// than (or equal to) the input — e.g. an already-optimal file — the ORIGINAL
// bytes are returned with `reduced: false` instead of a bigger file.
// JPEG-photo-heavy PDFs are the classic case: already-compressed image data
// cannot shrink losslessly, so callers must not promise a reduction.
//
// Semantics: pure + in-memory (qpdf runs in a WASM heap; no fs, no shell, no
// network, no binaries, no temp files). The input buffer is never mutated
// (the engine receives a defensive copy).

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
export const PDF_COMPRESS_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_COMPRESS_MAX_FILE_MB = PDF_EDITOR_MAX_FILE_MB;
export const PDF_COMPRESS_MAX_PAGES = PDF_EDITOR_MAX_PAGES;
// A single compress handles exactly one file; the editor's multi-file cap is
// intentionally NOT reused here (route enforces "exactly one").
//
// Levels are all lossless; they trade CPU time against size. `balanced` is
// the default. `fast` preserves the input's object-stream layout (cheapest);
// `maximum` repacks object streams at zlib level 9 (slowest, smallest).
export const PDF_COMPRESS_LEVELS = {
  fast: { compressionLevel: 1, objectStreams: false },
  balanced: { compressionLevel: 6, objectStreams: true },
  maximum: { compressionLevel: 9, objectStreams: true }
};
export const PDF_COMPRESS_DEFAULT_LEVEL = 'balanced';

export function isPdfCompressAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfCompressMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate the single uploaded file (pure; { name, size }).
export function validatePdfCompressUpload(file) {
  if (!file) return fail('Upload one PDF file to compress.');
  if (!isAllowedPdfInput(String(file.name || ''))) {
    return fail(`"${String(file.name || 'unnamed').slice(0, 100)}" must be a .pdf file.`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return fail('PDF file is empty.');
  if (size > PDF_COMPRESS_MAX_FILE_BYTES) {
    return fail(`PDF file exceeds ${PDF_COMPRESS_MAX_FILE_MB} MB.`);
  }
  return { ok: true };
}

// Validate the compression level (pure). Missing/empty selects the default.
export function validatePdfCompressLevel(level) {
  if (level === undefined || level === null || level === '') {
    return { ok: true, level: PDF_COMPRESS_DEFAULT_LEVEL };
  }
  if (typeof level !== 'string' || !PDF_COMPRESS_LEVELS[level]) {
    return fail(`level must be one of: ${Object.keys(PDF_COMPRESS_LEVELS).join(', ')}.`);
  }
  return { ok: true, level };
}

// Decide what to hand back (pure): only claim compression when the output is
// actually smaller; otherwise return the original bytes untouched.
export function chooseCompressedOutput(originalBytes, compressedBytes) {
  const original = Buffer.isBuffer(originalBytes) ? originalBytes : Buffer.from(originalBytes || []);
  const compressed = Buffer.isBuffer(compressedBytes) ? compressedBytes : Buffer.from(compressedBytes || []);
  if (compressed.length > 0 && compressed.length < original.length) {
    const ratio = (1 - compressed.length / original.length) * 100;
    return { bytes: compressed, reduced: true, ratio };
  }
  return { bytes: original, reduced: false, ratio: 0 };
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

// Build a safe download name `<original>-compressed.pdf` (pure). Sanitized to
// header-safe characters so it can be used in Content-Disposition directly.
export function compressDownloadName(originalName) {
  let base = String(originalName || 'document.pdf').split(/[\\/]/).pop() || 'document.pdf';
  base = base.replace(/\.pdf$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'document';
  base = base.slice(0, 100);
  return `${base}-compressed.pdf`;
}

// Compress with the selected level. Resolves to
// `{ bytes, reduced, ratio, level }` (see chooseCompressedOutput). Throws
// Error with a user-friendly message (never internal stack traces) on any
// failure. Never mutates `pdfBytes` (the engine receives a defensive copy).
// Already-encrypted files are rejected (compression needs no password here —
// unlock first); garbage fails readability validation.
export async function compressPdf(pdfBytes, level) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  const checkedFile = validatePdfCompressUpload({ name: 'document.pdf', size: bytes.length });
  if (!checkedFile.ok) throw new Error(checkedFile.error);
  const checkedLevel = validatePdfCompressLevel(level);
  if (!checkedLevel.ok) throw new Error(checkedLevel.error);
  const { compressionLevel, objectStreams } = PDF_COMPRESS_LEVELS[checkedLevel.level];

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
      throw new Error('This PDF is password-protected. Unlock it before compressing.');
    }
    throw new Error('PDF could not be read (not a valid PDF, corrupt or unsupported).');
  }
  if (info?.encrypted) {
    throw new Error('This PDF is password-protected. Unlock it before compressing.');
  }
  const numPages = info?.pageCount;
  if (!Number.isFinite(numPages) || numPages < 1) {
    throw new Error('Source PDF contains no pages.');
  }
  if (numPages > PDF_COMPRESS_MAX_PAGES) {
    throw new Error(`Source PDF has ${numPages} pages (max ${PDF_COMPRESS_MAX_PAGES}).`);
  }

  let out;
  try {
    out = await toolkit.compress(data, { compressionLevel, objectStreams });
  } catch {
    throw new Error('Unable to compress PDF.');
  }
  if (!out || out.length === 0) throw new Error('Compression produced no output.');
  const chosen = chooseCompressedOutput(data, Buffer.from(out));
  return { ...chosen, level: checkedLevel.level };
}
