// src/library/pdf-images.js — Standalone "Images to PDF" utility (admin-only).
//
// Separate from the PDF Editor (pdf-editor.js), Merge PDFs (pdf-merge.js),
// Unlock/Protect/Compress PDF and Split PDF: this module is intentionally
// additive. It REUSES the editor's image allowlist, image size/count limits,
// gate and request-cap helpers but never changes existing behavior.
//
// Engine: pdf-lib (`embedJpg`/`embedPng`) — already installed, no new
// dependency. JPEG bytes are embedded verbatim (DCTDecode passthrough, zero
// quality change); PNGs are embedded losslessly. Each image becomes one page
// in the caller-supplied (displayed) order.
//
// Two pdf-lib sharp edges handled here (both verified by spike):
// 1. `embedJpg`/`embedPng` read `bytes.buffer` directly, so Node Buffers
//    backed by the shared pool (non-zero byteOffset) misparse. Every image
//    is copied to a fresh zero-offset Uint8Array before embedding.
// 2. Extension/content mismatches and corrupt images raise per-file errors
//    naming the file — never a silent skip.
//
// Semantics: pure + in-memory (no fs, no shell, no network). Inputs are never
// mutated; output is a NEW pdf.

import { PDFDocument } from 'pdf-lib';
import {
  isPdfEditorAvailable,
  isAllowedPdfImage,
  pdfEditorMaxRequestBytes,
  PDF_EDITOR_MAX_IMAGE_BYTES,
  PDF_EDITOR_MAX_IMAGE_FILES
} from './pdf-editor.js';

// Editor-consistent limits so routes/tests share one source.
export const PDF_IMAGES_MAX_FILES = PDF_EDITOR_MAX_IMAGE_FILES;
export const PDF_IMAGES_MAX_FILE_BYTES = PDF_EDITOR_MAX_IMAGE_BYTES;
export const PDF_IMAGES_MAX_FILE_MB = PDF_EDITOR_MAX_IMAGE_BYTES / (1024 * 1024);
// A4 and US Letter in PDF points; `image` means one page per image at native
// pixel dimensions (1px = 1pt).
export const PDF_IMAGES_PAGE_SIZES = {
  A4: [595.28, 841.89],
  Letter: [612, 792]
};
export const PDF_IMAGES_PAGE_SIZE_NAMES = ['A4', 'Letter', 'image'];
export const PDF_IMAGES_ORIENTATIONS = ['portrait', 'landscape', 'auto'];
export const PDF_IMAGES_DEFAULT_PAGE_SIZE = 'A4';
export const PDF_IMAGES_DEFAULT_ORIENTATION = 'auto';
export const PDF_IMAGES_DEFAULT_MARGIN = 36;
export const PDF_IMAGES_MAX_MARGIN = 72;

export function isPdfImagesAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfImagesMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate the uploaded image list (pure; [{ name, size }]).
export function validatePdfImagesUpload(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return fail('Select at least one image (JPG or PNG).');
  }
  if (files.length > PDF_IMAGES_MAX_FILES) {
    return fail(`At most ${PDF_IMAGES_MAX_FILES} images per PDF.`);
  }
  for (let i = 0; i < files.length; i++) {
    const f = files[i] || {};
    if (!isAllowedPdfImage(String(f.name || ''))) {
      return fail(`File ${i + 1} ("${String(f.name || 'unnamed').slice(0, 100)}") must be a .jpg, .jpeg or .png image.`);
    }
    const size = Number(f.size);
    if (!Number.isFinite(size) || size <= 0) {
      return fail(`File ${i + 1} is empty.`);
    }
    if (size > PDF_IMAGES_MAX_FILE_BYTES) {
      return fail(`File ${i + 1} exceeds ${PDF_IMAGES_MAX_FILE_MB} MB.`);
    }
  }
  return { ok: true };
}

// Validate conversion options (pure). Margin is in PDF points.
export function validatePdfImagesOptions(opts = {}) {
  const pageSize = opts.pageSize === undefined || opts.pageSize === null || opts.pageSize === ''
    ? PDF_IMAGES_DEFAULT_PAGE_SIZE : String(opts.pageSize);
  if (!PDF_IMAGES_PAGE_SIZE_NAMES.includes(pageSize)) {
    return fail(`pageSize must be one of: ${PDF_IMAGES_PAGE_SIZE_NAMES.join(', ')}.`);
  }
  const orientation = opts.orientation === undefined || opts.orientation === null || opts.orientation === ''
    ? PDF_IMAGES_DEFAULT_ORIENTATION : String(opts.orientation);
  if (!PDF_IMAGES_ORIENTATIONS.includes(orientation)) {
    return fail(`orientation must be one of: ${PDF_IMAGES_ORIENTATIONS.join(', ')}.`);
  }
  let margin = opts.margin === undefined || opts.margin === null || opts.margin === ''
    ? PDF_IMAGES_DEFAULT_MARGIN : Number(opts.margin);
  if (!Number.isFinite(margin) || margin < 0 || margin > PDF_IMAGES_MAX_MARGIN) {
    return fail(`margin must be between 0 and ${PDF_IMAGES_MAX_MARGIN} points.`);
  }
  if (pageSize === 'image' && margin !== 0) {
    return fail('margin requires the A4 or Letter page size (image-size pages have no margins).');
  }
  return { ok: true, options: { pageSize, orientation, margin } };
}

