import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import {
  resolveWorkerConfig,
  isMockMode,
  sanitizeJobId,
  resolvePipelinePath,
  buildInferenceArgv,
  writeMockMp4,
  findNewestMp4,
  checkWorkerPrerequisites,
  formatPrereqReport,
} from '../scripts/ltx-worker.js';

const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');

const REAL_ENV = {
  AI_VIDEO_MOCK: 'false',
  LTX_REPO_DIR: '/opt/LTX-Video',
  LTX_PYTHON_BIN: 'python',
  LTX_PIPELINE_CONFIG: 'configs/ltxv-2b-0.9.8-distilled.yaml',
  LTX_CHECKPOINT_PATH: '/models/ltx.safetensors',
};

// Injected doubles: no GPU, no Python, no network.
function fakeExists(present) {
  const set = new Set(present);
  return async (p) => set.has(p);
}
function fakeRun({ versionOk = true, depsOk = true, cuda = 'True' } = {}) {
  return async (bin, args) => {
    if (args[0] === '--version') {
      return versionOk
        ? { ok: true, output: 'Python 3.10.5', error: '' }
        : { ok: false, output: '', error: 'spawn python ENOENT' };
    }
    const code = Array.isArray(args) ? args.join(' ') : '';
    if (code.includes('import torch, ltx_video')) {
      return depsOk
        ? { ok: true, output: '', error: '' }
        : { ok: false, output: '', error: "ModuleNotFoundError: No module named 'ltx_video'" };
    }
    if (code.includes('torch.cuda.is_available')) {
      return { ok: true, output: cuda, error: '' };
    }
    return { ok: true, output: '', error: '' };
  };
}
function repoFiles(repoDir) {
  return [repoDir, path.join(repoDir, 'inference.py'), path.join(repoDir, 'configs/ltxv-2b-0.9.8-distilled.yaml'), '/models/ltx.safetensors'];
}

test('worker mock stays the default fallback', () => {
  assert.equal(isMockMode({}), true);
  assert.equal(resolveWorkerConfig({}).mock, true);
  assert.equal(resolveWorkerConfig({ AI_VIDEO_MOCK: 'false' }).mock, false);
  assert.equal(resolveWorkerConfig({ AI_VIDEO_MOCK: 'false' }).pipelineConfig, 'configs/ltxv-2b-0.9.8-distilled.yaml');
});

test('prereq check: mock mode bypasses everything without touching the machine', async () => {
  let calls = 0;
  const report = await checkWorkerPrerequisites({
    config: resolveWorkerConfig({}),
    exists: async () => { calls += 1; return false; },
    run: async () => { calls += 1; return { ok: false, output: '', error: 'nope' }; },
  });
  assert.equal(report.ok, true);
  assert.equal(report.mock, true);
  assert.equal(calls, 0);
});

test('prereq check: healthy real-mode config reports READY', async () => {
  const config = resolveWorkerConfig(REAL_ENV);
  const report = await checkWorkerPrerequisites({ config, exists: fakeExists(repoFiles(config.repoDir)), run: fakeRun() });
  assert.equal(report.ok, true);
  assert.equal(report.mock, false);
  for (const name of ['python', 'repo', 'pipeline', 'checkpoint', 'dependencies', 'gpu']) {
    assert.ok(report.checks.some((c) => c.name === name && c.ok), `check ${name} must pass`);
  }
  assert.match(formatPrereqReport(report), /READY/);
});

test('prereq check: each missing piece fails clearly by name', async () => {
  const config = resolveWorkerConfig(REAL_ENV);
  // Missing Python.
  const noPy = await checkWorkerPrerequisites({ config, exists: fakeExists(repoFiles(config.repoDir)), run: fakeRun({ versionOk: false }) });
  assert.equal(noPy.ok, false);
  assert.match(noPy.checks.find((c) => c.name === 'python').detail, /LTX_PYTHON_BIN/);
  // Missing repo checkout.
  const noRepo = await checkWorkerPrerequisites({ config, exists: fakeExists([]), run: fakeRun() });
  assert.equal(noRepo.ok, false);
  assert.match(noRepo.checks.find((c) => c.name === 'repo').detail, /inference\.py/);
  // Missing pipeline YAML.
  const noPipe = await checkWorkerPrerequisites({
    config,
    exists: fakeExists([config.repoDir, path.join(config.repoDir, 'inference.py'), '/models/ltx.safetensors']),
    run: fakeRun(),
  });
  assert.equal(noPipe.ok, false);
  assert.match(noPipe.checks.find((c) => c.name === 'pipeline').detail, /ltxv-2b-0\.9\.8-distilled\.yaml/);
  // Missing checkpoint file.
  const noCkpt = await checkWorkerPrerequisites({
    config,
    exists: fakeExists([config.repoDir, path.join(config.repoDir, 'inference.py'), path.join(config.repoDir, 'configs/ltxv-2b-0.9.8-distilled.yaml')]),
    run: fakeRun(),
  });
  assert.equal(noCkpt.ok, false);
  assert.match(noCkpt.checks.find((c) => c.name === 'checkpoint').detail, /\/models\/ltx\.safetensors/);
  // Missing Python dependencies.
  const noDeps = await checkWorkerPrerequisites({ config, exists: fakeExists(repoFiles(config.repoDir)), run: fakeRun({ depsOk: false }) });
  assert.equal(noDeps.ok, false);
  assert.match(noDeps.checks.find((c) => c.name === 'dependencies').detail, /pip install/);
});

