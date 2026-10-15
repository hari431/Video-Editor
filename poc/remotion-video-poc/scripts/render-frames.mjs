// Fallback render path: Chrome renders JPEG frames (Remotion), system FFmpeg
// stitches + muxes audio. Used because the compositor's bundled
// ffmpeg/ffprobe binaries fail to launch on this Windows box
// (exit -1058471934) while system FFmpeg 9.0 works.
import { bundle } from '@remotion/bundler';
import { getCompositions, renderFrames } from '@remotion/renderer';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

const inputProps = JSON.parse(readFileSync(path.join(root, 'edl.input-props.json'), 'utf8'));
const framesDir = path.join(root, 'out', 'frames-r');
mkdirSync(framesDir, { recursive: true });

console.log('[render-frames] bundling...');
const t0 = Date.now();
const serveUrl = await bundle({
  entryPoint: path.join(root, 'src', 'index.js'),
  publicDir: path.join(root, 'public'),
});
const compositions = await getCompositions(serveUrl, { inputProps });
const composition = compositions.find((c) => c.id === 'GuidewirePoc');
if (!composition) throw new Error('GuidewirePoc not found');

console.log('[render-frames] rendering 180 JPEG frames via Chrome...');
await renderFrames({
  composition,
  serveUrl,
  inputProps,
  outputDir: framesDir,
  imageFormat: 'jpeg',
  onFrameUpdate: (i) => {
    if (i % 30 === 0) process.stdout.write(`\rframe ${i}/180`);
  },
});
console.log('\nframes ok');

const silent = path.join(root, 'out', 'silent.mp4');
let r = spawnSync(ffmpeg, ['-y', '-framerate', '30', '-i', path.join(framesDir, 'element-*.jpeg'), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', silent], { stdio: 'inherit' });
if (r.status !== 0) throw new Error('stitch failed');
const outPath = path.join(root, 'out', 'out.mp4');
// Mux trimmed main audio (2s..8s) under the stitched video for the POC.
r = spawnSync(ffmpeg, ['-y', '-i', silent, '-ss', '2.0', '-t', '6.0', '-i', path.join(root, 'public', 'main.mp4'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outPath], { stdio: 'inherit' });
if (r.status !== 0) throw new Error('mux failed');
console.log(`[render-frames] done in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outPath}`);