// Detect image kind by magic bytes (pure). Returns 'jpg' | 'png' | null.
export function detectImageKind(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
  return null;
}

// Page geometry for one image (pure): fit inside the page minus margin,
// aspect ratio preserved, centered. Returns { pageW, pageH, x, y, w, h }.
export function fitImageToPage(imgW, imgH, pageSize, orientation, margin) {
  let base = PDF_IMAGES_PAGE_SIZES[pageSize] || [imgW, imgH];
  if (pageSize === 'image') base = [imgW, imgH];
  let [pageW, pageH] = base;
  if (orientation === 'portrait') {
    pageW = Math.min(base[0], base[1]);
    pageH = Math.max(base[0], base[1]);
  } else if (orientation === 'landscape') {
    pageW = Math.max(base[0], base[1]);
    pageH = Math.min(base[0], base[1]);
  } else if (pageSize !== 'image') {
    // auto: match the page to the image orientation.
    const landscapeImg = imgW > imgH;
    pageW = landscapeImg ? Math.max(base[0], base[1]) : Math.min(base[0], base[1]);
    pageH = landscapeImg ? Math.min(base[0], base[1]) : Math.max(base[0], base[1]);
  }
  const availW = pageW - 2 * margin;
  const availH = pageH - 2 * margin;
  if (!(availW > 0) || !(availH > 0)) {
    return { error: 'Margin is too large for the page size.' };
  }
  const scale = Math.min(availW / imgW, availH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return { pageW, pageH, x: (pageW - w) / 2, y: (pageH - h) / 2, w, h };
}

// Build a safe download name `<base>.pdf` from the first image's filename
// (pure). Sanitized to header-safe characters.
export function imagesDownloadName(firstName) {
  let base = String(firstName || 'images').split(/[\\/]/).pop() || 'images';
  base = base.replace(/\.(jpe?g|png)$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'images';
  return `${base.slice(0, 100)}.pdf`;
}

// Convert images to one PDF in the given (displayed) order.
// `images`: [{ bytes, name }]. `opts`: { pageSize, orientation, margin }.
// Resolves to Buffer. Throws Error with a user-friendly per-file message.
// Never mutates the inputs.
export async function imagesToPdf(images, opts = {}) {
  const list = Array.isArray(images) ? images : [];
  const checked = validatePdfImagesUpload(list.map(f => ({ name: f?.name, size: f?.bytes ? f.bytes.length : 0 })));
  if (!checked.ok) throw new Error(checked.error);
  const checkedOpts = validatePdfImagesOptions(opts);
  if (!checkedOpts.ok) throw new Error(checkedOpts.error);
  const { pageSize, orientation, margin } = checkedOpts.options;

  const out = await PDFDocument.create();
  for (let i = 0; i < list.length; i++) {
    const { bytes, name } = list[i] || {};
    const label = `"${String(name || `image ${i + 1}`).slice(0, 100)}"`;
    const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    if (raw.length === 0 || raw.length > PDF_IMAGES_MAX_FILE_BYTES) {
      throw new Error(`${label} is empty or exceeds ${PDF_IMAGES_MAX_FILE_MB} MB.`);
    }
    const kind = detectImageKind(raw);
    if (!kind) throw new Error(`${label} is not a readable JPG or PNG image.`);
    const ext = String(name || '').toLowerCase();
    const extKind = ext.endsWith('.png') ? 'png' : (ext.endsWith('.jpg') || ext.endsWith('.jpeg') ? 'jpg' : null);
    if (extKind && extKind !== kind) {
      throw new Error(`${label} extension does not match its content.`);
    }
    // Fresh zero-offset copy: pdf-lib reads `.buffer` directly, so pooled
    // Node Buffers misparse (notably JPEG headers).
    const data = new Uint8Array(raw.length);
    data.set(raw);
    let embedded;
    try {
      embedded = kind === 'jpg' ? await out.embedJpg(data) : await out.embedPng(data);
    } catch {
      throw new Error(`${label} could not be embedded (unsupported or corrupt image).`);
    }
    const geo = fitImageToPage(embedded.width, embedded.height, pageSize, orientation, margin);
    if (geo.error) throw new Error(geo.error);
    const page = out.addPage([geo.pageW, geo.pageH]);
    page.drawImage(embedded, { x: geo.x, y: geo.y, width: geo.w, height: geo.h });
  }
  const saved = await out.save();
  if (!saved || saved.length === 0) throw new Error('Conversion produced no output.');
  return Buffer.from(saved);
}
