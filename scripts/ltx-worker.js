// scripts/ltx-worker.js — Isolated LTX-Video GPU worker (POC).
//
// Runs ONLY as a separate process/host. NEVER imported by src/server.js.
// The main Render web process queues jobs and POSTs to this worker; this
// worker is the single place that invokes the official LTX-Video entry:
//
//   Official: `ltx_video.inference.infer(InferenceConfig)`
//   CLI: `python inference.py --prompt ... --pipeline_config <yaml>`
//   Repo: https://github.com/Lightricks/LTX-Video
//   Default pipeline: configs/ltxv-2b-0.9.8-distilled.yaml
//
// Mock mode is the DEFAULT (AI_VIDEO_MOCK=true): without a checkpoint/GPU it
// writes a deterministic placeholder MP4 so the web → worker → status → MP4
// loop can be verified end-to-end. Set AI_VIDEO_MOCK=false + LTX_REPO_DIR (+
// LTX_CHECKPOINT_PATH unless Hugging Face hub download is intended) to run the
// real official pipeline. No model download happens in mock mode.
//
// Usage:
//   node scripts/ltx-worker.js --check                (prerequisite report)
//   node scripts/ltx-worker.js --job job.json --out out.mp4
//   node scripts/ltx-worker.js --serve   (POST /jobs, GET /artifacts/:id;
//                                         Bearer AI_VIDEO_WORKER_TOKEN)
//
// Env (server-side only, never sent to the browser):
//   AI_VIDEO_MOCK=true|false (default true), LTX_REPO_DIR, LTX_PYTHON_BIN,
//   LTX_PIPELINE_CONFIG, LTX_CHECKPOINT_PATH, AI_VIDEO_OUTPUT_DIR,
//   AI_VIDEO_WORKER_PORT, AI_VIDEO_WORKER_TOKEN.

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, copyFile, readdir, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const WORKER_INFERENCE_TIMEOUT_MS = 15 * 60 * 1000;
const CHECK_CMD_TIMEOUT_MS = 60 * 1000;

export function resolveWorkerConfig(env = process.env) {
  const get = (key) => (env && env[key] !== undefined && env[key] !== null ? String(env[key]) : '');
  const mockRaw = get('AI_VIDEO_MOCK').trim().toLowerCase();
  const checkpointPath = get('LTX_CHECKPOINT_PATH').trim();
  return {
    mock: mockRaw === 'false' || mockRaw === '0' ? false : true,
    repoDir: get('LTX_REPO_DIR').trim(),
    pythonBin: get('LTX_PYTHON_BIN').trim() || 'python',
    pipelineConfig: get('LTX_PIPELINE_CONFIG').trim() || 'configs/ltxv-2b-0.9.8-distilled.yaml',
    checkpointPath,
    outputDir: get('AI_VIDEO_OUTPUT_DIR').trim(),
    port: Number.parseInt(get('AI_VIDEO_WORKER_PORT').trim() || '4100', 10) || 4100,
    token: get('AI_VIDEO_WORKER_TOKEN').trim(),
  };
}

export function isMockMode(env = process.env) {
  return resolveWorkerConfig(env).mock;
}

export function sanitizeJobId(value) {
  const raw = String(value || 'job').slice(0, 64);
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  return clean || 'job';
}

