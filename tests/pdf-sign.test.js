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
  signPdf,
  validatePdfSignUpload,
  validatePdfSignOptions,
  placeSignature,
  signDownloadName,
  isPdfSignAvailable,
  pdfSignMaxRequestBytes,
  PDF_SIGN_POSITIONS,
  PDF_SIGN_MAX_FILE_MB,
  PDF_SIGN_MAX_FILE_BYTES,
  PDF_SIGN_MAX_PAGES,
  PDF_SIGN_MAX_IMAGE_MB
} from '../src/library/pdf-sign.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const SIGN_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-sign.js', import.meta.url)), 'utf8');

const sixPage = () => readFileSync(path.join(FIXTURES_DIR, 'split-6page-plain.pdf'));
const pngSig = () => readFileSync(path.join(FIXTURES_DIR, 'images-grad.png'));
const jpgSig = () => readFileSync(path.join(FIXTURES_DIR, 'images-grad.jpg'));
const alreadyEnc = () => readFileSync(path.join(FIXTURES_DIR, 'unlock-rich-rc4.pdf'));
const sha256 = b => createHash('sha256').update(b).digest('hex');

const files = (img = pngSig()) => ({
  pdf: { bytes: Buffer.from(sixPage()), name: 'doc.pdf' },
  image: { bytes: Buffer.from(img), name: 'sig.png' }
});

async function imageOpCounts(bytes) {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const ops = await (await doc.getPage(n)).getOperatorList();
    out.push(ops.fnArray.filter(f => f === pdfjsLib.OPS.paintImageXObject).length);
  }
  await task.destroy();
  return { pages: doc.numPages, counts: out };
}

test('sign: signature stamped on the chosen page only', async () => {
  const out = Buffer.from(await signPdf(files(), { position: 'bottom-right', widthPt: 150, page: 2 }));
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 6);
  const { counts } = await imageOpCounts(out);
  const before = await imageOpCounts(sixPage());
  assert.deepEqual(before.counts, [0, 1, 0, 0, 0, 0], 'fixture page 2 already embeds one image');
  assert.deepEqual(counts, [0, 2, 0, 0, 0, 0], 'exactly one image op added, on page 2');
  // Original text intact on the signed page.
  const task = pdfjsLib.getDocument({ data: new Uint8Array(out) });
  const pdfDoc = await task.promise;
  const tc = await (await pdfDoc.getPage(2)).getTextContent();
  assert.ok(tc.items.map(i => i.str).join(' ').includes('ALPHA-2'), 'page content preserved');
  await task.destroy();
});

test('sign: positions and widths, JPG signature', async () => {
  for (const position of ['top-left', 'center', 'bottom-right']) {
    const out = await signPdf(
      { pdf: { bytes: Buffer.from(sixPage()), name: 'doc.pdf' }, image: { bytes: Buffer.from(jpgSig()), name: 'sig.jpg' } },
      { position, widthPt: 120, page: 1 }
    );
    const { counts } = await imageOpCounts(out);
    assert.equal(counts[0], 1, `position ${position} draws on page 1`);
  }
  const geo = placeSignature(595, 842, 160 / 100, 150, 'bottom-right');
  assert.ok(geo.x >= 36 && geo.y >= 36 && geo.x + geo.w <= 595 - 36 + 1e-9, 'bottom-right sits inside margins');
  assert.ok(Math.abs(geo.w / geo.h - 1.6) < 1e-9, 'aspect preserved');
  assert.deepEqual(PDF_SIGN_POSITIONS.length, 9);
});

test('sign: output is visual-only, never a digital signature', async () => {
  const out = Buffer.from(await signPdf(files(), { position: 'bottom-right', widthPt: 150, page: 1 }));
  const raw = out.toString('latin1');
  assert.ok(!raw.includes('/ByteRange'), 'no signature ByteRange');
  assert.ok(!raw.includes('/DocMDP'), 'no certification dictionary');
  assert.ok(!/\/FT\s*\/Sig/.test(raw), 'no signature form fields');
});

