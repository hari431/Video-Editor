document.addEventListener('click', function (event) {
  var btn = event.target.closest('.discussion-delete-btn');
  if (btn) {
    if (!confirm('Are you sure you want to delete this?')) {
      event.preventDefault();
    }
    return;
  }

  var replyBtn = event.target.closest('.toggle-reply-btn');
  if (replyBtn) {
    var replyToId = replyBtn.getAttribute('data-reply-to');
    var form = document.getElementById('reply-form-' + replyToId);
    if (form) {
      form.classList.toggle('hidden');
    }
    return;
  }

  var cancelBtn = event.target.closest('.cancel-reply-btn');
  if (cancelBtn) {
    var replyToId = cancelBtn.getAttribute('data-reply-to');
    var form = document.getElementById('reply-form-' + replyToId);
    if (form) {
      form.classList.add('hidden');
    }
    return;
  }
});


