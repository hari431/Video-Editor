// src/public/admin-pdf-extract-images.js — Standalone Extract Images client (admin-only).
// ES module, no frameworks. The selected PDF is POSTed once for listing; the
// server reads embedded raster images from the file's object model (no page
// rasterization anywhere) and returns metadata plus base64 bytes, shown here
// as thumbnails with checkboxes. Export re-POSTs the same local File with a
// selection ("all" or "1,3" image numbers): one image downloads directly,
// several download as a server-built ZIP. The source PDF is only ever read.
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtSize(bytes) {
    if (!Number.isFinite(bytes)) return '?';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }

  var root = document.querySelector('[data-testid="pdf-extract-images-root"]');
  var available = root ? root.getAttribute('data-available') === '1' : false;
  var maxFileMb = root ? Number(root.getAttribute('data-max-file-mb')) || 50 : 50;
  var maxFileBytes = maxFileMb * 1024 * 1024;

  var selected = null; // File
  var inventory = []; // [{ index, page, width, height, format, sizeBytes, name, dataBase64, checked }]
  var skippedNote = '';
  var working = false;

  function setStatus(text, ok) {
    var el = $('pdfExtractImagesStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = text ? (ok ? '#15803d' : '#b91c1c') : '';
  }

  function setResult(text) {
    var el = $('pdfExtractImagesResult');
    if (!el) return;
    el.textContent = text || '';
  }

  function setProgressVisible(on, pct) {
    var el = $('pdfExtractImagesProgress');
    if (!el) return;
    el.style.display = on ? 'block' : 'none';
    var pctEl = $('pdfExtractImagesProgressPct');
    if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  }

  function checkedCount() {
    return inventory.filter(function (e) { return e.checked; }).length;
  }

  function refresh() {
    var hint = $('pdfExtractImagesHint');
    if (hint) hint.style.display = inventory.length ? 'none' : 'block';
    var skipped = $('pdfExtractImagesSkipped');
    if (skipped) skipped.textContent = skippedNote;
    var btn = $('pdfExtractImagesBtn');
    if (btn) btn.disabled = !available || working || checkedCount() === 0;
  }

  function render() {
    var list = $('pdfExtractImagesList');
    if (!list) return;
    list.innerHTML = '';
    inventory.forEach(function (entry) {
      var li = document.createElement('li');
      li.setAttribute('data-testid', 'pdf-extract-images-item');
      li.setAttribute('data-index', String(entry.index));
      li.style.cssText = 'display:flex;gap:8px;align-items:center;border:1px solid #e2e8f0;border-radius:10px;padding:8px 10px;background:#fff;';
      var mime = entry.format === 'jpg' ? 'image/jpeg' : 'image/png';
      li.innerHTML =
        '<input type="checkbox" data-testid="pdf-extract-images-check"' + (entry.checked ? ' checked' : '') + ' aria-label="Select image ' + entry.index + '">' +
        '<img data-testid="pdf-extract-images-thumbnail" src="data:' + mime + ';base64,' + entry.dataBase64 + '" alt="" style="width:56px;height:56px;object-fit:contain;background:#f1f5f9;border-radius:6px;">' +
        '<span style="flex:1;min-width:0;font-size:13px;" data-testid="pdf-extract-images-meta"><strong>#' + entry.index + ' ' + escapeHtml(entry.name) + '</strong><br>' +
        '<span data-testid="pdf-extract-images-page">Page ' + entry.page + '</span> · ' +
        '<span data-testid="pdf-extract-images-dimensions">' + entry.width + '×' + entry.height + '</span> · ' +
        '<span data-testid="pdf-extract-images-format">' + entry.format.toUpperCase() + '</span> · ' +
        '<span data-testid="pdf-extract-images-size">' + fmtSize(entry.sizeBytes) + '</span></span>';
      li.querySelector('[data-testid="pdf-extract-images-check"]').addEventListener('change', function (ev) {
        entry.checked = !!ev.target.checked;
        refresh();
      });
      list.appendChild(li);
    });
    refresh();
  }

  function dataUrlToBlob(dataBase64, format) {
    var bin = atob(dataBase64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: format === 'jpg' ? 'image/jpeg' : 'image/png' });
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e2) {} }, 4000);
  }

  async function listImages() {
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
    refresh();
    setProgressVisible(true, 20);
    try {
      var form = new FormData();
      form.append('pdf', selected, selected.name);
      var res = await fetch('/api/admin/pdf-tools/extract-images/list', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) {
        var msg = 'Image detection failed.';
        try {
          var j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (e) {}
        throw new Error(msg);
      }
      var payload = await res.json();
      inventory = (payload.images || []).map(function (img) {
        img.checked = true;
        return img;
      });
      skippedNote = (payload.skipped && payload.skipped.length)
        ? payload.skipped.length + ' embedded object(s) skipped (' +
          payload.skipped.slice(0, 3).map(function (s) { return 'page ' + s.page + ': ' + s.reason; }).join('; ') +
          (payload.skipped.length > 3 ? '; …' : '') + ').'
        : '';
      setProgressVisible(false);
      if (!inventory.length) {
        setStatus('No extractable raster images found in this PDF.' + (skippedNote ? ' ' + skippedNote : ''), false);
      } else {
        setStatus('Found ' + inventory.length + ' image' + (inventory.length === 1 ? '' : 's') + '.', true);
      }
      render();
    } catch (err) {
      setProgressVisible(false);
      setStatus((err && err.message) || 'Image detection failed.', false);
    } finally {
      working = false;
      refresh();
    }
  }

  async function doExport() {
    if (working) return;
    setStatus('');
    setResult('');
    var chosen = inventory.filter(function (e) { return e.checked; });
    if (!chosen.length) {
      setStatus('Select at least one image first.', false);
      return;
    }
    if (!selected) {
      setStatus('Select one PDF file first.', false);
      return;
    }
    working = true;
    refresh();
    setProgressVisible(true, 30);
    try {
      if (chosen.length === 1) {
        // Single image: download straight from the listed bytes (no re-upload).
        var single = chosen[0];
        downloadBlob(dataUrlToBlob(single.dataBase64, single.format), single.name);
        setProgressVisible(true, 100);
        setStatus('Download started (' + single.name + ').', true);
        setResult('Single image downloaded directly.');
      } else {
        var form = new FormData();
        form.append('pdf', selected, selected.name);
        form.append('selection', chosen.map(function (e) { return e.index; }).join(','));
        var res = await fetch('/api/admin/pdf-tools/extract-images/download', { method: 'POST', body: form, credentials: 'same-origin' });
        if (!res.ok) {
          var msg = 'Export failed.';
          try {
            var j = await res.json();
            if (j && j.error) msg = j.error;
          } catch (e) {}
          throw new Error(msg);
        }
        setProgressVisible(true, 90);
        var blob = await res.blob();
        var headerName = res.headers.get('X-Export-Filename') || 'images.zip';
        var serverCount = parseInt(res.headers.get('X-Extracted-Count') || '0', 10);
        if (serverCount !== chosen.length) {
          throw new Error('Server packaged ' + serverCount + ' images, expected ' + chosen.length + '.');
        }
        downloadBlob(blob, headerName);
        setProgressVisible(true, 100);
        setStatus('Exported ' + chosen.length + ' images — ZIP download started (' + headerName + ').', true);
        setResult(chosen.length + ' images in one ZIP.');
      }
      setTimeout(function () { setProgressVisible(false); }, 2500);
    } catch (err) {
      setProgressVisible(false);
      setStatus((err && err.message) || 'Export failed.', false);
    } finally {
      working = false;
      refresh();
    }
  }

  function init() {
    var pick = $('pdfExtractImagesPick');
    var input = $('pdfExtractImagesFile');
    var btn = $('pdfExtractImagesBtn');
    var clear = $('pdfExtractImagesClear');
    var all = $('pdfExtractImagesSelectAll');
    var none = $('pdfExtractImagesSelectNone');
    if (pick && input) pick.addEventListener('click', function () { input.click(); });
    if (input) input.addEventListener('change', function () {
      setStatus('');
      setResult('');
      selected = (input.files && input.files[0]) || null;
      input.value = '';
      inventory = [];
      skippedNote = '';
      render();
      if (selected) listImages();
    });
    if (all) all.addEventListener('click', function () {
      inventory.forEach(function (e) { e.checked = true; });
      render();
    });
    if (none) none.addEventListener('click', function () {
      inventory.forEach(function (e) { e.checked = false; });
      render();
    });
    if (btn) btn.addEventListener('click', doExport);
    if (clear) clear.addEventListener('click', function () {
      selected = null;
      inventory = [];
      skippedNote = '';
      setStatus('');
      setResult('');
      setProgressVisible(false);
      render();
    });
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
