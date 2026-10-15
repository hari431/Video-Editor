/**
 * Encoding & Decoding Library Module
 * Offline-capable, fully sandboxed in-browser conversion utilities.
 * Handles Unicode, base64, URL, HTML entities, and unicode escape formatting.
 */

export function runEncoding(input, mode, action) {
  if (!input) return '';

  try {
    if (mode === 'base64') {
      if (action === 'encode') {
        // Securely handle UTF-8 characters during base64 encoding
        return btoa(unescape(encodeURIComponent(input)));
      } else {
        // Catch invalid base64 decodes gracefully
        return decodeURIComponent(escape(atob(input)));
      }
    }

    if (mode === 'url') {
      if (action === 'encode') {
        return encodeURIComponent(input);
      } else {
        return decodeURIComponent(input);
      }
    }

    if (mode === 'html') {
      if (action === 'encode') {
        return String(input)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      } else {
        // Decode HTML entities
        const doc = new DOMParser().parseFromString(input, 'text/html');
        return doc.documentElement.textContent || '';
      }
    }

    if (mode === 'unicode') {
      if (action === 'encode') {
        return input.split('').map(char => {
          const code = char.charCodeAt(0).toString(16).toUpperCase();
          return '\\u' + code.padStart(4, '0');
        }).join('');
      } else {
        // Decode Unicode escape characters e.g. \u0047
        return input.replace(/\\u([0-9a-fA-F]{4})/g, (match, grp) => {
          return String.fromCharCode(parseInt(grp, 16));
        });
      }
    }

    return input;
  } catch (err) {
    throw new Error(`Conversion failed: ${err.message}. Check that the input format matches the selected decoding parameters.`);
  }
}

// UI Wiring
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const rawInputText = document.getElementById('rawInputText');
    const encodingModeSelect = document.getElementById('encodingModeSelect');
    const btnActionEncode = document.getElementById('btnActionEncode');
    const btnActionDecode = document.getElementById('btnActionDecode');
    
    const btnLoadSample = document.getElementById('btnLoadSample');
    const btnClearAll = document.getElementById('btnClearAll');
    
    const errorContainer = document.getElementById('errorContainer');
    const outputContainer = document.getElementById('outputContainer');
    const outputResultText = document.getElementById('outputResultText');
    const copyOutputBtn = document.getElementById('copyOutputBtn');

    if (btnLoadSample) {
      btnLoadSample.addEventListener('click', () => {
        rawInputText.value = 'Guidewire ClaimCenter: cc-982314 & PolicyCenter: pc-102944 (ID: #55)';
        encodingModeSelect.value = 'base64';
        btnActionEncode.click();
      });
    }

    if (btnClearAll) {
      btnClearAll.addEventListener('click', () => {
        rawInputText.value = '';
        outputResultText.value = '';
        errorContainer.classList.add('hidden');
        outputContainer.classList.add('hidden');
      });
    }

    function execute(action) {
      errorContainer.classList.add('hidden');
      outputContainer.classList.add('hidden');

      const text = rawInputText.value;
      if (!text) {
        showError('Please enter input text to translate.');
        return;
      }

      const mode = encodingModeSelect.value;

      try {
        const out = runEncoding(text, mode, action);
        outputResultText.value = out;
        outputContainer.classList.remove('hidden');
      } catch (err) {
        showError(err.message);
      }
    }

    if (btnActionEncode) {
      btnActionEncode.addEventListener('click', () => execute('encode'));
    }

    if (btnActionDecode) {
      btnActionDecode.addEventListener('click', () => execute('decode'));
    }

    if (copyOutputBtn) {
      copyOutputBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(outputResultText.value).then(() => {
          const originalText = copyOutputBtn.textContent;
          copyOutputBtn.textContent = '✓ Copied!';
          setTimeout(() => {
            copyOutputBtn.textContent = originalText;
          }, 1500);
        });
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
