// src/public/admin-pdf-bookmarks.js — Standalone Bookmarks client (admin-only).
// ES module, no frameworks. Selecting a PDF loads its current outline via
// POST /api/admin/pdf-tools/bookmarks/info for reference; applying POSTs the
// "Title | page" lines plus the mode (append preserves existing bookmarks,
// replace rebuilds) to POST /api/admin/pdf-tools/bookmarks/apply and
// downloads a NEW PDF. Page content is never altered.
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var root = document.querySelector('[data-testid="pdf-bookmarks-root"]');
  var available = root ? root.getAttribute('data-available') === '1' : false;
  var maxFileMb = root ? Number(root.getAttribute('data-max-file-mb')) || 50 : 50;
  var maxFileBytes = maxFileMb * 1024 * 1024;

  var selected = null; // File
  var working = false;

  function setStatus(text, ok) {
    var el = $('pdfBookmarksStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = text ? (ok ? '#15803d' : '#b91c1c') : '';
  }

  function setResult(text) {
    var el = $('pdfBookmarksResult');
    if (!el) return;
    el.textContent = text || '';
  }

  function setProgressVisible(on, pct) {
    var el = $('pdfBookmarksProgress');
    if (!el) return;
    el.style.display = on ? 'block' : 'none';
    var pctEl = $('pdfBookmarksProgressPct');
    if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  }

  function refresh(infoText) {
    var info = $('pdfBookmarksFileInfo');
    if (info) info.textContent = infoText != null ? infoText : (selected ? selected.name : 'No PDF selected yet.');
    var existing = $('pdfBookmarksExisting');
    if (existing && !existing.dataset.loaded) existing.textContent = '';
    var btn = $('pdfBookmarksBtn');
    if (btn) btn.disabled = !available || working || !selected;
  }

  async function loadExisting() {
    if (!selected) return;
    if (!/\.pdf$/i.test(selected.name || '')) {
      setStatus('Source file must be .pdf.', false);
      return;
    }
    if (!(selected.size > 0) || selected.size > maxFileBytes) {
      setStatus('PDF file is empty or exceeds ' + maxFileMb + ' MB.', false);
      return;
    }
    working = true;
    refresh('Reading bookmarks…');
    setProgressVisible(true, 30);
    try {
      var form = new FormData();
      form.append('pdf', selected, selected.name);
      var res = await fetch('/api/admin/pdf-tools/bookmarks/info', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) {
        var msg = 'Could not read bookmarks.';
        try {
          var j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (e) {}
        throw new Error(msg);
      }
      var payload = await res.json();
      var existing = $('pdfBookmarksExisting');
      var list = payload.bookmarks || [];
      if (existing) {
        existing.dataset.loaded = '1';
        existing.textContent = list.length
          ? 'Current bookmarks: ' + list.map(function (b) { return b.title + ' (p. ' + b.page + ')'; }).join('; ') + '.'
          : 'No bookmarks in this PDF yet.';
      }
      setProgressVisible(false);
      setStatus('', true);
      refresh(selected.name + ' · enter bookmarks below, then apply.');
    } catch (err) {
      setProgressVisible(false);
      setStatus((err && err.message) || 'Could not read bookmarks.', false);
      refresh(selected ? selected.name : null);
    } finally {
      working = false;
      refresh();
    }
  }

  async function doApply() {
    if (working) return;
    setStatus('');
    setResult('');
    if (!selected) {
      setStatus('Select one PDF file first.', false);
      return;
    }
    var entriesEl = $('pdfBookmarksEntries');
    var entries = entriesEl ? entriesEl.value : '';
    if (!entries.trim()) {
      setStatus('Enter at least one bookmark as "Title | page".', false);
      return;
    }
    var modeEl = $('pdfBookmarksMode');
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
      form.append('entries', entries);
      form.append('mode', modeEl ? modeEl.value : 'append');
      var res = await fetch('/api/admin/pdf-tools/bookmarks/apply', { method: 'POST', body: form, credentials: 'same-origin' });
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
      var headerName = res.headers.get('X-Export-Filename') || 'document-bookmarks.pdf';
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
      setResult('Bookmarks written; page content unchanged.');
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
    var pick = $('pdfBookmarksPick');
    var input = $('pdfBookmarksFile');
    var btn = $('pdfBookmarksBtn');
    var clear = $('pdfBookmarksClear');
    if (pick && input) pick.addEventListener('click', function () { input.click(); });
    if (input) input.addEventListener('change', function () {
      setStatus('');
      setResult('');
      selected = (input.files && input.files[0]) || null;
      input.value = '';
      var existing = $('pdfBookmarksExisting');
      if (existing) {
        delete existing.dataset.loaded;
        existing.textContent = '';
      }
      refresh();
      if (selected) loadExisting();
    });
    if (btn) btn.addEventListener('click', doApply);
    if (clear) clear.addEventListener('click', function () {
      selected = null;
      setStatus('');
      setResult('');
      setProgressVisible(false);
      var entriesEl = $('pdfBookmarksEntries');
      if (entriesEl) entriesEl.value = '';
      var existing = $('pdfBookmarksExisting');
      if (existing) {
        delete existing.dataset.loaded;
        existing.textContent = '';
      }
      refresh();
    });
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
