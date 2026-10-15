import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import {
  RECORDER_MIME_CANDIDATES,
  pickRecorderMimeType,
  recorderExtensionFor,
  recorderFileName,
  formatCaptureDimensions,
  REGION_MIN_PX,
  REGION_CAPTURE_FPS,
  normalizeDragRect,
  mapPreviewRectToSource,
  clampRegionPixels,
  RECORDER_RESOLUTIONS,
  RECORDER_DEFAULT_RESOLUTION,
  normalizeRecorderResolution,
  recorderVideoConstraints,
  recorderControlsFor,
  isRecorderSupported,
  classifyCaptureError,
  createRecorderSession,
  startRecorderSession,
  pauseRecorderSession,
  resumeRecorderSession,
  stopRecorderSession,
  recorderElapsedMs,
  formatRecorderElapsed,
  recorderPayloadBytes,
  buildRecordingFile
} from '../src/public/screen-recorder.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));

function renderEditor(overrides = {}) {
  return ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    editorAvailable: true,
    ...overrides
  });
}

test('MIME probing prefers efficient WebM capture and leaves MP4 finalization to FFmpeg', () => {
  assert.deepEqual([...RECORDER_MIME_CANDIDATES], [
    'video/webm;codecs=vp8',
    'video/webm;codecs=vp9',
    'video/webm'
  ]);
  assert.equal(pickRecorderMimeType(() => true), 'video/webm;codecs=vp8');
  assert.equal(pickRecorderMimeType((m) => m === 'video/mp4'), null);
  assert.equal(pickRecorderMimeType((m) => m === 'video/webm;codecs=vp9'), 'video/webm;codecs=vp9');
  assert.equal(pickRecorderMimeType(() => false), null);
  assert.equal(pickRecorderMimeType(null), null);
  assert.equal(pickRecorderMimeType(() => { throw new Error('boom'); }), null);
});

test('recording file names carry the matching editor-accepted extension', () => {
  assert.equal(recorderExtensionFor('video/webm;codecs=vp9'), '.webm');
  assert.equal(recorderExtensionFor('video/webm'), '.webm');
  assert.equal(recorderExtensionFor('video/mp4'), '.mp4');
  assert.equal(recorderExtensionFor('video/unknown'), '');
  assert.equal(recorderFileName('video/webm;codecs=vp8', 1720000000000), 'screen-recording-1720000000000.webm');
  assert.equal(recorderFileName('video/mp4', 1720000000000), 'screen-recording-1720000000000.mp4');
  assert.match(recorderFileName('video/webm', NaN), /^screen-recording-\d+\.webm$/);
});

test('support detection requires both getDisplayMedia and MediaRecorder', () => {
  const full = {
    navigator: { mediaDevices: { getDisplayMedia: async () => ({}) } },
    MediaRecorder: function () {}
  };
  assert.equal(isRecorderSupported(full), true);
  assert.equal(isRecorderSupported({ navigator: { mediaDevices: {} }, MediaRecorder: function () {} }), false);
  assert.equal(isRecorderSupported({ navigator: { mediaDevices: { getDisplayMedia: async () => ({}) } } }), false);
  assert.equal(isRecorderSupported({}), false);
  assert.equal(isRecorderSupported(null), false);
});

test('capture errors map to actionable user messages', () => {
  const err = (name, message) => ({ name, message });
  assert.match(classifyCaptureError(err('NotAllowedError', '')), /permission was denied/i);
  assert.match(classifyCaptureError(err('AbortError', '')), /cancelled/i);
  assert.match(classifyCaptureError(err('NotFoundError', '')), /no screen source/i);
  assert.match(classifyCaptureError(err('NotSupportedError', '')), /not supported/i);
  assert.match(classifyCaptureError(err('OverconstrainedError', '')), /without audio/i);
  assert.match(classifyCaptureError(err('SecurityError', '')), /secure context/i);
  assert.match(classifyCaptureError(err('InvalidStateError', '')), /not in a state/i);
  assert.match(classifyCaptureError(err('SomeFutureError', 'detail-here')), /failed to start.*detail-here/i);
  assert.match(classifyCaptureError(null), /failed to start/i);
});

