/**
 * Timestamp & DateTime Converter Library Module
 * Offline-capable, fully sandboxed in-browser conversion utilities.
 * Supports Unix seconds/milliseconds and converts to ISO-8601 / UTC / Local.
 */

export function convertFromUnix(val) {
  const clean = String(val).trim();
  if (!/^\d+$/.test(clean)) {
    throw new Error('Timestamp must contain numbers only.');
  }

  const num = Number(clean);
  let date;
  if (clean.length <= 11) {
    // Treat as seconds
    date = new Date(num * 1000);
  } else {
    // Treat as milliseconds
    date = new Date(num);
  }

  if (isNaN(date.getTime())) {
    throw new Error('The timestamp is invalid or out of range.');
  }

  return date;
}

export function convertFromIso(val) {
  const clean = String(val).trim();
  const date = new Date(clean);
  if (isNaN(date.getTime())) {
    throw new Error('Invalid ISO 8601 / Date String format. Use standard formats like "2026-09-30T04:30:00Z" or "2026-01-01".');
  }
  return date;
}

// UI Wiring
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const timestampInput = document.getElementById('timestampInput');
    const btnConvertTimestamp = document.getElementById('btnConvertTimestamp');
    
    const isoInput = document.getElementById('isoInput');
    const btnConvertIso = document.getElementById('btnConvertIso');

    const btnLoadSample = document.getElementById('btnLoadSample');
    const btnClearAll = document.getElementById('btnClearAll');

    const errorContainer = document.getElementById('errorContainer');
    const resultsPanel = document.getElementById('resultsPanel');

    // Outputs
    const outSeconds = document.getElementById('outSeconds');
    const outMillis = document.getElementById('outMillis');
    const outIso = document.getElementById('outIso');
    const outUtc = document.getElementById('outUtc');
    const outLocal = document.getElementById('outLocal');

    if (btnLoadSample) {
      btnLoadSample.addEventListener('click', () => {
        // Known fixed synthetic date value
        timestampInput.value = '1785501192'; // ~Year 2026
        btnConvertTimestamp.click();
      });
    }

    if (btnClearAll) {
      btnClearAll.addEventListener('click', () => {
        timestampInput.value = '';
        isoInput.value = '';
        errorContainer.classList.add('hidden');
        resultsPanel.classList.add('hidden');
      });
    }

    function populateResults(date) {
      outSeconds.value = Math.floor(date.getTime() / 1000);
      outMillis.value = date.getTime();
      outIso.value = date.toISOString();
      outUtc.value = date.toUTCString();
      outLocal.value = date.toLocaleString();
      resultsPanel.classList.remove('hidden');
    }

    if (btnConvertTimestamp) {
      btnConvertTimestamp.addEventListener('click', () => {
        errorContainer.classList.add('hidden');
        resultsPanel.classList.add('hidden');
        
        const val = timestampInput.value;
        if (!val) {
          showError('Please enter a Unix timestamp.');
          return;
        }

        try {
          const date = convertFromUnix(val);
          populateResults(date);
        } catch (err) {
          showError(err.message);
        }
      });
    }

    if (btnConvertIso) {
      btnConvertIso.addEventListener('click', () => {
        errorContainer.classList.add('hidden');
        resultsPanel.classList.add('hidden');

        const val = isoInput.value;
        if (!val) {
          showError('Please enter an ISO-8601 Date String.');
          return;
        }

        try {
          const date = convertFromIso(val);
          populateResults(date);
        } catch (err) {
          showError(err.message);
        }
      });
    }

    function showError(msg) {
      errorContainer.classList.remove('hidden');
      errorContainer.innerHTML = `
        <div class="flex items-start gap-3">
          <svg class="w-5 h-5 text-red-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
          <div class="text-sm font-semibold text-red-900">${msg}</div>
        </div>
      `;
    }
  });
}
