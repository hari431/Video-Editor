// src/public/admin-pdf-merge.js — Standalone Merge PDF client (admin-only).
// ES module, no frameworks. Preview page counts use the vendored pdf.js
// (local files, no CDN). Merge itself POSTs bytes in DISPLAYED order to
// POST /api/admin/pdf-tools/merge; the server merges with pdf-lib in-memory
// and streams back a NEW PDF. Sources are never modified.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var root = document.querySelector('[data-testid="pdf-merge-root"]');
  var available = root ? root.getAttribute('data-available') === '1' : false;
  var maxFileMb = root ? Number(root.getAttribute('data-max-file-mb')) || 50 : 50;
  var maxFiles = root ? Number(root.getAttribute('data-max-files')) || 8 : 8;
  var maxFileBytes = maxFileMb * 1024 * 1024;

  var items = []; // [{ id, file, name, size, pageCount|null, error|null }]
  var nextId = 1;
  var merging = false;
  var dragId = null;

  function setStatus(text, ok) {
    var el = $('pdfMergeStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = text ? (ok ? '#15803d' : '#b91c1c') : '';
  }

  function setProgressVisible(on, pct) {
    var el = $('pdfMergeProgress');
    if (!el) return;
    el.style.display = on ? 'block' : 'none';
    var pctEl = $('pdfMergeProgressPct');
    if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  }

  function refreshHint() {
    var hint = $('pdfMergeHint');
    if (hint) hint.style.display = items.length ? 'none' : 'block';
    var btn = $('pdfMergeBtn');
    if (btn) btn.disabled = !available || merging || items.length < 2;
  }

  async function probePageCount(entry) {
    try {
      var buf = new Uint8Array(await entry.file.arrayBuffer());
      var doc = await pdfjsLib.getDocument({ data: buf }).promise;
      entry.pageCount = doc.numPages;
      try { await doc.destroy(); } catch (e) {}
    } catch (e) {
      entry.pageCount = null;
      entry.error = 'Could not be read as a PDF.';
    }
  }

  function move(id, dir) {
    var i = items.findIndex(function (e) { return e.id === id; });
    var j = i + dir;
    if (i < 0 || j < 0 || j >= items.length) return;
    var tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
    render();
  }

  function remove(id) {
    items = items.filter(function (e) { return e.id !== id; });
    render();
  }

  function render() {
    var list = $('pdfMergeList');
    if (!list) return;
    list.innerHTML = '';
    items.forEach(function (entry, idx) {
      var li = document.createElement('li');
      li.setAttribute('data-testid', 'pdf-merge-item');
      li.setAttribute('data-id', String(entry.id));
      li.setAttribute('draggable', 'true');
      li.style.cssText = 'display:flex;gap:8px;align-items:center;border:1px solid #e2e8f0;border-radius:10px;padding:8px 10px;background:#fff;';
      var meta = entry.pageCount != null
        ? escapeHtml(entry.name) + ' · <span data-testid="pdf-merge-pages">' + entry.pageCount + ' page' + (entry.pageCount === 1 ? '' : 's') + '</span>'
        : escapeHtml(entry.name) + ' · <span data-testid="pdf-merge-pages">' + (entry.error || 'reading…') + '</span>';
      li.innerHTML =
        '<span style="font-weight:700;color:#64748b;min-width:22px;" data-testid="pdf-merge-order">' + (idx + 1) + '.</span>' +
        '<span style="flex:1;min-width:0;font-size:13px;" data-testid="pdf-merge-filename">' + meta + '</span>' +
        '<button type="button" class="button small secondary" data-act="up" data-testid="pdf-merge-up" aria-label="Move up">↑</button>' +
        '<button type="button" class="button small secondary" data-act="down" data-testid="pdf-merge-down" aria-label="Move down">↓</button>' +
        '<button type="button" class="button small secondary" data-act="remove" data-testid="pdf-merge-remove" aria-label="Remove">✕</button>';
      li.querySelector('[data-act="up"]').addEventListener('click', function () { move(entry.id, -1); });
      li.querySelector('[data-act="down"]').addEventListener('click', function () { move(entry.id, 1); });
      li.querySelector('[data-act="remove"]').addEventListener('click', function () { remove(entry.id); });
      li.addEventListener('dragstart', function (ev) {
        dragId = entry.id;
        try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(entry.id)); } catch (e) {}
      });
      li.addEventListener('dragover', function (ev) { ev.preventDefault(); });
      li.addEventListener('drop', function (ev) {
        ev.preventDefault();
        var from = dragId != null ? dragId : Number((ev.dataTransfer && ev.dataTransfer.getData('text/plain')) || NaN);
        if (!from) return;
        var fromIdx = items.findIndex(function (e) { return e.id === Number(from); });
        var toIdx = items.findIndex(function (e) { return e.id === entry.id; });
        if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
        var moved = items.splice(fromIdx, 1)[0];
        items.splice(toIdx, 0, moved);
        dragId = null;
        render();
      });
      list.appendChild(li);
    });
    refreshHint();
  }

  async function addFiles(fileList) {
    setStatus('');
    var incoming = Array.prototype.slice.call(fileList || []);
    if (!incoming.length) return;
    if (items.length + incoming.length > maxFiles) {
      setStatus('At most ' + maxFiles + ' PDF files can be merged at once.', false);
      incoming = incoming.slice(0, Math.max(0, maxFiles - items.length));
    }
    for (var k = 0; k < incoming.length; k++) {
      var f = incoming[k];
      var entry = { id: nextId++, file: f, name: f.name || 'document.pdf', size: f.size, pageCount: null, error: null };
      var extOk = /\.pdf$/i.test(entry.name);
      if (!extOk) {
        entry.error = 'Not a .pdf file — it will be rejected on merge.';
      } else if (!(entry.size > 0)) {
        entry.error = 'Empty file.';
      } else if (entry.size > maxFileBytes) {
        entry.error = 'Exceeds ' + maxFileMb + ' MB.';
      }
      items.push(entry);
      render();
      if (!entry.error) {
        await probePageCount(entry);
        render();
        if (entry.error) setStatus('"' + entry.name + '" could not be read as a PDF. Remove it before merging.', false);
      } else {
        setStatus('"' + entry.name + '": ' + entry.error, false);
      }
    }
    render();
  }

  async function doMerge() {
    if (merging) return;
    setStatus('');
    if (items.length < 2) {
      setStatus('Select at least 2 PDF files to merge.', false);
      return;
    }
    var bad = items.filter(function (e) { return e.error || e.pageCount == null; });
    if (bad.length) {
      setStatus('Remove unreadable files before merging: ' + bad.map(function (e) { return e.name; }).join(', '), false);
      return;
    }
    merging = true;
    refreshHint();
    setProgressVisible(true, 5);
    // Fake staged progress (upload 5→60, server merge 60→90, download →100)
    // since fetch has no upload-progress events without XHR.
    var pct = 5;
    var timer = setInterval(function () {
      pct = Math.min(90, pct + 5);
      setProgressVisible(true, pct);
    }, 250);
    try {
      var form = new FormData();
      items.forEach(function (e) { form.append('pdf', e.file, e.name); });
      var res = await fetch('/api/admin/pdf-tools/merge', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) {
        var msg = 'Merge failed.';
        try {
          var j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (e) {}
        throw new Error(msg);
      }
      setProgressVisible(true, 95);
      var blob = await res.blob();
      var headerName = res.headers.get('X-Export-Filename') || ('merged-' + Date.now() + '.pdf');
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = headerName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e2) {} }, 4000);
      clearInterval(timer);
      setProgressVisible(true, 100);
      setStatus('Merged ' + items.length + ' PDFs — download started (' + headerName + ').', true);
      setTimeout(function () { setProgressVisible(false); }, 2500);
    } catch (err) {
      clearInterval(timer);
      setProgressVisible(false);
      setStatus((err && err.message) || 'Merge failed.', false);
    } finally {
      merging = false;
      refreshHint();
    }
  }

  function init() {
    var pick = $('pdfMergePick');
    var input = $('pdfMergeFile');
    var btn = $('pdfMergeBtn');
    var clear = $('pdfMergeClear');
    if (pick && input) pick.addEventListener('click', function () { input.click(); });
    if (input) input.addEventListener('change', function () { addFiles(input.files); input.value = ''; });
    if (btn) btn.addEventListener('click', doMerge);
    if (clear) clear.addEventListener('click', function () { items = []; setStatus(''); setProgressVisible(false); render(); });
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
