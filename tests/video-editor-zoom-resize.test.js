import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  createProject,
  addFileEntry,
  appendMediaClip,
  addClip,
  resizeGeo,
  GEO_MIN,
  zoomPreviewRect,
  zoomFromPreviewRect,
  zoomDrawRect,
  zoomResizeDelta,
  ZOOM_LEVEL_MIN,
  ZOOM_LEVEL_MAX,
  getZoomState,
  projectToSpecV2
} from '../src/public/video-editor-project.js';

function makeZoomProject(level = 1.5, x = 0.5, y = 0.5) {
  const project = createProject();
  addFileEntry(project, { kind: 'video', name: 'v1.mp4', duration: 30, width: 1280, height: 720 });
  appendMediaClip(project, project.files[0].id, 0);
  const clip = addClip(project, 'zoom', 2);
  clip.level = level;
  clip.x = x;
  clip.y = y;
  clip.transition = 0.5;
  return { project, clip };
}

// Executes the SAME logic as the on-canvas zoom resize branch in
// admin-video-editor.js onBoxDown: capture {level,x,y} at pointerdown,
// project pointer travel (px) onto the handle ray, scale about the center.
const LAYER_W = 640;
const LAYER_H = 360;
function simulateZoomHandleDrag(clip, handle, dxPx, dyPx, layerW = LAYER_W, layerH = LAYER_H) {
  const start = { level: clip.level, x: clip.x, y: clip.y };
  const z = zoomResizeDelta(start, handle, dxPx, dyPx, layerW, layerH);
  assert.ok(z, `handle [${handle}] delta resolves`);
  clip.level = z.level;
  clip.x = z.x;
  clip.y = z.y;
  return z;
}

test('zoom on-canvas resize: all 8 handles execute without runtime errors and mutate level/center', () => {
  const handles = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'];
  for (const handle of handles) {
    const { clip } = makeZoomProject(1.5, 0.5, 0.5);
    assert.ok(clip.w === undefined && clip.h === undefined, 'zoom model stores no w/h');
    const z = simulateZoomHandleDrag(clip, handle, 30, 30);
    assert.ok(Number.isFinite(z.level + z.x + z.y + z.size), `handle [${handle}] delta stays finite`);
    assert.ok(Number.isFinite(clip.level + clip.x + clip.y), `handle [${handle}] model stays finite`);
    assert.ok(clip.level >= ZOOM_LEVEL_MIN && clip.level <= ZOOM_LEVEL_MAX, `handle [${handle}] level in export range`);
    assert.ok(clip.w === undefined && clip.h === undefined, `handle [${handle}] creates no w/h pollution`);
    // Preview rect must round-trip through the model: size == 1 / level
    // (up to q4 display rounding).
    const back = zoomPreviewRect(clip);
    assert.ok(Math.abs(back.w - 1 / clip.level) < 1e-4, `handle [${handle}] preview size matches level`);
    assert.ok(Math.abs(back.h - 1 / clip.level) < 1e-4, `handle [${handle}] preview stays square`);
  }
});

test('zoom-out: enlarging the region reduces magnification continuously to full-frame', () => {
  // Sweep SE outward in small steps from a centered level-2.0 region:
  // level must fall monotonically until the full-frame floor (was stuck at ~1.3).
  const sweeps = [];
  for (const px of [10, 25, 40, 55, 70, 85, 100, 115]) {
    sweeps.push(zoomResizeDelta({ level: 2.0, x: 0.5, y: 0.5 }, 'se', px, px).level);
  }
  for (let i = 1; i < sweeps.length; i++) {
    assert.ok(sweeps[i] < sweeps[i - 1], `level falls monotonically (step ${i}: ${sweeps[i - 1]} -> ${sweeps[i]})`);
  }
  // A full drag to the frame corner reaches level 1.0 (was stuck at ~1.3).
  const far = zoomResizeDelta({ level: 2.0, x: 0.5, y: 0.5 }, 'se', 800, 800);
  assert.equal(far.level, 1.0, 'corner drag reaches full-frame zoom-out');
  assert.deepEqual([far.x, far.y], [0.5, 0.5], 'full-frame centers');
});

