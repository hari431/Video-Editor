import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEditSpec,
  buildFfmpegArgs,
  EDITOR_MAX_VIDEO_OVERLAYS
} from '../src/library/video-editor.js';
import {
  createProject,
  addFileEntry,
  appendMediaClip,
  addClip,
  getClip,
  deleteClip,
  duplicateClip,
  moveClip,
  resizeClip,
  splitOverlayClipAt,
  splitAtPlayhead,
  extendOverlayToVideoEnd,
  projectToSpecV2,
  videoOverlayPreviewRect,
  videoOverlayExportBox,
  normalizeVoverlayPreset,
  normalizeVoverlayMargin,
  normalizeVoverlayShadow,
  voverlayPresetXY,
  VOVERLAY_PRESETS,
  VOVERLAY_DEFAULT_MARGIN,
  resetProjectIds
} from '../src/public/video-editor-project.js';

function mkProject() {
  resetProjectIds();
  const p = createProject();
  const main = addFileEntry(p, { kind: 'video', name: 'main.mp4', duration: 60, width: 1280, height: 720 });
  appendMediaClip(p, main.id);
  return p;
}

function addSecondVideo(p) {
  return addFileEntry(p, { kind: 'video', name: 'pip.mp4', duration: 20, width: 640, height: 480 });
}

function baseSpecV2(overrides = {}) {
  return {
    version: 2,
    width: 1280,
    height: 720,
    files: [{ kind: 'video' }, { kind: 'video' }],
    videoClips: [{ file: 0, sourceIn: 0, sourceOut: 10, start: 0, gain: 1 }],
    audioClips: [],
    blurs: [],
    texts: [],
    images: [],
    videoOverlays: [],
    ...overrides
  };
}

const V2_MEDIA = { width: 1280, height: 720, hasAudio: [true, true] };

// --- Model: creation ------------------------------------------------------------------
test('overlay: addClip defaults to last video, aspect height, distinct ids', () => {
  const p = mkProject();
  addSecondVideo(p);
  const ov = addClip(p, 'voverlay', 5);
  assert.equal(ov.type, 'voverlay');
  assert.equal(ov.file, 1);
  assert.equal(ov.x, 0.65);
  assert.equal(ov.y, 0.6);
  assert.equal(ov.w, 0.3);
  // 640x480 source → h = 0.3 * 480/640 = 0.225.
  assert.equal(ov.h, 0.225);
  assert.equal(ov.sourceIn, 0);
  assert.ok(/^o\d+$/.test(ov.id), 'overlay ids use the o-prefix');
  assert.ok(ov.end - ov.start >= 0.1);
  // Lone video overlays itself.
  const solo = mkProject();
  const self = addClip(solo, 'voverlay', 2);
  assert.equal(self.file, 0);
  // No video files at all → clear error.
  const empty = createProject();
  assert.throws(() => addClip(empty, 'voverlay', 0), /video file/);
});

test('overlay: explicit file index is honored and clamped', () => {
  const p = mkProject();
  addSecondVideo(p);
  assert.equal(addClip(p, 'voverlay', 1, 0).file, 0);
  assert.equal(addClip(p, 'voverlay', 1, 99).file, 1);
});

// --- Model: spec serialization (persistence) -----------------------------------------------
test('overlay: project serializes overlays exactly into the export spec', () => {
  const p = mkProject();
  addSecondVideo(p);
  const ov = addClip(p, 'voverlay', 4, 1);
  ov.x = 0.1;
  ov.y = 0.2;
  ov.w = 0.4;
  ov.h = 0.3;
  ov.sourceIn = 2.5;
  const spec = projectToSpecV2(p);
  assert.equal(spec.videoOverlays.length, 1);
  assert.deepEqual(spec.videoOverlays[0], {
    file: 1, x: 0.1, y: 0.2, w: 0.4, h: 0.3, start: ov.start, end: ov.end, sourceIn: 2.5
  });
  // Projects without overlays serialize an empty list (existing shape kept).
  const plain = mkProject();
  assert.deepEqual(projectToSpecV2(plain).videoOverlays, []);
});

