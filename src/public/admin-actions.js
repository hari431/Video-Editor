/* Diagnostic Actions card — explicit select-and-confirm UI (/admin only).
 * Lists the 5 declared read-only diagnostic plans below. Nothing executes on
 * page load and nothing executes on selection: a Run click after an explicit
 * confirmation is the only path to POST /api/admin/assistant/execute, and the
 * request body is always exactly { actionId }. All server data is rendered
 * via textContent; only server-provided /admin URLs become links
 * (validated same-origin admin paths, never user-supplied URLs).
 * No frameworks, no polling, no timers, no auto-execution. */
(function () {
  'use strict';

  // Client-side allowlist mirroring the server registry in
  // src/admin-assistant/actions.js. The server re-validates every id and
  // stays authoritative; a parity test pins this list to the registry.
  var ACTIONS = [
    { id: 'access.review-queue', label: 'Review pending access queue', description: 'Plan a review of pending and expiring access from the access overview.' },
    { id: 'attention.triage', label: 'Triage discussions needing attention', description: 'Plan a triage pass over unanswered and hidden discussions.' },
    { id: 'health.snapshot', label: 'Capture runtime health snapshot', description: 'Plan a read of the current runtime health indicators.' },
    { id: 'integrity.reconcile', label: 'Reconcile integrity diagnostics', description: 'Plan a review of integrity check results with admin evidence links.' },
    { id: 'brief.compose', label: 'Compose full admin brief plan', description: 'Plan a full brief read across every evidence section.' }
  ];

  var MAX_FINDINGS = 6;
  var MAX_REFS_PER_FINDING = 3;

  var selectedId = null;
  var running = false;

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

  // Only same-origin admin navigation targets may become clickable links.
  function isSafeAdminUrl(url) {
    return typeof url === 'string' && /^\/admin([#?/]|$)/.test(url);
  }

  function setStatus(state, label) {
    var badge = el('actions-status');
    if (!badge) return;
    var states = {
      idle: 'badge badge-neutral',
      confirm: 'badge badge-neutral',
      running: 'badge badge-neutral',
      executed: 'badge badge-healthy',
      blocked: 'badge badge-warning',
      unavailable: 'badge badge-neutral',
      error: 'badge badge-critical'
    };
    badge.className = states[state] || states.error;
    badge.textContent = label || state;
  }

  function hideConfirm() {
    var confirm = el('actions-confirm');
    if (confirm) confirm.style.display = 'none';
    selectedId = null;
    setStatus('idle', 'Idle');
  }

  function showConfirm(action) {
    selectedId = action.id;
    var label = el('actions-confirm-label');
    var desc = el('actions-confirm-desc');
    var confirm = el('actions-confirm');
    if (label) label.textContent = action.label;
    if (desc) desc.textContent = action.description;
    if (confirm) confirm.style.display = '';
    hideResult();
    hideError();
    setStatus('confirm', 'Confirm');
  }

  function hideResult() {
    var result = el('actions-result');
    if (result) {
      clear(result);
      result.style.display = 'none';
    }
  }

  function hideError() {
    var error = el('actions-error');
    if (error) error.style.display = 'none';
  }

  function showError(message) {
    var error = el('actions-error');
    if (error) {
      error.textContent = message;
      error.style.display = '';
    }
    setStatus('error', 'Error');
  }

  function addEvidenceLinks(container, refs, max) {
    var shown = 0;
    for (var i = 0; i < (refs || []).length && shown < max; i++) {
      var r = refs[i];
      if (!r || !isSafeAdminUrl(r.url)) continue;
      var link = document.createElement('a');
      link.href = r.url;
      link.textContent = 'Show evidence';
      link.style.marginRight = '8px';
      link.style.fontSize = '12px';
      container.appendChild(link);
      shown++;
    }
  }

  function renderExecuted(box, payload) {
    box.appendChild(text('p', payload.summary || 'Diagnostic complete.', ''));
    var findings = Array.isArray(payload.findings) ? payload.findings.slice(0, MAX_FINDINGS) : [];
    if (findings.length) {
      var list = document.createElement('ul');
      list.style.margin = '8px 0 0';
      list.style.paddingLeft = '18px';
      findings.forEach(function (f) {
        var item = document.createElement('li');
        item.style.fontSize = '13px';
        item.textContent = (f.title || 'Finding') + ' (' + (f.level || 'info') + ')';
        var links = document.createElement('div');
        addEvidenceLinks(links, f.evidenceRefs, MAX_REFS_PER_FINDING);
        item.appendChild(links);
        list.appendChild(item);
      });
      box.appendChild(list);
    }
    setStatus('executed', 'Done');
  }

  function renderResult(payload) {
    var box = el('actions-result');
    if (!box) return;
    clear(box);
    box.style.display = '';
    if (!payload || typeof payload !== 'object') {
      showError('Diagnostic result unavailable. Try again shortly.');
      return;
    }
    if (payload.ok === true && payload.status === 'executed') {
      renderExecuted(box, payload);
      return;
    }
    // Blocked / unavailable / execution-failed: server messages are generic
    // by contract — render them as text, never internals.
    var state = payload.status === 'blocked' ? 'blocked' : 'unavailable';
    box.appendChild(text('p', payload.message || 'Diagnostic could not run.', 'muted'));
    if (payload.reason) box.appendChild(text('p', 'Reason: ' + payload.reason, 'muted'));
    setStatus(state, state === 'blocked' ? 'Blocked' : 'Unavailable');
  }

  function setRunning(isRunning) {
    running = isRunning;
    var run = el('actions-run');
    var cancel = el('actions-cancel');
    if (run) {
      run.disabled = isRunning;
      run.textContent = isRunning ? 'Running…' : 'Run diagnostic';
    }
    if (cancel) cancel.disabled = isRunning;
    if (isRunning) setStatus('running', 'Running…');
  }

  function runSelected() {
    if (running || !selectedId) return;
    var id = selectedId;
    setRunning(true);
    hideError();
    fetch('/api/admin/assistant/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ actionId: id })
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          return { status: res.status, ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        setRunning(false);
        if (result.body && (result.body.status === 'executed' || result.body.status === 'blocked' || result.body.status === 'unavailable')) {
          renderResult(result.body);
          return;
        }
        showError('Diagnostic unavailable. Try again shortly.');
      })
      .catch(function () {
        setRunning(false);
        showError('Diagnostic unavailable. Check your connection and try again.');
      });
  }

  function renderActionList() {
    var list = el('actions-list');
    if (!list) return;
    clear(list);
    ACTIONS.forEach(function (action) {
      var item = document.createElement('li');
      item.style.marginBottom = '6px';
      item.style.fontSize = '13px';
      var name = document.createElement('strong');
      name.textContent = action.label;
      item.appendChild(name);
      var desc = document.createElement('div');
      desc.className = 'muted';
      desc.textContent = action.description;
      item.appendChild(desc);
      var select = document.createElement('button');
      select.type = 'button';
      select.className = 'button small secondary';
      select.textContent = 'Select';
      select.addEventListener('click', function () { showConfirm(action); });
      item.appendChild(select);
      list.appendChild(item);
    });
  }

  function init() {
    // Card may be absent on other pages; never fail in that case.
    if (!el('actions-card')) return;
    // Explicit list render only — no fetch, no auto-execution on load.
    renderActionList();
    var run = el('actions-run');
    var cancel = el('actions-cancel');
    if (run) run.addEventListener('click', runSelected);
    if (cancel) cancel.addEventListener('click', hideConfirm);
    setStatus('idle', 'Idle');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
