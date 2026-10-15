// tests/screen-recorder-behavior.test.js — Behavior-level screen recorder
// tests: boots the REAL editor page (EJS → jsdom) with stubbed browser
// capture APIs (fake picker/stream/tracks, fake MediaRecorder, fake canvas
// capture, controllable rAF) and drives the actual UI: Record click →
// picker → modal → drag → Confirm → frames → Stop → timeline clip.
//
// This is the closest executable approximation of the manual browser flow
// short of a real browser: it executes the production controller code
// paths (not source-text assertions). It never touches the network,
// storage, or the real display. No captured content is logged.
//
// Requires the `jsdom` devDependency (declared in package.json).

import './helpers/env.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { JSDOM, VirtualConsole } from 'jsdom';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const MODULE_URL = pathToFileURL(fileURLToPath(new URL('../src/public/admin-video-editor.js', import.meta.url))).href;

function makeVideoTrack(over = {}) {
  const track = {
    kind: 'video',
    readyState: 'live',
    stopped: false,
    onended: null,
    label: 'Fake display',
    stop() {
      if (this.stopped) return;
      this.stopped = true;
      this.readyState = 'ended';
      if (typeof this.onended === 'function') {
        try { this.onended(); } catch {}
      }
    },
    getSettings() { return { width: 1920, height: 1080 }; },
    async applyConstraints() {},
    ...over
  };
  return track;
}

function makeAudioTrack() {
  return {
    kind: 'audio',
    readyState: 'live',
    stopped: false,
    stop() { this.stopped = true; this.readyState = 'ended'; },
    getSettings() { return {}; }
  };
}

function makeDisplayStream({ audio = true } = {}) {
  const video = makeVideoTrack();
  const tracks = audio ? [video, makeAudioTrack()] : [video];
  return {
    __video: video,
    getVideoTracks() { return tracks.filter((t) => t.kind === 'video'); },
    getAudioTracks() { return tracks.filter((t) => t.kind === 'audio'); },
    getTracks() { return [...tracks]; }
  };
}

function namedError(name, message) {
  const err = new Error(message || name);
  err.name = name;
  return err;
}

// Minimal Web Audio stand-in so the harness exercises the production mixer
// path exactly like a real browser (jsdom provides no AudioContext, which
// used to hide mixer defects behind the no-Web-Audio fallback). The mixed
// track is fed only once its destination has a connected source — mirroring
// the Chrome muxer behavior that starves on a source-less destination.
function makeFakeAudioNode() {
  return {
    connect(target) {
      if (target && target.__isDestination) target.__sourceCount += 1;
      return target;
    }
  };
}

class FakeAudioDestination {
  constructor() {
    this.__isDestination = true;
    this.__sourceCount = 0;
    const dest = this;
    this.__track = {
      kind: 'audio',
      readyState: 'live',
      stopped: false,
      muted: false,
      __isMixed: true,
      __dest: dest,
      stop() { this.stopped = true; this.readyState = 'ended'; },
      getSettings() { return {}; }
    };
    this.stream = { getAudioTracks: () => [this.__track] };
  }
}

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
  }
  createMediaStreamDestination() { return new FakeAudioDestination(); }
  createMediaStreamSource() { return makeFakeAudioNode(); }
  createOscillator() {
    const node = makeFakeAudioNode();
    node.frequency = { value: 440 };
    node.start = () => {};
    node.stop = () => {};
    return node;
  }
  createGain() {
    const node = makeFakeAudioNode();
    node.gain = { value: 1, setTargetAtTime() {}, setValueAtTime() {} };
    return node;
  }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}

