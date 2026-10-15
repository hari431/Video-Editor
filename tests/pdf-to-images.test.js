import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import {
  parseImageSelection,
  detectRasterKind,
  rasterDimensions,
  validatePdfToImagesPart,
  validatePdfToImagesUpload,
  validatePdfToImagesFormat,
  validatePdfToImagesScale,
  renderedPartNames,
  renderedZipName,
  zipRenderedImages,
  isPdfToImagesAvailable,
  pdfToImagesMaxRequestBytes,
  PDF_TO_IMAGES_SCALES,
  PDF_TO_IMAGES_DEFAULT_SCALE,
  PDF_TO_IMAGES_MAX_DIMENSION,
  PDF_TO_IMAGES_MAX_PART_BYTES,
  PDF_TO_IMAGES_MAX_PART_MB,
  PDF_TO_IMAGES_MAX_PARTS
} from '../src/library/pdf-to-images.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const TO_IMAGES_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-to-images.js', import.meta.url)), 'utf8');
const TO_IMAGES_CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/public/admin-pdf-to-images.js', import.meta.url)), 'utf8');
const EDITOR_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-editor.js', import.meta.url)), 'utf8');
const MERGE_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-merge.js', import.meta.url)), 'utf8');
const UNLOCK_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-unlock.js', import.meta.url)), 'utf8');
const PROTECT_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-protect.js', import.meta.url)), 'utf8');
const COMPRESS_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-compress.js', import.meta.url)), 'utf8');
const SPLIT_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-split.js', import.meta.url)), 'utf8');
const IMAGES_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-images.js', import.meta.url)), 'utf8');

// Real raster fixtures (also used as synthetic "rendered" uploads).
const pngFile = () => readFileSync(path.join(FIXTURES_DIR, 'images-grad.png')); // 120x90
const jpgFile = () => readFileSync(path.join(FIXTURES_DIR, 'images-grad.jpg')); // 160x100

const sha256 = b => createHash('sha256').update(b).digest('hex');

// Minimal valid PNG builder (for dimension-guard tests without a canvas).
function makePng(width, height) {
  const raw = Buffer.alloc(1 + width * height * 3, 7);
  const ihdr = Buffer.alloc(21);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const idat = deflateSync(raw);
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(data.length, 0);
    h.write(type, 4);
    return Buffer.concat([h, data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr.subarray(0, 13)),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// Minimal in-test ZIP reader (independent check of packaged archives).
function readZip(buf) {
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'ZIP local header magic');
  const files = [];
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const compLen = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const data = buf.subarray(off + 30 + nameLen + extraLen, off + 30 + nameLen + extraLen + compLen);
    files.push({ name, bytes: method === 8 ? inflateRawSync(data) : data });
    off += 30 + nameLen + extraLen + compLen;
  }
  return files;
}

// range validation: strict "1-3,5,8-10" grammar against a page count.
test('pdf-to-images: page selection parsing and validation', () => {
  assert.deepEqual(parseImageSelection('1-3,5', 6), { ok: true, pages: [1, 2, 3, 5] });
  assert.deepEqual(parseImageSelection('5', 6), { ok: true, pages: [5] });
  assert.deepEqual(parseImageSelection(' 6 , 1 ', 6), { ok: true, pages: [6, 1] });
  assert.deepEqual(parseImageSelection('8-10', 12), { ok: true, pages: [8, 9, 10] });
  assert.equal(parseImageSelection('', 6).ok, false);
  assert.equal(parseImageSelection('1,,2', 6).ok, false, 'empty token rejected');
  assert.equal(parseImageSelection('1,', 6).ok, false, 'trailing comma rejected');
  assert.equal(parseImageSelection('a', 6).ok, false, 'non-numeric rejected');
  assert.equal(parseImageSelection('1-x', 6).ok, false, 'non-numeric range end rejected');
  assert.equal(parseImageSelection('1-2-3', 6).ok, false, 'double range rejected');
  assert.equal(parseImageSelection('0', 6).ok, false, 'page 0 rejected');
  assert.equal(parseImageSelection('7', 6).ok, false, 'out-of-range rejected');
  assert.equal(parseImageSelection('5-9', 6).ok, false, 'range overflow rejected');
  assert.equal(parseImageSelection('4-2', 6).ok, false, 'reversed range rejected');
  assert.equal(parseImageSelection('2,2', 6).ok, false, 'duplicate rejected');
  assert.equal(parseImageSelection('1-3,2', 6).ok, false, 'overlap duplicate rejected');
});

// format + scale validation.
test('pdf-to-images: format and scale validated with safe defaults', () => {
  assert.deepEqual(validatePdfToImagesFormat(''), { ok: true, format: 'png' });
  assert.deepEqual(validatePdfToImagesFormat('jpeg'), { ok: true, format: 'jpeg' });
  assert.equal(validatePdfToImagesFormat('gif').ok, false);
  assert.equal(validatePdfToImagesFormat('pdf').ok, false);
  assert.deepEqual(validatePdfToImagesScale(''), { ok: true, scale: PDF_TO_IMAGES_DEFAULT_SCALE });
  assert.deepEqual(validatePdfToImagesScale('3'), { ok: true, scale: 3 });
  assert.equal(validatePdfToImagesScale('5').ok, false, 'excessive scale rejected');
  assert.equal(validatePdfToImagesScale('0').ok, false);
  assert.equal(validatePdfToImagesScale('x').ok, false);
  assert.deepEqual(PDF_TO_IMAGES_SCALES, [1, 1.5, 2, 3]);
});

