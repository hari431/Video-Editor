// src/public/pdf-editor-project.js — Pure project model for the local
// Admin/Owner PDF editor. Zero DOM, zero dependencies, ESM so it runs both
// in the browser (ES module script) and under node:test.
//
// Model:
// - project.files: uploaded source PDFs [{ id, name, pageCount }]
// - project.pages: assembled OUTPUT pages in order
//   [{ id, file (fileId), page (1-based source page), rotate (0|90|180|270) }]
// - project.markups: content overlays bound to an output page id
//   [{ id, pageId, kind, ...geometry in DISPLAYED-space fractions (0..1,
//   top-left origin, matching the preview canvas and the export spec) }]
// - project.pageNumbers / project.watermark: export-time settings.
// Serialization (projectToSpec) maps fileIds to upload-order indices and
// 1-based pages to 0-based indices for src/library/pdf-editor.js.

export const PDF_PROJECT_MAX_FILES = 8;
export const PDF_PROJECT_MAX_PAGES = 500;
export const PDF_PROJECT_MAX_MARKUPS = 3000;
export const PDF_PROJECT_MAX_MARKUPS_PER_PAGE = 60;
export const PDF_PROJECT_MAX_TEXT_LEN = 500;
export const PDF_PROJECT_MAX_PATH_POINTS = 500;
export const PDF_PROJECT_MAX_EDITS = 3000;
export const PDF_PROJECT_MAX_EDITS_PER_PAGE = 60;
export const PDF_PROJECT_MAX_EDIT_LEN = 500;
export const PDF_EDIT_FAMILIES = ['Helvetica', 'TimesRoman', 'Courier'];
export const PDF_EDIT_ALIGNMENTS = ['left', 'center', 'right'];
export const PDF_UNDO_LIMIT = 50;

export const PDF_ROTATIONS = [0, 90, 180, 270];
export const PDF_MARKUP_KINDS = ['text', 'image', 'rect', 'ellipse', 'line', 'path'];
export const PDF_NUMBER_POSITIONS = [
  'bottom-center', 'bottom-right', 'bottom-left',
  'top-center', 'top-right', 'top-left'
];

let nextId = 1;

export function resetPdfProjectIds() {
  nextId = 1;
}

function newId(prefix) {
  return `${prefix}${nextId++}`;
}

