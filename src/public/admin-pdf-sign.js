// src/public/admin-pdf-sign.js — Standalone Sign PDF client (admin-only).
// ES module, no frameworks. A local pdf.js probe (vendored build, no CDN)
// reports the page count for page validation; the signature image previews
// locally via Image dimensions. Signing POSTs the PDF + image + placement to
// POST /api/admin/pdf-tools/sign; the server draws the image onto the page
// (VISUAL signature only — not cryptographic) and streams back a NEW PDF.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var root = document.querySelector('[data-testid="pdf-sign-root"]');
  var available = root ? root.getAttribute('data-available') === '1' : false;
  var maxFileMb = root ? Number(root.getAttribute('data-max-file-mb')) || 50 : 50;
  var maxImgMb = root ? Number(root.getAttribute('data-max-image-mb')) || 5 : 5;
  var maxFileBytes = maxFileMb * 1024 * 1024;
  var maxImgBytes = maxImgMb * 1024 * 1024;

  var selected = null; // File (PDF)
  var signature = null; // File (image)
  var pageCount = 0;
  var signing = false;

  function setStatus(text, ok) {
    var el = $('pdfSignStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = text ? (ok ? '#15803d' : '#b91c1c') : '';
  }

  function setResult(text) {
    var el = $('pdfSignResult');
    if (!el) return;
    el.textContent = text || '';
  }

  function setProgressVisible(on, pct) {
    var el = $('pdfSignProgress');
    if (!el) return;
    el.style.display = on ? 'block' : 'none';
    var pctEl = $('pdfSignProgressPct');
    if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  }

  function refresh() {
    var info = $('pdfSignFileInfo');
    if (info && !info.dataset.probed) {
      info.textContent = selected
        ? selected.name + ' · ' + pageCount + ' page' + (pageCount === 1 ? '' : 's')
        : 'No PDF selected yet.';
    }
    var imgInfo = $('pdfSignImgInfo');
    if (imgInfo && !imgInfo.dataset.probed) {
      imgInfo.textContent = signature
        ? signature.name + ' · signature image ready (visual only, not a digital signature).'
        : 'No signature image selected yet.';
    }
    var btn = $('pdfSignBtn');
    if (btn) btn.disabled = !available || signing || !selected || !signature;
  }

  async function probe(file) {
    // Local-only probe, never uploads: page count + already-protected check.
    var info = $('pdfSignFileInfo');
    pageCount = 0;
    try {
      var buf = new Uint8Array(await file.arrayBuffer());
      var task = pdfjsLib.getDocument({ data: buf });
      var doc = await task.promise;
      pageCount = doc.numPages;
      if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · ' + pageCount + ' page' + (pageCount === 1 ? '' : 's') + ' · ready to sign (visually).';
      }
      try { await task.destroy(); } catch (e) {}
    } catch (err) {
      var name = err && err.name;
      if (name === 'PasswordException') {
        if (info) {
          info.dataset.probed = '1';
          info.textContent = file.name + ' · 🔒 password-protected — unlock it before signing.';
        }
      } else if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · could not be previewed here; the server will validate on signing.';
      }
    }
    refresh();
  }

  function probeImage(file) {
    var imgInfo = $('pdfSignImgInfo');
    var img = new Image();
    img.onload = function () {
      if (imgInfo) {
        imgInfo.dataset.probed = '1';
        imgInfo.textContent = file.name + ' · ' + img.naturalWidth + '×' + img.naturalHeight +
          ' · signature image ready (visual only, not a digital signature).';
      }
      try { URL.revokeObjectURL(img.src); } catch (e) {}
      refresh();
    };
    img.onerror = function () {
      if (imgInfo) {
        imgInfo.dataset.probed = '1';
        imgInfo.textContent = file.name + ' · could not be previewed; the server will validate.';
      }
      refresh();
    };
    try {
      img.src = URL.createObjectURL(file);
    } catch (e) {
      refresh();
    }
  }

  async function doSign() {
    if (signing) return;
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
    if (!signature) {
      setStatus('Select one signature image (PNG or JPG) first.', false);
      return;
    }
    if (!/\.(png|jpe?g)$/i.test(signature.name || '')) {
      setStatus('Signature image must be .png, .jpg or .jpeg.', false);
      return;
    }
    if (!(signature.size > 0) || signature.size > maxImgBytes) {
      setStatus('Signature image is empty or exceeds ' + maxImgMb + ' MB.', false);
      return;
    }
    var pageEl = $('pdfSignPage');
    var page = pageEl ? Number(String(pageEl.value).trim()) : 1;
    if (!Number.isInteger(page) || page < 1 || (pageCount > 0 && page > pageCount)) {
      setStatus('Enter a page between 1 and ' + (pageCount || '?') + '.', false);
      return;
    }
    var get = function (id) {
      var el = $(id);
      return el ? el.value : '';
    };
    signing = true;
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
      form.append('signature', signature, signature.name);
      form.append('page', String(page));
      form.append('position', get('pdfSignPosition'));
      form.append('widthPt', get('pdfSignWidth'));
      var res = await fetch('/api/admin/pdf-tools/sign', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) {
        var msg = 'Signing failed.';
        try {
          var j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (e) {}
        throw new Error(msg);
      }
      setProgressVisible(true, 95);
      var blob = await res.blob();
      var headerName = res.headers.get('X-Export-Filename') || 'document-signed.pdf';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = headerName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e2) {} }, 4000);
      clearInterval(timer);
      setProgressVisible(true, 100);
      setStatus('Signed — download started (' + headerName + ').', true);
      setResult('Visual signature only — this is not a cryptographic digital signature.');
      setTimeout(function () { setProgressVisible(false); }, 2500);
    } catch (err) {
      clearInterval(timer);
      setProgressVisible(false);
      setStatus((err && err.message) || 'Signing failed.', false);
    } finally {
      signing = false;
      refresh();
    }
  }

  function init() {
    var pdfPick = $('pdfSignPdfPick');
    var pdfInput = $('pdfSignPdfFile');
    var imgPick = $('pdfSignImgPick');
    var imgInput = $('pdfSignImgFile');
    var btn = $('pdfSignBtn');
    var clear = $('pdfSignClear');
    if (pdfPick && pdfInput) pdfPick.addEventListener('click', function () { pdfInput.click(); });
    if (imgPick && imgInput) imgPick.addEventListener('click', function () { imgInput.click(); });
    if (pdfInput) pdfInput.addEventListener('change', function () {
      setStatus('');
      setResult('');
      selected = (pdfInput.files && pdfInput.files[0]) || null;
      pdfInput.value = '';
      var info = $('pdfSignFileInfo');
      if (info) delete info.dataset.probed;
      refresh();
      if (selected) probe(selected);
    });
    if (imgInput) imgInput.addEventListener('change', function () {
      setStatus('');
      setResult('');
      signature = (imgInput.files && imgInput.files[0]) || null;
      imgInput.value = '';
      var imgInfo = $('pdfSignImgInfo');
      if (imgInfo) delete imgInfo.dataset.probed;
      refresh();
      if (signature) probeImage(signature);
    });
    if (btn) btn.addEventListener('click', doSign);
    if (clear) clear.addEventListener('click', function () {
      selected = null;
      signature = null;
      pageCount = 0;
      setStatus('');
      setResult('');
      setProgressVisible(false);
      var info = $('pdfSignFileInfo');
      if (info) delete info.dataset.probed;
      var imgInfo = $('pdfSignImgInfo');
      if (imgInfo) delete imgInfo.dataset.probed;
      refresh();
    });
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
