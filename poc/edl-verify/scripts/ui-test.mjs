// UI/API validation-path tests (POC-local, zero deps, no STT/network egress).
// Boots server.mjs on a test port and exercises the HTTP API:
// valid EDL, warnings, invalid cut, invalid quote, missing transcript,
// malformed JSON, path-traversal rejection, and no-spec-on-failed-generate.
// Cleans up any out/ui-* files it creates. Reads fixtures only otherwise.
// Run: node scripts/ui-test.mjs — exits non-zero on any wrong verdict.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = 41799;
const BASE = `http://127.0.0.1:${PORT}`;

const realEdl = JSON.parse(readFileSync(path.join(root, 'edl.real.fixture.json'), 'utf8'));
const transcript = JSON.parse(readFileSync(path.join(root, 'transcript.sample.json'), 'utf8'));

let failures = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}
function clone(o) {
  return JSON.parse(JSON.stringify(o));
}
async function get(p) {
  const r = await fetch(BASE + p);
  return { status: r.status, json: await r.json(), text: null };
}
async function getText(p) {
  const r = await fetch(BASE + p);
  return { status: r.status, text: await r.text() };
}
async function post(p, body, raw = false) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}
function uiSpecs() {
  return new Set(readdirSync(path.join(root, 'out')).filter((n) => n.startsWith('ui-')));
}
function cleanupUiSpecs(before) {
  for (const n of readdirSync(path.join(root, 'out'))) {
    if (n.startsWith('ui-') && !before.has(n)) {
      try { unlinkSync(path.join(root, 'out', n)); } catch { /* best effort */ }
    }
  }
}

async function waitReady(proc, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + '/api/sources');
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const server = spawn(process.execPath, [path.join(root, 'server.mjs')], {
  env: { ...process.env, POC_UI_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (c) => { serverOut += c; });
server.stderr.on('data', (c) => { serverOut += c; });

try {
  if (!await waitReady(server)) {
    console.log(`FAIL  server did not start: ${serverOut.slice(-500)}`);
    process.exit(1);
  }

  // 1. UI page serves.
  {
    const r = await getText('/');
    expect('GET / serves UI', r.status === 200 && r.text.includes('Validate Edit Plan'));
  }

  // 2. Sources allowlist contains the real test video.
  {
    const r = await get('/api/sources');
    expect('sources list includes test video', r.status === 200 && r.json.sources.includes('edl_test_video.mp4'), JSON.stringify(r.json.sources));
  }

  // 3. Valid EDL + transcript -> PASS with summary.
  {
    const r = await post('/api/validate', { edl: realEdl, transcript });
    expect('valid EDL passes', r.status === 200 && r.json.status === 'PASS', JSON.stringify(r.json.errors));
    expect('cut summary present', r.json.summary && r.json.summary.expectedDuration === 8 && r.json.summary.removed.length === 1, JSON.stringify(r.json.summary));
  }

  // 4. Speech word-boundary cut -> WARNINGS (reviewable, not blocking).
  {
    const edl = clone(realEdl);
    edl.ranges[0].end = 0.9;
    edl.total_duration_s = 4.9;
    const r = await post('/api/validate', { edl, transcript });
    expect('warning case returns WARNINGS', r.status === 200 && r.json.status === 'WARNINGS' && r.json.warnings.length > 0, JSON.stringify(r.json));
  }

  // 5. Mid-word cut -> FAILED.
  {
    const edl = clone(realEdl);
    edl.ranges[0].end = 1.2;
    edl.total_duration_s = 5.2;
    const r = await post('/api/validate', { edl, transcript });
    expect('mid-word cut rejected', r.status === 422 && r.json.status === 'FAILED' && r.json.errors.some((e) => /inside word/.test(e)), JSON.stringify(r.json.errors));
  }

  // 6. Non-verbatim quote -> FAILED.
  {
    const edl = clone(realEdl);
    edl.ranges[0].quote = 'Welcome everyone today';
    const r = await post('/api/validate', { edl, transcript });
    expect('bad quote rejected', r.status === 422 && r.json.errors.some((e) => /contiguous/.test(e)), JSON.stringify(r.json.errors));
  }

  // 7. Missing transcript -> structural validation only (opt-in preserved).
  {
    const r = await post('/api/validate', { edl: realEdl });
    expect('no-transcript structural pass', r.status === 200 && r.json.status === 'PASS', JSON.stringify(r.json));
  }

  // 8. Malformed JSON bodies -> 400, never 500.
  {
    const r1 = await post('/api/validate', '{not json', true);
    const r2 = await post('/api/validate', { edl: [1, 2, 3] });
    expect('garbage body 400', r1.status === 400 && r1.json.status === 'FAILED');
    expect('non-object EDL 400', r2.status === 400 && r2.json.status === 'FAILED');
  }

  // 9. Path traversal / unknown files rejected before the adapter runs.
  {
    const before = uiSpecs();
    const tries = [
      '../../package.json',
      '/etc/passwd',
      'C:/Windows/win.ini',
      'ghost.mp4',
    ];
    let allRejected = true;
    for (const evil of tries) {
      const edl = clone(realEdl);
      edl.sources.MAIN = evil;
      const r = await post('/api/validate', { edl, transcript });
      if (!(r.status === 422 && r.json.errors.some((e) => /must be a video file available/.test(e)))) {
        allRejected = false;
        console.log(`  (accepted?! ${evil}: ${r.status} ${JSON.stringify(r.json.errors)})`);
      }
    }
    const ov = clone(realEdl);
    ov.overlays = [{ file: '../secret.mp4', x: 0.1, y: 0.1, w: 0.2, start_in_output: 0, duration: 1, sourceIn: 0 }];
    const ro = await post('/api/validate', { edl: ov, transcript });
    if (!(ro.status === 422)) { allRejected = false; console.log(`  (overlay traversal accepted: ${ro.status})`); }
    expect('traversal + unknown files rejected', allRejected);
    cleanupUiSpecs(before);
  }

  // 10. Generate on valid input -> 200 + version-2 spec kept.
  {
    const before = uiSpecs();
    const r = await post('/api/generate', { edl: realEdl, transcript });
    const kept = r.status === 200 && r.json.ok && r.json.spec && r.json.spec.version === 2
      && typeof r.json.specFile === 'string' && existsSync(path.join(root, r.json.specFile));
    expect('generate keeps version-2 spec', kept, `http=${r.status}`);
    cleanupUiSpecs(before);
  }

  // 11. Generate on invalid input -> 422 and NO new spec files.
  {
    const before = uiSpecs();
    const edl = clone(realEdl);
    edl.ranges[0].end = 1.2;
    edl.total_duration_s = 5.2;
    const r = await post('/api/generate', { edl, transcript });
    const after = uiSpecs();
    const leaked = [...after].filter((n) => !before.has(n));
    expect('failed generate writes no spec', r.status === 422 && !r.json.ok && leaked.length === 0, `http=${r.status} leaked=${leaked}`);
    cleanupUiSpecs(before);
  }
} finally {
  try { server.kill('SIGTERM'); } catch { /* best effort */ }
  await new Promise((r) => setTimeout(r, 500));
}

console.log(failures === 0 ? '[ui-test] ALL PASS' : `[ui-test] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
