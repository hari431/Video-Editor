/**
 * CSV / TSV Analyzer - Pure JS Offline Parser & Analyzer Engine
 * RFC-4180 compliant, handles escaped quotes, multi-line cells and delimiters cleanly.
 * Works uniformly in Browser and Node.js unit tests.
 */

/**
 * RFC-4180 Compliant CSV/TSV Parser.
 */
export function parseCsvPure(text, delimiter = ',') {
  if (!text) return [];

  const rows = [];
  let row = [];
  let col = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          col += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        col += char;
        i++;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
      } else if (char === delimiter) {
        row.push(col);
        col = '';
        i++;
      } else if (char === '\r' || char === '\n') {
        row.push(col);
        col = '';
        if (char === '\r' && nextChar === '\n') {
          i += 2;
        } else {
          i++;
        }
        rows.push(row);
        row = [];
      } else {
        col += char;
        i++;
      }
    }
  }

  if (col !== '' || row.length > 0) {
    row.push(col);
    rows.push(row);
  }

  // Remove trailing completely blank final row
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop();
  }

  return rows;
}

/**
 * Delimiter auto-detector based on density scoring in the header row.
 */
export function detectDelimiter(text) {
  if (!text) return ',';
  const firstLine = text.split(/\r?\n/)[0] || '';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;

  if (tabCount > commaCount && tabCount > semicolonCount) return '\t';
  if (semicolonCount > commaCount && semicolonCount > tabCount) return ';';
  return ',';
}

/**
 * Performs deep audit analytics on parsed array rows.
 */
export function analyzeCsvData(rows) {
  if (rows.length === 0) {
    return {
      headers: [],
      rowCount: 0,
      colCount: 0,
      duplicateHeaders: [],
      inconsistentRows: [],
      emptyColumns: [],
      malformedRows: []
    };
  }

  const headers = rows[0] || [];
  const colCount = headers.length;
  const rowCount = rows.length - 1;

  // 1. Find Duplicate Headers
  const dupMap = {};
  const duplicateHeaders = [];
  headers.forEach((h, idx) => {
    const cleanHeader = h.trim();
    if (!cleanHeader) return;
    dupMap[cleanHeader] = (dupMap[cleanHeader] || 0) + 1;
    if (dupMap[cleanHeader] === 2) {
      duplicateHeaders.push(cleanHeader);
    }
  });

  // 2. Scan for inconsistent row lengths & empty columns
  const inconsistentRows = [];
  const columnEmptyTracker = Array(colCount).fill(true);

  for (let r = 1; r < rows.length; r++) {
    const currRow = rows[r];
    if (currRow.length !== colCount) {
      inconsistentRows.push({ rowIndex: r, got: currRow.length, expected: colCount });
    }
    
    // Check cell emptyness for each column
    for (let c = 0; r < rows.length && c < currRow.length && c < colCount; c++) {
      if (currRow[c] !== undefined && currRow[c].trim() !== '') {
        columnEmptyTracker[c] = false;
      }
    }
  }

  // Map true empty columns to their header names
  const emptyColumns = [];
  columnEmptyTracker.forEach((isEmpty, idx) => {
    if (isEmpty) {
      emptyColumns.push(headers[idx] || `Column ${idx + 1}`);
    }
  });

  return {
    headers,
    rowCount,
    colCount,
    duplicateHeaders,
    inconsistentRows,
    emptyColumns
  };
}

