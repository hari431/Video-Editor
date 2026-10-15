// src/library/video-editor.js — Local-only Admin/Owner video editor helpers.
//
// SCOPE: this module is PURE (no fs, no child_process, no ffmpeg execution).
// It validates edit specs and builds deterministic ffmpeg argument lists.
// Execution lives in src/server.js and is gated by isVideoEditorAvailable():
//   - available unless VIDEO_EDITOR_ENABLED=false; production must install FFmpeg
//     (Render uses apt.txt) and can disable the editor with the same flag.
//
// Design notes:
// - Input is always an ADMIN-SELECTED LOCAL FILE (browser <input type=file>),
//   never a library path — so there is no path traversal surface and library
//   originals (queries/) are untouched by construction. Export always writes a
//   NEW temp file that is streamed back as a download; nothing is persisted.
// - Positions/sizes are fractions (0..1) of the client-reported video frame so
//   the server never needs ffprobe; they are converted to pixels here using the
//   declared videoWidth/videoHeight (validated bounds).
// - V1 caps: 1 trim, <=3 blur/mask rects, <=3 texts, <=1 image overlay.

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const EDITOR_INPUT_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv']);
export const EDITOR_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
export const EDITOR_OUTPUT_EXTENSION = '.mp4';

export const EDITOR_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const EDITOR_MAX_IMAGE_FILES = 4;
export const EDITOR_MAX_SPEC_BYTES = 100 * 1024;
export const EDITOR_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
export const EDITOR_MAX_AUDIO_BYTES = 200 * 1024 * 1024;
export const EDITOR_MAX_AUDIO_FILES = 8;
// Video upload cap: VIDEO_EDITOR_MAX_VIDEO_MB (default 2048 MB = 2 GB).
// Centralized here so the EJS label, client pre-check, and server-side
// multipart validation all enforce the same value. Never unlimited: the
// ceiling exists because the server buffers the whole upload in memory.
export const EDITOR_DEFAULT_MAX_VIDEO_MB = 2048;
export const EDITOR_MAX_VIDEO_MB_CEILING = 8192;
const EDITOR_MB = 1024 * 1024;

// Parse VIDEO_EDITOR_MAX_VIDEO_MB (positive integer MB). Garbage/zero/
// negative values fall back to the default; oversized values clamp to the
// ceiling. Accepts an env-like object so tests can inject values.
export function editorMaxVideoMb(env = process.env) {
  const configured = env?.VIDEO_EDITOR_MAX_VIDEO_MB;
  if (configured === undefined || configured === null || String(configured).trim() === '') {
    // Render buffers multipart uploads before processing. Keep production
    // uploads conservative by default; local development retains the 2 GB cap.
    return env?.NODE_ENV === 'production' ? 100 : EDITOR_DEFAULT_MAX_VIDEO_MB;
  }
  const raw = Number(configured);
  if (!Number.isFinite(raw)) return env?.NODE_ENV === 'production' ? 100 : EDITOR_DEFAULT_MAX_VIDEO_MB;
  const mb = Math.floor(raw);
  if (mb < 1) return env?.NODE_ENV === 'production' ? 100 : EDITOR_DEFAULT_MAX_VIDEO_MB;
  return Math.min(mb, EDITOR_MAX_VIDEO_MB_CEILING);
}

export function editorMaxVideoBytes(env = process.env) {
  return editorMaxVideoMb(env) * EDITOR_MB;
}

// Request cap = worst-case multi-track upload: max video files at the video
// cap each, max audio files at the audio cap, max images, plus headroom for
// spec JSON and multipart framing. The route additionally rejects oversized
// Content-Length before reading a byte. Local-only uploads are buffered in
// server memory, so plan free RAM ≈ upload size.
export function editorMaxRequestBytes(env = process.env) {
  const calculated = (
    EDITOR_MAX_VIDEO_FILES * editorMaxVideoBytes(env) +
    EDITOR_MAX_AUDIO_FILES * EDITOR_MAX_AUDIO_BYTES +
    EDITOR_MAX_IMAGE_FILES * EDITOR_MAX_IMAGE_BYTES +
    64 * EDITOR_MB
  );
  // Render web processes have limited memory; cap aggregate multipart data
  // because this route buffers uploads before invoking FFmpeg.
  return env?.NODE_ENV === 'production' ? Math.min(calculated, 350 * EDITOR_MB) : calculated;
}
export const EDITOR_MAX_BLURS = 64;
export const EDITOR_MAX_TEXTS = 64;
export const EDITOR_MAX_IMAGES = 64;
// Multi-track (spec version 2) caps. High enough to feel unlimited for an
// admin redaction workflow; bounded so one render cannot explode the filter
// graph or the buffered multipart upload.
export const EDITOR_MAX_VIDEO_FILES = 4;
export const EDITOR_MAX_VIDEO_CLIPS = 32;
export const EDITOR_MAX_AUDIO_CLIPS = 32;
export const EDITOR_PROJECT_FPS = 30;
export const EDITOR_MAX_TIME_SECONDS = 7200;
export const EDITOR_FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

// Burned-in brand watermark for editor exports. Absent by default (existing
// projects/specs export exactly as before). Text, size, color and opacity
// are editable; unspecified fields fall back to the defaults below so older
// specs (enabled/position only) keep rendering identically.
// Positions: 1 = Bottom-right (default), 2 = Top-left, 3 = Center,
// 4 = Top-right, 5 = Bottom-left.
export const EDITOR_WATERMARK_TEXT = 'Learn with me';
export const EDITOR_WATERMARK_SIZE_FRAC = 0.045;
export const EDITOR_WATERMARK_COLOR = '#FFFFFF';
export const EDITOR_WATERMARK_OPACITY = 75;
export const EDITOR_WATERMARK_POSITIONS = [
  { id: 1, label: 'Bottom-right' },
  { id: 2, label: 'Top-left' },
  { id: 3, label: 'Center' },
  { id: 4, label: 'Top-right' },
  { id: 5, label: 'Bottom-left' }
];
export const EDITOR_WATERMARK_DEFAULT_POSITION = 1;
export const EDITOR_WATERMARK_MIN_SIZE_FRAC = 0.02;
export const EDITOR_WATERMARK_MAX_SIZE_FRAC = 0.25;
export const EDITOR_WATERMARK_MAX_TEXT = 200;
// Margin fraction of the frame mirrors the client preview constant
// (see WATERMARK_MARGIN_FRAC in video-editor-project.js).
export const EDITOR_WATERMARK_MARGIN_FRAC = 0.02;

