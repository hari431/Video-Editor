// src/public/admin-pdf-to-images.js — Standalone PDF to Images client (admin-only).
// ES module, no frameworks. Rasterizing needs a 2D canvas, which only exists
// here in the browser: the selected local PDF is opened with the vendored
// pdf.js (no CDN), selected pages render to <canvas> at the chosen scale, and
// each canvas exports via toBlob (PNG lossless, JPEG quality 0.92). The
// source PDF is NEVER uploaded. One rendered page downloads directly; several
// are POSTed to POST /api/admin/pdf-tools/pdf-to-images/zip (validated,
// zipped server-side) and download as a ZIP.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

(function () {
  'use strict';

  var JPEG_QUALITY = 0.92;
  var ALLOWED_SCALES = [1, 1.5, 2, 3];

  function $(id) { return document.getElementById(id); }

  var root = document.querySelector('[data-testid="pdf-to-images-root"]');
  var available = root ? root.getAttribute('data-available') === '1' : false;

  var selected = null; // File
  var selectedBytes = null; // Uint8Array (local copy for pdf.js)
  var pageCount = 0;
  var rendering = false;

  function setStatus(text, ok) {
    var el = $('pdfToImagesStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = text ? (ok ? '#15803d' : '#b91c1c') : '';
  }

  function setResult(text) {
    var el = $('pdfToImagesResult');
    if (!el) return;
    el.textContent = text || '';
  }

  function setProgressVisible(on, pct) {
    var el = $('pdfToImagesProgress');
    if (!el) return;
    el.style.display = on ? 'block' : 'none';
    var pctEl = $('pdfToImagesProgressPct');
    if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  }

  function refresh() {
    var info = $('pdfToImagesFileInfo');
    if (info && !info.dataset.probed) {
      info.textContent = selected
        ? selected.name + ' · ' + pageCount + ' page' + (pageCount === 1 ? '' : 's')
        : 'No PDF selected yet.';
    }
    updatePreview();
    var btn = $('pdfToImagesBtn');
    if (btn) btn.disabled = !available || rendering || !selected;
  }

  function selectedMode() {
    var checked = document.querySelector('input[name="pdfToImagesMode"]:checked');
    return checked ? checked.value : 'all';
  }

  // Local selection parser (mirrors the server grammar): strict
  // "1-3,5,8-10" against the probed page count. Returns { pages } or { error }.
  function parseSelectionLocal(text) {
    if (!text || !text.trim()) return { error: 'Enter pages to render, e.g. 1-3,5,8-10.' };
    var pages = [];
    var seen = {};
    var tokens = text.split(',');
    for (var ti = 0; ti < tokens.length; ti++) {
      var token = tokens[ti].trim();
      if (!token) return { error: 'Empty entry in pages (near comma ' + (ti + 1) + ').' };
      var range = token.split('-').map(function (s) { return s.trim(); });
      if (range.length > 2 || range.some(function (s) { return !s; })) {
        return { error: 'Invalid pages entry "' + token.slice(0, 40) + '".' };
      }
      for (var k = 0; k < range.length; k++) {
        if (!/^\d+$/.test(range[k])) return { error: 'Invalid page "' + range[k].slice(0, 40) + '".' };
      }
      var from = Number(range[0]);
      var to = range.length === 2 ? Number(range[1]) : from;
      if (range.length === 2 && to < from) return { error: 'Reversed range "' + token.slice(0, 40) + '".' };
      for (var p = from; p <= to; p++) {
        if (p < 1 || p > pageCount) return { error: 'Page ' + p + ' is out of range (this PDF has ' + pageCount + ' pages).' };
        if (seen[p]) return { error: 'Duplicate page ' + p + '.' };
        seen[p] = true;
        pages.push(p);
      }
    }
    if (!pages.length) return { error: 'Enter pages to render, e.g. 1-3,5,8-10.' };
    return { pages: pages };
  }

  function resolvePages() {
    var mode = selectedMode();
    if (mode === 'all') {
      var all = [];
      for (var i = 1; i <= pageCount; i++) all.push(i);
      return { pages: all };
    }
    if (mode === 'page') {
      var el = $('pdfToImagesPage');
      var n = el ? Number(String(el.value).trim()) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > pageCount) {
        return { error: 'Enter a page between 1 and ' + pageCount + '.' };
      }
      return { pages: [n] };
    }
    var selEl = $('pdfToImagesSelection');
    return parseSelectionLocal(selEl ? selEl.value : '');
  }

  function updatePreview() {
    var preview = $('pdfToImagesPreview');
    if (!preview) return;
    if (!selected || !pageCount) {
      preview.textContent = '';
      return;
    }
    var resolved = resolvePages();
    var scaleEl = $('pdfToImagesScale');
    var scale = scaleEl ? Number(scaleEl.value) : 2;
    if (resolved.error) {
      preview.textContent = resolved.error;
      return;
    }
    preview.textContent = resolved.pages.length + ' page' + (resolved.pages.length === 1 ? '' : 's') +
      ' selected · ' + scale + 'x scale' +
      (resolved.pages.length === 1 ? ' · direct image download' : ' · ZIP download');
  }

  function safeBase(name) {
    var base = String(name || 'document').split(/[\\/]/).pop() || 'document';
    base = base.replace(/\.pdf$/i, '');
    base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return (base || 'document').slice(0, 80);
  }

  function canvasToBlob(canvas, format) {
    return new Promise(function (resolve, reject) {
      try {
        if (format === 'jpeg') canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
        else canvas.toBlob(resolve, 'image/png');
      } catch (e) { reject(e); return; }
      setTimeout(function () { reject(new Error('Canvas export timed out.')); }, 30000);
    }).then(function (blob) {
      if (!blob) throw new Error('Canvas export failed.');
      return blob;
    });
  }

  // NOTE: race guard — toBlob resolves null on failure; the timeout above
  // rejects only if NEITHER resolve NOR reject fired. A late resolve after a
  // timeout reject is ignored by the promise machinery. No password or file
  // content is ever logged here.
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e2) {} }, 4000);
  }

  async function doConvert() {
    if (rendering) return;
    setStatus('');
    setResult('');
    if (!selected || !selectedBytes) {
      setStatus('Select one PDF file first.', false);
      return;
    }
    if (!/\.pdf$/i.test(selected.name || '')) {
      setStatus('Source file must be .pdf.', false);
      return;
    }
    var resolved = resolvePages();
    if (resolved.error) {
      setStatus(resolved.error, false);
      return;
    }
    var formatEl = $('pdfToImagesFormat');
    var format = formatEl ? formatEl.value : 'png';
    if (format !== 'png' && format !== 'jpeg') {
      setStatus('Format must be PNG or JPEG.', false);
      return;
    }
    var scaleEl = $('pdfToImagesScale');
    var scale = scaleEl ? Number(scaleEl.value) : 2;
    if (ALLOWED_SCALES.indexOf(scale) === -1) {
      setStatus('Resolution must be one of: ' + ALLOWED_SCALES.join(', ') + '.', false);
      return;
    }
    rendering = true;
    refresh();
    setProgressVisible(true, 2);
    try {
      var task = pdfjsLib.getDocument({ data: selectedBytes.slice() });
      var doc = await task.promise;
      var total = Math.min(doc.numPages, pageCount || doc.numPages);
      var renders = [];
      for (var i = 0; i < resolved.pages.length; i++) {
        var n = resolved.pages[i];
        if (n < 1 || n > doc.numPages) throw new Error('Page ' + n + ' is out of range.');
        var page = await doc.getPage(n);
        var viewport = page.getViewport({ scale: scale });
        var canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
        var blob = await canvasToBlob(canvas, format);
        renders.push({ page: n, blob: blob, width: canvas.width, height: canvas.height });
        setProgressVisible(true, 2 + Math.round(93 * (i + 1) / resolved.pages.length));
      }
      try { await task.destroy(); } catch (e) {}
      var base = safeBase(selected.name);
      var pad = String(resolved.pages.length).length;
      if (renders.length === 1) {
        var r = renders[0];
        var singleName = base + '-p' + r.page + '.' + format.replace('jpeg', 'jpg');
        downloadBlob(r.blob, singleName);
        setProgressVisible(true, 100);
        setStatus('Rendered page ' + r.page + ' (' + r.width + '×' + r.height + ' px) — download started (' + singleName + ').', true);
        setResult('Single image downloaded directly.');
      } else {
        var form = new FormData();
        renders.forEach(function (r) {
          var ext = format === 'jpeg' ? 'jpg' : 'png';
          var fname = base + '-p' + String(r.page).padStart(pad, '0') + '.' + ext;
          form.append('image', r.blob, fname);
        });
        form.append('basename', base);
        var res = await fetch('/api/admin/pdf-tools/pdf-to-images/zip', { method: 'POST', body: form, credentials: 'same-origin' });
        if (!res.ok) {
          var msg = 'Packaging failed.';
          try {
            var j = await res.json();
            if (j && j.error) msg = j.error;
          } catch (e) {}
          throw new Error(msg);
        }
        var zipBlob = await res.blob();
        var parts = parseInt(res.headers.get('X-Rendered-Parts') || String(renders.length), 10) || renders.length;
        var headerName = res.headers.get('X-Export-Filename') || (base + '-images.zip');
        downloadBlob(zipBlob, headerName);
        setProgressVisible(true, 100);
        setStatus('Rendered ' + parts + ' pages — ZIP download started (' + headerName + ').', true);
        var dims = renders[0].width + '×' + renders[0].height + ' px';
        setResult(parts + ' images at ' + dims + ' each (' + scale + 'x, ' + format.toUpperCase() + ').');
      }
      setTimeout(function () { setProgressVisible(false); }, 2500);
    } catch (err) {
      setProgressVisible(false);
      var emsg = (err && err.message) || 'Rendering failed.';
      if (err && err.name === 'PasswordException') {
        emsg = 'This PDF is password-protected. Unlock it before converting to images.';
      } else if (/invalid|corrupt|trailer|xref/i.test(emsg)) {
        emsg = 'PDF could not be read (not a valid PDF or corrupt).';
      }
      setStatus(emsg, false);
    } finally {
      rendering = false;
      refresh();
    }
  }

  async function probe(file) {
    // Local-only probe, never uploads: page count + already-protected check.
    var info = $('pdfToImagesFileInfo');
    pageCount = 0;
    selectedBytes = null;
    try {
      var buf = new Uint8Array(await file.arrayBuffer());
      var task = pdfjsLib.getDocument({ data: buf });
      var doc = await task.promise;
      pageCount = doc.numPages;
      selectedBytes = buf;
      if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · ' + pageCount + ' page' + (pageCount === 1 ? '' : 's') + ' · ready to render.';
      }
      try { await task.destroy(); } catch (e) {}
    } catch (err) {
      var name = err && err.name;
      if (name === 'PasswordException') {
        if (info) {
          info.dataset.probed = '1';
          info.textContent = file.name + ' · 🔒 password-protected — unlock it before converting to images.';
        }
      } else if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · could not be previewed here; rendering will validate.';
      }
    }
    refresh();
  }

  function init() {
    var pick = $('pdfToImagesPick');
    var input = $('pdfToImagesFile');
    var btn = $('pdfToImagesBtn');
    var clear = $('pdfToImagesClear');
    if (pick && input) pick.addEventListener('click', function () { input.click(); });
    if (input) input.addEventListener('change', function () {
      setStatus('');
      setResult('');
      selected = (input.files && input.files[0]) || null;
      input.value = '';
      var info = $('pdfToImagesFileInfo');
      if (info) delete info.dataset.probed;
      refresh();
      if (selected) probe(selected);
    });
    var rerender = function () { updatePreview(); };
    ['pdfToImagesFormat', 'pdfToImagesScale', 'pdfToImagesSelection', 'pdfToImagesPage'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('input', rerender);
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="pdfToImagesMode"]'), function (el) {
      el.addEventListener('change', rerender);
    });
    if (btn) btn.addEventListener('click', doConvert);
    if (clear) clear.addEventListener('click', function () {
      selected = null;
      selectedBytes = null;
      pageCount = 0;
      setStatus('');
      setResult('');
      setProgressVisible(false);
      var info = $('pdfToImagesFileInfo');
      if (info) delete info.dataset.probed;
      refresh();
    });
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
