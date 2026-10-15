// src/library/pdf-text.js — Standalone "PDF to Text" utility (admin-only).
//
// Separate from all other PDF tools: intentionally additive. REUSES the
// editor's limits, gate and allowlist helpers plus the split tool's strict
// page-selection parser, but never changes existing behavior.
//
// Engine: pdfjs-dist `getTextContent()` (server legacy build) — already
// installed, no new dependency. Selectable text only: scanned/image-only
// pages yield little or no text, and this tool performs NO OCR (stated in
// the UI). Page boundaries are preserved with `--- Page N of M ---`
// separators; line breaks follow the extractor's end-of-line flags.
//
// Semantics: pure + in-memory (no fs, no shell, no network, no binaries, no
// temp files). The input buffer is never mutated; output is NEW text.

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
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
export const PDF_TEXT_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_TEXT_MAX_FILE_MB = PDF_EDITOR_MAX_FILE_MB;
export const PDF_TEXT_MAX_PAGES = PDF_EDITOR_MAX_PAGES;
// A single job handles exactly one file; the editor's multi-file cap is
// intentionally NOT reused here (route enforces "exactly one").
// Caps total extracted characters (a 500-page manual stays servable).
export const PDF_TEXT_MAX_CHARS = 5 * 1024 * 1024;

export function isPdfTextAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfTextMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate the single uploaded file (pure; { name, size }).
export function validatePdfTextUpload(file) {
  if (!file) return fail('Upload one PDF file to extract text from.');
  if (!isAllowedPdfInput(String(file.name || ''))) {
    return fail(`"${String(file.name || 'unnamed').slice(0, 100)}" must be a .pdf file.`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return fail('PDF file is empty.');
  if (size > PDF_TEXT_MAX_FILE_BYTES) {
    return fail(`PDF file exceeds ${PDF_TEXT_MAX_FILE_MB} MB.`);
  }
  return { ok: true };
}

// Build a safe download name `<original>.txt` (pure).
export function textDownloadName(originalName) {
  let base = String(originalName || 'document.pdf').split(/[\\/]/).pop() || 'document.pdf';
  base = base.replace(/\.pdf$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'document';
  return `${base.slice(0, 80)}.txt`;
}

// Extract selectable text. `opts`: { scope: 'all'|'range', selectionText }.
// Resolves to `{ text, pages: [{ page, chars }], pageCount }` where `page`
// is 1-based and text carries `--- Page N of M ---` separators. Throws
// user-friendly errors. Never mutates `pdfBytes`.
export async function extractPdfText(pdfBytes, opts = {}) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  const checkedFile = validatePdfTextUpload({ name: 'document.pdf', size: bytes.length });
  if (!checkedFile.ok) throw new Error(checkedFile.error);
  const scope = opts?.scope === 'range' ? 'range' : 'all';

  // Defensive copy: the loader may detach the backing buffer.
  const data = new Uint8Array(bytes.length);
  data.set(bytes);

  const verbosity = pdfjsLib.VerbosityLevel ? pdfjsLib.VerbosityLevel.ERRORS : 0;
  let loadingTask = null;
  try {
    loadingTask = pdfjsLib.getDocument({ data, verbosity });
    let doc;
    try {
      doc = await loadingTask.promise;
    } catch (err) {
      if (err && err.name === 'PasswordException') {
        throw new Error('This PDF is password-protected. Unlock it before extracting text.');
      }
      throw new Error('PDF could not be read (not a valid PDF, corrupt or unsupported).');
    }
    const numPages = doc.numPages;
    if (!Number.isFinite(numPages) || numPages < 1) {
      throw new Error('Source PDF contains no pages.');
    }
    if (numPages > PDF_TEXT_MAX_PAGES) {
      throw new Error(`Source PDF has ${numPages} pages (max ${PDF_TEXT_MAX_PAGES}).`);
    }
    let targets = Array.from({ length: numPages }, (_, i) => i);
    if (scope === 'range') {
      const parsed = parsePageSelection(opts?.selectionText, numPages);
      if (!parsed.ok) throw new Error(parsed.error);
      targets = parsed.pages;
    }

    const chunks = [];
    const pages = [];
    let total = 0;
    for (const pi of targets) {
      const page = await doc.getPage(pi + 1);
      let textContent;
      try {
        textContent = await page.getTextContent();
      } catch {
        textContent = { items: [] };
      }
      let body = '';
      for (const item of textContent.items || []) {
        if (!item || typeof item.str !== 'string' || !item.str) continue;
        body += item.str + (item.hasEOL ? '\n' : ' ');
      }
      body = body.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      const header = `--- Page ${pi + 1} of ${numPages} ---`;
      const block = body ? `${header}\n${body}\n` : `${header}\n`;
      total += block.length;
      if (total > PDF_TEXT_MAX_CHARS) {
        throw new Error(`Extracted text exceeds ${PDF_TEXT_MAX_CHARS} characters. Select fewer pages.`);
      }
      chunks.push(block);
      pages.push({ page: pi + 1, chars: block.length });
    }
    return { text: chunks.join('\n'), pages, pageCount: numPages };
  } finally {
    if (loadingTask && typeof loadingTask.destroy === 'function') {
      try { await loadingTask.destroy(); } catch { /* ignore cleanup errors */ }
    }
  }
}