test('resolution options stay practical and degrade to Original', () => {
  assert.deepEqual(RECORDER_RESOLUTIONS.map((entry) => entry.id), ['original', '720p', '1080p']);
  assert.equal(RECORDER_DEFAULT_RESOLUTION, 'original');
  assert.equal(normalizeRecorderResolution('720p').width, 1280);
  assert.equal(normalizeRecorderResolution('1080p').height, 1080);
  assert.equal(normalizeRecorderResolution('720').id, '720p');
  assert.equal(normalizeRecorderResolution('garbage-value').id, 'original');
  assert.equal(normalizeRecorderResolution('').id, 'original');
  assert.equal(normalizeRecorderResolution(null).id, 'original');
  assert.equal(normalizeRecorderResolution(undefined).id, 'original');
});

test('resolution constraints are preferences, never exact demands', () => {
  assert.equal(recorderVideoConstraints('original'), true);
  assert.equal(recorderVideoConstraints('  ORIGINAL ').width, undefined);
  assert.deepEqual(recorderVideoConstraints('720p'), { width: { ideal: 1280 }, height: { ideal: 720 } });
  assert.deepEqual(recorderVideoConstraints('1080p'), { width: { ideal: 1920 }, height: { ideal: 1080 } });
  // Unsupported settings fall back to unconstrained instead of failing.
  assert.equal(recorderVideoConstraints('8k-ultra'), true);
  assert.equal(recorderVideoConstraints(null), true);
});

test('captured dimensions are reported, never promised', () => {
  assert.equal(formatCaptureDimensions(1920, 1080), '1920x1080');
  assert.equal(formatCaptureDimensions(1280.7, 719.5), '1281x720');
  assert.equal(formatCaptureDimensions(null, 1080), '');
  assert.equal(formatCaptureDimensions(1920, undefined), '');
  assert.equal(formatCaptureDimensions(0, 1080), '');
  assert.equal(formatCaptureDimensions(-1, 1080), '');
  assert.equal(formatCaptureDimensions(NaN, NaN), '');
  assert.equal(formatCaptureDimensions('a', 'b'), '');
});

test('drag rectangles normalize direction and reject garbage', () => {
  assert.deepEqual(normalizeDragRect({ x: 10, y: 20, w: 30, h: 40 }), { x: 10, y: 20, w: 30, h: 40 });
  assert.deepEqual(normalizeDragRect({ x: 40, y: 60, w: -30, h: -40 }), { x: 10, y: 20, w: 30, h: 40 });
  assert.equal(normalizeDragRect(null), null);
  assert.equal(normalizeDragRect({ x: 1, y: 2 }), null);
  assert.equal(normalizeDragRect({ x: 'a', y: 0, w: 1, h: 1 }), null);
});

test('preview drags map linearly onto source pixels', () => {
  // 2x preview scale on a 1920x1080 source shown at 960x540.
  assert.deepEqual(
    mapPreviewRectToSource({ x: 100, y: 50, w: 200, h: 100 }, 960, 540, 1920, 1080),
    { x: 200, y: 100, w: 400, h: 200 }
  );
  // Drag direction does not matter.
  assert.deepEqual(
    mapPreviewRectToSource({ x: 300, y: 150, w: -200, h: -100 }, 960, 540, 1920, 1080),
    { x: 200, y: 100, w: 400, h: 200 }
  );
  assert.equal(mapPreviewRectToSource({ x: 0, y: 0, w: 1, h: 1 }, 0, 540, 1920, 1080), null);
  assert.equal(mapPreviewRectToSource(null, 960, 540, 1920, 1080), null);
});

test('regions clamp to even recordable pixels or fail loudly', () => {
  assert.equal(REGION_MIN_PX, 16);
  assert.equal(REGION_CAPTURE_FPS, 30);
  assert.deepEqual(clampRegionPixels({ x: 10, y: 20, w: 101, h: 51 }, 1920, 1080), { x: 10, y: 20, w: 100, h: 50 });
  // Overflow clamps into the frame.
  assert.deepEqual(clampRegionPixels({ x: 1900, y: 1000, w: 500, h: 500 }, 1920, 1080).w, 20);
  // Too small, degenerate, or unusable frames yield null (never fullscreen).
  assert.equal(clampRegionPixels({ x: 0, y: 0, w: 5, h: 5 }, 1920, 1080), null);
  assert.equal(clampRegionPixels({ x: 0, y: 0, w: 0, h: 0 }, 1920, 1080), null);
  assert.equal(clampRegionPixels(null, 1920, 1080), null);
  assert.equal(clampRegionPixels({ x: 0, y: 0, w: 100, h: 100 }, 0, 0), null);
  assert.equal(clampRegionPixels({ x: 0, y: 0, w: 100, h: 100 }, 'nope', 1080), null);
});

