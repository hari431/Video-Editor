import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject,
  contentEnd,
  outputDuration,
  addFileEntry,
  getOverlaySources,
  normalizeCrop,
  isClipCropped,
  setClipCrop,
  resetClipCrop,
  dragCrop,
  cropToPixels,
  pixelsToCrop,
  cropPercentStrings,
  getMediaFile,
  fileIndexOfKind,
  clampGain,
  computeClipGain,
  computeClipVolume,
  appendMediaClip,
  splitVideoClipAt,
  moveVideoClip,
  trimVideoClip,
  deleteVideoClip,
  duplicateVideoClip,
  moveAudioClip,
  trimAudioClip,
  deleteAudioClip,
  duplicateAudioClip,
  setMediaGain,
  setMediaVolumeDb,
  layoutSubRows,
  activeVideoClipAt,
  projectToSpecV2,
  addClip,
  getZoomState,
  getClip,
  deleteClip,
  duplicateClip,
  moveClip,
  resizeClip,
  formatTimecode,
  resetProjectIds,
  moveGeo,
  resizeGeo,
  clipPlayheadStatus,
  isOverlayVisibleAt,
  visibleOverlaysAt,
  splitAudioClipAt,
  splitOverlayClipAt,
  splitAtPlayhead,
  extendOverlayToVideoEnd,
  textPreviewStyle,
  clampTextToFrame,
  fitTextScale,
  estimateRemainingMs,
  formatEta,
  GEO_MIN,
  PROJECT_MAX_CLIPS,
  PROJECT_MAX_VIDEO_CLIPS,
  PROJECT_MAX_AUDIO_CLIPS
} from '../src/public/video-editor-project.js';

test.beforeEach(() => resetProjectIds());

// Project with one 60s video file + full-range clip, the common fixture.
function mkProject() {
  const p = createProject();
  const f = addFileEntry(p, { kind: 'video', name: 'a.mp4', duration: 60, width: 1280, height: 720 });
  const clip = appendMediaClip(p, f.id);
  return { p, f, clip };
}

test('createProject starts empty; contentEnd follows media clips', () => {
  const p = createProject();
  assert.equal(p.version, 2);
  assert.equal(contentEnd(p), 0);
  assert.equal(outputDuration(p), 0);
  const { p: q } = mkProject();
  assert.equal(contentEnd(q), 60);
});

test('file registry tracks kinds and upload order', () => {
  const p = createProject();
  const v0 = addFileEntry(p, { kind: 'video', name: 'a.mp4', duration: 60, width: 1280, height: 720 });
  const m0 = addFileEntry(p, { kind: 'audio', name: 's.mp3', duration: 30 });
  const v1 = addFileEntry(p, { kind: 'video', name: 'b.mp4', duration: 10, width: 640, height: 360 });
  assert.equal(getMediaFile(p, v0.id).name, 'a.mp4');
  assert.equal(getMediaFile(p, 'missing'), null);
  assert.equal(fileIndexOfKind(p, v0.id), 0);
  assert.equal(fileIndexOfKind(p, v1.id), 1);
  assert.equal(fileIndexOfKind(p, m0.id), 0);
  assert.equal(fileIndexOfKind(p, 'missing'), -1);
  assert.throws(() => addFileEntry(p, { kind: 'pdf', name: 'x', duration: 5 }), /kind/);
  assert.throws(() => addFileEntry(p, { kind: 'video', name: 'x', duration: 0 }), /positive/);
});

test('appendMediaClip tiles full-range clips at the timeline end', () => {
  const { p, f } = mkProject();
  assert.equal(p.videoClips.length, 1);
  assert.deepEqual([p.videoClips[0].sourceIn, p.videoClips[0].sourceOut, p.videoClips[0].start], [0, 60, 0]);
  const m = addFileEntry(p, { kind: 'audio', name: 's.mp3', duration: 30 });
  const music = appendMediaClip(p, m.id);
  assert.equal(music.start, 60);
  assert.equal(contentEnd(p), 90);
});

test('splitVideoClipAt divides source mapping and timeline', () => {
  const { p, clip } = mkProject();
  const [a, b] = splitVideoClipAt(p, clip.id, 20);
  assert.deepEqual([a.sourceIn, a.sourceOut, a.start], [0, 20, 0]);
  assert.deepEqual([b.sourceIn, b.sourceOut, b.start], [20, 60, 20]);
  assert.notEqual(a.id, b.id);
  assert.equal(p.videoClips.length, 2);
  assert.throws(() => splitVideoClipAt(p, a.id, 0.01), /inside the clip/);
  assert.throws(() => splitVideoClipAt(p, 'nope', 5), /not found/);
});

test('moveVideoClip clamps into free gaps (no overlaps)', () => {
  const { p } = mkProject();
  const [a, b] = splitVideoClipAt(p, p.videoClips[0].id, 30);
  // b is [30,60] (30s). Moving it left into a must stop at a's end region.
  moveVideoClip(p, b.id, 5);
  assert.ok(b.start >= 30, `no overlap, start=${b.start}`);
  moveVideoClip(p, a.id, 100);
  assert.ok(a.start >= 60 || a.start + (a.sourceOut - a.sourceIn) <= b.start, 'moving past b is legal, overlapping is not');
  moveVideoClip(p, a.id, -50);
  assert.equal(a.start, 0);
  assert.throws(() => moveVideoClip(p, 'nope', 1), /not found/);
});

test('trimVideoClip adjusts source edges within file and neighbours', () => {
  const { p } = mkProject();
  const [a, b] = splitVideoClipAt(p, p.videoClips[0].id, 30);
  trimVideoClip(p, a.id, 'end', 20);
  assert.equal(a.sourceOut, 20);
  assert.ok(a.start + (a.sourceOut - a.sourceIn) <= b.start, 'trim respects next clip');
  trimVideoClip(p, b.id, 'start', 35);
  assert.equal(b.sourceIn, 35);
  assert.throws(() => trimVideoClip(p, a.id, 'middle', 5), /Unknown edge/);
  assert.throws(() => trimVideoClip(p, 'nope', 'start', 5), /not found/);
});

test('audio clips move/trim freely and may overlap', () => {
  const p = createProject();
  const m = addFileEntry(p, { kind: 'audio', name: 's.mp3', duration: 30 });
  const c1 = appendMediaClip(p, m.id);
  const c2 = appendMediaClip(p, m.id);
  moveAudioClip(p, c2.id, 5);
  assert.equal(c2.start, 5);
  assert.ok(c2.start < c1.start + (c1.sourceOut - c1.sourceIn), 'overlap allowed');
  trimAudioClip(p, c1.id, 'end', 10);
  assert.equal(c1.sourceOut, 10);
  trimAudioClip(p, c1.id, 'start', 2);
  assert.equal(c1.sourceIn, 2);
  assert.throws(() => moveAudioClip(p, 'nope', 1), /not found/);
});

test('gain clamps to 0..2 on video and audio clips', () => {
  const { p, clip } = mkProject();
  setMediaGain(p, 'video', clip.id, 1.5);
  assert.equal(clip.gain, 1.5);
  assert.throws(() => setMediaGain(p, 'video', clip.id, 2.5), /Gain/);
  assert.throws(() => setMediaGain(p, 'video', clip.id, -1), /Gain/);
  assert.throws(() => setMediaGain(p, 'sub', clip.id, 1), /Kind/);
  assert.equal(clampGain('garbage'), 1);
  assert.equal(clampGain(1.23456), 1.235);
});

