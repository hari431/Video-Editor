// src/public/video-editor-project.js — Pure project model for the local
// Admin/Owner timeline video editor. Zero DOM, zero dependencies, ESM so it
// runs both in the browser (ES module script) and under node:test.
//
// Time model v2 (multi-track):
// - The timeline domain is OUTPUT seconds: 0..contentEnd, where contentEnd is
//   the furthest video/audio clip end. There is no global trim window.
// - Each video/audio clip maps a SOURCE range [sourceIn, sourceOut] of its
//   file onto the timeline at `start` (end = start + duration). Scrubbing at
//   output time t plays sourceIn + (t - start) of the active clip.
// - Overlay clips (blur/text/image in project.clips) are output-relative, as
//   before; the FFmpeg graph renders them after concat, so no mapping needed.
// - Video clips must not overlap (single video track); audio clips may.
// - Gain is 0..2 per video/audio clip (100% = original). Gain only.

export const PROJECT_MIN_SPAN = 0.1;
// Generic overlay animation keyframes, adapted conceptually from DonkeyCut's
// property/keyframe model. Times are clip-relative seconds. Values are stored
// per property so position, scale and opacity can share one interpolation path.
export const KEYFRAME_PROPERTIES = Object.freeze({
  x: { min: 0, max: 1, defaultValue: 0.5 },
  y: { min: 0, max: 1, defaultValue: 0.5 },
  scale: { min: 0.05, max: 4, defaultValue: 1 },
  opacity: { min: 0, max: 1, defaultValue: 1 }
});
export const KEYFRAME_EASINGS = Object.freeze(['linear', 'ease-in', 'ease-out', 'ease-in-out']);

export function normalizeKeyframes(raw, clipDuration) {
  if (!Array.isArray(raw) || raw.length > 200) return null;
  const duration = Number(clipDuration);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const result = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const time = Number(item.time);
    const value = Number(item.value);
    const property = item.property;
    const limits = KEYFRAME_PROPERTIES[property];
    const easing = item.easing === undefined ? 'linear' : item.easing;
    if (!limits || !Number.isFinite(time) || time < 0 || time > duration ||
        !Number.isFinite(value) || value < limits.min || value > limits.max ||
        !KEYFRAME_EASINGS.includes(easing)) return null;
    result.push({ property, time: Math.round(time * 1000) / 1000, value, easing });
  }
  result.sort((a, b) => a.property.localeCompare(b.property) || a.time - b.time);
  for (let i = 1; i < result.length; i++) {
    if (result[i].property === result[i - 1].property && result[i].time === result[i - 1].time) return null;
  }
  return result;
}

function applyKeyframeEasing(t, easing) {
  if (easing === 'ease-in') return t * t;
  if (easing === 'ease-out') return 1 - (1 - t) * (1 - t);
  if (easing === 'ease-in-out') return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return t;
}

export function evaluateKeyframes(raw, time, clipDuration) {
  const keyframes = normalizeKeyframes(raw, clipDuration);
  if (!keyframes) return null;
  const t = Math.max(0, Math.min(Number(clipDuration), Number(time)));
  const values = {};
  for (const property of Object.keys(KEYFRAME_PROPERTIES)) {
    const frames = keyframes.filter(frame => frame.property === property);
    if (!frames.length) continue;
    if (t <= frames[0].time) { values[property] = frames[0].value; continue; }
    const last = frames[frames.length - 1];
    if (t >= last.time) { values[property] = last.value; continue; }
    for (let i = 1; i < frames.length; i++) {
      const right = frames[i];
      if (t > right.time) continue;
      const left = frames[i - 1];
      const span = right.time - left.time;
      const ratio = span > 0 ? (t - left.time) / span : 1;
      const eased = applyKeyframeEasing(ratio, right.easing);
      values[property] = left.value + (right.value - left.value) * eased;
      break;
    }
  }
  return values;
}

export function upsertKeyframe(raw, frame, clipDuration) {
  const normalized = normalizeKeyframes(raw || [], clipDuration);
  if (!normalized || !frame || typeof frame !== 'object') throw new Error('Invalid keyframe data.');
  const candidate = normalizeKeyframes([
    ...normalized.filter(k => !(k.property === frame.property && Math.abs(k.time - Number(frame.time)) < 0.001)),
    frame
  ], clipDuration);
  if (!candidate) throw new Error('Invalid keyframe property, time, value or easing.');
  return candidate;
}

export const PROJECT_MAX_CLIPS = 192;
export const PROJECT_MAX_VIDEO_CLIPS = 32;
export const PROJECT_MAX_AUDIO_CLIPS = 32;

// Overlay video tracks (picture-in-picture) ride in project.clips with
// type 'voverlay' so timeline, selection, move/trim, delete, duplicate and
// split reuse the overlay-clip machinery. Shape:
//   { id, type:'voverlay', file, x, y, w, h, start, end, sourceIn, label }
// file = index among kind==='video' project files (matches upload order,
// so the server binds it to the right input). sourceIn = source seconds
// where overlay playback starts (default 0). Overlay audio is never mixed:
// exports use only the :v stream (muted by construction, stated in the UI).
export const VIDEO_OVERLAY_DEFAULT_W = 0.28;

// Webcam-bubble placement presets for video overlays (independent design):
// nine frame positions plus manual x/y. `margin` is a frame fraction
// (0..0.25) kept clear of the edges; center positions ignore it. A null
// preset means manual positioning via x/y.
export const VOVERLAY_PRESETS = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right'
];
export const VOVERLAY_DEFAULT_MARGIN = 0.02;

export function normalizeVoverlayPreset(preset) {
  if (typeof preset !== 'string') return null;
  const s = preset.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return VOVERLAY_PRESETS.includes(s) ? s : null;
}

export function normalizeVoverlayMargin(margin) {
  const m = Number(margin);
  if (!Number.isFinite(m)) return VOVERLAY_DEFAULT_MARGIN;
  return Math.min(0.25, Math.max(0, Math.round(m * 1e4) / 1e4));
}

export function normalizeVoverlayShadow(shadow) {
  const s = Number(shadow);
  if (!Number.isFinite(s)) return 0;
  return Math.min(1, Math.max(0, Math.round(s * 100) / 100));
}

// Resolve a preset (+margin) to top-left fractions for a w×h overlay.
// Pure; shared by preview and export so both position identically.
export function voverlayPresetXY(preset, margin, w, h) {
  const p = normalizeVoverlayPreset(preset);
  const m = normalizeVoverlayMargin(margin);
  const bw = Number(w) > 0 ? Number(w) : VIDEO_OVERLAY_DEFAULT_W;
  const bh = Number(h) > 0 ? Number(h) : VIDEO_OVERLAY_DEFAULT_W;
  let x = 0;
  let y = 0;
  if (!p) return null;
  if (p.endsWith('left')) x = m;
  else if (p.endsWith('right')) x = 1 - m - bw;
  else x = (1 - bw) / 2;
  if (p.startsWith('top')) y = m;
  else if (p.startsWith('bottom')) y = 1 - m - bh;
  else y = (1 - bh) / 2;
  return {
    x: Math.round(Math.min(Math.max(0, x), Math.max(0, 1 - bw)) * 1e4) / 1e4,
    y: Math.round(Math.min(Math.max(0, y), Math.max(0, 1 - bh)) * 1e4) / 1e4
  };
}

// Clip-id prefix per overlay type ('o' keeps overlay-video ids distinct from
// main-track video 'v' ids even though the counter is global).
function overlayIdPrefix(type) {
  return type === 'voverlay' ? 'o' : type[0];
}

// Burned-in watermark shared with the server export (video-editor.js).
// Fractions must match EDITOR_WATERMARK_SIZE_FRAC / EDITOR_WATERMARK_MARGIN_FRAC.
// Positions: 1 = bottom-right (default), 2 = top-left, 3 = center,
// 4 = top-right, 5 = bottom-left. Text/size/color/opacity mirror the server
// defaults so unspecified fields render identically on both sides.
export const WATERMARK_TEXT = 'Learn with me';
export const WATERMARK_SIZE_FRAC = 0.045;
export const WATERMARK_COLOR = '#FFFFFF';
export const WATERMARK_OPACITY = 75;
export const WATERMARK_MARGIN_FRAC = 0.02;
export const WATERMARK_POSITIONS = [1, 2, 3, 4, 5];
export const WATERMARK_DEFAULT_POSITION = 1;
export const WATERMARK_MIN_SIZE_FRAC = 0.02;
export const WATERMARK_MAX_SIZE_FRAC = 0.25;
export const WATERMARK_MAX_TEXT = 200;

function normalizeWatermarkColor(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return null;
  let hex = m[1].toUpperCase();
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return `#${hex}`;
}

