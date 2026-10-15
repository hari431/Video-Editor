import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import {
  extractPdfImages,
  selectExtractedImages,
  validatePdfExtractImagesUpload,
  validatePdfExtractImagesSelection,
  extractedImageNames,
  extractedZipName,
  zipExtractedImages,
  encodePng,
  isPdfExtractImagesAvailable,
  pdfExtractImagesMaxRequestBytes,
  PDF_EXTRACT_MAX_FILE_MB,
  PDF_EXTRACT_MAX_FILE_BYTES,
  PDF_EXTRACT_MAX_PAGES,
  PDF_EXTRACT_MAX_IMAGES
} from '../src/library/pdf-extract-images.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const EXTRACT_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-extract-images.js', import.meta.url)), 'utf8');
const EDITOR_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-editor.js', import.meta.url)), 'utf8');
const MERGE_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-merge.js', import.meta.url)), 'utf8');
const UNLOCK_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-unlock.js', import.meta.url)), 'utf8');
const PROTECT_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-protect.js', import.meta.url)), 'utf8');
const COMPRESS_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-compress.js', import.meta.url)), 'utf8');
const SPLIT_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-split.js', import.meta.url)), 'utf8');
const IMAGES_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-images.js', import.meta.url)), 'utf8');
const TO_IMAGES_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-to-images.js', import.meta.url)), 'utf8');

// Two-page fixture: page 1 carries a 120x90 PNG (inserted twice -> deduped),
// page 2 a 160x100 baseline JPEG.
const multiPlain = () => readFileSync(path.join(FIXTURES_DIR, 'extract-multi-plain.pdf'));
// Already-encrypted fixture (RC4).
const alreadyEnc = () => readFileSync(path.join(FIXTURES_DIR, 'unlock-rich-rc4.pdf'));
// Standalone raster fixtures (native-format reference bytes).
const pngFile = () => readFileSync(path.join(FIXTURES_DIR, 'images-grad.png'));
const jpgFile = () => readFileSync(path.join(FIXTURES_DIR, 'images-grad.jpg'));

const sha256 = b => createHash('sha256').update(b).digest('hex');

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

// image detection across multiple pages (deduped by object identity).
test('extract-images: detects embedded images with page association', async () => {
  const { images, skipped } = await extractPdfImages(multiPlain());
  assert.equal(images.length, 2, 'two unique embedded images');
  assert.deepEqual(images.map(i => i.page), [1, 2], 'page association correct');
  assert.deepEqual(images.map(i => i.index), [1, 2]);
  assert.deepEqual(skipped, [], 'nothing skipped on the fixture');
});

// PNG/JPEG native-format preservation + dimensions.
test('extract-images: PNG decoded losslessly, JPEG byte-verbatim', async () => {
  const { images } = await extractPdfImages(multiPlain());
  const png = images.find(i => i.format === 'png');
  const jpg = images.find(i => i.format === 'jpg');
  assert.ok(png, 'PNG image extracted');
  assert.ok(jpg, 'JPEG image extracted');
  assert.deepEqual([png.width, png.height], [120, 90]);
  assert.deepEqual([jpg.width, jpg.height], [160, 100]);
  assert.equal(png.data.subarray(0, 8).toString('latin1'), '\x89PNG\r\n\x1a\n', 'PNG magic present');
  assert.ok(jpg.data[0] === 0xFF && jpg.data[1] === 0xD8, 'JPEG SOI present');
  assert.deepEqual(jpg.data, jpgFile(), 'JPEG bytes identical to the inserted source (native quality)');
  assert.ok(png.sizeBytes > 0 && jpg.sizeBytes > 0);
});