// rendered output dimensions read without decoding pixels.
test('pdf-to-images: raster dimensions detected for PNG and JPEG', () => {
  assert.equal(detectRasterKind(pngFile()), 'png');
  assert.equal(detectRasterKind(jpgFile()), 'jpeg');
  assert.equal(detectRasterKind(Buffer.from('not an image')), null);
  assert.deepEqual(rasterDimensions(pngFile()), { width: 120, height: 90 });
  assert.deepEqual(rasterDimensions(jpgFile()), { width: 160, height: 100 });
  assert.deepEqual(rasterDimensions(makePng(4, 3)), { width: 4, height: 3 });
  assert.equal(rasterDimensions(Buffer.from('garbage')), null);
});

// single-page naming + multi-page ZIP validity (real PNG/JPEG renders).
test('pdf-to-images: rendered parts package into a valid ZIP', () => {
  const parts = [
    { name: 'doc-p1.png', bytes: pngFile() },
    { name: 'doc-p2.jpg', bytes: jpgFile() }
  ];
  const zip = zipRenderedImages(parts);
  assert.equal(zip.subarray(0, 4).toString('latin1'), 'PK\x03\x04', 'ZIP magic present');
  const entries = readZip(zip);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.name), ['doc-p1.png', 'doc-p2.jpg'], 'names and order preserved');
  assert.deepEqual(entries[0].bytes, pngFile(), 'PNG round-trips exactly');
  assert.deepEqual(entries[1].bytes, jpgFile(), 'JPEG round-trips exactly');
  assert.throws(() => zipRenderedImages([]), /at least one/);
  assert.throws(() => zipRenderedImages([{ name: 'x.txt', bytes: Buffer.from('nope') }]), /not a PNG or JPEG/);
  const tooMany = Array.from({ length: PDF_TO_IMAGES_MAX_PARTS + 1 }, (_, i) => ({ name: `p${i}.png`, size: 10, bytes: makePng(2, 2) }));
  assert.throws(() => zipRenderedImages(tooMany), new RegExp(`At most ${PDF_TO_IMAGES_MAX_PARTS}`));
});

// per-upload validation incl. the dimension abuse guard.
test('pdf-to-images: upload validation (size, kind, dimensions)', () => {
  assert.equal(validatePdfToImagesUpload([]).ok, false);
  assert.equal(validatePdfToImagesUpload(null).ok, false);
  assert.equal(validatePdfToImagesPart({ name: 'a.png', size: 0 }).ok, false, 'empty rejected');
  assert.equal(
    validatePdfToImagesPart({ name: 'a.png', size: PDF_TO_IMAGES_MAX_PART_BYTES + 1 }).ok, false,
    'oversize rejected'
  );
  const wide = makePng(PDF_TO_IMAGES_MAX_DIMENSION + 1, 2);
  assert.equal(
    validatePdfToImagesPart({ name: 'wide.png', size: wide.length, bytes: wide }).ok, false,
    'gigapixel render rejected'
  );
  assert.deepEqual(
    validatePdfToImagesPart({ name: 'ok.png', size: 100, bytes: pngFile() }),
    { ok: true }
  );
});

// output filenames sanitized.
test('pdf-to-images: output filenames are sanitized', () => {
  assert.deepEqual(
    renderedPartNames({ originalName: 'Report Q3.pdf', format: 'png', pages: [1, 2, 10] }),
    ['Report_Q3-p01.png', 'Report_Q3-p02.png', 'Report_Q3-p10.png']
  );
  assert.deepEqual(
    renderedPartNames({ originalName: '../../evil.pdf', format: 'jpg', pages: [3] }),
    ['evil-p03.jpg']
  );
  assert.equal(renderedZipName('Report Q3.pdf'), 'Report_Q3-images.zip');
  assert.equal(renderedZipName(''), 'document-images.zip');
});

// original source bytes never mutated (renders are copies by construction).
test('pdf-to-images: source bytes are never mutated', () => {
  const png = pngFile();
  const jpg = jpgFile();
  const beforePng = sha256(png);
  const beforeJpg = sha256(jpg);
  zipRenderedImages([
    { name: 'a.png', bytes: Buffer.from(png) },
    { name: 'b.jpg', bytes: Buffer.from(jpg) }
  ]);
  assert.equal(sha256(png), beforePng);
  assert.equal(sha256(jpg), beforeJpg);
});

