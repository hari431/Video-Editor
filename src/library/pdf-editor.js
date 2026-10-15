// src/library/pdf-editor.js — Local-only Admin/Owner PDF editor helpers.
//
// SCOPE: validation here is PURE (no fs, no network). Execution
// (renderPdfExport) runs pdf-lib fully in-process on caller-supplied byte
// buffers: no temp files, no shell, no external services, no Java/Docker.
// Library originals (queries/) are untouched by construction: inputs are
// uploaded bytes (or read-only bytes the caller fetched), output is a NEW
// in-memory PDF the caller streams back as a download.
//
// Coordinate convention (shared with the browser client):
// - Markup geometry uses fractions (0..1) of the DISPLAYED page (i.e. after
//   the page's rotation is applied, top-left origin), so the preview canvas
//   is WYSIWYG. The renderer inverse-maps them into unrotated PDF space
//   (displayedToUnrotated) before drawing; additions rotate WITH the page.
// - Spec shape (version 2; version 1 still accepted, without edits):
//     { version: 2,
//       files: [{ name }],
//       pages: [{ file, page (0-based), rotate (0|90|180|270),
//                 markups: [...], edits: [...] }],
//       pageNumbers: null | { start, position, margin, fontSize, color },
//       watermark: null | { text, fontSize, color, opacity, angle } }
// - Markup kinds: text | image | rect | ellipse | line | path.
//   Whiteout = rect fill #FFFFFF opacity 1 (opaque cover, NOT true redaction:
//   underlying bytes stay in the file). Highlight = rect fill #FFFF00 with
//   low opacity. Freehand = path (polyline segments).
// - Existing-text edits (cover-and-rewrite, never redaction): each edit
//   covers the original span box with the page background, then draws the
//   replacement with a matched standard font. Original bytes stay in the
//   file, exactly like whiteout.

import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { diffLineText } from '../public/pdf-editor-project.js';

export const PDF_INPUT_EXTENSIONS = new Set(['.pdf']);
export const PDF_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

export const PDF_EDITOR_MAX_FILES = 8;
export const PDF_EDITOR_MAX_FILE_MB = 50;
export const PDF_EDITOR_MAX_FILE_BYTES = PDF_EDITOR_MAX_FILE_MB * 1024 * 1024;
export const PDF_EDITOR_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const PDF_EDITOR_MAX_IMAGE_FILES = 8;
export const PDF_EDITOR_MAX_SPEC_BYTES = 100 * 1024;
export const PDF_EDITOR_MAX_PAGES = 500;
export const PDF_EDITOR_MAX_MARKUPS_PER_PAGE = 60;
export const PDF_EDITOR_MAX_TEXT_LEN = 500;
export const PDF_EDITOR_MAX_PATH_POINTS = 500;
export const PDF_EDITOR_MAX_EDITS_PER_PAGE = 60;
export const PDF_EDIT_FAMILIES = ['Helvetica', 'TimesRoman', 'Courier'];
export const PDF_EDIT_ALIGNMENTS = ['left', 'center', 'right'];

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ROTATIONS = new Set([0, 90, 180, 270]);
const MARKUP_KINDS = new Set(['text', 'image', 'rect', 'ellipse', 'line', 'path']);
const NUMBER_POSITIONS = new Set([
  'bottom-center', 'bottom-right', 'bottom-left',
  'top-center', 'top-right', 'top-left'
]);

// Local-only gate. Same semantics as the video editor: disabled in
// production or via explicit flag. Accepts an env-like object for tests.
export function isPdfEditorAvailable(env = process.env) {
  try {
    if (env && env.NODE_ENV === 'production') return false;
    if (env && env.PDF_EDITOR_ENABLED === 'false') return false;
    return true;
  } catch {
    return false;
  }
}

export function pdfInputExtension(filename) {
  if (typeof filename !== 'string') return '';
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return '';
  return filename.slice(dot).toLowerCase();
}

export function isAllowedPdfInput(filename) {
  return PDF_INPUT_EXTENSIONS.has(pdfInputExtension(filename));
}

export function isAllowedPdfImage(filename) {
  return PDF_IMAGE_EXTENSIONS.has(pdfInputExtension(filename));
}

