// Verifies a rendered MP4 with system ffprobe/ffmpeg (diagnostic only).
// Checks: duration ~= fixture total_duration_s, expected dimensions, has
// audio, frame grabs at the given output times, ebur128 loudness (DIAGNOSTIC
// — loudness numbers alone neither prove nor disprove boundary pops; see
// fade-audit for the structural check).
// Run: node scripts/verify.mjs [outMp4=out/out.mp4] [verificationOut=out/verification.json] [fixture=edl.fixture.json] [frameTimes=0.5,2,5.5]
// Exit non-zero on any check failure.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const out = path.join(root, process.argv[2] || path.join('out', 'out.mp4'));
const verificationName = process.argv[3] || path.join('out', 'verification.json');
const fixtureName = process.argv[4] || 'edl.fixture.json';
const frameTimes = (process.argv[5] || '0.5,2,5.5').split(',').map(Number);
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const edl = JSON.parse(readFileSync(path.join(root, fixtureName), 'utf8'));

function probe(args) {
  const r = spawnSync(ffprobe, args, { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

if (!existsSync(out)) {
  console.error(`[verify] FAIL: ${out} missing. Run render-spec first.`);
  process.exit(1);
}
const checks = {};
checks.sizeBytes = statSync(out).size;
checks.duration = Number(probe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]));
checks.width = Number(probe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', out]));
checks.height = Number(probe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', out]));
checks.hasAudio = probe(['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out]).includes('audio');

const framesDir = path.join(root, 'out', 'frames');
mkdirSync(framesDir, { recursive: true });
const frameKeys = [];
for (const t of frameTimes) {
  const key = `frame_t${String(t).replace('.', 'p')}`;
  frameKeys.push(key);
  const fp = path.join(framesDir, `${key}.png`);
  const r = spawnSync(ffmpeg, ['-y', '-ss', String(t), '-i', out, '-frames:v', '1', fp], { stdio: 'pipe' });
  checks[key] = r.status === 0 && existsSync(fp);
}
// Diagnostic loudness only: integrated + true peak for the record.
const loud = spawnSync(ffmpeg, ['-i', out, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
const tail = (loud.stderr || '').split('\n').filter((l) => l.includes('I:') || l.includes('Peak')).slice(-4).join(' | ');
checks.loudness = tail || 'n/a';

const results = { file: out, expectedDuration: edl.total_duration_s, checks };
const pass =
  Math.abs(checks.duration - edl.total_duration_s) < 0.4 &&
  checks.width === edl.width &&
  checks.height === edl.height &&
  checks.hasAudio &&
  checks.sizeBytes > 10000 &&
  frameKeys.every((k) => checks[k]);
results.pass = pass;
writeFileSync(path.join(root, verificationName), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
console.log(pass ? '[verify] PASS' : '[verify] FAIL (see verification output)');
process.exit(pass ? 0 : 1);
