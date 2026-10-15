import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  compressPdf,
  validatePdfCompressUpload,
  validatePdfCompressLevel,
  chooseCompressedOutput,
  compressDownloadName,
  isPdfCompressAvailable,
  pdfCompressMaxRequestBytes,
  PDF_COMPRESS_LEVELS,
  PDF_COMPRESS_DEFAULT_LEVEL,
  PDF_COMPRESS_MAX_FILE_MB,
  PDF_COMPRESS_MAX_FILE_BYTES,
  PDF_COMPRESS_MAX_PAGES
} from '../src/library/pdf-compress.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const COMPRESS_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-compress.js', import.meta.url)), 'utf8');
const EDITOR_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-editor.js', import.meta.url)), 'utf8');
const MERGE_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-merge.js', import.meta.url)), 'utf8');
const UNLOCK_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-unlock.js', import.meta.url)), 'utf8');
const PROTECT_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-protect.js', import.meta.url)), 'utf8');

// Rich plain fixture: 2 pages with Unicode text, vectors, a PNG image,
// freetext annotation, a filled text field and metadata (~45 KB).
const richPlain = () => readFileSync(path.join(FIXTURES_DIR, 'compress-rich-plain.pdf'));
// Already-encrypted fixture (RC4).
const alreadyEnc = () => readFileSync(path.join(FIXTURES_DIR, 'unlock-rich-rc4.pdf'));

const sha256 = b => createHash('sha256').update(b).digest('hex');

// Structural view of a PDF via pdf.js (same lens as the unlock/protect suites).
async function jsAnalyze(bytes, password) {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes), password });
  const doc = await task.promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const ops = await page.getOperatorList();
    const annots = await page.getAnnotations();
    pages.push({
      w: vp.width, h: vp.height,
      text: tc.items.map(i => i.str).join(' '),
      opFns: ops.fnArray.join(','),
      images: ops.fnArray.filter(f => f === pdfjsLib.OPS.paintImageXObject).length,
      annots: annots.map(a => `${a.annotationType || a.subtype}${a.fieldType ? `:${a.fieldType}` : ''}${a.fieldValue !== undefined ? `=${JSON.stringify(a.fieldValue)}` : ''}`).join('|')
    });
  }
  await task.destroy();
  return { numPages: doc.numPages, pages };
}

// 16. actual size reduction on a compressible fixture (+ output validity)
test('compress: realistic PDF gets smaller and stays valid', async () => {
  const input = richPlain();
  const result = await compressPdf(Buffer.from(input), 'balanced');
  assert.equal(result.level, 'balanced');
  assert.ok(result.reduced, `expected a smaller file, got ${input.length} -> ${result.bytes.length}`);
  assert.ok(result.ratio > 5, `expected meaningful reduction, got ${result.ratio.toFixed(1)}%`);
  assert.equal(result.bytes.slice(0, 5).toString('latin1'), '%PDF-');
  const doc = await PDFDocument.load(result.bytes);
  assert.equal(doc.getPageCount(), 2);
  assert.equal(doc.isEncrypted, false);
});

// 1+2+3+4+5+6+7+8+9. fidelity: text/unicode/pages/dims/images/vectors/annots/forms/metadata
test('compress: losslessly preserves all content', async () => {
  const input = richPlain();
  const { bytes: out } = await compressPdf(Buffer.from(input), 'maximum');
  const orig = await jsAnalyze(input, undefined);
  const comp = await jsAnalyze(out, undefined);
  assert.equal(comp.numPages, orig.numPages, 'page count preserved');
  assert.deepEqual(comp.pages.map(p => [p.w, p.h]), [[595, 842], [300, 400]], 'page dimensions preserved');
  assert.ok(orig.pages[0].text.length > 0, 'fixture has extractable text');
  for (const needle of ['Compress Fidelity Check', 'caf\u00e9', 'Second page for compress']) {
    assert.ok(comp.pages.some(p => p.text.includes(needle)), `text preserved: ${needle}`);
  }
  assert.deepEqual(comp.pages.map(p => p.text), orig.pages.map(p => p.text), 'extracted text identical');
  assert.ok(orig.pages[0].images > 0, 'fixture contains an image');
  assert.deepEqual(comp.pages.map(p => p.images), orig.pages.map(p => p.images), 'images preserved');
  assert.deepEqual(comp.pages.map(p => p.opFns), orig.pages.map(p => p.opFns), 'vector/content streams identical');
  assert.deepEqual(comp.pages.map(p => p.annots), orig.pages.map(p => p.annots), 'annotations preserved');
  assert.ok(comp.pages[0].annots.includes('Grace Hopper'), 'form field value preserved');
  const dOrig = await PDFDocument.load(input);
  const dComp = await PDFDocument.load(out);
  assert.equal(dComp.getTitle(), dOrig.getTitle(), 'metadata title preserved');
  assert.equal(dComp.getAuthor(), dOrig.getAuthor(), 'metadata author preserved');
});