export function isValidWatermarkPosition(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

// Normalize the optional `watermark` spec key. Absent/null → OFF (default,
// preserves existing projects). A bare boolean toggles with all defaults.
// An object enables by default unless `enabled: false` is explicit; missing
// text/size/color/opacity fall back to the defaults above.
export function normalizeEditorWatermark(raw) {
  if (raw === undefined || raw === null) {
    return {
      enabled: false,
      position: EDITOR_WATERMARK_DEFAULT_POSITION,
      text: EDITOR_WATERMARK_TEXT,
      size: EDITOR_WATERMARK_SIZE_FRAC,
      color: EDITOR_WATERMARK_COLOR,
      opacity: EDITOR_WATERMARK_OPACITY
    };
  }
  if (typeof raw === 'boolean') {
    return {
      enabled: raw,
      position: EDITOR_WATERMARK_DEFAULT_POSITION,
      text: EDITOR_WATERMARK_TEXT,
      size: EDITOR_WATERMARK_SIZE_FRAC,
      color: EDITOR_WATERMARK_COLOR,
      opacity: EDITOR_WATERMARK_OPACITY
    };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const enabled = raw.enabled === undefined || raw.enabled === null ? true : raw.enabled;
  if (typeof enabled !== 'boolean') return null;
  const position = raw.position === undefined || raw.position === null
    ? EDITOR_WATERMARK_DEFAULT_POSITION
    : Number(raw.position);
  if (!isValidWatermarkPosition(position)) return null;
  const text = raw.text === undefined || raw.text === null
    ? EDITOR_WATERMARK_TEXT
    : String(raw.text).replace(/\s+/g, ' ').trim();
  if (!text || text.length > EDITOR_WATERMARK_MAX_TEXT) return null;
  const size = raw.size === undefined || raw.size === null || String(raw.size).trim() === ''
    ? EDITOR_WATERMARK_SIZE_FRAC
    : Number(raw.size);
  if (!Number.isFinite(size) || size < EDITOR_WATERMARK_MIN_SIZE_FRAC || size > EDITOR_WATERMARK_MAX_SIZE_FRAC) return null;
  const color = raw.color === undefined || raw.color === null || String(raw.color).trim() === ''
    ? EDITOR_WATERMARK_COLOR
    : normalizeEditorColor(raw.color);
  if (!color) return null;
  const opacity = raw.opacity === undefined || raw.opacity === null || String(raw.opacity).trim() === ''
    ? EDITOR_WATERMARK_OPACITY
    : Number(raw.opacity);
  if (!Number.isInteger(opacity) || opacity < 1 || opacity > 100) return null;
  const motion = raw.motion === undefined || raw.motion === null ? 'none' : String(raw.motion);
  if (!['none', 'left-to-right', 'right-to-left'].includes(motion)) return null;
  const speed = raw.speed === undefined || raw.speed === null || String(raw.speed).trim() === '' ? 80 : Number(raw.speed);
  if (!Number.isFinite(speed) || speed < 10 || speed > 500) return null;
  return { enabled, position, text, size, color, opacity, motion, speed };
}

// Export quality/resolution selector. `height` is the target output height
// in pixels (width follows the aspect ratio); null = Original (no scaling).
// Labels carry the full dimensions for 2K+ so the UI reads
// "2K (2560x1440)" etc. while ids stay short for spec/FormData transport.
export const EDITOR_EXPORT_RESOLUTIONS = [
  { id: 'original', label: 'Original', height: null },
  { id: '480p', label: '480p', height: 480 },
  { id: '720p', label: '720p', height: 720 },
  { id: '1080p', label: '1080p', height: 1080 },
  { id: '2k', label: '2K (2560x1440)', height: 1440 },
  { id: '4k', label: '4K (3840x2160)', height: 2160 },
  { id: '8k', label: '8K (7680x4320)', height: 4320 }
];

// Normalize a client/supplied resolution value to an
// EDITOR_EXPORT_RESOLUTIONS entry. Accepts ids ('720p', '2k'), bare heights
// (720, '720'), and 'original'/null/undefined/'' (= Original). Returns the
// entry or null when the value is not a known resolution.
export function normalizeExportResolution(value) {
  if (value === null || value === undefined) return EDITOR_EXPORT_RESOLUTIONS[0];
  const t = String(value).trim().toLowerCase();
  if (t === '' || t === 'original' || t === 'null' || t === 'none') return EDITOR_EXPORT_RESOLUTIONS[0];
  for (const r of EDITOR_EXPORT_RESOLUTIONS) {
    if (t === r.id || t === r.label.toLowerCase()) return r;
  }
  const digits = t.replace(/[^0-9]/g, '');
  if (digits !== '') {
    const num = Number(digits);
    if (Number.isFinite(num)) {
      const hit = EDITOR_EXPORT_RESOLUTIONS.find(r => r.height === num);
      if (hit) return hit;
    }
  }
  return null;
}

// Height (px) for a resolution value, or null for Original. Returns
// undefined when the value is not a known resolution (caller rejects).
export function exportHeightForResolution(value) {
  const entry = normalizeExportResolution(value);
  if (!entry) return undefined;
  return entry.height;
}

// Local-only gate. Accepts an env-like object so tests can inject values;
// defaults to the real process.env.
export function isVideoEditorAvailable(env = process.env) {
  try {
    if (env && env.VIDEO_EDITOR_ENABLED === 'false') return false;
    // Available in production after FFmpeg is installed; deployments can
    // explicitly disable it with VIDEO_EDITOR_ENABLED=false.
    return true;
  } catch {
    return false;
  }
}

export function editorInputExtension(filename) {
  if (typeof filename !== 'string') return '';
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return '';
  return filename.slice(dot).toLowerCase();
}

export function isAllowedEditorInput(filename) {
  return EDITOR_INPUT_EXTENSIONS.has(editorInputExtension(filename));
}

export function isAllowedEditorImage(filename) {
  return EDITOR_IMAGE_EXTENSIONS.has(editorInputExtension(filename));
}

export function isAllowedEditorAudio(filename) {
  return EDITOR_AUDIO_EXTENSIONS.has(editorInputExtension(filename));
}

function toFiniteNumber(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function roundFrac(value) {
  return Math.round(value * 1e6) / 1e6;
}

export function normalizeEditorColor(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  const m = t.match(HEX_COLOR_RE);
  if (!m) return null;
  let hex = m[1].toUpperCase();
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return `#${hex}`;
}

function fail(error) {
  return { ok: false, error };
}

function checkTimeRange(startRaw, endRaw, label) {
  const start = toFiniteNumber(startRaw);
  const end = toFiniteNumber(endRaw);
  if (start === null || end === null) return { error: `${label}: start/end must be numbers.` };
  if (start < 0 || end < 0) return { error: `${label}: times must be >= 0.` };
  if (!(end > start)) return { error: `${label}: end must be after start.` };
  if (end > EDITOR_MAX_TIME_SECONDS) return { error: `${label}: end exceeds the 2h limit.` };
  // Integer-ms comparison: immune to binary float dust (10 - 9.9 is
  // 0.09999999999999964 in IEEE754), so model-accepted spans always validate.
  if (Math.round((end - start) * 1000) < 100) return { error: `${label}: range must be at least 0.1s.` };
  return { start: round3(start), end: round3(end) };
}

function checkFrac(value, label, { min = 0, max = 1, exclusiveMin = false } = {}) {
  const n = toFiniteNumber(value);
  if (n === null) return { error: `${label} must be a number.` };
  if (exclusiveMin ? !(n > min) : !(n >= min)) return { error: `${label} is out of range.` };
  if (!(n <= max)) return { error: `${label} is out of range.` };
  return { value: roundFrac(n) };
}

export function checkCrop(raw, label) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: `${label} must be an object.` };
  let left = toFiniteNumber(raw.left !== undefined ? raw.left : 0);
  let top = toFiniteNumber(raw.top !== undefined ? raw.top : 0);
  let right = toFiniteNumber(raw.right !== undefined ? raw.right : 1);
  let bottom = toFiniteNumber(raw.bottom !== undefined ? raw.bottom : 1);
  if (left === null || top === null || right === null || bottom === null) {
    return { error: `${label} coordinates must be numbers.` };
  }
  if (right <= left && left + right < 1 && top + bottom < 1) {
    right = 1 - right;
    bottom = 1 - bottom;
  }
  left = Math.max(0, Math.min(0.98, left));
  top = Math.max(0, Math.min(0.98, top));
  right = Math.max(left + 0.02, Math.min(1, right));
  bottom = Math.max(top + 0.02, Math.min(1, bottom));

  if (left <= 0.0001 && top <= 0.0001 && right >= 0.9999 && bottom >= 0.9999) {
    return { value: null };
  }
  return {
    value: {
      left: roundFrac(left),
      top: roundFrac(top),
      right: roundFrac(right),
      bottom: roundFrac(bottom)
    }
  };
}

// Overlay video tracks (picture-in-picture, V2 only) share these geometry
// rules. Each entry:
//   { file, x, y, w, h|null, start, end, sourceIn, crop|null }
// file = index among video-kind files (upload order). h omitted → aspect
// preserved. Overlay audio is never mixed (muted by construction).
export const EDITOR_MAX_VIDEO_OVERLAYS = 4;

function checkVideoOverlay(raw, label, videoCount) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${label} must be an object.` };
  const file = toFiniteNumber(raw.file);
  if (!Number.isInteger(file) || file < 0 || file >= videoCount) {
    return { error: `${label}.file must be a video file index (0–${Math.max(0, videoCount - 1)}).` };
  }
  const x = checkFrac(raw.x, `${label}.x`);
  if (x.error) return x;
  const y = checkFrac(raw.y, `${label}.y`);
  if (y.error) return y;
  const w = checkFrac(raw.w, `${label}.w`, { exclusiveMin: true });
  if (w.error) return w;
  let h = null;
  if (raw.h !== undefined && raw.h !== null && String(raw.h).trim() !== '') {
    const hc = checkFrac(raw.h, `${label}.h`, { exclusiveMin: true });
    if (hc.error) return hc;
    h = hc.value;
  }
  if (x.value + w.value > 1.000001) return { error: `${label}: overlay must fit inside the frame width.` };
  if (h !== null && y.value + h > 1.000001) return { error: `${label}: overlay must fit inside the frame height.` };
  const t = checkTimeRange(raw.start, raw.end, label);
  if (t.error) return t;
  const sourceIn = raw.sourceIn === undefined || raw.sourceIn === null || String(raw.sourceIn).trim() === ''
    ? 0
    : toFiniteNumber(raw.sourceIn);
  if (sourceIn === null || sourceIn < 0) return { error: `${label}.sourceIn must be >= 0.` };
  const brightness = toFiniteNumber(raw.brightness === undefined || raw.brightness === null ? 0 : raw.brightness);
  const contrast = toFiniteNumber(raw.contrast === undefined || raw.contrast === null ? 1 : raw.contrast);
  const saturation = toFiniteNumber(raw.saturation === undefined || raw.saturation === null ? 1 : raw.saturation);
  if (brightness === null || brightness < -1 || brightness > 1) return { error: `${label}.brightness must be between -1 and 1.` };
  if (contrast === null || contrast < 0 || contrast > 3) return { error: `${label}.contrast must be between 0 and 3.` };
  if (saturation === null || saturation < 0 || saturation > 3) return { error: `${label}.saturation must be between 0 and 3.` };
  const fadeVideoIn = toFiniteNumber(raw.fadeVideoIn === undefined || raw.fadeVideoIn === null ? 0 : raw.fadeVideoIn);
  const fadeVideoOut = toFiniteNumber(raw.fadeVideoOut === undefined || raw.fadeVideoOut === null ? 0 : raw.fadeVideoOut);
  if (fadeVideoIn === null || fadeVideoIn < 0 || fadeVideoIn > 30 || fadeVideoOut === null || fadeVideoOut < 0 || fadeVideoOut > 30) return { error: `${label}.fadeVideoIn and .fadeVideoOut must be between 0 and 30 seconds.` };
  let crop = null;
  if (raw.crop !== undefined && raw.crop !== null) {
    const cRes = checkCrop(raw.crop, `${label}.crop`);
    if (cRes.error) return cRes;
    crop = cRes.value;
  }
  let shape = 'rect';
  if (raw.shape !== undefined && raw.shape !== null && typeof raw.shape === 'string') {
    const s = raw.shape.trim().toLowerCase();
    if (s === 'circle' || s === 'ellipse') shape = 'circle';
    else if (s === 'rounded' || s === 'rounded-rect' || s === 'round') shape = 'rounded';
    else shape = 'rect';
  }
  // Webcam-bubble polish (absent = legacy behavior, output unchanged).
  const mirror = raw.mirror === true || String(raw.mirror).trim().toLowerCase() === 'true';
  let shadow = 0;
  if (raw.shadow !== undefined && raw.shadow !== null && String(raw.shadow).trim() !== '') {
    const sv = toFiniteNumber(raw.shadow);
    if (sv === null || sv < 0 || sv > 1) return { error: `${label}.shadow must be between 0 and 1.` };
    shadow = Math.round(sv * 100) / 100;
  }
  return {
    value: { file, x: x.value, y: y.value, w: w.value, h, start: t.start, end: t.end, sourceIn: Math.round(sourceIn * 1000) / 1000, crop, shape, mirror, shadow }
  };
}

function checkZoom(raw, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${label} must be an object.` };
  const level = toFiniteNumber(raw.level !== undefined ? raw.level : 1.5);
  if (level === null || level < 1.0 || level > 8.0) {
    return { error: `${label}.level must be between 1.0 and 8.0.` };
  }
  const x = checkFrac(raw.x, `${label}.x`);
  if (x.error) return x;
  const y = checkFrac(raw.y, `${label}.y`);
  if (y.error) return y;
  const transition = raw.transition === undefined || raw.transition === null || String(raw.transition).trim() === ''
    ? 0.5
    : toFiniteNumber(raw.transition);
  if (transition === null || transition < 0 || transition > 10) {
    return { error: `${label}.transition must be a positive number up to 10.` };
  }
  const t = checkTimeRange(raw.start, raw.end, label);
  if (t.error) return t;
  return {
    value: { start: t.start, end: t.end, level, x: x.value, y: y.value, transition: Math.round(transition * 1000) / 1000, easing: normalizeZoomEasingServer(raw.easing) }
  };
}

// Zoom easing acceptance mirrors the client normalizer: missing values
// default to linear (existing projects are unaffected); unrecognized values
// fall back to linear rather than failing the export.
const ZOOM_EASINGS_SERVER = ['linear', 'ease-in', 'ease-out', 'ease-in-out'];
function normalizeZoomEasingServer(easing) {
  if (typeof easing !== 'string') return 'linear';
  const s = easing.trim().toLowerCase();
  return ZOOM_EASINGS_SERVER.includes(s) ? s : 'linear';
}

