import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  splitPdf,
  parsePageSelection,
  validatePdfSplitUpload,
  validatePdfSplitMode,
  validatePdfSplitEvery,
  toQpdfSelection,
  chunkPages,
  splitPartNames,
  splitZipName,
  buildZip,
  isPdfSplitAvailable,
  pdfSplitMaxRequestBytes,
  PDF_SPLIT_MODES,
  PDF_SPLIT_MAX_FILE_MB,
  PDF_SPLIT_MAX_FILE_BYTES,
  PDF_SPLIT_MAX_PAGES
} from '../src/library/pdf-split.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const SPLIT_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-split.js', import.meta.url)), 'utf8');
const EDITOR_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-editor.js', import.meta.url)), 'utf8');
const MERGE_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-merge.js', import.meta.url)), 'utf8');
const UNLOCK_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-unlock.js', import.meta.url)), 'utf8');
const PROTECT_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-protect.js', import.meta.url)), 'utf8');
const COMPRESS_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-compress.js', import.meta.url)), 'utf8');

// 6-page plain fixture: mixed sizes, image + annots + widget on page 2,
// metadata. Markers ALPHA-1..6 identify page order.
const sixPage = () => readFileSync(path.join(FIXTURES_DIR, 'split-6page-plain.pdf'));
// Already-encrypted fixture (RC4).
const alreadyEnc = () => readFileSync(path.join(FIXTURES_DIR, 'unlock-rich-rc4.pdf'));

const sha256 = b => createHash('sha256').update(b).digest('hex');

// Structural view of a PDF via pdf.js (same lens as the other suites).
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

// Minimal in-test ZIP reader (independent check of our writer): parses local
// headers + central directory, inflates entries, verifies CRCs via magic.
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

// page/range parsing (valid + invalid + duplicates + out-of-range).
test('split: page selection parsing', () => {
  assert.deepEqual(parsePageSelection('1-3,5', 6), { ok: true, pages: [0, 1, 2, 4] });
  assert.deepEqual(parsePageSelection('5', 6), { ok: true, pages: [4] });
  assert.deepEqual(parsePageSelection(' 6 , 1 ', 6), { ok: true, pages: [5, 0] });
  assert.deepEqual(parsePageSelection('2-2', 6), { ok: true, pages: [1] });
  assert.equal(parsePageSelection('', 6).ok, false);
  assert.equal(parsePageSelection('  ', 6).ok, false);
  assert.equal(parsePageSelection('1,,2', 6).ok, false, 'empty token rejected');
  assert.equal(parsePageSelection('1,', 6).ok, false, 'trailing comma rejected');
  assert.equal(parsePageSelection('a', 6).ok, false, 'non-numeric rejected');
  assert.equal(parsePageSelection('1-x', 6).ok, false, 'non-numeric range end rejected');
  assert.equal(parsePageSelection('1-2-3', 6).ok, false, 'double range rejected');
  assert.equal(parsePageSelection('0', 6).ok, false, 'page 0 rejected');
  assert.equal(parsePageSelection('7', 6).ok, false, 'out-of-range rejected');
  assert.equal(parsePageSelection('5-9', 6).ok, false, 'range overflow rejected');
  assert.equal(parsePageSelection('4-2', 6).ok, false, 'reversed range rejected');
  assert.equal(parsePageSelection('2,2', 6).ok, false, 'duplicate rejected');
  assert.equal(parsePageSelection('1-3,2', 6).ok, false, 'overlap duplicate rejected');
  assert.equal(validatePdfSplitMode('extract').mode, 'extract');
  assert.equal(validatePdfSplitMode('bogus').ok, false);
  assert.deepEqual(PDF_SPLIT_MODES, ['extract', 'every', 'pages']);
  assert.deepEqual(validatePdfSplitEvery('2', 6), { ok: true, every: 2 });
  assert.deepEqual(validatePdfSplitEvery(3, 6), { ok: true, every: 3 });
  assert.equal(validatePdfSplitEvery('0', 6).ok, false);
  assert.equal(validatePdfSplitEvery('-1', 6).ok, false);
  assert.equal(validatePdfSplitEvery('1.5', 6).ok, false);
  assert.equal(validatePdfSplitEvery('x', 6).ok, false);
  assert.equal(validatePdfSplitEvery('', 6).ok, false);
  assert.equal(toQpdfSelection([0, 1, 2, 4]), '1-3,5');
  assert.equal(toQpdfSelection([4]), '5');
  assert.equal(toQpdfSelection([4, 0, 1]), '5,1-2', 'requested order preserved, not sorted');
  assert.deepEqual(chunkPages([0, 1, 2, 3, 4], 2), [[0, 1], [2, 3], [4]]);
});