test('overlay: serialized spec re-validates server-side (round-trip)', async () => {
  const { validateSpecV2 } = await import('../src/library/video-editor.js');
  const p = mkProject();
  addSecondVideo(p);
  const ov = addClip(p, 'voverlay', 3, 1);
  const spec = projectToSpecV2(p);
  const checked = validateSpecV2(spec);
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.spec.videoOverlays[0].file, ov.file);
});

// --- Model: timeline operations ---------------------------------------------------------------
test('overlay: move/trim via shared clip ops; split maps the source range', () => {
  const p = mkProject();
  addSecondVideo(p);
  const ov = addClip(p, 'voverlay', 4, 1);
  const dur = ov.end - ov.start;
  moveClip(p, ov.id, 10);
  assert.equal(ov.start, 10);
  assert.equal(Math.round((ov.end - ov.start) * 1000) / 1000, Math.round(dur * 1000) / 1000);
  resizeClip(p, ov.id, 'end', 20);
  assert.equal(ov.end, 20);
  // Split at midpoint: halves share geometry, source range divides.
  const mid = (ov.start + ov.end) / 2;
  const [a, b] = splitOverlayClipAt(p, ov.id, mid);
  assert.equal(a.end, mid);
  assert.equal(b.start, mid);
  assert.equal(b.sourceIn, (a.sourceIn || 0) + (mid - a.start));
  assert.equal(a.split, true);
  assert.equal(b.split, true);
  assert.equal(a.x, b.x);
  assert.ok(/^o\d+$/.test(a.id) && /^o\d+$/.test(b.id));
  // Playhead split helper reaches overlay clips too.
  const r = splitAtPlayhead(p, mid + 0.5);
  assert.ok(r.overlays.length >= 1);
  assert.equal(r.didSplit, true);
});

test('overlay: extend-to-end, delete and duplicate reuse clip machinery', () => {
  const p = mkProject();
  addSecondVideo(p);
  const ov = addClip(p, 'voverlay', 2, 1);
  const { extended } = extendOverlayToVideoEnd(p, ov.id);
  assert.equal(extended, true);
  assert.ok(ov.end > 4);
  const copy = duplicateClip(p, ov.id);
  assert.equal(copy.type, 'voverlay');
  assert.equal(copy.file, ov.file);
  assert.ok(deleteClip(p, copy.id));
  assert.equal(getClip(p, copy.id), null);
});

// --- Geometry: preview vs export ------------------------------------------------------------------
test('overlay: preview rect follows fractions; export box is even-clamped', () => {
  const ov = { x: 0.65, y: 0.6, w: 0.3, h: 0.1688 };
  const preview = videoOverlayPreviewRect(ov, 640, 360);
  assert.deepEqual(preview, { left: 416, top: 216, width: 192, height: 60.768 });
  const box = videoOverlayExportBox(ov, 1280, 720);
  // w=384, h=round(121.5)=122→even, x=832, y=432.
  assert.deepEqual(box, { x: 832, y: 432, w: 384, h: 122 });
  // Preview and export agree proportionally (1080p export, half-size preview).
  const preview2 = videoOverlayPreviewRect(ov, 960, 540);
  const box2 = videoOverlayExportBox(ov, 1920, 1080);
  assert.equal(Math.round(preview2.width * 2), box2.w);
  assert.equal(Math.round(preview2.height * 2), box2.h);
  // Missing h preserves aspect in export (-2) and preview (16:9).
  const noH = videoOverlayExportBox({ x: 0, y: 0, w: 0.5 }, 1280, 720);
  assert.equal(noH.h, -2);
  assert.equal(noH.w, 640);
});

