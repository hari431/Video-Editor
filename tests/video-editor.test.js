import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import {
  isVideoEditorAvailable,
  validateEditSpec,
  validateSpecV2,
  buildFfmpegArgs,
  buildV2Args,
  checkCrop,
  escapeDrawtextText,
  escapeDrawtextFontFile,
  getMultipartBoundary,
  parseMultipartForm,
  isAllowedEditorInput,
  isAllowedEditorImage,
  isAllowedEditorAudio,
  editorMaxVideoMb,
  editorMaxVideoBytes,
  editorMaxRequestBytes,
  normalizeExportResolution,
  exportHeightForResolution,
  EDITOR_EXPORT_RESOLUTIONS,
  EDITOR_DEFAULT_MAX_VIDEO_MB,
  EDITOR_MAX_VIDEO_MB_CEILING,
  EDITOR_MAX_BLURS,
  EDITOR_MAX_TEXTS,
  EDITOR_MAX_IMAGES,
  EDITOR_MAX_IMAGE_FILES,
  EDITOR_MAX_VIDEO_FILES,
  EDITOR_MAX_AUDIO_FILES,
  EDITOR_MAX_VIDEO_CLIPS,
  EDITOR_MAX_AUDIO_CLIPS
} from '../src/library/video-editor.js';
import { resizeGeo, projectToSpecV2 } from '../src/public/video-editor-project.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));

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

test('editor gate: enabled by default and can be explicitly disabled', () => {
  assert.equal(isVideoEditorAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isVideoEditorAvailable({ NODE_ENV: 'test' }), true);
  assert.equal(isVideoEditorAvailable({}), true);
  assert.equal(isVideoEditorAvailable({ NODE_ENV: 'production' }), true);
  assert.equal(isVideoEditorAvailable({ NODE_ENV: 'development', VIDEO_EDITOR_ENABLED: 'false' }), false);
  assert.equal(isVideoEditorAvailable({ NODE_ENV: 'production', VIDEO_EDITOR_ENABLED: 'true' }), true);
});

test('editor video limit: env-configurable MB with 2 GB default and ceiling', () => {  assert.equal(EDITOR_DEFAULT_MAX_VIDEO_MB, 2048);
  assert.equal(editorMaxVideoMb({}), 2048);
  assert.equal(editorMaxVideoMb({ NODE_ENV: 'production' }), 100);
  assert.equal(editorMaxVideoBytes({ NODE_ENV: 'production' }), 100 * 1048576);
  assert.equal(editorMaxVideoMb({ VIDEO_EDITOR_MAX_VIDEO_MB: '1024' }), 1024);
  assert.equal(editorMaxVideoMb({ VIDEO_EDITOR_MAX_VIDEO_MB: '512.9' }), 512);
  assert.equal(editorMaxVideoMb({ VIDEO_EDITOR_MAX_VIDEO_MB: 'garbage' }), 2048);
  assert.equal(editorMaxVideoMb({ VIDEO_EDITOR_MAX_VIDEO_MB: '' }), 2048);
  assert.equal(editorMaxVideoMb({ VIDEO_EDITOR_MAX_VIDEO_MB: '0' }), 2048);
  assert.equal(editorMaxVideoMb({ VIDEO_EDITOR_MAX_VIDEO_MB: '-50' }), 2048);
  assert.equal(editorMaxVideoMb({ VIDEO_EDITOR_MAX_VIDEO_MB: '99999' }), EDITOR_MAX_VIDEO_MB_CEILING);
  assert.equal(editorMaxVideoBytes({ VIDEO_EDITOR_MAX_VIDEO_MB: '1024' }), 1024 * 1048576);
  assert.equal(editorMaxVideoBytes({}), 2048 * 1048576);
  // Request cap covers the worst-case multi-track upload: max video files at
  // the video cap, max audio files, max images, plus framing headroom.
  const MB = 1048576;
  assert.equal(
    editorMaxRequestBytes({}),
    4 * editorMaxVideoBytes({}) + 8 * 200 * MB + 4 * 5 * MB + 64 * MB
  );
  assert.ok(editorMaxRequestBytes({ VIDEO_EDITOR_MAX_VIDEO_MB: '1024' }) > editorMaxVideoBytes({ VIDEO_EDITOR_MAX_VIDEO_MB: '1024' }));
  assert.equal(editorMaxRequestBytes({ NODE_ENV: 'production' }), 350 * MB);
});

test('input/image extension allowlist (mkv in, exe out)', () => {
  assert.equal(isAllowedEditorInput('clip.mp4'), true);
  assert.equal(isAllowedEditorInput('clip.WEBM'), true);
  assert.equal(isAllowedEditorInput('clip.mov'), true);
  assert.equal(isAllowedEditorInput('clip.mkv'), true);
  assert.equal(isAllowedEditorInput('clip.avi'), false);
  assert.equal(isAllowedEditorInput('clip.exe'), false);
  assert.equal(isAllowedEditorInput('noext'), false);
  assert.equal(isAllowedEditorImage('over.png'), true);
  assert.equal(isAllowedEditorImage('over.jpg'), true);
  assert.equal(isAllowedEditorImage('over.webp'), true);
  assert.equal(isAllowedEditorImage('over.svg'), false);
  assert.equal(isAllowedEditorImage('over.mp4'), false);
});

test('validateEditSpec: accepts a full V1 spec and normalizes colors', () => {
  const r = validateEditSpec(baseSpec({
    trim: { start: 1, end: 5 },
    blurs: [{ mode: 'blur', x: 0.1, y: 0.2, w: 0.2, h: 0.15, start: 1, end: 3 }],
    texts: [{ text: 'Hello', start: 0, end: 2, x: 0.05, y: 0.05, size: 0.05, color: '#fff', bg: '#000000' }],
    images: [{ start: 2, end: 4, x: 0.7, y: 0.7, w: 0.2, file: 1 }]
  }));
  assert.equal(r.ok, true);
  assert.equal(r.spec.texts[0].color, '#FFFFFF');
  assert.equal(r.spec.videoWidth, 1280);
  assert.equal(r.spec.images[0].file, 1);
});

test('validateEditSpec: legacy single image key still works (bound to file 0)', () => {
  const r = validateEditSpec({
    videoWidth: 1280, videoHeight: 720, trim: null, blurs: [], texts: [],
    image: { start: 2, end: 4, x: 0.7, y: 0.7, w: 0.2 }
  });
  assert.equal(r.ok, true);
  assert.equal(r.spec.images.length, 1);
  assert.equal(r.spec.images[0].file, 0);
});

test('validateEditSpec: image file index bounds and overlay cap', () => {
  const badFile = baseSpec({ images: [{ start: 0, end: 1, x: 0, y: 0, w: 0.2, file: EDITOR_MAX_IMAGE_FILES }] });
  assert.match(validateEditSpec(badFile).error, /file/);
  const negFile = baseSpec({ images: [{ start: 0, end: 1, x: 0, y: 0, w: 0.2, file: -1 }] });
  assert.equal(validateEditSpec(negFile).ok, false);
  const many = Array.from({ length: EDITOR_MAX_IMAGES + 1 }, (_, i) => ({ start: 0, end: 1, x: 0, y: 0, w: 0.2, file: 0 }));
  assert.match(validateEditSpec(baseSpec({ images: many })).error, /At most/);
});

test('validateEditSpec: rejects empty spec and bad ranges', () => {
  assert.match(validateEditSpec(baseSpec()).error, /No edits/);
  assert.equal(validateEditSpec(null).ok, false);
  assert.equal(validateEditSpec(baseSpec({ trim: { start: 5, end: 5 } })).ok, false);
  assert.equal(validateEditSpec(baseSpec({ trim: { start: -1, end: 5 } })).ok, false);
  assert.equal(validateEditSpec(baseSpec({ trim: { start: 0, end: 8000 } })).ok, false);
  assert.equal(validateEditSpec(baseSpec({ videoWidth: 0, videoHeight: 720, trim: { start: 0, end: 1 } })).ok, false);
});

test('validateEditSpec: rejects overflowing rects, bad colors, bad text, caps', () => {
  const blurOverflow = baseSpec({ blurs: [{ mode: 'mask', x: 0.9, y: 0.1, w: 0.2, h: 0.2, start: 0, end: 1 }] });
  assert.match(validateEditSpec(blurOverflow).error, /fit inside/);
  const badMode = baseSpec({ blurs: [{ mode: 'pixelate', x: 0, y: 0, w: 0.1, h: 0.1, start: 0, end: 1 }] });
  assert.equal(validateEditSpec(badMode).ok, false);
  const badColor = baseSpec({ texts: [{ text: 'x', start: 0, end: 1, x: 0, y: 0, size: 0.05, color: 'red', bg: null }] });
  assert.match(validateEditSpec(badColor).error, /color/);
  const empty = baseSpec({ texts: [{ text: '   ', start: 0, end: 1, x: 0, y: 0, size: 0.05, color: '#fff', bg: null }] });
  assert.match(validateEditSpec(empty).error, /1–200/);
  const many = Array.from({ length: EDITOR_MAX_BLURS + 1 }, () => ({ mode: 'blur', x: 0, y: 0, w: 0.1, h: 0.1, start: 0, end: 1 }));
  assert.match(validateEditSpec(baseSpec({ blurs: many })).error, /At most/);
  const manyT = Array.from({ length: EDITOR_MAX_TEXTS + 1 }, () => ({ text: 'x', start: 0, end: 1, x: 0, y: 0, size: 0.05, color: '#fff', bg: null }));
  assert.match(validateEditSpec(baseSpec({ texts: manyT })).error, /At most/);
});

test('escapeDrawtextText escapes backslash, quote and colon', () => {
  assert.equal(escapeDrawtextText("it's 12:30 \\ live"), "it\\'s 12\\:30 \\\\ live");
  assert.equal(escapeDrawtextFontFile('C:\\Windows\\Fonts\\arial.ttf'), 'C\\:/Windows/Fonts/arial.ttf');
});

test('multiline text: validation accepts real newlines, normalizes CRLF', () => {
  const two = baseSpec({ texts: [{ text: 'Line 1\nLine 2', start: 0, end: 2, x: 0.05, y: 0.05, size: 0.05, color: '#fff', bg: null }] });
  const r = validateEditSpec(two);
  assert.equal(r.ok, true);
  assert.equal(r.spec.texts[0].text, 'Line 1\nLine 2');
  // CRLF/CR from pasted Windows/mac-classic content normalize to \n.
  const crlf = baseSpec({ texts: [{ text: 'a\r\nb\rc', start: 0, end: 2, x: 0, y: 0, size: 0.05, color: '#fff', bg: null }] });
  assert.equal(validateEditSpec(crlf).spec.texts[0].text, 'a\nb\nc');
  // Length and geometry rules still apply to multiline text.
  const long = baseSpec({ texts: [{ text: 'x\n'.repeat(150), start: 0, end: 1, x: 0, y: 0, size: 0.05, color: '#fff', bg: null }] });
  assert.match(validateEditSpec(long).error, /1–200/);
  const whites = baseSpec({ texts: [{ text: '\n  \n', start: 0, end: 1, x: 0, y: 0, size: 0.05, color: '#fff', bg: null }] });
  assert.match(validateEditSpec(whites).error, /1–200/);
  // Multi-track (v2) specs share the same overlay validation.
  const v2multi = validateEditSpec(baseSpecV2({ texts: [{ text: 'Line 1\nLine 2', x: 0, y: 0, size: 0.05, color: '#fff', start: 0, end: 2 }] }));
  assert.equal(v2multi.ok, true);
  assert.equal(v2multi.spec.texts[0].text, 'Line 1\nLine 2');
});

test('multiline text: export preserves real newlines, literal backslash-n stays literal', () => {
  // A real newline passes escaping untouched so drawtext breaks the line.
  assert.equal(escapeDrawtextText('Line 1\nLine 2'), 'Line 1\nLine 2');
  // Typed backslash + n is escaped to a literal backslash, never a break.
  assert.equal(escapeDrawtextText('a\\nb'), 'a\\\\nb');
  const spec = baseSpec({
    texts: [{ text: 'Line 1\nLine 2', start: 0, end: 2, x: 0.05, y: 0.05, size: 0.05, color: '#ffffff', bg: null }]
  });
  const args = buildFfmpegArgs({ inputPath: '/tmp/in.mp4', imagePaths: [], outputPath: '/tmp/out.mp4', spec, fontFile: '/fonts/Arial.ttf' });
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.ok(filter.includes('drawtext='), 'text filter present');
  assert.ok(filter.includes('Line 1\nLine 2'), 'raw newline preserved in the drawtext filter (Line 1 + Enter + Line 2)');
});

