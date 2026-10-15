// src/library/ai-video.js — Isolated AI Video Generation POC (LTX-Video).
//
// SCOPE: PURE module (no fs, no child_process, no model execution).
// It validates prompts, tracks job lifecycle, and builds the payload for the
// isolated GPU worker. The main Render web process NEVER runs the model.
//
// Official upstream reference (https://github.com/Lightricks/LTX-Video):
//   - Programmatic entry: `ltx_video.inference.infer(InferenceConfig)`
//   - CLI entry: `python inference.py --prompt ... --pipeline_config <yaml>`
//   - InferenceConfig fields mapped in buildLtxWorkerPayload(): prompt,
//     pipeline_config, height, width, num_frames, frame_rate, seed,
//     negative_prompt, output_path (+ optional conditioning_* for image/video).
//   - Pipeline YAML (e.g. configs/ltxv-2b-0.9.8-distilled.yaml): pipeline_type,
//     checkpoint_path, spatial_upscaler_model_path, stg_mode, precision,
//     text_encoder_model_name_or_path, first_pass/second_pass timesteps.
// The isolated worker (scripts/ltx-worker.js) is the ONLY place that invokes
// that official entry. This module only prepares its input.
//
// Worker boundary:
//   - Web process: createAiVideoJobStore() holds queued/processing/completed/
//     failed jobs in memory and dispatchToWorker() POSTs to AI_VIDEO_WORKER_URL.
//   - GPU worker: separate process/host holding LTX_CHECKPOINT_PATH + GPU.
//     No credentials or model paths are ever sent to the browser.

import { randomUUID } from 'node:crypto';

export const AI_VIDEO_JOB_STATES = Object.freeze(['queued', 'processing', 'completed', 'failed']);

export const AI_VIDEO_DEFAULTS = Object.freeze({
  width: 768,
  height: 512,
  numFrames: 121,
  frameRate: 30,
  seed: 171198,
});