test('zoom-out: rendered box tracks the model with no rounding steps', () => {
  for (const px of [7, 23, 41, 77, 113]) {
    const z = zoomResizeDelta({ level: 2.0, x: 0.5, y: 0.5 }, 'se', px, px);
    const rendered = zoomPreviewRect({ level: z.level, x: z.x, y: z.y });
    assert.equal(rendered.w, z.size, `rendered tracks model exactly at +${px}px`);
    assert.ok(Math.abs(rendered.w - 1 / z.level) < 1e-4, `rendered equals 1/level at +${px}px`);
  }
});

test('zoom-in: shrinking raises magnification and caps at 8.0 without sticking', () => {
  const capped = zoomResizeDelta({ level: 2.0, x: 0.5, y: 0.5 }, 'se', -500, -500);
  assert.equal(capped.level, 8.0, 'deep shrink caps at max level');
  const further = zoomResizeDelta({ level: capped.level, x: capped.x, y: capped.y }, 'se', -500, -500);
  assert.equal(further.level, 8.0, 'further shrink stays capped, finite');
  assert.ok(Number.isFinite(further.x + further.y), 'capped drag stays finite');
});

test('zoom resize boundaries: extreme drags clamp, never NaN, center stays framed', () => {
  const cases = [
    ['se', 2000, 2000], ['nw', -2000, -2000], ['e', 2000, 0],
    ['w', -2000, 0], ['n', 0, -2000], ['s', 0, 2000], ['ne', 1500, -1500]
  ];
  for (const [handle, dx, dy] of cases) {
    const z = zoomResizeDelta({ level: 1.8, x: 0.4, y: 0.6 }, handle, dx, dy);
    assert.ok(z, `handle [${handle}] resolves at extremes`);
    assert.ok(Number.isFinite(z.level + z.x + z.y + z.size), `handle [${handle}] finite`);
    assert.ok(z.level >= 1.0 && z.level <= ZOOM_LEVEL_MAX, `handle [${handle}] level clamped`);
    assert.ok(z.x >= 0 && z.x <= 1 && z.y >= 0 && z.y <= 1, `handle [${handle}] center framed`);
  }
});

test('zoom resize: edge drags keep the target center stable on the orthogonal axis', () => {
  // Centered box: symmetric growth keeps the whole center fixed.
  const s = zoomResizeDelta({ level: 2.0, x: 0.5, y: 0.5 }, 's', 0, 60);
  assert.equal(s.x, 0.5, 'south drag keeps x');
  assert.equal(s.y, 0.5, 'south drag keeps centered y (symmetric growth)');
  assert.ok(s.size > 0.5, 'south drag enlarges');
  const e = zoomResizeDelta({ level: 2.0, x: 0.5, y: 0.5 }, 'e', 60, 0);
  assert.equal(e.y, 0.5, 'east drag keeps y');
  assert.equal(e.x, 0.5, 'east drag keeps centered x (symmetric growth)');
  assert.ok(e.size > 0.5, 'east drag enlarges');
  const n = zoomResizeDelta({ level: 2.0, x: 0.5, y: 0.5 }, 'n', 0, -60);
  assert.equal(n.x, 0.5, 'north drag keeps x');
  assert.equal(n.y, 0.5, 'north drag keeps centered y');
  const w = zoomResizeDelta({ level: 2.0, x: 0.5, y: 0.5 }, 'w', -60, 0);
  assert.equal(w.y, 0.5, 'west drag keeps y');
  assert.equal(w.x, 0.5, 'west drag keeps centered x');
  // Shrinking is symmetric too.
  const sh = zoomResizeDelta({ level: 2.0, x: 0.5, y: 0.5 }, 's', 0, -60);
  assert.equal(sh.x, 0.5, 'south shrink keeps x');
  assert.ok(sh.size < 0.5, 'south shrink reduces size');
});

