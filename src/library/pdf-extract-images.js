// src/library/pdf-extract-images.js — Standalone "Extract Images" utility (admin-only).
//
// Separate from the PDF Editor (pdf-editor.js), Merge, Unlock, Protect,
// Compress, Split and Images-to-PDF: this module is intentionally additive.
// It REUSES the editor's limits, gate and request-cap helpers but never
// changes existing behavior.
//
// Engine: pdf-lib's low-level object model (already installed — no new
// dependency, no page rasterization anywhere). Image XObjects are found by
// walking page resources (recursing into Form XObjects, deduplicated by
// object identity):
// - JPEG images (/DCTDecode) are returned byte-verbatim (native quality).
// - Other 8-bit RGB/grayscale images (raw or /FlateDecode, incl. ICCBased
//   and /Indexed color spaces) are decoded and re-encoded as PNG via
//   node:zlib (lossless).
// Documented non-goals: stencil masks (/ImageMask) and soft masks (/SMask)
// are skipped, not composited; JPEG-2000 (/JPXDecode), fax (/CCITTFaxDecode)
// and non-8-bit images are reported as skipped with a reason instead of
// failing the whole extraction.
//
// Semantics: pure + in-memory (no fs, no shell, no network, no binaries, no
// temp files). The input buffer is never mutated; outputs are NEW files.