function q4(value) {
  return Math.round(value * 1e4) / 1e4;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function createPdfProject() {
  return {
    version: 1,
    files: [],
    pages: [],
    markups: [],
    edits: [],
    pageNumbers: null,
    watermark: null,
    selectedPageId: null,
    selectedMarkupId: null,
    selectedEditId: null
  };
}

export function getPdfFile(project, id) {
  return project.files.find(f => f.id === id) || null;
}

export function getOutputPage(project, id) {
  return project.pages.find(p => p.id === id) || null;
}

export function getMarkup(project, id) {
  return project.markups.find(m => m.id === id) || null;
}

export function markupsForPage(project, pageId) {
  return project.markups.filter(m => m.pageId === pageId);
}

export function outputPageCount(project) {
  return project.pages.length;
}

// Register an uploaded source PDF. pageCount comes from the pdf.js probe in
// the browser. Returns the file entry.
export function addSourceFile(project, { name, pageCount }) {
  const count = num(pageCount);
  if (!Number.isInteger(count) || count < 1 || count > PDF_PROJECT_MAX_PAGES) {
    throw new Error('PDF page count must be 1–500.');
  }
  if (project.files.length >= PDF_PROJECT_MAX_FILES) {
    throw new Error(`Too many source PDFs (max ${PDF_PROJECT_MAX_FILES}).`);
  }
  const entry = {
    id: newId('f'),
    name: String(name || 'document.pdf').slice(0, 200),
    pageCount: count
  };
  project.files.push(entry);
  return entry;
}

// Append a 1-based inclusive source range as output pages (merge workflow).
// Returns the new output pages.
export function appendSourcePages(project, fileId, from = 1, to = null) {
  const file = getPdfFile(project, fileId);
  if (!file) throw new Error('Source PDF not found.');
  const lo = from === null || from === undefined ? 1 : Math.max(1, Math.floor(num(from, 1)));
  const hi = to === null || to === undefined ? file.pageCount : Math.min(file.pageCount, Math.floor(num(to, file.pageCount)));
  if (!(hi >= lo)) throw new Error('Invalid page range.');
  if (project.pages.length + (hi - lo + 1) > PDF_PROJECT_MAX_PAGES) {
    throw new Error(`Too many output pages (max ${PDF_PROJECT_MAX_PAGES}).`);
  }
  const added = [];
  for (let p = lo; p <= hi; p++) {
    const entry = { id: newId('p'), file: fileId, page: p, rotate: 0 };
    project.pages.push(entry);
    added.push(entry);
  }
  if (added.length) project.selectedPageId = added[0].id;
  return added;
}

export function moveOutputPage(project, id, newIndex) {
  const idx = project.pages.findIndex(p => p.id === id);
  if (idx === -1) throw new Error('Output page not found.');
  const clamped = Math.max(0, Math.min(project.pages.length - 1, Math.floor(num(newIndex, idx))));
  const [entry] = project.pages.splice(idx, 1);
  project.pages.splice(clamped, 0, entry);
  return entry;
}

export function removeOutputPage(project, id) {
  const idx = project.pages.findIndex(p => p.id === id);
  if (idx === -1) return false;
  project.pages.splice(idx, 1);
  project.markups = project.markups.filter(m => m.pageId !== id);
  project.edits = (project.edits || []).filter(e => e.pageId !== id);
  if (project.selectedPageId === id) project.selectedPageId = null;
  if (project.selectedMarkupId && !getMarkup(project, project.selectedMarkupId)) {
    project.selectedMarkupId = null;
  }
  if (project.selectedEditId && !getTextEdit(project, project.selectedEditId)) {
    project.selectedEditId = null;
  }
  return true;
}

// Duplicate an output page (with its markups and text edits) right after the
// original. Returns the new page entry.
export function duplicateOutputPage(project, id) {
  const src = getOutputPage(project, id);
  if (!src) throw new Error('Output page not found.');
  if (project.pages.length >= PDF_PROJECT_MAX_PAGES) {
    throw new Error(`Too many output pages (max ${PDF_PROJECT_MAX_PAGES}).`);
  }
  const copy = { ...src, id: newId('p') };
  const at = project.pages.findIndex(p => p.id === id);
  project.pages.splice(at + 1, 0, copy);
  for (const m of markupsForPage(project, id)) {
    project.markups.push({ ...m, id: newId('m'), pageId: copy.id });
  }
  for (const e of editsForPage(project, id)) {
    project.edits.push({ ...e, box: { ...e.box }, id: newId('e'), pageId: copy.id });
  }
  project.selectedPageId = copy.id;
  return copy;
}

// Extract (copy) output pages by id into a fresh project sharing the same
// file registry entries. The source project is unchanged (split workflow).
export function extractPagesToProject(project, pageIds) {
  if (!Array.isArray(pageIds) || pageIds.length === 0) throw new Error('Select at least one page.');
  const next = createPdfProject();
  for (const f of project.files) next.files.push({ ...f });
  for (const pid of pageIds) {
    const src = getOutputPage(project, pid);
    if (!src) throw new Error('Output page not found.');
    const copy = { ...src, id: newId('p') };
    next.pages.push(copy);
    for (const m of markupsForPage(project, pid)) {
      next.markups.push({ ...m, id: newId('m'), pageId: copy.id });
    }
    for (const e of editsForPage(project, pid)) {
      next.edits.push({ ...e, box: { ...e.box }, id: newId('e'), pageId: copy.id });
    }
  }
  return next;
}

export function rotateOutputPage(project, id) {
  const entry = getOutputPage(project, id);
  if (!entry) throw new Error('Output page not found.');
  const i = PDF_ROTATIONS.indexOf(entry.rotate);
  entry.rotate = PDF_ROTATIONS[(i + 1) % PDF_ROTATIONS.length];
  return entry;
}

export function setPageRotation(project, id, rotate) {
  const entry = getOutputPage(project, id);
  if (!entry) throw new Error('Output page not found.');
  if (!PDF_ROTATIONS.includes(rotate)) throw new Error('Rotation must be 0, 90, 180 or 270.');
  entry.rotate = rotate;
  return entry;
}

function checkFrac(value, label, min = 0, max = 1) {
  const n = num(value, NaN);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} must be ${min}–${max}.`);
  return q4(n);
}

function defaultMarkupProps(kind) {
  if (kind === 'text') {
    return { text: 'New text', x: 0.1, y: 0.1, size: 0.04, color: '#000000', align: 'left', opacity: 1 };
  }
  if (kind === 'image') return { x: 0.1, y: 0.1, w: 0.3, file: 0, opacity: 1 };
  if (kind === 'rect') {
    return { x: 0.1, y: 0.1, w: 0.3, h: 0.1, fill: '#FFFF00', fillOpacity: 0.35, stroke: null, strokeWidth: 0 };
  }
  if (kind === 'ellipse') {
    return { x: 0.1, y: 0.1, w: 0.3, h: 0.2, fill: null, fillOpacity: 1, stroke: '#FF0000', strokeWidth: 2 };
  }
  if (kind === 'line') {
    return { x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.1, stroke: '#FF0000', strokeWidth: 2, opacity: 1 };
  }
  if (kind === 'path') {
    return { points: [[0.1, 0.1], [0.4, 0.4]], stroke: '#0000FF', strokeWidth: 2, opacity: 1 };
  }
  throw new Error(`Unknown markup kind: ${kind}.`);
}

// Add a content markup to an output page. Geometry is DISPLAYED-space
// fractions (top-left origin). Returns the markup.
export function addMarkup(project, pageId, kind, props = {}) {
  if (!PDF_MARKUP_KINDS.includes(kind)) throw new Error(`Unknown markup kind: ${kind}.`);
  const page = getOutputPage(project, pageId);
  if (!page) throw new Error('Output page not found.');
  if (project.markups.length >= PDF_PROJECT_MAX_MARKUPS) throw new Error('Too many markups.');
  if (markupsForPage(project, pageId).length >= PDF_PROJECT_MAX_MARKUPS_PER_PAGE) {
    throw new Error('Too many markups on this page.');
  }
  const markup = { id: newId('m'), pageId, kind, ...defaultMarkupProps(kind) };
  Object.assign(markup, sanitizeMarkupProps(kind, props));
  project.markups.push(markup);
  project.selectedMarkupId = markup.id;
  return markup;
}

// Validate + normalize caller-supplied markup props (partial allowed).
export function sanitizeMarkupProps(kind, props = {}) {
  const out = {};
  const has = k => props[k] !== undefined && props[k] !== null;
  if (kind === 'text') {
    if (has('text')) {
      const t = String(props.text);
      if (!t.trim() || t.length > PDF_PROJECT_MAX_TEXT_LEN) throw new Error('Text must be 1–500 characters.');
      out.text = t;
    }
    if (has('x')) out.x = checkFrac(props.x, 'x');
    if (has('y')) out.y = checkFrac(props.y, 'y');
    if (has('size')) {
      const n = num(props.size, NaN);
      if (!Number.isFinite(n) || n < 0.01 || n > 0.4) throw new Error('size must be 0.01–0.4.');
      out.size = q4(n);
    }
    if (has('color')) {
      if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(props.color))) throw new Error('color must be #RGB or #RRGGBB.');
      out.color = String(props.color).toUpperCase();
    }
    if (has('align')) {
      if (!['left', 'center', 'right'].includes(props.align)) throw new Error('align must be left, center or right.');
      out.align = props.align;
    }
    if (has('opacity')) out.opacity = checkFrac(props.opacity, 'opacity');
  } else if (kind === 'image') {
    if (has('x')) out.x = checkFrac(props.x, 'x');
    if (has('y')) out.y = checkFrac(props.y, 'y');
    if (has('w')) {
      const n = num(props.w, NaN);
      if (!Number.isFinite(n) || n < 0.01 || n > 1) throw new Error('w must be 0.01–1.');
      out.w = q4(n);
    }
    if (has('file')) {
      const n = num(props.file, NaN);
      if (!Number.isInteger(n) || n < 0) throw new Error('file must be an image index.');
      out.file = n;
    }
    if (has('opacity')) out.opacity = checkFrac(props.opacity, 'opacity');
  } else if (kind === 'rect' || kind === 'ellipse') {
    for (const k of ['x', 'y']) if (has(k)) out[k] = checkFrac(props[k], k);
    for (const k of ['w', 'h']) {
      if (has(k)) {
        const n = num(props[k], NaN);
        if (!Number.isFinite(n) || n < 0.005 || n > 1) throw new Error(`${k} must be 0.005–1.`);
        out[k] = q4(n);
      }
    }
    // NOTE: explicit null clears fill/stroke (outline-only shapes,
    // whiteout presets); only `undefined` keeps the current value. A plain
    // has() check would drop nulls and wrongly resurrect defaults.
    if ('fill' in props && props.fill !== undefined) {
      const v = props.fill;
      if (v === null || v === '') out.fill = null;
      else {
        if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(v))) throw new Error('fill must be #RGB or #RRGGBB.');
        out.fill = String(v).toUpperCase();
      }
    }
    if (has('fillOpacity')) out.fillOpacity = checkFrac(props.fillOpacity, 'fillOpacity');
    if ('stroke' in props && props.stroke !== undefined) {
      const v = props.stroke;
      if (v === null || v === '') out.stroke = null;
      else {
        if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(v))) throw new Error('stroke must be #RGB or #RRGGBB.');
        out.stroke = String(v).toUpperCase();
      }
    }
    if (has('strokeWidth')) {
      const n = num(props.strokeWidth, NaN);
      if (!Number.isFinite(n) || n < 0 || n > 20) throw new Error('strokeWidth must be 0–20.');
      out.strokeWidth = Math.round(n * 100) / 100;
    }
  } else if (kind === 'line') {
    for (const k of ['x1', 'y1', 'x2', 'y2']) if (has(k)) out[k] = checkFrac(props[k], k);
    if (has('stroke')) {
      if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(props.stroke))) throw new Error('stroke must be #RGB or #RRGGBB.');
      out.stroke = String(props.stroke).toUpperCase();
    }
    if (has('strokeWidth')) {
      const n = num(props.strokeWidth, NaN);
      if (!Number.isFinite(n) || n < 0.5 || n > 20) throw new Error('strokeWidth must be 0.5–20.');
      out.strokeWidth = Math.round(n * 100) / 100;
    }
    if (has('opacity')) out.opacity = checkFrac(props.opacity, 'opacity');
  } else if (kind === 'path') {
    if (has('points')) {
      if (!Array.isArray(props.points) || props.points.length < 2 || props.points.length > PDF_PROJECT_MAX_PATH_POINTS) {
        throw new Error(`points must have 2–${PDF_PROJECT_MAX_PATH_POINTS} entries.`);
      }
      out.points = props.points.map((p, i) => {
        if (!Array.isArray(p) || p.length !== 2) throw new Error(`points[${i}] must be an [x, y] pair.`);
        return [checkFrac(p[0], `points[${i}][0]`), checkFrac(p[1], `points[${i}][1]`)];
      });
    }
    if (has('stroke')) {
      if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(props.stroke))) throw new Error('stroke must be #RGB or #RRGGBB.');
      out.stroke = String(props.stroke).toUpperCase();
    }
    if (has('strokeWidth')) {
      const n = num(props.strokeWidth, NaN);
      if (!Number.isFinite(n) || n < 0.5 || n > 20) throw new Error('strokeWidth must be 0.5–20.');
      out.strokeWidth = Math.round(n * 100) / 100;
    }
    if (has('opacity')) out.opacity = checkFrac(props.opacity, 'opacity');
  }
  return out;
}

export function updateMarkup(project, id, props = {}) {
  const markup = getMarkup(project, id);
  if (!markup) throw new Error('Markup not found.');
  Object.assign(markup, sanitizeMarkupProps(markup.kind, props));
  return markup;
}

export function deleteMarkup(project, id) {
  const idx = project.markups.findIndex(m => m.id === id);
  if (idx === -1) return false;
  project.markups.splice(idx, 1);
  if (project.selectedMarkupId === id) project.selectedMarkupId = null;
  return true;
}

export function setPageNumbers(project, settings) {
  if (settings === null || settings === undefined) {
    project.pageNumbers = null;
    return null;
  }
  if (typeof settings !== 'object') throw new Error('Invalid page number settings.');
  const start = settings.start === undefined ? 1 : num(settings.start, NaN);
  if (!Number.isInteger(start) || start < 1) throw new Error('start must be a positive integer.');
  const position = settings.position === undefined ? 'bottom-center' : settings.position;
  if (!PDF_NUMBER_POSITIONS.includes(position)) throw new Error('Invalid page number position.');
  const margin = settings.margin === undefined ? 0.04 : num(settings.margin, NaN);
  if (!Number.isFinite(margin) || margin < 0 || margin > 0.25) throw new Error('margin must be 0–0.25.');
  const fontSize = settings.fontSize === undefined ? 11 : num(settings.fontSize, NaN);
  if (!Number.isFinite(fontSize) || fontSize < 6 || fontSize > 48) throw new Error('fontSize must be 6–48pt.');
  const color = settings.color === undefined ? '#000000' : settings.color;
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(color))) throw new Error('color must be #RGB or #RRGGBB.');
  project.pageNumbers = { start, position, margin: q4(margin), fontSize, color: String(color).toUpperCase() };
  return project.pageNumbers;
}

export function setWatermark(project, settings) {
  if (settings === null || settings === undefined) {
    project.watermark = null;
    return null;
  }
  if (typeof settings !== 'object') throw new Error('Invalid watermark settings.');
  const text = String(settings.text || '').trim();
  if (!text || text.length > 200 || /[\r\n]/.test(text)) {
    throw new Error('Watermark text must be a single line of 1–200 characters.');
  }
  const fontSize = settings.fontSize === undefined ? 64 : num(settings.fontSize, NaN);
  if (!Number.isFinite(fontSize) || fontSize < 12 || fontSize > 200) throw new Error('fontSize must be 12–200pt.');
  const color = settings.color === undefined ? '#888888' : settings.color;
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(color))) throw new Error('color must be #RGB or #RRGGBB.');
  const opacity = settings.opacity === undefined ? 0.25 : num(settings.opacity, NaN);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('opacity must be 0–1.');
  const angle = settings.angle === undefined ? -45 : num(settings.angle, NaN);
  if (!Number.isFinite(angle) || angle < -90 || angle > 90) throw new Error('angle must be -90–90.');
  project.watermark = { text, fontSize, color: String(color).toUpperCase(), opacity, angle };
  return project.watermark;
}

// Serialize to the backend spec shape (src/library/pdf-editor.js).
// fileIds map to upload-order indices; 1-based source pages to 0-based.
// Emits spec version 2 (edits ride inside their page entry, ids stripped).
export function projectToSpec(project) {
  if (project.files.length === 0) throw new Error('Add a source PDF first.');
  if (project.pages.length === 0) throw new Error('The output has no pages.');
  const fileIndex = new Map(project.files.map((f, i) => [f.id, i]));
  const byPage = new Map();
  for (const m of project.markups) {
    if (!byPage.has(m.pageId)) byPage.set(m.pageId, []);
    const { id, pageId, ...rest } = m;
    byPage.get(m.pageId).push(rest);
  }
  const editsByPage = new Map();
  for (const e of project.edits || []) {
    if (!editsByPage.has(e.pageId)) editsByPage.set(e.pageId, []);
    const { id, pageId, ...rest } = e;
    editsByPage.get(e.pageId).push({ ...rest, box: { ...rest.box } });
  }
  return {
    version: 2,
    files: project.files.map(f => ({ name: f.name })),
    images: [],
    pages: project.pages.map(p => {
      const fi = fileIndex.get(p.file);
      if (fi === undefined) throw new Error('A page references a missing source file.');
      return { file: fi, page: p.page - 1, rotate: p.rotate, markups: byPage.get(p.id) || [], edits: editsByPage.get(p.id) || [] };
    }),
    pageNumbers: project.pageNumbers ? { ...project.pageNumbers } : null,
    watermark: project.watermark ? { ...project.watermark } : null
  };
}

// ---- Existing-text editing (cover-and-rewrite) ----
// The backend cannot parse or remove original content-stream glyphs, so an
// edit covers the original span box with the page background and draws the
// replacement text on top (never redaction: original bytes stay in the file).

// Map a PDF font name (e.g. "ABCDEE+Helvetica-BoldOblique", "ArialMT") to a
// renderable family + style flags. Pure + unit-tested.
export function matchPdfFont(fontName) {
  const raw = String(fontName || '');
  const plus = raw.lastIndexOf('+');
  const base = (plus >= 0 ? raw.slice(plus + 1) : raw).toLowerCase().replace(/[^a-z]/g, '');
  const bold = base.includes('bold') || base.includes('black') || base.includes('heavy') || base.includes('demi');
  const italic = base.includes('italic') || base.includes('oblique') || base.includes('cursive');
  let family = 'Helvetica';
  if (/(courier|mono|consolas|menlo|inconsolata|sourcecode|lucidatypewriter|typewriter|firacode|jetbrains|robotomono|ubuntumono)/.test(base)) {
    family = 'Courier';
  } else if (!base.includes('sans') && /(times|serif|georgia|garamond|palatino|bookman|charter|stix|libertine|dejavu|tinos|ptserif)/.test(base)) {
    family = 'TimesRoman';
  } else {
    family = 'Helvetica';
  }
  return { family, bold, italic };
}

// 2D affine multiply: out = t * m for [a,b,c,d,e,f] row-major forms
// (x' = a*x + c*y + e, y' = b*x + d*y + f). Pure + unit-tested.
export function affineMultiply(t, m) {
  const [a, b, c, d, e, f] = t;
  const [g, h, i, j, k, l] = m;
  return [
    a * g + c * h, b * g + d * h,
    a * i + c * j, b * i + d * j,
    a * k + c * l + e, b * k + d * l + f
  ];
}

// Map one pdf.js text item into displayed fractions using the page viewport
// ({transform:[6], width, height} in device px). Returns null for unusable
// geometry. Non-horizontal text is flagged rotated (not editable). The box
// width is filled in later by canvas measurement (see groupTextLines).
// Pure + unit-tested.
export function mapTextItem(item, vpTransform, viewportW, viewportH) {
  if (!item || typeof item.str !== 'string') return null;
  const m = Array.isArray(item.transform) && item.transform.length === 6 ? item.transform : null;
  const t = Array.isArray(vpTransform) && vpTransform.length === 6 ? vpTransform : null;
  if (!m || !t || !(viewportW > 0) || !(viewportH > 0)) return null;
  for (const v of [...m, ...t]) {
    if (!Number.isFinite(Number(v))) return null;
  }
  const c = affineMultiply(t.map(Number), m.map(Number));
  const sizePx = Math.hypot(c[2], c[3]);
  if (!(sizePx > 0)) return null;
  const skew = Math.abs(c[1]) + Math.abs(c[2]);
  return {
    text: item.str,
    xFrac: c[4] / viewportW,
    baseYFrac: c[5] / viewportH,
    sizeFrac: sizePx / viewportH,
    fontName: typeof item.fontName === 'string' ? item.fontName : '',
    hasEOL: !!item.hasEOL,
    rotated: skew > 0.02 * sizePx,
    wFrac: null
  };
}

// Group mapped items (with measured wFrac) into line spans:
// [{ text, x, y, w, h, size, fontName }] in displayed fractions, y = top.
// Joins word fragments with a space when the gap warrants it, breaks lines
// on hasEOL, vertical jumps and x-resets. Pure + unit-tested.
export function groupTextLines(items) {
  const lines = [];
  let cur = null;
  const finish = () => {
    if (!cur || !cur.parts.length) { cur = null; return; }
    // Sort parts by xFrac to guarantee absolute left-to-right visual order
    cur.parts.sort((a, b) => a.xFrac - b.xFrac);
    let x0 = Infinity, x1 = -Infinity, top = Infinity, bot = -Infinity, size = 0;
    let fontName = '';
    const counts = new Map();
    const words = [];
    let prevRight = null;
    for (const p of cur.parts) {
      if (p.text) {
        if (prevRight !== null && p.xFrac - prevRight > 0.25 * p.sizeFrac) words.push('');
        words.push(p.text);
        prevRight = p.xFrac + (p.wFrac || 0);
      }
      x0 = Math.min(x0, p.xFrac);
      x1 = Math.max(x1, p.xFrac + (p.wFrac || 0));
      top = Math.min(top, p.topFrac);
      bot = Math.max(bot, p.topFrac + p.sizeFrac);
      size = Math.max(size, p.sizeFrac);
      const k = p.fontName || '';
      counts.set(k, (counts.get(k) || 0) + 1);
      if ((counts.get(k) || 0) > (counts.get(fontName) || 0)) fontName = k;
    }
    const text = words.join(' ').replace(/ {2,}/g, ' ');
    if (text.trim()) {
      lines.push({ text, x: q4(x0), y: q4(Math.max(0, top)), w: q4(Math.max(0.004, x1 - x0)), h: q4(Math.max(0.004, bot - top)), size: q4(size), fontName });
    }
    cur = null;
  };
  for (const it of items || []) {
    if (!it || typeof it.text !== 'string' || !it.text) {
      if (it && it.hasEOL) finish();
      continue;
    }
    const top = it.baseYFrac - it.sizeFrac;
    if (!cur) {
      cur = { parts: [], top, h: it.sizeFrac, minX: it.xFrac };
    } else {
      const dy = Math.abs(top - cur.top);
      const tol = Math.max(0.35 * cur.h, 0.002);
      // Allow minor horizontal tracking/kerning overlaps (up to 0.05 page fraction)
      if (dy > tol || it.xFrac < cur.minX - 0.05) {
        finish();
      }
      if (!cur) cur = { parts: [], top, h: it.sizeFrac, minX: it.xFrac };
    }
    cur.parts.push({ ...it, topFrac: top });
    cur.minX = Math.min(cur.minX, it.xFrac);
    if (it.hasEOL) finish();
  }
  finish();
  return lines;
}

function checkEditColor(value, label) {
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value))) {
    throw new Error(`${label} must be #RGB or #RRGGBB.`);
  }
  return String(value).toUpperCase();
}

