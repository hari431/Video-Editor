/**
 * Gosu / Java Stack Trace Analyzer - Parser & Utilities
 * Fully offline, runs in-browser and Node.js test suites.
 */

/**
 * Parses a stack frame's location string.
 * Example input: "MyClass.java:23" -> { fileName: "MyClass.java", lineNumber: 23 }
 */
export function parseLocation(locationStr) {
  const trimmed = locationStr.trim();
  if (trimmed === 'Native Method') {
    return { fileName: 'Native Method', lineNumber: null };
  }
  if (trimmed === 'Unknown Source') {
    return { fileName: 'Unknown Source', lineNumber: null };
  }
  const parts = trimmed.split(':');
  const fileName = parts[0];
  const lineNumber = parts[1] ? parseInt(parts[1], 10) : null;
  return { fileName, lineNumber };
}

/**
 * Parses a single stack frame text from "at packageName.ClassName.methodName(FileName.java:LineNumber) [Gosu file: ...]"
 */
export function parseFrameText(frameText) {
  let clean = frameText.trim();
  if (clean.startsWith('at ')) {
    clean = clean.substring(3).trim();
  }
  const parenStart = clean.indexOf('(');
  if (parenStart === -1) {
    // Malformed frame or raw gosu line representation
    return {
      fullClassName: '',
      methodName: clean,
      fileName: 'Unknown',
      lineNumber: null,
      gosuFile: null,
      gosuLine: null
    };
  }

  const beforeParen = clean.substring(0, parenStart).trim();
  const insideParen = clean.substring(parenStart + 1, clean.indexOf(')', parenStart)).trim();

  // Parse class and method
  const dotParts = beforeParen.split('.');
  let methodName = '';
  let fullClassName = '';
  if (dotParts.length > 0) {
    methodName = dotParts[dotParts.length - 1];
    fullClassName = dotParts.slice(0, dotParts.length - 1).join('.');
  } else {
    methodName = beforeParen;
  }

  // Parse file and line number
  const { fileName, lineNumber } = parseLocation(insideParen);

  // Parse optional outer Gosu file suffix: e.g. " (Gosu file: MyGosuClass.gs:12)"
  let gosuFile = null;
  let gosuLine = null;
  const gosuMatch = clean.match(/\(Gosu file:\s*([^)]+)\)/);
  if (gosuMatch) {
    const gosuParts = gosuMatch[1].trim().split(':');
    gosuFile = gosuParts[0];
    if (gosuParts[1]) {
      gosuLine = parseInt(gosuParts[1], 10);
    }
  }

  return {
    fullClassName,
    methodName,
    fileName,
    lineNumber,
    gosuFile,
    gosuLine
  };
}

/**
 * Custom exception header parser that extracts class and optional message.
 */
export function parseExceptionHeader(headerText) {
  const colonIdx = headerText.indexOf(':');
  if (colonIdx !== -1) {
    const exceptionClass = headerText.substring(0, colonIdx).trim();
    const message = headerText.substring(colonIdx + 1).trim();
    return { exceptionClass, message, frames: [], omittedCount: 0 };
  } else {
    return { exceptionClass: headerText.trim(), message: '', frames: [], omittedCount: 0 };
  }
}

/**
 * Parses a raw multi-cause stack trace string into structured JSON exception objects.
 */
