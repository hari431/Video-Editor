// src/library/pdf-bookmarks.js — Standalone "Bookmarks" utility (admin-only).
//
// Separate from all other PDF tools: intentionally additive. REUSES the
// editor's limits, gate and allowlist helpers, but never changes existing
// behavior.
//
// Engine: pdf-lib low-level catalog surgery (already installed, no new
// dependency) — outline items ({Title, Dest [pageRef /Fit]}) chained with
// Prev/Next under the catalog /Outlines dictionary. Reading uses pdf.js
// (already installed). Verified by spike: pdf.js resolves created bookmarks
// to the right pages, append mode preserves pre-existing entries, and page
// content is untouched.
//
// Modes: `append` (default — new entries become siblings after the existing
// Last item, preserving current bookmarks) and `replace` (rebuilds the
// outline from the given list). Only flat, single-level lists are created.
//
// Entry syntax (one per line): `Title | 3` (title, 1-based page).
//
// Semantics: pure + in-memory (no fs, no shell, no network, no binaries, no
// temp files). The input buffer is never mutated; output is a NEW pdf.

import { PDFDocument, PDFName, PDFDict, PDFNumber, PDFString, PDFRef } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  isPdfEditorAvailable,
  isAllowedPdfInput,
  pdfEditorMaxRequestBytes,
  PDF_EDITOR_MAX_FILE_BYTES,
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from './pdf-editor.js';

// Editor-consistent limits so routes/tests share one source.
export const PDF_BOOKMARKS_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_BOOKMARKS_MAX_FILE_MB = PDF_EDITOR_MAX_FILE_MB;
export const PDF_BOOKMARKS_MAX_PAGES = PDF_EDITOR_MAX_PAGES;
// A single job handles exactly one file; the editor's multi-file cap is
// intentionally NOT reused here (route enforces "exactly one").
export const PDF_BOOKMARKS_MODES = ['append', 'replace'];
export const PDF_BOOKMARKS_DEFAULT_MODE = 'append';
export const PDF_BOOKMARKS_MAX_ENTRIES = 200;
export const PDF_BOOKMARKS_MAX_TITLE = 200;

export function isPdfBookmarksAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfBookmarksMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate the single uploaded file (pure; { name, size }).
export function validatePdfBookmarksUpload(file) {
  if (!file) return fail('Upload one PDF file to bookmark.');
  if (!isAllowedPdfInput(String(file.name || ''))) {
    return fail(`"${String(file.name || 'unnamed').slice(0, 100)}" must be a .pdf file.`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return fail('PDF file is empty.');
  if (size > PDF_BOOKMARKS_MAX_FILE_BYTES) {
    return fail(`PDF file exceeds ${PDF_BOOKMARKS_MAX_FILE_MB} MB.`);
  }
  return { ok: true };
}

// Parse "Title | 3" lines against a page count (pure). Returns 0-based
// entries in the given order.
export function parseBookmarkEntries(text, pageCount) {
  if (typeof text !== 'string' || text.trim() === '') {
    return fail('Enter at least one bookmark as "Title | page".');
  }
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return fail('Invalid page count.');
  }
  const entries = [];
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (line === '') continue;
    const segments = line.split('|');
    if (segments.length !== 2) {
      return fail(`Line ${li + 1} needs exactly one "|": write "Title | page".`);
    }
    const title = segments[0].trim();
    const pagePart = segments[1].trim();
    if (!title || title.length > PDF_BOOKMARKS_MAX_TITLE) {
      return fail(`Line ${li + 1} title must be 1–${PDF_BOOKMARKS_MAX_TITLE} characters.`);
    }
    if (!/^\d+$/.test(pagePart)) {
      return fail(`Line ${li + 1} page "${pagePart.slice(0, 20)}" must be a positive number.`);
    }
    const page = Number(pagePart);
    if (page < 1 || page > pageCount) {
      return fail(`Line ${li + 1} page ${page} is out of range (this PDF has ${pageCount} pages).`);
    }
    entries.push({ title, pageIndex: page - 1 });
    if (entries.length > PDF_BOOKMARKS_MAX_ENTRIES) {
      return fail(`Too many bookmarks (max ${PDF_BOOKMARKS_MAX_ENTRIES}).`);
    }
  }
  if (entries.length === 0) {
    return fail('Enter at least one bookmark as "Title | page".');
  }
  return { ok: true, entries };
}

export function validatePdfBookmarksMode(mode) {
  if (mode === undefined || mode === null || mode === '') {
    return { ok: true, mode: PDF_BOOKMARKS_DEFAULT_MODE };
  }
  if (typeof mode !== 'string' || !PDF_BOOKMARKS_MODES.includes(mode)) {
    return fail(`mode must be one of: ${PDF_BOOKMARKS_MODES.join(', ')}.`);
  }
  return { ok: true, mode };
}

