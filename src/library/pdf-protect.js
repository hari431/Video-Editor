// src/library/pdf-protect.js — Standalone "Protect PDF" utility (admin-only).
//
// Separate from the PDF Editor (pdf-editor.js), Merge PDFs (pdf-merge.js) and
// Unlock PDF (pdf-unlock.js): this module is intentionally additive. It
// REUSES the editor's limits, gate and allowlist helpers but never changes
// editor/merge/unlock behavior.
//
// Engine: `pdfstudio` (qpdf 12.3.2 compiled to WebAssembly, Apache-2.0) performs
// genuine structural encryption — `lock(bytes, { userPassword })` applies
// AES-256 (owner password defaults to the user password) while preserving
// pages, images, vectors, annotations, forms, fonts and metadata. Validated by
// an isolated spike (15/15 checks: pdf-lib refuses the output, AESv3/256-bit
// confirmed, round-trip operator lists/text/annotations/metadata identical,
// inputs byte-unchanged).
//
// The supplied password is used for encryption only (never guessed,
// brute-forced, bypassed, recovered, logged or stored).
//
// Semantics: pure + in-memory (qpdf runs in a WASM heap; no fs, no shell, no
// network, no binaries, no temp files). The input buffer is never mutated
// (the engine receives a defensive copy); output is a NEW pdf.

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
export const PDF_PROTECT_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_PROTECT_MAX_FILE_MB = PDF_EDITOR_MAX_FILE_MB;
export const PDF_PROTECT_MAX_PAGES = PDF_EDITOR_MAX_PAGES;
// A single protect handles exactly one file; the editor's multi-file cap is
// intentionally NOT reused here (route enforces "exactly one").
export const PDF_PROTECT_MAX_PASSWORD_LEN = 1024;

export function isPdfProtectAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfProtectMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate the single uploaded file (pure; { name, size }).
export function validatePdfProtectUpload(file) {
  if (!file) return fail('Upload one PDF file to protect.');
  if (!isAllowedPdfInput(String(file.name || ''))) {
    return fail(`"${String(file.name || 'unnamed').slice(0, 100)}" must be a .pdf file.`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return fail('PDF file is empty.');
  if (size > PDF_PROTECT_MAX_FILE_BYTES) {
    return fail(`PDF file exceeds ${PDF_PROTECT_MAX_FILE_MB} MB.`);
  }
  return { ok: true };
}

// Validate the password pair (pure). A non-empty password is required (an
// empty user password would leave the file opening without a prompt);
// strength rules beyond that are intentionally left to the admin.
export function validatePdfProtectPasswords(password, confirmPassword) {
  if (password === undefined || password === null || password === '') {
    return fail('Enter a password to protect the PDF.');
  }
  if (typeof password !== 'string' || typeof confirmPassword !== 'string') {
    return fail('Password must be text.');
  }
  if (password.length > PDF_PROTECT_MAX_PASSWORD_LEN) {
    return fail(`Password must be at most ${PDF_PROTECT_MAX_PASSWORD_LEN} characters.`);
  }
  if (password !== confirmPassword) {
    return fail('Passwords do not match.');
  }
  return { ok: true, password };
}

// Build a safe download name `<original>-protected.pdf` (pure). Sanitized to
// header-safe characters so it can be used in Content-Disposition directly.
export function protectDownloadName(originalName) {
  let base = String(originalName || 'document.pdf').split(/[\\/]/).pop() || 'document.pdf';
  base = base.replace(/\.pdf$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'document';
  base = base.slice(0, 100);
  return `${base}-protected.pdf`;
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

// Protect with the user-supplied password (AES-256; owner password defaults
// to it). Returns a NEW genuinely encrypted PDF. Throws Error with a
// user-friendly message (never internal stack traces or passwords) on any
// failure. Never mutates `pdfBytes` (the engine receives a defensive copy).
export async function protectPdf(pdfBytes, password) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  const checkedFile = validatePdfProtectUpload({ name: 'document.pdf', size: bytes.length });
  if (!checkedFile.ok) throw new Error(checkedFile.error);
  const checkedPw = validatePdfProtectPasswords(password, password);
  if (!checkedPw.ok) throw new Error(checkedPw.error);
  const pw = checkedPw.password;

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
      throw new Error('This PDF is already password-protected.');
    }
    throw new Error('PDF could not be read (not a valid PDF, corrupt or unsupported).');
  }
  if (info?.encrypted) {
    throw new Error('This PDF is already password-protected.');
  }
  const numPages = info?.pageCount;
  if (!Number.isFinite(numPages) || numPages < 1) {
    throw new Error('Source PDF contains no pages.');
  }
  if (numPages > PDF_PROTECT_MAX_PAGES) {
    throw new Error(`Source PDF has ${numPages} pages (max ${PDF_PROTECT_MAX_PAGES}).`);
  }

  let out;
  try {
    out = await toolkit.lock(data, { userPassword: pw });
  } catch {
    throw new Error('Unable to protect PDF.');
  }
  if (!out || out.length === 0) throw new Error('Protection produced no output.');
  // Safety net: never hand back an unencrypted file as "protected".
  if (!(await toolkit.isEncrypted(out))) {
    throw new Error('Protection failed (output is not encrypted).');
  }
  return Buffer.from(out);
}