function checkEditBox(box, label) {
  if (!box || typeof box !== 'object') throw new Error(`${label} must be an object.`);
  const out = {};
  for (const k of ['x', 'y', 'w', 'h']) {
    out[k] = checkFrac(box[k], `${label}.${k}`, k === 'x' || k === 'y' ? 0 : 0.004, 1);
  }
  return out;
}

// Validate + normalize edit props (partial allowed for updates).
export function sanitizeEditProps(props = {}) {
  const out = {};
  const has = k => props[k] !== undefined && props[k] !== null;
  if (has('text')) {
    const t = String(props.text);
    if (!t.trim() || t.length > PDF_PROJECT_MAX_EDIT_LEN || /[\r\n]/.test(t)) {
      throw new Error(`Text must be a single line of 1–${PDF_PROJECT_MAX_EDIT_LEN} characters.`);
    }
    out.text = t;
  }
  if (has('box')) out.box = checkEditBox(props.box, 'box');
  if (has('origText')) out.origText = String(props.origText).slice(0, PDF_PROJECT_MAX_EDIT_LEN);
  if (has('font')) {
    if (!PDF_EDIT_FAMILIES.includes(props.font)) throw new Error('font must be Helvetica, TimesRoman or Courier.');
    out.font = props.font;
  }
  for (const k of ['bold', 'italic']) {
    if (has(k)) out[k] = !!props[k];
  }
  if (has('size')) {
    const n = num(props.size, NaN);
    if (!Number.isFinite(n) || n < 0.01 || n > 0.4) throw new Error('size must be 0.01–0.4.');
    out.size = q4(n);
  }
  if (has('color')) out.color = checkEditColor(props.color, 'color');
  if (has('align')) {
    if (!PDF_EDIT_ALIGNMENTS.includes(props.align)) throw new Error('align must be left, center or right.');
    out.align = props.align;
  }
  // Explicit null/'' clears the cover color; undefined keeps it.
  if ('bg' in props && props.bg !== undefined) {
    if (props.bg === null || props.bg === '') out.bg = null;
    else out.bg = checkEditColor(props.bg, 'bg');
  }
  if (has('fitScale')) {
    const n = num(props.fitScale, NaN);
    if (!Number.isFinite(n) || n < 0.05 || n > 1) throw new Error('fitScale must be 0.05–1.');
    out.fitScale = Math.round(n * 1000) / 1000;
  }
  return out;
}

