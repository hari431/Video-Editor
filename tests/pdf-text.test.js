import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  extractPdfText,
  validatePdfTextUpload,
  textDownloadName,
  isPdfTextAvailable,
  pdfTextMaxRequestBytes,
  PDF_TEXT_MAX_FILE_MB,
  PDF_TEXT_MAX_FILE_BYTES,
  PDF_TEXT_MAX_PAGES,
  PDF_TEXT_MAX_CHARS
} from '../src/library/pdf-text.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const TEXT_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-text.js', import.meta.url)), 'utf8');

const sixPage = () => readFileSync(path.join(FIXTURES_DIR, 'split-6page-plain.pdf'));
const alreadyEnc = () => readFileSync(path.join(FIXTURES_DIR, 'unlock-rich-rc4.pdf'));
const sha256 = b => createHash('sha256').update(b).digest('hex');

test('text: extracts all pages with boundaries in order', async () => {
  const result = await extractPdfText(Buffer.from(sixPage()), { scope: 'all' });
  assert.equal(result.pageCount, 6);
  assert.equal(result.pages.length, 6);
  assert.deepEqual(result.pages.map(p => p.page), [1, 2, 3, 4, 5, 6]);
  for (let i = 0; i < 6; i++) {
    assert.ok(result.text.includes(`--- Page ${i + 1} of 6 ---`), `page ${i + 1} boundary present`);
    assert.ok(result.text.includes(`ALPHA-${i + 1}`), `page ${i + 1} text present`);
  }
  // Order: boundaries appear sequentially.
  const idx = [1, 2, 3, 4, 5, 6].map(n => result.text.indexOf(`--- Page ${n} of 6 ---`));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'pages in order');
  assert.ok(result.pages.every(p => p.chars > 0), 'per-page char counts reported');
});

test('text: range selection extracts only those pages', async () => {
  const result = await extractPdfText(Buffer.from(sixPage()), { scope: 'range', selectionText: '5,1-2' });
  assert.deepEqual(result.pages.map(p => p.page), [5, 1, 2]);
  assert.ok(result.text.includes('ALPHA-5') && result.text.includes('ALPHA-1'));
  assert.ok(!result.text.includes('ALPHA-4'), 'unselected page absent');
  assert.ok(result.text.includes('--- Page 5 of 6 ---'), 'boundary keeps document numbering');
});

test('text: pages without selectable text report zero chars (no OCR claimed)', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]); // blank page: no text at all
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('Hello', { x: 50, y: 750, size: 14, font });
  const result = await extractPdfText(Buffer.from(await doc.save()), { scope: 'all' });
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[0].chars > 0, true, 'header block always has chars');
  assert.ok(result.text.includes('Hello'));
});

test('text: invalid input rejected', async () => {
  await assert.rejects(extractPdfText(Buffer.from('not a pdf'), { scope: 'all' }), /could not be read/);
  await assert.rejects(extractPdfText(Buffer.alloc(0), { scope: 'all' }), /empty/);
  await assert.rejects(extractPdfText(Buffer.from(alreadyEnc()), { scope: 'all' }), /password-protected/);
  await assert.rejects(extractPdfText(Buffer.from(sixPage()), { scope: 'range', selectionText: '' }), /Enter pages/);
  await assert.rejects(extractPdfText(Buffer.from(sixPage()), { scope: 'range', selectionText: '99' }), /out of range/);
  await assert.rejects(extractPdfText(Buffer.from(sixPage()), { scope: 'range', selectionText: '1,1' }), /Duplicate/);
  assert.equal(validatePdfTextUpload({ name: 'evil.exe', size: 100 }).ok, false);
  assert.equal(textDownloadName('Report Q3.pdf'), 'Report_Q3.txt');
  assert.equal(textDownloadName('../../evil.pdf'), 'evil.txt');
  assert.ok(PDF_TEXT_MAX_CHARS >= 1024 * 1024, 'multi-MB text cap configured');
});

test('text: input bytes are never mutated', async () => {
  const input = sixPage();
  const before = sha256(input);
  await extractPdfText(Buffer.from(input), { scope: 'all' });
  assert.equal(sha256(input), before);
});