// selected-page extraction in the given order.
test('split: extract follows selection order', async () => {
  const { parts, mode } = await splitPdf(Buffer.from(sixPage()), { mode: 'extract', selectionText: '5,1-2' });
  assert.equal(mode, 'extract');
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0].pages, [4, 0, 1]);
  const doc = await PDFDocument.load(parts[0].bytes);
  assert.equal(doc.getPageCount(), 3);
  const a = await jsAnalyze(parts[0].bytes, undefined);
  assert.ok(a.pages[0].text.includes('ALPHA-5'));
  assert.ok(a.pages[1].text.includes('ALPHA-1'));
  assert.ok(a.pages[2].text.includes('ALPHA-2'));
});

// split every N pages.
test('split: every-2 yields three ordered parts', async () => {
  const { parts } = await splitPdf(Buffer.from(sixPage()), { mode: 'every', every: '2' });
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map(p => p.pages), [[0, 1], [2, 3], [4, 5]]);
  for (const [i, p] of parts.entries()) {
    const doc = await PDFDocument.load(p.bytes);
    assert.equal(doc.getPageCount(), 2, `part ${i + 1} has 2 pages`);
  }
  const a0 = await jsAnalyze(parts[0].bytes, undefined);
  assert.ok(a0.pages[0].text.includes('ALPHA-1') && a0.pages[1].text.includes('ALPHA-2'));
  const { parts: single } = await splitPdf(Buffer.from(sixPage()), { mode: 'every', every: '99' });
  assert.equal(single.length, 1, 'N larger than the document yields one part');
  assert.equal((await PDFDocument.load(single[0].bytes)).getPageCount(), 6);
});

// individual-page splitting.
test('split: individual pages yield six single-page files', async () => {
  const { parts } = await splitPdf(Buffer.from(sixPage()), { mode: 'pages' });
  assert.equal(parts.length, 6);
  for (let i = 0; i < 6; i++) {
    assert.deepEqual(parts[i].pages, [i]);
    const doc = await PDFDocument.load(parts[i].bytes);
    assert.equal(doc.getPageCount(), 1, `part ${i + 1} single page`);
  }
  const a = await jsAnalyze(parts[3].bytes, undefined);
  assert.ok(a.pages[0].text.includes('ALPHA-4'));
});

// content + page-dimension preservation.
test('split: content and dimensions preserved', async () => {
  const input = sixPage();
  const orig = await jsAnalyze(input, undefined);
  const { parts } = await splitPdf(Buffer.from(input), { mode: 'extract', selectionText: '1-3,5' });
  const got = await jsAnalyze(parts[0].bytes, undefined);
  const wantIdx = [0, 1, 2, 4];
  assert.deepEqual(got.pages.map(p => [p.w, p.h]), wantIdx.map(i => [orig.pages[i].w, orig.pages[i].h]));
  assert.deepEqual(got.pages.map(p => p.text), wantIdx.map(i => orig.pages[i].text), 'text identical');
  assert.deepEqual(got.pages.map(p => p.opFns), wantIdx.map(i => orig.pages[i].opFns), 'vectors identical');
  assert.deepEqual(got.pages.map(p => p.images), wantIdx.map(i => orig.pages[i].images), 'images preserved');
  assert.ok(orig.pages[1].images > 0, 'fixture has an image');
  assert.deepEqual(got.pages.map(p => p.annots), wantIdx.map(i => orig.pages[i].annots), 'annotations preserved');
  assert.ok(got.pages[1].annots.includes('field-two'), 'form field value preserved');
  const dOrig = await PDFDocument.load(input);
  const dGot = await PDFDocument.load(parts[0].bytes);
  assert.equal(dGot.getTitle(), dOrig.getTitle(), 'metadata preserved');
});