const AI_VIDEO_TRANSITIONS = Object.freeze({
  queued: ['processing', 'failed'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: [],
});

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

// Read AI video / LTX configuration from env. All model paths, credentials
// and tuning stay server-side; the browser only sees job id/state + MP4 URL.
export function aiVideoConfig(env = process.env) {
  const get = (key) => (env && env[key] !== undefined && env[key] !== null ? String(env[key]) : '');
  const workerUrl = get('AI_VIDEO_WORKER_URL').trim();
  const workerToken = get('AI_VIDEO_WORKER_TOKEN').trim();
  const checkpointPath = get('LTX_CHECKPOINT_PATH').trim();
  const pipelineConfig = get('LTX_PIPELINE_CONFIG').trim() || 'configs/ltxv-2b-0.9.8-distilled.yaml';
  const outputDir = get('AI_VIDEO_OUTPUT_DIR').trim();
  const enabledRaw = get('AI_VIDEO_ENABLED').trim().toLowerCase();
  const mockRaw = get('AI_VIDEO_MOCK').trim().toLowerCase();
  return {
    // POC is opt-in: disabled unless explicitly enabled, so existing editor
    // behavior is unchanged by default.
    enabled: enabledRaw === 'true' || enabledRaw === '1',
    workerUrl,
    // Bearer token for the isolated worker; never exposed to the browser.
    workerToken,
    checkpointPath,
    pipelineConfig,
    outputDir,
    // Mock mode lets the POC run without downloading the multi-GB checkpoint
    // or provisioning a GPU. The worker still owns execution; it just emits
    // a placeholder MP4 instead of calling infer().
    mock: mockRaw === 'true' || mockRaw === '1' || (!checkpointPath && !workerUrl),
  };
}

export function isAiVideoEnabled(env = process.env) {
  try {
    return aiVideoConfig(env).enabled;
  } catch {
    return false;
  }
}

// Validate a Generate request body. Returns { ok:true, prompt, options } or
// { ok:false, error }. Bounds mirror LTX guidance (resolutions divisible by
// 32 downstream; frames follow N*8+1); we clamp lightly here and let the
// worker pad/crop exactly like official infer().
export function validateAiVideoRequest(body) {
  if (!isRecord(body)) return { ok: false, error: 'A text prompt is required.' };
  const rawPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!rawPrompt) return { ok: false, error: 'A text prompt is required.' };
  if (rawPrompt.length > 1000) return { ok: false, error: 'Prompt must be at most 1000 characters.' };
  const width = body.width === undefined ? AI_VIDEO_DEFAULTS.width : toInt(body.width, NaN);
  const height = body.height === undefined ? AI_VIDEO_DEFAULTS.height : toInt(body.height, NaN);
  const numFrames = body.num_frames === undefined && body.numFrames === undefined
    ? AI_VIDEO_DEFAULTS.numFrames
    : toInt(body.num_frames !== undefined ? body.num_frames : body.numFrames, NaN);
  const frameRate = body.frame_rate === undefined && body.frameRate === undefined
    ? AI_VIDEO_DEFAULTS.frameRate
    : toInt(body.frame_rate !== undefined ? body.frame_rate : body.frameRate, NaN);
  const seedRaw = body.seed === undefined ? AI_VIDEO_DEFAULTS.seed : toInt(body.seed, NaN);
  if (!Number.isInteger(width) || width < 256 || width > 2048) {
    return { ok: false, error: 'width must be an integer between 256 and 2048.' };
  }
  if (!Number.isInteger(height) || height < 256 || height > 2048) {
    return { ok: false, error: 'height must be an integer between 256 and 2048.' };
  }
  if (!Number.isInteger(numFrames) || numFrames < 9 || numFrames > 257) {
    return { ok: false, error: 'num_frames must be an integer between 9 and 257.' };
  }
  if (!Number.isInteger(frameRate) || frameRate < 1 || frameRate > 60) {
    return { ok: false, error: 'frame_rate must be an integer between 1 and 60.' };
  }
  if (!Number.isInteger(seedRaw) || seedRaw < 0 || seedRaw > 4294967295) {
    return { ok: false, error: 'seed must be an integer between 0 and 4294967295.' };
  }
  const negativePrompt = typeof body.negative_prompt === 'string'
    ? body.negative_prompt.slice(0, 1000)
    : (typeof body.negativePrompt === 'string' ? body.negativePrompt.slice(0, 1000) : undefined);
  return {
    ok: true,
    prompt: rawPrompt,
    options: { width, height, numFrames, frameRate, seed: seedRaw, ...(negativePrompt ? { negativePrompt } : {}) },
  };
}

// Build the worker payload using official InferenceConfig field names so the
// isolated worker can pass it straight to `infer()` / `inference.py`.
export function buildLtxWorkerPayload(job, config = aiVideoConfig()) {
  if (!isRecord(job) || typeof job.prompt !== 'string' || !job.prompt) {
    throw new Error('Job must contain a prompt.');
  }
  const opts = isRecord(job.options) ? job.options : {};
  return {
    prompt: job.prompt,
    pipeline_config: config.pipelineConfig,
    height: opts.height ?? AI_VIDEO_DEFAULTS.height,
    width: opts.width ?? AI_VIDEO_DEFAULTS.width,
    num_frames: opts.numFrames ?? AI_VIDEO_DEFAULTS.numFrames,
    frame_rate: opts.frameRate ?? AI_VIDEO_DEFAULTS.frameRate,
    seed: opts.seed ?? AI_VIDEO_DEFAULTS.seed,
    ...(opts.negativePrompt ? { negative_prompt: opts.negativePrompt } : {}),
    ...(config.outputDir ? { output_path: config.outputDir } : {}),
    // The worker resolves checkpoint_path from LTX_CHECKPOINT_PATH server-side;
    // it is never accepted from the browser.
  };
}