test('sign: option validation', () => {
  assert.deepEqual(validatePdfSignOptions({}), { ok: true, options: { position: 'bottom-right', widthPt: 150, page: 1 } });
  assert.equal(validatePdfSignOptions({ position: 'middle' }).ok, false);
  assert.equal(validatePdfSignOptions({ widthPt: 19 }).ok, false);
  assert.equal(validatePdfSignOptions({ widthPt: 401 }).ok, false);
  assert.equal(validatePdfSignOptions({ page: 0 }).ok, false);
  assert.equal(validatePdfSignOptions({ page: 1.5 }).ok, false);
  assert.equal(validatePdfSignUpload(null).ok, false);
  assert.equal(validatePdfSignUpload({ pdf: { name: 'a.pdf', size: 10 } }).ok, false, 'missing image rejected');
  assert.equal(validatePdfSignUpload({ pdf: { name: 'a.txt', size: 10 }, image: { name: 's.png', size: 10 } }).ok, false);
  assert.equal(validatePdfSignUpload({ pdf: { name: 'a.pdf', size: 10 }, image: { name: 's.gif', size: 10 } }).ok, false);
  assert.equal(signDownloadName('Contract v2.pdf'), 'Contract_v2-signed.pdf');
  assert.equal(signDownloadName('../../evil.pdf'), 'evil-signed.pdf');
});

test('sign: invalid input rejected', async () => {
  const good = () => files();
  await assert.rejects(signPdf({ pdf: { bytes: Buffer.from('nope'), name: 'a.pdf' }, image: { bytes: pngSig(), name: 's.png' } }, { position: 'bottom-right', widthPt: 150, page: 1 }), /could not be read/);
  await assert.rejects(signPdf({ pdf: { bytes: Buffer.alloc(0), name: 'a.pdf' }, image: { bytes: pngSig(), name: 's.png' } }, { position: 'bottom-right', widthPt: 150, page: 1 }), /empty/);
  await assert.rejects(signPdf({ pdf: { bytes: alreadyEnc(), name: 'a.pdf' }, image: { bytes: pngSig(), name: 's.png' } }, { position: 'bottom-right', widthPt: 150, page: 1 }), /password-protected/);
  await assert.rejects(signPdf({ pdf: { bytes: sixPage(), name: 'a.pdf' }, image: { bytes: Buffer.from('nope'), name: 's.png' } }, { position: 'bottom-right', widthPt: 150, page: 1 }), /not a readable/);
  await assert.rejects(signPdf({ pdf: { bytes: sixPage(), name: 'a.pdf' }, image: { bytes: jpgSig(), name: 's.png' } }, { position: 'bottom-right', widthPt: 150, page: 1 }), /extension does not match/);
  const g = good();
  await assert.rejects(signPdf(g, { position: 'bottom-right', widthPt: 150, page: 99 }), /out of range/);
});

test('sign: input bytes are never mutated', async () => {
  const pdf = sixPage();
  const img = pngSig();
  const beforePdf = sha256(pdf);
  const beforeImg = sha256(img);
  await signPdf(
    { pdf: { bytes: Buffer.from(pdf), name: 'a.pdf' }, image: { bytes: Buffer.from(img), name: 's.png' } },
    { position: 'bottom-right', widthPt: 150, page: 1 }
  );
  assert.equal(sha256(pdf), beforePdf);
  assert.equal(sha256(img), beforeImg);
});