// output names sanitized.
test('split: output filenames are sanitized', () => {
  assert.deepEqual(
    splitPartNames({ originalName: 'Report Q3.pdf', mode: 'extract', selectionText: '1-3,5', groups: [[0, 1, 2, 4]] }),
    ['Report_Q3-pages-1-3_5.pdf']
  );
  assert.deepEqual(
    splitPartNames({ originalName: '../../evil.pdf', mode: 'every', groups: [[0, 1], [2, 3]] }),
    ['evil-part1.pdf', 'evil-part2.pdf']
  );
  assert.deepEqual(
    splitPartNames({ originalName: 'x.pdf', mode: 'pages', groups: [[0], [1]] }),
    ['x-page1.pdf', 'x-page2.pdf']
  );
  assert.equal(splitZipName('Report Q3.pdf'), 'Report_Q3-split.zip');
  assert.equal(splitZipName(''), 'document-split.zip');
  for (const n of splitPartNames({ originalName: 'a/b\\c.pdf', mode: 'pages', groups: [[0]] })) {
    assert.match(n, /^[A-Za-z0-9._-]+\.pdf$/);
  }
});

// invalid input handling.
test('split: invalid, non-PDF and encrypted input rejected', async () => {
  await assert.rejects(splitPdf(Buffer.from('not a pdf'), { mode: 'pages' }), /could not be read/);
  await assert.rejects(splitPdf(Buffer.alloc(0), { mode: 'pages' }), /empty/);
  await assert.rejects(splitPdf(Buffer.from(alreadyEnc()), { mode: 'pages' }), /password-protected/);
  await assert.rejects(splitPdf(Buffer.from(sixPage()), { mode: 'extract', selectionText: '' }), /Enter pages/);
  await assert.rejects(splitPdf(Buffer.from(sixPage()), { mode: 'extract', selectionText: '9' }), /out of range/);
  await assert.rejects(splitPdf(Buffer.from(sixPage()), { mode: 'extract', selectionText: '1,1' }), /Duplicate/);
  await assert.rejects(splitPdf(Buffer.from(sixPage()), { mode: 'every', every: '0' }), /positive whole number/);
  await assert.rejects(splitPdf(Buffer.from(sixPage()), { mode: 'bogus' }), /mode must be/);
  await assert.rejects(splitPdf(Buffer.from(sixPage()), { mode: 'every', every: '' }), /positive whole number/);
  assert.equal(validatePdfSplitUpload({ name: 'evil.exe', size: 100 }).ok, false);
  assert.match(validatePdfSplitUpload({ name: 'evil.exe', size: 100 }).error, /\.pdf/);
});

// original input bytes unchanged.
test('split: input bytes are never mutated', async () => {
  const input = sixPage();
  const before = sha256(input);
  await splitPdf(Buffer.from(input), { mode: 'every', every: '2' });
  await splitPdf(Buffer.from(input), { mode: 'extract', selectionText: '1,3,5' });
  assert.equal(sha256(input), before);
});

// limits consistent with the PDF tooling.
test('split: size and page limits match the PDF editor tooling', async () => {
  assert.equal(PDF_SPLIT_MAX_FILE_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_SPLIT_MAX_PAGES, PDF_EDITOR_MAX_PAGES);
  assert.ok(pdfSplitMaxRequestBytes() > 0);
  assert.equal(validatePdfSplitUpload(null).ok, false);
  assert.equal(validatePdfSplitUpload({ name: 'a.pdf', size: 0 }).ok, false);
  const over = validatePdfSplitUpload({ name: 'a.pdf', size: PDF_SPLIT_MAX_FILE_BYTES + 1 });
  assert.equal(over.ok, false);
  assert.match(over.error, new RegExp(String(PDF_SPLIT_MAX_FILE_MB)));
  const huge = Buffer.alloc(PDF_SPLIT_MAX_FILE_BYTES + 1);
  await assert.rejects(splitPdf(huge, { mode: 'pages' }), new RegExp(`exceeds ${PDF_SPLIT_MAX_FILE_MB} MB`));
  const big = await PDFDocument.create();
  const font = await big.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < PDF_SPLIT_MAX_PAGES + 1; i++) {
    big.addPage([200, 200]).drawText('x', { x: 10, y: 10, size: 8, font });
  }
  await assert.rejects(
    splitPdf(Buffer.from(await big.save()), { mode: 'pages' }),
    new RegExp(`max ${PDF_SPLIT_MAX_PAGES}`)
  );
});

