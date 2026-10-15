// src/public/admin-pdf-split.js — Standalone Split PDF client (admin-only).
// ES module, no frameworks. A local pdf.js probe (vendored build, no CDN)
// reports the selected file's page count (used to validate ranges locally)
// and flags already-protected files (splitting needs no password here —
// unlock first). Splitting POSTs the file + mode to
// POST /api/admin/pdf-tools/split; a single result downloads directly as
// PDF, multiple results download as a ZIP (Content-Type decides).
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var root = document.querySelector('[data-testid="pdf-split-root"]');
  var available = root ? root.getAttribute('data-available') === '1' : false;
  var maxFileMb = root ? Number(root.getAttribute('data-max-file-mb')) || 50 : 50;
  var maxFileBytes = maxFileMb * 1024 * 1024;

  var selected = null; // File
  var pageCount = 0;
  var splitting = false;

  function setStatus(text, ok) {
    var el = $('pdfSplitStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = text ? (ok ? '#15803d' : '#b91c1c') : '';
  }

  function setResult(text) {
    var el = $('pdfSplitResult');
    if (!el) return;
    el.textContent = text || '';
  }

  function setProgressVisible(on, pct) {
    var el = $('pdfSplitProgress');
    if (!el) return;
    el.style.display = on ? 'block' : 'none';
    var pctEl = $('pdfSplitProgressPct');
    if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  }

  function selectedMode() {
    var checked = document.querySelector('input[name="pdfSplitMode"]:checked');
    return checked ? checked.value : 'extract';
  }

  function refresh() {
    var info = $('pdfSplitFileInfo');
    if (info && !info.dataset.probed) {
      info.textContent = selected
        ? selected.name + ' · ' + pageCount + ' page' + (pageCount === 1 ? '' : 's')
        : 'No PDF selected yet.';
    }
    var btn = $('pdfSplitBtn');
    if (btn) btn.disabled = !available || splitting || !selected;
  }

  // Local range pre-check against the probed page count (server re-validates).
  function validateSelectionLocal(text) {
    if (!text || !text.trim()) return 'Enter pages to extract, e.g. 1-3,5,8-10.';
    var seen = {};
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
      }
    }
    return null;
  }

  async function probe(file) {
    // Local-only probe, never uploads: page count + already-protected check.
    var info = $('pdfSplitFileInfo');
    pageCount = 0;
    try {
      var buf = new Uint8Array(await file.arrayBuffer());
      var task = pdfjsLib.getDocument({ data: buf });
      var doc = await task.promise;
      pageCount = doc.numPages;
      if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · ' + pageCount + ' page' + (pageCount === 1 ? '' : 's') + ' · ready to split.';
      }
      try { await task.destroy(); } catch (e) {}
    } catch (err) {
      var name = err && err.name;
      if (name === 'PasswordException') {
        if (info) {
          info.dataset.probed = '1';
          info.textContent = file.name + ' · 🔒 password-protected — unlock it before splitting.';
        }
      } else if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · could not be previewed here; the server will validate on split.';
      }
    }
    refresh();
  }

  async function doSplit() {
    if (splitting) return;
    setStatus('');
    setResult('');
    if (!selected) {
      setStatus('Select one PDF file first.', false);
      return;
    }
    if (!/\.pdf$/i.test(selected.name || '')) {
      setStatus('Source file must be .pdf.', false);
      return;
    }
    if (!(selected.size > 0) || selected.size > maxFileBytes) {
      setStatus('PDF file is empty or exceeds ' + maxFileMb + ' MB.', false);
      return;
    }
    var mode = selectedMode();
    var selectionEl = $('pdfSplitSelection');
    var everyEl = $('pdfSplitEvery');
    var selection = selectionEl ? selectionEl.value : '';
    var every = everyEl ? everyEl.value : '';
    if (mode === 'extract') {
      var localErr = validateSelectionLocal(selection);
      if (localErr) {
        setStatus(localErr, false);
        return;
      }
    }
    if (mode === 'every') {
      var n = Number(String(every).trim());
      if (!Number.isInteger(n) || n < 1) {
        setStatus('Every-N must be a positive whole number of pages.', false);
        return;
      }
    }
    splitting = true;
    refresh();
    setProgressVisible(true, 5);
    var pct = 5;
    var timer = setInterval(function () {
      pct = Math.min(90, pct + 5);
      setProgressVisible(true, pct);
    }, 250);
    try {
      var form = new FormData();
      form.append('pdf', selected, selected.name);
      form.append('mode', mode);
      form.append('selection', selection);
      form.append('every', every);
      var res = await fetch('/api/admin/pdf-tools/split', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) {
        var msg = 'Split failed.';
        try {
          var j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (e) {}
        throw new Error(msg);
      }
      setProgressVisible(true, 95);
      var blob = await res.blob();
      var parts = parseInt(res.headers.get('X-Split-Parts') || '1', 10) || 1;
      var isZip = (res.headers.get('Content-Type') || '').indexOf('zip') !== -1;
      var headerName = res.headers.get('X-Export-Filename') || (isZip ? 'document-split.zip' : 'document-split.pdf');
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = headerName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e2) {} }, 4000);
      clearInterval(timer);
      setProgressVisible(true, 100);
      if (isZip) {
        setStatus('Split into ' + parts + ' files — ZIP download started (' + headerName + ').', true);
        setResult(parts + ' PDF files in one ZIP.');
      } else {
        setStatus('Split — download started (' + headerName + ').', true);
        setResult('Single PDF result.');
      }
      setTimeout(function () { setProgressVisible(false); }, 2500);
    } catch (err) {
      clearInterval(timer);
      setProgressVisible(false);
      setStatus((err && err.message) || 'Split failed.', false);
    } finally {
      splitting = false;
      refresh();
    }
  }

  function init() {
    var pick = $('pdfSplitPick');
    var input = $('pdfSplitFile');
    var btn = $('pdfSplitBtn');
    var clear = $('pdfSplitClear');
    if (pick && input) pick.addEventListener('click', function () { input.click(); });
    if (input) input.addEventListener('change', function () {
      setStatus('');
      setResult('');
      selected = (input.files && input.files[0]) || null;
      input.value = '';
      var info = $('pdfSplitFileInfo');
      if (info) delete info.dataset.probed;
      refresh();
      if (selected) probe(selected);
    });
    if (btn) btn.addEventListener('click', doSplit);
    if (clear) clear.addEventListener('click', function () {
      selected = null;
      pageCount = 0;
      setStatus('');
      setResult('');
      setProgressVisible(false);
      var info = $('pdfSplitFileInfo');
      if (info) delete info.dataset.probed;
      refresh();
    });
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
