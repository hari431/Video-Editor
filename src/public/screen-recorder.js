// src/public/screen-recorder.js — Pure screen-recorder helpers.
//
// Zero DOM, zero dependencies, ESM so it runs both in the browser
// (imported by admin-video-editor.js) and under node:test.
// Browser-only work (getDisplayMedia, MediaRecorder, timers, DOM wiring)
// lives in admin-video-editor.js; everything here is deterministic and
// unit-testable: MIME probing order, resolution constraints, support
// detection, error mapping, session/elapsed math (pause-aware), control
// enablement, and recording File assembly.
//
// Flow: Record (opens the native picker from the click) → user selects a
// source → recording starts automatically on the granted stream ⇄
// Pause/Resume → Stop → File → existing addMediaFiles('video', …) handoff.

// Record to WebM in-browser for broad MediaRecorder compatibility and lower
// capture overhead. The website converts the finished recording to MP4 with
// local FFmpeg so the saved file has finalized duration and seek metadata.
export const RECORDER_MIME_CANDIDATES = Object.freeze([
  'video/webm;codecs=vp8',
  'video/webm;codecs=vp9',
  'video/webm'
]);

// Pick the first MIME type the browser can record. isTypeSupported is
// injected (MediaRecorder.isTypeSupported in the browser) so this stays
// testable. Returns the MIME string or null when nothing is supported.
export function pickRecorderMimeType(isTypeSupported) {
  if (typeof isTypeSupported !== 'function') return null;
  for (const mime of RECORDER_MIME_CANDIDATES) {
    let supported = false;
    try {
      supported = !!isTypeSupported(mime);
    } catch {
      supported = false;
    }
    if (supported) return mime;
  }
  return null;
}

// File extension matching a recorder MIME type. The existing editor upload
// accepts .mp4/.webm/.mov/.mkv, so both outcomes flow through unchanged.
export function recorderExtensionFor(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('webm')) return '.webm';
  return '';
}

// Stable recording file name: screen-recording-<epoch-ms>.<ext>.
// Falls back to .webm when the MIME type is unknown.
export function recorderFileName(mimeType, nowMs) {
  const stamp = Number(nowMs);
  const safeStamp = Number.isFinite(stamp) && stamp >= 0 ? Math.floor(stamp) : Date.now();
  const ext = recorderExtensionFor(mimeType) || '.webm';
  return `screen-recording-${safeStamp}${ext}`;
}

// Feature-detect the Milestone A capture path. env is injected
// (window/navigator in the browser) so this stays testable.
export function isRecorderSupported(env) {
  try {
    const nav = env && env.navigator ? env.navigator : env;
    const hasDisplayMedia = !!(nav && nav.mediaDevices && typeof nav.mediaDevices.getDisplayMedia === 'function');
    const Recorder = (env && env.MediaRecorder) || (typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined);
    const hasRecorder = typeof Recorder === 'function';
    return hasDisplayMedia && hasRecorder;
  } catch {
    return false;
  }
}

// Map getDisplayMedia / MediaRecorder failures to user-facing messages.
// Names follow the DOMException taxonomy; unknown errors degrade to a
// generic message that still carries the original detail when present.
export function classifyCaptureError(err) {
  const name = err && typeof err.name === 'string' ? err.name : '';
  const detail = err && err.message ? String(err.message) : '';
  const withDetail = (base) => (detail ? `${base} (${detail})` : base);
  if (name === 'NotAllowedError') {
    return 'Screen recording permission was denied. Allow screen sharing and try again.';
  }
  if (name === 'NotFoundError') {
    return 'No screen source is available for recording on this device.';
  }
  if (name === 'NotSupportedError') {
    return 'Screen recording is not supported in this browser. Use a recent desktop Chrome, Edge, Firefox, or Safari.';
  }
  if (name === 'AbortError') {
    return 'Screen capture was cancelled before recording started.';
  }
  if (name === 'OverconstrainedError') {
    return 'The requested screen source could not be satisfied. Try again without audio.';
  }
  if (name === 'SecurityError') {
    return 'Screen recording needs a secure context (HTTPS or localhost).';
  }
  if (name === 'InvalidStateError') {
    return 'The recorder is not in a state that allows that action.';
  }
  return withDetail('Screen recording failed to start.');
}

