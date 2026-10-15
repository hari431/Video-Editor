// src/library/pdf-sign.js — Standalone "Sign PDF" utility (admin-only).
//
// Separate from all other PDF tools: intentionally additive. REUSES the
// editor's limits, gate and allowlist helpers plus the images tool's image
// validation, but never changes existing behavior.
//
// VISUAL SIGNATURES ONLY — this is NOT a cryptographic digital signature:
// no /Sig dictionaries, no ByteRange, no DocMDP, no certification. The
// signature image is drawn onto the page like a stamp. The UI, the API docs
// and the tests all state this explicitly (tests assert the output contains
// no digital-signature structures).
//
// Engine: pdf-lib (`embedPng`/`embedJpg` + `drawImage`) — already installed,
// no new dependency. JPEG bytes embed verbatim; PNGs losslessly. Images are
// copied to fresh zero-offset buffers first (pdf-lib reads `.buffer`
// directly, so pooled Node Buffers misparse).
//
// Semantics: pure + in-memory (no fs, no shell, no network, no binaries, no
// temp files). Inputs are never mutated; output is a NEW pdf.

import { PDFDocument } from 'pdf-lib';
import { detectImageKind, PDF_IMAGES_MAX_FILE_BYTES, PDF_IMAGES_MAX_FILE_MB } from './pdf-images.js';
import {
  isPdfEditorAvailable,
  isAllowedPdfInput,
  isAllowedPdfImage,
  pdfEditorMaxRequestBytes,
  PDF_EDITOR_MAX_FILE_BYTES,
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from './pdf-editor.js';

// Editor-consistent limits so routes/tests share one source.
export const PDF_SIGN_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_SIGN_MAX_FILE_MB = PDF_EDITOR_MAX_FILE_MB;
export const PDF_SIGN_MAX_PAGES = PDF_EDITOR_MAX_PAGES;
// A single job handles exactly one PDF plus one signature image.
export const PDF_SIGN_MAX_IMAGE_BYTES = PDF_IMAGES_MAX_FILE_BYTES;
export const PDF_SIGN_MAX_IMAGE_MB = PDF_IMAGES_MAX_FILE_MB;
export const PDF_SIGN_POSITIONS = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right'
];
export const PDF_SIGN_DEFAULT_POSITION = 'bottom-right';
export const PDF_SIGN_MIN_WIDTH = 20;
export const PDF_SIGN_MAX_WIDTH = 400;
export const PDF_SIGN_DEFAULT_WIDTH = 150;
export const PDF_SIGN_MARGIN = 36;

export function isPdfSignAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfSignMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate the two uploads (pure; { pdf: {name,size}, image: {name,size} }).
export function validatePdfSignUpload(files) {
  if (!files || !files.pdf) return fail('Upload one PDF file to sign.');
  if (!files.image) return fail('Upload one signature image (PNG or JPG).');
  if (!isAllowedPdfInput(String(files.pdf.name || ''))) {
    return fail(`"${String(files.pdf.name || 'unnamed').slice(0, 100)}" must be a .pdf file.`);
  }
  const pdfSize = Number(files.pdf.size);
  if (!Number.isFinite(pdfSize) || pdfSize <= 0) return fail('PDF file is empty.');
  if (pdfSize > PDF_SIGN_MAX_FILE_BYTES) {
    return fail(`PDF file exceeds ${PDF_SIGN_MAX_FILE_MB} MB.`);
  }
  if (!isAllowedPdfImage(String(files.image.name || ''))) {
    return fail(`"${String(files.image.name || 'unnamed').slice(0, 100)}" must be a .png, .jpg or .jpeg image.`);
  }
  const imgSize = Number(files.image.size);
  if (!Number.isFinite(imgSize) || imgSize <= 0) return fail('Signature image is empty.');
  if (imgSize > PDF_SIGN_MAX_IMAGE_BYTES) {
    return fail(`Signature image exceeds ${PDF_SIGN_MAX_IMAGE_MB} MB.`);
  }
  return { ok: true };
}

// Validate placement options (pure).
export function validatePdfSignOptions(opts = {}) {
  const position = opts.position === undefined || opts.position === null || opts.position === ''
    ? PDF_SIGN_DEFAULT_POSITION : String(opts.position);
  if (!PDF_SIGN_POSITIONS.includes(position)) {
    return fail(`position must be one of: ${PDF_SIGN_POSITIONS.join(', ')}.`);
  }
  const widthRaw = opts.widthPt === undefined || opts.widthPt === null || opts.widthPt === '' ? PDF_SIGN_DEFAULT_WIDTH : Number(opts.widthPt);
  if (!Number.isFinite(widthRaw) || widthRaw < PDF_SIGN_MIN_WIDTH || widthRaw > PDF_SIGN_MAX_WIDTH) {
    return fail(`widthPt must be between ${PDF_SIGN_MIN_WIDTH} and ${PDF_SIGN_MAX_WIDTH} points.`);
  }
  const pageRaw = opts.page === undefined || opts.page === null || opts.page === '' ? 1 : Number(opts.page);
  if (!Number.isInteger(pageRaw) || pageRaw < 1) {
    return fail('page must be a positive page number.');
  }
  return { ok: true, options: { position, widthPt: widthRaw, page: pageRaw } };
}