test('compress: levels are lossless and validated', async () => {
  assert.deepEqual(validatePdfCompressLevel(''), { ok: true, level: 'balanced' });
  assert.deepEqual(validatePdfCompressLevel(undefined), { ok: true, level: 'balanced' });
  assert.deepEqual(validatePdfCompressLevel('fast'), { ok: true, level: 'fast' });
  assert.deepEqual(validatePdfCompressLevel('maximum'), { ok: true, level: 'maximum' });
  assert.equal(validatePdfCompressLevel('ultra').ok, false);
  assert.match(validatePdfCompressLevel('ultra').error, /fast, balanced, maximum/);
  assert.equal(PDF_COMPRESS_DEFAULT_LEVEL, 'balanced');
  assert.deepEqual(Object.keys(PDF_COMPRESS_LEVELS), ['fast', 'balanced', 'maximum']);
  for (const level of ['fast', 'balanced', 'maximum']) {
    const result = await compressPdf(Buffer.from(richPlain()), level);
    assert.equal(result.level, level);
    const doc = await PDFDocument.load(result.bytes);
    assert.equal(doc.getPageCount(), 2, `${level}: page count preserved`);
  }
  await assert.rejects(compressPdf(Buffer.from(richPlain()), 'ultra'), /fast, balanced, maximum/);
});

test('compress: larger output is handled gracefully (original returned, no false claim)', () => {
  const original = Buffer.from([1, 2, 3, 4]);
  const bigger = Buffer.from([1, 2, 3, 4, 5]);
  const kept = chooseCompressedOutput(original, bigger);
  assert.equal(kept.reduced, false);
  assert.equal(kept.ratio, 0);
  assert.deepEqual(kept.bytes, original);
  const equal = chooseCompressedOutput(original, Buffer.from(original));
  assert.equal(equal.reduced, false, 'equal size is not a reduction');
  const smaller = chooseCompressedOutput(Buffer.from([1, 2, 3, 4]), Buffer.from([1, 2]));
  assert.equal(smaller.reduced, true);
  assert.equal(smaller.ratio, 50);
  assert.deepEqual(smaller.bytes, Buffer.from([1, 2]));
});

// 11. original input bytes unchanged
test('compress: input bytes are never mutated', async () => {
  const input = richPlain();
  const before = sha256(input);
  const lenBefore = input.length;
  await compressPdf(Buffer.from(input), 'balanced');
  assert.equal(sha256(input), before);
  assert.equal(input.length, lenBefore);
});

// 12. invalid/non-PDF input (incl. already-encrypted files)
test('compress: invalid, non-PDF and already-encrypted input rejected', async () => {
  await assert.rejects(compressPdf(Buffer.from('not a pdf at all'), 'balanced'), /could not be read/);
  await assert.rejects(compressPdf(Buffer.alloc(0), 'balanced'), /empty/);
  await assert.rejects(compressPdf(Buffer.from(alreadyEnc()), 'balanced'), /password-protected/);
  assert.equal(validatePdfCompressUpload({ name: 'evil.exe', size: 100 }).ok, false);
  assert.match(validatePdfCompressUpload({ name: 'evil.exe', size: 100 }).error, /\.pdf/);
});

// 13. file-size/page limits consistent with the PDF tooling
test('compress: size and page limits match the PDF editor tooling', async () => {
  assert.equal(PDF_COMPRESS_MAX_FILE_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_COMPRESS_MAX_PAGES, PDF_EDITOR_MAX_PAGES);
  assert.ok(pdfCompressMaxRequestBytes() > 0);
  assert.equal(validatePdfCompressUpload(null).ok, false);
  assert.equal(validatePdfCompressUpload({ name: 'a.pdf', size: 0 }).ok, false);
  const over = validatePdfCompressUpload({ name: 'a.pdf', size: PDF_COMPRESS_MAX_FILE_BYTES + 1 });
  assert.equal(over.ok, false);
  assert.match(over.error, new RegExp(String(PDF_COMPRESS_MAX_FILE_MB)));
  const huge = Buffer.alloc(PDF_COMPRESS_MAX_FILE_BYTES + 1);
  await assert.rejects(compressPdf(huge, 'balanced'), new RegExp(`exceeds ${PDF_COMPRESS_MAX_FILE_MB} MB`));
  const big = await PDFDocument.create();
  const font = await big.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < PDF_COMPRESS_MAX_PAGES + 1; i++) {
    big.addPage([200, 200]).drawText('x', { x: 10, y: 10, size: 8, font });
  }
  await assert.rejects(
    compressPdf(Buffer.from(await big.save()), 'balanced'),
    new RegExp(`max ${PDF_COMPRESS_MAX_PAGES}`)
  );
});

