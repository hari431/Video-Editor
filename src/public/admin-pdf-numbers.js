// src/public/admin-pdf-numbers.js — Standalone Page Numbers client (admin-only).
// ES module, no frameworks. A local pdf.js probe (vendored build, no CDN)
// reports the page count for range validation. Numbering POSTs the file +
// options to POST /api/admin/pdf-tools/page-numbers; the server draws page
// numbers onto the pages (content otherwise untouched) and streams back a
// NEW PDF.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var root = document.querySelector('[data-testid="pdf-numbers-root"]');
  var available = root ? root.getAttribute('data-available') === '1' : false;
  var maxFileMb = root ? Number(root.getAttribute('data-max-file-mb')) || 50 : 50;
  var maxFileBytes = maxFileMb * 1024 * 1024;

  var selected = null; // File
  var pageCount = 0;
  var numbering = false;

  function setStatus(text, ok) {
    var el = $('pdfNumbersStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = text ? (ok ? '#15803d' : '#b91c1c') : '';
  }

  function setResult(text) {
    var el = $('pdfNumbersResult');
    if (!el) return;
    el.textContent = text || '';
  }

  function setProgressVisible(on, pct) {
    var el = $('pdfNumbersProgress');
    if (!el) return;
    el.style.display = on ? 'block' : 'none';
    var pctEl = $('pdfNumbersProgressPct');
    if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  }

  function selectedScope() {
    var checked = document.querySelector('input[name="pdfNumbersScope"]:checked');
    return checked ? checked.value : 'all';
  }

  function refresh() {
    var info = $('pdfNumbersFileInfo');
    if (info && !info.dataset.probed) {
      info.textContent = selected
        ? selected.name + ' · ' + pageCount + ' page' + (pageCount === 1 ? '' : 's')
        : 'No PDF selected yet.';
    }
    var btn = $('pdfNumbersBtn');
    if (btn) btn.disabled = !available || numbering || !selected;
  }

  // Local range pre-check against the probed page count (server re-validates).
  function validateSelectionLocal(text) {
    if (!text || !text.trim()) return 'Enter pages to number, e.g. 1-3,5.';
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
    if (!count) return 'Enter pages to number, e.g. 1-3,5.';
    return null;
  }

  async function probe(file) {
    // Local-only probe, never uploads: page count + already-protected check.
    var info = $('pdfNumbersFileInfo');
    pageCount = 0;
    try {
      var buf = new Uint8Array(await file.arrayBuffer());
      var task = pdfjsLib.getDocument({ data: buf });
      var doc = await task.promise;
      pageCount = doc.numPages;
      if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · ' + pageCount + ' page' + (pageCount === 1 ? '' : 's') + ' · ready to number.';
      }
      try { await task.destroy(); } catch (e) {}
    } catch (err) {
      var name = err && err.name;
      if (name === 'PasswordException') {
        if (info) {
          info.dataset.probed = '1';
          info.textContent = file.name + ' · 🔒 password-protected — unlock it before numbering.';
        }
      } else if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · could not be previewed here; the server will validate on numbering.';
      }
    }
    refresh();
  }

  async function doNumber() {
    if (numbering) return;
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
    var scope = selectedScope();
    var selectionEl = $('pdfNumbersSelection');
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
    numbering = true;
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
      form.append('position', get('pdfNumbersPosition'));
      form.append('start', get('pdfNumbersStart'));
      form.append('fontSize', get('pdfNumbersSize'));
      form.append('prefix', get('pdfNumbersPrefix'));
      var res = await fetch('/api/admin/pdf-tools/page-numbers', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) {
        var msg = 'Numbering failed.';
        try {
          var j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (e) {}
        throw new Error(msg);
      }
      setProgressVisible(true, 95);
      var blob = await res.blob();
      var headerName = res.headers.get('X-Export-Filename') || 'document-numbered.pdf';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = headerName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e2) {} }, 4000);
      clearInterval(timer);
      setProgressVisible(true, 100);
      setStatus('Numbered — download started (' + headerName + ').', true);
      setResult(scope === 'range' ? 'Pages numbered: ' + selection.trim() + '.' : 'All pages numbered.');
      setTimeout(function () { setProgressVisible(false); }, 2500);
    } catch (err) {
      clearInterval(timer);
      setProgressVisible(false);
      setStatus((err && err.message) || 'Numbering failed.', false);
    } finally {
      numbering = false;
      refresh();
    }
  }

  function init() {
    var pick = $('pdfNumbersPick');
    var input = $('pdfNumbersFile');
    var btn = $('pdfNumbersBtn');
    var clear = $('pdfNumbersClear');
    if (pick && input) pick.addEventListener('click', function () { input.click(); });
    if (input) input.addEventListener('change', function () {
      setStatus('');
      setResult('');
      selected = (input.files && input.files[0]) || null;
      input.value = '';
      var info = $('pdfNumbersFileInfo');
      if (info) delete info.dataset.probed;
      refresh();
      if (selected) probe(selected);
    });
    if (btn) btn.addEventListener('click', doNumber);
    if (clear) clear.addEventListener('click', function () {
      selected = null;
      pageCount = 0;
      setStatus('');
      setResult('');
      setProgressVisible(false);
      var info = $('pdfNumbersFileInfo');
      if (info) delete info.dataset.probed;
      refresh();
    });
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
