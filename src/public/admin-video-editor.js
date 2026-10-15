// src/public/admin-video-editor.js — Multi-track local Admin/Owner editor.
// ES module (no frameworks, no dependencies); project math lives in
// ./video-editor-project.js (shared with node:test).
// - Timeline domain is OUTPUT seconds: 0..contentEnd (furthest clip end).
//   Video clips map source ranges onto it; gaps render black + silence.
// - The library original is never written: export uploads bytes to OS temp and
//   streams back a fresh download. Disabled in production (server refuses).
import {
  createProject,
  contentEnd,
  outputDuration,
  addFileEntry,
  getMediaFile,
  fileIndexOfKind,
  clampGain,
  appendMediaClip,
  splitVideoClipAt,
  splitAtPlayhead as splitAllAtPlayhead,
  extendOverlayToVideoEnd,
  isOverlayVisibleAt,
  moveVideoClip,
  trimVideoClip,
  deleteVideoClip,
  duplicateVideoClip,
  moveAudioClip,
  trimAudioClip,
  deleteAudioClip,
  duplicateAudioClip,
  setMediaGain,
  setMediaVolumeDb,
  computeClipGain,
  computeClipVolume,
  layoutSubRows,
  activeVideoClipAt,
  projectToSpecV2,
  addClip,
  getZoomState,
  getClip,
  deleteClip,
  duplicateClip,
  moveClip,
  resizeClip,
  formatTimecode,
  clipPlayheadStatus,
  estimateRemainingMs,
  formatEta,
  moveGeo,
  resizeGeo,
  GEO_MIN,
  zoomPreviewRect,
  zoomFromPreviewRect,
  zoomDrawRect,
  zoomResizeDelta,
  zoomPaintStyle,
  findDominantZoomClip,
  normalizeZoomEasing,
  normalizeVoverlayPreset,
  normalizeVoverlayMargin,
  normalizeVoverlayShadow,
  voverlayPresetXY,
  VOVERLAY_PRESETS,
  textPreviewStyle,
  clampTextToFrame,
  fitTextScale,
  watermarkPreviewLayout,
  normalizeProjectWatermark,
  normalizeCrop,
  isClipCropped,
  setClipCrop,
  resetClipCrop,
  dragCrop,
  cropToPixels,
  pixelsToCrop,
  cropPercentStrings,
  getOverlaySources,
  evaluateKeyframes,
  upsertKeyframe
} from './video-editor-project.js';
import {
  pickRecorderMimeType,
  recorderFileName,
  formatCaptureDimensions,
  REGION_MIN_PX,
  REGION_CAPTURE_FPS,
  REGION_PREVIEW_TIMEOUT_MS,
  REGION_DRAW_FAIL_LIMIT,
  normalizeDragRect,
  mapPreviewRectToSource,
  clampRegionPixels,
  normalizeRecorderResolution,
  recorderVideoConstraints,
  recorderControlsFor,
  RECORDER_DEFAULT_RESOLUTION,
  isRecorderSupported,
  classifyCaptureError,
  createRecorderSession,
  startRecorderSession,
  pauseRecorderSession,
  resumeRecorderSession,
  stopRecorderSession,
  recorderElapsedMs,
  formatRecorderElapsed,
  recorderPayloadBytes,
  buildRecordingFile
} from './screen-recorder.js';