// Worst-case buffered upload: max PDF files at the per-file cap each, max
// images, plus headroom for spec JSON and multipart framing. The route
// rejects oversized Content-Length before reading a byte.
export function pdfEditorMaxRequestBytes() {
  return (
    PDF_EDITOR_MAX_FILES * PDF_EDITOR_MAX_FILE_BYTES +
    PDF_EDITOR_MAX_IMAGE_FILES * PDF_EDITOR_MAX_IMAGE_BYTES +
    1024 * 1024
  );
}

export function normalizePdfColor(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  const m = t.match(HEX_COLOR_RE);
  if (!m) return null;
  let hex = m[1].toUpperCase();
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return `#${hex}`;
}

function hexToRgb01(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return rgb(r, g, b);
}

// Standard-font keys per family + style flags (the only fonts pdf-lib can
// embed without external font files).
const EDIT_FONT_KEYS = {
  Helvetica: { plain: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold, italic: StandardFonts.HelveticaOblique, boldItalic: StandardFonts.HelveticaBoldOblique },
  TimesRoman: { plain: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold, italic: StandardFonts.TimesRomanItalic, boldItalic: StandardFonts.TimesRomanBoldItalic },
  Courier: { plain: StandardFonts.Courier, bold: StandardFonts.CourierBold, italic: StandardFonts.CourierOblique, boldItalic: StandardFonts.CourierBoldOblique }
};

async function editFont(out, cache, family, bold, italic) {
  const table = EDIT_FONT_KEYS[family] || EDIT_FONT_KEYS.Helvetica;
  const key = family + (bold ? '+B' : '') + (italic ? '+I' : '');
  if (!cache.has(key)) {
    const face = bold && italic ? table.boldItalic : bold ? table.bold : italic ? table.italic : table.plain;
    cache.set(key, await out.embedFont(face));
  }
  return cache.get(key);
}

function fail(error) {
  return { ok: false, error };
}