// Zoom-magnification ramp expression for one region (eased ramps plus a
// hold at full level). Uses only FFmpeg-eval functions (if/lt/gt/pow —
// notably no clamp(), which eval does not implement). Linear emits the
// historical formula verbatim.
function zoomRampExpr(easing, S, E, L, T) {
  const pin = normalizeZoomEasingServer(easing);
  const lin = {
    in: `1.0+(${L}-1.0)*(time-${S})/${T}`,
    out: `1.0+(${L}-1.0)*(${E}-time)/${T}`
  };
  let zin = lin.in;
  let zout = lin.out;
  if (pin === 'ease-in') {
    zin = `1.0+(${L}-1.0)*pow((time-${S})/${T},3)`;
    zout = `1.0+(${L}-1.0)*pow((${E}-time)/${T},3)`;
  } else if (pin === 'ease-out') {
    zin = `1.0+(${L}-1.0)*(1-pow(1-(time-${S})/${T},3))`;
    zout = `1.0+(${L}-1.0)*(1-pow(1-(${E}-time)/${T},3))`;
  } else if (pin === 'ease-in-out') {
    zin = `if(lt((time-${S})/${T},0.5),1.0+(${L}-1.0)*(4*pow((time-${S})/${T},3)),1.0+(${L}-1.0)*(1-pow(-2*(time-${S})/${T}+2,3)/2))`;
    zout = `if(lt((${E}-time)/${T},0.5),1.0+(${L}-1.0)*(4*pow((${E}-time)/${T},3)),1.0+(${L}-1.0)*(1-pow(-2*(${E}-time)/${T}+2,3)/2))`;
  }
  return `if(lt(time,${S}+${T}),${zin},if(gt(time,${E}-${T}),${zout},${L}))`;
}

export function buildZoomFilter(zooms, W, H, fps) {
  if (!zooms || zooms.length === 0) return '';
  let zExpr = '1.0';
  let xExpr = '0';
  let yExpr = '0';
  const sorted = [...zooms].sort((a, b) => a.start - b.start);
  for (const z of sorted) {
    const S = z.start;
    const E = z.end;
    const L = z.level;
    const T = Math.min(z.transition === undefined ? 0.5 : z.transition, (E - S) / 2);
    const easing = normalizeZoomEasingServer(z.easing);
    let segZExpr;
    if (T > 0) {
      segZExpr = zoomRampExpr(easing, S, E, L, T);
    } else {
      segZExpr = `${L}`;
    }
    const targetX = z.x === undefined ? 0.5 : z.x;
    const targetY = z.y === undefined ? 0.5 : z.y;
    // NOTE: FFmpeg's expression evaluator has no clamp() — spell the rail as
    // min(max(v,lo),hi) so zoompan filter init does not fail with EINVAL.
    const segXExpr = `min(max(${targetX}*iw-iw/(2*zoom),0),iw-iw/zoom)`;
    const segYExpr = `min(max(${targetY}*ih-ih/(2*zoom),0),ih-ih/zoom)`;
    zExpr = `if(between(time,${S},${E}),${segZExpr},${zExpr})`;
    xExpr = `if(between(time,${S},${E}),${segXExpr},${xExpr})`;
    yExpr = `if(between(time,${S},${E}),${segYExpr},${yExpr})`;
  }
  return `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${W}x${H}:fps=${fps}`;
}

// Validate a raw edit spec (parsed JSON) into a normalized spec.
// Shape:
//   { videoWidth, videoHeight, trim|null, blurs[], texts[], image|null }
// Fractions (x,y,w,h,size) are 0..1 relative to the declared frame.
// Specs carrying version:2 dispatch to the multi-track validator below;
// everything else keeps this frozen v1 path.
export function validateEditSpec(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.version === 2) {
    return validateSpecV2(raw);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Invalid edit spec.');
  const width = toFiniteNumber(raw.videoWidth);
  const height = toFiniteNumber(raw.videoHeight);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > 7680 || height > 7680) {
    return fail('videoWidth/videoHeight must be integers between 16 and 7680.');
  }

  let trim = null;
  if (raw.trim !== null && raw.trim !== undefined) {
    if (typeof raw.trim !== 'object' || Array.isArray(raw.trim)) return fail('trim must be an object or null.');
    const r = checkTimeRange(raw.trim.start, raw.trim.end, 'trim');
    if (r.error) return fail(r.error);
    trim = { start: r.start, end: r.end };
  }

  const blursRaw = raw.blurs === undefined || raw.blurs === null ? [] : raw.blurs;
  if (!Array.isArray(blursRaw)) return fail('blurs must be an array.');
  if (blursRaw.length > EDITOR_MAX_BLURS) return fail(`At most ${EDITOR_MAX_BLURS} blur/mask areas.`);
  const blurs = [];
  for (let i = 0; i < blursRaw.length; i++) {
    const b = blursRaw[i];
    const label = `blurs[${i}]`;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(`${label} must be an object.`);
    if (b.mode !== 'blur' && b.mode !== 'mask') return fail(`${label}.mode must be "blur" or "mask".`);
    const t = checkTimeRange(b.start, b.end, label);
    if (t.error) return fail(t.error);
    const x = checkFrac(b.x, `${label}.x`); if (x.error) return fail(x.error);
    const y = checkFrac(b.y, `${label}.y`); if (y.error) return fail(y.error);
    const w = checkFrac(b.w, `${label}.w`, { exclusiveMin: true }); if (w.error) return fail(w.error);
    const h = checkFrac(b.h, `${label}.h`, { exclusiveMin: true }); if (h.error) return fail(h.error);
    if (x.value + w.value > 1.000001 || y.value + h.value > 1.000001) {
      return fail(`${label}: rect must fit inside the frame.`);
    }
    blurs.push({ mode: b.mode, x: x.value, y: y.value, w: w.value, h: h.value, start: t.start, end: t.end });
  }

  const textsRaw = raw.texts === undefined || raw.texts === null ? [] : raw.texts;
  if (!Array.isArray(textsRaw)) return fail('texts must be an array.');
  if (textsRaw.length > EDITOR_MAX_TEXTS) return fail(`At most ${EDITOR_MAX_TEXTS} text overlays.`);
  const texts = [];
  for (let i = 0; i < textsRaw.length; i++) {
    const t0 = textsRaw[i];
    const label = `texts[${i}]`;
    if (!t0 || typeof t0 !== 'object' || Array.isArray(t0)) return fail(`${label} must be an object.`);
    // Newlines are legitimate content: normalize CRLF/CR to \n, then keep
    // interior newlines verbatim (preview uses white-space:pre and FFmpeg
    // drawtext renders real newlines as line breaks). Only this restriction
    // was removed; length, timing, geometry and color rules are unchanged.
    const text = typeof t0.text === 'string' ? t0.text.replace(/\r\n?/g, '\n').trim() : '';
    if (!text || text.length > 200) return fail(`${label}.text must be 1–200 characters.`);
    const t = checkTimeRange(t0.start, t0.end, label);
    if (t.error) return fail(t.error);
    const x = checkFrac(t0.x, `${label}.x`); if (x.error) return fail(x.error);
    const y = checkFrac(t0.y, `${label}.y`); if (y.error) return fail(y.error);
    const size = checkFrac(t0.size, `${label}.size`, { min: 0.02, max: 0.25, exclusiveMin: true });
    if (size.error) return fail(`${label}.size must be between 0.02 and 0.25.`);
    const color = normalizeEditorColor(t0.color);
    if (!color) return fail(`${label}.color must be #RGB or #RRGGBB.`);
    let bg = null;
    if (t0.bg !== null && t0.bg !== undefined && String(t0.bg).trim() !== '') {
      bg = normalizeEditorColor(t0.bg);
      if (!bg) return fail(`${label}.bg must be #RGB or #RRGGBB.`);
    }
    const keyframes = checkOverlayKeyframes(t0.keyframes, label, t.end - t.start);
    if (keyframes.error) return fail(keyframes.error);
    texts.push({ text, x: x.value, y: y.value, size: size.value, color, bg, start: t.start, end: t.end, keyframes: keyframes.value });
  }

  // V2 uses images[] (one entry per overlay, each bound to an uploaded file
  // by index). The V1 single `image` key is still accepted and wrapped as
  // images[0] bound to the first uploaded file.
  const imagesRaw = raw.images === undefined || raw.images === null ? [] : raw.images;
  if (!Array.isArray(imagesRaw)) return fail('images must be an array.');
  const combinedImages = [...imagesRaw];
  if (raw.image !== null && raw.image !== undefined) {
    if (typeof raw.image !== 'object' || Array.isArray(raw.image)) return fail('image must be an object or null.');
    combinedImages.push({ ...raw.image, file: 0 });
  }
  if (combinedImages.length > EDITOR_MAX_IMAGES) return fail(`At most ${EDITOR_MAX_IMAGES} image overlays.`);
  const images = [];
  for (let i = 0; i < combinedImages.length; i++) {
    const im = combinedImages[i];
    const label = `images[${i}]`;
    if (typeof im !== 'object' || Array.isArray(im)) return fail(`${label} must be an object.`);
    const t = checkTimeRange(im.start, im.end, label);
    if (t.error) return fail(t.error);
    const x = checkFrac(im.x, `${label}.x`); if (x.error) return fail(x.error);
    const y = checkFrac(im.y, `${label}.y`); if (y.error) return fail(y.error);
    const w = checkFrac(im.w, `${label}.w`, { exclusiveMin: true }); if (w.error) return fail(w.error);
    if (x.value + w.value > 1.000001) return fail(`${label}: overlay must fit inside the frame width.`);
    const file = toFiniteNumber(im.file);
    if (!Number.isInteger(file) || file < 0 || file >= EDITOR_MAX_IMAGE_FILES) {
      return fail(`${label}.file must be an uploaded image index (0–${EDITOR_MAX_IMAGE_FILES - 1}).`);
    }
    let crop = null;
    if (im.crop !== undefined && im.crop !== null) {
      const cRes = checkCrop(im.crop, `${label}.crop`);
      if (cRes.error) return fail(cRes.error);
      crop = cRes.value;
    }
    const keyframes = checkOverlayKeyframes(im.keyframes, label, t.end - t.start);
    if (keyframes.error) return fail(keyframes.error);
    images.push({ x: x.value, y: y.value, w: w.value, start: t.start, end: t.end, file, crop, keyframes: keyframes.value });
  }

  // V1 (legacy, frozen) cannot render video overlays: reject rather than
  // silently exporting without them. Absent/empty stays valid (unchanged).
  if (raw.videoOverlays !== undefined && raw.videoOverlays !== null) {
    if (!Array.isArray(raw.videoOverlays) || raw.videoOverlays.length > 0) {
      return fail('video overlays require spec version 2.');
    }
  }

  // Export resolution: optional, defaults to Original (no scaling). An
  // unknown value fails validation so typos never silently render wrong.
  let resolution = EDITOR_EXPORT_RESOLUTIONS[0];
  if (raw.resolution !== undefined && raw.resolution !== null && String(raw.resolution).trim() !== '') {
    const entry = normalizeExportResolution(raw.resolution);
    if (!entry) return fail('resolution must be one of: Original, 480p, 720p, 1080p, 2K, 4K, 8K.');
    resolution = entry;
  } else if (raw.exportHeight !== undefined && raw.exportHeight !== null && String(raw.exportHeight).trim() !== '') {
    const entry = normalizeExportResolution(raw.exportHeight);
    if (!entry) return fail('resolution must be one of: Original, 480p, 720p, 1080p, 2K, 4K, 8K.');
    resolution = entry;
  }

  const watermark = normalizeEditorWatermark(raw.watermark);
  if (!watermark) return fail('watermark settings are invalid.');
  const watermarksRaw = raw.watermarks === undefined || raw.watermarks === null ? [watermark] : raw.watermarks;
  if (!Array.isArray(watermarksRaw) || watermarksRaw.length > 10) return fail('watermarks must be an array with at most 10 entries.');
  const watermarks = [];
  for (let i = 0; i < watermarksRaw.length; i++) {
    const checked = normalizeEditorWatermark(watermarksRaw[i]);
    if (!checked) return fail(`watermarks[${i}] has invalid settings.`);
    watermarks.push(checked);
  }
  if (!trim && blurs.length === 0 && texts.length === 0 && images.length === 0 && !watermarks.some(w => w.enabled)) {
    return fail('No edits specified.');
  }
  return { ok: true, spec: { videoWidth: width, videoHeight: height, trim, blurs, texts, images, watermark, watermarks, resolution: resolution.id, exportHeight: resolution.height } };
}

