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
  addPageNumbers,
  validatePdfNumbersUpload,
  validatePdfNumbersOptions,
  numbersDownloadName,
  isPdfNumbersAvailable,
  pdfNumbersMaxRequestBytes,
  PDF_NUMBERS_POSITIONS,
  PDF_NUMBERS_MAX_FILE_MB,
  PDF_NUMBERS_MAX_FILE_BYTES,
  PDF_NUMBERS_MAX_PAGES
} from '../src/library/pdf-page-numbers.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const NUMBERS_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-page-numbers.js', import.meta.url)), 'utf8');

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

test('numbers: all pages numbered from a start value', async () => {
  const out = Buffer.from(await addPageNumbers(Buffer.from(sixPage()), {
    position: 'bottom-center', start: 7, fontSize: 11, prefix: '', scope: 'all'
  }));
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 6);
  const texts = await pageTexts(out);
  for (let i = 0; i < 6; i++) {
    assert.ok(texts[i].includes(String(7 + i)), `page ${i + 1} shows ${7 + i}`);
    assert.ok(texts[i].includes(`ALPHA-${i + 1}`), 'original content preserved');
  }
});

test('numbers: range, prefix and positions', async () => {
  const out = Buffer.from(await addPageNumbers(Buffer.from(sixPage()), {
    position: 'top-right', start: 1, fontSize: 14, prefix: 'Page ', scope: 'range', selectionText: '2,4'
  }));
  const texts = await pageTexts(out);
  assert.ok(!texts[0].includes('Page 1'), 'page 1 unnumbered');
  assert.ok(texts[1].includes('Page 1'), 'first selected page gets start');
  assert.ok(texts[3].includes('Page 2'), 'second selected page increments');
  assert.ok(!texts[2].includes('Page '), 'page 3 unnumbered');
  for (const pos of ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']) {
    const r = await addPageNumbers(Buffer.from(sixPage()), {
      position: pos, start: 1, fontSize: 11, prefix: '', scope: 'range', selectionText: '1'
    });
    assert.ok((await pageTexts(r))[0].match(/(^|\s)1(\s|$)/), `position ${pos} renders`);
  }
});

test('numbers: option validation', () => {
  assert.deepEqual(validatePdfNumbersOptions({}), {
    ok: true, options: { position: 'bottom-center', start: 1, fontSize: 11, prefix: '' }
  });
  assert.equal(validatePdfNumbersOptions({ position: 'middle' }).ok, false);
  assert.equal(validatePdfNumbersOptions({ start: 0 }).ok, false);
  assert.equal(validatePdfNumbersOptions({ start: 1.5 }).ok, false);
  assert.equal(validatePdfNumbersOptions({ fontSize: 5 }).ok, false);
  assert.equal(validatePdfNumbersOptions({ fontSize: 49 }).ok, false);
  assert.equal(validatePdfNumbersOptions({ prefix: 'a\nb' }).ok, false);
  assert.equal(validatePdfNumbersOptions({ prefix: 'x'.repeat(21) }).ok, false);
  assert.deepEqual(PDF_NUMBERS_POSITIONS, ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']);
  assert.equal(numbersDownloadName('Report Q3.pdf'), 'Report_Q3-numbered.pdf');
  assert.equal(numbersDownloadName('../../evil.pdf'), 'evil-numbered.pdf');
});

test('numbers: invalid input rejected', async () => {
  const base = { position: 'bottom-center', start: 1, fontSize: 11, prefix: '', scope: 'all' };
  await assert.rejects(addPageNumbers(Buffer.from('not a pdf'), base), /could not be read/);
  await assert.rejects(addPageNumbers(Buffer.alloc(0), base), /empty/);
  await assert.rejects(addPageNumbers(Buffer.from(alreadyEnc()), base), /password-protected/);
  await assert.rejects(addPageNumbers(Buffer.from(sixPage()), { ...base, scope: 'range', selectionText: '' }), /Enter pages/);
  await assert.rejects(addPageNumbers(Buffer.from(sixPage()), { ...base, scope: 'range', selectionText: '99' }), /out of range/);
  await assert.rejects(addPageNumbers(Buffer.from(sixPage()), { ...base, scope: 'range', selectionText: '1,1' }), /Duplicate/);
  await assert.rejects(addPageNumbers(Buffer.from(sixPage()), { ...base, position: 'middle' }), /position must be/);
  assert.equal(validatePdfNumbersUpload({ name: 'evil.exe', size: 100 }).ok, false);
});

test('numbers: input bytes are never mutated', async () => {
  const input = sixPage();
  const before = sha256(input);
  await addPageNumbers(Buffer.from(input), { position: 'bottom-center', start: 1, fontSize: 11, prefix: '', scope: 'all' });
  assert.equal(sha256(input), before);
});

test('numbers: limits match the PDF editor tooling', async () => {
  assert.equal(PDF_NUMBERS_MAX_FILE_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_NUMBERS_MAX_PAGES, PDF_EDITOR_MAX_PAGES);
  assert.ok(pdfNumbersMaxRequestBytes() > 0);
  assert.equal(validatePdfNumbersUpload(null).ok, false);
  const over = validatePdfNumbersUpload({ name: 'a.pdf', size: PDF_NUMBERS_MAX_FILE_BYTES + 1 });
  assert.equal(over.ok, false);
  const huge = Buffer.alloc(PDF_NUMBERS_MAX_FILE_BYTES + 1);
  await assert.rejects(
    addPageNumbers(huge, { position: 'bottom-center', start: 1, fontSize: 11, prefix: '', scope: 'all' }),
    new RegExp(`exceeds ${PDF_NUMBERS_MAX_FILE_MB} MB`)
  );
  const big = await PDFDocument.create();
  for (let i = 0; i < PDF_NUMBERS_MAX_PAGES + 1; i++) big.addPage([200, 200]);
  await assert.rejects(
    addPageNumbers(Buffer.from(await big.save()), { position: 'bottom-center', start: 1, fontSize: 11, prefix: '', scope: 'all' }),
    new RegExp(`max ${PDF_NUMBERS_MAX_PAGES}`)
  );
});

test('numbers: server wires admin-only routes', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/page-numbers', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/page-numbers', requireApiAuth, requireAdmin"), 'API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-page-numbers.js'"), 'dedicated pdf-page-numbers library used');
  assert.ok(SERVER_SRC.includes('isPdfNumbersAvailable()'), 'production gate enforced');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/page-numbers'"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'numbers handler never logs');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker|canvas/i.test(handler), 'no shell/native workflows');
  const libCode = NUMBERS_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
});

