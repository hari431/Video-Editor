/**
 * PCF / XML Formatter, Validator & Path Explorer - Engine & Client handler
 * Offline, works on both browser environment and Node.js testing.
 */

/**
 * Clean, lightweight XML/PCF Parser that builds a syntax tree, keeps attribute order,
 * computes exact line/column coordinates, handles namespaces & comments, and returns stats.
 */
export function parseXmlPure(xmlText) {
  if (!xmlText || !xmlText.trim()) {
    throw new Error('Empty or invalid XML document.');
  }

  const lines = xmlText.split(/\r?\n/);

  function getCoordinates(index) {
    let cur = 0;
    for (let l = 0; l < lines.length; l++) {
      if (cur + lines[l].length >= index) {
        return { line: l + 1, column: index - cur + 1 };
      }
      cur += lines[l].length + 1; // account for newline
    }
    return { line: lines.length, column: 1 };
  }

  let root = null;
  const stack = [];
  let index = 0;
  const len = xmlText.length;

  let elementCount = 0;
  let attributeCount = 0;
  let commentCount = 0;

  while (index < len) {
    const char = xmlText[index];

    // Skip whitespace
    if (/\s/.test(char)) {
      index++;
      continue;
    }

    if (char === '<') {
      const startPos = index;

      // 1. Comments: <!-- ... -->
      if (xmlText.substring(index, index + 4) === '<!--') {
        const endComment = xmlText.indexOf('-->', index + 4);
        if (endComment === -1) {
          const coords = getCoordinates(index);
          throw new Error(`Unclosed XML comment starting at line ${coords.line}, column ${coords.column}`);
        }
        commentCount++;
        index = endComment + 3;
        continue;
      }

      // 2. Processing Instructions: <? ... ?>
      if (xmlText.substring(index, index + 2) === '<?') {
        const endPI = xmlText.indexOf('?>', index + 2);
        if (endPI === -1) {
          const coords = getCoordinates(index);
          throw new Error(`Unclosed processing instruction starting at line ${coords.line}, column ${coords.column}`);
        }
        index = endPI + 2;
        continue;
      }

      // 3. Regular Tag closing or opening
      const endTag = xmlText.indexOf('>', index);
      if (endTag === -1) {
        const coords = getCoordinates(index);
        throw new Error(`Unclosed XML tag starting at line ${coords.line}, column ${coords.column}`);
      }

      const tagContent = xmlText.substring(index + 1, endTag).trim();
      index = endTag + 1;

      // Close tag </name>
      if (tagContent.startsWith('/')) {
        const tagName = tagContent.substring(1).trim();
        if (stack.length === 0) {
          const coords = getCoordinates(startPos);
          throw new Error(`Unexpected closing tag </${tagName}> without opening tag at line ${coords.line}, column ${coords.column}`);
        }
        const activeNode = stack[stack.length - 1];
        if (activeNode.name !== tagName) {
          const coords = getCoordinates(startPos);
          throw new Error(`Mismatched closing tag </${tagName}>, expected </${activeNode.name}> at line ${coords.line}, column ${coords.column}`);
        }
        stack.pop();
        continue;
      }

      // Self-closing tags or opening tags
      const isSelfClosing = tagContent.endsWith('/');
      const cleanTagContent = isSelfClosing ? tagContent.substring(0, tagContent.length - 1).trim() : tagContent;

      // Parse tag name and attributes string
      const firstSpace = cleanTagContent.search(/\s/);
      let tagName = cleanTagContent;
      let attrText = '';
      if (firstSpace !== -1) {
        tagName = cleanTagContent.substring(0, firstSpace).trim();
        attrText = cleanTagContent.substring(firstSpace).trim();
      }

      // Attributes matching (preserves original parsing order)
      const attributes = {};
      const attrRegex = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(attrText)) !== null) {
        const attrName = attrMatch[1];
        const attrValue = attrMatch[2] !== undefined ? attrMatch[2] : attrMatch[3];
        attributes[attrName] = attrValue;
        attributeCount++;
      }

      const coords = getCoordinates(startPos);
      const node = {
        name: tagName,
        attributes,
        children: [],
        line: coords.line,
        column: coords.column,
        xpath: ''
      };

      elementCount++;

      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        node.parentName = parent.name;
        parent.children.push(node);

        const sameTypeSiblings = parent.children.filter(c => c.name === tagName);
        const indexSuffix = sameTypeSiblings.length > 1 ? `[${sameTypeSiblings.length}]` : '';
        node.xpath = `${parent.xpath}/${tagName}${indexSuffix}`;
      } else {
        node.parentName = null;
        node.xpath = `/${tagName}`;
        if (root) {
          throw new Error(`Multiple root elements detected. XML must have exactly one root element.`);
        }
        root = node;
      }

      if (!isSelfClosing) {
        stack.push(node);
      }
    } else {
      // Content text
      const nextLT = xmlText.indexOf('<', index);
      const textEnd = nextLT === -1 ? len : nextLT;
      const text = xmlText.substring(index, textEnd).trim();
      if (text && stack.length > 0) {
        stack[stack.length - 1].content = (stack[stack.length - 1].content || '') + text;
      }
      index = textEnd;
    }
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    throw new Error(`Unclosed XML tag <${unclosed.name}> starting at line ${unclosed.line}, column ${unclosed.column}`);
  }

  if (!root) {
    throw new Error('Empty or invalid XML document.');
  }

  return {
    root,
    stats: {
      elementCount,
      attributeCount,
      commentCount
    }
  };
}

