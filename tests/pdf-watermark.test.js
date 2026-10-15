import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  addWatermark,
  validatePdfWatermarkUpload,
  validatePdfWatermarkOptions,
  watermarkDownloadName,
  isPdfWatermarkAvailable,
  pdfWatermarkMaxRequestBytes,
  PDF_WATERMARK_POSITIONS,
  PDF_WATERMARK_MAX_FILE_MB,
  PDF_WATERMARK_MAX_FILE_BYTES,
  PDF_WATERMARK_MAX_PAGES
} from '../src/library/pdf-watermark.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const WATERMARK_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-watermark.js', import.meta.url)), 'utf8');

const sixPage = () => readFileSync(path.join(FIXTURES_DIR, 'split-6page-plain.pdf'));
const alreadyEnc = () => readFileSync(path.join(FIXTURES_DIR, 'unlock-rich-rc4.pdf'));
const sha256 = b => createHash('sha256').update(b).digest('hex');

async function pageTexts(bytes) {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const tc = await (await doc.getPage(n)).getTextContent();
    out.push(tc.items.map(i => i.str).join(' '));
  }
  await task.destroy();
  return out;
}

const baseOpts = { text: 'DRAFT', position: 'center', fontSize: 64, color: '#888888', opacity: 0.25, angle: -45, scope: 'all' };

test('watermark: all pages stamped, content preserved', async () => {
  const out = Buffer.from(await addWatermark(Buffer.from(sixPage()), baseOpts));
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 6);
  const texts = await pageTexts(out);
  for (let i = 0; i < 6; i++) {
    assert.ok(texts[i].includes('DRAFT'), `page ${i + 1} watermarked`);
    assert.ok(texts[i].includes(`ALPHA-${i + 1}`), 'underlying content preserved');
  }
});

test('watermark: range, positions and styling', async () => {
  const out = Buffer.from(await addWatermark(Buffer.from(sixPage()), {
    text: 'CONFIDENTIAL', position: 'top-right', fontSize: 48, color: '#FF0000',
    opacity: 0.5, angle: 0, scope: 'range', selectionText: '2,5'
  }));
  const texts = await pageTexts(out);
  assert.ok(!texts[0].includes('CONFIDENTIAL'), 'page 1 untouched');
  assert.ok(texts[1].includes('CONFIDENTIAL'), 'page 2 stamped');
  assert.ok(texts[4].includes('CONFIDENTIAL'), 'page 5 stamped');
  for (const pos of ['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    const r = await addWatermark(Buffer.from(sixPage()), {
      ...baseOpts, text: 'WM', position: pos, scope: 'range', selectionText: '1'
    });
    assert.ok((await pageTexts(r))[0].includes('WM'), `position ${pos} renders`);
  }
});

test('watermark: option validation', () => {
  assert.equal(validatePdfWatermarkOptions({ ...baseOpts, text: '' }).ok, false);
  assert.equal(validatePdfWatermarkOptions({ ...baseOpts, text: 'a\nb' }).ok, false);
  assert.equal(validatePdfWatermarkOptions({ ...baseOpts, text: 'x'.repeat(201) }).ok, false);
  assert.equal(validatePdfWatermarkOptions({ ...baseOpts, position: 'middle' }).ok, false);
  assert.equal(validatePdfWatermarkOptions({ ...baseOpts, fontSize: 11 }).ok, false);
  assert.equal(validatePdfWatermarkOptions({ ...baseOpts, fontSize: 201 }).ok, false);
  assert.equal(validatePdfWatermarkOptions({ ...baseOpts, color: 'red' }).ok, false);
  assert.equal(validatePdfWatermarkOptions({ ...baseOpts, opacity: 2 }).ok, false);
  assert.equal(validatePdfWatermarkOptions({ ...baseOpts, angle: 91 }).ok, false);
  assert.deepEqual(validatePdfWatermarkOptions({ text: 'Hi' }).options.position, 'center');
  assert.deepEqual(PDF_WATERMARK_POSITIONS, ['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right']);
  assert.equal(watermarkDownloadName('Report Q3.pdf'), 'Report_Q3-watermarked.pdf');
  assert.equal(watermarkDownloadName('../../evil.pdf'), 'evil-watermarked.pdf');
});

