/**
 * JSON / XML / Text Diff - Pure JS Offline Diff Engine & Helpers
 * Compatible with both browser environment and Node.js unit tests.
 */

/**
 * Recursively sorts keys of any JSON object to normalize it for comparison.
 */
export function sortJsonKeys(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortJsonKeys);
  }
  const sortedKeys = Object.keys(obj).sort();
  const result = {};
  for (const key of sortedKeys) {
    result[key] = sortJsonKeys(obj[key]);
  }
  return result;
}

/**
 * Normalizes a JSON string by sorting keys and pretty printing with 2 spaces.
 * Throws if JSON is invalid.
 */
export function normalizeJson(jsonText) {
  const parsed = JSON.parse(jsonText);
  const sorted = sortJsonKeys(parsed);
  return JSON.stringify(sorted, null, 2);
}

/**
 * Normalizes an XML/SOAP string by standardizing tags, spacing, and indentations.
 */
export function normalizeXml(xmlText) {
  // Normalize internal spacing of tags
  const cleanTags = xmlText.replace(/<([^>]+)>/g, (match, tagContents) => {
    return '<' + tagContents.replace(/\s+/g, ' ').trim() + '>';
  });

  const reg = /(>)\s*(<)(\/*)/g;
  const wspace = cleanTags.replace(reg, '$1\r\n$2$3');
  let formatted = '';
  let pad = 0;
  const lines = wspace.split('\r\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    let indent = 0;
    if (line.match(/.+<\/\w[^>]*>$/)) {
      indent = 0;
    } else if (line.match(/^<\/\w/)) {
      if (pad !== 0) {
        pad -= 1;
      }
    } else if (line.match(/^<\w[^>]*[^\/]>.*$/) && !line.startsWith('<?') && !line.startsWith('<!--')) {
      indent = 1;
    } else {
      indent = 0;
    }
    
    formatted += '  '.repeat(pad) + line + '\n';
    pad += indent;
  }
  return formatted.trim();
}

/**
 * High-performance line-by-line diff algorithm using LCS (Longest Common Subsequence).
 * Includes size guard to gracefully fall back to a fast linear diff on large inputs.
 */
export function computeLineDiff(oldLines, newLines) {
  const M = oldLines.length;
  const N = newLines.length;

  if (M > 2500 || N > 2500) {
    return computeSimpleDiff(oldLines, newLines);
  }

  const dp = Array.from({ length: M + 1 }, () => new Int32Array(N + 1));

  for (let i = 1; i <= M; i++) {
    for (let j = 1; j <= N; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let i = M;
  let j = N;
  const result = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({
        type: 'unchanged',
        oldLineNum: i,
        newLineNum: j,
        value: oldLines[i - 1]
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({
        type: 'added',
        oldLineNum: null,
        newLineNum: j,
        value: newLines[j - 1]
      });
      j--;
    } else {
      result.unshift({
        type: 'removed',
        oldLineNum: i,
        newLineNum: null,
        value: oldLines[i - 1]
      });
      i--;
    }
  }

  return result;
}

/**
 * Fallback O(N) simple diff for large inputs to avoid memory exhaustion or long freezes.
 */
export function computeSimpleDiff(oldLines, newLines) {
  const result = [];
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      result.push({
        type: 'unchanged',
        oldLineNum: i + 1,
        newLineNum: j + 1,
        value: oldLines[i]
      });
      i++;
      j++;
    } else if (j < newLines.length && (!oldSet.has(newLines[j]) || (i < oldLines.length && newSet.has(oldLines[i])))) {
      result.push({
        type: 'added',
        oldLineNum: null,
        newLineNum: j + 1,
        value: newLines[j]
      });
      j++;
    } else if (i < oldLines.length) {
      result.push({
        type: 'removed',
        oldLineNum: i + 1,
        newLineNum: null,
        value: oldLines[i]
      });
      i++;
    } else {
      break;
    }
  }

  return result;
}

/**
 * Main orchestrator of the diff operation.
 * Normalizes inputs based on auto-detected or manually specified mode.
 * Returns { mode, items, leftNormalized, rightNormalized, error }
 */
export function runDiff(leftText, rightText, modeSelection = 'auto') {
  let mode = modeSelection;
  let leftNormalized = leftText;
  let rightNormalized = rightText;
  let error = null;

  const leftTrim = leftText.trim();
  const rightTrim = rightText.trim();

  // Auto detect format
  if (modeSelection === 'auto') {
    if (leftTrim.startsWith('{') || leftTrim.startsWith('[') || rightTrim.startsWith('{') || rightTrim.startsWith('[')) {
      mode = 'json';
    } else if (leftTrim.startsWith('<') || rightTrim.startsWith('<')) {
      mode = 'xml';
    } else {
      mode = 'text';
    }
  }

  // Apply normalization
  if (mode === 'json') {
    try {
      if (leftText.trim() !== '') {
        leftNormalized = normalizeJson(leftText);
      }
    } catch (e) {
      error = `Left input is invalid JSON. Falling back to plain text comparison. (${e.message})`;
      leftNormalized = leftText;
      mode = 'text';
    }

    try {
      if (rightText.trim() !== '' && !error) {
        rightNormalized = normalizeJson(rightText);
      }
    } catch (e) {
      error = `Right input is invalid JSON. Falling back to plain text comparison. (${e.message})`;
      rightNormalized = rightText;
      mode = 'text';
    }
  } else if (mode === 'xml') {
    try {
      if (leftText.trim() !== '') {
        leftNormalized = normalizeXml(leftText);
      }
    } catch (e) {
      error = `Left input is invalid XML. Falling back to plain text comparison.`;
      leftNormalized = leftText;
      mode = 'text';
    }

    try {
      if (rightText.trim() !== '' && !error) {
        rightNormalized = normalizeXml(rightText);
      }
    } catch (e) {
      error = `Right input is invalid XML. Falling back to plain text comparison.`;
      rightNormalized = rightText;
      mode = 'text';
    }
  }

  const leftLines = leftNormalized.split(/\r?\n/);
  const rightLines = rightNormalized.split(/\r?\n/);

  const items = computeLineDiff(leftLines, rightLines);

  return {
    mode,
    items,
    leftNormalized,
    rightNormalized,
    error
  };
}

// UI Wiring
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const leftInput = document.getElementById('leftInput');
    const rightInput = document.getElementById('rightInput');
    const diffModeSelect = document.getElementById('diffModeSelect');
    const compareBtn = document.getElementById('compareBtn');
    const clearBtn = document.getElementById('clearBtn');
    const toggleSplitBtn = document.getElementById('toggleSplitBtn');
    const toggleUnifiedBtn = document.getElementById('toggleUnifiedBtn');
    const warningBanner = document.getElementById('warningBanner');
    const resultsPanel = document.getElementById('resultsPanel');
    const splitView = document.getElementById('splitView');
    const unifiedView = document.getElementById('unifiedView');
    const loadJsonSampleBtn = document.getElementById('loadJsonSampleBtn');
    const loadXmlSampleBtn = document.getElementById('loadXmlSampleBtn');
    const statSummary = document.getElementById('statSummary');

    let currentDiffResult = null;
    let viewMode = 'split'; // split or unified

    if (loadJsonSampleBtn) {
      loadJsonSampleBtn.addEventListener('click', () => {
        leftInput.value = `{\n  "name": "Guidewire Software",\n  "version": "10.0.1",\n  "modules": ["ClaimCenter", "PolicyCenter"],\n  "active": true\n}`;
        rightInput.value = `{\n  "active": true,\n  "name": "Guidewire Software",\n  "modules": ["ClaimCenter", "PolicyCenter", "BillingCenter"],\n  "version": "10.0.2"\n}`;
        diffModeSelect.value = 'json';
        compareBtn.click();
      });
    }

    if (loadXmlSampleBtn) {
      loadXmlSampleBtn.addEventListener('click', () => {
        leftInput.value = `<PCFElement   type="Card"   id="PolicyInfoCard"  >\n   <CardView>\n      <DetailViewInput   id="PolicyPeriod"   value="PolicyPeriod"   />\n      <ButtonInput id="EditButton" action="edit()" />\n   </CardView>\n</PCFElement>`;
        rightInput.value = `<PCFElement type="Card" id="PolicyInfoCard">\n  <CardView>\n    <DetailViewInput id="PolicyPeriod" value="PolicyPeriod" />\n    <ButtonInput id="EditButton" action="modify()" />\n    <ButtonInput id="CancelButton" action="cancel()" />\n  </CardView>\n</PCFElement>`;
        diffModeSelect.value = 'xml';
        compareBtn.click();
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        leftInput.value = '';
        rightInput.value = '';
        resultsPanel.classList.add('hidden');
        warningBanner.classList.add('hidden');
        currentDiffResult = null;
      });
    }

    if (compareBtn) {
      compareBtn.addEventListener('click', () => {
        const leftText = leftInput.value;
        const rightText = rightInput.value;

        if (leftText === '' && rightText === '') {
          resultsPanel.classList.add('hidden');
          warningBanner.classList.add('hidden');
          return;
        }

        compareBtn.disabled = true;
        compareBtn.textContent = 'Comparing...';
        warningBanner.classList.add('hidden');

        try {
          const res = runDiff(leftText, rightText, diffModeSelect.value);
          currentDiffResult = res;

          if (res.error) {
            warningBanner.classList.remove('hidden');
            warningBanner.textContent = res.error;
          }

          // Calculate counts
          let addedCount = 0;
          let removedCount = 0;
          let unchangedCount = 0;

          res.items.forEach(item => {
            if (item.type === 'added') addedCount++;
            else if (item.type === 'removed') removedCount++;
            else unchangedCount++;
          });

          statSummary.innerHTML = `
            <span class="px-2 py-1 rounded bg-slate-100 border text-slate-700 font-semibold text-xs uppercase">${res.mode} Mode</span>
            <span class="px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 font-semibold text-xs">+ ${addedCount} Additions</span>
            <span class="px-2 py-1 rounded bg-rose-50 border border-rose-200 text-rose-800 font-semibold text-xs">- ${removedCount} Deletions</span>
            <span class="text-xs text-slate-500 font-medium">${unchangedCount} Identical Lines</span>
          `;

          renderDiffOutput();
          resultsPanel.classList.remove('hidden');

        } catch (err) {
          warningBanner.classList.remove('hidden');
          warningBanner.textContent = `Diff calculation error: ${err.message}`;
        } finally {
          compareBtn.disabled = false;
          compareBtn.textContent = 'Compare Inputs';
        }
      });
    }

    if (toggleSplitBtn) {
      toggleSplitBtn.addEventListener('click', () => {
        viewMode = 'split';
        toggleSplitBtn.classList.add('bg-slate-900', 'text-white');
        toggleSplitBtn.classList.remove('bg-white', 'text-slate-700');
        toggleUnifiedBtn.classList.add('bg-white', 'text-slate-700');
        toggleUnifiedBtn.classList.remove('bg-slate-900', 'text-white');
        renderDiffOutput();
      });
    }

    if (toggleUnifiedBtn) {
      toggleUnifiedBtn.addEventListener('click', () => {
        viewMode = 'unified';
        toggleUnifiedBtn.classList.add('bg-slate-900', 'text-white');
        toggleUnifiedBtn.classList.remove('bg-white', 'text-slate-700');
        toggleSplitBtn.classList.add('bg-white', 'text-slate-700');
        toggleSplitBtn.classList.remove('bg-slate-900', 'text-white');
        renderDiffOutput();
      });
    }

    function renderDiffOutput() {
      if (!currentDiffResult) return;

      if (viewMode === 'split') {
        splitView.classList.remove('hidden');
        unifiedView.classList.add('hidden');
        renderSplitDiff();
      } else {
        unifiedView.classList.remove('hidden');
        splitView.classList.add('hidden');
        renderUnifiedDiff();
      }
    }

    function renderSplitDiff() {
      const leftCol = splitView.querySelector('#leftDiffCol');
      const rightCol = splitView.querySelector('#rightDiffCol');

      leftCol.innerHTML = '';
      rightCol.innerHTML = '';

      currentDiffResult.items.forEach(item => {
        const leftLineEl = document.createElement('div');
        const rightLineEl = document.createElement('div');

        leftLineEl.className = 'font-mono text-xs flex border-b border-slate-100 min-h-[22px]';
        rightLineEl.className = 'font-mono text-xs flex border-b border-slate-100 min-h-[22px]';

        if (item.type === 'unchanged') {
          leftLineEl.innerHTML = `
            <span class="w-10 text-right pr-2 text-slate-400 select-none border-r border-slate-200 shrink-0 font-semibold">${item.oldLineNum}</span>
            <span class="pl-3 text-slate-800 whitespace-pre">${escapeHtml(item.value)}</span>
          `;
          rightLineEl.innerHTML = `
            <span class="w-10 text-right pr-2 text-slate-400 select-none border-r border-slate-200 shrink-0 font-semibold">${item.newLineNum}</span>
            <span class="pl-3 text-slate-800 whitespace-pre">${escapeHtml(item.value)}</span>
          `;
        } else if (item.type === 'removed') {
          leftLineEl.className += ' bg-rose-50 border-rose-100 text-rose-900';
          leftLineEl.innerHTML = `
            <span class="w-10 text-right pr-2 text-rose-400 select-none border-r border-rose-200 shrink-0 font-semibold bg-rose-100/50">${item.oldLineNum}</span>
            <span class="pl-3 whitespace-pre font-bold">${escapeHtml(item.value)}</span>
          `;
          // Placeholder right
          rightLineEl.className += ' bg-slate-50/50 select-none';
          rightLineEl.innerHTML = `
            <span class="w-10 border-r border-slate-200 shrink-0 bg-slate-100/30"></span>
            <span class="pl-3 text-slate-300 whitespace-pre italic"></span>
          `;
        } else if (item.type === 'added') {
          // Placeholder left
          leftLineEl.className += ' bg-slate-50/50 select-none';
          leftLineEl.innerHTML = `
            <span class="w-10 border-r border-slate-200 shrink-0 bg-slate-100/30"></span>
            <span class="pl-3 text-slate-300 whitespace-pre italic"></span>
          `;

          rightLineEl.className += ' bg-emerald-50 border-emerald-100 text-emerald-900';
          rightLineEl.innerHTML = `
            <span class="w-10 text-right pr-2 text-emerald-400 select-none border-r border-emerald-200 shrink-0 font-semibold bg-emerald-100/50">${item.newLineNum}</span>
            <span class="pl-3 whitespace-pre font-bold">${escapeHtml(item.value)}</span>
          `;
        }

        leftCol.appendChild(leftLineEl);
        rightCol.appendChild(rightLineEl);
      });
    }

    function renderUnifiedDiff() {
      unifiedView.innerHTML = '';

      currentDiffResult.items.forEach(item => {
        const lineEl = document.createElement('div');
        lineEl.className = 'font-mono text-xs flex border-b border-slate-100 min-h-[22px]';

        if (item.type === 'unchanged') {
          lineEl.innerHTML = `
            <span class="w-10 text-right pr-2 text-slate-400 select-none border-r border-slate-200 shrink-0 font-semibold">${item.oldLineNum}</span>
            <span class="w-10 text-right pr-2 text-slate-400 select-none border-r border-slate-200 shrink-0 font-semibold">${item.newLineNum}</span>
            <span class="pl-4 text-slate-500 select-none shrink-0 border-r border-slate-200 w-6 font-bold"> </span>
            <span class="pl-3 text-slate-800 whitespace-pre">${escapeHtml(item.value)}</span>
          `;
        } else if (item.type === 'removed') {
          lineEl.className += ' bg-rose-50 border-rose-100 text-rose-900';
          lineEl.innerHTML = `
            <span class="w-10 text-right pr-2 text-rose-400 select-none border-r border-rose-200 shrink-0 font-semibold bg-rose-100/50">${item.oldLineNum}</span>
            <span class="w-10 border-r border-slate-200 shrink-0 bg-rose-100/30"></span>
            <span class="pl-4 text-rose-600 select-none shrink-0 border-r border-rose-200 w-6 font-extrabold">-</span>
            <span class="pl-3 whitespace-pre font-bold">${escapeHtml(item.value)}</span>
          `;
        } else if (item.type === 'added') {
          lineEl.className += ' bg-emerald-50 border-emerald-100 text-emerald-900';
          lineEl.innerHTML = `
            <span class="w-10 border-r border-slate-200 shrink-0 bg-emerald-100/30"></span>
            <span class="w-10 text-right pr-2 text-emerald-400 select-none border-r border-emerald-200 shrink-0 font-semibold bg-emerald-100/50">${item.newLineNum}</span>
            <span class="pl-4 text-emerald-600 select-none shrink-0 border-r border-slate-200 w-6 font-extrabold">+</span>
            <span class="pl-3 whitespace-pre font-bold">${escapeHtml(item.value)}</span>
          `;
        }

        unifiedView.appendChild(lineEl);
      });
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
