/**
 * Guidewire SQL Log Parameter Stitcher - Client Side Handler
 * Fully offline, parses parameters and replaces ? in SQL statements safely.
 */

// Simple SQL placeholder scanner that skips comments and string literals
export function findPlaceholders(sql) {
  const positions = [];
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const nextChar = sql[i + 1];
    
    if (inLineComment) {
      if (char === '\n' || char === '\r') {
        inLineComment = false;
      }
      continue;
    }
    
    if (inBlockComment) {
      if (char === '*' && nextChar === '/') {
        inBlockComment = false;
        i++; // skip '/'
      }
      continue;
    }
    
    if (inSingleQuote) {
      if (char === '\\') {
        i++; // skip escaped char
      } else if (char === "'") {
        if (nextChar === "'") {
          i++; // skip escaped quote in SQL format
        } else {
          inSingleQuote = false;
        }
      }
      continue;
    }
    
    if (inDoubleQuote) {
      if (char === '\\') {
        i++; // skip escaped char
      } else if (char === '"') {
        inDoubleQuote = false;
      }
      continue;
    }
    
    // Check start of comments
    if (char === '-' && nextChar === '-') {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === '/' && nextChar === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    
    // Check start of quotes
    if (char === "'") {
      inSingleQuote = true;
      continue;
    }
    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }
    
    // Check placeholder
    if (char === '?') {
      positions.push(i);
    }
  }
  return positions;
}

export function parseParameters(paramStr) {
  // Regex matches: [Param: 1, Type: varchar, Value: 'value'] or [Param: 2, Value: 12]
  const regex = /\[Param:\s*(\d+)([\s\S]*?)\]/gi;
  const params = [];
  let match;
  
  while ((match = regex.exec(paramStr)) !== null) {
    const index = parseInt(match[1], 10);
    const content = match[2];
    
    const typeMatch = content.match(/\bType:\s*([^,\]]+)/i);
    const valueMatch = content.match(/\bValue:\s*([\s\S]*)$/i);
    
    const type = typeMatch ? typeMatch[1].trim() : '';
    let value = valueMatch ? valueMatch[1].trim() : '';
    
    params.push({
      index,
      type,
      value
    });
  }
  
  params.sort((a, b) => a.index - b.index);
  return params;
}

export function formatValue(val, type) {
  if (val === undefined || val === null) return 'NULL';
  const trimmed = val.trim();
  
  // check if null/NULL
  if (trimmed.toLowerCase() === 'null') {
    return 'NULL';
  }
  
  // if already single or double quoted, keep as is
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed;
  }
  
  const lowerType = (type || '').toLowerCase();
  
  const isStringType = lowerType.includes('char') || 
                       lowerType.includes('string') || 
                       lowerType.includes('date') || 
                       lowerType.includes('time') || 
                       lowerType.includes('text') ||
                       lowerType.includes('clob') ||
                       lowerType.includes('uuid') ||
                       lowerType.includes('blob');
                       
  if (isStringType) {
    const escaped = trimmed.replace(/'/g, "''");
    return `'${escaped}'`;
  }
  
  // Check booleans
  if (lowerType === 'bit' || lowerType === 'boolean' || lowerType === 'bool') {
    if (trimmed === '1' || trimmed.toLowerCase() === 'true') {
      return 'TRUE';
    }
    if (trimmed === '0' || trimmed.toLowerCase() === 'false') {
      return 'FALSE';
    }
    return trimmed.toUpperCase();
  }
  
  // Fallback: Numeric patterns
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }
  
  // Boolean fallback
  if (trimmed.toLowerCase() === 'true' || trimmed.toLowerCase() === 'false') {
    return trimmed.toUpperCase();
  }
  
  // General string fallback if it isn't clearly numeric
  const escaped = trimmed.replace(/'/g, "''");
  return `'${escaped}'`;
}