test('sign: limits match the PDF editor tooling', async () => {
  assert.equal(PDF_SIGN_MAX_FILE_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_SIGN_MAX_PAGES, PDF_EDITOR_MAX_PAGES);
  assert.ok(pdfSignMaxRequestBytes() > 0);
  const over = validatePdfSignUpload({ pdf: { name: 'a.pdf', size: PDF_SIGN_MAX_FILE_BYTES + 1 }, image: { name: 's.png', size: 10 } });
  assert.equal(over.ok, false);
  const huge = Buffer.alloc(PDF_SIGN_MAX_FILE_BYTES + 1);
  await assert.rejects(
    signPdf({ pdf: { bytes: huge, name: 'a.pdf' }, image: { bytes: pngSig(), name: 's.png' } }, { position: 'bottom-right', widthPt: 150, page: 1 }),
    new RegExp(`exceeds ${PDF_SIGN_MAX_FILE_MB} MB`)
  );
  const big = await PDFDocument.create();
  for (let i = 0; i < PDF_SIGN_MAX_PAGES + 1; i++) big.addPage([200, 200]);
  await assert.rejects(
    signPdf({ pdf: { bytes: Buffer.from(await big.save()), name: 'a.pdf' }, image: { bytes: pngSig(), name: 's.png' } }, { position: 'bottom-right', widthPt: 150, page: 1 }),
    new RegExp(`max ${PDF_SIGN_MAX_PAGES}`)
  );
});

test('sign: server wires admin-only routes', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/sign', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/sign', requireApiAuth, requireAdmin"), 'API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-sign.js'"), 'dedicated pdf-sign library used');
  assert.ok(SERVER_SRC.includes('isPdfSignAvailable()'), 'production gate enforced');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/sign'"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'sign handler never logs');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker|canvas/i.test(handler), 'no shell/native workflows');
  const libCode = SIGN_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
  assert.ok(/visual signature|NOT a cryptographic/i.test(SIGN_LIB_SRC), 'visual-only scope documented');
});

test('sign: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfSignAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfSignAvailable({}), true);
  assert.equal(isPdfSignAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfSignAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
});

test('sign: admin page renders pickers + placement UI with visual-only notice', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-sign.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfSignAvailable: true,
    pdfSignMaxFileMb: 50,
    pdfSignMaxImageMb: 5
  });
  for (const hook of [
    'pdf-sign-root', 'pdf-sign-file', 'pdf-sign-image', 'pdf-sign-page', 'pdf-sign-position',
    'pdf-sign-width', 'pdf-sign-submit', 'pdf-sign-status', 'pdf-sign-result',
    'pdf-sign-progress', 'pdf-sign-clear', 'pdf-sign-pick', 'pdf-sign-image-pick',
    'pdf-sign-fileinfo', 'pdf-sign-imageinfo'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-sign\.js(\?v=\d+)?"/, 'client loads as ES module');
  assert.match(html, /visual signature only/i, 'visual-only scope stated in the UI');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-sign.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfSignAvailable: false,
    pdfSignMaxFileMb: 50,
    pdfSignMaxImageMb: 5
  });
  assert.match(disabled, /pdf-sign-disabled/, 'disabled notice when unavailable');
});

test('sign: client posts pdf+signature+placement', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-sign.js'), 'utf8');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/sign'"), 'posts to sign API');
  assert.ok(src.includes("form.append('pdf'"), 'uploads the PDF');
  assert.ok(src.includes("form.append('signature'"), 'uploads the signature image');
  assert.ok(src.includes("form.append('position'"), 'sends position');
  assert.ok(src.includes('GlobalWorkerOptions.workerSrc'), 'vendored pdf.js worker, no CDN');
  assert.ok(!src.includes('console.log'), 'client never logs');
});

test('sign: admin nav links the tool under PDF', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/sign/, 'nav links the tool');
  assert.match(nav, /Sign PDF/, 'nav label present');
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  assert.ok(nav.indexOf('href="/admin/pdf-tools/sign"') > pdfLabelIdx, 'link sits under the PDF group');
  const onPage = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/pdf-tools/sign' });
  assert.match(onPage, /<a href="\/admin\/pdf-tools\/sign" class="nav-link active"/, 'item highlights');
});
