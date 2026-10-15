// src/public/admin-pdf-text.js — Standalone PDF to Text client (admin-only).
// ES module, no frameworks. Preview and download POST the file + scope to
// the info/download endpoints; the server extracts selectable text per page
// (no OCR anywhere) and returns JSON for preview or a .txt download. A local
// pdf.js probe (vendored build, no CDN) reports the page count for range
// validation.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var root = document.querySelector('[data-testid="pdf-text-root"]');
  var available = root ? root.getAttribute('data-available') === '1' : false;
  var maxFileMb = root ? Number(root.getAttribute('data-max-file-mb')) || 50 : 50;
  var maxFileBytes = maxFileMb * 1024 * 1024;

  var selected = null; // File
  var pageCount = 0;
  var working = false;

  function setStatus(text, ok) {
    var el = $('pdfTextStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = text ? (ok ? '#15803d' : '#b91c1c') : '';
  }

  function setResult(text) {
    var el = $('pdfTextResult');
    if (!el) return;
    el.textContent = text || '';
  }

  function setProgressVisible(on, pct) {
    var el = $('pdfTextProgress');
    if (!el) return;
    el.style.display = on ? 'block' : 'none';
    var pctEl = $('pdfTextProgressPct');
    if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  }

  function selectedScope() {
    var checked = document.querySelector('input[name="pdfTextScope"]:checked');
    return checked ? checked.value : 'all';
  }

  function refresh() {
    var info = $('pdfTextFileInfo');
    if (info && !info.dataset.probed) {
      info.textContent = selected
        ? selected.name + ' · ' + pageCount + ' page' + (pageCount === 1 ? '' : 's')
        : 'No PDF selected yet.';
    }
    var preview = $('pdfTextPreviewBtn');
    if (preview) preview.disabled = !available || working || !selected;
    var btn = $('pdfTextBtn');
    if (btn) btn.disabled = !available || working || !selected;
  }

  // Local range pre-check against the probed page count (server re-validates).
  function validateSelectionLocal(text) {
    if (!text || !text.trim()) return 'Enter pages to extract, e.g. 1-3,5.';
    var seen = {};
    var count = 0;
    var tokens = text.split(',');
    for (var ti = 0; ti < tokens.length; ti++) {
      var token = tokens[ti].trim();
      if (!token) return 'Empty entry in pages (near comma ' + (ti + 1) + ').';
      var range = token.split('-').map(function (s) { return s.trim(); });
      if (range.length > 2 || range.some(function (s) { return !s; })) {
        return 'Invalid pages entry "' + token.slice(0, 40) + '".';
      }
      for (var k = 0; k < range.length; k++) {
        if (!/^\d+$/.test(range[k])) return 'Invalid page "' + range[k].slice(0, 40) + '".';
      }
      var from = Number(range[0]);
      var to = range.length === 2 ? Number(range[1]) : from;
      if (range.length === 2 && to < from) return 'Reversed range "' + token.slice(0, 40) + '".';
      for (var p = from; p <= to; p++) {
        if (p < 1 || p > pageCount) return 'Page ' + p + ' is out of range (this PDF has ' + pageCount + ' pages).';
        if (seen[p]) return 'Duplicate page ' + p + '.';
        seen[p] = true;
        count++;
      }
    }
    if (!count) return 'Enter pages to extract, e.g. 1-3,5.';
    return null;
  }

  function collectFields() {
    var scope = selectedScope();
    var selectionEl = $('pdfTextSelection');
    return { scope: scope, selection: selectionEl ? selectionEl.value : '' };
  }

  function checkReady() {
    if (!selected) return 'Select one PDF file first.';
    if (!/\.pdf$/i.test(selected.name || '')) return 'Source file must be .pdf.';
    if (!(selected.size > 0) || selected.size > maxFileBytes) {
      return 'PDF file is empty or exceeds ' + maxFileMb + ' MB.';
    }
    var fields = collectFields();
    if (fields.scope === 'range') {
      var localErr = validateSelectionLocal(fields.selection);
      if (localErr) return localErr;
    }
    return null;
  }

  async function probe(file) {
    // Local-only probe, never uploads: page count + already-protected check.
    var info = $('pdfTextFileInfo');
    pageCount = 0;
    try {
      var buf = new Uint8Array(await file.arrayBuffer());
      var task = pdfjsLib.getDocument({ data: buf });
      var doc = await task.promise;
      pageCount = doc.numPages;
      if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · ' + pageCount + ' page' + (pageCount === 1 ? '' : 's') + ' · ready to extract.';
      }
      try { await task.destroy(); } catch (e) {}
    } catch (err) {
      var name = err && err.name;
      if (name === 'PasswordException') {
        if (info) {
          info.dataset.probed = '1';
          info.textContent = file.name + ' · 🔒 password-protected — unlock it before extracting.';
        }
      } else if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · could not be previewed here; the server will validate.';
      }
    }
    refresh();
  }

  async function postText(endpoint) {
    var fields = collectFields();
    var form = new FormData();
    form.append('pdf', selected, selected.name);
    form.append('scope', fields.scope);
    form.append('selection', fields.selection);
    var res = await fetch(endpoint, { method: 'POST', body: form, credentials: 'same-origin' });
    if (!res.ok) {
      var msg = 'Extraction failed.';
      try {
        var j = await res.json();
        if (j && j.error) msg = j.error;
      } catch (e) {}
      throw new Error(msg);
    }
    return res;
  }

  async function doPreview() {
    if (working) return;
    setStatus('');
    setResult('');
    var readyErr = checkReady();
    if (readyErr) {
      setStatus(readyErr, false);
      return;
    }
    working = true;
    refresh();
    setProgressVisible(true, 30);
    try {
      var res = await postText('/api/admin/pdf-tools/pdf-to-text/info');
      var payload = await res.json();
      var preview = $('pdfTextPreview');
      if (preview) {
        preview.style.display = 'block';
        preview.textContent = (payload.text || '').slice(0, 20000) +
          ((payload.text || '').length > 20000 ? '\n… (preview truncated, download the full .txt)' : '');
      }
      var empty = (payload.pages || []).filter(function (p) { return !p.chars; }).length;
      setProgressVisible(false);
      setStatus('Extracted ' + (payload.pages || []).length + ' page' + ((payload.pages || []).length === 1 ? '' : 's') + '.', true);
      setResult(empty
        ? empty + ' page(s) contain no selectable text (scanned/image-only pages have none — no OCR is performed).'
        : 'All selected pages contain selectable text.');
    } catch (err) {
      setProgressVisible(false);
      setStatus((err && err.message) || 'Extraction failed.', false);
    } finally {
      working = false;
      refresh();
    }
  }

  async function doDownload() {
    if (working) return;
    setStatus('');
    setResult('');
    var readyErr = checkReady();
    if (readyErr) {
      setStatus(readyErr, false);
      return;
    }
    working = true;
    refresh();
    setProgressVisible(true, 5);
    var pct = 5;
    var timer = setInterval(function () {
      pct = Math.min(90, pct + 5);
      setProgressVisible(true, pct);
    }, 250);
    try {
      var res = await postText('/api/admin/pdf-tools/pdf-to-text/download');
      var blob = await res.blob();
      var headerName = res.headers.get('X-Export-Filename') || 'document.txt';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = headerName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e2) {} }, 4000);
      clearInterval(timer);
      setProgressVisible(true, 100);
      setStatus('Download started (' + headerName + ').', true);
      setTimeout(function () { setProgressVisible(false); }, 2500);
    } catch (err) {
      clearInterval(timer);
      setProgressVisible(false);
      setStatus((err && err.message) || 'Extraction failed.', false);
    } finally {
      working = false;
      refresh();
    }
  }

  function init() {
    var pick = $('pdfTextPick');
    var input = $('pdfTextFile');
    var previewBtn = $('pdfTextPreviewBtn');
    var btn = $('pdfTextBtn');
    var clear = $('pdfTextClear');
    if (pick && input) pick.addEventListener('click', function () { input.click(); });
    if (input) input.addEventListener('change', function () {
      setStatus('');
      setResult('');
      selected = (input.files && input.files[0]) || null;
      input.value = '';
      var info = $('pdfTextFileInfo');
      if (info) delete info.dataset.probed;
      var preview = $('pdfTextPreview');
      if (preview) {
        preview.style.display = 'none';
        preview.textContent = '';
      }
      refresh();
      if (selected) probe(selected);
    });
    if (previewBtn) previewBtn.addEventListener('click', doPreview);
    if (btn) btn.addEventListener('click', doDownload);
    if (clear) clear.addEventListener('click', function () {
      selected = null;
      pageCount = 0;
      setStatus('');
      setResult('');
      setProgressVisible(false);
      var info = $('pdfTextFileInfo');
      if (info) delete info.dataset.probed;
      var preview = $('pdfTextPreview');
      if (preview) {
        preview.style.display = 'none';
        preview.textContent = '';
      }
      refresh();
    });
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
