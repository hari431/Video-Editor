/* Admin Assistant card — deterministic brief + question box (/admin only).
 * No frameworks, no polling, no timers, no streaming. All server data is
 * rendered via textContent; only server-provided /admin URLs become links
 * (validated same-origin admin paths, never user-supplied URLs). */
(function () {
  'use strict';

  var MAX_QUESTION_CHARS = 500;
  var MAX_TOP_RISKS = 5;
  var MAX_REFS_PER_FINDING = 3;

  var STATUS_META = {
    healthy: { badge: 'badge-healthy', text: 'Healthy' },
    attention: { badge: 'badge-warning', text: 'Attention' },
    unavailable: { badge: 'badge-neutral', text: 'Unavailable' },
    loading: { badge: 'badge-neutral', text: 'Loading…' },
    error: { badge: 'badge-critical', text: 'Error' }
  };

  var LEVEL_BADGE = {
    critical: 'badge-critical',
    warning: 'badge-warning',
    info: 'badge-neutral'
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
    var badge = el('assistant-status');
    if (!badge) return;
    var meta = STATUS_META[state] || STATUS_META.error;
    badge.className = 'badge ' + meta.badge;
    badge.textContent = meta.text;
  }

  function showBriefError(message) {
    var error = el('assistant-error');
    var retry = el('assistant-retry');
    if (error) {
      error.textContent = message;
      error.style.display = '';
    }
    if (retry) retry.style.display = '';
    setStatus('error');
  }

  function addEvidenceLinks(container, refs, max) {
    var safe = (refs || []).filter(function (r) { return r && isSafeAdminUrl(r.url); });
    var shown = safe.slice(0, max);
    for (var i = 0; i < shown.length; i++) {
      var link = document.createElement('a');
      link.href = shown[i].url;
      link.textContent = 'Show evidence';
      link.style.marginRight = '8px';
      link.style.fontSize = '12px';
      container.appendChild(link);
    }
    if (safe.length > shown.length) {
      var more = document.createElement('span');
      more.className = 'muted';
      more.style.fontSize = '12px';
      more.textContent = '+' + (safe.length - shown.length) + ' more in brief';
      container.appendChild(more);
    }
  }

  function renderRiskList(listNode, risks) {
    clear(listNode);
    if (!risks || !risks.length) {
      var none = document.createElement('li');
      none.className = 'muted';
      none.style.fontSize = '13px';
      none.textContent = 'Nothing needs your attention in this brief.';
      listNode.appendChild(none);
      return;
    }
    risks.slice(0, MAX_TOP_RISKS).forEach(function (risk) {
      var item = document.createElement('li');
      item.style.marginBottom = '6px';
      item.style.fontSize = '13px';
      var badge = document.createElement('span');
      badge.className = 'badge ' + (LEVEL_BADGE[risk.level] || LEVEL_BADGE.info);
      badge.textContent = risk.level || 'info';
      item.appendChild(badge);
      item.appendChild(document.createTextNode(' ' + (risk.title || 'Finding')));
      var links = document.createElement('div');
      addEvidenceLinks(links, risk.evidenceRefs, MAX_REFS_PER_FINDING);
      item.appendChild(links);
      listNode.appendChild(item);
    });
  }

  function renderBrief(brief) {
    var headline = el('assistant-headline');
    var list = el('assistant-findings');
    if (!brief || typeof brief !== 'object') {
      showBriefError('Assistant brief unavailable. Try again shortly.');
      return;
    }
    setStatus(brief.overall === 'healthy' || brief.overall === 'attention' || brief.overall === 'unavailable' ? brief.overall : 'error');
    if (headline) headline.textContent = brief.headline || 'Brief unavailable.';
    if (list) renderRiskList(list, brief.topRisks);
    var error = el('assistant-error');
    if (error) error.style.display = 'none';
    var retry = el('assistant-retry');
    if (retry) retry.style.display = 'none';
  }

  function loadBrief() {
    var headline = el('assistant-headline');
    if (headline) headline.textContent = 'Loading the deterministic admin brief…';
    setStatus('loading');
    fetch('/api/admin/assistant/brief', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (body) {
        if (!body || body.ok !== true || !body.brief) throw new Error('bad brief payload');
        renderBrief(body.brief);
      })
      .catch(function () {
        var list = el('assistant-findings');
        if (list) clear(list);
        var h = el('assistant-headline');
        if (h) h.textContent = 'The assistant brief could not be loaded.';
        showBriefError('Assistant unavailable. Check your connection and try again.');
      });
  }

  function setAsking(isAsking) {
    var button = el('assistant-ask');
    var input = el('assistant-question');
    if (button) {
      button.disabled = isAsking;
      button.textContent = isAsking ? 'Asking…' : 'Ask';
    }
    if (input) input.disabled = isAsking;
  }

  function showAnswerMessage(message) {
    var box = el('assistant-answer');
    if (!box) return;
    clear(box);
    box.style.display = '';
    box.appendChild(text('p', message, 'muted'));
  }

  function renderAnswer(payload, question) {
    var box = el('assistant-answer');
    if (!box) return;
    clear(box);
    box.style.display = '';
    box.appendChild(text('p', 'You asked: ' + question, 'muted'));
    box.appendChild(text('p', payload.answer || 'No answer returned.', ''));
    if (payload.findings && payload.findings.length) {
      var list = document.createElement('ul');
      list.style.margin = '8px 0 0';
      list.style.paddingLeft = '18px';
      payload.findings.forEach(function (f) {
        var item = document.createElement('li');
        item.style.fontSize = '13px';
        item.textContent = f.title || 'Finding';
        var links = document.createElement('div');
        addEvidenceLinks(links, f.evidenceRefs, MAX_REFS_PER_FINDING);
        item.appendChild(links);
        list.appendChild(item);
      });
      box.appendChild(list);
    } else if (payload.evidenceRefs && payload.evidenceRefs.length) {
      var refs = document.createElement('div');
      addEvidenceLinks(refs, payload.evidenceRefs, MAX_REFS_PER_FINDING * 2);
      box.appendChild(refs);
    }
  }

  function renderUnsupported(payload) {
    var box = el('assistant-answer');
    if (!box) return;
    clear(box);
    box.style.display = '';
    box.appendChild(text('p', 'That question is outside the supported admin topics. No answer was generated.', 'muted'));
    if (payload && payload.supported && payload.supported.length) {
      box.appendChild(text('p', 'Supported topics:', 'muted'));
      var list = document.createElement('ul');
      list.style.margin = '4px 0 0';
      list.style.paddingLeft = '18px';
      payload.supported.forEach(function (label) {
        var item = document.createElement('li');
        item.style.fontSize = '13px';
        item.textContent = label;
        list.appendChild(item);
      });
      box.appendChild(list);
    }
  }

  function statusMessage(status, serverError) {
    if (status === 400) return (serverError || 'Invalid question.').slice(0, 200);
    if (status === 401 || status === 403) return 'Your session has expired or you lack admin access. Reload and sign in again.';
    if (status === 429) return 'Too many requests. Wait a minute and try again.';
    return 'Assistant unavailable. Try again shortly.';
  }

  function askQuestion(question) {
    setAsking(true);
    fetch('/api/admin/assistant/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ question: question })
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          return { status: res.status, ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        setAsking(false);
        if (result.ok && result.body && result.body.ok === true) {
          renderAnswer(result.body, question);
          return;
        }
        if (result.status === 422) {
          renderUnsupported(result.body);
          return;
        }
        var serverError = result.body && typeof result.body.error === 'string' ? result.body.error : null;
        showAnswerMessage(statusMessage(result.status, serverError));
      })
      .catch(function () {
        setAsking(false);
        showAnswerMessage('Assistant unavailable. Check your connection and try again.');
      });
  }

  function init() {
    // Card may be absent on other pages; never fail in that case.
    if (!el('assistant-card')) return;
    var retry = el('assistant-retry');
    if (retry) retry.addEventListener('click', loadBrief);
    var form = el('assistant-form');
    var input = el('assistant-question');
    if (form && input) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var question = (input.value || '').replace(/\s+/g, ' ').trim();
        if (!question) {
          showAnswerMessage('Type a question about admin data first.');
          return;
        }
        if (question.length > MAX_QUESTION_CHARS) {
          showAnswerMessage('Keep questions under ' + MAX_QUESTION_CHARS + ' characters.');
          return;
        }
        askQuestion(question);
      });
    }
    loadBrief();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