function toFiniteNumber(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function round4(value) {
  return Math.round(value * 1e4) / 1e4;
}

function checkFrac(value, label, { min = 0, max = 1 } = {}) {
  const n = toFiniteNumber(value);
  if (n === null) return { error: `${label} must be a number.` };
  if (!(n >= min) || !(n <= max)) return { error: `${label} is out of range.` };
  return { value: round4(n) };
}

function checkColor(value, label) {
  const c = normalizePdfColor(value);
  if (!c) return { error: `${label} must be #RGB or #RRGGBB.` };
  return { value: c };
}

function checkOpacity(value, label) {
  const r = checkFrac(value, label, { min: 0, max: 1 });
  if (r.error) return { error: r.error };
  return r;
}

// Inverse-map a DISPLAYED-space fraction point into UNROTATED page space.
// Displayed = unrotated rotated clockwise by `rotate` (PDF /Rotate semantics,
// same direction pdf.js renders). Returns [x, y] fractions.
export function displayedToUnrotated(x, y, rotate) {
  const r = ((Number(rotate) % 360) + 360) % 360;
  if (r === 90) return [round4(1 - y), round4(x)];
  if (r === 180) return [round4(1 - x), round4(1 - y)];
  if (r === 270) return [round4(y), round4(1 - x)];
  return [round4(x), round4(y)];
}

function checkMarkup(raw, label, imageCount) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${label} must be an object.` };
  if (!MARKUP_KINDS.has(raw.kind)) {
    return { error: `${label}.kind must be one of: text, image, rect, ellipse, line, path.` };
  }
  const kind = raw.kind;
  if (kind === 'text') {
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (!text.trim() || text.length > PDF_EDITOR_MAX_TEXT_LEN) {
      return { error: `${label}.text must be 1–${PDF_EDITOR_MAX_TEXT_LEN} characters.` };
    }
    const x = checkFrac(raw.x, `${label}.x`); if (x.error) return { error: x.error };
    const y = checkFrac(raw.y, `${label}.y`); if (y.error) return { error: y.error };
    const size = checkFrac(raw.size, `${label}.size`, { min: 0.01, max: 0.4 });
    if (size.error) return { error: `${label}.size must be between 0.01 and 0.4.` };
    const color = checkColor(raw.color, `${label}.color`); if (color.error) return { error: color.error };
    const align = raw.align === undefined || raw.align === null ? 'left' : String(raw.align);
    if (!['left', 'center', 'right'].includes(align)) return { error: `${label}.align must be left, center or right.` };
    const opacity = raw.opacity === undefined || raw.opacity === null ? 1 : toFiniteNumber(raw.opacity);
    if (opacity === null || opacity < 0 || opacity > 1) return { error: `${label}.opacity must be between 0 and 1.` };
    return { markup: { kind, text, x: x.value, y: y.value, size: size.value, color: color.value, align, opacity: Math.round(opacity * 1000) / 1000 } };
  }
  if (kind === 'image') {
    const x = checkFrac(raw.x, `${label}.x`); if (x.error) return { error: x.error };
    const y = checkFrac(raw.y, `${label}.y`); if (y.error) return { error: y.error };
    const w = checkFrac(raw.w, `${label}.w`, { min: 0.01, max: 1 });
    if (w.error) return { error: `${label}.w must be between 0.01 and 1.` };
    const file = toFiniteNumber(raw.file);
    if (!Number.isInteger(file) || file < 0 || file >= imageCount) {
      return { error: `${label}.file must be an uploaded image index.` };
    }
    const opacity = raw.opacity === undefined || raw.opacity === null ? 1 : toFiniteNumber(raw.opacity);
    if (opacity === null || opacity < 0 || opacity > 1) return { error: `${label}.opacity must be between 0 and 1.` };
    return { markup: { kind, x: x.value, y: y.value, w: w.value, file, opacity: Math.round(opacity * 1000) / 1000 } };
  }
  if (kind === 'rect' || kind === 'ellipse') {
    const x = checkFrac(raw.x, `${label}.x`); if (x.error) return { error: x.error };
    const y = checkFrac(raw.y, `${label}.y`); if (y.error) return { error: y.error };
    const w = checkFrac(raw.w, `${label}.w`, { min: 0.005, max: 1 });
    if (w.error) return { error: `${label}.w must be between 0.005 and 1.` };
    const h = checkFrac(raw.h, `${label}.h`, { min: 0.005, max: 1 });
    if (h.error) return { error: `${label}.h must be between 0.005 and 1.` };
    let fill = null;
    if (raw.fill !== null && raw.fill !== undefined && String(raw.fill).trim() !== '') {
      const c = checkColor(raw.fill, `${label}.fill`); if (c.error) return { error: c.error };
      fill = c.value;
    }
    const fillOpacity = raw.fillOpacity === undefined || raw.fillOpacity === null ? 1 : toFiniteNumber(raw.fillOpacity);
    if (fillOpacity === null || fillOpacity < 0 || fillOpacity > 1) return { error: `${label}.fillOpacity must be between 0 and 1.` };
    let stroke = null;
    if (raw.stroke !== null && raw.stroke !== undefined && String(raw.stroke).trim() !== '') {
      const c = checkColor(raw.stroke, `${label}.stroke`); if (c.error) return { error: c.error };
      stroke = c.value;
    }
    const sw = raw.strokeWidth === undefined || raw.strokeWidth === null ? 1 : toFiniteNumber(raw.strokeWidth);
    if (sw === null || sw < 0 || sw > 20) return { error: `${label}.strokeWidth must be between 0 and 20.` };
    if (!fill && !stroke) return { error: `${label} needs a fill and/or a stroke.` };
    return {
      markup: {
        kind, x: x.value, y: y.value, w: w.value, h: h.value, fill, stroke,
        fillOpacity: Math.round(fillOpacity * 1000) / 1000,
        strokeWidth: Math.round(sw * 100) / 100
      }
    };
  }
  if (kind === 'line') {
    const coords = {};
    for (const k of ['x1', 'y1', 'x2', 'y2']) {
      const r = checkFrac(raw[k], `${label}.${k}`);
      if (r.error) return { error: r.error };
      coords[k] = r.value;
    }
    const stroke = checkColor(raw.stroke === undefined || raw.stroke === null ? '#000000' : raw.stroke, `${label}.stroke`);
    if (stroke.error) return { error: stroke.error };
    const sw = raw.strokeWidth === undefined || raw.strokeWidth === null ? 2 : toFiniteNumber(raw.strokeWidth);
    if (sw === null || sw < 0.5 || sw > 20) return { error: `${label}.strokeWidth must be between 0.5 and 20.` };
    const opacity = raw.opacity === undefined || raw.opacity === null ? 1 : toFiniteNumber(raw.opacity);
    if (opacity === null || opacity < 0 || opacity > 1) return { error: `${label}.opacity must be between 0 and 1.` };
    return { markup: { kind, ...coords, stroke: stroke.value, strokeWidth: Math.round(sw * 100) / 100, opacity: Math.round(opacity * 1000) / 1000 } };
  }
  // kind === 'path' (freehand polyline)
  if (!Array.isArray(raw.points) || raw.points.length < 2 || raw.points.length > PDF_EDITOR_MAX_PATH_POINTS) {
    return { error: `${label}.points must be an array of 2–${PDF_EDITOR_MAX_PATH_POINTS} [x, y] pairs.` };
  }
  const points = [];
  for (let i = 0; i < raw.points.length; i++) {
    const p = raw.points[i];
    if (!Array.isArray(p) || p.length !== 2) return { error: `${label}.points[${i}] must be an [x, y] pair.` };
    const px = checkFrac(p[0], `${label}.points[${i}][0]`); if (px.error) return { error: px.error };
    const py = checkFrac(p[1], `${label}.points[${i}][1]`); if (py.error) return { error: py.error };
    points.push([px.value, py.value]);
  }
  const stroke = checkColor(raw.stroke === undefined || raw.stroke === null ? '#000000' : raw.stroke, `${label}.stroke`);
  if (stroke.error) return { error: stroke.error };
  const sw = raw.strokeWidth === undefined || raw.strokeWidth === null ? 2 : toFiniteNumber(raw.strokeWidth);
  if (sw === null || sw < 0.5 || sw > 20) return { error: `${label}.strokeWidth must be between 0.5 and 20.` };
  const opacity = raw.opacity === undefined || raw.opacity === null ? 1 : toFiniteNumber(raw.opacity);
  if (opacity === null || opacity < 0 || opacity > 1) return { error: `${label}.opacity must be between 0 and 1.` };
  return { markup: { kind, points, stroke: stroke.value, strokeWidth: Math.round(sw * 100) / 100, opacity: Math.round(opacity * 1000) / 1000 } };
}

// Validate one existing-text edit (cover-and-rewrite). Displayed-space box
// fractions like markups; single-line replacement text only.
function checkEdit(raw, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${label} must be an object.` };
  const boxRaw = raw.box;
  if (!boxRaw || typeof boxRaw !== 'object' || Array.isArray(boxRaw)) return { error: `${label}.box must be an object.` };
  const box = {};
  for (const k of ['x', 'y']) {
    const r = checkFrac(boxRaw[k], `${label}.box.${k}`);
    if (r.error) return { error: r.error };
    box[k] = r.value;
  }
  for (const k of ['w', 'h']) {
    const r = checkFrac(boxRaw[k], `${label}.box.${k}`, { min: 0.005, max: 1 });
    if (r.error) return { error: r.error };
    box[k] = r.value;
  }
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!text.trim() || text.length > 500 || /[\r\n]/.test(text)) {
    return { error: `${label}.text must be a single line of 1–500 characters.` };
  }
  const font = raw.font === undefined || raw.font === null ? 'Helvetica' : String(raw.font);
  if (!PDF_EDIT_FAMILIES.includes(font)) return { error: `${label}.font must be Helvetica, TimesRoman or Courier.` };
  const bold = raw.bold === undefined || raw.bold === null ? false : !!raw.bold;
  const italic = raw.italic === undefined || raw.italic === null ? false : !!raw.italic;
  const size = checkFrac(raw.size === undefined || raw.size === null ? 0.04 : raw.size, `${label}.size`, { min: 0.01, max: 0.4 });
  if (size.error) return { error: `${label}.size must be between 0.01 and 0.4.` };
  const color = checkColor(raw.color === undefined || raw.color === null ? '#000000' : raw.color, `${label}.color`);
  if (color.error) return { error: color.error };
  const align = raw.align === undefined || raw.align === null ? 'left' : String(raw.align);
  if (!PDF_EDIT_ALIGNMENTS.includes(align)) return { error: `${label}.align must be left, center or right.` };
  let bg = null;
  if (raw.bg !== null && raw.bg !== undefined && String(raw.bg).trim() !== '') {
    bg = normalizePdfColor(raw.bg);
    if (!bg) return { error: `${label}.bg must be #RGB or #RRGGBB.` };
  }
  const fitScale = raw.fitScale === undefined || raw.fitScale === null ? 1 : toFiniteNumber(raw.fitScale);
  if (fitScale === null || fitScale < 0.05 || fitScale > 1) {
    return { error: `${label}.fitScale must be between 0.05 and 1.` };
  }
  return {
    edit: {
      box, text, font, bold, italic, size: size.value, color: color.value, align,
      bg, fitScale: Math.round(fitScale * 1000) / 1000
    }
  };
}

