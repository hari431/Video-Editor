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
  cropPdf,
  validatePdfCropUpload,
  validatePdfCropMargins,
  cropDownloadName,
  isPdfCropAvailable,
  pdfCropMaxRequestBytes,
  PDF_CROP_MAX_FILE_MB,
  PDF_CROP_MAX_FILE_BYTES,
  PDF_CROP_MAX_PAGES,
  PDF_CROP_MAX_MARGIN
} from '../src/library/pdf-crop.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const CROP_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-crop.js', import.meta.url)), 'utf8');

const sixPage = () => readFileSync(path.join(FIXTURES_DIR, 'split-6page-plain.pdf'));
const alreadyEnc = () => readFileSync(path.join(FIXTURES_DIR, 'unlock-rich-rc4.pdf'));
const sha256 = b => createHash('sha256').update(b).digest('hex');

async function cropBoxes(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map(p => {
    const b = p.getCropBox();
    return [b.x, b.y, b.width, b.height];
  });
}

async function opLists(bytes) {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    out.push((await (await doc.getPage(n)).getOperatorList()).fnArray.join(','));
  }
  await task.destroy();
  return out;
}

test('crop: all pages with uniform margins', async () => {
  const out = Buffer.from(await cropPdf(Buffer.from(sixPage()), {
    margins: { top: 50, right: 50, bottom: 50, left: 50 }, scope: 'all'
  }));
  const boxes = await cropBoxes(out);
  // Page 1 is 595x842; page 3 is 300x400.
  assert.deepEqual(boxes[0], [50, 50, 495, 742]);
  assert.deepEqual(boxes[2], [50, 50, 200, 300]);
  // Content streams untouched.
  const before = await opLists(sixPage());
  const after = await opLists(out);
  assert.deepEqual(after, before, 'content identical after crop');
});

test('crop: selected pages only, others keep their boxes', async () => {
  const out = Buffer.from(await cropPdf(Buffer.from(sixPage()), {
    margins: { top: 10, right: 20, bottom: 30, left: 40 }, scope: 'range', selectionText: '1,4'
  }));
  const boxes = await cropBoxes(out);
  assert.deepEqual(boxes[0], [40, 30, 535, 802]);
  assert.deepEqual(boxes[1], [0, 0, 595, 842], 'page 2 untouched');
  assert.deepEqual(boxes[3], [40, 30, 535, 802], 'page 4 (595x842) cropped');
});

test('crop: margin validation', () => {
  assert.deepEqual(validatePdfCropMargins({ top: 10, right: 0, bottom: 0, left: 0 }),
    { ok: true, margins: { top: 10, right: 0, bottom: 0, left: 0 } });
  assert.equal(validatePdfCropMargins({}).ok, false, 'all-zero margins rejected');
  assert.equal(validatePdfCropMargins({ top: -1, right: 0, bottom: 0, left: 0 }).ok, false);
  assert.equal(validatePdfCropMargins({ top: PDF_CROP_MAX_MARGIN + 1, right: 0, bottom: 0, left: 0 }).ok, false);
  assert.equal(validatePdfCropMargins({ top: 'x', right: 0, bottom: 0, left: 0 }).ok, false);
  assert.equal(validatePdfCropMargins({ top: 0, right: 0, bottom: 0, left: 0 }).ok, false, 'all-zero rejected');
  assert.equal(cropDownloadName('Report Q3.pdf'), 'Report_Q3-cropped.pdf');
  assert.equal(cropDownloadName('../../evil.pdf'), 'evil-cropped.pdf');
});

test('crop: invalid input rejected', async () => {
  await assert.rejects(cropPdf(Buffer.from('not a pdf'), { margins: { top: 10, right: 10, bottom: 10, left: 10 }, scope: 'all' }), /could not be read/);
  await assert.rejects(cropPdf(Buffer.alloc(0), { margins: { top: 10, right: 10, bottom: 10, left: 10 }, scope: 'all' }), /empty/);
  await assert.rejects(cropPdf(Buffer.from(alreadyEnc()), { margins: { top: 10, right: 10, bottom: 10, left: 10 }, scope: 'all' }), /password-protected/);
  const m = { top: 10, right: 10, bottom: 10, left: 10 };
  await assert.rejects(cropPdf(Buffer.from(sixPage()), { margins: { top: 0, right: 0, bottom: 0, left: 0 }, scope: 'all' }), /at least one margin/);
  await assert.rejects(cropPdf(Buffer.from(sixPage()), { margins: m, scope: 'range', selectionText: '' }), /Enter pages/);
  await assert.rejects(cropPdf(Buffer.from(sixPage()), { margins: m, scope: 'range', selectionText: '99' }), /out of range/);
  await assert.rejects(cropPdf(Buffer.from(sixPage()), { margins: m, scope: 'range', selectionText: '2,2' }), /Duplicate/);
  // Margins larger than the page are rejected, not silently clipped.
  await assert.rejects(
    cropPdf(Buffer.from(sixPage()), { margins: { top: 0, right: 290, bottom: 0, left: 290 }, scope: 'range', selectionText: '3' }),
    /too large/
  );
  assert.equal(validatePdfCropUpload({ name: 'evil.exe', size: 100 }).ok, false);
});