// Compute placement for an image of aspect (w/h) on a W×H page (pure).
export function placeSignature(pageW, pageH, imgAspect, widthPt, position, margin = PDF_SIGN_MARGIN) {
  const w = Math.min(widthPt, pageW - 2 * margin);
  const h = w / imgAspect;
  const slots = {
    'top-left': [margin, pageH - margin - h],
    'top-center': [(pageW - w) / 2, pageH - margin - h],
    'top-right': [pageW - margin - w, pageH - margin - h],
    'middle-left': [margin, (pageH - h) / 2],
    'center': [(pageW - w) / 2, (pageH - h) / 2],
    'middle-right': [pageW - margin - w, (pageH - h) / 2],
    'bottom-left': [margin, margin],
    'bottom-center': [(pageW - w) / 2, margin],
    'bottom-right': [pageW - margin - w, margin]
  };
  const [x, y] = slots[position] || slots[PDF_SIGN_DEFAULT_POSITION];
  return { x, y, w, h };
}

// Build a safe download name `<original>-signed.pdf` (pure). The UI and docs
// state everywhere that this is a visual signature, not a digital one.
export function signDownloadName(originalName) {
  let base = String(originalName || 'document.pdf').split(/[\\/]/).pop() || 'document.pdf';
  base = base.replace(/\.pdf$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'document';
  return `${base.slice(0, 80)}-signed.pdf`;
}

// Stamp a signature image onto one page (visual only — see module header).
// `files`: { pdf: { bytes, name }, image: { bytes, name } }.
// `opts`: { position, widthPt, page (1-based) }. Resolves to Buffer.
// Throws user-friendly errors. Never mutates inputs.
export async function signPdf(files, opts = {}) {
  const pdfBytes = Buffer.isBuffer(files?.pdf?.bytes) ? files.pdf.bytes : Buffer.from(files?.pdf?.bytes || []);
  const imgBytes = Buffer.isBuffer(files?.image?.bytes) ? files.image.bytes : Buffer.from(files?.image?.bytes || []);
  const checkedFiles = validatePdfSignUpload({
    pdf: { name: files?.pdf?.name, size: pdfBytes.length },
    image: { name: files?.image?.name, size: imgBytes.length }
  });
  if (!checkedFiles.ok) throw new Error(checkedFiles.error);
  const checkedOpts = validatePdfSignOptions(opts);
  if (!checkedOpts.ok) throw new Error(checkedOpts.error);
  const { position, widthPt, page } = checkedOpts.options;

  const kind = detectImageKind(imgBytes);
  if (!kind) throw new Error('Signature image is not a readable PNG or JPG image.');
  const ext = String(files?.image?.name || '').toLowerCase();
  const extKind = ext.endsWith('.png') ? 'png' : (ext.endsWith('.jpg') || ext.endsWith('.jpeg') ? 'jpg' : null);
  if (extKind && extKind !== kind) {
    throw new Error('Signature image extension does not match its content.');
  }

  let doc;
  try {
    doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
  } catch (err) {
    if (/encrypted/i.test(err?.message || '')) {
      throw new Error('This PDF is password-protected. Unlock it before signing.');
    }
    throw new Error('PDF could not be read (not a valid PDF, corrupt or unsupported).');
  }
  const pages = doc.getPages();
  if (pages.length > PDF_SIGN_MAX_PAGES) {
    throw new Error(`Source PDF has ${pages.length} pages (max ${PDF_SIGN_MAX_PAGES}).`);
  }
  if (page > pages.length) {
    throw new Error(`Page ${page} is out of range (this PDF has ${pages.length} pages).`);
  }

  // Fresh zero-offset copy: pdf-lib reads `.buffer` directly.
  const data = new Uint8Array(imgBytes.length);
  data.set(imgBytes);
  let embedded;
  try {
    embedded = kind === 'jpg' ? await doc.embedJpg(data) : await doc.embedPng(data);
  } catch {
    throw new Error('Signature image could not be embedded (unsupported or corrupt image).');
  }
  const target = pages[page - 1];
  const { width: W, height: H } = target.getSize();
  const geo = placeSignature(W, H, embedded.width / embedded.height, widthPt, position);
  if (!(geo.w > 0) || !(geo.h > 0)) throw new Error('Signature does not fit on the page.');
  target.drawImage(embedded, { x: geo.x, y: geo.y, width: geo.w, height: geo.h });

  const out = await doc.save();
  if (!out || out.length === 0) throw new Error('Signing produced no output.');
  return Buffer.from(out);
}
