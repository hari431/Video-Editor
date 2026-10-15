// Generates synthetic local-only assets with system FFmpeg. No network, no keys.
// main.mp4: 1280x720 testsrc2 10s + 440Hz sine stereo -> public/main.mp4
// overlay.mp4: 480x270 testsrc 10s (silent) -> public/overlay.mp4
// audio.wav: 880Hz sine 10s mono -> public/audio.wav
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
mkdirSync(pub, { recursive: true });
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

function run(args, label) {
  console.log(`[make-assets] ${label}: ffmpeg ${args.slice(0, 6).join(' ')} ...`);
  const r = spawnSync(ffmpeg, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

const main = path.join(pub, 'main.mp4');
const overlay = path.join(pub, 'overlay.mp4');
const audio = path.join(pub, 'audio.wav');

if (!existsSync(main)) {
  run(
    ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=10',
     '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10:sample_rate=48000',
     '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
     '-c:a', 'aac', '-shortest', main],
    'main.mp4',
  );
} else console.log('[make-assets] main.mp4 exists, skip');

if (!existsSync(overlay)) {
  run(
    ['-y', '-f', 'lavfi', '-i', 'testsrc=size=480x270:rate=30:duration=10',
     '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
     '-an', overlay],
    'overlay.mp4',
  );
} else console.log('[make-assets] overlay.mp4 exists, skip');

if (!existsSync(audio)) {
  run(
    ['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=10:sample_rate=48000',
     '-ac', '1', audio],
    'audio.wav',
  );
} else console.log('[make-assets] audio.wav exists, skip');

console.log('[make-assets] done');