// Add an existing-text edit on an output page. span carries the measured
// original box + typography; replacement/opts override. Returns the edit.
export function addTextEdit(project, pageId, span, replacement, opts = {}) {
  const page = getOutputPage(project, pageId);
  if (!page) throw new Error('Output page not found.');
  if (!span || typeof span !== 'object') throw new Error('Text span is required.');
  if ((project.edits || []).length >= PDF_PROJECT_MAX_EDITS) throw new Error('Too many text edits.');
  if (editsForPage(project, pageId).length >= PDF_PROJECT_MAX_EDITS_PER_PAGE) {
    throw new Error('Too many text edits on this page.');
  }
  const spanSize = Number(span.size);
  const clean = sanitizeEditProps({
    text: replacement,
    box: { x: span.x, y: span.y, w: span.w, h: span.h },
    origText: span.text || '',
    font: opts.font !== undefined ? opts.font : (matchPdfFont(span.fontName).family),
    bold: opts.bold !== undefined ? opts.bold : matchPdfFont(span.fontName).bold,
    italic: opts.italic !== undefined ? opts.italic : matchPdfFont(span.fontName).italic,
    size: opts.size !== undefined ? opts.size
      : (Number.isFinite(spanSize) ? Math.min(0.4, Math.max(0.01, Math.round(spanSize * 1e4) / 1e4)) : 0.04),
    color: opts.color !== undefined ? opts.color : '#000000',
    align: opts.align !== undefined ? opts.align : 'left',
    bg: opts.bg !== undefined ? opts.bg : '#FFFFFF',
    fitScale: opts.fitScale !== undefined ? opts.fitScale : 1
  });
  const edit = { id: newId('e'), pageId, ...clean };
  project.edits.push(edit);
  project.selectedEditId = edit.id;
  project.selectedMarkupId = null;
  return edit;
}

