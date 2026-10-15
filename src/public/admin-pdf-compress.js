// src/public/admin-pdf-compress.js — Standalone Compress PDF client (admin-only).
// ES module, no frameworks. A local pdf.js probe (vendored build, no CDN)
// reports the selected file's page count and flags already-protected files
// (compression needs no password here — unlock first). Compressing POSTs the
// file + level to POST /api/admin/pdf-tools/compress; the server losslessly
// recompresses it and streams back a NEW PDF. The response headers carry the
// result (X-Compress-Reduced 1/0, X-Compress-Ratio percent), which is shown
// next to the original size — a reduction is only ever claimed when the
// download is actually smaller.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function fmtMb(bytes) {
    if (!Number.isFinite(bytes)) return '? MB';
    if (bytes < 1048576) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }

  var root = document.querySelector('[data-testid="pdf-compress-root"]');
  var available = root ? root.getAttribute('data-available') === '1' : false;
  var maxFileMb = root ? Number(root.getAttribute('data-max-file-mb')) || 50 : 50;
  var maxFileBytes = maxFileMb * 1024 * 1024;

  var selected = null; // File
  var compressing = false;

  function setStatus(text, ok) {
    var el = $('pdfCompressStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = text ? (ok ? '#15803d' : '#b91c1c') : '';
  }

  function setResult(text) {
    var el = $('pdfCompressResult');
    if (!el) return;
    el.textContent = text || '';
  }

  function setProgressVisible(on, pct) {
    var el = $('pdfCompressProgress');
    if (!el) return;
    el.style.display = on ? 'block' : 'none';
    var pctEl = $('pdfCompressProgressPct');
    if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  }

  function refresh() {
    var info = $('pdfCompressFileInfo');
    if (info && !info.dataset.probed) {
      info.textContent = selected
        ? selected.name + ' · ' + fmtMb(selected.size)
        : 'No PDF selected yet.';
    }
    var btn = $('pdfCompressBtn');
    if (btn) btn.disabled = !available || compressing || !selected;
  }

  async function probe(file) {
    // Local-only probe, never uploads: page count + already-protected check.
    var info = $('pdfCompressFileInfo');
    try {
      var buf = new Uint8Array(await file.arrayBuffer());
      var task = pdfjsLib.getDocument({ data: buf });
      var doc = await task.promise;
      var pages = doc.numPages;
      if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · ' + fmtMb(file.size) + ' · ' + pages + ' page' + (pages === 1 ? '' : 's') + ' · ready to compress.';
      }
      try { await task.destroy(); } catch (e) {}
    } catch (err) {
      var name = err && err.name;
      if (name === 'PasswordException') {
        if (info) {
          info.dataset.probed = '1';
          info.textContent = file.name + ' · ' + fmtMb(file.size) + ' · 🔒 password-protected — unlock it before compressing.';
        }
      } else if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · ' + fmtMb(file.size) + ' · could not be previewed here; the server will validate on compress.';
      }
    }
  }

  async function doCompress() {
    if (compressing) return;
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
    var levelEl = $('pdfCompressLevel');
    var level = levelEl && levelEl.value ? levelEl.value : 'balanced';
    compressing = true;
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
      form.append('level', level);
      var res = await fetch('/api/admin/pdf-tools/compress', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) {
        var msg = 'Compression failed.';
        try {
          var j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (e) {}
        throw new Error(msg);
      }
      setProgressVisible(true, 95);
      var blob = await res.blob();
      var reduced = res.headers.get('X-Compress-Reduced') === '1';
      var ratio = parseFloat(res.headers.get('X-Compress-Ratio') || '0') || 0;
      var headerName = res.headers.get('X-Export-Filename') || 'document-compressed.pdf';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = headerName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e2) {} }, 4000);
      clearInterval(timer);
      setProgressVisible(true, 100);
      if (reduced) {
        setStatus('Compressed — download started (' + headerName + ').', true);
        setResult(fmtMb(selected.size) + ' → ' + fmtMb(blob.size) + ' · ' + ratio.toFixed(1) + '% smaller (lossless).');
      } else {
        setStatus('Already optimally packed — the original was returned unchanged.', true);
        setResult(fmtMb(selected.size) + ' → ' + fmtMb(blob.size) + ' · no reduction possible without losing quality.');
      }
      setTimeout(function () { setProgressVisible(false); }, 2500);
    } catch (err) {
      clearInterval(timer);
      setProgressVisible(false);
      setStatus((err && err.message) || 'Compression failed.', false);
    } finally {
      compressing = false;
      refresh();
    }
  }

  function init() {
    var pick = $('pdfCompressPick');
    var input = $('pdfCompressFile');
    var btn = $('pdfCompressBtn');
    var clear = $('pdfCompressClear');
    if (pick && input) pick.addEventListener('click', function () { input.click(); });
    if (input) input.addEventListener('change', function () {
      setStatus('');
      setResult('');
      selected = (input.files && input.files[0]) || null;
      input.value = '';
      var info = $('pdfCompressFileInfo');
      if (info) delete info.dataset.probed;
      refresh();
      if (selected) probe(selected);
    });
    if (btn) btn.addEventListener('click', doCompress);
    if (clear) clear.addEventListener('click', function () {
      selected = null;
      setStatus('');
      setResult('');
      setProgressVisible(false);
      var info = $('pdfCompressFileInfo');
      if (info) delete info.dataset.probed;
      refresh();
    });
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