// selection: all + individual subsets in the given order.
test('extract-images: selection of all/individual images', async () => {
  const listing = await extractPdfImages(multiPlain());
  assert.deepEqual(selectExtractedImages(listing, 'all').map(i => i.index), [1, 2]);
  assert.deepEqual(selectExtractedImages(listing, '').map(i => i.index), [1, 2], 'empty means all');
  assert.deepEqual(selectExtractedImages(listing, '2').map(i => i.index), [2]);
  assert.deepEqual(selectExtractedImages(listing, '2,1').map(i => i.index), [2, 1], 'order preserved');
  assert.throws(() => selectExtractedImages(listing, '3'), /out of range/);
  assert.throws(() => selectExtractedImages(listing, '1,1'), /Duplicate/);
  assert.throws(() => selectExtractedImages(listing, 'x'), /Invalid selection/);
  assert.throws(() => selectExtractedImages({ images: [] }, 'all'), /No images/);
});

// duplicate/image-name handling: unique sanitized names.
test('extract-images: output filenames unique and sanitized', async () => {
  const listing = await extractPdfImages(multiPlain());
  const names = extractedImageNames({ originalName: 'Report Q3.pdf', images: listing.images });
  assert.deepEqual(names, ['Report_Q3-p1-img1.png', 'Report_Q3-p2-img2.jpg']);
  assert.equal(new Set(names).size, names.length, 'names unique');
  const dupes = extractedImageNames({
    originalName: '../../evil.pdf',
    images: [
      { page: 1, index: 1, format: 'png' },
      { page: 1, index: 1, format: 'png' }
    ]
  });
  assert.equal(new Set(dupes).size, 2, 'collisions disambiguated');
  assert.ok(dupes.every(n => /^[A-Za-z0-9._-]+\.(png|jpg)$/.test(n)), 'header-safe names');
  assert.equal(extractedZipName('Report Q3.pdf'), 'Report_Q3-images.zip');
  assert.equal(extractedZipName(''), 'document-images.zip');
});

// single download bytes + multi-image ZIP validity.
test('extract-images: single bytes and ZIP packaging round-trip', async () => {
  const listing = await extractPdfImages(multiPlain());
  const names = extractedImageNames({ originalName: 'doc.pdf', images: listing.images });
  const single = selectExtractedImages(listing, '2')[0];
  assert.equal(single.format, 'jpg');
  assert.deepEqual(single.data, jpgFile(), 'single download is the native JPEG');
  const zip = zipExtractedImages(
    selectExtractedImages(listing, 'all').map(img => ({ name: names[img.index - 1], bytes: img.data }))
  );
  assert.equal(zip.subarray(0, 4).toString('latin1'), 'PK\x03\x04', 'ZIP magic present');
  const entries = readZip(zip);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.name), names);
  assert.deepEqual(entries[0].bytes, listing.images[0].data, 'entry 1 round-trips');
  assert.deepEqual(entries[1].bytes, listing.images[1].data, 'entry 2 round-trips');
  assert.throws(() => zipExtractedImages([]), /at least one/);
});

// PNG encoder sanity (used for decoded images).
test('extract-images: PNG encoder emits valid images', () => {
  const samples = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  const png = encodePng(2, 2, 3, samples);
  assert.equal(png.subarray(0, 8).toString('latin1'), '\x89PNG\r\n\x1a\n');
  assert.equal(png.readUInt32BE(16), 2, 'IHDR width');
  assert.equal(png.readUInt32BE(20), 2, 'IHDR height');
  assert.throws(() => encodePng(0, 2, 3, samples), /dimensions/);
  assert.throws(() => encodePng(2, 2, 5, samples), /component/);
});

// invalid PDF input.
test('extract-images: invalid and non-PDF input rejected', async () => {
  await assert.rejects(extractPdfImages(Buffer.from('not a pdf at all')), /could not be read/);
  await assert.rejects(extractPdfImages(Buffer.alloc(0)), /empty/);
  assert.equal(validatePdfExtractImagesUpload({ name: 'evil.exe', size: 100 }).ok, false);
  assert.match(validatePdfExtractImagesUpload({ name: 'evil.exe', size: 100 }).error, /\.pdf/);
});

