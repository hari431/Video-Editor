// src/public/devtools-restrict.js – UX deterrent, not security boundary
// Disables context menu + specific DevTools shortcuts for normal authenticated users only.
// OWNER/ADMIN and localhost are unrestricted. No debugger loops, no polling.
(function () {
  try {
    // isPrivileged/isAuthenticated are server-rendered (see adsense-verification partial)
    var isPrivileged = !!window.__IS_PRIVILEGED__;
    var isAuthenticated = !!window.__IS_AUTHENTICATED__;
    var host = window.location.hostname;
    var isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!isAuthenticated) return;
    if (isPrivileged || isLocalhost) return;

    // Disable right-click
    document.addEventListener('contextmenu', function (e) {
      e.preventDefault();
    });

    // Block specific shortcuts only – do not interfere with Ctrl+C/V/F/A/X/Z etc.
    document.addEventListener('keydown', function (e) {
      var key = e.key ? e.key.toUpperCase() : '';
      // F12
      if (key === 'F12') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Ctrl+Shift+I / J / C
      if (e.ctrlKey && e.shiftKey && (key === 'I' || key === 'J' || key === 'C')) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Ctrl+U (view source)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'U') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    });
  } catch (e) {}
})();
