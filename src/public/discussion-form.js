document.addEventListener('DOMContentLoaded', () => {
  const newForm = document.querySelector('.discussion-new-form');
  const discussionsContainer = document.querySelector('.detail-discussions');

  if (newForm && discussionsContainer) {
    newForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = newForm.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var tId2 = ctrl ? setTimeout(function(){ try{ ctrl.abort(); }catch(e){} }, 8000) : null;
      try {
        const formData = new FormData(newForm);
        const res = await fetch(newForm.action, {
          method: 'POST',
          body: new URLSearchParams(formData),
          headers: {
            'Accept': 'application/json'
          },
          signal: ctrl ? ctrl.signal : undefined
        });
        if (tId2) clearTimeout(tId2);

        const data = await res.json();
        if (data.success && data.discussion) {
          newForm.reset();
          
          let list = discussionsContainer.querySelector('.detail-discussions-list');
          if (!list) {
            list = document.createElement('div');
            list.className = 'detail-discussions-list';
            discussionsContainer.appendChild(list);
          }
          
          const discussionHtml = `
            <a href="/discussions/${data.discussion.id}" class="detail-discussion-item">
              <span class="detail-discussion-title">${data.discussion.title}</span>
              <span class="detail-discussion-meta">0 replies ${data.message && data.message.includes('pending') ? '(Pending Approval)' : ''}</span>
            </a>
          `;
          list.insertAdjacentHTML('afterbegin', discussionHtml);
          
          const btnMsg = document.createElement('span');
          btnMsg.textContent = " " + (data.message || 'Posted');
          btnMsg.style.color = "green";
          btnMsg.style.marginLeft = "10px";
          submitBtn.parentNode.appendChild(btnMsg);
          setTimeout(() => btnMsg.remove(), 3000);
        } else {
          alert(data.error || 'Failed to post question');
        }
      } catch (err) {
        if (tId2) clearTimeout(tId2);
        console.error(err);
        if (err && err.name === 'AbortError') alert('Request timed out. Please try again.');
        else alert('An error occurred');
      } finally {
        if (tId2) clearTimeout(tId2);
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }
});