/**
 * Standard comment-preserving XML Formatter that formats consistently with 2-spaces.
 */
export function formatXmlPCF(xmlText) {
  const reg = /(>)\s*(<)(\/*)/g;
  const wspace = xmlText.replace(reg, '$1\r\n$2$3');
  let formatted = '';
  let pad = 0;
  const lines = wspace.split(/\r?\n/);

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
 * Recursively searches tree nodes for matches based on name or attributes.
 */
export function searchNodes(node, query, matches = []) {
  const q = query.toLowerCase().trim();
  if (!q) return matches;

  const nameMatch = node.name.toLowerCase().includes(q);
  const attrMatch = Object.entries(node.attributes).some(([k, v]) => 
    k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q)
  );

  if (nameMatch || attrMatch) {
    matches.push(node);
  }

  node.children.forEach(child => searchNodes(child, query, matches));
  return matches;
}

// UI Wiring
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const pcfInput = document.getElementById('pcfInput');
    const formatBtn = document.getElementById('formatBtn');
    const validateBtn = document.getElementById('validateBtn');
    const clearBtn = document.getElementById('clearBtn');
    const loadSampleBtn = document.getElementById('loadSampleBtn');
    const errorContainer = document.getElementById('errorContainer');
    const resultsPanel = document.getElementById('resultsPanel');
    const copyFormattedBtn = document.getElementById('copyFormattedBtn');
    const xmlTreeContainer = document.getElementById('xmlTreeContainer');
    
    // Details Sidebar Panel Elements
    const detailsPanel = document.getElementById('detailsPanel');
    const detailName = document.getElementById('detailName');
    const detailParent = document.getElementById('detailParent');
    const detailChildren = document.getElementById('detailChildren');
    const detailXPath = document.getElementById('detailXPath');
    const detailAttributes = document.getElementById('detailAttributes');
    const btnCopyXPath = document.getElementById('btnCopyXPath');

    // Document Statistics elements
    const statElements = document.getElementById('statElements');
    const statAttributes = document.getElementById('statAttributes');
    const statComments = document.getElementById('statComments');

    // Search
    const searchNodeInput = document.getElementById('searchNodeInput');
    const btnSearchNode = document.getElementById('btnSearchNode');
    const searchCount = document.getElementById('searchCount');

    let parsedTreeData = null;

    const samplePCF = `<?xml version="1.0"?>
<PCF
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:noNamespaceSchemaLocation="pcf.xsd">
  <!-- Synthetic PCF structure for custom PolicyCenter details -->
  <Card
    id="PolicyInfoCard"
    title="DisplayKeys.get('Web.PolicyFile.PolicyInfo')">
    <CardViewPanel>
      <Variable
        name="policyPeriod"
        type="PolicyPeriod" />
      <DetailViewPanel
        id="PolicyInfoDV">
        <InputColumn>
          <Label
            label="DisplayKeys.get('Web.PolicyInfo.Primary')" />
          <TextInput
            id="PolicyNumber"
            label="DisplayKeys.get('Web.PolicyInfo.PolicyNumber')"
            value="policyPeriod.PolicyNumber" />
          <BooleanRadioInput
            id="Active"
            label="DisplayKeys.get('Web.PolicyInfo.Active')"
            value="policyPeriod.Active" />
        </InputColumn>
      </DetailViewPanel>
    </CardViewPanel>
  </Card>
</PCF>`;

    if (loadSampleBtn) {
      loadSampleBtn.addEventListener('click', () => {
        pcfInput.value = samplePCF;
        pcfInput.dispatchEvent(new Event('input'));
        validateBtn.click();
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        pcfInput.value = '';
        resultsPanel.classList.add('hidden');
        errorContainer.classList.add('hidden');
        detailsPanel.classList.add('hidden');
        parsedTreeData = null;
      });
    }

    if (formatBtn) {
      formatBtn.addEventListener('click', () => {
        const text = pcfInput.value.trim();
        if (!text) return;
        try {
          const formatted = formatXmlPCF(text);
          pcfInput.value = formatted;
          validateBtn.click();
        } catch (err) {
          showError(`Formatting failed: ${err.message}`);
        }
      });
    }

    if (validateBtn) {
      validateBtn.addEventListener('click', () => {
        const text = pcfInput.value.trim();
        if (!text) {
          showError('Please paste XML or PCF contents to validate.');
          return;
        }

        errorContainer.classList.add('hidden');
        resultsPanel.classList.add('hidden');
        detailsPanel.classList.add('hidden');

        try {
          const parsed = parseXmlPure(text);
          parsedTreeData = parsed;

          // Render stats
          statElements.textContent = parsed.stats.elementCount;
          statAttributes.textContent = parsed.stats.attributeCount;
          statComments.textContent = parsed.stats.commentCount;

          // Render tree representation
          xmlTreeContainer.innerHTML = '';
          const treeRoot = renderTreeNodeHTML(parsed.root);
          xmlTreeContainer.appendChild(treeRoot);

          resultsPanel.classList.remove('hidden');

        } catch (err) {
          showError(err.message);
        }
      });
    }

    if (copyFormattedBtn) {
      copyFormattedBtn.addEventListener('click', () => {
        const text = pcfInput.value;
        navigator.clipboard.writeText(text).then(() => {
          const originalText = copyFormattedBtn.textContent;
          copyFormattedBtn.textContent = '✓ Copied!';
          setTimeout(() => {
            copyFormattedBtn.textContent = originalText;
          }, 1500);
        });
      });
    }

    if (btnCopyXPath) {
      btnCopyXPath.addEventListener('click', () => {
        const path = detailXPath.textContent;
        if (!path) return;
        navigator.clipboard.writeText(path).then(() => {
          const originalText = btnCopyXPath.textContent;
          btnCopyXPath.textContent = 'Copied!';
          setTimeout(() => {
            btnCopyXPath.textContent = originalText;
          }, 1500);
        });
      });
    }

    if (btnSearchNode) {
      btnSearchNode.addEventListener('click', () => {
        const query = searchNodeInput.value.trim();
        if (!parsedTreeData || !query) {
          searchCount.textContent = '0 matches';
          // Clear previous highlights
          document.querySelectorAll('.highlight-match').forEach(el => el.classList.remove('highlight-match', 'bg-amber-100'));
          return;
        }

        const matches = searchNodes(parsedTreeData.root, query);
        searchCount.textContent = `${matches.length} matches`;

        // Clear highlights
        document.querySelectorAll('.highlight-match').forEach(el => el.classList.remove('highlight-match', 'bg-amber-100'));

        // Highlight matching elements in the DOM tree by searching matching xpaths
        matches.forEach(node => {
          const matchElement = document.querySelector(`[data-xpath="${node.xpath}"]`);
          if (matchElement) {
            matchElement.classList.add('highlight-match', 'bg-amber-100');
            // Auto expand details parents
            let parentDetails = matchElement.closest('details');
            while (parentDetails) {
              parentDetails.open = true;
              parentDetails = parentDetails.parentElement.closest('details');
            }
          }
        });
      });
    }

    searchNodeInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        btnSearchNode.click();
      }
    });

    function renderTreeNodeHTML(node) {
      const isLeaf = node.children.length === 0;
      const el = document.createElement('div');
      el.className = 'my-1';

      if (isLeaf) {
        el.innerHTML = `
          <div data-xpath="${node.xpath}" class="cursor-pointer select-none font-mono text-xs text-indigo-950 hover:bg-indigo-50/50 p-1 rounded inline-flex items-center gap-1 font-semibold transition-colors" data-node-ref="true">
            &lt;${escapeHtml(node.name)}${Object.keys(node.attributes).length > 0 ? ' ...' : ''}/&gt;
          </div>
        `;
      } else {
        const detailsEl = document.createElement('details');
        detailsEl.className = 'group';
        detailsEl.open = true;

        const summaryEl = document.createElement('summary');
        summaryEl.className = 'list-none cursor-pointer select-none font-mono text-xs text-indigo-950 font-semibold hover:bg-indigo-50/50 p-1 rounded inline-flex items-center gap-1 transition-colors';
        summaryEl.setAttribute('data-xpath', node.xpath);
        summaryEl.setAttribute('data-node-ref', 'true');
        summaryEl.innerHTML = `
          <svg class="w-3.5 h-3.5 text-indigo-500 shrink-0 transform group-open:rotate-90 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
          &lt;${escapeHtml(node.name)}&gt;
        `;

        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'border-l border-indigo-100 pl-4 ml-2.5 space-y-1';

        node.children.forEach(child => {
          childrenContainer.appendChild(renderTreeNodeHTML(child));
        });

        detailsEl.appendChild(summaryEl);
        detailsEl.appendChild(childrenContainer);
        el.appendChild(detailsEl);
      }

      // Wire node click to show sidebar panel details
      const trigger = el.querySelector('[data-node-ref="true"]');
      if (trigger) {
        trigger.addEventListener('click', (e) => {
          e.stopPropagation();
          showNodeDetails(node);
        });
      }

      return el;
    }

    function showNodeDetails(node) {
      detailName.textContent = node.name;
      detailParent.textContent = node.parentName || 'None (Root)';
      detailChildren.textContent = node.children.length;
      detailXPath.textContent = node.xpath;

      // Populate attributes
      detailAttributes.innerHTML = '';
      const entries = Object.entries(node.attributes);
      if (entries.length === 0) {
        detailAttributes.innerHTML = '<li class="text-xs text-slate-400 italic">No attributes defined</li>';
      } else {
        entries.forEach(([key, val]) => {
          const li = document.createElement('li');
          li.className = 'text-xs border-b border-slate-100 py-1 last:border-0 flex justify-between gap-2';
          li.innerHTML = `<span class="font-mono text-indigo-700 font-semibold">${escapeHtml(key)}:</span> <span class="font-mono text-slate-800 break-all select-all">${escapeHtml(val)}</span>`;
          detailAttributes.appendChild(li);
        });
      }

      detailsPanel.classList.remove('hidden');
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