export function normalizeProjectWatermark(raw) {
  const defaults = {
    enabled: false,
    position: WATERMARK_DEFAULT_POSITION,
    text: WATERMARK_TEXT,
    size: WATERMARK_SIZE_FRAC,
    color: WATERMARK_COLOR,
    opacity: WATERMARK_OPACITY
  };
  if (raw === undefined || raw === null) return { ...defaults };
  if (typeof raw === 'boolean') return { ...defaults, enabled: raw };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const enabled = raw.enabled === undefined || raw.enabled === null ? true : raw.enabled;
  if (typeof enabled !== 'boolean') return null;
  const position = raw.position === undefined || raw.position === null
    ? WATERMARK_DEFAULT_POSITION
    : Number(raw.position);
  if (!Number.isInteger(position) || !WATERMARK_POSITIONS.includes(position)) return null;
  const text = raw.text === undefined || raw.text === null ? WATERMARK_TEXT : String(raw.text).replace(/\s+/g, ' ').trim();
  if (!text || text.length > WATERMARK_MAX_TEXT) return null;
  const size = raw.size === undefined || raw.size === null || String(raw.size).trim() === ''
    ? WATERMARK_SIZE_FRAC
    : Number(raw.size);
  if (!Number.isFinite(size) || size < WATERMARK_MIN_SIZE_FRAC || size > WATERMARK_MAX_SIZE_FRAC) return null;
  const color = raw.color === undefined || raw.color === null || String(raw.color).trim() === ''
    ? WATERMARK_COLOR
    : normalizeWatermarkColor(raw.color);
  if (!color) return null;
  const opacity = raw.opacity === undefined || raw.opacity === null || String(raw.opacity).trim() === ''
    ? WATERMARK_OPACITY
    : Number(raw.opacity);
  if (!Number.isInteger(opacity) || opacity < 1 || opacity > 100) return null;
  const motion = raw.motion === undefined || raw.motion === null ? 'none' : String(raw.motion);
  if (!['none', 'left-to-right', 'right-to-left'].includes(motion)) return null;
  const speed = raw.speed === undefined || raw.speed === null || String(raw.speed).trim() === '' ? 80 : Number(raw.speed);
  if (!Number.isFinite(speed) || speed < 10 || speed > 500) return null;
  return { enabled, position, text, size, color, opacity, motion, speed };
}

// Preview layout for the burned-in watermark, mirroring the server drawtext
// geometry (same size/margin fractions of the displayed frame). Pure.
// Returns { fontSizePx, text, color, opacity01, left, top, right, bottom, centered }.
export function watermarkPreviewLayout(watermark, layerW, layerH) {
  const wm = normalizeProjectWatermark(watermark) || {
    enabled: false, position: WATERMARK_DEFAULT_POSITION, text: WATERMARK_TEXT,
    size: WATERMARK_SIZE_FRAC, color: WATERMARK_COLOR, opacity: WATERMARK_OPACITY
  };
  const H = layerH > 0 ? layerH : 360;
  const W = layerW > 0 ? layerW : Math.round((H * 16) / 9);
  const fontSizePx = Math.max(10, Math.round(wm.size * H));
  const marginPx = Math.max(6, Math.round(WATERMARK_MARGIN_FRAC * Math.min(W, H)));
  const out = {
    fontSizePx,
    text: wm.text,
    color: wm.color,
    opacity01: Math.round((wm.opacity / 100) * 100) / 100,
    left: null, top: null, right: null, bottom: null,
    centered: wm.position === 3
  };
  if (wm.position === 2 || wm.position === 5) out.left = marginPx;
  else if (!out.centered) out.right = marginPx;
  if (wm.position === 2 || wm.position === 4) out.top = marginPx;
  else if (!out.centered) out.bottom = marginPx;
  return out;
}

// Integer-millisecond span: immune to binary float dust (e.g. 10 - 9.9 is
// 0.09999999999999964 in IEEE754). All minimum-span enforcement uses this so
// "accepted by the model" always implies "accepted by the backend".
export function spanMs(a, b) {
  return Math.round((b - a) * 1000);
}

let nextId = 1;

export function resetProjectIds() {
  nextId = 1;
}

function newId(prefix) {
  return `${prefix}${nextId++}`;
}

export function clampTime(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return Math.round(value * 1000) / 1000;
}

export function createProject() {
  return { version: 2, files: [], videoClips: [], audioClips: [], clips: [], chapters: [], selectedId: null };
}

function mediaEnd(c) {
  return c.start + (c.sourceOut - c.sourceIn);
}

function findFirstFreeVideoStart(project, dur, startFrom) {
  const clips = [...project.videoClips].sort((a, b) => a.start - b.start);
  let candidate = startFrom;
  for (const c of clips) {
    const cEnd = mediaEnd(c);
    if (candidate < cEnd && candidate + dur > c.start) {
      candidate = cEnd;
    }
  }
  return candidate;
}

// Length of the exported video in seconds: furthest video/audio clip end.
export function contentEnd(project) {
  let end = 0;
  for (const c of [...project.videoClips, ...project.audioClips]) {
    end = Math.max(end, mediaEnd(c));
  }
  return Math.round(end * 1000) / 1000;
}

// Backwards-compatible alias (overlays still think in output seconds).
export function outputDuration(project) {
  return contentEnd(project);
}

export function getMediaFile(project, id) {
  return project.files.find(f => f.id === id) || null;
}

// Index of a file among uploads of its kind (matches multipart part order:
// the i-th video entry binds the i-th `video` part, likewise audio).
export function fileIndexOfKind(project, id) {
  const file = getMediaFile(project, id);
  if (!file) return -1;
  let idx = -1;
  for (const f of project.files) {
    if (f.kind !== file.kind) continue;
    idx++;
    if (f.id === id) return idx;
  }
  return -1;
}

export function clampGain(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0, Math.round(n * 1000) / 1000));
}

// Preview audio gain calculation: combines linear gain (0–200%) and volumeDb (-60 to +24 dB)
// into an effective multiplier (unclamped for Web Audio GainNode; clamped for HTMLMediaElement.volume).
export function computeClipGain(clip) {
  if (!clip) return 1.0;
  const gain = clip.gain !== undefined && Number.isFinite(Number(clip.gain)) ? Number(clip.gain) : 1.0;
  const db = clip.volumeDb !== undefined && Number.isFinite(Number(clip.volumeDb)) ? Number(clip.volumeDb) : 0;
  const mult = gain * Math.pow(10, db / 20);
  return Math.max(0, mult);
}

export function computeClipVolume(clip) {
  const totalGain = computeClipGain(clip);
  return Math.min(1.0, Math.max(0.0, totalGain));
}

export function normalizeCrop(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let left = Number(raw.left !== undefined ? raw.left : 0);
  let top = Number(raw.top !== undefined ? raw.top : 0);
  let right = Number(raw.right !== undefined ? raw.right : 1);
  let bottom = Number(raw.bottom !== undefined ? raw.bottom : 1);
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) return null;

  if (right <= left && left + right < 1 && top + bottom < 1) {
    right = 1 - right;
    bottom = 1 - bottom;
  }

  left = Math.max(0, Math.min(0.98, left));
  top = Math.max(0, Math.min(0.98, top));
  right = Math.max(left + 0.02, Math.min(1, right));
  bottom = Math.max(top + 0.02, Math.min(1, bottom));

  if (left <= 0.0001 && top <= 0.0001 && right >= 0.9999 && bottom >= 0.9999) {
    return null;
  }

  const round4 = n => Math.round(n * 10000) / 10000;
  return {
    left: round4(left),
    top: round4(top),
    right: round4(right),
    bottom: round4(bottom)
  };
}

export function isClipCropped(clip) {
  return !!(clip && clip.crop && normalizeCrop(clip.crop));
}

export function setClipCrop(clip, crop) {
  if (!clip) return null;
  clip.crop = normalizeCrop(crop);
  return clip.crop;
}

export function resetClipCrop(clip) {
  if (!clip) return;
  clip.crop = null;
}

export function dragCrop(startCrop, handle, dx, dy, minSpan = 0.02) {
  const s = normalizeCrop(startCrop) || { left: 0, top: 0, right: 1, bottom: 1 };
  const dX = Number(dx) || 0;
  const dY = Number(dy) || 0;
  const span = Math.max(0.01, Number(minSpan) || 0.02);

  if (!handle) {
    const curW = s.right - s.left;
    const curH = s.bottom - s.top;
    const newLeft = Math.max(0, Math.min(1 - curW, s.left + dX));
    const newTop = Math.max(0, Math.min(1 - curH, s.top + dY));
    return {
      left: Math.round(newLeft * 10000) / 10000,
      top: Math.round(newTop * 10000) / 10000,
      right: Math.round((newLeft + curW) * 10000) / 10000,
      bottom: Math.round((newTop + curH) * 10000) / 10000
    };
  }

  const next = { left: s.left, top: s.top, right: s.right, bottom: s.bottom };
  if (handle === 'l' || handle === 'nw' || handle === 'sw') {
    next.left = Math.max(0, Math.min(s.right - span, s.left + dX));
  }
  if (handle === 'r' || handle === 'ne' || handle === 'se') {
    next.right = Math.min(1, Math.max(s.left + span, s.right + dX));
  }
  if (handle === 't' || handle === 'nw' || handle === 'ne') {
    next.top = Math.max(0, Math.min(s.bottom - span, s.top + dY));
  }
  if (handle === 'b' || handle === 'sw' || handle === 'se') {
    next.bottom = Math.min(1, Math.max(s.top + span, s.bottom + dY));
  }

  return {
    left: Math.round(next.left * 10000) / 10000,
    top: Math.round(next.top * 10000) / 10000,
    right: Math.round(next.right * 10000) / 10000,
    bottom: Math.round(next.bottom * 10000) / 10000
  };
}

export function cropToPixels(crop, frameW, frameH) {
  const c = normalizeCrop(crop) || { left: 0, top: 0, right: 1, bottom: 1 };
  const W = Math.max(1, Number(frameW) || 1);
  const H = Math.max(1, Number(frameH) || 1);
  const leftPx = Math.round(c.left * W);
  const topPx = Math.round(c.top * H);
  const rightPx = Math.round(c.right * W);
  const bottomPx = Math.round(c.bottom * H);
  return {
    x: leftPx,
    y: topPx,
    width: Math.max(1, rightPx - leftPx),
    height: Math.max(1, bottomPx - topPx)
  };
}