// Validate a raw edit spec (parsed JSON) into a normalized spec. Pure.
export function validatePdfEditSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Invalid PDF edit spec.');
  if (raw.version !== undefined && raw.version !== null && raw.version !== 1 && raw.version !== 2) {
    return fail('Unsupported PDF spec version.');
  }
  const filesRaw = raw.files;
  if (!Array.isArray(filesRaw) || filesRaw.length < 1 || filesRaw.length > PDF_EDITOR_MAX_FILES) {
    return fail(`files must be an array of 1–${PDF_EDITOR_MAX_FILES} entries.`);
  }
  const files = filesRaw.map(f => ({ name: String((f && f.name) || 'document.pdf').slice(0, 200) }));

  const imagesRaw = Array.isArray(raw.images) ? raw.images : [];
  if (imagesRaw.length > PDF_EDITOR_MAX_IMAGE_FILES) return fail(`At most ${PDF_EDITOR_MAX_IMAGE_FILES} overlay images.`);
  const images = imagesRaw.map(im => ({ name: String((im && im.name) || 'image').slice(0, 200) }));
  const imageCount = images.length;

  const pagesRaw = raw.pages;
  if (!Array.isArray(pagesRaw) || pagesRaw.length < 1 || pagesRaw.length > PDF_EDITOR_MAX_PAGES) {
    return fail(`pages must be an array of 1–${PDF_EDITOR_MAX_PAGES} entries.`);
  }
  const pages = [];
  for (let i = 0; i < pagesRaw.length; i++) {
    const p = pagesRaw[i];
    const label = `pages[${i}]`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return fail(`${label} must be an object.`);
    const file = toFiniteNumber(p.file);
    if (!Number.isInteger(file) || file < 0 || file >= files.length) {
      return fail(`${label}.file must be an uploaded PDF index.`);
    }
    const page = toFiniteNumber(p.page);
    if (!Number.isInteger(page) || page < 0 || page >= PDF_EDITOR_MAX_PAGES) {
      return fail(`${label}.page must be a 0-based page index.`);
    }
    const rotate = p.rotate === undefined || p.rotate === null ? 0 : toFiniteNumber(p.rotate);
    if (!ROTATIONS.has(rotate)) return fail(`${label}.rotate must be one of 0, 90, 180, 270.`);
    const markupsRaw = p.markups === undefined || p.markups === null ? [] : p.markups;
    if (!Array.isArray(markupsRaw)) return fail(`${label}.markups must be an array.`);
    if (markupsRaw.length > PDF_EDITOR_MAX_MARKUPS_PER_PAGE) {
      return fail(`${label}: at most ${PDF_EDITOR_MAX_MARKUPS_PER_PAGE} markups per page.`);
    }
    const markups = [];
    for (let j = 0; j < markupsRaw.length; j++) {
      const r = checkMarkup(markupsRaw[j], `${label}.markups[${j}]`, imageCount);
      if (r.error) return fail(r.error);
      markups.push(r.markup);
    }
    const editsRaw = p.edits === undefined || p.edits === null ? [] : p.edits;
    if (!Array.isArray(editsRaw)) return fail(`${label}.edits must be an array.`);
    if (editsRaw.length > PDF_EDITOR_MAX_EDITS_PER_PAGE) {
      return fail(`${label}: at most ${PDF_EDITOR_MAX_EDITS_PER_PAGE} text edits per page.`);
    }
    const edits = [];
    for (let j = 0; j < editsRaw.length; j++) {
      const r = checkEdit(editsRaw[j], `${label}.edits[${j}]`);
      if (r.error) return fail(r.error);
      edits.push(r.edit);
    }
    pages.push({ file, page, rotate, markups, edits });
  }

  let pageNumbers = null;
  if (raw.pageNumbers !== null && raw.pageNumbers !== undefined) {
    const pn = raw.pageNumbers;
    if (typeof pn !== 'object' || Array.isArray(pn)) return fail('pageNumbers must be an object or null.');
    const start = pn.start === undefined || pn.start === null ? 1 : toFiniteNumber(pn.start);
    if (!Number.isInteger(start) || start < 1 || start > 100000) return fail('pageNumbers.start must be a positive integer.');
    const position = pn.position === undefined || pn.position === null ? 'bottom-center' : String(pn.position);
    if (!NUMBER_POSITIONS.has(position)) return fail('pageNumbers.position must be a corner or edge center.');
    const margin = pn.margin === undefined || pn.margin === null ? 0.04 : toFiniteNumber(pn.margin);
    if (margin === null || margin < 0 || margin > 0.25) return fail('pageNumbers.margin must be between 0 and 0.25.');
    const fontSize = pn.fontSize === undefined || pn.fontSize === null ? 11 : toFiniteNumber(pn.fontSize);
    if (fontSize === null || fontSize < 6 || fontSize > 48) return fail('pageNumbers.fontSize must be between 6 and 48pt.');
    const color = checkColor(pn.color === undefined || pn.color === null ? '#000000' : pn.color, 'pageNumbers.color');
    if (color.error) return fail(color.error);
    pageNumbers = { start, position, margin: round4(margin), fontSize: Math.round(fontSize * 10) / 10, color: color.value };
  }

  let watermark = null;
  if (raw.watermark !== null && raw.watermark !== undefined) {
    const wm = raw.watermark;
    if (typeof wm !== 'object' || Array.isArray(wm)) return fail('watermark must be an object or null.');
    const text = typeof wm.text === 'string' ? wm.text.trim() : '';
    if (!text || text.length > 200 || /[\r\n]/.test(text)) {
      return fail('watermark.text must be a single line of 1–200 characters.');
    }
    const fontSize = wm.fontSize === undefined || wm.fontSize === null ? 64 : toFiniteNumber(wm.fontSize);
    if (fontSize === null || fontSize < 12 || fontSize > 200) return fail('watermark.fontSize must be between 12 and 200pt.');
    const color = checkColor(wm.color === undefined || wm.color === null ? '#888888' : wm.color, 'watermark.color');
    if (color.error) return fail(color.error);
    const opacity = wm.opacity === undefined || wm.opacity === null ? 0.25 : toFiniteNumber(wm.opacity);
    if (opacity === null || opacity < 0 || opacity > 1) return fail('watermark.opacity must be between 0 and 1.');
    const angle = wm.angle === undefined || wm.angle === null ? -45 : toFiniteNumber(wm.angle);
    if (angle === null || angle < -90 || angle > 90) return fail('watermark.angle must be between -90 and 90.');
    watermark = {
      text, fontSize: Math.round(fontSize * 10) / 10, color: color.value,
      opacity: Math.round(opacity * 1000) / 1000, angle: Math.round(angle * 10) / 10
    };
  }

  return { ok: true, spec: { version: 2, files, images, pages, pageNumbers, watermark } };
}