(function () {
  'use strict';

  var GUTTER_PX = 64;
  var MIN_PX_PER_SEC = 32;
  var MAX_PX_PER_SEC = 400;
  var MAX_IMAGE_FILES = 4;
  var LANE_ROW_PX = 34;

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setStatus(text, ok) {
    var el = $('exportStatus');
    if (!el) return;
    el.textContent = text;
    el.style.color = ok ? '#15803d' : '#b91c1c';
  }

  // ---- state (module-closure) ----
  var video = null;
  var project = null;
  var pxPerSec = 60;
  // Timeline master clock (output seconds). The <video> element is a slave:
  // only the active video clip drives its src/seek.
  var tlTime = 0;
  var timelinePlaying = false;
  var playStamp = 0;
  var playBase = 0;
  // Uploaded bytes: fileId -> { blob, url, file }. Overlay images stay in
  // the separate imageFiles[] flow (backend `image` parts).
  var fileBlobs = new Map();
  // Audio waveform peak cache keyed by media file id. Peaks are preview-only;
  // source media remains untouched and export continues through FFmpeg.
  var audioWaveforms = new Map();
  var audioWaveformPending = new Set();
  var imageFiles = [];
  var imageURLs = [];
  // Preview slaves.
  var currentPreviewClipId = null;
  var audioEls = new Map(); // clipId -> HTMLAudioElement
  var previewBlocked = false;
  var audioBlocked = false;
  var rafId = 0;
  var dragKind = null;
  var editingText = false;
  // Server-rendered upload cap (VIDEO_EDITOR_MAX_VIDEO_MB, default 2048).
  var maxVideoMb = 2048;
  var maxVideoBytes = 2048 * 1048576;
  var MAX_AUDIO_BYTES = 200 * 1048576;
  var seekingProgrammatically = false;
  var changingSourceProgrammatically = false;
  var cropEditingClipId = null;
  var tempCrop = null;
  var cropOriginal = null;
  var isWorkspaceActive = false;
  var isPreviewMaximized = false;

  function outDur() { return project ? contentEnd(project) : 0; }

  // ---- tiny pointer-drag helper (mouse + touch via Pointer Events) ----
  // Note: no preventDefault() on pointerdown here — it would suppress the
  // compatibility mouse events that dblclick (inline text editing) relies on.
  // Native text-selection/scroll interference is already handled with
  // user-select:none + touch-action:none on every drag surface.
  function startDrag(e, onMove, onUp) {
    if (e && e.stopPropagation) e.stopPropagation();
    var targetEl = e ? e.target : null;
    var currentEl = e ? e.currentTarget : null;
    var captureEl = (targetEl && targetEl.setPointerCapture) ? targetEl : currentEl;
    var pid = e ? e.pointerId : undefined;

    function move(ev) {
      if (pid !== undefined && ev && ev.pointerId !== undefined && ev.pointerId !== pid) return;
      onMove(ev);
    }

    function up(ev) {
      if (pid !== undefined && ev && ev.pointerId !== undefined && ev.pointerId !== pid) return;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      if (captureEl && captureEl.releasePointerCapture && pid !== undefined) {
        try { captureEl.releasePointerCapture(pid); } catch (err) {}
      }
      if (onUp) onUp(ev);
    }

    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);

    if (captureEl && captureEl.setPointerCapture && pid !== undefined) {
      try { captureEl.setPointerCapture(pid); } catch (err) {}
    }
  }

  function laneBodyX(bodyEl, clientX) {
    var r = bodyEl.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return (clientX - r.left) / r.width;
  }

  function tFromFrac(f) {
    if (!project) return 0;
    var d = contentEnd(project);
    return Math.min(d, Math.max(0, f * d));
  }

  // ---- layout / ruler / custom horizontal scrollbar ----
  function syncHScrollbar() {
    var scrollEl = $('veScroll');
    var trackEl = $('veHScrollbarTrack');
    var thumbEl = $('veHScrollbarThumb');
    if (!scrollEl || !trackEl || !thumbEl) return;

    var scrollWidth = scrollEl.scrollWidth || 1;
    var clientWidth = scrollEl.clientWidth || 1;
    var maxScrollLeft = scrollWidth - clientWidth;
    var trackWidth = trackEl.clientWidth || 1;

    if (maxScrollLeft <= 0) {
      thumbEl.style.width = '100%';
      thumbEl.style.transform = 'translateX(0px)';
      thumbEl.style.opacity = '0.4';
      return;
    }

    thumbEl.style.opacity = '1.0';
    var ratio = clientWidth / scrollWidth;
    var thumbWidthPx = Math.max(32, Math.round(trackWidth * ratio));
    thumbEl.style.width = thumbWidthPx + 'px';

    var scrollRatio = Math.min(1, Math.max(0, scrollEl.scrollLeft / maxScrollLeft));
    var maxThumbLeft = Math.max(1, trackWidth - thumbWidthPx);
    var thumbLeftPx = Math.round(scrollRatio * maxThumbLeft);
    thumbEl.style.transform = 'translateX(' + thumbLeftPx + 'px)';
  }

  function layoutTimeline() {
    var content = $('veContent');
    if (!content || !project) return;
    var w = Math.max(320, Math.round(contentEnd(project) * pxPerSec) + GUTTER_PX);
    content.style.width = w + 'px';
    var readout = $('veZoomReadout');
    if (readout) readout.textContent = pxPerSec + ' px/s';
    var slider = $('veZoomSlider');
    if (slider && Number(slider.value) !== pxPerSec) slider.value = String(pxPerSec);
    syncHScrollbar();
  }

  function setTimelineZoom(value) {
    var scrollEl = $('veScroll');
    var oldWidth = $('veContent') ? $('veContent').scrollWidth : 0;
    var oldLeft = scrollEl ? scrollEl.scrollLeft : 0;
    var oldClient = scrollEl ? scrollEl.clientWidth : 0;
    var centerTime = oldWidth > 0 ? ((oldLeft + oldClient / 2) / oldWidth) * contentEnd(project) : tlTime;
    pxPerSec = Math.max(20, Math.min(240, Math.round(Number(value) / 10) * 10));
    layoutTimeline();
    renderTimeline();
    if (scrollEl) {
      var newWidth = $('veContent') ? $('veContent').scrollWidth : 0;
      scrollEl.scrollLeft = Math.max(0, Math.min(Math.max(0, newWidth - scrollEl.clientWidth), centerTime * pxPerSec - scrollEl.clientWidth / 2));
    }
    syncHScrollbar();
  }

  function tickStep() {
    var steps = [0.1, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] * pxPerSec >= 70) return steps[i];
    }
    return 600;
  }

  function renderRuler() {
    var ruler = $('veRuler');
    if (!ruler || !project) return;
    ruler.innerHTML = '';
    var dur = contentEnd(project);
    if (!(dur > 0)) return;
    var step = tickStep();
    for (var t = 0; t <= dur + 1e-9; t += step) {
      var tick = document.createElement('div');
      tick.className = 've-tick';
      tick.style.left = (t / dur * 100) + '%';
      tick.textContent = formatTimecode(Math.min(t, dur));
      ruler.appendChild(tick);
    }
    (project.chapters || []).forEach(function (chapter) {
      var marker = document.createElement('button');
      marker.type = 'button';
      marker.title = formatTimecode(chapter.time) + ' · ' + chapter.title + ' (click to seek, double-click to rename)';
      marker.setAttribute('data-testid', 'video-editor-chapter-marker');
      marker.style.cssText = 'position:absolute;top:0;bottom:0;left:' + (chapter.time / dur * 100) + '%;z-index:8;width:2px;padding:0;border:0;background:#7c3aed;cursor:pointer;';
      var tag = document.createElement('span');
      tag.textContent = chapter.title;
      tag.style.cssText = 'position:absolute;top:1px;left:3px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#ede9fe;color:#5b21b6;border-radius:3px;padding:1px 3px;font-size:10px;font-weight:700;';
      marker.appendChild(tag);
      marker.addEventListener('click', function (event) { event.stopPropagation(); seek(chapter.time); });
      marker.addEventListener('dblclick', function (event) {
        event.stopPropagation();
        var renamed = window.prompt('Rename chapter', chapter.title);
        if (renamed && renamed.trim()) { chapter.title = renamed.trim().slice(0, 100); renderTimeline(); }
      });
      ruler.appendChild(marker);
    });
  }

  function addChapter() {
    if (!project) return;
    var title = window.prompt('Chapter title', 'New chapter');
    if (!title || !title.trim()) return;
    project.chapters = project.chapters || [];
    if (project.chapters.length >= 100) { setStatus('Maximum 100 chapters per project.', false); return; }
    project.chapters.push({ id: 'ch' + Date.now(), time: Math.max(0, Math.min(contentEnd(project), tlTime)), title: title.trim().slice(0, 100) });
    project.chapters.sort(function (x, y) { return x.time - y.time; });
    renderTimeline();
    setStatus('Chapter added at ' + formatTimecode(tlTime) + '.', true);
  }

  function copyChapterTimestamps() {
    if (!project || !(project.chapters || []).length) { setStatus('Add at least one chapter first.', false); return; }
    var lines = project.chapters.slice().sort(function (x, y) { return x.time - y.time; }).map(function (chapter) {
      return formatTimecode(chapter.time) + ' ' + chapter.title;
    }).join(String.fromCharCode(10));
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lines).then(function () { setStatus('YouTube chapter timestamps copied.', true); }).catch(function () { window.prompt('Copy chapter timestamps', lines); });
    } else window.prompt('Copy chapter timestamps', lines);
  }

  function deleteLastChapter() {
    if (!project || !(project.chapters || []).length) { setStatus('No chapters to delete.', false); return; }
    var chapter = project.chapters[project.chapters.length - 1];
    if (!window.confirm('Delete chapter "' + chapter.title + '"?')) return;
    project.chapters.splice(project.chapters.indexOf(chapter), 1);
    renderTimeline();
    setStatus('Chapter deleted.', true);
  }
  // ---- lanes / clips ----
  function mediaLabel(clip, file) {
    var kind = clipKindOf(clip.id) || clip.type;
    var name = (file && file.name) || (kind === 'video' ? 'Video' : 'Audio');
    return name + ' · ' + Math.round(clip.gain * 100) + '%';
  }

  function clipLabel(clip) {
    if (clip.type === 'text') return (clip.text || 'Text').slice(0, 24) || 'Text';
    if (clip.type === 'blur') return (clip.mode === 'mask' ? 'Hide' : 'Blur');
    if (clip.type === 'voverlay') return (clip.label || 'Video overlay').slice(0, 24) || 'Video overlay';
    if (clip.type === 'zoom') return (clip.label || 'Zoom').slice(0, 24) || 'Zoom';
    return clip.label || 'Image';
  }

  function laneBodyFor(kind) {
    return $({ video: 'veLaneVideo', audio: 'veLaneAudio', blur: 'veLaneBlur', text: 'veLaneText', image: 'veLaneImage', voverlay: 'veLaneVideoOverlay', zoom: 'veLaneZoom' }[kind]);
  }

  function clipNodeStyle(start, end) {
    var dur = contentEnd(project);
    if (!(dur > 0)) return { left: '0%', width: '0%', title: '' };
    return {
      left: (start / dur * 100) + '%',
      width: (Math.max(0.0005, (end - start)) / dur * 100) + '%',
      title: formatTimecode(start) + ' → ' + formatTimecode(end)
    };
  }

  function mediaSpan(clip) {
    return { start: clip.start, end: clip.start + (clip.sourceOut - clip.sourceIn) };
  }

  function requestAudioWaveform(fileId) {
    if (audioWaveforms.has(fileId) || audioWaveformPending.has(fileId)) return;
    var entry = fileBlobs.get(fileId);
    if (!entry || !entry.blob || typeof entry.blob.arrayBuffer !== 'function') return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioWaveformPending.add(fileId);
    var ctx;
    try { ctx = new Ctx(); } catch (err) { audioWaveformPending.delete(fileId); return; }
    entry.blob.arrayBuffer().then(function (bytes) {
      return ctx.decodeAudioData(bytes);
    }).then(function (buffer) {
      // Measure every channel so stereo audio is represented even when most
      // of its signal lives on the right channel. Store raw peaks; display gain
      // is calculated at paint time so the source amplitudes remain meaningful.
      var bucketCount = Math.max(64, Math.min(1200, Math.ceil(buffer.duration * 24)));
      var peaks = new Array(bucketCount).fill(0);
      var channelCount = Math.max(1, buffer.numberOfChannels || 1);
      for (var ch = 0; ch < channelCount; ch++) {
        var channel = buffer.getChannelData(ch);
        var samplesPerBucket = Math.max(1, Math.ceil(channel.length / bucketCount));
        for (var b = 0; b < bucketCount; b++) {
          var peak = 0;
          var from = b * samplesPerBucket;
          var to = Math.min(channel.length, from + samplesPerBucket);
          for (var n = from; n < to; n++) peak = Math.max(peak, Math.abs(channel[n]));
          peaks[b] = Math.max(peaks[b], peak);
        }
      }
      audioWaveforms.set(fileId, peaks);
    }).catch(function () {
      // Cache failure so renderTimeline() does not retry unsupported codecs forever.
      audioWaveforms.set(fileId, null);
    }).finally(function () {
      audioWaveformPending.delete(fileId);
      try { if (ctx && ctx.close) ctx.close(); } catch (err) {}
      if (project) renderTimeline();
    });
  }

  function paintAudioWaveform(canvas, fileId, sourceIn, sourceOut) {
    var peaks = audioWaveforms.get(fileId);
    if (!peaks || !canvas) return;
    var width = Math.max(1, Math.floor(canvas.clientWidth || canvas.width || 1));
    var height = Math.max(1, Math.floor(canvas.clientHeight || canvas.height || 1));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    var media = project && getMediaFile(project, fileId);
    if (!media || !Number.isFinite(media.duration) || media.duration <= 0) return;
    var start = Math.max(0, Math.min(peaks.length - 1, Math.floor((sourceIn / media.duration) * peaks.length)));
    var end = Math.max(start + 1, Math.min(peaks.length, Math.ceil((sourceOut / media.duration) * peaks.length)));
    var count = Math.max(1, end - start);
    var maxPeak = 0;
    for (var p = start; p < end; p++) maxPeak = Math.max(maxPeak, peaks[p] || 0);
    // Quiet recordings can otherwise render as a nearly flat line. Lift the
    // display against this clip's own peak, capped at 8x to preserve dynamics.
    var displayGain = maxPeak > 0 ? Math.min(8, 1 / maxPeak) : 1;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    for (var x = 0; x < width; x++) {
      var idx = Math.min(end - 1, start + Math.floor((x / width) * count));
      var normalizedPeak = (peaks[idx] || 0) * displayGain;
      var amp = Math.max(1, Math.round(normalizedPeak * (height - 2)));
      var barH = Math.max(1, Math.min(height - 1, amp));
      ctx.fillRect(x, Math.floor((height - barH) / 2), 1, barH);
    }
  }

  function renderLaneBody(body, items, opts) {
    // items: [{id, start, end, label, title, cls, selected}]
    // Overlapping items stack into sub-rows; layout shared with unit tests.
    if (!body) return;
    body.innerHTML = '';
    if (!project || !(contentEnd(project) > 0)) {
      body.style.minHeight = '';
      return;
    }
    var layout = layoutSubRows(items);
    body.style.minHeight = (Math.max(1, layout.rowCount) * LANE_ROW_PX) + 'px';
    items.forEach(function (it) {
      var el = document.createElement('div');
      el.className = 've-clip ' + (it.cls || '') + (project.selectedId === it.id ? ' ve-selected' : '');
      el.setAttribute('data-clip-id', it.id);
      var pos = clipNodeStyle(it.start, it.end);
      el.style.left = pos.left;
      el.style.width = pos.width;
      el.style.top = (4 + (layout.rows.get(it.id) || 0) * LANE_ROW_PX) + 'px';
      el.style.height = (LANE_ROW_PX - 8) + 'px';
      
      // Calculate pixel width based on current timeline horizontal zoom
      var widthPx = (it.end - it.start) * pxPerSec;
      var compactLabel = it.label;
      if (widthPx < 85) {
        if (it.cls.includes('voverlay')) compactLabel = '🎞️';
        else if (it.cls.includes('video')) compactLabel = '🎬';
        else if (it.cls.includes('audio')) compactLabel = '🎵';
        else if (it.cls.includes('image')) compactLabel = '🖼️';
        else if (it.cls.includes('text')) compactLabel = '📝';
        else if (it.cls.includes('blur')) compactLabel = '🌫️';
        else if (it.cls.includes('zoom')) compactLabel = '🔍';
        else compactLabel = '📎';
      }

      el.title = (it.title || it.label) + ' (' + pos.title + ')';
      var edgeL = document.createElement('div');
      edgeL.className = 've-edge ve-edge-l';
      edgeL.setAttribute('data-edge', 'start');
      var edgeR = document.createElement('div');
      edgeR.className = 've-edge ve-edge-r';
      edgeR.setAttribute('data-edge', 'end');
      var name = document.createElement('span');
      name.textContent = compactLabel;
      name.style.overflow = 'hidden';
      name.style.textOverflow = 'ellipsis';
      name.style.whiteSpace = 'nowrap';
      
      if (widthPx < 50) {
        el.style.padding = '0 2px';
        el.style.justifyContent = 'center';
      }

      el.appendChild(edgeL);
      if (it.cls && it.cls.includes('audio')) {
        var audioClip = project.audioClips.find(function (c) { return c.id === it.id; });
        if (audioClip) {
          var audioFile = getMediaFile(project, audioClip.file);
          if (audioFile) {
            requestAudioWaveform(audioFile.id);
            var wave = document.createElement('canvas');
            wave.className = 've-audio-waveform';
            wave.setAttribute('aria-hidden', 'true');
            wave.style.cssText = 'position:absolute;left:3px;right:3px;top:50%;transform:translateY(-50%);width:calc(100% - 6px);height:22px;opacity:1;pointer-events:none;z-index:1;';
            el.appendChild(wave);
          }
        }
      }
      name.style.position = 'relative';
      name.style.zIndex = '2';
      el.appendChild(name);
      el.appendChild(edgeR);
      opts.onPointer(el, it);
      body.appendChild(el);
      // Paint after insertion: canvas.clientWidth is zero before this point.
      if (it.cls && it.cls.includes('audio')) {
        var renderedAudioClip = project.audioClips.find(function (c) { return c.id === it.id; });
        if (renderedAudioClip) {
          var renderedAudioFile = getMediaFile(project, renderedAudioClip.file);
          var renderedWave = el.querySelector('.ve-audio-waveform');
          if (renderedAudioFile && renderedWave) paintAudioWaveform(renderedWave, renderedAudioFile.id, renderedAudioClip.sourceIn, renderedAudioClip.sourceOut);
        }
      }
    });
  }

  function renderTimeline() {
    if (!project) return;
    renderRuler();
    var dur = contentEnd(project);
    // Video lane: single row (overlaps rejected by the model).
    renderLaneBody($('veLaneVideo'), project.videoClips.map(function (c) {
      var s = mediaSpan(c);
      var f = getMediaFile(project, c.file);
      return {
        id: c.id, start: s.start, end: s.end,
        label: mediaLabel(c, f), title: 'Video · source ' + c.sourceIn + 's → ' + c.sourceOut + 's',
        cls: 've-clip-video'
      };
    }), { onPointer: function (el, it) { el.addEventListener('pointerdown', onMediaDown('video', it.id)); } });
    // Audio lane: overlaps stack into sub-rows.
    renderLaneBody($('veLaneAudio'), project.audioClips.map(function (c) {
      var s = mediaSpan(c);
      var f = getMediaFile(project, c.file);
      return {
        id: c.id, start: s.start, end: s.end,
        label: mediaLabel(c, f), title: 'Audio · source ' + c.sourceIn + 's → ' + c.sourceOut + 's',
        cls: 've-clip-audio'
      };
    }), { onPointer: function (el, it) { el.addEventListener('pointerdown', onMediaDown('audio', it.id)); } });
    // Overlay lanes: overlaps stack into sub-rows.
    var bodies = { blur: $('veLaneBlur'), text: $('veLaneText'), image: $('veLaneImage'), voverlay: $('veLaneVideoOverlay'), zoom: $('veLaneZoom') };
    ['blur', 'text', 'image', 'voverlay', 'zoom'].forEach(function (type) {
      renderLaneBody(bodies[type], project.clips.filter(function (c) { return c.type === type; }).map(function (clip) {
        return { id: clip.id, start: clip.start, end: clip.end, label: clipLabel(clip), title: clipLabel(clip), cls: 've-clip-' + type };
      }), { onPointer: function (el, it) { el.addEventListener('pointerdown', onClipDown(it.id)); } });
    });
    void dur;
    placePlayhead();
    updateTimecode();
    syncHScrollbar();
  }

  function findClipAny(id) {
    if (!project) return null;
    return getClip(project, id) ||
      project.videoClips.find(function (c) { return c.id === id; }) ||
      project.audioClips.find(function (c) { return c.id === id; }) || null;
  }

  function clipKindOf(id) {
    if (!project) return null;
    if (getClip(project, id)) return project.selectedId === id ? getClip(project, id).type : getClip(project, id).type;
    if (project.videoClips.some(function (c) { return c.id === id; })) return 'video';
    if (project.audioClips.some(function (c) { return c.id === id; })) return 'audio';
    return null;
  }

  // Toggle selection highlights in place. Unlike renderTimeline() this never
  // rebuilds DOM, so it is safe to call on pointerdown before a drag starts
  // (rebuilding there detached the drag source and killed every gesture).
  function syncSelection() {
    if (!project) return;
    var nodes = document.querySelectorAll('.ve-clip[data-clip-id]');
    Array.prototype.forEach.call(nodes, function (n) {
      n.classList.toggle('ve-selected', n.getAttribute('data-clip-id') === project.selectedId);
    });
  }

  function syncClipNode(id) {
    var clip = findClipAny(id);
    if (!clip || !project) return false;
    var n = document.querySelector('.ve-clip[data-clip-id="' + id + '"]');
    if (!n) return false;
    var span = clip.type === 'video' || clip.type === 'audio'
      ? { start: clip.start, end: clip.start + (clip.sourceOut - clip.sourceIn) }
      : clip;
    var pos = clipNodeStyle(span.start, span.end);
    n.style.left = pos.left;
    n.style.width = pos.width;
    n.title = pos.title;
    return true;
  }

  function syncTimelineClips() {
    if (!project) return false;
    var nodes = document.querySelectorAll('.ve-clip[data-clip-id]');
    var want = project.videoClips.length + project.audioClips.length + project.clips.length;
    if (nodes.length !== want) return false;
    var ok = true;
    Array.prototype.forEach.call(nodes, function (n) {
      if (!syncClipNode(n.getAttribute('data-clip-id'))) ok = false;
    });
    return ok;
  }

  function seek(t) {
    if (!project) return;
    resumeAudioContext();
    var dur = contentEnd(project);
    tlTime = Math.min(dur, Math.max(0, Number(t) || 0));
    killAudio();
    currentPreviewClipId = null;
    syncPreviewSource(true);
    if (timelinePlaying) {
      playBase = tlTime;
      playStamp = performance.now();
    }
    placePlayhead();
    updateTimecode();
    renderPreview();
  }

  function onBackgroundDown(e) {
    // Scrub when pressing ruler or empty lane space (not clips).
    if (e.target.closest('.ve-clip')) return;
    if (!project || !(contentEnd(project) > 0)) return;
    var lane = e.currentTarget;
    var body = lane.id === 'veRuler' ? lane : lane.querySelector('.ve-lane-body') || lane;
    seek(tFromFrac(laneBodyX(body, e.clientX)));
    startDrag(e, function (ev) {
      seek(tFromFrac(laneBodyX(body, ev.clientX)));
    });
  }

  function onClipDown(id) {
    return function (e) {
      if (!project) return;
      // Capture nodes synchronously: e.currentTarget is only valid during
      // dispatch, and no rebuild may happen before startDrag (a rebuild
      // detaches the node and kills listeners + pointer capture).
      var clipEl = e.currentTarget;
      var laneBody = clipEl.parentElement;
      var edgeEl = e.target.closest ? e.target.closest('[data-edge]') : null;
      var clip = getClip(project, id);
      if (!clip || !laneBody) return;
      // Click selects immediately; a drag only mutates the model on move.
      project.selectedId = id;
      if (tlTime < clip.start || tlTime > clip.end) {
        seek(clip.start);
      } else {
        renderPreview();
      }
      syncSelection();
      renderInspector();
      var moved = false;
      if (edgeEl) {
        var edge = edgeEl.getAttribute('data-edge');
        startDrag(e, function (ev) {
          var t = tFromFrac(laneBodyX(laneBody, ev.clientX));
          try { resizeClip(project, id, edge, t); } catch (err) { return; }
          moved = true;
          syncClipNode(id);
          updateTimecode();
          renderPreview();
        }, function () {
          if (moved) { renderTimeline(); renderPreview(); }
          renderInspector();
        });
      } else {
        var dur = clip.end - clip.start;
        var grabOffset = tFromFrac(laneBodyX(laneBody, e.clientX)) - clip.start;
        startDrag(e, function (ev) {
          var t = tFromFrac(laneBodyX(laneBody, ev.clientX)) - grabOffset;
          try { moveClip(project, id, t); } catch (err) { return; }
          moved = true;
          syncClipNode(id);
          updateTimecode();
          renderPreview();
        }, function () {
          if (moved) { renderTimeline(); renderPreview(); }
          renderInspector();
        });
      }
    };
  }

  function onMediaDown(kind, id) {
    return function (e) {
      if (!project) return;
      var clipEl = e.currentTarget;
      var laneBody = clipEl.parentElement;
      var edgeEl = e.target.closest ? e.target.closest('[data-edge]') : null;
      var list = kind === 'video' ? project.videoClips : project.audioClips;
      var clip = list.find(function (c) { return c.id === id; });
      if (!clip || !laneBody) return;
      project.selectedId = id;
      var span = { start: clip.start, end: clip.start + (clip.sourceOut - clip.sourceIn) };
      if (tlTime < span.start || tlTime > span.end) {
        seek(span.start);
      } else {
        renderPreview();
      }
      syncSelection();
      renderInspector();
      var moved = false;
      var after = function () {
        if (moved) { renderTimeline(); renderPreview(); }
        renderInspector();
      };
      if (edgeEl) {
        var edge = edgeEl.getAttribute('data-edge');
        startDrag(e, function (ev) {
          var frac = laneBodyX(laneBody, ev.clientX);
          try {
            if (kind === 'video') {
              var f = getMediaFile(project, clip.file);
              var srcT = frac * (f ? f.duration : contentEnd(project));
              trimVideoClip(project, id, edge, srcT);
            } else {
              var fa = getMediaFile(project, clip.file);
              var srcTa = frac * (fa ? fa.duration : contentEnd(project));
              trimAudioClip(project, id, edge, srcTa);
            }
          } catch (err) { return; }
          moved = true;
          syncClipNode(id);
          updateTimecode();
          renderPreview();
        }, after);
      } else {
        // Body drag moves in TIMELINE seconds; grab offset keeps the pointer.
        var grab = tFromFrac(laneBodyX(laneBody, e.clientX)) - clip.start;
        startDrag(e, function (ev) {
          var t = tFromFrac(laneBodyX(laneBody, ev.clientX)) - grab;
          try {
            if (kind === 'video') moveVideoClip(project, id, t);
            else moveAudioClip(project, id, t);
          } catch (err) { return; }
          moved = true;
          syncClipNode(id);
          updateTimecode();
          renderPreview();
        }, after);
      }
    };
  }

  // ---- playhead / timecode / master-clock playback ----
  function placePlayhead() {
    var head = $('vePlayhead');
    var content = $('veContent');
    var lane = $('veLaneVideo');
    if (!head || !content || !lane || !project) return;
    var dur = contentEnd(project);
    var frac = dur > 0 ? tlTime / dur : 0;
    var laneRect = lane.getBoundingClientRect();
    var contentRect = content.getBoundingClientRect();
    head.style.left = (laneRect.left - contentRect.left + frac * laneRect.width) + 'px';
  }

  function updateTimecode() {
    var el = $('veTimecode');
    if (!el || !project) return;
    var str = formatTimecode(tlTime) + ' / ' + formatTimecode(outDur());
    el.textContent = str;
    var badge = $('veWsTimecodeBadge');
    if (badge) badge.textContent = str;
    updateClipStatus();
  }

  function setPlaying(playing) {
    var btn = $('vePlayBtn');
    if (!video || !project) return;
    if (!(contentEnd(project) > 0)) { setStatus('Add a video clip first.', false); return; }
    if (playing) {
      resumeAudioContext();
      if (tlTime >= contentEnd(project) - 0.05) seek(0);
      previewBlocked = false;
      audioBlocked = false;
      timelinePlaying = true;
      playBase = tlTime;
      playStamp = performance.now();
      if (btn) btn.textContent = '⏸ Pause';
      currentPreviewClipId = null;
      syncPreviewSource(true);
      reconcileAudio(true);
      startTickLoop();
    } else {
      pauseTimeline();
    }
  }

  function pauseTimeline() {
    timelinePlaying = false;
    try { video.pause(); } catch (err) {}
    killAudio();
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    var b = $('vePlayBtn');
    if (b) b.textContent = '▶ Play';
    placePlayhead();
    updateTimecode();
    renderPreview();
  }

  // Web Audio graph management for preview amplification beyond HTMLMediaElement 1.0 volume limit.
  var audioCtx = null;
  var videoAudioSource = null;
  var videoGainNode = null;

  function getAudioContext() {
    if (audioCtx) return audioCtx;
    var AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtxClass) return null;
    try {
      audioCtx = new AudioCtxClass();
      return audioCtx;
    } catch (e) {
      return null;
    }
  }

  function resumeAudioContext() {
    if (audioCtx && audioCtx.state === 'suspended') {
      try { audioCtx.resume(); } catch (e) {}
    }
  }

  function ensureVideoWebAudio() {
    if (videoGainNode) return true;
    if (!video) return false;
    var ctx = getAudioContext();
    if (!ctx) return false;
    try {
      if (!videoAudioSource) {
        videoAudioSource = ctx.createMediaElementSource(video);
      }
      videoGainNode = ctx.createGain();
      videoGainNode.gain.value = 1.0;
      videoAudioSource.connect(videoGainNode);
      videoGainNode.connect(ctx.destination);
      return true;
    } catch (err) {
      return false;
    }
  }

  // Preview audio gain calculation: combines linear gain (0–200%) and volumeDb
  // into an effective volume multiplier clamped to [0.0, 1.0] for HTMLMediaElement preview.
  function computeClipVolume(clip) {
    if (!clip) return 1.0;
    var gain = clip.gain !== undefined ? clip.gain : 1.0;
    var db = clip.volumeDb !== undefined ? clip.volumeDb : 0;
    var mult = gain * Math.pow(10, db / 20);
    return Math.min(1.0, Math.max(0.0, mult));
  }

  function syncActiveVideoVolume() {
    if (!project || !video) return;
    var clip = activeVideoClipAt(project, tlTime);
    var targetGain = computeClipGain(clip);
    var wantVol = computeClipVolume(clip);
    if (ensureVideoWebAudio() && videoGainNode) {
      resumeAudioContext();
      if (Math.abs(videoGainNode.gain.value - targetGain) > 0.0001) {
        videoGainNode.gain.value = targetGain;
      }
      if (Math.abs(video.volume - 1.0) > 0.001) {
        try { video.volume = 1.0; } catch (err) {}
      }
    } else {
      if (Math.abs(video.volume - wantVol) > 0.001) {
        try { video.volume = wantVol; } catch (err) {}
      }
    }
  }

  // Single shared per-frame updater: playhead + timecode + preview overlays.
  // Runs while the timeline is playing regardless of how playback started.
  function playbackTick() {
    if (!timelinePlaying || !project) { rafId = 0; return; }
    var dur = contentEnd(project);
    
    // Check if there is an active video clip and the video is playing/loaded
    var clip = activeVideoClipAt(project, tlTime);
    if (clip && video && !video.paused && video.readyState >= 1) {
      // Synchronize timeline master clock (tlTime) to the actual physical video playback position!
      var mapped = clip.start + (video.currentTime - clip.sourceIn);
      tlTime = Math.min(dur, Math.max(0, mapped));
      // Keep playBase/playStamp updated so that if we transition to a gap, the fallback clock continues smoothly
      playBase = tlTime;
      playStamp = performance.now();
    } else {
      // Fallback to real-world elapsed time (e.g. during gaps, audio-only, or while video is buffering/loading)
      tlTime = Math.min(dur, Math.max(0, playBase + (performance.now() - playStamp) / 1000));
    }

    if (tlTime >= dur - 0.001) {
      pauseTimeline();
      seek(dur);
      return;
    }
    syncPreviewSource(false);
    syncActiveVideoVolume();
    reconcileAudio(false);
    placePlayhead();
    updateTimecode();
    renderPreview();
    rafId = requestAnimationFrame(playbackTick);
  }

  function startTickLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(playbackTick);
  }

  // ---- preview: video slave + gap black + music elements ----
  function fileUrl(fileId) {
    var info = fileBlobs.get(fileId);
    return info ? info.url : '';
  }

  function syncPreviewSource(force) {
    if (!project || !video) return;
    var clip = activeVideoClipAt(project, tlTime);
    var id = clip ? clip.id : null;
    if (!force && id === currentPreviewClipId) return;
    currentPreviewClipId = id;
    if (!clip) {
      // Gap: black frame; the timeline clock (and music) keep running.
      try {
        changingSourceProgrammatically = true;
        video.pause();
      } catch (err) {}
      try {
        changingSourceProgrammatically = true;
        video.removeAttribute('src');
        video.load();
      } catch (err) {}
      return;
    }
    var url = fileUrl(clip.file);
    if (!url) return;
    if (video.getAttribute('src') !== url) {
      changingSourceProgrammatically = true;
      video.setAttribute('src', url);
    }
    syncActiveVideoVolume();
    try {
      var targetTime = clip.sourceIn + (tlTime - clip.start);
      if (Math.abs(video.currentTime - targetTime) > 0.05) {
        seekingProgrammatically = true;
        video.currentTime = targetTime;
      }
    } catch (err) {}
    if (timelinePlaying && video.paused && !previewBlocked) {
      try {
        var pr = video.play();
        if (pr && typeof pr.catch === 'function') {
          pr.catch(function () {
            previewBlocked = true;
            setStatus('Preview playback was blocked — press Play again.', false);
          });
        }
      } catch (err) {
        previewBlocked = true;
      }
    }
  }

  function killAudio() {
    audioEls.forEach(function (entry) {
      try { entry.el.pause(); } catch (err) {}
      if (entry.sourceNode) {
        try { entry.sourceNode.disconnect(); } catch (e) {}
      }
      if (entry.gainNode) {
        try { entry.gainNode.disconnect(); } catch (e) {}
      }
    });
    audioEls.clear();
  }

  // Keep one HTMLAudioElement per active music clip (preview synchronization with
  // Web Audio amplification for gains > 1.0, with fallback to HTMLMediaElement volume).
  function reconcileAudio(force) {
    if (!project) return;
    if (!timelinePlaying) {
      if (audioEls.size) killAudio();
      return;
    }
    var active = new Map();
    for (const c of project.audioClips) {
      if (tlTime >= c.start && tlTime < c.start + (c.sourceOut - c.sourceIn)) active.set(c.id, c);
    }
    audioEls.forEach(function (entry, id) {
      if (!active.has(id)) {
        try { entry.el.pause(); } catch (err) {}
        if (entry.sourceNode) {
          try { entry.sourceNode.disconnect(); } catch (e) {}
        }
        if (entry.gainNode) {
          try { entry.gainNode.disconnect(); } catch (e) {}
        }
        audioEls.delete(id);
      }
    });
    if (audioBlocked) return;
    var ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      resumeAudioContext();
    }
    active.forEach(function (clip, id) {
      var entry = audioEls.get(id);
      var targetGain = computeClipGain(clip);
      var wantVol = computeClipVolume(clip);
      if (entry) {
        if (entry.gainNode) {
          if (Math.abs(entry.gainNode.gain.value - targetGain) > 0.0001) {
            entry.gainNode.gain.value = targetGain;
          }
          if (Math.abs(entry.el.volume - 1.0) > 0.001) {
            try { entry.el.volume = 1.0; } catch (err) {}
          }
        } else {
          if (Math.abs(entry.el.volume - wantVol) > 0.001) {
            try { entry.el.volume = wantVol; } catch (err) {}
          }
        }
        return;
      }
      if (!force && audioEls.has(id)) return;
      var url = fileUrl(clip.file);
      if (!url) return;
      try {
        var el = new Audio(url);
        el.preload = 'auto';
        el.currentTime = clip.sourceIn + (tlTime - clip.start);
        var sourceNode = null;
        var gainNode = null;
        if (ctx) {
          try {
            sourceNode = ctx.createMediaElementSource(el);
            gainNode = ctx.createGain();
            gainNode.gain.value = targetGain;
            sourceNode.connect(gainNode);
            gainNode.connect(ctx.destination);
            el.volume = 1.0;
          } catch (e) {
            el.volume = wantVol;
          }
        } else {
          el.volume = wantVol;
        }
        audioEls.set(id, { el: el, sourceNode: sourceNode, gainNode: gainNode });
        var pr = el.play();
        if (pr && typeof pr.catch === 'function') {
          pr.catch(function () {
            audioBlocked = true;
            try { el.pause(); } catch (err) {}
            audioEls.delete(id);
          });
        }
      } catch (err) {}
    });
  }

  // ---- preview overlays ----
  function clearPreview() {
    var layer = $('overlayLayer');
    if (layer) layer.innerHTML = '';
    clearVideoOverlays();
  }

  function styleRect(el, geo) {
    el.style.left = (geo.x * 100) + '%';
    el.style.top = (geo.y * 100) + '%';
    el.style.width = (geo.w * 100) + '%';
    el.style.height = ((geo.h == null ? geo.w : geo.h) * 100) + '%';
  }

  function renderBlurCanvas(boxEl, clip) {
    if (!boxEl || !clip || clip.type !== 'blur' || clip.mode === 'mask') return;
    var cvs = boxEl.querySelector('canvas.ve-blur-canvas');
    if (!cvs) {
      cvs = document.createElement('canvas');
      cvs.className = 've-blur-canvas';
      cvs.setAttribute('data-testid', 'video-editor-blur-canvas');
      cvs.style.position = 'absolute';
      cvs.style.inset = '0';
      cvs.style.width = '100%';
      cvs.style.height = '100%';
      cvs.style.display = 'block';
      cvs.style.pointerEvents = 'none';
      cvs.style.filter = 'blur(10px)';
      cvs.style.clipPath = 'inset(0)';
      boxEl.insertBefore(cvs, boxEl.firstChild);
    }
    if (!video || !(video.videoWidth > 0 && video.videoHeight > 0)) return;

    var vw = video.videoWidth;
    var vh = video.videoHeight;
    var t = tlTime;

    var activeZoom = project && project.clips ? findDominantZoomClip(project.clips, t) : null;
    var activeClip = project ? activeVideoClipAt(project, t) : null;
    var mainCrop = (activeClip && activeClip.crop && cropEditingClipId !== activeClip.id) ? normalizeCrop(activeClip.crop) : null;

    var sx, sy, sw, sh;
    var clipH = clip.h == null ? clip.w : clip.h;

    if (activeZoom) {
      var zState = getZoomState(activeZoom, t);
      var lvl = zState.level || 1.5;
      sx = (zState.x + (clip.x - 0.5) / lvl) * vw;
      sy = (zState.y + (clip.y - 0.5) / lvl) * vh;
      sw = (clip.w / lvl) * vw;
      sh = (clipH / lvl) * vh;
    } else if (mainCrop) {
      var cW = Math.max(0.01, mainCrop.right - mainCrop.left);
      var cH = Math.max(0.01, mainCrop.bottom - mainCrop.top);
      var scale = Math.min(1 / cW, 1 / cH);
      var xMid = (mainCrop.left + mainCrop.right) / 2;
      var yMid = (mainCrop.top + mainCrop.bottom) / 2;
      sx = (xMid + (clip.x - 0.5) / scale) * vw;
      sy = (yMid + (clip.y - 0.5) / scale) * vh;
      sw = (clip.w / scale) * vw;
      sh = (clipH / scale) * vh;
    } else {
      sx = clip.x * vw;
      sy = clip.y * vh;
      sw = clip.w * vw;
      sh = clipH * vh;
    }

    sx = Math.max(0, Math.min(vw - 1, sx));
    sy = Math.max(0, Math.min(vh - 1, sy));
    sw = Math.max(1, Math.min(vw - sx, sw));
    sh = Math.max(1, Math.min(vh - sy, sh));

    var destW = Math.max(16, Math.min(320, Math.round(sw / 2)));
    var destH = Math.max(16, Math.min(240, Math.round(sh / 2)));
    if (cvs.width !== destW || cvs.height !== destH) {
      cvs.width = destW;
      cvs.height = destH;
    }

    var ctx = cvs.getContext('2d');
    if (!ctx) return;
    try {
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, destW, destH);
      if (project && project.clips) {
        project.clips.forEach(function (c) {
          if (c.type === 'voverlay' && isOverlayVisibleAt(c, t)) {
            var entry = overlayVideoEls.get(c.id);
            if (entry && entry.video && entry.video.videoWidth > 0) {
              var ox = c.x, oy = c.y, ow = c.w, oh = (c.h == null ? c.w : c.h);
              var bx = clip.x, by = clip.y, bw = clip.w, bh = clipH;
              var ix = Math.max(ox, bx);
              var iy = Math.max(oy, by);
              var iw = Math.min(ox + ow, bx + bw) - ix;
              var ih = Math.min(oy + oh, by + bh) - iy;
              if (iw > 0 && ih > 0) {
                var ovW = entry.video.videoWidth;
                var ovH = entry.video.videoHeight;
                var ovCrop = normalizeCrop(c.crop);
                var ovSx = (ovCrop ? ovCrop.left + ((ix - ox) / ow) * (ovCrop.right - ovCrop.left) : (ix - ox) / ow) * ovW;
                var ovSy = (ovCrop ? ovCrop.top + ((iy - oy) / oh) * (ovCrop.bottom - ovCrop.top) : (iy - oy) / oh) * ovH;
                var ovSw = (ovCrop ? (iw / ow) * (ovCrop.right - ovCrop.left) : iw / ow) * ovW;
                var ovSh = (ovCrop ? (ih / oh) * (ovCrop.bottom - ovCrop.top) : ih / oh) * ovH;
                var dx = ((ix - bx) / bw) * destW;
                var dy = ((iy - by) / bh) * destH;
                var dw = (iw / bw) * destW;
                var dh = (ih / bh) * destH;
                ctx.drawImage(entry.video, ovSx, ovSy, ovSw, ovSh, dx, dy, dw, dh);
              }
            }
          }
        });
      }
    } catch (err) {}
  }

  function syncBlurOverlays() {
    var layer = $('overlayLayer');
    if (!layer || !project) return;
    var boxes = layer.querySelectorAll('.ve-pbox[data-clip-id]');
    Array.prototype.forEach.call(boxes, function (box) {
      var id = box.getAttribute('data-clip-id');
      var clip = findClipAny(id);
      if (clip && clip.type === 'blur' && clip.mode !== 'mask') {
        renderBlurCanvas(box, clip);
      }
    });
  }

  function paintBox(el, clip) {
    if (clip.type === 'blur') {
      if (clip.mode === 'mask') {
        el.style.background = '#000';
        el.style.backdropFilter = 'none';
        el.style.webkitBackdropFilter = 'none';
        el.style.boxShadow = 'none';
        var oldCvs = el.querySelector('canvas.ve-blur-canvas');
        if (oldCvs) el.removeChild(oldCvs);
      } else {
        el.style.background = 'rgba(255,255,255,0.08)';
        el.style.backdropFilter = 'blur(12px)';
        el.style.webkitBackdropFilter = 'blur(12px)';
        el.style.boxShadow = 'inset 0 0 0 1px rgba(255,255,255,0.25)';
        renderBlurCanvas(el, clip);
      }
    } else if (clip.type === 'text') {
      el.textContent = clip.text || '';
      el.style.color = clip.color || '#fff';
      el.style.fontWeight = '700';
      // Full-text single-line preview: no automatic wrapping (export
      // drawtext has no width limit). Only explicit newlines break lines;
      // overflow stays visible so a long line is fully shown. Position,
      // width, font size and alignment behavior are unchanged.
      var wrap = textPreviewStyle();
      el.style.height = wrap.height;
      el.style.whiteSpace = wrap.whiteSpace;
      el.style.overflow = wrap.overflow;
      // Proportional to the export drawtext size (size × frame height), so
      // the preview matches the exported MP4. Falls back to the video height
      // (or 360px) when the overlay layer has no layout yet, so text is
      // always visible instead of inheriting an unpredictable font size.
      // Shrink-to-fit keeps the complete text inside the frame without
      // wrapping; the model size (used by export) is untouched.
      var layerBox = (el.parentElement && el.parentElement.getBoundingClientRect()) || null;
      var layerH = (layerBox && layerBox.height) || 0;
      var layerW = (layerBox && layerBox.width) || 0;
      if (!(layerH > 0) && video && video.clientHeight > 0) layerH = video.clientHeight;
      if (!(layerH > 0)) layerH = 360;
      if (clip.bg) {
        el.style.background = clip.bg;
        el.style.padding = '2px 8px';
        el.style.borderRadius = '6px';
      }
      // Sized last so the background padding counts toward the frame fit.
      el.style.fontSize = effectiveTextSizePx(clip, layerW, layerH, el) + 'px';
    } else if (clip.type === 'image') {
      var url = imageURLs[clip.file];
      if (!url) return false;
      el.style.clipPath = 'none';
      el.style.contain = 'none';
      var imCrop = normalizeCrop(clip.crop);
      if (imCrop && cropEditingClipId !== clip.id) {
        var cW = Math.max(0.01, imCrop.right - imCrop.left);
        var cH = Math.max(0.01, imCrop.bottom - imCrop.top);
        el.innerHTML = '<div style="position:absolute;inset:0;overflow:hidden;clip-path:inset(0);pointer-events:none;"><img src="' + escapeHtml(url) + '" style="position:absolute;width:' + (100 / cW) + '%;height:' + (100 / cH) + '%;left:' + (-imCrop.left * (100 / cW)) + '%;top:' + (-imCrop.top * (100 / cH)) + '%;display:block;user-select:none;-webkit-user-select:none;object-fit:fill;"></div>';
        el.style.background = 'none';
      } else {
        el.innerHTML = '<div style="position:absolute;inset:0;overflow:hidden;clip-path:inset(0);pointer-events:none;"><img src="' + escapeHtml(url) + '" style="position:absolute;width:100%;height:100%;left:0;top:0;display:block;user-select:none;-webkit-user-select:none;object-fit:fill;"></div>';
        el.style.background = 'none';
      }
    } else if (clip.type === 'zoom') {
      el.style.border = '2px solid #db2777';
      el.style.background = 'rgba(219,39,119,0.15)';
      el.style.cursor = 'move';
      el.innerHTML = '<div style="position:absolute;top:4px;left:4px;background:#db2777;color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;white-space:nowrap;pointer-events:none;">🔍 Zoom ' + (clip.level || 1.5) + 'x</div>';
    }
    return true;
  }

  // Second video track preview: persistent <video> elements (one per visible
  // overlay clip) in a dedicated layer above the box layer. They are NOT
  // rebuilt every frame — recreating a <video> would restart decoding — only
  // synced here (geometry, source time, play state). Drag/resize reuse the
  // shared onBoxDown machinery via identical box structure.
  var overlayVideoEls = new Map();

  function clearVideoOverlays() {
    overlayVideoEls.forEach(function (entry) {
      try { entry.video.pause(); } catch (err) {}
      try { entry.box.remove(); } catch (err) {}
    });
    overlayVideoEls.clear();
  }

  function videoFileEntryAt(index) {
    if (!project) return null;
    var videos = project.files.filter(function (f) { return f.kind === 'video'; });
    return videos[index] || null;
  }

  function syncVideoOverlays() {
    var layer = $('overlayVideoLayer');
    if (!layer) return;
    if (!project) { clearVideoOverlays(); return; }
    var layerBox = layer.getBoundingClientRect();
    var desired = {};
    project.clips.forEach(function (clip) {
      if (clip.type !== 'voverlay') return;
      if (!isOverlayVisibleAt(clip, tlTime)) return;
      desired[clip.id] = clip;
    });
    overlayVideoEls.forEach(function (entry, id) {
      if (!desired[id]) {
        try { entry.video.pause(); } catch (err) {}
        try { entry.box.remove(); } catch (err) {}
        overlayVideoEls.delete(id);
      }
    });
    Object.keys(desired).forEach(function (id) {
      var clip = desired[id];
      var entry = overlayVideoEls.get(id);
      if (!entry) {
        var fileEntry = videoFileEntryAt(clip.file);
        var url = fileEntry ? fileUrl(fileEntry.id) : '';
        if (!url) return;
        var box = document.createElement('div');
        box.className = 've-pbox';
        box.setAttribute('data-clip-id', clip.id);
        box.style.pointerEvents = 'auto';
        box.style.cursor = 'pointer';
        var vid = document.createElement('video');
        vid.muted = true;
        vid.playsInline = true;
        vid.preload = 'auto';
        vid.setAttribute('aria-label', 'Video overlay preview (muted)');
        vid.style.width = '100%';
        vid.style.height = '100%';
        vid.style.objectFit = 'fill';
        vid.style.pointerEvents = 'none';
        vid.style.display = 'block';
        vid.src = url;

        var sh = document.createElement('div');
        sh.className = 've-voshadow';
        sh.style.position = 'absolute';
        sh.style.inset = '0';
        sh.style.background = '#000';
        sh.style.pointerEvents = 'none';
        sh.style.display = 'none';

        // Handle source loading and seek delays safely: seek as soon as the source is loaded/ready.
        var onVideoReady = function () {
          var currentClip = getClip(project, clip.id);
          if (!currentClip) return;
          var t = (currentClip.sourceIn || 0) + (tlTime - currentClip.start);
          try { vid.currentTime = Math.max(0, t); } catch (err) {}
        };
        vid.addEventListener('loadedmetadata', onVideoReady);
        vid.addEventListener('canplay', onVideoReady);

        box.appendChild(vid);
        // NOTE: vid must already be a child of box here; insertBefore with
        // a non-child reference throws NotFoundError, which previously
        // terminated the playback animation loop on the first tick.
        box.insertBefore(sh, vid);

        // Delegation-based pointerdown: unselected box selects on click; selected box drags/resizes.
        box.addEventListener('pointerdown', function (e) {
          if (cropEditingClipId === clip.id) return;
          e.stopPropagation();
          var isSel = project && project.selectedId === clip.id;
          if (!isSel && project) {
            project.selectedId = clip.id;
            syncSelection();
            box.classList.add('ve-active');
            if (!box.querySelector('.ve-corner')) {
              ['nw', 'ne', 'sw', 'se'].forEach(function (corner) {
                var c = document.createElement('div');
                c.className = 've-corner ve-corner-' + corner;
                c.setAttribute('data-corner', corner);
                box.appendChild(c);
              });
              ['n', 's', 'e', 'w'].forEach(function (edge) {
                var eHandle = document.createElement('div');
                eHandle.className = 've-pbox-edge ve-pbox-edge-' + edge;
                eHandle.setAttribute('data-edge', edge);
                box.appendChild(eHandle);
              });
            }
            renderInspector();
          }
          onBoxDown(clip.id, box)(e);
        });

        layer.appendChild(box);
        entry = { box: box, video: vid, shadow: sh, cornersFor: null };
        overlayVideoEls.set(id, entry);
      }
      var fileEntry = videoFileEntryAt(clip.file);
      var url = fileEntry ? fileUrl(fileEntry.id) : '';
      if (entry && url && entry.video.src !== url && !entry.video.src.endsWith(url)) {
        entry.video.src = url;
      }
      styleRect(entry.box, clip);
      entry.box.style.overflow = 'visible';
      entry.box.style.contain = 'none';
      // Independent webcam-bubble polish: horizontal mirror composes with
      // crop positioning via transform; shadow is a blurred offset
      // silhouette behind the video, shaped like the bubble.
      entry.video.style.transform = clip.mirror ? 'scaleX(-1)' : '';
      var shAmt = (typeof clip.shadow === 'number' && clip.shadow > 0) ? Math.min(1, clip.shadow) : 0;
      if (entry.shadow) {
        if (!shAmt) {
          entry.shadow.style.display = 'none';
        } else {
          var shBoxW = entry.box.offsetWidth || 0;
          var shBlur = Math.max(2, Math.round((shBoxW > 0 ? shBoxW : 160) / 24));
          var shOff = Math.max(1, Math.round((shBoxW > 0 ? shBoxW : 160) / 90));
          entry.shadow.style.display = 'block';
          entry.shadow.style.opacity = String(Math.round(shAmt * 100) / 100);
          entry.shadow.style.filter = 'blur(' + shBlur + 'px)';
          entry.shadow.style.transform = 'translate(' + shOff + 'px,' + shOff + 'px)';
        }
      }
      var ovShape = clip.shape ? String(clip.shape).trim().toLowerCase() : 'rect';
      if (ovShape === 'circle' || ovShape === 'ellipse') {
        entry.video.style.borderRadius = '50%';
        entry.video.style.clipPath = 'ellipse(50% 50% at 50% 50%)';
        if (entry.shadow) {
          entry.shadow.style.borderRadius = '50%';
          entry.shadow.style.clipPath = 'ellipse(50% 50% at 50% 50%)';
        }
      } else if (ovShape === 'rounded' || ovShape === 'rounded-rect' || ovShape === 'round') {
        entry.video.style.borderRadius = '12px';
        entry.video.style.clipPath = 'inset(0 round 12px)';
        if (entry.shadow) {
          entry.shadow.style.borderRadius = '12px';
          entry.shadow.style.clipPath = 'inset(0 round 12px)';
        }
      } else {
        entry.video.style.borderRadius = '0px';
        entry.video.style.clipPath = 'none';
        if (entry.shadow) {
          entry.shadow.style.borderRadius = '0px';
          entry.shadow.style.clipPath = 'none';
        }
      }
      var ovCrop = normalizeCrop(clip.crop);
      if (ovCrop && cropEditingClipId !== clip.id) {
        var cW = Math.max(0.01, ovCrop.right - ovCrop.left);
        var cH = Math.max(0.01, ovCrop.bottom - ovCrop.top);
        entry.video.style.position = 'absolute';
        entry.video.style.width = (100 / cW) + '%';
        entry.video.style.height = (100 / cH) + '%';
        entry.video.style.left = (-ovCrop.left * (100 / cW)) + '%';
        entry.video.style.top = (-ovCrop.top * (100 / cH)) + '%';
      } else {
        entry.video.style.position = 'static';
        entry.video.style.width = '100%';
        entry.video.style.height = '100%';
        entry.video.style.left = '0%';
        entry.video.style.top = '0%';
      }
      var isEditingCrop = cropEditingClipId === clip.id;
      var isSelected = project.selectedId === clip.id;
      entry.box.classList.toggle('ve-active', isSelected && !isEditingCrop);
      if ((isSelected && !isEditingCrop ? clip.id : null) !== entry.cornersFor) {
        entry.box.querySelectorAll('[data-corner], [data-edge]').forEach(function (c) { c.remove(); });
        if (isSelected && !isEditingCrop) {
          ['nw', 'ne', 'sw', 'se'].forEach(function (corner) {
            var c = document.createElement('div');
            c.className = 've-corner ve-corner-' + corner;
            c.setAttribute('data-corner', corner);
            entry.box.appendChild(c);
          });
          ['n', 's', 'e', 'w'].forEach(function (edge) {
            var eHandle = document.createElement('div');
            eHandle.className = 've-pbox-edge ve-pbox-edge-' + edge;
            eHandle.setAttribute('data-edge', edge);
            entry.box.appendChild(eHandle);
          });
        }
        entry.cornersFor = isSelected && !isEditingCrop ? clip.id : null;
      }
      try {
        var target = (clip.sourceIn || 0) + (tlTime - clip.start);
        if (entry.video.readyState >= 1) {
          var diff = Math.abs(entry.video.currentTime - target);
          if (timelinePlaying) {
            if (diff > 0.35) {
              entry.video.currentTime = Math.max(0, target);
            }
          } else {
            // When paused, perform exact synchronization (>0.01s) for frame-accurate scrubbing.
            if (diff > 0.01) {
              entry.video.currentTime = Math.max(0, target);
            }
          }
        }
        if (timelinePlaying) {
          if (entry.video.paused) {
            var played = entry.video.play();
            if (played && played.catch) played.catch(function () {});
          }
        } else if (!entry.video.paused) {
          entry.video.pause();
        }
      } catch (err) {}
    });
  }

  function renderPreview() {
    var layer = $('overlayLayer');
    if (!layer || !project || !video) return;
    // Never rebuild while a preview drag owns the gesture or the inline text
    // editor is open: the dragged box / editor would be destroyed mid-use
    // (listeners + capture lost after one step, or typed text wiped).
    if (dragKind === 'preview' || editingText) return;
    layer.innerHTML = '';
    syncWatermarkFromUI();
    var t = tlTime;
    project.clips.forEach(function (clip) {
      // Video overlays render in the dedicated video layer below (live
      // <video> elements would restart if rebuilt here every frame).
      if (clip.type === 'voverlay') return;
      // Same predicate as the export graph (FFmpeg between(t,start,end) is
      // inclusive): text/blur/image overlays show iff t is within [start, end].
      if (!isOverlayVisibleAt(clip, t)) return;
      var box = document.createElement('div');
      box.className = 've-pbox';
      box.setAttribute('data-clip-id', clip.id);
      var geo;
      if (clip.type === 'text') {
        geo = textBoxGeo(clip);
      } else if (clip.type === 'zoom') {
        geo = zoomPreviewRect(clip);
      } else {
        geo = { x: clip.x, y: clip.y, w: clip.w, h: clip.h };
      }
      // Overlay keyframes are evaluated at clip-relative playhead time.
      // Geometry remains untouched in the project model; only preview styling changes.
      var animationValues = null;
      if (['text', 'image', 'voverlay'].indexOf(clip.type) >= 0 && Array.isArray(clip.keyframes) && clip.keyframes.length) {
        animationValues = evaluateKeyframes(clip.keyframes, Math.max(0, t - clip.start), Math.max(0.001, clip.end - clip.start));
        if (animationValues) {
          if (animationValues.x !== undefined) geo.x = animationValues.x;
          if (animationValues.y !== undefined) geo.y = animationValues.y;
        }
      }
      styleRect(box, geo);
      if (animationValues) {
        if (animationValues.opacity !== undefined) box.style.opacity = String(animationValues.opacity);
        if (animationValues.scale !== undefined) {
          box.style.transform = 'scale(' + animationValues.scale + ')';
          box.style.transformOrigin = 'center center';
        }
      }
      layer.appendChild(box);
      if (!paintBox(box, clip)) { layer.removeChild(box); return; }
      if (clip.type === 'image') box.style.overflow = 'visible';
      var isEditingCrop = cropEditingClipId === clip.id;
      if (project.selectedId === clip.id) {
        if (!isEditingCrop) {
          box.classList.add('ve-active');
          ['nw', 'ne', 'sw', 'se'].forEach(function (corner) {
            var c = document.createElement('div');
            c.className = 've-corner ve-corner-' + corner;
            c.setAttribute('data-corner', corner);
            box.appendChild(c);
          });
          if (clip.type !== 'text') {
            ['n', 's', 'e', 'w'].forEach(function (edge) {
              var eHandle = document.createElement('div');
              eHandle.className = 've-pbox-edge ve-pbox-edge-' + edge;
              eHandle.setAttribute('data-edge', edge);
              box.appendChild(eHandle);
            });
          }
          box.addEventListener('pointerdown', onBoxDown(clip.id));
        }
        if (clip.type === 'text') {
          box.addEventListener('dblclick', function (e) {
            e.stopPropagation();
            startTextEdit(clip.id, box);
          });
        }
      } else {
        box.style.pointerEvents = 'auto';
        box.style.cursor = 'pointer';
        box.addEventListener('pointerdown', function (e) {
          if (cropEditingClipId === clip.id) return;
          e.stopPropagation();
          project.selectedId = clip.id;
          syncSelection();
          renderInspector();
          box.classList.add('ve-active');
          if (!box.querySelector('.ve-corner')) {
            ['nw', 'ne', 'sw', 'se'].forEach(function (corner) {
              var c = document.createElement('div');
              c.className = 've-corner ve-corner-' + corner;
              c.setAttribute('data-corner', corner);
              box.appendChild(c);
            });
            if (clip.type !== 'text') {
              ['n', 's', 'e', 'w'].forEach(function (edge) {
                var eHandle = document.createElement('div');
                eHandle.className = 've-pbox-edge ve-pbox-edge-' + edge;
                eHandle.setAttribute('data-edge', edge);
                box.appendChild(eHandle);
              });
            }
          }
          onBoxDown(clip.id, box)(e);
        });
      }
    });

    // On-canvas scale control box for main video clip when selected
    var activeClip = activeVideoClipAt(project, t);
    if (activeClip && project.selectedId === activeClip.id && cropEditingClipId !== activeClip.id) {
      var mainScale = (activeClip.scale && activeClip.scale > 0) ? activeClip.scale : 1.0;
      var mainBox = document.createElement('div');
      mainBox.className = 've-pbox ve-active ve-main-video-box';
      mainBox.setAttribute('data-clip-id', activeClip.id);
      mainBox.setAttribute('data-testid', 'video-editor-main-scale-box');
      mainBox.style.position = 'absolute';
      mainBox.style.left = '0%';
      mainBox.style.top = '0%';
      mainBox.style.width = '100%';
      mainBox.style.height = '100%';
      mainBox.style.border = '2px dashed #38bdf8';
      mainBox.style.pointerEvents = 'none';
      mainBox.style.cursor = 'default';
      mainBox.style.zIndex = '28';

      ['nw', 'ne', 'sw', 'se'].forEach(function (corner) {
        var c = document.createElement('div');
        c.className = 've-corner ve-corner-' + corner;
        c.setAttribute('data-corner', corner);
        c.style.pointerEvents = 'auto';
        mainBox.appendChild(c);
      });
      ['n', 's', 'e', 'w'].forEach(function (edge) {
        var eHandle = document.createElement('div');
        eHandle.className = 've-pbox-edge ve-pbox-edge-' + edge;
        eHandle.setAttribute('data-edge', edge);
        eHandle.style.pointerEvents = 'auto';
        mainBox.appendChild(eHandle);
      });

      var label = document.createElement('div');
      label.className = 've-main-video-label';
      label.style.position = 'absolute';
      label.style.top = '4px';
      label.style.left = '4px';
      label.style.background = '#0284c7';
      label.style.color = '#fff';
      label.style.fontSize = '10px';
      label.style.fontWeight = '700';
      label.style.padding = '2px 6px';
      label.style.borderRadius = '4px';
      label.style.pointerEvents = 'none';
      label.textContent = '🎬 Main Video (' + Math.round(mainScale * 100) + '%)';
      mainBox.appendChild(label);

      mainBox.addEventListener('pointerdown', onMainVideoBoxDown(activeClip.id, mainBox));
      layer.appendChild(mainBox);
    }
    // Burned-in watermark preview (topmost, always visible when ON — the
    // export drawtext has no time gate either). Text, size, color, opacity
    // and geometry mirror the server filter via watermarkPreviewLayout.
    var watermarkList = Array.isArray(project.watermarks) && project.watermarks.length ? project.watermarks : [project.watermark];
    watermarkList.forEach(function (rawWatermark) {
      var wmState = normalizeProjectWatermark(rawWatermark);
      if (!wmState || !wmState.enabled) return;
      var layerBox = layer.getBoundingClientRect();
      var wmLayout = watermarkPreviewLayout(wmState, layerBox.width || 0, layerBox.height || 0);
      var wm = document.createElement('div');
      wm.className = 've-pbox ve-watermark';
      wm.setAttribute('data-testid', 'video-editor-watermark-preview');
      wm.textContent = wmLayout.text;
      wm.style.pointerEvents = 'none';
      wm.style.color = wmLayout.color;
      wm.style.opacity = String(wmLayout.opacity01);
      wm.style.fontWeight = '800';
      wm.style.textShadow = '2px 2px 3px rgba(0,0,0,0.6)';
      wm.style.fontSize = wmLayout.fontSizePx + 'px';
      wm.style.whiteSpace = 'nowrap';
      if (wmState.motion && wmState.motion !== 'none') {
        // renderPreview runs during playback ticks, so derive the watermark's
        // horizontal position from timeline time for a smooth live preview.
        wm.style.left = '0px';
        wm.style.right = 'auto';
        wm.style.transform = 'none';
        if (wmLayout.centered) {
          wm.style.top = '50%';
          wm.style.bottom = 'auto';
          wm.style.transform = 'translateY(-50%)';
        } else {
          if (wmLayout.top != null) wm.style.top = wmLayout.top + 'px';
          if (wmLayout.bottom != null) wm.style.bottom = wmLayout.bottom + 'px';
        }
        layer.appendChild(wm);
        var maxX = Math.max(0, (layer.clientWidth || layerBox.width) - wm.offsetWidth);
        var travel = maxX > 0 ? (Math.max(0, tlTime) * Number(wmState.speed || 80)) % maxX : 0;
        wm.style.left = ((wmState.motion === 'right-to-left') ? maxX - travel : travel) + 'px';
      } else {
        if (wmLayout.centered) {
          wm.style.left = '50%';
          wm.style.top = '50%';
          wm.style.transform = 'translate(-50%,-50%)';
        } else {
          if (wmLayout.left != null) wm.style.left = wmLayout.left + 'px';
          if (wmLayout.top != null) wm.style.top = wmLayout.top + 'px';
          if (wmLayout.right != null) wm.style.right = wmLayout.right + 'px';
          if (wmLayout.bottom != null) wm.style.bottom = wmLayout.bottom + 'px';
        }
        layer.appendChild(wm);
      }
    });
    // Real-time video preview zoom and crop transform
    var activeZoom = findDominantZoomClip(project.clips, t);
    var activeClip = activeVideoClipAt(project, t);
    var mainCrop = (activeClip && activeClip.crop) ? normalizeCrop(activeClip.crop) : null;
    var mainScale = (activeClip && activeClip.scale && activeClip.scale > 0) ? activeClip.scale : 1.0;

    if (activeZoom) {
      // Paint the exact export window: object-view-box selects the content
      // rect with no layout impact, so the zoomed video is clipped to the
      // actual video frame in every layout (the old origin+scale paint
      // drifted off-center and could overflow the frame).
      var zState = getZoomState(activeZoom, t);
      var zEff = (Number(zState.level) > 0 ? Number(zState.level) : 1) * mainScale;
      var zBox = zoomPreviewRect({ level: zEff, x: zState.x, y: zState.y });
      var zPaint = zoomPaintStyle(zBox, zEff);
      var useObjectViewBox = false;
      try { useObjectViewBox = !!video.style && ('objectViewBox' in video.style); } catch (err) {}
      if (useObjectViewBox) {
        video.style.clipPath = 'none';
        video.style.transform = 'none';
        video.style.transformOrigin = '';
        try { video.style.objectViewBox = zPaint.objectViewBox; } catch (err) {}
      } else {
        try { video.style.objectViewBox = ''; } catch (err) {}
        video.style.clipPath = 'none';
        video.style.transformOrigin = zPaint.transformOrigin;
        video.style.transform = zPaint.transform;
      }
    } else if (mainCrop && cropEditingClipId !== activeClip.id) {
      var cW = Math.max(0.01, mainCrop.right - mainCrop.left);
      var cH = Math.max(0.01, mainCrop.bottom - mainCrop.top);
      var xMid = (mainCrop.left + mainCrop.right) / 2;
      var yMid = (mainCrop.top + mainCrop.bottom) / 2;
      var scale = Math.min(1 / cW, 1 / cH) * mainScale;
      video.style.clipPath = 'inset(' + (mainCrop.top * 100) + '% ' + ((1 - mainCrop.right) * 100) + '% ' + ((1 - mainCrop.bottom) * 100) + '% ' + (mainCrop.left * 100) + '%)';
      video.style.transformOrigin = (xMid * 100) + '% ' + (yMid * 100) + '%';
      video.style.transform = 'translate(' + ((0.5 - xMid) * 100) + '%, ' + ((0.5 - yMid) * 100) + '%) scale(' + scale + ')';
      try { video.style.objectViewBox = ''; } catch (err) {}
    } else {
      video.style.clipPath = 'none';
      video.style.transformOrigin = '50% 50%';
      video.style.transform = 'scale(' + mainScale + ')';
      try { video.style.objectViewBox = ''; } catch (err) {}
    }

    var selectedClip = project.selectedId ? getClip(project, project.selectedId) : null;
    if (selectedClip && selectedClip.type === 'zoom') {
      layer.style.pointerEvents = 'auto';
      layer.style.cursor = 'crosshair';
      layer.style.touchAction = 'none';
    } else {
      layer.style.pointerEvents = 'none';
      layer.style.cursor = '';
      layer.style.touchAction = '';
    }

    syncVideoOverlays();
    syncBlurOverlays();
    renderCropLayer();
  }

  // Burned-in watermark state lives on the project (like clips) so export and
  // preview share one source of truth. The controls are the editors; this
  // sync runs before every preview render and before export.
  var activeWatermarkIndex = 0;
  function renderWatermarkSelector() {
    var select = $('veWatermarkSelect');
    if (!select || !project) return;
    var list = Array.isArray(project.watermarks) && project.watermarks.length ? project.watermarks : [normalizeProjectWatermark(project.watermark)];
    select.innerHTML = '';
    list.forEach(function (wm, i) { var opt = document.createElement('option'); opt.value = String(i); opt.textContent = (i + 1) + '. ' + ((wm && wm.text) || 'Watermark'); select.appendChild(opt); });
    activeWatermarkIndex = Math.max(0, Math.min(list.length - 1, activeWatermarkIndex));
    select.value = String(activeWatermarkIndex);
    var remove = $('veRemoveWatermark'); if (remove) remove.disabled = list.length <= 1;
    var add = $('veAddWatermark'); if (add) add.disabled = list.length >= 10;
  }

  function syncWatermarkFromUI() {
    var box = $('veWatermark');
    var posEl = $('veWatermarkPosition');
    var textEl = $('veWatermarkText');
    var sizeEl = $('veWatermarkSize');
    var colorEl = $('veWatermarkColor');
    var opacityEl = $('veWatermarkOpacity');
    var motionEl = $('veWatermarkMotion');
    var speedEl = $('veWatermarkSpeed');
    var wrap = $('veWatermarkPositionWrap');
    var enabled = !!(box && box.checked);
    var position = posEl ? Number(posEl.value) : 1;
    if (![1, 2, 3, 4, 5].includes(position)) position = 1;
    var state = {
      enabled: enabled,
      position: position,
      text: textEl ? textEl.value : undefined,
      size: sizeEl && String(sizeEl.value).trim() !== '' ? Number(sizeEl.value) / 100 : undefined,
      color: colorEl ? colorEl.value : undefined,
      opacity: opacityEl && String(opacityEl.value).trim() !== '' ? Number(opacityEl.value) : undefined,
      motion: motionEl ? motionEl.value : 'none',
      speed: speedEl && String(speedEl.value).trim() !== '' ? Number(speedEl.value) : 80
    };
    if (project) {
      var list = Array.isArray(project.watermarks) && project.watermarks.length ? project.watermarks.slice() : [normalizeProjectWatermark(project.watermark)];
      var idx = Math.max(0, Math.min(list.length - 1, Number(activeWatermarkIndex) || 0));
      list[idx] = state; project.watermarks = list; project.watermark = list[0]; renderWatermarkSelector();
    }
    if (wrap) wrap.style.display = enabled ? '' : 'none';
    return state;
  }

  function syncWatermarkToUI(watermark) {
    var wm = normalizeProjectWatermark(watermark);
    if (!wm) return;
    var box = $('veWatermark');
    var posEl = $('veWatermarkPosition');
    var textEl = $('veWatermarkText');
    var sizeEl = $('veWatermarkSize');
    var colorEl = $('veWatermarkColor');
    var opacityEl = $('veWatermarkOpacity');
    var motionEl = $('veWatermarkMotion');
    var speedEl = $('veWatermarkSpeed');
    var wrap = $('veWatermarkPositionWrap');
    if (box) box.checked = !!wm.enabled;
    if (posEl) posEl.value = String(wm.position || 1);
    if (textEl && wm.text !== undefined) textEl.value = wm.text;
    if (sizeEl && wm.size !== undefined) sizeEl.value = Math.round(wm.size * 1000) / 10;
    if (colorEl && wm.color !== undefined) colorEl.value = wm.color;
    if (opacityEl && wm.opacity !== undefined) opacityEl.value = wm.opacity;
    if (motionEl) motionEl.value = wm.motion || 'none';
    if (speedEl) speedEl.value = wm.speed || 80;
    if (wrap) wrap.style.display = wm.enabled ? '' : 'none';
    if (project) {
      var list = Array.isArray(project.watermarks) && project.watermarks.length ? project.watermarks.slice() : [wm];
      list[activeWatermarkIndex] = wm; project.watermarks = list; project.watermark = list[0]; renderWatermarkSelector();
    }
  }

  // Preview text box geometry derived from the clip (mirrors renderPreview).
  function textBoxGeo(clip) {
    return { x: clip.x, y: clip.y, w: Math.max(0.05, clip.size * 4), h: clip.size * 1.4 };
  }

  var measureCtx = null;
  function measureCanvasCtx() {
    if (!measureCtx) {
      try { measureCtx = document.createElement('canvas').getContext('2d'); } catch (err) { measureCtx = null; }
    }
    return measureCtx;
  }

  // Actual rendered text metrics at a candidate pixel size: widest explicit
  // line (canvas measureText with the preview weight/family — no layout
  // cost) and per-line height from real font metrics. Never wraps: only
  // explicit newlines split lines.
  function textContentMetrics(text, sizePx, family) {
    var lines = String(text == null ? '' : text).split('\n');
    var ctx = measureCanvasCtx();
    var widths = [0];
    var lineH = sizePx * 1.2;
    if (ctx && sizePx > 0) {
      try {
        ctx.font = '700 ' + sizePx + 'px ' + (family || 'sans-serif');
        widths = lines.map(function (ln) { return ctx.measureText(ln).width; });
        var probe = ctx.measureText('Hg');
        if (probe && Number.isFinite(probe.fontBoundingBoxAscent) && Number.isFinite(probe.fontBoundingBoxDescent)) {
          var real = probe.fontBoundingBoxAscent + probe.fontBoundingBoxDescent;
          if (real > 0) lineH = real;
        }
      } catch (err) {}
    }
    return { maxW: Math.max.apply(null, widths.concat([0])), lineH: lineH, lines: lines.length };
  }

  // Rendered font size for a text clip: the user size, automatically reduced
  // just enough that the complete text (widest explicit line, all lines)
  // fits the frame space available from its anchor. Single line stays one
  // line; explicit newlines stay multiline; the 8px readability floor is
  // kept, so pathological cases still degrade to frame-edge clipping
  // exactly like the export does. The box's own chrome (border, background
  // padding) is subtracted from the available space — otherwise the fitted
  // text still overhangs by exactly the chrome width.
  function effectiveTextSizePx(clip, layerW, layerH, el) {
    var base = Math.max(8, (clip.size || 0.05) * layerH);
    if (!(layerW > 0 && layerH > 0)) return base;
    var family = previewFontFamily(el);
    var chromeW = 0, chromeH = 0;
    try {
      var cs = el ? window.getComputedStyle(el) : null;
      if (cs) {
        chromeW = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0) +
          (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        chromeH = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0) +
          (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      }
    } catch (err) {}
    var m = textContentMetrics(clip.text || '', base, family);
    var availW = Math.max(1, layerW - (Number(clip.x) || 0) * layerW - chromeW);
    var availH = Math.max(1, layerH - (Number(clip.y) || 0) * layerH - chromeH);
    return Math.max(8, base * fitTextScale(m.maxW, m.lineH * m.lines, availW, availH));
  }

  function previewFontFamily(el) {
    try {
      var fam = window.getComputedStyle(el).fontFamily;
      if (fam) return fam;
    } catch (err) {}
    return 'sans-serif';
  }

  // Live-update a dragged box without rebuilding (see renderPreview guard).
  function syncBoxEl(boxEl, clip) {
    if (clip.type === 'text') {
      styleRect(boxEl, textBoxGeo(clip));
      // Same single-line contract as paintBox: no auto-wrap while the box
      // is dragged/resized, explicit newlines still break (position/size live).
      var wrapLive = textPreviewStyle();
      boxEl.style.height = wrapLive.height;
      boxEl.style.whiteSpace = wrapLive.whiteSpace;
      boxEl.style.overflow = wrapLive.overflow;
      var liveBox = (boxEl.parentElement && boxEl.parentElement.getBoundingClientRect()) || null;
      var layerH = (liveBox && liveBox.height) || 0;
      var layerW = (liveBox && liveBox.width) || 0;
      if (!(layerH > 0) && video && video.clientHeight > 0) layerH = video.clientHeight;
      if (!(layerH > 0)) layerH = 360;
      boxEl.style.fontSize = effectiveTextSizePx(clip, layerW, layerH, boxEl) + 'px';
    } else if (clip.type === 'zoom') {
      styleRect(boxEl, zoomPreviewRect(clip));
    } else if (clip.type === 'image') {
      styleRect(boxEl, { x: clip.x, y: clip.y, w: clip.w, h: clip.h || clip.w });
    } else if (clip.type === 'blur') {
      styleRect(boxEl, clip);
      if (clip.mode !== 'mask') {
        renderBlurCanvas(boxEl, clip);
      }
    } else {
      styleRect(boxEl, clip);
    }
  }

  // Keep a text box inside the video frame using its ACTUAL rendered size
  // (measured from the live box element, so long single lines and multiple
  // explicit lines count exactly). The frame stays the clipping boundary:
  // only the anchor moves, never the overflow rules. No-op when the layer
  // has no layout yet.
  function fitTextToFrame(boxEl, clip) {
    var layer = $('overlayLayer');
    if (!layer || !boxEl || !clip) return;
    var lr = layer.getBoundingClientRect();
    if (!(lr.width > 0 && lr.height > 0)) return;
    var br = boxEl.getBoundingClientRect();
    var g = clampTextToFrame(clip.x, clip.y, br.width / lr.width, br.height / lr.height);
    clip.x = g.x;
    clip.y = g.y;
    boxEl.style.left = (g.x * 100) + '%';
    boxEl.style.top = (g.y * 100) + '%';
  }

  function previewFrac(layer, clientX, clientY) {
    var r = layer ? layer.getBoundingClientRect() : null;
    if (!r || r.width <= 0 || r.height <= 0) {
      var pWrap = $('previewWrap');
      if (pWrap) r = pWrap.getBoundingClientRect();
    }
    if (!r || r.width <= 0 || r.height <= 0) return { x: 0, y: 0 };
    return {
      x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (clientY - r.top) / r.height))
    };
  }

  function onBoxDown(id, boxElExplicit) {
    return function (e) {
      if (!project) return;
      var clip = getClip(project, id);
      if (!clip) return;
      // A direct canvas drag takes manual ownership of a webcam bubble's
      // position: drop any recorded placement preset so the inspector label
      // cannot go stale (x/y stay authoritative everywhere).
      if (clip.type === 'voverlay' && clip.preset != null) clip.preset = null;
      // Capture synchronously: the box must survive the whole gesture, so no
      // rebuild may happen before/during the drag (see renderPreview guard).
      var boxEl = boxElExplicit || e.currentTarget;
      // All overlay geometry is expressed as percentages of the main preview frame.
      // Use that canonical coordinate space even when the box lives in the separate
      // #overlayVideoLayer; its parent can have different bounds in Workspace mode.
      var layer = $('overlayLayer') || (boxEl ? boxEl.parentElement : null);
      if (!boxEl || !layer) return;
      var handleEl = e.target.closest ? e.target.closest('[data-corner], [data-edge], [data-handle]') : null;
      var handle = handleEl ? (handleEl.getAttribute('data-corner') || handleEl.getAttribute('data-edge') || handleEl.getAttribute('data-handle')) : null;
      var resizing = !!handle && (clip.type !== 'text' || handle === 'se');
      var moved = false;

      if (e && e.stopPropagation) e.stopPropagation();
      if (e && e.preventDefault && (resizing || e.button === 0)) e.preventDefault();

      dragKind = 'preview';
      if (resizing && clip.type === 'text') {
        var startSize = clip.size || 0.05;
        var p0 = previewFrac(layer, e.clientX, e.clientY);
        startDrag(e, function (ev) {
          var p = previewFrac(layer, ev.clientX, ev.clientY);
          var layerH = layer.getBoundingClientRect().height || 1;
          var h0 = Math.max(1, startSize * 1.4 * layerH);
          var h1 = Math.max(8, (startSize * 1.4 + (p.y - p0.y)) * layerH);
          clip.size = Math.min(0.25, Math.max(0.02, startSize * (h1 / h0)));
          moved = true;
          syncBoxEl(boxEl, clip);
          // A bigger font means a bigger box: re-fit the anchor so the
          // resized text stays inside the frame where possible.
          fitTextToFrame(boxEl, clip);
          var inspSize = document.querySelector('#veInspector [data-insp="size"]');
          if (inspSize) inspSize.value = Math.round(clip.size * 1000) / 10;
        }, function () {
          dragKind = null;
          renderPreview();
          renderInspector();
        });
      } else if (resizing && clip.type === 'zoom') {
        // Center-based model (Premiere Scale + Position style): scale the
        // region symmetrically about the stored target center instead of
        // pinning the opposite corner (which stuck zoom-out at ~1.3x and let
        // edge drags drift the orthogonal axis). Enlarging reduces
        // magnification continuously to full-frame (level 1.0); the center
        // only shifts the minimum needed to keep the box in frame. Level
        // stays precise during the gesture — rounding to 0.1 per move made
        // the rendered box jump in steps.
        var zStart = {
          level: (Number(clip.level) > 0 ? Number(clip.level) : 1.5),
          x: clip.x,
          y: clip.y
        };
        var zRect = layer.getBoundingClientRect ? layer.getBoundingClientRect() : null;
        var zLayerW = (zRect && zRect.width) || 0;
        var zLayerH = (zRect && zRect.height) || 0;
        var zDownX = e.clientX;
        var zDownY = e.clientY;
        startDrag(e, function (ev) {
          var zdx = (ev.clientX !== undefined && zDownX !== undefined) ? ev.clientX - zDownX : 0;
          var zdy = (ev.clientY !== undefined && zDownY !== undefined) ? ev.clientY - zDownY : 0;
          var zd = zoomResizeDelta(zStart, handle, zdx, zdy, zLayerW, zLayerH);
          if (!zd) return;
          clip.level = zd.level;
          clip.x = zd.x;
          clip.y = zd.y;
          if (clip.w !== undefined) delete clip.w;
          if (clip.h !== undefined) delete clip.h;
          moved = true;
          syncBoxEl(boxEl, clip);
          var zLvl = document.querySelector('#veInspector [data-insp="zoomLevel"]');
          var zX = document.querySelector('#veInspector [data-insp="x"]');
          var zY = document.querySelector('#veInspector [data-insp="y"]');
          if (zLvl) zLvl.value = Math.round(clip.level * 100) / 100;
          if (zX) zX.value = Math.round(clip.x * 1000) / 10;
          if (zY) zY.value = Math.round(clip.y * 1000) / 10;
        }, function () {
          dragKind = null;
          renderPreview();
          renderInspector();
        });
      } else if (resizing) {
        var hasH = clip.h != null;
        var startGeo = { x: clip.x, y: clip.y, w: clip.w, h: hasH ? clip.h : clip.w };
        var r0 = previewFrac(layer, e.clientX, e.clientY);
        var isAspectType = clip.type === 'voverlay' || clip.type === 'image';
        var startAspect = (startGeo.h > 0) ? (startGeo.w / startGeo.h) : 1;
        startDrag(e, function (ev) {
          var p = previewFrac(layer, ev.clientX, ev.clientY);
          var dx = p.x - r0.x;
          var dy = p.y - r0.y;
          var g = resizeGeo(startGeo, handle, dx, dy, { preserveAspect: isAspectType, aspect: startAspect, minDim: GEO_MIN });
          var q4 = function (val) { return Math.round(val * 1e4) / 1e4; };
          clip.x = q4(g.x);
          clip.y = q4(g.y);
          clip.w = q4(g.w);
          clip.h = q4(g.h);
          moved = true;
          syncBoxEl(boxEl, clip);
          var inspX = document.querySelector('#veInspector [data-insp="x"]');
          var inspY = document.querySelector('#veInspector [data-insp="y"]');
          var inspW = document.querySelector('#veInspector [data-insp="w"]');
          var inspH = document.querySelector('#veInspector [data-insp="h"]');
          if (inspX) inspX.value = Math.round(clip.x * 1000) / 10;
          if (inspY) inspY.value = Math.round(clip.y * 1000) / 10;
          if (inspW) inspW.value = Math.round(clip.w * 1000) / 10;
          if (inspH) inspH.value = Math.round(clip.h * 1000) / 10;
        }, function () {
          dragKind = null;
          renderPreview();
          renderInspector();
        });
      } else {
        var q0 = previewFrac(layer, e.clientX, e.clientY);
        var ox = clip.x;
        var oy = clip.y;
        var freeMove = clip.type === 'text';
        var frameBox = null;
        if (freeMove) {
          var lr0 = layer.getBoundingClientRect();
          var br0 = boxEl.getBoundingClientRect();
          if (lr0.width > 0 && lr0.height > 0) {
            frameBox = { w: br0.width / lr0.width, h: br0.height / lr0.height };
          }
        }
        startDrag(e, function (ev) {
          var q = previewFrac(layer, ev.clientX, ev.clientY);
          if (clip.type === 'zoom') {
            clip.x = Math.min(1, Math.max(0, ox + (q.x - q0.x)));
            clip.y = Math.min(1, Math.max(0, oy + (q.y - q0.y)));
          } else if (freeMove && frameBox) {
            var g0 = clampTextToFrame(ox + (q.x - q0.x), oy + (q.y - q0.y), frameBox.w, frameBox.h);
            clip.x = g0.x;
            clip.y = g0.y;
          } else {
            var g = moveGeo({ x: ox, y: oy, w: clip.w, h: clip.h }, q.x - q0.x, q.y - q0.y, !freeMove);
            clip.x = g.x;
            clip.y = g.y;
          }
          moved = true;
          syncBoxEl(boxEl, clip);
          var inspX = document.querySelector('#veInspector [data-insp="x"]');
          var inspY = document.querySelector('#veInspector [data-insp="y"]');
          if (inspX) inspX.value = Math.round(clip.x * 1000) / 10;
          if (inspY) inspY.value = Math.round(clip.y * 1000) / 10;
        }, function () {
          dragKind = null;
          renderPreview();
          renderInspector();
        });
      }
      void moved;
    };
  }

  function onMainVideoBoxDown(id, boxEl) {
    return function (e) {
      if (!project) return;
      var clip = project.videoClips.find(function (c) { return c.id === id; });
      if (!clip) return;
      var layer = $('overlayLayer');
      if (!layer) return;
      var handleEl = e.target.closest ? e.target.closest('[data-corner], [data-edge], [data-handle]') : null;
      var handle = handleEl ? (handleEl.getAttribute('data-corner') || handleEl.getAttribute('data-edge') || handleEl.getAttribute('data-handle')) : null;
      if (!handle) return;

      if (e && e.stopPropagation) e.stopPropagation();
      if (e && e.preventDefault) e.preventDefault();
      var startScale = clip.scale !== undefined && clip.scale > 0 ? clip.scale : 1.0;
      var r0 = previewFrac(layer, e.clientX, e.clientY);
      dragKind = 'preview';

      startDrag(e, function (ev) {
        var p = previewFrac(layer, ev.clientX, ev.clientY);
        var dx = p.x - r0.x;
        var dy = p.y - r0.y;
        var delta = 0;
        if (handle === 'se' || handle === 'e' || handle === 's') {
          delta = (dx + dy) * 1.5;
        } else if (handle === 'nw' || handle === 'w' || handle === 'n') {
          delta = (-dx - dy) * 1.5;
        } else if (handle === 'ne') {
          delta = (dx - dy) * 1.5;
        } else if (handle === 'sw') {
          delta = (-dx + dy) * 1.5;
        }
        var newScale = Math.max(0.25, Math.min(3.0, startScale + delta));
        clip.scale = Math.round(newScale * 100) / 100;
        video.style.transform = 'scale(' + clip.scale + ')';
        var inspScale = document.querySelector('#veInspector [data-insp="scalePct"]');
        if (inspScale) inspScale.value = Math.round(clip.scale * 100);
        var label = boxEl.querySelector('.ve-main-video-label');
        if (label) label.textContent = '🎬 Main Video (' + Math.round(clip.scale * 100) + '%)';
      }, function () {
        dragKind = null;
        renderPreview();
        renderInspector();
      });
    };
  }

  // Inline text editing on the preview: double-click the selected text box to
  // edit content in place (Enter inserts a real newline, Ctrl/Cmd+Enter or
  // blur commits, Escape cancels). Pauses playback and sets editingText so
  // preview rebuilds cannot wipe typing.
  function startTextEdit(id, boxEl) {
    var clip = getClip(project, id);
    var layer = $('overlayLayer');
    if (!project || !clip || clip.type !== 'text' || !boxEl || !layer || editingText) return;
    editingText = true;
    setPlaying(false);
    boxEl.innerHTML = '';
    var input = document.createElement('textarea');
    input.className = 've-textedit';
    input.setAttribute('data-testid', 'video-editor-text-edit');
    input.maxLength = 200;
    var lines = String(clip.text || '').split('\n').length;
    input.rows = Math.min(6, Math.max(1, lines));
    input.value = clip.text || '';
    var finished = false;
    function done() {
      if (finished) return;
      finished = true;
      editingText = false;
      renderPreview();
      renderInspector();
    }
    function commit() {
      var v = input.value.trim().slice(0, 200);
      if (v) {
        clip.text = v;
        setStatus('', true);
      } else {
        setStatus('Text cannot be empty (delete the clip instead).', false);
      }
      done();
    }
    input.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    input.addEventListener('dblclick', function (e) { e.stopPropagation(); });
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit();
      else if (e.key === 'Escape') { setStatus('', true); done(); }
      // Plain Enter falls through: the textarea inserts a real newline.
    });
    input.addEventListener('blur', function () { commit(); });
    boxEl.appendChild(input);
    try { input.focus(); input.select(); } catch (err) {}
  }

  // ---- inspector (exact numbers for fine-tuning) ----
  function numField(name, value, step, min, max) {
    var fieldLabel = ({ brightness: 'Brightness', contrast: 'Contrast', saturation: 'Saturation' })[name] || name;
    var isColorField = name === 'brightness' || name === 'contrast' || name === 'saturation';
    return '<label style="display:inline-flex; flex-direction:column; gap:5px; min-width:100px; color:' + (isColorField ? '#334155' : 'inherit') + '; font-size:12px; font-weight:700;">' + escapeHtml(fieldLabel) + ' <input type="number" data-insp="' + name + '" value="' + value + '" step="' + step + '"' +
      (min !== undefined ? ' min="' + min + '"' : '') + (max !== undefined ? ' max="' + max + '"' : '') + '></label>';
  }

  // Live playhead-vs-selected-clip readout (span-only update: no rebuild, so
  // inspector focus is never disturbed).
  function clipStatusText(clip) {
    var st = clipPlayheadStatus(clip, tlTime);
    if (st.relation === 'inside') return 'Playhead inside clip ✓ overlay visible';
    if (st.relation === 'before') return 'Playhead ' + st.delta + 's before clip start — overlay hidden';
    return 'Playhead ' + st.delta + 's after clip end — overlay hidden';
  }

  function updateClipStatus() {
    if (!project) return;
    var sel = project.selectedId;
    var clip = sel ? getClip(project, sel) : null;
    if (!clip) return;
    var box = $('veInspector');
    if (!box) return;
    var span = box.querySelector('[data-testid="video-editor-clip-status"]');
    if (span) span.textContent = clipStatusText(clip);
  }

  function mediaInspectorTitle(kind, clip, file) {
    return '<strong>' + escapeHtml((file && file.name) || (kind === 'video' ? 'Video' : 'Audio')) +
      '</strong> <span class="muted">(' + kind + ' · ' + escapeHtml(clip.id) + ')</span><br>';
  }

  function gainField(gain) {
    return '<label>Gain % <input type="number" data-insp="gainPct" value="' + Math.round(gain * 100) +
      '" step="1" min="0" max="200"></label> <span class="muted" style="font-size:11px;">(0–200%, 100% = original)</span>';
  }

  function volumeDbField(volumeDb) {
    var val = volumeDb !== undefined ? volumeDb : 0;
    return '<label>Volume Gain (dB) <input type="number" data-insp="volumeDb" value="' + val +
      '" step="1" min="-60" max="24"></label> <span class="muted" style="font-size:11px;">(-60 to +24 dB, 0 = unchanged)</span>';
  }

  function cropInspectorHtml(clip, targetType) {
    var isEditing = cropEditingClipId === clip.id;
    var c = isEditing ? (tempCrop || normalizeCrop(clip.crop) || { left: 0, top: 0, right: 1, bottom: 1 }) : (normalizeCrop(clip.crop) || { left: 0, top: 0, right: 1, bottom: 1 });

    var leftPct = Math.round(c.left * 1000) / 10;
    var topPct = Math.round(c.top * 1000) / 10;
    var rightPct = Math.round(c.right * 1000) / 10;
    var bottomPct = Math.round(c.bottom * 1000) / 10;

    var statusNote = isEditing
      ? '<span style="color:#0891b2;font-weight:600;">Editing crop: drag cyan handles in preview or adjust numbers below</span>'
      : (isClipCropped(clip) ? '<span style="color:#059669;font-weight:600;">Crop active ✓ (' + leftPct + '%, ' + topPct + '%, ' + rightPct + '%, ' + bottomPct + '%)</span>' : '<span class="muted">No crop applied (100% full frame)</span>');

    return '<div style="margin-top: 8px; padding: 10px; background: #f8fafc; border-radius: 8px; border: 1px solid #f1f5f9;" data-testid="video-editor-crop-section">' +
      '<div style="font-weight:700; font-size:11px; text-transform:uppercase; color:#64748b; margin-bottom: 6px; display:flex; justify-content:space-between; align-items:center;">' +
        '<span>✂️ Non-Destructive Crop</span>' +
        '<span style="font-size:11px; font-weight:normal;">' + statusNote + '</span>' +
      '</div>' +
      '<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px;">' +
        '<label>Left (%) <input type="number" data-insp="cropLeft" min="0" max="98" step="0.5" value="' + leftPct + '" style="width:72px;"></label>' +
        '<label>Top (%) <input type="number" data-insp="cropTop" min="0" max="98" step="0.5" value="' + topPct + '" style="width:72px;"></label>' +
        '<label>Right (%) <input type="number" data-insp="cropRight" min="2" max="100" step="0.5" value="' + rightPct + '" style="width:72px;"></label>' +
        '<label>Bottom (%) <input type="number" data-insp="cropBottom" min="2" max="100" step="0.5" value="' + bottomPct + '" style="width:72px;"></label>' +
      '</div>' +
      '<div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">' +
        (isEditing
          ? '<button type="button" class="button small primary" data-crop-action="apply" data-testid="video-editor-crop-apply" style="padding:3px 10px;font-size:12px;">✓ Apply Crop</button>' +
            '<button type="button" class="button small secondary" data-crop-action="cancel" data-testid="video-editor-crop-cancel" style="padding:3px 10px;font-size:12px;">✕ Cancel</button>'
          : '<button type="button" class="button small secondary" data-crop-action="edit" data-testid="video-editor-crop-edit" style="padding:3px 10px;font-size:12px;">✂️ Edit Crop</button>') +
        '<button type="button" class="button small secondary" data-crop-action="reset" data-testid="video-editor-crop-reset" style="padding:3px 10px;font-size:12px;"' + (!isClipCropped(clip) && !isEditing ? ' disabled' : '') + '>↺ Reset Crop</button>' +
      '</div>' +
    '</div>';
  }

  function updateCropGeometry(c, targetX, targetY, targetW, targetH) {
    var layer = $('cropLayer');
    if (!layer) return;
    var cropBox = layer.querySelector('.ve-crop-box');
    var shadeTop = layer.querySelector('.ve-crop-shade-top');
    var shadeBottom = layer.querySelector('.ve-crop-shade-bottom');
    var shadeLeft = layer.querySelector('.ve-crop-shade-left');
    var shadeRight = layer.querySelector('.ve-crop-shade-right');
    if (!cropBox || !shadeTop || !shadeBottom || !shadeLeft || !shadeRight) return;

    var leftPx = Math.round(c.left * targetW);
    var topPx = Math.round(c.top * targetH);
    var rightPx = Math.round(c.right * targetW);
    var bottomPx = Math.round(c.bottom * targetH);
    var boxW = Math.max(10, rightPx - leftPx);
    var boxH = Math.max(10, bottomPx - topPx);

    shadeTop.style.left = targetX + 'px';
    shadeTop.style.top = targetY + 'px';
    shadeTop.style.width = targetW + 'px';
    shadeTop.style.height = topPx + 'px';

    shadeBottom.style.left = targetX + 'px';
    shadeBottom.style.top = (targetY + bottomPx) + 'px';
    shadeBottom.style.width = targetW + 'px';
    shadeBottom.style.height = Math.max(0, targetH - bottomPx) + 'px';

    shadeLeft.style.left = targetX + 'px';
    shadeLeft.style.top = (targetY + topPx) + 'px';
    shadeLeft.style.width = leftPx + 'px';
    shadeLeft.style.height = boxH + 'px';

    shadeRight.style.left = (targetX + rightPx) + 'px';
    shadeRight.style.top = (targetY + topPx) + 'px';
    shadeRight.style.width = Math.max(0, targetW - rightPx) + 'px';
    shadeRight.style.height = boxH + 'px';

    cropBox.style.left = (targetX + leftPx) + 'px';
    cropBox.style.top = (targetY + topPx) + 'px';
    cropBox.style.width = boxW + 'px';
    cropBox.style.height = boxH + 'px';
  }

  function renderCropLayer() {
    var layer = $('cropLayer');
    if (!layer) return;
    if (!cropEditingClipId || !project) {
      layer.style.display = 'none';
      layer.innerHTML = '';
      return;
    }
    if (project.selectedId !== cropEditingClipId) {
      cropEditingClipId = null;
      tempCrop = null;
      cropOriginal = null;
      layer.style.display = 'none';
      layer.innerHTML = '';
      return;
    }
    var clip = findClipAny(cropEditingClipId);
    var kind = clipKindOf(cropEditingClipId) || (clip && clip.type);
    if (!clip || (kind !== 'video' && kind !== 'voverlay' && kind !== 'image')) {
      cropEditingClipId = null;
      layer.style.display = 'none';
      layer.innerHTML = '';
      return;
    }

    if ((kind === 'voverlay' || kind === 'image') && !isOverlayVisibleAt(clip, tlTime)) {
      layer.style.display = 'none';
      return;
    }
    if (kind === 'video') {
      var activeClip = activeVideoClipAt(project, tlTime);
      if (!activeClip || activeClip.id !== clip.id) {
        layer.style.display = 'none';
        return;
      }
    }

    var wrap = $('previewWrap');
    if (!wrap) return;
    var vidEl = $('previewVideo');
    var targetW = (vidEl && vidEl.clientWidth) || wrap.clientWidth || 640;
    var targetH = (vidEl && vidEl.clientHeight) || wrap.clientHeight || 360;
    var targetX = (vidEl && vidEl.offsetLeft) || 0;
    var targetY = (vidEl && vidEl.offsetTop) || 0;

    if (kind === 'voverlay') {
      var entry = overlayVideoEls.get(clip.id);
      if (entry && entry.box && entry.box.offsetWidth > 0) {
        targetX = entry.box.offsetLeft;
        targetY = entry.box.offsetTop;
        targetW = entry.box.offsetWidth;
        targetH = entry.box.offsetHeight;
      } else {
        var ovRect = videoOverlayPreviewRect(clip, targetW, targetH);
        targetX = targetX + ovRect.left;
        targetY = targetY + ovRect.top;
        targetW = Math.max(20, ovRect.width);
        targetH = Math.max(20, ovRect.height);
      }
    } else if (kind === 'image') {
      var ovLayer = $('overlayLayer');
      var imgBox = ovLayer ? ovLayer.querySelector('[data-clip-id="' + clip.id + '"]') : null;
      if (imgBox && imgBox.offsetWidth > 0) {
        targetX = imgBox.offsetLeft;
        targetY = imgBox.offsetTop;
        targetW = imgBox.offsetWidth;
        targetH = imgBox.offsetHeight;
      } else {
        targetX = targetX + (clip.x || 0) * targetW;
        targetY = targetY + (clip.y || 0) * targetH;
        targetW = Math.max(20, (clip.w || 0.2) * targetW);
        targetH = Math.max(20, (clip.h || clip.w || 0.2) * targetH);
      }
    }

    layer.style.display = 'block';
    layer.style.pointerEvents = 'auto';

    var c = tempCrop || normalizeCrop(clip.crop) || { left: 0, top: 0, right: 1, bottom: 1 };

    var cropBox = layer.querySelector('.ve-crop-box');
    if (!cropBox) {
      layer.innerHTML = '';

      var shadeTop = document.createElement('div');
      shadeTop.className = 've-crop-shade ve-crop-shade-top';
      layer.appendChild(shadeTop);

      var shadeBottom = document.createElement('div');
      shadeBottom.className = 've-crop-shade ve-crop-shade-bottom';
      layer.appendChild(shadeBottom);

      var shadeLeft = document.createElement('div');
      shadeLeft.className = 've-crop-shade ve-crop-shade-left';
      layer.appendChild(shadeLeft);

      var shadeRight = document.createElement('div');
      shadeRight.className = 've-crop-shade ve-crop-shade-right';
      layer.appendChild(shadeRight);

      cropBox = document.createElement('div');
      cropBox.className = 've-crop-box';
      cropBox.setAttribute('data-testid', 'video-editor-crop-box');

      ['nw', 'ne', 'sw', 'se'].forEach(function (corner) {
        var h = document.createElement('div');
        h.className = 've-crop-corner ve-crop-corner-' + corner;
        h.setAttribute('data-crop-handle', corner);
        cropBox.appendChild(h);
      });

      ['t', 'b', 'l', 'r'].forEach(function (edge) {
        var h = document.createElement('div');
        h.className = 've-crop-edge ve-crop-edge-' + edge;
        h.setAttribute('data-crop-handle', edge);
        cropBox.appendChild(h);
      });

      layer.appendChild(cropBox);

      cropBox.addEventListener('pointerdown', function (e) {
        var handle = e.target.getAttribute('data-crop-handle');
        var startX = e.clientX;
        var startY = e.clientY;
        var currentC = tempCrop || normalizeCrop(clip.crop) || { left: 0, top: 0, right: 1, bottom: 1 };
        var startCrop = { left: currentC.left, top: currentC.top, right: currentC.right, bottom: currentC.bottom };

        var curWrap = $('previewWrap');
        var curVid = $('previewVideo');
        var curW = (curVid && curVid.clientWidth) || (curWrap && curWrap.clientWidth) || 640;
        var curH = (curVid && curVid.clientHeight) || (curWrap && curWrap.clientHeight) || 360;
        var curX = (curVid && curVid.offsetLeft) || 0;
        var curY = (curVid && curVid.offsetTop) || 0;
        if (kind === 'voverlay') {
          var entry = overlayVideoEls.get(clip.id);
          if (entry && entry.box && entry.box.offsetWidth > 0) {
            curX = entry.box.offsetLeft;
            curY = entry.box.offsetTop;
            curW = entry.box.offsetWidth;
            curH = entry.box.offsetHeight;
          }
        } else if (kind === 'image') {
          var ovLayer = $('overlayLayer');
          var imgBox = ovLayer ? ovLayer.querySelector('[data-clip-id="' + clip.id + '"]') : null;
          if (imgBox && imgBox.offsetWidth > 0) {
            curX = imgBox.offsetLeft;
            curY = imgBox.offsetTop;
            curW = imgBox.offsetWidth;
            curH = imgBox.offsetHeight;
          }
        }

        e.stopPropagation();
        startDrag(e, function (ev) {
          var dx = (ev.clientX - startX) / curW;
          var dy = (ev.clientY - startY) / curH;
          var next = dragCrop(startCrop, handle, dx, dy, 0.02);
          tempCrop = next;
          updateCropGeometry(next, curX, curY, curW, curH);
          syncCropInputs();
        }, function () {
          if (tempCrop) {
            updateCropGeometry(tempCrop, curX, curY, curW, curH);
            syncCropInputs();
          }
        });
      });
    }

    updateCropGeometry(c, targetX, targetY, targetW, targetH);
  }

  function syncCropInputs() {
    var box = $('veInspector');
    if (!box || !tempCrop) return;
    var leftIn = box.querySelector('[data-insp="cropLeft"]');
    var topIn = box.querySelector('[data-insp="cropTop"]');
    var rightIn = box.querySelector('[data-insp="cropRight"]');
    var bottomIn = box.querySelector('[data-insp="cropBottom"]');
    if (leftIn) leftIn.value = Math.round(tempCrop.left * 1000) / 10;
    if (topIn) topIn.value = Math.round(tempCrop.top * 1000) / 10;
    if (rightIn) rightIn.value = Math.round(tempCrop.right * 1000) / 10;
    if (bottomIn) bottomIn.value = Math.round(tempCrop.bottom * 1000) / 10;
  }

  function toggleCropEditing(clipId) {
    if (cropEditingClipId === clipId) {
      var clip = findClipAny(clipId);
      if (clip && tempCrop) {
        clip.crop = normalizeCrop(tempCrop);
      }
      cropEditingClipId = null;
      tempCrop = null;
      cropOriginal = null;
    } else {
      var clip = findClipAny(clipId);
      if (!clip) return;
      if (timelinePlaying) {
        pauseTimeline();
      }
      var clipKind = clipKindOf(clipId) || clip.type;
      var clipStart = clip.start || 0;
      var clipEnd = (clipKind === 'voverlay' || clipKind === 'image' || clip.end != null) ? clip.end : (clip.start + (clip.sourceOut - clip.sourceIn));
      if (tlTime < clipStart || tlTime >= clipEnd) {
        seek(clipStart);
      }
      cropEditingClipId = clipId;
      cropOriginal = clip.crop ? { ...clip.crop } : null;
      tempCrop = clip.crop ? { ...clip.crop } : { left: 0, top: 0, right: 1, bottom: 1 };
    }
    renderCropLayer();
    renderPreview();
    renderInspector();
  }

  function wireCropActions(box, clip) {
    var editBtn = box.querySelector('[data-crop-action="edit"]');
    if (editBtn) {
      editBtn.addEventListener('click', function () {
        toggleCropEditing(clip.id);
      });
    }
    var applyBtn = box.querySelector('[data-crop-action="apply"]');
    if (applyBtn) {
      applyBtn.addEventListener('click', function () {
        var l = readNum(box, 'cropLeft');
        var t = readNum(box, 'cropTop');
        var r = readNum(box, 'cropRight');
        var b = readNum(box, 'cropBottom');
        if (l !== null && t !== null && r !== null && b !== null) {
          tempCrop = { left: l / 100, top: t / 100, right: r / 100, bottom: b / 100 };
        }
        clip.crop = normalizeCrop(tempCrop);
        cropEditingClipId = null;
        tempCrop = null;
        cropOriginal = null;
        renderCropLayer();
        renderPreview();
        renderInspector();
        setStatus('Crop applied.', true);
      });
    }
    var cancelBtn = box.querySelector('[data-crop-action="cancel"]');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        clip.crop = cropOriginal;
        cropEditingClipId = null;
        tempCrop = null;
        cropOriginal = null;
        renderCropLayer();
        renderPreview();
        renderInspector();
        setStatus('Crop editing cancelled.', true);
      });
    }
    var resetBtn = box.querySelector('[data-crop-action="reset"]');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        clip.crop = null;
        cropEditingClipId = null;
        tempCrop = null;
        cropOriginal = null;
        renderCropLayer();
        renderPreview();
        renderInspector();
        setStatus('Crop reset to full frame.', true);
      });
    }
    ['cropLeft', 'cropTop', 'cropRight', 'cropBottom'].forEach(function (name) {
      var el = box.querySelector('[data-insp="' + name + '"]');
      if (!el) return;
      el.addEventListener('input', function () {
        var l = readNum(box, 'cropLeft');
        var t = readNum(box, 'cropTop');
        var r = readNum(box, 'cropRight');
        var b = readNum(box, 'cropBottom');
        if (l !== null && t !== null && r !== null && b !== null) {
          if (cropEditingClipId !== clip.id) {
            cropEditingClipId = clip.id;
            cropOriginal = clip.crop ? { ...clip.crop } : null;
            if (timelinePlaying) pauseTimeline();
            renderPreview();
          }
          var left = Math.max(0, Math.min(0.98, l / 100));
          var top = Math.max(0, Math.min(0.98, t / 100));
          var right = Math.max(left + 0.02, Math.min(1, r / 100));
          var bottom = Math.max(top + 0.02, Math.min(1, b / 100));
          var validCrop = {
            left: Math.round(left * 10000) / 10000,
            top: Math.round(top * 10000) / 10000,
            right: Math.round(right * 10000) / 10000,
            bottom: Math.round(bottom * 10000) / 10000
          };
          tempCrop = validCrop;
          renderCropLayer();
        }
      });
    });
  }

  function renderInspector() {
    var box = $('veInspector');
    if (!box || !project) return;
    var sel = project.selectedId;
    var clip = sel ? findClipAny(sel) : null;
    if (!clip) {
      box.innerHTML = '<p class="muted" style="margin:0;">Add video/audio files, then select any clip — or add a Blur, Text, or Image at the playhead.</p>';
      return;
    }
    var kind = clipKindOf(sel) || clip.type;
    if (kind === 'video' || kind === 'audio') {
      renderMediaInspector(box, kind, clip);
      return;
    }
    var html = '<strong>' + escapeHtml(clipLabel(clip)) + '</strong> <span class="muted" style="font-size:11px;">(' + clip.type + ' · ' + escapeHtml(clip.id) + ')</span>' +
      
      // Group 1: Timing
      '<div style="margin-top: 12px; padding: 10px; background: #f8fafc; border-radius: 8px; border: 1px solid #f1f5f9;">' +
        '<div style="font-weight:700; font-size:11px; text-transform:uppercase; color:#64748b; margin-bottom: 6px; display:flex; align-items:center; gap:4px;">⏱️ Timing</div>' +
        numField('start', clip.start, 0.1, 0) + ' ' + numField('end', clip.end, 0.1, 0) + ' <span class="muted" style="font-size:11px;">seconds</span>' +
        '<div style="margin-top: 8px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">' +
          '<button type="button" class="button small secondary" data-goto="start" style="padding: 2px 8px; font-size: 11px;">Go to start</button> ' +
          '<button type="button" class="button small secondary" data-goto="end" style="padding: 2px 8px; font-size: 11px;">Go to end</button> ' +
          '<button type="button" class="button small secondary" data-extend="end" data-testid="video-editor-extend-end" style="padding: 2px 8px; font-size: 11px;">Extend to video end</button>' +
          '<span class="muted" data-testid="video-editor-clip-status" style="font-size: 11px; flex: 1; min-width: 140px;">' + escapeHtml(clipStatusText(clip)) + '</span>' +
        '</div>' +
      '</div>';

    // Group 2: Properties
    var propsHtml = '';
    if (clip.type === 'blur') {
      propsHtml += '<label>Mode <select data-insp="mode"><option value="blur"' + (clip.mode === 'blur' ? ' selected' : '') + '>Blur</option>' +
        '<option value="mask"' + (clip.mode === 'mask' ? ' selected' : '') + '>Hide (solid)</option></select></label>';
    } else if (clip.type === 'text') {
      propsHtml += '<div style="display:flex; flex-direction:column; gap:6px; width:100%;">' +
        '<label style="width:100%;">Text <textarea data-insp="text" rows="2" maxlength="200" style="flex:1;">' + escapeHtml(clip.text) + '</textarea></label>' +
        '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px;">' +
          numField('size', Math.round(clip.size * 1000) / 10, 0.5) +
          '<label>Color <input type="color" data-insp="color" value="' + escapeHtml(clip.color || '#ffffff') + '" style="width:28px; height:24px; padding:0; border:none; border-radius:4px; cursor:pointer;"></label>' +
          '<label>Bg <input type="color" data-insp="bg" value="' + escapeHtml(clip.bg || '#000000') + '" style="width:28px; height:24px; padding:0; border:none; border-radius:4px; cursor:pointer;"></label>' +
          '<label style="font-size:11px;"><input type="checkbox" data-insp="bgOn"' + (clip.bg ? ' checked' : '') + '> show background</label>' +
        '</div>' +
      '</div>';
    } else if (clip.type === 'image') {
      propsHtml += '<label>File <select data-insp="file" style="flex:1; min-width:140px;">' + imageFiles.map(function (f, i) {
        return '<option value="' + i + '"' + (clip.file === i ? ' selected' : '') + '>' + escapeHtml(f.name) + '</option>';
      }).join('') + '</select></label>';
    } else if (clip.type === 'voverlay') {
      var voFiles = project.files.filter(function (f) { return f.kind === 'video'; });
      var curShape = clip.shape || 'rect';
      var curPreset = normalizeVoverlayPreset(clip.preset) || 'custom';
      var presetOpts = ['custom'].concat(VOVERLAY_PRESETS).map(function (p) {
        var label = p === 'custom' ? 'Custom (manual x/y)' : p.split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
        return '<option value="' + p + '"' + (curPreset === p ? ' selected' : '') + '>' + label + '</option>';
      }).join('');
      var curMarginPct = Math.round(((clip.margin === undefined ? 0.02 : clip.margin) * 1000)) / 10;
      var curShadowPct = Math.round(((clip.shadow || 0) * 1000)) / 10;
      propsHtml += '<label>File <select data-insp="voverlayFile" style="flex:1; min-width:140px;">' + voFiles.map(function (f, i) {
        return '<option value="' + i + '"' + (clip.file === i ? ' selected' : '') + '>' + escapeHtml(f.name || ('Video ' + (i + 1))) + '</option>';
      }).join('') + '</select></label>' +
      '<label>Mask shape <select data-insp="voverlayShape" data-testid="video-editor-voverlay-shape" style="flex:1; min-width:140px;">' +
        '<option value="rect"' + (curShape === 'rect' ? ' selected' : '') + '>Rectangle</option>' +
        '<option value="rounded"' + (curShape === 'rounded' ? ' selected' : '') + '>Rounded rectangle</option>' +
        '<option value="circle"' + (curShape === 'circle' ? ' selected' : '') + '>Circle / Ellipse</option>' +
      '</select></label>' +
      '<label>Source start (s) <input type="number" data-insp="sourceIn" min="0" step="0.1" value="' + (clip.sourceIn || 0) + '" style="width:80px;"></label>' +
      '<label>Position <select data-insp="voverlayPreset" data-testid="video-editor-voverlay-preset" style="flex:1; min-width:140px;">' + presetOpts + '</select></label>' +
      '<label>Margin (%) <input type="number" data-insp="voverlayMargin" min="0" max="25" step="0.5" value="' + curMarginPct + '" style="width:80px;"></label>' +
      '<label style="font-size:12px;"><input type="checkbox" data-insp="voverlayMirror"' + (clip.mirror ? ' checked' : '') + '> Mirror horizontally</label>' +
      '<label>Shadow (%) <input type="number" data-insp="voverlayShadow" min="0" max="100" step="5" value="' + curShadowPct + '" style="width:80px;"></label>' +
      '<span class="muted" style="font-size:11px;">Overlay video is muted in preview and export; use audio clips for sound.</span>' +
      '<span class="muted" style="font-size:11px;">A position preset owns x/y (margin applies on select); choose Custom for manual x/y.</span>';
    } else if (clip.type === 'zoom') {
      var curEasing = normalizeZoomEasing(clip.easing);
      var easingOpts = ['linear', 'ease-in', 'ease-out', 'ease-in-out'].map(function (e0) {
        var label = e0 === 'linear' ? 'Linear' : e0.split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
        return '<option value="' + e0 + '"' + (curEasing === e0 ? ' selected' : '') + '>' + label + '</option>';
      }).join('');
      propsHtml += '<label>Zoom level (x) <input type="number" data-insp="zoomLevel" min="1" max="8" step="0.1" value="' + (clip.level || 1.5) + '" style="width:80px;"></label>' +
      '<label>Transition duration (s) <input type="number" data-insp="zoomTransition" min="0" max="10" step="0.1" value="' + (clip.transition === undefined ? 0.5 : clip.transition) + '" style="width:80px;"></label>' +
      '<label>Easing <select data-insp="zoomEasing" data-testid="video-editor-zoom-easing" style="min-width:110px;">' + easingOpts + '</select></label>' +
      '<span class="muted" style="font-size:11px; display:block; margin-top:4px;">You can also reposition the target center by clicking or dragging on the video preview!</span>';
    }

    if (propsHtml) {
      html += '<div style="margin-top: 8px; padding: 10px; background: #f8fafc; border-radius: 8px; border: 1px solid #f1f5f9;">' +
        '<div style="font-weight:700; font-size:11px; text-transform:uppercase; color:#64748b; margin-bottom: 6px;">🎨 Properties</div>' +
        propsHtml +
      '</div>';
    }

    // Animation controls for image/text/video-overlay layers.
    if (['text', 'image', 'voverlay'].indexOf(clip.type) >= 0) {
      var clipDurationForKeys = Math.max(0.001, Number(clip.end) - Number(clip.start));
      var relativeKeyTime = Math.max(0, Math.min(clipDurationForKeys, tlTime - clip.start));
      var keyframes = Array.isArray(clip.keyframes) ? clip.keyframes : [];
      var selectedProperty = 'x';
      var defaultValue = clip.x == null ? 0.5 : Number(clip.x);
      var keyframeRows = keyframes.slice().sort(function (a, b) { return a.time - b.time; }).map(function (kf, i) {
        return '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px;padding:3px 0;border-top:1px solid #e2e8f0;">' +
          '<span style="min-width:64px;">' + escapeHtml(kf.property) + '</span><span>' + Number(kf.time).toFixed(2) + 's</span><span>→ ' + Number(kf.value).toFixed(3) + '</span><span style="color:#64748b;">' + escapeHtml(kf.easing || 'linear') + '</span>' +
          '<button type="button" class="button small secondary" data-kf-remove="' + i + '" style="padding:1px 6px;font-size:10px;">Remove</button></div>';
      }).join('');
      html += '<div data-testid="video-editor-keyframes" style="margin-top:8px;padding:10px;background:#f8fafc;border-radius:8px;border:1px solid #f1f5f9;">' +
        '<div style="font-weight:700;font-size:11px;text-transform:uppercase;color:#64748b;margin-bottom:6px;">🎞️ Animation / Keyframes</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:end;">' +
        '<label>Property <select data-kf-property style="min-width:82px;"><option value="x">X (%)</option><option value="y">Y (%)</option><option value="scale">Scale</option><option value="opacity">Opacity</option></select></label>' +
        '<label>Value <input data-kf-value type="number" step="0.01" value="' + defaultValue + '" style="width:76px;"></label>' +
        '<label>Easing <select data-kf-easing><option value="linear">Linear</option><option value="ease-in">Ease in</option><option value="ease-out">Ease out</option><option value="ease-in-out">Ease in/out</option></select></label>' +
        '<button type="button" class="button small" data-kf-add>Add at ' + relativeKeyTime.toFixed(2) + 's</button></div>' +
        '<div class="muted" style="font-size:11px;margin-top:5px;">Playhead time within this overlay: ' + relativeKeyTime.toFixed(2) + 's / ' + clipDurationForKeys.toFixed(2) + 's. X/Y use normalized frame position (0–1); scale 0.05–4; opacity 0–1.</div>' +
        (keyframeRows || '<div class="muted" style="font-size:11px;margin-top:5px;">No keyframes yet. Move the playhead, set a property value, and add a keyframe.</div>') +
      '</div>';
    }

    // Group 3: Position & Size
    var geomHtml = numField('x', Math.round(clip.x * 1000) / 10, 0.5) + ' ' + numField('y', Math.round(clip.y * 1000) / 10, 0.5);
    if (clip.type === 'blur' || clip.type === 'image' || clip.type === 'voverlay') {
      geomHtml += ' ' + numField('w', Math.round(clip.w * 1000) / 10, 0.5);
    }
    if (clip.type === 'blur' || clip.type === 'image' || clip.type === 'voverlay') {
      geomHtml += ' ' + numField('h', Math.round((clip.h == null ? clip.w : clip.h) * 1000) / 10, 0.5);
    }

    html += '<div style="margin-top: 8px; padding: 10px; background: #f8fafc; border-radius: 8px; border: 1px solid #f1f5f9;">' +
      '<div style="font-weight:700; font-size:11px; text-transform:uppercase; color:#64748b; margin-bottom: 6px;">📐 Position & Size (%)</div>' +
      geomHtml +
    '</div>';

    if (clip.type === 'voverlay' || clip.type === 'image') {
      html += cropInspectorHtml(clip, clip.type);
    }

    box.innerHTML = html;
    wireInspectorClip(box, clip);
    var kfProperty = box.querySelector('[data-kf-property]');
    var kfValue = box.querySelector('[data-kf-value]');
    if (kfProperty && kfValue) {
      function updateKeyframeValueHint() {
        var p = kfProperty.value;
        var current = p === 'x' ? clip.x : p === 'y' ? clip.y : p === 'scale' ? 1 : 1;
        kfValue.value = String(current == null ? 0.5 : current);
        kfValue.min = p === 'scale' ? '0.05' : '0';
        kfValue.max = p === 'scale' ? '4' : '1';
        kfValue.step = p === 'x' || p === 'y' ? '0.01' : '0.05';
      }
      kfProperty.addEventListener('change', updateKeyframeValueHint);
    }
    var addKf = box.querySelector('[data-kf-add]');
    if (addKf) addKf.addEventListener('click', function () {
      var duration = Math.max(0.001, Number(clip.end) - Number(clip.start));
      var property = kfProperty.value;
      var fallback = property === 'x' ? clip.x : property === 'y' ? clip.y : 1;
      var frame = { property: property, time: Math.max(0, Math.min(duration, tlTime - clip.start)), value: Number(kfValue.value), easing: (box.querySelector('[data-kf-easing]') || {}).value || 'linear' };
      if (!Number.isFinite(frame.value)) { setStatus('Enter a valid keyframe value.', false); return; }
      try { clip.keyframes = upsertKeyframe(clip.keyframes || [], frame, duration); }
      catch (err) { setStatus(err.message || 'Invalid keyframe.', false); return; }
      setStatus('Keyframe added at ' + frame.time.toFixed(2) + 's.', true);
      renderPreview(); renderInspector();
    });
    box.querySelectorAll('[data-kf-remove]').forEach(function (button) {
      button.addEventListener('click', function () {
        var index = Number(button.getAttribute('data-kf-remove'));
        var frames = (clip.keyframes || []).slice().sort(function (a, b) { return a.time - b.time; });
        if (frames[index]) {
          var target = frames[index];
          clip.keyframes = frames.filter(function (kf) { return !(kf.property === target.property && kf.time === target.time); });
          renderPreview(); renderInspector();
        }
      });
    });
    if (clip.type === 'voverlay' || clip.type === 'image') {
      wireCropActions(box, clip);
    }
    var goStart = box.querySelector('[data-goto="start"]');
    if (goStart) goStart.addEventListener('click', function () { seek(clip.start); });
    var goEnd = box.querySelector('[data-goto="end"]');
    if (goEnd) goEnd.addEventListener('click', function () { seek(clip.end); });
    var extEnd = box.querySelector('[data-extend="end"]');
    if (extEnd) extEnd.addEventListener('click', function () {
      var r;
      try {
        r = extendOverlayToVideoEnd(project, clip.id);
      } catch (err) { setStatus(err.message || 'Cannot extend.', false); return; }
      if (!r.extended) { setStatus('Already at the video end.', true); return; }
      setStatus('', true);
      renderTimeline();
      renderPreview();
      renderInspector();
    });
  }

  function renderMediaInspector(box, kind, clip) {
    var file = getMediaFile(project, clip.file);
    var end = clip.start + (clip.sourceOut - clip.sourceIn);
    
    var html = mediaInspectorTitle(kind, clip, file) +
      '<span class="muted" style="font-size:11px;">File: ' + escapeHtml((file && file.name) || '—') +
      (file ? ' · ' + formatTimecode(file.duration) + ' long' : '') + '</span>' +

      // Group 1: Timing
      '<div style="margin-top: 12px; padding: 10px; background: #f8fafc; border-radius: 8px; border: 1px solid #f1f5f9;">' +
        '<div style="font-weight:700; font-size:11px; text-transform:uppercase; color:#64748b; margin-bottom: 6px;">⏱️ Clip Timing</div>' +
        '<div style="display:flex; flex-direction:column; gap:4px;">' +
          '<div>' + numField('sourceIn', clip.sourceIn, 0.1, 0) + ' ' + numField('sourceOut', clip.sourceOut, 0.1, 0) + ' <span class="muted" style="font-size:11px;">source seconds in file</span></div>' +
          '<div style="margin-top: 6px; padding-top: 6px; border-top: 1px dotted #e2e8f0;">' + numField('start', clip.start, 0.1, 0) + ' <span class="muted" style="font-size:11px;">timeline start (end ' + formatTimecode(end) + ')</span></div>' +
        '</div>' +
      '</div>' +

      // Group 2: Audio Settings
      '<div style="margin-top: 8px; padding: 10px; background: #f8fafc; border-radius: 8px; border: 1px solid #f1f5f9;">' +
        '<div style="font-weight:700; font-size:11px; text-transform:uppercase; color:#64748b; margin-bottom: 6px;">🔊 Audio Settings</div>' +
        gainField(clip.gain) +
        '<div style="margin-top:4px;">' + volumeDbField(clip.volumeDb || 0) + '</div>' +
      '</div>';

    // Group 3: Scale / Size Settings (Video only)
    if (kind === 'video') {
      var curScalePct = Math.round((clip.scale || 1.0) * 100);
      html += '<div style="margin-top: 8px; padding: 10px; background: #f8fafc; border-radius: 8px; border: 1px solid #f1f5f9;">' +
        '<div style="font-weight:700; font-size:11px; text-transform:uppercase; color:#64748b; margin-bottom: 6px;">🔍 Display Scale (%)</div>' +
        '<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">' +
          numField('scalePct', curScalePct, 5, 25) +
          '<button type="button" class="button small secondary" data-scale-preset="100" style="padding:2px 8px;font-size:11px;">100% (Fit)</button>' +
          '<button type="button" class="button small secondary" data-scale-preset="125" style="padding:2px 8px;font-size:11px;">125%</button>' +
          '<button type="button" class="button small secondary" data-scale-preset="150" style="padding:2px 8px;font-size:11px;">150%</button>' +
        '</div>' +
        '<span class="muted" style="font-size:11px; display:block; margin-top:4px;">Non-destructive scale (25% - 300%). Preserves aspect ratio.</span>' +
      '</div>' +
      '<div style="margin-top: 8px; padding: 10px; background: #f8fafc; border-radius: 8px; border: 1px solid #f1f5f9;">' +
        '<div style="font-weight:700; font-size:11px; text-transform:uppercase; color:#64748b; margin-bottom: 6px;">🎨 Color Correction</div>' +
        '<div style="display:flex; gap:12px; flex-wrap:wrap; align-items:flex-start;">' +
          numField('brightness', clip.brightness !== undefined ? clip.brightness : 0, 0.05, -1, 1) +
          numField('contrast', clip.contrast !== undefined ? clip.contrast : 1, 0.05, 0, 3) +
          numField('saturation', clip.saturation !== undefined ? clip.saturation : 1, 0.05, 0, 3) +
        '</div><span class="muted" style="font-size:11px;">Export: brightness −1 to +1; contrast and saturation 0 to 3. Defaults preserve the original image.</span>' +
      '</div>' +
      '<div style="margin-top: 8px; padding: 10px; background: #f8fafc; border-radius: 8px; border: 1px solid #f1f5f9;">' +
        '<div style="font-weight:700; font-size:11px; text-transform:uppercase; color:#64748b; margin-bottom: 6px;">🎞️ Video Fade In / Out (seconds)</div>' +
        '<div style="display:flex; gap:8px; flex-wrap:wrap;">' +
          numField('fadeVideoIn', clip.fadeVideoIn || 0, 0.1, 0, 30) +
          numField('fadeVideoOut', clip.fadeVideoOut || 0, 0.1, 0, 30) +
        '</div><span class="muted" style="font-size:11px;">Fade to/from black during export; each fade is capped to clip duration.</span>' +
      '</div>';
    }

    // Group 4: Audio fades for original clip audio and added audio tracks.
    html += '<div style="margin-top: 8px; padding: 10px; background: #f8fafc; border-radius: 8px; border: 1px solid #f1f5f9;">' +
      '<div style="font-weight:700; font-size:11px; text-transform:uppercase; color:#64748b; margin-bottom: 6px;">🎚️ Audio Fade In / Out (seconds)</div>' +
      '<div style="display:flex; gap:8px; flex-wrap:wrap;">' +
        numField('fadeIn', clip.fadeIn || 0, 0.1, 0, 30) +
        numField('fadeOut', clip.fadeOut || 0, 0.1, 0, 30) +
      '</div><span class="muted" style="font-size:11px;">Applied during export; each fade is capped to clip duration.</span>' +
    '</div>';

    // Group 5: File Source Selection (Audio only)
    if (kind === 'audio') {
      html += '<div style="margin-top: 8px; padding: 10px; background: #f8fafc; border-radius: 8px; border: 1px solid #f1f5f9;">' +
        '<div style="font-weight:700; font-size:11px; text-transform:uppercase; color:#64748b; margin-bottom: 6px;">💿 Audio Source</div>' +
        '<label>File <select data-insp="mediaFile" style="flex:1; min-width:140px;">' + project.files.filter(function (f) {
          return f.kind === 'audio';
        }).map(function (f) {
          return '<option value="' + escapeHtml(f.id) + '"' + (clip.file === f.id ? ' selected' : '') + '>' +
            escapeHtml(f.name) + '</option>';
        }).join('') + '</select></label>' +
      '</div>';
    }

    if (kind === 'video') {
      html += cropInspectorHtml(clip, 'video');
    }

    box.innerHTML = html;
    wireInspectorMedia(box, kind, clip);
    if (kind === 'video') {
      wireCropActions(box, clip);
    }
  }

  function readNum(box, name) {
    var el = box.querySelector('[data-insp="' + name + '"]');
    if (!el) return null;
    var v = parseFloat(el.value);
    return Number.isFinite(v) ? v : null;
  }

  // Apply media inspector fields to the shared model. Returns {ok, error}.
  function applyMediaFields(box, kind, clip) {
    if (!project) return { ok: false };
    var fail = function (error) { return { ok: false, error: error }; };
    var file = getMediaFile(project, clip.file);
    if (!file) return fail('Media file not found.');
    var sIn = readNum(box, 'sourceIn');
    var sOut = readNum(box, 'sourceOut');
    var st = readNum(box, 'start');
    var gainPct = readNum(box, 'gainPct');
    var volumeDb = readNum(box, 'volumeDb');
    var fadeIn = readNum(box, 'fadeIn');
    var fadeOut = readNum(box, 'fadeOut');
    var scalePct = readNum(box, 'scalePct');
    var brightness = readNum(box, 'brightness');
    var contrast = readNum(box, 'contrast');
    var saturation = readNum(box, 'saturation');
    var fadeVideoIn = readNum(box, 'fadeVideoIn');
    var fadeVideoOut = readNum(box, 'fadeVideoOut');
    if (kind === 'video' && fadeVideoIn !== null) clip.fadeVideoIn = Math.max(0, Math.min(30, fadeVideoIn));
    if (kind === 'video' && fadeVideoOut !== null) clip.fadeVideoOut = Math.max(0, Math.min(30, fadeVideoOut));
    if (kind === 'video' && brightness !== null) clip.brightness = Math.max(-1, Math.min(1, brightness));
    if (kind === 'video' && contrast !== null) clip.contrast = Math.max(0, Math.min(3, contrast));
    if (kind === 'video' && saturation !== null) clip.saturation = Math.max(0, Math.min(3, saturation));
    if (kind === 'video' && scalePct !== null) {
      clip.scale = Math.max(0.25, Math.min(3.0, scalePct / 100));
    }
    try {
      if (kind === 'video') {
        if (sIn !== null && sOut !== null) {
          // Apply edges in an order that never discards the typed field.
          if (sIn <= sOut) {
            trimVideoClip(project, clip.id, 'start', Math.min(sIn, sOut));
            trimVideoClip(project, clip.id, 'end', Math.max(sIn, sOut));
          } else {
            trimVideoClip(project, clip.id, 'end', Math.max(sIn, sOut));
            trimVideoClip(project, clip.id, 'start', Math.min(sIn, sOut));
          }
        } else if (sIn !== null) {
          trimVideoClip(project, clip.id, 'start', sIn);
        } else if (sOut !== null) {
          trimVideoClip(project, clip.id, 'end', sOut);
        }
        if (st !== null) moveVideoClip(project, clip.id, st);
      } else {
        if (sIn !== null && sOut !== null) {
          if (sIn <= sOut) {
            trimAudioClip(project, clip.id, 'start', Math.min(sIn, sOut));
            trimAudioClip(project, clip.id, 'end', Math.max(sIn, sOut));
          } else {
            trimAudioClip(project, clip.id, 'end', Math.max(sIn, sOut));
            trimAudioClip(project, clip.id, 'start', Math.min(sIn, sOut));
          }
        } else if (sIn !== null) {
          trimAudioClip(project, clip.id, 'start', sIn);
        } else if (sOut !== null) {
          trimAudioClip(project, clip.id, 'end', sOut);
        }
        if (st !== null) moveAudioClip(project, clip.id, st);
      }
    } catch (err) { return fail(err.message || 'Invalid media timing.'); }
    if (gainPct !== null) {
      try {
        setMediaGain(project, kind, clip.id, gainPct / 100);
      } catch (err) { return fail(err.message || 'Invalid gain.'); }
    }
    if (volumeDb !== null) {
      try {
        setMediaVolumeDb(project, kind, clip.id, volumeDb);
      } catch (err) { return fail(err.message || 'Invalid volume DB.'); }
    }
    {
      if (fadeIn !== null) clip.fadeIn = Math.max(0, Math.min(30, fadeIn));
      if (fadeOut !== null) clip.fadeOut = Math.max(0, Math.min(30, fadeOut));
    }
    if (gainPct !== null || volumeDb !== null) {
      resumeAudioContext();
      if (kind === 'video') {
        syncActiveVideoVolume();
      } else if (kind === 'audio') {
        var live = audioEls.get(clip.id);
        if (live) {
          var targetGain = computeClipGain(clip);
          var wantVol = computeClipVolume(clip);
          if (live.gainNode) {
            if (Math.abs(live.gainNode.gain.value - targetGain) > 0.0001) {
              live.gainNode.gain.value = targetGain;
            }
            if (Math.abs(live.el.volume - 1.0) > 0.001) {
              try { live.el.volume = 1.0; } catch (err) {}
            }
          } else if (live.el) {
            if (Math.abs(live.el.volume - wantVol) > 0.001) {
              try { live.el.volume = wantVol; } catch (err) {}
            }
          }
        }
      }
    }
    var fileSel = box.querySelector('[data-insp="mediaFile"]');
    if (fileSel) {
      var target = getMediaFile(project, fileSel.value);
      if (!target || target.kind !== kind) return fail('Selected file is not loaded.');
      if (target.id !== clip.file) {
        if (clip.sourceOut > target.duration) {
          if (target.duration < PROJECT_MIN_SPAN) return fail('Replacement file is too short.');
          clip.sourceIn = 0;
          clip.sourceOut = Math.round(target.duration * 1000) / 1000;
          setStatus('Source range reset to fit the replacement file.', true);
        }
        clip.file = target.id;
      }
    }
    return { ok: true };
  }

  function wireInspectorMedia(box, kind, clip) {
    box.querySelectorAll('[data-insp]').forEach(function (el) {
      el.addEventListener('input', function () {
        if (!applyMediaFields(box, kind, clip).ok) return;
        renderTimeline();
        renderPreview();
      });
      el.addEventListener('change', function () {
        var r = applyMediaFields(box, kind, clip);
        if (!r.ok) { setStatus(r.error || 'Invalid value.', false); return; }
        setStatus('', true);
        renderTimeline();
        renderPreview();
        renderInspector();
      });
    });
    box.querySelectorAll('[data-scale-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var pct = parseFloat(btn.getAttribute('data-scale-preset'));
        if (Number.isFinite(pct)) {
          clip.scale = pct / 100;
          renderTimeline();
          renderPreview();
          renderInspector();
        }
      });
    });
  }

  // Apply inspector fields to the shared model. Returns {ok, error}.
  // Used live on `input` (no status noise, no inspector rebuild so focus is
  // kept) and as the commit step on `change` (full re-render + status).
  function applyClipFields(box, clip) {
    if (!project || !getClip(project, clip.id)) return { ok: false };
    var fail = function (error) { return { ok: false, error: error }; };
    var s = readNum(box, 'start');
    var e = readNum(box, 'end');
    if (s !== null && e !== null) {
      try {
        moveClip(project, clip.id, Math.min(s, e));
        resizeClip(project, clip.id, 'end', Math.max(s, e));
      } catch (err) { return fail(err.message || 'Invalid timing.'); }
    }
    var pct = function (name, min, max, exclusiveMin) {
      var v = readNum(box, name);
      if (v === null) return null;
      v = v / 100;
      if (v < min || v > max || (exclusiveMin && v <= min)) return 'bad';
      return Math.round(v * 1e4) / 1e4;
    };
    var x = pct('x', 0, 1);
    var y = pct('y', 0, 1);
    if (x === 'bad' || y === 'bad') return fail('Position must be 0–100%.');
    if (x !== null) clip.x = x;
    if (y !== null) clip.y = y;
    if (clip.type === 'blur' || clip.type === 'image' || clip.type === 'voverlay') {
      var w = pct('w', 0, 1, true);
      if (w === 'bad') return fail('Width must be 1–100%.');
      if (w !== null) {
        clip.w = w;
        if (clip.type === 'image') {
          if (clip.x + clip.w > 1) {
            clip.x = Math.max(0, Math.round((1 - clip.w) * 1e4) / 1e4);
          }
          var effH = clip.h || clip.w;
          if (clip.y + effH > 1) {
            clip.y = Math.max(0, Math.round((1 - effH) * 1e4) / 1e4);
          }
        }
      }
    }
    if (clip.type === 'blur' || clip.type === 'voverlay' || clip.type === 'image') {
      var h = pct('h', 0, 1, true);
      if (h === 'bad') return fail('Height must be 1–100%.');
      if (h !== null) clip.h = h;
    }
    if (clip.type === 'blur') {
      var mode = box.querySelector('[data-insp="mode"]');
      if (mode && (mode.value === 'blur' || mode.value === 'mask')) clip.mode = mode.value;
    }
    if (clip.type === 'text') {
      var tv = box.querySelector('[data-insp="text"]');
      if (tv) {
        var t = tv.value.trim();
        if (!t) return fail('Text cannot be empty (delete the clip instead).');
        clip.text = t.slice(0, 200);
      }
      var size = pct('size', 0.02, 0.25, true);
      if (size === 'bad') return fail('Size must be 2–25%.');
      if (size !== null) clip.size = size;
      var color = box.querySelector('[data-insp="color"]');
      if (color) clip.color = color.value;
      var bgOn = box.querySelector('[data-insp="bgOn"]');
      var bg = box.querySelector('[data-insp="bg"]');
      clip.bg = (bgOn && bgOn.checked && bg) ? bg.value : null;
    }
    if (clip.type === 'text' && (x !== null || y !== null || size !== null)) {
      // Typed positions/sizes obey the same frame rule as canvas dragging,
      // measured from the live preview box when one is rendered.
      var live = document.querySelector('.ve-pbox[data-clip-id="' + clip.id + '"]');
      if (live) fitTextToFrame(live, clip);
    }
    if (clip.type === 'image') {
      var fileSel = box.querySelector('[data-insp="file"]');
      if (fileSel) {
        var idx = parseInt(fileSel.value, 10);
        if (!Number.isInteger(idx) || idx < 0 || idx >= imageFiles.length) {
          return fail('Selected image file is not loaded.');
        }
        clip.file = idx;
      }
    }
    if (clip.type === 'voverlay') {
      var voSel = box.querySelector('[data-insp="voverlayFile"]');
      if (voSel) {
        var voIdx = parseInt(voSel.value, 10);
        var voCount = project.files.filter(function (f) { return f.kind === 'video'; }).length;
        if (!Number.isInteger(voIdx) || voIdx < 0 || voIdx >= voCount) {
          return fail('Selected overlay video is not loaded.');
        }
        clip.file = voIdx;
      }
      var srcInEl = box.querySelector('[data-insp="sourceIn"]');
      if (srcInEl && String(srcInEl.value).trim() !== '') {
        var srcIn = Number(srcInEl.value);
        if (!Number.isFinite(srcIn) || srcIn < 0) {
          return fail('Source start must be 0 or more seconds.');
        }
        var voFiles = project.files.filter(function (f) { return f.kind === 'video'; });
        var file = voFiles[clip.file];
        if (file && file.duration && srcIn + (clip.end - clip.start) > file.duration + 0.001) {
          return fail('Source start + duration exceeds the video file duration.');
        }
        clip.sourceIn = Math.round(srcIn * 1000) / 1000;
      }
      var shapeSel = box.querySelector('[data-insp="voverlayShape"]');
      if (shapeSel) {
        var sVal = shapeSel.value ? String(shapeSel.value).trim().toLowerCase() : 'rect';
        if (sVal === 'circle' || sVal === 'ellipse') clip.shape = 'circle';
        else if (sVal === 'rounded' || sVal === 'rounded-rect' || sVal === 'round') clip.shape = 'rounded';
        else clip.shape = 'rect';
        syncVideoOverlays();
      }
      var mirrorEl = box.querySelector('[data-insp="voverlayMirror"]');
      if (mirrorEl) {
        clip.mirror = !!mirrorEl.checked;
        syncVideoOverlays();
      }
      var shadowEl = box.querySelector('[data-insp="voverlayShadow"]');
      if (shadowEl && String(shadowEl.value).trim() !== '') {
        var shPct = Number(shadowEl.value);
        if (!Number.isFinite(shPct) || shPct < 0 || shPct > 100) {
          return fail('Shadow must be between 0 and 100%.');
        }
        clip.shadow = normalizeVoverlayShadow(shPct / 100);
        syncVideoOverlays();
      }
      // Preset owns x/y while active (margin re-derives on every edit);
      // Custom keeps manual x/y from the generic fields above.
      var presetSel = box.querySelector('[data-insp="voverlayPreset"]');
      var marginEl = box.querySelector('[data-insp="voverlayMargin"]');
      if (presetSel) {
        var picked = normalizeVoverlayPreset(presetSel.value);
        if (!picked) {
          clip.preset = null;
        } else {
          clip.preset = picked;
          var mPct = marginEl && String(marginEl.value).trim() !== '' ? Number(marginEl.value) : NaN;
          if (marginEl && !Number.isFinite(mPct)) {
            return fail('Margin must be a number.');
          }
          if (marginEl && (mPct < 0 || mPct > 25)) {
            return fail('Margin must be between 0 and 25%.');
          }
          if (marginEl && String(marginEl.value).trim() !== '') {
            clip.margin = normalizeVoverlayMargin(mPct / 100);
          }
          var resolved = voverlayPresetXY(clip.preset, clip.margin, clip.w, clip.h);
          if (resolved) {
            clip.x = resolved.x;
            clip.y = resolved.y;
          }
        }
      }
    }
    if (clip.type === 'zoom') {
      var lvlEl = box.querySelector('[data-insp="zoomLevel"]');
      if (lvlEl) {
        var lvl = Number(lvlEl.value);
        if (!Number.isFinite(lvl) || lvl < 1.0 || lvl > 8.0) {
          return fail('Zoom level must be between 1.0 and 8.0.');
        }
        clip.level = Math.round(lvl * 10) / 10;
      }
      var transEl = box.querySelector('[data-insp="zoomTransition"]');
      if (transEl) {
        var trans = Number(transEl.value);
        if (!Number.isFinite(trans) || trans < 0 || trans > 10) {
          return fail('Transition duration must be between 0 and 10 seconds.');
        }
        clip.transition = Math.round(trans * 100) / 100;
      }
      var easeEl = box.querySelector('[data-insp="zoomEasing"]');
      if (easeEl) {
        clip.easing = normalizeZoomEasing(easeEl.value);
      }
    }
    return { ok: true };
  }

  function wireInspectorClip(box, clip) {
    box.querySelectorAll('[data-insp]').forEach(function (el) {
      // Live feedback while typing/picking (text, size, color, ...): apply to
      // the model and re-sync timeline + preview immediately, without
      // rebuilding the inspector so focus is preserved.
      el.addEventListener('input', function () {
        if (!applyClipFields(box, clip).ok) return;
        renderTimeline();
        renderPreview();
      });
      el.addEventListener('change', function () {
        var r = applyClipFields(box, clip);
        if (!r.ok) { setStatus(r.error || 'Invalid value.', false); return; }
        setStatus('', true);
        renderTimeline();
        renderPreview();
        renderInspector();
      });
    });
  }

  // ---- file loading / project lifecycle ----
  function fileMeta(kind, file) {
    return new Promise(function (resolve, reject) {
      var url = null;
      try {
        url = URL.createObjectURL(file);
      } catch (err) {
        reject(new Error('Could not read ' + (file.name || 'file') + '.'));
        return;
      }
      var el = document.createElement(kind === 'video' ? 'video' : 'audio');
      el.preload = 'metadata';
      var timer = setTimeout(function () {
        cleanup();
        reject(new Error('Timed out reading ' + (file.name || 'file') + '.'));
      }, 20000);
      function cleanup() {
        clearTimeout(timer);
        try {
          el.removeAttribute('src');
          if (el.load) el.load();
        } catch (err) {}
      }
      el.addEventListener('loadedmetadata', function () {
        var meta = {
          duration: el.duration,
          width: el.videoWidth || null,
          height: el.videoHeight || null
        };
        cleanup();
        try { URL.revokeObjectURL(url); } catch (err) {}
        resolve(meta);
      });
      el.addEventListener('error', function () {
        cleanup();
        try { URL.revokeObjectURL(url); } catch (err) {}
        reject(new Error('Could not read ' + (file.name || 'file') + '.'));
      });
      el.src = url;
    });
  }

  function renderOverlaySourcesList() {
    var el = $('voverlaySourcesList');
    if (!el || !project) return;
    var sources = project.files.filter(function (f) { return f.kind === 'video' && f.isOverlaySource; });
    if (!sources.length) {
      el.innerHTML = '<span class="muted" style="font-size:11px;">No overlay video sources uploaded yet. Choose video files above to use as picture-in-picture overlays.</span>';
      return;
    }
    var allVideos = project.files.filter(function (f) { return f.kind === 'video'; });
    var html = '<div style="display:flex;flex-direction:column;gap:4px;">' +
      '<span style="font-size:11px;font-weight:600;color:#334155;">Overlay Video Sources (' + sources.length + '):</span>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
    sources.forEach(function (s) {
      var globalIdx = allVideos.indexOf(s);
      var durStr = formatTimecode(s.duration);
      var dimStr = s.width && s.height ? (s.width + 'x' + s.height) : '';
      html += '<div style="display:inline-flex;align-items:center;gap:6px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px;padding:3px 8px;font-size:11px;" data-testid="video-editor-overlay-source-item">' +
        '<span>📹 ' + escapeHtml(s.name) + ' (' + durStr + (dimStr ? ' · ' + dimStr : '') + ')</span>' +
        '<button type="button" class="button small" data-add-overlay-source="' + globalIdx + '" style="padding:1px 6px;font-size:11px;">＋ Add as overlay</button>' +
      '</div>';
    });
    html += '</div></div>';
    el.innerHTML = html;
    el.querySelectorAll('[data-add-overlay-source]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-add-overlay-source'), 10);
        try {
          addClip(project, 'voverlay', tlTime, idx);
          renderTimeline();
          renderPreview();
          renderInspector();
          setStatus('Added video overlay clip at playhead.', true);
        } catch (err) {
          setStatus(err.message || 'Cannot add overlay clip.', false);
        }
      });
    });
  }

  function refreshAfterFiles(note) {
    layoutTimeline();
    renderTimeline();
    renderPreview();
    renderInspector();
    renderOverlaySourcesList();
    if (note) setStatus(note, true);
  }

  async function addOverlaySourceFiles(fileList) {
    if (!project) return;
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var capBytes = maxVideoBytes;
    var capLabel = maxVideoMb + ' MB';
    var added = 0;
    for (const f of files) {
      var currentVideoCount = project.files.filter(function (file) { return file.kind === 'video'; }).length;
      if (currentVideoCount >= 4) {
        setStatus('Cannot add ' + (f.name || 'file') + ': maximum 4 total video files reached.', false);
        break;
      }
      if (!(f.size > 0 && f.size <= capBytes)) {
        setStatus('Skipped ' + (f.name || 'file') + ': must be 1 byte–' + capLabel + '.', false);
        continue;
      }
      if (!/\.(mp4|webm|mov|mkv)$/i.test(f.name || '')) {
        setStatus('Skipped ' + (f.name || 'file') + ': video overlay must be mp4, webm, mov or mkv.', false);
        continue;
      }
      try {
        var meta = await fileMeta('video', f);
        if (!Number.isFinite(meta.duration) || meta.duration <= 0) throw new Error('no duration');
        var entry = addFileEntry(project, {
          kind: 'video',
          name: f.name,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          isOverlaySource: true
        });
        var url = null;
        try { url = URL.createObjectURL(f); } catch (err) {}
        fileBlobs.set(entry.id, { blob: f, url: url });
        added++;
      } catch (err) {
        setStatus('Skipped ' + (f.name || 'file') + ': ' + (err.message || 'unreadable.'), false);
      }
    }
    renderOverlaySourcesList();
    renderInspector();
    if (added) {
      setStatus('Loaded ' + added + ' video overlay source(s). Click "+ Add as overlay" to add to timeline.', true);
    }
  }

  async function addMediaFiles(kind, fileList) {
    if (!project) return;
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var isVideo = kind === 'video';
    var capBytes = isVideo ? maxVideoBytes : MAX_AUDIO_BYTES;
    var capLabel = isVideo ? (maxVideoMb + ' MB') : '200 MB';
    var added = 0;
    for (const f of files) {
      if (isVideo && !(f.size > 0 && f.size <= capBytes)) {
        setStatus('Skipped ' + (f.name || 'file') + ': must be 1 byte–' + capLabel + '.', false);
        continue;
      }
      if (!isVideo && !(f.size > 0 && f.size <= capBytes)) {
        setStatus('Skipped ' + (f.name || 'file') + ': must be 1 byte–' + capLabel + '.', false);
        continue;
      }
      if (isVideo && !/\.(mp4|webm|mov|mkv)$/i.test(f.name || '')) {
        setStatus('Skipped ' + (f.name || 'file') + ': video must be mp4, webm, mov or mkv.', false);
        continue;
      }
      if (!isVideo && !/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f.name || '')) {
        setStatus('Skipped ' + (f.name || 'file') + ': audio must be mp3, wav, m4a, aac, ogg or flac.', false);
        continue;
      }
      try {
        var meta = await fileMeta(kind, f);
        if (!Number.isFinite(meta.duration) || meta.duration <= 0) throw new Error('no duration');
        var entry = addFileEntry(project, {
          kind: kind, name: f.name, duration: meta.duration, width: meta.width, height: meta.height
        });
        var url = null;
        try { url = URL.createObjectURL(f); } catch (err) {}
        fileBlobs.set(entry.id, { blob: f, url: url });
        appendMediaClip(project, entry.id, tlTime);
        added++;
      } catch (err) {
        setStatus('Skipped ' + (f.name || 'file') + ': ' + (err.message || 'unreadable.'), false);
      }
    }
    fitZoom();
    refreshAfterFiles(added ? 'Added ' + added + ' ' + kind + ' clip(s) at the playhead.' : '');
  }

  function fitZoom() {
    var scroll = $('veScroll');
    var dur = outDur();
    if (scroll && dur > 0) {
      pxPerSec = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, (scroll.clientWidth - GUTTER_PX - 20) / dur));
    }
  }

  function setImageFiles(files) {
    var countAdded = 0;
    var skipped = 0;
    Array.prototype.forEach.call(files || [], function (f) {
      var duplicate = imageFiles.some(function (existing) {
        return existing.name === f.name && existing.size === f.size;
      });
      if (duplicate) return;
      if (imageFiles.length >= MAX_IMAGE_FILES) {
        skipped++;
        return;
      }
      imageFiles.push(f);
      try { imageURLs.push(URL.createObjectURL(f)); } catch (e) { imageURLs.push(''); }
      countAdded++;
    });
    if (skipped > 0 || (imageFiles.length >= MAX_IMAGE_FILES && (files || []).length > countAdded)) {
      setStatus('Only up to ' + MAX_IMAGE_FILES + ' unique overlay images can be loaded.', false);
    } else if (countAdded > 0) {
      setStatus('Loaded ' + countAdded + ' overlay image(s). Current total: ' + imageFiles.length + '.', true);
    }
    renderPreview();
    renderInspector();
  }

  function addClipAtPlayhead(type) {
    if (!project || !(contentEnd(project) > 0)) { setStatus('Add a video clip first.', false); return; }
    if (type === 'image' && imageFiles.length === 0) {
      setStatus('Choose overlay image file(s) first.', false);
      return;
    }
    try {
      var fileIdx = type === 'image' ? Math.max(0, imageFiles.length - 1) : 0;
      if (type === 'voverlay') {
        var allVideos = project.files.filter(function (f) { return f.kind === 'video'; });
        var overlaySources = allVideos.filter(function (f) { return f.isOverlaySource; });
        var pool = overlaySources.length > 0 ? overlaySources : allVideos;
        if (!pool.length) {
          setStatus('Upload a video overlay source first.', false);
          return;
        }
        var targetFile = pool[pool.length - 1];
        fileIdx = allVideos.indexOf(targetFile);
        if (fileIdx < 0) fileIdx = 0;
      }
      addClip(project, type, tlTime, fileIdx);
    } catch (err) { setStatus(err.message || 'Cannot add clip.', false); return; }
    renderTimeline();
    renderPreview();
    renderInspector();
  }

  function selectedMediaClip() {
    if (!project || !project.selectedId) return null;
    var v = project.videoClips.find(function (c) { return c.id === project.selectedId; });
    if (v) return { kind: 'video', clip: v };
    var a = project.audioClips.find(function (c) { return c.id === project.selectedId; });
    if (a) return { kind: 'audio', clip: a };
    return null;
  }

  function deleteSelected() {
    if (!project || !project.selectedId) { setStatus('Select a clip first.', false); return; }
    var id = project.selectedId;
    // Deleting a video segment also removes its split-generated items
    // (collected for the status line); independent clips are untouched.
    var linked = [];
    if (deleteClip(project, id) || deleteVideoClip(project, id, linked) || deleteAudioClip(project, id)) {
      if (linked.length) setStatus('Deleted video segment + ' + linked.length + ' linked clip(s).', true);
      if (tlTime > contentEnd(project)) seek(contentEnd(project));
      else { renderTimeline(); renderPreview(); renderInspector(); }
    } else {
      setStatus('Select a clip first.', false);
    }
  }

  function duplicateSelected() {
    if (!project || !project.selectedId) { setStatus('Select a clip first.', false); return; }
    var id = project.selectedId;
    try {
      if (getClip(project, id)) duplicateClip(project, id);
      else if (project.videoClips.some(function (c) { return c.id === id; })) duplicateVideoClip(project, id);
      else if (project.audioClips.some(function (c) { return c.id === id; })) duplicateAudioClip(project, id);
      else { setStatus('Select a clip first.', false); return; }
    } catch (err) { setStatus(err.message || 'Cannot duplicate.', false); return; }
    renderTimeline();
    renderPreview();
    renderInspector();
  }

  // Split at playhead cuts EVERYTHING spanning the playhead — the video
  // clip (via splitVideoClipAt in the model), plus audio clips and
  // blur/text/image overlays — so all tracks stay in sync. Clips fully
  // before/after the playhead are untouched.
  function splitAtPlayhead() {
    if (!project) { setStatus('Add a video clip first.', false); return; }
    var result;
    try {
      result = splitAllAtPlayhead(project, tlTime);
    } catch (err) { setStatus(err.message || 'Cannot split here.', false); return; }
    if (!result || !result.didSplit) {
      setStatus('Move the playhead inside a clip to split.', false);
      return;
    }
    renderTimeline();
    renderPreview();
    renderInspector();
  }

  // ---- export ----
  // Export quality/resolution selector value ('original' default). Only known
  // ids leave this function; anything else falls back to Original (no FFmpeg
  // scaling arr downstream).
  function selectedExportResolution() {
    var el = $('exportResolution');
    var v = el && el.value ? String(el.value) : 'original';
    v = v.trim().toLowerCase();
    if (v === '480p' || v === '720p' || v === '1080p' || v === '2k' || v === '4k' || v === '8k') return v;
    return 'original';
  }

  var currentExportId = null;
  var isExporting = false;
  var pollTimer = null;

  function cancelExport() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (!isExporting || !currentExportId) return;
    var exportIdToCancel = currentExportId;
    currentExportId = null;
    isExporting = false;

    var exportBtn = $('exportBtn');
    if (exportBtn) {
      exportBtn.disabled = true;
      exportBtn.textContent = 'Cancelling...';
    }

    fetch('/api/admin/video-editor/cancel-export', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id: exportIdToCancel }),
      credentials: 'same-origin'
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; });
      })
      .then(function () {
        setStatus('Export cancelled', false);
        resetProgressUI();
      })
      .catch(function () {
        setStatus('Export cancelled', false);
        resetProgressUI();
      });
  }

  function resetProgressUI() {
    var exportBtn = $('exportBtn');
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.textContent = 'Export edited MP4';
    }
    var progContainer = $('exportProgressContainer');
    var progBar = $('exportProgressBar');
    if (progContainer) {
      progContainer.style.display = 'none';
    }
    if (progBar) {
      progBar.style.width = '0%';
    }
  }

  function doExport() {
    if (isExporting) {
      cancelExport();
      return;
    }
    setStatus('', true);
    if (!project || project.videoClips.length === 0) { setStatus('Add a video clip first.', false); return; }
    syncWatermarkFromUI();
    for (const c of project.clips) {
      if (c.type === 'image' && (!Number.isInteger(c.file) || c.file < 0 || c.file >= imageFiles.length)) {
        setStatus('An image clip references an image file that is not loaded.', false);
        return;
      }
    }
    var spec;
    try {
      spec = projectToSpecV2(project);
    } catch (err) { setStatus(err.message || 'Invalid edits.', false); return; }
    spec.resolution = selectedExportResolution();
    var fd = new FormData();
    fd.append('spec', JSON.stringify(spec));
    fd.append('resolution', spec.resolution);
    for (const f of project.files) {
      if (f.kind !== 'video') continue;
      var vinfo = fileBlobs.get(f.id);
      if (!vinfo || !vinfo.blob) { setStatus('Missing bytes for ' + f.name + '.', false); return; }
      fd.append('video', vinfo.blob, f.name);
    }
    for (const f of project.files) {
      if (f.kind !== 'audio') continue;
      var ainfo = fileBlobs.get(f.id);
      if (!ainfo || !ainfo.blob) { setStatus('Missing bytes for ' + f.name + '.', false); return; }
      fd.append('audio', ainfo.blob, f.name);
    }
    imageFiles.forEach(function (img) { fd.append('image', img, img.name); });
    
    var exportId = Date.now() + Math.random().toString(36).substring(2, 10);
    fd.append('exportId', exportId);

    var exportBtn = $('exportBtn');
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.textContent = 'Cancel Export';
    }

    var progContainer = $('exportProgressContainer');
    var progBar = $('exportProgressBar');
    if (progContainer) {
      progContainer.style.display = 'block';
    }
    if (progBar) {
      progBar.style.width = '0%';
    }

    var startTime = new Date();
    var pad = function (num) { return String(num).padStart(2, '0'); };
    var timeStr = pad(startTime.getHours()) + ':' + pad(startTime.getMinutes()) + ':' + pad(startTime.getSeconds());
    var exportStartPrefix = 'Export started: ' + timeStr;
    var exportStartMs = Date.now();

    // Preparing: the upload/spec validation/ffmpeg spawn can take a while
    // and no measurable progress exists yet — show that honestly instead of
    // a fake 0%. The start-time prefix is kept; no ETA is estimated yet.
    setStatus(exportStartPrefix + ' — Preparing export... — Estimating remaining time...', true);
    isExporting = true;
    currentExportId = exportId;

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (!isExporting || currentExportId !== exportId) {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        return;
      }

      fetch('/api/admin/video-editor/export-progress?id=' + exportId, { credentials: 'same-origin' })
        .then(function (r) {
          if (!r.ok) throw new Error('progress failed');
          return r.json();
        })
        .then(function (data) {
          if (!isExporting || currentExportId !== exportId) {
            if (pollTimer) {
              clearInterval(pollTimer);
              pollTimer = null;
            }
            return;
          }
          // Backend statuses: unknown (no entry yet) -> starting (ffmpeg
          // spawned, nothing measurable) -> rendering (first time= parsed)
          // -> done/failed/cancelled. Only rendering (or a real percent)
          // switches to the percentage view; anything earlier keeps the
          // honest preparing state with the bar at 0%.
          var measurable = data && (data.status === 'rendering' || data.status === 'done' ||
            (typeof data.percent === 'number' && data.percent > 0));
          if (measurable) {
            var pct = data.percent.toFixed(2) + '%';
            // ETA from actual elapsed time + actual progress, refreshed on
            // every poll. Null (0%/100%/invalid) means no ETA suffix.
            var etaSuffix = '';
            var etaMs = estimateRemainingMs(Date.now() - exportStartMs, data.percent);
            if (etaMs !== null) {
              var etaLabel = formatEta(etaMs);
              if (etaLabel) etaSuffix = ' — ' + etaLabel;
            }
            setStatus(exportStartPrefix + ' — Exporting... ' + pct + etaSuffix, true);
            if (progBar) {
              progBar.style.width = pct;
            }
          } else if (data && (data.status === 'starting' || data.status === 'unknown')) {
            setStatus(exportStartPrefix + ' — Preparing export... — Estimating remaining time...', true);
          }
        })
        .catch(function () {});
    }, 1000);

    fetch('/api/admin/video-editor/export', { method: 'POST', credentials: 'same-origin', body: fd })
      .then(function (r) {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        if (!isExporting || currentExportId !== exportId) {
          throw new Error('cancelled_by_user');
        }
        if (!r.ok) {
          return r.json().catch(function () { return { error: 'Export failed (HTTP ' + r.status + ').' }; }).then(function (d) {
            throw new Error((d && d.error) || 'Export failed.');
          });
        }
        if (progBar) {
          progBar.style.width = '100%';
        }
        setStatus(exportStartPrefix + ' — Exporting... 100.00%', true);
        return r.blob().then(function (blob) { return { blob: blob, name: r.headers.get('X-Export-Filename') || 'edited-video.mp4' }; });
      })
      .then(function (out) {
        if (!isExporting || currentExportId !== exportId) return;
        var url = URL.createObjectURL(out.blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = out.name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {} }, 4000);
      })
      .catch(function (err) {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        if (err.message === 'cancelled_by_user') {
          return;
        }
        if (progContainer) {
          progContainer.style.display = 'none';
        }
        if (progBar) {
          progBar.style.width = '0%';
        }
        setStatus(err.message || 'Export failed.', false);
      })
      .finally(function () {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        if (isExporting && currentExportId === exportId) {
          isExporting = false;
          currentExportId = null;
          if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.textContent = 'Export edited MP4';
          }
          setTimeout(function () {
            if (progContainer) {
              progContainer.style.display = 'none';
            }
            if (progBar) {
              progBar.style.width = '0%';
            }
          }, 1500);
        }
      });
  }

  // Read-only bridge for the optional EDL evidence panel. It reflects the
  // current video timeline; it does not alter clips or bypass the export path.
  window.getVideoEditorTimelineEdl = function () {
    if (!project || !Array.isArray(project.videoClips) || !project.videoClips.length) {
      throw new Error('Upload a video and add at least one video clip to the timeline first.');
    }
    var sources = {};
    var sourceDurations = {};
    var sourceKeys = new Map();
    var ranges = [];
    var total = 0;
    project.videoClips.slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (clip) {
      var file = getMediaFile(project, clip.file);
      if (!file || typeof file.name !== 'string' || !file.name) {
        throw new Error('A timeline clip is missing its source filename.');
      }
      var key = sourceKeys.get(clip.file);
      if (!key) {
        key = 'SOURCE_' + (sourceKeys.size + 1);
        sourceKeys.set(clip.file, key);
        sources[key] = file.name;
        sourceDurations[key] = Number(file.duration) || 0;
      }
      var start = Number(clip.sourceIn);
      var end = Number(clip.sourceOut);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new Error('A timeline clip has an invalid source range.');
      }
      ranges.push({ source: key, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 });
      total = Math.round((total + end - start) * 1000) / 1000;
    });
    return { version: 1, sources: sources, source_durations: sourceDurations, ranges: ranges, total_duration_s: total };
  };

  // Apply a reviewed EDL to the editor's video timeline. The normal Export
  // button then renders the resulting project through the existing pipeline.
  window.applyVideoEditorEdl = function (edl) {
    if (!project) throw new Error('Video Editor is not initialized.');
    if (!edl || typeof edl !== 'object' || !edl.sources || !Array.isArray(edl.ranges) || !edl.ranges.length) {
      throw new Error('EDL must contain a sources map and at least one kept range.');
    }
    var fileByName = new Map();
    project.files.forEach(function (f) {
      if (f.kind === 'video' && f.name && !fileByName.has(f.name)) fileByName.set(f.name, f);
    });
    var plan = [];
    var cursor = 0;
    edl.ranges.forEach(function (r, index) {
      if (!r || typeof r.source !== 'string' || !edl.sources[r.source]) throw new Error('EDL range ' + (index + 1) + ' has an unknown source.');
      var file = fileByName.get(edl.sources[r.source]);
      if (!file) throw new Error('Upload the source video "' + edl.sources[r.source] + '" in the main editor first.');
      var start = Number(r.start), end = Number(r.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > file.duration + 0.05) {
        throw new Error('EDL range ' + (index + 1) + ' is outside the source video or invalid.');
      }
      plan.push({ fileId: file.id, start: start, end: Math.min(end, file.duration), outputStart: cursor });
      cursor = Math.round((cursor + end - start) * 1000) / 1000;
    });
    if (cursor <= 0) throw new Error('EDL has no usable output duration.');
    // Replace only the video lane; audio and overlays remain untouched and may
    // need manual adjustment if the new cut duration/order differs.
    project.videoClips.slice().forEach(function (clip) { deleteVideoClip(project, clip.id); });
    plan.forEach(function (item) {
      var clip = appendMediaClip(project, item.fileId, item.outputStart, 1);
      clip.sourceIn = item.start;
      clip.sourceOut = item.end;
      clip.start = item.outputStart;
      clip.gain = 1;
      clip.volumeDb = 0;
      clip.fadeIn = 0;
      clip.fadeOut = 0;
      clip.crop = null;
    });
    tlTime = 0;
    renderTimeline();
    renderInspector();
    seek(0);
    return { duration: cursor, clips: plan.length };
  };

  // ---- screen recorder (record → pick → region → auto-record ⇄ pause → stop → main video clip) ----
  // One-button flow: Record opens the native picker from the click; the
  // granted source plays in a region modal where the user drags a
  // rectangle, and recording starts automatically on Confirm. Capture uses
  // a canvas crop pipeline (drawImage of the region → captureStream):
  // CropTarget/cropTo() cannot do this (element-scoped, same-tab-only,
  // Chromium-only). An invalid region or missing canvas capture fails
  // loudly to idle — never a silent fullscreen recording. Pause/Resume use
  // the native MediaRecorder methods with session state checks; the timer
  // excludes paused spans (see recorderElapsedMs). Finalize hands the
  // recording to the existing pipeline via addMediaFiles('video', [file]):
  // upload caps, extension checks, metadata probing, file registration,
  // timeline clips and export are all reused unchanged. Pure helpers (MIME
  // probing, resolution constraints, region geometry, error mapping,
  // session/elapsed math, control matrix, File assembly) live in
  // ./screen-recorder.js so they are unit-testable under node:test.
  var srSession = createRecorderSession();
  var srStream = null;
  var srRecorder = null;
  var srChunks = [];
  var srMimeType = '';
  var srTimerId = 0;
  var srStopping = false;
  var srFinalized = false;
  // In-flight guard: Record stays enabled while the picker is open and
  // constraints apply (session is still idle). Without it, a second click
  // launches a duplicate getDisplayMedia flight or a duplicate
  // MediaRecorder on the same stream, leaking tracks/recorders.
  var srStarting = false;
  var srResolutionId = RECORDER_DEFAULT_RESOLUTION;
  // Region-capture state: the modal preview video doubles as the crop
  // source during recording. srOutStream is the canvas stream being
  // recorded (canvas video track + transferred display audio tracks).
  // srRegionBox is the clamped source-pixel box; srRegionCss is the live
  // drag in preview CSS pixels. srConfirming guards double-Confirm.
  var srOutStream = null;
  var srRegionCanvas = null;
  var srRegionBox = null;
  var srRegionCss = null;
  // Optional narration and webcam PiP; both start disabled.
  var srAudioContext = null;
  var srAudioDestination = null;
  var srAudioSources = [];
  var srMicStream = null;
  var srMicGain = null;
  var srMicEnabled = false;
  var srCameraStream = null;
  var srCameraVideo = null;
  var srCameraEnabled = false;
  // Pause & Edit Studio: overlays are composited into future recorded frames.
  var srPauseOverlays = [];
  var srPauseStudioSnapshot = null;
  var srPauseStudioOpen = false;
  var srPauseStudioMode = 'select';
  var srPauseStudioSelected = -1;
  var srPauseStudioDrag = null;
  var srPauseStudioDraft = null;
  var srPauseBlurCanvas = null;
  var srRegionOpen = false;
  var srConfirming = false;
  var srRafId = 0;
  var srPumpTimer = 0;
  var srVisibilityHandler = null;
  var srRegionKeyHandler = null;
  // Preview readiness: the modal opens before first frames arrive, so
  // Confirm stays disabled until the preview reports usable dimensions and
  // frames. The bounded poll either enables selection or cancels with an
  // actionable error — a dead preview can never strand the session.
  var srPreviewTimer = 0;
  var srPreviewReady = false;
  var srPreviewStartedAt = 0;
  var srRegionResizeHandler = null;
  // Consecutive crop-draw failures (see srDrawRegionFrame).
  var srDrawFailures = 0;
  var srCountdownTimer = 0;
  var srCountdownResolve = null;
  var srStopFinalizeTimer = 0;
  var srPendingFile = null;
  var srProcessingRecording = false;
  var srRecorderFailureStatus = '';
  var srControlPipWindow = null;
  var srControlPipDocument = null;
  var srAbortRequested = false;

  function srRecordBtn() { return $('srRecordBtn'); }
  function srPauseBtn() { return $('srPauseBtn'); }
  function srResumeBtn() { return $('srResumeBtn'); }
  function srStopBtn() { return $('srStopBtn'); }
  function srResolutionSel() { return $('srResolution'); }

  function srSetStatus(text, active) {
    var el = $('srStatus');
    if (!el) return;
    el.textContent = text;
    el.style.color = active ? '#dc2626' : '#64748b';
  }

  function srSetError(text) {
    var el = $('srError');
    if (el) el.textContent = text || '';
  }

  function srPaintTimer() {
    var el = $('srTimer');
    if (el) el.textContent = formatRecorderElapsed(recorderElapsedMs(srSession, Date.now()));
    srRenderControlWindow();
  }

  // Enablement follows the pure control matrix so buttons always reflect
  // the actual capture/recording state. The resolution selector explains
  // itself: it is a best-effort preference applied when recording starts,
  // so it is only unavailable during an active session.
  function srControlButtonMarkup(id, symbol, tooltip, style) {
    // Share the available row width and scale glyphs with the resizable PiP viewport.
    return '<button id="' + id + '" type="button" title="' + tooltip + '" aria-label="' + tooltip + '" data-tooltip="' + tooltip + '" style="box-sizing:border-box;flex:1 1 0;width:0;min-width:0;height:100%;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;border:0;border-radius:clamp(4px,1.2vw,12px);padding:0;font:700 clamp(14px,7vh,72px) Segoe UI,Arial,sans-serif;line-height:1;white-space:nowrap;cursor:pointer;' + style + '">' + symbol + '</button>';
  }

  function srRenderControlWindow() {
    var doc = srControlPipDocument;
    var pipStatus = doc && doc.body ? doc.getElementById('srPipStatus') : null;
    var pipPause = doc && doc.body ? doc.getElementById('srPipPause') : null;
    var pipResume = doc && doc.body ? doc.getElementById('srPipResume') : null;
    var pipStop = doc && doc.body ? doc.getElementById('srPipStop') : null;
    var pipAbort = doc && doc.body ? doc.getElementById('srPipAbort') : null;
    var pipSave = doc && doc.body ? doc.getElementById('srPipSave') : null;
    var pipMic = doc && doc.body ? doc.getElementById('srPipMic') : null;
    var pipCamera = doc && doc.body ? doc.getElementById('srPipCamera') : null;
    var fallbackStatus = $('srFloatingStatus');
    var fallbackPause = $('srFloatingPause');
    var fallbackResume = $('srFloatingResume');
    var fallbackStop = $('srFloatingStop');
    var fallbackAbort = $('srFloatingAbort');
    var fallbackSave = $('srFloatingSave');
    var fallbackMic = $('srFloatingMic');
    var fallbackCamera = $('srFloatingCamera');
    var finishing = srStopping || srProcessingRecording || !!srPendingFile || !!srRecorderFailureStatus;
    var active = srSession.status === 'recording';
    var paused = srSession.status === 'paused';
    var statusText = active
      ? 'Recording · ' + formatRecorderElapsed(recorderElapsedMs(srSession, Date.now()))
      : paused ? 'Paused'
      : srProcessingRecording ? 'Processing recording…'
      : srPendingFile ? 'Ready to save'
      : srRecorderFailureStatus || (srSession.status === 'idle' ? 'Not recording' : 'Starting…');
    [pipStatus, fallbackStatus].forEach(function (el) { if (el) el.textContent = statusText; });
    [pipPause, fallbackPause].forEach(function (el) {
      if (el) {
        el.disabled = !active;
        el.style.display = active ? 'inline-flex' : 'none';
      }
    });
    [pipResume, fallbackResume].forEach(function (el) {
      if (el) {
        el.disabled = !paused;
        el.style.display = paused ? 'inline-flex' : 'none';
      }
    });
    [pipStop, fallbackStop].forEach(function (el) {
      if (el) {
        el.disabled = !(active || paused);
        if (finishing) el.disabled = true;
        if (srPendingFile) el.textContent = 'Stopped';
        else if (el.id === 'srPipStop') el.textContent = '■';
        else if (el.id === 'srFloatingStop') el.textContent = '■ Stop';
      }
    });
    [pipAbort, fallbackAbort].forEach(function (el) { if (el) el.disabled = !(active || paused || srRegionOpen || srStarting); });
    [pipSave, fallbackSave].forEach(function (el) {
      if (el) {
        el.disabled = !srPendingFile;
        el.style.display = srPendingFile ? 'inline-flex' : 'none';
        el.textContent = el.id === 'srPipSave' ? '⬇' : '⬇ Save video';
        el.title = srPendingFile ? 'Save the completed recording' : 'Available after Stop finishes';
      }
    });
    [pipMic, fallbackMic].forEach(function (el) {
      if (!el) return;
      el.disabled = !(active || paused); el.textContent = srMicEnabled ? '🎙' : '🔇';
      el.title = srMicEnabled ? 'Mute microphone' : 'Unmute microphone (asks permission first time)';
      el.setAttribute('aria-label', el.title);
    });
    [pipCamera, fallbackCamera].forEach(function (el) {
      if (!el) return;
      el.disabled = !(active || paused); el.textContent = srCameraEnabled ? '📷' : '🚫';
      el.title = srCameraEnabled ? 'Turn camera off' : 'Turn camera on (adds picture-in-picture)';
      el.setAttribute('aria-label', el.title);
    });
  }

  function srCloseFloatingControls() {
    // A Stop-triggered PiP close was making the entire control surface vanish
    // before the user could see finalization or retrieve the result. Keep a
    // page-level recovery surface until processing finishes or the user
    // explicitly saves/discards the pending file.
    if (srStopping || srProcessingRecording || srPendingFile) {
      var winWhileFinishing = srControlPipWindow;
      srControlPipWindow = null;
      srControlPipDocument = null;
      try { if (winWhileFinishing && !winWhileFinishing.closed) winWhileFinishing.close(); } catch (err) {}
      var recoverableFallback = $('srFloatingControlsFallback');
      if (recoverableFallback) recoverableFallback.style.display = 'block';
      srRenderControlWindow();
      return;
    }
    var win = srControlPipWindow;
    srControlPipWindow = null;
    srControlPipDocument = null;
    try { if (win && !win.closed) win.close(); } catch (err) {}
    var fallback = $('srFloatingControlsFallback');
    if (fallback) fallback.style.display = 'none';
  }

  function srShowFallbackControls() {
    var fallback = $('srFloatingControlsFallback');
    if (fallback) fallback.style.display = 'block';
    srRenderControlWindow();
  }

  function srOpenFloatingControls() {
    // Document Picture-in-Picture provides an always-on-top control surface
    // while the user switches to other apps. It is requested directly from
    // the Record region click so the browser's transient user activation is
    // still available. Older browsers fall back to a page-fixed toolbar.
    try {
      var api = window.documentPictureInPicture;
      if (!api || typeof api.requestWindow !== 'function') {
        srShowFallbackControls();
        return;
      }
      var pending = api.requestWindow({ width: 300, height: 76 });
      if (!pending || typeof pending.then !== 'function') {
        srShowFallbackControls();
        return;
      }
      pending.then(function (pip) {
        if (!pip || pip.closed) {
          srShowFallbackControls();
          return;
        }
        srControlPipWindow = pip;
        srControlPipDocument = pip.document;
        try {
          var base = document.querySelector('link[rel="stylesheet"]');
          if (base && base.href) {
            var link = pip.document.createElement('link');
            link.rel = 'stylesheet';
            link.href = base.href;
            pip.document.head.appendChild(link);
          }
        } catch (err) {}
        var doc = pip.document;
        doc.title = 'Screen recording controls';
        doc.documentElement.style.width = '100%';
        doc.documentElement.style.height = '100%';
        doc.documentElement.style.boxSizing = 'border-box';
        doc.body.style.margin = '0';
        doc.body.style.overflow = 'hidden';
        doc.body.style.width = '100%';
        doc.body.style.height = '100%';
        doc.body.style.minWidth = '0';
        doc.body.style.minHeight = '0';
        doc.body.style.boxSizing = 'border-box';
        doc.body.innerHTML = '<main style="box-sizing:border-box;display:flex;flex-direction:column;gap:clamp(2px,0.8vh,8px);width:100%;height:100%;min-width:0;min-height:0;margin:0;padding:clamp(3px,1vw,10px);background:#f8fafc;color:#0f172a;font:clamp(10px,2.5vh,22px) Segoe UI,Arial,sans-serif;">' +
          '<div id="srPipStatus" role="status" style="flex:0 0 auto;height:clamp(18px,12%,38px);line-height:1.2;margin:0;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:clamp(10px,2.5vh,22px);">Starting…</div>' +
          '<div style="display:flex;flex:1 1 auto;min-height:0;min-width:0;width:100%;gap:clamp(2px,0.8vw,8px);align-items:stretch;justify-content:stretch;overflow:hidden;">' +
          srControlButtonMarkup('srPipPause', 'Ⅱ', 'Pause recording', 'background:#e2e8f0;color:#0f172a;') +
          srControlButtonMarkup('srPipResume', '▶', 'Resume recording', 'background:#e2e8f0;color:#0f172a;') +
          srControlButtonMarkup('srPipStop', '■', 'Stop recording', 'background:#1e3a8a;color:#fff;') +
          srControlButtonMarkup('srPipAbort', '✕', 'Abort and discard recording', 'background:#fee2e2;color:#991b1b;') +
          srControlButtonMarkup('srPipMic', '🔇', 'Unmute microphone', 'background:#e2e8f0;color:#0f172a;') +
          srControlButtonMarkup('srPipCamera', '🚫', 'Turn camera on', 'background:#e2e8f0;color:#0f172a;') +
          srControlButtonMarkup('srPipSave', '↓', 'Save recording', 'background:#047857;color:#fff;') +
          '</div></main>';
        doc.getElementById('srPipPause').addEventListener('click', srPauseRecording);
        doc.getElementById('srPipResume').addEventListener('click', srResumeRecording);
        doc.getElementById('srPipStop').addEventListener('click', srStopRecording);
        doc.getElementById('srPipAbort').addEventListener('click', srAbortRecording);
        doc.getElementById('srPipMic').addEventListener('click', srToggleMicrophone);
        doc.getElementById('srPipCamera').addEventListener('click', srToggleCamera);
        doc.getElementById('srPipSave').addEventListener('click', function () {
          if (srPendingFile) srSavePendingRecording();
        });
        pip.addEventListener('pagehide', function () {
          srControlPipWindow = null;
          srControlPipDocument = null;
          // Some browser/window-manager paths dismiss Document PiP when capture
          // ends. Preserve the controls on the editor page through finalization
          // so the completed file can still be saved.
          if (srStopping || srProcessingRecording || srPendingFile) {
            srShowFallbackControls();
          }
        });
        srRenderControlWindow();
      }).catch(function () {
        srShowFallbackControls();
      });
    } catch (err) {
      srShowFallbackControls();
    }
  }

  function srAbortRecording() {
    if (srRegionOpen && srSession.status === 'idle') {
      srCancelRegion('Recording aborted.');
      srCloseFloatingControls();
      return;
    }
    if (srSession.status !== 'recording' && srSession.status !== 'paused') return;
    srAbortRequested = true;
    srSetStatus('Aborting recording…', false);
    srStopRecording();
  }

  function srSyncButtons() {
    var controls = recorderControlsFor(srSession.status);
    var record = srRecordBtn();
    var pause = srPauseBtn();
    var resume = srResumeBtn();
    var stop = srStopBtn();
    var resolution = srResolutionSel();
    if (record) record.disabled = !controls.record || srStarting;
    if (pause) pause.disabled = !controls.pause;
    if (resume) resume.disabled = !controls.resume;
    if (stop) stop.disabled = !controls.stop;
    if (resolution) {
      resolution.disabled = !controls.resolution;
      try {
        resolution.title = controls.resolution
          ? 'Preferred capture resolution (best effort; applies when you press Record).'
          : 'Resolution is fixed while recording or paused; change it when idle.';
      } catch (err) {}
    }
    srRenderControlWindow();
  }

  function srStopTimer() {
    if (srTimerId) {
      try { clearInterval(srTimerId); } catch (err) {}
      srTimerId = 0;
    }
  }

  function srStopStreamTracks(stream) {
    if (!stream) return;
    try {
      stream.getTracks().forEach(function (track) {
        try { track.stop(); } catch (err) {}
      });
    } catch (err) {}
  }

  // Create a stable mixed audio track before recording, allowing microphone
  // mute/unmute without changing MediaRecorder's active track set.
  async function srSetupAudioMixer(outStream) {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!outStream) return false;
    if (!AudioCtx) {
      // Keep existing system audio on browsers without Web Audio. Mic control
      // will report unsupported instead of silently losing the audio track.
      try {
        var fallbackTracks = srStream && srStream.getAudioTracks ? srStream.getAudioTracks() : [];
        fallbackTracks.forEach(function (track) { try { outStream.addTrack(track); } catch (err) {} });
      } catch (err) {}
      return false;
    }
    try {
      srAudioContext = new AudioCtx();
      srAudioDestination = srAudioContext.createMediaStreamDestination();
      var displayTracks = srStream && srStream.getAudioTracks ? srStream.getAudioTracks() : [];
      var connectedSources = 0;
      displayTracks.forEach(function (track) {
        try {
          var source = srAudioContext.createMediaStreamSource(new MediaStream([track]));
          source.connect(srAudioDestination);
          srAudioSources.push(source);
          connectedSources += 1;
        } catch (err) {}
      });
      if (connectedSources === 0) {
        // A source-less MediaStreamDestination starves the recorder: Chrome
        // emits only empty dataavailable blobs for the whole session, so Stop
        // finalizes with zero chunks ("Recording failed — no video data")
        // even while the region canvas is painting every frame. A zero-gain
        // keeper source keeps the muxer fed with silence; microphone
        // narration enabled later joins the same destination unchanged.
        try {
          var keeperOsc = srAudioContext.createOscillator();
          var keeperGain = srAudioContext.createGain();
          keeperGain.gain.value = 0;
          keeperOsc.connect(keeperGain);
          keeperGain.connect(srAudioDestination);
          if (typeof keeperOsc.start === 'function') keeperOsc.start();
          srAudioSources.push(keeperOsc);
        } catch (err) {}
      }
      var mixedTrack = srAudioDestination.stream.getAudioTracks()[0];
      if (mixedTrack) outStream.addTrack(mixedTrack);
      try { await srAudioContext.resume(); } catch (err) {}
      return !!mixedTrack;
    } catch (err) {
      try { if (srAudioContext) srAudioContext.close(); } catch (e2) {}
      srAudioContext = null; srAudioDestination = null; srAudioSources = [];
      try {
        var direct = srStream && srStream.getAudioTracks ? srStream.getAudioTracks() : [];
        direct.forEach(function (track) { try { outStream.addTrack(track); } catch (e3) {} });
      } catch (e4) {}
      return false;
    }
  }

  async function srToggleMicrophone() {
    if (srSession.status !== 'recording' && srSession.status !== 'paused') return;
    try {
      if (!srMicStream) {
        if (!srAudioContext || !srAudioDestination) throw new Error('Microphone mixing is not supported by this browser.');
        srMicStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false
        });
        if (!srMicStream.getAudioTracks()[0]) throw new Error('No microphone was provided by the selected device.');
        var source = srAudioContext.createMediaStreamSource(srMicStream);
        srMicGain = srAudioContext.createGain();
        srMicGain.gain.value = 1;
        source.connect(srMicGain); srMicGain.connect(srAudioDestination); srAudioSources.push(source);
        srMicEnabled = true;
        try { await srAudioContext.resume(); } catch (err) {}
      } else {
        srMicEnabled = !srMicEnabled;
        if (srMicGain && srAudioContext) srMicGain.gain.setTargetAtTime(srMicEnabled ? 1 : 0, srAudioContext.currentTime, 0.015);
      }
      srRenderControlWindow(); srSetError('');
    } catch (err) {
      srSetError('Microphone unavailable: ' + ((err && err.message) || 'allow microphone access and try again.'));
    }
  }

  async function srToggleCamera() {
    if (srSession.status !== 'recording' && srSession.status !== 'paused') return;
    try {
      if (!srCameraStream) {
        srCameraStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false
        });
        if (!srCameraStream.getVideoTracks()[0]) throw new Error('No camera was provided by the selected device.');
        srCameraVideo = document.createElement('video');
        srCameraVideo.muted = true; srCameraVideo.autoplay = true; srCameraVideo.playsInline = true;
        srCameraVideo.srcObject = srCameraStream; srCameraEnabled = true;
        srCameraStream.getVideoTracks()[0].onended = function () { srCameraEnabled = false; srRenderControlWindow(); };
        try { await srCameraVideo.play(); } catch (err) {}
      } else if (srCameraEnabled) {
        // Camera Off is a real device shutdown, not merely hiding the PiP.
        srCameraEnabled = false;
        if (srCameraStream) { srStopStreamTracks(srCameraStream); srCameraStream = null; }
        if (srCameraVideo) {
          try { srCameraVideo.pause(); srCameraVideo.srcObject = null; } catch (err) {}
          srCameraVideo = null;
        }
      } else {
        // If the track was stopped externally, reacquire it on the next click.
        srCameraEnabled = false;
        if (srCameraStream) { srStopStreamTracks(srCameraStream); srCameraStream = null; }
        if (srCameraVideo) { try { srCameraVideo.pause(); srCameraVideo.srcObject = null; } catch (err) {} srCameraVideo = null; }
        return srToggleCamera();
      }
      srRenderControlWindow(); srSetError('');
    } catch (err) {
      srSetError('Camera unavailable: ' + ((err && err.message) || 'allow camera access and try again.'));
      srCameraEnabled = false;
    }
  }

  // Release every capture resource and drop recorder references. Covers
  // the display stream, the canvas output stream, the region pump, the
  // modal (with its key listener), and the preview video. Safe to call
  // from any terminal path (finalize, error, cancel, external stop);
  // repeated calls are no-ops once refs are cleared.
  function srReleaseCapture() {
    srCancelCountdown();
    srStopTimer();
    srStopRegionPump();
    srCloseRegionModal();
    // A second flight cannot be alive when release runs (Record re-entry
    // is guarded by srStarting; terminal paths end flights), so clearing
    // here is safe.
    srStarting = false;
    srConfirming = false;
    if (srOutStream) {
      srStopStreamTracks(srOutStream);
      srOutStream = null;
    }
    if (srStream) { srStopStreamTracks(srStream); srStream = null; }
    if (srMicStream) { srStopStreamTracks(srMicStream); srMicStream = null; }
    if (srCameraStream) { srStopStreamTracks(srCameraStream); srCameraStream = null; }
    if (srCameraVideo) { try { srCameraVideo.pause(); srCameraVideo.srcObject = null; } catch (err) {} srCameraVideo = null; }
    srMicGain = null; srMicEnabled = false; srCameraEnabled = false; srAudioSources = [];
    if (srAudioContext) { try { srAudioContext.close(); } catch (err) {} srAudioContext = null; }
    srAudioDestination = null;
    srRecorder = null;
    srChunks = [];
    srStopping = false;
    srDrawFailures = 0;
    srRegionCanvas = null;
    srRegionBox = null;
    srRegionCss = null;
    srPauseOverlays = [];
    srPauseStudioSnapshot = null;
    srPauseStudioSelected = -1;
    srClosePauseStudio();
  }

  function srResetToIdle(note) {
    srReleaseCapture();
    srAbortRequested = false;
    srSession = createRecorderSession();
    srMimeType = '';
    srPaintTimer();
    srSyncButtons();
    srSetStatus('Idle', false);
    if (note) setStatus(note, true);
  }

  function srFail(message) {
    srSetError(message);
    setStatus(message, false);
    srResetToIdle();
  }

  // Assemble the finalized recording and hand it to the existing upload
  // pipeline as a main video source. No page reload; the clip appears on
  // the timeline at the playhead via addMediaFiles. The finalized guard
  // makes Stop-button, track-ended and recorder-error paths converge here
  // exactly once (no duplicate clips, no double handoff).
  function srCloseRecordingComplete() {
    var modal = $('srRecordingCompleteModal');
    if (modal) modal.style.display = 'none';
  }

  function srShowRecordingComplete(file) {
    srProcessingRecording = false;
    srRecorderFailureStatus = '';
    srPendingFile = file;
    var modal = $('srRecordingCompleteModal');
    var name = $('srRecordingCompleteName');
    var size = $('srRecordingCompleteSize');
    var status = $('srRecordingCompleteStatus');
    if (name) name.textContent = file.name;
    if (size) size.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
    if (status) {
      // The standalone Screen Recorder page ships without an "Add to editor"
      // button; offer only the download path there.
      status.textContent = $('srRecordingCompleteAdd')
        ? 'Recording is ready. Save it to your device or add it to the editor.'
        : 'Recording is ready. Save it to your device.';
    }
    if (modal) modal.style.display = 'flex';
    setStatus('Screen recording is ready to save.', true);
    srRenderControlWindow();
  }

  function srSavePendingRecording() {
    if (!srPendingFile) return;
    var url = '';
    var anchor = null;
    try {
      url = URL.createObjectURL(srPendingFile);
      anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = srPendingFile.name;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      srCloseRecordingComplete();
      srPendingFile = null;
      srProcessingRecording = false;
      srRecorderFailureStatus = '';
      srSetError('');
      setStatus('Download started. Check your browser downloads. Start a new recording whenever you are ready.', true);
      srCloseFloatingControls();
      srRenderControlWindow();
    } catch (err) {
      if (anchor && anchor.parentNode) anchor.parentNode.removeChild(anchor);
      var status = $('srRecordingCompleteStatus');
      if (status) status.textContent = 'Could not start the download. Try again or add the recording to the editor.';
    } finally {
      if (url) {
        try { setTimeout(function () { URL.revokeObjectURL(url); }, 60000); } catch (err) {}
      }
    }
  }

  function srAddPendingRecordingToEditor() {
    if (!srPendingFile) return;
    var file = srPendingFile;
    srCloseRecordingComplete();
    srPendingFile = null;
    srSetError('');
    addMediaFiles('video', [file]).then(function () {
      setStatus('Screen recording added as a main video clip.', true);
    }).catch(function () {
      setStatus('Could not add the recording to the editor. You can record again.', false);
    });
  }

  function srDiscardPendingRecording() {
    srPendingFile = null;
    srProcessingRecording = false;
    srCloseRecordingComplete();
    setStatus('Recording discarded.', false);
    srCloseFloatingControls();
    srRenderControlWindow();
  }

  function srFinalizeRecording() {
    if (srFinalized) return;
    // Stop the recorder's event flow first, but do not destroy the floating
    // controls or report Idle until the recording is either saved or a
    // recoverable failure has been shown. This keeps Stop from looking like
    // it closed/discarded the user's recording while processing is pending.
    srFinalized = true;
    if (srStopFinalizeTimer) {
      try { clearTimeout(srStopFinalizeTimer); } catch (err) {}
      srStopFinalizeTimer = 0;
    }
    srStopTimer();
    srStopRegionPump();
    srStarting = false;
    srConfirming = false;
    var chunks = srChunks.slice();
    var mime = srMimeType;
    var startStamp = srSession.startStamp;
    var stream = srStream;
    var outStream = srOutStream;
    srRecorder = null;
    srChunks = [];
    srStopping = false;
    srDrawFailures = 0;
    if (outStream) {
      srStopStreamTracks(outStream);
      srOutStream = null;
    }
    if (stream) {
      srStopStreamTracks(stream);
      srStream = null;
    }
    // Finalization has its own resource-release path (it does not call
    // srReleaseCapture), so release optional mic/camera devices and Web Audio
    // explicitly here as well.
    if (srMicStream) { srStopStreamTracks(srMicStream); srMicStream = null; }
    if (srCameraStream) { srStopStreamTracks(srCameraStream); srCameraStream = null; }
    if (srCameraVideo) {
      try { srCameraVideo.pause(); srCameraVideo.srcObject = null; } catch (err) {}
      srCameraVideo = null;
    }
    srMicGain = null; srMicEnabled = false; srCameraEnabled = false; srAudioSources = [];
    if (srAudioContext) { try { srAudioContext.close(); } catch (err) {} srAudioContext = null; }
    srAudioDestination = null;
    srCloseRegionModal();
    srRegionCanvas = null;
    srRegionBox = null;
    srRegionCss = null;
    srPauseOverlays = [];
    srPauseStudioSnapshot = null;
    srPauseStudioSelected = -1;
    srClosePauseStudio();
    srSession = createRecorderSession();
    srMimeType = '';
    srPaintTimer();
    srSyncButtons();

    // A very short capture can legitimately end before the first timeslice.
    // Request a final flush before the Stop event when possible; the watchdog
    // still provides a bounded recovery path if the browser omits onstop.
    if (srAbortRequested) {
      srAbortRequested = false;
      srPendingFile = null;
      srCloseRecordingComplete();
      srProcessingRecording = false;
      srSetStatus('Recording aborted and discarded.', false);
      srCloseFloatingControls();
      srRenderControlWindow();
      return;
    }
    if (recorderPayloadBytes(chunks) === 0) {
      var emptyMsg = 'The browser stopped recording but did not provide any video chunks. No file can be assembled from this capture. Try again and keep the selected source active while recording.';
      srRecorderFailureStatus = 'Recording failed — no video data';
      srProcessingRecording = false;
      srSetError(emptyMsg);
      srSetStatus(srRecorderFailureStatus, false);
      setStatus(emptyMsg, false);
      // Keep controls available for recovery and do not silently close them.
      srRenderControlWindow();
      return;
    }
    var file = null;
    try {
      file = buildRecordingFile(chunks, mime, recorderFileName(mime, startStamp));
    } catch (err) {
      var buildMsg = (err && err.message) || 'Could not assemble the screen recording.';
      srRecorderFailureStatus = 'Recording could not be prepared';
      srProcessingRecording = false;
      srSetError(buildMsg);
      srSetStatus(srRecorderFailureStatus, false);
      setStatus(buildMsg, false);
      srRenderControlWindow();
      return;
    }
    srSetError('');
    srProcessingRecording = true;
    srRenderControlWindow();
    srSetStatus('Finalizing MP4…', false);
    // The server permits a bounded 10-minute FFmpeg encode. Do not abort at
    // 12 seconds: that forced a raw WebM recovery download during valid MP4
    // conversions, leaving duration/seek metadata incomplete.
    fetch('/api/admin/video-editor/finalize-recording', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    }).then(async function (response) {
      if (!response.ok) {
        var detail = '';
        try {
          var errorBody = await response.json();
          detail = errorBody && (errorBody.error || errorBody.message) || '';
        } catch (err) {}
        throw new Error('MP4 finalization failed (HTTP ' + response.status + ')' + (detail ? ': ' + detail : ''));
      }
      var contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.indexOf('video/mp4') === -1 && contentType.indexOf('application/octet-stream') === -1) {
        throw new Error('MP4 finalization returned an unexpected content type: ' + (contentType || 'missing'));
      }
      var filename = response.headers.get('X-Recording-Filename') || '';
      if (!filename) {
        var disposition = response.headers.get('content-disposition') || '';
        var match = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
        filename = match && match[1] ? match[1].trim() : '';
      }
      return response.blob().then(function (blob) {
        return { blob: blob, filename: filename };
      });
    }).then(function (result) {
      if (!result.blob || !result.blob.size) throw new Error('MP4 finalization returned an empty file.');
      var fallbackName = file.name.replace(/\.(webm|mp4)$/i, '.mp4');
      var mp4Name = result.filename || fallbackName;
      if (!/\.mp4$/i.test(mp4Name)) mp4Name = mp4Name.replace(/\.[^.]+$/, '') + '.mp4';
      var mp4 = new File([result.blob], mp4Name, { type: 'video/mp4', lastModified: Date.now() });
      srShowRecordingComplete(mp4);
    }).catch(function (err) {
      // Preserve the source recording if conversion genuinely fails, and make
      // the fallback explicit so a WebM is never mistaken for a finalized MP4.
      var reason = err && err.message ? err.message : 'Unknown conversion error';
      srSetStatus('MP4 conversion failed; original WebM is available. ' + reason, false);
      var status = $('srRecordingCompleteStatus');
      srShowRecordingComplete(file);
      if (status) status.textContent = 'MP4 conversion failed. The original WebM is available as a recovery copy. ' + reason;
    });
  }
  function srStopRecording() {
    var status = srSession.status;
    if ((status !== 'recording' && status !== 'paused') || srStopping || srFinalized) return;
    srStopping = true;
    try { stopRecorderSession(srSession, Date.now()); } catch (err) {}
    srStopTimer();
    srPaintTimer();
    srSetStatus('Finishing…', false);
    var rec = srRecorder;
    if (rec) {
      // Browser MediaRecorder should fire onstop, but some browser/driver
      // combinations fail to deliver it promptly. Keep a bounded fallback so
      // Stop never leaves the UI stuck on "Finishing…".
      if (srStopFinalizeTimer) {
        try { clearTimeout(srStopFinalizeTimer); } catch (err) {}
      }
      srStopFinalizeTimer = setTimeout(function () {
        srStopFinalizeTimer = 0;
        if (srFinalized || !srStopping) return;
        var active = srRecorder;
        if (active && active.state !== 'inactive') {
          // First watchdog: some implementations take longer to process stop.
          // Request stop again, retain ondataavailable, and allow another
          // bounded window for final chunks/onstop before recovering.
          try {
            active.stop();
          } catch (err) {
            srSetError('The browser did not stop recording cleanly. Recovering the captured data…');
          }
          srStopFinalizeTimer = setTimeout(function () {
            srStopFinalizeTimer = 0;
            if (!srFinalized && srStopping) {
              srSetError('The browser did not finish the stop event. Recovering the recorded data collected so far…');
              srFinalizeRecording();
            }
          }, 2500);
          return;
        }
        // Inactive means the recorder has stopped; allow queued final
        // dataavailable/onstop events to run before the fallback consumes data.
        srStopFinalizeTimer = setTimeout(function () {
          srStopFinalizeTimer = 0;
          if (!srFinalized && srStopping) srFinalizeRecording();
        }, 500);
      }, 2500);
      try {
        if (rec.state === 'inactive') {
          // Even an already-inactive recorder may have queued its final
          // dataavailable/onstop events. Give them a bounded chance to land
          // before the recovery path snapshots srChunks.
          srStopFinalizeTimer = setTimeout(function () {
            srStopFinalizeTimer = 0;
            if (!srFinalized && srStopping) srFinalizeRecording();
          }, 500);
        } else {
          // Ask MediaRecorder for a final dataavailable event before teardown.
          // Calling requestData while paused can throw in some browsers, so
          // stop remains authoritative and its onstop handler finalizes.
          try {
            if (typeof rec.requestData === 'function' && rec.state === 'recording') rec.requestData();
          } catch (flushError) {}
          rec.stop();
        }
      } catch (err) {
        srSetError('The browser could not stop the recorder cleanly. Trying to recover the recording…');
        // Do not finalize synchronously on a failed stop: the recorder may
        // still deliver one final dataavailable event asynchronously.
        srStopFinalizeTimer = setTimeout(function () {
          srStopFinalizeTimer = 0;
          if (!srFinalized && srStopping) srFinalizeRecording();
        }, 500);
      }
    } else {
      srResetToIdle();
    }
    srSyncButtons();
  }

  function srPauseRecording() {
    if (srSession.status !== 'recording') return;
    var rec = srRecorder;
    if (!rec || rec.state !== 'recording') return;
    try {
      rec.pause();
    } catch (err) {
      srSetError(classifyCaptureError(err));
      return;
    }
    try { pauseRecorderSession(srSession, Date.now()); } catch (err) {}
    srStopRegionPump();
    srSetStatus('Paused', false);
    srPaintTimer();
    srOpenPauseStudio();
    srSyncButtons();
  }

  function srResumeRecording() {
    if (srSession.status !== 'paused') return;
    var rec = srRecorder;
    if (!rec || rec.state !== 'paused') return;
    // Hide/minimize the editor before capture resumes so the UI cannot be
    // mistaken for recording content. Capture is canvas-based and remains isolated.
    srClosePauseStudio();
    try {
      rec.resume();
    } catch (err) {
      srSetError(classifyCaptureError(err));
      return;
    }
    try { resumeRecorderSession(srSession, Date.now()); } catch (err) {}
    var resumeText = 'Recording…';
    if (srRegionBox) resumeText = 'Recording region ' + srRegionBox.w + 'x' + srRegionBox.h + '…';
    srSetStatus(resumeText, true);
    srPaintTimer();
    srSyncButtons();
    srStartRegionPump();
  }

  // The capture video track ended outside our UI (native "Stop sharing" or
  // OS revocation). While recording/paused this funnels into the same stop
  // path as the Stop button; otherwise there is nothing to stop (a grant
  // that ends before recording starts fails gracefully at validation).
  function srOnSourceEnded() {
    if (srFinalized) return;
    var status = srSession.status;
    if (status === 'recording' || status === 'paused') {
      srStopRecording();
      return;
    }
    // The source ended while the region modal is open (or before recording
    // started): cancel back to idle with all tracks stopped.
    if (srRegionOpen) {
      srCancelRegion('The shared source ended before recording started.');
    }
  }

  // Record (one-button flow): invoked from the Record click, which is the
  // user gesture getDisplayMedia requires. Opens the native picker —
  // entire display, window, or tab, as offered by the browser — then starts
  // recording automatically on the granted stream: live-track validation,
  // best-effort resolution preference, exactly one MediaRecorder, session
  // clock, status with actual dimensions, timer. Constraint attempts
  // degrade gracefully: resolution+audio → resolution video-only → plain
  // video. Picker cancellation and denial return to idle via srFail with
  // all tracks stopped. The srStarting guard rejects duplicate clicks
  // while the async flow runs. rec.onstop is the single completion path:
  // Stop button, native Stop sharing, and recorder errors all converge on
  // srFinalizeRecording, which is guarded to run exactly once.
  async function srStartRecording() {
    if (srSession.status !== 'idle') return;
    if (srStarting) return;
    srStarting = true;
    srSyncButtons();
    try {
      srSetError('');
      if (!isRecorderSupported(window)) {
        srFail('Screen recording is not supported in this browser. Use a recent desktop Chrome, Edge, Firefox, or Safari over HTTPS.');
        return;
      }
      var resolutionId = normalizeRecorderResolution(srResolutionId).id;
      var videoConstraints = recorderVideoConstraints(resolutionId);
      var attempts = [
        { video: videoConstraints, audio: true },
        { video: videoConstraints },
        { video: true }
      ];
      var stream = null;
      var lastError = null;
      for (var i = 0; i < attempts.length; i++) {
        try {
          stream = await window.navigator.mediaDevices.getDisplayMedia(attempts[i]);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (!err || (err.name !== 'NotFoundError' && err.name !== 'OverconstrainedError')) break;
        }
      }
      if (!stream) {
        srFail(classifyCaptureError(lastError));
        return;
      }
      var track = stream.getVideoTracks && stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') {
        srStopStreamTracks(stream);
        srFail('Screen capture ended without a live video track.');
        return;
      }
      srStream = stream;
      srFinalized = false;
      track.onended = function () {
        srOnSourceEnded();
      };
      // Hand the live stream to the region modal. The srStarting flight
      // stays claimed while the modal is open (Record is disabled);
      // Confirm continues toward recording, Cancel/Esc/track-end release
      // everything back to idle. There is deliberately no flag clear here.
      try {
        await srOpenRegionModal();
      } catch (err) {
        srFail((err && err.message) || classifyCaptureError(err));
        return;
      }
      srSetStatus('Source granted — drag the region to record.', false);
      srPaintTimer();
    } finally {
      // Keep the flight claimed while the modal owns the session; every
      // other exit (srFail/reset paths) clears it via srReleaseCapture.
      if (!srRegionOpen) srStarting = false;
      srSyncButtons();
    }
  }

  function srRegionModal() { return $('srRegionModal'); }
  function srRegionVideo() { return $('srRegionVideo'); }
  function srRegionStage() { return $('srRegionStage'); }
  function srRegionBoxEl() { return $('srRegionBox'); }
  function srRegionDimsEl() { return $('srRegionDims'); }
  function srRegionConfirmBtn() { return $('srRegionConfirm'); }
  function srRegionCancelBtn() { return $('srRegionCancel'); }

  function srSetRegionError(text) {
    var el = $('srRegionError');
    if (el) el.textContent = text || '';
  }

  // Preview video metrics for drag mapping: CSS size on screen plus the
  // live stream frame size. Null when the preview is not measurable.
  function srStopPreviewPoll() {
    if (srPreviewTimer) {
      try { clearInterval(srPreviewTimer); } catch (err) {}
      srPreviewTimer = 0;
    }
  }

  // Bounded readiness poll: runs every 250ms while the modal waits for
  // first frames. Enables Confirm once the preview is measurable; cancels
  // back to idle with an actionable error on timeout. Stops itself when
  // the modal closes so it can never cancel an active recording.
  function srPollPreviewReady() {
    if (!srRegionOpen) {
      srStopPreviewPoll();
      return;
    }
    var video = srRegionVideo();
    var ready = false;
    try {
      // Intrinsic dimensions alone are insufficient: hidden/unlaid-out video
      // elements can report a frame while pointer coordinates have no usable
      // CSS rectangle. Do not enable Confirm until source pixels and the
      // actual on-screen preview geometry are measurable.
      ready = !!video && (video.videoWidth || 0) > 0 && (video.videoHeight || 0) > 0 &&
        (video.readyState || 0) >= 2 && !!srPreviewMetrics();
    } catch (err) {
      ready = false;
    }
    if (ready) {
      if (!srPreviewReady) {
        srPreviewReady = true;
        srStopPreviewPoll();
        var confirm = srRegionConfirmBtn();
        if (confirm) confirm.disabled = false;
        var dims = srRegionDimsEl();
        if (dims) dims.textContent = 'Drag on the preview';
        srPaintRegionBox();
      }
      return;
    }
    if (Date.now() - srPreviewStartedAt > REGION_PREVIEW_TIMEOUT_MS) {
      srStopPreviewPoll();
      srCancelRegion('The live preview never became ready. The shared source may have stalled — press Record to try again.');
    }
  }

  function srPreviewMetrics() {
    var video = srRegionVideo();
    if (!video) return null;
    var rect = null;
    try {
      rect = video.getBoundingClientRect();
    } catch (err) {
      return null;
    }
    var frameW = video.videoWidth || 0;
    var frameH = video.videoHeight || 0;
    if (!rect || !(rect.width > 0) || !(rect.height > 0) || !(frameW > 0) || !(frameH > 0)) return null;
    return { cssW: rect.width, cssH: rect.height, frameW: frameW, frameH: frameH, left: rect.left, top: rect.top };
  }

  function srPaintRegionBox() {
    var boxEl = srRegionBoxEl();
    var dimsEl = srRegionDimsEl();
    var metrics = srPreviewMetrics();
    if (!boxEl) return;
    if (!srRegionCss || !metrics) {
      boxEl.style.display = 'none';
      // When the preview itself is not measurable yet, leave the
      // 'Waiting for preview…' notice set at open untouched.
      if (dimsEl && metrics) dimsEl.textContent = 'Drag on the preview';
      return;
    }
    var fixed = normalizeDragRect(srRegionCss);
    if (!fixed) {
      boxEl.style.display = 'none';
      return;
    }
    boxEl.style.display = 'block';
    // Position relative to the stage: the video fills the stage width and
    // the stage wraps the video, so stage and video boxes coincide; measure
    // both to stay exact under any stylesheet.
    var stage = srRegionStage();
    var stageRect = null;
    try {
      stageRect = stage ? stage.getBoundingClientRect() : null;
    } catch (err) {
      stageRect = null;
    }
    var dx = stageRect ? (metrics.left - stageRect.left) : 0;
    var dy = stageRect ? (metrics.top - stageRect.top) : 0;
    boxEl.style.left = (dx + fixed.x) + 'px';
    boxEl.style.top = (dy + fixed.y) + 'px';
    boxEl.style.width = Math.max(0, fixed.w) + 'px';
    boxEl.style.height = Math.max(0, fixed.h) + 'px';
    if (dimsEl) {
      var mapped = mapPreviewRectToSource(fixed, metrics.cssW, metrics.cssH, metrics.frameW, metrics.frameH);
      var clamped = mapped ? clampRegionPixels(mapped, metrics.frameW, metrics.frameH) : null;
      dimsEl.textContent = clamped
        ? ('Region ' + clamped.w + 'x' + clamped.h)
        : 'Drag a larger region';
    }
  }

  function srRegionPointFromEvent(e) {
    var metrics = srPreviewMetrics();
    if (!metrics || !e) return null;
    var cx = (typeof e.clientX === 'number') ? e.clientX : null;
    var cy = (typeof e.clientY === 'number') ? e.clientY : null;
    if (cx === null || cy === null) return null;
    return {
      x: Math.max(0, Math.min(metrics.cssW, cx - metrics.left)),
      y: Math.max(0, Math.min(metrics.cssH, cy - metrics.top))
    };
  }

  function srWireRegionDrag() {
    var stage = srRegionStage();
    if (!stage || stage.getAttribute('data-sr-drag') === '1') return;
    try {
      stage.setAttribute('data-sr-drag', '1');
    } catch (err) {}
    stage.addEventListener('pointerdown', function (e) {
      if (srSession.status !== 'idle' || !srRegionOpen) return;
      if (e && e.pointerType === 'mouse' && typeof e.button === 'number' && e.button !== 0) return;
      var anchor = srRegionPointFromEvent(e);
      if (!anchor) return;
      if (e && e.preventDefault) {
        try { e.preventDefault(); } catch (err) {}
      }
      srRegionCss = { x: anchor.x, y: anchor.y, w: 0, h: 0 };
      srPaintRegionBox();
      startDrag(e, function (ev) {
        var current = srRegionPointFromEvent(ev);
        if (!current) return;
        srRegionCss = { x: anchor.x, y: anchor.y, w: current.x - anchor.x, h: current.y - anchor.y };
        srPaintRegionBox();
      }, function () {
        srPaintRegionBox();
      });
    });
  }

  async function srOpenRegionModal() {
    var modal = srRegionModal();
    var video = srRegionVideo();
    if (!modal || !video || !srStream) throw new Error('Region selection is unavailable.');
    srRegionCss = null;
    srRegionBox = null;
    srSetRegionError('');
    video.muted = true;
    try {
      video.style.aspectRatio = '';
    } catch (err) {}
    var applyAspect = function () {
      try {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          video.style.aspectRatio = video.videoWidth + ' / ' + video.videoHeight;
        }
      } catch (err) {}
      srPaintRegionBox();
    };
    try {
      video.addEventListener('loadedmetadata', applyAspect, { once: true });
    } catch (err) {
      try {
        video.addEventListener('loadedmetadata', applyAspect);
      } catch (e2) {}
    }
    try {
      video.srcObject = srStream;
    } catch (err) {
      video.srcObject = null;
      throw err;
    }
    // Show the preview before starting playback. Some browsers defer the
    // first frame while a video sits inside a display:none modal; silently
    // swallowing play() rejection left users with a blank selector until
    // timeout. Await playback so startup failures reach the visible status.
    modal.style.display = 'flex';
    srRegionOpen = true;
    try {
      var played = video.play();
      if (played && typeof played.then === 'function') await played;
    } catch (err) {
      throw new Error('The live screen preview could not start. Close other screen-capture sessions, press Record again, and allow screen sharing. ' +
        ((err && err.name) ? '(' + err.name + ')' : ''));
    }
    srWireRegionDrag();
    srRegionKeyHandler = function (ev) {
      if (ev && ev.key === 'Escape' && srRegionOpen) {
        try {
          if (ev.preventDefault) ev.preventDefault();
        } catch (err) {}
        srCancelRegion();
      }
    };
    try {
      document.addEventListener('keydown', srRegionKeyHandler);
    } catch (err) {}
    // Preview readiness gate: Confirm stays disabled until the preview
    // reports usable dimensions and frames. Recalculate after layout and
    // metadata settle; time out loudly instead of stranding a dead modal.
    var confirmBtn = srRegionConfirmBtn();
    if (confirmBtn) confirmBtn.disabled = true;
    var dimsEl = srRegionDimsEl();
    if (dimsEl) dimsEl.textContent = 'Waiting for preview…';
    srPreviewReady = false;
    srPreviewStartedAt = Date.now();
    srStopPreviewPoll();
    try {
      srPreviewTimer = setInterval(srPollPreviewReady, 250);
    } catch (err) {
      srPreviewTimer = 0;
    }
    srRegionResizeHandler = function () {
      if (srRegionOpen) srPaintRegionBox();
    };
    try {
      window.addEventListener('resize', srRegionResizeHandler);
    } catch (err) {}
    applyAspect();
    srPaintRegionBox();
    srPollPreviewReady();
  }

  function srCloseRegionModal() {
    var modal = srRegionModal();
    var video = srRegionVideo();
    srStopPreviewPoll();
    if (srRegionResizeHandler) {
      try {
        window.removeEventListener('resize', srRegionResizeHandler);
      } catch (err) {}
      srRegionResizeHandler = null;
    }
    if (srRegionKeyHandler) {
      try {
        document.removeEventListener('keydown', srRegionKeyHandler);
      } catch (err) {}
      srRegionKeyHandler = null;
    }
    if (video) {
      try { video.pause(); } catch (err) {}
      try { video.srcObject = null; } catch (err) {}
      try { video.removeAttribute('src'); } catch (err) {}
    }
    // Keep the box for an in-progress recording (hidden with the modal);
    // selection state resets on cancel/finalize paths.
    var boxEl = srRegionBoxEl();
    if (boxEl) boxEl.style.display = 'none';
    if (modal) modal.style.display = 'none';
    srRegionOpen = false;
  }

  // Cancel region selection: back to idle with every track stopped and no
  // recording. Idempotent; safe from Esc, Cancel, and source termination.
  function srCancelRegion(note) {
    srCancelCountdown();
    srCloseRegionModal();
    srCloseFloatingControls();
    srReleaseCapture();
    srSession = createRecorderSession();
    srMimeType = '';
    srPaintTimer();
    srSyncButtons();
    srSetStatus('Idle', false);
    if (note) setStatus(note, true);
  }

  // One crop frame: draw the clamped source box onto the region canvas.
  // A skipped frame (source not ready yet) is transient and ignored. A
  // THROWING draw is different: sustained bursts mean the crop pipeline is
  // really broken, so after REGION_DRAW_FAIL_LIMIT consecutive failures the
  // recording stops with an error instead of capturing black frames.
  function srPauseStudioCanvas() { return $('srPauseStudioCanvas'); }
  function srPauseStudioModal() { return $('srPauseStudioModal'); }

  function srPauseStudioPoint(event) {
    var canvas = srPauseStudioCanvas();
    if (!canvas) return null;
    var rect = canvas.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height))
    };
  }

  function srPauseOverlayAt(point) {
    for (var i = srPauseOverlays.length - 1; i >= 0; i -= 1) {
      var item = srPauseOverlays[i];
      if (point.x >= item.x && point.x <= item.x + item.w && point.y >= item.y && point.y <= item.y + item.h) return i;
    }
    return -1;
  }

  // Apply overlays to the already-painted frame. Blur uses a separate scratch
  // canvas to avoid feeding a canvas back into itself while filtering.
  function srApplyPauseOverlays(ctx, targetCanvas, overlays) {
    if (!ctx || !targetCanvas || !Array.isArray(overlays)) return;
    // Apply blur first, then draw crisp text/images on top so edits remain readable.
    overlays.forEach(function (item) {
      if (item.type !== 'blur') return;
      var x = Math.max(0, Math.min(targetCanvas.width - 1, Math.round(item.x)));
      var y = Math.max(0, Math.min(targetCanvas.height - 1, Math.round(item.y)));
      var w = Math.min(targetCanvas.width - x, Math.round(item.w));
      var h = Math.min(targetCanvas.height - y, Math.round(item.h));
      if (w < 2 || h < 2) return;
      if (!srPauseBlurCanvas) srPauseBlurCanvas = document.createElement('canvas');
      srPauseBlurCanvas.width = w; srPauseBlurCanvas.height = h;
      var scratch = srPauseBlurCanvas.getContext('2d');
      if (!scratch) return;
      scratch.clearRect(0, 0, w, h);
      scratch.drawImage(targetCanvas, x, y, w, h, 0, 0, w, h);
      ctx.save();
      ctx.filter = 'blur(' + Math.max(4, Math.min(14, Math.round(Math.min(w, h) * 0.08))) + 'px)';
      ctx.drawImage(srPauseBlurCanvas, x - 2, y - 2, w + 4, h + 4);
      ctx.restore();
    });
    overlays.forEach(function (item, index) {
      if (item.type === 'text' && item.text) {
        ctx.save();
        ctx.font = 'bold ' + Math.max(18, Math.round(item.h * 0.72)) + 'px Arial, sans-serif';
        ctx.textBaseline = 'top';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.lineWidth = Math.max(3, Math.round(item.h * 0.12));
        ctx.fillStyle = item.color || '#ffffff';
        ctx.strokeText(item.text, item.x, item.y);
        ctx.fillText(item.text, item.x, item.y);
        ctx.restore();
      } else if (item.type === 'image' && item.image && (item.image.complete || item.image.naturalWidth > 0)) {
        try { ctx.drawImage(item.image, item.x, item.y, item.w, item.h); } catch (err) {}
      }
      if (srPauseStudioOpen && index === srPauseStudioSelected) {
        ctx.save();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = Math.max(2, targetCanvas.width / 700);
        ctx.setLineDash([8, 5]);
        ctx.strokeRect(item.x, item.y, item.w, item.h);
        ctx.restore();
      }
    });
  }

  function srRenderPauseStudio() {
    var canvas = srPauseStudioCanvas();
    var modal = srPauseStudioModal();
    if (!canvas || !modal || !srPauseStudioOpen || !srPauseStudioSnapshot) return;
    if (canvas.width !== srPauseStudioSnapshot.width || canvas.height !== srPauseStudioSnapshot.height) {
      canvas.width = srPauseStudioSnapshot.width;
      canvas.height = srPauseStudioSnapshot.height;
    }
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(srPauseStudioSnapshot, 0, 0, canvas.width, canvas.height);
    srApplyPauseOverlays(ctx, canvas, srPauseOverlays);
    if (srPauseStudioDraft) {
      ctx.save();
      ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = Math.max(2, canvas.width / 700);
      ctx.setLineDash([8, 5]);
      ctx.strokeRect(srPauseStudioDraft.x, srPauseStudioDraft.y, srPauseStudioDraft.w, srPauseStudioDraft.h);
      ctx.restore();
    }
    var mode = $('srPauseStudioMode');
    var remove = $('srPauseStudioRemove');
    var resume = $('srPauseStudioResume');
    if (mode) mode.textContent = srPauseStudioMode === 'blur' ? 'Blur mode: drag a rectangle' : 'Select mode: drag an overlay to move it';
    if (remove) remove.disabled = srPauseStudioSelected < 0 || srPauseStudioSelected >= srPauseOverlays.length;
    if (resume) resume.disabled = false;
  }

  function srOpenPauseStudio() {
    var modal = srPauseStudioModal();
    if (!modal || !srRegionCanvas) return;
    try {
      srPauseStudioSnapshot = document.createElement('canvas');
      srPauseStudioSnapshot.width = srRegionCanvas.width;
      srPauseStudioSnapshot.height = srRegionCanvas.height;
      var snapshotCtx = srPauseStudioSnapshot.getContext('2d');
      if (!snapshotCtx) throw new Error('Canvas preview is unavailable.');
      snapshotCtx.drawImage(srRegionCanvas, 0, 0);
    } catch (err) {
      srPauseStudioSnapshot = null;
      srSetError('Paused editor preview could not be opened. You can still resume recording.');
      return;
    }
    srPauseStudioOpen = true;
    srPauseStudioMode = 'select';
    srPauseStudioDrag = null;
    srPauseStudioDraft = null;
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    srRenderPauseStudio();
  }

  function srClosePauseStudio() {
    var modal = srPauseStudioModal();
    if (modal) { modal.style.display = 'none'; modal.setAttribute('aria-hidden', 'true'); }
    srPauseStudioOpen = false;
    srPauseStudioDrag = null;
    srPauseStudioDraft = null;
  }

  function srAddPauseText() {
    var input = $('srPauseStudioText');
    var text = input && input.value ? input.value.trim() : '';
    if (!text) { srSetError('Enter text before adding it to the paused recording.'); return; }
    var canvas = srPauseStudioCanvas();
    if (!canvas) return;
    var height = Math.max(28, Math.round(canvas.height * 0.07));
    srPauseOverlays.push({
      type: 'text', text: text.slice(0, 240),
      x: Math.round(canvas.width * 0.08), y: Math.round(canvas.height * 0.12),
      w: Math.min(canvas.width * 0.8, Math.max(80, text.length * height * 0.62)),
      h: height, color: '#ffffff'
    });
    srPauseStudioSelected = srPauseOverlays.length - 1;
    if (input) input.value = '';
    srSetError('');
    srRenderPauseStudio();
  }

  async function srAddPauseImage(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type || '')) {
      srSetError('Choose a PNG, JPG, WEBP or GIF image.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) { srSetError('Pause Studio images must be 5 MB or smaller.'); return; }
    try {
      var url = await new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || '')); };
        reader.onerror = function () { reject(new Error('Could not read that image.')); };
        reader.readAsDataURL(file);
      });
      var image = new Image();
      await new Promise(function (resolve, reject) {
        image.onload = resolve;
        image.onerror = function () { reject(new Error('Could not decode that image.')); };
        image.src = url;
      });
      var canvas = srPauseStudioCanvas();
      var w = Math.min(canvas.width * 0.28, image.naturalWidth || image.width || 240);
      var h = w * (image.naturalHeight || image.height || 1) / Math.max(1, image.naturalWidth || image.width || 1);
      if (h > canvas.height * 0.55) { w *= canvas.height * 0.55 / h; h = canvas.height * 0.55; }
      srPauseOverlays.push({ type: 'image', image: image, x: Math.round(canvas.width * 0.66), y: Math.round(canvas.height * 0.12), w: Math.round(w), h: Math.round(h) });
      srPauseStudioSelected = srPauseOverlays.length - 1;
      srSetError('');
      srRenderPauseStudio();
    } catch (err) {
      srSetError((err && err.message) || 'Could not add that image.');
    }
  }

  function srWirePauseStudio() {
    var textBtn = $('srPauseStudioAddText');
    if (textBtn) textBtn.addEventListener('click', srAddPauseText);
    var imageInput = $('srPauseStudioImage');
    if (imageInput) imageInput.addEventListener('change', function () {
      var file = imageInput.files && imageInput.files[0];
      srAddPauseImage(file);
      imageInput.value = '';
    });
    var blurBtn = $('srPauseStudioBlur');
    if (blurBtn) blurBtn.addEventListener('click', function () {
      srPauseStudioMode = srPauseStudioMode === 'blur' ? 'select' : 'blur';
      srPauseStudioSelected = -1;
      srRenderPauseStudio();
    });
    var selectBtn = $('srPauseStudioSelect');
    if (selectBtn) selectBtn.addEventListener('click', function () {
      srPauseStudioMode = 'select';
      srPauseStudioSelected = -1;
      srRenderPauseStudio();
    });
    var removeBtn = $('srPauseStudioRemove');
    if (removeBtn) removeBtn.addEventListener('click', function () {
      if (srPauseStudioSelected < 0 || srPauseStudioSelected >= srPauseOverlays.length) return;
      srPauseOverlays.splice(srPauseStudioSelected, 1);
      srPauseStudioSelected = -1;
      srRenderPauseStudio();
    });
    var clearBtn = $('srPauseStudioClear');
    if (clearBtn) clearBtn.addEventListener('click', function () {
      srPauseOverlays = [];
      srPauseStudioSelected = -1;
      srPauseStudioDraft = null;
      srRenderPauseStudio();
      srSetError('All pause edits cleared. They will no longer appear after resume.');
    });
    var resumeBtn = $('srPauseStudioResume');
    if (resumeBtn) resumeBtn.addEventListener('click', srResumeRecording);
    var canvas = srPauseStudioCanvas();
    if (!canvas) return;
    canvas.addEventListener('pointerdown', function (event) {
      if (!srPauseStudioOpen) return;
      var point = srPauseStudioPoint(event);
      if (!point) return;
      if (srPauseStudioMode === 'blur') {
        srPauseStudioDrag = { kind: 'blur', start: point };
        srPauseStudioDraft = { x: point.x, y: point.y, w: 0, h: 0 };
      } else {
        var hit = srPauseOverlayAt(point);
        srPauseStudioSelected = hit;
        if (hit >= 0) {
          var item = srPauseOverlays[hit];
          srPauseStudioDrag = { kind: 'move', index: hit, start: point, x: item.x, y: item.y };
        } else {
          srPauseStudioDrag = null;
        }
      }
      try { canvas.setPointerCapture(event.pointerId); } catch (err) {}
      srRenderPauseStudio();
    });
    canvas.addEventListener('pointermove', function (event) {
      if (!srPauseStudioOpen || !srPauseStudioDrag) return;
      var point = srPauseStudioPoint(event);
      if (!point) return;
      var drag = srPauseStudioDrag;
      if (drag.kind === 'blur') {
        srPauseStudioDraft = {
          x: Math.min(drag.start.x, point.x), y: Math.min(drag.start.y, point.y),
          w: Math.abs(point.x - drag.start.x), h: Math.abs(point.y - drag.start.y)
        };
      } else {
        var item = srPauseOverlays[drag.index];
        if (item) {
          item.x = Math.max(0, Math.min(canvas.width - item.w, drag.x + point.x - drag.start.x));
          item.y = Math.max(0, Math.min(canvas.height - item.h, drag.y + point.y - drag.start.y));
        }
      }
      srRenderPauseStudio();
    });
    function finishDrag() {
      if (!srPauseStudioDrag) return;
      if (srPauseStudioDrag.kind === 'blur' && srPauseStudioDraft && srPauseStudioDraft.w >= 8 && srPauseStudioDraft.h >= 8) {
        srPauseOverlays.push({ type: 'blur', x: srPauseStudioDraft.x, y: srPauseStudioDraft.y, w: srPauseStudioDraft.w, h: srPauseStudioDraft.h });
        srPauseStudioSelected = srPauseOverlays.length - 1;
      }
      srPauseStudioDrag = null;
      srPauseStudioDraft = null;
      srRenderPauseStudio();
    }
    canvas.addEventListener('pointerup', finishDrag);
    canvas.addEventListener('pointercancel', finishDrag);
  }

  function srDrawRegionFrame() {
    var video = srRegionVideo();
    if (video && srRegionCanvas && srRegionBox) {
      var painted = false;
      try {
        if (video.readyState >= 2) {
          var ctx = srRegionCanvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(
              video,
              srRegionBox.x, srRegionBox.y, srRegionBox.w, srRegionBox.h,
              0, 0, srRegionCanvas.width, srRegionCanvas.height
            );
            painted = true;
            // Pause Studio overlays are composited into the captured output, never
            // into the browser UI. They persist across Resume until removed.
            srApplyPauseOverlays(ctx, srRegionCanvas, srPauseOverlays);
            // Optional webcam picture-in-picture is composited into the output.
            if (srCameraEnabled && srCameraVideo && srCameraVideo.readyState >= 2 &&
                srCameraVideo.videoWidth > 0 && srCameraVideo.videoHeight > 0) {
              var margin = Math.max(8, Math.round(srRegionCanvas.width * 0.018));
              var pipW = Math.round(srRegionCanvas.width * 0.24);
              var pipH = Math.min(Math.round(pipW * srCameraVideo.videoHeight / srCameraVideo.videoWidth), Math.round(srRegionCanvas.height * 0.34));
              pipW = Math.round(pipH * srCameraVideo.videoWidth / srCameraVideo.videoHeight);
              var pipX = srRegionCanvas.width - pipW - margin;
              var pipY = srRegionCanvas.height - pipH - margin;
              ctx.save(); ctx.fillStyle = 'rgba(15,23,42,0.9)';
              ctx.fillRect(pipX - 3, pipY - 3, pipW + 6, pipH + 6);
              ctx.drawImage(srCameraVideo, pipX, pipY, pipW, pipH); ctx.restore();
            }
          }
        }
      } catch (err) {
        painted = false;
        srDrawFailures += 1;
      }
      if (painted) {
        srDrawFailures = 0;
      } else if (video.readyState >= 2 && srDrawFailures >= REGION_DRAW_FAIL_LIMIT) {
        srDrawFailures = 0;
        srSetError('Region capture failed repeatedly — stopping the recording.');
        srStopRecording();
      }
    }
  }

  function srStopRegionPump() {
    if (srRafId) {
      try {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(srRafId);
      } catch (err) {}
      srRafId = 0;
    }
    if (srPumpTimer) {
      try { clearInterval(srPumpTimer); } catch (err) {}
      srPumpTimer = 0;
    }
    if (srVisibilityHandler) {
      try { document.removeEventListener('visibilitychange', srVisibilityHandler); } catch (err) {}
      srVisibilityHandler = null;
    }
  }

  // Do not depend exclusively on requestAnimationFrame for screen capture:
  // browsers suspend/throttle animation frames when this editor tab is in
  // the background. A timer keeps refreshing the crop canvas while the user
  // switches to other desktop applications. Browsers may still throttle
  // background timers, so this improves continuity but cannot promise a
  // fixed FPS in every browser.
  function srPumpRegionFrame() {
    if (srSession.status !== 'recording') return;
    srDrawRegionFrame();
  }

  function srStartRegionPump() {
    srStopRegionPump();
    srDrawRegionFrame();
    if (srSession.status !== 'recording') return;
    var intervalMs = Math.max(33, Math.floor(1000 / REGION_CAPTURE_FPS));
    try {
      srPumpTimer = setInterval(srPumpRegionFrame, intervalMs);
    } catch (err) {
      srPumpTimer = 0;
    }
    // Refresh immediately when returning to the editor tab, without waiting
    // for the next interval tick. The timer itself continues during hiding.
    srVisibilityHandler = function () {
      if (srSession.status === 'recording') srDrawRegionFrame();
    };
    try { document.addEventListener('visibilitychange', srVisibilityHandler); } catch (err) {}
  }

  // Confirm the dragged region and start recording it. Validates the drag
  // against live preview metrics, clamps to recordable source pixels, and
  // fails loudly (staying in the modal) when the region is unusable —
  // never a silent fullscreen recording. A missing canvas capture API
  // fails the same loud way.
  // Five-second countdown mirrors the Snipping Tool workflow. Resolving false
  // on cancel/source-end prevents a delayed recording from starting later.
  function srCancelCountdown() {
    if (srCountdownTimer) {
      try { clearInterval(srCountdownTimer); } catch (err) {}
      srCountdownTimer = 0;
    }
    var resolve = srCountdownResolve;
    srCountdownResolve = null;
    var number = $('srCountdownNumber');
    if (number) number.style.display = 'none';
    if (resolve) resolve(false);
  }

  function srWaitForCountdown() {
    return new Promise(function (resolve) {
      var delayInput = $('srCountdownSeconds');
      var requestedDelay = delayInput ? Number.parseInt(delayInput.value, 10) : 5;
      if (!Number.isFinite(requestedDelay)) requestedDelay = 5;
      var remaining = Math.max(1, Math.min(60, requestedDelay));
      var dims = srRegionDimsEl();
      var confirm = srRegionConfirmBtn();
      var number = $('srCountdownNumber');
      if (confirm) confirm.disabled = true;
      if (dims) dims.textContent = 'Recording starts in ' + remaining + '…';
      if (number) {
        number.textContent = String(remaining);
        number.style.display = 'flex';
      }
      srCountdownResolve = resolve;
      srCountdownTimer = setInterval(function () {
        if (!srRegionOpen) {
          srCancelCountdown();
          return;
        }
        remaining -= 1;
        if (remaining <= 0) {
          if (srCountdownTimer) clearInterval(srCountdownTimer);
          srCountdownTimer = 0;
          srCountdownResolve = null;
          if (dims) dims.textContent = 'Starting recording…';
          if (number) {
            number.textContent = 'GO';
            setTimeout(function () { if (number) number.style.display = 'none'; }, 450);
          }
          resolve(true);
          return;
        }
        if (dims) dims.textContent = 'Recording starts in ' + remaining + '…';
        if (number) number.textContent = String(remaining);
      }, 1000);
    });
  }

  async function srConfirmRegion() {
    if (!srRegionOpen) return;
    if (srConfirming) return;
    srConfirming = true;
    try {
      srSetRegionError('');
      // Readiness gate: the bounded poll enables Confirm once the preview
      // is measurable, but a stale click must still be rejected here.
      if (!srPreviewReady) {
        srSetRegionError('The live preview is not ready yet — wait a moment and try again.');
        return;
      }
      var metrics = srPreviewMetrics();
      if (!metrics) {
        srSetRegionError('The live preview is not ready yet — wait a moment and try again.');
        return;
      }
      if (!srRegionCss) {
        srSetRegionError('Drag a rectangle on the preview first.');
        return;
      }
      var mapped = mapPreviewRectToSource(srRegionCss, metrics.cssW, metrics.cssH, metrics.frameW, metrics.frameH);
      var box = mapped ? clampRegionPixels(mapped, metrics.frameW, metrics.frameH) : null;
      if (!box) {
        srSetRegionError('That region is too small or outside the frame — drag a larger area (min ' + REGION_MIN_PX + 'px).');
        return;
      }
      var track = srStream && srStream.getVideoTracks ? srStream.getVideoTracks()[0] : null;
      if (!track || track.readyState === 'ended' || !srStream) {
        srCancelRegion('The shared source ended before recording started.');
        return;
      }
      srOpenFloatingControls();
      var countdownComplete = await srWaitForCountdown();
      if (!countdownComplete || !srRegionOpen || !srStream) return;
      var resEntry = normalizeRecorderResolution(srResolutionId);
      if (resEntry.width && resEntry.height && typeof track.applyConstraints === 'function') {
        try {
          await track.applyConstraints(recorderVideoConstraints(resEntry.id));
        } catch (err) {
          // Best effort only: keep the native provision when the browser
          // or source rejects the preference.
        }
      }
      var canvas = null;
      try {
        canvas = document.createElement('canvas');
      } catch (err) {
        canvas = null;
      }
      if (!canvas || typeof canvas.getContext !== 'function' || typeof canvas.captureStream !== 'function') {
        srFail('Region recording needs canvas capture, which this browser does not support.');
        return;
      }
      // Very large desktop regions (for example 3192x1756) can overload
      // the browser's canvas/encoder pipeline and produce dropped or torn
      // frames. Keep the exact selected crop/aspect ratio, but cap the output
      // raster to 1920x1080 for a stable, YouTube-friendly recording.
      var outputScale = Math.min(1, 1920 / box.w, 1080 / box.h);
      canvas.width = Math.max(1, Math.round(box.w * outputScale));
      canvas.height = Math.max(1, Math.round(box.h * outputScale));
      var outStream = null;
      try {
        outStream = canvas.captureStream(REGION_CAPTURE_FPS);
      } catch (err) {
        outStream = null;
      }
      if (!outStream) {
        srFail('Region recording needs canvas capture, which this browser does not support.');
        return;
      }
      // Add a stable mixed system-audio track; microphone starts off.
      await srSetupAudioMixer(outStream);
      var mime = null;
      try {
        mime = pickRecorderMimeType(function (candidate) {
          try {
            return window.MediaRecorder.isTypeSupported(candidate);
          } catch (err) {
            return false;
          }
        });
      } catch (err) {
        mime = null;
      }
      if (!mime) {
        srStopStreamTracks(outStream);
        srFail('This browser cannot record screen video (no supported format).');
        return;
      }
      // Final liveness check before constructing exactly one recorder.
      if (track.readyState === 'ended' || !srStream) {
        srStopStreamTracks(outStream);
        srFail('The shared source ended before recording started.');
        return;
      }
      var rec = null;
      try {
        rec = new window.MediaRecorder(outStream, { mimeType: mime });
      } catch (err) {
        srStopStreamTracks(outStream);
        srFail(classifyCaptureError(err));
        return;
      }
      srRegionCanvas = canvas;
      srRegionBox = box;
      srOutStream = outStream;
      srChunks = [];
      srMimeType = mime;
      srRecorder = rec;
      srStopping = false;
      srFinalized = false;
      srProcessingRecording = false;
      srRecorderFailureStatus = '';
      srPendingFile = null;
      srDrawFailures = 0;
      rec.ondataavailable = function (e) {
        // Ignore delayed browser events after the single finalization path has
        // consumed the chunk list. In particular, do not let a late event
        // append into a fresh session after the Stop watchdog has recovered.
        if (!srFinalized && e && e.data && e.data.size > 0) srChunks.push(e.data);
      };
      rec.onerror = function () {
        var status = srSession.status;
        if ((status === 'recording' || status === 'paused') && !srFinalized) srStopRecording();
      };
      // Completion path: MediaRecorder.stop() delivers the final
      // dataavailable event(s) and then fires onstop. Without this handler
      // Stop would strand the session with capture tracks still live.
      rec.onstop = function () {
        // Some browser/driver combinations dispatch "stop" before the last
        // dataavailable callback has run. Defer the snapshot briefly so any
        // queued final chunk can still be collected by the existing handler.
        if (srStopFinalizeTimer) {
          try { clearTimeout(srStopFinalizeTimer); } catch (err) {}
          srStopFinalizeTimer = 0;
        }
        srStopFinalizeTimer = setTimeout(function () {
          srStopFinalizeTimer = 0;
          if (!srFinalized) srFinalizeRecording();
        }, 300);
      };
      try {
        rec.start(1000);
      } catch (err) {
        srFail(classifyCaptureError(err));
        return;
      }
      try {
        startRecorderSession(srSession, Date.now());
      } catch (err) {
        try { rec.stop(); } catch (e2) {}
        srFail('Could not start the screen recorder.');
        return;
      }
      var hasSystemAudio = false;
      try {
        hasSystemAudio = srStream.getAudioTracks && srStream.getAudioTracks().length > 0;
      } catch (err) {
        hasSystemAudio = false;
      }
      var modal = srRegionModal();
      if (modal) modal.style.display = 'none';
      srRegionOpen = false;
      // Recording runs headless from here: the preview video keeps playing
      // as the crop source, but Esc must no longer cancel the session.
      srStopPreviewPoll();
      if (srRegionKeyHandler) {
        try {
          document.removeEventListener('keydown', srRegionKeyHandler);
        } catch (err) {}
        srRegionKeyHandler = null;
      }
      var statusText = 'Recording region ' + formatCaptureDimensions(box.w, box.h) +
        (hasSystemAudio ? '…' : ' (system audio not shared; mic is off until enabled)…');
      srSetStatus(statusText, true);
      srPaintTimer();
      srSyncButtons();
      srTimerId = setInterval(srPaintTimer, 250);
      srStartRegionPump();
    } finally {
      srConfirming = false;
      srSyncButtons();
    }
  }

  function srWireControls() {
    srWirePauseStudio();
    var record = srRecordBtn();
    var pause = srPauseBtn();
    var resume = srResumeBtn();
    var stop = srStopBtn();
    var resolution = srResolutionSel();
    if (!isRecorderSupported(window)) {
      if (record) {
        record.disabled = true;
        try { record.title = 'Screen recording needs a recent desktop browser over HTTPS.'; } catch (err) {}
      }
      srSetStatus('Not supported in this browser', false);
      return;
    }
    if (resolution) {
      try { resolution.value = normalizeRecorderResolution(srResolutionId).id; } catch (err) {}
      resolution.addEventListener('change', function () {
        srResolutionId = normalizeRecorderResolution(resolution.value).id;
        try { resolution.value = srResolutionId; } catch (err) {}
      });
    }
    if (record) {
      record.addEventListener('click', function () {
        try {
          var started = srStartRecording();
          if (started && typeof started.catch === 'function') {
            started.catch(function (err) {
              srFail(classifyCaptureError(err));
            });
          }
        } catch (err) {
          srFail(classifyCaptureError(err));
        }
      });
    }
    if (pause) {
      pause.addEventListener('click', function () {
        srPauseRecording();
      });
    }
    if (resume) {
      resume.addEventListener('click', function () {
        srResumeRecording();
      });
    }
    if (stop) {
      stop.addEventListener('click', function () {
        srStopRecording();
      });
    }
    var floatingPause = $('srFloatingPause');
    var floatingResume = $('srFloatingResume');
    var floatingStop = $('srFloatingStop');
    var floatingAbort = $('srFloatingAbort');
    var floatingSave = $('srFloatingSave');
    var floatingMic = $('srFloatingMic');
    var floatingCamera = $('srFloatingCamera');
    if (floatingPause) floatingPause.addEventListener('click', srPauseRecording);
    if (floatingResume) floatingResume.addEventListener('click', srResumeRecording);
    if (floatingStop) floatingStop.addEventListener('click', srStopRecording);
    if (floatingAbort) floatingAbort.addEventListener('click', srAbortRecording);
    if (floatingMic) floatingMic.addEventListener('click', srToggleMicrophone);
    if (floatingCamera) floatingCamera.addEventListener('click', srToggleCamera);
    if (floatingSave) floatingSave.addEventListener('click', function () {
      if (srPendingFile) srSavePendingRecording();
    });
    var regionConfirm = srRegionConfirmBtn();
    if (regionConfirm) {
      regionConfirm.addEventListener('click', function () {
        try {
          var confirmed = srConfirmRegion();
          if (confirmed && typeof confirmed.catch === 'function') {
            confirmed.catch(function (err) {
              srFail(classifyCaptureError(err));
            });
          }
        } catch (err) {
          srFail(classifyCaptureError(err));
        }
      });
    }
    var regionCancel = srRegionCancelBtn();
    if (regionCancel) {
      regionCancel.addEventListener('click', function () {
        srCancelRegion();
      });
    }
    var saveRecording = $('srRecordingCompleteSave');
    if (saveRecording) saveRecording.addEventListener('click', srSavePendingRecording);
    var addRecording = $('srRecordingCompleteAdd');
    if (addRecording) addRecording.addEventListener('click', srAddPendingRecordingToEditor);
    var discardRecording = $('srRecordingCompleteDiscard');
    if (discardRecording) discardRecording.addEventListener('click', srDiscardPendingRecording);
    srSyncButtons();
  }

  // ---- init ----
  // Editor page only: the recorder has its own page and wires itself in
  // initScreenRecorder below. Gated on the editor root being present.
  function initVideoEditor() {
    var root = document.querySelector('[data-testid="video-editor-root"]');
    if (!root) return;
    if (root.getAttribute('data-available') !== '1') return;
    var videoInput = $('videoFile');
    var voverlayInput = $('voverlaySourceFile');
    var audioInput = $('audioFile');
    var imageInput = $('imageFile');
    video = $('previewVideo');
    if (!videoInput || !video) return;
    project = createProject();
    var zoomSlider = $('veZoomSlider');
    var zoomOut = $('veZoomOut');
    var zoomIn = $('veZoomIn');
    var zoomFit = $('veZoomFit');
    if (zoomSlider) zoomSlider.addEventListener('input', function () { setTimelineZoom(zoomSlider.value); });
    if (zoomOut) zoomOut.addEventListener('click', function () { setTimelineZoom(pxPerSec - 20); });
    if (zoomIn) zoomIn.addEventListener('click', function () { setTimelineZoom(pxPerSec + 20); });
    if (zoomFit) zoomFit.addEventListener('click', function () {
      var scrollEl = $('veScroll');
      var duration = contentEnd(project);
      var available = scrollEl ? scrollEl.clientWidth : 600;
      setTimelineZoom(duration > 0 ? Math.max(20, Math.min(240, Math.floor((available - GUTTER_PX) / duration / 10) * 10)) : 60);
      if (scrollEl) scrollEl.scrollLeft = 0;
    });
    renderTimeline();
    renderInspector();
    renderOverlaySourcesList();

    var configuredMb = parseInt(root.getAttribute('data-max-video-mb'), 10);
    if (Number.isFinite(configuredMb) && configuredMb >= 1) {
      maxVideoMb = configuredMb;
      maxVideoBytes = configuredMb * 1048576;
    }

    videoInput.addEventListener('change', function () {
      addMediaFiles('video', videoInput.files).finally(function () {
        try { videoInput.value = ''; } catch (err) {}
      });
    });
    if (voverlayInput) {
      voverlayInput.addEventListener('change', function () {
        addOverlaySourceFiles(voverlayInput.files).finally(function () {
          try { voverlayInput.value = ''; } catch (err) {}
        });
      });
    }
    if (audioInput) {
      audioInput.addEventListener('change', function () {
        addMediaFiles('audio', audioInput.files).finally(function () {
          try { audioInput.value = ''; } catch (err) {}
        });
      });
    }
    if (imageInput) {
      imageInput.addEventListener('change', function () {
        setImageFiles(imageInput.files);
      });
    }
    // Native video events: the element is a preview slave of the master
    // timeline clock (tlTime). User seeks map back onto the timeline when
    // they land inside a known clip; anything else re-syncs to tlTime.
    // Native play joins the shared frame loop; native pause freezes it.
    video.addEventListener('play', function () {
      changingSourceProgrammatically = false;
      if (!project || !(contentEnd(project) > 0)) return;
      previewBlocked = false;
      audioBlocked = false;
      var b = $('vePlayBtn');
      if (b) b.textContent = '⏸ Pause';
      if (!timelinePlaying) {
        timelinePlaying = true;
        playBase = tlTime;
        playStamp = performance.now();
        startTickLoop();
      }
    });
    video.addEventListener('loadeddata', function () { renderPreview(); });
    video.addEventListener('timeupdate', function () { placePlayhead(); updateTimecode(); renderPreview(); });
    video.addEventListener('seeked', function () {
      if (!project) return;
      if (seekingProgrammatically) {
        seekingProgrammatically = false;
        return;
      }
      var mapped = timelineFromVideo();
      if (mapped !== null) {
        tlTime = mapped;
        killAudio();
        playBase = tlTime;
        playStamp = performance.now();
      } else {
        currentPreviewClipId = null;
        syncPreviewSource(true);
      }
      placePlayhead();
      updateTimecode();
      renderPreview();
    });
    video.addEventListener('pause', function () {
      if (changingSourceProgrammatically) {
        changingSourceProgrammatically = false;
        return;
      }
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      var b = $('vePlayBtn');
      if (b) b.textContent = '▶ Play';
      // A programmatic pause with no active clip (timeline gap) must not
      // stop the master clock — music keeps playing through gaps.
      if (timelinePlaying && activeVideoClipAt(project, tlTime)) {
        timelinePlaying = false;
        killAudio();
        placePlayhead();
        updateTimecode();
        renderPreview();
      }
    });
    video.addEventListener('playing', function () {
      changingSourceProgrammatically = false;
      previewBlocked = false;
      var b = $('vePlayBtn');
      if (b && timelinePlaying) b.textContent = '⏸ Pause';
    });

    // Scrub on ruler + empty lane space.
    ['veRuler', 'veLaneVideo', 'veLaneAudio', 'veLaneBlur', 'veLaneText', 'veLaneImage', 'veLaneVideoOverlay', 'veLaneZoom'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('pointerdown', onBackgroundDown);
    });

    var veScrollEl = $('veScroll');
    var trackEl = $('veHScrollbarTrack');
    var thumbEl = $('veHScrollbarThumb');

    if (veScrollEl) {
      veScrollEl.addEventListener('scroll', syncHScrollbar, { passive: true });
      window.addEventListener('resize', syncHScrollbar);
      // Workspace grid/flex sizing settles after the initial render. Observe both
      // the viewport and its content so the custom thumb is recalculated after
      // workspace entry, panel resizing, zooming, and browser resizes.
      if (typeof ResizeObserver !== 'undefined') {
        var timelineResizeObserver = new ResizeObserver(function () {
          window.requestAnimationFrame(syncHScrollbar);
        });
        timelineResizeObserver.observe(veScrollEl);
        var observedContent = $('veContent');
        if (observedContent) timelineResizeObserver.observe(observedContent);
        var observedTrack = $('veHScrollbarTrack');
        if (observedTrack) timelineResizeObserver.observe(observedTrack);
      }
      window.requestAnimationFrame(syncHScrollbar);
      veScrollEl.addEventListener('wheel', function (e) {
        if (e.deltaX !== 0) {
          // Native horizontal wheel/trackpad scrolling
          return;
        }
        if (e.shiftKey) {
          e.preventDefault();
          veScrollEl.scrollLeft += e.deltaY;
        } else {
          var hasH = veScrollEl.scrollWidth > veScrollEl.clientWidth;
          var hasV = veScrollEl.scrollHeight > veScrollEl.clientHeight;
          if (hasH && !hasV) {
            e.preventDefault();
            veScrollEl.scrollLeft += e.deltaY;
          }
        }
      }, { passive: false });
    }

    if (trackEl && thumbEl) {
      thumbEl.addEventListener('pointerdown', function (e) {
        if (!veScrollEl) return;
        var startScrollLeft = veScrollEl.scrollLeft;
        var startX = e.clientX;
        var scrollWidth = veScrollEl.scrollWidth || 1;
        var clientWidth = veScrollEl.clientWidth || 1;
        var maxScrollLeft = scrollWidth - clientWidth;
        var trackWidth = trackEl.clientWidth || 1;
        var thumbWidthPx = thumbEl.offsetWidth || 32;
        var maxThumbLeft = Math.max(1, trackWidth - thumbWidthPx);

        startDrag(e, function (ev) {
          var dx = ev.clientX - startX;
          var scrollDelta = maxThumbLeft > 0 ? (dx / maxThumbLeft) * maxScrollLeft : 0;
          veScrollEl.scrollLeft = Math.min(maxScrollLeft, Math.max(0, startScrollLeft + scrollDelta));
          syncHScrollbar();
        });
      });

      trackEl.addEventListener('pointerdown', function (e) {
        if (e.target === thumbEl || !veScrollEl) return;
        var trackRect = trackEl.getBoundingClientRect();
        var clickX = e.clientX - trackRect.left;
        var scrollWidth = veScrollEl.scrollWidth || 1;
        var clientWidth = veScrollEl.clientWidth || 1;
        var maxScrollLeft = scrollWidth - clientWidth;
        var trackWidth = trackRect.width || 1;
        var thumbWidthPx = thumbEl.offsetWidth || 32;
        var maxThumbLeft = Math.max(1, trackWidth - thumbWidthPx);

        var targetRatio = Math.min(1, Math.max(0, (clickX - thumbWidthPx / 2) / maxThumbLeft));
        veScrollEl.scrollLeft = targetRatio * maxScrollLeft;
        syncHScrollbar();
      });
    }
    // Note: only innerHTML of the lane bodies changes on re-render; the lane
    // containers persist, so these listeners survive.

    var playBtn = $('vePlayBtn');
    if (playBtn) playBtn.addEventListener('click', function () {
      if (!project || !(contentEnd(project) > 0)) { setStatus('Add a video clip first.', false); return; }
      setPlaying(!timelinePlaying);
    });

    var zin = $('veZoomIn');
    if (zin) zin.addEventListener('click', function () {
      pxPerSec = Math.min(MAX_PX_PER_SEC, pxPerSec * 1.4);
      layoutTimeline();
      renderTimeline();
    });
    var zout = $('veZoomOut');
    if (zout) zout.addEventListener('click', function () {
      pxPerSec = Math.max(MIN_PX_PER_SEC, pxPerSec / 1.4);
      layoutTimeline();
      renderTimeline();
    });

    var av = $('veAddVideo');
    if (av) av.addEventListener('click', function () { if (videoInput) videoInput.click(); });
    var aa = $('veAddAudio');
    if (aa) aa.addEventListener('click', function () { if (audioInput) audioInput.click(); });
    var sp = $('veSplit');
    if (sp) sp.addEventListener('click', splitAtPlayhead);
    var addChapterBtn = $('veAddChapter');
    if (addChapterBtn) addChapterBtn.addEventListener('click', addChapter);
    var copyChaptersBtn = $('veCopyChapters');
    if (copyChaptersBtn) copyChaptersBtn.addEventListener('click', copyChapterTimestamps);
    var deleteChapterBtn = $('veDeleteChapter');
    if (deleteChapterBtn) deleteChapterBtn.addEventListener('click', deleteLastChapter);
    var ab = $('veAddBlur');
    if (ab) ab.addEventListener('click', function () { addClipAtPlayhead('blur'); });
    var at = $('veAddText');
    if (at) at.addEventListener('click', function () { addClipAtPlayhead('text'); });
    var ai = $('veAddImage');
    if (ai) ai.addEventListener('click', function () { addClipAtPlayhead('image'); });
    var avo = $('veAddVideoOverlay');
    if (avo) avo.addEventListener('click', function () { addClipAtPlayhead('voverlay'); });
    var az = $('veAddZoom');
    if (az) az.addEventListener('click', function () { addClipAtPlayhead('zoom'); });
    var cropBtn = $('veCropBtn');
    if (cropBtn) {
      cropBtn.addEventListener('click', function () {
        if (!project) return;
        var selId = project.selectedId;
        var clip = selId ? findClipAny(selId) : null;
        var kind = selId ? (clipKindOf(selId) || (clip && clip.type)) : null;
        if (clip && (kind === 'video' || kind === 'voverlay' || kind === 'image' || clip.type === 'video' || clip.type === 'voverlay' || clip.type === 'image')) {
          toggleCropEditing(clip.id);
        } else {
          var activeMain = activeVideoClipAt(project, tlTime);
          if (activeMain) {
            project.selectedId = activeMain.id;
            toggleCropEditing(activeMain.id);
          } else {
            setStatus('Select a video, video overlay, or image clip first to crop.', false);
          }
        }
      });
    }
    var layer = $('overlayLayer');
    if (layer) {
      // Zoom region creation + center placement directly on the preview.
      // With a zoom clip selected, press-drag-release on empty preview draws
      // the zoom region (marquee -> level/center via the shared zoom helpers);
      // a plain click without dragging just repositions the target center.
      // The whole gesture owns dragKind so renderPreview cannot rebuild the
      // box mid-draw, and pointerup always exits (no synthetic re-dispatch).
      layer.addEventListener('pointerdown', function (e) {
        if (!project || !project.selectedId) return;
        var clip = getClip(project, project.selectedId);
        if (!clip || clip.type !== 'zoom') return;
        if (cropEditingClipId) return;
        if (e.target !== layer) return; // Only drags starting on the background canvas
        if (e.button !== undefined && e.button !== 0) return;

        if (e && e.stopPropagation) e.stopPropagation();
        if (e && e.preventDefault) e.preventDefault();
        var anchor = previewFrac(layer, e.clientX, e.clientY);
        var downX = e.clientX;
        var downY = e.clientY;
        var boxEl = layer.querySelector('[data-clip-id="' + clip.id + '"]');
        var drew = false;
        dragKind = 'preview';
        startDrag(e, function (ev) {
          var dxPx = (ev.clientX !== undefined && downX !== undefined) ? Math.abs(ev.clientX - downX) : 0;
          var dyPx = (ev.clientY !== undefined && downY !== undefined) ? Math.abs(ev.clientY - downY) : 0;
          if (!drew && Math.max(dxPx, dyPx) < 4) return; // still a click: wait for release
          drew = true;
          var cur = previewFrac(layer, ev.clientX, ev.clientY);
          var marquee = zoomDrawRect(anchor, cur);
          if (!marquee) return;
          var z = zoomFromPreviewRect(marquee);
          clip.level = z.level;
          clip.x = z.x;
          clip.y = z.y;
          if (boxEl && !boxEl.isConnected) boxEl = null;
          if (!boxEl) boxEl = layer.querySelector('[data-clip-id="' + clip.id + '"]');
          if (boxEl) syncBoxEl(boxEl, clip);
          var zLvl = document.querySelector('#veInspector [data-insp="zoomLevel"]');
          var zX = document.querySelector('#veInspector [data-insp="x"]');
          var zY = document.querySelector('#veInspector [data-insp="y"]');
          if (zLvl) zLvl.value = clip.level;
          if (zX) zX.value = Math.round(clip.x * 1000) / 10;
          if (zY) zY.value = Math.round(clip.y * 1000) / 10;
        }, function () {
          dragKind = null;
          if (!drew) {
            clip.x = Math.min(1, Math.max(0, anchor.x));
            clip.y = Math.min(1, Math.max(0, anchor.y));
          }
          renderPreview();
          renderInspector();
        });
      });
    }
    var dup = $('veDuplicate');
    if (dup) dup.addEventListener('click', duplicateSelected);
    var del = $('veDelete');
    if (del) del.addEventListener('click', deleteSelected);
    // Burned-in watermark controls: EVERY setting syncs project state + live
    // preview immediately. Text/size/color/opacity use `input` for live
    // feedback while typing/picking; toggle/position use `change`. A missing
    // listener here leaves that setting stale until another control moves.
    function onWatermarkSettingChanged() { syncWatermarkFromUI(); renderPreview(); }
    var wmBox = $('veWatermark');
    if (wmBox) wmBox.addEventListener('change', onWatermarkSettingChanged);
    var wmPos = $('veWatermarkPosition');
    if (wmPos) wmPos.addEventListener('change', onWatermarkSettingChanged);
    var wmText = $('veWatermarkText');
    if (wmText) wmText.addEventListener('input', onWatermarkSettingChanged);
    var wmSize = $('veWatermarkSize');
    if (wmSize) wmSize.addEventListener('input', onWatermarkSettingChanged);
    var wmColor = $('veWatermarkColor');
    if (wmColor) wmColor.addEventListener('input', onWatermarkSettingChanged);
    var wmOpacity = $('veWatermarkOpacity');
    if (wmOpacity) wmOpacity.addEventListener('input', onWatermarkSettingChanged);
    var wmMotion = $('veWatermarkMotion');
    if (wmMotion) wmMotion.addEventListener('change', onWatermarkSettingChanged);
    var wmSpeed = $('veWatermarkSpeed');
    if (wmSpeed) wmSpeed.addEventListener('input', onWatermarkSettingChanged);
    var wmSelect = $('veWatermarkSelect');
    if (wmSelect) wmSelect.addEventListener('change', function () {
      // Capture the requested selection before syncing the previous editor values.
      // syncWatermarkFromUI() rebuilds the selector and otherwise resets its value
      // to the currently active watermark, making other entries impossible to select.
      var nextIndex = Number(wmSelect.value) || 0;
      syncWatermarkFromUI();
      var list = project && Array.isArray(project.watermarks) ? project.watermarks : [];
      activeWatermarkIndex = Math.max(0, Math.min(list.length - 1, nextIndex));
      syncWatermarkToUI(list[activeWatermarkIndex] || project.watermark);
      renderWatermarkSelector();
      renderPreview();
    });
    var wmAdd = $('veAddWatermark');
    if (wmAdd) wmAdd.addEventListener('click', function () {
      syncWatermarkFromUI();
      var list = project.watermarks || [];
      if (list.length >= 10) return;
      list.push({ enabled: true, position: 2, text: 'New watermark', size: 0.045, color: '#ffffff', opacity: 75, motion: 'none', speed: 80 });
      project.watermarks = list; activeWatermarkIndex = list.length - 1;
      syncWatermarkToUI(list[activeWatermarkIndex]); renderWatermarkSelector(); renderPreview();
    });
    var wmRemove = $('veRemoveWatermark');
    if (wmRemove) wmRemove.addEventListener('click', function () {
      syncWatermarkFromUI();
      var list = project.watermarks || [];
      if (list.length <= 1) return;
      list.splice(activeWatermarkIndex, 1); activeWatermarkIndex = Math.max(0, activeWatermarkIndex - 1);
      project.watermarks = list; project.watermark = list[0];
      syncWatermarkToUI(list[activeWatermarkIndex]); renderWatermarkSelector(); renderPreview();
    });
    if (project) {
      if (!Array.isArray(project.watermarks) || !project.watermarks.length) project.watermarks = [normalizeProjectWatermark(project.watermark)];
      activeWatermarkIndex = 0; renderWatermarkSelector();
      syncWatermarkToUI(project.watermarks[0]);
    } else syncWatermarkFromUI();

    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Escape') {
        if (closeDrawers()) {
          e.preventDefault();
          return;
        }
        if (isPreviewMaximized) {
          e.preventDefault();
          setMaximizePreview(false);
          return;
        }
        if (document.body.classList.contains('ve-workspace-active')) {
          e.preventDefault();
          setWorkspaceMode(false);
          return;
        }
      } else if (e.code === 'KeyF' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (document.body.classList.contains('ve-workspace-active')) {
          e.preventDefault();
          setMaximizePreview(!isPreviewMaximized);
        }
      } else if (e.code === 'Space' && project && video && contentEnd(project) > 0) {
        e.preventDefault();
        setPlaying(!timelinePlaying);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && project && project.selectedId) {
        e.preventDefault();
        deleteSelected();
      }
    });

    function closeDrawers() {
      var uc = $('veUploadControls');
      var ec = $('veExportContainer');
      var wasOpen = false;
      if (uc && uc.classList.contains('ve-drawer-open')) {
        uc.classList.remove('ve-drawer-open');
        wasOpen = true;
      }
      if (ec && ec.classList.contains('ve-drawer-open')) {
        ec.classList.remove('ve-drawer-open');
        wasOpen = true;
      }
      return wasOpen;
    }

    function toggleMediaDrawer(force) {
      var uc = $('veUploadControls');
      if (!uc) return;
      var isOpen = uc.classList.contains('ve-drawer-open');
      var shouldOpen = typeof force === 'boolean' ? force : !isOpen;
      if (shouldOpen) {
        closeDrawers();
        uc.classList.add('ve-drawer-open');
      } else {
        uc.classList.remove('ve-drawer-open');
      }
    }

    function toggleExportDrawer(force) {
      var ec = $('veExportContainer');
      if (!ec) return;
      var isOpen = ec.classList.contains('ve-drawer-open');
      var shouldOpen = typeof force === 'boolean' ? force : !isOpen;
      if (shouldOpen) {
        closeDrawers();
        ec.classList.add('ve-drawer-open');
      } else {
        ec.classList.remove('ve-drawer-open');
      }
    }

    function setWorkspaceMode(active) {
      isWorkspaceActive = !!active;
      var root = $('videoEditorRoot');
      var header = $('veWorkspaceHeader');
      if (isWorkspaceActive) {
        document.body.classList.add('ve-workspace-active');
        if (root) root.classList.add('ve-workspace-active');
        if (header) header.style.display = 'flex';
      } else {
        if (isPreviewMaximized) setMaximizePreview(false);
        closeDrawers();
        document.body.classList.remove('ve-workspace-active');
        if (root) root.classList.remove('ve-workspace-active');
        if (header) header.style.display = 'none';
      }
      layoutTimeline();
      renderTimeline();
      updatePlayhead();
      renderCropLayer();
      renderPreview();
    }

    function setMaximizePreview(maximized) {
      if (maximized && !isWorkspaceActive) {
        setWorkspaceMode(true);
      }
      isPreviewMaximized = !!maximized;
      var root = $('videoEditorRoot');
      var maxBtn = $('veMaximizePreviewBtn');
      var floatBtn = $('veFloatingRestorePreview');
      if (isPreviewMaximized) {
        document.body.classList.add('ve-preview-maximized');
        if (root) root.classList.add('ve-preview-maximized');
        if (maxBtn) maxBtn.textContent = '🗗 Restore Workspace';
        if (floatBtn) floatBtn.style.display = 'inline-flex';
      } else {
        document.body.classList.remove('ve-preview-maximized');
        if (root) root.classList.remove('ve-preview-maximized');
        if (maxBtn) maxBtn.textContent = '🗖 Maximize Preview';
        if (floatBtn) floatBtn.style.display = 'none';
      }
      layoutTimeline();
      renderTimeline();
      updatePlayhead();
      renderCropLayer();
      renderPreview();
    }

    function initDividerDrag() {
      var divider = $('veDivider');
      if (!divider) return;
      var startY = 0;
      var startH = 240;
      var isDragging = false;
      divider.addEventListener('pointerdown', function (e) {
        if (!document.body.classList.contains('ve-workspace-active')) return;
        isDragging = true;
        startY = e.clientY;
        var root = $('videoEditorRoot');
        var computedH = parseInt(getComputedStyle(root).getPropertyValue('--ve-timeline-height'), 10);
        if (!computedH || isNaN(computedH)) {
          var tl = $('veTimelineContainer');
          startH = tl ? tl.getBoundingClientRect().height : 240;
        } else {
          startH = computedH;
        }
        divider.classList.add('ve-dragging');
        try { divider.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
      });
      divider.addEventListener('pointermove', function (e) {
        if (!isDragging) return;
        var deltaY = startY - e.clientY; // dragging up increases timeline height
        var minH = 120;
        var maxH = Math.round(window.innerHeight * 0.75);
        var newH = Math.max(minH, Math.min(maxH, Math.round(startH + deltaY)));
        var root = $('videoEditorRoot');
        if (root) root.style.setProperty('--ve-timeline-height', newH + 'px');
        layoutTimeline();
        renderCropLayer();
        renderPreview();
      });
      function endDividerDrag(e) {
        if (!isDragging) return;
        isDragging = false;
        divider.classList.remove('ve-dragging');
        try { divider.releasePointerCapture(e.pointerId); } catch (err) {}
        layoutTimeline();
        renderTimeline();
        updatePlayhead();
        renderCropLayer();
        renderPreview();
      }
      divider.addEventListener('pointerup', endDividerDrag);
      divider.addEventListener('pointercancel', endDividerDrag);
    }

    function initWorkspaceControls() {
      var wsToggle = $('veWorkspaceToggle');
      if (wsToggle) wsToggle.addEventListener('click', function () { setWorkspaceMode(true); });
      var tlWsToggle = $('veTimelineWorkspaceToggle');
      if (tlWsToggle) tlWsToggle.addEventListener('click', function () { setWorkspaceMode(true); });
      var wsRestore = $('veWorkspaceRestoreBtn');
      if (wsRestore) wsRestore.addEventListener('click', function () { setWorkspaceMode(false); });
      var maxPreviewBtn = $('veMaximizePreviewBtn');
      if (maxPreviewBtn) maxPreviewBtn.addEventListener('click', function () { setMaximizePreview(!isPreviewMaximized); });
      var floatRestore = $('veFloatingRestorePreview');
      if (floatRestore) floatRestore.addEventListener('click', function () { setMaximizePreview(false); });

      var btnMedia = $('veToggleMediaBtn');
      if (btnMedia) btnMedia.addEventListener('click', function () { toggleMediaDrawer(); });
      var btnExport = $('veToggleExportBtn');
      if (btnExport) btnExport.addEventListener('click', function () { toggleExportDrawer(); });
      var closeU = $('veCloseUploadsBtn');
      if (closeU) closeU.addEventListener('click', closeDrawers);
      var closeE = $('veCloseExportBtn');
      if (closeE) closeE.addEventListener('click', closeDrawers);

      var uc = $('veUploadControls');
      if (uc) {
        uc.addEventListener('click', function (e) {
          if (e.target === uc) closeDrawers();
        });
      }
      var ec = $('veExportContainer');
      if (ec) {
        ec.addEventListener('click', function (e) {
          if (e.target === ec) closeDrawers();
        });
      }

      initDividerDrag();

      window.addEventListener('resize', function () {
        if (document.body.classList.contains('ve-workspace-active')) {
          layoutTimeline();
          renderTimeline();
          updatePlayhead();
          renderCropLayer();
          renderPreview();
        }
      });

      try {
        window.__veSetWorkspaceMode = setWorkspaceMode;
        window.__veSetMaximizePreview = setMaximizePreview;
        window.__veIsWorkspaceActive = function () { return document.body.classList.contains('ve-workspace-active'); };
        window.__veIsPreviewMaximized = function () { return isPreviewMaximized; };
      } catch (err) {}
    }

    // Preselected exact library path (?path= validated server-side): load its
    // bytes read-only via the existing authenticated stream route as the
    // first video file. The server never writes to the library; export still
    // produces a new download.
    var preselected = root.getAttribute('data-preselected') || '';
    if (preselected) {
      var streamUrl = '/video/' + preselected.split('/').map(encodeURIComponent).join('/');
      var baseName = preselected.split('/').pop() || 'video.mp4';
      setStatus('Loading preselected video…', true);
      fetch(streamUrl, { credentials: 'same-origin' })
        .then(function (r) {
          if (!r.ok) throw new Error('Could not load the preselected video (HTTP ' + r.status + '). Select a file manually.');
          return r.blob();
        })
        .then(function (blob) {
          var f;
          try {
            f = new File([blob], baseName, { type: blob.type || 'video/mp4' });
          } catch (err) {
            f = blob;
            f.name = baseName;
          }
          addMediaFiles('video', [f]);
        })
        .catch(function (err) { setStatus(err.message || 'Could not load the preselected video.', false); });
    }

    var exportBtn = $('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', doExport);

    initWorkspaceControls();
  }

  // The standalone Screen Recorder page has no editor root; wire only its own
  // controls. Gated on the recorder card actually being on the page, so the
  // Video Editor page never initializes recorder state.
  function initScreenRecorder() {
    var card = document.querySelector('[data-testid="video-editor-screen-recorder"]');
    if (!card) return;
    srWireControls();
  }

  // Entry point: initialize whichever features this page actually ships.
  function init() {
    initVideoEditor();
    initScreenRecorder();
  }

  // Map the video element's own clock back onto the timeline (native seeks).
  // Returns timeline seconds or null when the position matches no known clip.
  function timelineFromVideo() {
    if (!project || !video || currentPreviewClipId === null) {
      // Fall back to any clip of any file containing this source position.
      if (!project || !video) return null;
      var ct = video.currentTime || 0;
      for (const c of project.videoClips) {
        var f = getMediaFile(project, c.file);
        void f;
        if (ct >= c.sourceIn && ct <= c.sourceOut) {
          return c.start + (ct - c.sourceIn);
        }
      }
      return null;
    }
    var clip = project.videoClips.find(function (c) { return c.id === currentPreviewClipId; });
    if (!clip) return null;
    var cur = video.currentTime || 0;
    if (cur < clip.sourceIn || cur > clip.sourceOut) return null;
    return clip.start + (cur - clip.sourceIn);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