export function pixelsToCrop(rect, frameW, frameH) {
  if (!rect) return null;
  const W = Math.max(1, Number(frameW) || 1);
  const H = Math.max(1, Number(frameH) || 1);
  const left = Math.max(0, Math.min(1, (Number(rect.x) || 0) / W));
  const top = Math.max(0, Math.min(1, (Number(rect.y) || 0) / H));
  const right = Math.max(left + 0.02, Math.min(1, (left * W + (Number(rect.width) || 0)) / W));
  const bottom = Math.max(top + 0.02, Math.min(1, (top * H + (Number(rect.height) || 0)) / H));
  return normalizeCrop({ left, top, right, bottom });
}

export function cropPercentStrings(crop) {
  const c = normalizeCrop(crop) || { left: 0, top: 0, right: 1, bottom: 1 };
  return {
    left: String(Math.round(c.left * 1000) / 10),
    top: String(Math.round(c.top * 1000) / 10),
    right: String(Math.round(c.right * 1000) / 10),
    bottom: String(Math.round(c.bottom * 1000) / 10)
  };
}

export function getOverlaySources(project) {
  if (!project || !Array.isArray(project.files)) return [];
  const overlaySources = project.files.filter(f => f.kind === 'video' && f.isOverlaySource);
  return overlaySources.length > 0 ? overlaySources : project.files.filter(f => f.kind === 'video');
}

// Register an uploaded file. meta: {kind:'video'|'audio', name, duration,
// width?, height?, isOverlaySource?}. Returns the file entry.
export function addFileEntry(project, meta) {
  if (!meta || (meta.kind !== 'video' && meta.kind !== 'audio')) {
    throw new Error('File kind must be "video" or "audio".');
  }
  const duration = Number(meta.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('File duration must be positive.');
  const entry = {
    id: newId(meta.kind === 'video' ? 'f' : 'a'),
    kind: meta.kind,
    name: String(meta.name || (meta.kind === 'video' ? 'video' : 'audio')),
    duration: Math.round(duration * 1000) / 1000,
    width: (meta.width && Number.isFinite(Number(meta.width))) ? Math.round(Number(meta.width)) : null,
    height: (meta.height && Number.isFinite(Number(meta.height))) ? Math.round(Number(meta.height)) : null,
    isOverlaySource: !!meta.isOverlaySource
  };
  project.files.push(entry);
  return entry;
}

export function defaultClipProps(type) {
  if (type === 'blur') return { mode: 'blur', x: 0.1, y: 0.1, w: 0.2, h: 0.15, label: 'Blur' };
  if (type === 'text') {
    return { text: 'New text', x: 0.05, y: 0.05, size: 0.05, color: '#FFFFFF', bg: null, label: 'Text' };
  }
  if (type === 'image') return { x: 0.7, y: 0.7, w: 0.2, h: 0.2, file: 0, label: 'Image', crop: null };
  // Video-overlay geometry defaults; the file index and aspect-correct height
  // are resolved in addClip (which sees the project). h is always stored so
  // move/resize treat it as a free rectangle.
  if (type === 'voverlay') return { x: 0.68, y: 0.04, w: VIDEO_OVERLAY_DEFAULT_W, h: 0.1688, sourceIn: 0, file: 0, label: 'Video overlay', crop: null, shape: 'rect', mirror: false, preset: null, margin: VOVERLAY_DEFAULT_MARGIN, shadow: 0 };
  if (type === 'zoom') return { level: 1.5, x: 0.25, y: 0.25, transition: 0.5, easing: DEFAULT_ZOOM_EASING, label: 'Zoom' };
  throw new Error(`Unknown clip type: ${type}`);
}

export function normalizeOverlayShape(shape) {
  if (!shape || typeof shape !== 'string') return 'rect';
  const s = shape.trim().toLowerCase();
  if (s === 'circle' || s === 'ellipse') return 'circle';
  if (s === 'rounded' || s === 'rounded-rect' || s === 'round') return 'rounded';
  return 'rect';
}

// Add a clip at output-relative time `at` (clamped). Returns the new clip.
export function addClip(project, type, at, fileIndex) {
  if (!['blur', 'text', 'image', 'voverlay', 'zoom'].includes(type)) throw new Error(`Unknown clip type: ${type}.`);
  if (project.clips.length >= PROJECT_MAX_CLIPS) throw new Error('Too many clips (max 24).');
  const outDur = outputDuration(project);
  const span = Math.min(2, Math.max(PROJECT_MIN_SPAN, outDur));
  const start = clampTime(Number(at), 0, Math.max(0, outDur - PROJECT_MIN_SPAN));
  const clip = {
    id: newId(overlayIdPrefix(type)),
    type,
    start,
    end: clampTime(start + span, start + PROJECT_MIN_SPAN, outDur),
    ...defaultClipProps(type)
  };
  if (type === 'text') clip.label = 'Text';
  if (type === 'image') {
    clip.file = Number.isInteger(fileIndex) ? fileIndex : 0;
  }
  if (type === 'voverlay') {
    // Select from overlay sources if any exist, otherwise all video files.
    const allVideos = project.files.filter(f => f.kind === 'video');
    if (!allVideos.length) throw new Error('Add a video file first.');
    const overlaySources = allVideos.filter(f => f.isOverlaySource);
    const pool = overlaySources.length > 0 ? overlaySources : allVideos;
    let targetFileEntry;
    if (Number.isInteger(fileIndex) && fileIndex >= 0 && fileIndex < allVideos.length) {
      targetFileEntry = allVideos[fileIndex];
    } else {
      targetFileEntry = pool[pool.length - 1];
    }
    const idx = allVideos.indexOf(targetFileEntry);
    clip.file = idx >= 0 ? idx : 0;
    const src = targetFileEntry;
    if (src.width > 0 && src.height > 0) {
      const firstVideo = allVideos[0];
      const canvasW = firstVideo && firstVideo.width > 0 ? firstVideo.width : 1280;
      const canvasH = firstVideo && firstVideo.height > 0 ? firstVideo.height : 720;
      clip.h = Math.min(1 - clip.y, Math.max(GEO_MIN, Math.round((clip.w * (canvasW / canvasH) * src.height) / src.width * 1e4) / 1e4));
    }
    const videoDuration = src.duration || span;
    clip.end = clampTime(start + videoDuration, start + PROJECT_MIN_SPAN, outDur);
    clip.crop = null;
  }
  project.clips.push(clip);
  project.selectedId = clip.id;
  return clip;
}

export function getClip(project, id) {
  return project.clips.find(c => c.id === id) || null;
}

export function deleteClip(project, id) {
  const idx = project.clips.findIndex(c => c.id === id);
  if (idx === -1) return false;
  project.clips.splice(idx, 1);
  if (project.selectedId === id) project.selectedId = null;
  return true;
}

export function duplicateClip(project, id) {
  const src = getClip(project, id);
  if (!src) throw new Error('Clip not found.');
  if (project.clips.length >= PROJECT_MAX_CLIPS) throw new Error('Too many clips (max 24).');
  const outDur = outputDuration(project);
  const dur = src.end - src.start;
  const start = clampTime(src.end + 0.1, 0, Math.max(0, outDur - PROJECT_MIN_SPAN));
  const copy = { ...src, id: newId(overlayIdPrefix(src.type)), start, end: clampTime(start + dur, start + PROJECT_MIN_SPAN, outDur) };
  project.clips.push(copy);
  project.selectedId = copy.id;
  return copy;
}

// Move a clip body in output-relative time, preserving duration.
export function moveClip(project, id, newStart) {
  const clip = getClip(project, id);
  if (!clip) throw new Error('Clip not found.');
  const outDur = outputDuration(project);
  const dur = clip.end - clip.start;
  const start = clampTime(Number(newStart), 0, Math.max(0, outDur - dur));
  clip.start = start;
  clip.end = clampTime(start + dur, start + PROJECT_MIN_SPAN, outDur);
  return clip;
}

// Resize one edge of a clip to output-relative time t.
export function resizeClip(project, id, edge, t) {
  const clip = getClip(project, id);
  if (!clip) throw new Error('Clip not found.');
  const outDur = outputDuration(project);
  const time = clampTime(Number(t), 0, outDur);

  if (clip.type === 'voverlay') {
    const videos = project.files.filter(f => f.kind === 'video');
    const file = videos[clip.file];
    if (file && file.duration) {
      if (edge === 'start') {
        const timeCandidate = clampTime(time, 0, clip.end - PROJECT_MIN_SPAN);
        const maxDt = clip.sourceIn || 0; // can at most move start left by sourceIn
        const newStart = Math.max(clip.start - maxDt, timeCandidate);
        const actualDt = newStart - clip.start;
        clip.start = Math.round(newStart * 1000) / 1000;
        clip.sourceIn = Math.max(0, Math.round(((clip.sourceIn || 0) + actualDt) * 1000) / 1000);
      } else if (edge === 'end') {
        const maxDur = file.duration - (clip.sourceIn || 0);
        const maxEnd = clip.start + maxDur;
        clip.end = clampTime(time, clip.start + PROJECT_MIN_SPAN, Math.min(outDur, maxEnd));
      } else {
        throw new Error(`Unknown edge: ${edge}.`);
      }
      return clip;
    }
  }

  if (edge === 'start') {
    clip.start = clampTime(time, 0, clip.end - PROJECT_MIN_SPAN);
  } else if (edge === 'end') {
    clip.end = clampTime(time, clip.start + PROJECT_MIN_SPAN, outDur);
  } else {
    throw new Error(`Unknown edge: ${edge}.`);
  }
  return clip;
}

// Convert the timeline project to the backend v2 spec shape
// (see validateSpecV2 in src/library/video-editor.js). widths/heights come
// from the first video file entry (client-measured); the server prefers
// probed values and falls back to these.
export function projectToSpecV2(project) {
  const firstVideo = project.files.find(f => f.kind === 'video');
  if (!firstVideo) throw new Error('Add a video file first.');
  const W = firstVideo.width;
  const H = firstVideo.height;
  if (!Number.isInteger(W) || !Number.isInteger(H)) throw new Error('Video dimensions are not loaded yet.');
  const legacyWatermark = normalizeProjectWatermark(project.watermark);
  if (!legacyWatermark) throw new Error('Invalid watermark settings.');
  const sourceWatermarks = Array.isArray(project.watermarks) ? project.watermarks : [legacyWatermark];
  if (sourceWatermarks.length > 10) throw new Error('A maximum of 10 watermarks is supported.');
  const watermarks = sourceWatermarks.map(normalizeProjectWatermark);
  if (watermarks.some(w => !w)) throw new Error('Invalid watermark settings.');
  const watermark = watermarks[0] || legacyWatermark;
  const spec = {
    version: 2,
    width: W,
    watermarks,
    height: H,
    files: project.files.map(f => ({ kind: f.kind })),
    videoClips: project.videoClips.map(c => ({
      file: fileIndexOfKind(project, c.file),
      sourceIn: c.sourceIn, sourceOut: c.sourceOut, start: c.start, gain: c.gain,
      volumeDb: c.volumeDb !== undefined ? c.volumeDb : 0,
      fadeIn: c.fadeIn !== undefined ? c.fadeIn : 0,
      fadeOut: c.fadeOut !== undefined ? c.fadeOut : 0,
      crop: normalizeCrop(c.crop),
      scale: c.scale !== undefined && c.scale !== 1 ? c.scale : 1.0,
      brightness: c.brightness !== undefined ? c.brightness : 0,
      contrast: c.contrast !== undefined ? c.contrast : 1,
      saturation: c.saturation !== undefined ? c.saturation : 1,
      fadeVideoIn: c.fadeVideoIn !== undefined ? c.fadeVideoIn : 0,
      fadeVideoOut: c.fadeVideoOut !== undefined ? c.fadeVideoOut : 0
    })),
    audioClips: project.audioClips.map(c => ({
      file: fileIndexOfKind(project, c.file),
      sourceIn: c.sourceIn, sourceOut: c.sourceOut, start: c.start, gain: c.gain,
      volumeDb: c.volumeDb !== undefined ? c.volumeDb : 0,
      fadeIn: c.fadeIn !== undefined ? c.fadeIn : 0,
      fadeOut: c.fadeOut !== undefined ? c.fadeOut : 0
    })),
    blurs: [],
    texts: [],
    images: [],
    videoOverlays: [],
    zooms: [],
    watermark
  };
  const clips = [...project.clips].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const clip of clips) {
    if (clip.type === 'blur') {
      spec.blurs.push({ mode: clip.mode, x: clip.x, y: clip.y, w: clip.w, h: clip.h, start: clip.start, end: clip.end });
    } else if (clip.type === 'text') {
      spec.texts.push({
        text: clip.text, x: clip.x, y: clip.y, size: clip.size,
        color: clip.color, bg: clip.bg, start: clip.start, end: clip.end,
        keyframes: Array.isArray(clip.keyframes) ? clip.keyframes : []
      });
    } else if (clip.type === 'image') {
      spec.images.push({
        x: clip.x, y: clip.y, w: clip.w,
        start: clip.start, end: clip.end,
        file: clip.file,
        crop: normalizeCrop(clip.crop),
        keyframes: Array.isArray(clip.keyframes) ? clip.keyframes : []
      });
    } else if (clip.type === 'voverlay') {
      // mirror/shadow travel only when set, so older projects serialize
      // (and export) byte-identically to before.
      const voEntry = {
        file: clip.file, x: clip.x, y: clip.y, w: clip.w, h: clip.h,
        start: clip.start, end: clip.end, sourceIn: clip.sourceIn || 0,
        crop: normalizeCrop(clip.crop),
        shape: normalizeOverlayShape(clip.shape)
      };
      if (clip.mirror === true) voEntry.mirror = true;
      if (normalizeVoverlayShadow(clip.shadow) > 0) voEntry.shadow = normalizeVoverlayShadow(clip.shadow);
      spec.videoOverlays.push(voEntry);
    } else if (clip.type === 'zoom') {
      spec.zooms.push({
        start: clip.start, end: clip.end,
        level: clip.level || 1.5, x: clip.x || 0, y: clip.y || 0,
        transition: clip.transition === undefined ? 0.5 : clip.transition,
        easing: normalizeZoomEasing(clip.easing)
      });
    }
  }
  return spec;
}

