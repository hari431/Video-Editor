// Renders an MP4 through the EXISTING pipeline code (read-only import).
// Mirrors what src/server.js does for a V2 export — validate spec, probe
// media facts, resolve font, build deterministic argv, spawn system ffmpeg —
// but writes only inside this POC directory. The library is never modified.
// Run: node scripts/render-spec.mjs [v2spec=edl.v2spec.json] [assetsJson] [outMp4=out/out.mp4] [infoOut=out/render-info.json]
//   When assetsJson is given, video/audio input paths come from it; otherwise
//   the legacy synthetic pair (public/main.mp4 + public/overlay.mp4) is used.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateSpecV2,
  buildV2Args,
} from '../../../src/library/video-editor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const pub = path.join(root, 'public');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';

// Portable font resolution (POC-local). Order: VIDEO_EDITOR_FONT env (must be
// an existing file), Linux DejaVuSans, Windows Arial; else throw with options.
function resolveEditorFont() {
  const candidates = [
    { source: 'VIDEO_EDITOR_FONT', path: process.env.VIDEO_EDITOR_FONT || null },
    { source: 'linux', path: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf' },
    { source: 'windows', path: 'C:/Windows/Fonts/arial.ttf' },
  ];
  for (const c of candidates) {
    try {
      if (typeof c.path === 'string' && c.path.length > 0 && existsSync(c.path) && statSync(c.path).isFile()) {
        return c;
      }
    } catch { /* try next */ }
  }
  const tried = candidates.map(c => `  - ${c.source}: ${c.path || '(not set)'}`).join('\n');
  throw new Error(
    `No usable font found for drawtext.\nTried:\n${tried}\nSupported options: set VIDEO_EDITOR_FONT to a .ttf file, or install DejaVuSans (Linux) / Arial (Windows).`
  );
}

function probeHasAudio(absPath) {
  const r = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', absPath], { encoding: 'utf8' });
  return (r.stdout || '').includes('audio');
}

const specName = process.argv[2] || 'edl.v2spec.json';
const assetsName = process.argv[3] || null;
const outName = process.argv[4] || path.join('out', 'out.mp4');
const infoName = process.argv[5] || path.join('out', 'render-info.json');

const spec = JSON.parse(readFileSync(path.join(root, specName), 'utf8'));
const checked = validateSpecV2(spec);
if (!checked.ok) {
  console.error(`render-spec FAIL: V2 spec invalid: ${checked.error}`);
  process.exit(1);
}
console.log(`[render-spec] spec valid, contentEnd=${checked.spec.contentEnd}s`);

// Input paths: sidecar assets file when given (real-input flow), else the
// legacy synthetic pair (default flow — behavior unchanged).
let videoPaths;
let audioPaths = [];
if (assetsName) {
  const assets = JSON.parse(readFileSync(path.join(root, assetsName), 'utf8'));
  videoPaths = assets.videoPaths;
  audioPaths = assets.audioPaths || [];
} else {
  videoPaths = [path.join(pub, 'main.mp4'), path.join(pub, 'overlay.mp4')];
}
for (const p of [...videoPaths, ...audioPaths]) {
  if (!existsSync(p)) {
    console.error(`render-spec FAIL: missing asset ${p}`);
    process.exit(1);
  }
}

// Media facts the graph depends on (mirrors server-side ffprobe; falls back
// to EDL-declared geometry like the server falls back to spec values).
const media = {
  width: spec.width,
  height: spec.height,
  hasAudio: videoPaths.map(probeHasAudio),
};
console.log(`[render-spec] media: ${media.width}x${media.height} hasAudio=${JSON.stringify(media.hasAudio)}`);

// A font is required only when the spec carries texts or an enabled
// watermark (mirrors the server gate); cuts-only specs render font-free.
const needsFont = checked.spec.texts.length > 0 || (checked.spec.watermark && checked.spec.watermark.enabled);
let fontFile = null;
let fontSource = 'none-needed';
if (needsFont) {
  const resolved = resolveEditorFont();
  fontFile = resolved.path;
  fontSource = resolved.source;
}
console.log(`[render-spec] font: ${fontFile || '(none needed)'} (via ${fontSource})`);

mkdirSync(path.join(root, 'out'), { recursive: true });
const outPath = path.join(root, outName);
const argv = buildV2Args({
  videoPaths,
  audioPaths,
  imagePaths: [],
  outputPath: outPath,
  spec: checked.spec,
  fontFile,
  media,
});

console.log('[render-spec] spawning system ffmpeg...');
const t0 = Date.now();
const r = spawnSync(ffmpeg, ['-nostdin', ...argv], { stdio: 'inherit' });
const wallMs = Date.now() - t0;
if (r.status !== 0) {
  console.error(`render-spec FAIL: ffmpeg exit ${r.status}`);
  process.exit(1);
}
const sizeBytes = statSync(outPath).size;
if (sizeBytes === 0) {
  console.error('render-spec FAIL: empty output');
  process.exit(1);
}
writeFileSync(
  path.join(root, infoName),
  JSON.stringify({ wallMs, sizeBytes, fontFile, fontSource, media, videoPaths, argv }, null, 2) + '\n',
);
console.log(`[render-spec] done in ${(wallMs / 1000).toFixed(1)}s -> ${outPath} (${sizeBytes} bytes)`);