test('compress: download name is `<original>-compressed.pdf` and header-safe', () => {
  assert.equal(compressDownloadName('Report Q3.pdf'), 'Report_Q3-compressed.pdf');
  assert.equal(compressDownloadName('../../evil.pdf'), 'evil-compressed.pdf');
  assert.equal(compressDownloadName('x'), 'x-compressed.pdf');
  assert.equal(compressDownloadName(''), 'document-compressed.pdf');
  for (const n of [compressDownloadName('a/b\\c.pdf'), compressDownloadName('q"uote.pdf')]) {
    assert.match(n, /^[A-Za-z0-9._-]+\.pdf$/);
  }
});

// 14. admin-only server wiring (editor, merge, unlock and protect intact)
test('compress: server wires admin-only routes (other tools untouched)', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/compress', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/compress', requireApiAuth, requireAdmin"), 'API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-compress.js'"), 'dedicated pdf-compress library used');
  assert.ok(SERVER_SRC.includes('compressDownloadName'), 'original-based download name used');
  assert.ok(SERVER_SRC.includes('X-Compress-Reduced'), 'reduction result exposed via headers');
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-editor', requireAuth, requireAdmin"), 'editor page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-editor/export', requireApiAuth, requireAdmin"), 'editor export route intact');
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/merge', requireAuth, requireAdmin"), 'merge page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/merge', requireApiAuth, requireAdmin"), 'merge API route intact');
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/unlock', requireAuth, requireAdmin"), 'unlock page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/unlock', requireApiAuth, requireAdmin"), 'unlock API route intact');
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/protect', requireAuth, requireAdmin"), 'protect page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/protect', requireApiAuth, requireAdmin"), 'protect API route intact');
  assert.ok(!EDITOR_LIB_SRC.includes('compressPdf'), 'editor library has no compress code');
  assert.ok(!MERGE_LIB_SRC.includes('compressPdf'), 'merge library has no compress code');
  assert.ok(!UNLOCK_LIB_SRC.includes('compressPdf'), 'unlock library has no compress code');
  assert.ok(!PROTECT_LIB_SRC.includes('compressPdf'), 'protect library has no compress code');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/compress'"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'compress handler never logs');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker/i.test(handler), 'no shell/binary workflows in the handler');
  const libCode = COMPRESS_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(libCode.includes("from 'pdfstudio'"), 'qpdf-WASM engine used');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
  assert.ok(!/\.writeFileSync|createWriteStream|mkdtemp|tmpdir/i.test(libCode), 'no temp-file workflows');
  assert.ok(!/downsample|re-render|render/i.test(libCode), 'no lossy re-rendering');
});

// 15. production availability gate
test('compress: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfCompressAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfCompressAvailable({}), true);
  assert.equal(isPdfCompressAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfCompressAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
  assert.ok(SERVER_SRC.includes('isPdfCompressAvailable()'), 'production gate enforced');
});

test('compress: admin page renders file + level UI with progress and result', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-compress.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfCompressAvailable: true,
    pdfCompressMaxFileMb: 50
  });
  for (const hook of [
    'pdf-compress-root', 'pdf-compress-file', 'pdf-compress-level', 'pdf-compress-submit',
    'pdf-compress-status', 'pdf-compress-result', 'pdf-compress-progress', 'pdf-compress-clear',
    'pdf-compress-pick', 'pdf-compress-fileinfo'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-compress\.js(\?v=\d+)?"/, 'client loads as ES module');
  assert.match(html, /data-max-file-mb="50"/, '50 MB cap exposed');
  assert.match(html, /lossless only/i, 'lossless nature stated in the UI');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-compress.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfCompressAvailable: false,
    pdfCompressMaxFileMb: 50
  });
  assert.match(disabled, /pdf-compress-disabled/, 'disabled notice when unavailable');
});

test('compress: client posts file+level, shows honest size results', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-compress.js'), 'utf8');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/compress'"), 'posts to compress API');
  assert.ok(src.includes("form.append('pdf'"), 'uploads the PDF');
  assert.ok(src.includes("form.append('level'"), 'sends the level');
  assert.ok(src.includes('X-Compress-Reduced') && src.includes('X-Compress-Ratio'), 'reads honest result headers');
  assert.ok(src.includes('Already optimally packed'), 'graceful already-optimal message');
  assert.ok(src.includes('pdfCompressProgress') && src.includes('setProgressVisible'), 'loading/progress state');
  assert.ok(src.includes('GlobalWorkerOptions.workerSrc'), 'vendored pdf.js worker, no CDN');
  assert.ok(!src.includes('console.log'), 'client never logs');
});

test('compress: admin nav links the compress tool under PDF', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/compress/, 'nav links the compress tool');
  assert.match(nav, /Compress PDF/, 'nav label present');
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  assert.ok(nav.indexOf('href="/admin/pdf-tools/compress"') > pdfLabelIdx, 'compress link sits under the PDF group');
  const onPage = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/pdf-tools/compress' });
  assert.match(onPage, /<a href="\/admin\/pdf-tools\/compress" class="nav-link active"/, 'compress item highlights');
});