class FakeMediaRecorder {
  static instances = [];
  static chunksFired = 0;
  static supported = new Set(['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']);
  static isTypeSupported(mime) { return FakeMediaRecorder.supported.has(mime); }
  // Per-boot probe: (recordedStream) => true when at least one frame was
  // painted onto the recorded canvas. Models the real muxer: a canvas that
  // never receives a frame yields no encodable data.
  static paintProbe = null;
  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || 'video/webm';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onerror = null;
    this.onstop = null;
    this.stopCalls = 0;
    FakeMediaRecorder.instances.push(this);
  }
  // Chrome-faithful payload rule: a chunk carries bytes only when the canvas
  // was painted AND every audio track on the recorded stream is fed. A
  // source-less Web Audio mix destination starves the muxer, so the browser
  // fires dataavailable with an EMPTY blob (the app filters size > 0).
  // Plain (non-mixer) tracks are always fed; mixer tracks are fed once their
  // destination has at least one connected source.
  muxerPayload() {
    let painted = true;
    try {
      painted = typeof FakeMediaRecorder.paintProbe === 'function'
        ? !!FakeMediaRecorder.paintProbe(this.stream)
        : true;
    } catch {}
    let fed = true;
    try {
      const audio = this.stream && typeof this.stream.getAudioTracks === 'function'
        ? this.stream.getAudioTracks()
        : [];
      fed = audio.every((t) => t.__isMixed !== true || (t.__dest ? t.__dest.__sourceCount > 0 : true));
    } catch {}
    return (painted && fed) ? `fake-chunk-${FakeMediaRecorder.chunksFired}` : '';
  }
  emitAvailable() {
    FakeMediaRecorder.chunksFired += 1;
    if (typeof this.ondataavailable === 'function') {
      try {
        this.ondataavailable({ data: new Blob([this.muxerPayload()], { type: this.mimeType }) });
      } catch {}
    }
  }
  start() {
    if (this.state !== 'inactive') throw new Error('InvalidStateError');
    this.state = 'recording';
  }
  pause() {
    if (this.state !== 'recording') throw new Error('InvalidStateError');
    this.state = 'paused';
  }
  resume() {
    if (this.state !== 'paused') throw new Error('InvalidStateError');
    this.state = 'recording';
  }
  requestData() {
    if (this.state === 'inactive') return;
    this.emitAvailable();
  }
  stop() {
    this.stopCalls += 1;
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.emitAvailable();
    if (typeof this.onstop === 'function') {
      try { this.onstop(); } catch {}
    }
  }
}

let bootSeq = 0;
let activeHarness = null;

const savedTimers = {
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval
};

afterEach(async () => {
  // Always release: recording tests leave live paint/poll intervals that
  // would otherwise keep the runner process alive forever.
  if (activeHarness) {
    try { await activeHarness.shutdown(); } catch {}
    activeHarness = null;
  }
  // Restore bare timer globals in case a boot was interrupted.
  try {
    globalThis.setInterval = savedTimers.setInterval;
    globalThis.clearInterval = savedTimers.clearInterval;
  } catch {}
});