// Escape user text for the ffmpeg drawtext filter (single-quoted value).
export function escapeDrawtextText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
}

function fmtTime(t) {
  return String(Math.round(t * 1000) / 1000);
}

function enableBetween(start, end) {
  return `between(t,${fmtTime(start)},${fmtTime(end)})`;
}

const toEven = n => Math.max(0, (Math.round(n) >> 1) << 1);

// Escape a font file path for the ffmpeg drawtext filter (single-quoted value).
export function escapeDrawtextFontFile(value) {
  return String(value).replace(/\\/g, '/').replace(/'/g, "\\'").replace(/:/g, '\\:');
}

// Build the burned-in watermark drawtext filter body (no input/output
// labels — the caller chains it like any other overlay). Shared by the V1 and
// V2 builders so both exports render identically: full-duration, editable
// text/size/color/opacity, positions 1 = bottom-right, 2 = top-left,
// 3 = center, 4 = top-right, 5 = bottom-left. Deterministic for given inputs.
// `watermark` is a normalized object (see normalizeEditorWatermark).
// Throws on invalid geometry/font.
export function watermarkDrawtextFilter({ width, height, watermark, fontFile }) {
  const W = Number(width);
  const H = Number(height);
  if (!Number.isFinite(W) || !Number.isFinite(H) || W < 16 || H < 16) {
    throw new Error('watermark needs a valid frame size.');
  }
  const position = Number(watermark && watermark.position);
  if (!isValidWatermarkPosition(position)) throw new Error('watermark position must be 1, 2, 3, 4 or 5.');
  if (typeof fontFile !== 'string' || !fontFile) throw new Error('watermark needs a font file.');
  const FS = Math.min(256, Math.max(12, Math.round(watermark.size * H)));
  const M = Math.max(8, Math.round(EDITOR_WATERMARK_MARGIN_FRAC * Math.min(W, H)));
  const alpha = String(Math.round((watermark.opacity / 100) * 100) / 100);
  let x;
  let y;
  if (watermark.motion === 'left-to-right') {
    x = `mod(t*${Number(watermark.speed || 80)}\\,max(1\\,w-text_w))`;
  } else if (watermark.motion === 'right-to-left') {
    x = `max(0\\,w-text_w-mod(t*${Number(watermark.speed || 80)}\\,max(1\\,w-text_w)))`;
  } else if (position === 2 || position === 5) {
    x = `${M}`;
  } else if (position === 3) {
    x = '(w-text_w)/2';
  } else {
    x = `w-text_w-${M}`;
  }
  if (position === 2 || position === 4) {
    y = `${M}`;
  } else if (position === 3) {
    y = '(h-text_h)/2';
  } else {
    y = `h-text_h-${M}`;
  }
  return `drawtext=fontfile='${escapeDrawtextFontFile(fontFile)}':text='${escapeDrawtextText(watermark.text)}':fontsize=${FS}:fontcolor=${watermark.color}@${alpha}:shadowcolor=black@0.6:shadowx=2:shadowy=2:x=${x}:y=${y}`;
}

// Build a deterministic ffmpeg argv (no shell) for the validated spec.
// Never reads or writes the user's original: inputPath is the uploaded temp
// copy, outputPath is a fresh temp file the caller creates.
// fontFile: required when the spec has text overlays (drawtext segfaults on
// systems without a working fontconfig when no font is given), ignored
// otherwise.
// imagePaths: array of temp input paths, one per uploaded image file; spec
// images bind to them by index. The legacy single imagePath is still honored
// as imagePaths[0].
// Build FFmpeg argv for converting a browser MediaRecorder WebM capture into a
// seekable MP4. Keep the recorded dimensions untouched; optimize for screen text
// with H.264 CRF 18 while avoiding the extremely slow 'medium' preset.
export function buildScreenRecordingFfmpegArgs({ inputPath, outputPath } = {}) {
  if (typeof inputPath !== 'string' || !inputPath) throw new Error('inputPath is required.');
  if (typeof outputPath !== 'string' || !outputPath) throw new Error('outputPath is required.');
  return [
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-max_muxing_queue_size', '1024',
    outputPath
  ];
}

export function buildFfmpegArgs({ inputPath = null, imagePath = null, imagePaths = null, videoPaths = null, audioPaths = null, media = null, outputPath, spec, fontFile = null }) {
  const version = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec.version : undefined;
  if (version === 2) {
    return buildV2Args({ videoPaths, audioPaths, imagePaths, outputPath, spec, fontFile, media });
  }
  if (typeof inputPath !== 'string' || !inputPath) throw new Error('inputPath is required.');
  if (typeof outputPath !== 'string' || !outputPath) throw new Error('outputPath is required.');
  const checked = validateEditSpec(spec);
  if (!checked.ok) throw new Error(checked.error);
  const s = checked.spec;
  const resolvedImagePaths = Array.isArray(imagePaths) ? imagePaths : (typeof imagePath === 'string' && imagePath ? [imagePath] : []);
  for (let i = 0; i < s.images.length; i++) {
    const needed = s.images[i].file;
    if (!Number.isInteger(needed) || needed < 0 || needed >= resolvedImagePaths.length ||
        typeof resolvedImagePaths[needed] !== 'string' || !resolvedImagePaths[needed]) {
      throw new Error(`imagePaths[${needed}] is required for images[${i}].`);
    }
  }
  if ((s.texts.length > 0 || (s.watermark && s.watermark.enabled)) && (typeof fontFile !== 'string' || !fontFile)) {
    throw new Error('Text overlays or the watermark need a local font. Set VIDEO_EDITOR_FONT to a .ttf file.');
  }
  const W = s.videoWidth;
  const H = s.videoHeight;

  const args = ['-y'];
  let filter = '';
  let label = '0:v';
  const parts = [];
  const nextLabel = () => `ve${parts.length}`;

  const px = (frac, dim) => Math.max(1, Math.round(frac * dim));

  for (const b of s.blurs) {
    const X = Math.min(W - 1, Math.round(b.x * W));
    const Y = Math.min(H - 1, Math.round(b.y * H));
    const PW = Math.min(W - X, px(b.w, W));
    const PH = Math.min(H - Y, px(b.h, H));
    const en = `enable='${enableBetween(b.start, b.end)}'`;
    const out = nextLabel();
    if (b.mode === 'blur') {
      const R = Math.min(30, Math.max(2, Math.round(Math.min(PW, PH) / 6)));
      parts.push(
        `[${label}]split[bs${parts.length}][bv${parts.length}];` +
        `[bs${parts.length}]crop=${PW}:${PH}:${X}:${Y},boxblur=${R}:1[bx${parts.length}];` +
        `[bv${parts.length}][bx${parts.length}]overlay=${X}:${Y}:${en}[${out}]`
      );
    } else {
      parts.push(`[${label}]drawbox=x=${X}:y=${Y}:w=${PW}:h=${PH}:color=black@1:t=fill:${en}[${out}]`);
    }
    label = out;
  }

  for (const t of s.texts) {
    const X = Math.min(W - 1, Math.round(t.x * W));
    const Y = Math.min(H - 1, Math.round(t.y * H));
    const FS = Math.min(256, Math.max(12, Math.round(t.size * H)));
    const en = `enable='${enableBetween(t.start, t.end)}'`;
    const box = t.bg ? `:box=1:boxcolor=${t.bg}:boxborderw=10` : '';
    const out = nextLabel();
    parts.push(
      `[${label}]drawtext=fontfile='${escapeDrawtextFontFile(fontFile)}':text='${escapeDrawtextText(t.text)}':fontsize=${FS}:fontcolor=${t.color}${box}:x=${X}:y=${Y}:${en}[${out}]`
    );
    label = out;
  }

  const inputs = ['-i', inputPath];
  // Images render in start-time order (same order as validateEditSpec sorts
  // nothing — projectToSpec pre-sorts; each overlay chains onto the label).
  const orderedImages = [...s.images]
    .map((im, order) => ({ im, order }))
    .sort((a, b) => a.im.start - b.im.start || a.im.end - b.im.end || a.order - b.order);
  for (const { im } of orderedImages) {
    inputs.push('-i', resolvedImagePaths[im.file]);
  }
  let imageInputNo = 1;
  const imageFilters = [];
  for (const { im } of orderedImages) {
    const n = imageInputNo++;
    const baseIW = toEven(Math.min(W, Math.max(8, im.w * W)));
    const IW = keyframeExpr(im.keyframes, 'scale', 1, im.start, baseIW);
    const X = keyframeExpr(im.keyframes, 'x', im.x, im.start, W);
    const Y = keyframeExpr(im.keyframes, 'y', im.y, im.start, H);
    const alpha = keyframeExpr(im.keyframes, 'opacity', 1, im.start);
    const en = `enable='${enableBetween(im.start, im.end)}'`;
    const imCrop = im.crop
      ? `crop=w=trunc(iw*${roundFrac(im.crop.right - im.crop.left)}/2)*2:h=trunc(ih*${roundFrac(im.crop.bottom - im.crop.top)}/2)*2:x=trunc(iw*${roundFrac(im.crop.left)}/2)*2:y=trunc(ih*${roundFrac(im.crop.top)}/2)*2,`
      : '';
    imageFilters.push({ n, IW, X, Y, alpha, en, imCrop });
  }

  args.push(...inputs);
  if (s.trim) {
    args.push('-ss', fmtTime(s.trim.start), '-to', fmtTime(s.trim.end));
  }
  for (const f of imageFilters) {
    const out = nextLabel();
    parts.push(`[${f.n}:v]${f.imCrop}scale=${f.IW}:-2[ovr${f.n}];[${label}][ovr${f.n}]overlay=${f.X}:${f.Y}:${f.en}[${out}]`);
    label = out;
  }
  // Burned-in brand watermark renders last (topmost), before the optional
  // export downscale, spanning the full duration. Absent/disabled specs skip
  // this, so legacy filter graphs are byte-identical.
  for (const watermark of (s.watermarks || (s.watermark ? [s.watermark] : []))) {
    if (!watermark || !watermark.enabled) continue;
    const out = nextLabel();
    parts.push(`[${label}]${watermarkDrawtextFilter({ width: W, height: H, watermark, fontFile })}[${out}]`);
    label = out;
  }
  // Export resolution: scale only when a specific quality is selected AND it
  // is a downscale (target height < source height). Original (null), equal
  // or larger targets keep source pixels: aspect preserved via width=-2,
  // no wasteful upscaling.
  const exportHeightV1 = s.exportHeight || null;
  if (exportHeightV1 && exportHeightV1 < H) {
    const out = nextLabel();
    if (parts.length === 0) {
      parts.push(`[0:v]scale=-2:${exportHeightV1}[${out}]`);
    } else {
      parts.push(`[${label}]scale=-2:${exportHeightV1}[${out}]`);
    }
    label = out;
  }
  if (parts.length > 0) {
    filter = parts.join(';');
    args.push('-filter_complex', filter, '-map', `[${label}]`);
  }
  args.push('-map', '0:a?');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-movflags', '+faststart', outputPath);
  return args;
}

// ---- Multi-track spec (version 2) ----
// Redesign for the multi-track editor. Legacy (v1, no version key) validation
// and rendering above are frozen byte-for-byte; v2 lives entirely here.
// Shape:
//   { version: 2, width, height, files: [{kind:'video'|'audio'}],
//     videoClips: [{file, sourceIn, sourceOut, start, gain}],
//     audioClips: [{file, sourceIn, sourceOut, start, gain}],
//     blurs: [...], texts: [...], images: [...] }
// - `files` is index-aligned with the uploaded parts: the i-th video entry
//   binds the i-th `video` part, likewise audio/image.
// - Video clips must not overlap (single video track); audio clips may.
// - Overlay times are OUTPUT (assembled-timeline) seconds; the FFmpeg graph
//   renders overlays after concat, so no mapping is needed.
// - Gain is 0..2 (100% = original), applied with the volume filter. Gain
//   only — no normalization, fade, EQ, or compression anywhere.


function checkOverlayKeyframes(raw, label, duration) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw) || raw.length > 200) return { error: `${label}.keyframes must be an array of at most 200 entries.` };
  const allowed = { x: [0, 1], y: [0, 1], scale: [0.05, 4], opacity: [0, 1] };
  const result = [];
  for (const frame of raw) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) ||
        !Object.prototype.hasOwnProperty.call(allowed, frame.property)) return { error: `${label}.keyframes contains an invalid property.` };
    const time = toFiniteNumber(frame.time);
    const value = toFiniteNumber(frame.value);
    const range = allowed[frame.property];
    const easing = frame.easing === undefined ? 'linear' : frame.easing;
    if (time === null || time < 0 || time > duration || value === null ||
        value < range[0] || value > range[1] ||
        !['linear', 'ease-in', 'ease-out', 'ease-in-out'].includes(easing)) {
      return { error: `${label}.keyframes contains an invalid time, value, or easing.` };
    }
    result.push({ property: frame.property, time: round3(time), value, easing });
  }
  result.sort((a, b) => a.property.localeCompare(b.property) || a.time - b.time);
  for (let i = 1; i < result.length; i++) {
    if (result[i].property === result[i - 1].property && result[i].time === result[i - 1].time) {
      return { error: `${label}.keyframes has duplicate property/time entries.` };
    }
  }
  return { value: result };
}