test('crop: input bytes are never mutated', async () => {
  const input = sixPage();
  const before = sha256(input);
  await cropPdf(Buffer.from(input), { margins: { top: 10, right: 10, bottom: 10, left: 10 }, scope: 'all' });
  assert.equal(sha256(input), before);
});

test('crop: limits match the PDF editor tooling', async () => {
  assert.equal(PDF_CROP_MAX_FILE_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_CROP_MAX_PAGES, PDF_EDITOR_MAX_PAGES);
  assert.ok(pdfCropMaxRequestBytes() > 0);
  assert.equal(validatePdfCropUpload(null).ok, false);
  const over = validatePdfCropUpload({ name: 'a.pdf', size: PDF_CROP_MAX_FILE_BYTES + 1 });
  assert.equal(over.ok, false);
  const huge = Buffer.alloc(PDF_CROP_MAX_FILE_BYTES + 1);
  await assert.rejects(
    cropPdf(huge, { margins: { top: 10, right: 10, bottom: 10, left: 10 }, scope: 'all' }),
    new RegExp(`exceeds ${PDF_CROP_MAX_FILE_MB} MB`)
  );
  const big = await PDFDocument.create();
  for (let i = 0; i < PDF_CROP_MAX_PAGES + 1; i++) big.addPage([200, 200]);
  await assert.rejects(
    cropPdf(Buffer.from(await big.save()), { margins: { top: 10, right: 10, bottom: 10, left: 10 }, scope: 'all' }),
    new RegExp(`max ${PDF_CROP_MAX_PAGES}`)
  );
});

test('crop: server wires admin-only routes', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/crop', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/crop', requireApiAuth, requireAdmin"), 'API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-crop.js'"), 'dedicated pdf-crop library used');
  assert.ok(SERVER_SRC.includes('isPdfCropAvailable()'), 'production gate enforced');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/crop'"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'crop handler never logs');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker|canvas/i.test(handler), 'no shell/native workflows');
  const libCode = CROP_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
  assert.ok(libCode.includes('setCropBox'), 'CropBox engine used (no rasterization)');
});

test('crop: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfCropAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfCropAvailable({}), true);
  assert.equal(isPdfCropAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfCropAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
});

test('crop: admin page renders picker + margins + scope UI', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-crop.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfCropAvailable: true,
    pdfCropMaxFileMb: 50
  });
  for (const hook of [
    'pdf-crop-root', 'pdf-crop-file', 'pdf-crop-top', 'pdf-crop-right', 'pdf-crop-bottom',
    'pdf-crop-left', 'pdf-crop-scope-all', 'pdf-crop-scope-range', 'pdf-crop-selection',
    'pdf-crop-submit', 'pdf-crop-status', 'pdf-crop-result', 'pdf-crop-progress',
    'pdf-crop-clear', 'pdf-crop-pick', 'pdf-crop-fileinfo'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-crop\.js(\?v=\d+)?"/, 'client loads as ES module');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-crop.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfCropAvailable: false,
    pdfCropMaxFileMb: 50
  });
  assert.match(disabled, /pdf-crop-disabled/, 'disabled notice when unavailable');
});

test('crop: client posts file+margins+scope', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-crop.js'), 'utf8');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/crop'"), 'posts to crop API');
  assert.ok(src.includes("form.append('pdf'"), 'uploads the PDF');
  assert.ok(src.includes("form.append('marginTop'"), 'sends margins');
  assert.ok(src.includes("form.append('scope'"), 'sends the scope');
  assert.ok(src.includes('GlobalWorkerOptions.workerSrc'), 'vendored pdf.js worker, no CDN');
  assert.ok(!src.includes('console.log'), 'client never logs');
});

test('crop: admin nav links the tool under PDF', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/crop/, 'nav links the tool');
  assert.match(nav, /Crop PDF/, 'nav label present');
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  assert.ok(nav.indexOf('href="/admin/pdf-tools/crop"') > pdfLabelIdx, 'link sits under the PDF group');
  const onPage = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/pdf-tools/crop' });
  assert.match(onPage, /<a href="\/admin\/pdf-tools\/crop" class="nav-link active"/, 'item highlights');
});
