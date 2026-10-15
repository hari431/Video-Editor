/**
 * Integration Payload Decoder - Core Logic & Helpers
 * Runs entirely locally (in-browser or in Node.js unit tests).
 */

/**
 * Decodes a base64 string to a Uint8Array.
 * Works in both browser and Node.js.
 */
export function decodeBase64(str) {
  const cleaned = str.replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(cleaned, 'base64');
    return new Uint8Array(buf);
  }
  const binString = atob(cleaned);
  const bytes = new Uint8Array(binString.length);
  for (let i = 0; i < binString.length; i++) {
    bytes[i] = binString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decodes a hex string to a Uint8Array.
 */
export function decodeHex(str) {
  const cleaned = str.replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]+$/.test(cleaned) || cleaned.length % 2 !== 0) {
    return null;
  }
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes[i / 2] = parseInt(cleaned.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Converts a Uint8Array of bytes into a UTF-8 string.
 * Returns null if the bytes are not valid UTF-8.
 */
export function bytesToString(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decompresses Gzip bytes using either Node.js zlib or Browser DecompressionStream.
 */
export async function decompressGzip(bytes) {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const zlib = await import('node:zlib');
    const buf = Buffer.from(bytes.buffer || bytes);
    const decompressed = zlib.gunzipSync(buf);
    return new Uint8Array(decompressed);
  } else if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const output = [];
    const reader = ds.readable.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output.push(value);
    }
    const len = output.reduce((acc, curr) => acc + curr.length, 0);
    const merged = new Uint8Array(len);
    let offset = 0;
    for (const chunk of output) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }
  throw new Error('Gzip decompression not supported in this environment.');
}

/**
 * HTML/XML entities decoder.
 */
export function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

/**
 * Pretty-prints XML or SOAP strings.
 */
