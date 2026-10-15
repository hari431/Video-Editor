import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  zoomPreviewRect,
  zoomPaintStyle,
  findDominantZoomClip,
  getZoomState,
  easeZoomRamp,
  normalizeZoomEasing,
  ZOOM_EASINGS,
  DEFAULT_ZOOM_EASING,
  createProject,
  addFileEntry,
  appendMediaClip,
  addClip,
  duplicateClip,
  moveClip,
  resizeClip,
  splitOverlayClipAt,
  extendOverlayToVideoEnd,
  projectToSpecV2
} from '../src/public/video-editor-project.js';
import { buildZoomFilter, validateSpecV2 } from '../src/library/video-editor.js';

// --- Bug 1: off-center focus paints exactly the export window ---------------

test('zoom paint: centered region yields frame-tiling insets at multiple levels', () => {
  for (const level of [1.5, 2.0, 2.5, 3.0, 5.0, 8.0]) {
    const box = zoomPreviewRect({ level, x: 0.5, y: 0.5 });
    const paint = zoomPaintStyle(box, level);
    const nums = paint.objectViewBox.slice(6, -1).replace(/%/g, '').trim().split(/\s+/).map(Number);
    const [top, right, bottom, left] = nums.map(v => v / 100);
    assert.equal(left, top, `level ${level}: left == top (centered)`);
    assert.equal(right, bottom, `level ${level}: right == bottom (centered)`);
    assert.ok(Math.abs(left + box.w + right - 1) < 1e-4, `level ${level}: horizontal tiles`);
    assert.ok(Math.abs(top + box.h + bottom - 1) < 1e-4, `level ${level}: vertical tiles`);
  }
});

test('zoom paint: off-center focus selects the exact export window', () => {
  const cases = [
    { level: 2.0, x: 0.7, y: 0.3 },
    { level: 2.0, x: 0.25, y: 0.25 },
    { level: 3.0, x: 0.1, y: 0.9 },
    { level: 5.0, x: 0.85, y: 0.15 },
    { level: 8.0, x: 0.12, y: 0.88 },
    { level: 1.5, x: 0.8, y: 0.2 }
  ];
  for (const c of cases) {
    const box = zoomPreviewRect(c);
    const paint = zoomPaintStyle(box, c.level);
    // Parse inset(top right bottom left) back to fractions and compare.
    const nums = paint.objectViewBox.slice(6, -1).replace(/%/g, '').trim().split(/\s+/).map(Number);
    assert.equal(nums.length, 4, 'four inset values');
    const [top, right, bottom, left] = nums.map(v => v / 100);
    assert.ok(Math.abs(left - box.x) < 1e-9, `left matches box.x (L=${c.level} c=${c.x},${c.y})`);
    assert.ok(Math.abs(top - box.y) < 1e-9, `top matches box.y (L=${c.level} c=${c.x},${c.y})`);
    assert.ok(Math.abs(left + (100 - left * 100 - right * 100) / 100 + right - 1) < 1e-9, 'insets tile the frame');
    // Export rails for the same clamped center must equal the box.
    const st = getZoomState({ ...c, start: 0, end: 10, transition: 0 }, 5);
    const half = 1 / (2 * st.level);
    const exL = Math.min(Math.max(st.x - half, 0), 1 - 2 * half);
    assert.ok(Math.abs(box.x - exL) < 1e-4, `box matches export rail (L=${c.level} c=${c.x},${c.y})`);
  }
});

test('zoom paint: legacy fallback maps box edges onto the frame exactly', () => {
  // screen = s*c + t with t = -box*s (fractions of element size):
  // box left edge -> 0, box right edge -> element width, for any box/scale.
  const W = 1280;
  const boxes = [
    { box: zoomPreviewRect({ level: 2.0, x: 0.7, y: 0.3 }), s: 2.0 },
    { box: zoomPreviewRect({ level: 3.0, x: 0.1, y: 0.9 }), s: 3.0 },
    { box: zoomPreviewRect({ level: 5.0, x: 0.85, y: 0.15 }), s: 5.0 },
    { box: zoomPreviewRect({ level: 8.0, x: 0.12, y: 0.88 }), s: 8.0 },
    { box: zoomPreviewRect({ level: 1.5, x: 0.5, y: 0.5 }), s: 1.5 }
  ];
  for (const { box, s } of boxes) {
    const tx = -box.x * s * W;
    const ty = -box.y * s * W;
    const leftPx = s * (box.x * W) + tx;
    const rightPx = s * ((box.x + box.w) * W) + tx;
    const topPx = s * (box.y * W) + ty;
    // q4 box rounding leaves sub-pixel residue (bounded by s*W*5e-5).
    assert.ok(Math.abs(leftPx) < 1, 'left edge maps to 0');
    assert.ok(Math.abs(rightPx - W) < 1, 'right edge maps to frame width');
    assert.ok(Math.abs(topPx) < 1, 'top edge maps to 0');
    // Fallback string carries the same numbers.
    const paint = zoomPaintStyle(box, s);
    assert.ok(paint.transform.includes(`scale(${s})`), 'fallback scales');
    assert.ok(paint.transformOrigin === '0 0', 'fallback origin is 0 0');
  }
});