async function boot({ picker = null, canvas = 'ok' } = {}) {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.chunksFired = 0;
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    editorAvailable: true
  });
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url: 'https://localhost/', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const doc = window.document;

  // Controllable animation frames.
  let rafSeq = 0;
  const rafQueue = new Map();
  const requestFrame = (cb) => {
    const id = ++rafSeq;
    rafQueue.set(id, cb);
    return id;
  };
  const cancelFrame = (id) => { rafQueue.delete(id); };
  const stepFrames = (n = 1) => {
    for (let i = 0; i < n; i++) {
      const jobs = [...rafQueue.values()];
      rafQueue.clear();
      for (const cb of jobs) {
        try { cb(performance.now()); } catch {}
      }
    }
  };

  globalThis.window = window;
  globalThis.document = doc;
  // NOTE: globalThis.navigator is getter-only on modern Node; the module
  // under test consistently uses window.navigator, which jsdom provides.
  globalThis.requestAnimationFrame = requestFrame;
  globalThis.cancelAnimationFrame = cancelFrame;
  window.requestAnimationFrame = requestFrame;
  window.cancelAnimationFrame = cancelFrame;

  // Bare-timer registry: the controller arms paint/poll intervals that must
  // not outlive the test (see shutdown()).
  const liveIntervals = new Set();
  globalThis.setInterval = (fn, ms, ...args) => {
    const id = savedTimers.setInterval(fn, ms, ...args);
    liveIntervals.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => {
    liveIntervals.delete(id);
    return savedTimers.clearInterval(id);
  };

  // Picker.
  const pickerCalls = [];
  const grant = picker || (async () => makeDisplayStream({ audio: true }));
  Object.defineProperty(window.navigator, 'mediaDevices', {
    value: {
      getDisplayMedia: (constraints) => {
        pickerCalls.push(constraints);
        return grant(constraints);
      }
    },
    configurable: true
  });

  // Recorder (muxer-faithful: see FakeMediaRecorder.muxerPayload).
  window.MediaRecorder = FakeMediaRecorder;
  FakeMediaRecorder.paintProbe = (stream) => {
    const canvasEl = stream && stream.__canvas;
    if (!canvasEl) return false;
    return drawnFrames.some((entry) => entry.canvas === canvasEl);
  };

  // Web Audio: present like a real desktop browser so the mixer path runs.
  window.AudioContext = FakeAudioContext;

  // Object URLs (fileMeta probing path).
  if (typeof window.URL.createObjectURL !== 'function') {
    window.URL.createObjectURL = () => 'blob:fake-url';
  }
  if (typeof window.URL.revokeObjectURL !== 'function') {
    window.URL.revokeObjectURL = () => {};
  }

  // Canvas capture: 'ok' records frames, 'missing' simulates an ancient
  // browser without captureStream, 'draw-throws' simulates a broken pipe.
  const drawnFrames = [];
  let drawMode = 'ok';
  window.HTMLCanvasElement.prototype.getContext = function () {
    const canvasEl = this;
    return {
      drawImage: (...args) => {
        if (drawMode === 'throw') throw new Error('draw failed');
        const entry = [...args];
        entry.canvas = canvasEl;
        drawnFrames.push(entry);
      },
      clearRect() {}, fillRect() {}, strokeRect() {}, save() {}, restore() {},
      setLineDash() {}, fillText() {}, strokeText() {}
    };
  };
  const canvasStreams = [];
  if (canvas !== 'missing') {
    window.HTMLCanvasElement.prototype.captureStream = function (fps) {
      const canvasEl = this;
      const videoTracks = [{
        kind: 'video',
        readyState: 'live',
        stopped: false,
        stop() { this.stopped = true; this.readyState = 'ended'; },
        getSettings: () => ({ width: canvasEl.width, height: canvasEl.height })
      }];
      const audioTracks = [];
      const out = {
        __canvas: canvasEl,
        __fps: fps,
        getVideoTracks: () => [...videoTracks],
        getAudioTracks: () => [...audioTracks],
        getTracks: () => [...videoTracks, ...audioTracks],
        addTrack: (t) => { (t.kind === 'audio' ? audioTracks : videoTracks).push(t); }
      };
      canvasStreams.push(out);
      return out;
    };
  } else {
    delete window.HTMLCanvasElement.prototype.captureStream;
  }

  // fileMeta probing: temp video/audio elements resolve fake metadata.
  const origCreate = doc.createElement.bind(doc);
  doc.createElement = (tag, options) => {
    const el = origCreate(tag, options);
    if (tag === 'video' || tag === 'audio') {
      queueMicrotask(() => {
        try {
          Object.defineProperty(el, 'duration', { value: 5, configurable: true });
          if (tag === 'video') {
            Object.defineProperty(el, 'videoWidth', { value: 640, configurable: true });
            Object.defineProperty(el, 'videoHeight', { value: 360, configurable: true });
          }
        } catch {}
        el.dispatchEvent(new window.Event('loadedmetadata'));
      });
    }
    return el;
  };

  // Wait for document load so the module init() runs synchronously.
  await new Promise((resolve) => {
    if (doc.readyState === 'complete') resolve();
    else window.addEventListener('load', () => resolve(), { once: true });
  });
  await import(`${MODULE_URL}?boot=${++bootSeq}`);

  const $ = (id) => doc.getElementById(id);
  const click = (el) => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const stubPreview = ({ cssW = 960, cssH = 540, left = 100, top = 60, frameW = 1920, frameH = 1080, readyState = 3 } = {}) => {
    const video = $('srRegionVideo');
    const stage = $('srRegionStage');
    Object.defineProperty(video, 'videoWidth', { value: frameW, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: frameH, configurable: true });
    Object.defineProperty(video, 'readyState', { value: readyState, configurable: true });
    const rect = { left, top, width: cssW, height: cssH, right: left + cssW, bottom: top + cssH, x: left, y: top, toJSON: () => ({}) };
    video.getBoundingClientRect = () => ({ ...rect });
    stage.getBoundingClientRect = () => ({ ...rect });
  };
  const dragOnStage = (x1, y1, x2, y2) => {
    const stage = $('srRegionStage');
    const down = new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x1, clientY: y1, button: 0 });
    stage.dispatchEvent(down);
    const move = new window.MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: x2, clientY: y2 });
    window.dispatchEvent(move);
    const up = new window.MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: x2, clientY: y2 });
    window.dispatchEvent(up);
  };
  const escKey = () => {
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
  };
  const timelineClips = () => doc.querySelectorAll('#veLaneVideo .ve-clip-video');
  const shutdown = async () => {
    for (const id of [...liveIntervals]) {
      try { savedTimers.clearInterval(id); } catch {}
    }
    liveIntervals.clear();
    try { dom.window.close(); } catch {}
    try {
      globalThis.setInterval = savedTimers.setInterval;
      globalThis.clearInterval = savedTimers.clearInterval;
    } catch {}
  };

  const harness = {
    window, doc, $, click, settle, stubPreview, dragOnStage, escKey, timelineClips,
    shutdown,
    stepFrames, pickerCalls, drawnFrames, canvasStreams,
    setDrawMode: (mode) => { drawMode = mode; },
    recorders: () => FakeMediaRecorder.instances
  };
  activeHarness = harness;
  return harness;
}

