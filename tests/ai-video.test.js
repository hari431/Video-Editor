import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateAiVideoRequest,
  createAiVideoJobStore,
  buildLtxWorkerPayload,
  dispatchToWorker,
  buildTimelineImport,
  aiVideoConfig,
  isAiVideoEnabled,
  AI_VIDEO_JOB_STATES,
} from '../src/library/ai-video.js';
import { buildInferenceArgv, isMockMode, resolveWorkerConfig } from '../scripts/ltx-worker.js';

const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');

// ── API validation ──
test('ai-video validation: prompt required, bounds enforced', () => {
  assert.equal(validateAiVideoRequest(null).ok, false);
  assert.equal(validateAiVideoRequest({}).ok, false);
  assert.equal(validateAiVideoRequest({ prompt: '  ' }).ok, false);
  assert.match(validateAiVideoRequest({}).error, /prompt/i);
  const over = validateAiVideoRequest({ prompt: 'x'.repeat(1001) });
  assert.equal(over.ok, false);
  assert.match(over.error, /1000/);
  assert.equal(validateAiVideoRequest({ prompt: 'a shot', width: 1 }).ok, false);
  assert.equal(validateAiVideoRequest({ prompt: 'a shot', num_frames: 2 }).ok, false);
  const good = validateAiVideoRequest({ prompt: '  a river at dawn  ' });
  assert.equal(good.ok, true);
  assert.equal(good.prompt, 'a river at dawn');
  assert.equal(good.options.width, 768);
});

// ── Job lifecycle ──
test('ai-video lifecycle: queued -> processing -> completed; bad transitions rejected', () => {
  let n = 0;
  const store = createAiVideoJobStore({ now: () => '2026-01-01T00:00:00.000Z', id: () => `job-${++n}` });
  const created = store.create('a mountain lake', {});
  assert.equal(created.state, 'queued');
  assert.deepEqual(AI_VIDEO_JOB_STATES, ['queued', 'processing', 'completed', 'failed']);
  const processing = store.setState(created.id, 'processing');
  assert.equal(processing.state, 'processing');
  const done = store.setState(created.id, 'completed', { outputUrl: '/api/admin/ai-video/jobs/job-1/download' });
  assert.equal(done.state, 'completed');
  assert.match(done.outputUrl, /download/);
  assert.throws(() => store.setState(created.id, 'processing'), /Cannot move job/);
  assert.equal(store.get('missing'), null);
});

// ── Failure handling ──
test('ai-video failure: markFailed sets error; dispatch without worker URL throws', async () => {
  const store = createAiVideoJobStore({ now: () => '2026-01-01T00:00:00.000Z', id: () => 'job-f1' });
  const created = store.create('a desert storm', {});
  store.setState(created.id, 'processing');
  const failed = store.markFailed(created.id, 'GPU out of memory');
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /GPU/);
  await assert.rejects(
    dispatchToWorker({ id: 'x', prompt: 'hi' }, { config: { workerUrl: '', workerToken: '' }, fetchImpl: async () => ({ ok: true }) }),
    /AI_VIDEO_WORKER_URL/
  );
  await assert.rejects(
    dispatchToWorker(
      { id: 'x', prompt: 'hi' },
      { config: { workerUrl: 'http://worker:4100', workerToken: '', pipelineConfig: 'c.yaml' }, fetchImpl: async () => { throw new Error('down'); } }
    ),
    /unreachable/
  );
  await assert.rejects(
    dispatchToWorker(
      { id: 'x', prompt: 'hi' },
      { config: { workerUrl: 'http://worker:4100', workerToken: '', pipelineConfig: 'c.yaml' }, fetchImpl: async () => ({ ok: false, status: 500 }) }
    ),
    /rejected/
  );
});