function keyframeExpr(frames, property, baseValue, clipStart, multiplier = 1) {
  const points = (frames || []).filter(k => k.property === property)
    .sort((a, b) => a.time - b.time)
    .map(k => ({ t: round3(clipStart + k.time), v: Number(k.value) * multiplier, easing: k.easing }));
  if (!points.length) return String(Number(baseValue) * multiplier);
  const num = n => String(Math.round(n * 100000) / 100000);
  if (points.length === 1) return num(points[0].v);
  let expr = num(points[points.length - 1].v);
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i], b = points[i + 1];
    const span = Math.max(0.001, b.t - a.t);
    const r = `((t-${num(a.t)})/${num(span)})`;
    let eased = r;
    if (b.easing === 'ease-in') eased = `(${r}*${r})`;
    else if (b.easing === 'ease-out') eased = `(1-(1-${r})*(1-${r}))`;
    else if (b.easing === 'ease-in-out') eased = `if(lt(${r}\\,0.5)\\,2*${r}*${r}\\,1-((-2*${r}+2)*(-2*${r}+2))/2)`;
    const val = `${num(a.v)}+(${num(b.v)}-${num(a.v)})*${eased}`;
    expr = `if(lt(t\\,${num(b.t)})\\,${val}\\,${expr})`;
  }
  return `if(lt(t\\,${num(points[0].t)})\\,${num(points[0].v)}\\,${expr})`;
}

function checkGain(value, label) {
  const n = toFiniteNumber(value);
  if (n === null) return { error: `${label} must be a number.` };
  if (!(n >= 0) || !(n <= 2)) return { error: `${label} must be between 0 and 2 (100% = original).` };
  return { value: Math.round(n * 1000) / 1000 };
}