// Capture resolution options. Width/height are *preferred* (ideal)
// values, never exact: the browser and the selected source decide what is
// actually provided, and the UI must not promise an exact resolution.
// `original` requests no constraints (native source resolution).
export const RECORDER_RESOLUTIONS = Object.freeze([
  { id: 'original', label: 'Original', width: null, height: null },
  { id: '720p', label: '720p', width: 1280, height: 720 },
  { id: '1080p', label: '1080p', width: 1920, height: 1080 }
]);

export const RECORDER_DEFAULT_RESOLUTION = 'original';

// Normalize a resolution selector value to a known entry. Unknown, empty
// or missing values fall back to Original rather than failing, so an
// unsupported setting degrades gracefully.
export function normalizeRecorderResolution(value) {
  const fallback = RECORDER_RESOLUTIONS[0];
  if (value === null || value === undefined) return fallback;
  const key = String(value).trim().toLowerCase();
  if (key === '') return fallback;
  for (const entry of RECORDER_RESOLUTIONS) {
    if (key === entry.id || key === entry.label.toLowerCase()) return entry;
  }
  const digits = key.replace(/[^0-9]/g, '');
  if (digits !== '') {
    const num = Number(digits);
    if (Number.isFinite(num)) {
      const hit = RECORDER_RESOLUTIONS.find((entry) => entry.height === num);
      if (hit) return hit;
    }
  }
  return fallback;
}

// Build the `video` constraints for getDisplayMedia from a resolution
// selector value. Original → `true` (no constraints). Fixed options use
// `ideal` (not `exact`) so browsers fall back instead of rejecting when
// the source cannot provide the size.
export function recorderVideoConstraints(value) {
  const entry = normalizeRecorderResolution(value);
  if (!entry.width || !entry.height) return true;
  return {
    width: { ideal: entry.width },
    height: { ideal: entry.height }
  };
}

// Minimal recorder session model. Statuses:
//   idle → recording ⇄ paused → stopped → (reset) idle.
// Record opens the native picker from the click and starts the MediaRecorder
// on the granted stream; there is no held-source state. Timestamps use an
// injected clock (Date.now in the browser) for testability. pausedMs
// accumulates finished pause spans so the timer excludes paused duration.
export function createRecorderSession() {
  return { status: 'idle', startStamp: null, stopStamp: null, pausedMs: 0, pauseStartStamp: null };
}

export function startRecorderSession(session, nowMs) {
  if (!session || session.status !== 'idle') throw new Error('Recorder session can only start from idle.');
  const now = Number(nowMs);
  if (!Number.isFinite(now) || now < 0) throw new Error('Recorder session needs a valid start time.');
  session.status = 'recording';
  session.startStamp = now;
  session.stopStamp = null;
  session.pausedMs = 0;
  session.pauseStartStamp = null;
  return session;
}

export function pauseRecorderSession(session, nowMs) {
  if (!session || session.status !== 'recording') throw new Error('Only a recording session can pause.');
  const now = Number(nowMs);
  if (!Number.isFinite(now) || now < 0) throw new Error('Recorder session needs a valid pause time.');
  session.status = 'paused';
  session.pauseStartStamp = now;
  return session;
}

export function resumeRecorderSession(session, nowMs) {
  if (!session || session.status !== 'paused') throw new Error('Only a paused session can resume.');
  const now = Number(nowMs);
  if (!Number.isFinite(now) || now < 0) throw new Error('Recorder session needs a valid resume time.');
  const span = Math.max(0, now - (session.pauseStartStamp === null ? now : session.pauseStartStamp));
  session.pausedMs += span;
  session.pauseStartStamp = null;
  session.status = 'recording';
  return session;
}

