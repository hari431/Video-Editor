import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEditSpec,
  validateSpecV2,
  buildFfmpegArgs,
  normalizeEditorWatermark,
  isValidWatermarkPosition,
  watermarkDrawtextFilter,
  EDITOR_WATERMARK_TEXT,
  EDITOR_WATERMARK_SIZE_FRAC,
  EDITOR_WATERMARK_COLOR,
  EDITOR_WATERMARK_OPACITY,
  EDITOR_WATERMARK_POSITIONS,
  EDITOR_WATERMARK_DEFAULT_POSITION,
  EDITOR_WATERMARK_MARGIN_FRAC
} from '../src/library/video-editor.js';
import {
  normalizeProjectWatermark,
  watermarkPreviewLayout,
  projectToSpecV2,
  createProject,
  WATERMARK_TEXT,
  WATERMARK_SIZE_FRAC,
  WATERMARK_COLOR,
  WATERMARK_OPACITY,
  WATERMARK_MARGIN_FRAC
} from '../src/public/video-editor-project.js';
import { resolveVideoWatermarkEnabled } from '../src/library/video-protection.js';

const FULL_DEFAULTS = {
  enabled: false, position: 1, text: 'Learn with me', size: 0.045, color: '#FFFFFF', opacity: 75
};

function baseSpec(overrides = {}) {
  return {
    videoWidth: 1280,
    videoHeight: 720,
    trim: null,
    blurs: [],
    texts: [],
    images: [],
    ...overrides
  };
}

function baseSpecV2(overrides = {}) {
  return {
    version: 2,
    width: 1280,
    height: 720,
    files: [{ kind: 'video' }],
    videoClips: [{ file: 0, sourceIn: 0, sourceOut: 4, start: 0, gain: 1 }],
    audioClips: [],
    blurs: [],
    texts: [],
    images: [],
    ...overrides
  };
}

const V2_MEDIA = { width: 1280, height: 720, hasAudio: [true] };

// --- Normalization ------------------------------------------------------------------
test('watermark: absent defaults OFF with full default settings (existing projects unchanged)', () => {
  assert.deepEqual(normalizeEditorWatermark(undefined), FULL_DEFAULTS);
  assert.deepEqual(normalizeEditorWatermark(null), FULL_DEFAULTS);
  assert.deepEqual(normalizeEditorWatermark(true), { ...FULL_DEFAULTS, enabled: true });
  assert.deepEqual(normalizeEditorWatermark(false), FULL_DEFAULTS);
  assert.deepEqual(normalizeEditorWatermark({ position: 4 }), { ...FULL_DEFAULTS, enabled: true, position: 4 });
  assert.deepEqual(normalizeEditorWatermark({ enabled: false }), FULL_DEFAULTS);
  assert.deepEqual(
    normalizeEditorWatermark({ enabled: true, position: 5, text: 'Studio', size: 0.1, color: '#ff0000', opacity: 50 }),
    { enabled: true, position: 5, text: 'Studio', size: 0.1, color: '#FF0000', opacity: 50 }
  );
  // Whitespace collapses in text; 3-digit hex normalizes.
  assert.equal(normalizeEditorWatermark({ text: '  A\nB  ' }).text, 'A B');
  assert.equal(normalizeEditorWatermark({ color: '#abc' }).color, '#AABBCC');
});

test('watermark: invalid shapes rejected', () => {
  for (const bad of [
    'yes', 1, 0, [], [1],
    { position: 0 }, { position: 6 }, { position: 'x' }, { enabled: 'yes' },
    { text: '' }, { text: '   ' }, { text: 'x'.repeat(201) },
    { size: 0.01 }, { size: 0.3 }, { size: 'big' },
    { color: 'red' }, { color: '#GGGGGG' },
    { opacity: 0 }, { opacity: 101 }, { opacity: 12.5 }, { opacity: 'high' }
  ]) {
    assert.equal(normalizeEditorWatermark(bad), null, `rejected: ${JSON.stringify(bad)}`);
  }
  assert.equal(isValidWatermarkPosition(1), true);
  assert.equal(isValidWatermarkPosition(5), true);
  assert.equal(isValidWatermarkPosition(6), false);
});