import { deflateRawSync } from 'node:zlib';
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFNumber,
  PDFString,
  PDFHexString,
  PDFRef,
  PDFRawStream,
  decodePDFRawStream
} from 'pdf-lib';
import { buildZip } from './pdf-split.js';
import {
  isPdfEditorAvailable,
  isAllowedPdfInput,
  pdfEditorMaxRequestBytes,
  PDF_EDITOR_MAX_FILE_BYTES,
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from './pdf-editor.js';

// Editor-consistent limits so routes/tests share one source.
export const PDF_EXTRACT_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_BYTES;
export const PDF_EXTRACT_MAX_FILE_MB = PDF_EDITOR_MAX_FILE_MB;
export const PDF_EXTRACT_MAX_PAGES = PDF_EDITOR_MAX_PAGES;
// A single extract handles exactly one file; the editor's multi-file cap is
// intentionally NOT reused here (route enforces "exactly one").
// Safety bound on extracted objects (a 500-page catalog cannot hang the tool).
export const PDF_EXTRACT_MAX_IMAGES = 1000;

export function isPdfExtractImagesAvailable(env = process.env) {
  return isPdfEditorAvailable(env);
}

export function pdfExtractImagesMaxRequestBytes() {
  return pdfEditorMaxRequestBytes();
}

function fail(error) {
  return { ok: false, error };
}

// Validate the single uploaded file (pure; { name, size }).
export function validatePdfExtractImagesUpload(file) {
  if (!file) return fail('Upload one PDF file to extract images from.');
  if (!isAllowedPdfInput(String(file.name || ''))) {
    return fail(`"${String(file.name || 'unnamed').slice(0, 100)}" must be a .pdf file.`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return fail('PDF file is empty.');
  if (size > PDF_EXTRACT_MAX_FILE_BYTES) {
    return fail(`PDF file exceeds ${PDF_EXTRACT_MAX_FILE_MB} MB.`);
  }
  return { ok: true };
}

// Validate a 1-based image selection like "all" or "1,3" (pure). `total` is
// the extracted image count. Returns 0-based indexes in the given order.
export function validatePdfExtractImagesSelection(text, total) {
  if (typeof text !== 'string') return fail('Invalid selection.');
  const t = text.trim().toLowerCase();
  if (!Number.isInteger(total) || total < 0) return fail('Invalid image count.');
  if (t === '' || t === 'all') {
    if (total === 0) return fail('No images to select.');
    return { ok: true, indexes: Array.from({ length: total }, (_, i) => i) };
  }
  const indexes = [];
  const seen = new Set();
  for (const token of t.split(',')) {
    const part = token.trim();
    if (!/^\d+$/.test(part)) return fail(`Invalid selection "${part.slice(0, 40)}" — use image numbers like 1,3.`);
    const n = Number(part);
    if (n < 1 || n > total) return fail(`Image ${n} is out of range (found ${total}).`);
    if (seen.has(n)) return fail(`Duplicate image ${n} — list each image once.`);
    seen.add(n);
    indexes.push(n - 1);
  }
  if (indexes.length === 0) return fail('Select at least one image.');
  return { ok: true, indexes };
}

function sanitizeBase(originalName) {
  let base = String(originalName || 'document.pdf').split(/[\\/]/).pop() || 'document.pdf';
  base = base.replace(/\.pdf$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'document';
  return base.slice(0, 60);
}

// Output filenames (pure, header-safe, unique by construction).
export function extractedImageNames({ originalName, images }) {
  const base = sanitizeBase(originalName);
  const used = new Set();
  return images.map(img => {
    let name = `${base}-p${img.page}-img${img.index}.${img.format}`;
    let n = 1;
    while (used.has(name)) {
      n++;
      name = `${base}-p${img.page}-img${img.index}-${n}.${img.format}`;
    }
    used.add(name);
    return name;
  });
}

export function extractedZipName(originalName) {
  return `${sanitizeBase(originalName)}-images.zip`;
}

// --- embedded-image walk (pdf-lib object model, no rendering) ---

function pdfName(o) {
  return o instanceof PDFName ? o.toString() : null;
}

function pdfNum(o) {
  return o instanceof PDFNumber ? o.asNumber() : null;
}

function asDict(obj, context) {
  const o = obj instanceof PDFRef ? context.lookup(obj) : obj;
  if (o instanceof PDFDict) return { dict: o, stream: o };
  if (o && o.dict instanceof PDFDict) return { dict: o.dict, stream: o };
  return null;
}

function filterNames(dict) {
  const f = dict.get(PDFName.of('Filter'));
  if (f instanceof PDFName) return [f.toString()];
  if (f instanceof PDFArray) {
    return f.asArray().map(x => (x instanceof PDFName ? x.toString() : null)).filter(Boolean);
  }
  return [];
}

// Resolve a color space to { components } or { indexed, baseComponents,
// hival, lookupBytes } or null when unsupported.
function lookupBytesOf(obj, context) {
  const o = obj instanceof PDFRef ? context.lookup(obj) : obj;
  if (o && o.contents instanceof Uint8Array) return Buffer.from(o.contents);
  if (o && typeof o.value === 'string') return Buffer.from(o.value, 'latin1');
  if (o && o.value instanceof Uint8Array) return Buffer.from(o.value);
  return null;
}

function resolveColorSpace(csObj, context) {
  const cs = csObj instanceof PDFRef ? context.lookup(csObj) : csObj;
  if (cs instanceof PDFName) {
    const n = cs.toString();
    if (n === '/DeviceRGB') return { components: 3 };
    if (n === '/DeviceGray') return { components: 1 };
    if (n === '/DeviceCMYK') return { components: 4 };
    if (n === '/CalRGB') return { components: 3 };
    if (n === '/CalGray') return { components: 1 };
    return null;
  }
  // ICCBased profiles live in the referenced stream dict (/N components).
  const host = cs instanceof PDFDict ? cs : (cs && cs.dict instanceof PDFDict ? cs.dict : null);
  if (host) {
    const n = pdfNum(host.get(PDFName.of('N')));
    if (Number.isInteger(n) && n >= 1 && n <= 4) return { components: n };
  }
  if (cs instanceof PDFArray) {
    const arr = cs.asArray();
    const head = arr[0] instanceof PDFName ? arr[0].toString() : null;
    if (head === '/ICCBased' && arr.length >= 2) {
      // Array-wrapped ICC profile: [/ICCBased streamRef].
      return resolveColorSpace(arr[1], context);
    }
    if (head === '/Indexed' && arr.length >= 4) {
      const base = resolveColorSpace(arr[1], context);
      const hival = pdfNum(arr[2]);
      if (!base || base.components == null || !Number.isInteger(hival)) return null;
      const lookupBytes = lookupBytesOf(arr[3], context);
      if (!lookupBytes) return null;
      return { indexed: true, baseComponents: base.components, hival, lookupBytes };
    }
  }
  return null;
}

function crc32Table() {
  if (!crc32Table.t) {
    const t = (crc32Table.t = new Int32Array(256));
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
  }
  return crc32Table.t;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'latin1');
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  typeBuf.copy(head, 4);
  const table = crc32Table();
  let crc = -1;
  const upd = buf => { for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8); };
  upd(typeBuf);
  upd(data);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ -1) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}

// Encode raw 8-bit samples as PNG (lossless). Supports 1/3-component data
// (gray/RGB); caller expands Indexed palettes first.
export function encodePng(width, height, components, samples) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error('Invalid image dimensions.');
  }
  if (components !== 1 && components !== 3) throw new Error('Unsupported component count.');
  const rowLen = width * components;
  if (samples.length !== rowLen * height) throw new Error('Sample size mismatch.');
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0;
    Buffer.from(samples.subarray(y * rowLen, (y + 1) * rowLen)).copy(raw, y * (rowLen + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = components === 1 ? 0 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', Buffer.from(deflateRawSync(raw, { level: 6 }))),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function expandIndexed(samples, baseComponents, hival, lookupBytes) {
  const out = Buffer.alloc(samples.length * baseComponents);
  const stride = lookupBytes.length / (hival + 1);
  for (let i = 0; i < samples.length; i++) {
    const idx = Math.min(samples[i], hival);
    lookupBytes.copy(out, i * baseComponents, Math.floor(idx * stride), Math.floor(idx * stride) + baseComponents);
  }
  return out;
}

// Walk page resources (recursing into Form XObjects), deduplicated by object
// identity. Calls `visit({ dict, stream, page })` per image XObject.
function walkImages(doc, visit) {
  const context = doc.context;
  const seen = new Set();
  const walkDict = (dict, page) => {
    const r = asDict(dict.get(PDFName.of('XObject')), context);
    if (!r) return;
    for (const key of r.dict.keys()) {
      const entry = asDict(r.dict.get(key), context);
      if (!entry || seen.has(entry.stream)) continue;
      seen.add(entry.stream);
      const subtype = pdfName(entry.dict.get(PDFName.of('Subtype')));
      if (subtype === '/Form') {
        walkDict(entry.dict, page);
        continue;
      }
      if (subtype !== '/Image') continue;
      visit({ dict: entry.dict, stream: entry.stream, page });
    }
  };
  doc.getPages().forEach((page, i) => {
    const res = page.node.get(PDFName.of('Resources'));
    const resDict = res instanceof PDFRef ? context.lookup(res) : res;
    if (resDict instanceof PDFDict) walkDict(resDict, i + 1);
    else if (resDict && resDict.dict instanceof PDFDict) walkDict(resDict.dict, i + 1);
  });
}

// Extract embedded raster images.
// Resolves to `{ images: [{ index, page, width, height, format, sizeBytes,
// name, data }], skipped: [{ page, reason }] }`. `name` is filled by the
// caller via extractedImageNames (needs the original filename).
// Throws Error with a user-friendly message on unreadable/encrypted input.
// Never mutates `pdfBytes`.
export async function extractPdfImages(pdfBytes) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  const checkedFile = validatePdfExtractImagesUpload({ name: 'document.pdf', size: bytes.length });
  if (!checkedFile.ok) throw new Error(checkedFile.error);

  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (err) {
    if (/encrypted/i.test(err?.message || '')) {
      throw new Error('This PDF is password-protected. Unlock it before extracting images.');
    }
    throw new Error('PDF could not be read (not a valid PDF, corrupt or unsupported).');
  }
  const context = doc.context;
  const numPages = doc.getPageCount();
  if (numPages > PDF_EXTRACT_MAX_PAGES) {
    throw new Error(`Source PDF has ${numPages} pages (max ${PDF_EXTRACT_MAX_PAGES}).`);
  }

  const images = [];
  const skipped = [];
  const skip = (page, reason) => skipped.push({ page, reason });

  walkImages(doc, ({ dict, stream, page }) => {
    if (images.length + skipped.length >= PDF_EXTRACT_MAX_IMAGES) {
      skip(page, `image limit reached (${PDF_EXTRACT_MAX_IMAGES})`);
      return;
    }
    try {
      const mask = dict.get(PDFName.of('ImageMask'));
      if (mask && mask.toString() === 'true') {
        skip(page, 'stencil mask (not a standalone image)');
        return;
      }
      const width = pdfNum(dict.get(PDFName.of('Width')));
      const height = pdfNum(dict.get(PDFName.of('Height')));
      const bpc = pdfNum(dict.get(PDFName.of('BitsPerComponent')));
      if (!width || !height || width < 1 || height < 1 || width > 20000 || height > 20000) {
        skip(page, 'invalid dimensions');
        return;
      }
      const raw = stream && stream.contents instanceof Uint8Array
        ? Buffer.from(stream.contents)
        : null;
      if (!raw || raw.length === 0) {
        skip(page, 'empty image data');
        return;
      }
      const filters = filterNames(dict);
      // Native JPEG path: single DCTDecode filter -> verbatim bytes.
      if (filters.length === 1 && filters[0] === '/DCTDecode') {
        if (!(raw[0] === 0xFF && raw[1] === 0xD8)) {
          skip(page, 'unreadable JPEG data');
          return;
        }
        images.push({ index: images.length + 1, page, width, height, format: 'jpg', sizeBytes: raw.length, data: raw });
        return;
      }
      if (filters.some(f => f === '/JPXDecode')) {
        skip(page, 'JPEG-2000 images are not supported');
        return;
      }
      if (filters.some(f => f === '/CCITTFaxDecode')) {
        skip(page, 'fax-encoded images are not supported');
        return;
      }
      if (bpc !== 8) {
        skip(page, `only 8-bit images are supported (found ${bpc}-bit)`);
        return;
      }
      const cs = resolveColorSpace(dict.get(PDFName.of('ColorSpace')), context);
      if (!cs) {
        skip(page, 'unsupported color space');
        return;
      }
      let samples;
      try {
        const decoded = filters.length === 0 ? { contents: raw } : decodePDFRawStream(stream);
        samples = Buffer.from(decoded.contents);
      } catch {
        skip(page, 'could not decode image data');
        return;
      }
      let components = cs.components;
      let pixels = samples;
      if (cs.indexed) {
        if (cs.baseComponents !== 1 && cs.baseComponents !== 3) {
          skip(page, 'unsupported palette base');
          return;
        }
        if (samples.length !== width * height) {
          skip(page, 'sample size mismatch');
          return;
        }
        pixels = expandIndexed(samples, cs.baseComponents, cs.hival, cs.lookupBytes);
        components = cs.baseComponents;
      }
      if (components !== 1 && components !== 3) {
        skip(page, 'unsupported component count');
        return;
      }
      if (pixels.length !== width * height * components) {
        skip(page, 'sample size mismatch');
        return;
      }
      const png = encodePng(width, height, components, pixels);
      images.push({ index: images.length + 1, page, width, height, format: 'png', sizeBytes: png.length, data: png });
    } catch {
      skip(page, 'unreadable image object');
    }
  });

  return { images, skipped };
}

// Extract a 1-based index selection ("all" or "1,3") from a listing result.
// Returns the matching image entries in the given order.
export function selectExtractedImages(listing, selectionText) {
  const total = Array.isArray(listing?.images) ? listing.images.length : 0;
  const checked = validatePdfExtractImagesSelection(selectionText, total);
  if (!checked.ok) throw new Error(checked.error);
  return checked.indexes.map(i => listing.images[i]);
}

// Package selected images (already extracted) into a ZIP (pure).
export function zipExtractedImages(named) {
  const list = Array.isArray(named) ? named : [];
  if (list.length === 0) throw new Error('Select at least one image.');
  return buildZip(list.map(e => {
    if (!e || typeof e.name !== 'string' || !e.name) throw new Error('ZIP entry needs a name.');
    const data = Buffer.isBuffer(e.bytes) ? e.bytes : Buffer.from(e.bytes || []);
    if (data.length === 0) throw new Error(`ZIP entry "${e.name}" is empty.`);
    return { name: e.name, data };
  }));
}