export function getTextEdit(project, id) {
  return (project.edits || []).find(e => e.id === id) || null;
}

export function editsForPage(project, pageId) {
  return (project.edits || []).filter(e => e.pageId === pageId);
}

// Find the edit already covering a span box (re-edit updates instead of
// duplicating): same page, overlapping boxes, same original text.
export function findEditForSpan(project, pageId, box, origText) {
  if (!box) return null;
  for (const e of editsForPage(project, pageId)) {
    if (e.origText !== origText) continue;
    const b = e.box;
    const ix0 = Math.max(b.x, box.x), ix1 = Math.min(b.x + b.w, box.x + box.w);
    const iy0 = Math.max(b.y, box.y), iy1 = Math.min(b.y + b.h, box.y + box.h);
    const iw = Math.max(0, ix1 - ix0), ih = Math.max(0, iy1 - iy0);
    const area = Math.max(1e-9, b.w * b.h);
    if ((iw * ih) / area > 0.5) return e;
  }
  return null;
}

export function updateTextEdit(project, id, props = {}) {
  const edit = getTextEdit(project, id);
  if (!edit) throw new Error('Text edit not found.');
  Object.assign(edit, sanitizeEditProps(props));
  return edit;
}

export function deleteTextEdit(project, id) {
  const idx = (project.edits || []).findIndex(e => e.id === id);
  if (idx === -1) return false;
  project.edits.splice(idx, 1);
  if (project.selectedEditId === id) project.selectedEditId = null;
  return true;
}

