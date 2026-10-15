// Adapter-level evidence-gate tests (POC-local, zero deps, no STT/network).
// Spawns adapter.mjs as a child process and asserts exit codes, stderr, and
// output-file presence/absence plus content identity.
// Cases: flag-off compatibility (byte-identical outputs), evidence success,
// warning passthrough, and every failure mode (mid-word, out-of-bounds,
// non-verbatim quote, uncovered source, empty/malformed transcript, duration
// disagreement) — each must exit non-zero AND write no outputs.
// Temp files live under out/tmp-* and are removed afterwards. Reads fixtures
// only; never touches existing outputs.
// Run: node scripts/adapter-evidence-test.mjs — exits non-zero on any wrong verdict.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const adapter = path.join(root, 'adapter.mjs');
const transcriptPath = path.join(root, 'transcript.sample.json');

const realEdl = JSON.parse(readFileSync(path.join(root, 'edl.real.fixture.json'), 'utf8'));
const realSpec = readFileSync(path.join(root, 'edl.real.v2spec.json'), 'utf8');
const realAssets = readFileSync(path.join(root, 'edl.real.assets.json'), 'utf8');

let failures = 0;
const tmpFiles = [];
function tmp(name) {
  const p = path.join(root, 'out', `tmp-${name}`);
  tmpFiles.push(p);
  return p;
}
// Adapter resolves file args against the POC root: pass root-relative paths.
function rel(p) {
  return path.relative(root, p);
}
function cleanup() {
  for (const p of tmpFiles) {
    try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
  }
}
function expect(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}
function sha(s) {
  return createHash('sha256').update(s).digest('hex');
}
function clone(o) {
  return JSON.parse(JSON.stringify(o));
}
function runAdapter(args) {
  const r = spawnSync(process.execPath, [adapter, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function writeTmp(name, obj, raw = false) {
  const p = tmp(name);
  writeFileSync(p, raw ? obj : JSON.stringify(obj, null, 2) + '\n');
  return p;
}

try {
  // 1. Flag-off compatibility: outputs byte-identical to the recorded real artifacts.
  {
    const spec = tmp('flagoff.v2spec.json');
    const assets = tmp('flagoff.assets.json');
    const r = runAdapter(['edl.real.fixture.json', rel(spec), rel(assets)]);
    expect('flag-off exit 0', r.status === 0, r.stderr.slice(-300));
    expect('flag-off spec identical', existsSync(spec) && sha(readFileSync(spec, 'utf8')) === sha(realSpec));
    expect('flag-off assets identical', existsSync(assets) && sha(readFileSync(assets, 'utf8')) === sha(realAssets));
  }

  // 2. Evidence success (n/a quotes preserved via skip path): exit 0, identical spec.
  {
    const spec = tmp('ev-ok.v2spec.json');
    const assets = tmp('ev-ok.assets.json');
    const r = runAdapter(['edl.real.fixture.json', rel(spec), rel(assets), '--evidence', 'transcript.sample.json']);
    expect('evidence success exit 0', r.status === 0, r.stderr.slice(-300));
    expect('evidence success spec identical', existsSync(spec) && sha(readFileSync(spec, 'utf8')) === sha(realSpec));
    expect('evidence ok logged', /evidence ok/.test(r.stdout + r.stderr));
  }

  // 3. Warning passthrough: speech word-boundary edge (end 0.9) passes with warning on stderr.
  {
    const edl = clone(realEdl);
    edl.ranges[0].end = 0.9;
    edl.total_duration_s = 4.9; // keep structural total consistent so the warning comes from evidence
    const fx = writeTmp('warn.fixture.json', edl);
    const spec = tmp('warn.v2spec.json');
    const r = runAdapter([rel(fx), rel(spec), '--evidence', 'transcript.sample.json']);
    expect('warning case exit 0', r.status === 0, r.stderr.slice(-300));
    expect('warning on stderr, spec written', /word-boundary cut during speech/.test(r.stderr) && existsSync(spec));
  }

  // 4. Failure cases: exit non-zero, cause named on stderr, NO outputs written.
  const failCases = [
    {
      name: 'mid-word edge',
      make: () => { const e = clone(realEdl); e.ranges[0].end = 1.2; e.total_duration_s = 5.2; return e; },
      match: /inside word/,
    },
    {
      name: 'out-of-bounds edge',
      make: () => { const e = clone(realEdl); e.ranges[1].end = 14.0; e.total_duration_s = 10.0; return e; },
      match: /outside source duration/,
    },
    {
      name: 'non-verbatim quote',
      make: () => { const e = clone(realEdl); e.ranges[0].quote = 'Welcome everyone today'; return e; },
      match: /contiguous/,
    },
  ];
  for (const fc of failCases) {
    const fx = writeTmp(`fail-${fc.name.replace(/[^a-z]+/g, '-')}.fixture.json`, fc.make());
    const spec = tmp(`fail-${fc.name.replace(/[^a-z]+/g, '-')}.v2spec.json`);
    const r = runAdapter([rel(fx), rel(spec), '--evidence', 'transcript.sample.json']);
    const noOutputs = !existsSync(spec);
    expect(`${fc.name} rejected, nothing written`,
      r.status !== 0 && fc.match.test(r.stderr) && noOutputs,
      `exit=${r.status} stderr=${r.stderr.slice(-200)}`);
  }

  // 5. Uncovered source (transcript variant without MAIN).
  {
    const t = JSON.parse(readFileSync(transcriptPath, 'utf8'));
    delete t.sources.MAIN;
    const tx = writeTmp('nouncover.transcript.json', t);
    const spec = tmp('nouncover.v2spec.json');
    const r = runAdapter(['edl.real.fixture.json', rel(spec), '--evidence', rel(tx)]);
    expect('uncovered source rejected, nothing written',
      r.status !== 0 && /no transcript coverage/.test(r.stderr) && !existsSync(spec),
      `exit=${r.status} stderr=${r.stderr.slice(-200)}`);
  }

  // 6. Empty word list fails closed.
  {
    const t = JSON.parse(readFileSync(transcriptPath, 'utf8'));
    t.sources.MAIN.words = [];
    const tx = writeTmp('empty.transcript.json', t);
    const spec = tmp('empty.v2spec.json');
    const r = runAdapter(['edl.real.fixture.json', rel(spec), '--evidence', rel(tx)]);
    expect('empty transcript rejected, nothing written',
      r.status !== 0 && /no transcript words/.test(r.stderr) && !existsSync(spec),
      `exit=${r.status} stderr=${r.stderr.slice(-200)}`);
  }

  // 7. Malformed transcript file (not JSON) fails cleanly.
  {
    const tx = writeTmp('broken.transcript.json', '{not json', true);
    const spec = tmp('broken.v2spec.json');
    const r = runAdapter(['edl.real.fixture.json', rel(spec), '--evidence', rel(tx)]);
    expect('malformed transcript rejected, nothing written',
      r.status !== 0 && /cannot load transcript/.test(r.stderr) && !existsSync(spec),
      `exit=${r.status} stderr=${r.stderr.slice(-200)}`);
  }

  // 8. Duration disagreement beyond 0.5s (declared 20 vs file 12) fails closed.
  {
    const t = JSON.parse(readFileSync(transcriptPath, 'utf8'));
    t.sources.MAIN.duration = 20.0;
    const tx = writeTmp('drift.transcript.json', t);
    const spec = tmp('drift.v2spec.json');
    const r = runAdapter(['edl.real.fixture.json', rel(spec), '--evidence', rel(tx)]);
    expect('duration disagreement rejected, nothing written',
      r.status !== 0 && /duration disagreement/.test(r.stderr) && !existsSync(spec),
      `exit=${r.status} stderr=${r.stderr.slice(-200)}`);
  }
} finally {
  cleanup();
}

console.log(failures === 0 ? '[adapter-evidence-test] ALL PASS' : `[adapter-evidence-test] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