// encrypted PDF behavior.
test('extract-images: password-protected PDFs ask to unlock first', async () => {
  await assert.rejects(extractPdfImages(alreadyEnc()), /password-protected.*[Uu]nlock/);
});

// original PDF unchanged.
test('extract-images: input bytes are never mutated', async () => {
  const input = multiPlain();
  const before = sha256(input);
  const lenBefore = input.length;
  await extractPdfImages(Buffer.from(input));
  assert.equal(sha256(input), before);
  assert.equal(input.length, lenBefore);
});

// limits consistent with the PDF tooling.
test('extract-images: size and page limits match the PDF editor tooling', async () => {
  assert.equal(PDF_EXTRACT_MAX_FILE_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_EXTRACT_MAX_PAGES, PDF_EDITOR_MAX_PAGES);
  assert.ok(PDF_EXTRACT_MAX_IMAGES >= 500, 'image cap covers the page cap');
  assert.ok(pdfExtractImagesMaxRequestBytes() > 0);
  assert.equal(validatePdfExtractImagesUpload(null).ok, false);
  assert.equal(validatePdfExtractImagesUpload({ name: 'a.pdf', size: 0 }).ok, false);
  const over = validatePdfExtractImagesUpload({ name: 'a.pdf', size: PDF_EXTRACT_MAX_FILE_BYTES + 1 });
  assert.equal(over.ok, false);
  assert.match(over.error, new RegExp(String(PDF_EXTRACT_MAX_FILE_MB)));
  const huge = Buffer.alloc(PDF_EXTRACT_MAX_FILE_BYTES + 1);
  await assert.rejects(extractPdfImages(huge), new RegExp(`exceeds ${PDF_EXTRACT_MAX_FILE_MB} MB`));
});

// admin-only server wiring (all other tools intact).
test('extract-images: server wires admin-only routes (other tools untouched)', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/extract-images', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/extract-images/list', requireApiAuth, requireAdmin"), 'list API route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/extract-images/download', requireApiAuth, requireAdmin"), 'download API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-extract-images.js'"), 'dedicated pdf-extract-images library used');
  assert.ok(SERVER_SRC.includes('X-Extracted-Count'), 'image count exposed via headers');
  for (const [page, api, label] of [
    ["app.get('/admin/pdf-editor'", "app.post('/api/admin/pdf-editor/export'", 'editor'],
    ["app.get('/admin/pdf-tools/merge'", "app.post('/api/admin/pdf-tools/merge'", 'merge'],
    ["app.get('/admin/pdf-tools/unlock'", "app.post('/api/admin/pdf-tools/unlock'", 'unlock'],
    ["app.get('/admin/pdf-tools/protect'", "app.post('/api/admin/pdf-tools/protect'", 'protect'],
    ["app.get('/admin/pdf-tools/compress'", "app.post('/api/admin/pdf-tools/compress'", 'compress'],
    ["app.get('/admin/pdf-tools/split'", "app.post('/api/admin/pdf-tools/split'", 'split'],
    ["app.get('/admin/pdf-tools/images-to-pdf'", "app.post('/api/admin/pdf-tools/images-to-pdf'", 'images'],
    ["app.get('/admin/pdf-tools/pdf-to-images'", "app.post('/api/admin/pdf-tools/pdf-to-images/zip'", 'pdf-to-images']
  ]) {
    assert.ok(SERVER_SRC.includes(`${page}, requireAuth, requireAdmin`), `${label} page route intact`);
    assert.ok(SERVER_SRC.includes(`${api}, requireApiAuth, requireAdmin`), `${label} API route intact`);
  }
  assert.ok(!EDITOR_LIB_SRC.includes('extractPdfImages'), 'editor library has no extract code');
  assert.ok(!MERGE_LIB_SRC.includes('extractPdfImages'), 'merge library has no extract code');
  assert.ok(!UNLOCK_LIB_SRC.includes('extractPdfImages'), 'unlock library has no extract code');
  assert.ok(!PROTECT_LIB_SRC.includes('extractPdfImages'), 'protect library has no extract code');
  assert.ok(!COMPRESS_LIB_SRC.includes('extractPdfImages'), 'compress library has no extract code');
  assert.ok(!SPLIT_LIB_SRC.includes('extractPdfImages'), 'split library has no extract code');
  assert.ok(!IMAGES_LIB_SRC.includes('extractPdfImages'), 'images library has no extract code');
  assert.ok(!TO_IMAGES_LIB_SRC.includes('extractPdfImages'), 'pdf-to-images library has no extract code');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/extract-images/"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'extract handlers never log');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker|canvas/i.test(handler), 'no shell/native workflows in the handlers');
  const libCode = EXTRACT_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
  assert.ok(!/\.writeFileSync|createWriteStream|mkdtemp|tmpdir/i.test(libCode), 'no temp-file workflows');
  assert.ok(!/canvas|sharp|jimp/i.test(libCode), 'no rasterizer in the library');
  assert.ok(!/getOperatorList|getViewport|\.render\(/.test(libCode), 'no page rendering in the library');
});