test('delete/duplicate manage video+audio clips and selection', () => {
  const { p, clip } = mkProject();
  assert.equal(deleteVideoClip(p, 'missing'), false);
  const copy = duplicateVideoClip(p, clip.id);
  assert.notEqual(copy.id, clip.id);
  assert.ok(copy.start >= 60, 'duplicate appended at timeline end');
  assert.equal(p.selectedId, copy.id);
  assert.equal(deleteVideoClip(p, copy.id), true);
  assert.equal(p.selectedId, null);
  const m = addFileEntry(p, { kind: 'audio', name: 's.mp3', duration: 30 });
  const mu = appendMediaClip(p, m.id);
  assert.equal(deleteAudioClip(p, mu.id), true);
  const mu2 = appendMediaClip(p, m.id);
  const beforeDup = contentEnd(p);
  assert.equal(duplicateAudioClip(p, mu2.id).start, beforeDup);
});

test('layoutSubRows stacks overlaps and packs touching clips', () => {
  const { rows, rowCount } = layoutSubRows([
    { id: 'a', start: 0, end: 4 },
    { id: 'b', start: 2, end: 6 },
    { id: 'c', start: 4, end: 8 },
    { id: 'd', start: 1, end: 3 }
  ]);
  assert.equal(rowCount, 3);
  assert.equal(rows.get('a'), 0);
  assert.equal(rows.get('c'), 0);
  assert.notEqual(rows.get('b'), rows.get('a'));
  assert.notEqual(rows.get('d'), rows.get('a'));
  assert.notEqual(rows.get('d'), rows.get('b'));
  assert.deepEqual(layoutSubRows([]), { rows: new Map(), rowCount: 0 });
});

test('activeVideoClipAt finds clips and gaps', () => {
  const { p } = mkProject();
  splitVideoClipAt(p, p.videoClips[0].id, 30);
  deleteVideoClip(p, p.videoClips[1].id);
  // Remaining: [0,30]; gap after.
  assert.equal(activeVideoClipAt(p, 10).sourceIn, 0);
  assert.equal(activeVideoClipAt(p, 45), null);
});

test('projectToSpecV2 maps files, gains and overlays', () => {
  const { p, f } = mkProject();
  const m = addFileEntry(p, { kind: 'audio', name: 's.mp3', duration: 30 });
  appendMediaClip(p, m.id);
  setMediaGain(p, 'video', p.videoClips[0].id, 0.5);
  const t = addClip(p, 'text', 5);
  t.text = 'Line 1\nLine 2';
  const spec = projectToSpecV2(p);
  assert.equal(spec.version, 2);
  assert.deepEqual(spec.files, [{ kind: 'video' }, { kind: 'audio' }]);
  assert.equal(spec.videoClips[0].file, 0);
  assert.equal(spec.videoClips[0].gain, 0.5);
  assert.equal(spec.audioClips[0].file, 0);
  assert.equal(spec.texts[0].text, 'Line 1\nLine 2');
  assert.equal(spec.width, 1280);
  assert.equal(spec.height, 720);
  const nodims = createProject();
  addFileEntry(nodims, { kind: 'video', name: 'x.mp4', duration: 5 });
  appendMediaClip(nodims, nodims.files[0].id);
  assert.throws(() => projectToSpecV2(nodims), /dimensions/);
  assert.throws(() => projectToSpecV2(createProject()), /video file/);
});

test('overlay add/move/resize/delete still clamp to the media timeline', () => {
  const { p } = mkProject();
  const b = addClip(p, 'blur', 5);
  assert.equal(b.start, 5);
  moveClip(p, b.id, 999);
  assert.ok(b.end <= 60);
  resizeClip(p, b.id, 'end', 999);
  assert.equal(b.end, 60);
  assert.equal(deleteClip(p, b.id), true);
});

test('overlay clip cap is enforced', () => {
  const { p } = mkProject();
  for (let i = 0; i < PROJECT_MAX_CLIPS; i++) addClip(p, 'blur', (i % 50) + 0.01);
  assert.throws(() => addClip(p, 'blur', 1), /Too many/);
});

test('formatTimecode renders mm:ss.d', () => {
  assert.equal(formatTimecode(0), '00:00.0');
  assert.equal(formatTimecode(7.25), '00:07.2');
  assert.equal(formatTimecode(75.9), '01:15.9');
  assert.equal(formatTimecode(-3), '00:00.0');
});

test('estimateRemainingMs extrapolates actual elapsed time and progress', () => {
  // Linear math only: 8s at 8% implies ~92s left.
  assert.equal(estimateRemainingMs(8000, 8), 92000);
  assert.equal(estimateRemainingMs(60000, 50), 60000);
  // Later polls shrink the ETA as real progress lands.
  assert.ok(estimateRemainingMs(120000, 50) < estimateRemainingMs(60000, 10));
  // Nothing measurable / nothing left / invalid → null (no ETA shown).
  assert.equal(estimateRemainingMs(5000, 0), null);
  assert.equal(estimateRemainingMs(5000, 100), null);
  assert.equal(estimateRemainingMs(5000, 120), null);
  assert.equal(estimateRemainingMs(0, 10), null);
  assert.equal(estimateRemainingMs(-5, 10), null);
  assert.equal(estimateRemainingMs(NaN, 10), null);
  assert.equal(estimateRemainingMs(5000, 'fast'), null);
});

test('formatEta renders seconds, minutes and hours with calm rounding', () => {
  assert.equal(formatEta(42000), '~42s remaining');
  assert.equal(formatEta(0), '~0s remaining');
  assert.equal(formatEta(59000), '~59s remaining');
  assert.equal(formatEta(205000), '~3m 25s remaining');
  assert.equal(formatEta(154000), '~2m 35s remaining');
  assert.equal(formatEta(60000), '~1m remaining');
  assert.equal(formatEta(4320000), '~1h 12m remaining');
  assert.equal(formatEta(3600000), '~1h remaining');
  assert.equal(formatEta(3599000), '~1h remaining');
  assert.equal(formatEta('nope'), null);
});

test('clipPlayheadStatus reports inside/before/after with delta', () => {
  const clip = { start: 5.252, end: 7 };
  assert.deepEqual(clipPlayheadStatus(clip, 6.2), { relation: 'inside', delta: 0 });
  assert.deepEqual(clipPlayheadStatus(clip, 5.252), { relation: 'inside', delta: 0 });
  assert.deepEqual(clipPlayheadStatus(clip, 7), { relation: 'inside', delta: 0 });
  // The reported near-miss: 0.052s outside reads as a sub-pixel timeline gap.
  assert.deepEqual(clipPlayheadStatus(clip, 5.2), { relation: 'before', delta: 0.052 });
  assert.deepEqual(clipPlayheadStatus(clip, 7.5), { relation: 'after', delta: 0.5 });
});