test('boots to idle: Record usable, Pause/Resume/Stop inert', async () => {
  const h = await boot();
  assert.equal(h.$('srRecordBtn').disabled, false);
  assert.equal(h.$('srResolution').disabled, false);
  assert.equal(h.$('srPauseBtn').disabled, true);
  assert.equal(h.$('srResumeBtn').disabled, true);
  assert.equal(h.$('srStopBtn').disabled, true);
  assert.equal(h.$('srFloatingMic').disabled, true, 'microphone toggle is unavailable before recording');
  assert.equal(h.$('srFloatingCamera').disabled, true, 'camera toggle is unavailable before recording');
  assert.equal(h.$('srFloatingMic').title, 'Unmute microphone');
  assert.equal(h.$('srFloatingCamera').title, 'Turn camera on');
  assert.equal(h.$('srStatus').textContent, 'Idle');
  assert.equal(h.$('srRegionModal').style.display, 'none');
});

test('Record opens the picker, then the modal with a live preview', async () => {
  const h = await boot();
  h.click(h.$('srRecordBtn'));
  await h.settle();
  assert.equal(h.pickerCalls.length, 1);
  assert.deepEqual(h.pickerCalls[0], { video: true, audio: true });
  assert.equal(h.$('srRegionModal').style.display, 'flex');
  assert.ok(h.$('srRegionVideo').srcObject, 'preview wired to the granted stream');
  assert.equal(h.$('srStopBtn').disabled, true);
  assert.equal(h.$('srPauseBtn').disabled, true);
});

