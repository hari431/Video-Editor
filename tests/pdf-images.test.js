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
  imagesToPdf,
  validatePdfImagesUpload,
  validatePdfImagesOptions,
  detectImageKind,
  fitImageToPage,
  imagesDownloadName,
  isPdfImagesAvailable,
  pdfImagesMaxRequestBytes,
  PDF_IMAGES_MAX_FILE_MB,
  PDF_IMAGES_MAX_FILE_BYTES,
  PDF_IMAGES_MAX_FILES
} from '../src/library/pdf-images.js';
import {
  PDF_EDITOR_MAX_IMAGE_BYTES,
  PDF_EDITOR_MAX_IMAGE_FILES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const IMAGES_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-images.js', import.meta.url)), 'utf8');
const EDITOR_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-editor.js', import.meta.url)), 'utf8');
const MERGE_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-merge.js', import.meta.url)), 'utf8');
const UNLOCK_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-unlock.js', import.meta.url)), 'utf8');
const PROTECT_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-protect.js', import.meta.url)), 'utf8');
const COMPRESS_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-compress.js', import.meta.url)), 'utf8');
const SPLIT_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-split.js', import.meta.url)), 'utf8');

// Gradient fixtures: PNG 120x90, baseline JPEG 160x100.
const pngFile = () => readFileSync(path.join(FIXTURES_DIR, 'images-grad.png'));
const jpgFile = () => readFileSync(path.join(FIXTURES_DIR, 'images-grad.jpg'));

const sha256 = b => createHash('sha256').update(b).digest('hex');

async function imageOps(bytes) {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const ops = await (await doc.getPage(n)).getOperatorList();
    out.push(ops.fnArray.filter(f => f === pdfjsLib.OPS.paintImageXObject).length);
  }
  await task.destroy();
  return { pages: doc.numPages, images: out };
}

// multiple image conversion (JPG + PNG in one document).
test('images: converts multiple JPG/PNG images to one PDF', async () => {
  const out = await imagesToPdf(
    [
      { bytes: Buffer.from(jpgFile()), name: 'a.jpg' },
      { bytes: Buffer.from(pngFile()), name: 'b.png' }
    ],
    { pageSize: 'A4', orientation: 'portrait', margin: 36 }
  );
  assert.equal(out.slice(0, 5).toString('latin1'), '%PDF-');
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 2);
  assert.equal(doc.isEncrypted, false);
});

// order preservation: image-size pages expose each image's dimensions in order.
test('images: pages follow the displayed input order', async () => {
  const out = await imagesToPdf(
    [
      { bytes: Buffer.from(jpgFile()), name: 'first.jpg' },
      { bytes: Buffer.from(pngFile()), name: 'second.png' },
      { bytes: Buffer.from(jpgFile()), name: 'third.jpg' }
    ],
    { pageSize: 'image', orientation: 'auto', margin: 0 }
  );
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 3);
  const sizes = [0, 1, 2].map(i => {
    const s = doc.getPage(i).getSize();
    return [s.width, s.height];
  });
  assert.deepEqual(sizes, [[160, 100], [120, 90], [160, 100]]);
  // Reversed input reverses the pages.
  const rev = await imagesToPdf(
    [
      { bytes: Buffer.from(pngFile()), name: 'second.png' },
      { bytes: Buffer.from(jpgFile()), name: 'first.jpg' }
    ],
    { pageSize: 'image', orientation: 'auto', margin: 0 }
  );
  const dRev = await PDFDocument.load(rev);
  assert.deepEqual([dRev.getPage(0).getSize().width, dRev.getPage(1).getSize().width], [120, 160]);
});

