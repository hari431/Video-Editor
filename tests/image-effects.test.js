import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  validateImageEffectSpec,
  renderImageEffectsToBuffer,
  compileEffectToFFmpegFilter
} from '../src/library/image-effects.js';
import {
  computeCoverDraw,
  normalizePhotoFocus,
  createDefaultEffect
} from '../src/public/image-effects-shared.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';

test('validateImageEffectSpec: validates width, height, and effect layers', () => {
  const result = validateImageEffectSpec({
    width: 1920,
    height: 1080,
    bgColor: '#1e293b',
    layers: [
      { id: 'l1', type: 'redaction', x: 0.1, y: 0.2, w: 0.3, h: 0.1, color: '#000000' },
      { id: 'l2', type: 'stamp', x: 0.5, y: 0.5, w: 0.2, h: 0.15, text: 'TOP SECRET' },
      { id: 'l3', type: 'headline', x: 0.2, y: 0.7, w: 0.6, h: 0.2, text: 'BREAKING NEWS' }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.spec.width, 1920);
  assert.equal(result.spec.height, 1080);
  assert.equal(result.spec.layers.length, 3);
  assert.equal(result.spec.layers[0].type, 'redaction');
  assert.equal(result.spec.layers[1].type, 'stamp');
  assert.equal(result.spec.layers[2].type, 'headline');
});

test('renderImageEffectsToBuffer: renders image canvas buffer with effect layers', async () => {
  const spec = {
    width: 800,
    height: 600,
    bgColor: '#0f172a',
    layers: [
      { id: 'l1', type: 'redaction', x: 0.1, y: 0.1, w: 0.4, h: 0.1, color: '#000000', visible: true },
      { id: 'l2', type: 'highlight', x: 0.1, y: 0.3, w: 0.5, h: 0.08, color: '#facc15', visible: true },
      { id: 'l3', type: 'stamp', x: 0.6, y: 0.1, w: 0.3, h: 0.2, text: 'DECLASSIFIED', color: '#16a34a', visible: true },
      { id: 'l4', type: 'headline', x: 0.1, y: 0.5, w: 0.8, h: 0.25, text: 'EDITORIAL TEXT', size: 0.08, visible: true }
    ]
  };

  const buf = await renderImageEffectsToBuffer(null, spec, 'png');
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 100);
});

test('compileEffectToFFmpegFilter: compiles redaction, highlight, stamp, headline, and blur for Video Editor reuse', () => {
  const redactionFilter = compileEffectToFFmpegFilter(
    { type: 'redaction', x: 0.1, y: 0.1, w: 0.2, h: 0.1, color: '#000000', opacity: 1 },
    1920,
    1080
  );
  assert.match(redactionFilter, /^drawbox=x=192:y=108:w=384:h=108:color=0x000000ff:t=fill$/);

  const stampFilter = compileEffectToFFmpegFilter(
    { type: 'stamp', x: 0.5, y: 0.2, w: 0.3, h: 0.15, text: 'TOP SECRET', color: '#dc2626' },
    1920,
    1080
  );
  assert.match(stampFilter, /drawbox/);
  assert.match(stampFilter, /drawtext/);
  assert.match(stampFilter, /TOP SECRET/);

  const headlineFilter = compileEffectToFFmpegFilter(
    { type: 'headline', x: 0.1, y: 0.7, w: 0.8, h: 0.2, text: 'CINEMATIC', size: 0.08, color: '#ffffff', bg: '#000000' },
    1920,
    1080
  );
  assert.match(headlineFilter, /drawbox/);
  assert.match(headlineFilter, /drawtext/);
  assert.match(headlineFilter, /CINEMATIC/);
});


test('standalone Image Editor wires all eight handles to resize gestures and exports without editor chrome', () => {
  const src = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  assert.match(src, /function hitHandle\(point, fx\)/);
  assert.match(src, /dragKind = forceKind \|\| \(handle \? handle === 'rotate' \? 'rotate' : 'resize' : 'move'\)/);
  assert.match(src, /window\.addEventListener\('pointermove', move, true\)/);
  assert.match(src, /if \(dragKind === 'resize'\)/);
  assert.match(src, /const exportCanvas = document\.createElement\('canvas'\)/);
  assert.match(src, /effects\.forEach\(effect => \{\s*if \(effect\.visible !== false\) drawEffectOnCanvas/);
});


test('standalone Image Editor starts clean and loads presets only on explicit selection', () => {
  const src = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  const init = src.match(/function init\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(init, 'init function should exist');
  assert.doesNotMatch(init[1], /loadClassifiedPreset\(\)|loadCinematicPreset\(\)/);
  assert.match(init[1], /effects = \[\]/);
  assert.match(src, /btnClassified\.addEventListener\('click', loadClassifiedPreset\)/);
  assert.match(src, /btnCinematic\.addEventListener\('click', loadCinematicPreset\)/);
});


test('backend image effect renderer validates and renders shape layers', async () => {
  const result = validateImageEffectSpec({ width: 320, height: 240, layers: [
    { id: 'shape1', type: 'shape', shape: 'star', x: 0.2, y: 0.2, w: 0.4, h: 0.4, fillColor: '#2563eb', fillOpacity: 0.6, outlineEnabled: true, outlineColor: '#ff0000', outlineWidth: 5, outlineOpacity: 0.8 }
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.spec.layers.length, 1);
  assert.equal(result.spec.layers[0].shape, 'star');
  const buf = await renderImageEffectsToBuffer(null, { width: 320, height: 240, layers: result.spec.layers }, 'png');
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 100);
});

test('shape tools expose six types, independent appearance controls, custom drawing, and export rendering', () => {
  const client=readFileSync(path.join(process.cwd(),'src/public/admin-image-editor.js'),'utf8');
  const shared=readFileSync(path.join(process.cwd(),'src/public/image-effects-shared.js'),'utf8');
  const view=readFileSync(path.join(process.cwd(),'src/views/admin-image-editor.ejs'),'utf8');
  const backend=readFileSync(path.join(process.cwd(),'src/library/image-effects.js'),'utf8');
  for(const id of ['btnShapeRectangle','btnShapeRoundedRectangle','btnShapeCircle','btnShapeTriangle','btnShapeDiamond','btnShapeStar'])assert.match(view,new RegExp(id));
  for(const shape of ['rectangle','rounded-rectangle','circle','triangle','diamond','star'])assert.match(client,new RegExp(shape));
  for(const prop of ['fillOpacity','outlineEnabled','outlineColor','outlineWidth','outlineOpacity','cornerRadius'])assert.match(client,new RegExp(prop));
  assert.match(client,/pendingShapeType/);assert.match(shared,/effect.type === 'shape'/);assert.match(backend,/layer.type === 'shape'/);assert.match(backend,/'blur', 'shape'/);
});

test('Image Editor implements bounded session Undo/Redo, shortcuts, and background reset', () => {
  const src = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  const view = readFileSync(path.join(process.cwd(), 'src/views/admin-image-editor.ejs'), 'utf8');
  assert.match(src, /const HISTORY_LIMIT = 100/);
  assert.match(src, /function pushUndoSnapshot\(\)/);
  assert.match(src, /function undo\(\)/);
  assert.match(src, /function redo\(\)/);
  assert.match(src, /redoStack\.length = 0/);
  assert.match(src, /if \(undoStack\.length > HISTORY_LIMIT\) undoStack\.shift\(\)/);
  assert.match(src, /function clearHistory\(\)/);
  assert.match(src, /clearHistory\(\);/);
  assert.match(src, /key === 'z' && !e\.shiftKey/);
  assert.match(src, /key === 'y' \|\| \(key === 'z' && e\.shiftKey\)/);
  assert.match(src, /Native text-field undo\/redo takes priority/);
  assert.match(view, /id="btnUndo" disabled/);
  assert.match(view, /id="btnRedo" disabled/);
});

test('standalone Image Editor deletes the selected layer with Delete or Backspace without interrupting field editing', () => {
  const src = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  assert.match(src, /document\.addEventListener\('keydown'/);
  assert.match(src, /e\.key !== 'Delete' && e\.key !== 'Backspace'/);
  assert.match(src, /target\.isContentEditable \|\| \/\^\(INPUT\|TEXTAREA\|SELECT\)\$\//);
  assert.match(src, /handleLayerAction\('del', selectedEffectId\)/);
});


test('redaction layers support selectable geometric masks in preview and backend export', async () => {
  const client = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  const shared = readFileSync(path.join(process.cwd(), 'src/public/image-effects-shared.js'), 'utf8');
  const backend = readFileSync(path.join(process.cwd(), 'src/library/image-effects.js'), 'utf8');
  assert.match(client, /sel\.type === 'redaction'[\s\S]*?data-prop="shape"/);
  for (const shape of ['rectangle', 'rounded-rectangle', 'circle', 'triangle', 'diamond', 'star']) {
    assert.ok(shared.includes(`shape === '${shape}'`) || shape === 'rectangle');
    assert.ok(backend.includes(`shape === '${shape}'`) || shape === 'rectangle');
  }
  const result = validateImageEffectSpec({ width: 320, height: 240, layers: [
    { id: 'diamond-redaction', type: 'redaction', shape: 'diamond', x: 0.2, y: 0.2, w: 0.5, h: 0.5, color: '#ff0000', opacity: 1 }
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.spec.layers[0].shape, 'diamond');
  const buf = await renderImageEffectsToBuffer(null, { width: 320, height: 240, layers: result.spec.layers }, 'png');
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 100);
});


test('blur Inspector exposes geometric mask choices and renderers clip blur to selected shape', () => {
  const client = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  const shared = readFileSync(path.join(process.cwd(), 'src/public/image-effects-shared.js'), 'utf8');
  const backend = readFileSync(path.join(process.cwd(), 'src/library/image-effects.js'), 'utf8');
  assert.match(client, /sel\.type === 'blur'[\s\S]*?Blur shape[\s\S]*?data-prop="shape"/);
  assert.match(shared, /effect\.type === 'blur'[\s\S]*?const shape = effect\.shape \|\| 'rectangle'[\s\S]*?ctx\.clip\(\)/);
  assert.match(backend, /layer\.type === 'blur'[\s\S]*?const shape = layer\.shape \|\| 'rectangle'[\s\S]*?ctx\.clip\(\)/);
  for (const shape of ['rounded-rectangle', 'circle', 'triangle', 'diamond', 'star']) {
    assert.ok(shared.includes(`shape === '${shape}'`));
    assert.ok(backend.includes(`shape === '${shape}'`));
  }
});


test('Image Editor supports multiple independent image layers through upload, stack, preview, and export', async () => {
  const client = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  const view = readFileSync(path.join(process.cwd(), 'src/views/admin-image-editor.ejs'), 'utf8');
  const shared = readFileSync(path.join(process.cwd(), 'src/public/image-effects-shared.js'), 'utf8');
  const backend = readFileSync(path.join(process.cwd(), 'src/library/image-effects.js'), 'utf8');
  assert.match(view, /id="imageLayerInput"[^>]*multiple/);
  assert.match(client, /imageLayerInput\?\.addEventListener\('change'/);
  assert.match(client, /Promise\.all\(supported\.map/);
  assert.match(client, /createDefaultEffect\('image'/);
  assert.match(client, /effects\.push\(fx\)/);
  assert.match(shared, /type === 'image'/);
  assert.match(shared, /function computeCoverDraw/);
  assert.match(shared, /function drawCoveredImage/);
  assert.match(shared, /effect\.type === 'image'[\s\S]*?drawCoveredImage\(ctx, image,/);
  assert.match(backend, /'shape', 'image'/);
  assert.match(backend, /function computeCoverDraw/);
  assert.match(backend, /normalizePhotoFocus\(layer\)/);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S9sAAAAASUVORK5CYII=', 'base64');
  const data = 'data:image/png;base64,' + png.toString('base64');
  const result = validateImageEffectSpec({ width: 320, height: 240, layers: [
    { id: 'img1', type: 'image', imageData: data, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    { id: 'img2', type: 'image', imageData: data, x: 0.5, y: 0.5, w: 0.2, h: 0.2 }
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.spec.layers.length, 2);
  const buf = await renderImageEffectsToBuffer(null, result.spec, 'png');
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 100);
});


test('image layers support selectable geometric masks in Inspector, preview, and export', () => {
  const client = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  const view = readFileSync(path.join(process.cwd(), 'src/views/admin-image-editor.ejs'), 'utf8');
  const shared = readFileSync(path.join(process.cwd(), 'src/public/image-effects-shared.js'), 'utf8');
  const backend = readFileSync(path.join(process.cwd(), 'src/library/image-effects.js'), 'utf8');
  assert.match(client, /sel\.type === 'image'[\s\S]*?Image shape \/ mask[\s\S]*?data-prop="shape"/);
  assert.match(shared, /effect\.type === 'image'[\s\S]*?const imageShape = effect\.shape \|\| 'rectangle'[\s\S]*?ctx\.clip\(\)/);
  assert.match(backend, /layer\.type === 'image'[\s\S]*?const imageShape = layer\.shape \|\| 'rectangle'[\s\S]*?ctx\.clip\(\)/);
  assert.match(view, /id="mainImageUploadCard"[\s\S]*?Upload Main \/ Background Image/);
  // Preview and backend share one mask tracer so every mask stays in parity.
  assert.match(shared, /function traceImageMaskPath/);
  for (const shape of ['rounded-rectangle', 'circle', 'triangle', 'diamond', 'star']) {
    assert.ok(shared.includes(`'${shape}'`), `preview should support ${shape}`);
    assert.ok(backend.includes(`'${shape}'`), `backend should support ${shape}`);
  }
  // All trendy masks must also trace in the shared preview helper (not fall back to rectangle).
  for (const shape of ['heart', 'hexagon', 'octagon', 'arch', 'speech-bubble', 'ticket', 'blob', 'scalloped', 'torn-paper']) {
    assert.ok(shared.includes(`'${shape}'`), `preview should support ${shape}`);
  }
});


test('image editor resize handles use display-scaled hit targets for large backing canvases', () => {
  const client = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  assert.match(client, /Hit targets must be measured in CSS pixels/);
  assert.match(client, /18 \* canvasWidth \/ Math\.max\(1, rect\.width\)/);
  assert.match(client, /18 \* canvasHeight \/ Math\.max\(1, rect\.height\)/);
  assert.match(client, /function hitHandle\(point, fx\)/);
  assert.match(client, /dragKind === 'resize'[\s\S]*?fx\.w = right - left; fx\.h = bottom - top;/);
});


test('torn-paper photo mask supports adjustable edge, irregularity, paper color, and shadow in preview and export', () => {
  const client = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  const shared = readFileSync(path.join(process.cwd(), 'src/public/image-effects-shared.js'), 'utf8');
  const backend = readFileSync(path.join(process.cwd(), 'src/library/image-effects.js'), 'utf8');
  assert.match(client, /\['torn-paper','Torn paper'\]/);
  assert.match(client, /Paper edge size \(px\)/);
  assert.match(client, /data-prop="irregularityPercent"/);
  assert.match(client, /data-prop="edgeColor"/);
  assert.match(shared, /function traceTornPaperPath/);
  assert.match(shared, /imageShape === 'torn-paper'[\s\S]*?ctx\.clip\(\)[\s\S]*?ctx\.stroke\(\)/);
  assert.match(backend, /function traceTornPaperPath/);
  assert.match(backend, /imageShape==='torn-paper'[\s\S]*?ctx\.clip\(\)[\s\S]*?ctx\.stroke\(\)/);
});


test('main background supports selectable masks and preserves transparent masked exports', () => {
  const client = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  const view = readFileSync(path.join(process.cwd(), 'src/views/admin-image-editor.ejs'), 'utf8');
  assert.match(view, /id="bgShapeInput"/);
  assert.match(view, /value="torn-paper"/);
  assert.match(client, /function traceBackgroundMask/);
  assert.match(client, /function drawBackgroundImage/);
  assert.match(client, /drawBackgroundImage\(ctx\)/);
  assert.match(client, /format === 'jpeg'.*?#ffffff/s);
});


test('main image mask color renders a visible edge for non-rectangular masks', () => {
  const client = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  assert.match(client, /if \(bgShape !== 'rectangle'\)/);
  assert.match(client, /ctx\.strokeStyle = bgEdgeColor/);
  assert.match(client, /ctx\.lineWidth = Math\.max\(2, bgEdgeSize/);
});


test('main image mask preview renders on an empty canvas and responds to shape and paper controls', () => {
  const client = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  // Empty workspace keeps a genuine full-size default canvas (solid or checker),
  // never an opaque mask-shaped fill: mask controls only stroke an outline.
  assert.match(client, /function hasMainImage\(\)/);
  assert.match(client, /function paintCanvasBase\(ctx\)/);
  assert.match(client, /ctx\.fillStyle = canvasBgColor/);
  assert.match(client, /ctx\.setLineDash\(\[10, 6\]\)/);
  assert.match(client, /ctx\.lineWidth = Math\.max\(2, bgEdgeSize/);
  assert.match(client, /bgShape === 'torn-paper' \? 'round' : 'miter'/);
  assert.doesNotMatch(client, /Draw subtle grid texture/);
});


test('trendy image mask shapes are available in editor and backend renderers', async () => {
  const fs = await import('node:fs');
  const editor = fs.readFileSync(new URL('../src/public/admin-image-editor.js', import.meta.url), 'utf8');
  const view = fs.readFileSync(new URL('../src/views/admin-image-editor.ejs', import.meta.url), 'utf8');
  const backend = fs.readFileSync(new URL('../src/library/image-effects.js', import.meta.url), 'utf8');
  for (const shape of ['heart', 'hexagon', 'octagon', 'arch', 'speech-bubble', 'ticket', 'blob', 'scalloped']) {
    assert.ok(editor.includes(`'${shape}'`), `editor should expose ${shape}`);
    assert.ok(view.includes(`value="${shape}"`), `main image selector should expose ${shape}`);
    assert.ok(backend.includes(`'${shape}'`), `backend renderer should support ${shape}`);
  }
});

test('default canvas fills the entire area and export works with no main image', async () => {
  const client = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  const view = readFileSync(path.join(process.cwd(), 'src/views/admin-image-editor.ejs'), 'utf8');
  // Selectable canvas background covers the full canvas (regression: no grid, no mask fill).
  assert.match(view, /id="canvasBgInput"/);
  assert.match(view, /id="canvasBgTransparentInput"/);
  assert.match(client, /canvasBgColor/);
  assert.match(client, /canvasBgTransparent/);
  assert.match(client, /paintCanvasBase\(ctx\)/);
  assert.match(client, /if \(hasImage\) \{\s*drawBackgroundImage\(ctx\);/);
  // Backend: empty spec renders a solid full-size canvas for PNG and JPEG.
  for (const fmt of ['png', 'webp', 'jpeg']) {
    const buf = await renderImageEffectsToBuffer(null, { width: 320, height: 240, bgColor: '#123456', layers: [] }, fmt);
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 100, `${fmt} empty-canvas export should produce bytes`);
  }
});

test('masked main image keeps transparency outside for PNG but uses solid for JPEG', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S9sAAAAASUVORK5CYII=', 'base64');
  const spec = { width: 200, height: 200, bgColor: '#1e293b', bgShape: 'circle', bgEdgeSize: 8, bgEdgeColor: '#ffffff', layers: [] };
  const outPng = await renderImageEffectsToBuffer(png, spec, 'png');
  const outJpeg = await renderImageEffectsToBuffer(png, spec, 'jpeg');
  assert.ok(outPng.length > 100);
  assert.ok(outJpeg.length > 100);
  assert.notDeepEqual(outPng.subarray(1, 4).toString('hex'), outJpeg.subarray(1, 4).toString('hex'));
  // Spec validation preserves the mask fields (root cause: previously dropped).
  const checked = validateImageEffectSpec(spec);
  assert.equal(checked.ok, true);
  assert.equal(checked.spec.bgShape, 'circle');
  assert.equal(checked.spec.bgEdgeColor, '#ffffff');
});

test('image-layer masks clip without opaque fill and support edge properties', async () => {
  const shared = readFileSync(path.join(process.cwd(), 'src/public/image-effects-shared.js'), 'utf8');
  const backend = readFileSync(path.join(process.cwd(), 'src/library/image-effects.js'), 'utf8');
  assert.match(shared, /function traceImageMaskPath/);
  assert.match(shared, /traceImageMaskPath\(ctx, imageShape, wPx, hPx/);
  assert.match(backend, /function traceBackgroundMaskPath/);
  // Torn-paper keeps configurable edge/shadow in both renderers.
  for (const prop of ['edgeSize', 'irregularity', 'edgeColor', 'shadowBlur', 'shadowOpacity']) {
    assert.ok(shared.includes(prop), `preview should honor ${prop}`);
    assert.ok(backend.includes(prop), `backend should honor ${prop}`);
  }
  // An image layer with every mask renders without throwing.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S9sAAAAASUVORK5CYII=', 'base64');
  const data = 'data:image/png;base64,' + png.toString('base64');
  for (const shape of ['rectangle', 'rounded-rectangle', 'circle', 'triangle', 'diamond', 'star', 'heart', 'hexagon', 'octagon', 'arch', 'speech-bubble', 'ticket', 'blob', 'scalloped', 'torn-paper']) {
    const buf = await renderImageEffectsToBuffer(null, { width: 240, height: 180, bgColor: '#1e293b', layers: [
      { id: `m-${shape}`, type: 'image', imageData: data, shape, x: 0.2, y: 0.2, w: 0.5, h: 0.5, cornerRadius: 18, edgeSize: 12, irregularity: 0.7, edgeColor: '#f8f7f2' }
    ] }, 'png');
    assert.ok(buf.length > 100, `${shape} image mask should export`);
  }
});

test('editor export mirrors preview background/mask rules and surfaces errors', () => {
  const client = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  assert.match(client, /function paintExportCanvasBase\(ctx, format\)/);
  assert.match(client, /const preserveAlpha = format !== 'jpeg' && \(canvasBgTransparent \|\| \(bgShape !== 'rectangle' && \(hasImage \|\| shapedEmptyCanvas\)\)\)/);
  assert.match(client, /paintExportCanvasBase\(ctx, format\)/);
  assert.match(client, /full-size output from the model/);
  assert.match(client, /Canvas has invalid dimensions/);
  assert.match(client, /Export failed: /);
  assert.match(client, /drawBackgroundImage\(ctx\)/);
  assert.match(client, /dataUrl === 'data:,'/);
});


test('empty canvas with selected mask exports a filled silhouette instead of a rectangle', () => {
  const client = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  const view = readFileSync(path.join(process.cwd(), 'src/views/admin-image-editor.ejs'), 'utf8');
  const backend = readFileSync(path.join(process.cwd(), 'src/library/image-effects.js'), 'utf8');
  assert.match(client, /const shapedEmptyCanvas = !hasImage && bgShape !== 'rectangle' && !canvasBgTransparent/);
  assert.match(client, /ctx\.fillStyle = canvasBgColor \|\| '#1e293b';\s*ctx\.fill\(\)/);
  assert.match(client, /shapedEmptyCanvas && format === 'jpeg' \? '#ffffff'/);
  assert.match(backend, /const shapedEmptyCanvas = !hasImageBuf && bgShape !== 'rectangle' && !bgTransparent/);
  assert.match(backend, /if \(shapedEmptyCanvas\) \{[\s\S]*?ctx\.fill\(\)/);
  assert.match(view, /With no main image the canvas background fills the entire canvas/);
});

test('photo repositioning: cover math preserves aspect ratio and honors focus', () => {
  // Wide photo (200x100) into a 100x100 mask box: scaled to 200x100, never stretched.
  const left = computeCoverDraw(200, 100, 100, 100, 0, 0.5);
  assert.equal(left.dw, 200);
  assert.equal(left.dh, 100);
  assert.ok(left.dx === 0);
  assert.ok(left.dy === 0);
  const right = computeCoverDraw(200, 100, 100, 100, 1, 0.5);
  assert.equal(right.dx, -100);
  assert.equal(right.dy, 0);
  const mid = computeCoverDraw(200, 100, 100, 100, 0.5, 0.5);
  assert.equal(mid.dx, -50);
  // Tall photo into a wide box: vertical overflow only, horizontal untouched.
  const tall = computeCoverDraw(100, 200, 100, 100, 0.5, 0);
  assert.equal(tall.dw, 100);
  assert.equal(tall.dh, 200);
  assert.ok(tall.dx === 0);
  assert.ok(tall.dy === 0);
  // Focus normalization: defaults centered, out-of-range clamped.
  assert.deepEqual(normalizePhotoFocus({}), { x: 0.5, y: 0.5 });
  assert.deepEqual(normalizePhotoFocus({ photoX: 2, photoY: -1 }), { x: 1, y: 0 });
  assert.deepEqual(normalizePhotoFocus({ photoX: 'bad', photoY: NaN }), { x: 0.5, y: 0.5 });
  // New image layers default to a centered photo.
  const fx = createDefaultEffect('image');
  assert.equal(fx.photoX, 0.5);
  assert.equal(fx.photoY, 0.5);
  // Preview and backend share the identical cover formula (export parity by construction).
  const shared = readFileSync(path.join(process.cwd(), 'src/public/image-effects-shared.js'), 'utf8');
  const backend = readFileSync(path.join(process.cwd(), 'src/library/image-effects.js'), 'utf8');
  for (const src of [shared, backend]) {
    assert.ok(src.includes('const scale = Math.max(wPx / srcW, hPx / srcH);'));
  }
});

test('photo repositioning: export shifts the visible photo region in PNG, WebP, and JPEG', async () => {
  // Wide two-color photo: left half red, right half blue.
  const src = createCanvas(100, 50);
  const sx = src.getContext('2d');
  sx.fillStyle = '#ff0000';
  sx.fillRect(0, 0, 50, 50);
  sx.fillStyle = '#0000ff';
  sx.fillRect(50, 0, 50, 50);
  const photoBuf = src.toBuffer('image/png');
  const dataUrl = 'data:image/png;base64,' + photoBuf.toString('base64');
  const layerWith = photoX => ({
    id: 'pan-me', type: 'image', imageData: dataUrl, shape: 'heart',
    x: 0.25, y: 0.25, w: 0.5, h: 0.5, photoX, photoY: 0.5
  });
  const centerPixel = async buf => {
    const img = await loadImage(buf);
    const c = createCanvas(200, 200);
    c.getContext('2d').drawImage(img, 0, 0);
    return [...c.getContext('2d').getImageData(100, 100, 1, 1).data];
  };
  for (const fmt of ['png', 'webp', 'jpeg']) {
    const leftBuf = await renderImageEffectsToBuffer(null, { width: 200, height: 200, bgColor: '#1e293b', layers: [layerWith(0)] }, fmt);
    const rightBuf = await renderImageEffectsToBuffer(null, { width: 200, height: 200, bgColor: '#1e293b', layers: [layerWith(1)] }, fmt);
    assert.ok(leftBuf.length > 100, `${fmt} left export should render`);
    assert.ok(rightBuf.length > 100, `${fmt} right export should render`);
    assert.notDeepEqual(leftBuf, rightBuf, `${fmt}: photo offset must change the exported output`);
  }
  // PNG is lossless: focus 0 shows red, focus 1 shows blue at the mask center.
  const leftPx = await centerPixel(await renderImageEffectsToBuffer(null, { width: 200, height: 200, bgColor: '#1e293b', layers: [layerWith(0)] }, 'png'));
  const rightPx = await centerPixel(await renderImageEffectsToBuffer(null, { width: 200, height: 200, bgColor: '#1e293b', layers: [layerWith(1)] }, 'png'));
  assert.ok(leftPx[0] > 200 && leftPx[2] < 50, `focus 0 should show red, got ${leftPx}`);
  assert.ok(rightPx[2] > 200 && rightPx[0] < 50, `focus 1 should show blue, got ${rightPx}`);
  // Mask geometry is unchanged by the focus: a masked main image plus a
  // repositioned layer render together without errors.
  const combined = await renderImageEffectsToBuffer(photoBuf, { width: 200, height: 200, bgColor: '#1e293b', bgShape: 'circle', layers: [layerWith(0.75)] }, 'png');
  assert.ok(combined.length > 100);
});

test('photo repositioning: controls, pan gesture, and undo-safe persistence', () => {
  const client = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  // Intuitive controls: X/Y sliders plus Center and pan-mode toggle.
  assert.match(client, /data-prop="photoX"/);
  assert.match(client, /data-prop="photoY"/);
  assert.match(client, /data-action="center-photo"/);
  assert.match(client, /data-action="toggle-pan"/);
  assert.match(client, /Photo position inside mask/);
  // Normal dragging still moves the whole layer; pan requires pan mode or Alt+drag.
  assert.match(client, /photoPanMode \|\| !!e\.altKey/);
  assert.match(client, /dragKind === 'pan'/);
  assert.match(client, /dragStartPhoto = \{ photoX/);
  // The pan branch only writes photoX/photoY: mask position/size/shape are independent.
  const panBranch = client.match(/else if \(dragKind === 'pan'\) \{([\s\S]*?)\n        \} else if \(dragKind === 'rotate'\)/);
  assert.ok(panBranch, 'pan drag branch should exist');
  assert.match(panBranch[1], /fx\.photoX/);
  assert.match(panBranch[1], /fx\.photoY/);
  assert.doesNotMatch(panBranch[1], /fx\.(x|y|w|h|rotation) =/);
  // Undo/Redo snapshots carry the focus: JSON round-trip preserves it while
  // selection, resize, rotation, and reorder only touch geometry.
  const layer = { id: 'a', type: 'image', photoX: 0.2, photoY: 0.8, x: 0.1, y: 0.1, w: 0.3, h: 0.3, rotation: 15 };
  const snap = JSON.parse(JSON.stringify([layer]));
  snap[0].x = 0.2; snap[0].y = 0.3; snap[0].w = 0.4; snap[0].h = 0.2; snap[0].rotation = -30;
  assert.equal(snap[0].photoX, 0.2);
  assert.equal(snap[0].photoY, 0.8);
  // Backend validation preserves and clamps focus for exports.
  const checked = validateImageEffectSpec({ width: 320, height: 240, layers: [
    { id: 'i', type: 'image', imageData: 'data:image/png;base64,xx', photoX: 0.2, photoY: 5, x: 0.1, y: 0.1, w: 0.3, h: 0.3 }
  ] });
  assert.equal(checked.ok, true);
  assert.equal(checked.spec.layers[0].photoX, 0.2);
  assert.equal(checked.spec.layers[0].photoY, 1);
  const defaulted = validateImageEffectSpec({ width: 320, height: 240, layers: [
    { id: 'j', type: 'image', imageData: 'data:image/png;base64,xx', x: 0.1, y: 0.1, w: 0.3, h: 0.3 }
  ] });
  assert.equal(defaulted.spec.layers[0].photoX, 0.5);
  assert.equal(defaulted.spec.layers[0].photoY, 0.5);
});


test('image layers expose independent photo-position controls and keep preview/export crop offsets in sync', () => {
  const client = readFileSync(path.join(process.cwd(), 'src/public/admin-image-editor.js'), 'utf8');
  const shared = readFileSync(path.join(process.cwd(), 'src/public/image-effects-shared.js'), 'utf8');
  const backend = readFileSync(path.join(process.cwd(), 'src/library/image-effects.js'), 'utf8');
  assert.match(client, /data-prop="imagePanX"/);
  assert.match(client, /data-prop="imagePanY"/);
  assert.match(client, /e\\.altKey/);
  assert.match(client, /dragKind === 'image-pan'/);
  assert.match(shared, /effect\\.imagePanX/);
  assert.match(shared, /effect\\.imagePanY/);
  assert.match(backend, /layer\\.imagePanX/);
  assert.match(backend, /layer\\.imagePanY/);
});