// --- Server validation -------------------------------------------------------------------------------
test('overlay: V2 validation accepts good entries, rejects bad ones', () => {
  const good = baseSpecV2({
    videoOverlays: [{ file: 1, x: 0.65, y: 0.6, w: 0.3, h: 0.1688, start: 1, end: 5, sourceIn: 0 }]
  });
  const r = validateEditSpec(good);
  assert.equal(r.ok, true);
  assert.equal(r.spec.videoOverlays.length, 1);
  const cases = [
    [{ file: 5, x: 0, y: 0, w: 0.2, start: 0, end: 1 }, /file/],
    [{ file: 0, x: 0.9, y: 0, w: 0.2, start: 0, end: 1 }, /frame width/],
    [{ file: 0, x: 0, y: 0.9, w: 0.2, h: 0.2, start: 0, end: 1 }, /frame height/],
    [{ file: 0, x: 0, y: 0, w: 0, start: 0, end: 1 }, /out of range/],
    [{ file: 0, x: 0, y: 0, w: 0.2, start: 3, end: 30 }, /beyond the timeline/],
    [{ file: 0, x: 0, y: 0, w: 0.2, start: 2, end: 1 }, /after start/],
    [{ file: 0, x: 0, y: 0, w: 0.2, start: 0, end: 1, sourceIn: -1 }, /sourceIn/],
    ['nope', /must be an object/]
  ];
  for (const [entry, pattern] of cases) {
    assert.match(validateEditSpec(baseSpecV2({ videoOverlays: [entry] })).error, pattern, JSON.stringify(entry));
  }
  assert.match(validateEditSpec('x').error || '', /./);
  const capped = Array.from({ length: EDITOR_MAX_VIDEO_OVERLAYS + 1 }, () => ({ file: 0, x: 0, y: 0, w: 0.2, start: 0, end: 1 }));
  assert.match(validateEditSpec(baseSpecV2({ videoOverlays: capped })).error, /At most/);
  assert.match(validateEditSpec(baseSpecV2({ videoOverlays: 'nope' })).error, /must be an array/);
});

test('overlay: legacy V1 specs reject overlays instead of dropping them', () => {
  const v1spec = {
    videoWidth: 1280, videoHeight: 720, trim: { start: 0, end: 2 },
    blurs: [], texts: [], images: [],
    videoOverlays: [{ file: 0, x: 0, y: 0, w: 0.2, start: 0, end: 1 }]
  };
  assert.match(validateEditSpec(v1spec).error, /version 2/);
  const emptyOk = {
    videoWidth: 1280, videoHeight: 720, trim: { start: 0, end: 2 },
    blurs: [], texts: [], images: [], videoOverlays: []
  };
  assert.equal(validateEditSpec(emptyOk).ok, true);
});

// --- FFmpeg graph ------------------------------------------------------------------------------------------
test('overlay: V2 graph trims, offsets, scales and overlays — audio muted', () => {
  const args = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4', '/tmp/v1.mp4'],
    audioPaths: [],
    imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec: baseSpecV2({
      videoOverlays: [{ file: 1, x: 0.65, y: 0.6, w: 0.3, h: 0.1688, start: 2, end: 6, sourceIn: 1 }]
    }),
    fontFile: null,
    media: V2_MEDIA
  }).join(' ');
  // Trim to [1, 1+4], offset onto t=2, scale to 384x122, overlay at 832,432.
  assert.ok(args.includes('[1:v]trim=start=1:end=5'), 'overlay source range trimmed');
  assert.ok(args.includes('setpts=PTS-STARTPTS+2/TB'), 'offset onto the timeline');
  assert.ok(args.includes('scale=384:122'), 'exact-rect scale from geometry');
  assert.ok(args.includes('overlay=832:432:'), 'positioned topmost in frame');
  assert.ok(args.includes("enable='between(t,2,6)'"), 'windowed to the timeline range');
  assert.ok(!args.includes('[1:a]'), 'overlay audio never mapped (muted)');
  // Deterministic: identical specs produce identical graphs.
  const again = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4', '/tmp/v1.mp4'],
    audioPaths: [],
    imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec: baseSpecV2({
      videoOverlays: [{ file: 1, x: 0.65, y: 0.6, w: 0.3, h: 0.1688, start: 2, end: 6, sourceIn: 1 }]
    }),
    fontFile: null,
    media: V2_MEDIA
  }).join(' ');
  assert.equal(args, again);
});