test('watermark: invalid input rejected', async () => {
  await assert.rejects(addWatermark(Buffer.from('not a pdf'), baseOpts), /could not be read/);
  await assert.rejects(addWatermark(Buffer.alloc(0), baseOpts), /empty/);
  await assert.rejects(addWatermark(Buffer.from(alreadyEnc()), baseOpts), /password-protected/);
  await assert.rejects(addWatermark(Buffer.from(sixPage()), { ...baseOpts, scope: 'range', selectionText: '' }), /Enter pages/);
  await assert.rejects(addWatermark(Buffer.from(sixPage()), { ...baseOpts, scope: 'range', selectionText: '99' }), /out of range/);
  await assert.rejects(addWatermark(Buffer.from(sixPage()), { ...baseOpts, scope: 'range', selectionText: '1,1' }), /Duplicate/);
  assert.equal(validatePdfWatermarkUpload({ name: 'evil.exe', size: 100 }).ok, false);
});

test('watermark: input bytes are never mutated', async () => {
  const input = sixPage();
  const before = sha256(input);
  await addWatermark(Buffer.from(input), baseOpts);
  assert.equal(sha256(input), before);
});

test('watermark: limits match the PDF editor tooling', async () => {
  assert.equal(PDF_WATERMARK_MAX_FILE_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_WATERMARK_MAX_PAGES, PDF_EDITOR_MAX_PAGES);
  assert.ok(pdfWatermarkMaxRequestBytes() > 0);
  assert.equal(validatePdfWatermarkUpload(null).ok, false);
  const over = validatePdfWatermarkUpload({ name: 'a.pdf', size: PDF_WATERMARK_MAX_FILE_BYTES + 1 });
  assert.equal(over.ok, false);
  const huge = Buffer.alloc(PDF_WATERMARK_MAX_FILE_BYTES + 1);
  await assert.rejects(addWatermark(huge, baseOpts), new RegExp(`exceeds ${PDF_WATERMARK_MAX_FILE_MB} MB`));
  const big = await PDFDocument.create();
  for (let i = 0; i < PDF_WATERMARK_MAX_PAGES + 1; i++) big.addPage([200, 200]);
  await assert.rejects(
    addWatermark(Buffer.from(await big.save()), baseOpts),
    new RegExp(`max ${PDF_WATERMARK_MAX_PAGES}`)
  );
});

test('watermark: server wires admin-only routes', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/watermark', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/watermark', requireApiAuth, requireAdmin"), 'API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-watermark.js'"), 'dedicated pdf-watermark library used');
  assert.ok(SERVER_SRC.includes('isPdfWatermarkAvailable()'), 'production gate enforced');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/watermark'"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'watermark handler never logs');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker|canvas/i.test(handler), 'no shell/native workflows');
  const libCode = WATERMARK_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
});

test('watermark: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfWatermarkAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfWatermarkAvailable({}), true);
  assert.equal(isPdfWatermarkAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfWatermarkAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
});

test('watermark: admin page renders picker + options + scope UI', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-watermark.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfWatermarkAvailable: true,
    pdfWatermarkMaxFileMb: 50
  });
  for (const hook of [
    'pdf-watermark-root', 'pdf-watermark-file', 'pdf-watermark-text', 'pdf-watermark-position',
    'pdf-watermark-size', 'pdf-watermark-color', 'pdf-watermark-opacity', 'pdf-watermark-angle',
    'pdf-watermark-scope-all', 'pdf-watermark-scope-range', 'pdf-watermark-selection',
    'pdf-watermark-submit', 'pdf-watermark-status', 'pdf-watermark-result',
    'pdf-watermark-progress', 'pdf-watermark-clear', 'pdf-watermark-pick', 'pdf-watermark-fileinfo'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-watermark\.js(\?v=\d+)?"/, 'client loads as ES module');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-watermark.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfWatermarkAvailable: false,
    pdfWatermarkMaxFileMb: 50
  });
  assert.match(disabled, /pdf-watermark-disabled/, 'disabled notice when unavailable');
});

test('watermark: client posts file+options+scope', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-watermark.js'), 'utf8');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/watermark'"), 'posts to watermark API');
  assert.ok(src.includes("form.append('pdf'"), 'uploads the PDF');
  assert.ok(src.includes("form.append('text'"), 'sends text');
  assert.ok(src.includes("form.append('opacity'"), 'sends opacity');
  assert.ok(src.includes("form.append('scope'"), 'sends the scope');
  assert.ok(src.includes('GlobalWorkerOptions.workerSrc'), 'vendored pdf.js worker, no CDN');
  assert.ok(!src.includes('console.log'), 'client never logs');
});

test('watermark: admin nav links the tool under PDF', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/watermark/, 'nav links the tool');
  assert.match(nav, /Watermark PDF/, 'nav label present');
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  assert.ok(nav.indexOf('href="/admin/pdf-tools/watermark"') > pdfLabelIdx, 'link sits under the PDF group');
  const onPage = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/pdf-tools/watermark' });
  assert.match(onPage, /<a href="\/admin\/pdf-tools\/watermark" class="nav-link active"/, 'item highlights');
});
