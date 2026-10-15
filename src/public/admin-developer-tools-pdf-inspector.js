/**
 * PDF AcroForm Field Inspector - Client Side Handler
 * Handles PDF upload, client-side interactive search, filtration, and display.
 */

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('pdfFileInput');
    const inspectBtn = document.getElementById('inspectBtn');
    const clearBtn = document.getElementById('clearBtn');
    const errorContainer = document.getElementById('errorContainer');
    const resultsPanel = document.getElementById('resultsPanel');
    const searchInput = document.getElementById('fieldSearchInput');
    const typeFilter = document.getElementById('fieldTypeFilter');
    const fieldsList = document.getElementById('fieldsList');
    const metaFilename = document.getElementById('metaFilename');
    const metaCount = document.getElementById('metaCount');

    let parsedFields = [];

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        fileInput.value = '';
        resultsPanel.classList.add('hidden');
        errorContainer.classList.add('hidden');
        parsedFields = [];
      });
    }

    const loadSampleBtn = document.getElementById('loadSampleBtn');
    if (loadSampleBtn) {
      loadSampleBtn.addEventListener('click', async () => {
        loadSampleBtn.disabled = true;
        const originalText = loadSampleBtn.textContent;
        loadSampleBtn.textContent = 'Loading...';
        errorContainer.classList.add('hidden');

        try {
          const res = await fetch('/api/admin/developer-tools/pdf-inspector/sample');
          if (!res.ok) {
            throw new Error('Failed to fetch synthetic fillable PDF sample.');
          }
          const blob = await res.blob();
          const file = new File([blob], 'synthetic_fillable_sample.pdf', { type: 'application/pdf' });
          
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);
          fileInput.files = dataTransfer.files;

          // Automatically trigger inspection button click
          inspectBtn.click();
        } catch (err) {
          showError(err.message || 'Unable to load synthetic sample PDF.');
        } finally {
          loadSampleBtn.disabled = false;
          loadSampleBtn.textContent = originalText;
        }
      });
    }

    if (inspectBtn) {
      inspectBtn.addEventListener('click', async () => {
        const file = fileInput.files[0];
        if (!file) {
          showError('Please select a fillable PDF file to inspect.');
          return;
        }

        inspectBtn.disabled = true;
        inspectBtn.textContent = 'Inspecting PDF...';
        errorContainer.classList.add('hidden');
        resultsPanel.classList.add('hidden');

        const formData = new FormData();
        formData.append('pdf', file);

        try {
          const res = await fetch('/api/admin/developer-tools/pdf-inspector', {
            method: 'POST',
            body: formData
          });

          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || 'Server returned an error.');
          }

          parsedFields = data.fields || [];
          metaFilename.textContent = data.filename;
          metaCount.textContent = parsedFields.length;

          renderFieldsList();
          resultsPanel.classList.remove('hidden');

        } catch (err) {
          showError(err.message || 'Failed to inspect PDF form fields.');
        } finally {
          inspectBtn.disabled = false;
          inspectBtn.textContent = 'Inspect Form Fields';
        }
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', renderFieldsList);
    }

    if (typeFilter) {
      typeFilter.addEventListener('change', renderFieldsList);
    }

    function renderFieldsList() {
      const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
      const filter = typeFilter ? typeFilter.value : 'all';

      fieldsList.innerHTML = '';

      const filtered = parsedFields.filter(f => {
        const matchesQuery = f.name.toLowerCase().includes(query) || (f.value && String(f.value).toLowerCase().includes(query));
        const matchesFilter = filter === 'all' || f.type.toLowerCase() === filter.toLowerCase();
        return matchesQuery && matchesFilter;
      });

      if (filtered.length === 0) {
        fieldsList.innerHTML = `
          <div class="col-span-full py-12 text-center text-slate-500 bg-slate-50 rounded-xl border border-slate-200">
            No AcroForm fields matches your criteria.
          </div>
        `;
        return;
      }

      filtered.forEach((f, idx) => {
        const fieldEl = document.createElement('div');
        fieldEl.className = 'bg-white border border-slate-200 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow relative group';

        let badgeColor = 'bg-slate-100 text-slate-700';
        if (f.type === 'Text') badgeColor = 'bg-blue-50 text-blue-700 border-blue-200';
        else if (f.type === 'Checkbox') badgeColor = 'bg-emerald-50 text-emerald-700 border-emerald-200';
        else if (f.type === 'Radio') badgeColor = 'bg-purple-50 text-purple-700 border-purple-200';
        else if (f.type === 'Dropdown') badgeColor = 'bg-amber-50 text-amber-700 border-amber-200';
        else if (f.type === 'Signature') badgeColor = 'bg-rose-50 text-rose-700 border-rose-200';

        const coordsHtml = f.coords 
          ? `<span class="text-xs text-slate-500" title="Widget Bounding Box">Coords: x=${f.coords.x}, y=${f.coords.y} [${f.coords.width}x${f.coords.height}px]</span>`
          : '<span class="text-xs text-slate-400 italic">No visual widget coords</span>';

        const pageHtml = f.page
          ? `<span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-800 text-[11px] font-bold border border-slate-200 shrink-0">Page ${f.page}</span>`
          : '<span class="px-2 py-0.5 rounded-full bg-slate-50 text-slate-400 text-[11px] border shrink-0">No page link</span>';

        const flagsList = [];
        if (f.flags.readOnly) flagsList.push('<span class="text-[10px] bg-slate-100 text-slate-600 font-bold px-1.5 py-0.5 rounded border">Read-Only</span>');
        if (f.flags.required) flagsList.push('<span class="text-[10px] bg-red-50 text-red-600 font-bold px-1.5 py-0.5 rounded border border-red-200">Required</span>');
        if (f.flags.multiline) flagsList.push('<span class="text-[10px] bg-blue-50 text-blue-600 font-bold px-1.5 py-0.5 rounded border">Multiline</span>');
        if (f.flags.password) flagsList.push('<span class="text-[10px] bg-slate-900 text-white font-bold px-1.5 py-0.5 rounded border">Password</span>');
        if (f.flags.options && f.flags.options.length > 0) {
          flagsList.push(`<span class="text-[10px] bg-purple-50 text-purple-600 font-bold px-1.5 py-0.5 rounded border" title="Available choices: ${escapeHtml(f.flags.options.join(', '))}">Options (${f.flags.options.length})</span>`);
        }

        fieldEl.innerHTML = `
          <div class="flex items-start justify-between gap-3 border-b border-slate-100 pb-3 mb-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h4 class="font-mono text-sm font-bold text-slate-900 select-all truncate max-w-xs md:max-w-md" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</h4>
                <button class="text-slate-400 hover:text-slate-600 p-0.5 rounded border border-transparent hover:bg-slate-100 transition-colors btn-copy-name" title="Copy field name">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg>
                </button>
              </div>
              <div class="flex items-center gap-2 mt-1 flex-wrap">
                <span class="px-2 py-0.5 rounded text-[10px] font-bold border ${badgeColor}">${f.type.toUpperCase()}</span>
                ${coordsHtml}
              </div>
            </div>
            ${pageHtml}
          </div>

          <div class="space-y-2">
            <div>
              <span class="text-[10px] text-slate-400 uppercase tracking-wider block">Current Value:</span>
              <div class="flex items-center gap-2 mt-1">
                <code class="bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs text-slate-800 break-all select-all flex-1 font-mono min-h-[26px] flex items-center">${escapeHtml(String(f.value !== undefined ? f.value : '')) || '<span class="text-slate-400 italic">Empty</span>'}</code>
                <button class="px-2 py-1 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded border transition-colors shrink-0 btn-copy-value" title="Copy value">
                  Copy
                </button>
              </div>
            </div>

            ${flagsList.length > 0 ? `
              <div class="pt-1.5 flex items-center gap-1.5 flex-wrap">
                <span class="text-[10px] text-slate-400 uppercase tracking-wider mr-1">Flags:</span>
                ${flagsList.join('')}
              </div>
            ` : ''}
          </div>
        `;

        // Wire copy name button
        const copyNameBtn = fieldEl.querySelector('.btn-copy-name');
        if (copyNameBtn) {
          copyNameBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(f.name);
            const originalSvg = copyNameBtn.innerHTML;
            copyNameBtn.innerHTML = '<svg class="w-3.5 h-3.5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>';
            setTimeout(() => {
              copyNameBtn.innerHTML = originalSvg;
            }, 1000);
          });
        }

        // Wire copy value button
        const copyValBtn = fieldEl.querySelector('.btn-copy-value');
        if (copyValBtn) {
          copyValBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(String(f.value || ''));
            const originalText = copyValBtn.textContent;
            copyValBtn.textContent = 'Copied!';
            copyValBtn.classList.add('text-emerald-600', 'border-emerald-200');
            setTimeout(() => {
              copyValBtn.textContent = originalText;
              copyValBtn.classList.remove('text-emerald-600', 'border-emerald-200');
            }, 1000);
          });
        }

        fieldsList.appendChild(fieldEl);
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

    function escapeHtml(str) {
      if (!str) return '';
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
  });
}