test('zoom resize: off-center enlargement slides center minimally, stays continuous', () => {
  let level = 2.0;
  let prev = 0.5;
  for (const px of [20, 60, 120, 220, 400]) {
    const z = zoomResizeDelta({ level: 2.0, x: 0.7, y: 0.3 }, 'se', px, px);
    assert.ok(z.level <= level, 'level never rises while enlarging');
    level = z.level;
    assert.ok(z.size >= prev, 'box grows monotonically');
    prev = z.size;
    assert.ok(z.x >= 0.5 && z.x <= 0.7, 'center slides minimally toward frame middle');
    assert.ok(z.y >= 0.3 && z.y <= 0.5, 'center slides minimally toward frame middle');
  }
  const full = zoomResizeDelta({ level: 2.0, x: 0.7, y: 0.3 }, 'se', 1000, 1000);
  assert.equal(full.level, 1.0, 'off-center drag still reaches full-frame');
});

test('zoom resize: unknown handle throws like resizeGeo', () => {
  assert.throws(() => zoomResizeDelta({ level: 1.5, x: 0.5, y: 0.5 }, 'bogus', 10, 10), /Unknown corner/);
});

test('zoom resize: preserves transition, timing, playback math, and export spec', () => {
  const { project, clip } = makeZoomProject(1.5, 0.5, 0.5);
  const start = clip.start;
  const end = clip.end;
  const transition = clip.transition;
  simulateZoomHandleDrag(clip, 'nw', -40, -40);
  assert.equal(clip.transition, transition, 'transition untouched');
  assert.equal(clip.start, start, 'timing start untouched');
  assert.equal(clip.end, end, 'timing end untouched');
  const spec = projectToSpecV2(project);
  assert.equal(spec.zooms.length, 1);
  assert.ok(spec.zooms[0].level >= ZOOM_LEVEL_MIN && spec.zooms[0].level <= ZOOM_LEVEL_MAX, 'exported level in range');
  assert.equal(spec.zooms[0].transition, transition, 'exported transition intact');
  const st = getZoomState(clip, (start + end) / 2);
  assert.ok(Number.isFinite(st.level) && Number.isFinite(st.x) && Number.isFinite(st.y), 'playback state finite');
});

test('zoom on-canvas resize: old generic rect path corrupts the model (root-cause lock)', () => {
  const { clip } = makeZoomProject(1.5, 0.5, 0.5);
  // What the code did before the fix: feed center+x/y plus undefined w/h
  // straight into resizeGeo and write the result back as x/y/w/h.
  const bad = resizeGeo({ x: clip.x, y: clip.y, w: clip.w, h: clip.h }, 'se', 0.05, 0.05, { minDim: GEO_MIN });
  assert.ok(Number.isNaN(bad.w) || Number.isNaN(bad.h) || Number.isNaN(bad.x), 'generic path yields NaN for zoom clips');
});

test('zoom on-canvas resize: workspace preview wires a zoom-specific resize branch', () => {
  const jsSrc = readFileSync(path.join(process.cwd(), 'src/public/admin-video-editor.js'), 'utf8');
  assert.match(jsSrc, /zoomPreviewRect/, 'preview uses canonical zoom rect helper');
  assert.match(jsSrc, /zoomFromPreviewRect/, 'draw converts marquee back to level/center');
  assert.match(jsSrc, /zoomResizeDelta/, 'resize scales about the target center');
  assert.match(jsSrc, /resizing && clip\.type === 'zoom'/, 'zoom has a dedicated resize branch');
});