test('numbers: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfNumbersAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfNumbersAvailable({}), true);
  assert.equal(isPdfNumbersAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfNumbersAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
});

test('numbers: admin page renders picker + options + scope UI', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-numbers.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfNumbersAvailable: true,
    pdfNumbersMaxFileMb: 50
  });
  for (const hook of [
    'pdf-numbers-root', 'pdf-numbers-file', 'pdf-numbers-position', 'pdf-numbers-start',
    'pdf-numbers-size', 'pdf-numbers-prefix', 'pdf-numbers-scope-all', 'pdf-numbers-scope-range',
    'pdf-numbers-selection', 'pdf-numbers-submit', 'pdf-numbers-status', 'pdf-numbers-result',
    'pdf-numbers-progress', 'pdf-numbers-clear', 'pdf-numbers-pick', 'pdf-numbers-fileinfo'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-numbers\.js(\?v=\d+)?"/, 'client loads as ES module');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-numbers.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfNumbersAvailable: false,
    pdfNumbersMaxFileMb: 50
  });
  assert.match(disabled, /pdf-numbers-disabled/, 'disabled notice when unavailable');
});

test('numbers: client posts file+options+scope', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-numbers.js'), 'utf8');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/page-numbers'"), 'posts to numbers API');
  assert.ok(src.includes("form.append('pdf'"), 'uploads the PDF');
  assert.ok(src.includes("form.append('position'"), 'sends position');
  assert.ok(src.includes("form.append('start'"), 'sends start');
  assert.ok(src.includes("form.append('scope'"), 'sends the scope');
  assert.ok(src.includes('GlobalWorkerOptions.workerSrc'), 'vendored pdf.js worker, no CDN');
  assert.ok(!src.includes('console.log'), 'client never logs');
});

test('numbers: admin nav links the tool under PDF', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/page-numbers/, 'nav links the tool');
  assert.match(nav, /Page Numbers/, 'nav label present');
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  assert.ok(nav.indexOf('href="/admin/pdf-tools/page-numbers"') > pdfLabelIdx, 'link sits under the PDF group');
  const onPage = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/pdf-tools/page-numbers' });
  assert.match(onPage, /<a href="\/admin\/pdf-tools\/page-numbers" class="nav-link active"/, 'item highlights');
});
