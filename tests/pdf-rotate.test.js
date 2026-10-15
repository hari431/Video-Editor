import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { PDFDocument } from 'pdf-lib';
import {
  rotatePdf,
  validatePdfRotateUpload,
  validatePdfRotateAngle,
  rotateDownloadName,
  isPdfRotateAvailable,
  pdfRotateMaxRequestBytes,
  PDF_ROTATE_ANGLES,
  PDF_ROTATE_MAX_FILE_MB,
  PDF_ROTATE_MAX_FILE_BYTES,
  PDF_ROTATE_MAX_PAGES
} from '../src/library/pdf-rotate.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const ROTATE_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-rotate.js', import.meta.url)), 'utf8');

const sixPage = () => readFileSync(path.join(FIXTURES_DIR, 'split-6page-plain.pdf'));
const alreadyEnc = () => readFileSync(path.join(FIXTURES_DIR, 'unlock-rich-rc4.pdf'));
const sha256 = b => createHash('sha256').update(b).digest('hex');
const rotationsOf = async bytes => (await PDFDocument.load(bytes)).getPages().map(p => p.getRotation().angle);

test('rotate: all pages +90', async () => {
  const out = Buffer.from(await rotatePdf(Buffer.from(sixPage()), { angle: 90, scope: 'all' }));
  assert.deepEqual(await rotationsOf(out), [90, 90, 90, 90, 90, 90]);
  assert.equal((await PDFDocument.load(out)).getPageCount(), 6);
});

test('rotate: selected pages only, others untouched', async () => {
  const out = Buffer.from(await rotatePdf(Buffer.from(sixPage()), { angle: 90, scope: 'range', selectionText: '1-2,6' }));
  assert.deepEqual(await rotationsOf(out), [90, 90, 0, 0, 0, 90]);
});

test('rotate: angles 180 / 270 / -90 and relative stacking', async () => {
  assert.deepEqual(await rotationsOf(await rotatePdf(Buffer.from(sixPage()), { angle: 180, scope: 'all' })), [180, 180, 180, 180, 180, 180]);
  assert.deepEqual(await rotationsOf(await rotatePdf(Buffer.from(sixPage()), { angle: 270, scope: 'all' })), [270, 270, 270, 270, 270, 270]);
  assert.deepEqual(await rotationsOf(await rotatePdf(Buffer.from(sixPage()), { angle: -90, scope: 'all' })), [270, 270, 270, 270, 270, 270]);
  // Relative semantics: rotating twice stacks.
  const once = Buffer.from(await rotatePdf(Buffer.from(sixPage()), { angle: 90, scope: 'all' }));
  const twice = await rotationsOf(await rotatePdf(once, { angle: 90, scope: 'all' }));
  assert.deepEqual(twice, [180, 180, 180, 180, 180, 180]);
});

test('rotate: angle validation', () => {
  assert.deepEqual(validatePdfRotateAngle(90), { ok: true, angle: 90 });
  assert.deepEqual(validatePdfRotateAngle('180'), { ok: true, angle: 180 });
  assert.equal(validatePdfRotateAngle(45).ok, false);
  assert.equal(validatePdfRotateAngle('sideways').ok, false);
  assert.equal(validatePdfRotateAngle('').ok, false);
  assert.deepEqual(PDF_ROTATE_ANGLES, [90, 180, 270, -90, -180, -270]);
  assert.equal(rotateDownloadName('Report Q3.pdf', 90), 'Report_Q3-rotated-90.pdf');
  assert.equal(rotateDownloadName('../../evil.pdf', -90), 'evil-rotated--90.pdf');
  assert.equal(rotateDownloadName('', 180), 'document-rotated-180.pdf');
});

test('rotate: invalid input rejected', async () => {
  await assert.rejects(rotatePdf(Buffer.from('not a pdf'), { angle: 90, scope: 'all' }), /could not be read/);
  await assert.rejects(rotatePdf(Buffer.alloc(0), { angle: 90, scope: 'all' }), /empty/);
  await assert.rejects(rotatePdf(Buffer.from(alreadyEnc()), { angle: 90, scope: 'all' }), /password-protected/);
  await assert.rejects(rotatePdf(Buffer.from(sixPage()), { angle: 45, scope: 'all' }), /angle must be/);
  await assert.rejects(rotatePdf(Buffer.from(sixPage()), { angle: 90, scope: 'range', selectionText: '' }), /Enter pages/);
  await assert.rejects(rotatePdf(Buffer.from(sixPage()), { angle: 90, scope: 'range', selectionText: '9' }), /out of range/);
  await assert.rejects(rotatePdf(Buffer.from(sixPage()), { angle: 90, scope: 'range', selectionText: '1,1' }), /Duplicate/);
  assert.equal(validatePdfRotateUpload({ name: 'evil.exe', size: 100 }).ok, false);
});