test('zoom draw-to-create: +Zoom defaults produce a finite preview region', () => {
  // Same model path as +Zoom -> addClipAtPlayhead('zoom'): defaults + preview rect.
  const project = createProject();
  addFileEntry(project, { kind: 'video', name: 'v1.mp4', duration: 30, width: 1280, height: 720 });
  appendMediaClip(project, project.files[0].id, 0);
  const clip = addClip(project, 'zoom', 2);
  assert.equal(clip.level, 1.5);
  assert.ok(clip.w === undefined && clip.h === undefined, 'new zoom has no w/h');
  const rect = zoomPreviewRect(clip);
  assert.ok(Number.isFinite(rect.x + rect.y + rect.w + rect.h), 'preview region is finite');
  assert.ok(rect.w > 0 && rect.h > 0 && rect.x >= 0 && rect.y >= 0, 'region inside frame');
});

test('zoom draw-to-create: press-drag defines level/center via the actual draw math', () => {
  // Same math as the overlayLayer background handler: anchor -> marquee -> model.
  const anchor = { x: 0.3, y: 0.3 };
  const current = { x: 0.55, y: 0.5 };
  const marquee = zoomDrawRect(anchor, current);
  assert.ok(marquee, 'drag produces a marquee rect');
  assert.ok(Math.abs(marquee.w - marquee.h) < 1e-9, 'marquee is square (uniform level)');
  const z = zoomFromPreviewRect(marquee);
  assert.ok(Number.isFinite(z.level + z.x + z.y), 'draw result is finite');
  assert.ok(z.level >= 1.0 && z.level <= ZOOM_LEVEL_MAX, 'drawn level in export range');
  assert.ok(z.level < 1.5 || z.x !== 0.5, 'drag mutates the region');

  const { clip } = makeZoomProject(1.5, 0.5, 0.5);
  clip.level = z.level;
  clip.x = z.x;
  clip.y = z.y;
  assert.ok(clip.w === undefined && clip.h === undefined, 'draw creates no w/h pollution');
  const back = zoomPreviewRect(clip);
  assert.ok(Math.abs(back.w - 1 / clip.level) < 1e-3, 'drawn region round-trips through level');
});

test('zoom draw-to-create: tiny movement is a click (center placement, level kept)', () => {
  // Handler threshold (<4px) keeps plain clicks as center repositioning.
  assert.equal(zoomDrawRect({ x: 0.4, y: 0.4 }, { x: 0.4, y: 0.4 }), null, 'no drag -> no marquee');
  const { clip } = makeZoomProject(1.5, 0.5, 0.5);
  const anchor = { x: 0.62, y: 0.38 };
  clip.x = Math.min(1, Math.max(0, anchor.x));
  clip.y = Math.min(1, Math.max(0, anchor.y));
  assert.equal(clip.level, 1.5, 'click keeps level');
  assert.equal(clip.x, 0.62, 'click places center x');
  assert.equal(clip.y, 0.38, 'click places center y');
});

test('zoom draw-to-create: drag in any direction stays in frame and syncs export', () => {
  const drags = [
    [{ x: 0.5, y: 0.5 }, { x: 0.9, y: 0.9 }],
    [{ x: 0.5, y: 0.5 }, { x: 0.1, y: 0.1 }],
    [{ x: 0.2, y: 0.8 }, { x: 0.7, y: 0.3 }]
  ];
  for (const [a, c] of drags) {
    const m = zoomDrawRect(a, c);
    assert.ok(m, 'drag yields marquee');
    assert.ok(m.x >= 0 && m.y >= 0 && m.x + m.w <= 1 + 1e-9 && m.y + m.h <= 1 + 1e-9, 'marquee inside frame');
    const { project, clip } = makeZoomProject(1.5, 0.5, 0.5);
    const start = clip.start;
    const end = clip.end;
    const z = zoomFromPreviewRect(m);
    clip.level = z.level;
    clip.x = z.x;
    clip.y = z.y;
    assert.equal(clip.start, start, 'draw keeps timing');
    assert.equal(clip.end, end, 'draw keeps timing');
    const spec = projectToSpecV2(project);
    assert.equal(spec.zooms[0].level, clip.level, 'drawn level exports');
  }
});
