// src/public/admin-pdf-header-footer.js — Standalone Header/Footer client (admin-only).
// ES module, no frameworks. A local pdf.js probe (vendored build, no CDN)
// reports the page count for range validation. Submitting POSTs the file +
// header/footer text ({page}/{total} tokens) + options to
// POST /api/admin/pdf-tools/header-footer; the server draws the text onto the
// pages (content otherwise untouched) and streams back a NEW PDF.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var root = document.querySelector('[data-testid="pdf-header-footer-root"]');
  var available = root ? root.getAttribute('data-available') === '1' : false;
  var maxFileMb = root ? Number(root.getAttribute('data-max-file-mb')) || 50 : 50;
  var maxFileBytes = maxFileMb * 1024 * 1024;

  var selected = null; // File
  var pageCount = 0;
  var working = false;

  function setStatus(text, ok) {
    var el = $('pdfHeaderFooterStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = text ? (ok ? '#15803d' : '#b91c1c') : '';
  }

  function setResult(text) {
    var el = $('pdfHeaderFooterResult');
    if (!el) return;
    el.textContent = text || '';
  }

  function setProgressVisible(on, pct) {
    var el = $('pdfHeaderFooterProgress');
    if (!el) return;
    el.style.display = on ? 'block' : 'none';
    var pctEl = $('pdfHeaderFooterProgressPct');
    if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  }

  function selectedScope() {
    var checked = document.querySelector('input[name="pdfHeaderFooterScope"]:checked');
    return checked ? checked.value : 'all';
  }

  function refresh() {
    var info = $('pdfHeaderFooterFileInfo');
    if (info && !info.dataset.probed) {
      info.textContent = selected
        ? selected.name + ' · ' + pageCount + ' page' + (pageCount === 1 ? '' : 's')
        : 'No PDF selected yet.';
    }
    var btn = $('pdfHeaderFooterBtn');
    if (btn) btn.disabled = !available || working || !selected;
  }

  // Local range pre-check against the probed page count (server re-validates).
  function validateSelectionLocal(text) {
    if (!text || !text.trim()) return 'Enter pages, e.g. 1-3,5.';
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
    if (!count) return 'Enter pages, e.g. 1-3,5.';
    return null;
  }

  async function probe(file) {
    // Local-only probe, never uploads: page count + already-protected check.
    var info = $('pdfHeaderFooterFileInfo');
    pageCount = 0;
    try {
      var buf = new Uint8Array(await file.arrayBuffer());
      var task = pdfjsLib.getDocument({ data: buf });
      var doc = await task.promise;
      pageCount = doc.numPages;
      if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · ' + pageCount + ' page' + (pageCount === 1 ? '' : 's') + ' · ready.';
      }
      try { await task.destroy(); } catch (e) {}
    } catch (err) {
      var name = err && err.name;
      if (name === 'PasswordException') {
        if (info) {
          info.dataset.probed = '1';
          info.textContent = file.name + ' · 🔒 password-protected — unlock it first.';
        }
      } else if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · could not be previewed here; the server will validate.';
      }
    }
    refresh();
  }

  async function doApply() {
    if (working) return;
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
    var headerEl = $('pdfHeaderFooterHeader');
    var footerEl = $('pdfHeaderFooterFooter');
    var header = headerEl ? headerEl.value : '';
    var footer = footerEl ? footerEl.value : '';
    if (!header.trim() && !footer.trim()) {
      setStatus('Enter header text, footer text, or both. {page} and {total} are supported.', false);
      return;
    }
    var scope = selectedScope();
    var selectionEl = $('pdfHeaderFooterSelection');
    var selection = selectionEl ? selectionEl.value : '';
    if (scope === 'range') {
      var localErr = validateSelectionLocal(selection);
      if (localErr) {
        setStatus(localErr, false);
        return;
      }
    }
    var get = function (id) {
      var el = $(id);
      return el ? el.value : '';
    };
    working = true;
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
      form.append('scope', scope);
      form.append('selection', selection);
      form.append('header', header);
      form.append('footer', footer);
      form.append('align', get('pdfHeaderFooterAlign'));
      form.append('fontSize', get('pdfHeaderFooterSize'));
      var res = await fetch('/api/admin/pdf-tools/header-footer', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) {
        var msg = 'Failed.';
        try {
          var j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (e) {}
        throw new Error(msg);
      }
      setProgressVisible(true, 95);
      var blob = await res.blob();
      var headerName = res.headers.get('X-Export-Filename') || 'document-header-footer.pdf';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = headerName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e2) {} }, 4000);
      clearInterval(timer);
      setProgressVisible(true, 100);
      setStatus('Done — download started (' + headerName + ').', true);
      setResult(scope === 'range' ? 'Pages: ' + selection.trim() + '.' : 'All pages stamped.');
      setTimeout(function () { setProgressVisible(false); }, 2500);
    } catch (err) {
      clearInterval(timer);
      setProgressVisible(false);
      setStatus((err && err.message) || 'Failed.', false);
    } finally {
      working = false;
      refresh();
    }
  }

  function init() {
    var pick = $('pdfHeaderFooterPick');
    var input = $('pdfHeaderFooterFile');
    var btn = $('pdfHeaderFooterBtn');
    var clear = $('pdfHeaderFooterClear');
    if (pick && input) pick.addEventListener('click', function () { input.click(); });
    if (input) input.addEventListener('change', function () {
      setStatus('');
      setResult('');
      selected = (input.files && input.files[0]) || null;
      input.value = '';
      var info = $('pdfHeaderFooterFileInfo');
      if (info) delete info.dataset.probed;
      refresh();
      if (selected) probe(selected);
    });
    if (btn) btn.addEventListener('click', doApply);
    if (clear) clear.addEventListener('click', function () {
      selected = null;
      pageCount = 0;
      setStatus('');
      setResult('');
      setProgressVisible(false);
      var info = $('pdfHeaderFooterFileInfo');
      if (info) delete info.dataset.probed;
      refresh();
    });
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