test('watermark: constants expose text, defaults and Options 1-5', () => {
  assert.equal(EDITOR_WATERMARK_TEXT, 'Learn with me');
  assert.equal(WATERMARK_TEXT, 'Learn with me');
  assert.deepEqual(EDITOR_WATERMARK_POSITIONS.map(p => p.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(EDITOR_WATERMARK_POSITIONS.map(p => p.label),
    ['Bottom-right', 'Top-left', 'Center', 'Top-right', 'Bottom-left']);
  assert.equal(EDITOR_WATERMARK_DEFAULT_POSITION, 1);
  // Client preview fractions mirror the server export fractions exactly.
  assert.equal(WATERMARK_SIZE_FRAC, EDITOR_WATERMARK_SIZE_FRAC);
  assert.equal(WATERMARK_MARGIN_FRAC, EDITOR_WATERMARK_MARGIN_FRAC);
  assert.equal(WATERMARK_COLOR, EDITOR_WATERMARK_COLOR);
  assert.equal(WATERMARK_OPACITY, EDITOR_WATERMARK_OPACITY);
});

// --- Spec validation -------------------------------------------------------------------
test('watermark: validateEditSpec defaults OFF; invalid values fail', () => {
  const r = validateEditSpec(baseSpec({ trim: { start: 0, end: 2 } }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.spec.watermark, FULL_DEFAULTS);
  assert.match(validateEditSpec(baseSpec({ watermark: { position: 9 } })).error, /watermark/);
  assert.match(validateEditSpec(baseSpec({ watermark: 'yes' })).error, /watermark/);
  assert.match(validateEditSpec(baseSpec({ watermark: { text: '' } })).error, /watermark/);
  assert.match(validateEditSpec(baseSpec({ watermark: { color: 'red' } })).error, /watermark/);
  assert.match(validateEditSpec(baseSpec({ watermark: { opacity: 0 } })).error, /watermark/);
  assert.match(validateEditSpec(baseSpec({ watermark: { size: 0.5 } })).error, /watermark/);
  // Empty legacy specs still fail (existing behavior preserved).
  assert.match(validateEditSpec(baseSpec()).error, /No edits/);
  // Enabled watermark alone counts as an edit (burn-only export allowed).
  const only = validateEditSpec({
    videoWidth: 1280, videoHeight: 720,
    watermark: { enabled: true, position: 5, text: 'Hi', size: 0.1, color: '#000000', opacity: 100 }
  });
  assert.equal(only.ok, true);
  assert.deepEqual(only.spec.watermark,
    { enabled: true, position: 5, text: 'Hi', size: 0.1, color: '#000000', opacity: 100 });
});

test('watermark: V2 validation threads the flag through', () => {
  // Note: V2 specs require at least one overlay entry (pre-existing rule —
  // the inner overlay check rejects overlay-free specs either way).
  const withBlur = { blurs: [{ mode: 'blur', x: 0.1, y: 0.1, w: 0.2, h: 0.2, start: 1, end: 3 }] };
  const r = validateEditSpec(baseSpecV2({ ...withBlur, watermark: { enabled: true, position: 4, text: 'T', opacity: 10 } }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.spec.watermark,
    { enabled: true, position: 4, text: 'T', size: 0.045, color: '#FFFFFF', opacity: 10 });
  assert.deepEqual(validateSpecV2(baseSpecV2(withBlur)).spec.watermark, FULL_DEFAULTS);
  assert.match(validateEditSpec(baseSpecV2({ ...withBlur, watermark: { position: 0 } })).error, /watermark/);
});

// --- FFmpeg builders ------------------------------------------------------------------------
test('watermark: OFF exports contain no brand drawtext (legacy graphs unchanged)', () => {
  const v1 = buildFfmpegArgs({
    inputPath: '/tmp/in.mp4', imagePaths: [], outputPath: '/tmp/out.mp4',
    spec: baseSpec({ trim: { start: 0, end: 2 } }), fontFile: null
  }).join(' ');
  assert.ok(!v1.includes('Learn with me'), 'no watermark filter when absent');
  const v2 = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4'], audioPaths: [], imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec: baseSpecV2({
      blurs: [{ mode: 'blur', x: 0.1, y: 0.1, w: 0.2, h: 0.2, start: 1, end: 3 }],
      watermark: { enabled: false }
    }),
    fontFile: null, media: V2_MEDIA
  }).join(' ');
  assert.ok(!v2.includes('Learn with me'), 'no watermark filter when explicitly OFF');
});