test('zoom paint: preview wiring uses object-view-box with fallback and clears it', () => {
  const jsSrc = readFileSync(path.join(process.cwd(), 'src/public/admin-video-editor.js'), 'utf8');
  assert.match(jsSrc, /objectViewBox/, 'zoom paint sets object-view-box');
  assert.match(jsSrc, /zoomPaintStyle/, 'paint math shared with tests');
  // All three paint branches (zoom / crop / plain) reset a stale window.
  const setCount = (jsSrc.match(/video\.style\.objectViewBox = /g) || []).length;
  assert.ok(setCount >= 3, `object-view-box assigned/cleared in every branch (found ${setCount})`);
  assert.ok(!jsSrc.includes(`transformOrigin = (zState.x * 100)`), 'old origin+scale paint removed');
});

test('zoom paint: layout untouched — video keeps its box, no wrapper added', () => {
  const ejsSrc = readFileSync(path.join(process.cwd(), 'src/views/admin-video-editor.ejs'), 'utf8');
  assert.match(ejsSrc, /<video id="previewVideo"[^>]*style="width:100%;display:block;"/, 'video layout style unchanged');
  const wrapIdx = ejsSrc.indexOf('id="previewWrap"');
  const videoIdx = ejsSrc.indexOf('id="previewVideo"');
  const between = ejsSrc.slice(wrapIdx, videoIdx);
  assert.ok(!/<div[^>]*id="previewVideoClip"/.test(between), 'no wrapper div inserted (layout identical)');
});

// --- Bug 2: one precedence rule everywhere -----------------------------------

function zclip(id, start, end, extra = {}) {
  return { id, type: 'zoom', start, end, level: 2.0, x: 0.5, y: 0.5, transition: 0.5, ...extra };
}

test('zoom precedence: later start wins regardless of insertion order', () => {
  const A = zclip('za', 2, 8);
  const B = zclip('zb', 5, 10);
  assert.equal(findDominantZoomClip([A, B], 6).id, 'zb', 'insertion A,B -> later start wins');
  assert.equal(findDominantZoomClip([B, A], 6).id, 'zb', 'insertion B,A -> later start wins');
  assert.equal(findDominantZoomClip([A, B], 3).id, 'za', 'outside overlap -> sole match');
  assert.equal(findDominantZoomClip([A, B], 9).id, 'zb', 'outside overlap -> sole match');
});

test('zoom precedence: shared boundary picks the later starter', () => {
  const A = zclip('za', 2, 5);
  const B = zclip('zb', 5, 8);
  assert.equal(findDominantZoomClip([A, B], 5).id, 'zb', 't=5 belongs to the incoming region');
  assert.equal(findDominantZoomClip([B, A], 5).id, 'zb', 'order-independent at the boundary');
});

test('zoom precedence: equal starts break by later end, then later position', () => {
  const short = zclip('zs', 2, 6);
  const long = zclip('zl', 2, 9);
  assert.equal(findDominantZoomClip([short, long], 4).id, 'zl', 'same start -> later end wins');
  assert.equal(findDominantZoomClip([long, short], 4).id, 'zl', 'same start -> later end wins either order');
  const d1 = zclip('zd1', 2, 6);
  const d2 = zclip('zd2', 2, 6);
  assert.equal(findDominantZoomClip([d1, d2], 4).id, 'zd2', 'full tie -> later position wins');
  assert.equal(findDominantZoomClip([d2, d1], 4).id, 'zd1', 'full tie -> later position wins (swapped)');
});

test('zoom precedence: no match, empty input, and non-zoom clips', () => {
  const A = zclip('za', 2, 8);
  assert.equal(findDominantZoomClip([A], 0), null, 'before all regions');
  assert.equal(findDominantZoomClip([A], 20), null, 'after all regions');
  assert.equal(findDominantZoomClip([], 5), null, 'empty list');
  assert.equal(findDominantZoomClip([{ id: 'b1', type: 'blur', start: 0, end: 10 }], 5), null, 'non-zoom ignored');
});