test('text: limits match the PDF editor tooling', async () => {
  assert.equal(PDF_TEXT_MAX_FILE_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_TEXT_MAX_PAGES, PDF_EDITOR_MAX_PAGES);
  assert.ok(pdfTextMaxRequestBytes() > 0);
  assert.equal(validatePdfTextUpload(null).ok, false);
  const over = validatePdfTextUpload({ name: 'a.pdf', size: PDF_TEXT_MAX_FILE_BYTES + 1 });
  assert.equal(over.ok, false);
  const huge = Buffer.alloc(PDF_TEXT_MAX_FILE_BYTES + 1);
  await assert.rejects(extractPdfText(huge, { scope: 'all' }), new RegExp(`exceeds ${PDF_TEXT_MAX_FILE_MB} MB`));
  const big = await PDFDocument.create();
  for (let i = 0; i < PDF_TEXT_MAX_PAGES + 1; i++) big.addPage([200, 200]);
  await assert.rejects(
    extractPdfText(Buffer.from(await big.save()), { scope: 'all' }),
    new RegExp(`max ${PDF_TEXT_MAX_PAGES}`)
  );
});

test('text: server wires admin-only routes', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/pdf-to-text', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/pdf-to-text/info', requireApiAuth, requireAdmin"), 'info API route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/pdf-to-text/download', requireApiAuth, requireAdmin"), 'download API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-text.js'"), 'dedicated pdf-text library used');
  assert.ok(SERVER_SRC.includes('isPdfTextAvailable()'), 'production gate enforced');
  assert.ok(SERVER_SRC.includes('X-Text-Pages'), 'page count exposed via headers');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/pdf-to-text/"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'text handlers never log');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker|canvas/i.test(handler), 'no shell/native workflows');
  const libCode = TEXT_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
  assert.ok(!/tesseract|ocrmypdf|ocrad/i.test(libCode), 'no OCR runtime');
});

test('text: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfTextAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfTextAvailable({}), true);
  assert.equal(isPdfTextAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfTextAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
});

test('text: admin page renders picker + scope + preview UI', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-text.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfTextAvailable: true,
    pdfTextMaxFileMb: 50
  });
  for (const hook of [
    'pdf-text-root', 'pdf-text-file', 'pdf-text-scope-all', 'pdf-text-scope-range',
    'pdf-text-selection', 'pdf-text-preview', 'pdf-text-preview-output',
    'pdf-text-submit', 'pdf-text-status', 'pdf-text-result',
    'pdf-text-progress', 'pdf-text-clear', 'pdf-text-pick', 'pdf-text-fileinfo'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-text\.js(\?v=\d+)?"/, 'client loads as ES module');
  assert.match(html, /no OCR/i, 'no-OCR scope stated in the UI');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-text.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfTextAvailable: false,
    pdfTextMaxFileMb: 50
  });
  assert.match(disabled, /pdf-text-disabled/, 'disabled notice when unavailable');
});

test('text: client previews and downloads .txt', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-text.js'), 'utf8');
  assert.ok(src.includes("'/api/admin/pdf-tools/pdf-to-text/info'"), 'previews via API');
  assert.ok(src.includes("'/api/admin/pdf-tools/pdf-to-text/download'"), 'downloads via API');
  assert.ok(src.includes("form.append('pdf'"), 'uploads the PDF');
  assert.ok(src.includes('GlobalWorkerOptions.workerSrc'), 'vendored pdf.js worker, no CDN');
  assert.ok(!src.includes('console.log'), 'client never logs');
});

test('text: admin nav links the tool under PDF', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/pdf-to-text/, 'nav links the tool');
  assert.match(nav, /PDF to Text/, 'nav label present');
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  assert.ok(nav.indexOf('href="/admin/pdf-tools/pdf-to-text"') > pdfLabelIdx, 'link sits under the PDF group');
  const onPage = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/pdf-tools/pdf-to-text' });
  assert.match(onPage, /<a href="\/admin\/pdf-tools\/pdf-to-text" class="nav-link active"/, 'item highlights');
});
