import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import {
  checkEdlEvidence,
  checkEvidenceEdge,
  validateEdlStructure,
  allowlistedEdlSource,
  edlToSpecV2,
  edlCutSummary
} from '../src/library/edl-evidence.js';
import { validateSpecV2 } from '../src/library/video-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');

function sampleTranscript() {
  return {
    sources: {
      MAIN: {
        duration: 12.0,
        words: [
          { text: 'Welcome', start: 0.2, end: 0.6 },
          { text: 'back', start: 0.7, end: 0.9 },
          { text: 'everyone.', start: 1.0, end: 1.5 },
          { text: 'Today', start: 1.9, end: 2.2 },
          { text: 'we', start: 2.3, end: 2.4 },
          { text: 'look', start: 2.5, end: 2.8 },
          { text: 'at', start: 2.9, end: 3.0 },
          { text: 'queries.', start: 3.1, end: 3.8 },
          { text: 'Finally,', start: 8.2, end: 8.6 },
          { text: 'thanks', start: 8.7, end: 9.1 },
          { text: 'for', start: 9.2, end: 9.3 },
          { text: 'watching.', start: 9.4, end: 9.9 }
        ]
      }
    }
  };
}

function sampleEdl(overrides = {}) {
  return {
    version: 1,
    width: 1280,
    height: 720,
    sources: { MAIN: 'clip.mp4' },
    ranges: [
      { source: 'MAIN', start: 0.0, end: 4.0, beat: 'INTRO', quote: 'n/a', reason: 'keep' },
      { source: 'MAIN', start: 8.0, end: 12.0, beat: 'OUTRO', quote: 'n/a', reason: 'keep' }
    ],
    overlays: [],
    texts: [],
    watermark: null,
    total_duration_s: 8.0,
    ...overrides
  };
}

test('evidence: valid EDL passes with silence edges and skipped n/a quotes', () => {
  const r = checkEdlEvidence(sampleEdl(), sampleTranscript());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('evidence: mid-word edge rejected', () => {
  const edl = sampleEdl();
  edl.ranges[0].end = 1.2;
  edl.total_duration_s = 5.2;
  const r = checkEdlEvidence(edl, sampleTranscript());
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /inside word/);
});

test('evidence: out-of-bounds edge rejected', () => {
  const edl = sampleEdl();
  edl.ranges[1].end = 14.0;
  edl.total_duration_s = 10.0;
  const r = checkEdlEvidence(edl, sampleTranscript());
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /outside source duration/);
});

test('evidence: non-verbatim quote rejected, verbatim passes', () => {
  const bad = sampleEdl();
  bad.ranges[0].quote = 'Welcome everyone today';
  assert.match(checkEdlEvidence(bad, sampleTranscript()).errors.join(' '), /contiguous/);
  const good = sampleEdl();
  good.ranges[0].quote = 'Welcome back everyone';
  assert.equal(checkEdlEvidence(good, sampleTranscript()).ok, true);
});

test('evidence: speech word-boundary cut passes with warning, never an error', () => {
  const words = sampleTranscript().sources.MAIN.words;
  const r = checkEvidenceEdge(words, 12.0, 0.9, 'probe');
  assert.equal(r.ok, true);
  assert.match(String(r.warning), /word-boundary cut during speech/);
});

test('evidence: empty and malformed word lists fail closed', () => {
  const empty = sampleTranscript();
  empty.sources.MAIN.words = [];
  assert.match(checkEdlEvidence(sampleEdl(), empty).errors.join(' '), /no transcript words/);
  const malformed = sampleTranscript();
  malformed.sources.MAIN.words = [{ text: 'hi' }];
  assert.match(checkEdlEvidence(sampleEdl(), malformed).errors.join(' '), /malformed/);
  const uncovered = sampleTranscript();
  delete uncovered.sources.MAIN;
  assert.match(checkEdlEvidence(sampleEdl(), uncovered).errors.join(' '), /no transcript coverage/);
});