function checkMediaClip(raw, label, fileCount) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${label} must be an object.` };
  const file = toFiniteNumber(raw.file);
  if (!Number.isInteger(file) || file < 0 || file >= fileCount) {
    return { error: `${label}.file must be an uploaded file index.` };
  }
  const span = checkTimeRange(raw.sourceIn, raw.sourceOut, `${label} source`);
  if (span.error) return { error: span.error };
  const start = toFiniteNumber(raw.start);
  if (start === null || !(start >= 0) || start > EDITOR_MAX_TIME_SECONDS) {
    return { error: `${label}.start must be >= 0.` };
  }
  const gain = checkGain(raw.gain === undefined || raw.gain === null ? 1 : raw.gain, `${label}.gain`);
  if (gain.error) return { error: gain.error };
  const volumeDb = toFiniteNumber(raw.volumeDb === undefined || raw.volumeDb === null ? 0 : raw.volumeDb);
  if (volumeDb === null || volumeDb < -60 || volumeDb > 24) {
    return { error: `${label}.volumeDb must be a number between -60 and 24.` };
  }
  const fadeIn = toFiniteNumber(raw.fadeIn === undefined || raw.fadeIn === null ? 0 : raw.fadeIn);
  const fadeOut = toFiniteNumber(raw.fadeOut === undefined || raw.fadeOut === null ? 0 : raw.fadeOut);
  if (fadeIn === null || fadeIn < 0 || fadeIn > 30 || fadeOut === null || fadeOut < 0 || fadeOut > 30) {
    return { error: `${label}.fadeIn and .fadeOut must be between 0 and 30 seconds.` };
  }
  let crop = null;
  if (raw.crop !== undefined && raw.crop !== null) {
    const cRes = checkCrop(raw.crop, `${label}.crop`);
    if (cRes.error) return { error: cRes.error };
    crop = cRes.value;
  }
  const brightness = toFiniteNumber(raw.brightness === undefined || raw.brightness === null ? 0 : raw.brightness);
  const contrast = toFiniteNumber(raw.contrast === undefined || raw.contrast === null ? 1 : raw.contrast);
  const saturation = toFiniteNumber(raw.saturation === undefined || raw.saturation === null ? 1 : raw.saturation);
  if (brightness === null || brightness < -1 || brightness > 1) return { error: `${label}.brightness must be between -1 and 1.` };
  if (contrast === null || contrast < 0 || contrast > 3) return { error: `${label}.contrast must be between 0 and 3.` };
  if (saturation === null || saturation < 0 || saturation > 3) return { error: `${label}.saturation must be between 0 and 3.` };
  const fadeVideoIn = toFiniteNumber(raw.fadeVideoIn === undefined || raw.fadeVideoIn === null ? 0 : raw.fadeVideoIn);
  const fadeVideoOut = toFiniteNumber(raw.fadeVideoOut === undefined || raw.fadeVideoOut === null ? 0 : raw.fadeVideoOut);
  if (fadeVideoIn === null || fadeVideoIn < 0 || fadeVideoIn > 30 || fadeVideoOut === null || fadeVideoOut < 0 || fadeVideoOut > 30) {
    return { error: `${label}.fadeVideoIn and .fadeVideoOut must be between 0 and 30 seconds.` };
  }
  let scale = 1.0;
  if (raw.scale !== undefined && raw.scale !== null && String(raw.scale).trim() !== '') {
    const sNum = toFiniteNumber(raw.scale);
    if (sNum === null || sNum < 0.1 || sNum > 10.0) {
      return { error: `${label}.scale must be a number between 0.1 and 10.0.` };
    }
    scale = Math.round(sNum * 1000) / 1000;
  }
  return {
    clip: {
      file,
      sourceIn: span.start,
      sourceOut: span.end,
      start: round3(start),
      end: round3(start + (span.end - span.start)),
      gain: gain.value,
      volumeDb: Math.round(volumeDb * 100) / 100,
      fadeIn: Math.round(fadeIn * 1000) / 1000,
      fadeOut: Math.round(fadeOut * 1000) / 1000,
      crop,
      scale,
      brightness: Math.round(brightness * 1000) / 1000,
      contrast: Math.round(contrast * 1000) / 1000,
      saturation: Math.round(saturation * 1000) / 1000,
      fadeVideoIn: Math.round(fadeVideoIn * 1000) / 1000,
      fadeVideoOut: Math.round(fadeVideoOut * 1000) / 1000
    }
  };
}

// Video track has no overlaps: sorted clips must satisfy next.start >= prev.end.
function checkNoVideoOverlap(clips) {
  const sorted = [...clips].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    if (Math.round((sorted[i].start - sorted[i - 1].end) * 1000) < 0) {
      return { error: 'Video clips must not overlap; move or trim them apart.' };
    }
  }
  return null;
}

export function validateSpecV2(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Invalid edit spec.');
  const width = toFiniteNumber(raw.width !== undefined ? raw.width : raw.videoWidth);
  const height = toFiniteNumber(raw.height !== undefined ? raw.height : raw.videoHeight);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > 7680 || height > 7680) {
    return fail('width/height must be integers between 16 and 7680.');
  }
  const filesRaw = raw.files;
  if (!Array.isArray(filesRaw) || filesRaw.length === 0) return fail('files must be a non-empty array.');
  const videoCount = filesRaw.filter(f => f && f.kind === 'video').length;
  const audioCount = filesRaw.filter(f => f && f.kind === 'audio').length;
  if (videoCount + audioCount !== filesRaw.length) return fail('files entries must be {kind:"video"|"audio"}.');
  if (videoCount < 1 || videoCount > EDITOR_MAX_VIDEO_FILES) {
    return fail(`Need 1–${EDITOR_MAX_VIDEO_FILES} video files.`);
  }
  if (audioCount > EDITOR_MAX_AUDIO_FILES) return fail(`At most ${EDITOR_MAX_AUDIO_FILES} audio files.`);
  const files = filesRaw.map(f => ({ kind: f.kind }));

  const videoRaw = raw.videoClips === undefined || raw.videoClips === null ? [] : raw.videoClips;
  if (!Array.isArray(videoRaw)) return fail('videoClips must be an array.');
  if (videoRaw.length < 1 || videoRaw.length > EDITOR_MAX_VIDEO_CLIPS) {
    return fail(`Need 1–${EDITOR_MAX_VIDEO_CLIPS} video clips.`);
  }
  const videoClips = [];
  for (let i = 0; i < videoRaw.length; i++) {
    const r = checkMediaClip(videoRaw[i], `videoClips[${i}]`, videoCount);
    if (r.error) return fail(r.error);
    videoClips.push(r.clip);
  }
  const overlap = checkNoVideoOverlap(videoClips);
  if (overlap) return fail(overlap.error);

  const audioRaw = raw.audioClips === undefined || raw.audioClips === null ? [] : raw.audioClips;
  if (!Array.isArray(audioRaw)) return fail('audioClips must be an array.');
  if (audioRaw.length > EDITOR_MAX_AUDIO_CLIPS) return fail(`At most ${EDITOR_MAX_AUDIO_CLIPS} audio clips.`);
  const audioClips = [];
  for (let i = 0; i < audioRaw.length; i++) {
    const r = checkMediaClip(audioRaw[i], `audioClips[${i}]`, audioCount);
    if (r.error) return fail(r.error);
    audioClips.push(r.clip);
  }

  // Timeline length = furthest clip end across video + audio.
  let contentEnd = 0;
  for (const c of [...videoClips, ...audioClips]) contentEnd = Math.max(contentEnd, c.end);
  contentEnd = Math.round(contentEnd * 1000) / 1000;

  // Second video overlay track (picture-in-picture). Entries reference an
  // uploaded video file by kind-index; audio is never mixed (muted).
  // Validated before the classic overlays so an overlay-only timeline still
  // validates (the inner overlay check below only knows blurs/texts/images).
  const overlaysRaw = raw.videoOverlays === undefined || raw.videoOverlays === null ? [] : raw.videoOverlays;
  if (!Array.isArray(overlaysRaw)) return fail('videoOverlays must be an array.');
  if (overlaysRaw.length > EDITOR_MAX_VIDEO_OVERLAYS) return fail(`At most ${EDITOR_MAX_VIDEO_OVERLAYS} video overlays.`);
  const videoOverlays = [];
  for (let i = 0; i < overlaysRaw.length; i++) {
    const checked = checkVideoOverlay(overlaysRaw[i], `videoOverlays[${i}]`, videoCount);
    if (checked.error) return fail(checked.error);
    if (Math.round((checked.value.end - contentEnd) * 1000) > 0) {
      return fail(`videoOverlays[${i}] ends beyond the timeline (${contentEnd}s). Extend a clip or shorten the overlay.`);
    }
    videoOverlays.push(checked.value);
  }

  // Overlays reuse the v1 overlay validation (arrays, geometry, colors,
  // image file binding); then each must fit inside the assembled timeline.
  const overlayCheck = validateEditSpec({
    videoWidth: width,
    videoHeight: height,
    trim: null,
    blurs: raw.blurs === undefined ? [] : raw.blurs,
    texts: raw.texts === undefined ? [] : raw.texts,
    images: raw.images === undefined ? [] : raw.images,
    image: raw.image === undefined ? null : raw.image,
    watermark: raw.watermark === undefined ? null : raw.watermark
  });
  let blurs = [];
  let texts = [];
  let images = [];
  if (overlayCheck.ok) {
    blurs = overlayCheck.spec.blurs;
    texts = overlayCheck.spec.texts;
    images = overlayCheck.spec.images;
  } else if (!((videoClips.length > 0 || videoOverlays.length > 0 || (raw.zooms && raw.zooms.length > 0)) && /No edits specified/.test(overlayCheck.error || ''))) {
    return overlayCheck;
  }
  for (const [key, list] of [['blurs', blurs], ['texts', texts], ['images', images]]) {
    for (let i = 0; i < list.length; i++) {
      if (Math.round((list[i].end - contentEnd) * 1000) > 0) {
        return fail(`${key}[${i}] ends beyond the timeline (${contentEnd}s). Extend a clip or shorten the overlay.`);
      }
    }
  }

  const multiWatermarksRaw = raw.watermarks === undefined || raw.watermarks === null
    ? [overlayCheck.ok ? overlayCheck.spec.watermark : (raw.watermark || { enabled: false, position: EDITOR_WATERMARK_DEFAULT_POSITION })]
    : raw.watermarks;
  if (!Array.isArray(multiWatermarksRaw) || multiWatermarksRaw.length < 1 || multiWatermarksRaw.length > 10) return fail('watermarks must contain 1 to 10 entries.');
  const multiWatermarks = [];
  for (let i = 0; i < multiWatermarksRaw.length; i++) {
    const wm = normalizeEditorWatermark(multiWatermarksRaw[i]);
    if (!wm) return fail(`watermarks[${i}] has invalid settings.`);
    multiWatermarks.push(wm);
  }

  const zoomsRaw = raw.zooms === undefined || raw.zooms === null ? [] : raw.zooms;
  if (!Array.isArray(zoomsRaw)) return fail('zooms must be an array.');
  const zooms = [];
  for (let i = 0; i < zoomsRaw.length; i++) {
    const checked = checkZoom(zoomsRaw[i], `zooms[${i}]`);
    if (checked.error) return fail(checked.error);
    if (Math.round((checked.value.end - contentEnd) * 1000) > 0) {
      return fail(`zooms[${i}] ends beyond the timeline (${contentEnd}s). Extend a clip or shorten the zoom.`);
    }
    zooms.push(checked.value);
  }

  let resolution = EDITOR_EXPORT_RESOLUTIONS[0];
  if (raw.resolution !== undefined && raw.resolution !== null && String(raw.resolution).trim() !== '') {
    const entry = normalizeExportResolution(raw.resolution);
    if (!entry) return fail('resolution must be one of: Original, 480p, 720p, 1080p, 2K, 4K, 8K.');
    resolution = entry;
  } else if (raw.exportHeight !== undefined && raw.exportHeight !== null && String(raw.exportHeight).trim() !== '') {
    const entry = normalizeExportResolution(raw.exportHeight);
    if (!entry) return fail('resolution must be one of: Original, 480p, 720p, 1080p, 2K, 4K, 8K.');
    resolution = entry;
  }

  return {
    ok: true,
    spec: {
      version: 2,
      width,
      height,
      videoWidth: width,
      videoHeight: height,
      fps: EDITOR_PROJECT_FPS,
      files,
      videoClips: [...videoClips].sort((a, b) => a.start - b.start),
      audioClips,
      blurs,
      texts,
      images,
      videoOverlays,
      zooms,
      watermark: overlayCheck.ok ? overlayCheck.spec.watermark : { enabled: false, position: EDITOR_WATERMARK_DEFAULT_POSITION },
      watermarks: multiWatermarks,
      contentEnd,
      resolution: resolution.id,
      exportHeight: resolution.height
    }
  };
}

// Build the multi-track FFmpeg graph (no shell):
//   per video clip: trim+scale/pad segment (gaps filled with black) -> concat
//   per audio segment (clip companions with gain + music with gain): trim,
//   gain, resample, delay to timeline position -> amix (normalize=0 keeps gain)
//   overlays chained after concat (output-relative times, as in v1).
// media: { width, height, hasAudio: boolean[] per video file } (server-probed;
//   tests inject synthetic values so no ffprobe is needed in unit tests).
export function buildV2Args({ videoPaths, audioPaths, imagePaths = [], outputPath, spec, fontFile = null, media }) {
  if (!Array.isArray(videoPaths) || videoPaths.length === 0) throw new Error('videoPaths are required.');
  if (typeof outputPath !== 'string' || !outputPath) throw new Error('outputPath is required.');
  const checked = validateSpecV2(spec);
  if (!checked.ok) throw new Error(checked.error);
  const s = checked.spec;
  const videoCount = s.files.filter(f => f.kind === 'video').length;
  const audioCount = s.files.filter(f => f.kind === 'audio').length;
  if (videoPaths.length !== videoCount) throw new Error('videoPaths must match the spec video files.');
  if (!Array.isArray(audioPaths) || audioPaths.length !== audioCount) {
    throw new Error('audioPaths must match the spec audio files.');
  }
  const W = Math.round((media && typeof media.width === 'number' && media.width >= 16) ? media.width : s.videoWidth);
  const H = Math.round((media && typeof media.height === 'number' && media.height >= 16) ? media.height : s.videoHeight);
  const hasAudio = (media && Array.isArray(media.hasAudio)) ? media.hasAudio : [];
  const resolvedImages = Array.isArray(imagePaths) ? imagePaths : [];
  for (let i = 0; i < s.images.length; i++) {
    const needed = s.images[i].file;
    if (!Number.isInteger(needed) || needed < 0 || needed >= resolvedImages.length ||
        typeof resolvedImages[needed] !== 'string' || !resolvedImages[needed]) {
      throw new Error(`imagePaths[${needed}] is required for images[${i}].`);
    }
  }
  if ((s.texts.length > 0 || (s.watermark && s.watermark.enabled)) && (typeof fontFile !== 'string' || !fontFile)) {
    throw new Error('Text overlays or the watermark need a local font. Set VIDEO_EDITOR_FONT to a .ttf file.');
  }

  const args = ['-y'];
  const inputs = [];
  for (const p of videoPaths) inputs.push('-i', p);
  const audioBase = videoPaths.length;
  for (const p of audioPaths) inputs.push('-i', p);
  // Image inputs follow, ordered by overlay start (deterministic numbering).
  const orderedImages = [...s.images]
    .map((im, order) => ({ im, order }))
    .sort((a, b) => a.im.start - b.im.start || a.im.end - b.im.end || a.order - b.order);
  for (const { im } of orderedImages) inputs.push('-i', resolvedImages[im.file]);
  const imageBase = audioBase + audioPaths.length;
  const imageInputNo = new Map();
  orderedImages.forEach(({ im }, k) => { if (!imageInputNo.has(im.file + ':' + k)) imageInputNo.set(k, imageBase + k); });

  const parts = [];
  const nextLabel = () => `ve${parts.length}`;
  const px = (frac, dim) => Math.max(1, Math.round(frac * dim));
  const FPS = EDITOR_PROJECT_FPS;

  // --- video segments (+ black fillers for gaps), then concat ---
  const vclips = [...s.videoClips].sort((a, b) => a.start - b.start);
  const segLabels = [];
  const vAudioSegLabels = [];
  let cursor = 0;
  let segNo = 0;
  let audioSegNo = 0;
  const norm = `aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo`;
  const delayMs = t => Math.max(0, Math.round(t * 1000));

  const pushFiller = gap => {
    const outV = `vf${segNo++}`;
    parts.push(`color=black:s=${W}x${H}:r=${FPS}:d=${fmtTime(gap)},format=yuv420p[${outV}]`);
    segLabels.push(outV);

    const outA = `af${audioSegNo++}`;
    parts.push(`anullsrc=r=44100:cl=stereo:d=${fmtTime(gap)},${norm}[${outA}]`);
    vAudioSegLabels.push(outA);
  };

  for (const c of vclips) {
    const gap = c.start - cursor;
    if (Math.round(gap * 1000) >= 20) {
      pushFiller(gap);
    }
    const dur = c.sourceOut - c.sourceIn;

    // video segment
    const outV = `vv${segNo++}`;
    const cropFilter = c.crop
      ? `crop=w=trunc(iw*${roundFrac(c.crop.right - c.crop.left)}/2)*2:h=trunc(ih*${roundFrac(c.crop.bottom - c.crop.top)}/2)*2:x=trunc(iw*${roundFrac(c.crop.left)}/2)*2:y=trunc(ih*${roundFrac(c.crop.top)}/2)*2,`
      : '';
    let scalePadFilter = '';
    const S = c.scale !== undefined && c.scale > 0 ? c.scale : 1.0;
    if (Math.abs(S - 1.0) > 0.001) {
      if (S < 1.0) {
        scalePadFilter = `scale=${W}:${H}:force_original_aspect_ratio=decrease,scale=w=trunc(iw*${roundFrac(S)}/2)*2:h=trunc(ih*${roundFrac(S)}/2)*2,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,`;
      } else {
        scalePadFilter = `scale=${W}:${H}:force_original_aspect_ratio=decrease,scale=w=trunc(iw*${roundFrac(S)}/2)*2:h=trunc(ih*${roundFrac(S)}/2)*2,crop=${W}:${H}:(iw-${W})/2:(ih-${H})/2,`;
      }
    } else {
      scalePadFilter = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,`;
    }
    parts.push(
      `[${c.file}:v]trim=start=${fmtTime(c.sourceIn)}:end=${fmtTime(c.sourceOut)},setpts=PTS-STARTPTS,` +
      cropFilter +
      scalePadFilter +
      `eq=brightness=${fmtTime(c.brightness)}:contrast=${fmtTime(c.contrast)}:saturation=${fmtTime(c.saturation)}` +
      (c.fadeVideoIn > 0 ? `,fade=t=in:st=0:d=${fmtTime(Math.min(dur, c.fadeVideoIn))}:color=black` : '') +
      (c.fadeVideoOut > 0 ? `,fade=t=out:st=${fmtTime(Math.max(0, dur - c.fadeVideoOut))}:d=${fmtTime(Math.min(dur, c.fadeVideoOut))}:color=black` : '') +
      `,setsar=1,fps=${FPS},format=yuv420p[${outV}]`
    );
    segLabels.push(outV);

    // companion audio segment
    const outA = `aa${audioSegNo++}`;
    if (hasAudio[c.file] === false) {
      parts.push(`anullsrc=r=44100:cl=stereo:d=${fmtTime(dur)},${norm}[${outA}]`);
    } else {
      const vol = c.volumeDb !== undefined && c.volumeDb !== 0 ? `${fmtTime(c.volumeDb)}dB` : fmtTime(c.gain);
      const fadeIn = Math.min(dur, Math.max(0, Number(c.fadeIn) || 0));
      const fadeOut = Math.min(dur, Math.max(0, Number(c.fadeOut) || 0));
      const fadeFilters = (fadeIn > 0 ? `,afade=t=in:st=0:d=${fmtTime(fadeIn)}` : '') +
        (fadeOut > 0 ? `,afade=t=out:st=${fmtTime(Math.max(0, dur - fadeOut))}:d=${fmtTime(fadeOut)}` : '');
      parts.push(`[${c.file}:a]atrim=start=${fmtTime(c.sourceIn)}:end=${fmtTime(c.sourceOut)},asetpts=PTS-STARTPTS,volume=${vol}${fadeFilters},${norm}[${outA}]`);
    }
    vAudioSegLabels.push(outA);

    cursor = c.end;
  }

  let label = `vc${parts.length}`;
  parts.push(`[${segLabels.join('][')}]concat=n=${segLabels.length}:v=1:a=0[${label}]`);

  const origAudioLabel = `au_orig`;
  parts.push(`[${vAudioSegLabels.join('][')}]concat=n=${vAudioSegLabels.length}:v=0:a=1[${origAudioLabel}]`);

  // --- audio: mix the concatenated original audio track with added music tracks ---
  const mixInputs = [origAudioLabel];
  let segIdx = 0;
  for (const c of s.audioClips) {
    const out = `mu${segIdx++}`;
    const delay = delayMs(c.start);
    const delayFilter = `,adelay=${delay}|${delay}`;
    const vol = c.volumeDb !== undefined && c.volumeDb !== 0 ? `${fmtTime(c.volumeDb)}dB` : fmtTime(c.gain);
    const dur = c.sourceOut - c.sourceIn;
    const fadeIn = Math.min(dur, Math.max(0, Number(c.fadeIn) || 0));
    const fadeOut = Math.min(dur, Math.max(0, Number(c.fadeOut) || 0));
    const fadeFilters = (fadeIn > 0 ? `,afade=t=in:st=0:d=${fmtTime(fadeIn)}` : '') +
      (fadeOut > 0 ? `,afade=t=out:st=${fmtTime(Math.max(0, dur - fadeOut))}:d=${fmtTime(fadeOut)}` : '');
    parts.push(`[${audioBase + c.file}:a]atrim=start=${fmtTime(c.sourceIn)}:end=${fmtTime(c.sourceOut)},asetpts=PTS-STARTPTS,volume=${vol}${fadeFilters},${norm}${delayFilter}[${out}]`);
    mixInputs.push(out);
  }

  let audioLabel;
  if (mixInputs.length === 1) {
    audioLabel = origAudioLabel;
  } else {
    audioLabel = `au_mixed`;
    parts.push(
      `[${mixInputs.join('][')}]amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0:normalize=0,` +
      `aresample=44100[${audioLabel}]`
    );
  }

  // --- overlays after concat (same filters as v1, output-relative times) ---
  label = (() => {
    let l = label;
    if (s.zooms && s.zooms.length > 0) {
      const out = nextLabel();
      const zoomFilter = buildZoomFilter(s.zooms, W, H, EDITOR_PROJECT_FPS);
      parts.push(`[${l}]${zoomFilter}[${out}]`);
      l = out;
    }
    for (const b of s.blurs) {
      const X = Math.min(W - 1, Math.round(b.x * W));
      const Y = Math.min(H - 1, Math.round(b.y * H));
      const PW = Math.min(W - X, px(b.w, W));
      const PH = Math.min(H - Y, px(b.h, H));
      const en = `enable='${enableBetween(b.start, b.end)}'`;
      const out = nextLabel();
      if (b.mode === 'blur') {
        const R = Math.min(30, Math.max(2, Math.round(Math.min(PW, PH) / 6)));
        parts.push(
          `[${l}]split[bs${parts.length}][bv${parts.length}];` +
          `[bs${parts.length}]crop=${PW}:${PH}:${X}:${Y},boxblur=${R}:1[bx${parts.length}];` +
          `[bv${parts.length}][bx${parts.length}]overlay=${X}:${Y}:${en}[${out}]`
        );
      } else {
        parts.push(`[${l}]drawbox=x=${X}:y=${Y}:w=${PW}:h=${PH}:color=black@1:t=fill:${en}[${out}]`);
      }
      l = out;
    }
    for (const t of s.texts) {
      const X = keyframeExpr(t.keyframes, 'x', t.x, t.start, W);
      const Y = keyframeExpr(t.keyframes, 'y', t.y, t.start, H);
      const FS = keyframeExpr(t.keyframes, 'scale', 1, t.start, Math.min(256, Math.max(12, Math.round(t.size * H))));
      const alpha = keyframeExpr(t.keyframes, 'opacity', 1, t.start);
      const en = `enable='${enableBetween(t.start, t.end)}'`;
      const box = t.bg ? `:box=1:boxcolor=${t.bg}:boxborderw=10` : '';
      const out = nextLabel();
      parts.push(
        `[${l}]drawtext=fontfile='${escapeDrawtextFontFile(fontFile)}':text='${escapeDrawtextText(t.text)}':fontsize='${FS}':fontcolor=${t.color}:alpha='${alpha}'${box}:x='${X}':y='${Y}':${en}[${out}]`
      );
      l = out;
    }
    return l;
  })();
  orderedImages.forEach(({ im }, k) => {
    const n = imageBase + k;
    const baseIW = toEven(Math.min(W, Math.max(8, im.w * W)));
    const IW = keyframeExpr(im.keyframes, 'scale', 1, im.start, baseIW);
    const X = keyframeExpr(im.keyframes, 'x', im.x, im.start, W);
    const Y = keyframeExpr(im.keyframes, 'y', im.y, im.start, H);
    const alpha = keyframeExpr(im.keyframes, 'opacity', 1, im.start);
    const en = `enable='${enableBetween(im.start, im.end)}'`;
    const out = nextLabel();
    const imCrop = im.crop
      ? `crop=w=trunc(iw*${roundFrac(im.crop.right - im.crop.left)}/2)*2:h=trunc(ih*${roundFrac(im.crop.bottom - im.crop.top)}/2)*2:x=trunc(iw*${roundFrac(im.crop.left)}/2)*2:y=trunc(ih*${roundFrac(im.crop.top)}/2)*2,`
      : '';
    parts.push(`[${n}:v]${imCrop}scale=w='trunc((${IW})/2)*2':h=-2:eval=frame,format=rgba,lut=a='val*(${alpha})'[ovr${n}];[${label}][ovr${n}]overlay=x='${X}':y='${Y}':eval=frame:${en}[${out}]`);
    label = out;
  });
  // Second video overlay track (picture-in-picture), below the watermark.
  // Each entry trims its source input to the needed range, offsets it onto
  // the timeline, scales it (exact rect, or aspect-preserved without h) and
  // overlays it inside its time window. Only the :v stream is ever used —
  // overlay audio is muted by construction. Sorted by start for determinism.
  for (const ov of [...(s.videoOverlays || [])].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const dur = ov.end - ov.start;
    const IW = toEven(Math.min(W, Math.max(8, ov.w * W)));
    const IH = ov.h != null ? toEven(Math.min(H, Math.max(8, ov.h * H))) : -2;
    const X = toEven(Math.min(W - 8, Math.round(ov.x * W)));
    const Y = toEven(Math.min(H - 8, Math.round(ov.y * H)));
    const en = `enable='${enableBetween(ov.start, ov.end)}'`;
    const out = nextLabel();
    const ovCrop = ov.crop
      ? `crop=w=trunc(iw*${roundFrac(ov.crop.right - ov.crop.left)}/2)*2:h=trunc(ih*${roundFrac(ov.crop.bottom - ov.crop.top)}/2)*2:x=trunc(iw*${roundFrac(ov.crop.left)}/2)*2:y=trunc(ih*${roundFrac(ov.crop.top)}/2)*2,`
      : '';
    let shapeFilter = '';
    let shapeAlpha = null;
    const ovShape = ov.shape ? String(ov.shape).trim().toLowerCase() : 'rect';
    if (ovShape === 'circle' || ovShape === 'ellipse') {
      shapeAlpha = `if(lte(pow((X-W/2)/(W/2),2)+pow((Y-H/2)/(H/2),2),1),255,0)`;
      shapeFilter = `,format=yuva420p,geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='${shapeAlpha}'`;
    } else if (ovShape === 'rounded' || ovShape === 'rounded-rect' || ovShape === 'round') {
      shapeAlpha = `if(lte(pow(max(abs(X-W/2)-(W/2-min(W,H)*0.12),0),2)+pow(max(abs(Y-H/2)-(H/2-min(W,H)*0.12),0),2),pow(min(W,H)*0.12,2)),255,0)`;
      shapeFilter = `,format=yuva420p,geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='${shapeAlpha}'`;
    }
    // Webcam-bubble polish: mirror and soft shadow are no-ops when unset,
    // keeping legacy output byte-identical.
    const flipSuffix = ov.mirror ? ',hflip' : '';
    const shadowAmt = typeof ov.shadow === 'number' && ov.shadow > 0 ? Math.min(1, ov.shadow) : 0;
    if (!shadowAmt) {
      parts.push(
        `[${ov.file}:v]trim=start=${fmtTime(ov.sourceIn || 0)}:end=${fmtTime((ov.sourceIn || 0) + dur)},` +
        `setpts=PTS-STARTPTS+${fmtTime(ov.start)}/TB,${ovCrop}scale=${IW}:${IH}${flipSuffix},setsar=1${shapeFilter}[ov${out}];` +
        `[${label}][ov${out}]overlay=${X}:${Y}:${en}[${out}]`
      );
    } else {
      // Shadow reuses the scaled frames: shaped black silhouette at reduced
      // opacity, blurred, offset down-right, composited first so the bubble
      // paints on top. Alpha mask matches the bubble shape when set.
      const shOp = Math.round(shadowAmt * 100) / 100;
      const shSigma = Math.min(24, Math.max(2, Math.round(IW / 24)));
      const shOff = toEven(Math.max(2, Math.round(Math.min(W, H) / 240)));
      const shMask = shapeAlpha
        ? `format=yuva420p,geq=lum=16:cb=128:cr=128:a='${shapeAlpha}'`
        : `format=yuva420p`;
      const videoSide = shapeFilter
        ? `[ovr${out}]${shapeFilter.slice(1)}[ov${out}]`
        : `[ovr${out}]copy[ov${out}]`;
      parts.push(
        `[${ov.file}:v]trim=start=${fmtTime(ov.sourceIn || 0)}:end=${fmtTime((ov.sourceIn || 0) + dur)},` +
        `setpts=PTS-STARTPTS+${fmtTime(ov.start)}/TB,${ovCrop}scale=${IW}:${IH}${flipSuffix},setsar=1,split=2[ovr${out}][ovsh${out}];` +
        `${videoSide};` +
        `[ovsh${out}]${shMask},colorchannelmixer=aa=${shOp},gblur=sigma=${shSigma}[sh${out}];` +
        `[${label}][sh${out}]overlay=${X + shOff}:${Y + shOff}:${en}[sht${out}];` +
        `[sht${out}][ov${out}]overlay=${X}:${Y}:${en}[${out}]`
      );
    }
    label = out;
  }
  // Same burned-in brand watermark as V1 (topmost, full duration).
  for (const watermark of (s.watermarks || (s.watermark ? [s.watermark] : []))) {
    if (!watermark || !watermark.enabled) continue;
    const out = nextLabel();
    parts.push(`[${label}]${watermarkDrawtextFilter({ width: W, height: H, watermark, fontFile })}[${out}]`);
    label = out;
  }

  // Export resolution: scale only when a specific quality is selected AND it
  // is a downscale (target height < frame height). Original (null), equal or
  // larger targets keep source pixels: aspect preserved via width=-2, no
  // wasteful upscaling.
  const exportHeight = s.exportHeight || null;
  if (exportHeight && exportHeight < H) {
    const out = nextLabel();
    parts.push(`[${label}]scale=-2:${exportHeight}[${out}]`);
    label = out;
  }

  args.push(...inputs);
  const filter = parts.join(';');
  args.push('-filter_complex', filter, '-map', `[${label}]`, '-map', `[${audioLabel}]`);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-movflags', '+faststart', outputPath);
  return args;
}

