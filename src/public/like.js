document.addEventListener('click', function (event) {
  const btn = event.target.closest('.like-btn');
  if (!btn) return;
  const path = btn.getAttribute('data-path');
  if (!path) return;

  // Prevent card navigation if nested inside a card
  if (btn.classList.contains('card-like-btn') || btn.closest('.card')) {
    event.preventDefault();
    event.stopPropagation();
  }

  const control = btn.closest('.like-control');
  const countEl = control ? control.querySelector('.like-count') : null;
  const heartEl = control ? control.querySelector('.heart-icon') : null;
  const labelEl = control ? control.querySelector('.like-btn-label') : null;
  const originalHtml = btn.innerHTML;

  if (btn.disabled) return;
  btn.disabled = true;

  // Temporary visual feedback
  if (heartEl) {
    heartEl.textContent = '⏳';
  } else {
    btn.textContent = '...';
  }

  var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timeoutId = controller ? setTimeout(function(){ try{ controller.abort(); }catch(e){} }, 8000) : null;
  fetch('/api/like/' + path.split('/').map(encodeURIComponent).join('/'), {
    method: 'POST',
    headers: { 'X-CSRF-Token': document.querySelector('meta[name=csrf-token]')?.content },
    credentials: 'include',
    signal: controller ? controller.signal : undefined
  })
    .then(async function(response) {
      var data = await response.json().catch(function(){ return {}; });
      if (!response.ok) throw new Error(data.error || data.message || 'HTTP ' + response.status);
      
      if (countEl) countEl.textContent = data.likeCount;
      
      if (heartEl) {
        heartEl.textContent = data.liked ? '❤️' : '🤍';
        btn.classList.toggle('liked', data.liked);
        btn.style.color = data.liked ? '#ef4444' : '#64748b';
      } else if (labelEl) {
        labelEl.textContent = data.liked ? 'Unlike' : 'Like';
      } else {
        btn.textContent = data.liked ? 'Unlike' : 'Like';
      }
    })
    .catch(function(error) {
      console.error('Like request failed:', error);
      btn.innerHTML = originalHtml;
      if (error && error.name === 'AbortError') {
        var toast = document.createElement('div');
        toast.textContent = 'Request timed out. Please try again.';
        toast.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;z-index:9999';
        document.body.appendChild(toast);
        setTimeout(function(){ toast.remove(); }, 2500);
      }
    })
    .finally(function() {
      if (timeoutId) clearTimeout(timeoutId);
      btn.disabled = false;
    });
});