// Stopping is valid from recording AND paused (stop-while-paused must
// finalize, never strand the recorder). The timer freezes at stopStamp.
export function stopRecorderSession(session, nowMs) {
  if (!session || (session.status !== 'recording' && session.status !== 'paused')) {
    throw new Error('Recorder session is not recording.');
  }
  const now = Number(nowMs);
  if (!Number.isFinite(now) || now < 0) throw new Error('Recorder session needs a valid stop time.');
  if (session.status === 'paused') {
    const span = Math.max(0, now - (session.pauseStartStamp === null ? now : session.pauseStartStamp));
    session.pausedMs += span;
    session.pauseStartStamp = null;
  }
  session.status = 'stopped';
  session.stopStamp = now;
  return session;
}

// Elapsed *recorded* milliseconds at clock time nowMs: paused spans are
// excluded, and the value freezes at the stop stamp once stopped.
export function recorderElapsedMs(session, nowMs) {
  if (!session || session.status === 'idle' || session.startStamp === null) return 0;
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return 0;
  let end = now;
  let paused = session.pausedMs || 0;
  if (session.status === 'paused' && session.pauseStartStamp !== null) {
    // An open pause span counts up to now (timer holds while paused).
    paused += Math.max(0, now - session.pauseStartStamp);
  } else if (session.status === 'stopped' && session.stopStamp !== null) {
    end = Math.min(now, session.stopStamp);
  }
  return Math.max(0, Math.floor(end - session.startStamp - paused));
}

// Describe actual captured dimensions for status text. Returns 'WxH'
// (e.g. '1920x1080') or '' when the settings are unavailable, so callers
// report what the browser/source actually provides instead of promising
// the preferred resolution.
export function formatCaptureDimensions(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return '';
  return `${Math.round(w)}x${Math.round(h)}`;
}

// ---- Snipping-style region capture (pure geometry) ----
// The granted display/window/tab plays in a preview <video> styled to the
// stream aspect ratio (no letterboxing); the user drags a rectangle on it.
// These helpers map that drag onto recordable source pixels. Recording uses
// a canvas crop pipeline (drawImage of the region → captureStream), never
// a silent fullscreen fallback: an invalid region fails loudly.

// Minimum recordable region edge in source pixels. Below this, encoders
// and the preview mapping become meaningless; the UI asks for a larger
// drag instead of recording a sliver.
export const REGION_MIN_PX = 16;

// Target 15 fps for region capture. Large desktop crops are copied from
// the live preview into a canvas before encoding; 30 fps at multi-megapixel
// sizes can overload browser compositing and produce torn/blank frames.
export const REGION_CAPTURE_FPS = 15;

// Bounded wait for the region preview to become playable (loadedmetadata +
// first frames) before region selection is allowed. Expiry cancels back to
// idle with an actionable error instead of stranding a dead preview.
export const REGION_PREVIEW_TIMEOUT_MS = 15000;

// Consecutive canvas draw failures tolerated before the recording is
// stopped with an error. A skipped frame (source not ready yet) is
// transient; a sustained burst means the crop pipeline is really broken.
export const REGION_DRAW_FAIL_LIMIT = 60;

// Normalize a drag rectangle (negative w/h allowed when dragging up or
// left) to a positive {x,y,w,h} box. Returns null for non-numeric input.
export function normalizeDragRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const w = Number(rect.w);
  const h = Number(rect.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  const left = w < 0 ? x + w : x;
  const top = h < 0 ? y + h : y;
  return { x: left, y: top, w: Math.abs(w), h: Math.abs(h) };
}