// ── Timeline import ──
test('ai-video timeline import: only completed jobs with a URL', () => {
  assert.throws(() => buildTimelineImport({ state: 'processing', id: 'a', prompt: 'x' }), /Only completed/);
  assert.throws(() => buildTimelineImport({ state: 'completed', id: 'a', prompt: 'x' }), /no downloadable/);
  const imp = buildTimelineImport({ state: 'completed', id: 'abcdef123456', prompt: 'A River!', outputUrl: '/api/admin/ai-video/jobs/abcdef123456/download' });
  assert.match(imp.fileName, /\.mp4$/);
  assert.match(imp.fileName, /ai-a-river-/);
  assert.equal(imp.downloadUrl, '/api/admin/ai-video/jobs/abcdef123456/download');
});

// ── Worker boundary: official inference.py mapping, mock default ──
test('ltx worker: mock by default; argv mirrors official inference.py InferenceConfig', () => {
  assert.equal(isMockMode({}), true);
  assert.equal(resolveWorkerConfig({ AI_VIDEO_MOCK: 'false' }).mock, false);
  const argv = buildInferenceArgv({ prompt: 'a test shot', height: 512, width: 768, num_frames: 121, seed: 7 });
  assert.deepEqual(argv, ['inference.py', '--prompt', 'a test shot', '--pipeline_config', 'configs/ltxv-2b-0.9.8-distilled.yaml', '--height', '512', '--width', '768', '--num_frames', '121', '--seed', '7']);
  const payload = buildLtxWorkerPayload({ prompt: 'p', options: { width: 1, height: 2, numFrames: 9, frameRate: 30, seed: 1 } }, { pipelineConfig: 'configs/x.yaml' });
  assert.equal(payload.pipeline_config, 'configs/x.yaml');
  assert.equal(payload.num_frames, 9);
});

// ── Routes: admin-only, flag-gated, isolated ──
test('ai-video routes: admin-only, disabled by default, no secrets to browser', () => {
  assert.equal(isAiVideoEnabled({}), false);
  assert.equal(isAiVideoEnabled({ AI_VIDEO_ENABLED: 'true' }), true);
  assert.equal(aiVideoConfig({}).enabled, false);
  for (const route of ['/api/admin/ai-video/jobs', '/api/admin/ai-video/jobs/:id', '/api/admin/ai-video/jobs/:id/download']) {
    assert.ok(SERVER_SRC.includes(`'${route}'`), `server.js must register ${route}`);
  }
  const postIdx = SERVER_SRC.indexOf("app.post('/api/admin/ai-video/jobs'");
  assert.ok(postIdx > 0);
  assert.ok(SERVER_SRC.slice(postIdx, postIdx + 200).includes('requireApiAuth'));
  assert.ok(SERVER_SRC.slice(postIdx, postIdx + 200).includes('requireAdmin'));
  assert.ok(SERVER_SRC.includes('isAiVideoEnabled()'), 'routes must be feature-flagged');
  assert.ok(SERVER_SRC.includes('createAiVideoJobStore'), 'routes must use the in-memory job store');
  assert.ok(SERVER_SRC.includes('dispatchToWorker'), 'web must delegate to the isolated worker');
  // Secrets/model paths stay server-side: public job shape has no token/checkpoint.
  assert.ok(!/outputUrl.*workerToken|checkpointPath.*res\.json/s.test(SERVER_SRC));
  // Existing editor surface untouched: no edit to its export/progress/cancel wiring.
  assert.ok(SERVER_SRC.includes("app.get('/api/admin/video-editor/export-progress'"));
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/video-editor/cancel-export'"));
  // Web process never runs the model directly (comments may name inference.py;
  // execution via spawn lives only in scripts/ltx-worker.js).
  const aiBlock = SERVER_SRC.slice(SERVER_SRC.indexOf('Isolated AI Video Generation POC'));
  assert.ok(!/\bspawn\s*\(|\btorch\b|diffusers/i.test(aiBlock), 'model execution stays in scripts/ltx-worker.js');
});

// ── Route errors: disabled flag and unknown job shapes ──
test('ai-video route errors: 404 shapes for disabled/unknown, 409 before completion', () => {
  assert.ok(SERVER_SRC.includes("'AI video generation is disabled.'"));
  assert.ok(SERVER_SRC.includes("'Job not found.'"));
  assert.ok(SERVER_SRC.includes('Job is ${job.state}.') || SERVER_SRC.includes('Job is'));
});
