// poc/edl-verify/adapter.mjs — READ-ONLY adapter.
// Maps a hand-authored video-use-style EDL fixture to the existing V2 spec
// shape consumed by validateSpecV2()/buildV2Args().
// Reuses geometry thinking from ../../src/public/video-editor-project.js by
// reference only (fractions 0..1, output-relative overlay times); it does NOT
// duplicate the project model and modifies nothing outside this directory.
// Run: node adapter.mjs [fixture=edl.fixture.json] [v2specOut=edl.v2spec.json] [assetsOut] [--evidence transcript.json]
//   When assetsOut is given, also writes {videoPaths, audioPaths} with
//   absolute asset paths: bare source names resolve against this POC's
//   public/; path-like values resolve against the repo root.
//   With --evidence, the EDL is validated against transcript evidence AFTER
//   source/asset resolution and duration grounding but BEFORE any V2 spec or
//   assets are written. Errors fail closed (exit 1, nothing written);
//   warnings go to stderr and the run continues. Without the flag, behavior
//   is exactly as before (no transcript needed).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEdl } from './evidence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');

// Optional flag: --evidence <transcript.json>. Positional args keep their
// legacy meaning and defaults, so behavior without the flag is unchanged.
const rawArgs = process.argv.slice(2);
let evidencePath = null;
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--evidence') {
    evidencePath = rawArgs[++i] || null;
    if (!evidencePath) fail('--evidence requires a transcript path');
  } else {
    positional.push(rawArgs[i]);
  }
}
const fixtureName = positional[0] || 'edl.fixture.json';
const v2specName = positional[1] || 'edl.v2spec.json';
const assetsName = positional[2] || null;

const edl = JSON.parse(readFileSync(path.join(here, fixtureName), 'utf8'));

function fail(msg) {
  console.error(`adapter FAIL: ${msg}`);
  process.exit(1);
}

// Minimal fixture validation (structural only — no STT/word-boundary source in
// this phase; boundary checks are documented for a later transcription phase).
if (!Array.isArray(edl.ranges) || edl.ranges.length === 0) fail('ranges must be a non-empty array');
for (const r of edl.ranges) {
  if (typeof r.source !== 'string' || !edl.sources[r.source]) fail(`range references unknown source ${r.source}`);
  if (!(r.end > r.start) || r.start < 0) fail('range end must be after start, start >= 0');
  if (Math.round((r.end - r.start) * 1000) < 100) fail('range must be at least 0.1s');
}

// Resolve a source value to an absolute asset path. Bare filenames live in
// this POC's public/; path-like values are repo-relative (keeps fixtures
// portable across checkouts).
function resolveAsset(value) {
  if (typeof value !== 'string' || value.length === 0) fail('source value must be a non-empty string');
  const base = (value.includes('/') || value.includes('\\') || path.isAbsolute(value)) ? repoRoot : path.join(here, 'public');
  return path.resolve(base, value);
}

// Unique video files in first-use order across ranges then overlays.
const videoNames = [];
for (const r of edl.ranges) {
  const name = edl.sources[r.source];
  if (!videoNames.includes(name)) videoNames.push(name);
}
for (const ov of edl.overlays || []) {
  const name = ov.file;
  if (!videoNames.includes(name)) videoNames.push(name);
}
const videoPaths = videoNames.map(resolveAsset);
for (const p of videoPaths) {
  if (!existsSync(p)) fail(`missing asset ${p}`);
}

// Ranges map onto the output timeline back-to-back starting at 0.
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
    // Defaults mirror appendMediaClip (fadeIn: 0, fadeOut: 0): no boundary
    // fades. The fade-audit step evidences this gap; the library is untouched.
    fadeIn: 0,
    fadeOut: 0,
  };
  cursor = Math.round((cursor + dur) * 1000) / 1000;
  return clip;
});
const contentEnd = cursor;
if (Math.abs(contentEnd - edl.total_duration_s) > 0.001) {
  fail(`total_duration_s (${edl.total_duration_s}) != contentEnd (${contentEnd})`);
}