test('picker cancellation returns to clean Idle', async () => {
  const h = await boot({
    picker: async () => { throw namedError('AbortError', 'denied'); }
  });
  h.click(h.$('srRecordBtn'));
  await h.settle();
  assert.equal(h.$('srRegionModal').style.display, 'none');
  assert.equal(h.$('srStatus').textContent, 'Idle');
  assert.equal(h.$('srRecordBtn').disabled, false);
  assert.match(h.$('srError').textContent, /cancelled/i);
  assert.equal(h.recorders().length, 0);
});

test('permission denial returns to clean Idle', async () => {
  const h = await boot({
    picker: async () => { throw namedError('NotAllowedError', 'nope'); }
  });
  h.click(h.$('srRecordBtn'));
  await h.settle();
  assert.equal(h.$('srStatus').textContent, 'Idle');
  assert.match(h.$('srError').textContent, /permission was denied/i);
  assert.equal(h.$('srRecordBtn').disabled, false);
});

test('Confirm stays disabled until the preview is ready', async () => {
  const h = await boot();
  h.click(h.$('srRecordBtn'));
  await h.settle();
  // No dimensions stubbed: preview not ready.
  assert.equal(h.$('srRegionConfirm').disabled, true);
  assert.match(h.$('srRegionDims').textContent, /Waiting for preview/);
});

test('drag draws the box with live mapped dimensions', async () => {
  const h = await boot();
  h.click(h.$('srRecordBtn'));
  await h.settle();
  h.stubPreview();
  await h.settle(400);
  assert.equal(h.$('srRegionConfirm').disabled, false);
  h.dragOnStage(100, 60, 300, 160);
  const box = h.$('srRegionBox');
  assert.equal(box.style.display, 'block');
  assert.equal(box.style.width, '200px');
  assert.equal(box.style.height, '100px');
  // 2x preview scale: 200x100 css → 400x200 source pixels.
  assert.equal(h.$('srRegionDims').textContent, 'Region 400x200');
});

test('Confirm without a drag keeps the modal open with guidance', async () => {
  const h = await boot();
  h.click(h.$('srRecordBtn'));
  await h.settle();
  h.stubPreview();
  await h.settle(400);
  h.click(h.$('srRegionConfirm'));
  await h.settle();
  assert.equal(h.$('srRegionModal').style.display, 'flex');
  assert.match(h.$('srRegionError').textContent, /Drag a rectangle/);
  assert.equal(h.recorders().length, 0);
});

test('tiny regions are rejected, never recorded', async () => {
  const h = await boot();
  h.click(h.$('srRecordBtn'));
  await h.settle();
  h.stubPreview();
  await h.settle(400);
  h.dragOnStage(100, 60, 102, 62);
  h.click(h.$('srRegionConfirm'));
  await h.settle();
  assert.equal(h.$('srRegionModal').style.display, 'flex');
  assert.match(h.$('srRegionError').textContent, /too small/);
  assert.equal(h.recorders().length, 0);
});

test('Confirm records only the region and pumps frames while recording', async () => {
  const h = await boot();
  h.click(h.$('srRecordBtn'));
  await h.settle();
  h.stubPreview();
  await h.settle(400);
  h.dragOnStage(100, 60, 300, 160);
  h.click(h.$('srRegionConfirm'));
  await h.settle();
  assert.equal(h.recorders().length, 1);
  const rec = h.recorders()[0];
  assert.equal(rec.state, 'recording');
  assert.ok(h.canvasStreams.includes(rec.stream), 'recorder captures the canvas stream, not the display');
  assert.equal(rec.stream.__fps, 30);
  assert.equal(rec.stream.getAudioTracks().length, 1, 'shared audio carried over');
  assert.equal(h.$('srRegionModal').style.display, 'none');
  assert.match(h.$('srStatus').textContent, /Recording region 400x200/);
  assert.equal(h.$('srPauseBtn').disabled, false);
  assert.equal(h.$('srStopBtn').disabled, false);
  const before = h.drawnFrames.length;
  assert.ok(before > 0, 'first frame painted synchronously');
  const frame = h.drawnFrames[0];
  assert.deepEqual(frame.slice(1, 5), [200, 100, 400, 200], 'crop box in source pixels');
  assert.deepEqual(frame.slice(5, 7), [400, 200], 'canvas sized to the region');
  h.stepFrames(3);
  assert.ok(h.drawnFrames.length > before, 'pump keeps painting while recording');
});