// Preview rectangle for a video overlay in layer pixels. Pure.
export function videoOverlayPreviewRect(ov, layerW, layerH) {
  const W = layerW > 0 ? layerW : 640;
  const H = layerH > 0 ? layerH : 360;
  const hFrac = ov.h != null ? ov.h : (ov.w * 9) / 16;
  return {
    left: ov.x * W,
    top: ov.y * H,
    width: ov.w * W,
    height: hFrac * H
  };
}

function evenInt(n) {
  return Math.max(0, Math.round(n / 2) * 2);
}

// Export pixel box mirroring the server FFmpeg geometry (even-clamped,
// frame-bounded, aspect-preserved when h is absent). Pure.
export function videoOverlayExportBox(ov, W, H) {
  const w = evenInt(Math.min(W, Math.max(8, ov.w * W)));
  const h = ov.h != null ? evenInt(Math.min(H, Math.max(8, ov.h * H))) : -2;
  return {
    x: evenInt(Math.min(W - 8, Math.round(ov.x * W))),
    y: evenInt(Math.min(H - 8, Math.round(ov.y * H))),
    w,
    h
  };
}

// Zoom magnification bounds shared by preview, inspector, and export
// Keep the client/server zoom ceiling aligned. Higher levels are useful for
// small UI details; focus rails clamp the selected region to the source frame.
export const ZOOM_LEVEL_MIN = 1.0;
export const ZOOM_LEVEL_MAX = 8.0;

// Zoom transition easing (independent design): linear preserves the exact
// historical ramp; the cubics ease the zoom-in and zoom-out transitions
// while the hold period stays at full level.
export const ZOOM_EASINGS = ['linear', 'ease-in', 'ease-out', 'ease-in-out'];
export const DEFAULT_ZOOM_EASING = 'linear';

export function normalizeZoomEasing(easing) {
  if (typeof easing !== 'string') return DEFAULT_ZOOM_EASING;
  const s = easing.trim().toLowerCase();
  return ZOOM_EASINGS.includes(s) ? s : DEFAULT_ZOOM_EASING;
}

// Eased ramp progress for a 0..1 linear fraction. Pure; shared by preview
// (getZoomState) and covered together with the export expressions.
export function easeZoomRamp(frac, easing) {
  const f = Math.min(1, Math.max(0, Number(frac)));
  if (!Number.isFinite(f)) return 0;
  switch (normalizeZoomEasing(easing)) {
    case 'ease-in':
      return f * f * f;
    case 'ease-out':
      return 1 - Math.pow(1 - f, 3);
    case 'ease-in-out':
      return f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;
    default:
      return f;
  }
}

// Canonical on-canvas rectangle for a zoom clip in normalized fractions.
// Zoom clips store a target CENTER (x, y) plus a uniform LEVEL — never w/h.
// The visible region is a square: w = h = 1 / level, anchored at
// (center - size/2) and clamped into the frame. Mirrors renderPreview/
// syncBoxEl in admin-video-editor.js; single source of truth for tests.
export function zoomPreviewRect(clip) {
  const level = Number(clip.level) > 0 ? Number(clip.level) : 1.5;
  const wz = 1.0 / level;
  const hz = 1.0 / level;
  const cx = clip.x === undefined ? 0.5 : Number(clip.x);
  const cy = clip.y === undefined ? 0.5 : Number(clip.y);
  return {
    x: q4(Math.min(1 - wz, Math.max(0, cx - wz / 2))),
    y: q4(Math.min(1 - hz, Math.max(0, cy - hz / 2))),
    w: q4(wz),
    h: q4(hz)
  };
}

// Convert a resized preview rectangle back to zoom model fields.
// Level is clamped to the inspector/export range 1.0..8.0 (0.1 steps);
// center is the rect midpoint clamped to 0..1. Never emits w/h.
export function zoomFromPreviewRect(rect) {
  const w = Number(rect.w);
  const h = Number(rect.h);
  const size = (w > 0 && h > 0) ? (w + h) / 2 : (w > 0 ? w : h);
  const rawLevel = size > 0 ? 1.0 / size : 1.5;
  const level = Math.min(ZOOM_LEVEL_MAX, Math.max(ZOOM_LEVEL_MIN, Math.round(rawLevel * 10) / 10));
  return {
    level,
    x: q4(Math.min(1, Math.max(0, Number(rect.x) + w / 2))),
    y: q4(Math.min(1, Math.max(0, Number(rect.y) + h / 2)))
  };
}