test('overlay: aspect-preserved scale without h; watermark stays topmost', () => {
  const args = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4', '/tmp/v1.mp4'],
    audioPaths: [],
    imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec: baseSpecV2({
      videoOverlays: [{ file: 1, x: 0, y: 0, w: 0.5, start: 0, end: 4 }],
      watermark: { enabled: true, position: 1 }
    }),
    fontFile: '/fonts/Arial.ttf',
    media: V2_MEDIA
  }).join(' ');
  assert.ok(args.includes('scale=640:-2'), 'aspect preserved without h');
  const overlayIdx = args.indexOf('[1:v]trim');
  const wmIdx = args.indexOf("text='Learn with me'");
  assert.ok(overlayIdx !== -1 && wmIdx !== -1 && overlayIdx < wmIdx, 'watermark renders above overlays');
});

// --- UI wiring (static) --------------------------------------------------------------------------------------------
test('overlay: timeline lane, button, layer and inspector hooks exist', async () => {
  const { readFile } = await import('node:fs/promises');
  const ejs = await readFile(new URL('../src/views/admin-video-editor.ejs', import.meta.url), 'utf8');
  assert.ok(ejs.includes('data-testid="video-editor-lane-video-overlay"'), 'timeline lane present');
  assert.ok(ejs.includes('data-testid="video-editor-add-video-overlay"'), 'add button present');
  assert.ok(ejs.includes('data-testid="video-editor-video-overlays"'), 'preview video layer present');
  assert.ok(ejs.includes('ve-clip-voverlay'), 'lane clip color present');
  const client = await readFile(new URL('../src/public/admin-video-editor.js', import.meta.url), 'utf8');
  assert.ok(client.includes('syncVideoOverlays'), 'persistent preview sync present');
  assert.ok(client.includes("addClipAtPlayhead('voverlay')"), 'add-button wiring present');
  assert.ok(client.includes('videoOverlayPreviewRect'), 'preview uses shared geometry');
  assert.ok(client.includes('muted in preview and export'), 'muted behavior stated in UI');
});

// --- UI wiring (static) --------------------------------------------------------------------------------------------
test('overlay: timeline lane, button, layer and inspector hooks exist', async () => {
  const { readFile } = await import('node:fs/promises');
  const ejs = await readFile(new URL('../src/views/admin-video-editor.ejs', import.meta.url), 'utf8');
  assert.ok(ejs.includes('data-testid="video-editor-lane-video-overlay"'), 'timeline lane present');
  assert.ok(ejs.includes('data-testid="video-editor-add-video-overlay"'), 'add button present');
  assert.ok(ejs.includes('data-testid="video-editor-video-overlays"'), 'preview video layer present');
  assert.ok(ejs.includes('ve-clip-voverlay'), 'lane clip color present');
  const client = await readFile(new URL('../src/public/admin-video-editor.js', import.meta.url), 'utf8');
  assert.ok(client.includes('syncVideoOverlays'), 'persistent preview sync present');
  assert.ok(client.includes("addClipAtPlayhead('voverlay')"), 'add-button wiring present');
  assert.ok(client.includes('videoOverlayPreviewRect'), 'preview uses shared geometry');
  assert.ok(client.includes('muted in preview and export'), 'muted behavior stated in UI');
});

// --- Phase 1 webcam-bubble polish: mirror, presets/margin, shadow -------------------------------
test('bubble: new clips default to unmirrored, manual position, no shadow', () => {
  const p = mkProject();
  addSecondVideo(p);
  const ov = addClip(p, 'voverlay', 5);
  assert.equal(ov.mirror, false, 'mirror defaults off');
  assert.equal(ov.preset, null, 'preset defaults to manual x/y');
  assert.equal(ov.margin, VOVERLAY_DEFAULT_MARGIN, 'margin default present');
  assert.equal(ov.shadow, 0, 'shadow defaults off');
  // Unset extras serialize away: legacy output shape preserved exactly.
  const spec = projectToSpecV2(p);
  const entry = spec.videoOverlays.find(o => o.file === ov.file);
  assert.ok(entry, 'overlay serialized');
  assert.ok(!('mirror' in entry), 'mirror omitted when unset');
  assert.ok(!('shadow' in entry), 'shadow omitted when unset');
});