test('structure: valid passes; unknown source, bad spans, and total mismatch fail', () => {
  assert.equal(validateEdlStructure(sampleEdl()).ok, true);
  const ghost = sampleEdl();
  ghost.ranges[0].source = 'GHOST';
  assert.match(validateEdlStructure(ghost).error, /unknown source/);
  const span = sampleEdl();
  span.ranges[0].end = 0.05;
  assert.match(validateEdlStructure(span).error, /at least 0.1s/);
  const total = sampleEdl();
  total.total_duration_s = 9.0;
  assert.match(validateEdlStructure(total).error, /total_duration_s/);
  const nullEntry = sampleEdl();
  nullEntry.ranges[1] = null;
  assert.match(validateEdlStructure(nullEntry).error, /must be an object/);
});

test('structure: malformed texts/overlays fail closed, null stays absent', () => {
  for (const [mutate, pattern] of [
    [(e) => { e.texts = 'x'; }, /texts must be an array/],
    [(e) => { e.texts = [null]; }, /texts\[0\] must be an object/],
    [(e) => { e.texts = [42]; }, /texts\[0\] must be an object/],
    [(e) => { e.overlays = 'x'; }, /overlays must be an array/],
    [(e) => { e.overlays = [null]; }, /overlays\[0\] must be an object/],
  ]) {
    const edl = sampleEdl();
    mutate(edl);
    const r = validateEdlStructure(edl);
    assert.equal(r.ok, false, `rejected: ${pattern}`);
    assert.match(r.error, pattern);
  }
  const absent = sampleEdl();
  absent.texts = null;
  absent.overlays = null;
  assert.equal(validateEdlStructure(absent).ok, true, 'null collections stay absent');
});

test('dimensions: omitted default to documented HD; valid pass through; invalid fail explicitly', () => {
  // Omitted -> 1280x720 defaults, and the defaulted spec validates.
  const omitted = sampleEdl();
  delete omitted.width;
  delete omitted.height;
  assert.equal(validateEdlStructure(omitted).ok, true);
  const spec = edlToSpecV2(omitted);
  assert.equal(spec.width, 1280);
  assert.equal(spec.height, 720);
  assert.equal(validateSpecV2(spec).ok, true);
  // Valid explicit dimensions pass through untouched.
  const hd = sampleEdl();
  hd.width = 1920;
  hd.height = 1080;
  assert.equal(validateEdlStructure(hd).ok, true);
  assert.equal(edlToSpecV2(hd).width, 1920);
  assert.equal(edlToSpecV2(hd).height, 1080);
  // Invalid: zero, oversized, fractional, non-numeric — never coerced.
  for (const [w, h] of [[0, 720], [1280, 0], [10000, 720], [1280, 10000], [1280.5, 720], [1280, 200.25], ['wide', 720], [1280, 'tall']]) {
    const bad = sampleEdl();
    bad.width = w;
    bad.height = h;
    const r = validateEdlStructure(bad);
    assert.equal(r.ok, false, `rejected: ${w}x${h}`);
    assert.match(r.error, /integers between 16 and 7680/);
    assert.throws(() => edlToSpecV2(bad), /integers between 16 and 7680/);
  }
  // Half-provided dimensions are rejected, not half-defaulted.
  const half = sampleEdl();
  delete half.height;
  assert.match(validateEdlStructure(half).error, /provided together/);
});

test('mapping: malformed collections throw controlled errors, never TypeErrors', () => {
  const cases = [
    [{ ranges: [{ source: 'MAIN', start: 0, end: 1 }] }, /sources map/],
    [{ sources: {}, ranges: [], texts: 'x' }, /texts must be an array/],
    [{ sources: {}, ranges: [], overlays: 'x' }, /overlays must be an array/],
    [{ sources: {}, ranges: [], texts: [null] }, /texts\[0\] must be an object/],
    [{ sources: {}, ranges: [], overlays: [42] }, /overlays\[0\] must be an object/],
  ];
  for (const [input, pattern] of cases) {
    let err = null;
    try {
      edlToSpecV2(input);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `threw for ${pattern}`);
    assert.ok(!(err instanceof TypeError), `controlled, not TypeError, for ${pattern}`);
    assert.match(err.message, pattern);
  }
  // Null collections coerce to absent (matches the structural gate).
  const spec = edlToSpecV2({ sources: { MAIN: 'a.mp4' }, ranges: [{ source: 'MAIN', start: 0, end: 1 }], texts: null, overlays: null });
  assert.deepEqual(spec.texts, []);
  assert.deepEqual(spec.videoOverlays, []);
});

