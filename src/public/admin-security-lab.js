/* Security Lab card — tool catalog + controlled runs (/admin/ai only).
 * Loads GET /api/admin/security-lab/tools (catalog) and GET
 * /api/admin/security-lab/status (install state) once on load, plus manual
 * retry. POST /api/admin/security-lab/execute fires ONLY from an explicit
 * two-step user action (Run → Confirm run) on a ready tool; never
 * automatically, never on load. No frameworks, no polling, no timers, no
 * streaming. All server data is rendered via textContent; source URLs become
 * links only when they match the https://github.com/ allowlist; version
 * strings are never links. Run buttons exist only for catalog tools flagged
 * `executionAllowed` that also report status `ready`. */
(function () {
  'use strict';

  var MAX_ITEMS = 25;
  var TOOLS_ENDPOINT = '/api/admin/security-lab/tools';
  var STATUS_ENDPOINT = '/api/admin/security-lab/status';
  var EXECUTE_ENDPOINT = '/api/admin/security-lab/execute';

  // Allowed input per executable tool (mirrors the server schemas exactly).
  var RUNNABLE = {
    gitleaks: { field: 'path', label: 'Repo-relative path under queries/ or src/', placeholder: 'queries' },
    trivy: { field: 'path', label: 'Repo-relative path under queries/ or src/', placeholder: 'queries' },
    httpx: { field: 'target', label: 'Public hostname or IP (no URLs, ports, or paths)', placeholder: 'example.com' },
    binwalk: { field: 'path', label: 'Repo-relative path under queries/ or src/', placeholder: 'queries' },
    subfinder: { field: 'domain', label: 'Domain for passive subdomain enumeration (no URLs or IPs)', placeholder: 'example.com' },
    theharvester: { field: 'domain', label: 'Domain for keyless passive OSINT (crtsh, certspotter)', placeholder: 'example.com' },
    amass: { field: 'domain', label: 'Domain for controlled enum reconnaissance (no URLs or IPs)', placeholder: 'example.com' },
    testssl: { field: 'target', label: 'Public hostname or IP for TLS analysis (default port 443)', placeholder: 'example.com' },
    wafw00f: { field: 'target', label: 'Public hostname or IP for WAF fingerprinting', placeholder: 'example.com' },
    gobuster: { field: 'target', label: 'Public hostname or IP for directory discovery (fixed wordlist, 10 threads)', placeholder: 'example.com' },
    dirsearch: { field: 'target', label: 'Public hostname or IP for web path discovery (non-recursive)', placeholder: 'example.com' }
  };

  var BADGE_META = {
    ready: { badge: 'badge-healthy', text: 'Ready' },
    loading: { badge: 'badge-neutral', text: 'Loading…' },
    error: { badge: 'badge-critical', text: 'Error' }
  };

  function el(id) {
    return document.getElementById(id);
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function text(tag, content, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = content == null ? '' : String(content);
    return node;
  }

  // Only upstream GitHub project pages may become clickable links.
  function isSafeSourceUrl(url) {
    return typeof url === 'string' && /^https:\/\/github\.com\//.test(url);
  }

  function setStatus(state) {
    var badge = el('security-lab-status');
    if (!badge) return;
    var meta = BADGE_META[state] || BADGE_META.error;
    badge.className = 'badge ' + meta.badge;
    badge.textContent = meta.text;
  }

  function showError(message) {
    var error = el('security-lab-error');
    var retry = el('security-lab-retry');
    if (error) {
      error.textContent = message;
      error.style.display = '';
    }
    if (retry) retry.style.display = '';
    setStatus('error');
  }

  function hideError() {
    var error = el('security-lab-error');
    if (error) error.style.display = 'none';
    var retry = el('security-lab-retry');
    if (retry) retry.style.display = 'none';
  }

  function renderDisabled(listNode, tools) {
    clear(listNode);
    var items = (tools || []).filter(function (tool) { return tool.executionAllowed !== true; }).slice(0, MAX_ITEMS);
    if (!items.length) return;
    items.forEach(function (tool) {
      var item = document.createElement('li');
      item.style.marginBottom = '6px';
      item.style.fontSize = '13px';
      var name = document.createElement('strong');
      name.textContent = tool.name || tool.id || 'Security tool';
      item.appendChild(name);
      var meta = document.createElement('span');
      meta.className = 'muted';
      meta.textContent = ' · ' + (tool.category || 'uncategorized') + ' · ' + (tool.riskLevel || 'low') + ' risk · read-only';
      item.appendChild(meta);
      var desc = document.createElement('div');
      desc.className = 'muted';
      desc.textContent = tool.description || '';
      item.appendChild(desc);
      if (isSafeSourceUrl(tool.sourceUrl)) {
        var link = document.createElement('a');
        link.href = tool.sourceUrl;
        link.textContent = 'Upstream source';
        link.style.fontSize = '12px';
        link.setAttribute('rel', 'noreferrer');
        item.appendChild(link);
      }
      listNode.appendChild(item);
    });
  }

  function statusText(state) {
    if (state && state.status === 'ready') {
      return state.version ? 'Ready · ' + state.version : 'Ready';
    }
    if (state && state.status === 'not-installed') return 'Not installed';
    return 'Unavailable';
  }

  function renderResult(box, result) {
    clear(box);
    box.appendChild(text('p', 'Result: ' + (result.status || 'unknown'), 'muted'));
    box.appendChild(text('p', result.message || '', 'muted'));
    if (result.truncated) box.appendChild(text('p', 'Output truncated to server bounds.', 'muted'));
    if (result.stdout) {
      box.appendChild(text('div', 'Standard output:', 'muted'));
      var out = document.createElement('pre');
      out.style.whiteSpace = 'pre-wrap';
      out.style.fontSize = '12px';
      out.textContent = result.stdout;
      box.appendChild(out);
    }
    if (result.stderr) {
      box.appendChild(text('div', 'Standard error:', 'muted'));
      var err = document.createElement('pre');
      err.style.whiteSpace = 'pre-wrap';
      err.style.fontSize = '12px';
      err.textContent = result.stderr;
      box.appendChild(err);
    }
  }

  function executeTool(toolId, input, controls, box) {
    if (controls.running) return;
    controls.running = true;
    controls.run.disabled = true;
    controls.confirm.disabled = true;
    controls.cancel.disabled = true;
    controls.input.disabled = true;
    controls.run.textContent = 'Running…';
    // Exact execution contract: nothing but toolId + input.
    fetch(EXECUTE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ toolId: toolId, input: input })
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          return { status: res.status, ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        controls.running = false;
        controls.run.disabled = false;
        controls.confirm.style.display = 'none';
        controls.cancel.style.display = 'none';
        controls.run.style.display = '';
        controls.run.textContent = 'Run';
        controls.input.disabled = false;
        controls.cancel.disabled = false;
        if (result.body && result.body.result && typeof result.body.result.status === 'string') {
          renderResult(box, result.body.result);
          return;
        }
        var message = (result.body && result.body.error) || 'Tool run unavailable. Try again shortly.';
        if (result.status === 429) message = 'Rate limit exceeded. Try again shortly.';
        clear(box);
        box.appendChild(text('p', message, 'muted'));
      })
      .catch(function () {
        controls.running = false;
        controls.run.disabled = false;
        controls.confirm.style.display = 'none';
        controls.cancel.style.display = 'none';
        controls.run.style.display = '';
        controls.run.textContent = 'Run';
        controls.input.disabled = false;
        controls.cancel.disabled = false;
        clear(box);
        box.appendChild(text('p', 'Tool run unavailable. Check your connection and try again.', 'muted'));
      });
  }

  function renderEnabled(listNode, tools, statusById) {
    clear(listNode);
    var items = (tools || []).filter(function (tool) { return tool.executionAllowed === true; }).slice(0, MAX_ITEMS);
    if (!items.length) {
      var none = document.createElement('li');
      none.className = 'muted';
      none.style.fontSize = '13px';
      none.textContent = 'No runnable tools registered.';
      listNode.appendChild(none);
      return;
    }
    items.forEach(function (tool) {
      var spec = RUNNABLE[tool.id];
      var state = statusById[tool.id];
      var item = document.createElement('li');
      item.style.marginBottom = '10px';
      item.style.fontSize = '13px';
      var name = document.createElement('strong');
      name.textContent = tool.name || tool.id || 'Security tool';
      item.appendChild(name);
      var meta = document.createElement('span');
      meta.className = 'muted';
      meta.textContent = ' · ' + (tool.category || 'uncategorized') + ' · ' + (tool.riskLevel || 'low') + ' risk · ' + statusText(state);
      item.appendChild(meta);
      var desc = document.createElement('div');
      desc.className = 'muted';
      desc.textContent = tool.description || '';
      item.appendChild(desc);
      // Run controls exist only for known executable tools whose spec matches
      // the server schema; the button appears only when the tool is ready.
      if (!spec || !state || state.status !== 'ready') {
        if (state && state.status === 'not-installed') {
          item.appendChild(text('div', 'Not installed on the server — run unavailable.', 'muted'));
        }
        listNode.appendChild(item);
        return;
      }
      var form = document.createElement('div');
      form.style.marginTop = '4px';
      var label = document.createElement('label');
      label.className = 'muted';
      label.style.fontSize = '12px';
      label.textContent = spec.label;
      form.appendChild(label);
      var row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '8px';
      row.style.marginTop = '4px';
      row.style.flexWrap = 'wrap';
      var input = document.createElement('input');
      input.type = 'text';
      input.placeholder = spec.placeholder;
      input.maxLength = 512;
      input.autocomplete = 'off';
      input.style.flex = '1';
      input.style.minWidth = '180px';
      input.style.padding = '6px 8px';
      input.style.border = '1px solid #cbd5e1';
      input.style.borderRadius = '8px';
      input.style.fontSize = '13px';
      row.appendChild(input);
      var controls = { running: false };
      var confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'button small';
      confirm.textContent = 'Confirm run';
      confirm.style.display = 'none';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'button small secondary';
      cancel.textContent = 'Cancel';
      cancel.style.display = 'none';
      var run = document.createElement('button');
      run.type = 'button';
      run.className = 'button small secondary';
      run.textContent = 'Run';
      controls.run = run;
      controls.confirm = confirm;
      controls.cancel = cancel;
      controls.input = input;
      var box = document.createElement('div');
      box.style.marginTop = '6px';
      run.addEventListener('click', function () {
        if (controls.running) return;
        run.style.display = 'none';
        confirm.style.display = '';
        cancel.style.display = '';
      });
      cancel.addEventListener('click', function () {
        if (controls.running) return;
        confirm.style.display = 'none';
        cancel.style.display = 'none';
        run.style.display = '';
      });
      confirm.addEventListener('click', function () {
        if (controls.running) return;
        var value = input.value;
        var payload = {};
        payload[spec.field] = value;
        executeTool(tool.id, payload, controls, box);
      });
      row.appendChild(run);
      row.appendChild(confirm);
      row.appendChild(cancel);
      form.appendChild(row);
      item.appendChild(form);
      item.appendChild(box);
      listNode.appendChild(item);
    });
  }

  function getJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function toolsUrl() {
    // Optional server-side filters exist only on the dedicated page; the
    // /admin/ai card has no filter inputs and always loads the full catalog.
    var q = el('security-lab-filter-q');
    var category = el('security-lab-filter-category');
    var risk = el('security-lab-filter-risk');
    if (!q && !category && !risk) return TOOLS_ENDPOINT;
    var params = [];
    if (q && q.value.trim()) params.push('q=' + encodeURIComponent(q.value.trim().slice(0, 120)));
    if (category && category.value) params.push('category=' + encodeURIComponent(category.value));
    if (risk && risk.value) params.push('riskLevel=' + encodeURIComponent(risk.value));
    return params.length ? TOOLS_ENDPOINT + '?' + params.join('&') : TOOLS_ENDPOINT;
  }

  function load() {
    var summary = el('security-lab-summary');
    var note = el('security-lab-enabled-note');
    if (summary) summary.textContent = 'Loading security tool catalog…';
    if (note) note.textContent = 'Checking tool availability…';
    setStatus('loading');
    Promise.all([getJson(toolsUrl()), getJson(STATUS_ENDPOINT)])
      .then(function (results) {
        var catalog = results[0];
        var status = results[1];
        if (!catalog || catalog.ok !== true || !Array.isArray(catalog.tools)) {
          throw new Error('catalog');
        }
        var statusById = {};
        if (status && status.ok === true && Array.isArray(status.tools)) {
          status.tools.forEach(function (entry) {
            if (entry && typeof entry.toolId === 'string') statusById[entry.toolId] = entry;
          });
        }
        var enabled = el('security-lab-enabled-list');
        var list = el('security-lab-list');
        if (enabled) renderEnabled(enabled, catalog.tools, statusById);
        if (list) renderDisabled(list, catalog.tools);
        var readyCount = Object.keys(statusById).filter(function (id) { return statusById[id].status === 'ready'; }).length;
        if (summary) summary.textContent = 'Registered tools: ' + catalog.tools.length + '. Runs, where enabled, are admin-only.';
        if (note) note.textContent = readyCount > 0 ? readyCount + ' tool(s) ready to run.' : 'No executable tools currently installed.';
        setStatus('ready');
        hideError();
      })
      .catch(function () {
        var enabled = el('security-lab-enabled-list');
        var list = el('security-lab-list');
        if (enabled) clear(enabled);
        if (list) clear(list);
        var s = el('security-lab-summary');
        if (s) s.textContent = 'Security tool catalog could not be loaded.';
        showError('Security Lab catalog unavailable. Check your connection and try again.');
      });
  }

  function init() {
    // Card may be absent on other pages; never fail in that case.
    if (!el('security-lab-card')) return;
    var retry = el('security-lab-retry');
    if (retry) retry.addEventListener('click', load);
    var filters = el('security-lab-filters');
    if (filters) {
      filters.addEventListener('submit', function (event) {
        event.preventDefault();
        load();
      });
    }
    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
