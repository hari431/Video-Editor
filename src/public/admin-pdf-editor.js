// src/public/admin-pdf-editor.js — Local Admin/Owner PDF editor.
// ES module (no frameworks); page-model math lives in
// ./pdf-editor-project.js (shared with node:test). Preview rendering uses
// the vendored pdf.js (src/public/vendor/pdfjs, local files, no CDN).
// - Sources are local bytes (file picker, or a library PDF fetched
//   read-only for preselect). Library originals are never written.
// - Geometry is DISPLAYED-space fractions (top-left origin), matching the
//   export spec in src/library/pdf-editor.js.
// - Export uploads bytes + spec JSON; the server renders a NEW PDF in
//   memory with pdf-lib and streams it back as a download.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import {
  createPdfProject,
  resetPdfProjectIds,
  getPdfFile,
  getOutputPage,
  getMarkup,
  markupsForPage,
  addSourceFile,
  appendSourcePages,
  moveOutputPage,
  removeOutputPage,
  duplicateOutputPage,
  rotateOutputPage,
  setPageRotation,
  addMarkup,
  updateMarkup,
  deleteMarkup,
  getTextEdit,
  editsForPage,
  findEditForSpan,
  addTextEdit,
  updateTextEdit,
  deleteTextEdit,
  matchPdfFont,
  mapTextItem,
  groupTextLines,
  extractWordSpans,
  diffLineText,
  editFitScale,
  createUndoStack,
  pushUndo,
  undoProject,
  redoProject,
  setPageNumbers,
  setWatermark,
  projectToSpec
} from './pdf-editor-project.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setStatus(text, ok) {
    var el = $('pdfExportStatus');
    if (!el) return;
    el.textContent = text;
    el.style.color = ok ? '#15803d' : '#b91c1c';
  }

  // ---- state ----
  var project = null;
  var pdfDocs = new Map(); // fileId -> { data: Uint8Array, doc: PDFDocumentProxy, name }
  var imageFiles = []; // [{ blob, url, img, w, h, name }]
  var tool = 'select';
  var zoom = 1.2;
  var fitMode = 'width'; // 'width' | 'page'
  var pageView = null; // { pageId, viewportW, viewportH, scale }
  var drag = null; // active pointer gesture
  var editingText = false;
  var maxFileMb = 50;
  var maxFileBytes = 50 * 1048576;
  var MAX_IMAGE_BYTES = 5 * 1048576;
  var undoStack = createUndoStack();
  var spanCache = new Map(); // pageId -> { rotate, spans }
  var measureCtx = null;
  var hoveredSpan = null;
  var BASE_WIDTH = 840;

  function updateZoomLabel() {
    var lbl = $('pdfZoomLabel');
    if (lbl) lbl.textContent = Math.round(zoom * 100) + '%';
  }

  // Record the pre-mutation state for undo (clears redo). Call BEFORE the
  // mutation, at discrete commit points — never per keystroke.
  function checkpoint() {
    if (!project) return;
    try {
      pushUndo(undoStack, project);
      updateUndoButtons();
    } catch (err) {}
  }

  function updateUndoButtons() {
    var u = $('pdfUndoBtn'), r = $('pdfRedoBtn');
    if (u) u.disabled = !(undoStack && undoStack.past.length);
    if (r) r.disabled = !(undoStack && undoStack.future.length);
  }

  function doUndo() {
    if (!project) return;
    if (undoProject(project, undoStack)) {
      spanCache.clear();
      setStatus('', true);
      renderAll();
      updateUndoButtons();
    }
  }

  function doRedo() {
    if (!project) return;
    if (redoProject(project, undoStack)) {
      spanCache.clear();
      setStatus('', true);
      renderAll();
      updateUndoButtons();
    }
  }

  function selectedPage() {
    if (!project || !project.selectedPageId) return null;
    return getOutputPage(project, project.selectedPageId);
  }

  function selectedMarkup() {
    if (!project || !project.selectedMarkupId) return null;
    return getMarkup(project, project.selectedMarkupId);
  }

  function selectedEdit() {
    if (!project || !project.selectedEditId) return null;
    return getTextEdit(project, project.selectedEditId);
  }

  function fileDoc(fileId) {
    var e = pdfDocs.get(fileId);
    return e ? e.doc : null;
  }

  // ---- sources ----
  function fileMetaOk(f) {
    if (!(f.size > 0 && f.size <= maxFileBytes)) {
      setStatus('Skipped ' + (f.name || 'file') + ': must be 1 byte–' + maxFileMb + ' MB.', false);
      return false;
    }
    if (!/\.pdf$/i.test(f.name || '')) {
      setStatus('Skipped ' + (f.name || 'file') + ': only .pdf files.', false);
      return false;
    }
    return true;
  }

  async function addPdfFiles(fileList) {
    if (!project) return;
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var added = 0;
    for (const f of files) {
      if (project.files.length >= 8) { setStatus('At most 8 source PDFs.', false); break; }
      if (!fileMetaOk(f)) continue;
      try {
        var buf = new Uint8Array(await f.arrayBuffer());
        var doc = await pdfjsLib.getDocument({ data: buf.slice() }).promise;
        var entry = addSourceFile(project, { name: f.name, pageCount: doc.numPages });
        pdfDocs.set(entry.id, { data: buf, doc: doc, name: f.name });
        appendSourcePages(project, entry.id);
        added++;
      } catch (err) {
        setStatus('Skipped ' + (f.name || 'file') + ': unreadable PDF.', false);
      }
    }
    if (added) {
      setStatus('Added ' + added + ' PDF(s). Pages appended in order (merge).', true);
      renderAll();
    }
  }

  function setImageFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    var added = 0;
    files.forEach(function (f) {
      if (imageFiles.length >= 8) return;
      if (!(f.size > 0 && f.size <= MAX_IMAGE_BYTES)) {
        setStatus('Skipped ' + (f.name || 'image') + ': must be 1 byte–5 MB.', false);
        return;
      }
      if (!/\.(png|jpe?g)$/i.test(f.name || '')) {
        setStatus('Skipped ' + (f.name || 'image') + ': only png/jpg.', false);
        return;
      }
      var url = null;
      try { url = URL.createObjectURL(f); } catch (e) { url = ''; }
      var rec = { blob: f, url: url, img: null, w: 0, h: 0, name: f.name };
      imageFiles.push(rec);
      added++;
      if (url) {
        var im = new Image();
        im.onload = function () {
          rec.img = im; rec.w = im.naturalWidth; rec.h = im.naturalHeight;
          renderMain();
        };
        im.src = url;
      }
    });
    if (added) { setStatus('Loaded ' + added + ' image(s).', true); renderInspector(); }
  }

  // ---- page list (thumbnails + order controls) ----
  async function renderPageList() {
    var list = $('pdfPageList');
    if (!list || !project) return;
    list.innerHTML = '';
    if (!project.pages.length) {
      list.innerHTML = '<p class="muted" style="margin:0;">No pages yet — add a PDF file.</p>';
      return;
    }
    for (let i = 0; i < project.pages.length; i++) {
      const entry = project.pages[i];
      const file = getPdfFile(project, entry.file);
      const doc = fileDoc(entry.file);
      const box = document.createElement('div');
      box.className = 'pdf-thumb' + (project.selectedPageId === entry.id ? ' pdf-selected' : '');
      box.setAttribute('data-page-id', entry.id);
      const label = document.createElement('div');
      label.textContent = (i + 1) + ' · ' + (file ? file.name : '?') + ' p' + entry.page +
        (entry.rotate ? ' ⟳' + entry.rotate : '');
      box.appendChild(label);
      const cv = document.createElement('canvas');
      box.appendChild(cv);
      const ctrls = document.createElement('div');
      [['←', 'left'], ['→', 'right'], ['⟳', 'rot'], ['⧉', 'dup'], ['✕', 'del']].forEach(function ([t, act]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'button small secondary';
        b.textContent = t;
        b.style.padding = '0 6px';
        b.title = act === 'left' ? 'Move Left' : act === 'right' ? 'Move Right' : act === 'rot' ? 'Rotate' : act === 'dup' ? 'Duplicate' : 'Delete';
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          pageControl(entry.id, act);
        });
        ctrls.appendChild(b);
      });
      box.appendChild(ctrls);
      box.addEventListener('click', function () {
        project.selectedPageId = entry.id;
        project.selectedMarkupId = null;
        project.selectedEditId = null;
        renderAll();
      });
      list.appendChild(box);
      if (doc) {
        try {
          const pdfPage = await doc.getPage(entry.page);
          const vp = pdfPage.getViewport({ scale: 0.22, rotation: entry.rotate });
          cv.width = Math.max(1, Math.round(vp.width));
          cv.height = Math.max(1, Math.round(vp.height));
          await pdfPage.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
        } catch (e) { /* thumbnail best-effort */ }
      }
    }
    var ind = $('pdfPageIndicator');
    if (ind) {
      const idx = project.pages.findIndex(p => p.id === project.selectedPageId);
      ind.textContent = project.pages.length
        ? ('Page ' + (idx >= 0 ? idx + 1 : 1) + ' / ' + project.pages.length)
        : 'No pages';
    }
    var meta = $('pdfMeta');
    if (meta) meta.textContent = project.files.length + ' source(s) · ' + project.pages.length + ' output page(s) · ' + project.markups.length + ' markup(s)';
  }

  function pageControl(id, act) {
    if (!project) return;
    try {
      checkpoint();
      if (act === 'left' || act === 'right') {
        const idx = project.pages.findIndex(p => p.id === id);
        moveOutputPage(project, id, idx + (act === 'left' ? -1 : 1));
      } else if (act === 'rot') {
        rotateOutputPage(project, id);
      } else if (act === 'dup') {
        duplicateOutputPage(project, id);
      } else if (act === 'del') {
        removeOutputPage(project, id);
      }
    } catch (err) { setStatus(err.message || 'Cannot update page.', false); return; }
    updateUndoButtons();
    renderAll();
  }

  // ---- main canvas ----
  function fracToPx(x, y) {
    if (!pageView) return { x: 0, y: 0 };
    return { x: x * pageView.viewportW, y: y * pageView.viewportH };
  }

  function pxToFrac(px, py) {
    if (!pageView || pageView.viewportW <= 0 || pageView.viewportH <= 0) return { x: 0, y: 0 };
    return {
      x: Math.min(1, Math.max(0, px / pageView.viewportW)),
      y: Math.min(1, Math.max(0, py / pageView.viewportH))
    };
  }

  async function renderMain() {
    var canvas = $('pdfPageCanvas');
    var overlay = $('pdfOverlayCanvas');
    var stack = $('pdfCanvasStack');
    if (!canvas || !overlay || !stack || !project) return;
    var page = selectedPage();
    if (!page) {
      canvas.width = 0; canvas.height = 0;
      overlay.width = 0; overlay.height = 0;
      pageView = null;
      return;
    }
    var doc = fileDoc(page.file);
    if (!doc) return;
    try {
      var pdfPage = await doc.getPage(page.page);
      var base = pdfPage.getViewport({ scale: 1, rotation: page.rotate });
      var scale = Math.max(0.4, Math.min(3, zoom * (BASE_WIDTH / Math.max(1, base.width))));
      var vp = pdfPage.getViewport({ scale: scale, rotation: page.rotate });
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      overlay.width = canvas.width;
      overlay.height = canvas.height;
      stack.style.width = canvas.width + 'px';
      pageView = { pageId: page.id, viewportW: canvas.width, viewportH: canvas.height, scale: scale };
      updateZoomLabel();
      // Guard against stale async renders after page switches.
      if (!project || project.selectedPageId !== page.id) return;
      await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      if (!project || project.selectedPageId !== page.id) return;
      ensureSpans(page).catch(function () {});
      drawOverlay();
    } catch (err) {
      setStatus('Could not render page.', false);
    }
  }

  function withAlpha(hex, alpha) {
    var h = String(hex || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  // ---- existing-text editing (cover-and-rewrite) ----
  // Canvas font for a matched family (mirrors the server-side standard fonts
  // closely enough that preview and export agree).
  function canvasFontFor(family, bold, italic, sizePx) {
    var fam = family === 'TimesRoman' ? '"Times New Roman", Times, serif'
      : family === 'Courier' ? '"Courier New", Courier, monospace'
      : 'Helvetica, Arial, sans-serif';
    return (italic ? 'italic ' : '') + (bold ? '700 ' : '400 ') + sizePx + 'px ' + fam;
  }

  function measureCanvasCtx() {
    if (!measureCtx) {
      try { measureCtx = document.createElement('canvas').getContext('2d'); } catch (e) { measureCtx = null; }
    }
    return measureCtx;
  }

  // Width of one line in px at sizePx with the edit font (no layout cost).
  function measureEditLine(text, family, bold, italic, sizePx) {
    var ctx = measureCanvasCtx();
    if (!ctx || !(sizePx > 0)) return String(text || '').length * sizePx * 0.55;
    try {
      ctx.font = canvasFontFor(family, bold, italic, sizePx);
      return ctx.measureText(String(text || '')).width;
    } catch (e) {
      return String(text || '').length * sizePx * 0.55;
    }
  }

  // Auto-shrink scale so replacement text fits its span box (1 = fits).
  function editFitFor(edit, sizePx, boxWPx) {
    if (!edit || !(sizePx > 0) || !(boxWPx > 0)) return 1;
    var w = measureEditLine(edit.text, edit.font, edit.bold, edit.italic, sizePx);
    var n = Number(w), b = Number(boxWPx);
    if (!(n > 0) || !(b > 0)) return 1;
    return Math.min(1, b / n);
  }

  function rgbToHex(r, g, b) {
    const h = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return ('#' + h(r) + h(g) + h(b)).toUpperCase();
  }

  // Sample rendered pixels inside a page-fraction box: returns the dominant
  // (background) and darkest-frequent (text) colors. Best-effort: any failure
  // yields black-on-white defaults. Never throws.
  function sampleSpanColors(box) {
    var fallback = { text: '#000000', bg: '#FFFFFF' };
    try {
      var canvas = $('pdfPageCanvas');
      if (!canvas || !pageView || !box) return fallback;
      var ctx = canvas.getContext('2d');
      if (!ctx) return fallback;
      var x0 = Math.max(0, Math.floor(box.x * canvas.width));
      var y0 = Math.max(0, Math.floor(box.y * canvas.height));
      var x1 = Math.min(canvas.width, Math.ceil((box.x + box.w) * canvas.width));
      var y1 = Math.min(canvas.height, Math.ceil((box.y + box.h) * canvas.height));
      if (x1 <= x0 || y1 <= y0) return fallback;
      var img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
      var d = img.data;
      var stride = Math.max(1, Math.floor(Math.sqrt((d.length / 4) / 1500)));
      var counts = new Map();
      for (let i = 0; i < d.length; i += 4 * stride) {
        if (d[i + 3] < 128) continue;
        const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      if (!counts.size) return fallback;
      var entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const toRgb = k => [(k >> 8 & 15) * 17, (k >> 4 & 15) * 17, (k & 15) * 17];
      const lum = k => { const c = toRgb(k); return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]; };
      const bg = toRgb(entries[0][0]);
      const bgLum = lum(entries[0][0]);
      let text = null;
      for (const [k] of entries) {
        if (Math.abs(lum(k) - bgLum) > 40) { text = toRgb(k); break; }
      }
      if (!text) {
        // Uniform box (blank cover area): keep defaults.
        return { text: fallback.text, bg: rgbToHex(bg[0], bg[1], bg[2]) };
      }
      return { text: rgbToHex(text[0], text[1], text[2]), bg: rgbToHex(bg[0], bg[1], bg[2]) };
    } catch (e) {
      return fallback;
    }
  }

  // Extract positioned text spans for an output page (cached per page+rotate).
  // Empty result = nothing editable (e.g. scanned image page).
  async function ensureSpans(page) {
    if (!project || !page) return [];
    const hit = spanCache.get(page.id);
    if (hit && hit.rotate === page.rotate) return hit.spans;
    const doc = fileDoc(page.file);
    if (!doc) return [];
    try {
      const pdfPage = await doc.getPage(page.page);
      const vp = pdfPage.getViewport({ scale: 1, rotation: page.rotate });
      const tc = await pdfPage.getTextContent();
      const items = Array.isArray(tc.items) ? tc.items : [];
      const styles = tc.styles || {};
      // Measure at viewport (scale-1) points so fractions stay
      // scale-invariant across zooms.
      const ctx = measureCanvasCtx();
      const mapped = [];
      for (const it of items) {
        const style = styles[it.fontName] || {};
        const fontName = style.fontFamily ? `${it.fontName} ${style.fontFamily}` : it.fontName;
        const m = mapTextItem(Object.assign({}, it, { fontName: fontName }), vp.transform, vp.width, vp.height);
        if (!m || m.rotated || !m.text.trim()) continue;
        const pageWPoints = vp.width / vp.scale;
        let nativeWFrac = 0;
        if (typeof it.width === 'number' && it.width > 0 && pageWPoints > 0) {
          nativeWFrac = it.width / pageWPoints;
        } else {
          const fam = matchPdfFont(m.fontName);
          const sizePt = Math.max(1, m.sizeFrac * vp.height);
          let wPt = 0;
          try {
            ctx.font = canvasFontFor(fam.family, fam.bold, fam.italic, sizePt);
            wPt = ctx.measureText(m.text).width;
          } catch (e) { wPt = m.text.length * sizePt * 0.55; }
          nativeWFrac = vp.width > 0 ? wPt / vp.width : 0;
        }
        mapped.push({ ...m, wFrac: nativeWFrac });
      }
      const spans = groupTextLines(mapped);
      spanCache.set(page.id, { rotate: page.rotate, spans });
      return spans;
    } catch (err) {
      return [];
    }
  }

  function hitSpan(pageId, fx, fy) {
    const hit = spanCache.get(pageId);
    if (!hit) return null;
    const tol = 0.008;
    for (let i = hit.spans.length - 1; i >= 0; i--) {
      const s = hit.spans[i];
      if (fx >= s.x - tol && fx <= s.x + s.w + tol && fy >= s.y - tol && fy <= s.y + s.h + tol) {
        return s;
      }
    }
    return null;
  }

  function drawMarkupShape(ctx, m, isSelected) {
    if (!pageView) return;
    var W = pageView.viewportW, H = pageView.viewportH;
    ctx.save();
    if (m.kind === 'text') {
      const sizePx = Math.max(6, m.size * H);
      ctx.font = '400 ' + sizePx + 'px Helvetica, Arial, sans-serif';
      ctx.globalAlpha = m.opacity;
      ctx.fillStyle = m.color || '#000';
      ctx.textBaseline = 'top';
      const lines = String(m.text || '').split('\n').slice(0, 20);
      lines.forEach(function (ln, i) {
        ctx.fillText(ln, m.x * W, m.y * H + i * sizePx * 1.2);
      });
    } else if (m.kind === 'image') {
      const rec = imageFiles[m.file];
      const p = fracToPx(m.x, m.y);
      const wPx = m.w * W;
      let hPx = wPx;
      if (rec && rec.w > 0 && rec.h > 0) hPx = wPx * (rec.h / rec.w);
      ctx.globalAlpha = m.opacity;
      if (rec && rec.img) ctx.drawImage(rec.img, p.x, p.y, wPx, hPx);
      else { ctx.fillStyle = '#cbd5e1'; ctx.fillRect(p.x, p.y, wPx, hPx); }
    } else if (m.kind === 'rect') {
      const p = fracToPx(m.x, m.y);
      if (m.fill) { ctx.globalAlpha = m.fillOpacity; ctx.fillStyle = m.fill; ctx.fillRect(p.x, p.y, m.w * W, m.h * H); }
      if (m.stroke && m.strokeWidth > 0) {
        ctx.globalAlpha = 1; ctx.strokeStyle = m.stroke; ctx.lineWidth = Math.max(1, m.strokeWidth);
        ctx.strokeRect(p.x, p.y, m.w * W, m.h * H);
      }
    } else if (m.kind === 'ellipse') {
      const p = fracToPx(m.x, m.y);
      ctx.beginPath();
      ctx.ellipse(p.x + m.w * W / 2, p.y + m.h * H / 2, Math.max(1, m.w * W / 2), Math.max(1, m.h * H / 2), 0, 0, Math.PI * 2);
      if (m.fill) { ctx.globalAlpha = m.fillOpacity; ctx.fillStyle = m.fill; ctx.fill(); }
      if (m.stroke && m.strokeWidth > 0) {
        ctx.globalAlpha = 1; ctx.strokeStyle = m.stroke; ctx.lineWidth = Math.max(1, m.strokeWidth); ctx.stroke();
      }
    } else if (m.kind === 'line' || m.kind === 'path') {
      const pts = m.kind === 'line' ? [[m.x1, m.y1], [m.x2, m.y2]] : m.points;
      ctx.globalAlpha = m.opacity;
      ctx.strokeStyle = m.stroke;
      ctx.lineWidth = Math.max(1, m.strokeWidth);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach(function (pt, i) {
        const p = fracToPx(pt[0], pt[1]);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }
    ctx.restore();
    if (isSelected) {
      const bb = markupBBox(m);
      if (bb) {
        ctx.save();
        ctx.strokeStyle = '#1d4ed8';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(bb.x * W - 4, bb.y * H - 4, bb.w * W + 8, bb.h * H + 8);
        // SE resize handle.
        ctx.setLineDash([]);
        ctx.fillStyle = '#1d4ed8';
        ctx.fillRect(bb.x * W + bb.w * W - 2, bb.y * H + bb.h * H - 2, 10, 10);
        ctx.restore();
      }
    }
  }

  function drawOverlay() {
    if (editingText || (drag && drag.kind === 'gesture')) return;
    paintOverlay();
  }

  // Unconditional repaint (used by the drag paths so moves/resizes/shapes
  // track the pointer live; drawOverlay() stays frozen mid-gesture).
  function paintOverlay() {
    var overlay = $('pdfOverlayCanvas');
    if (!overlay || !project || !pageView) return;
    var ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    var page = selectedPage();
    if (!page) return;
    // Page numbers + watermark live preview (same math as export).
    if (project.pageNumbers) {
      const pn = project.pageNumbers;
      const idx = project.pages.findIndex(p => p.id === page.id);
      const label = String(pn.start + Math.max(0, idx));
      ctx.save();
      ctx.font = '700 ' + Math.max(6, pn.fontSize) + 'px Helvetica, Arial, sans-serif';
      ctx.fillStyle = pn.color;
      const tw = ctx.measureText(label).width;
      const m = pn.margin * Math.min(overlay.width, overlay.height);
      let nx = overlay.width / 2 - tw / 2, ny = overlay.height - m - pn.fontSize;
      if (pn.position.startsWith('top-')) ny = m;
      if (pn.position.endsWith('-right')) nx = overlay.width - m - tw;
      else if (pn.position.endsWith('-left')) nx = m;
      ctx.fillText(label, nx, ny);
      ctx.restore();
    }
    if (project.watermark && project.watermark.text) {
      const wm = project.watermark;
      ctx.save();
      ctx.globalAlpha = wm.opacity;
      ctx.font = '700 ' + wm.fontSize + 'px Helvetica, Arial, sans-serif';
      ctx.fillStyle = wm.color;
      ctx.translate(overlay.width / 2, overlay.height / 2);
      ctx.rotate(wm.angle * Math.PI / 180);
      const tw = ctx.measureText(wm.text).width;
      ctx.fillText(wm.text, -tw / 2, wm.fontSize / 3);
      ctx.restore();
    }
    markupsForPage(project, page.id).forEach(function (m) {
      drawMarkupShape(ctx, m, project.selectedMarkupId === m.id);
    });
    // Existing-text edits paint above the rendered page (cover + rewrite),
    // below user annotations — exactly the export draw order.
    editsForPage(project, page.id).forEach(function (e) {
      drawTextEdit(ctx, e, project.selectedEditId === e.id);
    });
    // Visual cue for ALL editable text blocks on the page in edit mode to make them easy to find & click
    if (tool === 'edit' && !editingText) {
      const hit = spanCache.get(page.id);
      if (hit && hit.spans) {
        ctx.save();
        ctx.strokeStyle = 'rgba(37, 99, 235, 0.28)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        hit.spans.forEach(function (s) {
          if (s === hoveredSpan) return;
          var bx = s.x * overlay.width, by = s.y * overlay.height;
          var bw = s.w * overlay.width, bh = s.h * overlay.height;
          ctx.strokeRect(bx - 1.5, by - 1.5, bw + 3, bh + 3);
        });
        ctx.restore();
      }
    }
    // Stronger visual highlight for active hover in edit mode
    if (tool === 'edit' && hoveredSpan && !editingText) {
      var hbx = hoveredSpan.x * overlay.width, hby = hoveredSpan.y * overlay.height;
      var hbw = hoveredSpan.w * overlay.width, hbh = hoveredSpan.h * overlay.height;
      ctx.save();
      ctx.strokeStyle = '#2563eb';
      ctx.fillStyle = 'rgba(37, 99, 235, 0.12)';
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.fillRect(hbx - 2, hby - 2, hbw + 4, hbh + 4);
      ctx.strokeRect(hbx - 2, hby - 2, hbw + 4, hbh + 4);
      ctx.restore();
    }
  }

  // Paint one existing-text edit: opaque cover over the original span, then
  // the replacement in the matched font (auto-shrunk to the span width).
  function drawTextEdit(ctx, e, isSelected) {
    if (!pageView || !e || !e.box) return;
    var W = pageView.viewportW, H = pageView.viewportH;
    var bx = e.box.x * W, by = e.box.y * H;
    var bw = e.box.w * W, bh = e.box.h * H;
    ctx.save();
    var fontHeight = Math.max(1, bh);
    var coverX = bx - 0.15 * fontHeight;
    var coverY = by - 0.1 * fontHeight;
    var coverW = bw + 0.3 * fontHeight;
    var coverH = 1.35 * fontHeight;
    if (e.bg) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = e.bg;
      ctx.fillRect(coverX, coverY, Math.max(1, coverW), Math.max(1, coverH));
    }

    var sizePxOrig = Math.max(4, e.size * H);
    var fam = matchPdfFont(e.font);
    ctx.font = canvasFontFor(fam.family, e.bold, e.italic, sizePxOrig);

    const isFormattingEdit = (!e.text || !e.origText || e.text === e.origText);

    var scale = 1;
    if (!isFormattingEdit) {
      var tw = ctx.measureText(e.text || '').width;
      var maxW = (0.85 - e.box.x) * W;
      if (tw > maxW) {
        scale = Math.min(1, maxW / tw);
      }
    }

    var sizePx = sizePxOrig * scale;
    ctx.font = canvasFontFor(fam.family, e.bold, e.italic, sizePx);
    ctx.fillStyle = e.color || '#000000';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    var tx = bx;
    if (e.align === 'center') {
      var tw_final = ctx.measureText(e.text || '').width;
      tx = bx + Math.max(0, (bw - tw_final) / 2);
    } else if (e.align === 'right') {
      var tw_final = ctx.measureText(e.text || '').width;
      tx = bx + Math.max(0, bw - tw_final);
    }

    var baselineY = by + bh;
    ctx.fillText(e.text || '', tx, baselineY);
    ctx.restore();
    if (isSelected) {
      ctx.save();
      ctx.strokeStyle = '#1d4ed8';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(bx - 4, by - 4, bw + 8, bh + 8);
      ctx.restore();
    }
  }

  // Hit-test text edits (checked before markups in select mode).
  function hitEdit(pageId, fx, fy) {
    var items = editsForPage(project, pageId);
    for (let i = items.length - 1; i >= 0; i--) {
      const b = items[i].box;
      if (!b) continue;
      const tol = 0.008;
      if (fx >= b.x - tol && fx <= b.x + b.w + tol && fy >= b.y - tol && fy <= b.y + b.h + tol) {
        return items[i];
      }
    }
    return null;
  }

  // BBox in fractions for hit-testing / selection outline.
  function markupBBox(m) {
    if (!pageView) return null;
    if (m.kind === 'text') {
      const lines = String(m.text || '').split('\n');
      const w = Math.max(0.02, (Math.max.apply(null, lines.map(l => l.length).concat([1])) * m.size * 0.55));
      return { x: m.x, y: m.y, w: w, h: m.size * 1.2 * lines.length };
    }
    if (m.kind === 'image') {
      const rec = imageFiles[m.file];
      let h = m.w;
      if (rec && rec.w > 0 && rec.h > 0 && pageView.viewportW > 0 && pageView.viewportH > 0) {
        h = m.w * (pageView.viewportW / pageView.viewportH) / (rec.w / rec.h);
      }
      return { x: m.x, y: m.y, w: m.w, h: h };
    }
    if (m.kind === 'rect' || m.kind === 'ellipse') return { x: m.x, y: m.y, w: m.w, h: m.h };
    if (m.kind === 'line') {
      return {
        x: Math.min(m.x1, m.x2), y: Math.min(m.y1, m.y2),
        w: Math.max(0.004, Math.abs(m.x2 - m.x1)), h: Math.max(0.004, Math.abs(m.y2 - m.y1))
      };
    }
    if (m.kind === 'path') {
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      m.points.forEach(function (p) {
        x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
      });
      return { x: x0, y: y0, w: Math.max(0.004, x1 - x0), h: Math.max(0.004, y1 - y0) };
    }
    return null;
  }

  function hitMarkup(pageId, fx, fy) {
    var items = markupsForPage(project, pageId);
    for (let i = items.length - 1; i >= 0; i--) {
      const bb = markupBBox(items[i]);
      if (!bb) continue;
      const tol = 0.012;
      if (fx >= bb.x - tol && fx <= bb.x + bb.w + tol && fy >= bb.y - tol && fy <= bb.y + bb.h + tol) {
        return items[i];
      }
    }
    return null;
  }

  function canvasFrac(e) {
    var overlay = $('pdfOverlayCanvas');
    var r = overlay.getBoundingClientRect();
    var px = (e.clientX - r.left) * (overlay.width / Math.max(1, r.width));
    var py = (e.clientY - r.top) * (overlay.height / Math.max(1, r.height));
    return pxToFrac(px, py);
  }

  function toolDefaults(kind) {
    var color = ($('pdfColorInput') && $('pdfColorInput').value) || '#000000';
    var sizePct = parseFloat(($('pdfSizeInput') && $('pdfSizeInput').value) || '4');
    var size = Math.min(0.4, Math.max(0.01, (Number.isFinite(sizePct) ? sizePct : 4) / 100));
    var text = ($('pdfTextInput') && $('pdfTextInput').value) || 'New text';
    if (kind === 'text') return { text: text.slice(0, 500), color: color, size: size };
    if (kind === 'image') return { file: Math.max(0, imageFiles.length - 1) };
    if (kind === 'pen') return { stroke: color, strokeWidth: 2.5 };
    if (kind === 'highlight') return { fill: '#FFFF00', fillOpacity: 0.35, stroke: null, strokeWidth: 0 };
    if (kind === 'rect') return { fill: null, fillOpacity: 1, stroke: color, strokeWidth: 2 };
    if (kind === 'ellipse') return { fill: null, fillOpacity: 1, stroke: color, strokeWidth: 2 };
    if (kind === 'line') return { stroke: color, strokeWidth: 2.5 };
    if (kind === 'whiteout') return { fill: '#FFFFFF', fillOpacity: 1, stroke: null, strokeWidth: 0 };
    return {};
  }

  function onOverlayDown(e) {
    if (!project || !pageView) return;
    var page = selectedPage();
    if (!page) { setStatus('Add a source PDF first.', false); return; }
    if (editingText) return;
    e.preventDefault();
    var start = canvasFrac(e);
    if (tool === 'edit') {
      // EDIT mode touches existing PDF text only — never annotations.
      var hitE = hitEdit(page.id, start.x, start.y);
      if (hitE) {
        project.selectedEditId = hitE.id;
        project.selectedMarkupId = null;
        startSpanEdit(page, { x: hitE.box.x, y: hitE.box.y, w: hitE.box.w, h: hitE.box.h, text: hitE.origText || hitE.text, size: hitE.size, fontName: hitE.font }, hitE);
        return;
      }
      var span = hitSpan(page.id, start.x, start.y);
      if (!span) { setStatus('Click directly on existing PDF text to edit it.', false); return; }
      var prior = findEditForSpan(project, page.id, { x: span.x, y: span.y, w: span.w, h: span.h }, span.text);
      startSpanEdit(page, span, prior);
      return;
    }
    if (tool === 'select') {
      const hitE = hitEdit(page.id, start.x, start.y);
      if (hitE) {
        project.selectedEditId = hitE.id;
        project.selectedMarkupId = null;
        drawOverlay(); renderInspector();
        return;
      }
      const hit = hitMarkup(page.id, start.x, start.y);
      if (!hit) { project.selectedMarkupId = null; project.selectedEditId = null; drawOverlay(); renderInspector(); return; }
      project.selectedMarkupId = hit.id;
      project.selectedEditId = null;
      // SE-corner resize handle?
      const bb = markupBBox(hit);
      const seTol = 14 / Math.max(1, pageView.viewportW);
      const resizing = bb && start.x >= bb.x + bb.w - seTol && start.y >= bb.y + bb.h - seTol;
      drag = {
        kind: 'gesture', mode: resizing ? 'resize' : 'move', id: hit.id,
        startX: start.x, startY: start.y,
        orig: JSON.parse(JSON.stringify(hit))
      };
      drawOverlay(); renderInspector();
      return;
    }
    if (tool === 'text') {
      try {
        checkpoint();
        const m = addMarkup(project, page.id, 'text', Object.assign({ x: start.x, y: start.y }, toolDefaults('text')));
        project.selectedMarkupId = m.id;
        project.selectedEditId = null;
      } catch (err) { setStatus(err.message || 'Cannot add text.', false); return; }
      updateUndoButtons();
      drawOverlay(); renderPageList(); renderInspector();
      return;
    }
    if (tool === 'image') {
      if (!imageFiles.length) { setStatus('Choose overlay image file(s) first.', false); return; }
      try {
        checkpoint();
        const m = addMarkup(project, page.id, 'image', Object.assign({ x: start.x, y: start.y }, toolDefaults('image')));
        project.selectedMarkupId = m.id;
        project.selectedEditId = null;
      } catch (err) { setStatus(err.message || 'Cannot add image.', false); return; }
      updateUndoButtons();
      drawOverlay(); renderInspector();
      return;
    }
    // Box / line / pen gestures.
    drag = { kind: 'gesture', mode: 'draw', tool: tool, startX: start.x, startY: start.y, points: [[start.x, start.y]] };
  }

  function onOverlayMove(e) {
    var overlay = $('pdfOverlayCanvas');
    var page = selectedPage();
    if (!drag || drag.kind !== 'gesture' || !project) {
      if (!editingText && page && overlay) {
        var curPos = canvasFrac(e);
        if (tool === 'edit') {
          var sp = hitSpan(page.id, curPos.x, curPos.y);
          var edHit = hitEdit(page.id, curPos.x, curPos.y);
          var nextSpan = sp || (edHit ? { x: edHit.box.x, y: edHit.box.y, w: edHit.box.w, h: edHit.box.h } : null);
          if (nextSpan !== hoveredSpan) {
            hoveredSpan = nextSpan;
            overlay.style.cursor = nextSpan ? 'text' : 'default';
            paintOverlay();
          }
        } else {
          if (hoveredSpan) { hoveredSpan = null; paintOverlay(); }
          overlay.style.cursor = tool === 'select' ? 'default' : (tool === 'pen' || tool === 'highlight' || tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'whiteout' ? 'crosshair' : 'default');
        }
      }
      return;
    }
    e.preventDefault();
    var cur = canvasFrac(e);
    if (drag.mode === 'move' || drag.mode === 'resize') {
      const m = getMarkup(project, drag.id);
      if (!m) { drag = null; return; }
      const dx = cur.x - drag.startX, dy = cur.y - drag.startY;
      try {
        if (drag.mode === 'move') {
          if (m.kind === 'text' || m.kind === 'image' || m.kind === 'rect' || m.kind === 'ellipse') {
            updateMarkup(project, m.id, { x: drag.orig.x + dx, y: drag.orig.y + dy });
          } else if (m.kind === 'line') {
            updateMarkup(project, m.id, {
              x1: drag.orig.x1 + dx, y1: drag.orig.y1 + dy,
              x2: drag.orig.x2 + dx, y2: drag.orig.y2 + dy
            });
          } else if (m.kind === 'path') {
            updateMarkup(project, m.id, {
              points: drag.orig.points.map(p => [p[0] + dx, p[1] + dy])
            });
          }
        } else {
          // SE resize.
          if (m.kind === 'text') {
            const h0 = Math.max(0.02, markupBBox(drag.orig).h);
            const h1 = Math.max(0.02, (drag.orig.y + markupBBox(drag.orig).h + dy) - drag.orig.y);
            updateMarkup(project, m.id, { size: drag.orig.size * (h1 / h0) });
          } else if (m.kind === 'image' || m.kind === 'rect' || m.kind === 'ellipse') {
            updateMarkup(project, m.id, {
              w: Math.max(0.01, drag.orig.w + dx),
              ...(m.kind === 'rect' || m.kind === 'ellipse' ? { h: Math.max(0.005, drag.orig.h + dy) } : {})
            });
          } else if (m.kind === 'line') {
            updateMarkup(project, m.id, { x2: drag.orig.x2 + dx, y2: drag.orig.y2 + dy });
          }
        }
      } catch (err) { /* clamp: ignore out-of-range moves */ }
      // Live repaint; inspector commits on release so focus is never stolen.
      paintOverlay();
      return;
    }
    if (drag.mode === 'draw') {
      if (drag.tool === 'pen') drag.points.push([cur.x, cur.y]);
      else { drag.curX = cur.x; drag.curY = cur.y; }
      // Repaint from scratch, then the in-progress ghost (no smearing).
      paintOverlay();
      var overlayCanvas = $('pdfOverlayCanvas');
      var ctx = overlayCanvas ? overlayCanvas.getContext('2d') : null;
      if (!ctx) return;
      var ghost = null;
      if (drag.tool === 'pen') {
        ghost = { kind: 'path', points: drag.points, stroke: toolDefaults('pen').stroke, strokeWidth: 2.5, opacity: 1 };
      } else {
        const x = Math.min(drag.startX, drag.curX === undefined ? drag.startX : drag.curX);
        const y = Math.min(drag.startY, drag.curY === undefined ? drag.startY : drag.curY);
        const w = Math.abs((drag.curX === undefined ? drag.startX : drag.curX) - drag.startX);
        const h = Math.abs((drag.curY === undefined ? drag.startY : drag.curY) - drag.startY);
        if (drag.tool === 'line') {
          ghost = { kind: 'line', x1: drag.startX, y1: drag.startY, x2: drag.curX, y2: drag.curY, stroke: toolDefaults('line').stroke, strokeWidth: 2.5, opacity: 1 };
        } else {
          const d = toolDefaults(drag.tool);
          ghost = Object.assign({ kind: drag.tool === 'ellipse' ? 'ellipse' : 'rect', x: x, y: y, w: Math.max(0.004, w), h: Math.max(0.004, h) }, d);
        }
      }
      if (ghost) drawMarkupShape(ctx, ghost, false);
    }
  }

  function onOverlayUp(e) {
    if (!drag || drag.kind !== 'gesture' || !project) { drag = null; return; }
    var page = selectedPage();
    var d = drag;
    drag = null;
    if (!page) return;
    if (d.mode === 'move' || d.mode === 'resize') {
      checkpoint();
      updateUndoButtons();
      drawOverlay();
      renderInspector();
      return;
    }
    var cur = canvasFrac(e);
    try {
      if (d.tool === 'pen') {
        if (d.points.length >= 2) {
          checkpoint();
          const m = addMarkup(project, page.id, 'path', { points: d.points, stroke: toolDefaults('pen').stroke, strokeWidth: 2.5 });
          project.selectedMarkupId = m.id;
          project.selectedEditId = null;
          updateUndoButtons();
        }
      } else if (d.tool === 'line') {
        checkpoint();
        const m = addMarkup(project, page.id, 'line', {
          x1: d.startX, y1: d.startY, x2: cur.x, y2: cur.y,
          stroke: toolDefaults('line').stroke, strokeWidth: 2.5
        });
        project.selectedMarkupId = m.id;
        project.selectedEditId = null;
        updateUndoButtons();
      } else {
        // Box tools: highlight / rect / ellipse / whiteout.
        const kind = d.tool === 'ellipse' ? 'ellipse' : 'rect';
        const x = Math.min(d.startX, cur.x), y = Math.min(d.startY, cur.y);
        const w = Math.abs(cur.x - d.startX), h = Math.abs(cur.y - d.startY);
        if (w < 0.004 || h < 0.004) { drawOverlay(); return; }
        checkpoint();
        const m = addMarkup(project, page.id, kind, Object.assign({ x: x, y: y, w: w, h: h }, toolDefaults(d.tool)));
        project.selectedMarkupId = m.id;
        project.selectedEditId = null;
        updateUndoButtons();
      }
    } catch (err) { setStatus(err.message || 'Cannot add markup.', false); }
    drawOverlay(); renderInspector();
  }

  function onOverlayDblClick(e) {
    if (!project || !pageView) return;
    var page = selectedPage();
    if (!page) return;
    var f = canvasFrac(e);
    var hitE = hitEdit(page.id, f.x, f.y);
    if (hitE) {
      project.selectedEditId = hitE.id;
      project.selectedMarkupId = null;
      startSpanEdit(page, { x: hitE.box.x, y: hitE.box.y, w: hitE.box.w, h: hitE.box.h, text: hitE.origText || hitE.text, size: hitE.size, fontName: hitE.font }, hitE);
      return;
    }
    var hit = hitMarkup(page.id, f.x, f.y);
    if (hit && hit.kind === 'text') {
      project.selectedMarkupId = hit.id;
      project.selectedEditId = null;
      startTextEdit(hit.id);
    }
  }

  // Inline text editing (mirrors the video editor pattern).
  function startTextEdit(id) {
    var m = getMarkup(project, id);
    var overlay = $('pdfOverlayCanvas');
    var stack = $('pdfCanvasStack');
    if (!m || m.kind !== 'text' || !overlay || !stack || editingText) return;
    editingText = true;
    var p = fracToPx(m.x, m.y);
    var r = overlay.getBoundingClientRect();
    var scaleCss = r.width / Math.max(1, overlay.width);
    var input = document.createElement('textarea');
    input.className = 'pdf-textedit';
    input.setAttribute('data-testid', 'pdf-editor-text-edit');
    input.maxLength = 500;
    input.rows = Math.max(1, String(m.text).split('\n').length);
    input.value = m.text || '';
    input.style.left = (p.x * scaleCss) + 'px';
    input.style.top = (p.y * scaleCss) + 'px';
    input.style.width = Math.max(120, (markupBBox(m).w * overlay.width) * scaleCss + 20) + 'px';
    input.style.fontSize = Math.max(10, m.size * overlay.height * scaleCss) + 'px';
    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      try { stack.removeChild(input); } catch (e) {}
      editingText = false;
      if (commit) {
        const v = input.value.trim();
        if (v) {
          try { updateMarkup(project, id, { text: v.slice(0, 500) }); setStatus('', true); }
          catch (err) { setStatus(err.message || 'Invalid text.', false); }
        } else {
          setStatus('Text cannot be empty (delete the markup instead).', false);
        }
      }
      drawOverlay(); renderInspector();
    }
    input.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
    input.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Escape') finish(false);
      else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) finish(true);
    });
    input.addEventListener('blur', function () { finish(true); });
    stack.appendChild(input);
    try { input.focus(); input.select(); } catch (err) {}
  }

  // Inline editor for EXISTING pdf text (EDIT mode): the textarea is styled
  // from the span metrics so editing feels in place. Plain Enter commits
  // (single-line replacements); Escape cancels; blur commits.
  function startSpanEdit(page, span, existing) {
    var overlay = $('pdfOverlayCanvas');
    var stack = $('pdfCanvasStack');
    if (!project || !page || !span || !overlay || !stack || editingText) return;
    if (!pageView || pageView.pageId !== page.id) return;
    editingText = true;
    var base = existing || {
      text: span.text, font: matchPdfFont(span.fontName).family,
      bold: matchPdfFont(span.fontName).bold, italic: matchPdfFont(span.fontName).italic,
      size: span.size, color: '#000000', align: 'left'
    };
    var sampled = sampleSpanColors({ x: span.x, y: span.y, w: span.w, h: span.h });
    var input = document.createElement('textarea');
    input.className = 'pdf-textedit pdf-spanedit';
    input.setAttribute('data-testid', 'pdf-editor-span-edit');
    input.maxLength = 500;
    input.rows = 1;
    input.value = base.text || '';
    var p = { x: span.x * overlay.width, y: span.y * overlay.height };
    var r = overlay.getBoundingClientRect();
    var scaleCss = r.width / Math.max(1, overlay.width);
    input.style.left = (p.x * scaleCss) + 'px';
    input.style.top = (p.y * scaleCss) + 'px';
    input.style.width = Math.max(120, span.w * overlay.width * scaleCss + 20) + 'px';
    input.style.fontSize = Math.max(10, span.size * overlay.height * scaleCss) + 'px';
    input.style.fontFamily = canvasFontFor(base.font, base.bold, base.italic, 12).replace(/^[a-z ]+\d+px\s+/, '');
    input.style.fontWeight = base.bold ? '700' : '400';
    input.style.fontStyle = base.italic ? 'italic' : 'normal';
    input.style.color = (existing && existing.color) || sampled.text;
    input.style.textAlign = 'left';
    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      try { stack.removeChild(input); } catch (e) {}
      editingText = false;
      if (commit) {
        const v = input.value.trim();
        if (!v) {
          setStatus('Replacement text cannot be empty.', false);
        } else {
          try {
            checkpoint();
            var boxWPx = Math.max(1, span.w * overlay.width);
            var sizePx = Math.max(4, span.size * overlay.height);
            var align = base.align || 'left';
            var maxAvailableW = boxWPx;
            var W = overlay.width;
            if (align === 'left') {
              maxAvailableW = Math.max(boxWPx, (0.85 - span.x) * W);
            } else if (align === 'right') {
              maxAvailableW = Math.max(boxWPx, (span.x + span.w - 0.1) * W);
            } else {
              var cx = span.x + span.w / 2;
              maxAvailableW = Math.max(boxWPx, Math.min(cx - 0.1, 0.9 - cx) * 2 * W);
            }
            var fit = editFitScale(measureEditLine(v.slice(0, 500), base.font, base.bold, base.italic, sizePx), boxWPx, maxAvailableW);
            var rec = {
              text: v.slice(0, 500),
              font: base.font, bold: base.bold, italic: base.italic, size: span.size,
              color: (existing && existing.color) || sampled.text,
              align: (existing && existing.align) || 'left',
              bg: (existing && existing.bg !== undefined) ? existing.bg : sampled.bg,
              fitScale: fit
            };
            if (existing) {
              updateTextEdit(project, existing.id, rec);
              project.selectedEditId = existing.id;
            } else {
              var created = addTextEdit(project, page.id,
                { x: span.x, y: span.y, w: span.w, h: span.h, text: span.text, size: span.size, fontName: span.fontName }, rec.text, rec);
              project.selectedEditId = created.id;
            }
            project.selectedMarkupId = null;
            setStatus('', true);
          } catch (err) { setStatus(err.message || 'Invalid replacement.', false); }
        }
      }
      updateUndoButtons();
      drawOverlay(); renderInspector();
    }
    input.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
    input.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Escape') finish(false);
      else if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); }
    });
    input.addEventListener('blur', function () { finish(true); });
    stack.appendChild(input);
    try { input.focus(); input.select(); } catch (err) {}
  }

  // ---- inspector ----
  function numField(name, value, step, min, max) {
    return '<label>' + escapeHtml(name) + ' <input type="number" data-insp="' + name + '" value="' + value + '" step="' + step + '"' +
      (min !== undefined ? ' min="' + min + '"' : '') + (max !== undefined ? ' max="' + max + '"' : '') + '></label>';
  }

  function renderInspector() {
    var box = $('pdfInspector');
    if (!box || !project) return;
    var page = selectedPage();
    var m = selectedMarkup();
    var ed = selectedEdit();
    var html = '';
    if (page) {
      const idx = project.pages.findIndex(p => p.id === page.id);
      const file = getPdfFile(project, page.file);
      html += '<div><strong>Page ' + (idx + 1) + ' / ' + project.pages.length + '</strong> <span class="muted">(' +
        escapeHtml((file && file.name) || '?') + ' p' + page.page + ' · ⟳' + page.rotate + '°)</span></div>';
      html += '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;">' +
        '<button type="button" class="button small secondary" data-pgop="rot">⟳ Rotate</button> ' +
        '<button type="button" class="button small secondary" data-pgop="dup">⧉ Duplicate</button> ' +
        '<button type="button" class="button small secondary" data-pgop="ext">✂ Extract</button> ' +
        '<button type="button" class="button small secondary" data-pgop="left">← Move</button> ' +
        '<button type="button" class="button small secondary" data-pgop="right">Move →</button> ' +
        '<button type="button" class="button small secondary" data-pgop="del">✕ Delete</button></div>';
    }
    if (ed) {
      html += '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #e2e8f0;"><strong>Existing Text Edit</strong> <span class="muted">(cover & rewrite)</span>';
      html += '<div style="margin-top:4px;padding:6px 8px;background-color:#f0fdf4;border:1px solid #bbf7d0;border-radius:4px;font-size:11px;color:#166534;line-height:1.4;font-weight:500;">' +
        'Existing text formatting is preserved. Use Add Text when you need custom formatting.' +
        '</div>';
      if (ed.origText) {
        html += '<div class="muted" style="font-size:11px;margin-top:4px;">Original: <code>' + escapeHtml(ed.origText) + '</code></div>';
      }
      html += '<div style="margin-top:6px;"><label style="width:100%;">Replacement text <input type="text" data-ed="text" maxlength="500" value="' +
        escapeHtml(ed.text) + '" style="flex:1;"></label></div>';
      html += '<div style="margin-top:4px;"><label>Cover bg <input type="color" data-ed="bg" value="' + escapeHtml(ed.bg || '#ffffff') + '"></label> ' +
        '<label style="font-size:11px;"><input type="checkbox" data-ed="bgOn"' + (ed.bg ? ' checked' : '') + '> cover</label></div>';
      var fitPct = Math.round((ed.fitScale || 1) * 100);
      html += '<div class="muted" style="font-size:11px;margin-top:3px;">Auto-shrink scale: ' + fitPct + '%' + (fitPct < 100 ? ' (shrunk to fit box)' : ' (fits original width)') + '</div>';
      html += ' <div style="margin-top:6px;"><button type="button" class="button small secondary" data-edop="del">Delete text edit</button></div></div>';
    } else if (m) {
      html += '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #e2e8f0;"><strong>Markup</strong> <span class="muted">(' + m.kind + ')</span>';
      if (m.kind === 'text') {
        html += '<div style="margin-top:4px;"><label style="width:100%;">Text <input type="text" data-insp="text" maxlength="500" value="' +
          escapeHtml(m.text) + '" style="flex:1;"></label></div><div>' +
          numField('sizePct', Math.round(m.size * 1000) / 10, 0.5, 1, 40) +
          ' <label>Color <input type="color" data-insp="color" value="' + escapeHtml(m.color) + '"></label>' +
          ' <label>Align <select data-insp="align"><option value="left"' + (m.align === 'left' ? ' selected' : '') + '>left</option>' +
          '<option value="center"' + (m.align === 'center' ? ' selected' : '') + '>center</option>' +
          '<option value="right"' + (m.align === 'right' ? ' selected' : '') + '>right</option></select></label></div>';
        html += '<div>' + numField('x', Math.round(m.x * 1000) / 10, 0.5) + ' ' + numField('y', Math.round(m.y * 1000) / 10, 0.5) + ' <span class="muted">position %</span></div>';
      } else if (m.kind === 'image') {
        html += '<div>' + numField('x', Math.round(m.x * 1000) / 10, 0.5) + ' ' + numField('y', Math.round(m.y * 1000) / 10, 0.5) + ' ' +
          numField('w', Math.round(m.w * 1000) / 10, 0.5, 1, 100) + ' <span class="muted">% (height auto)</span></div>';
      } else if (m.kind === 'rect' || m.kind === 'ellipse') {
        html += '<div>' + numField('x', Math.round(m.x * 1000) / 10, 0.5) + ' ' + numField('y', Math.round(m.y * 1000) / 10, 0.5) + ' ' +
          numField('w', Math.round(m.w * 1000) / 10, 0.5) + ' ' + numField('h', Math.round(m.h * 1000) / 10, 0.5) + '</div>';
        html += '<div><label>Fill <input type="color" data-insp="fill" value="' + escapeHtml(m.fill || '#ffffff') + '"></label> ' +
          '<label style="font-size:11px;"><input type="checkbox" data-insp="fillOn"' + (m.fill ? ' checked' : '') + '> fill</label> ' +
          numField('fillOpacity', m.fillOpacity, 0.05, 0, 1) + '</div>';
        html += '<div><label>Stroke <input type="color" data-insp="stroke" value="' + escapeHtml(m.stroke || '#000000') + '"></label> ' +
          '<label style="font-size:11px;"><input type="checkbox" data-insp="strokeOn"' + (m.stroke ? ' checked' : '') + '> stroke</label> ' +
          numField('strokeWidth', m.strokeWidth, 0.5, 0, 20) + '</div>';
      } else if (m.kind === 'line' || m.kind === 'path') {
        html += '<div><label>Stroke <input type="color" data-insp="stroke" value="' + escapeHtml(m.stroke) + '"></label> ' +
          numField('strokeWidth', m.strokeWidth, 0.5, 0.5, 20) + ' ' + numField('opacity', m.opacity, 0.05, 0, 1) + '</div>';
        html += '<p class="muted" style="font-size:11px;margin:4px 0 0;">Move with the Select tool; edit points by redrawing.</p>';
      }
      html += ' <div style="margin-top:4px;"><button type="button" class="button small secondary" data-mkop="del">Delete markup</button></div></div>';
    } else if (page) {
      html += '<p class="muted" style="margin:8px 0 0;">Select a markup, page, or existing text on the canvas to edit exact values.</p>';
    }
    // Page numbers + watermark.
    var pn = project.pageNumbers;
    html += '<div style="margin-top:10px;padding:10px;background:#f8fafc;border-radius:8px;border:1px solid #f1f5f9;">' +
      '<div style="font-weight:700;font-size:11px;text-transform:uppercase;color:#64748b;margin-bottom:6px;">🔢 Page numbers</div>' +
      '<label style="font-size:12px;"><input type="checkbox" data-doc="pnOn"' + (pn ? ' checked' : '') + '> add page numbers</label>';
    if (pn) {
      html += '<div style="margin-top:4px;">' + numField('pnStart', pn.start, 1, 1) +
        ' <label>Position <select data-doc="pnPosition">' +
        ['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right', 'top-left'].map(function (p) {
          return '<option value="' + p + '"' + (pn.position === p ? ' selected' : '') + '>' + p + '</option>';
        }).join('') + '</select></label> ' + numField('pnFontSize', pn.fontSize, 1, 6, 48) + '</div>';
    }
    html += '</div>';
    var wm = project.watermark;
    html += '<div style="margin-top:8px;padding:10px;background:#f8fafc;border-radius:8px;border:1px solid #f1f5f9;">' +
      '<div style="font-weight:700;font-size:11px;text-transform:uppercase;color:#64748b;margin-bottom:6px;">💧 Text watermark</div>' +
      '<label style="font-size:12px;"><input type="checkbox" data-doc="wmOn"' + (wm ? ' checked' : '') + '> add watermark</label>';
    if (wm) {
      html += '<div style="margin-top:4px;"><label style="width:100%;">Text <input type="text" data-doc="wmText" maxlength="200" value="' +
        escapeHtml(wm.text) + '" style="flex:1;"></label></div><div>' + numField('wmFontSize', wm.fontSize, 2, 12, 200) + ' ' +
        numField('wmOpacity', wm.opacity, 0.05, 0, 1) + ' ' + numField('wmAngle', wm.angle, 1, -90, 90) + '</div>';
    }
    html += '</div>';
    box.innerHTML = html;
    wireInspector(box);
  }

  function readNum(box, name) {
    var el = box.querySelector('[data-insp="' + name + '"], [data-ed="' + name + '"]');
    if (!el) return null;
    var v = parseFloat(el.value);
    return Number.isFinite(v) ? v : null;
  }

  function applyEditFields(box, ed) {
    var fail = function (error) { return { ok: false, error: error }; };
    try {
      var props = {};
      var tv = box.querySelector('[data-ed="text"]');
      if (tv) {
        var t = tv.value.trim();
        if (!t) return fail('Replacement text cannot be empty.');
        props.text = t.slice(0, 500);
      }
      var fv = box.querySelector('[data-ed="font"]');
      if (fv) props.font = fv.value;
      var bv = box.querySelector('[data-ed="bold"]');
      if (bv) props.bold = bv.checked;
      var iv = box.querySelector('[data-ed="italic"]');
      if (iv) props.italic = iv.checked;
      var sz = readNum(box, 'edSizePct');
      if (sz !== null) props.size = sz / 100;
      var cv = box.querySelector('[data-ed="color"]');
      if (cv) props.color = cv.value;
      var al = box.querySelector('[data-ed="align"]');
      if (al) props.align = al.value;
      var bgOn = box.querySelector('[data-ed="bgOn"]');
      var bg = box.querySelector('[data-ed="bg"]');
      if (bgOn && bg) props.bg = bgOn.checked ? bg.value : null;

      // Recalculate auto-shrink scale
      if (pageView) {
        var overlay = $('pdfOverlayCanvas');
        var curText = props.text !== undefined ? props.text : ed.text;
        var curFont = props.font !== undefined ? props.font : ed.font;
        var curBold = props.bold !== undefined ? props.bold : ed.bold;
        var curItalic = props.italic !== undefined ? props.italic : ed.italic;
        var curSize = props.size !== undefined ? props.size : ed.size;
        var curAlign = props.align !== undefined ? props.align : ed.align;
        var boxWPx = Math.max(1, ed.box.w * (overlay ? overlay.width : pageView.viewportW));
        var sizePx = Math.max(4, curSize * (overlay ? overlay.height : pageView.viewportH));
        
        var align = curAlign || 'left';
        var maxAvailableW = boxWPx;
        var W = overlay ? overlay.width : pageView.viewportW;
        if (align === 'left') {
          maxAvailableW = Math.max(boxWPx, (0.85 - ed.box.x) * W);
        } else if (align === 'right') {
          maxAvailableW = Math.max(boxWPx, (ed.box.x + ed.box.w - 0.1) * W);
        } else {
          var cx = ed.box.x + ed.box.w / 2;
          maxAvailableW = Math.max(boxWPx, Math.min(cx - 0.1, 0.9 - cx) * 2 * W);
        }
        props.fitScale = editFitScale(measureEditLine(curText, curFont, curBold, curItalic, sizePx), boxWPx, maxAvailableW);
      }
      updateTextEdit(project, ed.id, props);
    } catch (err) { return fail(err.message || 'Invalid value.'); }
    return { ok: true };
  }

  function applyMarkupFields(box, m) {
    var fail = function (error) { return { ok: false, error: error }; };
    try {
      if (m.kind === 'text') {
        var tv = box.querySelector('[data-insp="text"]');
        if (tv) {
          const t = tv.value.trim();
          if (!t) return fail('Text cannot be empty (delete the markup instead).');
          updateMarkup(project, m.id, { text: t.slice(0, 500) });
        }
        var sizePct = readNum(box, 'sizePct');
        if (sizePct !== null) updateMarkup(project, m.id, { size: sizePct / 100 });
        var color = box.querySelector('[data-insp="color"]');
        if (color) updateMarkup(project, m.id, { color: color.value });
        var align = box.querySelector('[data-insp="align"]');
        if (align) updateMarkup(project, m.id, { align: align.value });
        var x = readNum(box, 'x'), y = readNum(box, 'y');
        if (x !== null) updateMarkup(project, m.id, { x: x / 100 });
        if (y !== null) updateMarkup(project, m.id, { y: y / 100 });
      } else if (m.kind === 'image') {
        var ix = readNum(box, 'x'), iy = readNum(box, 'y'), iw = readNum(box, 'w');
        if (ix !== null) updateMarkup(project, m.id, { x: ix / 100 });
        if (iy !== null) updateMarkup(project, m.id, { y: iy / 100 });
        if (iw !== null) updateMarkup(project, m.id, { w: iw / 100 });
      } else if (m.kind === 'rect' || m.kind === 'ellipse') {
        var props = {};
        ['x', 'y', 'w', 'h'].forEach(function (k) {
          var v = readNum(box, k);
          if (v !== null) props[k] = v / 100;
        });
        var fillOn = box.querySelector('[data-insp="fillOn"]');
        var fill = box.querySelector('[data-insp="fill"]');
        if (fillOn && fill) props.fill = fillOn.checked ? fill.value : null;
        var fo = readNum(box, 'fillOpacity');
        if (fo !== null) props.fillOpacity = fo;
        var strokeOn = box.querySelector('[data-insp="strokeOn"]');
        var stroke = box.querySelector('[data-insp="stroke"]');
        if (strokeOn && stroke) props.stroke = strokeOn.checked ? stroke.value : null;
        var sw = readNum(box, 'strokeWidth');
        if (sw !== null) props.strokeWidth = sw;
        updateMarkup(project, m.id, props);
      } else if (m.kind === 'line' || m.kind === 'path') {
        var stroke2 = box.querySelector('[data-insp="stroke"]');
        if (stroke2) updateMarkup(project, m.id, { stroke: stroke2.value });
        var sw2 = readNum(box, 'strokeWidth');
        if (sw2 !== null) updateMarkup(project, m.id, { strokeWidth: sw2 });
        var op = readNum(box, 'opacity');
        if (op !== null) updateMarkup(project, m.id, { opacity: op });
      }
    } catch (err) { return fail(err.message || 'Invalid value.'); }
    return { ok: true };
  }

  function applyDocFields(box) {
    // Page numbers.
    var pnOn = box.querySelector('[data-doc="pnOn"]');
    if (pnOn) {
      if (!pnOn.checked) { setPageNumbers(project, null); }
      else {
        const cur = project.pageNumbers || { start: 1, position: 'bottom-center', margin: 0.04, fontSize: 11, color: '#000000' };
        var startEl = box.querySelector('[data-insp="pnStart"], [data-doc="pnStart"]');
        var start = startEl ? parseInt(startEl.value, 10) : cur.start;
        // numField renders data-insp="pnStart".
        var startInsp = box.querySelector('[data-insp="pnStart"]');
        if (startInsp) start = parseInt(startInsp.value, 10);
        var posEl = box.querySelector('[data-doc="pnPosition"]');
        var fsEl = box.querySelector('[data-insp="pnFontSize"]');
        try {
          setPageNumbers(project, {
            start: Number.isFinite(start) ? start : cur.start,
            position: posEl ? posEl.value : cur.position,
            margin: cur.margin,
            fontSize: fsEl ? parseFloat(fsEl.value) : cur.fontSize,
            color: cur.color
          });
        } catch (err) { return { ok: false, error: err.message }; }
      }
    }
    var wmOn = box.querySelector('[data-doc="wmOn"]');
    if (wmOn) {
      if (!wmOn.checked) { setWatermark(project, null); }
      else {
        const cur = project.watermark || { text: 'DRAFT', fontSize: 64, color: '#888888', opacity: 0.25, angle: -45 };
        var tEl = box.querySelector('[data-doc="wmText"]');
        var fsW = box.querySelector('[data-insp="wmFontSize"]');
        var opW = box.querySelector('[data-insp="wmOpacity"]');
        var anW = box.querySelector('[data-insp="wmAngle"]');
        try {
          setWatermark(project, {
            text: tEl ? tEl.value : cur.text,
            fontSize: fsW ? parseFloat(fsW.value) : cur.fontSize,
            color: cur.color,
            opacity: opW ? parseFloat(opW.value) : cur.opacity,
            angle: anW ? parseFloat(anW.value) : cur.angle
          });
        } catch (err) { return { ok: false, error: err.message }; }
      }
    }
    return { ok: true };
  }

  function wireInspector(box) {
    box.querySelectorAll('[data-insp]').forEach(function (el) {
      el.addEventListener('input', function () {
        var m = selectedMarkup();
        if (m && el.closest('#pdfInspector') && box.contains(el)) {
          // Only markup fields live-update; doc fields commit on change.
          if (el.getAttribute('data-insp').startsWith('pn') || el.getAttribute('data-insp').startsWith('wm')) return;
          if (!applyMarkupFields(box, m).ok) return;
          drawOverlay();
        }
      });
      el.addEventListener('change', function () {
        checkpoint();
        var r = applyDocFields(box);
        if (!r.ok) { setStatus(r.error || 'Invalid value.', false); return; }
        var m = selectedMarkup();
        if (m) {
          var r2 = applyMarkupFields(box, m);
          if (!r2.ok) { setStatus(r2.error || 'Invalid value.', false); return; }
        }
        updateUndoButtons();
        setStatus('', true);
        drawOverlay();
        renderInspector();
      });
    });
    box.querySelectorAll('[data-ed]').forEach(function (el) {
      el.addEventListener('input', function () {
        var ed = selectedEdit();
        if (ed && el.closest('#pdfInspector') && box.contains(el)) {
          if (!applyEditFields(box, ed).ok) return;
          drawOverlay();
        }
      });
      el.addEventListener('change', function () {
        var ed = selectedEdit();
        if (ed && el.closest('#pdfInspector') && box.contains(el)) {
          checkpoint();
          var r = applyEditFields(box, ed);
          if (!r.ok) { setStatus(r.error || 'Invalid value.', false); return; }
          updateUndoButtons();
          setStatus('', true);
          drawOverlay();
          renderInspector();
        }
      });
    });
    box.querySelectorAll('[data-doc]').forEach(function (el) {
      el.addEventListener('change', function () {
        checkpoint();
        var r = applyDocFields(box);
        if (!r.ok) { setStatus(r.error || 'Invalid value.', false); return; }
        updateUndoButtons();
        setStatus('', true);
        drawOverlay();
        renderInspector();
      });
    });
    box.querySelectorAll('[data-pgop]').forEach(function (el) {
      el.addEventListener('click', function () {
        var page = selectedPage();
        if (!page) return;
        var act = el.getAttribute('data-pgop');
        if (act === 'dup') {
          try {
            checkpoint();
            duplicateOutputPage(project, page.id);
            updateUndoButtons();
            setStatus('Duplicated page ' + page.page + '.', true);
            renderAll();
          } catch (err) { setStatus(err.message || 'Cannot duplicate page.', false); }
        } else if (act === 'ext') {
          try {
            var extProject = extractPagesToProject(project, [page.id]);
            doExtractExport(extProject, 'extracted-page-' + page.page + '.pdf');
          } catch (err) { setStatus(err.message || 'Cannot extract page.', false); }
        } else {
          pageControl(page.id, act);
        }
      });
    });
    box.querySelectorAll('[data-mkop]').forEach(function (el) {
      el.addEventListener('click', function () {
        var m = selectedMarkup();
        if (!m) return;
        checkpoint();
        deleteMarkup(project, m.id);
        updateUndoButtons();
        drawOverlay();
        renderInspector();
      });
    });
    box.querySelectorAll('[data-edop]').forEach(function (el) {
      el.addEventListener('click', function () {
        var ed = selectedEdit();
        if (!ed) return;
        checkpoint();
        deleteTextEdit(project, ed.id);
        updateUndoButtons();
        drawOverlay();
        renderInspector();
      });
    });
  }

  function renderAll() {
    renderPageList();
    renderMain();
    renderInspector();
  }

  async function doExtractExport(extProject, defaultName) {
    setStatus('Exporting extracted page…', true);
    var spec;
    try { spec = projectToSpec(extProject); }
    catch (err) { setStatus(err.message || 'Cannot export page.', false); return; }
    spec.images = imageFiles.map(function (f) { return { name: f.name }; });
    var fd = new FormData();
    fd.append('spec', JSON.stringify(spec));
    for (const f of extProject.files) {
      const info = pdfDocs.get(f.id);
      if (!info || !info.data) { setStatus('Missing bytes for ' + f.name + '.', false); return; }
      fd.append('pdf', new Blob([info.data], { type: 'application/pdf' }), f.name);
    }
    imageFiles.forEach(function (rec) { fd.append('image', rec.blob, rec.name); });
    try {
      const r = await fetch('/api/admin/pdf-editor/export', { method: 'POST', credentials: 'same-origin', body: fd });
      if (!r.ok) {
        const d = await r.json().catch(function () { return { error: 'Export failed (HTTP ' + r.status + ').' }; });
        throw new Error((d && d.error) || 'Export failed.');
      }
      const blob = await r.blob();
      const name = r.headers.get('X-Export-Filename') || defaultName || 'extracted.pdf';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {} }, 4000);
      setStatus('Exported ' + name + '.', true);
    } catch (err) {
      setStatus(err.message || 'Extract export failed.', false);
    }
  }

  // ---- export ----
  async function doExport() {
    setStatus('', true);
    if (!project || !project.pages.length) { setStatus('Add a source PDF first.', false); return; }
    var spec;
    try {
      spec = projectToSpec(project);
    } catch (err) { setStatus(err.message || 'Invalid project.', false); return; }
    spec.images = imageFiles.map(function (f) { return { name: f.name }; });
    var fd = new FormData();
    fd.append('spec', JSON.stringify(spec));
    for (const f of project.files) {
      const info = pdfDocs.get(f.id);
      if (!info || !info.data) { setStatus('Missing bytes for ' + f.name + '.', false); return; }
      fd.append('pdf', new Blob([info.data], { type: 'application/pdf' }), f.name);
    }
    imageFiles.forEach(function (rec) { fd.append('image', rec.blob, rec.name); });
    var btn = $('pdfExportBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
    setStatus('Exporting…', true);
    try {
      const r = await fetch('/api/admin/pdf-editor/export', { method: 'POST', credentials: 'same-origin', body: fd });
      if (!r.ok) {
        const d = await r.json().catch(function () { return { error: 'Export failed (HTTP ' + r.status + ').' }; });
        throw new Error((d && d.error) || 'Export failed.');
      }
      const blob = await r.blob();
      const name = r.headers.get('X-Export-Filename') || 'edited.pdf';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {} }, 4000);
      setStatus('Exported ' + name + '.', true);
    } catch (err) {
      setStatus(err.message || 'Export failed.', false);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Export new PDF'; }
    }
  }

  // ---- init ----
  function init() {
    var root = document.querySelector('[data-testid="pdf-editor-root"]');
    if (!root) return;
    if (root.getAttribute('data-available') !== '1') return;
    resetPdfProjectIds();
    project = createPdfProject();
    var configuredMb = parseInt(root.getAttribute('data-max-file-mb'), 10);
    if (Number.isFinite(configuredMb) && configuredMb >= 1) {
      maxFileMb = configuredMb;
      maxFileBytes = configuredMb * 1048576;
    }
    var openBtn = $('pdfOpenBtn');
    var pdfInput = $('pdfFile');
    if (openBtn && pdfInput) {
      openBtn.addEventListener('click', function () { pdfInput.click(); });
    }
    var undoBtn = $('pdfUndoBtn');
    if (undoBtn) undoBtn.addEventListener('click', doUndo);
    var redoBtn = $('pdfRedoBtn');
    if (redoBtn) redoBtn.addEventListener('click', doRedo);
    var imgInput = $('pdfImageFile');
    if (pdfInput) {
      pdfInput.addEventListener('change', function () {
        addPdfFiles(pdfInput.files).finally(function () {
          try { pdfInput.value = ''; } catch (err) {}
        });
      });
    }
    if (imgInput) {
      imgInput.addEventListener('change', function () {
        setImageFiles(imgInput.files);
        try { imgInput.value = ''; } catch (err) {}
      });
    }
    document.querySelectorAll('[data-tool]').forEach(function (el) {
      el.addEventListener('click', function () {
        tool = el.getAttribute('data-tool');
        document.querySelectorAll('[data-tool]').forEach(function (x) {
          x.classList.toggle('button', x.getAttribute('data-tool') === tool);
          x.classList.toggle('secondary', x.getAttribute('data-tool') !== tool);
        });
        if (tool === 'image' && !imageFiles.length) {
          if (imgInput) imgInput.click();
          else setStatus('Choose overlay image file(s) first.', false);
        }
      });
    });
    var overlay = $('pdfOverlayCanvas');
    if (overlay) {
      overlay.addEventListener('pointerdown', onOverlayDown);
      overlay.addEventListener('dblclick', onOverlayDblClick);
      window.addEventListener('pointermove', onOverlayMove);
      window.addEventListener('pointerup', onOverlayUp);
      window.addEventListener('pointercancel', function () { drag = null; });
    }
    var del = $('pdfDeleteMarkup');
    if (del) del.addEventListener('click', function () {
      if (project && project.selectedEditId) {
        checkpoint();
        deleteTextEdit(project, project.selectedEditId);
        updateUndoButtons();
        drawOverlay(); renderInspector();
        return;
      }
      var m = selectedMarkup();
      if (!m) { setStatus('Select a markup or text edit first.', false); return; }
      checkpoint();
      deleteMarkup(project, m.id);
      updateUndoButtons();
      drawOverlay(); renderInspector();
    });
    var prev = $('pdfPrevPage'), next = $('pdfNextPage');
    if (prev) prev.addEventListener('click', function () { stepPage(-1); });
    if (next) next.addEventListener('click', function () { stepPage(1); });
    var zin = $('pdfZoomIn'), zout = $('pdfZoomOut');
    if (zin) zin.addEventListener('click', function () {
      zoom = Math.min(3, zoom * 1.2);
      updateZoomLabel();
      renderMain();
    });
    if (zout) zout.addEventListener('click', function () {
      zoom = Math.max(0.4, zoom / 1.2);
      updateZoomLabel();
      renderMain();
    });
    var fitBtn = $('pdfFitBtn');
    if (fitBtn) fitBtn.addEventListener('click', function () {
      var wrap = $('pdfPreviewWrap');
      var page = selectedPage();
      if (!wrap || !page) return;
      var doc = fileDoc(page.file);
      if (!doc) return;
      doc.getPage(page.page).then(function (pdfPage) {
        var base = pdfPage.getViewport({ scale: 1, rotation: page.rotate });
        var pad = 48;
        var targetW = Math.max(200, wrap.clientWidth - pad);
        var targetH = Math.max(200, wrap.clientHeight - pad);
        var scaleW = targetW / Math.max(1, base.width);
        var scaleH = targetH / Math.max(1, base.height);
        var targetScale = Math.min(scaleW, scaleH);
        zoom = Math.min(3, Math.max(0.4, targetScale / (BASE_WIDTH / Math.max(1, base.width))));
        updateZoomLabel();
        renderMain();
      }).catch(function () {});
    });
    var rot = $('pdfRotatePage');
    if (rot) rot.addEventListener('click', function () {
      var p = selectedPage();
      if (p) {
        checkpoint();
        rotateOutputPage(project, p.id);
        updateUndoButtons();
        renderAll();
      }
    });
    var dupP = $('pdfDuplicatePage');
    if (dupP) dupP.addEventListener('click', function () {
      var p = selectedPage();
      if (p) {
        try {
          checkpoint();
          duplicateOutputPage(project, p.id);
          updateUndoButtons();
          setStatus('Duplicated page ' + p.page + '.', true);
          renderAll();
        } catch (err) { setStatus(err.message || 'Cannot duplicate page.', false); }
      }
    });
    var extP = $('pdfExtractPage');
    if (extP) extP.addEventListener('click', function () {
      var p = selectedPage();
      if (p) {
        try {
          var extProject = extractPagesToProject(project, [p.id]);
          doExtractExport(extProject, 'extracted-page-' + p.page + '.pdf');
        } catch (err) { setStatus(err.message || 'Cannot extract page.', false); }
      }
    });
    var delP = $('pdfDeletePage');
    if (delP) delP.addEventListener('click', function () {
      var p = selectedPage();
      if (p) {
        checkpoint();
        removeOutputPage(project, p.id);
        updateUndoButtons();
        renderAll();
      }
    });
    var exp = $('pdfExportBtn');
    if (exp) exp.addEventListener('click', doExport);
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        doRedo();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && project) {
        if (project.selectedEditId) {
          e.preventDefault();
          checkpoint();
          deleteTextEdit(project, project.selectedEditId);
          updateUndoButtons();
          drawOverlay(); renderInspector();
        } else if (project.selectedMarkupId) {
          e.preventDefault();
          checkpoint();
          deleteMarkup(project, project.selectedMarkupId);
          updateUndoButtons();
          drawOverlay(); renderInspector();
        }
      }
    });
    // Preselected library PDF (?path=): fetched read-only; export still
    // produces a new download and the library is never written.
    var preselected = root.getAttribute('data-preselected') || '';
    if (preselected) {
      var streamUrl = '/file/' + preselected.split('/').map(encodeURIComponent).join('/');
      var baseName = preselected.split('/').pop() || 'document.pdf';
      setStatus('Loading preselected PDF…', true);
      fetch(streamUrl, { credentials: 'same-origin' })
        .then(function (r) {
          if (!r.ok) throw new Error('Could not load the preselected PDF (HTTP ' + r.status + '). Select a file manually.');
          return r.blob();
        })
        .then(function (blob) {
          var f;
          try { f = new File([blob], baseName, { type: 'application/pdf' }); }
          catch (err) { f = blob; f.name = baseName; }
          addPdfFiles([f]);
        })
        .catch(function (err) { setStatus(err.message || 'Could not load the preselected PDF.', false); });
    }
    renderAll();
  }

  function stepPage(d) {
    if (!project || !project.pages.length) return;
    var idx = project.pages.findIndex(p => p.id === project.selectedPageId);
    if (idx === -1) idx = 0;
    else idx = Math.min(project.pages.length - 1, Math.max(0, idx + d));
    project.selectedPageId = project.pages[idx].id;
    project.selectedMarkupId = null;
    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