test('bubble: nine presets resolve with margin and stay in frame', () => {
  assert.deepEqual(VOVERLAY_PRESETS, [
    'top-left', 'top-center', 'top-right',
    'middle-left', 'center', 'middle-right',
    'bottom-left', 'bottom-center', 'bottom-right'
  ]);
  assert.equal(normalizeVoverlayPreset('Top_Left'), 'top-left', 'case/separator tolerant');
  assert.equal(normalizeVoverlayPreset('bogus'), null, 'unknown preset rejected');
  assert.equal(normalizeVoverlayPreset(null), null, 'null stays manual');
  assert.equal(normalizeVoverlayMargin('abc'), VOVERLAY_DEFAULT_MARGIN, 'bad margin falls back');
  assert.equal(normalizeVoverlayMargin(-1), 0, 'margin floored');
  assert.equal(normalizeVoverlayMargin(9), 0.25, 'margin capped');
  assert.equal(normalizeVoverlayShadow(2), 1, 'shadow capped');
  assert.equal(normalizeVoverlayShadow(-1), 0, 'shadow floored');
  const w = 0.28;
  const h = 0.21;
  const m = 0.04;
  const cases = {
    'top-left': [m, m],
    'top-center': [(1 - w) / 2, m],
    'top-right': [1 - m - w, m],
    'middle-left': [m, (1 - h) / 2],
    center: [(1 - w) / 2, (1 - h) / 2],
    'middle-right': [1 - m - w, (1 - h) / 2],
    'bottom-left': [m, 1 - m - h],
    'bottom-center': [(1 - w) / 2, 1 - m - h],
    'bottom-right': [1 - m - w, 1 - m - h]
  };
  for (const [preset, [ex, ey]] of Object.entries(cases)) {
    const got = voverlayPresetXY(preset, m, w, h);
    assert.ok(Math.abs(got.x - ex) < 1e-9 && Math.abs(got.y - ey) < 1e-9, `${preset} resolves`);
  }
  assert.equal(voverlayPresetXY('bogus', m, w, h), null, 'bad preset resolves nothing');
  // Oversized bubble + margin still clamps inside the frame.
  const big = voverlayPresetXY('bottom-right', 0.2, 0.9, 0.9);
  assert.ok(big.x >= 0 && big.y >= 0 && big.x + 0.9 <= 1 + 1e-9 && big.y + 0.9 <= 1 + 1e-9, 'clamped in frame');
});

test('bubble: spec carries mirror/shadow only when set; server validates', async () => {
  const { validateSpecV2 } = await import('../src/library/video-editor.js');
  const p = mkProject();
  addSecondVideo(p);
  const ov = addClip(p, 'voverlay', 3, 1);
  ov.mirror = true;
  ov.shadow = 0.5;
  const spec = projectToSpecV2(p);
  const entry = spec.videoOverlays.find(o => o.file === ov.file);
  assert.equal(entry.mirror, true, 'mirror serialized');
  assert.equal(entry.shadow, 0.5, 'shadow serialized');
  assert.equal(validateSpecV2(spec).ok, true, 'server accepts set values');
  // Server rejects out-of-range shadow; absent keys default safely.
  const bad = structuredClone(spec);
  bad.videoOverlays.find(o => o.file === ov.file).shadow = 2;
  assert.match(validateSpecV2(bad).error || '', /shadow/, 'bad shadow rejected');
  const legacy = baseSpecV2({
    videoOverlays: [{ file: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2, start: 0, end: 2 }]
  });
  const checked = validateSpecV2(legacy);
  assert.equal(checked.ok, true, 'legacy spec without new keys validates');
  assert.equal(checked.spec.videoOverlays[0].mirror, false, 'mirror defaults false');
  assert.equal(checked.spec.videoOverlays[0].shadow, 0, 'shadow defaults 0');
});

