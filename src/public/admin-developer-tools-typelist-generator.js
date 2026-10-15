/**
 * Guidewire Typelist Generator - Core Engine & DOM UI wiring
 * Offline-capable, fully testable in both Node.js and Browser environments.
 */

/**
 * Escapes XML values securely.
 */
export function escapeXmlValue(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates Guidewire XML typelist structure.
 */
export function generateTypelistXml({ name, desc, format, typecodes }) {
  const safeName = escapeXmlValue(name || 'CustomTypelist');
  const safeDesc = escapeXmlValue(desc || 'Custom typelist description.');

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';

  if (format === 'ttx') {
    xml += `<typelistextension xmlns="http://guidewire.com/typelists" name="${safeName}">\n`;
  } else if (format === 'fnt') {
    xml += `<typelistfilter xmlns="http://guidewire.com/typelists" name="Filter_${safeName}" typelist="${safeName}">\n`;
  } else {
    xml += `<typelist xmlns="http://guidewire.com/typelists"\n  name="${safeName}"\n  desc="${safeDesc}">\n`;
  }

  typecodes.forEach((tc) => {
    const code = escapeXmlValue(tc.code);
    const tcName = escapeXmlValue(tc.name);
    const tcDesc = escapeXmlValue(tc.desc);
    const priority = tc.priority ? Number(tc.priority) : '';
    const retired = tc.retired === true || tc.retired === 'true';
    const category = escapeXmlValue(tc.category);
    const parent = escapeXmlValue(tc.parent);

    if (format === 'fnt') {
      xml += `  <include code="${code}"/>\n`;
    } else {
      let tcAttrs = `code="${code}" name="${tcName}" desc="${tcDesc}"`;
      if (priority !== '') {
        tcAttrs += ` priority="${priority}"`;
      }
      if (retired) {
        tcAttrs += ` retired="true"`;
      }

      if (category || parent) {
        xml += `  <typecode ${tcAttrs}>\n`;
        if (category) {
          xml += `    <category code="${category}"/>\n`;
        }
        if (parent) {
          xml += `    <category code="${parent}"/>\n`;
        }
        xml += `  </typecode>\n`;
      } else {
        xml += `  <typecode ${tcAttrs}/>\n`;
      }
    }
  });

  if (format === 'ttx') {
    xml += '</typelistextension>';
  } else if (format === 'fnt') {
    xml += '</typelistfilter>';
  } else {
    xml += '</typelist>';
  }

  return xml;
}

// UI Wiring
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const listNameInput = document.getElementById('listNameInput');
    const listDescInput = document.getElementById('listDescInput');
    const formatSelect = document.getElementById('formatSelect');
    const typecodesTableBody = document.getElementById('typecodesTableBody');
    const btnAddTypecode = document.getElementById('btnAddTypecode');
    const btnGenerate = document.getElementById('btnGenerate');
    const btnLoadSample = document.getElementById('btnLoadSample');
    const btnClearAll = document.getElementById('btnClearAll');
    const copyXmlBtn = document.getElementById('copyXmlBtn');
    const downloadXmlBtn = document.getElementById('downloadXmlBtn');
    const xmlOutputContainer = document.getElementById('xmlOutputContainer');
    const rawXmlPre = document.getElementById('rawXmlPre');

    const sampleTypecodes = [
      { code: 'draft', name: 'Draft', desc: 'Draft initial status', priority: 1, category: 'PersonalAuto', parent: '', retired: false },
      { code: 'bound', name: 'Bound', desc: 'Active bound policy', priority: 2, category: 'CommercialAuto', parent: '', retired: false },
      { code: 'expired', name: 'Expired', desc: 'Terminated or expired policy', priority: 3, category: 'WorkersComp', parent: '', retired: true }
    ];

    if (btnLoadSample) {
      btnLoadSample.addEventListener('click', () => {
        listNameInput.value = 'PolicyStatus';
        listDescInput.value = 'System typelist representing policy period life states';
        formatSelect.value = 'tti';
        
        typecodesTableBody.innerHTML = '';
        sampleTypecodes.forEach(tc => addTypecodeRow(tc));
        btnGenerate.click();
      });
    }

    if (btnClearAll) {
      btnClearAll.addEventListener('click', () => {
        listNameInput.value = '';
        listDescInput.value = '';
        formatSelect.value = 'tti';
        typecodesTableBody.innerHTML = '';
        xmlOutputContainer.classList.add('hidden');
        rawXmlPre.textContent = '';
      });
    }

    if (btnAddTypecode) {
      btnAddTypecode.addEventListener('click', () => {
        addTypecodeRow({ code: '', name: '', desc: '', priority: '', category: '', parent: '', retired: false });
      });
    }

    if (btnGenerate) {
      btnGenerate.addEventListener('click', () => {
        const typecodes = [];
        const rows = typecodesTableBody.querySelectorAll('tr');
        
        rows.forEach(row => {
          const code = row.querySelector('.tc-code').value.trim();
          if (!code) return; // Skip empty codes
          
          typecodes.push({
            code,
            name: row.querySelector('.tc-name').value.trim(),
            desc: row.querySelector('.tc-desc').value.trim(),
            priority: row.querySelector('.tc-priority').value.trim(),
            category: row.querySelector('.tc-category').value.trim(),
            parent: row.querySelector('.tc-parent').value.trim(),
            retired: row.querySelector('.tc-retired').checked
          });
        });

        const xml = generateTypelistXml({
          name: listNameInput.value.trim(),
          desc: listDescInput.value.trim(),
          format: formatSelect.value,
          typecodes
        });

        rawXmlPre.textContent = xml;
        xmlOutputContainer.classList.remove('hidden');
      });
    }

    if (copyXmlBtn) {
      copyXmlBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(rawXmlPre.textContent).then(() => {
          const originalText = copyXmlBtn.textContent;
          copyXmlBtn.textContent = '✓ Copied!';
          setTimeout(() => {
            copyXmlBtn.textContent = originalText;
          }, 1500);
        });
      });
    }

    if (downloadXmlBtn) {
      downloadXmlBtn.addEventListener('click', () => {
        const ext = formatSelect.value;
        const filename = `${listNameInput.value.trim() || 'CustomTypelist'}.${ext}`;
        const blob = new Blob([rawXmlPre.textContent], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    function addTypecodeRow(data) {
      const row = document.createElement('tr');
      row.className = 'border-b border-slate-100 last:border-0 hover:bg-slate-50/50';

      row.innerHTML = `
        <td class="p-2"><input type="text" class="tc-code px-2 py-1 border rounded w-full font-mono text-xs" value="${escapeXmlValue(data.code)}" placeholder="e.g. bound" required /></td>
        <td class="p-2"><input type="text" class="tc-name px-2 py-1 border rounded w-full text-xs" value="${escapeXmlValue(data.name)}" placeholder="e.g. Bound" /></td>
        <td class="p-2"><input type="text" class="tc-desc px-2 py-1 border rounded w-full text-xs" value="${escapeXmlValue(data.desc)}" placeholder="Description" /></td>
        <td class="p-2" style="width: 70px;"><input type="number" class="tc-priority px-2 py-1 border rounded w-full text-xs font-mono" value="${data.priority || ''}" placeholder="1" /></td>
        <td class="p-2"><input type="text" class="tc-category px-2 py-1 border rounded w-full font-mono text-xs" value="${escapeXmlValue(data.category)}" placeholder="Category" /></td>
        <td class="p-2"><input type="text" class="tc-parent px-2 py-1 border rounded w-full font-mono text-xs" value="${escapeXmlValue(data.parent)}" placeholder="Parent Code" /></td>
        <td class="p-2 text-center" style="width: 50px;"><input type="checkbox" class="tc-retired" ${data.retired ? 'checked' : ''} /></td>
        <td class="p-2 text-center" style="width: 120px;">
          <div class="flex items-center justify-center gap-1.5">
            <button type="button" class="px-1.5 py-0.5 border bg-white hover:bg-slate-50 rounded text-[10px] font-bold text-slate-700 btn-move-up" title="Move Up">▲</button>
            <button type="button" class="px-1.5 py-0.5 border bg-white hover:bg-slate-50 rounded text-[10px] font-bold text-slate-700 btn-move-down" title="Move Down">▼</button>
            <button type="button" class="px-1.5 py-0.5 border border-red-200 bg-red-50 hover:bg-red-100 text-[10px] font-bold text-red-700 rounded btn-delete-row" title="Delete">✕</button>
          </div>
        </td>
      `;

      // Wire move/delete buttons
      row.querySelector('.btn-delete-row').addEventListener('click', () => {
        row.remove();
      });

      row.querySelector('.btn-move-up').addEventListener('click', () => {
        const prev = row.previousElementSibling;
        if (prev) {
          typecodesTableBody.insertBefore(row, prev);
        }
      });

      row.querySelector('.btn-move-down').addEventListener('click', () => {
        const next = row.nextElementSibling;
        if (next) {
          typecodesTableBody.insertBefore(next, row);
        }
      });

      typecodesTableBody.appendChild(row);
    }
  });
}