test('pause holds frames, resume restarts, stop finalizes one clip', async () => {
  const h = await boot();
  h.click(h.$('srRecordBtn'));
  await h.settle();
  h.stubPreview();
  await h.settle(400);
  h.dragOnStage(100, 60, 300, 160);
  h.click(h.$('srRegionConfirm'));
  await h.settle();
  const rec = h.recorders()[0];
  h.click(h.$('srPauseBtn'));
  assert.equal(rec.state, 'paused');
  assert.equal(h.$('srPauseStudioModal').style.display, 'flex', 'Pause opens the maximized edit studio');
  assert.ok(h.$('srPauseStudioCanvas'), 'paused frame preview is available');
  assert.equal(h.$('srPauseStudioAddText').disabled, false);
  assert.equal(h.$('srPauseStudioBlur').disabled, false);
  h.$('srPauseStudioText').value = 'Test annotation';
  h.click(h.$('srPauseStudioAddText'));
  assert.equal(h.$('srPauseStudioRemove').disabled, false, 'added annotation can be selected');
  assert.ok(h.$('srPauseStudioClear'), 'studio exposes a clear-all control');
  h.click(h.$('srPauseStudioRemove'));
  assert.equal(h.$('srPauseStudioRemove').disabled, true, 'selected annotation can be removed');
  h.$('srPauseStudioText').value = 'Persistent annotation';
  h.click(h.$('srPauseStudioAddText'));
  assert.equal(h.$('srPauseStudioRemove').disabled, false, 'second annotation is active');
  h.click(h.$('srPauseStudioClear'));
  assert.equal(h.$('srPauseStudioRemove').disabled, true, 'clear-all removes active edits');
  const frozen = h.drawnFrames.length;
  h.stepFrames(5);
  assert.equal(h.drawnFrames.length, frozen, 'no frames while paused');
  assert.equal(h.$('srResumeBtn').disabled, false);
  h.click(h.$('srResumeBtn'));
  assert.equal(h.$('srPauseStudioModal').style.display, 'none', 'studio is hidden before capture resumes');
  assert.equal(rec.state, 'recording');
  h.stepFrames(2);
  assert.ok(h.drawnFrames.length > frozen, 'frames resume');
  h.click(h.$('srStopBtn'));
  await h.settle(80);
  assert.equal(rec.stopCalls, 1);
  assert.equal(h.$('srStatus').textContent, 'Finishing…');
  assert.equal(h.$('srStopBtn').disabled, true, 'Stop stays disabled during finalization');
  assert.equal(h.timelineClips().length, 1, 'exactly one main-timeline clip');
  assert.equal(h.$('srStopBtn').disabled, true);
  assert.equal(h.$('srRecordBtn').disabled, false);
});

