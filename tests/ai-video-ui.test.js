import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const PAGE_SRC = readFileSync(new URL('../src/views/admin-video-editor.ejs', import.meta.url), 'utf8');
const PARTIAL_SRC = readFileSync(new URL('../src/views/partials/ai-video-panel.ejs', import.meta.url), 'utf8');
const CLIENT_SRC = readFileSync(new URL('../src/public/admin-ai-video.js', import.meta.url), 'utf8');
const EDITOR_JS = readFileSync(new URL('../src/public/admin-video-editor.js', import.meta.url), 'utf8');

test('ai-video panel: renders only when enabled, with prompt/generate/status/preview/add controls', () => {
  const enabled = ejs.render(PARTIAL_SRC, { aiVideoEnabled: true });
  for (const id of ['ai-video-panel', 'ai-video-prompt', 'ai-video-generate', 'ai-video-status', 'ai-video-preview', 'ai-video-add-timeline']) {
    assert.ok(enabled.includes(`data-testid="${id}"`), `panel must include ${id}`);
  }
  assert.ok(enabled.includes('id="aiPrompt"'));
  assert.ok(enabled.includes('id="aiGenerateBtn"'));
  assert.ok(enabled.includes('id="aiAddTimelineBtn"'));
  const disabled = ejs.render(PARTIAL_SRC, {});
  assert.ok(!disabled.includes('ai-video-panel'), 'panel must not render when the flag is absent');
  const off = ejs.render(PARTIAL_SRC, { aiVideoEnabled: false });
  assert.ok(!off.includes('ai-video-panel'), 'panel must not render when disabled');
});

test('ai-video page wiring: additive include + client script, editor JS untouched', () => {
  assert.ok(PAGE_SRC.includes("include('partials/ai-video-panel')"), 'page must include the isolated partial');
  assert.ok(PAGE_SRC.includes('/admin-ai-video.js'), 'page must load the isolated client');
  assert.ok(!EDITOR_JS.includes('ai-video') && !EDITOR_JS.includes('aiVideo') && !EDITOR_JS.includes('AiVideoPanel'),
    'existing editor JS must not be modified for the POC');
  // No existing editor testids/markup removed.
  for (const marker of ['video-editor-root', 'video-editor-export', 'video-editor-evidence-section']) {
    assert.ok(PAGE_SRC.includes(marker), `existing editor markup ${marker} must remain`);
  }
});

test('ai-video client: generate → poll states → preview → timeline via existing file input', () => {
  assert.ok(CLIENT_SRC.includes("POST") || CLIENT_SRC.includes("'/api/admin/ai-video/jobs'") || CLIENT_SRC.includes('"/api/admin/ai-video/jobs"'),
    'client must create jobs via POST');
  assert.ok(CLIENT_SRC.includes('/api/admin/ai-video/jobs/'), 'client must poll job status');
  assert.ok(CLIENT_SRC.includes('queued') && CLIENT_SRC.includes('processing') && CLIENT_SRC.includes('completed') && CLIENT_SRC.includes('failed'),
    'client must surface all four job states');
  assert.ok(CLIENT_SRC.includes('aiPreview') && CLIENT_SRC.includes('.src ='), 'completed MP4 must be shown in the preview video');
  // Timeline import reuses the stock flow: DataTransfer → #videoFile → change.
  assert.ok(CLIENT_SRC.includes('videoFile'), 'client must target the existing #videoFile input');
  assert.ok(CLIENT_SRC.includes('DataTransfer'), 'client must attach the clip via DataTransfer');
  assert.ok(CLIENT_SRC.includes("dispatchEvent(new Event('change'"), 'client must fire the existing change flow');
  assert.ok(!CLIENT_SRC.includes('appendMediaClip') && !CLIENT_SRC.includes('project.videoClips'),
    'client must not touch timeline internals');
  // Never handles secrets or model config.
  assert.ok(!/WORKER_TOKEN|CHECKPOINT|SESSION_SECRET|api_key/i.test(CLIENT_SRC), 'client must never handle secrets');
});

test('ai-video page flag: server passes aiVideoEnabled without changing editor locals', () => {
  const idx = SERVER_SRC.indexOf("res.render('admin-video-editor'");
  assert.ok(idx > 0);
  const block = SERVER_SRC.slice(idx, idx + 400);
  assert.ok(block.includes('aiVideoEnabled'), 'editor page must receive the aiVideoEnabled flag');
  assert.ok(block.includes('editorAvailable') && block.includes('editorMaxVideoMb') && block.includes('preselectedPath'),
    'existing editor locals must remain');
});