test('recorder session walks idle, recording, paused, stopped', () => {
  const session = createRecorderSession();
  assert.equal(session.status, 'idle');
  assert.equal(recorderElapsedMs(session, 1000), 0);
  assert.throws(() => pauseRecorderSession(session, 1000), /can pause/);
  assert.throws(() => resumeRecorderSession(session, 1000), /can resume/);
  assert.throws(() => stopRecorderSession(session, 1000), /not recording/);
  startRecorderSession(session, 1000);
  assert.equal(session.status, 'recording');
  assert.equal(recorderElapsedMs(session, 2500), 1500);
  assert.throws(() => startRecorderSession(session, 3000), /only start from idle/);
  assert.throws(() => resumeRecorderSession(session, 3000), /can resume/);
  pauseRecorderSession(session, 4000);
  assert.equal(session.status, 'paused');
  assert.throws(() => pauseRecorderSession(session, 4500), /can pause/);
  assert.throws(() => startRecorderSession(session, 4500), /only start from idle/);
  resumeRecorderSession(session, 9000);
  assert.equal(session.status, 'recording');
  stopRecorderSession(session, 12000);
  assert.equal(session.status, 'stopped');
  assert.throws(() => stopRecorderSession(session, 13000), /not recording/);
  assert.throws(() => startRecorderSession(createRecorderSession(), NaN), /valid start time/);
});

test('stopping while paused finalizes instead of stranding the recorder', () => {
  const session = createRecorderSession();
  startRecorderSession(session, 0);
  pauseRecorderSession(session, 5000);
  stopRecorderSession(session, 8000);
  assert.equal(session.status, 'stopped');
  // 8s wall clock minus the 3s pause span = 5s of recorded media.
  assert.equal(recorderElapsedMs(session, 8000), 5000);
  assert.equal(recorderElapsedMs(session, 60000), 5000);
});

test('timer excludes paused duration across multiple pause cycles', () => {
  const session = createRecorderSession();
  startRecorderSession(session, 0);
  assert.equal(recorderElapsedMs(session, 10000), 10000);
  pauseRecorderSession(session, 10000);
  // While paused the displayed time holds steady at the pause instant.
  assert.equal(recorderElapsedMs(session, 15000), 10000);
  assert.equal(recorderElapsedMs(session, 20000), 10000);
  resumeRecorderSession(session, 20000);
  assert.equal(recorderElapsedMs(session, 25000), 15000);
  pauseRecorderSession(session, 25000);
  resumeRecorderSession(session, 30000);
  assert.equal(recorderElapsedMs(session, 35000), 20000);
  stopRecorderSession(session, 40000);
  assert.equal(recorderElapsedMs(session, 40000), 25000);
  assert.equal(recorderElapsedMs(session, 99999), 25000);
});

test('control enablement follows the actual capture state', () => {
  assert.deepEqual(recorderControlsFor('idle'), {
    record: true, pause: false, resume: false, stop: false, resolution: true
  });
  assert.deepEqual(recorderControlsFor('recording'), {
    record: false, pause: true, resume: false, stop: true, resolution: false
  });
  assert.deepEqual(recorderControlsFor('paused'), {
    record: false, pause: false, resume: true, stop: true, resolution: false
  });
  assert.deepEqual(recorderControlsFor('stopped'), {
    record: false, pause: false, resume: false, stop: false, resolution: false
  });
  assert.deepEqual(recorderControlsFor('bogus'), {
    record: false, pause: false, resume: false, stop: false, resolution: false
  });
});

test('elapsed timer formats as MM:SS', () => {
  assert.equal(formatRecorderElapsed(0), '00:00');
  assert.equal(formatRecorderElapsed(999), '00:00');
  assert.equal(formatRecorderElapsed(5000), '00:05');
  assert.equal(formatRecorderElapsed(65000), '01:05');
  assert.equal(formatRecorderElapsed(3600000), '60:00');
  assert.equal(formatRecorderElapsed(-5), '00:00');
});