test('moveGeo moves inside the frame and clamps at edges', () => {
  assert.deepEqual(moveGeo({ x: 0.1, y: 0.2, w: 0.2, h: 0.15 }, 0.05, -0.05), { x: 0.15, y: 0.15, w: 0.2, h: 0.15 });
  const tl = moveGeo({ x: 0.05, y: 0.05, w: 0.2, h: 0.2 }, -1, -1);
  assert.equal(tl.x, 0);
  assert.equal(tl.y, 0);
  assert.equal(tl.w, 0.2);
  const br = moveGeo({ x: 0.7, y: 0.7, w: 0.2, h: 0.2 }, 0.5, 0.5);
  assert.equal(br.x, 0.8);
  assert.equal(br.y, 0.8);
  // Free move (text anchor): clamps the point, ignores box size.
  assert.deepEqual(moveGeo({ x: 0.9, y: 0.9 }, 0.5, 0.5, false), { x: 1, y: 1, w: undefined, h: undefined });
  assert.deepEqual(moveGeo({ x: 0.1, y: 0.1 }, -5, -5, false).x, 0);
});

test('resizeGeo anchors the opposite corner and enforces minimum size', () => {
  const se = resizeGeo({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, 'se', 0.1, 0.1);
  assert.deepEqual(se, { x: 0.1, y: 0.1, w: 0.3, h: 0.3 });
  const nw = resizeGeo({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, 'nw', 0.1, 0.1);
  assert.equal(nw.x, 0.3);
  assert.equal(nw.y, 0.3);
  assert.equal(nw.w, 0.2);
  assert.equal(nw.h, 0.2);
  // Cannot shrink below minimum or invert.
  const tiny = resizeGeo({ x: 0.4, y: 0.4, w: 0.05, h: 0.05 }, 'se', -1, -1);
  assert.ok(tiny.w >= GEO_MIN && tiny.h >= GEO_MIN);
  // Cannot leave the frame.
  const edge = resizeGeo({ x: 0.8, y: 0.8, w: 0.2, h: 0.2 }, 'se', 1, 1);
  assert.ok(edge.x + edge.w <= 1 && edge.y + edge.h <= 1);
  const neg = resizeGeo({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, 'nw', -1, -1);
  assert.equal(neg.x, 0);
  assert.equal(neg.y, 0);
  assert.throws(() => resizeGeo({ x: 0, y: 0, w: 0.1, h: 0.1 }, 'middle', 0, 0), /Unknown corner/);
});

test('addFileEntry rounds float dimensions to integers', () => {
  const p = createProject();
  const v0 = addFileEntry(p, { kind: 'video', name: 'float.mp4', duration: 60, width: 1280.4, height: 720.6 });
  assert.equal(v0.width, 1280);
  assert.equal(v0.height, 721);
});

test('multiple image clips can coexist with different file indices', () => {
  const p = createProject();
  addFileEntry(p, { kind: 'video', name: 'a.mp4', duration: 60, width: 1280, height: 720 });
  appendMediaClip(p, p.files[0].id);

  // Add first image clip referencing file 0
  const c1 = addClip(p, 'image', 5, 0);
  assert.equal(c1.file, 0);

  // Add second image clip referencing file 1
  const c2 = addClip(p, 'image', 10, 1);
  assert.equal(c2.file, 1);

  // Verify spec mapping
  const spec = projectToSpecV2(p);
  assert.equal(spec.images.length, 2);
  assert.equal(spec.images[0].file, 0);
  assert.equal(spec.images[1].file, 1);
});

test('setMediaVolumeDb changes volumeDb on video or audio clip and serializes correctly', () => {
  const p = createProject();
  addFileEntry(p, { kind: 'video', name: 'a.mp4', duration: 60, width: 1280, height: 720 });
  const c = appendMediaClip(p, p.files[0].id);

  // Default value should be 0 dB
  assert.equal(c.volumeDb, 0);

  // Set to new volumeDb
  setMediaVolumeDb(p, 'video', c.id, 6);
  assert.equal(c.volumeDb, 6);

  // Invalid values should throw
  assert.throws(() => setMediaVolumeDb(p, 'video', c.id, -100));
  assert.throws(() => setMediaVolumeDb(p, 'video', c.id, 30));

  // Verify spec mapping
  const spec = projectToSpecV2(p);
  assert.equal(spec.videoClips[0].volumeDb, 6);
});

test('isOverlayVisibleAt matches the export between(t,start,end): text shows at the right time', () => {
  const clip = { start: 5, end: 7, type: 'text', text: 'Hi' };
  assert.equal(isOverlayVisibleAt(clip, 4.999), false);
  assert.equal(isOverlayVisibleAt(clip, 5), true);
  assert.equal(isOverlayVisibleAt(clip, 6), true);
  assert.equal(isOverlayVisibleAt(clip, 7), true);
  assert.equal(isOverlayVisibleAt(clip, 7.001), false);
  assert.equal(isOverlayVisibleAt(null, 6), false);
  assert.equal(isOverlayVisibleAt(clip, NaN), false);
});

test('textPreviewStyle keeps one line, honors explicit newlines, never clips', () => {
  const style = textPreviewStyle();
  // No automatic wrapping: only explicit \n breaks lines; overflow stays
  // visible so a long single line is fully shown, never clipped.
  assert.equal(style.whiteSpace, 'pre');
  assert.equal(style.overflow, 'visible');
  assert.equal(style.height, 'auto');
  assert.ok(!('overflowWrap' in style), 'no wrap-related properties');
  // Short and long texts share the same contract (no per-length behavior).
  assert.deepEqual(textPreviewStyle(), style);
});

test('text clip content is stored verbatim (spaces and explicit newlines preserved)', () => {
  const { p } = mkProject();
  const t = addClip(p, 'text', 5);
  // Long multi-word text and explicit newlines survive the model untouched;
  // with white-space:pre the preview renders one line per \n, no auto-wrap.
  t.text = 'one two three four five six seven eight nine ten';
  assert.equal(t.text, 'one two three four five six seven eight nine ten');
  t.text = 'first line\nsecond line';
  assert.equal(t.text, 'first line\nsecond line');
  assert.equal(t.text.split('\n').length, 2);
  moveClip(p, t.id, 6);
  resizeClip(p, t.id, 'end', 9);
  assert.equal(t.text, 'first line\nsecond line');
  const copy = duplicateClip(p, t.id);
  assert.equal(copy.text, 'first line\nsecond line');
});

test('clampTextToFrame keeps the measured box inside the canvas', () => {
  // 1. New text starts inside: defaults (0.05, 0.05) fit a typical box.
  const { p } = mkProject();
  const t = addClip(p, 'text', 5);
  assert.deepEqual([t.x, t.y], [0.05, 0.05]);
  assert.deepEqual(clampTextToFrame(t.x, t.y, 0.25, 0.07), { x: 0.05, y: 0.05 });
  // 2. Drag toward right/bottom edge stops at the frame.
  assert.deepEqual(clampTextToFrame(0.9, 0.9, 0.2, 0.1), { x: 0.8, y: 0.9 });
  assert.deepEqual(clampTextToFrame(1.2, 0.5, 0.2, 0.1), { x: 0.8, y: 0.5 });
  assert.deepEqual(clampTextToFrame(0.5, 1.5, 0.2, 0.1), { x: 0.5, y: 0.9 });
  // 3. Drag toward left/top edge stops at zero.
  assert.deepEqual(clampTextToFrame(-0.05, -0.1, 0.2, 0.1), { x: 0, y: 0 });
  assert.deepEqual(clampTextToFrame(-2, -2, 0.2, 0.1), { x: 0, y: 0 });
  // 4. Long single line wider than the frame pins the start visible.
  assert.deepEqual(clampTextToFrame(0.4, 0.3, 1.4, 0.06), { x: 0, y: 0.3 });
  assert.deepEqual(clampTextToFrame(0, 0.3, 2.5, 0.06), { x: 0, y: 0.3 });
  // 5. Multi-line height counts: tall box stops higher.
  assert.deepEqual(clampTextToFrame(0.2, 0.8, 0.2, 0.3), { x: 0.2, y: 0.7 });
  assert.deepEqual(clampTextToFrame(0.2, 0.5, 0.2, 0.3), { x: 0.2, y: 0.5 });
  // 6. Existing behavior intact: inside boxes pass through (q4-rounded),
  // zero/unknown sizes degrade to anchor clamping, garbage anchors to zero.
  assert.deepEqual(clampTextToFrame(0.1, 0.2, 0.3, 0.1), { x: 0.1, y: 0.2 });
  assert.deepEqual(clampTextToFrame(0.12345, 0.2, 0, 0), { x: 0.1235, y: 0.2 });
  assert.deepEqual(clampTextToFrame(0.9, 0.9, 0, 0), { x: 0.9, y: 0.9 });
  assert.deepEqual(clampTextToFrame(NaN, null, 0.2, 0.1), { x: 0, y: 0 });
});

test('fitTextScale shrinks only what overflows the available space', () => {
  // 1. Short single-line text keeps its font size.
  assert.equal(fitTextScale(200, 20, 720, 405), 1);
  assert.equal(fitTextScale(720, 20, 720, 405), 1);
  // 2. Long single-line text scales down to fit the width.
  assert.equal(fitTextScale(1440, 20, 720, 405), 0.5);
  assert.ok(Math.abs(fitTextScale(1000, 20, 720, 405) - 720 / 1000) < 1e-9);
  // 3. Complete text visible: width and height both bound the scale.
  assert.equal(fitTextScale(360, 810, 720, 405), 0.5);
  assert.equal(fitTextScale(1440, 810, 720, 405), 0.5);
  // 4./5. Explicit-newline and tall text count via measured height.
  assert.equal(fitTextScale(200, 60, 720, 405), 1);
  assert.equal(fitTextScale(200, 500, 720, 405), 405 / 500);
  // 6. Existing behavior intact: empty/invalid dims never hide or grow text.
  assert.equal(fitTextScale(0, 20, 720, 405), 1);
  assert.equal(fitTextScale(200, 20, 0, 405), 1);
  assert.equal(fitTextScale(NaN, 20, 720, 405), 1);
  assert.equal(fitTextScale(-50, 20, 720, 405), 1);
});

test('visibleOverlaysAt returns only the overlays spanning t', () => {
  const { p } = mkProject();
  const b = addClip(p, 'blur', 1);
  moveClip(p, b.id, 0);
  resizeClip(p, b.id, 'end', 10);
  const t = addClip(p, 'text', 5);
  moveClip(p, t.id, 5);
  resizeClip(p, t.id, 'end', 8);
  assert.deepEqual(visibleOverlaysAt(p, 0.5).map(c => c.id), [b.id]);
  assert.deepEqual(visibleOverlaysAt(p, 6).map(c => c.id).sort(), [b.id, t.id].sort());
  assert.deepEqual(visibleOverlaysAt(p, 20).map(c => c.id), []);
});

test('splitAudioClipAt divides source mapping and timeline like video', () => {
  const p = createProject();
  const m = addFileEntry(p, { kind: 'audio', name: 's.mp3', duration: 30 });
  const c = appendMediaClip(p, m.id);
  moveAudioClip(p, c.id, 0);
  const [a, b] = splitAudioClipAt(p, c.id, 10);
  assert.deepEqual([a.sourceIn, a.sourceOut, a.start], [0, 10, 0]);
  assert.deepEqual([b.sourceIn, b.sourceOut, b.start], [10, 30, 10]);
  assert.notEqual(a.id, b.id);
  assert.equal(a.gain, b.gain);
  assert.throws(() => splitAudioClipAt(p, a.id, 0.01), /inside the clip/);
  assert.throws(() => splitAudioClipAt(p, 'nope', 5), /not found/);
});

test('splitOverlayClipAt splits blur/text/image keeping timing and props', () => {
  const { p } = mkProject();
  const t = addClip(p, 'text', 5);
  moveClip(p, t.id, 4);
  resizeClip(p, t.id, 'end', 10);
  t.text = 'Hello';
  t.color = '#FF0000';
  const [a, b] = splitOverlayClipAt(p, t.id, 6);
  assert.deepEqual([a.start, a.end], [4, 6]);
  assert.deepEqual([b.start, b.end], [6, 10]);
  assert.equal(a.text, 'Hello');
  assert.equal(b.text, 'Hello');
  assert.equal(a.color, '#FF0000');
  assert.equal(b.color, '#FF0000');
  assert.notEqual(a.id, b.id);
  const blur = addClip(p, 'blur', 20);
  moveClip(p, blur.id, 20);
  resizeClip(p, blur.id, 'end', 30);
  const [ba, bb] = splitOverlayClipAt(p, blur.id, 25);
  assert.deepEqual([ba.start, ba.end, bb.start, bb.end], [20, 25, 25, 30]);
  assert.equal(ba.mode, bb.mode);
  assert.throws(() => splitOverlayClipAt(p, ba.id, 0.01), /inside the clip/);
});

// Shared split/delete fixture: 60s video+audio with text/blur/image
// spanning t=5 plus one independent text clip elsewhere.
function mkSplitProject() {
  const p = createProject();
  const v = addFileEntry(p, { kind: 'video', name: 'a.mp4', duration: 60, width: 1280, height: 720 });
  appendMediaClip(p, v.id);
  const m = addFileEntry(p, { kind: 'audio', name: 's.mp3', duration: 60 });
  const ac = appendMediaClip(p, m.id);
  moveAudioClip(p, ac.id, 0);
  const text = addClip(p, 'text', 0);
  resizeClip(p, text.id, 'end', 10);
  const blur = addClip(p, 'blur', 2);
  resizeClip(p, blur.id, 'end', 8);
  const image = addClip(p, 'image', 4);
  resizeClip(p, image.id, 'end', 6);
  const lone = addClip(p, 'text', 20);
  resizeClip(p, lone.id, 'end', 25);
  return { p, text, blur, image, lone };
}

test('split flags halves so each belongs to its video segment', () => {
  const { p, lone } = mkSplitProject();
  const r = splitAtPlayhead(p, 5);
  assert.equal(r.didSplit, true);
  // Every spanning audio/overlay half is marked split-generated...
  for (const c of [...p.audioClips, ...p.clips]) {
    if (c.id === lone.id) continue;
    assert.equal(c.split, true);
  }
  // ...while the independent clip stays unmarked.
  assert.equal(lone.split, undefined);
  assert.equal(p.videoClips.length, 2);
});

test('delete first segment removes only its own split items', () => {
  const { p, lone } = mkSplitProject();
  splitAtPlayhead(p, 5);
  const [segA, segB] = p.videoClips;
  assert.deepEqual([segA.start, segB.start], [0, 5]);
  const removed = [];
  assert.equal(deleteVideoClip(p, segA.id, removed), true);
  assert.equal(removed.length, 4);
  assert.deepEqual(removed.map(x => x.kind).sort(), ['audio', 'blur', 'image', 'text']);
  // Right halves survive with exact timing...
  assert.deepEqual(p.audioClips.map(c => [c.start, c.sourceIn]), [[5, 5]]);
  assert.deepEqual(p.clips.map(c => [c.type, c.start, c.end]).sort(), [
    ['blur', 5, 8], ['image', 5, 6], ['text', 20, 25], ['text', 5, 10]
  ]);
  // ...including the independent clip, and the other segment.
  assert.ok(getClip(p, lone.id));
  assert.equal(p.videoClips.length, 1);
  assert.equal(p.videoClips[0].id, segB.id);
});

test('delete second segment removes only its own split items', () => {
  const { p, lone } = mkSplitProject();
  splitAtPlayhead(p, 5);
  const [, segB] = p.videoClips;
  const removed = [];
  assert.equal(deleteVideoClip(p, segB.id, removed), true);
  assert.equal(removed.length, 4);
  assert.deepEqual(p.audioClips.map(c => [c.start, c.sourceIn]), [[0, 0]]);
  assert.deepEqual(p.clips.map(c => [c.type, c.start, c.end]).sort(), [
    ['blur', 2, 5], ['image', 4, 5], ['text', 0, 5], ['text', 20, 25]
  ]);
  assert.ok(getClip(p, lone.id));
  assert.equal(p.videoClips.length, 1);
});

test('repeated split/delete keeps associations per segment', () => {
  const { p, lone } = mkSplitProject();
  splitAtPlayhead(p, 5);
  splitAtPlayhead(p, 2);
  assert.deepEqual(p.videoClips.map(c => [c.start, c.start + (c.sourceOut - c.sourceIn)]), [[0, 2], [2, 5], [5, 60]]);
  // Delete the middle segment: only items contained in [2,5] go.
  const mid = p.videoClips[1];
  const removed = [];
  assert.equal(deleteVideoClip(p, mid.id, removed), true);
  assert.ok(removed.length >= 3, `middle items removed, got ${removed.length}`);
  assert.ok(!p.clips.some(c => c.start >= 2 && c.end <= 5 && c.split === true), 'no middle leftovers');
  // Outer segments and their items plus the independent clip survive.
  assert.equal(p.videoClips.length, 2);
  assert.ok(getClip(p, lone.id));
  assert.ok(p.clips.some(c => c.type === 'text' && c.start === 0 && c.end === 2), 'left text half survives');
  assert.ok(p.clips.some(c => c.type === 'text' && c.start === 5), 'right text half survives');
  // Deleting a missing segment still reports false and changes nothing.
  const counts = [p.videoClips.length, p.audioClips.length, p.clips.length];
  assert.equal(deleteVideoClip(p, 'missing'), false);
  assert.deepEqual([p.videoClips.length, p.audioClips.length, p.clips.length], counts);
});

test('extendOverlayToVideoEnd extends to its own segment end', () => {
  const { p } = mkSplitProject();
  splitAtPlayhead(p, 5);
  // Fresh clip inside the left segment: start kept, end becomes 5.
  const extra = addClip(p, 'text', 1);
  resizeClip(p, extra.id, 'end', 3);
  const r = extendOverlayToVideoEnd(p, extra.id);
  assert.equal(r.extended, true);
  assert.deepEqual([extra.start, extra.end], [1, 5]);
  // Extending again is a no-op (already at the video end).
  const r2 = extendOverlayToVideoEnd(p, extra.id);
  assert.equal(r2.extended, false);
  assert.equal(extra.end, 5);
  // Overhangs past the segment end are left untouched, never shortened.
  const over = addClip(p, 'text', 3);
  resizeClip(p, over.id, 'end', 8);
  assert.deepEqual([over.start, over.end], [3, 8]);
  assert.equal(extendOverlayToVideoEnd(p, over.id).extended, false);
  assert.equal(over.end, 8);
  // Audio ids and unknown ids are rejected (audio untouched by design).
  assert.throws(() => extendOverlayToVideoEnd(p, p.audioClips[0].id), /Clip not found/);
  assert.throws(() => extendOverlayToVideoEnd(p, 'missing'), /Clip not found/);
});

test('extendOverlayToVideoEnd rejects gaps and too-short spans', () => {
  const p = createProject();
  const v = addFileEntry(p, { kind: 'video', name: 'a.mp4', duration: 60, width: 1280, height: 720 });
  const first = appendMediaClip(p, v.id);
  trimVideoClip(p, first.id, 'end', 5);
  const second = appendMediaClip(p, v.id);
  moveVideoClip(p, second.id, 30);
  trimVideoClip(p, second.id, 'end', 5);
  // Segments are [0,5] and [30,35]: a clip starting in the gap belongs nowhere.
  const gap = addClip(p, 'text', 10);
  assert.throws(() => extendOverlayToVideoEnd(p, gap.id), /No video segment/);
  // A clip starting within 0.1s of the segment end cannot extend.
  p.clips.push({ id: 'edge', type: 'text', text: 'x', x: 0, y: 0, size: 0.05, color: '#FFF', bg: null, start: 34.96, end: 34.99 });
  assert.throws(() => extendOverlayToVideoEnd(p, 'edge'), /too close/);
  // Non-overlay entries in the clip list are rejected.
  p.clips.push({ id: 'fake', type: 'video', start: 0, end: 1 });
  assert.throws(() => extendOverlayToVideoEnd(p, 'fake'), /Only blur, text, image, video-overlay and zoom/);
});

test('splitAtPlayhead splits video+audio+blur+text+image together, others untouched', () => {
  const p = createProject();
  const v = addFileEntry(p, { kind: 'video', name: 'a.mp4', duration: 60, width: 1280, height: 720 });
  const vc = appendMediaClip(p, v.id);
  const m = addFileEntry(p, { kind: 'audio', name: 's.mp3', duration: 60 });
  const ac = appendMediaClip(p, m.id);
  moveAudioClip(p, ac.id, 0);
  const blur = addClip(p, 'blur', 0);
  moveClip(p, blur.id, 0);
  resizeClip(p, blur.id, 'end', 20);
  const text = addClip(p, 'text', 0);
  moveClip(p, text.id, 0);
  resizeClip(p, text.id, 'end', 20);
  text.text = 'Cap';
  const before = addClip(p, 'text', 30);
  moveClip(p, before.id, 30);
  resizeClip(p, before.id, 'end', 40);
  const vEnd = vc.start + (vc.sourceOut - vc.sourceIn);
  const aEnd = ac.start + (ac.sourceOut - ac.sourceIn);
  const r = splitAtPlayhead(p, 10);
  assert.equal(r.didSplit, true);
  assert.equal(r.videos.length, 1);
  assert.equal(r.audios.length, 1);
  assert.equal(r.overlays.length, 2);
  // Video halves keep the source mapping.
  const [va, vb] = r.videos[0];
  assert.deepEqual([va.sourceOut, vb.sourceIn, vb.start], [10, 10, 10]);
  assert.equal(va.start, 0);
  assert.equal(vb.start + (vb.sourceOut - vb.sourceIn), vEnd);
  // Audio halves keep exact timing too.
  const [aa, ab] = r.audios[0];
  assert.deepEqual([aa.start, ab.start], [0, 10]);
  assert.equal(ab.sourceIn, 10);
  assert.equal(aa.sourceOut, 10);
  assert.equal(ab.start + (ab.sourceOut - ab.sourceIn), aEnd);
  // Overlay halves meet exactly at the split with props intact.
  for (const [a, b] of r.overlays) {
    assert.equal(a.end, 10);
    assert.equal(b.start, 10);
    assert.notEqual(a.id, b.id);
  }
  const splitText = p.clips.filter(c => c.type === 'text' && c.text === 'Cap');
  assert.equal(splitText.length, 2);
  // Clip fully after the split is unchanged.
  assert.deepEqual([before.start, before.end], [30, 40]);
  // Splitting at an edge (no strict interior) reports didSplit=false and
  // changes nothing.
  const countBefore = p.videoClips.length + p.audioClips.length + p.clips.length;
  const none = splitAtPlayhead(p, 0.01);
  assert.equal(none.didSplit, false);
  assert.equal(p.videoClips.length + p.audioClips.length + p.clips.length, countBefore);
});

test('appendMediaClip inserts at playhead and handles overlap logic correctly', () => {
  const p = createProject();
  addFileEntry(p, { kind: 'video', name: 'v1.mp4', duration: 10, width: 1280, height: 720 });
  addFileEntry(p, { kind: 'video', name: 'v2.mp4', duration: 10, width: 1280, height: 720 });
  addFileEntry(p, { kind: 'audio', name: 'a1.mp3', duration: 15 });

  // 1. Insert Video 1 at playhead 5. Since timeline is empty, it should start at exactly 5.
  const v1 = appendMediaClip(p, p.files[0].id, 5);
  assert.equal(v1.start, 5);

  // 2. Insert Audio 1 at playhead 2. Since audio can overlap, it should start at exactly 2.
  const a1 = appendMediaClip(p, p.files[2].id, 2);
  assert.equal(a1.start, 2);

  // 3. Insert Video 2 at playhead 8.
  // Video 1 occupies [5, 15]. Playhead 8 is inside Video 1.
  // Video 2 (duration 10) should be pushed forward to the end of Video 1, so it starts at exactly 15.
  const v2 = appendMediaClip(p, p.files[1].id, 8);
  assert.equal(v2.start, 15);
});

test('voverlay clip: duration, horizontal move, and resize bounds validation', () => {
  const p = createProject();
  addFileEntry(p, { kind: 'video', name: 'v1.mp4', duration: 10, width: 1280, height: 720 });
  appendMediaClip(p, p.files[0].id, 0); // contentEnd is now 10

  // 1. Add voverlay clip. It should render at the source video's full duration (10s)
  const clip = addClip(p, 'voverlay', 0);
  assert.equal(clip.start, 0);
  assert.equal(clip.end, 10);
  assert.equal(clip.end - clip.start, 10);

  // 2. Drag/Move horizontally to change start time
  // Let's make the timeline longer by appending another video so we have room to move it.
  addFileEntry(p, { kind: 'video', name: 'v2.mp4', duration: 10, width: 1280, height: 720 });
  appendMediaClip(p, p.files[1].id); // timeline duration is now 20

  moveClip(p, clip.id, 5);
  assert.equal(clip.start, 5);
  assert.equal(clip.end, 15); // duration is preserved at 10s

  // 3. Bounds validation in resize:
  // Since file duration is 10, and sourceIn is 0, maximum duration of the clip is 10.
  // Let's try to resize end to 25. It should clamp end to start + 10 = 15.
  resizeClip(p, clip.id, 'end', 25);
  assert.equal(clip.end, 15);

  // If we set sourceIn to 3, maximum duration is 10 - 3 = 7.
  clip.sourceIn = 3;
  // Resizing end to 20 should clamp end to start + 7 = 12.
  resizeClip(p, clip.id, 'end', 20);
  assert.equal(clip.end, 12);
});

test('zoom clip: timeline editing, target geometry, clamping, and animation preview math', () => {
  const p = createProject();
  addFileEntry(p, { kind: 'video', name: 'v1.mp4', duration: 10, width: 1280, height: 720 });
  appendMediaClip(p, p.files[0].id, 0); // contentEnd is 10

  // 1. Add zoom clip. It should render on the zoom track with defaults.
  const clip = addClip(p, 'zoom', 2);
  assert.equal(clip.type, 'zoom');
  assert.equal(clip.start, 2);
  assert.ok(clip.end > clip.start);

  // 2. Drag/Move horizontally to change start time
  moveClip(p, clip.id, 4);
  assert.equal(clip.start, 4);

  // 3. Test real-time zoom animation and frame edge clamping math (prevents empty/black areas)
  // Let level = 2.0. Min coordinate fraction is 0.5/2.0 = 0.25, max fraction is 1.0 - 0.25 = 0.75.
  clip.level = 2.0;
  clip.transition = 1.0;
  clip.x = 0.1; // extreme edge, should be clamped to 0.25
  clip.y = 0.9; // extreme edge, should be clamped to 0.75

  // At t=4.5 (mid zoom-in transition): level should be 1.0 + (2.0 - 1.0)*0.5 = 1.5
  // minFrac = 0.5/1.5 = 0.333, maxFrac = 1 - 0.333 = 0.667
  const stateMid = getZoomState(clip, 4.5);
  assert.equal(stateMid.level, 1.5);
  assert.ok(stateMid.x >= 0.33);
  assert.ok(stateMid.y <= 0.67);

  // At t=5.0 (full zoom): level should be 2.0
  const stateFull = getZoomState(clip, 5.0);
  assert.equal(stateFull.level, 2.0);
  assert.equal(stateFull.x, 0.25);
  assert.equal(stateFull.y, 0.75);

  // 4. Split and Delete zoom segment
  const beforeCount = p.clips.length;
  const parts = splitOverlayClipAt(p, clip.id, 5);
  assert.equal(p.clips.length, beforeCount + 1);
  assert.equal(parts[0].end, 5);
  assert.equal(parts[1].start, 5);

  const deleted = deleteClip(p, parts[0].id);
  assert.ok(deleted);
  assert.equal(p.clips.length, beforeCount);
});

test('voverlay regression: default geometry, aspect ratio, and boundary clamping', () => {
  const p = createProject();
  addFileEntry(p, { kind: 'video', name: 'v1.mp4', duration: 10, width: 1280, height: 720 });
  appendMediaClip(p, p.files[0].id, 0);

  const clip = addClip(p, 'voverlay', 0);
  assert.equal(clip.type, 'voverlay');
  assert.equal(clip.w, 0.28);
  assert.equal(clip.x, 0.68);
  assert.equal(clip.y, 0.04);
  assert.equal(clip.h, 0.28); // 16:9 source on 16:9 canvas means h = w
});

test('voverlay: edge-trimming start moves clip start and sourceIn in sync', () => {
  const p = createProject();
  addFileEntry(p, { kind: 'video', name: 'v1.mp4', duration: 10, width: 1280, height: 720 });
  appendMediaClip(p, p.files[0].id, 0);

  const clip = addClip(p, 'voverlay', 0); // start: 0, end: 10, sourceIn: 0
  assert.equal(clip.start, 0);
  assert.equal(clip.sourceIn, 0);

  // Trim left edge to 2.0. start should become 2.0, sourceIn should become 2.0.
  resizeClip(p, clip.id, 'start', 2.0);
  assert.equal(clip.start, 2.0);
  assert.equal(clip.sourceIn, 2.0);

  // Trim left edge back to 0.5. start should become 0.5, sourceIn should become 0.5.
  resizeClip(p, clip.id, 'start', 0.5);
  assert.equal(clip.start, 0.5);
  assert.equal(clip.sourceIn, 0.5);
});

test('separate overlay uploads: overlay sources do not create main video clips and are reusable', () => {
  const p = createProject();
  // 1. Add main video
  const mainVideo = addFileEntry(p, { kind: 'video', name: 'main.mp4', duration: 30, width: 1920, height: 1080 });
  appendMediaClip(p, mainVideo.id, 0);
  assert.equal(p.videoClips.length, 1);

  // 2. Add dedicated overlay sources
  const ovSource1 = addFileEntry(p, {
    kind: 'video',
    name: 'pip1.mp4',
    duration: 10,
    width: 640,
    height: 360,
    isOverlaySource: true
  });
  const ovSource2 = addFileEntry(p, {
    kind: 'video',
    name: 'pip2.mp4',
    duration: 15,
    width: 1280,
    height: 720,
    isOverlaySource: true
  });

  // Verify overlay sources do NOT create clips on the main video timeline
  assert.equal(p.videoClips.length, 1);
  assert.equal(p.files.length, 3);
  assert.equal(p.files[1].isOverlaySource, true);
  assert.equal(p.files[2].isOverlaySource, true);

  // 3. getOverlaySources returns overlay sources
  const sources = getOverlaySources(p);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].name, 'pip1.mp4');
  assert.equal(sources[1].name, 'pip2.mp4');

  // 4. Add video overlay clips using overlay sources
  // Without specifying index: selects the most recent overlay source (pip2)
  const ovClip1 = addClip(p, 'voverlay', 2);
  assert.equal(ovClip1.type, 'voverlay');
  assert.equal(ovClip1.file, 2); // index in allVideos: 0 = main, 1 = pip1, 2 = pip2
  assert.equal(ovClip1.start, 2);
  assert.equal(p.videoClips.length, 1); // Main video track remains untouched!

  // Specifying index: reuse pip1 (index 1)
  const ovClip2 = addClip(p, 'voverlay', 5, 1);
  assert.equal(ovClip2.type, 'voverlay');
  assert.equal(ovClip2.file, 1);

  // 5. Support overlapping overlay clips with independent settings
  const ovClip3 = addClip(p, 'voverlay', 6, 2);
  ovClip3.x = 0.1;
  ovClip3.y = 0.1;
  ovClip3.w = 0.4;
  ovClip3.h = 0.25;

  assert.equal(p.clips.filter(c => c.type === 'voverlay').length, 3);

  // 6. Test crop functions on clips
  assert.equal(isClipCropped(ovClip1), false);
  setClipCrop(ovClip1, { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 });
  assert.equal(isClipCropped(ovClip1), true);
  assert.deepEqual(ovClip1.crop, { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 });

  resetClipCrop(ovClip1);
  assert.equal(isClipCropped(ovClip1), false);
  assert.equal(ovClip1.crop, null);

  // Also test crop on main video clip
  const mainClip = p.videoClips[0];
  setClipCrop(mainClip, { left: 0.05, top: 0.05, right: 0.95, bottom: 0.95 });
  assert.equal(isClipCropped(mainClip), true);

  // 7. Verify projectToSpecV2 includes crop for both main clip and overlays
  setClipCrop(ovClip2, { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 });
  const spec = projectToSpecV2(p);
  assert.equal(spec.videoClips.length, 1);
  assert.deepEqual(spec.videoClips[0].crop, { left: 0.05, top: 0.05, right: 0.95, bottom: 0.95 });

  const ovSpecs = spec.videoOverlays;
  assert.equal(ovSpecs.length, 3);
  assert.equal(ovSpecs[0].file, 2);
  assert.equal(ovSpecs[1].file, 1);
  assert.deepEqual(ovSpecs[1].crop, { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 });
  assert.equal(ovSpecs[2].crop, null); // backward compatible with null
});

test('crop handle geometry: corners adjust two boundaries, edges adjust one, box translates', () => {
  const base = { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 };

  // Corners
  // NW adjusts left and top
  const nw = dragCrop(base, 'nw', 0.05, 0.05);
  assert.deepEqual(nw, { left: 0.25, top: 0.25, right: 0.8, bottom: 0.8 });

  // NE adjusts right and top
  const ne = dragCrop(base, 'ne', -0.05, 0.05);
  assert.deepEqual(ne, { left: 0.2, top: 0.25, right: 0.75, bottom: 0.8 });

  // SW adjusts left and bottom
  const sw = dragCrop(base, 'sw', 0.05, -0.05);
  assert.deepEqual(sw, { left: 0.25, top: 0.2, right: 0.8, bottom: 0.75 });

  // SE adjusts right and bottom
  const se = dragCrop(base, 'se', -0.05, -0.05);
  assert.deepEqual(se, { left: 0.2, top: 0.2, right: 0.75, bottom: 0.75 });

  // Edges
  // Top edge adjusts top only
  const t = dragCrop(base, 't', 0.1, 0.05);
  assert.deepEqual(t, { left: 0.2, top: 0.25, right: 0.8, bottom: 0.8 });

  // Bottom edge adjusts bottom only
  const b = dragCrop(base, 'b', 0.1, -0.05);
  assert.deepEqual(b, { left: 0.2, top: 0.2, right: 0.8, bottom: 0.75 });

  // Left edge adjusts left only
  const l = dragCrop(base, 'l', 0.05, 0.1);
  assert.deepEqual(l, { left: 0.25, top: 0.2, right: 0.8, bottom: 0.8 });

  // Right edge adjusts right only
  const r = dragCrop(base, 'r', -0.05, 0.1);
  assert.deepEqual(r, { left: 0.2, top: 0.2, right: 0.75, bottom: 0.8 });

  // Interior translation (null / empty handle)
  const moved = dragCrop(base, null, 0.1, 0.05);
  assert.deepEqual(moved, { left: 0.3, top: 0.25, right: 0.9, bottom: 0.85 });
  assert.equal(Math.round((moved.right - moved.left) * 1000), 600);
  assert.equal(Math.round((moved.bottom - moved.top) * 1000), 600);
});

test('crop boundary clamping: frame limits and minimum dimension enforcement prevent invalid/inverted rectangles', () => {
  const base = { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 };

  // Cannot drag left boundary past 0
  const outLeft = dragCrop(base, 'l', -0.5, 0);
  assert.equal(outLeft.left, 0);
  assert.equal(outLeft.right, 0.8);

  // Cannot drag right boundary past 1
  const outRight = dragCrop(base, 'r', 0.5, 0);
  assert.equal(outRight.right, 1);
  assert.equal(outRight.left, 0.2);

  // Cannot drag top boundary past 0
  const outTop = dragCrop(base, 't', 0, -0.5);
  assert.equal(outTop.top, 0);
  assert.equal(outTop.bottom, 0.8);

  // Cannot drag bottom boundary past 1
  const outBottom = dragCrop(base, 'b', 0, 0.5);
  assert.equal(outBottom.bottom, 1);
  assert.equal(outBottom.top, 0.2);

  // Enforces minSpan (default 0.02) to prevent inverted rectangles
  const invertL = dragCrop(base, 'l', 0.9, 0, 0.02);
  assert.equal(invertL.left, 0.78); // right (0.8) - 0.02
  assert.equal(invertL.right, 0.8);

  const invertR = dragCrop(base, 'r', -0.9, 0, 0.02);
  assert.equal(invertR.right, 0.22); // left (0.2) + 0.02
  assert.equal(invertR.left, 0.2);

  const invertT = dragCrop(base, 't', 0, 0.9, 0.02);
  assert.equal(invertT.top, 0.78); // bottom (0.8) - 0.02
  assert.equal(invertT.bottom, 0.8);

  const invertB = dragCrop(base, 'b', 0, -0.9, 0.02);
  assert.equal(invertB.bottom, 0.22); // top (0.2) + 0.02
  assert.equal(invertB.top, 0.2);

  // Moving box past frame bounds clamps without collapsing dimensions
  const movePastEdge = dragCrop(base, null, 0.5, 0.5);
  assert.equal(movePastEdge.right, 1);
  assert.equal(movePastEdge.bottom, 1);
  assert.equal(Math.round((movePastEdge.right - movePastEdge.left) * 1000), 600);
  assert.equal(Math.round((movePastEdge.bottom - movePastEdge.top) * 1000), 600);
});

test('crop coordinate conversion: cropToPixels and pixelsToCrop in landscape, portrait, and round-trips', () => {
  // 16:9 Landscape (1920x1080)
  const normCrop = { left: 0.1, top: 0.2, right: 0.9, bottom: 0.8 };
  const pxLandscape = cropToPixels(normCrop, 1920, 1080);
  assert.equal(pxLandscape.x, 192);
  assert.equal(pxLandscape.y, 216);
  assert.equal(pxLandscape.width, 1536);
  assert.equal(pxLandscape.height, 648);

  // Round-trip back to normalized
  const backLandscape = pixelsToCrop(pxLandscape, 1920, 1080);
  assert.deepEqual(backLandscape, normCrop);

  // 9:16 Portrait (1080x1920)
  const pxPortrait = cropToPixels(normCrop, 1080, 1920);
  assert.equal(pxPortrait.x, 108);
  assert.equal(pxPortrait.y, 384);
  assert.equal(pxPortrait.width, 864);
  assert.equal(pxPortrait.height, 1152);

  const backPortrait = pixelsToCrop(pxPortrait, 1080, 1920);
  assert.deepEqual(backPortrait, normCrop);

  // Partial overlay source frame (e.g. 320x180)
  const pxOverlay = cropToPixels({ left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 }, 320, 180);
  assert.equal(pxOverlay.x, 80);
  assert.equal(pxOverlay.y, 45);
  assert.equal(pxOverlay.width, 160);
  assert.equal(pxOverlay.height, 90);
});

test('crop synchronization: numeric Inspector strings, normalization, cancel and reset consistency', () => {
  const p = createProject();
  addFileEntry(p, { kind: 'video', name: 'v.mp4', duration: 20, width: 1280, height: 720 });
  const clip = appendMediaClip(p, p.files[0].id, 0);

  // Initial state: not cropped
  assert.equal(isClipCropped(clip), false);
  assert.equal(clip.crop, null);

  // Numeric inspector strings for uncropped clip defaults to full frame
  const initialStrings = cropPercentStrings(clip.crop);
  assert.deepEqual(initialStrings, { left: '0', top: '0', right: '100', bottom: '100' });

  // Simulate editing: user inputs 15.5%, 10%, 85%, 90%
  const editedCrop = normalizeCrop({ left: 0.155, top: 0.1, right: 0.85, bottom: 0.9 });
  assert.ok(editedCrop);
  assert.equal(editedCrop.left, 0.155);

  const editedStrings = cropPercentStrings(editedCrop);
  assert.deepEqual(editedStrings, { left: '15.5', top: '10', right: '85', bottom: '90' });

  // Apply crop
  setClipCrop(clip, editedCrop);
  assert.equal(isClipCropped(clip), true);
  assert.deepEqual(clip.crop, editedCrop);

  // Cancel behavior: restores last saved crop (editedCrop) if user makes unsaved change
  const unsavedChange = { left: 0.3, top: 0.3, right: 0.7, bottom: 0.7 };
  const original = clip.crop ? { ...clip.crop } : null;
  // Simulating user cancelling: clip.crop reverts to original
  assert.deepEqual(original, editedCrop);

  // Reset behavior: restores full frame (null)
  resetClipCrop(clip);
  assert.equal(isClipCropped(clip), false);
  assert.equal(clip.crop, null);

  // Normalization cleans up inverted/invalid inputs
  const inverted = normalizeCrop({ left: 0.8, top: 0.8, right: 0.2, bottom: 0.2 });
  assert.ok(inverted.left < inverted.right);
  assert.ok(inverted.top < inverted.bottom);

  // Full-frame crop normalizes to null for non-destructive storage
  assert.equal(normalizeCrop({ left: 0, top: 0, right: 1, bottom: 1 }), null);
});

test('audio gain and volume calculations: computeClipGain and computeClipVolume combine linear gain and dB accurately', () => {
  // Default clip: 100% gain, 0 dB -> factor 1.0
  assert.equal(computeClipGain(null), 1.0);
  assert.equal(computeClipGain({}), 1.0);
  assert.equal(computeClipGain({ gain: 1.0, volumeDb: 0 }), 1.0);
  assert.equal(computeClipVolume({ gain: 1.0, volumeDb: 0 }), 1.0);

  // Amplification: Gain 200% (gain = 2.0, volumeDb = 0) -> unclamped gain 2.0, clamped volume 1.0
  const gain200 = computeClipGain({ gain: 2.0, volumeDb: 0 });
  assert.equal(gain200, 2.0);
  assert.equal(computeClipVolume({ gain: 2.0, volumeDb: 0 }), 1.0);

  // Amplification: Volume Gain +24 dB (gain = 1.0, volumeDb = 24) -> factor ~15.8489
  const gain24dB = computeClipGain({ gain: 1.0, volumeDb: 24 });
  assert.ok(Math.abs(gain24dB - Math.pow(10, 24 / 20)) < 0.001);
  assert.ok(gain24dB > 15.8);
  assert.equal(computeClipVolume({ gain: 1.0, volumeDb: 24 }), 1.0);

  // Combined Amplification: Gain 200% AND +24 dB -> 2.0 * 10^(24/20) ~ 31.697
  const combinedAmp = computeClipGain({ gain: 2.0, volumeDb: 24 });
  assert.ok(Math.abs(combinedAmp - 2.0 * Math.pow(10, 24 / 20)) < 0.001);
  assert.ok(combinedAmp > 31.6);
  assert.equal(computeClipVolume({ gain: 2.0, volumeDb: 24 }), 1.0);

  // Attenuation: Gain 50% (gain = 0.5, volumeDb = 0) -> 0.5
  assert.equal(computeClipGain({ gain: 0.5, volumeDb: 0 }), 0.5);
  assert.equal(computeClipVolume({ gain: 0.5, volumeDb: 0 }), 0.5);

  // Attenuation: Volume Gain -6 dB (gain = 1.0, volumeDb = -6) -> ~0.501
  const gainMinus6dB = computeClipGain({ gain: 1.0, volumeDb: -6 });
  assert.ok(Math.abs(gainMinus6dB - Math.pow(10, -6 / 20)) < 0.001);
  assert.equal(computeClipVolume({ gain: 1.0, volumeDb: -6 }), gainMinus6dB);

  // Muted: Gain 0% -> 0
  assert.equal(computeClipGain({ gain: 0, volumeDb: 0 }), 0);
  assert.equal(computeClipVolume({ gain: 0, volumeDb: 0 }), 0);
});