test('allowlist: bare names pass; paths, absolute, dotfiles, and long names fail', () => {
  assert.equal(allowlistedEdlSource('clip.mp4', null), 'clip.mp4');
  assert.equal(allowlistedEdlSource('clip.mp4', ['clip.mp4']), 'clip.mp4');
  assert.equal(allowlistedEdlSource('other.mp4', ['clip.mp4']), null);
  for (const evil of ['../x.mp4', 'a/b.mp4', 'a\\b.mp4', '/etc/passwd', 'C:/x.mp4', '.hidden.mp4', ' x.mp4', 'x'.repeat(129)]) {
    assert.equal(allowlistedEdlSource(evil, null), null, `rejected: ${evil}`);
  }
});

test('mapping: EDL converts to a valid V2 spec with cumulative output starts', () => {
  const spec = edlToSpecV2(sampleEdl());
  const checked = validateSpecV2(spec);
  assert.equal(checked.ok, true);
  assert.equal(checked.spec.contentEnd, 8);
  assert.deepEqual(checked.spec.videoClips.map((c) => [c.sourceIn, c.sourceOut, c.start]), [[0, 4, 0], [8, 12, 4]]);
});

test('summary: kept ranges, removed intervals, and expected duration', () => {
  const s = edlCutSummary(sampleEdl());
  assert.equal(s.expectedDuration, 8);
  assert.deepEqual(s.removed, [{ source: 'MAIN', start: 4, end: 8 }]);
  assert.equal(s.kept.length, 2);
});

test('admin video editor page renders the evidence panel without touching editor hooks', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-video-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    editorAvailable: true
  });
  for (const hook of [
    'video-editor-evidence-section', 'video-editor-evidence-toggle',
    'video-editor-evidence-edl',
    'video-editor-evidence-transcript', 'video-editor-evidence-validate',
    'video-editor-evidence-generate', 'video-editor-evidence-result',
    'video-editor-evidence-summary', 'video-editor-evidence-note'
  ]) {
    assert.match(html, new RegExp(hook), `evidence hook present: ${hook}`);
  }
  assert.doesNotMatch(html, /video-editor-evidence-source/, 'unused source input removed');
  assert.match(html, /\/edl-evidence-panel\.js/, 'evidence panel script referenced');
  assert.match(html, /no AI transcription/, 'manual-transcript notice present');
  // Existing editor surface untouched.
  assert.match(html, /video-editor-timeline/, 'timeline still present');
  assert.match(html, /video-editor-export/, 'export still present');
});

test('server wires admin-only evidence routes with local-only gate and no render path', () => {
  for (const route of ['/api/admin/edl-evidence/validate', '/api/admin/edl-evidence/generate']) {
    assert.match(SERVER_SRC, new RegExp(`app\\.post\\('${route.replace(/\//g, '\\/')}', requireApiAuth, requireAdmin`),
      `route registered with admin auth: ${route}`);
  }
  const start = SERVER_SRC.indexOf('/api/admin/edl-evidence/validate');
  const end = SERVER_SRC.indexOf('// Local-only Admin/Owner video export. Disabled in production', start);
  assert.ok(start > 0 && end > start, 'evidence route block located');
  const block = SERVER_SRC.slice(start, end);
  assert.match(block, /isVideoEditorAvailable\(\)/, 'local-only gate present');
  assert.match(block, /validateSpecV2\(spec\)/, 'generate re-validates via existing validator');
  assert.doesNotMatch(block, /spawn\s*\(/, 'no child processes in evidence routes');
  assert.doesNotMatch(block, /buildFfmpegArgs\s*\(/, 'no ffmpeg graph construction in evidence routes');
});