test('zoom precedence: preview rule matches FFmpeg export rule', () => {
  // Export nests start-sorted ifs (stable): later start wins; ties keep
  // (start,end)-sorted order, i.e. later end then later position wins.
  const orders = [
    [zclip('za', 2, 8), zclip('zb', 5, 10)],
    [zclip('zb', 5, 10), zclip('za', 2, 8)],
    [zclip('zs', 2, 6), zclip('zl', 2, 9)],
    [zclip('zl', 2, 9), zclip('zs', 2, 6)]
  ];
  for (const order of orders) {
    const winner = findDominantZoomClip(order, 6);
    const f = buildZoomFilter(
      order.map(z => ({ start: z.start, end: z.end, level: z.level, x: z.x, y: z.y, transition: 0.5 })),
      1280, 720, 30
    );
    // The winner's level must be the outermost (first-checked) branch.
    const firstLevel = f.match(/if\(between\(time,[\d.]+,[\d.]+\),if\(lt\(time,[\d.]+\+[\d.]+?\),1\.0\+\(([\d.]+)-1\.0\)/);
    assert.ok(firstLevel, 'zoompan has an outermost branch');
    assert.equal(Number(firstLevel[1]), winner.level, `export outermost == preview winner (${winner.id})`);
  }
});

test('zoom precedence: preview selection sites use the shared rule', () => {
  const jsSrc = readFileSync(path.join(process.cwd(), 'src/public/admin-video-editor.js'), 'utf8');
  assert.match(jsSrc, /findDominantZoomClip/, 'shared precedence helper wired');
  assert.ok(!/\.find\(function \(c\) \{ return c\.type === 'zoom'/.test(jsSrc), 'no first-match zoom selection remains');
});

// --- Phase 2: easing (independent cubic ramps, linear default) ----------------

// Executes the REAL z-expression generated by buildZoomFilter using an
// FFmpeg-eval shim (between/lt/gt/if/min/max/pow only — the same function
// set the filter is allowed to use).
function evalZoomExpr(segZExpr, t) {
  const between = (x, a, b) => (x >= a && x <= b ? 1 : 0);
  const lt = (a, b) => (a < b ? 1 : 0);
  const gt = (a, b) => (a > b ? 1 : 0);
  const IFF = (c, a, b) => (c ? a : b);
  const fn = new Function(
    'time', 'between', 'lt', 'gt', 'IFF', 'pow', 'min', 'max',
    `return (${segZExpr.replace(/\bif\(/g, 'IFF(')});`
  );
  return fn(t, between, lt, gt, IFF, Math.pow, Math.min, Math.max);
}

function zoomZExpr(easing) {
  const f = buildZoomFilter(
    [{ start: 2, end: 8, level: 2.0, x: 0.5, y: 0.5, transition: 1.0, easing }],
    1280, 720, 30
  );
  const zPart = f.split("':x='")[0].split("z='")[1];
  assert.ok(zPart && zPart.length > 0 && !zPart.includes("'"), 'z expression extracted cleanly');
  return zPart;
}

function mkZoomProject() {
  const project = createProject();
  addFileEntry(project, { kind: 'video', name: 'v1.mp4', duration: 30, width: 1280, height: 720 });
  appendMediaClip(project, project.files[0].id, 0);
  return project;
}

test('zoom easing: normalizer defaults and vocabulary', () => {
  assert.deepEqual(ZOOM_EASINGS, ['linear', 'ease-in', 'ease-out', 'ease-in-out']);
  assert.equal(DEFAULT_ZOOM_EASING, 'linear');
  assert.equal(normalizeZoomEasing(undefined), 'linear', 'missing defaults');
  assert.equal(normalizeZoomEasing(null), 'linear', 'null defaults');
  assert.equal(normalizeZoomEasing(''), 'linear', 'empty defaults');
  assert.equal(normalizeZoomEasing('bogus'), 'linear', 'invalid falls back safely');
  assert.equal(normalizeZoomEasing(' Ease-Out '), 'ease-out', 'case/whitespace tolerant');
});

test('zoom easing: ramp curves at unit fractions', () => {
  const at = (f, e) => easeZoomRamp(f, e);
  assert.equal(at(0, 'linear'), 0);
  assert.equal(at(1, 'linear'), 1);
  assert.equal(at(0.5, 'linear'), 0.5);
  assert.equal(at(0.5, 'ease-in'), 0.125, 'ease-in cubic: slow start');
  assert.equal(at(0.5, 'ease-out'), 0.875, 'ease-out cubic: fast start');
  assert.equal(at(0.5, 'ease-in-out'), 0.5, 'in-out midpoint exact');
  assert.ok(at(0.25, 'ease-in') < at(0.25, 'linear'), 'ease-in below linear early');
  assert.ok(at(0.25, 'ease-out') > at(0.25, 'linear'), 'ease-out above linear early');
  assert.ok(at(0.75, 'ease-in') < at(0.75, 'linear'), 'ease-in below linear late');
  assert.ok(at(0.75, 'ease-out') > at(0.75, 'linear'), 'ease-out above linear late');
  assert.equal(at(0, 'ease-in-out'), 0);
  assert.equal(at(1, 'ease-in-out'), 1);
  assert.equal(at(-2, 'ease-out'), 0, 'clamped below');
  assert.equal(at(99, 'ease-in'), 1, 'clamped above');
  assert.equal(at(NaN, 'linear'), 0, 'non-finite safe');
  assert.equal(at(0.5, 'nope'), 0.5, 'unknown easing behaves linear');
});

test('zoom easing: getZoomState curves across in, hold, and out', () => {
  const base = { start: 2, end: 8, level: 2.0, x: 0.5, y: 0.5, transition: 1.0 };
  const lv = (t, easing) => getZoomState({ ...base, easing }, t).level;
  // Outside and exact boundaries (all easings agree here).
  for (const e of ['linear', 'ease-in', 'ease-out', 'ease-in-out', undefined]) {
    assert.equal(lv(1.5, e), 1.0, `${e} before start`);
    assert.equal(lv(2.0, e), 1.0, `${e} at start`);
    assert.equal(lv(3.0, e), 2.0, `${e} at end of zoom-in`);
    assert.equal(lv(5.0, e), 2.0, `${e} hold`);
    assert.equal(lv(7.0, e), 2.0, `${e} at start of zoom-out`);
    assert.equal(lv(8.0, e), 1.0, `${e} at end`);
    assert.equal(lv(9.0, e), 1.0, `${e} after end`);
  }
  // Mid-transition shape per easing (zoom-in at t=2.5, zoom-out at t=7.5).
  assert.equal(lv(2.5, 'linear'), 1.5);
  assert.equal(lv(2.5, 'ease-in'), 1.125);
  assert.equal(lv(2.5, 'ease-out'), 1.875);
  assert.equal(lv(2.5, 'ease-in-out'), 1.5);
  assert.equal(lv(7.5, 'linear'), 1.5);
  assert.equal(lv(7.5, 'ease-in'), 1.125, 'out-ramp mirrors in-ramp');
  assert.equal(lv(7.5, 'ease-out'), 1.875, 'out-ramp mirrors in-ramp');
  assert.equal(lv(7.5, 'ease-in-out'), 1.5, 'out-ramp mirrors in-ramp');
  // Missing easing behaves exactly like linear.
  for (const t of [2.25, 2.75, 5, 7.25, 7.75]) {
    assert.equal(lv(t, undefined), lv(t, 'linear'), `legacy default at t=${t}`);
  }
});

test('zoom easing: JS preview matches generated FFmpeg expressions', () => {
  for (const easing of ['linear', 'ease-in', 'ease-out', 'ease-in-out']) {
    const expr = zoomZExpr(easing);
    for (let t = 1; t <= 9.001; t += 0.25) {
      const expected = getZoomState({ start: 2, end: 8, level: 2.0, x: 0.5, y: 0.5, transition: 1.0, easing }, t).level;
      const actual = evalZoomExpr(expr, t);
      assert.ok(Math.abs(actual - expected) < 1e-9, `${easing} parity at t=${t.toFixed(2)} (js=${expected}, expr=${actual})`);
    }
  }
});

test('zoom easing: linear graph keeps the historical formula; no-zoom empty', () => {
  const f = buildZoomFilter(
    [{ start: 2, end: 7, level: 2.0, x: 0.3, y: 0.4, transition: 0.5, easing: 'linear' }],
    1280, 720, 30
  );
  assert.ok(
    f.includes(`if(lt(time,2+0.5),1.0+(2-1.0)*(time-2)/0.5,if(gt(time,7-0.5),1.0+(2-1.0)*(7-time)/0.5,2))`),
    'linear formula verbatim'
  );
  assert.ok(!f.includes('pow('), 'linear uses no pow');
  assert.equal(buildZoomFilter([], 1280, 720, 30), '', 'no zooms -> empty filter');
  for (const easing of ['ease-in', 'ease-out', 'ease-in-out']) {
    const g = buildZoomFilter(
      [{ start: 2, end: 7, level: 2.0, x: 0.3, y: 0.4, transition: 0.5, easing }],
      1280, 720, 30
    );
    assert.ok(g.includes('pow('), `${easing} uses pow`);
    assert.ok(!g.includes('clamp('), `${easing} uses no clamp()`);
  }
});

test('zoom easing: server validation, legacy projects, and invalid values', () => {
  const good = {
    version: 2, width: 1280, height: 720,
    files: [{ kind: 'video' }],
    videoClips: [{ file: 0, sourceIn: 0, sourceOut: 10, start: 0, gain: 1 }],
    audioClips: [],
    zooms: [{ start: 1, end: 5, level: 2, x: 0.5, y: 0.5, transition: 0.5, easing: 'ease-in-out' }]
  };
  const checked = validateSpecV2(good);
  assert.equal(checked.ok, true);
  assert.equal(checked.spec.zooms[0].easing, 'ease-in-out', 'valid easing preserved');
  const legacy = structuredClone(good);
  delete legacy.zooms[0].easing;
  const checkedLegacy = validateSpecV2(legacy);
  assert.equal(checkedLegacy.ok, true);
  assert.equal(checkedLegacy.spec.zooms[0].easing, 'linear', 'missing easing defaults (legacy safe)');
  const weird = structuredClone(good);
  weird.zooms[0].easing = 'warp-speed';
  const checkedWeird = validateSpecV2(weird);
  assert.equal(checkedWeird.ok, true);
  assert.equal(checkedWeird.spec.zooms[0].easing, 'linear', 'invalid easing normalizes safely');
});

test('zoom easing: defaults, persistence, and clip operations preserve it', () => {
  const project = mkZoomProject();
  const clip = addClip(project, 'zoom', 2);
  assert.equal(clip.easing, 'linear', 'new clips default to linear');
  clip.easing = 'ease-out';
  clip.level = 2.0;
  const spec = projectToSpecV2(project);
  const entry = spec.zooms.find(z => Math.abs(z.start - clip.start) < 1e-9);
  assert.equal(entry.easing, 'ease-out', 'spec carries easing (save path)');
  const rechecked = validateSpecV2({ version: 2, width: 1280, height: 720, files: [{ kind: 'video' }], videoClips: [{ file: 0, sourceIn: 0, sourceOut: 30, start: 0, gain: 1 }], audioClips: [], zooms: [entry] });
  assert.equal(rechecked.ok, true);
  assert.equal(rechecked.spec.zooms[0].easing, 'ease-out', 'reload preserves easing');
  const dup = duplicateClip(project, clip.id);
  assert.equal(dup.easing, 'ease-out', 'duplicate preserves easing');
  const mound = mkZoomProject();
  const mclip = addClip(mound, 'zoom', 4);
  mclip.easing = 'ease-in';
  const moved = moveClip(mound, mclip.id, 6);
  assert.equal(moved.easing, 'ease-in', 'move preserves easing');
  const trimmed = resizeClip(mound, mclip.id, 'end', moved.end - 1);
  assert.equal(trimmed.easing, 'ease-in', 'trim preserves easing');
  const parts = splitOverlayClipAt(mound, mclip.id, moved.start + 0.5);
  assert.equal(parts[0].easing, 'ease-in', 'split halves preserve easing (a)');
  assert.equal(parts[1].easing, 'ease-in', 'split halves preserve easing (b)');
  const ext = extendOverlayToVideoEnd(mound, parts[1].id);
  assert.equal(ext.clip.easing, 'ease-in', 'extend preserves easing');
});

test('zoom easing: inspector exposes all four options', () => {
  const jsSrc = readFileSync(path.join(process.cwd(), 'src/public/admin-video-editor.js'), 'utf8');
  assert.match(jsSrc, /data-insp="zoomEasing"/, 'easing select in inspector');
  // Options render at runtime from this literal list.
  assert.match(jsSrc, /\['linear', 'ease-in', 'ease-out', 'ease-in-out'\]\.map\(function \(e0\)/, 'all four options generated');
  assert.match(jsSrc, /normalizeZoomEasing/, 'selection normalized on commit');
});