// page count, dimensions and orientation.
test('images: page sizes and orientations', async () => {
  const one = [{ bytes: Buffer.from(jpgFile()), name: 'a.jpg' }];
  const approx = (a, b) => Math.abs(a - b) < 0.01;
  // A4 portrait (landscape image letterboxed onto a portrait page).
  let out = await imagesToPdf(one, { pageSize: 'A4', orientation: 'portrait', margin: 0 });
  let s = (await PDFDocument.load(out)).getPage(0).getSize();
  assert.ok(approx(s.width, 595.28) && approx(s.height, 841.89), `A4 portrait, got ${s.width}x${s.height}`);
  // A4 landscape.
  out = await imagesToPdf(one, { pageSize: 'A4', orientation: 'landscape', margin: 0 });
  s = (await PDFDocument.load(out)).getPage(0).getSize();
  assert.ok(approx(s.width, 841.89) && approx(s.height, 595.28), `A4 landscape, got ${s.width}x${s.height}`);
  // Letter portrait.
  out = await imagesToPdf(one, { pageSize: 'Letter', orientation: 'portrait', margin: 36 });
  s = (await PDFDocument.load(out)).getPage(0).getSize();
  assert.ok(approx(s.width, 612) && approx(s.height, 792), `Letter portrait, got ${s.width}x${s.height}`);
  // Auto follows the image orientation (160x100 landscape -> landscape page).
  out = await imagesToPdf(one, { pageSize: 'A4', orientation: 'auto', margin: 0 });
  s = (await PDFDocument.load(out)).getPage(0).getSize();
  assert.ok(s.width > s.height, 'auto picks landscape for a landscape image');
  // Image-size pages use native dimensions.
  out = await imagesToPdf(one, { pageSize: 'image', orientation: 'auto', margin: 0 });
  s = (await PDFDocument.load(out)).getPage(0).getSize();
  assert.deepEqual([s.width, s.height], [160, 100]);
});

// fit math: aspect preserved, centered, inside margins.
test('images: fit preserves aspect ratio within margins', () => {
  const g = fitImageToPage(160, 100, 'A4', 'portrait', 36);
  assert.ok(Math.abs(g.w / g.h - 1.6) < 1e-9, 'aspect preserved');
  assert.ok(g.x >= 36 && g.y >= 36 && g.x + g.w <= 595.28 - 36 + 1e-9 && g.y + g.h <= 841.89 - 36 + 1e-9, 'inside margins');
  assert.ok(Math.abs((g.x - 36) - (595.28 - 36 - (g.x + g.w))) < 1e-9, 'horizontally centered');
  assert.equal(validatePdfImagesOptions({ pageSize: 'image', orientation: 'auto', margin: 10 }).ok, false, 'margin rejected for image-size pages');
  assert.equal(validatePdfImagesOptions({ pageSize: 'A3', orientation: 'auto', margin: 0 }).ok, false, 'bad page size rejected');
  assert.equal(validatePdfImagesOptions({ pageSize: 'A4', orientation: 'diagonal', margin: 0 }).ok, false, 'bad orientation rejected');
  assert.equal(validatePdfImagesOptions({ pageSize: 'A4', orientation: 'auto', margin: 200 }).ok, false, 'oversized margin rejected');
  assert.deepEqual(validatePdfImagesOptions({}), { ok: true, options: { pageSize: 'A4', orientation: 'auto', margin: 36 } });
});

// image presence + quality (JPEG embedded verbatim).
test('images: every page paints its image; JPEG bytes preserved verbatim', async () => {
  const jpg = jpgFile();
  const out = await imagesToPdf(
    [
      { bytes: Buffer.from(jpg), name: 'a.jpg' },
      { bytes: Buffer.from(pngFile()), name: 'b.png' }
    ],
    { pageSize: 'A4', orientation: 'auto', margin: 36 }
  );
  const { pages, images } = await imageOps(out);
  assert.equal(pages, 2);
  assert.deepEqual(images, [1, 1], 'one image painted per page');
  assert.ok(out.includes(jpg.subarray(0, 64)), 'original JPEG bytes embedded verbatim (no quality change)');
});