// Shrink-to-fit scale for a replacement string: measured width vs box
// width at the commit size. 1 when it fits; invalid input → 1 (never hide).
export function editFitScale(textWPx, boxWPx, maxAvailableW) {
  const tw = Number(textWPx);
  const bw = Number(boxWPx);
  if (!(tw > 0) || !(bw > 0)) return 1;
  const limitW = (typeof maxAvailableW === 'number' && maxAvailableW > bw) ? maxAvailableW : bw;
  return Math.min(1, limitW / tw);
}

// ---- Undo/redo (snapshot command stack; model stays dependency-free) ----
function snapshotProject(project) {
  return JSON.parse(JSON.stringify({
    version: project.version,
    files: project.files,
    pages: project.pages,
    markups: project.markups,
    edits: project.edits || [],
    pageNumbers: project.pageNumbers,
    watermark: project.watermark,
    selectedPageId: project.selectedPageId,
    selectedMarkupId: project.selectedMarkupId,
    selectedEditId: project.selectedEditId || null
  }));
}

function restoreProject(project, snap) {
  const s = JSON.parse(JSON.stringify(snap));
  project.version = s.version;
  project.files = s.files;
  project.pages = s.pages;
  project.markups = s.markups;
  project.edits = s.edits || [];
  project.pageNumbers = s.pageNumbers;
  project.watermark = s.watermark;
  project.selectedPageId = s.selectedPageId;
  project.selectedMarkupId = s.selectedMarkupId;
  project.selectedEditId = s.selectedEditId || null;
  return project;
}