export function parseLogs(rawText) {
  const lines = rawText.split(/\r?\n/);
  const blocks = [];
  
  let currentSql = '';
  let currentSqlRawLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    // Check if line contains parameter specs
    const paramIndex = trimmed.indexOf('[Param:');
    const parametersKeywordIndex = trimmed.toLowerCase().indexOf('parameters:');
    
    if (paramIndex !== -1 || parametersKeywordIndex !== -1) {
      const paramPart = paramIndex !== -1 ? trimmed.substring(paramIndex) : trimmed.substring(parametersKeywordIndex);
      
      if (currentSql) {
        blocks.push({
          sql: currentSql.trim(),
          rawLines: [...currentSqlRawLines, line],
          paramStr: paramPart,
          paramsParsed: parseParameters(paramPart)
        });
        currentSql = '';
        currentSqlRawLines = [];
      } else {
        blocks.push({
          sql: '',
          rawLines: [line],
          paramStr: paramPart,
          paramsParsed: parseParameters(paramPart)
        });
      }
      continue;
    }
    
    // Check if line contains a standard SQL keyword (ignoring leading metadata or timestamp)
    const sqlMatch = trimmed.match(/\b(SELECT|INSERT|UPDATE|DELETE|WITH|MERGE|CREATE|DROP|ALTER)\b/i);
    
    if (sqlMatch) {
      if (currentSql) {
        blocks.push({
          sql: currentSql.trim(),
          rawLines: currentSqlRawLines,
          paramStr: '',
          paramsParsed: []
        });
      }
      
      const keywordIdx = sqlMatch.index;
      currentSql = trimmed.substring(keywordIdx);
      currentSqlRawLines = [line];
    } else if (currentSql) {
      currentSql += '\n' + trimmed;
      currentSqlRawLines.push(line);
    }
  }
  
  if (currentSql) {
    blocks.push({
      sql: currentSql.trim(),
      rawLines: currentSqlRawLines,
      paramStr: '',
      paramsParsed: []
    });
  }
  
  return blocks;
}

export function stitchBlock(block) {
  const { sql, paramsParsed } = block;
  if (!sql) {
    return {
      stitchedSql: '',
      error: 'No SQL query found to associate with these parameters.'
    };
  }
  
  const placeholders = findPlaceholders(sql);
  
  if (placeholders.length === 0) {
    return {
      stitchedSql: sql,
      warning: 'No "?" placeholders found in this SQL statement.'
    };
  }
  
  const paramMap = {};
  paramsParsed.forEach(p => {
    paramMap[p.index] = p;
  });
  
  let result = '';
  let lastIndex = 0;
  const warnings = [];
  
  for (let i = 0; i < placeholders.length; i++) {
    const pos = placeholders[i];
    result += sql.substring(lastIndex, pos);
    
    const paramNum = i + 1;
    const param = paramMap[paramNum];
    
    if (param) {
      result += formatValue(param.value, param.type);
    } else {
      result += `/* MISSING: Param ${paramNum} */ ?`;
      warnings.push(`Parameter ${paramNum} is missing.`);
    }
    
    lastIndex = pos + 1;
  }
  
  result += sql.substring(lastIndex);
  
  if (paramsParsed.length > placeholders.length) {
    warnings.push(`Pasted log has ${paramsParsed.length} parameters, but SQL statement only has ${placeholders.length} placeholders.`);
  }
  
  return {
    stitchedSql: result,
    warnings: warnings.length > 0 ? warnings : null
  };
}