// UI Wiring
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const csvInput = document.getElementById('csvInput');
    const delimiterSelect = document.getElementById('delimiterSelect');
    const fileInput = document.getElementById('csvFileInput');
    const analyzeBtn = document.getElementById('analyzeBtn');
    const clearBtn = document.getElementById('clearBtn');
    const loadSampleBtn = document.getElementById('loadSampleBtn');
    const resultsPanel = document.getElementById('resultsPanel');
    const errorContainer = document.getElementById('errorContainer');
    const filterInput = document.getElementById('tableFilterInput');

    const statRows = document.getElementById('statRows');
    const statCols = document.getElementById('statCols');
    const auditAlertsContainer = document.getElementById('auditAlertsContainer');
    const tableHeader = document.getElementById('tableHeader');
    const tableBody = document.getElementById('tableBody');

    let currentParsedRows = [];

    const sampleCsv = `ClaimNumber,PolicyNumber,InsuredName,ClaimStatus,ClaimantAge,ReserveAmount,Notes\nCC-982314,PC-102914,"Harichandana, Hari",Open,28,4500.00,"Double quotes inside works ""perfectly""."\nCC-552312,PC-882314,"Gosu Expert",Open,45,12000.00,No issues found.\nCC-112314,PC-102914,"John Doe",Closed,34,0.00,"Closed, paid in full."\nCC-998811,PC-991244,"Jane Doe",Open,,250.00,Empty age test.`;

    if (loadSampleBtn) {
      loadSampleBtn.addEventListener('click', () => {
        csvInput.value = sampleCsv;
        delimiterSelect.value = 'auto';
        analyzeBtn.click();
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        csvInput.value = '';
        fileInput.value = '';
        resultsPanel.classList.add('hidden');
        errorContainer.classList.add('hidden');
        currentParsedRows = [];
      });
    }

    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const file = fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(evt) {
          csvInput.value = evt.target.result;
          analyzeBtn.click();
        };
        reader.readAsText(file);
      });
    }

    if (analyzeBtn) {
      analyzeBtn.addEventListener('click', () => {
        const text = csvInput.value;
        if (!text || !text.trim()) {
          showError('Please paste content or select a CSV/TSV file first.');
          return;
        }

        errorContainer.classList.add('hidden');
        resultsPanel.classList.add('hidden');

        try {
          let delim = delimiterSelect.value;
          if (delim === 'auto') {
            delim = detectDelimiter(text);
          }

          const parsed = parseCsvPure(text, delim);
          currentParsedRows = parsed;

          if (parsed.length === 0) {
            throw new Error('Empty or un-parsable data format provided.');
          }

          const analysis = analyzeCsvData(parsed);

          // Populate stats
          statRows.textContent = analysis.rowCount;
          statCols.textContent = analysis.colCount;

          // Populate audits list
          auditAlertsContainer.innerHTML = '';
          const alerts = [];

          if (analysis.duplicateHeaders.length > 0) {
            alerts.push(`<div class="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-3 text-xs">⚠️ <strong>Duplicate Headers Found:</strong> ${analysis.duplicateHeaders.join(', ')}</div>`);
          }
          if (analysis.inconsistentRows.length > 0) {
            alerts.push(`<div class="bg-red-50 border border-red-200 text-red-900 rounded-lg p-3 text-xs">❌ <strong>Inconsistent Row Lengths:</strong> Detected ${analysis.inconsistentRows.length} rows with mismatched field counts. (e.g. Row ${analysis.inconsistentRows[0].rowIndex} has ${analysis.inconsistentRows[0].got} columns instead of ${analysis.inconsistentRows[0].expected})</div>`);
          }
          if (analysis.emptyColumns.length > 0) {
            alerts.push(`<div class="bg-slate-50 border border-slate-200 text-slate-700 rounded-lg p-3 text-xs">ℹ️ <strong>Fully Empty Columns:</strong> ${analysis.emptyColumns.join(', ')}</div>`);
          }

          if (alerts.length === 0) {
            auditAlertsContainer.innerHTML = '<div class="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg p-3 text-xs">✓ <strong>No Structural Anomalies:</strong> CSV matches consistent header length, contains zero duplicates, and has no missing column definitions!</div>';
          } else {
            alerts.forEach(html => {
              auditAlertsContainer.innerHTML += html;
            });
          }

          // Render Table Header
          tableHeader.innerHTML = '';
          const trHeader = document.createElement('tr');
          trHeader.className = 'bg-slate-100 border-b border-slate-200 text-[10px] text-slate-500 uppercase tracking-wider font-bold';
          analysis.headers.forEach(h => {
            const th = document.createElement('th');
            th.className = 'p-3 font-semibold';
            th.textContent = h || 'Unnamed Column';
            trHeader.appendChild(th);
          });
          tableHeader.appendChild(trHeader);

          // Render Table Body Rows (cap preview at first 100 rows for high speed performance)
          renderTableRows();

          resultsPanel.classList.remove('hidden');

        } catch (err) {
          showError(err.message || 'Unable to parse CSV structure.');
        }
      });
    }

    if (filterInput) {
      filterInput.addEventListener('input', () => {
        renderTableRows();
      });
    }

    function renderTableRows() {
      if (currentParsedRows.length <= 1) return;
      tableBody.innerHTML = '';

      const query = filterInput.value.toLowerCase().trim();
      const headers = currentParsedRows[0];
      const dataRows = currentParsedRows.slice(1);

      let renderedCount = 0;

      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        
        // Filter rows by query
        if (query) {
          const rowText = row.join(' ').toLowerCase();
          if (!rowText.includes(query)) continue;
        }

        const tr = document.createElement('tr');
        tr.className = 'border-b border-slate-100 last:border-0 hover:bg-slate-50/40 text-xs text-slate-700';

        // Check if this row is malformed compared to header count
        const isMalformed = row.length !== headers.length;
        if (isMalformed) {
          tr.className += ' bg-red-50/50 text-red-900';
        }

        for (let j = 0; j < headers.length; j++) {
          const td = document.createElement('td');
          td.className = 'p-3 whitespace-nowrap overflow-hidden max-w-xs truncate';
          td.textContent = row[j] !== undefined ? row[j] : '';
          tr.appendChild(td);
        }

        tableBody.appendChild(tr);
        renderedCount++;

        // Stop rendering if preview exceeds 100 rows
        if (renderedCount >= 100) {
          const trWarning = document.createElement('tr');
          trWarning.className = 'bg-slate-50 text-center font-semibold text-slate-500 text-[11px]';
          trWarning.innerHTML = `<td colspan="${headers.length}" class="p-3">Showing first 100 rows. Use local filter above to search matching contents.</td>`;
          tableBody.appendChild(trWarning);
          break;
        }
      }

      if (renderedCount === 0) {
        tableBody.innerHTML = `<tr><td colspan="${headers.length}" class="p-8 text-center text-slate-400 italic">No rows matching current search query.</td></tr>`;
      }
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
