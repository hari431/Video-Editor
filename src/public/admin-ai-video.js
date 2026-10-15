// src/public/admin-ai-video.js — Isolated AI Video Generation POC client.
//
// Classic script (no modules, no dependencies). Wires ONLY the isolated
// #aiVideoSection panel rendered by partials/ai-video-panel.ejs when the
// server enables it (AI_VIDEO_ENABLED=true, admin-only page). It never
// touches timeline internals or editor logic directly: "Add to Timeline"
// fetches the completed MP4 and feeds it through the EXISTING
// #videoFile <input type=file> change flow, so the stock addMediaFiles()
// handler appends the clip at the playhead with zero editor changes.
//
// Network surface (same-origin, cookie-authenticated like the rest of the
// admin UI): POST /api/admin/ai-video/jobs {prompt} → {job}
//   GET /api/admin/ai-video/jobs/:id → {job:{state,...}} (queued, processing,
//   completed, failed). Preview/Add use the job outputUrl (download route).
// No model paths, credentials or config are ever read or displayed here.
(function () {
  'use strict';

  var POLL_MS = 1500;
  var POLL_MAX = 200; // ~5 minutes

  function $(id) { return document.getElementById(id); }

  function setStatus(text, ok) {
    var el = $('aiStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = ok === true ? '#15803d' : (ok === false ? '#b91c1c' : '');
  }

  function setBusy(busy) {
    var btn = $('aiGenerateBtn');
    if (btn) btn.disabled = !!busy;
  }

  function setAddEnabled(enabled) {
    var btn = $('aiAddTimelineBtn');
    if (btn) btn.disabled = !enabled;
  }

  function showPreview(url) {
    var wrap = $('aiPreviewWrap');
    var video = $('aiPreview');
    if (!wrap || !video) return;
    try { video.pause(); } catch (e) {}
    video.src = url;
    try { video.load(); } catch (e) {}
    wrap.style.display = 'block';
  }

  function hidePreview() {
    var wrap = $('aiPreviewWrap');
    var video = $('aiPreview');
    if (video) { try { video.pause(); } catch (e) {} video.removeAttribute('src'); try { video.load(); } catch (e2) {} }
    if (wrap) wrap.style.display = 'none';
  }

  function currentJob() {
    return window.__aiVideoJob || null;
  }

  function rememberJob(job) {
    window.__aiVideoJob = job || null;
  }

  async function pollUntilDone(jobId) {
    for (var i = 0; i < POLL_MAX; i++) {
      var res;
      try {
        res = await fetch('/api/admin/ai-video/jobs/' + encodeURIComponent(jobId), { credentials: 'same-origin' });
      } catch (e) {
        setStatus('Status check failed: network error.', false);
        return null;
      }
      if (res.status === 404) { setStatus('AI video generation is disabled.', false); return null; }
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok || !data || !data.job) {
        setStatus((data && data.error) || 'Status check failed.', false);
        return null;
      }
      var job = data.job;
      rememberJob(job);
      if (job.state === 'processing' || job.state === 'queued') {
        setStatus('Status: ' + job.state + '…');
        await new Promise(function (r) { setTimeout(r, POLL_MS); });
        continue;
      }
      return job;
    }
    setStatus('Timed out waiting for generation. Try again.', false);
    return null;
  }

  async function onGenerate() {
    var promptEl = $('aiPrompt');
    var prompt = promptEl ? String(promptEl.value || '').trim() : '';
    if (!prompt) { setStatus('Enter a text prompt first.', false); return; }
    setBusy(true);
    setAddEnabled(false);
    hidePreview();
    rememberJob(null);
    setStatus('Status: queued…');
    var res;
    try {
      res = await fetch('/api/admin/ai-video/jobs', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: prompt })
      });
    } catch (e) {
      setStatus('Generate failed: network error.', false);
      setBusy(false);
      return;
    }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || !data || !data.job) {
      setStatus((data && data.error) || 'Generate failed.', false);
      setBusy(false);
      return;
    }
    var job = await pollUntilDone(data.job.id);
    setBusy(false);
    if (!job) return;
    if (job.state === 'completed' && job.outputUrl) {
      setStatus('Status: completed.', true);
      showPreview(job.outputUrl);
      setAddEnabled(true);
    } else if (job.state === 'failed') {
      setStatus(job.error || 'Generation failed.', false);
    } else {
      setStatus('Status: ' + job.state + '.', false);
    }
  }

  function aiFileName(job) {
    var raw = String((job && job.prompt) || 'ai-video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ai-video';
    var short = String((job && job.id) || 'video').slice(0, 8);
    return 'ai-' + raw + '-' + short + '.mp4';
  }

  async function onAddToTimeline() {
    var job = currentJob();
    if (!job || job.state !== 'completed' || !job.outputUrl) {
      setStatus('Generate a clip first.', false);
      return;
    }
    var input = $('videoFile');
    if (!input) { setStatus('The Video Editor timeline is unavailable. Reload the page.', false); return; }
    if (typeof window.DataTransfer === 'undefined') {
      setStatus('This browser cannot attach files programmatically.', false);
      return;
    }
    setStatus('Adding to timeline…');
    var blob;
    try {
      var res = await fetch(job.outputUrl, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('download failed');
      blob = await res.blob();
    } catch (e) {
      setStatus('Could not download the generated clip.', false);
      return;
    }
    var file;
    try {
      file = new File([blob], aiFileName(job), { type: 'video/mp4' });
    } catch (e) {
      setStatus('Could not prepare the clip for the timeline.', false);
      return;
    }
    try {
      var dt = new window.DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      setStatus('Added to the timeline at the playhead.', true);
    } catch (e) {
      setStatus('Could not add to the timeline.', false);
    }
  }

  function init() {
    // Panel renders only when the server enables the POC; otherwise no-op.
    if (!$('aiVideoSection') || !$('aiGenerateBtn')) return;
    $('aiGenerateBtn').addEventListener('click', onGenerate);
    var addBtn = $('aiAddTimelineBtn');
    if (addBtn) addBtn.addEventListener('click', onAddToTimeline);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Minimal test seam (no editor internals exposed).
  window.AiVideoPanel = window.AiVideoPanel || {};
  window.AiVideoPanel.fileNameFor = aiFileName;
})();