// production availability gate.
test('extract-images: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfExtractImagesAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfExtractImagesAvailable({}), true);
  assert.equal(isPdfExtractImagesAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfExtractImagesAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
  assert.ok(SERVER_SRC.includes('isPdfExtractImagesAvailable()'), 'production gate enforced');
});

test('extract-images: admin page renders picker + inventory + export UI', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-extract-images.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfExtractImagesAvailable: true,
    pdfExtractImagesMaxFileMb: 50
  });
  for (const hook of [
    'pdf-extract-images-root', 'pdf-extract-images-file', 'pdf-extract-images-list',
    'pdf-extract-images-submit', 'pdf-extract-images-pick', 'pdf-extract-images-clear',
    'pdf-extract-images-select-all', 'pdf-extract-images-select-none',
    'pdf-extract-images-status', 'pdf-extract-images-result', 'pdf-extract-images-progress',
    'pdf-extract-images-hint', 'pdf-extract-images-skipped'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-extract-images\.js(\?v=\d+)?"/, 'client loads as ES module');
  assert.match(html, /data-max-file-mb="50"/, '50 MB cap exposed');
  assert.match(html, /never re-rendered|object model/i, 'no-rasterization stated in the UI');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-extract-images.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfExtractImagesAvailable: false,
    pdfExtractImagesMaxFileMb: 50
  });
  assert.match(disabled, /pdf-extract-images-disabled/, 'disabled notice when unavailable');
});

test('extract-images: client lists with thumbnails and exports single/ZIP', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-extract-images.js'), 'utf8');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/extract-images/list'"), 'lists via API');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/extract-images/download'"), 'exports via API');
  assert.ok(src.includes('pdf-extract-images-thumbnail'), 'thumbnail preview');
  assert.ok(src.includes('pdf-extract-images-check'), 'per-image selection');
  assert.ok(src.includes('pdf-extract-images-dimensions'), 'dimensions display');
  assert.ok(src.includes('pdf-extract-images-format'), 'format display');
  assert.ok(src.includes('pdf-extract-images-page'), 'page display');
  assert.ok(src.includes('X-Extracted-Count'), 'reads image-count header');
  assert.ok(src.includes('pdfExtractImagesProgress') && src.includes('setProgressVisible'), 'loading/progress state');
  assert.ok(!src.includes('getViewport') && !src.includes('.render('), 'client never rasterizes pages');
  assert.ok(!src.includes('console.log'), 'client never logs');
});

test('extract-images: admin nav links the tool under PDF', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/extract-images/, 'nav links the tool');
  assert.match(nav, /Extract Images/, 'nav label present');
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  assert.ok(nav.indexOf('href="/admin/pdf-tools/extract-images"') > pdfLabelIdx, 'link sits under the PDF group');
  const onPage = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/pdf-tools/extract-images' });
  assert.match(onPage, /<a href="\/admin\/pdf-tools\/extract-images" class="nav-link active"/, 'item highlights');
});