// Resolve the pipeline YAML: absolute paths as-is, otherwise relative to the
// LTX repo checkout (official configs/ live there).
export function resolvePipelinePath(config = resolveWorkerConfig()) {
  const raw = String(config.pipelineConfig || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return raw;
  if (config.repoDir) return path.join(config.repoDir, raw);
  return path.resolve(process.cwd(), raw);
}

// Build argv for the OFFICIAL inference.py CLI. Field mapping mirrors
// InferenceConfig in ltx_video/inference.py: prompt, pipeline_config, height,
// width, num_frames, seed, output_path. The checkpoint itself resolves inside
// the pipeline YAML / HF hub; the worker never accepts model paths from the
// network caller.
export function buildInferenceArgv(payload, config = resolveWorkerConfig(), opts = {}) {
  const prompt = String(payload?.prompt || '').trim();
  if (!prompt) throw new Error('A text prompt is required.');
  const height = Number(payload?.height ?? 512);
  const width = Number(payload?.width ?? 768);
  const numFrames = Number(payload?.num_frames ?? payload?.numFrames ?? 121);
  const seed = Number(payload?.seed ?? 171198);
  if (!Number.isInteger(height) || height < 256 || height > 2048) throw new Error('height out of range.');
  if (!Number.isInteger(width) || width < 256 || width > 2048) throw new Error('width out of range.');
  if (!Number.isInteger(numFrames) || numFrames < 9 || numFrames > 257) throw new Error('num_frames out of range.');
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new Error('seed out of range.');
  const argv = [
    'inference.py',
    '--prompt', prompt,
    '--pipeline_config', String(payload?.pipeline_config || config.pipelineConfig),
    '--height', String(height),
    '--width', String(width),
    '--num_frames', String(numFrames),
    '--seed', String(seed),
  ];
  if (opts.runDir) argv.push('--output_path', String(opts.runDir));
  return argv;
}

// Deterministic placeholder MP4 for mock mode: minimal ftyp box so the file
// is served as video/mp4 and the preview/download loop is exercisable without
// a GPU or multi-GB checkpoint. NOT a playable video; real runs replace it.
export async function writeMockMp4(absPath, payload = {}) {
  const prompt = String(payload?.prompt || 'mock').slice(0, 80);
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
  ]);
  const comment = Buffer.from(`LTX-Video POC mock output. Prompt: ${prompt}. `, 'utf8');
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, Buffer.concat([ftyp, comment]));
  return absPath;
}

// Find the newest .mp4 under dir (official inference.py names outputs
// video_output_*.mp4 inside output_path). Returns null when absent.
export async function findNewestMp4(dir, { readdirImpl = readdir, statImpl = stat } = {}) {
  let newest = null;
  async function walk(current) {
    let entries;
    try {
      entries = await readdirImpl(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && /\.mp4$/i.test(entry.name)) {
          const st = await statImpl(full);
          const mtime = Number(st?.mtimeMs || 0);
          if (!newest || mtime > newest.mtime) newest = { path: full, mtime };
        }
      } catch {
        // Ignore unreadable entries; keep scanning.
      }
    }
  }
  await walk(dir);
  return newest ? newest.path : null;
}

async function defaultExists(absPath) {
  try {
    await access(absPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultRun(bin, args, timeoutMs = CHECK_CMD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, output: '', error: err?.message || String(err) });
      return;
    }
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      out += chunk.toString('utf8');
      if (out.length > 4096) out = out.slice(-4096);
    });
    child.stderr?.on('data', (chunk) => {
      errOut += chunk.toString('utf8');
      if (errOut.length > 4096) errOut = errOut.slice(-4096);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: out.trim(), error: err?.message || String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim(), error: code === 0 ? '' : (errOut.trim() || `exit code ${code}`) });
    });
  });
}