export function parseStackTrace(text) {
  if (!text || !text.trim()) return [];
  const lines = text.split(/\r?\n/);
  const exceptions = [];
  let currentException = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Check for "Caused by:"
    if (line.startsWith('Caused by:')) {
      if (currentException) {
        exceptions.push(currentException);
      }
      const header = line.substring('Caused by:'.length).trim();
      currentException = parseExceptionHeader(header);
      continue;
    }

    // Check for omitted frames
    if (line.startsWith('...') && line.includes('more')) {
      const match = line.match(/\.\.\.\s+(\d+)\s+more/);
      if (match && currentException) {
        currentException.omittedCount = parseInt(match[1], 10);
      }
      continue;
    }

    // Check for frames (usually starts with "at ")
    const frameMatch = line.match(/^\s*at\s+(.+)$/);
    if (frameMatch) {
      const frameText = frameMatch[1].trim();
      const parsedFrame = parseFrameText(frameText);
      if (parsedFrame) {
        if (!currentException) {
          currentException = { exceptionClass: 'UnknownException', message: '', frames: [], omittedCount: 0 };
        }
        currentException.frames.push(parsedFrame);
      }
      continue;
    }

    // If it's the first line of the stack trace and we don't have an exception yet
    if (!currentException) {
      let headerText = line;
      if (line.startsWith('Exception in thread')) {
        const threadMatch = line.match(/^Exception in thread\s+"[^"]+"\s+(.+)$/);
        if (threadMatch) {
          headerText = threadMatch[1];
        }
      }
      currentException = parseExceptionHeader(headerText);
    } else {
      // Append to the exception's multi-line message
      currentException.message += (currentException.message ? '\n' : '') + line;
    }
  }

  if (currentException) {
    exceptions.push(currentException);
  }

  return exceptions;
}

/**
 * Classifies a stack frame to filter out system and framework noise.
 */
export function classifyFrame(frame) {
  const cls = frame.fullClassName || '';
  const file = frame.fileName || '';

  // 1. Is it Custom Gosu?
  if (frame.gosuFile || file.endsWith('.gs') || cls.startsWith('gw.rules.') || cls.startsWith('gw.plugin.')) {
    return 'custom-gosu';
  }

  // 2. Is it Guidewire Framework?
  if (cls.startsWith('com.guidewire.') || cls.startsWith('gw.') || cls.startsWith('com.gw.')) {
    return 'guidewire-framework';
  }

  // 3. Known third-party and standard platform libraries
  const noisePackages = [
    'java.', 'javax.', 'sun.', 'com.sun.', 'org.apache.', 'org.hibernate.', 'org.springframework.',
    'org.eclipse.jetty.', 'org.mortbay.jetty.', 'com.fasterxml.jackson.', 'org.postgresql.', 'oracle.jdbc.',
    'com.microsoft.sqlserver.', 'com.mysql.', 'net.sf.sf', 'org.junit.', 'junit.', 'org.h2.'
  ];

  if (noisePackages.some(pkg => cls.startsWith(pkg))) {
    return 'framework-noise';
  }

  // 4. Default to general/custom application Java code
  return 'custom-app';
}

/**
 * Searches the exception chain for database or SQL-related exceptions.
 */
export function detectDatabaseException(exceptions) {
  const dbClasses = [
    'java.sql.SQLException',
    'org.hibernate.JDBCException',
    'com.guidewire.commons.system.exception.DatabaseException',
    'gw.api.database.QueryParseException',
    'oracle.jdbc.OracleDatabaseException',
    'org.postgresql.util.PSQLException',
    'com.microsoft.sqlserver.jdbc.SQLServerException'
  ];

  for (const ex of exceptions) {
    const cls = ex.exceptionClass || '';
    if (dbClasses.some(dbCls => cls.includes(dbCls)) || (cls.endsWith('Exception') && (cls.includes('SQL') || cls.includes('Database') || cls.includes('JDBC')))) {
      return ex;
    }
  }
  return null;
}

/**
 * Identifies the deep root cause exception.
 */
export function identifyRootCause(exceptions) {
  if (!exceptions || exceptions.length === 0) return null;
  const root = exceptions[exceptions.length - 1];
  return {
    exceptionClass: root.exceptionClass,
    message: root.message,
    depth: exceptions.length - 1,
    hasFrames: root.frames.length > 0
  };
}