// ZIP output: multi-part results pack into a valid archive.
test('split: multiple parts zip into a valid archive', async () => {
  const { parts } = await splitPdf(Buffer.from(sixPage()), { mode: 'every', every: '2' });
  const names = splitPartNames({ originalName: 'report.pdf', mode: 'every', groups: parts.map(p => p.pages) });
  const zip = buildZip(parts.map((p, i) => ({ name: names[i], data: p.bytes })));
  assert.equal(zip.subarray(0, 4).toString('latin1'), 'PK\x03\x04', 'ZIP magic present');
  const entries = readZip(zip);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(e => e.name), names);
  for (let i = 0; i < entries.length; i++) {
    assert.deepEqual(entries[i].bytes, parts[i].bytes, `entry ${i + 1} round-trips exactly`);
    assert.equal(entries[i].bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  }
  assert.throws(() => buildZip([]), /Nothing to zip/);
});

// admin-only server wiring (editor, merge, unlock, protect, compress intact).
test('split: server wires admin-only routes (other tools untouched)', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/split', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/split', requireApiAuth, requireAdmin"), 'API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-split.js'"), 'dedicated pdf-split library used');
  assert.ok(SERVER_SRC.includes('X-Split-Parts'), 'part count exposed via headers');
  assert.ok(SERVER_SRC.includes('application/zip'), 'ZIP download supported');
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
  assert.ok(!EDITOR_LIB_SRC.includes('splitPdf'), 'editor library has no split code');
  assert.ok(!MERGE_LIB_SRC.includes('splitPdf'), 'merge library has no split code');
  assert.ok(!UNLOCK_LIB_SRC.includes('splitPdf'), 'unlock library has no split code');
  assert.ok(!PROTECT_LIB_SRC.includes('splitPdf'), 'protect library has no split code');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/split'"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'split handler never logs');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker/i.test(handler), 'no shell/binary workflows in the handler');
  const libCode = SPLIT_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(libCode.includes("from 'pdfstudio'"), 'qpdf-WASM engine used');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
  assert.ok(!/\.writeFileSync|createWriteStream|mkdtemp|tmpdir/i.test(libCode), 'no temp-file workflows');
});

// production availability gate.
test('split: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfSplitAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfSplitAvailable({}), true);
  assert.equal(isPdfSplitAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfSplitAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
  assert.ok(SERVER_SRC.includes('isPdfSplitAvailable()'), 'production gate enforced');
});

test('split: admin page renders file + mode UI with progress', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-split.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfSplitAvailable: true,
    pdfSplitMaxFileMb: 50
  });
  for (const hook of [
    'pdf-split-root', 'pdf-split-file', 'pdf-split-mode-extract', 'pdf-split-mode-every',
    'pdf-split-mode-pages', 'pdf-split-selection', 'pdf-split-every', 'pdf-split-submit',
    'pdf-split-status', 'pdf-split-result', 'pdf-split-progress', 'pdf-split-clear',
    'pdf-split-pick', 'pdf-split-fileinfo'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-split\.js(\?v=\d+)?"/, 'client loads as ES module');
  assert.match(html, /data-max-file-mb="50"/, '50 MB cap exposed');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-split.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfSplitAvailable: false,
    pdfSplitMaxFileMb: 50
  });
  assert.match(disabled, /pdf-split-disabled/, 'disabled notice when unavailable');
});

test('split: client posts file+mode and handles PDF or ZIP downloads', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-split.js'), 'utf8');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/split'"), 'posts to split API');
  assert.ok(src.includes("form.append('pdf'"), 'uploads the PDF');
  assert.ok(src.includes("form.append('mode'"), 'sends the mode');
  assert.ok(src.includes("form.append('selection'"), 'sends the selection');
  assert.ok(src.includes("form.append('every'"), 'sends the chunk size');
  assert.ok(src.includes('X-Split-Parts'), 'reads part-count header');
  assert.ok(src.includes('GlobalWorkerOptions.workerSrc'), 'vendored pdf.js worker, no CDN');
  assert.ok(!src.includes('console.log'), 'client never logs');
});

test('split: admin nav links the split tool under PDF', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/split/, 'nav links the split tool');
  assert.match(nav, /Split PDF/, 'nav label present');
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  assert.ok(nav.indexOf('href="/admin/pdf-tools/split"') > pdfLabelIdx, 'split link sits under the PDF group');
  const onPage = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/pdf-tools/split' });
  assert.match(onPage, /<a href="\/admin\/pdf-tools\/split" class="nav-link active"/, 'split item highlights');
});