function pngMagic(bytes) {
  return bytes.length > 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
}

function jpgMagic(bytes) {
  return bytes.length > 2 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
}

// Render the export: assemble + annotate pages with pdf-lib, fully
// in-memory. Inputs are never mutated (pdf-lib loads copies). Throws on
// invalid spec, unreadable/encrypted sources, or out-of-range page refs.
export async function renderPdfExport({ pdfBytesList, imageBytesList = [], spec }) {
  const checked = validatePdfEditSpec(spec);
  if (!checked.ok) throw new Error(checked.error);
  const s = checked.spec;
  if (!Array.isArray(pdfBytesList) || pdfBytesList.length !== s.files.length) {
    throw new Error('Uploaded PDF files do not match the project.');
  }
  const images = Array.isArray(imageBytesList) ? imageBytesList : [];

  const sources = [];
  for (let i = 0; i < pdfBytesList.length; i++) {
    const bytes = pdfBytesList[i];
    if (!bytes || bytes.length === 0) throw new Error(`PDF file ${i + 1} is empty.`);
    if (bytes.length > PDF_EDITOR_MAX_FILE_BYTES) {
      throw new Error(`PDF file ${i + 1} exceeds ${PDF_EDITOR_MAX_FILE_MB} MB.`);
    }
    let doc;
    try {
      doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
    } catch (err) {
      throw new Error(`PDF file ${i + 1} could not be read (corrupt or encrypted).`);
    }
    sources.push(doc);
  }
  for (const entry of s.pages) {
    if (entry.page >= sources[entry.file].getPageCount()) {
      throw new Error(`pages reference page ${entry.page + 1} of file ${entry.file + 1}, which has only ${sources[entry.file].getPageCount()} pages.`);
    }
  }

  const embeddedImages = [];
  for (let i = 0; i < images.length; i++) {
    const bytes = images[i];
    if (!bytes || bytes.length === 0) throw new Error(`Image ${i + 1} is empty.`);
    if (bytes.length > PDF_EDITOR_MAX_IMAGE_BYTES) throw new Error(`Image ${i + 1} exceeds 5 MB.`);
    embeddedImages.push(bytes);
  }

  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const fontBold = await out.embedFont(StandardFonts.HelveticaBold);
  const fontCache = new Map();

  const toPt = (frac, dim) => frac * dim;
  // Displayed-space fraction point -> unrotated PDF points on a W×H page.
  const toPage = (x, y, rotate, W, H) => {
    const [ux, uy] = displayedToUnrotated(x, y, rotate);
    return { x: toPt(ux, W), y: (1 - uy) * H };
  };

  for (let pi = 0; pi < s.pages.length; pi++) {
    const entry = s.pages[pi];
    const [copied] = await out.copyPages(sources[entry.file], [entry.page]);
    out.addPage(copied);
    const page = copied;
    if (entry.rotate) page.setRotation(degrees(entry.rotate));
    const { width: W, height: H } = page.getSize();

    // Existing-text edits first: cover the original span, then draw the
    // replacement (same vstretch as Add Text, so preview and export agree).
    // Original bytes stay in the file — this is cover-and-rewrite, never
    // redaction.
    for (const e of entry.edits || []) {
      const ea = toPage(e.box.x, e.box.y, entry.rotate, W, H);
      const eb = toPage(
        Math.min(1, e.box.x + e.box.w), Math.min(1, e.box.y + e.box.h), entry.rotate, W, H
      );
      const ex0 = Math.min(ea.x, eb.x);
      const ey0 = Math.min(ea.y, eb.y);
      const ewPt = Math.abs(eb.x - ea.x);
      const ehPt = Math.abs(eb.y - ea.y);
      
      const fontHeight = Math.max(1, ehPt);
      // Typographically accurate cover rectangle to perfectly mask descenders, ascenders and slants:
      // In PDF coordinates, y points UP. ey0 is the baseline of the box.
      // Therefore, to extend BELOW the baseline, we subtract 0.25 * fontHeight from ey0.
      const coverX = ex0 - 0.15 * fontHeight;
      const coverY = ey0 - 0.25 * fontHeight;
      const coverW = ewPt + 0.3 * fontHeight;
      const coverH = 1.35 * fontHeight;

      if (e.bg) {
        page.drawRectangle({
          x: coverX, y: coverY, width: Math.max(0.5, coverW), height: Math.max(0.5, coverH),
          color: hexToRgb01(e.bg), opacity: 1, borderWidth: 0
        });
      }
      const efont = await editFont(out, fontCache, e.font, e.bold, e.italic);
      const esizeOrig = Math.max(4, Math.min(288, e.size * H));

      const isFormattingEdit = (!e.text || !e.origText || e.text === e.origText);

      let scale = 1;
      if (!isFormattingEdit) {
        const tw = efont.widthOfTextAtSize(e.text, esizeOrig);
        const maxW = (0.85 - e.box.x) * W;
        if (tw > maxW) {
          scale = Math.min(1, maxW / tw);
        }
      }

      const esize = Math.max(4, Math.min(288, esizeOrig * scale));

      let tx = ex0;
      if (e.align === 'center') {
        const tw_final = efont.widthOfTextAtSize(e.text, esize);
        tx = ex0 + Math.max(0, (ewPt - tw_final) / 2);
      } else if (e.align === 'right') {
        const tw_final = efont.widthOfTextAtSize(e.text, esize);
        tx = ex0 + Math.max(0, ewPt - tw_final);
      }

      page.drawText(e.text, {
        x: tx,
        y: ey0,
        size: esize,
        font: efont,
        color: hexToRgb01(e.color || '#000000'),
        lineHeight: esize * 1.2
      });
    }

    for (const m of entry.markups) {
      if (m.kind === 'text') {
        const p = toPage(m.x, m.y, entry.rotate, W, H);
        const size = Math.max(4, Math.min(288, m.size * H));
        const lines = String(m.text).split('\n').slice(0, 20);
        const lineHeight = size * 1.2;
        lines.forEach((ln, li) => {
          page.drawText(ln, {
            x: p.x,
            y: p.y - size - li * lineHeight,
            size,
            font,
            color: hexToRgb01(m.color),
            opacity: m.opacity,
            lineHeight
          });
        });
      } else if (m.kind === 'image') {
        const needed = m.file;
        if (!Number.isInteger(needed) || needed < 0 || needed >= embeddedImages.length) {
          throw new Error('An image markup references an image that was not uploaded.');
        }
        const raw = embeddedImages[needed];
        const embedded = pngMagic(raw) ? await out.embedPng(raw)
          : jpgMagic(raw) ? await out.embedJpg(raw)
            : null;
        if (!embedded) throw new Error(`Image ${needed + 1} must be PNG or JPG.`);
        const p = toPage(m.x, m.y, entry.rotate, W, H);
        const wPt = Math.max(4, m.w * W);
        const hPt = (wPt * embedded.height) / embedded.width;
        page.drawImage(embedded, { x: p.x, y: p.y - hPt, width: wPt, height: hPt, opacity: m.opacity });
      } else if (m.kind === 'rect' || m.kind === 'ellipse') {
        const a = toPage(m.x, m.y, entry.rotate, W, H);
        const b = toPage(
          Math.min(1, m.x + m.w), Math.min(1, m.y + m.h), entry.rotate, W, H
        );
        const x0 = Math.min(a.x, b.x);
        const y0 = Math.min(a.y, b.y);
        const wPt = Math.abs(b.x - a.x);
        const hPt = Math.abs(b.y - a.y);
        const opts = {
          x: x0, y: y0, width: Math.max(0.5, wPt), height: Math.max(0.5, hPt),
          borderWidth: m.stroke ? Math.max(0.5, m.strokeWidth) : 0
        };
        if (m.fill) { opts.color = hexToRgb01(m.fill); opts.opacity = m.fillOpacity; }
        if (m.stroke) opts.borderColor = hexToRgb01(m.stroke);
        if (m.kind === 'rect') page.drawRectangle(opts);
        else {
          page.drawEllipse({
            x: x0 + wPt / 2, y: y0 + hPt / 2,
            xScale: Math.max(0.25, wPt / 2), yScale: Math.max(0.25, hPt / 2),
            color: opts.color, opacity: opts.opacity,
            borderColor: opts.borderColor, borderWidth: opts.borderWidth
          });
        }
      } else if (m.kind === 'line' || m.kind === 'path') {
        const pts = m.kind === 'line'
          ? [[m.x1, m.y1], [m.x2, m.y2]]
          : m.points;
        const color = hexToRgb01(m.stroke);
        for (let k = 0; k + 1 < pts.length; k++) {
          const a = toPage(pts[k][0], pts[k][1], entry.rotate, W, H);
          const b = toPage(pts[k + 1][0], pts[k + 1][1], entry.rotate, W, H);
          page.drawLine({
            start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y },
            thickness: Math.max(0.5, m.strokeWidth), color, opacity: m.opacity
          });
        }
      }
    }

    if (s.pageNumbers) {
      const pn = s.pageNumbers;
      const label = String(pn.start + pi);
      const size = pn.fontSize;
      const tw = fontBold.widthOfTextAtSize(label, size);
      const mPt = pn.margin * Math.min(W, H);
      let nx = W / 2 - tw / 2;
      let ny = mPt;
      if (pn.position.startsWith('top-')) ny = H - mPt - size;
      if (pn.position.endsWith('-right')) nx = W - mPt - tw;
      else if (pn.position.endsWith('-left')) nx = mPt;
      page.drawText(label, { x: nx, y: ny, size, font: fontBold, color: hexToRgb01(pn.color) });
    }

    if (s.watermark) {
      const wm = s.watermark;
      const tw = fontBold.widthOfTextAtSize(wm.text, wm.fontSize);
      page.drawText(wm.text, {
        x: W / 2 - tw / 2, y: H / 2 - wm.fontSize / 2,
        size: wm.fontSize, font: fontBold,
        color: hexToRgb01(wm.color), opacity: wm.opacity,
        rotate: degrees(wm.angle)
      });
    }
  }

  return out.save();
}
