const input = document.querySelector('#searchInput');
const results = document.querySelector('#searchResults');
let timer;

if (input && results) {
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) {
      results.style.display = 'none';
      results.innerHTML = '';
      return;
    }

    timer = setTimeout(async () => {
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var tId = controller ? setTimeout(function(){ try{ controller.abort(); }catch(e){} }, 6000) : null;
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' }, signal: controller ? controller.signal : undefined });
        if (tId) clearTimeout(tId);
        if (!response.ok) return;
        const data = await response.json();
        results.innerHTML = data.results.length
          ? data.results.map(item => `<a href="/query/${item.path.split('/').map(encodeURIComponent).join('/')}"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.category)}</small></a>`).join('')
          : '<div class="empty-search">No matching content.</div>';
        results.style.display = 'block';
      } catch (err) {
        if (tId) clearTimeout(tId);
        if (err && err.name === 'AbortError') {
          results.innerHTML = '<div class="empty-search">Search timed out. Try again.</div>';
          results.style.display = 'block';
          setTimeout(function(){ results.style.display='none'; }, 2000);
        } else {
          results.style.display = 'none';
        }
      }
    }, 200);
  });

  document.addEventListener('click', event => {
    if (!event.target.closest('.search')) results.style.display = 'none';
  });
}

const copyButton = document.querySelector('#copyButton');
if (copyButton) {
  copyButton.addEventListener('click', async () => {
    const code = document.querySelector('#queryCode').textContent;
    const original = copyButton.textContent;
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var tid = ctl ? setTimeout(function(){ try{ ctl.abort(); }catch(e){} }, 6000) : null;
    try {
      await navigator.clipboard.writeText(code);
      const response = await fetch('/api/query-copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ path: copyButton.dataset.path }),
        signal: ctl ? ctl.signal : undefined
      });
      if (tid) clearTimeout(tid);
      if (!response.ok) throw new Error('Copy event could not be recorded.');
      copyButton.textContent = 'Copied';
    } catch {
      if (tid) clearTimeout(tid);
      copyButton.textContent = 'Copy failed';
    } finally {
      if (tid) clearTimeout(tid);
    }
    setTimeout(() => { copyButton.textContent = original; }, 1400);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

// External/public links (YouTube etc.) should navigate to external site normally.
// Preserve internal navigation: only bypass handling for absolute external origins.
// This ensures no global interceptor prevents external navigation.
(function() {
  function isExternalHref(href) {
    if (!href) return false;
    // Absolute http(s) URL that is not same-origin
    if (/^https?:\/\//i.test(href)) {
      try {
        var url = new URL(href, window.location.href);
        return url.origin !== window.location.origin;
      } catch (e) { return false; }
    }
    return false;
  }
  document.addEventListener('click', function(event) {
    var a = event.target.closest && event.target.closest('a');
    if (!a) return;
    var href = a.getAttribute('href');
    if (isExternalHref(href)) {
      // Allow normal browser navigation to external site; do not prevent/alter.
      // Ensure target blank is not forced by internal handlers.
      return;
    }
    // Internal links handled normally (no override)
  }, true);

  // Also ensure dynamically rendered external anchors have correct rel
  function enhanceExternalAnchors() {
    document.querySelectorAll('a[href^="http://"], a[href^="https://"]').forEach(function(a) {
      try {
        var url = new URL(a.href, window.location.href);
        if (url.origin !== window.location.origin) {
          if (!a.getAttribute('target')) a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        }
      } catch {}
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhanceExternalAnchors);
  } else {
    enhanceExternalAnchors();
  }
})();