// limits consistent with the PDF tooling.
test('pdf-to-images: limits match the PDF editor tooling', () => {
  assert.equal(PDF_TO_IMAGES_MAX_PART_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_TO_IMAGES_MAX_PARTS, PDF_EDITOR_MAX_PAGES);
  assert.ok(pdfToImagesMaxRequestBytes() > 0);
  const huge = Buffer.alloc(PDF_TO_IMAGES_MAX_PART_BYTES + 1);
  assert.equal(validatePdfToImagesPart({ name: 'a.png', size: huge.length }).ok, false);
});

// admin-only server wiring (all other tools intact).
test('pdf-to-images: server wires admin-only routes (other tools untouched)', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/pdf-to-images', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/pdf-to-images/zip', requireApiAuth, requireAdmin"), 'ZIP API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-to-images.js'"), 'dedicated pdf-to-images library used');
  assert.ok(SERVER_SRC.includes('X-Rendered-Parts'), 'part count exposed via headers');
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
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/images-to-pdf', requireAuth, requireAdmin"), 'images page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/images-to-pdf', requireApiAuth, requireAdmin"), 'images API route intact');
  assert.ok(!EDITOR_LIB_SRC.includes('zipRenderedImages'), 'editor library has no pdf-to-images code');
  assert.ok(!MERGE_LIB_SRC.includes('zipRenderedImages'), 'merge library has no pdf-to-images code');
  assert.ok(!UNLOCK_LIB_SRC.includes('zipRenderedImages'), 'unlock library has no pdf-to-images code');
  assert.ok(!PROTECT_LIB_SRC.includes('zipRenderedImages'), 'protect library has no pdf-to-images code');
  assert.ok(!COMPRESS_LIB_SRC.includes('zipRenderedImages'), 'compress library has no pdf-to-images code');
  assert.ok(!SPLIT_LIB_SRC.includes('zipRenderedImages'), 'split library has no pdf-to-images code');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/pdf-to-images/zip'"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'zip handler never logs');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker|canvas/i.test(handler), 'no shell/native workflows in the handler');
  const libCode = TO_IMAGES_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
  assert.ok(!/\.writeFileSync|createWriteStream|mkdtemp|tmpdir/i.test(libCode), 'no temp-file workflows');
  assert.ok(!/node-canvas|canvas|sharp|jimp/i.test(libCode), 'no native canvas runtime');
});

// production availability gate.
test('pdf-to-images: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfToImagesAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfToImagesAvailable({}), true);
  assert.equal(isPdfToImagesAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfToImagesAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
  assert.ok(SERVER_SRC.includes('isPdfToImagesAvailable()'), 'production gate enforced');
});

test('pdf-to-images: admin page renders picker + selection + format UI', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-to-images.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfToImagesAvailable: true
  });
  for (const hook of [
    'pdf-to-images-root', 'pdf-to-images-file', 'pdf-to-images-format', 'pdf-to-images-scale',
    'pdf-to-images-mode-all', 'pdf-to-images-mode-range', 'pdf-to-images-mode-page',
    'pdf-to-images-selection', 'pdf-to-images-page', 'pdf-to-images-preview',
    'pdf-to-images-submit', 'pdf-to-images-status', 'pdf-to-images-result',
    'pdf-to-images-progress', 'pdf-to-images-clear', 'pdf-to-images-pick', 'pdf-to-images-fileinfo'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-to-images\.js(\?v=\d+)?"/, 'client loads as ES module');
  assert.match(html, /never uploaded/i, 'local-only rendering stated in the UI');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-to-images.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfToImagesAvailable: false
  });
  assert.match(disabled, /pdf-to-images-disabled/, 'disabled notice when unavailable');
});

test('pdf-to-images: client renders locally, never uploads the source PDF', () => {
  const src = TO_IMAGES_CLIENT_SRC;
  assert.ok(src.includes('page.render({ canvasContext:'), 'renders via pdf.js canvas');
  assert.ok(src.includes('getViewport({ scale:'), 'scale-driven viewport');
  assert.ok(src.includes('canvas.toBlob'), 'canvas export (PNG/JPEG)');
  assert.ok(src.includes('0.92'), 'documented JPEG quality');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/pdf-to-images/zip'"), 'multi-page ZIP via server');
  assert.ok(src.includes('X-Rendered-Parts'), 'reads part-count header');
  assert.ok(src.includes('PasswordException'), 'locked files mapped to unlock-first message');
  assert.ok(!src.includes("form.append('pdf'"), 'source PDF is never uploaded');
  assert.ok(src.includes('GlobalWorkerOptions.workerSrc'), 'vendored pdf.js worker, no CDN');
  assert.ok(!src.includes('console.log'), 'client never logs');
});

test('pdf-to-images: admin nav links the tool under PDF', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/pdf-to-images/, 'nav links the tool');
  assert.match(nav, /PDF to Images/, 'nav label present');
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  assert.ok(nav.indexOf('href="/admin/pdf-tools/pdf-to-images"') > pdfLabelIdx, 'link sits under the PDF group');
  const onPage = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/pdf-tools/pdf-to-images' });
  assert.match(onPage, /<a href="\/admin\/pdf-tools\/pdf-to-images" class="nav-link active"/, 'item highlights');
});