// CSS paint for the zoom preview that matches the export window exactly.
// `box` is the content window in fractions (see zoomPreviewRect); `scale`
// is the effective magnification. Modern path: object-view-box selects the
// window with zero layout impact — the element box never changes, so the
// painted video is clipped to the actual video frame in every layout with
// no extra wrapper or clipping rules. Legacy path (browsers without
// object-view-box): origin-0 translate+scale, which shows the same window
// but can overflow like the old origin+scale paint.
export function zoomPaintStyle(box, scale) {
  const s = Number(scale) > 0 ? Number(scale) : 1;
  const x = Math.min(1, Math.max(0, Number(box.x) || 0));
  const y = Math.min(1, Math.max(0, Number(box.y) || 0));
  const w = Math.min(1, Math.max(0, Number(box.w) || 0));
  const h = Math.min(1, Math.max(0, Number(box.h) || 0));
  const pct = f => Math.round(f * 10000) / 100;
  return {
    objectViewBox: `inset(${pct(y)}% ${pct(1 - x - w)}% ${pct(1 - y - h)}% ${pct(x)}%)`,
    transformOrigin: '0 0',
    transform: `translate(${pct(-x * s)}%, ${pct(-y * s)}%) scale(${s})`
  };
}

// Latest-start-wins zoom precedence, mirroring the export nested-if order
// (buildZoomFilter sorts by start ascending so the later starter is checked
// first; stable sorts keep end-ascending then insertion order within ties).
// Among regions containing t: greatest start wins, then greatest end, then
// greatest position in clips order. Deterministic; null when none match.
export function findDominantZoomClip(clips, t) {
  let best = null;
  let bestIdx = -1;
  for (let i = 0; i < (clips || []).length; i++) {
    const c = clips[i];
    if (!c || c.type !== 'zoom') continue;
    if (!(t >= c.start && t <= c.end)) continue;
    if (!best || c.start > best.start ||
        (c.start === best.start && (c.end > best.end ||
          (c.end === best.end && i > bestIdx)))) {
      best = c;
      bestIdx = i;
    }
  }
  return best;
}

// Marquee rectangle for draw-to-create: press-drag from `anchor` to `current`
// defines a square zoom region (uniform level). Returns null when there is
// no drag yet (plain click). Pure + unit-tested; the preview background
// handler feeds the result into zoomFromPreviewRect.
export function zoomDrawRect(anchor, current) {
  const ax = Number(anchor.x);
  const ay = Number(anchor.y);
  const cx = Number(current.x);
  const cy = Number(current.y);
  if (![ax, ay, cx, cy].every(Number.isFinite)) return null;
  let side = Math.max(Math.abs(cx - ax), Math.abs(cy - ay));
  if (!(side > 0)) return null;
  side = Math.min(side, 1);
  const rx = Math.min(Math.max(0, (cx >= ax) ? ax : ax - side), Math.max(0, 1 - side));
  const ry = Math.min(Math.max(0, (cy >= ay) ? ay : ay - side), Math.max(0, 1 - side));
  return { x: q4(rx), y: q4(ry), w: q4(side), h: q4(side) };
}

// Outward ray per handle in layer space (y grows downward, matching client
// coordinates). Corner rays are diagonal, edge rays axial; aliases mirror
// resizeGeo so both helpers accept the same handle names.
const ZOOM_HANDLE_RAYS = {
  se: [1, 1], nw: [-1, -1], ne: [1, -1], sw: [-1, 1],
  e: [1, 0], r: [1, 0], w: [-1, 0], l: [-1, 0],
  s: [0, 1], b: [0, 1], n: [0, -1], t: [0, -1]
};

// Center-stable zoom resize (Premiere Scale-about-center style): the region
// scales symmetrically about the stored target center instead of pinning the
// opposite corner, so enlarging reduces magnification continuously down to
// full-frame (level 1.0) with no stuck edge, and edge drags never drift the
// orthogonal axis. `start` is the { level, x, y } captured at pointerdown;
// (dxPx, dyPx) is pointer travel in client pixels; layerW/H make the math
// aspect-correct. Sizes clamp to [1/MAX .. 1]; the center only shifts the
// minimum needed to keep the box in frame (forced to 0.5 at full frame).
// Level stays precise during the gesture — per-move 0.1 rounding made the
// rendered box jump in steps. Returns { level, x, y, size }, or null when
// inputs are not finite (caller then ignores the move), and throws on an
// unknown handle like resizeGeo. Pure + unit-tested.
export function zoomResizeDelta(start, handle, dxPx, dyPx, layerW, layerH) {
  const hKey = String(handle || '').toLowerCase();
  const ray = ZOOM_HANDLE_RAYS[hKey];
  if (!ray) throw new Error(`Unknown corner: ${handle}.`);
  const dx = Number(dxPx);
  const dy = Number(dyPx);
  const W = Number(layerW) > 0 ? Number(layerW) : 640;
  const H = Number(layerH) > 0 ? Number(layerH) : 360;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const startLevel = Number(start.level) > 0 ? Number(start.level) : 1.5;
  const startSize = 1 / startLevel;
  const rx = ray[0] * W;
  const ry = ray[1] * H;
  const len = Math.hypot(rx, ry);
  if (!(len > 0)) return null;
  const along = dx * (rx / len) + dy * (ry / len);
  let size = startSize + (2 * along) / len;
  if (!Number.isFinite(size)) return null;
  size = Math.min(1, Math.max(1 / ZOOM_LEVEL_MAX, size));
  const half = size / 2;
  const scx = start.x === undefined ? 0.5 : Number(start.x);
  const scy = start.y === undefined ? 0.5 : Number(start.y);
  const fx = Number.isFinite(scx) ? scx : 0.5;
  const fy = Number.isFinite(scy) ? scy : 0.5;
  return {
    level: 1 / size,
    x: q4(size >= 1 ? 0.5 : Math.min(Math.max(fx, half), 1 - half)),
    y: q4(size >= 1 ? 0.5 : Math.min(Math.max(fy, half), 1 - half)),
    size: q4(size)
  };
}