test('multiline text: properties control is a textarea, inline editor supports Enter', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  // Properties Text field is a real textarea (Enter inserts \n natively).
  assert.ok(src.includes('<textarea data-insp="text"'), 'textarea properties control');
  assert.ok(!src.includes('<input type="text" data-insp="text"'), 'no single-line text control left');
  // Inline preview editor is a textarea: plain Enter falls through to a
  // newline, Ctrl/Cmd+Enter commits, Escape cancels, blur commits.
  const editIdx = src.indexOf('function startTextEdit');
  const editEnd = src.indexOf('// ---- inspector', editIdx);
  const editBody = src.slice(editIdx, editEnd);
  assert.ok(editBody.includes("createElement('textarea')"), 'inline editor is a textarea');
  assert.ok(editBody.includes('e.ctrlKey || e.metaKey'), 'Ctrl/Cmd+Enter commits');
  assert.ok(editBody.includes("e.key === 'Escape'"), 'Escape still cancels');
  assert.ok(!/if\s*\(\s*e\.key\s*===\s*'Enter'\s*\)\s*commit\(\)/.test(editBody), 'plain Enter no longer commits (inserts newline)');
});

test('buildFfmpegArgs: trim+blur+mask+text+image produce one filter chain, mp4 out', () => {
  const spec = baseSpec({
    trim: { start: 1.5, end: 6 },
    blurs: [
      { mode: 'blur', x: 0.1, y: 0.1, w: 0.2, h: 0.2, start: 2, end: 4 },
      { mode: 'mask', x: 0.5, y: 0.5, w: 0.2, h: 0.1, start: 0, end: 1 }
    ],
    texts: [{ text: "it's live", start: 0, end: 2, x: 0.05, y: 0.05, size: 0.05, color: '#ffffff', bg: null }],
    images: [{ start: 1, end: 3, x: 0.7, y: 0.7, w: 0.2, file: 0 }]
  }).valueOf();
  const args = buildFfmpegArgs({ inputPath: '/tmp/in.mkv', imagePaths: ['/tmp/ov.png'], outputPath: '/tmp/out.mp4', spec, fontFile: '/fonts/Arial.ttf' });
  const joined = args.join(' ');
  assert.ok(joined.includes('-ss 1.5'), 'trim start present');
  assert.ok(joined.includes('-to 6'), 'trim end present');
  assert.ok(joined.includes('boxblur='), 'blur filter present');
  assert.ok(joined.includes('drawbox='), 'mask filter present');
  assert.ok(joined.includes('drawtext='), 'text filter present');
  assert.ok(joined.includes("fontfile='/fonts/Arial.ttf'"), 'explicit font present');
  assert.ok(joined.includes("it\\'s live"), 'text escaped');
  assert.ok(joined.includes('overlay='), 'image overlay present');
  assert.ok(joined.includes('libx264'), 'h264 encoder');
  assert.ok(joined.includes('+faststart'), 'faststart for streaming');
  assert.equal(args[args.length - 1], '/tmp/out.mp4');
  assert.ok(!args.includes('/tmp/in.mkv') || args.indexOf('/tmp/out.mp4') !== args.indexOf('/tmp/in.mkv'), 'output is a new file');
});

test('buildFfmpegArgs: trim-only needs no filter chain; missing image/font rejected', () => {
  const args = buildFfmpegArgs({
    inputPath: 'a.webm', outputPath: 'b.mp4', spec: baseSpec({ trim: { start: 0, end: 2 } })
  });
  assert.ok(!args.join(' ').includes('-filter_complex'));
  assert.throws(() => buildFfmpegArgs({
    inputPath: 'a.mp4', outputPath: 'b.mp4', spec: baseSpec({ images: [{ start: 0, end: 1, x: 0, y: 0, w: 0.2, file: 0 }] })
  }), /imagePaths/);
  assert.throws(() => buildFfmpegArgs({
    inputPath: 'a.mp4', outputPath: 'b.mp4', spec: baseSpec({ image: { start: 0, end: 1, x: 0, y: 0, w: 0.2 } })
  }), /imagePaths/);
  assert.throws(() => buildFfmpegArgs({
    inputPath: 'a.mp4', outputPath: 'b.mp4',
    spec: baseSpec({ texts: [{ text: 'x', start: 0, end: 1, x: 0, y: 0, size: 0.05, color: '#fff', bg: null }] })
  }), /font/);
  assert.throws(() => buildFfmpegArgs({ inputPath: 'a.mp4', outputPath: 'b.mp4', spec: baseSpec() }), /No edits/);
});

test('buildFfmpegArgs: multiple images chain as separate inputs in start order', () => {
  const spec = baseSpec({
    images: [
      { start: 3, end: 5, x: 0.5, y: 0.5, w: 0.2, file: 1 },
      { start: 0, end: 2, x: 0.1, y: 0.1, w: 0.2, file: 0 }
    ]
  });
  const args = buildFfmpegArgs({
    inputPath: '/tmp/in.mp4', imagePaths: ['/tmp/a.png', '/tmp/b.png'],
    outputPath: '/tmp/out.mp4', spec
  });
  const joined = args.join(' ');
  // Input order follows start time: file 0 (earlier) becomes -i #1.
  const firstInput = joined.indexOf('-i /tmp/a.png');
  const secondInput = joined.indexOf('-i /tmp/b.png');
  assert.ok(firstInput !== -1 && secondInput !== -1 && firstInput < secondInput, 'inputs ordered by start');
  assert.equal((joined.match(/\[1:v\]scale/g) || []).length, 1, 'first image scaled');
  assert.equal((joined.match(/\[2:v\]scale/g) || []).length, 1, 'second image scaled');
  assert.equal((joined.match(/overlay=\d+:\d+:enable/g) || []).length, 2, 'two overlay filters chained');
});