test('watermark: V1 burn-in positions render correct drawtext geometry', () => {
  // 1280x720 → FS=round(0.045*720)=32, M=max(8,round(0.02*720))=14.
  const build = watermark => buildFfmpegArgs({
    inputPath: '/tmp/in.mp4', imagePaths: [], outputPath: '/tmp/out.mp4',
    spec: baseSpec({ trim: { start: 0, end: 2 }, watermark }),
    fontFile: '/fonts/Arial.ttf'
  }).join(' ');
  const p1 = build({ enabled: true, position: 1 });
  assert.ok(p1.includes("text='Learn with me'"), 'default brand text burned in');
  assert.ok(p1.includes('fontsize=32'), 'proportional size');
  assert.ok(p1.includes('fontcolor=#FFFFFF@0.75'), 'default color and opacity');
  assert.ok(p1.includes('x=w-text_w-14:y=h-text_h-14'), 'Option 1 bottom-right');
  const p2 = build({ enabled: true, position: 2 });
  assert.ok(p2.includes('x=14:y=14'), 'Option 2 top-left');
  const p3 = build({ enabled: true, position: 3 });
  assert.ok(p3.includes('x=(w-text_w)/2:y=(h-text_h)/2'), 'Option 3 center');
  const p4 = build({ enabled: true, position: 4 });
  assert.ok(p4.includes('x=w-text_w-14:y=14'), 'Option 4 top-right');
  const p5 = build({ enabled: true, position: 5 });
  assert.ok(p5.includes('x=14:y=h-text_h-14'), 'Option 5 bottom-left');
  // Deterministic: identical specs produce identical graphs.
  assert.equal(build({ enabled: true, position: 1 }), build({ enabled: true, position: 1 }));
});

test('watermark: custom text/size/color/opacity reach the filter, escaped safely', () => {
  const out = buildFfmpegArgs({
    inputPath: '/tmp/in.mp4', imagePaths: [], outputPath: '/tmp/out.mp4',
    spec: baseSpec({
      trim: { start: 0, end: 2 },
      watermark: { enabled: true, position: 3, text: "It's live: 50%", size: 0.1, color: '#ff0000', opacity: 100 }
    }),
    fontFile: '/fonts/Arial.ttf'
  }).join(' ');
  assert.ok(out.includes("text='It\\'s live\\: 50%'"), 'text escaped for drawtext');
  assert.ok(out.includes('fontsize=72'), '0.1 * 720 = 72');
  assert.ok(out.includes('fontcolor=#FF0000@1'), 'normalized color, full opacity');
});

test('watermark: V2 burn-in matches V1 geometry', () => {
  const settings = { enabled: true, position: 4, text: 'T', size: 0.05, color: '#000000', opacity: 50 };
  const v1 = buildFfmpegArgs({
    inputPath: '/tmp/in.mp4', imagePaths: [], outputPath: '/tmp/out.mp4',
    spec: baseSpec({ trim: { start: 0, end: 2 }, watermark: settings }),
    fontFile: '/fonts/Arial.ttf'
  }).join(' ');
  const v2 = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4'], audioPaths: [], imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec: baseSpecV2({ watermark: settings }),
    fontFile: '/fonts/Arial.ttf', media: V2_MEDIA
  }).join(' ');
  const drawtextOf = joined => joined.match(/drawtext=[^[]*\[/)[0];
  assert.equal(drawtextOf(v2), drawtextOf(v1), 'identical filter on both pipelines');
});

test('watermark: missing font fails for watermark-only exports', () => {
  assert.throws(
    () => buildFfmpegArgs({
      inputPath: '/tmp/in.mp4', imagePaths: [], outputPath: '/tmp/out.mp4',
      spec: baseSpec({ watermark: true }), fontFile: null
    }),
    /font/
  );
});

test('watermark: shared filter builder validates inputs', () => {
  const good = { enabled: true, position: 1, text: 'T', size: 0.045, color: '#FFFFFF', opacity: 75 };
  assert.throws(() => watermarkDrawtextFilter({ width: 1280, height: 720, watermark: { ...good, position: 9 }, fontFile: '/f.ttf' }), /1, 2, 3, 4 or 5/);
  assert.throws(() => watermarkDrawtextFilter({ width: 1280, height: 720, watermark: good, fontFile: null }), /font file/);
  assert.throws(() => watermarkDrawtextFilter({ width: 0, height: 720, watermark: good, fontFile: '/f.ttf' }), /frame size/);
});