export function formatTimecode(totalSeconds) {
  const t = Math.max(0, Number(totalSeconds) || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const d = Math.floor((t % 1) * 10);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(m)}:${pad(s)}.${d}`;
}

// Remaining-time estimate for the export progress UI (pure + unit-tested).
// Linear extrapolation from ACTUAL elapsed time and ACTUAL FFmpeg percent —
// never a fixed or guessed duration. Returns remaining milliseconds, or
// null when there is nothing measurable yet (percent <= 0), nothing left
// (percent >= 100), or invalid inputs: callers show no ETA then.
export function estimateRemainingMs(elapsedMs, percent) {
  const elapsed = Number(elapsedMs);
  const pct = Number(percent);
  if (!Number.isFinite(elapsed) || !(elapsed > 0)) return null;
  if (!Number.isFinite(pct) || !(pct > 0) || pct >= 100) return null;
  return Math.max(0, elapsed * (100 - pct) / pct);
}

// Format a remaining-time estimate for display. Rounds to dampen poll
// jitter: whole seconds under a minute, 5-second steps under an hour,
// whole minutes beyond. "~"-prefixed since it is an estimate; null for
// non-numeric input. Pure + unit-tested.
export function formatEta(remainingMs) {
  const totalSeconds = Math.max(0, Math.round(Number(remainingMs) / 1000));
  if (!Number.isFinite(totalSeconds)) return null;
  if (totalSeconds < 60) return `~${totalSeconds}s remaining`;
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60);
    let s = Math.round((totalSeconds % 60) / 5) * 5;
    let mm = m;
    if (s === 60) { mm += 1; s = 0; }
    if (mm >= 60) return formatEta(mm * 60000);
    return s === 0 ? `~${mm}m remaining` : `~${mm}m ${s}s remaining`;
  }
  const h = Math.floor(totalSeconds / 3600);
  let min = Math.round((totalSeconds % 3600) / 60);
  let hh = h;
  if (min === 60) { hh += 1; min = 0; }
  return min === 0 ? `~${hh}h remaining` : `~${hh}h ${min}m remaining`;
}

// Overlay visibility predicate shared with the live preview renderer.
// Matches the export graph exactly: FFmpeg `between(t,start,end)` is
// inclusive on both ends, so the preview shows a blur/text/image overlay
// iff the timeline clock t is within [start, end]. Pure + unit-tested.
export function isOverlayVisibleAt(clip, tOut) {
  if (!clip) return false;
  const t = Number(tOut);
  if (!Number.isFinite(t)) return false;
  const start = Number(clip.start);
  const end = Number(clip.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return t >= start && t <= end;
}

// Overlays visible at output time t (same domain as clip start/end and the
// export `between()` enables). Sorted by start for deterministic painting.
export function visibleOverlaysAt(project, tOut) {
  if (!project || !Array.isArray(project.clips)) return [];
  return project.clips
    .filter(c => isOverlayVisibleAt(c, tOut))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

// Preview style contract for text overlays (pure + unit-tested).
// Text stays ONE LINE by default: `white-space: pre` performs no automatic
// wrapping (spaces preserved exactly), and only explicit newline characters
// create additional lines. Overflow stays visible so a long single line is
// fully shown instead of clipped (the export draws the full line with no
// width limit). Position, width, font size and alignment behavior are
// unchanged.
export function textPreviewStyle() {
  return {
    height: 'auto',
    whiteSpace: 'pre',
    overflow: 'visible'
  };
}

// Relationship of the playhead (OUTPUT seconds, same domain as clip
// start/end) to a clip. Powers the inspector readout that disambiguates
// near-miss alignment: on long videos at fit zoom, a sub-pixel gap between
// the playhead and a clip edge is invisible on the timeline, while the
// preview (correctly) hides the overlay. Pure + unit-tested.
export function clipPlayheadStatus(clip, tOut) {
  const t = Number(tOut) || 0;
  const start = Number(clip.start);
  const end = Number(clip.end);
  if (t < start) return { relation: 'before', delta: Math.round((start - t) * 1000) / 1000 };
  if (t > end) return { relation: 'after', delta: Math.round((t - end) * 1000) / 1000 };
  return { relation: 'inside', delta: 0 };
}

// ---- Overlay geometry helpers (fractions 0..1, pure + unit-tested) ----
// Used by preview drag/resize so the math (including clamping) is shared and
// verifiable. Clamping guarantees: no negative positions, box never leaves
// the frame, minimum 0.02 size.

export const GEO_MIN = 0.02;

function q4(value) {
  return Math.round(value * 1e4) / 1e4;
}

// Move a box by (dx, dy). constrainBox=true keeps the whole w×h box inside
// the frame (blur/image); false clamps only the anchor point 0..1 (text).
export function moveGeo(geo, dx, dy, constrainBox = true) {
  const w = Number(geo.w) || 0;
  const h = Number(geo.h) || 0;
  let x = Number(geo.x) + Number(dx);
  let y = Number(geo.y) + Number(dy);
  if (constrainBox) {
    x = Math.min(Math.max(0, x), Math.max(0, 1 - w));
    y = Math.min(Math.max(0, y), Math.max(0, 1 - h));
  } else {
    x = Math.min(1, Math.max(0, x));
    y = Math.min(1, Math.max(0, y));
  }
  return { x: q4(x), y: q4(y), w: geo.w, h: geo.h };
}

// Resize a box from a corner (nw/ne/sw/se) or edge (n/s/e/w) by (dx, dy).
// Supports both growing and shrinking, aspect-ratio preservation, minimum
// dimensions, and boundary clamping. The opposite anchor stays pinned.
export function resizeGeo(geo, handle, dx, dy, options = {}) {
  const sx = Number(geo.x);
  const sy = Number(geo.y);
  const sw = Number(geo.w);
  const sh = Number(geo.h);
  const minDim = (options && typeof options.minDim === 'number') ? options.minDim : GEO_MIN;
  const hKey = String(handle || '').toLowerCase();
  const validHandles = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w', 't', 'b', 'l', 'r'];
  if (!validHandles.includes(hKey)) throw new Error(`Unknown corner: ${handle}.`);

  const preserveAspect = !!(options && options.preserveAspect);
  const aspect = (options && typeof options.aspect === 'number' && options.aspect > 0)
    ? options.aspect
    : (sh > 0 ? sw / sh : 1);

  let { x, y, w, h } = { x: sx, y: sy, w: sw, h: sh };

  if (preserveAspect) {
    if (hKey === 'se') {
      const maxW = Math.min(1 - sx, (1 - sy) * aspect);
      const effDelta = Math.abs(dx) >= Math.abs(dy * aspect) ? dx : dy * aspect;
      w = Math.max(minDim, Math.min(maxW, sw + effDelta));
      h = w / aspect;
    } else if (hKey === 'nw') {
      const maxW = Math.min(sx + sw, (sy + sh) * aspect);
      const effDelta = Math.abs(-dx) >= Math.abs(-dy * aspect) ? -dx : -dy * aspect;
      w = Math.max(minDim, Math.min(maxW, sw + effDelta));
      h = w / aspect;
      x = (sx + sw) - w;
      y = (sy + sh) - h;
    } else if (hKey === 'ne') {
      const maxW = Math.min(1 - sx, (sy + sh) * aspect);
      const effDelta = Math.abs(dx) >= Math.abs(-dy * aspect) ? dx : -dy * aspect;
      w = Math.max(minDim, Math.min(maxW, sw + effDelta));
      h = w / aspect;
      y = (sy + sh) - h;
    } else if (hKey === 'sw') {
      const maxW = Math.min(sx + sw, (1 - sy) * aspect);
      const effDelta = Math.abs(-dx) >= Math.abs(dy * aspect) ? -dx : dy * aspect;
      w = Math.max(minDim, Math.min(maxW, sw + effDelta));
      h = w / aspect;
      x = (sx + sw) - w;
    } else if (hKey === 'e' || hKey === 'r') {
      const maxW = Math.min(1 - sx, (1 - sy) * aspect);
      w = Math.max(minDim, Math.min(maxW, sw + Number(dx)));
      h = w / aspect;
    } else if (hKey === 'w' || hKey === 'l') {
      const maxW = Math.min(sx + sw, (1 - sy) * aspect);
      w = Math.max(minDim, Math.min(maxW, sw - Number(dx)));
      h = w / aspect;
      x = (sx + sw) - w;
    } else if (hKey === 's' || hKey === 'b') {
      const maxH = Math.min(1 - sy, (1 - sx) / aspect);
      h = Math.max(minDim, Math.min(maxH, sh + Number(dy)));
      w = h * aspect;
    } else if (hKey === 'n' || hKey === 't') {
      const maxH = Math.min(sy + sh, (1 - sx) / aspect);
      h = Math.max(minDim, Math.min(maxH, sh - Number(dy)));
      w = h * aspect;
      y = (sy + sh) - h;
    }
  } else {
    if (hKey === 'nw' || hKey === 'sw' || hKey === 'w' || hKey === 'l') {
      x = Math.min(sx + sw - minDim, Math.max(0, sx + Number(dx)));
      w = sx + sw - x;
    }
    if (hKey === 'ne' || hKey === 'se' || hKey === 'e' || hKey === 'r') {
      w = Math.max(minDim, Math.min(1 - sx, sw + Number(dx)));
    }
    if (hKey === 'nw' || hKey === 'ne' || hKey === 'n' || hKey === 't') {
      y = Math.min(sy + sh - minDim, Math.max(0, sy + Number(dy)));
      h = sy + sh - y;
    }
    if (hKey === 'sw' || hKey === 'se' || hKey === 's' || hKey === 'b') {
      h = Math.max(minDim, Math.min(1 - sy, sh + Number(dy)));
    }
  }

  return { x: q4(x), y: q4(y), w: q4(w), h: q4(h) };
}

// Clamp a text anchor so the box stays inside the frame. Text has no stored
// width: callers pass the ACTUAL rendered box size in fractions (measured
// from the live preview element, so long single lines and multi-line text
// count exactly). The anchor range is [0, 1-size]; a box wider/taller than
// the frame pins to 0 so its start stays visible (matching export, which
// also clips at the frame edge). Pure + unit-tested.
export function clampTextToFrame(x, y, wFrac, hFrac) {
  const sx = Number(x);
  const sy = Number(y);
  const w = Number(wFrac);
  const h = Number(hFrac);
  const bw = Number.isFinite(w) && w > 0 ? w : 0;
  const bh = Number.isFinite(h) && h > 0 ? h : 0;
  const cx = Number.isFinite(sx) ? sx : 0;
  const cy = Number.isFinite(sy) ? sy : 0;
  return {
    x: q4(Math.min(Math.max(0, 1 - bw), Math.max(0, cx))),
    y: q4(Math.min(Math.max(0, 1 - bh), Math.max(0, cy)))
  };
}

// Shrink-to-fit scale for text: how much a textW×textH block (measured at
// the base font size) must shrink to fit availW×availH. Returns 1 when it
// already fits; 0..1 otherwise. Invalid/empty inputs mean "no info" → 1
// (never hide or blow up text). Pure + unit-tested.
export function fitTextScale(textW, textH, availW, availH) {
  const tw = Number(textW);
  const th = Number(textH);
  const aw = Number(availW);
  const ah = Number(availH);
  if (!(tw > 0) || !(th > 0) || !(aw > 0) || !(ah > 0)) return 1;
  return Math.min(1, aw / tw, ah / th);
}

// ---- Video/audio media tracks ----
// Clips reference project.files entries by id and map [sourceIn, sourceOut]
// onto the timeline at `start`. Gain is 0..2 (100% = original). Video clips
// must not overlap; audio clips may overlap freely.

function mediaDur(c) {
  return Math.round((c.sourceOut - c.sourceIn) * 1000) / 1000;
}

// Neighbouring video clips around a timeline position (excluding ignoreId),
// for overlap-safe moves/trims. Returns { prevEnd, nextStart } in output sec.
function videoNeighbours(project, ignoreId, start, end) {
  let prevEnd = 0;
  let nextStart = Infinity;
  for (const c of project.videoClips) {
    if (c.id === ignoreId) continue;
    const cs = c.start;
    const ce = mediaEnd(c);
    if (ce <= start + 1e-9) prevEnd = Math.max(prevEnd, ce);
    else if (cs >= end - 1e-9) nextStart = Math.min(nextStart, cs);
    else return { overlap: true };
  }
  return { prevEnd, nextStart };
}

function assertNoVideoOverlap(project, ignoreId, start, end) {
  const n = videoNeighbours(project, ignoreId, start, end);
  if (n.overlap) throw new Error('Video clips must not overlap; move or trim them apart.');
  return n;
}

// Append a full-range clip of a file at the timeline position. Returns the clip.
export function appendMediaClip(project, fileId, start = null, gain = 1) {
  const file = getMediaFile(project, fileId);
  if (!file) throw new Error('Media file not found.');
  const isVideo = file.kind === 'video';
  const list = isVideo ? project.videoClips : project.audioClips;
  const cap = isVideo ? PROJECT_MAX_VIDEO_CLIPS : PROJECT_MAX_AUDIO_CLIPS;
  if (list.length >= cap) throw new Error(`Too many ${file.kind} clips.`);
  
  let targetStart = start !== null && start !== undefined ? Number(start) : contentEnd(project);
  if (!Number.isFinite(targetStart) || targetStart < 0) {
    targetStart = contentEnd(project);
  }

  const clip = {
    id: newId(isVideo ? 'v' : 'm'),
    type: isVideo ? 'video' : 'audio',
    file: fileId,
    sourceIn: 0,
    sourceOut: file.duration,
    start: targetStart,
    gain: clampGain(gain),
    volumeDb: 0,
    fadeIn: 0,
    fadeOut: 0,
    crop: null
  };
  if (!isVideo) {
    // Audio may overlap: inserted at playhead, draggable anywhere.
  } else {
    clip.start = findFirstFreeVideoStart(project, clip.sourceOut - clip.sourceIn, targetStart);
    assertNoVideoOverlap(project, clip.id, clip.start, clip.start + (clip.sourceOut - clip.sourceIn));
  }
  list.push(clip);
  project.selectedId = clip.id;
  return clip;
}

// Split a video clip at output time t (strict interior). Returns [a, b].
export function splitVideoClipAt(project, id, t) {
  const idx = project.videoClips.findIndex(c => c.id === id);
  if (idx === -1) throw new Error('Video clip not found.');
  if (project.videoClips.length >= PROJECT_MAX_VIDEO_CLIPS) throw new Error('Too many video clips.');
  const src = project.videoClips[idx];
  const time = clampTime(Number(t), 0, contentEnd(project));
  if (!(time > src.start + 0.05 && time < mediaEnd(src) - 0.05)) {
    throw new Error('Split point must be inside the clip (away from its edges).');
  }
  const cutSrc = clampTime(src.sourceIn + (time - src.start), src.sourceIn, src.sourceOut);
  const a = { ...src, id: newId('v'), sourceOut: cutSrc };
  const b = { ...src, id: newId('v'), sourceIn: cutSrc, start: time };
  project.videoClips.splice(idx, 1, a, b);
  project.selectedId = b.id;
  return [a, b];
}

// Split an audio clip at output time t (strict interior). Returns [a, b].
// Mirrors splitVideoClipAt: the source range is divided proportionally so
// both halves keep exact timing (a ends at t, b starts at t) and properties.
// Halves shorter than 0.1s are rejected so both halves stay export-valid.
export function splitAudioClipAt(project, id, t) {
  const idx = project.audioClips.findIndex(c => c.id === id);
  if (idx === -1) throw new Error('Audio clip not found.');
  if (project.audioClips.length >= PROJECT_MAX_AUDIO_CLIPS) throw new Error('Too many audio clips.');
  const src = project.audioClips[idx];
  const time = clampTime(Number(t), 0, contentEnd(project));
  const end = mediaEnd(src);
  if (!(time > src.start + 0.05 && time < end - 0.05)) {
    throw new Error('Split point must be inside the clip (away from its edges).');
  }
  if (spanMs(src.start, time) < 100 || spanMs(time, end) < 100) {
    throw new Error('Split would create a clip shorter than 0.1s.');
  }
  const cutSrc = clampTime(src.sourceIn + (time - src.start), src.sourceIn, src.sourceOut);
  // split:true marks split-generated halves so deleting a video segment can
  // cascade to exactly its own items (independent clips never carry it).
  const a = { ...src, id: newId('m'), sourceOut: cutSrc, split: true };
  const b = { ...src, id: newId('m'), sourceIn: cutSrc, start: time, split: true };
  project.audioClips.splice(idx, 1, a, b);
  project.selectedId = b.id;
  return [a, b];
}

// Split an overlay clip (blur/text/image) at output time t (strict
// interior). Returns [a, b]: a keeps [start, t], b keeps [t, end], all other
// properties (mode/text/geometry/colors/file) copied verbatim. Halves
// shorter than 0.1s are rejected so both halves stay export-valid.
export function splitOverlayClipAt(project, id, t) {
  const idx = project.clips.findIndex(c => c.id === id);
  if (idx === -1) throw new Error('Clip not found.');
  if (project.clips.length >= PROJECT_MAX_CLIPS) throw new Error('Too many clips (max 24).');
  const src = project.clips[idx];
  const time = clampTime(Number(t), 0, outputDuration(project));
  if (!(time > src.start && time < src.end)) {
    throw new Error('Split point must be inside the clip (away from its edges).');
  }
  if (spanMs(src.start, time) < 100 || spanMs(time, src.end) < 100) {
    throw new Error('Split would create a clip shorter than 0.1s.');
  }
  // split:true marks split-generated halves so deleting a video segment can
  // cascade to exactly its own items (independent clips never carry it).
  // Video overlays additionally split their source range like audio halves.
  const a = { ...src, id: newId(overlayIdPrefix(src.type)), end: time, split: true };
  const b = { ...src, id: newId(overlayIdPrefix(src.type)), start: time, split: true };
  if (src.type === 'voverlay') {
    b.sourceIn = Math.round(((src.sourceIn || 0) + (time - src.start)) * 1000) / 1000;
  }
  project.clips.splice(idx, 1, a, b);
  project.selectedId = b.id;
  return [a, b];
}

// Extend a blur/text/image overlay to the end of the video segment under its
// start (keeps split-generated items associated with their own segment).
// Start is unchanged; end becomes the segment end. Audio clips and other
// segments' items are untouched. Returns { extended, clip }; already at the
// segment end is a no-op ({ extended: false }). Throws when the clip is
// missing/not an overlay, when no video segment contains its start, or when
// the resulting span would be invalid (<0.1s). Pure + unit-tested.
export function extendOverlayToVideoEnd(project, id) {
  const clip = getClip(project, id);
  if (!clip) throw new Error('Clip not found.');
  if (clip.type !== 'blur' && clip.type !== 'text' && clip.type !== 'image' && clip.type !== 'voverlay' && clip.type !== 'zoom') {
    throw new Error('Only blur, text, image, video-overlay and zoom clips can extend to the video end.');
  }
  const seg = project.videoClips.find(c => clip.start >= c.start && clip.start < mediaEnd(c));
  if (!seg) throw new Error('No video segment under the clip start.');
  const segEnd = Math.round(mediaEnd(seg) * 1000) / 1000;
  if (Math.round((segEnd - clip.end) * 1000) <= 0) return { extended: false, clip };
  if (spanMs(clip.start, segEnd) < 100) {
    throw new Error('Clip start is too close to the video end to extend.');
  }
  clip.end = segEnd;
  return { extended: true, clip };
}

// Split EVERYTHING spanning output time t: video clip(s), audio clip(s) and
// blur/text/image overlays. Clips fully before/after t are untouched; a clip
// whose halves would be invalid (<0.1s) or exceed caps is skipped rather
// than failing the whole split. Returns { videos, audios, overlays,
// didSplit }. Never throws for "nothing to split" (didSplit === false).
export function splitAtPlayhead(project, t) {
  const time = clampTime(Number(t), 0, contentEnd(project));
  const videos = [];
  const audios = [];
  const overlays = [];
  for (const c of [...project.videoClips]) {
    const end = mediaEnd(c);
    if (time > c.start + 0.05 && time < end - 0.05) {
      try {
        const pair = splitVideoClipAt(project, c.id, time);
        videos.push(pair);
      } catch {}
    }
  }
  for (const c of [...project.audioClips]) {
    const end = mediaEnd(c);
    if (time > c.start + 0.05 && time < end - 0.05 &&
        spanMs(c.start, time) >= 100 && spanMs(time, end) >= 100) {
      try {
        const pair = splitAudioClipAt(project, c.id, time);
        audios.push(pair);
      } catch {}
    }
  }
  for (const c of [...project.clips]) {
    if (time > c.start && time < c.end &&
        spanMs(c.start, time) >= 100 && spanMs(time, c.end) >= 100) {
      try {
        const pair = splitOverlayClipAt(project, c.id, time);
        overlays.push(pair);
      } catch {}
    }
  }
  return { videos, audios, overlays, didSplit: (videos.length + audios.length + overlays.length) > 0 };
}

// Move a video clip body; clamps into the free gap (no overlaps) at/after 0.
export function moveVideoClip(project, id, newStart) {
  const clip = project.videoClips.find(c => c.id === id);
  if (!clip) throw new Error('Video clip not found.');
  const dur = mediaDur(clip);
  const start = clampTime(Number(newStart), 0, Number.MAX_SAFE_INTEGER);
  // Robust pass: clamp into the free gap containing the request.
  const bounds = freeVideoGap(project, id, dur, start);
  clip.start = clampTime(start, bounds.lo, bounds.hi);
  return clip;
}

// Free gap around a requested position for a clip of duration dur:
// the widest [lo, hi] start-range containing `want` with no overlaps.
function freeVideoGap(project, ignoreId, dur, want) {
  const segs = project.videoClips
    .filter(c => c.id !== ignoreId)
    .map(c => ({ s: c.start, e: mediaEnd(c) }))
    .sort((a, b) => a.s - b.s);
  let lo = 0;
  let hi = Infinity;
  for (const g of segs) {
    if (g.e <= want + 1e-9) {
      lo = Math.max(lo, g.e);
    } else if (g.s >= want + dur - 1e-9) {
      hi = Math.min(hi, g.s - dur);
      break;
    } else {
      // Requested span intersects this segment: pin to the closer side.
      const snapLeft = g.s - dur;
      const snapRight = g.e;
      if (Math.abs(want - snapLeft) <= Math.abs(want - snapRight)) hi = Math.min(hi, snapLeft);
      else lo = Math.max(lo, snapRight);
    }
  }
  if (!Number.isFinite(hi)) hi = Math.max(lo, want);
  if (hi < lo) {
    // No free gap fits: keep the clip where it is (caller clamps to current).
    const cur = project.videoClips.find(c => c.id === ignoreId);
    const cs = cur ? cur.start : lo;
    lo = cs;
    hi = cs;
  }
  return { lo, hi };
}

// Trim a video clip source edge. Edge 'start'|'end' adjusts sourceIn/out;
// the timeline start stays fixed, duration follows (clamped to neighbours).
export function trimVideoClip(project, id, edge, sourceT) {
  const clip = project.videoClips.find(c => c.id === id);
  if (!clip) throw new Error('Video clip not found.');
  const file = getMediaFile(project, clip.file);
  if (!file) throw new Error('Media file not found.');
  const t = clampTime(Number(sourceT), 0, file.duration);
  if (edge === 'start') {
    const next = nextVideoStart(project, id, clip.start);
    const maxEnd = Number.isFinite(next) ? next : Infinity;
    // end = start + (sourceOut - newIn) must fit before next.
    let lo = Math.max(0, clip.sourceOut - (maxEnd - clip.start));
    let newIn = clampTime(t, lo, clip.sourceOut - PROJECT_MIN_SPAN);
    if (spanMs(newIn, clip.sourceOut) < 100) newIn = clampTime(clip.sourceOut - PROJECT_MIN_SPAN - 0.001, lo, clip.sourceOut);
    clip.sourceIn = Math.round(newIn * 1000) / 1000;
  } else if (edge === 'end') {
    const next = nextVideoStart(project, id, clip.start);
    const maxEnd = Number.isFinite(next) ? next : Infinity;
    const hi = Math.min(file.duration, clip.sourceIn + (maxEnd - clip.start));
    let newOut = clampTime(t, clip.sourceIn + PROJECT_MIN_SPAN, Math.max(clip.sourceIn + PROJECT_MIN_SPAN, hi));
    if (spanMs(clip.sourceIn, newOut) < 100) newOut = clip.sourceIn + PROJECT_MIN_SPAN + 0.001;
    clip.sourceOut = Math.round(newOut * 1000) / 1000;
  } else {
    throw new Error(`Unknown edge: ${edge}.`);
  }
  return clip;
}

function nextVideoStart(project, ignoreId, start) {
  let next = Infinity;
  for (const c of project.videoClips) {
    if (c.id === ignoreId) continue;
    if (c.start >= start - 1e-9 && c.start < next) next = c.start;
  }
  return next;
}

// Millisecond-safe containment: [aStart, aEnd] inside [bStart, bEnd].
function spanWithin(aStart, aEnd, bStart, bEnd) {
  return Math.round((aStart - bStart) * 1000) >= 0 && Math.round((bEnd - aEnd) * 1000) >= 0;
}

export function deleteVideoClip(project, id, removed) {
  const idx = project.videoClips.findIndex(c => c.id === id);
  if (idx === -1) return false;
  const seg = project.videoClips[idx];
  const segStart = seg.start;
  const segEnd = mediaEnd(seg);
  project.videoClips.splice(idx, 1);
  if (project.selectedId === id) project.selectedId = null;
  // Cascade to split-generated items belonging to this segment: flagged
  // audio/overlay clips fully contained in the removed span. Independent
  // clips (no flag) and moved-out items are never touched.
  const take = Array.isArray(removed) ? removed : null;
  project.audioClips = project.audioClips.filter(c => {
    const keep = !(c.split === true && spanWithin(c.start, mediaEnd(c), segStart, segEnd));
    if (!keep) {
      if (take) take.push({ kind: 'audio', id: c.id });
      if (project.selectedId === c.id) project.selectedId = null;
    }
    return keep;
  });
  project.clips = project.clips.filter(c => {
    const keep = !(c.split === true && spanWithin(c.start, c.end, segStart, segEnd));
    if (!keep) {
      if (take) take.push({ kind: c.type, id: c.id });
      if (project.selectedId === c.id) project.selectedId = null;
    }
    return keep;
  });
  return true;
}

export function duplicateVideoClip(project, id) {
  const src = project.videoClips.find(c => c.id === id);
  if (!src) throw new Error('Video clip not found.');
  if (project.videoClips.length >= PROJECT_MAX_VIDEO_CLIPS) throw new Error('Too many video clips.');
  const copy = { ...src, id: newId('v'), start: contentEnd(project) };
  project.videoClips.push(copy);
  project.selectedId = copy.id;
  return copy;
}

// ---- Audio clips (overlap allowed; otherwise same shape as video) ----
export function moveAudioClip(project, id, newStart) {
  const clip = project.audioClips.find(c => c.id === id);
  if (!clip) throw new Error('Audio clip not found.');
  clip.start = clampTime(Number(newStart), 0, Number.MAX_SAFE_INTEGER);
  return clip;
}

export function trimAudioClip(project, id, edge, sourceT) {
  const clip = project.audioClips.find(c => c.id === id);
  if (!clip) throw new Error('Audio clip not found.');
  const file = getMediaFile(project, clip.file);
  if (!file) throw new Error('Media file not found.');
  const t = clampTime(Number(sourceT), 0, file.duration);
  if (edge === 'start') {
    let newIn = clampTime(t, 0, clip.sourceOut - PROJECT_MIN_SPAN);
    if (spanMs(newIn, clip.sourceOut) < 100) newIn = clampTime(clip.sourceOut - PROJECT_MIN_SPAN - 0.001, 0, clip.sourceOut);
    clip.sourceIn = Math.round(newIn * 1000) / 1000;
  } else if (edge === 'end') {
    let newOut = clampTime(t, clip.sourceIn + PROJECT_MIN_SPAN, file.duration);
    if (spanMs(clip.sourceIn, newOut) < 100) newOut = clip.sourceIn + PROJECT_MIN_SPAN + 0.001;
    clip.sourceOut = Math.round(newOut * 1000) / 1000;
  } else {
    throw new Error(`Unknown edge: ${edge}.`);
  }
  return clip;
}

export function deleteAudioClip(project, id) {
  const idx = project.audioClips.findIndex(c => c.id === id);
  if (idx === -1) return false;
  project.audioClips.splice(idx, 1);
  if (project.selectedId === id) project.selectedId = null;
  return true;
}

export function duplicateAudioClip(project, id) {
  const src = project.audioClips.find(c => c.id === id);
  if (!src) throw new Error('Audio clip not found.');
  if (project.audioClips.length >= PROJECT_MAX_AUDIO_CLIPS) throw new Error('Too many audio clips.');
  const copy = { ...src, id: newId('m'), start: contentEnd(project) };
  project.audioClips.push(copy);
  project.selectedId = copy.id;
  return copy;
}

export function setMediaGain(project, kind, id, gain) {
  const list = kind === 'video' ? project.videoClips : kind === 'audio' ? project.audioClips : null;
  if (!list) throw new Error('Kind must be "video" or "audio".');
  const clip = list.find(c => c.id === id);
  if (!clip) throw new Error('Clip not found.');
  const n = Number(gain);
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error('Gain must be between 0 and 2 (100% = original).');
  clip.gain = Math.round(n * 1000) / 1000;
  return clip;
}

export function setMediaVolumeDb(project, kind, id, volumeDb) {
  const list = kind === 'video' ? project.videoClips : kind === 'audio' ? project.audioClips : null;
  if (!list) throw new Error('Kind must be "video" or "audio".');
  const clip = list.find(c => c.id === id);
  if (!clip) throw new Error('Clip not found.');
  const n = Number(volumeDb);
  if (!Number.isFinite(n) || n < -60 || n > 24) throw new Error('Volume Db must be between -60 and 24.');
  clip.volumeDb = Math.round(n);
  return clip;
}

// Greedy interval-graph row packing so overlapping clips of one logical
// track stack into visual sub-rows: [{id,start,end}] -> {rows: Map, rowCount}.
export function layoutSubRows(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const rowEnds = [];
  const rows = new Map();
  for (const it of sorted) {
    let r = -1;
    for (let i = 0; i < rowEnds.length; i++) {
      if (it.start >= rowEnds[i]) { r = i; break; }
    }
    if (r === -1) { r = rowEnds.length; rowEnds.push(0); }
    rowEnds[r] = it.end;
    rows.set(it.id, r);
  }
  return { rows, rowCount: rowEnds.length };
}

// Active video clip at output time t (null inside gaps).
export function activeVideoClipAt(project, t) {
  for (const c of project.videoClips) {
    if (t >= c.start && t < mediaEnd(c)) return c;
  }
  return null;
}

export function getZoomState(clip, t) {
  const start = clip.start;
  const end = clip.end;
  const dur = end - start;
  const level = Number(clip.level || 1.5);
  const trans = Math.min(Number(clip.transition === undefined ? 0.5 : clip.transition), dur / 2);
  const easing = normalizeZoomEasing(clip.easing);

  let currentLevel = 1.0;
  if (t < start || t > end) {
    currentLevel = 1.0;
  } else if (t < start + trans && trans > 0) {
    const frac = (t - start) / trans;
    currentLevel = 1.0 + (level - 1.0) * easeZoomRamp(frac, easing);
  } else if (t > end - trans && trans > 0) {
    const frac = (end - t) / trans;
    currentLevel = 1.0 + (level - 1.0) * easeZoomRamp(frac, easing);
  } else {
    currentLevel = level;
  }

  // Clamped target center to prevent black margins
  const minFrac = currentLevel > 1 ? 0.5 / currentLevel : 0.5;
  const maxFrac = currentLevel > 1 ? 1 - 0.5 / currentLevel : 0.5;
  
  const targetX = clip.x === undefined ? 0.5 : clip.x;
  const targetY = clip.y === undefined ? 0.5 : clip.y;

  const currentX = Math.min(maxFrac, Math.max(minFrac, targetX));
  const currentY = Math.min(maxFrac, Math.max(minFrac, targetY));

  return { level: currentLevel, x: currentX, y: currentY };
}