// invalid/non-image input.
test('images: invalid and non-image input rejected per file', async () => {
  await assert.rejects(imagesToPdf([{ bytes: Buffer.from('not an image'), name: 'a.jpg' }], {}), /not a readable/);
  await assert.rejects(imagesToPdf([{ bytes: Buffer.from(pngFile()), name: 'a.gif' }], {}), /must be a .jpg/);
  await assert.rejects(imagesToPdf([{ bytes: Buffer.from(jpgFile()), name: 'a.png' }], {}), /extension does not match/);
  await assert.rejects(imagesToPdf([], {}), /at least one image/);
  await assert.rejects(imagesToPdf([{ bytes: Buffer.alloc(0), name: 'a.jpg' }], {}), /empty|at least/);
  assert.equal(detectImageKind(Buffer.from([0xFF, 0xD8, 0xFF, 0x00])), 'jpg');
  assert.equal(detectImageKind(Buffer.from([0x89, 0x50, 0x4E, 0x47])), 'png');
  assert.equal(detectImageKind(Buffer.from('GIF89a')), null);
});

// original files unchanged.
test('images: input bytes are never mutated', async () => {
  const jpg = jpgFile();
  const png = pngFile();
  const hj = sha256(jpg);
  const hp = sha256(png);
  await imagesToPdf(
    [{ bytes: Buffer.from(jpg), name: 'a.jpg' }, { bytes: Buffer.from(png), name: 'b.png' }],
    { pageSize: 'A4', orientation: 'auto', margin: 36 }
  );
  assert.equal(sha256(jpg), hj);
  assert.equal(sha256(png), hp);
});

// limits consistent with the PDF tooling.
test('images: file-count and size limits match the PDF editor tooling', async () => {
  assert.equal(PDF_IMAGES_MAX_FILES, PDF_EDITOR_MAX_IMAGE_FILES);
  assert.equal(PDF_IMAGES_MAX_FILE_BYTES, PDF_EDITOR_MAX_IMAGE_BYTES);
  assert.ok(pdfImagesMaxRequestBytes() > 0);
  const nine = Array.from({ length: PDF_IMAGES_MAX_FILES + 1 }, (_, i) => ({ name: `f${i}.jpg`, size: 100 }));
  assert.equal(validatePdfImagesUpload(nine).ok, false);
  assert.match(validatePdfImagesUpload(nine).error, new RegExp(String(PDF_IMAGES_MAX_FILES)));
  const over = validatePdfImagesUpload([{ name: 'a.jpg', size: PDF_IMAGES_MAX_FILE_BYTES + 1 }]);
  assert.equal(over.ok, false);
  assert.match(over.error, /exceeds 5 MB/);
  assert.equal(validatePdfImagesUpload([]).ok, false);
  const many = Array.from({ length: PDF_IMAGES_MAX_FILES + 1 }, () => ({ bytes: Buffer.from(jpgFile()), name: 'a.jpg' }));
  await assert.rejects(imagesToPdf(many, {}), new RegExp(`At most ${PDF_IMAGES_MAX_FILES} images`));
});

test('images: download name follows the first image and is header-safe', () => {
  assert.equal(imagesDownloadName('Vacation Photo 1.JPG'), 'Vacation_Photo_1.pdf');
  assert.equal(imagesDownloadName('../../evil.png'), 'evil.pdf');
  assert.equal(imagesDownloadName('x'), 'x.pdf');
  assert.equal(imagesDownloadName(''), 'images.pdf');
  assert.match(imagesDownloadName('a/b\\c.jpg'), /^[A-Za-z0-9._-]+\.pdf$/);
});

