// src/public/admin-pdf-images.js — Standalone Images to PDF client (admin-only).
// ES module, no frameworks. Selected images preview as thumbnails (object
// URLs revoked on remove/clear) with dimensions read locally via Image.
// Files upload in DISPLAYED order to POST /api/admin/pdf-tools/images-to-pdf;
// the server embeds them verbatim (no quality change) and streams back a NEW
// PDF with one image per page.
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var root = document.querySelector('[data-testid="pdf-images-root"]');
  var available = root ? root.getAttribute('data-available') === '1' : false;
  var maxFileMb = root ? Number(root.getAttribute('data-max-file-mb')) || 5 : 5;
  var maxFiles = root ? Number(root.getAttribute('data-max-files')) || 8 : 8;
  var maxFileBytes = maxFileMb * 1024 * 1024;

  var items = []; // [{ id, file, name, size, url, width, height, error }]
  var nextId = 1;
  var converting = false;
  var dragId = null;

  function setStatus(text, ok) {
    var el = $('pdfImagesStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = text ? (ok ? '#15803d' : '#b91c1c') : '';
  }

  function setResult(text) {
    var el = $('pdfImagesResult');
    if (!el) return;
    el.textContent = text || '';
  }

  function setProgressVisible(on, pct) {
    var el = $('pdfImagesProgress');
    if (!el) return;
    el.style.display = on ? 'block' : 'none';
    var pctEl = $('pdfImagesProgressPct');
    if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  }

  function refreshHint() {
    var hint = $('pdfImagesHint');
    if (hint) hint.style.display = items.length ? 'none' : 'block';
    var btn = $('pdfImagesBtn');
    if (btn) btn.disabled = !available || converting || items.length === 0;
  }

  function revoke(entry) {
    try { if (entry.url) URL.revokeObjectURL(entry.url); } catch (e) {}
    entry.url = null;
  }

  function probeDims(entry) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        entry.width = img.naturalWidth;
        entry.height = img.naturalHeight;
        try { URL.revokeObjectURL(img.src); } catch (e) {}
        resolve();
      };
      img.onerror = function () {
        entry.error = 'Could not be read as an image.';
        resolve();
      };
      img.src = entry.url;
    });
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
    items = items.filter(function (e) {
      if (e.id === id) { revoke(e); return false; }
      return true;
    });
    render();
  }

  function render() {
    var list = $('pdfImagesList');
    if (!list) return;
    list.innerHTML = '';
    items.forEach(function (entry, idx) {
      var li = document.createElement('li');
      li.setAttribute('data-testid', 'pdf-images-item');
      li.setAttribute('data-id', String(entry.id));
      li.setAttribute('draggable', 'true');
      li.style.cssText = 'display:flex;gap:8px;align-items:center;border:1px solid #e2e8f0;border-radius:10px;padding:8px 10px;background:#fff;';
      var meta = entry.width
        ? escapeHtml(entry.name) + ' · <span data-testid="pdf-images-dimensions">' + entry.width + '×' + entry.height + '</span>'
        : escapeHtml(entry.name) + ' · <span data-testid="pdf-images-dimensions">' + (entry.error || 'reading…') + '</span>';
      var thumb = entry.url && !entry.error
        ? '<img data-testid="pdf-images-thumbnail" src="' + entry.url + '" alt="" style="width:56px;height:56px;object-fit:contain;background:#f1f5f9;border-radius:6px;">'
        : '<span style="width:56px;text-align:center;">🖼</span>';
      li.innerHTML =
        '<span style="font-weight:700;color:#64748b;min-width:22px;" data-testid="pdf-images-order">' + (idx + 1) + '.</span>' +
        thumb +
        '<span style="flex:1;min-width:0;font-size:13px;" data-testid="pdf-images-filename">' + meta + '</span>' +
        '<button type="button" class="button small secondary" data-act="up" data-testid="pdf-images-up" aria-label="Move up">↑</button>' +
        '<button type="button" class="button small secondary" data-act="down" data-testid="pdf-images-down" aria-label="Move down">↓</button>' +
        '<button type="button" class="button small secondary" data-act="remove" data-testid="pdf-images-remove" aria-label="Remove">✕</button>';
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
    setResult('');
    var incoming = Array.prototype.slice.call(fileList || []);
    if (!incoming.length) return;
    if (items.length + incoming.length > maxFiles) {
      setStatus('At most ' + maxFiles + ' images per PDF.', false);
      incoming = incoming.slice(0, Math.max(0, maxFiles - items.length));
    }
    for (var k = 0; k < incoming.length; k++) {
      var f = incoming[k];
      var entry = {
        id: nextId++, file: f, name: f.name || 'image', size: f.size,
        url: null, width: 0, height: 0, error: null
      };
      if (!/\.(png|jpe?g)$/i.test(entry.name)) {
        entry.error = 'Not a .jpg/.jpeg/.png file — it will be rejected on convert.';
      } else if (!(entry.size > 0)) {
        entry.error = 'Empty file.';
      } else if (entry.size > maxFileBytes) {
        entry.error = 'Exceeds ' + maxFileMb + ' MB.';
      } else {
        try {
          entry.url = URL.createObjectURL(f);
        } catch (e) {
          entry.error = 'Could not be previewed.';
        }
      }
      items.push(entry);
      render();
      if (entry.url && !entry.error) {
        await probeDims(entry);
        render();
        if (entry.error) setStatus('"' + entry.name + '": ' + entry.error, false);
      } else if (entry.error) {
        setStatus('"' + entry.name + '": ' + entry.error, false);
      }
    }
    render();
  }

  async function doConvert() {
    if (converting) return;
    setStatus('');
    setResult('');
    if (!items.length) {
      setStatus('Select at least one image first.', false);
      return;
    }
    var bad = items.filter(function (e) { return e.error || !e.width; });
    if (bad.length) {
      setStatus('Remove unreadable files before converting: ' + bad.map(function (e) { return e.name; }).join(', '), false);
      return;
    }
    var pageSizeEl = $('pdfImagesPageSize');
    var orientationEl = $('pdfImagesOrientation');
    var marginEl = $('pdfImagesMargin');
    converting = true;
    refreshHint();
    setProgressVisible(true, 5);
    var pct = 5;
    var timer = setInterval(function () {
      pct = Math.min(90, pct + 5);
      setProgressVisible(true, pct);
    }, 250);
    try {
      var form = new FormData();
      items.forEach(function (e) { form.append('image', e.file, e.name); });
      form.append('pageSize', pageSizeEl ? pageSizeEl.value : 'A4');
      form.append('orientation', orientationEl ? orientationEl.value : 'auto');
      form.append('margin', marginEl ? marginEl.value : '36');
      var res = await fetch('/api/admin/pdf-tools/images-to-pdf', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) {
        var msg = 'Conversion failed.';
        try {
          var j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (e) {}
        throw new Error(msg);
      }
      setProgressVisible(true, 95);
      var blob = await res.blob();
      var pages = parseInt(res.headers.get('X-Images-Pages') || String(items.length), 10) || items.length;
      var headerName = res.headers.get('X-Export-Filename') || 'images.pdf';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = headerName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e2) {} }, 4000);
      clearInterval(timer);
      setProgressVisible(true, 100);
      setStatus('Converted ' + pages + ' image' + (pages === 1 ? '' : 's') + ' — download started (' + headerName + ').', true);
      setTimeout(function () { setProgressVisible(false); }, 2500);
    } catch (err) {
      clearInterval(timer);
      setProgressVisible(false);
      setStatus((err && err.message) || 'Conversion failed.', false);
    } finally {
      converting = false;
      refreshHint();
    }
  }

  function init() {
    var pick = $('pdfImagesPick');
    var input = $('pdfImagesFile');
    var btn = $('pdfImagesBtn');
    var clear = $('pdfImagesClear');
    if (pick && input) pick.addEventListener('click', function () { input.click(); });
    if (input) input.addEventListener('change', function () { addFiles(input.files); input.value = ''; });
    if (btn) btn.addEventListener('click', doConvert);
    if (clear) clear.addEventListener('click', function () {
      items.forEach(revoke);
      items = [];
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