test('prereq check: unset checkpoint and headless GPU are warnings, not fatal', async () => {
  const config = resolveWorkerConfig({ ...REAL_ENV, LTX_CHECKPOINT_PATH: '' });
  const report = await checkWorkerPrerequisites({ config, exists: fakeExists(repoFiles(config.repoDir)), run: fakeRun({ cuda: 'False' }) });
  assert.equal(report.ok, true);
  assert.equal(report.checks.find((c) => c.name === 'checkpoint').severity, 'warn');
  assert.equal(report.checks.find((c) => c.name === 'gpu').severity, 'warn');
});

test('inference argv: official mapping plus per-job --output_path for real runs', () => {
  const base = buildInferenceArgv({ prompt: 'a test shot', height: 512, width: 768, num_frames: 121, seed: 7 });
  assert.deepEqual(base, ['inference.py', '--prompt', 'a test shot', '--pipeline_config', 'configs/ltxv-2b-0.9.8-distilled.yaml', '--height', '512', '--width', '768', '--num_frames', '121', '--seed', '7']);
  const withDir = buildInferenceArgv({ prompt: 'a test shot' }, resolveWorkerConfig({}), { runDir: '/tmp/runs/job-1' });
  assert.deepEqual(withDir.slice(-2), ['--output_path', '/tmp/runs/job-1']);
  assert.ok(withDir.includes('inference.py'));
});

test('pipeline path: absolute as-is, otherwise repo-relative (official configs/)', () => {
  assert.equal(resolvePipelinePath({ repoDir: '/opt/LTX-Video', pipelineConfig: 'configs/ltxv-2b-0.9.8-distilled.yaml' }), path.join('/opt/LTX-Video', 'configs/ltxv-2b-0.9.8-distilled.yaml'));
  assert.equal(resolvePipelinePath({ repoDir: '/opt/LTX-Video', pipelineConfig: '/m/custom.yaml' }), '/m/custom.yaml');
});

test('job ids are sanitized for artifact filenames (no traversal)', () => {
  assert.equal(sanitizeJobId('../../etc/passwd'), '______etc_passwd');
  assert.ok(!/[/\\.]/.test(sanitizeJobId('a/b\\c:d')));
  assert.equal(sanitizeJobId(''), 'job');
});

test('artifact capture: newest .mp4 wins; empty dir yields null', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ltx-artifact-'));
  try {
    assert.equal(await findNewestMp4(dir), null);
    const oldMp4 = path.join(dir, 'video_output_old.mp4');
    const newMp4 = path.join(dir, 'nested', 'video_output_new.mp4');
    await mkdtemp(path.join(dir, 'nested-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(newMp4), { recursive: true });
    await writeFile(oldMp4, Buffer.from('old'));
    await writeFile(newMp4, Buffer.from('new'));
    await writeFile(path.join(dir, 'notes.txt'), 'ignore me');
    const old = new Date(Date.now() - 60000);
    await utimes(oldMp4, old, old);
    assert.equal(await findNewestMp4(dir), newMp4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mock output still works (no GPU required)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ltx-mock-'));
  try {
    const out = path.join(dir, 'sub', 'clip.mp4');
    const { runJob } = await import('../scripts/ltx-worker.js');
    const result = await runJob({ id: 'job-m1', prompt: 'a river' }, { config: resolveWorkerConfig({}), outPath: out });
    assert.equal(result.ok, true);
    assert.equal(result.mock, true);
    assert.equal(result.outPath, out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('isolation intact: web process never runs Python/PyTorch/LTX', () => {
  assert.ok(!SERVER_SRC.includes("from './scripts/ltx-worker.js'") && !SERVER_SRC.includes('from "../scripts/ltx-worker.js"'),
    'server.js must never import the worker');
  const aiBlock = SERVER_SRC.slice(SERVER_SRC.indexOf('Isolated AI Video Generation POC'));
  // Comments may name python/inference.py; execution (spawn/torch) lives only
  // in scripts/ltx-worker.js.
  assert.ok(!/\bspawn\s*\(|\btorch\b|diffusers/i.test(aiBlock), 'AI routes must not execute the model');
  // Download route streams worker bytes when present, mock fallback otherwise.
  assert.ok(SERVER_SRC.includes('aiVideoMockMp4Bytes(job.prompt)'), 'mock download fallback must remain');
  assert.ok(SERVER_SRC.includes('aiVideoConfig().outputDir'), 'download prefers the real worker artifact when present');
});