// Startup/configuration check for real LTX execution. Mock mode bypasses
// everything (no Python/GPU/repo/checkpoint needed). In real mode each missing
// piece is reported by name with the env var to set. Injectable exists/run so
// tests never need a GPU or Python.
export async function checkWorkerPrerequisites({ config = resolveWorkerConfig(), exists = defaultExists, run = defaultRun } = {}) {
  const checks = [];
  if (config.mock) {
    return {
      ok: true,
      mock: true,
      checks: [{ name: 'mode', ok: true, severity: 'info', detail: 'AI_VIDEO_MOCK=true: placeholder MP4, no Python/GPU/repo/checkpoint required.' }],
    };
  }
  // Python interpreter.
  const py = await run(config.pythonBin, ['--version']);
  checks.push(py.ok
    ? { name: 'python', ok: true, severity: 'info', detail: `${config.pythonBin}: ${(py.output || '').split('\n')[0] || 'available'}` }
    : { name: 'python', ok: false, severity: 'error', detail: `LTX_PYTHON_BIN='${config.pythonBin}' not found or not executable (${py.error || 'unknown error'}). Install Python 3.10+ with the LTX-Video inference extras.` });
  // LTX repo checkout with official inference.py.
  if (!config.repoDir) {
    checks.push({ name: 'repo', ok: false, severity: 'error', detail: 'LTX_REPO_DIR is not set. Clone https://github.com/Lightricks/LTX-Video and set LTX_REPO_DIR to the checkout.' });
  } else {
    const inferPy = path.join(config.repoDir, 'inference.py');
    const repoOk = await exists(config.repoDir);
    const inferOk = repoOk && await exists(inferPy);
    checks.push(repoOk && inferOk
      ? { name: 'repo', ok: true, severity: 'info', detail: `LTX_REPO_DIR=${config.repoDir} (inference.py present)` }
      : { name: 'repo', ok: false, severity: 'error', detail: `LTX repo checkout missing: expected ${inferPy}. Clone https://github.com/Lightricks/LTX-Video into LTX_REPO_DIR.` });
  }
  // Pipeline YAML (default: official ltxv-2b-0.9.8-distilled).
  const pipelinePath = resolvePipelinePath(config);
  if (!pipelinePath) {
    checks.push({ name: 'pipeline', ok: false, severity: 'error', detail: 'LTX_PIPELINE_CONFIG is empty.' });
  } else {
    const pipeOk = await exists(pipelinePath);
    checks.push(pipeOk
      ? { name: 'pipeline', ok: true, severity: 'info', detail: `pipeline config: ${pipelinePath}` }
      : { name: 'pipeline', ok: false, severity: 'error', detail: `Pipeline config not found: ${pipelinePath}. Use a configs/*.yaml from the LTX repo (default configs/ltxv-2b-0.9.8-distilled.yaml).` });
  }
  // Checkpoint: missing file is fatal when explicitly set; when unset the
  // official loader falls back to Hugging Face hub download (warn only).
  if (config.checkpointPath) {
    const ckptOk = await exists(config.checkpointPath);
    checks.push(ckptOk
      ? { name: 'checkpoint', ok: true, severity: 'info', detail: `LTX_CHECKPOINT_PATH=${config.checkpointPath}` }
      : { name: 'checkpoint', ok: false, severity: 'error', detail: `Checkpoint not found: ${config.checkpointPath}. Download the safetensors weights or unset LTX_CHECKPOINT_PATH for hub download.` });
  } else {
    checks.push({ name: 'checkpoint', ok: true, severity: 'warn', detail: 'LTX_CHECKPOINT_PATH unset: official loader will download weights from Hugging Face hub (network + cache required).' });
  }
  // Python dependencies (torch + ltx_video package from the repo install).
  const deps = await run(config.pythonBin, ['-c', 'import torch, ltx_video']);
  checks.push(deps.ok
    ? { name: 'dependencies', ok: true, severity: 'info', detail: 'torch + ltx_video importable' }
    : { name: 'dependencies', ok: false, severity: 'error', detail: `Python deps missing (${deps.error || 'import failed'}). From LTX_REPO_DIR run: python -m pip install -e .[inference].` });
  // GPU visibility: warning only — CPU/MPS fallback exists but is very slow.
  const cuda = await run(config.pythonBin, ['-c', 'import torch; print(torch.cuda.is_available())']);
  const hasCuda = cuda.ok && /true/i.test(cuda.output || '');
  checks.push(hasCuda
    ? { name: 'gpu', ok: true, severity: 'info', detail: 'torch.cuda.is_available() = True' }
    : { name: 'gpu', ok: true, severity: 'warn', detail: `No CUDA GPU visible (${cuda.ok ? `torch reports: ${cuda.output || 'False'}` : `probe failed: ${cuda.error || 'unknown'}`}). CPU/MPS fallback is possible but very slow; a CUDA GPU is recommended.` });
  return { ok: checks.every((c) => c.severity !== 'error' || c.ok), mock: false, checks };
}

export function formatPrereqReport(report) {
  const lines = [`LTX worker prerequisite check (mock=${report.mock ? 'on' : 'off'}): ${report.ok ? 'READY' : 'NOT READY'}`];
  for (const c of report.checks) {
    const mark = c.severity === 'error' && !c.ok ? 'FAIL' : (c.severity === 'warn' ? 'WARN' : 'ok');
    lines.push(` [${mark}] ${c.name}: ${c.detail}`);
  }
  return lines.join('\n');
}

function runOfficialInference(payload, { config, timeoutMs = WORKER_INFERENCE_TIMEOUT_MS, runDir, destPath }) {
  return new Promise((resolve) => {
    const cwd = config.repoDir || process.cwd();
    let argv;
    try {
      argv = buildInferenceArgv(payload, config, { runDir });
    } catch (err) {
      resolve({ ok: false, error: err?.message || String(err) });
      return;
    }
    let child;
    try {
      child = spawn(config.pythonBin, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: err?.message || String(err) });
      return;
    }
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err?.message || String(err) });
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = String(stderr || '').replace(/\s+/g, ' ').trim().slice(-500);
        resolve({ ok: false, error: `LTX inference failed (code ${code}).${tail ? ` ${tail}` : ''}` });
        return;
      }
      try {
        const produced = await findNewestMp4(runDir);
        if (!produced) {
          resolve({ ok: false, error: `LTX inference exited 0 but no .mp4 was produced under ${runDir}.` });
          return;
        }
        await mkdir(path.dirname(destPath), { recursive: true });
        await copyFile(produced, destPath);
        resolve({ ok: true, outPath: destPath });
      } catch (err) {
        resolve({ ok: false, error: `Could not collect LTX output: ${err?.message || String(err)}` });
      }
    });
  });
}

