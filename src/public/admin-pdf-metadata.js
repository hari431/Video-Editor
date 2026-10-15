// src/public/admin-pdf-metadata.js — Standalone PDF Metadata client (admin-only).
// ES module, no frameworks. Selecting a PDF loads its current metadata via
// POST /api/admin/pdf-tools/metadata/info into the form; saving POSTs the
// edited fields to POST /api/admin/pdf-tools/metadata/apply and downloads a
// NEW PDF that differs only in metadata.
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var FIELDS = ['title', 'author', 'subject', 'keywords', 'creator', 'producer'];

  var root = document.querySelector('[data-testid="pdf-metadata-root"]');
  var available = root ? root.getAttribute('data-available') === '1' : false;
  var maxFileMb = root ? Number(root.getAttribute('data-max-file-mb')) || 50 : 50;
  var maxFileBytes = maxFileMb * 1024 * 1024;

  var selected = null; // File
  var saving = false;

  function setStatus(text, ok) {
    var el = $('pdfMetadataStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = text ? (ok ? '#15803d' : '#b91c1c') : '';
  }

  function setResult(text) {
    var el = $('pdfMetadataResult');
    if (!el) return;
    el.textContent = text || '';
  }

  function setProgressVisible(on, pct) {
    var el = $('pdfMetadataProgress');
    if (!el) return;
    el.style.display = on ? 'block' : 'none';
    var pctEl = $('pdfMetadataProgressPct');
    if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  }

  function fieldId(key) {
    return 'pdfMetadata' + key.charAt(0).toUpperCase() + key.slice(1);
  }

  function readForm() {
    var out = {};
    FIELDS.forEach(function (key) {
      var el = $(fieldId(key));
      out[key] = el ? el.value : '';
    });
    return out;
  }

  function fillForm(meta) {
    meta = meta || {};
    FIELDS.forEach(function (key) {
      var el = $(fieldId(key));
      if (!el) return;
      var v = meta[key];
      el.value = Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v));
    });
  }

  function clearForm() {
    fillForm({ title: '', author: '', subject: '', keywords: '', creator: '', producer: '' });
  }

  function refresh(infoText) {
    var info = $('pdfMetadataFileInfo');
    if (info) info.textContent = infoText != null ? infoText : (selected ? selected.name : 'No PDF selected yet.');
    var btn = $('pdfMetadataBtn');
    if (btn) btn.disabled = !available || saving || !selected;
  }

  async function loadInfo() {
    if (!selected) return;
    if (!/\.pdf$/i.test(selected.name || '')) {
      setStatus('Source file must be .pdf.', false);
      return;
    }
    if (!(selected.size > 0) || selected.size > maxFileBytes) {
      setStatus('PDF file is empty or exceeds ' + maxFileMb + ' MB.', false);
      return;
    }
    saving = true;
    refresh('Reading metadata…');
    setProgressVisible(true, 30);
    try {
      var form = new FormData();
      form.append('pdf', selected, selected.name);
      var res = await fetch('/api/admin/pdf-tools/metadata/info', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) {
        var msg = 'Could not read metadata.';
        try {
          var j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (e) {}
        throw new Error(msg);
      }
      var payload = await res.json();
      fillForm(payload.metadata);
      setProgressVisible(false);
      setStatus('', true);
      refresh(selected.name + ' · edit the fields, then save.');
    } catch (err) {
      setProgressVisible(false);
      setStatus((err && err.message) || 'Could not read metadata.', false);
      refresh(selected ? selected.name : null);
    } finally {
      saving = false;
      refresh();
    }
  }

  async function doSave() {
    if (saving) return;
    setStatus('');
    setResult('');
    if (!selected) {
      setStatus('Select one PDF file first.', false);
      return;
    }
    saving = true;
    refresh();
    setProgressVisible(true, 5);
    var pct = 5;
    var timer = setInterval(function () {
      pct = Math.min(90, pct + 5);
      setProgressVisible(true, pct);
    }, 250);
    try {
      var values = readForm();
      var form = new FormData();
      form.append('pdf', selected, selected.name);
      FIELDS.forEach(function (key) { form.append(key, values[key]); });
      var res = await fetch('/api/admin/pdf-tools/metadata/apply', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) {
        var msg = 'Save failed.';
        try {
          var j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (e) {}
        throw new Error(msg);
      }
      setProgressVisible(true, 95);
      var blob = await res.blob();
      var headerName = res.headers.get('X-Export-Filename') || 'document-metadata.pdf';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = headerName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e2) {} }, 4000);
      clearInterval(timer);
      setProgressVisible(true, 100);
      setStatus('Saved — download started (' + headerName + ').', true);
      setResult('Only metadata changed; everything else is preserved.');
      setTimeout(function () { setProgressVisible(false); }, 2500);
    } catch (err) {
      clearInterval(timer);
      setProgressVisible(false);
      setStatus((err && err.message) || 'Save failed.', false);
    } finally {
      saving = false;
      refresh();
    }
  }

  function init() {
    var pick = $('pdfMetadataPick');
    var input = $('pdfMetadataFile');
    var btn = $('pdfMetadataBtn');
    var clear = $('pdfMetadataClear');
    if (pick && input) pick.addEventListener('click', function () { input.click(); });
    if (input) input.addEventListener('change', function () {
      setStatus('');
      setResult('');
      selected = (input.files && input.files[0]) || null;
      input.value = '';
      clearForm();
      refresh();
      if (selected) loadInfo();
    });
    if (btn) btn.addEventListener('click', doSave);
    if (clear) clear.addEventListener('click', function () {
      selected = null;
      setStatus('');
      setResult('');
      setProgressVisible(false);
      clearForm();
      refresh();
    });
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