export function createUndoStack() {
  return { past: [], future: [] };
}

// Record the pre-mutation state. Any new checkpoint clears the redo stack.
export function pushUndo(stack, project) {
  if (!stack || !Array.isArray(stack.past) || !Array.isArray(stack.future)) {
    throw new Error('Invalid undo stack.');
  }
  stack.past.push(snapshotProject(project));
  if (stack.past.length > PDF_UNDO_LIMIT) stack.past.shift();
  stack.future.length = 0;
  return stack;
}

export function undoProject(project, stack) {
  if (!stack || !stack.past.length) return false;
  stack.future.push(snapshotProject(project));
  restoreProject(project, stack.past.pop());
  return true;
}

export function redoProject(project, stack) {
  if (!stack || !stack.future.length) return false;
  stack.past.push(snapshotProject(project));
  restoreProject(project, stack.future.pop());
  return true;
}

// Convert mapped PDF.js text items into individual word-level spans.
// Spaces are ignored as editable spans, and punctuation remains attached
// where practical. Returns rounded fractional span metadata:
// [{ text, x, y, w, h, size, fontName }]
export function extractWordSpans(items, viewportW, viewportH, measureCtx) {
  const spans = [];
  if (!Array.isArray(items) || !(viewportW > 0) || !(viewportH > 0)) return spans;

  for (const it of items) {
    if (!it || typeof it.text !== 'string' || !it.text.trim()) continue;

    // Split text into tokens based on whitespace, retaining the whitespace as tokens
    const tokens = it.text.split(/(\s+)/);
    
    // Set up standard canvas measurements
    const fam = matchPdfFont(it.fontName);
    const sizePt = Math.max(1, it.sizeFrac * viewportH);
    const fontStr = (fam.italic ? 'italic ' : '') + (fam.bold ? '700 ' : '400 ') + sizePt + 'px ' + (
      fam.family === 'TimesRoman' ? '"Times New Roman", Times, serif'
      : fam.family === 'Courier' ? '"Courier New", Courier, monospace'
      : 'Helvetica, Arial, sans-serif'
    );

    // Measure each token's width in points
    const widths = tokens.map(token => {
      if (!token) return 0;
      if (measureCtx) {
        try {
          measureCtx.font = fontStr;
          return measureCtx.measureText(token).width;
        } catch (e) {
          return token.length * sizePt * 0.55;
        }
      }
      return token.length * sizePt * 0.55;
    });

    // Proportional scaling factor relative to parent TextItem's width
    const totalMeasuredW = widths.reduce((sum, w) => sum + w, 0);
    const parentW = (it.wFrac || 0) * viewportW;
    const scale = totalMeasuredW > 0 ? (parentW / totalMeasuredW) : 1;

    let curX = it.xFrac * viewportW;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const tokenW = widths[i] * scale;
      if (token && !/^\s+$/.test(token)) {
        // Create an independent word-level span
        spans.push({
          text: token,
          x: q4(curX / viewportW),
          y: q4(it.baseYFrac - it.sizeFrac),
          w: q4(tokenW / viewportW),
          h: q4(it.sizeFrac),
          size: q4(it.sizeFrac),
          fontName: it.fontName
        });
      }
      curX += tokenW;
    }
  }

  return spans;
}

// Diff two strings to extract the unchanged prefix (Segment A),
// the edited middle part (Segment B Orig/Repl), and the unchanged suffix (Segment C).
export function diffLineText(origText, newText) {
  const oStr = typeof origText === 'string' ? origText : '';
  const nStr = typeof newText === 'string' ? newText : '';

  let prefixLen = 0;
  const maxPrefix = Math.min(oStr.length, nStr.length);
  while (prefixLen < maxPrefix && oStr[prefixLen] === nStr[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  const maxSuffix = Math.min(oStr.length - prefixLen, nStr.length - prefixLen);
  while (suffixLen < maxSuffix && 
         oStr[oStr.length - 1 - suffixLen] === nStr[nStr.length - 1 - suffixLen]) {
    suffixLen++;
  }

  const segmentA = oStr.slice(0, prefixLen);
  const segmentC = oStr.slice(oStr.length - suffixLen);
  
  const segmentBOrig = oStr.slice(prefixLen, oStr.length - suffixLen);
  const segmentBRepl = nStr.slice(prefixLen, nStr.length - suffixLen);

  return {
    segmentA,
    segmentBOrig,
    segmentBRepl,
    segmentC
  };
}