// In-memory job store for the POC. Production would persist to Postgres; the
// POC keeps jobs process-local so no migration or schema change is required
// and the existing Video Editor is untouched.
export function createAiVideoJobStore({ now = () => new Date().toISOString(), id = () => randomUUID() } = {}) {
  const jobs = new Map();

  function publicJob(job) {
    return {
      id: job.id,
      prompt: job.prompt,
      options: { ...job.options },
      state: job.state,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(job.outputUrl ? { outputUrl: job.outputUrl } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  function create(prompt, options = {}) {
    const validated = validateAiVideoRequest({ prompt, ...options });
    if (!validated.ok) throw new Error(validated.error);
    const timestamp = now();
    const job = {
      id: id(),
      prompt: validated.prompt,
      options: validated.options,
      state: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      outputUrl: null,
      error: null,
    };
    jobs.set(job.id, job);
    return publicJob(job);
  }

  function get(jobId) {
    const job = jobs.get(String(jobId || ''));
    return job ? publicJob(job) : null;
  }

  function setState(jobId, nextState, patch = {}) {
    const job = jobs.get(String(jobId || ''));
    if (!job) return null;
    if (!AI_VIDEO_JOB_STATES.includes(nextState)) throw new Error(`Unknown job state: ${nextState}.`);
    const allowed = AI_VIDEO_TRANSITIONS[job.state] || [];
    if (!allowed.includes(nextState)) {
      throw new Error(`Cannot move job from ${job.state} to ${nextState}.`);
    }
    job.state = nextState;
    job.updatedAt = now();
    if (patch.outputUrl !== undefined) job.outputUrl = patch.outputUrl;
    if (patch.error !== undefined) job.error = patch.error;
    if (nextState !== 'failed') {
      if (patch.error === undefined) job.error = null;
    }
    if (nextState !== 'completed') {
      if (patch.outputUrl === undefined) job.outputUrl = null;
    }
    return publicJob(job);
  }

  function markFailed(jobId, message) {
    const msg = typeof message === 'string' && message.trim() ? message.trim().slice(0, 500) : 'Generation failed.';
    return setState(jobId, 'failed', { error: msg });
  }

  return { create, get, setState, markFailed, states: AI_VIDEO_JOB_STATES };
}

// Dispatch a queued job to the isolated GPU worker over HTTP. The web process
// never imports torch/diffusers or touches the checkpoint; it only hands the
// official InferenceConfig-shaped payload to the worker. fetchImpl is injected
// so tests never perform network I/O.
export async function dispatchToWorker(job, { config = aiVideoConfig(), fetchImpl = globalThis.fetch } = {}) {
  if (!isRecord(job) || !job.id || !job.prompt) throw new Error('A queued job is required.');
  if (!config.workerUrl) throw new Error('AI_VIDEO_WORKER_URL is not configured.');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  const payload = buildLtxWorkerPayload(job, config);
  let res;
  try {
    res = await fetchImpl(config.workerUrl.replace(/\/+$/, '') + '/jobs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.workerToken ? { authorization: `Bearer ${config.workerToken}` } : {}),
      },
      body: JSON.stringify({ id: job.id, ...payload }),
    });
  } catch (err) {
    throw new Error(`AI worker unreachable: ${err?.message || String(err)}`);
  }
  if (!res || !res.ok) {
    const status = res ? res.status : 'unknown';
    throw new Error(`AI worker rejected the job (status ${status}).`);
  }
  return true;
}

// Build a timeline-import descriptor for a completed job. The client uses it
// to fetch the MP4 and feed it through the EXISTING #videoFile input change
// flow (addMediaFiles), so no editor logic is modified.
export function buildTimelineImport(job) {
  if (!isRecord(job)) throw new Error('A completed job is required.');
  if (job.state !== 'completed') throw new Error('Only completed jobs can be added to the timeline.');
  const url = job.outputUrl || job.downloadUrl;
  if (typeof url !== 'string' || !url) throw new Error('Completed job has no downloadable video.');
  const safePrompt = String(job.prompt || 'ai-video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ai-video';
  return {
    fileName: `ai-${safePrompt}-${String(job.id || 'video').slice(0, 8)}.mp4`,
    downloadUrl: url,
  };
}