test('bubble: graph unchanged when unset; hflip/shadow chains appear when set', () => {
  const plainArgs = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4', '/tmp/v1.mp4'],
    audioPaths: [],
    imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec: baseSpecV2({
      videoOverlays: [{ file: 1, x: 0.65, y: 0.6, w: 0.3, h: 0.1688, start: 2, end: 6, sourceIn: 1 }]
    }),
    fontFile: null,
    media: V2_MEDIA
  }).join(' ');
  assert.ok(!plainArgs.includes('hflip'), 'no mirror stage when unset');
  assert.ok(!plainArgs.includes('split=2'), 'no shadow split when unset');
  assert.ok(!plainArgs.includes('gblur'), 'no shadow blur when unset');
  // Legacy mask strings are byte-identical after the shadow refactor.
  const legacyCircle = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4', '/tmp/v1.mp4'],
    audioPaths: [],
    imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec: baseSpecV2({
      videoOverlays: [{ file: 1, x: 0.65, y: 0.6, w: 0.3, h: 0.1688, start: 2, end: 6, sourceIn: 1, shape: 'circle' }]
    }),
    fontFile: null,
    media: V2_MEDIA
  }).join(' ');
  assert.ok(legacyCircle.includes(`geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='if(lte(pow((X-W/2)/(W/2),2)+pow((Y-H/2)/(H/2),2),1),255,0)'`), 'circle mask unchanged');
  const mirrorArgs = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4', '/tmp/v1.mp4'],
    audioPaths: [],
    imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec: baseSpecV2({
      videoOverlays: [{ file: 1, x: 0.65, y: 0.6, w: 0.3, h: 0.1688, start: 2, end: 6, sourceIn: 1, mirror: true }]
    }),
    fontFile: null,
    media: V2_MEDIA
  }).join(' ');
  assert.ok(mirrorArgs.includes('scale=384:122,hflip'), 'mirror flips after scale');
  const shadowArgs = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4', '/tmp/v1.mp4'],
    audioPaths: [],
    imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec: baseSpecV2({
      videoOverlays: [{ file: 1, x: 0.65, y: 0.6, w: 0.3, h: 0.1688, start: 2, end: 6, sourceIn: 1, shadow: 0.5 }]
    }),
    fontFile: null,
    media: V2_MEDIA
  }).join(' ');
  assert.ok(shadowArgs.includes('split=2'), 'shadow duplicates scaled frames');
  assert.ok(shadowArgs.includes('colorchannelmixer=aa=0.5'), 'shadow opacity from setting');
  assert.ok(shadowArgs.includes('gblur=sigma='), 'shadow is blurred');
  // Circle mask text is preserved verbatim for both bubble and shadow.
  const circleArgs = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4', '/tmp/v1.mp4'],
    audioPaths: [],
    imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec: baseSpecV2({
      videoOverlays: [{ file: 1, x: 0.65, y: 0.6, w: 0.3, h: 0.1688, start: 2, end: 6, sourceIn: 1, shape: 'circle', shadow: 0.8 }]
    }),
    fontFile: null,
    media: V2_MEDIA
  }).join(' ');
  const mask = `a='if(lte(pow((X-W/2)/(W/2),2)+pow((Y-H/2)/(H/2),2),1),255,0)'`;
  assert.ok(circleArgs.split(mask).length === 3, 'circle mask reused for bubble + shadow');
});

test('bubble: preview and export position presets identically', () => {
  // Same resolved fractions feed the preview rect (fraction space) and the
  // export box (pixel space): positions must agree.
  for (const preset of VOVERLAY_PRESETS) {
    const r = voverlayPresetXY(preset, 0.03, 0.28, 0.21);
    const preview = videoOverlayPreviewRect({ x: r.x, y: r.y, w: 0.28, h: 0.21 }, 640, 360);
    assert.ok(Math.abs(preview.left / 640 - r.x) < 1e-9, `${preset} preview x matches`);
    assert.ok(Math.abs(preview.top / 360 - r.y) < 1e-9, `${preset} preview y matches`);
    const box = videoOverlayExportBox({ x: r.x, y: r.y, w: 0.28, h: 0.21 }, 1280, 720);
    assert.equal(box.x % 2, 0, `${preset} export x even (libx264-safe)`);
    assert.equal(box.y % 2, 0, `${preset} export y even (libx264-safe)`);
    assert.ok(Math.abs(box.x - Math.round(r.x * 1280)) <= 1, `${preset} export x matches preset`);
    assert.ok(Math.abs(box.y - Math.round(r.y * 720)) <= 1, `${preset} export y matches preset`);
  }
});