// Transcript-evidence gate (opt-in only). Runs after source/asset resolution
// and duration grounding, before any V2 spec or assets are written.
if (evidencePath) {
  runEvidenceGate();
}

function probeFileDuration(absPath) {
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', absPath], { encoding: 'utf8' });
  return Number((r.stdout || '').trim());
}

function runEvidenceGate() {
  let transcript;
  try {
    transcript = JSON.parse(readFileSync(path.resolve(here, evidencePath), 'utf8'));
  } catch (e) {
    fail(`cannot load transcript ${evidencePath}: ${e.message}`);
  }
  // Duration grounding: every EDL source covered by the transcript is probed;
  // disagreement beyond 0.5s fails closed; otherwise the ffprobe duration is
  // authoritative for edge bounds.
  const effective = JSON.parse(JSON.stringify(transcript));
  if (!effective.sources || typeof effective.sources !== 'object') {
    fail('transcript has no usable sources map');
  }
  for (const [key, assetName] of Object.entries(edl.sources)) {
    const entry = effective.sources[key];
    if (!entry) continue; // uncovered source -> checkEdl reports it
    const idx = videoNames.indexOf(assetName);
    if (idx < 0 || !videoPaths[idx]) continue;
    const probed = probeFileDuration(videoPaths[idx]);
    if (!Number.isFinite(probed) || probed <= 0) {
      fail(`cannot probe duration for source "${key}" (${videoPaths[idx]})`);
    }
    const declared = Number(entry.duration);
    if (!Number.isFinite(declared) || declared <= 0) {
      fail(`transcript source "${key}" has no usable duration`);
    }
    if (Math.abs(probed - declared) >= 0.5) {
      fail(`duration disagreement for source "${key}": transcript ${declared}s vs file ${probed}s (tolerance 0.5s)`);
    }
    entry.duration = probed; // ffprobe is authoritative
  }
  const res = checkEdl(edl, effective);
  for (const w of res.warnings) console.error(`adapter warning: ${w}`);
  if (!res.ok) {
    for (const e of res.errors) console.error(`adapter evidence FAIL: ${e}`);
    console.error('adapter FAIL: transcript evidence rejected the EDL (no V2 spec written)');
    process.exit(1);
  }
  console.log(`adapter evidence ok (${res.warnings.length} warning(s))`);
}

const v2spec = {
  version: 2,
  width: edl.width,
  height: edl.height,
  files: videoNames.map(() => ({ kind: 'video' })),
  videoClips,
  audioClips: [],
  blurs: [],
  texts: (edl.texts || []).map((t) => ({
    text: t.content,
    x: t.x,
    y: t.y,
    size: t.size,
    color: t.color,
    bg: null,
    start: t.start_in_output,
    end: t.end_in_output,
  })),
  images: [],
  videoOverlays: (edl.overlays || []).map((ov) => ({
    file: videoNames.indexOf(ov.file),
    x: ov.x,
    y: ov.y,
    w: ov.w,
    // h omitted -> aspect preserved by the pipeline (checkVideoOverlay).
    h: null,
    start: ov.start_in_output,
    end: ov.start_in_output + ov.duration,
    sourceIn: ov.sourceIn || 0,
    shape: 'rect',
  })),
  zooms: [],
  watermark: edl.watermark === undefined ? null : edl.watermark,
  resolution: 'original',
};

writeFileSync(path.join(here, v2specName), JSON.stringify(v2spec, null, 2) + '\n');
if (assetsName) {
  writeFileSync(path.join(here, assetsName), JSON.stringify({ videoPaths, audioPaths: [] }, null, 2) + '\n');
}
console.log(`adapter ok: ${edl.ranges.length} range(s), contentEnd=${contentEnd}s matches total_duration_s=${edl.total_duration_s}s`);
console.log('boundaryCheck: n/a (synthetic/real media without transcript — word/silence snapping documented for a later STT phase)');
