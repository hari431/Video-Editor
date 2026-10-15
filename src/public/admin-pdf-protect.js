// src/public/admin-pdf-protect.js — Standalone Protect PDF client (admin-only).
// ES module, no frameworks. A local pdf.js probe (vendored build, no CDN)
// reports the selected file's page count and whether it is already
// password-protected. Protecting POSTs the file + password + confirmation to
// POST /api/admin/pdf-tools/protect; the server AES-256 encrypts it and
// streams back a NEW protected PDF. Both password fields are cleared after
// every attempt and are never logged or stored.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var root = document.querySelector('[data-testid="pdf-protect-root"]');
  var available = root ? root.getAttribute('data-available') === '1' : false;
  var maxFileMb = root ? Number(root.getAttribute('data-max-file-mb')) || 50 : 50;
  var maxFileBytes = maxFileMb * 1024 * 1024;

  var selected = null; // File
  var protecting = false;

  function setStatus(text, ok) {
    var el = $('pdfProtectStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = text ? (ok ? '#15803d' : '#b91c1c') : '';
  }

  function setProgressVisible(on, pct) {
    var el = $('pdfProtectProgress');
    if (!el) return;
    el.style.display = on ? 'block' : 'none';
    var pctEl = $('pdfProtectProgressPct');
    if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  }

  function refresh() {
    var info = $('pdfProtectFileInfo');
    if (info && !info.dataset.probed) {
      info.textContent = selected
        ? selected.name + ' · ' + (selected.size / 1048576).toFixed(2) + ' MB'
        : 'No PDF selected yet.';
    }
    var btn = $('pdfProtectBtn');
    if (btn) btn.disabled = !available || protecting || !selected;
  }

  function clearPasswords() {
    var pw = $('pdfProtectPassword');
    var confirm = $('pdfProtectConfirm');
    if (pw) pw.value = '';
    if (confirm) confirm.value = '';
  }

  function passwords() {
    var pwEl = $('pdfProtectPassword');
    var confirmEl = $('pdfProtectConfirm');
    return {
      pw: pwEl && pwEl.value ? pwEl.value : '',
      confirm: confirmEl && confirmEl.value ? confirmEl.value : ''
    };
  }

  async function probe(file) {
    // Local-only probe, never uploads: page count + already-protected check.
    var info = $('pdfProtectFileInfo');
    try {
      var buf = new Uint8Array(await file.arrayBuffer());
      var task = pdfjsLib.getDocument({ data: buf });
      var doc = await task.promise;
      var pages = doc.numPages;
      if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · ' + pages + ' page' + (pages === 1 ? '' : 's') + ' · ready to protect.';
      }
      try { await task.destroy(); } catch (e) {}
    } catch (err) {
      var name = err && err.name;
      if (name === 'PasswordException') {
        if (info) {
          info.dataset.probed = '1';
          info.textContent = file.name + ' · 🔒 already password-protected — protecting it again is not supported.';
        }
      } else if (info) {
        info.dataset.probed = '1';
        info.textContent = file.name + ' · could not be previewed here; the server will validate on protect.';
      }
    }
  }

  async function doProtect() {
    if (protecting) return;
    setStatus('');
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
    var typed = passwords();
    if (!typed.pw) {
      setStatus('Enter a password to protect the PDF.', false);
      return;
    }
    if (typed.pw !== typed.confirm) {
      setStatus('Passwords do not match.', false);
      return;
    }
    protecting = true;
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
      form.append('password', typed.pw);
      form.append('confirmPassword', typed.confirm);
      var res = await fetch('/api/admin/pdf-tools/protect', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) {
        var msg = 'Protection failed.';
        try {
          var j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (e) {}
        throw new Error(msg);
      }
      setProgressVisible(true, 95);
      var blob = await res.blob();
      var headerName = res.headers.get('X-Export-Filename') || 'document-protected.pdf';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = headerName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e2) {} }, 4000);
      clearInterval(timer);
      setProgressVisible(true, 100);
      setStatus('Protected — download started (' + headerName + '). Keep the password safe: it cannot be recovered.', true);
      setTimeout(function () { setProgressVisible(false); }, 2500);
    } catch (err) {
      clearInterval(timer);
      setProgressVisible(false);
      setStatus((err && err.message) || 'Protection failed.', false);
    } finally {
      clearPasswords();
      protecting = false;
      refresh();
    }
  }

  function init() {
    var pick = $('pdfProtectPick');
    var input = $('pdfProtectFile');
    var btn = $('pdfProtectBtn');
    var clear = $('pdfProtectClear');
    if (pick && input) pick.addEventListener('click', function () { input.click(); });
    if (input) input.addEventListener('change', function () {
      setStatus('');
      selected = (input.files && input.files[0]) || null;
      input.value = '';
      var info = $('pdfProtectFileInfo');
      if (info) delete info.dataset.probed;
      refresh();
      if (selected) probe(selected);
    });
    if (btn) btn.addEventListener('click', doProtect);
    if (clear) clear.addEventListener('click', function () {
      selected = null;
      clearPasswords();
      setStatus('');
      setProgressVisible(false);
      var info = $('pdfProtectFileInfo');
      if (info) delete info.dataset.probed;
      refresh();
    });
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
