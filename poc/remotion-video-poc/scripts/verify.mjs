// Verifies POC output with system ffprobe/ffmpeg. No Remotion APIs.
// Checks: exists, duration ~= 6s, 1280x720, has audio, loudness (ebur128),
// frame grabs at t=0.5/2/5.5s. Writes out/verification.json.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const out = path.join(root, 'out', 'out.mp4');
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const results = { file: out, checks: {} };

function probe(args) {
  const r = spawnSync(ffprobe, args, { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

if (!existsSync(out)) {
  console.error('[verify] FAIL: out/out.mp4 missing. Run npm run render first.');
  process.exit(1);
}
results.checks.sizeBytes = statSync(out).size;
results.checks.duration = Number(probe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]));
results.checks.width = Number(probe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', out]));
results.checks.height = Number(probe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', out]));
results.checks.hasAudio = probe(['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out]).includes('audio');

mkdirSync(path.join(root, 'out', 'frames'), { recursive: true });
for (const t of [0.5, 2, 5.5]) {
  const fp = path.join(root, 'out', 'frames', `t${t}.png`);
  const r = spawnSync(ffmpeg, ['-y', '-ss', String(t), '-i', out, '-frames:v', '1', fp], { stdio: 'pipe' });
  results.checks[`frame_t${t}`] = r.status === 0 && existsSync(fp);
}
const loud = spawnSync(ffmpeg, ['-i', out, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
const tail = (loud.stderr || '').split('\n').filter((l) => l.includes('I:') || l.includes('Peak')).slice(-4).join(' | ');
results.checks.loudness = tail || 'n/a';

const pass =
  Math.abs(results.checks.duration - 6.0) < 0.4 &&
  results.checks.width === 1280 &&
  results.checks.height === 720 &&
  results.checks.hasAudio &&
  results.checks.sizeBytes > 10000;
results.pass = pass;
writeFileSync(path.join(root, 'out', 'verification.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
console.log(pass ? '[verify] PASS' : '[verify] FAIL (see out/verification.json)');
process.exit(pass ? 0 : 1);
