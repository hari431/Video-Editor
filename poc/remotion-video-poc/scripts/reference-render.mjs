// Reference render with SYSTEM ffmpeg implementing the same EDL fixture.
// Mirrors what the existing buildV2Args() pipeline does (trim -> PiP overlay
// -> drawtext text -> drawtext watermark last -> aac audio), so the POC has
// measured numbers even where Remotion's bundled binaries are blocked.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Portable font resolution (POC-local). Order:
// 1. VIDEO_EDITOR_FONT env (must be an existing file)
// 2. Linux DejaVuSans
// 3. Windows Arial
// Otherwise throws, listing the supported options.
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

// Escape a font path for the ffmpeg drawtext filter (single-quoted value).
function escapeFontFile(p) {
  return String(p).replace(/\\/g, '/').replace(/'/g, "\\'").replace(/:/g, '\\:');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const pub = path.join(root, 'public');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const { path: fontPath, source: fontSource } = resolveEditorFont();
console.log(`[reference] font: ${fontPath} (via ${fontSource})`);
const font = escapeFontFile(fontPath);
const out = path.join(root, 'out', 'out.mp4');

const ovW = 358;
const ovX = 870;
const ovY = 29;
const filter =
  `[1:v]scale=${ovW}:-2[ov];` +
  `[0:v][ov]overlay=${ovX}:${ovY}:enable='between(t,1,5)'[v1];` +
  `[v1]drawtext=fontfile='${font}':text='Guidewire POC':fontsize=36:fontcolor=#FFFFFF:x=64:y=36:enable='between(t,1,6)'[v2];` +
  `[v2]drawtext=fontfile='${font}':text='Learn with me':fontsize=32:fontcolor=#FFFFFF@0.75:shadowcolor=black@0.6:shadowx=2:shadowy=2:x=w-text_w-14:y=h-text_h-14[vout]`;

const args = [
  '-y',
  '-ss', '2.0', '-t', '6.0', '-i', path.join(pub, 'main.mp4'),
  '-ss', '0', '-t', '4.0', '-i', path.join(pub, 'overlay.mp4'),
  '-ss', '2.0', '-t', '6.0', '-i', path.join(pub, 'audio.m4a'),
  '-filter_complex', filter,
  '-map', '[vout]', '-map', '2:a',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-movflags', '+faststart', '-shortest', out,
];
console.log('[reference] system ffmpeg render...');
const t0 = Date.now();
const r = spawnSync(ffmpeg, args, { stdio: 'inherit' });
if (r.status !== 0) throw new Error(`reference render failed (${r.status})`);
console.log(`[reference] done in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${out}`);