// Build a safe download name `<original>-bookmarks.pdf` (pure).
export function bookmarksDownloadName(originalName) {
  let base = String(originalName || 'document.pdf').split(/[\\/]/).pop() || 'document.pdf';
  base = base.replace(/\.pdf$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'document';
  return `${base.slice(0, 80)}-bookmarks.pdf`;
}

async function loadDoc(pdfBytes) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  const checkedFile = validatePdfBookmarksUpload({ name: 'document.pdf', size: bytes.length });
  if (!checkedFile.ok) throw new Error(checkedFile.error);
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (err) {
    if (/encrypted/i.test(err?.message || '')) {
      throw new Error('This PDF is password-protected. Unlock it before editing bookmarks.');
    }
    throw new Error('PDF could not be read (not a valid PDF, corrupt or unsupported).');
  }
}

// Read the current outline as flat [{ title, page }] (1-based pages).
// Unresolvable destinations come back with page null.
export async function getPdfBookmarks(pdfBytes) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  const checkedFile = validatePdfBookmarksUpload({ name: 'document.pdf', size: bytes.length });
  if (!checkedFile.ok) throw new Error(checkedFile.error);
  let task = null;
  try {
    task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
    const doc = await task.promise;
    const outline = await doc.getOutline().catch(() => null);
    const flat = [];
    const walk = items => {
      for (const it of items || []) {
        flat.push({ title: String(it.title || ''), dest: it.dest || null });
        walk(it.items);
      }
    };
    walk(outline);
    const out = [];
    for (const entry of flat) {
      let page = null;
      try {
        if (entry.dest) page = (await doc.getPageIndex(entry.dest[0])) + 1;
      } catch {
        page = null;
      }
      out.push({ title: entry.title, page });
    }
    return out;
  } catch (err) {
    if (err && (err.name === 'PasswordException' || /password/i.test(err?.message || ''))) {
      throw new Error('This PDF is password-protected. Unlock it before reading bookmarks.');
    }
    throw new Error('PDF could not be read (not a valid PDF, corrupt or unsupported).');
  } finally {
    if (task && typeof task.destroy === 'function') {
      try { await task.destroy(); } catch { /* ignore cleanup errors */ }
    }
  }
}

// Write bookmarks. `opts`: { entriesText, mode }. Resolves to Buffer.
// Never mutates `pdfBytes`.
export async function setPdfBookmarks(pdfBytes, opts = {}) {
  const doc = await loadDoc(pdfBytes);
  const numPages = doc.getPageCount();
  if (numPages > PDF_BOOKMARKS_MAX_PAGES) {
    throw new Error(`Source PDF has ${numPages} pages (max ${PDF_BOOKMARKS_MAX_PAGES}).`);
  }
  const checkedMode = validatePdfBookmarksMode(opts?.mode);
  if (!checkedMode.ok) throw new Error(checkedMode.error);
  const parsed = parseBookmarkEntries(opts?.entriesText, numPages);
  if (!parsed.ok) throw new Error(parsed.error);

  const context = doc.context;
  const pages = doc.getPages();
  const catalog = doc.catalog;
  const mode = checkedMode.mode;

  let outlinesRef = catalog.get(PDFName.of('Outlines'));
  let outlines = outlinesRef instanceof PDFRef ? context.lookup(outlinesRef) : outlinesRef;
  let prevRef = null;
  let baseCount = 0;
  let keepExisting = false;
  if (mode === 'append' && outlines instanceof PDFDict) {
    const lastRef = outlines.get(PDFName.of('Last'));
    if (lastRef instanceof PDFRef) {
      prevRef = lastRef;
      keepExisting = true;
      const countObj = outlines.get(PDFName.of('Count'));
      baseCount = countObj && Number.isInteger(countObj.asNumber()) ? Math.max(0, countObj.asNumber()) : 0;
    }
  }
  if (!keepExisting || !(outlines instanceof PDFDict)) {
    outlines = context.obj({ Type: PDFName.of('Outlines') });
    outlinesRef = context.register(outlines);
    catalog.set(PDFName.of('Outlines'), outlinesRef);
    prevRef = null;
    baseCount = 0;
  }

  let firstRef = null;
  for (const e of parsed.entries) {
    const itemRef = context.register(context.obj({
      Title: PDFString.of(e.title),
      Parent: outlinesRef,
      Dest: context.obj([pages[e.pageIndex].ref, PDFName.of('Fit')])
    }));
    const item = context.lookup(itemRef);
    if (prevRef) {
      item.set(PDFName.of('Prev'), prevRef);
      context.lookup(prevRef).set(PDFName.of('Next'), itemRef);
    } else {
      firstRef = itemRef;
    }
    prevRef = itemRef;
  }
  if (firstRef) outlines.set(PDFName.of('First'), firstRef);
  outlines.set(PDFName.of('Last'), prevRef);
  outlines.set(PDFName.of('Count'), PDFNumber.of(baseCount + parsed.entries.length));

  const out = await doc.save();
  if (!out || out.length === 0) throw new Error('Bookmarks produced no output.');
  return Buffer.from(out);
}