test('Stop waits for the final dataavailable event before preserving the file', async () => {
  const h = await boot();
  h.click(h.$('srRecordBtn'));
  await h.settle();
  h.stubPreview();
  await h.settle(400);
  h.dragOnStage(100, 60, 300, 160);
  h.click(h.$('srRegionConfirm'));
  await h.settle();
  const rec = h.recorders()[0];
  // Simulate a browser that delivers final data shortly after stop rather
  // than synchronously inside stop().
  rec.stop = function () {
    this.stopCalls += 1;
    this.state = 'inactive';
    setTimeout(() => {
      if (typeof this.ondataavailable === 'function') {
        this.ondataavailable({ data: new Blob(['delayed-final-chunk'], { type: this.mimeType }) });
      }
      if (typeof this.onstop === 'function') this.onstop();
    }, 30);
  };
  h.click(h.$('srStopBtn'));
  assert.equal(h.$('srStatus').textContent, 'Finishing…');
  await h.settle(100);
  assert.equal(rec.stopCalls, 1);
  assert.equal(h.$('srStatus').textContent, 'Idle');
  assert.equal(h.timelineClips().length, 1, 'final chunk reaches the existing editor handoff');
});

test('onstop arriving before final dataavailable still preserves the recording', async () => {
  const h = await boot();
  h.click(h.$('srRecordBtn'));
  await h.settle();
  h.stubPreview();
  await h.settle(400);
  h.dragOnStage(100, 60, 300, 160);
  h.click(h.$('srRegionConfirm'));
  await h.settle();
  const rec = h.recorders()[0];
  rec.stop = function () {
    this.stopCalls += 1;
    this.state = 'inactive';
    // Simulate a browser that dispatches stop before its final data event.
    if (typeof this.onstop === 'function') this.onstop();
    setTimeout(() => {
      if (typeof this.ondataavailable === 'function') {
        this.ondataavailable({ data: new Blob(['late-final-chunk'], { type: this.mimeType }) });
      }
    }, 80);
  };
  h.click(h.$('srStopBtn'));
  await h.settle(450);
  assert.equal(rec.stopCalls, 1);
  assert.equal(h.timelineClips().length, 1, 'late final chunk is preserved and handed to editor');
});

test('zero-chunk stop reports recoverable failure without hiding floating controls', async () => {
  const h = await boot();
  h.click(h.$('srRecordBtn'));
  await h.settle();
  h.stubPreview();
  await h.settle(400);
  h.dragOnStage(100, 60, 300, 160);
  h.click(h.$('srRegionConfirm'));
  await h.settle();
  const rec = h.recorders()[0];
  rec.stop = function () {
    this.stopCalls += 1;
    this.state = 'inactive';
    // Deliberately no dataavailable event: reproduce the reported failure.
    if (typeof this.onstop === 'function') this.onstop();
  };
  h.click(h.$('srStopBtn'));
  await h.settle(80);
  assert.match(h.$('srError').textContent, /did not provide any video chunks/i);
  assert.equal(h.$('srFloatingControlsFallback').style.display, 'block',
    'controls remain available to explain recovery/failure');
  assert.equal(h.$('srRecordBtn').disabled, false);
});

test('native Stop sharing mid-recording finalizes without duplicates', async () => {
  let granted = null;
  const h = await boot({
    picker: async () => {
      granted = makeDisplayStream({ audio: false });
      return granted;
    }
  });
  h.click(h.$('srRecordBtn'));
  await h.settle();
  h.stubPreview();
  await h.settle(400);
  h.dragOnStage(100, 60, 300, 160);
  h.click(h.$('srRegionConfirm'));
  await h.settle();
  assert.equal(h.recorders().length, 1);
  granted.__video.stop();
  await h.settle(80);
  assert.equal(h.timelineClips().length, 1);
  assert.equal(h.$('srStatus').textContent, 'Idle');
  assert.ok(granted.__video.stopped, 'source track released');
});

test('Escape in the modal cancels cleanly with tracks released', async () => {
  let granted = null;
  const h = await boot({
    picker: async () => {
      granted = makeDisplayStream({ audio: true });
      return granted;
    }
  });
  h.click(h.$('srRecordBtn'));
  await h.settle();
  h.escKey();
  await h.settle();
  assert.equal(h.$('srRegionModal').style.display, 'none');
  assert.equal(h.$('srStatus').textContent, 'Idle');
  assert.ok(granted.getTracks().every((t) => t.stopped), 'all tracks stopped');
  assert.equal(h.$('srRecordBtn').disabled, false);
});

