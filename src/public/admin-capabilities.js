/* Admin Capabilities card — read-only capability/status view (/admin only).
 * Fetches GET /api/admin/assistant/capabilities once on load (plus manual
 * retry). No frameworks, no polling, no timers, no execution. All server data
 * is rendered via textContent; only server-provided /admin URLs become links
 * (validated same-origin admin paths, never user-supplied URLs). */
(function () {
  'use strict';

  var MAX_ITEMS = 25;

  var STATUS_META = {
    ready: { badge: 'badge-healthy', text: 'Ready' },
    partial: { badge: 'badge-warning', text: 'Partial' },
    blocked: { badge: 'badge-critical', text: 'Blocked' },
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

  // Only same-origin admin navigation targets may become clickable links.
  function isSafeAdminUrl(url) {
    return typeof url === 'string' && /^\/admin([#?/]|$)/.test(url);
  }

  function setStatus(state) {
    var badge = el('capabilities-status');
    if (!badge) return;
    var meta = STATUS_META[state] || STATUS_META.error;
    badge.className = 'badge ' + meta.badge;
    badge.textContent = meta.text;
  }

  function showError(message) {
    var error = el('capabilities-error');
    var retry = el('capabilities-retry');
    if (error) {
      error.textContent = message;
      error.style.display = '';
    }
    if (retry) retry.style.display = '';
    setStatus('error');
  }

  function renderList(listNode, capabilities) {
    clear(listNode);
    var items = (capabilities || []).slice(0, MAX_ITEMS);
    if (!items.length) {
      var none = document.createElement('li');
      none.className = 'muted';
      none.style.fontSize = '13px';
      none.textContent = 'No capabilities available.';
      listNode.appendChild(none);
      return;
    }
    items.forEach(function (cap) {
      var item = document.createElement('li');
      item.style.marginBottom = '6px';
      item.style.fontSize = '13px';
      var name = document.createElement('strong');
      name.textContent = cap.label || cap.id || 'Capability';
      item.appendChild(name);
      var meta = document.createElement('span');
      meta.className = 'muted';
      meta.textContent = ' · ' + (cap.category || 'uncategorized') + ' · read-only' + (cap.available === false ? ' · unavailable' : '');
      item.appendChild(meta);
      var desc = document.createElement('div');
      desc.className = 'muted';
      desc.textContent = cap.description || '';
      item.appendChild(desc);
      if (isSafeAdminUrl(cap.url)) {
        var link = document.createElement('a');
        link.href = cap.url;
        link.textContent = 'Open in admin';
        link.style.fontSize = '12px';
        item.appendChild(link);
      }
      listNode.appendChild(item);
    });
  }

  function render(payload) {
    var summary = el('capabilities-summary');
    var list = el('capabilities-list');
    if (!payload || payload.ok !== true || !payload.preflight || !Array.isArray(payload.capabilities)) {
      showError('Capability status unavailable. Try again shortly.');
      return;
    }
    var status = payload.preflight.status;
    setStatus(status === 'ready' || status === 'partial' || status === 'blocked' ? status : 'error');
    if (summary) summary.textContent = payload.preflight.summary || 'Capability status loaded.';
    if (list) renderList(list, payload.capabilities);
    var error = el('capabilities-error');
    if (error) error.style.display = 'none';
    var retry = el('capabilities-retry');
    if (retry) retry.style.display = 'none';
  }

  function load() {
    var summary = el('capabilities-summary');
    if (summary) summary.textContent = 'Loading capability status…';
    setStatus('loading');
    fetch('/api/admin/assistant/capabilities', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (body) {
        render(body);
      })
      .catch(function () {
        var list = el('capabilities-list');
        if (list) clear(list);
        var s = el('capabilities-summary');
        if (s) s.textContent = 'Capability status could not be loaded.';
        showError('Capabilities unavailable. Check your connection and try again.');
      });
  }

  function init() {
    // Card may be absent on other pages; never fail in that case.
    if (!el('capabilities-card')) return;
    var retry = el('capabilities-retry');
    if (retry) retry.addEventListener('click', load);
    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