// --- Client project + preview parity -------------------------------------------------------------
test('watermark: project spec defaults OFF; invalid settings throw', () => {
  const p = createProject();
  p.files = [{ kind: 'video', width: 1280, height: 720 }];
  p.videoClips = [{ file: p.files[0], sourceIn: 0, sourceOut: 4, start: 0, gain: 1 }];
  const spec = projectToSpecV2(p);
  assert.deepEqual(spec.watermark, FULL_DEFAULTS);
  p.watermark = { enabled: true, position: 5, text: 'Hi', size: 0.1, color: '#000', opacity: 20 };
  assert.deepEqual(projectToSpecV2(p).watermark,
    { enabled: true, position: 5, text: 'Hi', size: 0.1, color: '#000000', opacity: 20 });
  p.watermark = { enabled: true, position: 7 };
  assert.throws(() => projectToSpecV2(p), /Invalid watermark settings/);
  p.watermark = { enabled: true, text: '' };
  assert.throws(() => projectToSpecV2(p), /Invalid watermark settings/);
  assert.deepEqual(normalizeProjectWatermark(undefined), FULL_DEFAULTS);
});

test('watermark: preview layout mirrors export geometry fractions', () => {
  // Export at 1280x720: FS=32, M=14. Preview at displayed 640x360 halves both.
  const l1 = watermarkPreviewLayout({ position: 1 }, 640, 360);
  assert.equal(l1.fontSizePx, 16);
  assert.equal(l1.right, 7);
  assert.equal(l1.bottom, 7);
  assert.equal(l1.centered, false);
  assert.equal(l1.text, 'Learn with me');
  assert.equal(l1.color, '#FFFFFF');
  assert.equal(l1.opacity01, 0.75);
  const l2 = watermarkPreviewLayout({ position: 2 }, 640, 360);
  assert.equal(l2.left, 7);
  assert.equal(l2.top, 7);
  const l3 = watermarkPreviewLayout({ position: 3 }, 640, 360);
  assert.equal(l3.centered, true);
  const l4 = watermarkPreviewLayout({ position: 4 }, 640, 360);
  assert.equal(l4.right, 7);
  assert.equal(l4.top, 7);
  const l5 = watermarkPreviewLayout({ position: 5 }, 640, 360);
  assert.equal(l5.left, 7);
  assert.equal(l5.bottom, 7);
  // Same fractions as the server filter at identical frame sizes.
  const full = watermarkPreviewLayout({ position: 1 }, 1280, 720);
  assert.equal(full.fontSizePx, Math.round(EDITOR_WATERMARK_SIZE_FRAC * 720));
  assert.equal(full.right, Math.max(8, Math.round(EDITOR_WATERMARK_MARGIN_FRAC * 720)));
  // Custom settings flow into the preview exactly as into the export.
  const custom = watermarkPreviewLayout(
    { position: 3, text: 'Hi', size: 0.1, color: '#ff0000', opacity: 50 }, 1280, 720);
  assert.equal(custom.text, 'Hi');
  assert.equal(custom.fontSizePx, 72);
  assert.equal(custom.color, '#FF0000');
  assert.equal(custom.opacity01, 0.5);
});

test('watermark: preview and export agree on one shared configuration', () => {
  // Colors enter the builder already normalized (validation layer does that,
  // exactly like text overlays) — so the settings here use canonical form.
  const settings = { enabled: true, position: 4, text: 'Demo!', size: 0.08, color: '#00FF00', opacity: 40 };
  const H = 720;
  const preview = watermarkPreviewLayout(settings, 1280, H);
  const filter = watermarkDrawtextFilter({ width: 1280, height: H, watermark: settings, fontFile: '/f.ttf' });
  assert.ok(filter.includes(`fontsize=${preview.fontSizePx}`), 'same pixel size');
  assert.ok(filter.includes(`fontcolor=#00FF00@0.4`), 'same normalized color and alpha');
  assert.ok(filter.includes(`text='Demo!'`), 'same text');
  assert.ok(filter.includes('x=w-text_w-') && preview.right !== null, 'same top-right corner');
});