// admin-only server wiring (editor, merge, unlock, protect, compress, split intact).
test('images: server wires admin-only routes (other tools untouched)', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/images-to-pdf', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/images-to-pdf', requireApiAuth, requireAdmin"), 'API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-images.js'"), 'dedicated pdf-images library used');
  assert.ok(SERVER_SRC.includes('X-Images-Pages'), 'page count exposed via headers');
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-editor', requireAuth, requireAdmin"), 'editor page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-editor/export', requireApiAuth, requireAdmin"), 'editor export route intact');
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/merge', requireAuth, requireAdmin"), 'merge page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/merge', requireApiAuth, requireAdmin"), 'merge API route intact');
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/unlock', requireAuth, requireAdmin"), 'unlock page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/unlock', requireApiAuth, requireAdmin"), 'unlock API route intact');
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/protect', requireAuth, requireAdmin"), 'protect page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/protect', requireApiAuth, requireAdmin"), 'protect API route intact');
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/compress', requireAuth, requireAdmin"), 'compress page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/compress', requireApiAuth, requireAdmin"), 'compress API route intact');
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/split', requireAuth, requireAdmin"), 'split page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/split', requireApiAuth, requireAdmin"), 'split API route intact');
  assert.ok(!EDITOR_LIB_SRC.includes('imagesToPdf'), 'editor library has no images code');
  assert.ok(!MERGE_LIB_SRC.includes('imagesToPdf'), 'merge library has no images code');
  assert.ok(!UNLOCK_LIB_SRC.includes('imagesToPdf'), 'unlock library has no images code');
  assert.ok(!PROTECT_LIB_SRC.includes('imagesToPdf'), 'protect library has no images code');
  assert.ok(!COMPRESS_LIB_SRC.includes('imagesToPdf'), 'compress library has no images code');
  assert.ok(!SPLIT_LIB_SRC.includes('imagesToPdf'), 'split library has no images code');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/images-to-pdf'"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'images handler never logs');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker/i.test(handler), 'no shell/binary workflows in the handler');
  const libCode = IMAGES_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
  assert.ok(!/\.writeFileSync|createWriteStream|mkdtemp|tmpdir/i.test(libCode), 'no temp-file workflows');
  assert.ok(!/sharp|jimp|canvas/i.test(libCode), 'no new image runtime');
});

// production availability gate.
test('images: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfImagesAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfImagesAvailable({}), true);
  assert.equal(isPdfImagesAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfImagesAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
  assert.ok(SERVER_SRC.includes('isPdfImagesAvailable()'), 'production gate enforced');
});

test('images: admin page renders picker + reorderable list + options UI', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-images.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfImagesAvailable: true,
    pdfImagesMaxFileMb: 5,
    pdfImagesMaxFiles: 8
  });
  for (const hook of [
    'pdf-images-root', 'pdf-images-file', 'pdf-images-list', 'pdf-images-submit',
    'pdf-images-pick', 'pdf-images-clear', 'pdf-images-pagesize', 'pdf-images-orientation',
    'pdf-images-margin', 'pdf-images-status', 'pdf-images-result', 'pdf-images-progress',
    'pdf-images-hint'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-images\.js(\?v=\d+)?"/, 'client loads as ES module');
  assert.match(html, /data-max-file-mb="5"/, '5 MB cap exposed');
  assert.match(html, /multiple/, 'multi-file picker');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-images.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfImagesAvailable: false,
    pdfImagesMaxFileMb: 5,
    pdfImagesMaxFiles: 8
  });
  assert.match(disabled, /pdf-images-disabled/, 'disabled notice when unavailable');
});

test('images: client shows thumbnails/dims/remove/reorder and uploads in order', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-images.js'), 'utf8');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/images-to-pdf'"), 'posts to images API');
  assert.ok(src.includes("form.append('image'"), 'uploads in displayed order');
  assert.ok(src.includes('pdf-images-thumbnail'), 'thumbnail preview');
  assert.ok(src.includes('pdf-images-dimensions'), 'dimensions display');
  assert.ok(src.includes('pdf-images-filename'), 'filename display');
  assert.ok(src.includes('pdf-images-remove'), 'remove button');
  assert.ok(src.includes('pdf-images-up') && src.includes('pdf-images-down'), 'up/down reorder');
  assert.ok(src.includes('draggable'), 'drag/drop reorder');
  assert.ok(src.includes('pdfImagesProgress') && src.includes('setProgressVisible'), 'loading/progress state');
  assert.ok(!src.includes('console.log'), 'client never logs');
});

test('images: admin nav links the tool under PDF', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/images-to-pdf/, 'nav links the tool');
  assert.match(nav, /Images to PDF/, 'nav label present');
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  assert.ok(nav.indexOf('href="/admin/pdf-tools/images-to-pdf"') > pdfLabelIdx, 'link sits under the PDF group');
  const onPage = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/pdf-tools/images-to-pdf' });
  assert.match(onPage, /<a href="\/admin\/pdf-tools\/images-to-pdf" class="nav-link active"/, 'item highlights');
});