test('missing canvas capture fails loudly, never fullscreen', async () => {
  const h = await boot({ canvas: 'missing' });
  h.click(h.$('srRecordBtn'));
  await h.settle();
  h.stubPreview();
  await h.settle(400);
  h.dragOnStage(100, 60, 300, 160);
  h.click(h.$('srRegionConfirm'));
  await h.settle();
  assert.equal(h.recorders().length, 0, 'no recorder without canvas capture');
  assert.match(h.$('srError').textContent || h.$('srStatus').textContent, /canvas capture|Idle/);
  assert.equal(h.$('srStatus').textContent, 'Idle');
});

test('sustained draw failures stop the recording with an error', async () => {
  const h = await boot();
  h.click(h.$('srRecordBtn'));
  await h.settle();
  h.stubPreview();
  await h.settle(400);
  h.dragOnStage(100, 60, 300, 160);
  h.click(h.$('srRegionConfirm'));
  await h.settle();
  const rec = h.recorders()[0];
  assert.equal(rec.state, 'recording');
  h.setDrawMode('throw');
  h.stepFrames(70);
  await h.settle(80);
  assert.equal(rec.state, 'inactive', 'threshold stops the broken pipeline');
  assert.equal(h.$('srStatus').textContent, 'Idle');
});

test('preview that never becomes ready times out back to Idle', async () => {
  const h = await boot();
  const realNow = Date.now;
  let granted = null;
  try {
    h.click(h.$('srRecordBtn'));
    await h.settle();
    // Never stub dimensions: preview stays unready. Jump the clock past
    // the bounded wait, then let the poll tick once.
    globalThis.Date.now = () => realNow() + 60 * 1000;
    await h.settle(400);
  } finally {
    globalThis.Date.now = realNow;
  }
  assert.equal(h.$('srRegionModal').style.display, 'none');
  assert.equal(h.$('srStatus').textContent, 'Idle');
  assert.ok(
    (h.$('srError').textContent || '').includes('never became ready') ||
    h.$('srRecordBtn').disabled === false,
    'actionable timeout state, reusable Record'
  );
  void granted;
});

test('recording without shared system audio still yields a savable file', async () => {
  // Root-cause regression: the Web Audio mixer must not starve MediaRecorder
  // when the granted display stream carries no audio track (the user did not
  // share audio). A source-less mix destination made Chrome emit only empty
  // dataavailable blobs for the whole session, so Stop finalized with zero
  // chunks ("Recording failed — no video data") despite painted frames.
  const h = await boot({
    picker: async () => makeDisplayStream({ audio: false })
  });
  h.click(h.$('srRecordBtn'));
  await h.settle();
  h.stubPreview();
  await h.settle(400);
  h.dragOnStage(100, 60, 300, 160);
  h.$('srCountdownSeconds').value = '1';
  h.click(h.$('srRegionConfirm'));
  await h.settle(1700);
  assert.equal(h.recorders().length, 1, 'recorder starts after the countdown');
  const rec = h.recorders()[0];
  assert.equal(rec.state, 'recording');
  assert.ok(h.drawnFrames.length > 0, 'region frames are painting');
  assert.equal(rec.stream.getAudioTracks().length, 1, 'exactly one mixed audio track');
  h.click(h.$('srStopBtn'));
  await h.settle(700);
  assert.doesNotMatch(
    h.$('srError').textContent || '',
    /did not provide any video chunks/i,
    'no zero-chunk failure when audio was never shared'
  );
  assert.equal(h.$('srRecordingCompleteModal').style.display, 'flex', 'completed recording is offered for save');
  assert.equal(h.$('srFloatingSave').disabled, false, 'Save is available after Stop');
  assert.match(h.$('srRecordingCompleteName').textContent, /screen-recording-.*\.webm/);
});
