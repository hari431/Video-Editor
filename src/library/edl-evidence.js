// src/library/edl-evidence.js — EDL transcript-evidence validation + EDL->V2 mapping.
//
// SCOPE: PURE (no fs, no child_process, no network, no STT/AI). Validates a
// hand-authored, video-use-style EDL against timestamped transcript evidence
// BEFORE any V2 spec is generated or rendered. Transcripts are supplied
// manually; this module generates none and understands no video content.
//
// Provenance: ported verbatim from the isolated poc/edl-verify experiment
// (evidence.mjs + adapter mapping), which remains available as a standalone
// test harness and now re-exports this module — one rule source, no drift.
// Nothing in the existing editor, validation, or rendering logic is altered.

export const EVIDENCE_EPS = 0.001;
export const EVIDENCE_SILENCE_PREFER_S = 0.3;
export const EVIDENCE_GROUND_TOLERANCE_S = 0.5;
export const EVIDENCE_MAX_BODY_BYTES = 1024 * 1024;

// Output-frame defaults when the EDL omits dimensions. 1280x720 matches the
// POC fixtures and test media and is the standard HD canvas the pipeline's
// scale/pad stage handles natively. Defaults fill OMISSION only — a supplied
// value must be an integer 16..7680 (mirroring validateSpecV2) and anything
// else fails explicitly; invalid values are never coerced or rounded into
// range.
export const EDL_DEFAULT_WIDTH = 1280;
export const EDL_DEFAULT_HEIGHT = 720;
export const EDL_MIN_DIMENSION = 16;
export const EDL_MAX_DIMENSION = 7680;

// Resolve output dimensions for an EDL.
// Returns { ok, width?, height?, error? }: both absent -> defaults; exactly
// one present -> error (must be provided together); present values must be
// integers 16..7680.
export function resolveEdlDimensions(edl) {
  const raw = edl && typeof edl === 'object' ? edl : {};
  const hasW = raw.width !== undefined && raw.width !== null;
  const hasH = raw.height !== undefined && raw.height !== null;
  if (!hasW && !hasH) return { ok: true, width: EDL_DEFAULT_WIDTH, height: EDL_DEFAULT_HEIGHT };
  if (hasW !== hasH) return { ok: false, error: 'width and height must be provided together.' };
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < EDL_MIN_DIMENSION || width > EDL_MAX_DIMENSION ||
      height < EDL_MIN_DIMENSION || height > EDL_MAX_DIMENSION) {
    return { ok: false, error: 'width/height must be integers between 16 and 7680.' };
  }
  return { ok: true, width, height };
}

function normWord(text) {
  return String(text || '').toLowerCase().replace(/[.,!?;:'"()\-[\]]/g, '').trim();
}

function normQuote(text) {
  return String(text || '').toLowerCase().replace(/[.,!?;:'"()\-[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isSentenceEnd(text) {
  return /[.!?]$/.test(String(text || '').trim());
}

function isSkippedQuote(quote) {
  if (quote === undefined || quote === null) return true;
  const t = String(quote).trim();
  return t === '' || /^n\/a\b/i.test(t);
}

// Structural check of one source's word list. Returns an error string or null.
// Zero evidence must never validate silently (fail closed).
function validateWords(words) {
  if (!Array.isArray(words)) return 'transcript words must be an array';
  if (words.length === 0) return 'no transcript words for source (zero evidence cannot validate)';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w || typeof w !== 'object') return `transcript word[${i}] is malformed (not an object)`;
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) {
      return `transcript word[${i}] is malformed (start/end must be finite numbers)`;
    }
    if (w.end < w.start) return `transcript word[${i}] is malformed (end < start)`;
    if (typeof w.text !== 'string') return `transcript word[${i}] is malformed (text must be a string)`;
  }
  return null;
}

// Words overlapping [start, end).
function wordsInRange(words, start, end) {
  return words.filter((w) => w.end > start + EVIDENCE_EPS && w.start < end - EVIDENCE_EPS);
}

// Single edge check against one source's words + duration.
// Returns { ok, error?, warning? }. Word-boundary cuts during speech PASS
// with a warning; silence gaps and sentence boundaries pass silently.
export function checkEvidenceEdge(words, duration, t, label = 'edge') {
  if (typeof t !== 'number' || !Number.isFinite(t)) {
    return { ok: false, error: `${label}: not a number` };
  }
  if (t < -EVIDENCE_EPS || t > duration + EVIDENCE_EPS) {
    return { ok: false, error: `${label} t=${t}s outside source duration 0..${duration}s` };
  }
  const inside = words.find((w) => w.start + EVIDENCE_EPS < t && t < w.end - EVIDENCE_EPS);
  if (inside) {
    return { ok: false, error: `${label} t=${t}s falls inside word "${inside.text}" [${inside.start}-${inside.end}]` };
  }
  const prev = words.filter((w) => w.end <= t + EVIDENCE_EPS).sort((a, b) => b.end - a.end)[0] || null;
  const next = words.filter((w) => w.start >= t - EVIDENCE_EPS).sort((a, b) => a.start - b.start)[0] || null;
  if (!prev || !next) {
    return { ok: true, warning: null };
  }
  const gap = next.start - prev.end;
  if (isSentenceEnd(prev.text) || gap >= EVIDENCE_SILENCE_PREFER_S) {
    return { ok: true, warning: null };
  }
  return { ok: true, warning: `${label} t=${t}s is a word-boundary cut during speech (gap ${Math.round(gap * 1000)}ms) — allowed` };
}

function checkEvidenceQuote(words, start, end, quote, label) {
  if (isSkippedQuote(quote)) return { ok: true, skipped: true };
  const want = normQuote(quote).split(' ').filter(Boolean);
  if (want.length === 0) return { ok: true, skipped: true };
  const have = wordsInRange(words, start, end).map((w) => normWord(w.text)).filter(Boolean);
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.every((tok, k) => have[i + k] === tok)) return { ok: true, skipped: false };
  }
  return { ok: false, error: `${label}: quote is not a contiguous run of transcript words in [${start}-${end}]` };
}

