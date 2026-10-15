// src/library/pdf-to-images.js — Standalone "PDF to Images" utility (admin-only).
//
// Separate from the PDF Editor (pdf-editor.js), Merge, Unlock, Protect,
// Compress, Split and Images-to-PDF: this module is intentionally additive.
// It REUSES the editor's limits, gate and request-cap helpers but never
// changes existing behavior.
//
// Architecture note (verified against the installed stack): rasterizing PDF
// pages requires a 2D canvas, which only exists in the browser — neither
// pdf-lib nor pdfjs-dist can render pixels in Node, and adding a native
// canvas runtime was deliberately avoided. Rendering therefore happens
// client-side with the already-vendored pdf.js (`getViewport({ scale })` +
// `page.render()` into a `<canvas>`, exported via `canvas.toBlob()`); the
// source PDF is never uploaded at all. This module validates the rendered
// uploads and packages multi-page results into a ZIP (reusing the split
// tool's dependency-free ZIP writer). All image bytes here are already
// raster output, so "quality" is decided client-side (PNG lossless;
// JPEG at fixed quality 0.92, stated in the UI).
//
// Semantics: pure + in-memory (no fs, no shell, no network, no binaries, no
// temp files). Inputs are never mutated.

import { buildZip } from './pdf-split.js';
import {
  isPdfEditorAvailable,
  pdfEditorMaxRequestBytes,
  PDF_EDITOR_MAX_FILE_BYTES,
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from './pdf-editor.js';

// One rendered page image per output; the page cap bounds the part count.
export const PDF_TO_IMAGES_MAX_PARTS = PDF_EDITOR_MAX_PAGES;
export const PDF_TO_IMAGES_MAX_PART_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_TO_IMAGES_MAX_PART_MB = PDF_EDITOR_MAX_FILE_MB;
// DoS guard on raster dimensions (a 500-page A4 document at 3x is ~1800x2500;
// this cap is far above legitimate renders but stops gigapixel abuse).
export const PDF_TO_IMAGES_MAX_DIMENSION = 16000;
export const PDF_TO_IMAGES_FORMATS = ['png', 'jpeg'];
// Client render scales (1x = 72 DPI). Kept small: pixels grow quadratically.
export const PDF_TO_IMAGES_SCALES = [1, 1.5, 2, 3];
export const PDF_TO_IMAGES_DEFAULT_SCALE = 2;
export const PDF_TO_IMAGES_JPEG_QUALITY = 0.92;

export function isPdfToImagesAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfToImagesMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Detect raster kind by magic bytes (pure). Returns 'png' | 'jpeg' | null.
export function detectRasterKind(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';
  return null;
}

// Read raster dimensions without decoding pixels (pure; for the abuse guard).
// PNG: IHDR width/height. JPEG: first SOFn frame header. Returns
// { width, height } or null when unreadable.
export function rasterDimensions(bytes) {
  try {
    if (!bytes || bytes.length < 30) return null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
      const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
      let pos = 2;
      while (pos + 9 < bytes.length) {
        if (bytes[pos] !== 0xFF) return null;
        const marker = bytes[pos + 1];
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          const height = (bytes[pos + 5] << 8) | bytes[pos + 6];
          const width = (bytes[pos + 7] << 8) | bytes[pos + 8];
          if (width > 0 && height > 0) return { width, height };
          return null;
        }
        if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
          pos += 2;
          continue;
        }
        const len = (bytes[pos + 2] << 8) | bytes[pos + 3];
        if (len < 2) return null;
        pos += 2 + len;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// Validate one rendered upload (pure; { name, size, bytes? }). When bytes are
// supplied, kind and dimensions are enforced too.
export function validatePdfToImagesPart(part) {
  if (!part) return fail('Upload at least one rendered page image.');
  const size = Number(part.size);
  if (!Number.isFinite(size) || size <= 0) return fail(`"${String(part.name || 'page').slice(0, 100)}" is empty.`);
  if (size > PDF_TO_IMAGES_MAX_PART_BYTES) {
    return fail(`"${String(part.name || 'page').slice(0, 100)}" exceeds ${PDF_TO_IMAGES_MAX_PART_MB} MB.`);
  }
  if (part.bytes !== undefined && part.bytes !== null) {
    const bytes = Buffer.isBuffer(part.bytes) ? part.bytes : Buffer.from(part.bytes);
    const kind = detectRasterKind(bytes);
    if (kind !== 'png' && kind !== 'jpeg') {
      return fail(`"${String(part.name || 'page').slice(0, 100)}" is not a PNG or JPEG image.`);
    }
    const dims = rasterDimensions(bytes);
    if (!dims) return fail(`"${String(part.name || 'page').slice(0, 100)}" has unreadable dimensions.`);
    if (dims.width > PDF_TO_IMAGES_MAX_DIMENSION || dims.height > PDF_TO_IMAGES_MAX_DIMENSION) {
      return fail(`"${String(part.name || 'page').slice(0, 100)}" exceeds ${PDF_TO_IMAGES_MAX_DIMENSION}px (re-render at a lower scale).`);
    }
  }
  return { ok: true };
}

// Validate the whole rendered set (pure; [{ name, size, bytes? }]).
export function validatePdfToImagesUpload(parts) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return fail('Upload at least one rendered page image.');
  }
  if (parts.length > PDF_TO_IMAGES_MAX_PARTS) {
    return fail(`At most ${PDF_TO_IMAGES_MAX_PARTS} page images per ZIP.`);
  }
  for (const part of parts) {
    const checked = validatePdfToImagesPart(part);
    if (!checked.ok) return checked;
  }
  return { ok: true };
}