// Map a preview-CSS-pixel drag onto source pixels. The preview is styled
// to the stream aspect ratio, so one linear scale per axis is exact.
// Direction-agnostic (see normalizeDragRect). Returns rounded pixels, or
// null when inputs are unusable.
export function mapPreviewRectToSource(rectCss, previewW, previewH, frameW, frameH) {
  const box = normalizeDragRect(rectCss);
  const pw = Number(previewW);
  const ph = Number(previewH);
  const fw = Number(frameW);
  const fh = Number(frameH);
  if (!box) return null;
  if (![pw, ph, fw, fh].every((n) => Number.isFinite(n) && n > 0)) return null;
  const sx = fw / pw;
  const sy = fh / ph;
  return {
    x: Math.round(box.x * sx),
    y: Math.round(box.y * sy),
    w: Math.round(box.w * sx),
    h: Math.round(box.h * sy)
  };
}

// Clamp a candidate region to integer source pixels inside the frame and
// force even width/height (odd dimensions break hardware encoders and some
// muxers). Returns {x,y,w,h} or null when nothing recordable remains —
// callers must fail loudly, never fall back to fullscreen.
export function clampRegionPixels(rect, frameW, frameH) {
  const frameWidth = Math.floor(Number(frameW));
  const frameHeight = Math.floor(Number(frameH));
  if (!Number.isFinite(frameWidth) || !Number.isFinite(frameHeight) || frameWidth < 2 || frameHeight < 2) return null;
  const box = normalizeDragRect(rect);
  if (!box) return null;
  const x = Math.max(0, Math.min(frameWidth - 1, Math.round(box.x)));
  const y = Math.max(0, Math.min(frameHeight - 1, Math.round(box.y)));
  let w = Math.max(0, Math.min(frameWidth - x, Math.round(box.w)));
  let h = Math.max(0, Math.min(frameHeight - y, Math.round(box.h)));
  w -= w % 2;
  h -= h % 2;
  if (w < REGION_MIN_PX || h < REGION_MIN_PX) return null;
  return { x, y, w, h };
}

// Control enablement for a session status. Single source of truth shared
// by the UI sync and the unit tests: Record (which opens the picker) and
// the resolution preference are available while idle; Pause/Resume follow
// the recording state; Stop covers recording and paused.
export function recorderControlsFor(status) {
  const s = String(status || 'idle');
  return {
    record: s === 'idle',
    pause: s === 'recording',
    resume: s === 'paused',
    stop: s === 'recording' || s === 'paused',
    resolution: s === 'idle'
  };
}

// Format elapsed milliseconds as MM:SS (Screenity-style control-bar timer).
// Hours fold into minutes so long sessions keep a stable width.
export function formatRecorderElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(Number(elapsedMs) / 1000));
  if (!Number.isFinite(totalSeconds)) return '00:00';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(minutes)}:${pad(seconds)}`;
}

// Total payload bytes across recorded chunks (guards the empty-recording
// case before a File is assembled).
export function recorderPayloadBytes(chunks) {
  if (!Array.isArray(chunks)) return 0;
  let total = 0;
  for (const chunk of chunks) {
    const size = chunk && typeof chunk.size === 'number' ? chunk.size : 0;
    if (Number.isFinite(size) && size > 0) total += size;
  }
  return total;
}

// Assemble the finalized recording File. Uses the injected FileImpl
// (global File in the browser) and falls back to a Blob with assigned
// name/type when File construction is unavailable (older Safari).
export function buildRecordingFile(chunks, mimeType, name, FileImpl) {
  const parts = Array.isArray(chunks) ? chunks.filter((c) => c && c.size > 0) : [];
  if (parts.length === 0) throw new Error('Recording produced no data.');
  const fileName = String(name || recorderFileName(mimeType, Date.now()));
  const type = String(mimeType || 'video/webm');
  const Impl = FileImpl || (typeof File !== 'undefined' ? File : null);
  if (typeof Impl === 'function') {
    try {
      return new Impl(parts, fileName, { type });
    } catch {
      // Fall through to the Blob fallback below.
    }
  }
  if (typeof Blob !== 'undefined') {
    const blob = new Blob(parts, { type });
    blob.name = fileName;
    return blob;
  }
  throw new Error('This browser cannot assemble the recording file.');
}
