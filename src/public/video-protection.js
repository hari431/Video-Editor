// src/public/video-protection.js – Video Recording Protection Layer (client).
// Isolated overlay + signalling. Honest scope:
//  - Watermark overlay is our own DOM above the player (never touches YouTube's
//    internal iframe DOM). It is part of the page, so it appears in recordings.
//  - No webpage API can detect external recorder apps (OBS, phone cameras,
//    OS capture). We only use real page signals: visibility, focus, fullscreen,
//    PrintScreen key delivery, and contextmenu. All are logged as signals,
//    never claimed as confirmed recording detection.
//  - Global right-click/DevTools deterrence already lives in
//    devtools-restrict.js; this file only adds video-container behaviour.
//  - Admins never load this (server renders enabled:false and skips init).
(function () {
  'use strict';

  var initialized = false;
  var lastBlurLog = 0;

  var CORNERS = [
    { top: '14px', left: '14px', right: 'auto', bottom: 'auto' },
    { top: '14px', left: 'auto', right: '14px', bottom: 'auto' },
    { top: 'auto', left: 'auto', right: '14px', bottom: '14px' },
    { top: 'auto', left: '14px', right: 'auto', bottom: '14px' }
  ];

  function sendLog(cfg, eventType, details) {
    try {
      var payload = JSON.stringify({
        itemPath: cfg.itemPath,
        itemType: cfg.itemType,
        eventType: eventType,
        details: Object.assign({ sessionShort: cfg.sessionShort }, details || {})
      });
      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'application/json' });
        if (navigator.sendBeacon('/api/video-protection-event', blob)) return;
      }
      fetch('/api/video-protection-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: payload,
        keepalive: true,
        credentials: 'same-origin'
      }).catch(function () {});
    } catch (e) {}
  }

  function pauseYouTube(container) {
    try {
      var frame = container.querySelector('iframe');
      if (!frame || !frame.contentWindow) return false;
      // Requires enablejsapi=1 on the embed URL (server appends it).
      frame.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'pauseVideo', args: '' }),
        'https://www.youtube-nocookie.com'
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  function init(cfg) {
    if (initialized) return;
    if (!cfg || !cfg.enabled) return;
    initialized = true;

    var container = cfg.youtube
      ? document.getElementById('youtubeContainer')
      : document.querySelector('.video-shell');
    if (!container) return;

    try {
      if (window.getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }
    } catch (e) {}

    // Dynamic watermark: viewer identity + session id, moves periodically
    // so it cannot be cropped out of a recording trivially. The server
    // already renders `.video-watermark.is-protected` inside the container
    // (visible without JS); reuse it when present, else create one with the
    // same two-line layout (name line, then masked-email + session line).
    var wm = container.querySelector('.video-watermark.is-protected');
    if (!wm) {
      wm = document.createElement('div');
      wm.className = 'video-watermark is-protected';
      wm.setAttribute('aria-hidden', 'true');
      var wmName = document.createElement('span');
      wmName.className = 'wm-viewer';
      wmName.textContent = 'For ' + (cfg.viewerName || 'member') + ' \u00B7 Downloading or Recording is prohibited';
      var wmId = document.createElement('span');
      wmId.className = 'wm-email';
      wmId.textContent = (cfg.maskedEmail || '') + ' \u00B7 ' + (cfg.sessionShort || '');
      wm.appendChild(wmName);
      wm.appendChild(wmId);
      container.appendChild(wm);
    }

    var corner = 0;
    function moveWatermark() {
      corner = (corner + 1) % CORNERS.length;
      var pos = CORNERS[corner];
      wm.style.top = pos.top;
      wm.style.left = pos.left;
      wm.style.right = pos.right;
      wm.style.bottom = pos.bottom;
    }
    var mover = setInterval(moveWatermark, 10000);
    if (window.addEventListener) {
      window.addEventListener('pagehide', function () { clearInterval(mover); });
    }

    // Transient warning pill (also used as a soft obscure cue).
    var warn = container.querySelector('.prot-warn');
    if (!warn) {
      warn = document.createElement('div');
      warn.className = 'prot-warn';
      warn.setAttribute('role', 'status');
      warn.style.display = 'none';
      container.appendChild(warn);
    }
    var warnTimer = null;
    function showWarning(text) {
      try {
        warn.textContent = text;
        warn.style.display = 'block';
        if (warnTimer) clearTimeout(warnTimer);
        warnTimer = setTimeout(function () { warn.style.display = 'none'; }, 3500);
      } catch (e) {}
    }

    var video = cfg.youtube ? null : container.querySelector('video');

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        if (video) { try { video.pause(); } catch (e) {} }
        if (cfg.youtube) {
          if (pauseYouTube(container)) {
            sendLog(cfg, 'YOUTUBE_PAUSE_ATTEMPTED', { reason: 'tab-hidden' });
          }
        }
        sendLog(cfg, 'VIDEO_HIDDEN', {});
        showWarning('Playback paused while the tab is hidden. This event is logged.');
      } else {
        sendLog(cfg, 'VIDEO_VISIBLE', {});
      }
    });

    window.addEventListener('blur', function () {
      var now = Date.now();
      if (now - lastBlurLog < 5000) return;
      lastBlurLog = now;
      sendLog(cfg, 'WINDOW_BLURRED', {});
    });
    window.addEventListener('focus', function () {
      sendLog(cfg, 'WINDOW_FOCUSED', {});
    });

    document.addEventListener('fullscreenchange', function () {
      var fs = !!document.fullscreenElement;
      sendLog(cfg, 'FULLSCREEN_CHANGED', { fullscreen: fs });
    });

    // PrintScreen key: the OS usually captures before the page sees anything,
    // so treat delivery as a suspected-attempt signal only.
    document.addEventListener('keydown', function (e) {
      if (e && e.key === 'PrintScreen') {
        sendLog(cfg, 'SUSPECTED_SCREENSHOT_KEY', {});
        showWarning('Screenshots of protected video are logged to your account.');
      }
    });

    // Container right-click: global deterrence lives in devtools-restrict.js,
    // but right-clicks inside the cross-origin YouTube iframe never reach the
    // parent document (separate browsing context), so they must be stopped by
    // the transparent shield above the iframe. Here we block what does reach
    // us and record the attempt for the audit trail.
    container.addEventListener('contextmenu', function (e) {
      try {
        e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
      } catch (err) {}
      sendLog(cfg, 'CONTEXTMENU_BLOCKED', {});
    });

    // YouTube right-click shield (non-admin only; this init never runs for
    // admins because cfg.enabled is false). The shield covers the iframe so
    // right-clicks hit our DOM instead of YouTube's document. Left/middle
    // input briefly drops the shield so playback/controls keep working.
    try {
      var shield = document.getElementById('youtubeRightClickShield');
      if (cfg.youtube && shield && container.contains(shield)) {
        shield.addEventListener('contextmenu', function (e) {
          try {
            e.preventDefault();
            if (e.stopPropagation) e.stopPropagation();
          } catch (err) {}
          sendLog(cfg, 'CONTEXTMENU_BLOCKED', { shield: true });
        });
        var restoreShield = function () {
          try {
            shield.style.pointerEvents = 'auto';
          } catch (err) {}
        };
        shield.addEventListener('mousedown', function (e) {
          try {
            if (e && e.button !== 2) {
              shield.style.pointerEvents = 'none';
              setTimeout(restoreShield, 400);
            }
          } catch (err) {}
        });
        window.addEventListener('mouseup', restoreShield);
        shield.addEventListener(
          'touchstart',
          function () {
            try {
              shield.style.pointerEvents = 'none';
              setTimeout(restoreShield, 400);
            } catch (err) {}
          },
          { passive: true }
        );
        window.addEventListener('touchend', restoreShield);
      }
    } catch (e) {}
  }

  window.VideoProtection = { init: init };
})();