export async function runJob(payload, { config = resolveWorkerConfig(), outPath } = {}) {
  const prompt = String(payload?.prompt || '').trim();
  if (!prompt) throw new Error('A text prompt is required.');
  const safeId = sanitizeJobId(payload?.id);
  const baseDir = config.outputDir || path.join(process.cwd(), 'outputs');
  const dest = outPath || path.join(baseDir, `${safeId}.mp4`);
  if (config.mock) {
    await writeMockMp4(dest, payload);
    return { ok: true, outPath: dest, mock: true };
  }
  const runDir = path.join(baseDir, 'runs', `${safeId}-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  const result = await runOfficialInference(payload, { config, runDir, destPath: dest });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, outPath: result.outPath, mock: false };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--serve') out.serve = true;
    else if (arg === '--check') out.check = true;
    else if ((arg === '--job' || arg === '--out') && argv[i + 1]) out[arg.slice(2)] = argv[++i];
  }
  return out;
}

async function readJsonBody(req, limitBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('Body too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function artifactPathFor(config, jobId) {
  const baseDir = config.outputDir || path.join(process.cwd(), 'outputs');
  return path.join(baseDir, `${sanitizeJobId(jobId)}.mp4`);
}

const invokedDirectly = process.argv[1] && path.basename(process.argv[1]) === 'ltx-worker.js';
if (invokedDirectly) {
  const args = parseArgs();
  const config = resolveWorkerConfig();
  if (args.check) {
    const report = await checkWorkerPrerequisites({ config });
    console.log(formatPrereqReport(report));
    process.exit(report.ok ? 0 : 1);
  } else if (args.serve) {
    if (!config.mock) {
      const report = await checkWorkerPrerequisites({ config });
      console.log(formatPrereqReport(report));
      if (!report.ok) {
        console.error('Refusing to start: fix the failed checks above (or set AI_VIDEO_MOCK=true).');
        process.exit(1);
      }
    }
    const server = createServer(async (req, res) => {
      const urlPath = (req.url || '').split('?')[0];
      if (config.token) {
        const auth = String(req.headers.authorization || '');
        if (auth !== `Bearer ${config.token}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized.' }));
          return;
        }
      }
      const artifactMatch = req.method === 'GET' && /^\/artifacts\/([A-Za-z0-9_-]{1,64})$/.exec(urlPath || '');
      if (artifactMatch) {
        try {
          const data = await readFile(artifactPathFor(config, artifactMatch[1]));
          res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': data.length });
          res.end(data);
        } catch {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Artifact not found.' }));
        }
        return;
      }
      if (req.method !== 'POST' || urlPath !== '/jobs') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Not found.' }));
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body.' }));
        return;
      }
      try {
        const result = await runJob(payload, { config });
        if (!result.ok) throw new Error(result.error || 'Generation failed.');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: payload?.id || null, outPath: result.outPath, mock: result.mock }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message || 'Generation failed.' }));
      }
    });
    server.listen(config.port, () => {
      console.log(`LTX worker listening on :${config.port} (mock=${config.mock ? 'on' : 'off'})`);
    });
  } else if (args.job) {
    if (!config.mock) {
      const report = await checkWorkerPrerequisites({ config });
      console.log(formatPrereqReport(report));
      if (!report.ok) process.exit(1);
    }
    const jobJson = JSON.parse(await readFile(args.job, 'utf8'));
    const outPath = args.out || artifactPathFor(config, jobJson?.id);
    const result = await runJob(jobJson, { config, outPath });
    if (!result.ok) {
      console.error(result.error || 'Generation failed.');
      process.exit(1);
    }
    console.log(result.outPath);
  } else {
    console.log('Usage: node scripts/ltx-worker.js --check | --job job.json --out out.mp4 | --serve');
  }
}