test('bubble: inspector and preview wire mirror, preset, margin, shadow', async () => {
  const { readFile } = await import('node:fs/promises');
  const client = await readFile(new URL('../src/public/admin-video-editor.js', import.meta.url), 'utf8');
  assert.ok(client.includes('data-insp="voverlayPreset"'), 'preset select in inspector');
  assert.ok(client.includes('data-insp="voverlayMargin"'), 'margin input in inspector');
  assert.ok(client.includes('data-insp="voverlayMirror"'), 'mirror checkbox in inspector');
  assert.ok(client.includes('data-insp="voverlayShadow"'), 'shadow input in inspector');
  assert.ok(client.includes("scaleX(-1)"), 'preview mirrors the bubble video');
  assert.ok(client.includes('ve-voshadow'), 'preview renders a shadow element');
  assert.ok(client.includes('voverlayPresetXY'), 'preset resolution shared with export math');
});

test('bubble: overlay box is built with vid parented before shadow insert (no NotFoundError)', async () => {
  // Regression: syncVideoOverlays() called box.insertBefore(sh, vid) before
  // box.appendChild(vid). insertBefore with a non-child reference throws
  // NotFoundError, which escaped renderPreview inside playbackTick before
  // the next requestAnimationFrame was scheduled — freezing timeline,
  // timecode and playhead with the button stuck on Pause.
  const { readFile } = await import('node:fs/promises');
  const client = await readFile(new URL('../src/public/admin-video-editor.js', import.meta.url), 'utf8');
  const syncStart = client.indexOf('function syncVideoOverlays()');
  assert.ok(syncStart !== -1, 'syncVideoOverlays present');
  const syncBody = client.slice(syncStart, client.indexOf('function renderPreview()', syncStart));
  const appendAt = syncBody.indexOf('box.appendChild(vid)');
  const insertAt = syncBody.indexOf('box.insertBefore(sh, vid)');
  assert.ok(appendAt !== -1 && insertAt !== -1, 'both box wirings present');
  assert.ok(appendAt < insertAt, 'vid is parented before the shadow is inserted relative to it');
});

test('bubble: insertBefore-before-append throws per DOM contract (why the order matters)', () => {
  // Minimal stub enforcing the real DOM insertBefore contract; replays the
  // pre-fix statement order to prove it throws, and the fixed order to prove
  // it is safe — with shadow enabled and disabled alike (the call ran
  // unconditionally at box creation).
  function stubBox() {
    const children = [];
    return {
      children,
      appendChild(el) { children.push(el); return el; },
      insertBefore(el, ref) {
        if (!children.includes(ref)) {
          const err = new Error(`Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.`);
          err.name = 'NotFoundError';
          throw err;
        }
        children.splice(children.indexOf(ref), 0, el);
        return el;
      }
    };
  }
  for (const shadowOn of [false, true]) {
    void shadowOn;
    // Pre-fix order: insert first -> throws, box never parents, entry lost.
    assert.throws(() => {
      const box = stubBox();
      const vid = { tag: 'video' };
      const sh = { tag: 'shadow' };
      box.insertBefore(sh, vid);
      box.appendChild(vid);
    }, /NotFoundError/, 'pre-fix order throws with or without shadow');
    // Fixed order: parent first -> safe, shadow lands before video.
    const box = stubBox();
    const vid = { tag: 'video' };
    const sh = { tag: 'shadow' };
    box.appendChild(vid);
    box.insertBefore(sh, vid);
    assert.deepEqual(box.children.map(c => c.tag), ['shadow', 'video'], 'shadow paints behind video');
  }
});