test('payload accounting and File assembly guard empty recordings', () => {
  assert.equal(recorderPayloadBytes([]), 0);
  assert.equal(recorderPayloadBytes(null), 0);
  assert.equal(recorderPayloadBytes([{ size: 10 }, { size: 0 }, null, { size: 5 }]), 15);
  assert.throws(() => buildRecordingFile([], 'video/webm', 'x.webm'), /no data/);
  const blob = new Blob(['abc'], { type: 'video/webm' });
  const file = buildRecordingFile([blob, new Blob([], { type: 'video/webm' })], 'video/webm', 'screen-recording-1.webm');
  assert.equal(file.name, 'screen-recording-1.webm');
  assert.equal(file.type, 'video/webm');
  assert.equal(file.size, 3);
});

test('editor page exposes the one-button record flow and resolution', async () => {
  const html = await renderEditor();
  for (const hook of [
    'video-editor-screen-recorder',
    'video-editor-recording-resolution',
    'video-editor-start-recording',
    'video-editor-pause-recording',
    'video-editor-resume-recording',
    'video-editor-stop-recording',
    'video-editor-recording-status',
    'video-editor-recording-timer',
    'video-editor-recording-error'
  ]) {
    assert.match(html, new RegExp(hook), `recorder hook present: ${hook}`);
  }
  assert.doesNotMatch(html, /video-editor-select-screen/, 'no separate selection step');
  assert.doesNotMatch(html, /srSelectBtn/, 'no selection button element');
  assert.match(html, /Press Record/, 'one-button flow labelled');
  assert.match(html, /drag the region to record/, 'region workflow explained');
  assert.match(html, /only that region is captured/, 'no-silent-fullscreen promise in UI');
  assert.match(html, /choose a display, window, or tab/, 'native picker choice explained without over-claiming');
  assert.match(html, /value="720p"/, '720p resolution offered');
  assert.match(html, /value="1080p"/, '1080p resolution offered');
  assert.match(html, /value="original"/, 'original resolution offered');
  assert.match(html, /aria-label="Record screen"/, 'record has an accessible label');
  assert.match(html, /aria-label="Pause recording"/, 'pause has an accessible label');
  assert.match(html, /modulepreload" href="\/screen-recorder\.js"/, 'recorder module preloaded');
});

test('idle ships with Record and resolution usable, rest inert, before any script runs', async () => {
  const html = await renderEditor();
  // Static disabled attributes: Pause/Resume/Stop must be inert from first
  // paint, even if the module script is slow or fails to load. Record and
  // the resolution selector ship enabled: Record opens the picker.
  assert.doesNotMatch(html, /id="srRecordBtn"[^>]*disabled/, 'record usable at idle');
  assert.doesNotMatch(html, /id="srResolution"[^>]*disabled/, 'resolution usable at idle');
  for (const id of ['srPauseBtn', 'srResumeBtn', 'srStopBtn']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*disabled`), `${id} statically disabled at idle`);
  }
  // Disabled state must also be visible, not just functional.
  assert.match(html, /video-editor-screen-recorder"\] \.button:disabled/, 'recorder disabled styling present');
});

test('region modal ships hidden with drag, confirm, and cancel hooks', async () => {
  const html = await renderEditor();
  for (const hook of [
    'video-editor-region-modal',
    'video-editor-region-stage',
    'video-editor-region-video',
    'video-editor-region-box',
    'video-editor-region-dims',
    'video-editor-region-confirm',
    'video-editor-region-cancel',
    'video-editor-region-error'
  ]) {
    assert.match(html, new RegExp(hook), `region hook present: ${hook}`);
  }
  assert.match(html, /id="srRegionModal"[^>]*display:none/, 'modal hidden until a source is granted');
  assert.match(html, /cursor:crosshair/, 'crosshair affordance on the selection stage');
  assert.match(html, /Esc or Cancel/, 'escape hatch documented');
});

test('recorder UI degrades to disabled controls when the editor is unavailable', async () => {
  const html = await renderEditor({ editorAvailable: false });
  assert.match(html, /video-editor-screen-recorder/, 'recorder card still rendered');
  assert.match(html, /id="srRecordBtn"[^>]*disabled/, 'record button disabled with the editor');
});

test('stop completes from recording and paused through a single finalize path', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  // Stop entry accepts both live states (stop-while-paused must finalize).
  assert.match(src, /status !== 'recording' && status !== 'paused'/, 'stop entry covers recording and paused');
  // onstop is assigned before rec.start so no completion is ever missed.
  const constructAt = src.indexOf('new window.MediaRecorder');
  const onstopAt = src.indexOf('rec.onstop = function');
  const startAt = src.indexOf('rec.start(1000)');
  assert.ok(constructAt !== -1 && onstopAt !== -1 && startAt !== -1, 'construct, onstop, and start all present');
  assert.ok(constructAt < onstopAt && onstopAt < startAt, 'onstop wired before recording starts');
  // Finalize stops every capture track (sharing indicator clears) exactly once.
  const finalizeAt = src.indexOf('function srFinalizeRecording');
  const guardAt = src.indexOf('if (srFinalized) return;');
  assert.ok(finalizeAt !== -1 && guardAt > finalizeAt, 'finalize guarded against duplicates');
  assert.match(src, /srStopStreamTracks\(stream\)/, 'finalize stops the capture tracks');
  assert.match(src, /srStopTimer\(\)/, 'finalize clears the timer');
  assert.match(src, /srSession = createRecorderSession\(\)/, 'finalize returns the session to idle');
});

test('recorder controller runs record-pick-auto-record with pause/resume', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  assert.match(src, /from '\.\/screen-recorder\.js'/, 'imports the pure recorder helpers');
  assert.match(src, /pickRecorderMimeType/, 'probes MIME support at runtime');
  assert.match(src, /async function srStartRecording/, 'single Record entry flow');
  assert.doesNotMatch(src, /srSelectSource/, 'no separate selection phase remains');
  assert.doesNotMatch(src, /readyRecorderSession/, 'no held-source state remains');
  assert.doesNotMatch(src, /source-ready/, 'no held-source status remains');
  assert.match(src, /getDisplayMedia\(attempts\[i\]\)/, 'Record opens the native picker');
  assert.match(src, /recorderVideoConstraints/, 'applies the preferred resolution');
  assert.match(src, /Screen capture ended without a live video track/, 'rejects missing or ended tracks');
  assert.match(src, /The shared source ended before recording started/, 're-validates liveness before constructing the recorder');
  assert.match(src, /new window\.MediaRecorder/, 'constructs exactly one recorder after the grant');
  assert.match(src, /rec\.pause\(\)/, 'pauses via the native MediaRecorder');
  assert.match(src, /rec\.resume\(\)/, 'resumes via the native MediaRecorder');
  assert.match(src, /pauseRecorderSession\(srSession/, 'pause guarded by the session state');
  assert.match(src, /resumeRecorderSession\(srSession/, 'resume guarded by the session state');
  assert.match(src, /rec\.onstop = function/, 'recorder completion handler wired (Stop actually finalizes)');
  assert.match(src, /srFinalized = true/, 'finalize-once guard set');
  assert.match(src, /if \(srFinalized\) return;/, 'duplicate finalization rejected');
  assert.match(src, /applyConstraints\(recorderVideoConstraints/, 'preferred resolution applied best-effort to the granted track');
  assert.match(src, /formatCaptureDimensions\(/, 'actual captured dimensions reported, not promised');
  assert.match(src, /resolution\.title = controls\.resolution/, 'resolution control explains its disabled state');
  assert.match(src, /track\.onended = function/, 'native Stop sharing routed through one path');
  assert.match(src, /srOnSourceEnded/, 'track termination handled without stranding');
  assert.match(src, /rec\.start\(1000\)/, 'records in timesliced chunks');
  assert.match(src, /addMediaFiles\('video', \[file\]\)/, 'hands the recording to the existing upload pipeline');
  assert.match(src, /srWireControls\(\);/, 'wires recorder controls during init');
  assert.match(src, /getTracks\(\)\.forEach/, 'releases media tracks on terminal paths');
  assert.match(src, /recorderPayloadBytes\(chunks\) === 0/, 'rejects empty recordings');
  assert.match(src, /srPauseBtn|video-editor-pause-recording/, 'pause control referenced');
  assert.match(src, /srResumeBtn|video-editor-resume-recording/, 'resume control referenced');
  // Order inside the single flow: picker grant → modal → confirm →
  // construct → onstop → start → session clock.
  const pickerAt = src.indexOf('getDisplayMedia(attempts[i])');
  const modalAt = src.indexOf('srOpenRegionModal()');
  const confirmAt = src.indexOf('async function srConfirmRegion');
  const constructAt = src.indexOf('new window.MediaRecorder');
  const onstopAt = src.indexOf('rec.onstop = function');
  const startAt = src.indexOf('rec.start(1000)');
  const sessionAt = src.indexOf('startRecorderSession(srSession, Date.now())');
  for (const [name, at] of [['picker', pickerAt], ['modal', modalAt], ['confirm', confirmAt], ['construct', constructAt], ['onstop', onstopAt], ['start', startAt], ['session', sessionAt]]) {
    assert.ok(at !== -1, `${name} step present`);
  }
  assert.ok(pickerAt < modalAt && modalAt < confirmAt && confirmAt < constructAt &&
    constructAt < onstopAt && onstopAt < startAt && startAt < sessionAt,
    'picker → modal → confirm → construct → onstop → start → session clock');
});

test('Admin Video Editor exposes the desktop recorder launcher', async () => {
  const html = await renderEditor();
  assert.match(html, /video-editor-desktop-recorder-launch/);
  assert.match(html, /href="learnwithme-recorder:\/\/launch"/);
  assert.match(html, /desktop-recorder\\\\install-protocol\.ps1/);
});

test('website Stop has a bounded fallback if MediaRecorder omits onstop', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  const stopBody = src.slice(src.indexOf('function srStopRecording'), src.indexOf('function srPauseRecording'));
  assert.match(stopBody, /srStopFinalizeTimer\s*=\s*setTimeout/);
  assert.match(stopBody, /2500/);
  assert.match(stopBody, /active\.stop\(\)/, 'watchdog retries stopping an active recorder');
  assert.match(stopBody, /500/, 'inactive recorder gets time for queued final events');
  assert.match(stopBody, /srFinalizeRecording\(\)/);
  assert.doesNotMatch(stopBody, /active\.ondataavailable\s*=\s*null/, 'does not discard final chunks');
  const finalizeBody = src.slice(src.indexOf('function srFinalizeRecording'), src.indexOf('function srStopRecording'));
  assert.match(finalizeBody, /clearTimeout\(srStopFinalizeTimer\)/);
  assert.match(finalizeBody, /srShowRecordingComplete\(file\)/);
});

test('recording offers a five-second countdown and explicit save choices', async () => {
  const html = await renderEditor();
  for (const hook of [
    'video-editor-recording-complete-modal',
    'video-editor-recording-complete-name',
    'video-editor-recording-complete-size',
    'video-editor-recording-complete-status',
    'video-editor-recording-save',
    'video-editor-recording-add',
    'video-editor-recording-discard'
  ]) {
    assert.match(html, new RegExp(hook), `completion hook present: ${hook}`);
  }
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  assert.match(src, /var remaining = 5/, 'countdown starts at five seconds');
  assert.match(src, /srWaitForCountdown\(\)/, 'region confirmation waits for countdown');
  assert.match(src, /srShowRecordingComplete\(file\)/, 'Stop presents the completed recording');
  assert.match(src, /anchor\.download = srPendingFile\.name/, 'Save downloads the recorded file');
  assert.match(src, /addMediaFiles\('video', \[file\]\)/, 'Add to editor preserves the editing workflow');
});
test('website crop pump keeps refreshing when the editor tab is backgrounded', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  const pump = src.slice(src.indexOf('function srStopRegionPump'), src.indexOf('function srCancelCountdown'));
  assert.match(pump, /srPumpTimer\s*=\s*setInterval\(srPumpRegionFrame, intervalMs\)/,
    'crop frames are refreshed by a timer, not RAF alone');
  assert.match(pump, /document\.addEventListener\('visibilitychange', srVisibilityHandler\)/,
    'crop is refreshed immediately when returning to the tab');
  assert.match(pump, /clearInterval\(srPumpTimer\)/, 'pump timer is cleaned up');
  assert.doesNotMatch(pump, /srRafId\s*=\s*requestAnimationFrame\(srPumpRegionFrame\)/,
    'background capture does not depend on animation-frame scheduling');
});

test('countdown duration is configurable from 1 to 60 seconds and defaults to 5', () => {
  const js = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  const html = readFileSync(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), 'utf8');
  assert.match(html, /id="srCountdownSeconds"[^>]*type="number"[^>]*min="1"[^>]*max="60"[^>]*value="5"/);
  assert.match(js, /var delayInput = \$\('srCountdownSeconds'\)/);
  assert.match(js, /var remaining = Math\.max\(1, Math\.min\(60, requestedDelay\)\)/);
});

test('floating recorder dimensions and icons stay compact', () => {
  const js = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  assert.match(js, /requestWindow\(\{ width: 190, height: 58 \}\)/);
  assert.match(js, /width:22px;height:21px;min-width:22px/);
});

test('region countdown displays large 5-to-1 numbers before recording', () => {
  const js = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  const html = readFileSync(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), 'utf8');
  assert.match(js, /number\.textContent = String\(remaining\)/);
  assert.match(js, /number\.style\.display = 'flex'/);
  assert.match(html, /id="srCountdownNumber"/);
});

test('recorder explains how to keep floating controls outside the captured region', () => {
  const js = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  const html = readFileSync(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), 'utf8');
  assert.match(js, /drag this window by its title bar to a screen area OUTSIDE your selected recording rectangle/i);
  assert.match(html, /move the floating controls window outside the rectangle using its title bar/i);
  assert.match(html, /anything inside that rectangle may appear in the video/i);
});

test('floating controls use compact icon-only buttons with hover tooltips', () => {
  const js = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  const html = readFileSync(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), 'utf8');
  assert.match(js, /requestWindow\(\{ width: 190, height: 58 \}\)/);
  assert.match(js, /title="\' \+ tooltip \+ '" aria-label=/);
  assert.match(js, /srControlButtonMarkup\('srPipPause', 'Ⅱ', 'Pause recording'/);
  assert.match(js, /srControlButtonMarkup\('srPipResume', '▶', 'Resume recording'/);
  assert.match(js, /srControlButtonMarkup\('srPipStop', '■', 'Stop recording'/);
  assert.match(js, /srControlButtonMarkup\('srPipAbort', '✕', 'Abort and discard recording'/);
  assert.match(js, /srControlButtonMarkup\('srPipSave', '↓', 'Save recording'/);
  assert.match(html, /id="srFloatingPause" title="Pause recording"/);
  assert.match(html, /id="srFloatingSave" title="Save recording after Stop"/);
  assert.match(html, /top:12px/);
});

test('region recording exposes always-on-top controls and an accessible fallback', () => {
  const js = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  const html = readFileSync(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), 'utf8');
  assert.match(js, /window\.documentPictureInPicture/);
  assert.match(js, /api\.requestWindow/);
  assert.match(js, /srPipPause/);
  assert.match(js, /srPipResume/);
  assert.match(js, /srPipStop/);
  assert.match(js, /srPipAbort/);
  assert.match(js, /srPipSave/);
  assert.match(js, /function srAbortRecording/);
  assert.match(html, /id="srFloatingControlsFallback"/);
  assert.match(html, /id="srFloatingPause"/);
  assert.match(html, /id="srFloatingResume"/);
  assert.match(html, /id="srFloatingStop"/);
  assert.match(html, /id="srFloatingAbort"/);
  assert.match(html, /id="srFloatingSave"/);
});

test('website recorder awaits visible preview playback and surfaces startup failures', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  assert.match(src, /await srOpenRegionModal\(\)/, 'capture startup waits for preview initialization');
  const openBody = src.slice(src.indexOf('async function srOpenRegionModal'), src.indexOf('function srCloseRegionModal'));
  assert.match(openBody, /modal\.style\.display = 'flex';\s*srRegionOpen = true;\s*try \{\s*var played = video\.play\(\);\s*if \(played && typeof played\.then === 'function'\) await played;/,
    'modal is visible before playback is awaited');
  assert.match(openBody, /The live screen preview could not start/, 'playback rejection produces actionable error');
  assert.doesNotMatch(openBody, /played\.catch\(function \(\) \{\}\)/, 'playback rejection is not silently swallowed');
});

test('region Confirm waits for measurable on-screen preview geometry', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  const pollBody = src.slice(src.indexOf('function srPollPreviewReady'), src.indexOf('function srPreviewMetrics'));
  assert.match(pollBody, /video\.videoWidth\s*\|\|\s*0/, 'waits for intrinsic source width');
  assert.match(pollBody, /video\.videoHeight\s*\|\|\s*0/, 'waits for intrinsic source height');
  assert.match(pollBody, /video\.readyState\s*\|\|\s*0\)\s*>=\s*2/, 'waits until a current frame is available');
  assert.match(pollBody, /!!srPreviewMetrics\(\)/, 'requires measurable CSS preview geometry');
  assert.match(pollBody, /confirm\.disabled = false/, 'enables Confirm only after readiness passes');
});

test('region recording uses a canvas crop pipeline, never silent fullscreen', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  // The recorder is constructed on the canvas output stream only.
  assert.match(src, /new window\.MediaRecorder\(outStream/, 'recorder captures the cropped canvas stream');
  assert.doesNotMatch(src, /new window\.MediaRecorder\(srStream/, 'display stream is never recorded directly');
  assert.match(src, /canvas\.captureStream\(REGION_CAPTURE_FPS\)/, 'canvas captured at a controlled frame rate');
  assert.match(src, /outStream\.addTrack\(audioTrack\)/, 'shared audio transfers onto the canvas stream');
  assert.match(src, /ctx\.drawImage\(\s*video,/, 'crop frames paint the region box');
  // Missing canvas capture fails loudly instead of falling back.
  assert.match(src, /canvas capture, which this browser does not support/, 'no-captureStream failure is explicit');
  // Invalid regions stay in the modal with guidance.
  assert.match(src, /clampRegionPixels\(mapped/, 'confirm clamps through the pure helper');
  assert.match(src, /too small or outside the frame/, 'unusable regions rejected with guidance');
  // Confirm is double-guarded like every other async entry.
  assert.match(src, /if \(srConfirming\) return;/, 'duplicate confirm rejected');
  const confirmBody = src.slice(src.indexOf('async function srConfirmRegion'), src.indexOf('function srWireControls'));
  assert.match(confirmBody, /finally \{\s*srConfirming = false;/, 'confirm flight cleared on every exit');
});

test('region pump, modal, and listeners live exactly as long as needed', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  // Pump runs while recording, holds on pause, restarts on resume.
  assert.match(src, /srStartRegionPump\(\);/, 'pump starts with recording');
  const pauseBody = src.slice(src.indexOf('function srPauseRecording'), src.indexOf('function srResumeRecording'));
  assert.match(pauseBody, /srStopRegionPump\(\);/, 'pump stops on pause');
  const resumeBody = src.slice(src.indexOf('function srResumeRecording'), src.indexOf('function srOnSourceEnded'));
  assert.match(resumeBody, /srStartRegionPump\(\);/, 'pump restarts on resume');
  // Esc listener is added on open and removed on close/confirm/finalize.
  assert.match(src, /document\.addEventListener\('keydown', srRegionKeyHandler\)/, 'esc wired on modal open');
  assert.match(src, /document\.removeEventListener\('keydown', srRegionKeyHandler\)/, 'esc unwired on close');
  // Drag uses pointer capture with a painted box and live dimensions.
  assert.match(src, /pointerdown/, 'drag starts on pointer press');
  assert.match(src, /startDrag\(e, function \(ev\)/, 'drag reuses the shared drag helper');
  // Cancel and terminal paths close the modal, pause the preview, and
  // release every stream.
  assert.match(src, /function srCancelRegion/, 'explicit cancel path exists');
  assert.match(src, /video\.srcObject = null/, 'preview source detached on close');
  const releaseBody = src.slice(src.indexOf('function srReleaseCapture'), src.indexOf('function srResetToIdle'));
  assert.match(releaseBody, /srStopRegionPump\(\)/, 'release stops the pump');
  assert.match(releaseBody, /srCloseRegionModal\(\)/, 'release closes the modal');
  assert.match(releaseBody, /srStopStreamTracks\(srOutStream\)/, 'release stops the canvas stream');
});

test('rapid double-click Record cannot duplicate pickers or recorders', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  // The picker and constraint awaits run while the session is still idle,
  // so re-entry must be rejected or duplicate flights leak tracks.
  assert.match(src, /if \(srStarting\) return;/, 'duplicate record rejected while starting');
  assert.match(src, /srStarting = true;/, 'record flight claimed');
  assert.doesNotMatch(src, /srSelecting/, 'no leftover two-phase flight flag');
  // Button sync reflects the flight so the disabled state is truthful.
  assert.match(src, /record\.disabled = !controls\.record \|\| srStarting/, 'record disables during its flight');
  // The flight always clears, even on early return: try/finally, with the
  // flight deliberately held while the region modal owns the session.
  const recordBody = src.slice(src.indexOf('async function srStartRecording'), src.indexOf('function srWireControls'));
  assert.match(recordBody, /if \(!srRegionOpen\) srStarting = false;/, 'modal keeps the flight claimed, all other exits clear it');
  // Every post-grant failure releases through srFail (no held-source state).
  assert.match(recordBody, /srFail\('This browser cannot record screen video/, 'unsupported format releases the grant');
});