// UI wiring
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const rawTraceInput = document.getElementById('rawTraceInput');
    const analyzeBtn = document.getElementById('analyzeBtn');
    const clearBtn = document.getElementById('clearBtn');
    const loadSampleGosuBtn = document.getElementById('loadSampleGosuBtn');
    const loadSampleSqlBtn = document.getElementById('loadSampleSqlBtn');
    const errorContainer = document.getElementById('errorContainer');
    const resultsPanel = document.getElementById('resultsPanel');
    const rootCauseBox = document.getElementById('rootCauseBox');
    const dbAlertBox = document.getElementById('dbAlertBox');
    const exceptionChainList = document.getElementById('exceptionChainList');

    const sampleGosu = `Exception in thread "GosuRulesEngine-1" gw.lang.parser.exceptions.ParseResultsException: Found 1 parser errors: Line 14, Column 5: The property "Active" is not writable on "pc_policyperiod"
    at gw.internal.ext.org.apache.commons.cli.CommandLine.getOptionValue(CommandLine.java:102)
    at gw.lang.function.Function0.invoke(Function0.js) (Gosu file: MyGosuClass.gs:12)
    at gw.rules.PolicyRules.evaluate(PolicyRules.gs:45)
    at com.guidewire.pl.web.controller.RequestProcessor.process(RequestProcessor.java:99)
Caused by: java.lang.NullPointerException: Cannot invoke "Object.hashCode()" because "obj" is null
    at com.customer.integration.AddressValidator.validate(AddressValidator.java:23)
    at gw.rules.PolicyRules.evaluate(PolicyRules.gs:41)
    ... 12 more`;

    const sampleSql = `com.guidewire.commons.system.exception.DatabaseException: Query execution failed against Oracle DB
    at com.guidewire.commons.system.database.QueryExecutor.execute(QueryExecutor.java:543)
    at com.guidewire.commons.system.database.QueryExecutor.run(QueryExecutor.java:234)
Caused by: java.sql.SQLException: ORA-00060: deadlock detected while waiting for resource
    at oracle.jdbc.driver.T4CTTIoer11.processError(T4CTTIoer11.java:494)
    at oracle.jdbc.driver.T4C8Oall.process(T4C8Oall.java:1020)
    ... 35 more`;

    if (loadSampleGosuBtn) {
      loadSampleGosuBtn.addEventListener('click', () => {
        rawTraceInput.value = sampleGosu;
        rawTraceInput.dispatchEvent(new Event('input'));
      });
    }

    if (loadSampleSqlBtn) {
      loadSampleSqlBtn.addEventListener('click', () => {
        rawTraceInput.value = sampleSql;
        rawTraceInput.dispatchEvent(new Event('input'));
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        rawTraceInput.value = '';
        resultsPanel.classList.add('hidden');
        errorContainer.classList.add('hidden');
        rawTraceInput.focus();
      });
    }

    if (analyzeBtn) {
      analyzeBtn.addEventListener('click', () => {
        const input = rawTraceInput.value.trim();
        if (!input) {
          showError('Please paste a raw Java or Gosu stack trace.');
          return;
        }

        analyzeBtn.disabled = true;
        analyzeBtn.textContent = 'Analyzing...';
        errorContainer.classList.add('hidden');
        exceptionChainList.innerHTML = '';
        dbAlertBox.classList.add('hidden');

        try {
          const exceptions = parseStackTrace(input);
          if (exceptions.length === 0) {
            showError('Unable to parse any exceptions from the input. Verify your stack trace format.');
            return;
          }

          // 1. Display Root Cause
          const rootCause = identifyRootCause(exceptions);
          if (rootCause) {
            rootCauseBox.innerHTML = `
              <div class="flex items-start gap-3">
                <span class="px-2.5 py-1 bg-red-100 text-red-800 text-xs font-bold rounded-md shrink-0 uppercase tracking-wider">Exception</span>
                <div>
                  <h4 class="font-mono text-base font-bold text-red-950 break-all select-all">${escapeHtml(rootCause.exceptionClass)}</h4>
                  <p class="text-sm text-red-900 mt-1.5 whitespace-pre-wrap">${escapeHtml(rootCause.message || 'No description message provided.')}</p>
                  <div class="mt-3 flex items-center gap-3 text-xs text-red-700 font-semibold">
                    <span>Chain Depth: Caused by level ${rootCause.depth}</span>
                    <span>•</span>
                    <span>${rootCause.hasFrames ? 'Frames extracted' : 'No stack frames in root exception'}</span>
                  </div>
                </div>
              </div>
            `;
          }

          // 2. Database/SQL exceptions detection
          const dbEx = detectDatabaseException(exceptions);
          if (dbEx) {
            dbAlertBox.classList.remove('hidden');
            dbAlertBox.innerHTML = `
              <div class="flex items-start gap-3">
                <svg class="w-5 h-5 text-amber-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"></path></svg>
                <div>
                  <h4 class="text-sm font-bold text-amber-950">Database Error Identified</h4>
                  <p class="text-xs text-amber-900 mt-1 font-mono">${escapeHtml(dbEx.exceptionClass)}: ${escapeHtml(dbEx.message)}</p>
                </div>
              </div>
            `;
          }

          // 3. Render Exception Chain and Frames Grouping
          exceptions.forEach((ex, idx) => {
            const chainEl = document.createElement('div');
            chainEl.className = 'bg-white border border-slate-200 rounded-xl p-6 shadow-sm transition-all hover:shadow-md';

            // Partition frames
            const customGosuFrames = [];
            const customAppFrames = [];
            const gwFrameworkFrames = [];
            const noiseFrames = [];

            ex.frames.forEach(frame => {
              const classification = classifyFrame(frame);
              if (classification === 'custom-gosu') customGosuFrames.push(frame);
              else if (classification === 'custom-app') customAppFrames.push(frame);
              else if (classification === 'guidewire-framework') gwFrameworkFrames.push(frame);
              else noiseFrames.push(frame);
            });

            const hasFrames = ex.frames.length > 0;

            chainEl.innerHTML = `
              <div class="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-100 pb-4 mb-4">
                <div class="flex items-center gap-3">
                  <span class="flex items-center justify-center w-7 h-7 rounded-full bg-slate-900 text-white font-mono text-xs font-bold">#${idx + 1}</span>
                  <div>
                    <h4 class="font-mono text-sm font-bold text-slate-900 break-all">${escapeHtml(ex.exceptionClass)}</h4>
                    <p class="text-xs text-slate-500 mt-0.5 break-all">${escapeHtml(ex.message.split('\n')[0])}</p>
                  </div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <span class="px-2.5 py-0.5 text-xs font-semibold rounded bg-slate-100 border border-slate-200 text-slate-700">${ex.frames.length} total frames</span>
                </div>
              </div>

              ${!hasFrames ? '<p class="text-xs text-slate-500 italic">No stack frames extracted for this level.</p>' : `
                <div class="space-y-4">
                  <!-- Custom Gosu Frames (Highly Critical) -->
                  ${customGosuFrames.length === 0 ? '' : `
                    <div>
                      <div class="text-xs font-bold text-indigo-700 uppercase tracking-wider mb-2 flex items-center gap-1">
                        <span class="w-2 h-2 rounded-full bg-indigo-600"></span>
                        Custom Gosu Code (${customGosuFrames.length})
                      </div>
                      <div class="bg-indigo-50/50 border border-indigo-100 rounded-lg p-3 space-y-1.5 font-mono text-xs">
                        ${customGosuFrames.map(f => renderFrameRow(f, 'text-indigo-950 font-semibold', 'bg-indigo-100 text-indigo-800')).join('')}
                      </div>
                    </div>
                  `}

                  <!-- Custom App Java Frames -->
                  ${customAppFrames.length === 0 ? '' : `
                    <div>
                      <div class="text-xs font-bold text-emerald-700 uppercase tracking-wider mb-2 flex items-center gap-1">
                        <span class="w-2 h-2 rounded-full bg-emerald-600"></span>
                        Custom Application Java Code (${customAppFrames.length})
                      </div>
                      <div class="bg-emerald-50/50 border border-emerald-100 rounded-lg p-3 space-y-1.5 font-mono text-xs">
                        ${customAppFrames.map(f => renderFrameRow(f, 'text-emerald-950 font-semibold', 'bg-emerald-100 text-emerald-800')).join('')}
                      </div>
                    </div>
                  `}

                  <!-- Guidewire Framework Frames -->
                  ${gwFrameworkFrames.length === 0 ? '' : `
                    <div>
                      <details class="group">
                        <summary class="text-xs font-bold text-slate-600 uppercase tracking-wider mb-2 flex items-center gap-1 cursor-pointer select-none">
                          <span class="w-2 h-2 rounded-full bg-slate-500"></span>
                          Guidewire Platform Internals (${gwFrameworkFrames.length})
                          <span class="text-slate-400 text-[10px] ml-1 group-open:hidden">[Click to Expand]</span>
                          <span class="text-slate-400 text-[10px] ml-1 hidden group-open:inline">[Click to Collapse]</span>
                        </summary>
                        <div class="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1.5 font-mono text-xs">
                          ${gwFrameworkFrames.map(f => renderFrameRow(f, 'text-slate-700')).join('')}
                        </div>
                      </details>
                    </div>
                  `}

                  <!-- Framework Noise (JDK, Jetty, Hibernate, etc.) -->
                  ${noiseFrames.length === 0 ? '' : `
                    <div>
                      <details class="group">
                        <summary class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1 cursor-pointer select-none">
                          <span class="w-2 h-2 rounded-full bg-slate-300"></span>
                          Third-Party & System Noise (${noiseFrames.length})
                          <span class="text-slate-400 text-[10px] ml-1 group-open:hidden">[Click to Expand]</span>
                          <span class="text-slate-400 text-[10px] ml-1 hidden group-open:inline">[Click to Collapse]</span>
                        </summary>
                        <div class="bg-slate-50/30 border border-slate-100 rounded-lg p-3 space-y-1.5 font-mono text-xs text-slate-500">
                          ${noiseFrames.map(f => renderFrameRow(f, 'text-slate-400')).join('')}
                        </div>
                      </details>
                    </div>
                  `}

                  ${ex.omittedCount > 0 ? `
                    <div class="text-xs text-slate-500 italic mt-2 ml-2">
                      ... ${ex.omittedCount} more frames omitted in the logs
                    </div>
                  ` : ''}
                </div>
              `}
            `;

            exceptionChainList.appendChild(chainEl);
          });

          resultsPanel.classList.remove('hidden');

        } catch (err) {
          showError(`Analysis failed: ${err.message}`);
        } finally {
          analyzeBtn.disabled = false;
          analyzeBtn.textContent = 'Analyze Stack Trace';
        }
      });
    }

    function renderFrameRow(frame, textStyle = 'text-slate-800', badgeStyle = 'bg-slate-100 text-slate-600') {
      const cls = frame.fullClassName ? `${frame.fullClassName}.` : '';
      const method = frame.methodName || '';
      const location = frame.lineNumber !== null ? `${frame.fileName}:${frame.lineNumber}` : (frame.fileName || 'Unknown Source');
      
      let gosuSuffix = '';
      if (frame.gosuFile) {
        gosuSuffix = ` <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-100 text-indigo-800 border border-indigo-200 ml-2" title="Original Gosu source coordinates">Gosu: ${escapeHtml(frame.gosuFile)}:${frame.gosuLine || ''}</span>`;
      }

      return `
        <div class="flex items-start justify-between py-1 border-b border-slate-100 last:border-0 gap-2 hover:bg-slate-100/40 px-1 rounded transition-colors">
          <div class="break-all ${textStyle}">
            at <span>${escapeHtml(cls)}</span><span class="font-bold">${escapeHtml(method)}</span>${gosuSuffix}
          </div>
          <div class="text-[11px] font-semibold text-slate-500 shrink-0 whitespace-nowrap bg-slate-100/80 border border-slate-200 px-1.5 py-0.5 rounded">
            ${escapeHtml(location)}
          </div>
        </div>
      `;
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
