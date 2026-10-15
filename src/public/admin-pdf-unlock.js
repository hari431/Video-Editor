// src/public/admin-pdf-unlock.js — Standalone Unlock PDF client (admin-only).
// ES module, no frameworks. A local pdf.js probe (vendored build, no CDN)
// reports whether the selected file looks password-protected and its page
// count. Unlocking POSTs the file + password to
// POST /api/admin/pdf-tools/unlock; the server tries the password exactly
// once and streams back a NEW unlocked PDF. The password field is cleared
// after every attempt and is never logged or stored.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var root = document.querySelector('[data-testid="pdf-unlock-root"]');
  var available = root ? root.getAttribute('data-available') === '1' : false;
  var maxFileMb = root ? Number(root.getAttribute('data-max-file-mb')) || 50 : 50;
  var maxFileBytes = maxFileMb * 1024 * 1024;

  var selected = null; // File
  var unlocking = false;

  function setStatus(text, ok) {
    var el = $('pdfUnlockStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = text ? (ok ? '#15803d' : '#b91c1c') : '';
  }

  function setProgressVisible(on, pct) {
    var el = $('pdfUnlockProgress');
    if (!el) return;
    el.style.display = on ? 'block' : 'none';
    var pctEl = $('pdfUnlockProgressPct');
    if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  }

  function refresh() {
    var info = $('pdfUnlockFileInfo');
    if (info) {
      info.textContent = selected
        ? selected.name + ' · ' + (selected.size / 1048576).toFixed(2) + ' MB'
        : 'No PDF selected yet.';
    }
    var btn = $('pdfUnlockBtn');
    if (btn) btn.disabled = !available || unlocking || !selected;
  }

  function clearPassword() {
    var pw = $('pdfUnlockPassword');
    if (pw) pw.value = '';
  }

  async function probe(file) {
    // Local-only probe, never uploads: reports locked status + page count.
    var info = $('pdfUnlockFileInfo');
    var pwEl = $('pdfUnlockPassword');
    var typed = pwEl && pwEl.value ? pwEl.value : '';
    try {
      var buf = new Uint8Array(await file.arrayBuffer());
      var task = pdfjsLib.getDocument({ data: buf, password: typed || undefined });
      var doc = await task.promise;
      var pages = doc.numPages;
      if (info) info.textContent = file.name + ' · ' + pages + ' page' + (pages === 1 ? '' : 's') + ' · not password-protected (password optional).';
      try { await task.destroy(); } catch (e) {}
    } catch (err) {
      var name = err && err.name;
      var msg = String((err && err.message) || '');
      if (name === 'PasswordException' && /no password/i.test(msg)) {
        if (info) info.textContent = file.name + ' · 🔒 password-protected — enter the document password.';
      } else if (name === 'PasswordException') {
        if (typed) setStatus('Incorrect password (local check). The server will verify on unlock.', false);
        else if (info) info.textContent = file.name + ' · 🔒 password-protected — enter the document password.';
      } else if (info) {
        info.textContent = file.name + ' · could not be previewed here; the server will validate on unlock.';
      }
    }
  }

  async function doUnlock() {
    if (unlocking) return;
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
    var pwEl = $('pdfUnlockPassword');
    var typed = pwEl && pwEl.value ? pwEl.value : '';
    unlocking = true;
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
      form.append('password', typed);
      var res = await fetch('/api/admin/pdf-tools/unlock', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) {
        var msg = 'Unlock failed.';
        try {
          var j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (e) {}
        throw new Error(msg);
      }
      setProgressVisible(true, 95);
      var blob = await res.blob();
      var headerName = res.headers.get('X-Export-Filename') || 'document-unlocked.pdf';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = headerName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e2) {} }, 4000);
      clearInterval(timer);
      setProgressVisible(true, 100);
      setStatus('Unlocked — download started (' + headerName + ').', true);
      setTimeout(function () { setProgressVisible(false); }, 2500);
    } catch (err) {
      clearInterval(timer);
      setProgressVisible(false);
      setStatus((err && err.message) || 'Unlock failed.', false);
    } finally {
      clearPassword();
      unlocking = false;
      refresh();
    }
  }

  function init() {
    var pick = $('pdfUnlockPick');
    var input = $('pdfUnlockFile');
    var btn = $('pdfUnlockBtn');
    var clear = $('pdfUnlockClear');
    var pw = $('pdfUnlockPassword');
    if (pick && input) pick.addEventListener('click', function () { input.click(); });
    if (input) input.addEventListener('change', function () {
      setStatus('');
      selected = (input.files && input.files[0]) || null;
      input.value = '';
      refresh();
      if (selected) probe(selected);
    });
    if (pw) pw.addEventListener('input', function () { if (selected) probe(selected); });
    if (btn) btn.addEventListener('click', doUnlock);
    if (clear) clear.addEventListener('click', function () {
      selected = null;
      clearPassword();
      setStatus('');
      setProgressVisible(false);
      refresh();
    });
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