// --- Editor UI wiring (static: EJS controls + client sync + preview) -------------------------------
test('watermark: editor UI exposes toggle, settings, preview and spec flow', async () => {  const { readFile } = await import('node:fs/promises');
  const ejs = await readFile(new URL('../src/views/admin-video-editor.ejs', import.meta.url), 'utf8');
  assert.ok(ejs.includes('data-testid="video-editor-watermark"'), 'ON/OFF toggle present');
  assert.ok(ejs.includes('data-testid="video-editor-watermark-position"'), 'position selector present');
  assert.ok(ejs.includes('data-testid="video-editor-watermark-text"'), 'text input present');
  assert.ok(ejs.includes('data-testid="video-editor-watermark-size"'), 'size input present');
  assert.ok(ejs.includes('data-testid="video-editor-watermark-color"'), 'color input present');
  assert.ok(ejs.includes('data-testid="video-editor-watermark-opacity"'), 'opacity input present');
  assert.ok(ejs.includes('Option 1: Bottom-right'), 'Option 1 labeled');
  assert.ok(ejs.includes('Option 2: Top-left'), 'Option 2 labeled');
  assert.ok(ejs.includes('Option 3: Center'), 'Option 3 labeled');
  assert.ok(ejs.includes('Option 4: Top-right'), 'Option 4 labeled');
  assert.ok(ejs.includes('Option 5: Bottom-left'), 'Option 5 labeled');
  assert.ok(ejs.includes('Watermark: false'), 'duplicate-avoidance hint present');
  const client = await readFile(new URL('../src/public/admin-video-editor.js', import.meta.url), 'utf8');
  assert.ok(client.includes('syncWatermarkFromUI'), 'UI state syncs into the project');
  assert.ok(client.includes('watermarkPreviewLayout'), 'preview uses the shared layout helper');
  assert.ok(client.includes('video-editor-watermark-preview'), 'preview element marked for tests');
});

// --- Duplicate-avoidance pairing ----------------------------------------------------------------------
test('watermark: burned-in export pairs with a site overlay opt-out', () => {
  // Export half: watermark ON burns the brand text into the file.
  const exported = buildFfmpegArgs({
    inputPath: '/tmp/in.mp4', imagePaths: [], outputPath: '/tmp/out.mp4',
    spec: baseSpec({ trim: { start: 0, end: 2 }, watermark: { enabled: true, position: 1 } }),
    fontFile: '/fonts/Arial.ttf'
  }).join(' ');
  assert.ok(exported.includes("text='Learn with me'"), 'export carries the burned-in brand');
  // Site half (linked video): External Watermark:false suppresses the overlay.
  assert.equal(resolveVideoWatermarkEnabled({ fileWatermark: false, protectionEnabled: true }), false);
  assert.equal(resolveVideoWatermarkEnabled({ fileWatermark: false, protectionEnabled: false }), false);
  // Site half (library video): branding enabled:false hides the brand overlay.
  // (Covered structurally by video-branding tests; the store default stays enabled.)
});

test('watermark: every setting refreshes preview + spec independently (no position touch needed)', async () => {
  const { readFile } = await import('node:fs/promises');
  const ejs = await readFile(new URL('../src/views/admin-video-editor.ejs', import.meta.url), 'utf8');
  for (const id of ['veWatermark', 'veWatermarkPosition', 'veWatermarkText', 'veWatermarkSize', 'veWatermarkColor', 'veWatermarkOpacity']) {
    assert.ok(ejs.includes(`id="${id}"`), `control #${id} rendered`);
  }
  const client = await readFile(new URL('../src/public/admin-video-editor.js', import.meta.url), 'utf8');
  assert.ok(client.includes('function onWatermarkSettingChanged'), 'single shared refresh handler');
  // Toggle + position commit on change; text/size/color/opacity refresh live on input.
  const expectations = [
    ['veWatermark', 'change'],
    ['veWatermarkPosition', 'change'],
    ['veWatermarkText', 'input'],
    ['veWatermarkSize', 'input'],
    ['veWatermarkColor', 'input'],
    ['veWatermarkOpacity', 'input']
  ];
  for (const [id, event] of expectations) {
    const re = new RegExp(`\\$\\('${id}'\\)[\\s\\S]{0,120}?addEventListener\\('${event}'`);
    assert.ok(re.test(client), `#${id} refreshes on ${event}`);
  }
  // Every watermark listener funnels through sync + preview (no stale caches,
  // no position-dependent refresh).
  const handlerUses = (client.match(/onWatermarkSettingChanged/g) || []).length;
  assert.ok(handlerUses >= 1 + expectations.length, 'all six controls share the sync+preview handler');
  assert.ok(client.includes('function syncWatermarkFromUI'), 'sync reads every watermark field');
  for (const field of ['veWatermarkText', 'veWatermarkSize', 'veWatermarkColor', 'veWatermarkOpacity', 'veWatermarkPosition']) {
    assert.ok(client.includes(`$('${field}')`), `sync reads ${field}`);
  }
});