// Full EDL evidence check. Transcript shape:
//   { sources: { <key>: { duration, words: [{text, start, end}] } } }
// Returns { ok, errors[], warnings[] }.
export function checkEdlEvidence(edl, transcript) {
  const errors = [];
  const warnings = [];
  const ranges = edl && Array.isArray(edl.ranges) ? edl.ranges : [];
  if (ranges.length === 0) return { ok: false, errors: ['no ranges'], warnings };
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const label = `ranges[${i}]${r.beat ? ` (${r.beat})` : ''}`;
    const src = transcript && transcript.sources ? transcript.sources[r.source] : null;
    if (!src) {
      errors.push(`${label}: no transcript coverage for source "${r.source}"`);
      continue;
    }
    const words = src.words || [];
    const wordsError = validateWords(words);
    if (wordsError) {
      errors.push(`${label}: ${wordsError}`);
      continue;
    }
    const duration = Number(src.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      errors.push(`${label}: transcript source has no usable duration`);
      continue;
    }
    for (const [t, name] of [[r.start, 'start'], [r.end, 'end']]) {
      const res = checkEvidenceEdge(words, duration, Number(t), `${label}.${name}`);
      if (!res.ok) errors.push(res.error);
      else if (res.warning) warnings.push(res.warning);
    }
    const q = checkEvidenceQuote(words, Number(r.start), Number(r.end), r.quote, label);
    if (!q.ok) errors.push(q.error);
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Minimal structural validation of a hand-authored EDL (mirrors the POC
// adapter: known sources, ordered positive spans, total consistency).
// Returns { ok, error? } — single first failure, fail fast.
export function validateEdlStructure(edl) {
  if (!edl || typeof edl !== 'object' || Array.isArray(edl)) return { ok: false, error: 'EDL must be an object.' };
  if (!Array.isArray(edl.ranges) || edl.ranges.length === 0) return { ok: false, error: 'ranges must be a non-empty array.' };
  let cursor = 0;
  for (let i = 0; i < edl.ranges.length; i++) {
    const r = edl.ranges[i];
    if (!r || typeof r !== 'object') return { ok: false, error: `ranges[${i}] must be an object.` };
    if (typeof r.source !== 'string' || !edl.sources || !edl.sources[r.source]) {
      return { ok: false, error: `ranges[${i}] references an unknown source.` };
    }
    const start = Number(r.start);
    const end = Number(r.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start) || start < 0) {
      return { ok: false, error: `ranges[${i}]: end must be after start, start >= 0.` };
    }
    if (Math.round((end - start) * 1000) < 100) return { ok: false, error: `ranges[${i}]: range must be at least 0.1s.` };
    cursor = Math.round((cursor + (end - start)) * 1000) / 1000;
  }
  const total = Number(edl.total_duration_s);
  if (!Number.isFinite(total) || Math.abs(cursor - total) > 0.001) {
    return { ok: false, error: `total_duration_s (${edl.total_duration_s}) does not match kept content (${cursor}s).` };
  }
  const dims = resolveEdlDimensions(edl);
  if (!dims.ok) return { ok: false, error: dims.error };
  // Collection type gates: edlToSpecV2 reads these unconditionally, so
  // non-arrays or non-object entries must fail here with a controlled error
  // instead of throwing a TypeError downstream.
  for (const key of ['texts', 'overlays']) {
    const list = edl[key];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) return { ok: false, error: `${key} must be an array.` };
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return { ok: false, error: `${key}[${i}] must be an object.` };
      }
    }
  }
  return { ok: true };
}