// UI wiring
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const rawLogsInput = document.getElementById('rawLogsInput');
    const stitchBtn = document.getElementById('stitchBtn');
    const clearBtn = document.getElementById('clearBtn');
    const loadExampleBtn = document.getElementById('loadExampleBtn');
    const resultsWrapper = document.getElementById('resultsWrapper');
    const statementCount = document.getElementById('statementCount');
    const statusMessage = document.getElementById('statusMessage');
    const statementsList = document.getElementById('statementsList');
    const copyAllBtn = document.getElementById('copyAllBtn');

    if (!rawLogsInput || !stitchBtn) return;

    const exampleLog = `10:15:30.123 DEBUG [gw.database.Query] SELECT p.ID, p.PolicyNumber, p.PeriodStart, p.PeriodEnd FROM pc_policyperiod p WHERE p.Status = ? AND p.PeriodStart >= ? AND p.ArchivePartition IS ?
10:15:30.124 DEBUG [gw.database.Query] Parameters: [Param: 1, Type: varchar, Value: 'Bound'], [Param: 2, Type: datetime, Value: '2026-01-01 00:00:00.000'], [Param: 3, Type: integer, Value: null]

10:15:31.450 DEBUG [gw.database.Query] UPDATE pc_policyperiod SET Status = ?, Terminated = ? WHERE ID = ?
10:15:31.451 DEBUG [gw.database.Query] Parameters: [Param: 1, Type: varchar, Value: 'Rescinded'], [Param: 2, Type: bit, Value: 1], [Param: 3, Type: varchar, Value: 'pc:99812']`;

    loadExampleBtn.addEventListener('click', () => {
      rawLogsInput.value = exampleLog;
      resultsWrapper.style.display = 'none';
      statementsList.innerHTML = '';
    });

  clearBtn.addEventListener('click', () => {
    rawLogsInput.value = '';
    resultsWrapper.style.display = 'none';
    statementsList.innerHTML = '';
    statusMessage.style.display = 'none';
  });

  copyAllBtn.addEventListener('click', () => {
    const copyBlocks = document.querySelectorAll('.stitched-sql-pre');
    if (copyBlocks.length === 0) return;
    
    const combinedSql = Array.from(copyBlocks)
      .map(pre => pre.textContent.trim())
      .join('\n\n-- --------------------------------------------------\n\n');
      
    navigator.clipboard.writeText(combinedSql).then(() => {
      const originalText = copyAllBtn.textContent;
      copyAllBtn.textContent = '✓ Copied All!';
      copyAllBtn.style.background = '#dcfce7';
      copyAllBtn.style.color = '#15803d';
      setTimeout(() => {
        copyAllBtn.textContent = originalText;
        copyAllBtn.style.background = '#f1f5f9';
        copyAllBtn.style.color = '#334155';
      }, 2000);
    });
  });

  stitchBtn.addEventListener('click', () => {
    const rawVal = rawLogsInput.value;
    if (!rawVal.trim()) {
      alert('Please paste some Guidewire log text first.');
      return;
    }

    const blocks = parseLogs(rawVal);
    statementsList.innerHTML = '';

    if (blocks.length === 0) {
      statusMessage.style.display = 'block';
      statusMessage.className = 'flash flash-error';
      statusMessage.textContent = 'Could not detect any SQL queries or parameter statements. Ensure your SQL keywords are in uppercase or contain standard Query logging statements.';
      resultsWrapper.style.display = 'block';
      statementCount.textContent = '0';
      return;
    }

    statusMessage.style.display = 'none';
    resultsWrapper.style.display = 'block';
    statementCount.textContent = blocks.length.toString();

    blocks.forEach((block, index) => {
      const { sql, paramsParsed, paramStr, rawLines } = block;
      const stitched = stitchBlock(block);

      const blockEl = document.createElement('div');
      blockEl.style.background = '#f8fafc';
      blockEl.style.border = '1px solid #e2e8f0';
      blockEl.style.borderRadius = '10px';
      blockEl.style.padding = '16px';
      blockEl.style.display = 'flex';
      blockEl.style.flexDirection = 'column';
      blockEl.style.gap = '12px';

      // Title & Action Bar
      const headerEl = document.createElement('div');
      headerEl.style.display = 'flex';
      headerEl.style.justifyContent = 'space-between';
      headerEl.style.alignItems = 'center';
      headerEl.style.flexWrap = 'wrap';
      headerEl.style.gap = '8px';

      const titleEl = document.createElement('h3');
      titleEl.style.fontSize = '14px';
      titleEl.style.margin = '0';
      titleEl.style.color = '#334155';
      titleEl.textContent = `Statement #${index + 1}`;

      const actionGroup = document.createElement('div');
      actionGroup.style.display = 'flex';
      actionGroup.style.gap = '8px';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'button small';
      copyBtn.style.padding = '4px 8px';
      copyBtn.style.fontSize = '12px';
      copyBtn.textContent = '📋 Copy';

      actionGroup.appendChild(copyBtn);
      headerEl.appendChild(titleEl);
      headerEl.appendChild(actionGroup);
      blockEl.appendChild(headerEl);

      // Warning block if any
      if (stitched.warning || stitched.error || stitched.warnings) {
        const alertEl = document.createElement('div');
        alertEl.style.fontSize = '12px';
        alertEl.style.padding = '8px 12px';
        alertEl.style.borderRadius = '6px';
        
        if (stitched.error) {
          alertEl.style.background = '#fef2f2';
          alertEl.style.border = '1px solid #fecaca';
          alertEl.style.color = '#991b1b';
          alertEl.textContent = `Error: ${stitched.error}`;
        } else {
          alertEl.style.background = '#fffbeb';
          alertEl.style.border = '1px solid #fde68a';
          alertEl.style.color = '#92400e';
          
          const warningMsgs = [];
          if (stitched.warning) warningMsgs.push(stitched.warning);
          if (stitched.warnings) warningMsgs.push(...stitched.warnings);
          alertEl.innerHTML = `<strong>Attention needed:</strong><br>${warningMsgs.join('<br>')}`;
        }
        blockEl.appendChild(alertEl);
      }

      // Display original SQL & Stitched SQL side-by-side or stacked
      const bodyEl = document.createElement('div');
      bodyEl.style.display = 'grid';
      bodyEl.style.gridTemplateColumns = '1fr';
      bodyEl.style.gap = '12px';

      // Original section
      if (sql) {
        const origContainer = document.createElement('div');
        const origLabel = document.createElement('div');
        origLabel.style.fontSize = '11px';
        origLabel.style.fontWeight = 'bold';
        origLabel.style.color = '#64748b';
        origLabel.style.marginBottom = '4px';
        origLabel.textContent = 'Original SQL (With Placeholders):';
        
        const origPre = document.createElement('pre');
        origPre.style.margin = '0';
        origPre.style.padding = '10px';
        origPre.style.background = '#f1f5f9';
        origPre.style.borderRadius = '6px';
        origPre.style.fontSize = '12px';
        origPre.style.overflowX = 'auto';
        origPre.style.fontFamily = 'monospace';
        origPre.textContent = sql;

        origContainer.appendChild(origLabel);
        origContainer.appendChild(origPre);
        bodyEl.appendChild(origContainer);
      }

      // Stitched section
      if (stitched.stitchedSql) {
        const stitchedContainer = document.createElement('div');
        const stitchedLabel = document.createElement('div');
        stitchedLabel.style.fontSize = '11px';
        stitchedLabel.style.fontWeight = 'bold';
        stitchedLabel.style.color = '#0284c7';
        stitchedLabel.style.marginBottom = '4px';
        stitchedLabel.textContent = 'Stitched Executable SQL:';
        
        const stitchedPre = document.createElement('pre');
        stitchedPre.className = 'stitched-sql-pre';
        stitchedPre.style.margin = '0';
        stitchedPre.style.padding = '10px';
        stitchedPre.style.background = '#f0f9ff';
        stitchedPre.style.border = '1px solid #bae6fd';
        stitchedPre.style.borderRadius = '6px';
        stitchedPre.style.fontSize = '12px';
        stitchedPre.style.overflowX = 'auto';
        stitchedPre.style.fontFamily = 'monospace';
        stitchedPre.style.fontWeight = '500';
        stitchedPre.style.color = '#0369a1';
        stitchedPre.textContent = stitched.stitchedSql;

        stitchedContainer.appendChild(stitchedLabel);
        stitchedContainer.appendChild(stitchedPre);
        bodyEl.appendChild(stitchedContainer);

        // Copy button action
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(stitched.stitchedSql).then(() => {
            const originalText = copyBtn.textContent;
            copyBtn.textContent = '✓ Copied!';
            copyBtn.style.background = '#dcfce7';
            copyBtn.style.color = '#15803d';
            setTimeout(() => {
              copyBtn.textContent = originalText;
              copyBtn.style.background = '';
              copyBtn.style.color = '';
            }, 1500);
          });
        });
      }

      // Display parsed parameters
      if (paramsParsed && paramsParsed.length > 0) {
        const paramsContainer = document.createElement('div');
        const paramsLabel = document.createElement('div');
        paramsLabel.style.fontSize = '11px';
        paramsLabel.style.fontWeight = 'bold';
        paramsLabel.style.color = '#64748b';
        paramsLabel.style.marginBottom = '6px';
        paramsLabel.textContent = `Parsed Bind Parameters (${paramsParsed.length}):`;

        const grid = document.createElement('div');
        grid.style.display = 'flex';
        grid.style.flexWrap = 'wrap';
        grid.style.gap = '6px';

        paramsParsed.forEach(p => {
          const badge = document.createElement('span');
          badge.style.fontSize = '11px';
          badge.style.padding = '4px 8px';
          badge.style.background = '#fff';
          badge.style.border = '1px solid #cbd5e1';
          badge.style.borderRadius = '6px';
          badge.style.fontFamily = 'monospace';
          badge.innerHTML = `<strong style="color:#0f172a;">#${p.index}</strong>: <span style="color:#0891b2;">${p.type || 'unknown'}</span> = <code style="background:#f1f5f9; padding:2px 4px; border-radius:4px; font-weight:600; color:#b45309;">${p.value}</code>`;
          grid.appendChild(badge);
        });

        paramsContainer.appendChild(paramsLabel);
        paramsContainer.appendChild(grid);
        bodyEl.appendChild(paramsContainer);
      }

      blockEl.appendChild(bodyEl);
      statementsList.appendChild(blockEl);
    });
  });
});
}