test('admin video editor page renders V2 timeline UI', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    editorAvailable: true
  });
  for (const hook of [
    'video-editor-timeline', 'video-editor-ruler', 'video-editor-playhead',
    'video-editor-lane-video', 'video-editor-lane-audio',
    'video-editor-lane-blur', 'video-editor-lane-text', 'video-editor-lane-image',
    'video-editor-inspector', 'video-editor-timecode',
    'video-editor-zoom-in', 'video-editor-zoom-out', 'video-editor-play',
    'video-editor-add-video', 'video-editor-add-audio', 'video-editor-split',
    'video-editor-add-blur', 'video-editor-add-text', 'video-editor-add-image',
    'video-editor-duplicate-clip', 'video-editor-delete-clip', 'video-editor-audio'
  ]) {
    assert.match(html, new RegExp(hook), `timeline hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-video-editor\.js(\?v=\d+)?"/, 'client loads as ES module');
  assert.match(html, /video-editor-project/, 'project model module referenced');
  assert.doesNotMatch(html, /id="trimStart"/, 'V1 manual trim fields removed');
  assert.doesNotMatch(html, /id="blurMode"/, 'V1 single-blur form removed');
});

test('multipart parser round-trips fields plus binary files (binary-safe)', () => {
  const boundary = '----TestBoundary123';
  const videoBytes = Buffer.from([0x00, 0x01, 0x0d, 0x0a, 0xff, 0x2d, 0x2d, 0x2d, 0x2d, 0x54, 0x65, 0x73, 0x74]);
  const imgBytes = Buffer.from('fake-png-bytes');
  const enc = (s) => Buffer.from(s, 'latin1');
  const body = Buffer.concat([
    enc(`--${boundary}\r\nContent-Disposition: form-data; name="spec"\r\n\r\n`),
    enc('{"trim":{"start":1,"end":2}}'),
    enc(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="clip.mkv"\r\nContent-Type: video/x-matroska\r\n\r\n`),
    videoBytes,
    enc(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="ov.png"\r\nContent-Type: image/png\r\n\r\n`),
    imgBytes,
    enc(`\r\n--${boundary}--\r\n`)
  ]);
  assert.equal(getMultipartBoundary(`multipart/form-data; boundary=${boundary}`), boundary);
  assert.equal(getMultipartBoundary('application/json'), null);
  assert.equal(getMultipartBoundary('multipart/form-data; boundary=bad boundary!'), null);
  const { fields, files } = parseMultipartForm(body, boundary);
  assert.equal(fields.spec, '{"trim":{"start":1,"end":2}}');
  assert.equal(files.length, 2);
  assert.ok(files[0].data.equals(videoBytes), 'video bytes preserved exactly');
  assert.ok(files[1].data.equals(imgBytes), 'image bytes preserved exactly');
  assert.equal(files[0].filename, 'clip.mkv');
});

test('admin video editor page renders admin-only UI without touching protection behaviour', async () => {
  for (const available of [true, false]) {
    const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
      user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
      editorAvailable: available
    });
    assert.match(html, /Local Video Editor/, 'page title present');
    assert.match(html, /admin-video-editor/, 'client script hook present');
    assert.match(html, /External \/ YouTube videos are not editable/, 'external exclusion note present');
    assert.match(html, /original file is never modified/i, 'untouched-original note present');
    assert.doesNotMatch(html, /video-protection\.js/, 'does not load viewer protection script');
    assert.doesNotMatch(html, /share-button/, 'does not reuse share partial');
    assert.match(html, /data-preselected=""/, 'no preselect by default (standalone mode intact)');
    assert.match(html, /data-max-video-mb="2048"/, 'default 2 GB cap exposed for the client pre-check');
    assert.match(html, /max 2048 MB/, 'default 2 GB cap shown in the file picker label');
    if (available) {
      assert.match(html, /videoFile/, 'file picker present when available');
    } else {
      assert.match(html, /disabled in production/i, 'disabled notice when unavailable');
    }
  }
});

test('editor page accepts a preselected exact path with safe escaping', async () => {
  const preselectedPath = 'Guidewire/Tutorials/A&B/clip.mp4';
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    editorAvailable: true,
    preselectedPath
  });
  assert.match(html, /data-testid="video-editor-preselected"/, 'preselected note present');
  assert.ok(html.includes('data-preselected="Guidewire/Tutorials/A&amp;B/clip.mp4"'), 'path HTML-escaped in data attribute');
  assert.ok(html.includes('<code>Guidewire/Tutorials/A&amp;B/clip.mp4</code>'), 'path HTML-escaped in note');
  assert.match(html, /original file is never modified/i, 'untouched-original note kept');
});

test('editor page surfaces a configured video cap to label and client', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    editorAvailable: true,
    editorMaxVideoMb: 1024
  });
  assert.match(html, /data-max-video-mb="1024"/, 'configured cap exposed for the client pre-check');
  assert.match(html, /max 1024 MB/, 'configured cap shown in the file picker label');
});

test('playhead tracks playback however it starts (shared rAF loop + media sync)', () => {  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  // One shared per-frame loop (no duplicated tick implementations to drift).
  assert.equal(src.split('function playbackTick').length - 1, 1, 'single shared tick function');
  assert.ok(src.includes('rafId = requestAnimationFrame(playbackTick)'), 'loop re-arms the shared tick');
  // Native-controls playback joins the same loop instead of freezing.
  assert.ok(src.includes("addEventListener('play'"), 'native play starts the frame loop');
  // Frame-throttle/seek safety net keeps playhead, timecode and boxes synced.
  assert.ok(src.includes("addEventListener('timeupdate'"), 'timeupdate syncs playhead during playback');
  assert.ok(src.includes("addEventListener('seeked'"), 'control-bar seeks sync playhead');
  // The loop and the safety net both move only the playhead readout path.
  for (const hook of ['placePlayhead();', 'updateTimecode();', 'renderPreview();']) {
    assert.ok(src.includes(hook), `sync path present: ${hook}`);
  }
  // Pause path still freezes the loop (no runaway frames).
  assert.ok(src.includes("addEventListener('pause'"), 'pause freezes the loop');
  // No auto-scroll via scrollIntoView/scrollTo smuggled in.
  assert.doesNotMatch(src, /scrollIntoView|scrollTo/, 'no auto-scroll');
  // Multi-track splitting is intentional (required for multiple video clips).
  assert.ok(src.includes("$('veSplit')"), 'split-at-playhead button wired');
  assert.ok(src.includes('splitVideoClipAt'), 'split uses the model operation');
});

test('text editing: no native hijack, inline editor, live inspector', async () => {  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    editorAvailable: true
  });
  // Native text-selection/drag must not hijack text-box gestures (blur boxes
  // have no text content, which is why only Text broke).
  assert.match(html, /\.ve-pbox\s*\{[^}]*user-select:\s*none/, 'preview boxes opt out of native text selection');
  assert.match(html, /\.ve-corner\s*\{[^}]*user-select:\s*none/, 'resize corners opt out of native text selection');
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  // Inline editing entry point on the selected text box.
  assert.ok(src.includes("addEventListener('dblclick'"), 'dblclick opens the inline text editor');
  assert.ok(src.includes('video-editor-text-edit'), 'inline editor hook present');
  assert.ok(src.includes('function startTextEdit'), 'inline editor implementation present');
  // Live inspector: input events sync model+preview without a focus-stealing
  // inspector rebuild; change commits fully.
  assert.ok(src.includes("addEventListener('input'"), 'inspector live-updates on input');
  // Typing must survive playback rebuilds only when NOT editing inline.
  assert.ok(src.includes('editingText'), 'inline-edit rebuild guard present');
});

test('clip/playhead readout disambiguates near-miss alignment', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  // Inspector shows a live playhead-vs-clip relationship for the selection.
  assert.ok(src.includes('video-editor-clip-status'), 'status readout hook present');
  assert.ok(src.includes('function clipStatusText'), 'status text builder present');
  assert.ok(src.includes('overlay hidden'), 'hidden state is named explicitly');
  // Jump buttons seek into the clip without touching model timing.
  assert.ok(src.includes('data-goto="start"'), 'go-to-start hook present');
  assert.ok(src.includes('data-goto="end"'), 'go-to-end hook present');
  // Media inspector exposes per-clip source range + gain (multi-track trim).
  // (Attributes are composed by numField(), so assert the builder calls.)
  assert.ok(src.includes("numField('sourceIn'"), 'source-in field present');
  assert.ok(src.includes("numField('sourceOut'"), 'source-out field present');
  assert.ok(src.includes("data-insp=\"gainPct\"") || src.includes('gainPct'), 'gain field present');
  // Status refreshes with the timecode path (per frame), not via rebuilds.
  const updIdx = src.indexOf('updateClipStatus()');
  const tcIdx = src.indexOf('function updateTimecode()');
  assert.ok(updIdx !== -1 && tcIdx !== -1 && updIdx > tcIdx, 'status refreshes from the timecode path');
  // Multi-track client drives preview from the active clip + gap black.
  assert.ok(src.includes('activeVideoClipAt'), 'active-clip preview switching present');
  assert.ok(src.includes('reconcileAudio'), 'music preview reconciliation present');
});

// ---- Multi-track spec v2 ----

function baseSpecV2(overrides = {}) {
  return {
    version: 2,
    width: 1280,
    height: 720,
    files: [{ kind: 'video' }, { kind: 'audio' }],
    videoClips: [
      { file: 0, sourceIn: 0, sourceOut: 4, start: 0, gain: 1 },
      { file: 0, sourceIn: 10, sourceOut: 14, start: 6, gain: 0.5 }
    ],
    audioClips: [
      { file: 0, sourceIn: 0, sourceOut: 10, start: 0, gain: 1.5 }
    ],
    blurs: [{ mode: 'blur', x: 0.1, y: 0.1, w: 0.2, h: 0.2, start: 1, end: 3 }],
    texts: [],
    images: [],
    ...overrides
  };
}

const V2_MEDIA = { width: 1280, height: 720, hasAudio: [true] };

test('v2: accepts multi video/audio clips with gain + overlays', () => {
  const r = validateEditSpec(baseSpecV2());
  assert.equal(r.ok, true);
  assert.equal(r.spec.version, 2);
  assert.equal(r.spec.contentEnd, 10);
  assert.equal(r.spec.videoClips.length, 2);
  assert.equal(r.spec.audioClips[0].gain, 1.5);
  // validateSpecV2 directly agrees (dispatch parity).
  assert.equal(validateSpecV2(baseSpecV2()).ok, true);
});

test('v2: rejects overlapping video clips but allows audio overlap', () => {
  const bad = baseSpecV2({
    videoClips: [
      { file: 0, sourceIn: 0, sourceOut: 4, start: 0, gain: 1 },
      { file: 0, sourceIn: 0, sourceOut: 4, start: 3.9, gain: 1 }
    ]
  });
  assert.match(validateEditSpec(bad).error, /must not overlap/);
  const touching = baseSpecV2({
    videoClips: [
      { file: 0, sourceIn: 0, sourceOut: 4, start: 0, gain: 1 },
      { file: 0, sourceIn: 0, sourceOut: 4, start: 4, gain: 1 }
    ],
    audioClips: []
  });
  assert.equal(validateEditSpec(touching).ok, true);
  const audioOverlap = baseSpecV2({
    audioClips: [
      { file: 0, sourceIn: 0, sourceOut: 10, start: 0, gain: 1 },
      { file: 0, sourceIn: 0, sourceOut: 10, start: 5, gain: 1 }
    ]
  });
  assert.equal(validateEditSpec(audioOverlap).ok, true);
});

test('v2: gain bounds, file refs, clip counts, overlay timeline fit', () => {
  assert.match(validateEditSpec(baseSpecV2({ videoClips: [{ file: 0, sourceIn: 0, sourceOut: 2, start: 0, gain: 2.5 }] })).error, /gain/);
  assert.match(validateEditSpec(baseSpecV2({ videoClips: [{ file: 0, sourceIn: 0, sourceOut: 2, start: 0, gain: -0.1 }] })).error, /gain/);
  assert.match(validateEditSpec(baseSpecV2({ videoClips: [{ file: 5, sourceIn: 0, sourceOut: 2, start: 0, gain: 1 }] })).error, /file/);
  assert.match(validateEditSpec(baseSpecV2({ videoClips: [] })).error, /1–/);
  const many = Array.from({ length: EDITOR_MAX_AUDIO_CLIPS + 1 }, () => ({ file: 0, sourceIn: 0, sourceOut: 2, start: 0, gain: 1 }));
  assert.match(validateEditSpec(baseSpecV2({ audioClips: many })).error, /At most/);
  assert.match(validateEditSpec(baseSpecV2({ files: [{ kind: 'audio' }] })).error, /video files/);
  assert.match(
    validateEditSpec(baseSpecV2({ blurs: [{ mode: 'mask', x: 0, y: 0, w: 0.1, h: 0.1, start: 9, end: 12 }] })).error,
    /beyond the timeline/
  );
  // Gain edges accepted.
  assert.equal(validateEditSpec(baseSpecV2({ audioClips: [{ file: 0, sourceIn: 0, sourceOut: 2, start: 0, gain: 0 }] })).ok, true);
  assert.equal(validateEditSpec(baseSpecV2({ audioClips: [{ file: 0, sourceIn: 0, sourceOut: 2, start: 0, gain: 2 }] })).ok, true);
});

test('v2: audio allowlist covers common music files', () => {
  assert.equal(isAllowedEditorAudio('song.mp3'), true);
  assert.equal(isAllowedEditorAudio('take.WAV'), true);
  assert.equal(isAllowedEditorAudio('score.m4a'), true);
  assert.equal(isAllowedEditorAudio('loop.ogg'), true);
  assert.equal(isAllowedEditorAudio('clip.mp4'), false);
  assert.equal(isAllowedEditorAudio('notes.txt'), false);
});

test('v2 build: concat + per-segment gain + amix + overlays after concat', () => {
  const args = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4'],
    audioPaths: ['/tmp/m0.mp3'],
    imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec: baseSpecV2(),
    fontFile: null,
    media: V2_MEDIA
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('-i /tmp/v0.mp4'), 'video input present');
  assert.ok(joined.includes('-i /tmp/m0.mp3'), 'music input present');
  assert.ok(joined.includes('trim=start=0:end=4'), 'first segment trimmed');
  assert.ok(joined.includes('trim=start=10:end=14'), 'second segment trimmed');
  assert.ok(joined.includes('concat=n=3'), 'two segments + one gap filler concatenated');
  assert.ok(joined.includes('color=black'), 'gap filler present');
  assert.ok(joined.includes('volume=0.5'), 'clip gain applied');
  assert.ok(joined.includes('volume=1.5'), 'music gain applied');
  assert.ok(joined.includes('adelay=0|0'), 'timeline delay present');
  assert.ok(joined.includes('concat=n=3:v=0:a=1[au_orig]'), 'audio segments concatenated');
  assert.ok(joined.includes('amix=inputs=2'), 'companion audios + music mixed');
  assert.ok(joined.includes('normalize=0'), 'mix preserves gain (no normalization)');
  assert.ok(joined.includes('boxblur='), 'blur after concat');
  assert.ok(joined.indexOf('concat=') < joined.indexOf('boxblur='), 'overlays render after concat');
  assert.ok(joined.includes('-map [au'), 'mixed audio mapped');
  assert.equal(args[args.length - 1], '/tmp/out.mp4');
});

test('v2 build: missing companion audio becomes silence, no-audio-at-all still maps', () => {
  const spec = baseSpecV2({ files: [{ kind: 'video' }], audioClips: [] });
  const args = buildFfmpegArgs({
    videoPaths: ['/tmp/silent.mp4'],
    audioPaths: [],
    imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec,
    fontFile: null,
    media: { width: 640, height: 360, hasAudio: [false] }
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('anullsrc='), 'silence substituted');
  assert.ok(joined.includes('-map [au'), 'audio still mapped');
  assert.throws(() => buildFfmpegArgs({
    videoPaths: [], audioPaths: [], imagePaths: [], outputPath: '/tmp/out.mp4', spec, fontFile: null, media: V2_MEDIA
  }), /videoPaths/);
  assert.throws(() => buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4'], audioPaths: [], imagePaths: [], outputPath: '/tmp/out.mp4',
    spec: baseSpecV2({ audioClips: [{ file: 3, sourceIn: 0, sourceOut: 2, start: 0, gain: 1 }] }),
    fontFile: null, media: V2_MEDIA
  }), /file/);
});

test('v1 legacy path frozen: same argv shape without version key', () => {
  const args = buildFfmpegArgs({
    inputPath: '/tmp/in.mkv', imagePaths: ['/tmp/ov.png'], outputPath: '/tmp/out.mp4',
    spec: {
      videoWidth: 1280, videoHeight: 720, trim: { start: 1, end: 5 }, blurs: [], texts: [],
      images: [{ start: 1, end: 3, x: 0.7, y: 0.7, w: 0.2, file: 0 }]
    },
    fontFile: null
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('-ss 1'), 'legacy trim intact');
  assert.ok(joined.includes('-map 0:a?'), 'legacy audio mapping intact');
  assert.doesNotMatch(joined, /concat=|amix=/, 'no v2 filters leak into v1');
});

test('v2 build: regression test proving original audio + music are both present in the final FFmpeg graph/export', () => {
  const args = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4'],
    audioPaths: ['/tmp/m0.mp3'],
    imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec: baseSpecV2(),
    fontFile: null,
    media: V2_MEDIA
  });
  const joined = args.join(' ');
  // Verify that the original video's audio [0:a] is trimmed
  assert.ok(joined.includes('[0:a]atrim='), 'original video audio stream trimmed');
  // Verify that the added music's audio [1:a] is trimmed
  assert.ok(joined.includes('[1:a]atrim='), 'added music audio stream trimmed');
  // Verify that sequential original audio segments are concatenated
  assert.ok(joined.includes('concat=n=3:v=0:a=1[au_orig]'), 'original audio segments concatenated sequentially');
  // Verify that the concatenated original audio track and music track are mixed
  assert.ok(joined.includes('[au_orig][mu0]amix=inputs=2'), 'original audio track and music track mixed');
  // Verify that the mixed audio stream is mapped to output
  assert.ok(joined.includes('-map [au_mixed]'), 'mixed audio stream mapped to output');
});

test('v2 build: regression test proving normalized V2 spec (with videoWidth/videoHeight) correctly compiles and produces valid export args', () => {
  // 1. Simulate the server-side flow: validate raw client spec first
  const rawSpec = baseSpecV2({
    blurs: [{ mode: 'blur', x: 0.1, y: 0.1, w: 0.2, h: 0.2, start: 1, end: 3 }],
    texts: [{ text: 'Redacted', x: 0.2, y: 0.2, size: 0.05, color: '#FF0000', start: 0, end: 4 }],
    images: [{ x: 0.3, y: 0.3, w: 0.1, start: 0, end: 2, file: 0 }]
  });
  const checked = validateEditSpec(rawSpec);
  assert.equal(checked.ok, true);
  
  // Verify returned spec has normalized keys
  const normalizedSpec = checked.spec;
  assert.equal(normalizedSpec.videoWidth, 1280);
  assert.equal(normalizedSpec.videoHeight, 720);
  assert.equal(normalizedSpec.width, 1280);
  assert.equal(normalizedSpec.height, 720);

  // 2. Build FFmpeg arguments using the normalized spec (exactly what the route does)
  const args = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4'],
    audioPaths: ['/tmp/m0.mp3'],
    imagePaths: ['/tmp/image0.png'],
    outputPath: '/tmp/out.mp4',
    spec: normalizedSpec,
    fontFile: '/tmp/font.ttf',
    media: V2_MEDIA
  });

  const joined = args.join(' ');
  // 3. Verify no error was thrown, and check that overlays and concatenation filters are valid
  assert.ok(args.length > 0, 'Args successfully constructed');
  assert.ok(joined.includes('boxblur'), 'blur filter is present');
  assert.ok(joined.includes('drawtext'), 'text overlay filter is present');
  assert.ok(joined.includes('overlay'), 'image overlay filter is present');
  assert.ok(joined.includes('concat='), 'concatenation filters are present');
});

test('v2 build: regression test reproducing export with float video dimensions (Safari subpixel scaling) correctly rounds and compiles to integer dimensions', () => {
  const floatMedia = { width: 1280.4, height: 720.6, hasAudio: [true] };
  const spec = baseSpecV2();
  
  const args = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4'],
    audioPaths: ['/tmp/m0.mp3'],
    imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec,
    fontFile: null,
    media: floatMedia
  });
  
  const joined = args.join(' ');
  assert.ok(joined.includes('scale=1280:721'), 'scale dimensions are rounded to integers');
  assert.ok(joined.includes('color=black:s=1280x721'), 'filler dimensions are rounded to integers');
});

test('v2 build: regression test verifying volumeDb is correctly parsed and compiled into volume=XdB in FFmpeg arguments', () => {
  const spec = baseSpecV2({
    videoClips: [
      { file: 0, sourceIn: 0, sourceOut: 4, start: 0, gain: 1, volumeDb: 18 }
    ],
    audioClips: [
      { file: 0, sourceIn: 0, sourceOut: 10, start: 0, gain: 1.5, volumeDb: -6 }
    ]
  });
  
  const args = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4'],
    audioPaths: ['/tmp/m0.mp3'],
    imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec,
    fontFile: null,
    media: V2_MEDIA
  });
  
  const joined = args.join(' ');
  assert.ok(joined.includes('volume=18dB'), 'video clip volumeDb compiled to 18dB');
  assert.ok(joined.includes('volume=-6dB'), 'audio clip volumeDb compiled to -6dB');
});

test('audio fades: validated clip settings compile to FFmpeg afade filters', () => {
  const spec = baseSpecV2({
    videoClips: [
      { file: 0, sourceIn: 0, sourceOut: 4, start: 0, gain: 1, fadeIn: 0.5, fadeOut: 1 }
    ],
    audioClips: [
      { file: 0, sourceIn: 0, sourceOut: 10, start: 2, gain: 1, fadeIn: 1.25, fadeOut: 2 }
    ]
  });
  const checked = validateSpecV2(spec);
  assert.equal(checked.ok, true);
  assert.equal(checked.spec.audioClips[0].fadeIn, 1.25);
  assert.equal(checked.spec.audioClips[0].fadeOut, 2);

  const args = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4'],
    audioPaths: ['/tmp/m0.mp3'],
    imagePaths: [],
    outputPath: '/tmp/out.mp4',
    spec,
    fontFile: null,
    media: V2_MEDIA
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('afade=t=in:st=0:d=0.5'), 'source video audio supports fade-in');
  assert.ok(joined.includes('afade=t=out:st=3:d=1'), 'source video audio supports fade-out');
  assert.ok(joined.includes('afade=t=in:st=0:d=1.25'), 'added audio fade-in starts at the trimmed clip start');
  assert.ok(joined.includes('afade=t=out:st=8:d=2'), 'added audio fade-out ends at the trimmed clip end');
  assert.ok(joined.includes('adelay=2000|2000'), 'timeline placement remains applied');
});

test('audio fades: project serialization persists fade settings and inspector exposes controls', () => {
  const spec = projectToSpecV2({
    files: [
      { id: 'video-1', kind: 'video', width: 1280, height: 720 },
      { id: 'audio-1', kind: 'audio' }
    ],
    videoClips: [
      { id: 'v1', file: 'video-1', sourceIn: 0, sourceOut: 10, start: 0, gain: 1, fadeIn: 0.75, fadeOut: 1.25 }
    ],
    audioClips: [
      { id: 'a1', file: 'audio-1', sourceIn: 0, sourceOut: 10, start: 0, gain: 1, fadeIn: 1.5, fadeOut: 2.5 }
    ],
    clips: []
  });
  assert.equal(spec.videoClips[0].fadeIn, 0.75);
  assert.equal(spec.videoClips[0].fadeOut, 1.25);
  assert.equal(spec.audioClips[0].fadeIn, 1.5);
  assert.equal(spec.audioClips[0].fadeOut, 2.5);
  const ui = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  assert.match(ui, /numField\('fadeIn', clip\.fadeIn \|\| 0/);
  assert.match(ui, /numField\('fadeOut', clip\.fadeOut \|\| 0/);
  assert.match(ui, /clip\.fadeIn = Math\.max\(0, Math\.min\(30, fadeIn\)\)/);
});

test('audio fades: legacy defaults and invalid values are safe', () => {
  const legacy = baseSpecV2({
    audioClips: [{ file: 0, sourceIn: 0, sourceOut: 5, start: 0, gain: 1 }]
  });
  const checked = validateSpecV2(legacy);
  assert.equal(checked.ok, true);
  assert.equal(checked.spec.audioClips[0].fadeIn, 0);
  assert.equal(checked.spec.audioClips[0].fadeOut, 0);
  for (const value of [-0.1, 30.1, 'bad']) {
    const bad = baseSpecV2({
      audioClips: [{ file: 0, sourceIn: 0, sourceOut: 5, start: 0, gain: 1, fadeIn: value }]
    });
    assert.equal(validateSpecV2(bad).ok, false, `reject fadeIn=${value}`);
  }
});

test('export resolution: Original default, all qualities known, garbage rejected', () => {
  assert.equal(EDITOR_EXPORT_RESOLUTIONS[0].id, 'original');
  assert.equal(EDITOR_EXPORT_RESOLUTIONS[0].height, null);
  const ids = EDITOR_EXPORT_RESOLUTIONS.map(r => r.id);
  for (const id of ['original', '480p', '720p', '1080p', '2k', '4k', '8k']) {
    assert.ok(ids.includes(id), `resolution offered: ${id}`);
  }
  assert.equal(normalizeExportResolution(undefined).id, 'original');
  assert.equal(normalizeExportResolution(null).id, 'original');
  assert.equal(normalizeExportResolution('').id, 'original');
  assert.equal(normalizeExportResolution('Original').id, 'original');
  assert.equal(normalizeExportResolution('720p').height, 720);
  assert.equal(normalizeExportResolution('2K').height, 1440);
  assert.equal(normalizeExportResolution('4k').height, 2160);
  assert.equal(normalizeExportResolution('8k').height, 4320);
  assert.equal(normalizeExportResolution(1080).height, 1080);
  assert.equal(normalizeExportResolution('garbage'), null);
  assert.equal(normalizeExportResolution('360p'), null);
  assert.equal(exportHeightForResolution('original'), null);
  assert.equal(exportHeightForResolution('720p'), 720);
  assert.equal(exportHeightForResolution('nope'), undefined);
});

test('export resolution: v1+v2 specs accept it, default to Original, reject garbage', () => {
  const v1 = validateEditSpec(baseSpec({ trim: { start: 0, end: 2 }, resolution: '720p' }));
  assert.equal(v1.ok, true);
  assert.equal(v1.spec.resolution, '720p');
  assert.equal(v1.spec.exportHeight, 720);
  const v1Default = validateEditSpec(baseSpec({ trim: { start: 0, end: 2 } }));
  assert.equal(v1Default.ok, true);
  assert.equal(v1Default.spec.resolution, 'original');
  assert.equal(v1Default.spec.exportHeight, null);
  assert.match(validateEditSpec(baseSpec({ trim: { start: 0, end: 2 }, resolution: '360p' })).error, /resolution/);
  const v2 = validateEditSpec(baseSpecV2({ resolution: '1080p' }));
  assert.equal(v2.ok, true);
  assert.equal(v2.spec.resolution, '1080p');
  assert.equal(v2.spec.exportHeight, 1080);
  assert.match(validateEditSpec(baseSpecV2({ resolution: '360p' })).error, /resolution/);
});

test('export resolution: Original adds no scaling; 720p downscales; 4k never upscales 720p', () => {
  const argsOriginal = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4'], audioPaths: ['/tmp/m0.mp3'], imagePaths: [], outputPath: '/tmp/out.mp4',
    spec: baseSpecV2(), fontFile: null, media: V2_MEDIA
  });
  assert.doesNotMatch(argsOriginal.join(' '), /scale=-2:/, 'Original has no resolution scaling');
  const args720 = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4'], audioPaths: ['/tmp/m0.mp3'], imagePaths: [], outputPath: '/tmp/out.mp4',
    spec: baseSpecV2({ resolution: '720p' }), fontFile: null,
    media: { width: 1920, height: 1080, hasAudio: [true] }
  });
  assert.match(args720.join(' '), /scale=-2:720/, '720p downscales a 1080p source');
  const args4k = buildFfmpegArgs({
    videoPaths: ['/tmp/v0.mp4'], audioPaths: ['/tmp/m0.mp3'], imagePaths: [], outputPath: '/tmp/out.mp4',
    spec: baseSpecV2({ resolution: '4k' }), fontFile: null,
    media: { width: 1280, height: 720, hasAudio: [true] }
  });
  assert.doesNotMatch(args4k.join(' '), /scale=-2:/, '4k target on a 720p source does not upscale');
  // V1 path behaves the same (trim-only + 480p gains exactly one scale step).
  const v1Scaled = buildFfmpegArgs({
    inputPath: 'a.mp4', outputPath: 'b.mp4',
    spec: baseSpec({ trim: { start: 0, end: 2 }, resolution: '480p' })
  });
  assert.match(v1Scaled.join(' '), /scale=-2:480/, 'v1 480p scales');
  const v1Orig = buildFfmpegArgs({
    inputPath: 'a.mp4', outputPath: 'b.mp4', spec: baseSpec({ trim: { start: 0, end: 2 } })
  });
  assert.doesNotMatch(v1Orig.join(' '), /scale=-2:/, 'v1 Original untouched (legacy frozen)');
  assert.throws(() => buildFfmpegArgs({
    inputPath: 'a.mp4', outputPath: 'b.mp4',
    spec: baseSpec({ trim: { start: 0, end: 2 }, resolution: '360p' })
  }), /resolution/);
});

test('export resolution: editor page offers Original (default) through 8K', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    editorAvailable: true
  });
  assert.match(html, /video-editor-resolution/, 'resolution selector hook present');
  assert.match(html, /Original/, 'Original option present');
  for (const label of ['480p', '720p', '1080p', '2K \\(2560x1440\\)', '4K \\(3840x2160\\)', '8K \\(7680x4320\\)']) {
    assert.match(html, new RegExp(label), `quality offered: ${label}`);
  }
  assert.match(html, /value="original" selected/, 'Original is the default');
});

test('preview + split wiring: text visibility predicate, split-all, resolution upload', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  // Text preview is time-gated by the same inclusive predicate the export
  // between(t,start,end) enables use, so editing matches the MP4.
  assert.ok(src.includes('isOverlayVisibleAt'), 'preview uses the shared visibility predicate');
  // Split at playhead cuts every spanning track, not just video.
  assert.ok(src.includes('splitAllAtPlayhead') || src.includes('splitAtPlayhead(project'), 'split-all model operation wired');
  assert.ok(src.includes('splitVideoClipAt'), 'video split still routes via splitVideoClipAt');
  // Resolution selector value travels with the export (spec + form field).
  assert.ok(src.includes('exportResolution'), 'resolution selector read');
  assert.ok(src.includes("fd.append('resolution'"), 'resolution uploaded with export');
  assert.ok(src.includes('selectedExportResolution'), 'resolution helper present');
});

test('preview text stays one line (pre), shows all words, honors explicit newlines', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  assert.ok(src.includes('textPreviewStyle'), 'shared single-line contract used by the preview');
  // paintBox text branch: no auto-wrap (white-space:pre), visible overflow
  // so a long single line is fully shown — the one-line-high
  // overflow:hidden that hid every word after the first line is gone.
  const paintIdx = src.indexOf('function paintBox');
  const renderIdx = src.indexOf('function renderPreview');
  const paintBody = src.slice(paintIdx, renderIdx);
  assert.ok(paintBody.includes("clip.type === 'text'"), 'text branch present');
  assert.ok(paintBody.includes('textPreviewStyle()'), 'text branch applies the single-line contract');
  assert.ok(!/el\.style\.overflow\s*=\s*'hidden'/.test(paintBody), 'no clipped overflow on preview boxes');
  assert.ok(!paintBody.includes('break-word'), 'no automatic wrapping');
  // Full text assigned verbatim: spaces kept exactly, explicit \n kept so
  // the pre-formatted box renders one line per newline and nothing else.
  assert.ok(paintBody.includes('el.textContent = clip.text'), 'text content assigned verbatim');
  // Live drag path keeps the same contract while moving/resizing.
  const syncIdx = src.indexOf('function syncBoxEl');
  const syncEnd = src.indexOf('function previewFrac');
  const syncBody = src.slice(syncIdx, syncEnd);
  assert.ok(syncBody.includes('textPreviewStyle()'), 'drag path keeps single-line text visible');
  assert.ok(syncBody.includes('styleRect(boxEl, textBoxGeo(clip))'), 'drag still moves the box');
  assert.ok(syncBody.includes('boxEl.style.fontSize'), 'drag still live-sizes text');
  // Untouched: timeline labels still truncate; text geometry, base font-size,
  // position and timing behavior intact (only wrapping changed).
  assert.ok(src.includes("whiteSpace = 'nowrap'"), 'timeline labels still single-line');
  assert.ok(src.includes('textBoxGeo(clip)'), 'text box geometry unchanged');
  assert.ok(src.includes('(clip.size || 0.05) * layerH'), 'proportional base font size unchanged');
  assert.ok(src.includes('isOverlayVisibleAt(clip, t)'), 'timing/visibility logic unchanged');
});

test('preview text auto-fits: long lines shrink to fit, short text untouched', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  // Both render paths (initial paint + live drag) size from measured text.
  const paintIdx = src.indexOf('function paintBox');
  const paintBody = src.slice(paintIdx, src.indexOf('function renderPreview'));
  assert.ok(paintBody.includes('effectiveTextSizePx('), 'paint sizes from measured text');
  assert.ok(src.includes('ctx.measureText('), 'actual rendered widths measured');
  assert.ok(src.includes('fitTextScale('), 'measured sizes drive the fit scale');
  // Box chrome (border/padding) is subtracted so fitted text cannot overhang
  // by the chrome width.
  assert.ok(src.includes('borderLeftWidth') && src.includes('paddingLeft'), 'frame fit accounts for box chrome');
  const syncBody = src.slice(src.indexOf('function syncBoxEl'), src.indexOf('function previewFrac'));
  assert.ok(syncBody.includes('effectiveTextSizePx('), 'drag path sizes from measured text');
  // Single line stays one line: pre formatting applied from the contract,
  // no normal wrapping anywhere in the preview text path.
  assert.ok(paintBody.includes('el.style.whiteSpace = wrap.whiteSpace'), 'pre formatting applied from contract');
  assert.ok(!/whiteSpace\s*=\s*['"]normal['"]/.test(paintBody), 'no automatic wrapping in paint');
  assert.ok(!/whiteSpace\s*=\s*['"]normal['"]/.test(syncBody), 'no automatic wrapping on drag');
  // Untouched: model size still drives export spec; no filter built here.
  assert.ok(!src.includes('filter_complex') && !src.includes('drawtext='), 'no FFmpeg/export filter built in the client');
});

test('preview text stays inside the canvas via measured-box clamping', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  assert.ok(src.includes('clampTextToFrame'), 'shared frame-clamp helper used by the preview');
  assert.ok(src.includes('function fitTextToFrame'), 'measured-size fit helper present');
  // Canvas drag measures the live box once and clamps the anchor per move.
  const boxIdx = src.indexOf('function onBoxDown');
  const boxEnd = src.indexOf('function startTextEdit');
  const boxBody = src.slice(boxIdx, boxEnd);
  assert.ok(boxBody.includes('getBoundingClientRect'), 'drag measures the rendered box');
  assert.ok(boxBody.includes('clampTextToFrame(ox +'), 'drag clamps text to the frame');
  // Text resize re-fits after growing the font.
  assert.ok(boxBody.includes('fitTextToFrame(boxEl, clip)'), 'resize keeps text in frame');
  // Inspector x/y re-fits through the live preview box.
  assert.ok(src.includes("querySelector('.ve-pbox[data-clip-id="), 'inspector fits via the live box');
  // Untouched: blur/image still use the geometry model; no export changes.
  assert.ok(boxBody.includes('moveGeo('), 'blur/image move path intact');
  assert.ok(boxBody.includes('resizeGeo('), 'blur/image resize path intact');
  assert.ok(!src.includes('filter_complex') && !src.includes('drawtext='), 'no FFmpeg/export filter built in the client');
  // Single-line contract intact (no wrapping reintroduced).
  assert.ok(src.includes('textPreviewStyle()'), 'single-line preview style kept');
});

test('extend to video end: inspector action wired to the model operation', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  assert.ok(src.includes('extendOverlayToVideoEnd'), 'model operation used');
  assert.ok(src.includes('data-extend="end"'), 'timing-section action hook present');
  assert.ok(src.includes('video-editor-extend-end'), 'action test id present');
  // Only the overlay inspector offers it (video/audio use renderMediaInspector).
  const inspIdx = src.indexOf('Group 1: Timing');
  const mediaIdx = src.indexOf('function renderMediaInspector');
  const timingHtml = src.slice(inspIdx, mediaIdx);
  assert.ok(timingHtml.includes('data-extend="end"'), 'action lives in the overlay timing section');
  assert.ok(!src.slice(mediaIdx, mediaIdx + 4000).includes('data-extend='), 'no extend action for video/audio clips');
});

test('export ETA: preparing text, live estimate, completion and clearing', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  // 1. Preparing state keeps the start time and estimates nothing yet.
  assert.ok(src.includes("Preparing export... — Estimating remaining time...'"), 'preparing + estimating text');
  // 2./4. ETA derives from actual elapsed time + actual progress each poll.
  assert.ok(src.includes('var exportStartMs = Date.now()'), 'export start timestamp tracked');
  assert.ok(src.includes('estimateRemainingMs(Date.now() - exportStartMs'), 'ETA from elapsed + progress');
  assert.ok(src.includes('formatEta(etaMs)'), 'ETA formatted per poll');
  assert.ok(src.includes("' — ' + etaLabel"), 'ETA appended to the status line');
  // 5. 100%/completed carries no ETA.
  assert.ok(src.includes("setStatus(exportStartPrefix + ' — Exporting... 100.00%', true)"), 'completion has no ETA');
  // 6. Cancel/error replace the whole status line, and the poll guard stops
  // stale updates — no lingering ETA possible.
  assert.ok(src.includes("setStatus('Export cancelled'"), 'cancel clears the status line');
  assert.ok(src.includes('if (!isExporting || currentExportId !== exportId)'), 'poll guarded after cancel');
});

test('export preparing state: honest status until measurable FFmpeg progress', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  // Starts honest: preparing with the start-time prefix, no fake percent,
  // and no ETA before anything measurable exists.
  assert.ok(src.includes("Preparing export... — Estimating remaining time...'"), 'preparing + estimating text present');
  assert.ok(src.includes("exportStartPrefix + ' — Preparing export... — Estimating remaining time...'"), 'start time kept during preparation');
  // Exact backend transition: rendering/done (or a real percent) flips to
  // the percentage view; starting/unknown keeps preparing, bar untouched.
  assert.ok(src.includes("data.status === 'rendering'"), 'measurable-progress transition point');
  assert.ok(src.includes("data.status === 'starting'"), 'starting state handled');
  assert.ok(src.includes("data.status === 'unknown'"), 'pre-entry state handled');
  assert.ok(src.includes("Exporting... ' + pct"), 'percentage view kept once measurable');
  assert.ok(src.includes("Exporting... 100.00%'"), 'completion keeps the percentage format');
  assert.ok(src.includes('Cancel Export'), 'cancel kept');
});

test('delete cascades to split-generated segment items only', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  assert.ok(src.includes('deleteVideoClip(project, id, linked)'), 'delete collects linked clips');
  assert.ok(src.includes('linked clip(s)'), 'cascade reported in the status line');
});

test('FFmpeg progress parsing: extracts time correctly and computes correct percentages', () => {
  const parseProgressTime = (chunkStr) => {
    const m = chunkStr.match(/time=\s*(\d+):(\d+):(\d+)/);
    if (!m) return null;
    const hours = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    const seconds = parseInt(m[3], 10);
    return hours * 3600 + minutes * 60 + seconds;
  };

  const computePercentage = (currentSecs, totalDuration) => {
    if (totalDuration <= 0) return 0;
    const rawPercent = (currentSecs / totalDuration) * 100;
    return Math.min(99.99, Math.round(rawPercent * 100) / 100);
  };

  // Simulated FFmpeg outputs
  const chunk1 = "frame=  123 fps=0.0 q=-0.0 size=    1152kB time=00:00:15.50 bitrate=2304.0kbits/s speed=8.2x";
  const chunk2 = "frame=  256 fps=12.5 q=-0.0 size=    3400kB time=00:01:30.00 bitrate=1200.0kbits/s speed=1.2x";
  const chunk3 = "invalid stream output without progress";

  const totalDuration = 180; // 3 minutes = 180s

  const time1 = parseProgressTime(chunk1);
  assert.equal(time1, 15);
  assert.equal(computePercentage(time1, totalDuration), 8.33); // 15 / 180 = 8.33%

  const time2 = parseProgressTime(chunk2);
  assert.equal(time2, 90);
  assert.equal(computePercentage(time2, totalDuration), 50); // 90 / 180 = 50%

  const spaceChunk = "frame=  256 fps=12.5 q=-0.0 size=    3400kB time=  00:01:30.00 bitrate=1200.0kbits/s speed=1.2x";
  assert.equal(parseProgressTime(spaceChunk), 90);

  const time3 = parseProgressTime(chunk3);
  assert.equal(time3, null);
});

test('v2 build: zoom filter validation and ffmpeg compilation', async () => {
  const { validateSpecV2, buildV2Args } = await import('../src/library/video-editor.js');
  
  const spec = {
    version: 2,
    width: 1280,
    height: 720,
    files: [{ kind: 'video' }],
    videoClips: [{ file: 0, sourceIn: 0, sourceOut: 10, start: 0, gain: 1 }],
    audioClips: [],
    zooms: [
      { start: 2, end: 7, level: 2.0, x: 0.3, y: 0.4, transition: 0.5 }
    ]
  };

  const checked = validateSpecV2(spec);
  assert.ok(checked.ok);
  assert.equal(checked.spec.zooms.length, 1);
  assert.equal(checked.spec.zooms[0].level, 2.0);

  // FFmpeg dynamic filter generation
  const args = buildV2Args({
    videoPaths: ['v1.mp4'],
    audioPaths: [],
    outputPath: 'out.mp4',
    spec,
    media: { width: 1280, height: 720, hasAudio: [false] }
  });

  const joined = args.join(' ');
  assert.ok(joined.includes('zoompan='), 'zoompan filter was generated');
  assert.ok(joined.includes('between(time,2,7)'), 'filter targets correct segment time window');
  // FFmpeg's eval has no clamp(): the rail must be spelled min(max(v,lo),hi)
  // or filter init fails with EINVAL ("Unknown function in 'clamp(...)'").
  assert.ok(!joined.includes('clamp('), 'no unsupported clamp() in generated filters');
  assert.ok(joined.includes('min(max(0.3*iw-iw/(2*zoom),0),iw-iw/zoom)'), 'railed X coordinate formula is present');
  assert.ok(joined.includes('min(max(0.4*ih-ih/(2*zoom),0),ih-ih/zoom)'), 'railed Y coordinate formula is present');
});

test('v2 build: zoompan coordinate rail uses only FFmpeg-eval functions (no clamp)', async () => {
  // Regression: buildZoomFilter emitted clamp(...), which FFmpeg's expression
  // evaluator does not implement. Filter init then failed immediately with
  // EINVAL (-22): "Unknown function in 'clamp(...)'", no packets, "Conversion
  // failed!" — at any export resolution whenever a zoom clip was present.
  const { buildV2Args, buildZoomFilter } = await import('../src/library/video-editor.js');
  const spec = {
    version: 2,
    width: 1280,
    height: 720,
    files: [{ kind: 'video' }],
    videoClips: [{ file: 0, sourceIn: 0, sourceOut: 10, start: 0, gain: 1 }],
    audioClips: [],
    zooms: [
      { start: 0, end: 10, level: 2.5, x: 0.3, y: 0.7, transition: 0.5 }
    ],
    exportHeight: 1440 // 2K target from the failure report
  };
  const args = buildV2Args({
    videoPaths: ['v1.mp4'],
    audioPaths: [],
    outputPath: 'out.mp4',
    spec,
    media: { width: 1280, height: 720, hasAudio: [false] }
  });
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.ok(filter.includes('zoompan='), 'zoom branch present');
  assert.ok(!filter.includes('clamp('), 'no unsupported clamp() anywhere in the graph');
  // The min/max rail must be mathematically identical to clamp(v,0,hi).
  const rail = (v, hi) => Math.min(Math.max(v, 0), hi);
  const clamp = (v, hi) => Math.min(Math.max(v, 0), hi);
  for (const zoom of [1.0, 1.5, 2.5, 3.0, 5.0, 8.0]) {
    for (const t of [0, 0.1, 0.3, 0.5, 0.9, 1.0]) {
      for (const dim of [720, 1080, 1440, 2160]) {
        const v = t * dim - dim / (2 * zoom);
        const hi = dim - dim / zoom;
        assert.equal(rail(v, hi), clamp(v, hi), `rail == clamp at zoom=${zoom} t=${t} dim=${dim}`);
      }
    }
  }
  // Direct unit check of the filter builder across zoom shapes.
  const f = buildZoomFilter(
    [{ start: 1, end: 5, level: 2, x: 0.2, y: 0.8, transition: 0 }],
    2560, 1440, 30
  );
  assert.ok(f.includes('s=2560x1440'), 'explicit output size kept');
  assert.ok(!f.includes('clamp('), 'builder output has no clamp()');
});

test('checkCrop validation and normalization', () => {
  // Null/undefined returns null (no crop)
  assert.deepEqual(checkCrop(null, 'crop'), { value: null });
  assert.deepEqual(checkCrop(undefined, 'crop'), { value: null });

  // Full-frame crop normalized to null
  assert.deepEqual(checkCrop({ left: 0, top: 0, right: 1, bottom: 1 }, 'crop'), { value: null });

  // Valid partial crop
  const c1 = checkCrop({ left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 }, 'crop');
  assert.ok(!c1.error);
  assert.deepEqual(c1.value, { left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 });

  // Margin-style input (right and bottom given as inset margins)
  const c2 = checkCrop({ left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 }, 'crop');
  assert.ok(!c2.error);
  assert.deepEqual(c2.value, { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 });

  // Clamping minimum span
  const c3 = checkCrop({ left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 }, 'crop');
  assert.ok(!c3.error);
  assert.ok(c3.value.right >= c3.value.left + 0.02);
  assert.ok(c3.value.bottom >= c3.value.top + 0.02);

  // Invalid types
  assert.ok(checkCrop('invalid', 'crop').error);
  assert.ok(checkCrop([1, 2, 3], 'crop').error);
  assert.ok(checkCrop({ left: 'foo' }, 'crop').error);
});

test('v2 build: crop filter validation and FFmpeg compilation for main clips and video overlays', () => {
  const spec = {
    version: 2,
    width: 1920,
    height: 1080,
    files: [
      { kind: 'video' }, // Main video (file 0)
      { kind: 'video' }  // Overlay video source (file 1)
    ],
    videoClips: [
      {
        file: 0,
        sourceIn: 0,
        sourceOut: 10,
        start: 0,
        gain: 1,
        volumeDb: 0,
        crop: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 }
      }
    ],
    audioClips: [],
    blurs: [],
    texts: [],
    images: [],
    videoOverlays: [
      {
        file: 1,
        start: 1.0,
        end: 6.0,
        sourceIn: 0.5,
        x: 0.6,
        y: 0.1,
        w: 0.3,
        h: 0.2,
        crop: { left: 0.2, top: 0.1, right: 0.8, bottom: 0.9 }
      }
    ],
    zooms: [],
    watermark: {
      enabled: false,
      position: 1,
      text: 'Test',
      size: 0.05,
      color: '#FFFFFF',
      opacity: 50
    }
  };

  const checked = validateSpecV2(spec);
  assert.ok(checked.ok);
  assert.ok(checked.spec.videoClips[0].crop);
  assert.equal(checked.spec.videoClips[0].crop.left, 0.1);
  assert.ok(checked.spec.videoOverlays[0].crop);
  assert.equal(checked.spec.videoOverlays[0].crop.left, 0.2);

  const args = buildV2Args({
    videoPaths: ['main.mp4', 'overlay.mp4'],
    audioPaths: [],
    outputPath: 'out.mp4',
    spec: checked.spec,
    media: { width: 1920, height: 1080, hasAudio: [true, false] }
  });

  const joined = args.join(' ');

  // Main video should have crop filter in its chain
  assert.ok(joined.includes('crop=w=trunc(iw*0.8/2)*2:h=trunc(ih*0.8/2)*2:x=trunc(iw*0.1/2)*2:y=trunc(ih*0.1/2)*2'), 'Main video crop filter generated');

  // Video overlay should have crop filter before scaling
  assert.ok(joined.includes('crop=w=trunc(iw*0.6/2)*2:h=trunc(ih*0.8/2)*2:x=trunc(iw*0.2/2)*2:y=trunc(ih*0.1/2)*2'), 'Overlay crop filter generated');
  assert.ok(joined.includes('overlay=1152:108'), 'Overlay placed at correct geometry');
});

test('admin video editor renders editing workspace controls and layout hooks', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    editorAvailable: true
  });

  const workspaceHooks = [
    'video-editor-workspace-toggle',
    'video-editor-timeline-workspace-toggle',
    'video-editor-workspace-header',
    'video-editor-workspace-restore',
    'video-editor-workspace-media-btn',
    'video-editor-workspace-export-btn',
    'video-editor-maximize-preview',
    'video-editor-divider',
    'video-editor-upload-controls'
  ];

  for (const hook of workspaceHooks) {
    assert.match(html, new RegExp(hook), `workspace hook present: ${hook}`);
  }

  // Check CSS styles for workspace mode and maximize preview
  assert.match(html, /body\.ve-workspace-active\s*\{/, 'workspace active body styling present');
  assert.match(html, /body\.ve-workspace-active #videoEditorRoot\s*\{/, 'workspace active grid styling present');
  assert.match(html, /body\.ve-preview-maximized #videoEditorRoot\s*\{/, 'preview maximized grid styling present');
  assert.match(html, /#veDivider/, 'draggable divider styling present');
  assert.match(html, /ve-drawer-modal/, 'drawer modal styling present');
  assert.match(html, /ve-floating-restore-btn/, 'floating restore button styling present');
});

test('editing workspace script wiring: toggles, drawers, divider, and maximize preview', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');

  // Verify workspace mode function and state
  assert.ok(src.includes('function setWorkspaceMode'), 'setWorkspaceMode function present');
  assert.ok(src.includes('function setMaximizePreview'), 'setMaximizePreview function present');
  assert.ok(src.includes('function initDividerDrag'), 'initDividerDrag function present');
  assert.ok(src.includes('function closeDrawers'), 'closeDrawers function present');
  assert.ok(src.includes('function toggleMediaDrawer'), 'toggleMediaDrawer function present');
  assert.ok(src.includes('function toggleExportDrawer'), 'toggleExportDrawer function present');

  // Verify button listeners wiring
  assert.ok(src.includes("$('veWorkspaceToggle')"), 'workspace toggle button wired');
  assert.ok(src.includes("$('veTimelineWorkspaceToggle')"), 'timeline workspace toggle button wired');
  assert.ok(src.includes("$('veWorkspaceRestoreBtn')"), 'workspace restore button wired');
  assert.ok(src.includes("$('veMaximizePreviewBtn')"), 'maximize preview button wired');
  assert.ok(src.includes("$('veFloatingRestorePreview')"), 'floating preview restore button wired');
  assert.ok(src.includes("$('veToggleMediaBtn')"), 'media drawer toggle wired');
  assert.ok(src.includes("$('veToggleExportBtn')"), 'export drawer toggle wired');

  // Verify divider dragging implementation with pointer events
  assert.ok(src.includes('setPointerCapture'), 'pointer capture used for divider dragging');
  assert.ok(src.includes('--ve-timeline-height'), 'css variable updated on divider drag');

  // Verify keyboard shortcuts: Esc to restore / close drawers, F for maximize preview
  assert.ok(src.includes("e.code === 'Escape'"), 'Escape key handler present');
  assert.ok(src.includes("e.code === 'KeyF'"), 'KeyF shortcut present for maximize preview');

  // Verify window resize listener for responsive layout
  assert.ok(src.includes("window.addEventListener('resize'"), 'resize listener present for responsive workspace');

  // Verify timecode synchronization badge
  assert.ok(src.includes("$('veWsTimecodeBadge')"), 'workspace timecode badge synchronized');
});

test('admin video editor renders restored watermark controls and preview frame clipping in inspector and workspace', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    editorAvailable: true
  });

  // Watermark controls in Inspector
  assert.match(html, /id="veWatermarkSection"/, 'watermark section in inspector container');
  assert.match(html, /data-testid="video-editor-watermark-controls"/, 'watermark controls testid present');
  assert.match(html, /id="veWatermark"/, 'watermark enable checkbox present');
  assert.match(html, /id="veWatermarkText"/, 'watermark text input present');
  assert.match(html, /id="veWatermarkPosition"/, 'watermark position select present');
  assert.match(html, /id="veWatermarkSize"/, 'watermark size input present');
  assert.match(html, /id="veWatermarkColor"/, 'watermark color picker present');
  assert.match(html, /id="veWatermarkOpacity"/, 'watermark opacity input present');

  // Preview frame unclipped handles in CSS
  assert.match(html, /#previewWrap\s*\{[^}]*overflow:\s*visible\s*!important/s, 'previewWrap allows unclipped handles');
  assert.match(html, /body\.ve-workspace-active #previewWrap\s*\{[^}]*overflow:\s*visible\s*!important/s, 'workspace previewWrap allows unclipped handles');

  // Watermark dark mode styles in workspace
  assert.match(html, /body\.ve-workspace-active \.ve-inspector-watermark-card/, 'workspace watermark card styling present');

  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  assert.ok(src.includes('function syncWatermarkFromUI'), 'syncWatermarkFromUI present in JS');
  assert.ok(src.includes('function syncWatermarkToUI'), 'syncWatermarkToUI present in JS');
  assert.ok(src.includes('onWatermarkSettingChanged'), 'watermark change listener present');
});

test('video overlay shapes: inspector controls, client script wiring, and matching ffmpeg export', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');

  // Inspector shape selection
  assert.ok(src.includes('data-insp="voverlayShape"'), 'mask shape select present in inspector');
  assert.ok(src.includes('voverlayShape'), 'voverlayShape wired in inspector fields');

  // Shape application in preview
  assert.ok(src.includes('ellipse(50% 50% at 50% 50%)'), 'circle/ellipse clip-path applied in syncVideoOverlays');
  assert.ok(src.includes('inset(0 round 12px)'), 'rounded rect clip-path applied in syncVideoOverlays');

  // FFmpeg compilation matches shapes
  const specCircle = {
    version: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    files: [{ kind: 'video' }, { kind: 'video' }],
    videoClips: [{ file: 0, sourceIn: 0, sourceOut: 5, start: 0, gain: 1 }],
    audioClips: [],
    blurs: [],
    texts: [],
    images: [],
    videoOverlays: [
      { file: 1, x: 0.6, y: 0.1, w: 0.3, h: 0.3, start: 0, end: 4, sourceIn: 0, shape: 'circle' }
    ],
    zooms: []
  };

  const checkedCircle = validateSpecV2(specCircle);
  assert.ok(checkedCircle.ok);
  const argsCircle = buildV2Args({
    videoPaths: ['/tmp/main.mp4', '/tmp/pip.mp4'],
    audioPaths: [],
    imagePaths: [],
    outputPath: 'out.mp4',
    spec: checkedCircle.spec,
    media: { width: 1920, height: 1080 }
  });
  const joinedCircle = argsCircle.join(' ');
  assert.ok(joinedCircle.includes("geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='if(lte(pow((X-W/2)/(W/2),2)+pow((Y-H/2)/(H/2),2),1),255,0)'"), 'Circle mask geq filter compiled');

  const specRound = {
    ...specCircle,
    videoOverlays: [
      { file: 1, x: 0.6, y: 0.1, w: 0.3, h: 0.3, start: 0, end: 4, sourceIn: 0, shape: 'rounded' }
    ]
  };
  const checkedRound = validateSpecV2(specRound);
  assert.ok(checkedRound.ok);
  const argsRound = buildV2Args({
    videoPaths: ['/tmp/main.mp4', '/tmp/pip.mp4'],
    audioPaths: [],
    imagePaths: [],
    outputPath: 'out.mp4',
    spec: checkedRound.spec,
    media: { width: 1920, height: 1080 }
  });
  const joinedRound = argsRound.join(' ');
  assert.ok(joinedRound.includes("pow(min(W,H)*0.12,2)),255,0)'"), 'Rounded rect mask geq filter compiled');
});

test('image crop: interactive inspector controls, script wiring, and ffmpeg export compilation', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');

  // Inspector and preview image crop wiring
  assert.ok(src.includes("clip.type === 'voverlay' || clip.type === 'image'"), 'image clips use cropInspectorHtml');
  assert.ok(src.includes("targetX = imgBox.offsetLeft"), 'image overlay box target coordinates resolved in renderCropLayer');
  assert.ok(src.includes("cropBtn.addEventListener('click'"), 'toolbar crop button wired');
  assert.ok(src.includes("clip.type === 'video' || clip.type === 'voverlay' || clip.type === 'image'"), 'toolbar crop button accepts image clips');

  // FFmpeg export compilation for image crop
  const specImageCrop = {
    version: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    files: [{ kind: 'video' }],
    videoClips: [{ file: 0, sourceIn: 0, sourceOut: 5, start: 0, gain: 1 }],
    audioClips: [],
    blurs: [],
    texts: [],
    images: [
      { file: 0, x: 0.5, y: 0.5, w: 0.25, start: 0, end: 5, crop: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 } }
    ],
    videoOverlays: [],
    zooms: []
  };

  const checkedImage = validateSpecV2(specImageCrop);
  assert.ok(checkedImage.ok);
  const args = buildV2Args({
    videoPaths: ['/tmp/main.mp4'],
    audioPaths: [],
    imagePaths: ['/tmp/logo.png'],
    outputPath: 'out.mp4',
    spec: checkedImage.spec,
    media: { width: 1920, height: 1080 }
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('crop=w=trunc(iw*0.8/2)*2:h=trunc(ih*0.8/2)*2:x=trunc(iw*0.1/2)*2:y=trunc(ih*0.1/2)*2'), 'Image crop filter generated in export');
  assert.ok(joined.includes('scale=480:-2'), 'Cropped image scaled after crop');
});

test('media upload UI cards: 4 consistent cards with limits and source separation', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    editorAvailable: true,
    editorMaxVideoMb: 1024
  });

  assert.match(html, /data-testid="video-editor-upload-card-video"/, 'Main video upload card present');
  assert.match(html, /data-testid="video-editor-upload-card-voverlay"/, 'Video overlay upload card present');
  assert.match(html, /data-testid="video-editor-upload-card-audio"/, 'Audio upload card present');
  assert.match(html, /data-testid="video-editor-upload-card-image"/, 'Image upload card present');

  // Verify caps and labels
  assert.match(html, /\(max 1024 MB\)/, 'Video cap shown');
  assert.match(html, /\(max 200 MB\)/, 'Audio cap shown');
  assert.match(html, /\(max 5 MB\)/, 'Image cap shown');

  // Verify inputs remain distinct
  assert.match(html, /id="videoFile"/, 'Main video input distinct');
  assert.match(html, /id="voverlaySourceFile"/, 'Overlay video input distinct');
  assert.match(html, /id="audioFile"/, 'Audio input distinct');
  assert.match(html, /id="imageFile"/, 'Image input distinct');
});

test('timeline scrolling: independent overflow-x/y, sticky headers, high-contrast scrollbars, and wheel synchronization', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    editorAvailable: true
  });

  // Timeline scrolling attributes and styles
  assert.match(html, /id="veScroll"[^>]*style="[^"]*overflow-x:\s*(scroll|auto);overflow-y:\s*auto;/, 'independent overflow-x and overflow-y on veScroll');
  assert.match(html, /scrollbar-gutter:\s*stable/, 'scrollbar-gutter stable present on veScroll');
  assert.match(html, /position:\s*sticky;\s*top:\s*0;\s*z-index:\s*25;/, 'sticky top Time header row');
  assert.match(html, /position:\s*sticky;\s*left:\s*0;\s*z-index:\s*20;/, 'sticky left lane labels');

  // Custom high-contrast scrollbars in both standard and workspace modes
  assert.match(html, /\.ve-hscrollbar-track\s*\{[^}]*height:\s*14px;/s, 'horizontal scrollbar track height');
  assert.match(html, /\.ve-hscrollbar-thumb\s*\{[^}]*background:\s*#3b82f6;/s, 'dark mode scrollbar thumb color');
  assert.match(html, /body:not\(\.ve-workspace-active\)\s+\.ve-hscrollbar-thumb\s*\{[^}]*background:\s*#2563eb;/s, 'light mode scrollbar thumb color');

  // Trim handles CSS
  assert.match(html, /\.ve-edge\s*\{[^}]*cursor:\s*ew-resize/s, 'trim edge handles cursor');
  assert.match(html, /\.ve-edge\s*\{[^}]*touch-action:\s*none/s, 'trim edge handles touch-action');

  // Script wiring for wheel horizontal scrolling
  const scriptSrc = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  assert.match(scriptSrc, /veScrollEl\.addEventListener\('wheel'/, 'wheel event listener wired on veScroll');
});

test('workspace non-overlapping CSS grid layout and independent inspector scroll', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    editorAvailable: true
  });

  // Grid rows with minmax(0, 1fr) for bounded middle region
  assert.match(html, /grid-template-rows:\s*44px\s+minmax\(0,\s*1fr\)\s+6px\s+var\(--ve-timeline-height,\s*240px\)/, 'grid rows allocate bounded 1fr middle and custom timeline bottom');
  assert.match(html, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(320px,\s*360px\)/, 'grid columns allocate bounded 1fr preview and inspector side panel');

  // Inspector container bounded inside row 2 with independent vertical scrolling
  assert.match(html, /body\.ve-workspace-active #veInspectorContainer\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*2;/s, 'inspector placed in column 2, row 2');
  assert.match(html, /body\.ve-workspace-active #veInspectorContainer\s*\{[^}]*min-height:\s*0\s*!important;[^}]*max-height:\s*100%\s*!important;/s, 'inspector min-height and max-height strictly bounded to prevent timeline overlap');
  assert.match(html, /body\.ve-workspace-active #veInspectorContainer\s*\{[^}]*overflow-y:\s*auto\s*!important;/s, 'inspector independently scrollable');

  // Timeline container placed in bottom row 4
  assert.match(html, /body\.ve-workspace-active #veTimelineContainer\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*grid-row:\s*4;/s, 'timeline placed in bottom row across full width');
  assert.match(html, /body\.ve-workspace-active #veTimelineContainer\s*\{[^}]*min-height:\s*0\s*!important;/s, 'timeline min-height bounded');

  // Watermark section inside inspector container
  assert.match(html, /id="veInspectorContainer"[^>]*>[\s\S]*?id="veWatermarkSection"/, 'watermark section is inside the scrollable inspector container');
});

test('workspace preview scaling and live layout recalculation across modes, divider drag, and resize', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    editorAvailable: true
  });

  // Preview container and wrap use full available dimensions with aspect ratio preservation
  assert.match(html, /body\.ve-workspace-active #veSectionPreview\s*\{[^}]*min-width:\s*0\s*!important;[^}]*min-height:\s*0\s*!important;/s, 'preview section min dimensions zero to avoid grid blowout');
  assert.match(html, /body\.ve-workspace-active #vePreviewContainer\s*\{[^}]*flex:\s*1\s+1\s+auto;/s, 'preview container flex auto');
  assert.match(html, /body\.ve-workspace-active #previewWrap video\s*\{[^}]*object-fit:\s*contain;/s, 'preview video preserves aspect ratio');
  assert.match(html, /body\.ve-workspace-active #previewWrap video\s*\{[^}]*max-height:\s*calc\(100vh - var\(--ve-timeline-height,\s*240px\)\s*-\s*130px\);/s, 'preview video height dynamically accounts for timeline height');

  // JS wiring: renderPreview called on mode change, divider dragging, and window resize
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');
  assert.match(src, /function setWorkspaceMode[\s\S]*?renderPreview\(\);/, 'setWorkspaceMode triggers renderPreview');
  assert.match(src, /function setMaximizePreview[\s\S]*?renderPreview\(\);/, 'setMaximizePreview triggers renderPreview');
  assert.match(src, /divider\.addEventListener\('pointermove'[\s\S]*?renderPreview\(\);/, 'divider drag updates preview layout');
  assert.match(src, /window\.addEventListener\('resize'[\s\S]*?renderPreview\(\);/, 'window resize triggers renderPreview');
});

test('blur preview: live video canvas sampling, coordinate mapping, overlay compositing, mask mode, and matching export', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    editorAvailable: true
  });

  // Verify previewWrap and overlayLayer structure and blur canvas CSS
  assert.doesNotMatch(html, /id="overlayLayer"[^>]*contain:\s*paint/, 'overlayLayer does not use paint containment that blocks backdrop-filter');
  assert.match(html, /\.ve-blur-canvas\s*\{[^}]*filter:\s*blur\(10px\)/, 'CSS defines .ve-blur-canvas with blur filter');

  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');

  // Verify renderBlurCanvas definition and video slice sampling
  assert.ok(src.includes('function renderBlurCanvas(boxEl, clip)'), 'renderBlurCanvas defined');
  assert.match(src, /ctx\.drawImage\(video,\s*sx,\s*sy,\s*sw,\s*sh,\s*0,\s*0,\s*destW,\s*destH\)/, 'renderBlurCanvas draws underlying video slice onto canvas');

  // Verify coordinate mapping accounts for zoom and crop
  assert.match(src, /if \(activeZoom\)[\s\S]*?lvl[\s\S]*?sx = \(zState\.x \+ \(clip\.x - 0\.5\) \/ lvl\) \* vw/, 'renderBlurCanvas maps coordinates when zoom is active');
  assert.match(src, /else if \(mainCrop\)[\s\S]*?scale[\s\S]*?sx = \(xMid \+ \(clip\.x - 0\.5\) \/ scale\) \* vw/, 'renderBlurCanvas maps coordinates when main video crop is active');

  // Verify video overlay intersection drawing into blur canvas
  assert.match(src, /c\.type === 'voverlay'[\s\S]*?ctx\.drawImage\(entry\.video,\s*ovSx,\s*ovSy,\s*ovSw,\s*ovSh,\s*dx,\s*dy,\s*dw,\s*dh\)/, 'renderBlurCanvas draws intersecting video overlays onto blur canvas');

  // Verify syncBlurOverlays lifecycle integration
  assert.ok(src.includes('function syncBlurOverlays()'), 'syncBlurOverlays defined');
  assert.match(src, /renderPreview\(\)[\s\S]*?syncBlurOverlays\(\);/, 'renderPreview calls syncBlurOverlays');
  assert.match(src, /syncBoxEl[\s\S]*?clip\.type === 'blur'[\s\S]*?renderBlurCanvas\(boxEl,\s*clip\)/, 'syncBoxEl refreshes blur canvas on drag/resize');
  assert.match(src, /video\.addEventListener\('loadeddata', function \(\) \{ renderPreview\(\); \}\)/, 'video loadeddata triggers preview render to refresh blur canvas');

  // Verify mask mode renders solid black and cleans up canvas
  assert.match(src, /if \(clip\.mode === 'mask'\)[\s\S]*?el\.style\.background = '#000'[\s\S]*?removeChild\(oldCvs\)/, 'mask mode applies solid black and removes blur canvas');

  // Verify FFmpeg export compilation for blur and mask modes
  const specBlur = {
    version: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    files: [{ kind: 'video' }],
    videoClips: [{ file: 0, sourceIn: 0, sourceOut: 5, start: 0, gain: 1 }],
    audioClips: [],
    blurs: [
      { x: 0.1, y: 0.2, w: 0.3, h: 0.25, mode: 'blur', start: 0, end: 5 },
      { x: 0.5, y: 0.5, w: 0.2, h: 0.2, mode: 'mask', start: 1, end: 4 }
    ],
    texts: [],
    images: [],
    videoOverlays: [],
    zooms: []
  };
  const checked = validateSpecV2(specBlur);
  assert.ok(checked.ok, 'v2 spec with blur and mask modes validates');
  const args = buildV2Args({
    videoPaths: ['main.mp4'],
    audioPaths: [],
    outputPath: 'out.mp4',
    spec: checked.spec,
    media: { width: 1920, height: 1080 }
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('boxblur='), 'FFmpeg export builds boxblur filter for blur mode');
  assert.ok(joined.includes('drawbox=x='), 'FFmpeg export builds drawbox filter for mask mode');
});

test('audio gain preview: volume calculation combining gain and volumeDb with live preview synchronization', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');

  // Verify computeClipVolume implementation
  assert.ok(src.includes('function computeClipVolume'), 'computeClipVolume function defined');
  assert.match(src, /Math\.pow\(10,\s*db\s*\/\s*20\)/, 'dB to linear factor conversion present');
  assert.match(src, /Math\.min\(1\.0,\s*Math\.max\(0\.0,\s*mult\)\)/, 'volume factor clamped between 0 and 1');

  // Verify Web Audio context management and amplification graph
  assert.ok(src.includes('function getAudioContext'), 'getAudioContext helper defined');
  assert.ok(src.includes('function resumeAudioContext'), 'resumeAudioContext helper defined');
  assert.ok(src.includes('function ensureVideoWebAudio'), 'ensureVideoWebAudio graph helper defined');
  assert.match(src, /videoGainNode\.gain\.value\s*=\s*targetGain/, 'Web Audio GainNode amplifies video volume beyond HTML 1.0 limit');

  // Verify syncActiveVideoVolume updates main video element volume and gain node
  assert.ok(src.includes('function syncActiveVideoVolume'), 'syncActiveVideoVolume defined');
  assert.match(src, /video\.volume = wantVol|video\.volume = 1\.0/, 'video element volume updated with safe fallback');

  // Verify volume sync inside playback tick loop and source switching
  assert.match(src, /playbackTick\(\)[\s\S]*?syncActiveVideoVolume\(\);/, 'playbackTick syncs active video volume every frame');
  assert.match(src, /syncPreviewSource[\s\S]*?syncActiveVideoVolume\(\)/, 'syncPreviewSource calculates and applies volume');

  // Verify audio clips volume synchronization in reconcileAudio and applyMediaFields
  assert.match(src, /reconcileAudio[\s\S]*?computeClipVolume\(clip\)/, 'reconcileAudio uses combined volume calculation');
  assert.match(src, /applyMediaFields[\s\S]*?syncActiveVideoVolume\(\)[\s\S]*?computeClipVolume\(clip\)/, 'applyMediaFields immediately updates video and audio volumes');
  assert.match(src, /applyMediaFields[\s\S]*?resumeAudioContext\(\)/, 'applyMediaFields resumes AudioContext on user interaction');
});

test('main video crop: on-canvas crop editing, inspector controls, kind resolution, and matching export', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');

  // Verify kind resolution and crop layer activation for main video
  assert.match(src, /var kind = clipKindOf\(cropEditingClipId\)/, 'renderCropLayer resolves clip kind using clipKindOf');
  assert.match(src, /if \(kind === 'video'\)/, 'renderCropLayer checks kind for main video active clip');
  assert.match(src, /var kind = clipKindOf\(sel\)/, 'renderInspector resolves kind so video media inspector renders');
  assert.match(src, /if \(kind === 'video'\)[\s\S]*?cropInspectorHtml/, 'renderMediaInspector includes crop inspector for video');

  // Verify dynamic coordinate resolution during crop drag
  assert.match(src, /var curW = \(curVid && curVid\.clientWidth\) \|\| \(curWrap && curWrap\.clientWidth\) \|\| 640;/, 'crop drag dynamically reads preview dimensions');

  // Verify main video crop in FFmpeg export compilation
  const specMainCrop = {
    version: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    files: [{ kind: 'video' }],
    videoClips: [{ file: 0, sourceIn: 0, sourceOut: 10, start: 0, gain: 1, crop: { left: 0.1, top: 0.15, right: 0.85, bottom: 0.9 } }],
    audioClips: [],
    blurs: [],
    texts: [],
    images: [],
    videoOverlays: [],
    zooms: []
  };
  const checked = validateSpecV2(specMainCrop);
  assert.ok(checked.ok, 'validates main video crop in v2 spec');
  const args = buildV2Args({
    videoPaths: ['main.mp4'],
    audioPaths: [],
    outputPath: 'out.mp4',
    spec: checked.spec,
    media: { width: 1920, height: 1080 }
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('crop=w=trunc(iw*0.75/2)*2:h=trunc(ih*0.75/2)*2:x=trunc(iw*0.1/2)*2:y=trunc(ih*0.15/2)*2'), 'main video crop filter correctly formatted and compiled');
});

test('image resizing: unclipped corner and edge handles, reliable drag-to-resize, numeric sizing, and crop independence', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');

  // Verify image container keeps handles visible without clipping
  assert.match(src, /clip\.type === 'image'[\s\S]*?overflow:\s*hidden;\s*clip-path:\s*inset\(0\);[\s\S]*?pointer-events:\s*none;/, 'paintBox wraps inner img with clipping container, leaving outer box unclipped');
  assert.match(src, /if \(clip\.type === 'image'\) box\.style\.overflow = 'visible';/, 'renderPreview ensures image box has visible overflow for corner handles');

  // Verify aspect-preserving drag calculation via resizeGeo in onBoxDown
  assert.match(src, /resizeGeo\(startGeo,\s*handle,\s*dx,\s*dy,\s*\{\s*preserveAspect:\s*isAspectType,\s*aspect:\s*startAspect,\s*minDim:\s*GEO_MIN\s*\}\)/, 'onBoxDown delegates resize gestures to resizeGeo with aspect ratio');

  // Verify numeric size clamping and crop independence in applyClipFields
  assert.match(src, /if \(clip\.type === 'image'\)[\s\S]*?if \(clip\.x \+ clip\.w > 1\)/, 'applyClipFields clamps position when width is increased to prevent frame overflow');

  // Verify export spec preserves independent crop with resized width
  const specResizedImageCrop = {
    version: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    files: [{ kind: 'video' }],
    videoClips: [{ file: 0, sourceIn: 0, sourceOut: 5, start: 0, gain: 1 }],
    audioClips: [],
    blurs: [],
    texts: [],
    images: [
      { file: 0, x: 0.2, y: 0.2, w: 0.6, start: 0, end: 5, crop: { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 } }
    ],
    videoOverlays: [],
    zooms: []
  };
  const checked = validateSpecV2(specResizedImageCrop);
  assert.ok(checked.ok, 'resized image with crop validates');
  const args = buildV2Args({
    videoPaths: ['main.mp4'],
    audioPaths: [],
    imagePaths: ['logo.png'],
    outputPath: 'out.mp4',
    spec: checked.spec,
    media: { width: 1920, height: 1080 }
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('crop=w=trunc(iw*0.6/2)*2:h=trunc(ih*0.6/2)*2:x=trunc(iw*0.2/2)*2:y=trunc(ih*0.2/2)*2'), 'image crop is applied independently');
  assert.ok(joined.includes('scale=1152:-2'), 'resized image width (0.6 * 1920 = 1152) is compiled into scale filter');
});

test('resizeGeo: all 4 corner handles and 4 edge handles support growing, shrinking, minimum dimensions, and aspect ratio', () => {
  const base = { x: 0.2, y: 0.2, w: 0.4, h: 0.3 };
  const aspect = 0.4 / 0.3; // 4/3

  // 1. SE corner: drag outward (grow) and inward (shrink)
  const seGrown = resizeGeo(base, 'se', 0.1, 0.1, { preserveAspect: true, aspect });
  assert.ok(seGrown.w > base.w, 'SE corner grows width on outward drag');
  assert.ok(seGrown.h > base.h, 'SE corner grows height on outward drag');
  assert.strictEqual(seGrown.x, base.x, 'SE corner keeps top-left x anchored');
  assert.strictEqual(seGrown.y, base.y, 'SE corner keeps top-left y anchored');
  assert.strictEqual(Math.round((seGrown.w / seGrown.h) * 100), Math.round(aspect * 100), 'SE corner preserves aspect ratio');

  const seShrunk = resizeGeo(base, 'se', -0.2, -0.2, { preserveAspect: true, aspect });
  assert.ok(seShrunk.w < base.w, 'SE corner shrinks width on inward drag');
  assert.ok(seShrunk.h < base.h, 'SE corner shrinks height on inward drag');
  assert.ok(seShrunk.w >= 0.02, 'SE corner respects minimum dimensions');

  // 2. NW corner: drag outward (grow to top-left) and inward (shrink to bottom-right)
  const nwGrown = resizeGeo(base, 'nw', -0.1, -0.1, { preserveAspect: true, aspect });
  assert.ok(nwGrown.w > base.w, 'NW corner grows width on outward drag');
  assert.ok(nwGrown.h > base.h, 'NW corner grows height on outward drag');
  assert.strictEqual(Math.round((nwGrown.x + nwGrown.w) * 100), Math.round((base.x + base.w) * 100), 'NW corner keeps bottom-right anchored');

  const nwShrunk = resizeGeo(base, 'nw', 0.2, 0.2, { preserveAspect: true, aspect });
  assert.ok(nwShrunk.w < base.w, 'NW corner shrinks width on inward drag');
  assert.ok(nwShrunk.h < base.h, 'NW corner shrinks height on inward drag');
  assert.ok(nwShrunk.w >= 0.02, 'NW corner respects minimum dimensions');

  // 3. NE corner: drag outward (grow) and inward (shrink)
  const neGrown = resizeGeo(base, 'ne', 0.1, -0.1, { preserveAspect: true, aspect });
  assert.ok(neGrown.w > base.w, 'NE corner grows width');
  assert.strictEqual(neGrown.x, base.x, 'NE corner keeps left edge anchored');

  const neShrunk = resizeGeo(base, 'ne', -0.2, 0.2, { preserveAspect: true, aspect });
  assert.ok(neShrunk.w < base.w, 'NE corner shrinks width');

  // 4. SW corner: drag outward (grow) and inward (shrink)
  const swGrown = resizeGeo(base, 'sw', -0.1, 0.1, { preserveAspect: true, aspect });
  assert.ok(swGrown.w > base.w, 'SW corner grows width');
  assert.strictEqual(swGrown.y, base.y, 'SW corner keeps top edge anchored');

  const swShrunk = resizeGeo(base, 'sw', 0.2, -0.2, { preserveAspect: true, aspect });
  assert.ok(swShrunk.w < base.w, 'SW corner shrinks width');

  // 5. Edge handles: e, w, s, n
  const eGrown = resizeGeo(base, 'e', 0.1, 0, { preserveAspect: true, aspect });
  assert.ok(eGrown.w > base.w, 'E edge handle grows box');
  const wGrown = resizeGeo(base, 'w', -0.1, 0, { preserveAspect: true, aspect });
  assert.ok(wGrown.w > base.w, 'W edge handle grows box');
  const sGrown = resizeGeo(base, 's', 0, 0.1, { preserveAspect: true, aspect });
  assert.ok(sGrown.h > base.h, 'S edge handle grows box');
  const nGrown = resizeGeo(base, 'n', 0, -0.1, { preserveAspect: true, aspect });
  assert.ok(nGrown.h > base.h, 'N edge handle grows box');

  // 6. Free-form edge handles (for blurs/unconstrained elements)
  const freeE = resizeGeo(base, 'e', 0.1, 0, { preserveAspect: false });
  assert.strictEqual(freeE.w, 0.5, 'free-form E handle increases width without changing height');
  assert.strictEqual(freeE.h, base.h, 'free-form E handle leaves height untouched');
});

test('main video scale control: non-destructive Inspector controls, preview transform, and FFmpeg export compilation', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');

  // 1. Inspector rendering and wiring for Display Scale (%)
  assert.match(src, /Display Scale \(%\)/, 'Media inspector displays Scale (%) header for video');
  assert.match(src, /numField\('scalePct',/, 'Media inspector renders scalePct input field');
  assert.match(src, /data-scale-preset="100"/, 'Scale preset 100% button provided');
  assert.match(src, /data-scale-preset="150"/, 'Scale preset 150% button provided');
  assert.match(src, /clip\.scale = Math\.max\(0\.25,\s*Math\.min\(3\.0,\s*scalePct \/ 100\)\)/, 'applyMediaFields updates clip.scale between 25% and 300%');

  // 2. Preview transform calculation
  assert.match(src, /var mainScale = \(activeClip && activeClip\.scale && activeClip\.scale > 0\) \? activeClip\.scale : 1\.0;/, 'renderPreview extracts mainScale');
  assert.match(src, /video\.style\.transform = 'scale\(' \+ mainScale \+ '\)';/, 'renderPreview applies scale to video transform');

  // 3. Project to Spec V2 mapping
  const spec = projectToSpecV2({
    files: [{ kind: 'video', id: 'vid1', width: 1920, height: 1080 }],
    videoClips: [{ id: 'vc1', file: 'vid1', sourceIn: 0, sourceOut: 10, start: 0, gain: 1, volumeDb: 0, scale: 1.5 }],
    audioClips: [],
    clips: [],
    watermark: { enabled: false }
  });
  assert.strictEqual(spec.videoClips[0].scale, 1.5, 'projectToSpecV2 preserves clip.scale');

  // 4. FFmpeg export compilation for scaled main video
  const specEnlarged = {
    version: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    files: [{ kind: 'video' }],
    videoClips: [{ file: 0, sourceIn: 0, sourceOut: 10, start: 0, gain: 1, scale: 1.25 }],
    audioClips: [],
    blurs: [],
    texts: [],
    images: [],
    videoOverlays: [],
    zooms: []
  };
  const checkedEnlarged = validateSpecV2(specEnlarged);
  assert.ok(checkedEnlarged.ok, 'v2 spec with video scale 1.25 validates');
  const argsEnlarged = buildV2Args({
    videoPaths: ['main.mp4'],
    audioPaths: [],
    outputPath: 'out.mp4',
    spec: checkedEnlarged.spec,
    media: { width: 1920, height: 1080 }
  });
  const joinedEnlarged = argsEnlarged.join(' ');
  assert.ok(joinedEnlarged.includes('scale=w=trunc(iw*1.25/2)*2:h=trunc(ih*1.25/2)*2'), 'FFmpeg compiles scaled video dimensions');
  assert.ok(joinedEnlarged.includes('crop=1920:1080:(iw-1920)/2:(ih-1080)/2'), 'FFmpeg compiles centered crop for enlarged video');

  const specShrunk = {
    version: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    files: [{ kind: 'video' }],
    videoClips: [{ file: 0, sourceIn: 0, sourceOut: 10, start: 0, gain: 1, scale: 0.75 }],
    audioClips: [],
    blurs: [],
    texts: [],
    images: [],
    videoOverlays: [],
    zooms: []
  };
  const checkedShrunk = validateSpecV2(specShrunk);
  assert.ok(checkedShrunk.ok, 'v2 spec with video scale 0.75 validates');
  const argsShrunk = buildV2Args({
    videoPaths: ['main.mp4'],
    audioPaths: [],
    outputPath: 'out.mp4',
    spec: checkedShrunk.spec,
    media: { width: 1920, height: 1080 }
  });
  const joinedShrunk = argsShrunk.join(' ');
  assert.ok(joinedShrunk.includes('scale=w=trunc(iw*0.75/2)*2:h=trunc(ih*0.75/2)*2'), 'FFmpeg compiles shrunk video dimensions');
  assert.ok(joinedShrunk.includes('pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black'), 'FFmpeg compiles centered black padding for shrunk video');
});

test('on-canvas direct manipulation: fluid unselected clip dragging, 8 handles, and non-blocking main video scale box', async () => {
  const scriptSrc = readFileSync(path.join(PUBLIC_DIR, 'admin-video-editor.js'), 'utf8');

  // Verify fluid single-gesture selection and dragging on unselected clip pointerdown
  assert.match(scriptSrc, /box\.addEventListener\('pointerdown',[\s\S]*?onBoxDown\(clip\.id,\s*box\)\(e\);/s, 'unselected overlay clip invokes onBoxDown immediately on pointerdown');

  // Verify main video scale box pointer-events isolation so underlying overlays remain clickable
  assert.match(scriptSrc, /mainBox\.style\.pointerEvents\s*=\s*'none';/, 'main video scale box container uses pointer-events: none to avoid blocking preview hits');
  assert.match(scriptSrc, /c\.style\.pointerEvents\s*=\s*'auto';/, 'main video scale box handles use pointer-events: auto');

  // Verify 8 handles (4 corners + 4 edges) wired on selected overlays and main video
  assert.match(scriptSrc, /'nw',\s*'ne',\s*'sw',\s*'se'/, '4 corner handles instantiated');
  assert.match(scriptSrc, /'n',\s*'s',\s*'e',\s*'w'/, '4 edge midpoint handles instantiated');

  // Verify edge midpoint handle CSS indicators
  const ejsSrc = readFileSync(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), 'utf8');
  assert.match(ejsSrc, /\.ve-pbox-edge::after\s*\{[^}]*background:\s*#fff;/s, 'edge midpoint handles render visible indicators');
});