// Bare-filename gate for EDL source values (production allowlist primitive:
// no slashes, no absolute paths, no dotfiles, bounded length). Returns the
// name or null when rejected. Transcript coverage is enforced separately by
// checkEdlEvidence, so only names declared in BOTH reach any further step —
export function allowlistedEdlSource(value, allowedNames) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  if (value.includes('/') || value.includes('\\') || value.startsWith('.')) return null;
  if (/^[a-zA-Z]:/.test(value)) return null;
  if (value !== value.trim()) return null;
  if (Array.isArray(allowedNames) && !allowedNames.includes(value)) return null;
  return value;
}

// Map an EDL to the existing V2 spec shape (adapter mapping, ported verbatim
// in behavior: ranges back-to-back from 0, files in first-use order, overlay
// h omitted for aspect preservation, appendMediaClip gain/volume/fade defaults).
export function edlToSpecV2(edl) {
  if (!edl || typeof edl !== 'object' || Array.isArray(edl) || !Array.isArray(edl.ranges)) {
    throw new Error('EDL must be an object with a ranges array.');
  }
  if (!edl.sources || typeof edl.sources !== 'object') {
    throw new Error('EDL must declare a sources map.');
  }
  const texts = edl.texts === undefined || edl.texts === null ? [] : edl.texts;
  if (!Array.isArray(texts)) throw new Error('EDL texts must be an array.');
  const overlays = edl.overlays === undefined || edl.overlays === null ? [] : edl.overlays;
  if (!Array.isArray(overlays)) throw new Error('EDL overlays must be an array.');
  for (const [key, list] of [['texts', texts], ['overlays', overlays]]) {
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`EDL ${key}[${i}] must be an object.`);
      }
    }
  }
  const dims = resolveEdlDimensions(edl);
  if (!dims.ok) throw new Error(dims.error);
  const videoNames = [];
  for (const r of edl.ranges) {
    const name = edl.sources[r.source];
    if (!videoNames.includes(name)) videoNames.push(name);
  }
  for (const ov of overlays) {
    if (!videoNames.includes(ov.file)) videoNames.push(ov.file);
  }
  let cursor = 0;
  const videoClips = edl.ranges.map((r) => {
    const dur = Math.round((r.end - r.start) * 1000) / 1000;
    const clip = {
      file: videoNames.indexOf(edl.sources[r.source]),
      sourceIn: r.start,
      sourceOut: r.end,
      start: Math.round(cursor * 1000) / 1000,
      gain: 1,
      volumeDb: 0,
      fadeIn: 0,
      fadeOut: 0,
    };
    cursor = Math.round((cursor + dur) * 1000) / 1000;
    return clip;
  });
  return {
    version: 2,
    width: dims.width,
    height: dims.height,
    files: videoNames.map(() => ({ kind: 'video' })),
    videoClips,
    audioClips: [],
    blurs: [],
    texts: texts.map((t) => ({
      text: t.content,
      x: t.x, y: t.y, size: t.size, color: t.color, bg: null,
      start: t.start_in_output, end: t.end_in_output,
    })),
    images: [],
    videoOverlays: overlays.map((ov) => ({
      file: videoNames.indexOf(ov.file),
      x: ov.x, y: ov.y, w: ov.w, h: null,
      start: ov.start_in_output,
      end: ov.start_in_output + ov.duration,
      sourceIn: ov.sourceIn || 0,
      shape: 'rect',
    })),
    zooms: [],
    watermark: edl.watermark === undefined ? null : edl.watermark,
    resolution: 'original',
  };
}

// Readable cut summary for UI display (presentation only, no validation).
export function edlCutSummary(edl) {
  const ranges = Array.isArray(edl.ranges) ? edl.ranges : [];
  const kept = ranges.map((r) => ({
    source: r.source,
    start: Number(r.start),
    end: Number(r.end),
    duration: Math.round((Number(r.end) - Number(r.start)) * 1000) / 1000,
    beat: r.beat || null,
  }));
  const bySource = new Map();
  for (const k of kept) {
    if (!Number.isFinite(k.start) || !Number.isFinite(k.end)) continue;
    if (!bySource.has(k.source)) bySource.set(k.source, []);
    bySource.get(k.source).push(k);
  }
  const removed = [];
  for (const [source, list] of bySource) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const k of sorted) {
      if (k.start > cursor) removed.push({ source, start: cursor, end: k.start });
      cursor = Math.max(cursor, k.end);
    }
  }
  const expectedDuration = Math.round(kept.reduce((n, k) => n + (Number.isFinite(k.duration) ? k.duration : 0), 0) * 1000) / 1000;
  return { kept, removed, expectedDuration, trailingUnknown: true };
}
