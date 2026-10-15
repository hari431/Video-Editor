import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  createProject,
  addFileEntry,
  addClip,
  getClip,
  resizeGeo
} from '../src/public/video-editor-project.js';

test('video editor on-canvas resizing: preserves geometry and clip.h for Blur, Image, and Video Overlay', () => {
  const project = createProject();
  addFileEntry(project, { kind: 'video', name: 'v1.mp4', duration: 30, width: 1280, height: 720 });

  const blur = addClip(project, 'blur', 0);
  const img = addClip(project, 'image', 0);
  const voverlay = addClip(project, 'voverlay', 0);

  assert.equal(typeof blur.h, 'number', 'Blur clip initializes with numeric height');
  assert.equal(typeof img.h, 'number', 'Image clip initializes with numeric height');
  assert.equal(typeof voverlay.h, 'number', 'Video overlay clip initializes with numeric height');

  // Verify all 8 handles calculate valid geometric updates
  const handles = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'];
  handles.forEach(handle => {
    const geoBlur = resizeGeo({ x: blur.x, y: blur.y, w: blur.w, h: blur.h }, handle, 0.05, 0.05, { minDim: 0.02 });
    assert.ok(geoBlur.w >= 0.02 && geoBlur.h >= 0.02, `Blur handle [${handle}] resizes correctly`);

    const geoImg = resizeGeo({ x: img.x, y: img.y, w: img.w, h: img.h }, handle, 0.05, 0.05, { preserveAspect: true, aspect: 1, minDim: 0.02 });
    assert.ok(geoImg.w >= 0.02 && geoImg.h >= 0.02, `Image handle [${handle}] resizes correctly`);

    const geoVo = resizeGeo({ x: voverlay.x, y: voverlay.y, w: voverlay.w, h: voverlay.h }, handle, 0.05, 0.05, { preserveAspect: true, aspect: 1.5, minDim: 0.02 });
    assert.ok(geoVo.w >= 0.02 && geoVo.h >= 0.02, `Voverlay handle [${handle}] resizes correctly`);
  });
});

test('video editor horizontal scrollbar: DOM elements, styling, and script synchronization', () => {
  const ejsSrc = readFileSync(path.join(process.cwd(), 'src/views/admin-video-editor.ejs'), 'utf8');
  const jsSrc = readFileSync(path.join(process.cwd(), 'src/public/admin-video-editor.js'), 'utf8');

  // Verify DOM structure for custom horizontal scrollbar
  assert.match(ejsSrc, /id="veHScrollbarWrap"/, '#veHScrollbarWrap element exists in EJS');
  assert.match(ejsSrc, /id="veHScrollbarTrack"/, '#veHScrollbarTrack element exists in EJS');
  assert.match(ejsSrc, /id="veHScrollbarThumb"/, '#veHScrollbarThumb element exists in EJS');

  // Verify syncHScrollbar script function exists and binds pointer events
  assert.match(jsSrc, /function syncHScrollbar\(\)/, 'syncHScrollbar function defined in JS');
  assert.match(jsSrc, /thumbEl\.addEventListener\('pointerdown'/, 'pointerdown listener attached to scrollbar thumb');
  assert.match(jsSrc, /trackEl\.addEventListener\('pointerdown'/, 'pointerdown listener attached to scrollbar track');
});


test('Editing Workspace keeps its custom scrollbar visible and recalculates it after layout changes', () => {
  const ejsSrc = readFileSync(path.join(process.cwd(), 'src/views/admin-video-editor.ejs'), 'utf8');
  const jsSrc = readFileSync(path.join(process.cwd(), 'src/public/admin-video-editor.js'), 'utf8');
  assert.match(ejsSrc, /\.ve-hscrollbar-wrap\s*\{[\s\S]*?flex:\s*0\s+0\s+32px\s*!important/);
  assert.match(ejsSrc, /\.ve-hscrollbar-wrap\s*\{[\s\S]*?visibility:\s*visible\s*!important/);
  assert.match(jsSrc, /new ResizeObserver\(function\s*\(\)\s*\{\s*window\.requestAnimationFrame\(syncHScrollbar\)/);
  assert.match(jsSrc, /var MIN_PX_PER_SEC = 32;/);
  assert.match(jsSrc, /clip\.type === 'blur' \|\| clip\.type === 'image' \|\| clip\.type === 'voverlay'[\s\S]*?numField\('h'/, 'Image clips expose their height field in the inspector');
});