export function validatePdfToImagesFormat(format) {
  if (format === undefined || format === null || format === '') {
    return { ok: true, format: 'png' };
  }
  if (typeof format !== 'string' || !PDF_TO_IMAGES_FORMATS.includes(format)) {
    return fail(`format must be one of: ${PDF_TO_IMAGES_FORMATS.join(', ')}.`);
  }
  return { ok: true, format };
}

export function validatePdfToImagesScale(scale) {
  if (scale === undefined || scale === null || scale === '') {
    return { ok: true, scale: PDF_TO_IMAGES_DEFAULT_SCALE };
  }
  const n = typeof scale === 'string' && scale.trim() !== '' ? Number(scale) : scale;
  if (!PDF_TO_IMAGES_SCALES.includes(n)) {
    return fail(`scale must be one of: ${PDF_TO_IMAGES_SCALES.join(', ')}.`);
  }
  return { ok: true, scale: n };
}

// Parse a 1-based page selection like "1-3,5,8-10" against a document with
// `pageCount` pages. Returns 1-based page numbers in the GIVEN order (the
// client renders in this order; the server receives them in order).
// Strict: empty tokens, non-numeric parts, reversed ranges, out-of-range
// pages and duplicates are all rejected with a specific message. Mirrored by
// the client-side pre-check (the server re-validates everything it receives).
export function parseImageSelection(text, pageCount) {
  if (typeof text !== 'string' || text.trim() === '') {
    return fail('Enter pages to render, e.g. 1-3,5,8-10.');
  }
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return fail('Invalid page count.');
  }
  const pages = [];
  const seen = new Set();
  const tokens = text.split(',');
  for (let ti = 0; ti < tokens.length; ti++) {
    const token = tokens[ti].trim();
    if (token === '') return fail(`Empty entry in pages (near comma ${ti + 1}).`);
    const range = token.split('-').map(s => s.trim());
    if (range.length > 2 || range.some(s => s === '')) {
      return fail(`Invalid pages entry "${token.slice(0, 40)}". Use numbers like 5 or ranges like 1-3.`);
    }
    const nums = [];
    for (const part of range) {
      if (!/^\d+$/.test(part)) {
        return fail(`Invalid page "${part.slice(0, 40)}" — pages are positive numbers.`);
      }
      nums.push(Number(part));
    }
    const from = nums[0];
    const to = nums.length === 2 ? nums[1] : nums[0];
    if (nums.length === 2 && to < from) {
      return fail(`Reversed range "${token.slice(0, 40)}" — write the lower page first.`);
    }
    for (let p = from; p <= to; p++) {
      if (p < 1 || p > pageCount) {
        return fail(`Page ${p} is out of range (this PDF has ${pageCount} pages).`);
      }
      if (seen.has(p)) return fail(`Duplicate page ${p} — list each page once.`);
      seen.add(p);
      pages.push(p);
    }
    if (pages.length > PDF_TO_IMAGES_MAX_PARTS) {
      return fail(`Too many pages selected (max ${PDF_TO_IMAGES_MAX_PARTS}).`);
    }
  }
  if (pages.length === 0) return fail('Enter pages to render, e.g. 1-3,5,8-10.');
  return { ok: true, pages };
}

function sanitizeBase(originalName) {
  let base = String(originalName || 'document').split(/[\\/]/).pop() || 'document';
  base = base.replace(/\.(pdf|png|jpe?g)$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'document';
  return base.slice(0, 80);
}

// Output filenames (pure, header-safe).
export function renderedPartNames({ originalName, format, pages }) {
  const base = sanitizeBase(originalName);
  const pad = Math.max(2, String(pages.length).length);
  return pages.map((p, i) => `${base}-p${String(p).padStart(pad, '0')}.${format}`);
}

export function renderedZipName(originalName) {
  return `${sanitizeBase(originalName)}-images.zip`;
}

// Package rendered page images (already validated) into a ZIP (pure).
// `parts`: [{ name, bytes }]. Returns Buffer. Throws on empty input.
export function zipRenderedImages(parts) {
  const list = (Array.isArray(parts) ? parts : []).map(p => ({
    name: p?.name,
    size: p?.size ?? (p?.bytes ? p.bytes.length : 0),
    bytes: p?.bytes
  }));
  const checked = validatePdfToImagesUpload(list);
  if (!checked.ok) throw new Error(checked.error);
  return buildZip(list.map(p => ({
    name: String(p.name),
    data: Buffer.isBuffer(p.bytes) ? p.bytes : Buffer.from(p.bytes || [])
  })));
}