test('rotate: input bytes are never mutated', async () => {
  const input = sixPage();
  const before = sha256(input);
  await rotatePdf(Buffer.from(input), { angle: 90, scope: 'all' });
  assert.equal(sha256(input), before);
});

test('rotate: limits match the PDF editor tooling', async () => {
  assert.equal(PDF_ROTATE_MAX_FILE_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_ROTATE_MAX_PAGES, PDF_EDITOR_MAX_PAGES);
  assert.ok(pdfRotateMaxRequestBytes() > 0);
  assert.equal(validatePdfRotateUpload(null).ok, false);
  const over = validatePdfRotateUpload({ name: 'a.pdf', size: PDF_ROTATE_MAX_FILE_BYTES + 1 });
  assert.equal(over.ok, false);
  const huge = Buffer.alloc(PDF_ROTATE_MAX_FILE_BYTES + 1);
  await assert.rejects(rotatePdf(huge, { angle: 90, scope: 'all' }), new RegExp(`exceeds ${PDF_ROTATE_MAX_FILE_MB} MB`));
  const big = await PDFDocument.create();
  for (let i = 0; i < PDF_ROTATE_MAX_PAGES + 1; i++) big.addPage([200, 200]);
  await assert.rejects(
    rotatePdf(Buffer.from(await big.save()), { angle: 90, scope: 'all' }),
    new RegExp(`max ${PDF_ROTATE_MAX_PAGES}`)
  );
});

test('rotate: server wires admin-only routes', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/rotate', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/rotate', requireApiAuth, requireAdmin"), 'API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-rotate.js'"), 'dedicated pdf-rotate library used');
  assert.ok(SERVER_SRC.includes('isPdfRotateAvailable()'), 'production gate enforced');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/rotate'"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'rotate handler never logs');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker|canvas/i.test(handler), 'no shell/native workflows');
  const libCode = ROTATE_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(libCode.includes("from 'pdfstudio'"), 'qpdf-WASM engine used');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
});

test('rotate: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfRotateAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfRotateAvailable({}), true);
  assert.equal(isPdfRotateAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfRotateAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
});

test('rotate: admin page renders picker + angle + scope UI', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-rotate.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfRotateAvailable: true,
    pdfRotateMaxFileMb: 50
  });
  for (const hook of [
    'pdf-rotate-root', 'pdf-rotate-file', 'pdf-rotate-angle', 'pdf-rotate-scope-all',
    'pdf-rotate-scope-range', 'pdf-rotate-selection', 'pdf-rotate-submit',
    'pdf-rotate-status', 'pdf-rotate-result', 'pdf-rotate-progress', 'pdf-rotate-clear',
    'pdf-rotate-pick', 'pdf-rotate-fileinfo'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-rotate\.js(\?v=\d+)?"/, 'client loads as ES module');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-rotate.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfRotateAvailable: false,
    pdfRotateMaxFileMb: 50
  });
  assert.match(disabled, /pdf-rotate-disabled/, 'disabled notice when unavailable');
});

test('rotate: client posts file+angle+scope', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-rotate.js'), 'utf8');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/rotate'"), 'posts to rotate API');
  assert.ok(src.includes("form.append('pdf'"), 'uploads the PDF');
  assert.ok(src.includes("form.append('angle'"), 'sends the angle');
  assert.ok(src.includes("form.append('scope'"), 'sends the scope');
  assert.ok(src.includes('GlobalWorkerOptions.workerSrc'), 'vendored pdf.js worker, no CDN');
  assert.ok(!src.includes('console.log'), 'client never logs');
});

test('rotate: admin nav links the tool under PDF', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/rotate/, 'nav links the tool');
  assert.match(nav, /Rotate PDF/, 'nav label present');
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  assert.ok(nav.indexOf('href="/admin/pdf-tools/rotate"') > pdfLabelIdx, 'link sits under the PDF group');
  const onPage = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/pdf-tools/rotate' });
  assert.match(onPage, /<a href="\/admin\/pdf-tools\/rotate" class="nav-link active"/, 'item highlights');
});
