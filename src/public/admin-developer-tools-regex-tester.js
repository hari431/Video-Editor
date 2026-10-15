/**
 * JS-Based Regex Tester Engine & Client-side wiring
 * Offline-capable, fully sandboxed in-browser.
 */

export function runRegexTest(pattern, text, flags, replacement = '') {
  if (!pattern) {
    return { success: false, matches: [], replacedText: text };
  }

  try {
    const regex = new RegExp(pattern, flags);
    
    // Find all matches
    const matches = [];
    let match;

    if (flags.includes('g')) {
      // For global, we loop using exec
      regex.lastIndex = 0; // reset
      let prevLastIndex = -1;

      while ((match = regex.exec(text)) !== null) {
        // Prevent infinite loops on zero-width matches
        if (regex.lastIndex === prevLastIndex) {
          regex.lastIndex++;
          continue;
        }
        prevLastIndex = regex.lastIndex;

        matches.push({
          text: match[0],
          index: match.index,
          groups: match.slice(1) // capture groups
        });
      }
    } else {
      // Single match
      match = regex.exec(text);
      if (match) {
        matches.push({
          text: match[0],
          index: match.index,
          groups: match.slice(1)
        });
      }
    }

    // Compute replacement preview
    let replacedText = '';
    try {
      replacedText = text.replace(regex, replacement);
    } catch (e) {
      replacedText = 'Replacement error: ' + e.message;
    }

    return {
      success: true,
      matches,
      replacedText
    };

  } catch (err) {
    return {
      success: false,
      error: err.message,
      matches: [],
      replacedText: text
    };
  }
}

// UI Wiring
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const regexPatternInput = document.getElementById('regexPatternInput');
    const regexFlagsInput = document.getElementById('regexFlagsInput');
    const regexTestTextInput = document.getElementById('regexTestTextInput');
    const regexReplaceInput = document.getElementById('regexReplaceInput');
    
    const btnTestRegex = document.getElementById('btnTestRegex');
    const btnLoadSample = document.getElementById('btnLoadSample');
    const btnClearAll = document.getElementById('btnClearAll');

    const errorContainer = document.getElementById('errorContainer');
    const resultsPanel = document.getElementById('resultsPanel');
    const matchCountStat = document.getElementById('matchCountStat');
    const highlightedPreview = document.getElementById('highlightedPreview');
    const replacedPreviewPre = document.getElementById('replacedPreviewPre');
    const captureGroupsContainer = document.getElementById('captureGroupsContainer');

    const samplePattern = '(?<prefix>cc|pc)-(?<id>\\d{6})';
    const sampleText = 'The PolicyCenter transaction number is pc-102944.\\nYesterday, the ClaimCenter claim number cc-982314 was filed successfully.\\nBe sure to check both prefix codes.';
    const sampleReplace = 'GW_SYSTEM: $<id>';

    if (btnLoadSample) {
      btnLoadSample.addEventListener('click', () => {
        regexPatternInput.value = samplePattern;
        regexFlagsInput.value = 'gi';
        regexTestTextInput.value = sampleText.replace(/\\n/g, '\n');
        regexReplaceInput.value = sampleReplace;
        btnTestRegex.click();
      });
    }

    if (btnClearAll) {
      btnClearAll.addEventListener('click', () => {
        regexPatternInput.value = '';
        regexFlagsInput.value = 'g';
        regexTestTextInput.value = '';
        regexReplaceInput.value = '';
        errorContainer.classList.add('hidden');
        resultsPanel.classList.add('hidden');
      });
    }

    if (btnTestRegex) {
      btnTestRegex.addEventListener('click', () => {
        const pattern = regexPatternInput.value.trim();
        const text = regexTestTextInput.value;
        const flags = regexFlagsInput.value.trim();
        const replacement = regexReplaceInput.value;

        errorContainer.classList.add('hidden');
        resultsPanel.classList.add('hidden');

        if (!pattern) {
          showError('Please specify a valid RegExp pattern.');
          return;
        }

        const res = runRegexTest(pattern, text, flags, replacement);
        if (!res.success) {
          showError(`RegExp compilation error: ${res.error}`);
          return;
        }

        matchCountStat.textContent = res.matches.length;
        replacedPreviewPre.textContent = res.replacedText;

        // Render Highlighted HTML
        highlightedPreview.innerHTML = renderHighlightedText(text, pattern, flags);

        // Render Capture Groups Table
        captureGroupsContainer.innerHTML = '';
        if (res.matches.length === 0) {
          captureGroupsContainer.innerHTML = '<div class="text-xs text-slate-400 italic p-3">No matching captures found.</div>';
        } else {
          const table = document.createElement('table');
          table.className = 'w-full text-left border-collapse text-xs mt-2';
          table.innerHTML = `
            <thead>
              <tr class="bg-slate-100 border-b border-slate-200 text-slate-500 uppercase tracking-wider font-bold">
                <th class="p-2 w-16">Match #</th>
                <th class="p-2">Whole Match</th>
                <th class="p-2">Captured Groups</th>
              </tr>
            </thead>
            <tbody></tbody>
          `;
          const tbody = table.querySelector('tbody');
          res.matches.forEach((m, idx) => {
            const tr = document.createElement('tr');
            tr.className = 'border-b border-slate-100 hover:bg-slate-50/50';
            
            const groupList = m.groups.length > 0
              ? m.groups.map((g, gi) => `<span class="bg-indigo-50 border border-indigo-100 text-indigo-700 font-bold px-1.5 py-0.5 rounded font-mono block mb-1">Group ${gi + 1}: "${escapeHtml(g)}"</span>`).join('')
              : '<span class="text-slate-400 italic">None</span>';

            tr.innerHTML = `
              <td class="p-2 font-bold font-mono text-slate-400">#${idx + 1}</td>
              <td class="p-2 font-mono text-slate-800 font-semibold break-all select-all">"${escapeHtml(m.text)}"</td>
              <td class="p-2">${groupList}</td>
            `;
            tbody.appendChild(tr);
          });
          captureGroupsContainer.appendChild(table);
        }

        resultsPanel.classList.remove('hidden');
      });
    }

    function renderHighlightedText(text, pattern, flags) {
      try {
        // Safe regex highlighter using matching indices
        const regex = new RegExp(pattern, flags);
        if (!flags.includes('g')) {
          // If not global, highlight first match
          const match = regex.exec(text);
          if (match) {
            const start = match.index;
            const end = start + match[0].length;
            return escapeHtml(text.substring(0, start)) + 
              `<mark class="bg-yellow-300 text-slate-900 font-bold px-0.5 rounded font-mono select-all">${escapeHtml(match[0])}</mark>` + 
              escapeHtml(text.substring(end));
          }
          return escapeHtml(text);
        }

        regex.lastIndex = 0;
        let highlighted = '';
        let lastIdx = 0;
        let match;
        let prevLastIdx = -1;

        while ((match = regex.exec(text)) !== null) {
          if (regex.lastIndex === prevLastIdx) {
            regex.lastIndex++;
            continue;
          }
          prevLastIdx = regex.lastIndex;

          const start = match.index;
          highlighted += escapeHtml(text.substring(lastIdx, start));
          highlighted += `<mark class="bg-yellow-300 text-slate-900 font-bold px-0.5 rounded font-mono select-all">${escapeHtml(match[0])}</mark>`;
          lastIdx = start + match[0].length;
        }

        highlighted += escapeHtml(text.substring(lastIdx));
        return highlighted;

      } catch (e) {
        return escapeHtml(text);
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