export function formatXml(xml) {
  const reg = /(>)\s*(<)(\/*)/g;
  const wspace = xml.replace(reg, '$1\r\n$2$3');
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
 * Pretty-prints JSON strings.
 */
export function formatJson(str) {
  try {
    const obj = JSON.parse(str);
    return JSON.stringify(obj, null, 2);
  } catch {
    return null;
  }
}

/**
 * Heuristic to check if string contains printable / readable characters.
 */
export function isReadableText(str) {
  if (typeof str !== 'string' || str.length === 0) return false;
  let controlChars = 0;
  const checkLen = Math.min(str.length, 1000);
  for (let i = 0; i < checkLen; i++) {
    const code = str.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      controlChars++;
    }
  }
  return (controlChars / checkLen) < 0.05;
}

/**
 * Checks if a string is likely Base64 encoded.
 */
export function isBase64Pattern(str) {
  const cleaned = str.replace(/\s+/g, '');
  if (cleaned.length < 8) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(cleaned);
}

/**
 * Check and decode a potential nested payload value.
 */
export async function checkAndDecodeNested(str) {
  const trimmed = str.trim();
  if (trimmed.length < 12) return null;

  // Try Gzip magic detection if it starts with Gzip header in hex or Base64
  // Let's first check Hex
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    const hexBytes = decodeHex(trimmed);
    if (hexBytes) {
      if (hexBytes[0] === 0x1f && hexBytes[1] === 0x8b) {
        try {
          const unzippedBytes = await decompressGzip(hexBytes);
          const unzippedStr = bytesToString(unzippedBytes);
          if (unzippedStr && isReadableText(unzippedStr)) {
            return { type: 'Hex + Gzip Decompressed', decoded: unzippedStr };
          }
        } catch {
          // ignore
        }
      }
      const hexStr = bytesToString(hexBytes);
      if (hexStr && isReadableText(hexStr) && (hexStr.includes('{') || hexStr.includes('<') || hexStr.length > 20)) {
        return { type: 'Hex Decoded', decoded: hexStr };
      }
    }
  }

  // Next check Base64
  if (isBase64Pattern(trimmed)) {
    try {
      const b64Bytes = decodeBase64(trimmed);
      if (b64Bytes) {
        if (b64Bytes[0] === 0x1f && b64Bytes[1] === 0x8b) {
          try {
            const unzippedBytes = await decompressGzip(b64Bytes);
            const unzippedStr = bytesToString(unzippedBytes);
            if (unzippedStr && isReadableText(unzippedStr)) {
              return { type: 'Base64 + Gzip Decompressed', decoded: unzippedStr };
            }
          } catch {
            // ignore
          }
        }
        const b64Str = bytesToString(b64Bytes);
        if (b64Str && isReadableText(b64Str)) {
          // Verify it's not a false positive word (like a common dictionary word)
          // We look for structured text indicators, or longer strings
          if (b64Str.includes('{') || b64Str.includes('<') || b64Str.length > 15) {
            return { type: 'Base64 Decoded', decoded: b64Str };
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Recursively scans a parsed JSON object for nested payloads.
 */
export async function findNestedPayloadsInObj(obj, path = 'root', results = []) {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') {
    if (obj.length >= 12) {
      const decoded = await checkAndDecodeNested(obj);
      if (decoded) {
        results.push({ path, original: obj, ...decoded });
      }
    }
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      await findNestedPayloadsInObj(obj[i], `${path}[${i}]`, results);
    }
  } else if (typeof obj === 'object') {
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        await findNestedPayloadsInObj(obj[key], `${path}.${key}`, results);
      }
    }
  }
}

/**
 * Scans an XML string for nested payloads inside tags.
 */
export async function findNestedPayloadsInXml(xml, results = []) {
  // Simple regex to match <tag>content</tag> with contents at least 12 characters long without nested tags
  const tagRegex = /<([\w:.-]+)[^>]*>([^<]{12,})<\/\1>/g;
  let match;
  while ((match = tagRegex.exec(xml)) !== null) {
    const tagName = match[1];
    const content = match[2].trim();
    const decoded = await checkAndDecodeNested(content);
    if (decoded) {
      results.push({ path: `<${tagName}>`, original: content, ...decoded });
    }
  }
}

/**
 * Runs the full sequential decoding chain for a single payload string.
 */
export async function decodePayloadChain(input) {
  const steps = [];
  let currentVal = input.trim();
  let done = false;
  let iterations = 0;
  const maxIterations = 5; // Prevent any possible infinite loops

  steps.push({
    title: 'Original Input',
    type: 'original',
    value: input
  });

  while (!done && iterations < maxIterations) {
    iterations++;
    let changed = false;

    // 1. Is URL encoded?
    if (currentVal.includes('%')) {
      try {
        // Only consider it URL encoded if it contains actual valid sequence and decodes to something different
        const decoded = decodeURIComponent(currentVal);
        if (decoded !== currentVal) {
          currentVal = decoded;
          steps.push({
            title: 'URL Decoded',
            type: 'url',
            value: currentVal
          });
          changed = true;
          continue;
        }
      } catch {
        // ignore malformed URL components
      }
    }

    // 2. Is HTML Entity escaped?
    if (/&amp;|&lt;|&gt;|&quot;|&#39;|&#x27;|&#x2F;/.test(currentVal)) {
      const decoded = decodeHtmlEntities(currentVal);
      if (decoded !== currentVal) {
        currentVal = decoded;
        steps.push({
          title: 'HTML Entities Decoded',
          type: 'html',
          value: currentVal
        });
        changed = true;
        continue;
      }
    }

    // 3. Is XML? If so, format it and we are done
    if (currentVal.startsWith('<') && currentVal.endsWith('>')) {
      const formatted = formatXml(currentVal);
      steps.push({
        title: 'XML / SOAP Formatted',
        type: 'xml',
        value: formatted
      });
      currentVal = formatted;
      done = true;
      break;
    }

    // 4. Is JSON? If so, format it and we are done
    if ((currentVal.startsWith('{') && currentVal.endsWith('}')) || (currentVal.startsWith('[') && currentVal.endsWith(']'))) {
      const formatted = formatJson(currentVal);
      if (formatted) {
        steps.push({
          title: 'JSON Formatted',
          type: 'json',
          value: formatted
        });
        currentVal = formatted;
        done = true;
        break;
      }
    }

    // 5. Is Gzip Hex?
    if (/^[0-9a-fA-F\s]+$/.test(currentVal) && currentVal.replace(/\s+/g, '').length >= 16) {
      const hexBytes = decodeHex(currentVal);
      if (hexBytes) {
        if (hexBytes[0] === 0x1f && hexBytes[1] === 0x8b) {
          try {
            const decompressed = await decompressGzip(hexBytes);
            const str = bytesToString(decompressed);
            if (str && isReadableText(str)) {
              currentVal = str;
              steps.push({
                title: 'Hex decoded + Gzip decompressed',
                type: 'hex_gzip',
                value: currentVal
              });
              changed = true;
              continue;
            }
          } catch {
            // ignore
          }
        } else {
          // Plain Hex decoded text?
          const str = bytesToString(hexBytes);
          if (str && isReadableText(str) && (str.includes('{') || str.includes('<') || str.length > 15)) {
            currentVal = str;
            steps.push({
              title: 'Hex Decoded',
              type: 'hex',
              value: currentVal
            });
            changed = true;
            continue;
          }
        }
      }
    }

    // 6. Is Base64?
    if (isBase64Pattern(currentVal)) {
      try {
        const bytes = decodeBase64(currentVal);
        if (bytes && bytes.length > 0) {
          // Check if gzip first
          if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
            try {
              const decompressed = await decompressGzip(bytes);
              const str = bytesToString(decompressed);
              if (str && isReadableText(str)) {
                currentVal = str;
                steps.push({
                  title: 'Base64 decoded + Gzip decompressed',
                  type: 'base64_gzip',
                  value: currentVal
                });
                changed = true;
                continue;
              }
            } catch {
              // ignore Gzip errors, maybe it is raw base64 binary
            }
          }

          // Otherwise normal string
          const str = bytesToString(bytes);
          if (str && isReadableText(str)) {
            currentVal = str;
            steps.push({
              title: 'Base64 Decoded',
              type: 'base64',
              value: currentVal
            });
            changed = true;
            continue;
          }
        }
      } catch {
        // ignore
      }
    }

    if (!changed) {
      done = true;
    }
  }

  // Finally, scan the final state for nested payloads
  const nested = [];
  if (currentVal.startsWith('<')) {
    await findNestedPayloadsInXml(currentVal, nested);
  } else {
    try {
      const parsed = JSON.parse(currentVal);
      await findNestedPayloadsInObj(parsed, 'root', nested);
    } catch {
      // Not JSON, do a generic regex-based Base64/Hex scan of the current string
      // Matches standard words or lines of base64 inside plain text
      const b64Regex = /[A-Za-z0-9+/]{30,}={0,2}/g;
      let match;
      const seen = new Set();
      while ((match = b64Regex.exec(currentVal)) !== null) {
        const potential = match[0];
        if (seen.has(potential)) continue;
        seen.add(potential);
        const decoded = await checkAndDecodeNested(potential);
        if (decoded) {
          nested.push({
            path: `Regex Match [index ${match.index}]`,
            original: potential,
            ...decoded
          });
        }
      }
    }
  }

  return {
    finalValue: currentVal,
    steps,
    nested
  };
}

// UI Wiring
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const rawPayloadInput = document.getElementById('rawPayloadInput');
    const decodeBtn = document.getElementById('decodeBtn');
    const clearBtn = document.getElementById('clearBtn');
    const loadSampleSoapBtn = document.getElementById('loadSampleSoapBtn');
    const loadSampleJsonBtn = document.getElementById('loadSampleJsonBtn');
    const stepsContainer = document.getElementById('stepsContainer');
    const resultPanel = document.getElementById('resultPanel');
    const errorContainer = document.getElementById('errorContainer');
    const copyFinalBtn = document.getElementById('copyFinalBtn');
    const finalResultCode = document.getElementById('finalResultCode');

    const sampleSoap = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:api="http://guidewire.com/ws/api">\n   <soapenv:Header/>\n   <soapenv:Body>\n      <api:processPayload>\n         <api:transactionId>TX-9823147</api:transactionId>\n         <api:encodedData>H4sICD25NmcCA2FwaV9yZXNwb25zZSBzYW1wbGUAS8vPz0vNS1FIz0vOTFEISUxPTEvNydDLzEsHACWInpYWAAAA</api:encodedData>\n      </api:processPayload>\n   </soapenv:Body>\n</soapenv:Envelope>`;

    const sampleJson = `{\n  "status": "success",\n  "code": 200,\n  "data": {\n    "message": "Payload delivered",\n    "payload": "eyJrZXkiOiAidmFsdWUiLCAidXNlcl9pZCI6IDQ1Nn0="\n  }\n}`;

    if (loadSampleSoapBtn) {
      loadSampleSoapBtn.addEventListener('click', () => {
        rawPayloadInput.value = sampleSoap;
        rawPayloadInput.dispatchEvent(new Event('input'));
      });
    }

    if (loadSampleJsonBtn) {
      loadSampleJsonBtn.addEventListener('click', () => {
        rawPayloadInput.value = sampleJson;
        rawPayloadInput.dispatchEvent(new Event('input'));
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        rawPayloadInput.value = '';
        stepsContainer.innerHTML = '';
        resultPanel.classList.add('hidden');
        errorContainer.classList.add('hidden');
        rawPayloadInput.focus();
      });
    }

    if (decodeBtn) {
      decodeBtn.addEventListener('click', async () => {
        const input = rawPayloadInput.value.trim();
        if (!input) {
          showError('Please paste an integration payload or log string.');
          return;
        }

        decodeBtn.disabled = true;
        decodeBtn.textContent = 'Decoding...';
        errorContainer.classList.add('hidden');
        stepsContainer.innerHTML = '';

        try {
          const result = await decodePayloadChain(input);
          
          // Render Main Decoding Steps
          result.steps.forEach((step, idx) => {
            const stepEl = document.createElement('div');
            stepEl.className = 'bg-white border border-slate-200 rounded-xl p-5 mb-5 shadow-sm transition-all hover:shadow-md';
            
            let badgeColor = 'bg-slate-100 text-slate-800 border-slate-200';
            if (step.type === 'original') badgeColor = 'bg-blue-50 text-blue-800 border-blue-200';
            else if (step.type === 'json' || step.type === 'xml') badgeColor = 'bg-emerald-50 text-emerald-800 border-emerald-200';
            else badgeColor = 'bg-indigo-50 text-indigo-800 border-indigo-200';

            stepEl.innerHTML = `
              <div class="flex items-center justify-between mb-3 border-b border-slate-100 pb-3">
                <div class="flex items-center gap-3">
                  <span class="flex items-center justify-center w-7 h-7 rounded-full bg-slate-900 text-white font-mono text-sm">${idx + 1}</span>
                  <h4 class="font-bold text-slate-900 text-base">${step.title}</h4>
                </div>
                <span class="px-3 py-1 text-xs font-semibold rounded-full border ${badgeColor}">${step.type.toUpperCase()}</span>
              </div>
              <div class="relative group mt-2">
                <button class="absolute top-2 right-2 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-md border border-slate-300 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all shadow-sm flex items-center gap-1 btn-copy-step">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg>
                  Copy Step
                </button>
                <pre class="bg-slate-950 text-slate-100 font-mono text-sm p-4 rounded-lg overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-96 border border-slate-800"><code>${escapeHtmlForDisplay(step.value)}</code></pre>
              </div>
            `;

            // Wire up copy step button
            const copyStepBtn = stepEl.querySelector('.btn-copy-step');
            if (copyStepBtn) {
              copyStepBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(step.value);
                const originalText = copyStepBtn.innerHTML;
                copyStepBtn.innerHTML = `
                  <svg class="w-3.5 h-3.5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
                  Copied!
                `;
                setTimeout(() => {
                  copyStepBtn.innerHTML = originalText;
                }, 1500);
              });
            }

            stepsContainer.appendChild(stepEl);
          });

          // Render Nested Payloads Section
          if (result.nested && result.nested.length > 0) {
            const nestedSectionEl = document.createElement('div');
            nestedSectionEl.className = 'mt-8 border-t border-slate-200 pt-8';
            nestedSectionEl.innerHTML = `
              <h3 class="text-lg font-bold text-slate-950 mb-4 flex items-center gap-2">
                <svg class="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"></path></svg>
                Extracted Nested Payloads (${result.nested.length})
              </h3>
              <p class="text-sm text-slate-600 mb-4">The following nested Base64/Hex strings were automatically extracted and decoded from the payload structure:</p>
              <div id="nestedContainers"></div>
            `;
            stepsContainer.appendChild(nestedSectionEl);

            const nestedContainers = nestedSectionEl.querySelector('#nestedContainers');
            result.nested.forEach((nest, idx) => {
              const nestEl = document.createElement('div');
              nestEl.className = 'bg-slate-50 border border-slate-200 rounded-xl p-5 mb-4';
              
              // Try to format nested contents nicely
              let formattedNestValue = nest.decoded;
              const formattedJson = formatJson(nest.decoded);
              if (formattedJson) {
                formattedNestValue = formattedJson;
              } else if (nest.decoded.trim().startsWith('<') && nest.decoded.trim().endsWith('>')) {
                formattedNestValue = formatXml(nest.decoded);
              }

              nestEl.innerHTML = `
                <div class="flex flex-col md:flex-row md:items-center justify-between mb-3 border-b border-slate-200 pb-3 gap-2">
                  <div class="flex items-center gap-2.5">
                    <span class="px-2 py-0.5 bg-indigo-100 text-indigo-800 rounded font-mono text-xs font-semibold">Location: ${escapeHtmlForDisplay(nest.path)}</span>
                    <span class="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded text-xs font-semibold">${nest.type}</span>
                  </div>
                  <button class="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 text-xs font-semibold rounded-md border border-slate-300 transition-all shadow-sm flex items-center gap-1 btn-copy-nested">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg>
                    Copy Decoded
                  </button>
                </div>
                <div class="mb-2">
                  <div class="text-xs font-medium text-slate-500 mb-1">Raw Encoded Snippet:</div>
                  <code class="block bg-slate-100 text-slate-700 font-mono text-xs p-2 rounded border border-slate-200 overflow-x-auto select-all max-h-16">${escapeHtmlForDisplay(nest.original.substring(0, 100))}${nest.original.length > 100 ? '...' : ''}</code>
                </div>
                <div class="mt-3 relative group">
                  <pre class="bg-slate-950 text-slate-100 font-mono text-sm p-4 rounded-lg overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-96 border border-slate-800"><code>${escapeHtmlForDisplay(formattedNestValue)}</code></pre>
                </div>
              `;

              const copyNestedBtn = nestEl.querySelector('.btn-copy-nested');
              if (copyNestedBtn) {
                copyNestedBtn.addEventListener('click', () => {
                  navigator.clipboard.writeText(formattedNestValue);
                  const originalText = copyNestedBtn.innerHTML;
                  copyNestedBtn.innerHTML = `
                    <svg class="w-3.5 h-3.5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
                    Copied!
                  `;
                  setTimeout(() => {
                    copyNestedBtn.innerHTML = originalText;
                  }, 1500);
                });
              }

              nestedContainers.appendChild(nestEl);
            });
          }

          // Render Final Step Results
          finalResultCode.innerHTML = escapeHtmlForDisplay(result.finalValue);
          resultPanel.classList.remove('hidden');

          if (copyFinalBtn) {
            // Unbind old listeners by replacing the button clone
            const newCopyFinalBtn = copyFinalBtn.cloneNode(true);
            copyFinalBtn.parentNode.replaceChild(newCopyFinalBtn, copyFinalBtn);

            newCopyFinalBtn.addEventListener('click', () => {
              navigator.clipboard.writeText(result.finalValue);
              const originalText = newCopyFinalBtn.innerHTML;
              newCopyFinalBtn.innerHTML = `
                <svg class="w-4 h-4 text-emerald-600 animate-bounce" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
                Copied Decoded Result!
              `;
              setTimeout(() => {
                newCopyFinalBtn.innerHTML = originalText;
              }, 1500);
            });
          }

        } catch (err) {
          showError(`Decoding failed: ${err.message}`);
        } finally {
          decodeBtn.disabled = false;
          decodeBtn.textContent = 'Decode Payload';
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

    function escapeHtmlForDisplay(str) {
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