// ---- Minimal multipart/form-data parser (dependency-free) ----
// Only what the editor client sends: text fields + media files (video,
// audio and image parts). Byte-exact Buffer scanning; binary-safe.

export function getMultipartBoundary(contentType) {
  if (typeof contentType !== 'string') return null;
  const m = contentType.match(/boundary=([^;]+)/i);
  if (!m) return null;
  let b = m[1].trim();
  if (b.length >= 2 && b.startsWith('"') && b.endsWith('"')) b = b.slice(1, -1);
  if (!/^[A-Za-z0-9\-_]{1,128}$/.test(b)) return null;
  return b;
}

function parsePartHeaders(headerText) {
  const headers = {};
  for (const line of headerText.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

function parseContentDisposition(value) {
  const out = { name: null, filename: null };
  if (typeof value !== 'string') return out;
  const nameM = value.match(/name="([^"]*)"/);
  if (nameM) out.name = nameM[1];
  const fileM = value.match(/filename="([^"]*)"/);
  if (fileM) out.filename = fileM[1];
  return out;
}

export function parseMultipartForm(body, boundary) {
  const fields = {};
  const files = [];
  if (!Buffer.isBuffer(body) || typeof boundary !== 'string' || !boundary) {
    return { fields, files };
  }
  const delimiter = Buffer.from(`--${boundary}`);
  const closeDelimiter = Buffer.from(`--${boundary}--`);
  const CRLF = Buffer.from('\r\n');
  const HEADER_SEP = Buffer.from('\r\n\r\n');

  // Find all delimiter positions (must be at buffer start or after CRLF).
  const positions = [];
  let from = 0;
  for (;;) {
    const idx = body.indexOf(delimiter, from);
    if (idx === -1) break;
    if (idx === 0 || body.subarray(idx - 2, idx).equals(CRLF)) positions.push(idx);
    from = idx + delimiter.length;
    if (from >= body.length) break;
  }
  for (let i = 0; i + 1 < positions.length; i++) {
    let partStart = positions[i] + delimiter.length;
    // Skip the trailing '--' of the close delimiter (epilogue reached).
    if (body.subarray(partStart, partStart + 2).equals(Buffer.from('--'))) break;
    if (body.subarray(partStart, partStart + 2).equals(CRLF)) partStart += 2;
    let partEnd = positions[i + 1];
    if (partEnd >= 2 && body.subarray(partEnd - 2, partEnd).equals(CRLF)) partEnd -= 2;
    if (partEnd <= partStart) continue;
    const part = body.subarray(partStart, partEnd);
    const sepIdx = part.indexOf(HEADER_SEP);
    if (sepIdx === -1) continue;
    const headers = parsePartHeaders(part.subarray(0, sepIdx).toString('latin1'));
    const data = part.subarray(sepIdx + HEADER_SEP.length);
    const disp = parseContentDisposition(headers['content-disposition']);
    if (!disp.name) continue;
    if (disp.filename !== null && disp.filename !== undefined && disp.filename !== '') {
      files.push({
        fieldName: disp.name,
        filename: disp.filename,
        contentType: headers['content-type'] || 'application/octet-stream',
        data: Buffer.from(data)
      });
    } else {
      const text = data.toString('utf8');
      if (fields[disp.name] === undefined) fields[disp.name] = text;
      else if (Array.isArray(fields[disp.name])) fields[disp.name].push(text);
      else fields[disp.name] = [fields[disp.name], text];
    }
  }
  // Silence unused-var lint for closeDelimiter reference clarity (kept for spec readability).
  void closeDelimiter;
  return { fields, files };
}
