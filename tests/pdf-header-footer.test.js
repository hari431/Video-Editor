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
  addHeaderFooter,
  validatePdfHeaderFooterUpload,
  validatePdfHeaderFooterOptions,
  expandHeaderFooterTokens,
  headerFooterDownloadName,
  isPdfHeaderFooterAvailable,
  pdfHeaderFooterMaxRequestBytes,
  PDF_HEADER_FOOTER_MAX_FILE_MB,
  PDF_HEADER_FOOTER_MAX_FILE_BYTES,
  PDF_HEADER_FOOTER_MAX_PAGES
} from '../src/library/pdf-header-footer.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const HEADER_FOOTER_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-header-footer.js', import.meta.url)), 'utf8');

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

const baseOpts = { header: 'CONFIDENTIAL', footer: 'Page {page} of {total}', align: 'center', fontSize: 10, scope: 'all' };

test('header-footer: tokens expand per page, content preserved', async () => {
  const out = Buffer.from(await addHeaderFooter(Buffer.from(sixPage()), baseOpts));
  assert.equal((await PDFDocument.load(out)).getPageCount(), 6);
  const texts = await pageTexts(out);
  for (let i = 0; i < 6; i++) {
    assert.ok(texts[i].includes('CONFIDENTIAL'), `page ${i + 1} header`);
    assert.ok(texts[i].includes(`Page ${i + 1} of 6`), `page ${i + 1} footer tokens`);
    assert.ok(texts[i].includes(`ALPHA-${i + 1}`), 'original content preserved');
  }
});

test('header-footer: range and alignment, header-only and footer-only', async () => {
  const out = Buffer.from(await addHeaderFooter(Buffer.from(sixPage()), {
    header: '', footer: 'F{page}', align: 'right', fontSize: 12, scope: 'range', selectionText: '2,4'
  }));
  const texts = await pageTexts(out);
  assert.ok(!texts[0].includes('F1'), 'page 1 untouched');
  assert.ok(texts[1].includes('F2') && texts[3].includes('F4'), 'selected pages stamped');
  const hOnly = await addHeaderFooter(Buffer.from(sixPage()), {
    header: 'Hdr', footer: '', align: 'left', fontSize: 10, scope: 'range', selectionText: '1'
  });
  const ht = await pageTexts(hOnly);
  assert.ok(ht[0].includes('Hdr') && !ht[1].includes('Hdr'), 'header-only works');
  for (const align of ['left', 'center', 'right']) {
    const r = await addHeaderFooter(Buffer.from(sixPage()), {
      header: 'A', footer: 'B', align, fontSize: 10, scope: 'range', selectionText: '1'
    });
    const t = (await pageTexts(r))[0];
    assert.ok(t.includes('A') && t.includes('B'), `align ${align} renders both lines`);
  }
});

test('header-footer: tokens and option validation', () => {
  assert.equal(expandHeaderFooterTokens('P{page}/{total}', 3, 6), 'P3/6');
  assert.equal(expandHeaderFooterTokens('plain', 3, 6), 'plain');
  assert.deepEqual(validatePdfHeaderFooterOptions({ header: 'H', footer: '' }),
    { ok: true, options: { header: 'H', footer: '', align: 'center', fontSize: 10 } });
  assert.equal(validatePdfHeaderFooterOptions({ header: '', footer: '' }).ok, false, 'both empty rejected');
  assert.equal(validatePdfHeaderFooterOptions({ header: 'x'.repeat(201), footer: '' }).ok, false);
  assert.equal(validatePdfHeaderFooterOptions({ header: 'a\nb', footer: '' }).ok, false);
  assert.equal(validatePdfHeaderFooterOptions({ header: 'H', footer: '', align: 'middle' }).ok, false);
  assert.equal(validatePdfHeaderFooterOptions({ header: 'H', footer: '', fontSize: 5 }).ok, false);
  assert.equal(validatePdfHeaderFooterOptions({ header: 'H', footer: '', fontSize: 49 }).ok, false);
  assert.equal(headerFooterDownloadName('Report Q3.pdf'), 'Report_Q3-header-footer.pdf');
  assert.equal(headerFooterDownloadName('../../evil.pdf'), 'evil-header-footer.pdf');
});

test('header-footer: invalid input rejected', async () => {
  await assert.rejects(addHeaderFooter(Buffer.from('not a pdf'), baseOpts), /could not be read/);
  await assert.rejects(addHeaderFooter(Buffer.alloc(0), baseOpts), /empty/);
  await assert.rejects(addHeaderFooter(Buffer.from(alreadyEnc()), baseOpts), /password-protected/);
  await assert.rejects(addHeaderFooter(Buffer.from(sixPage()), { ...baseOpts, scope: 'range', selectionText: '' }), /Enter pages/);
  await assert.rejects(addHeaderFooter(Buffer.from(sixPage()), { ...baseOpts, scope: 'range', selectionText: '99' }), /out of range/);
  await assert.rejects(addHeaderFooter(Buffer.from(sixPage()), { ...baseOpts, scope: 'range', selectionText: '1,1' }), /Duplicate/);
  assert.equal(validatePdfHeaderFooterUpload({ name: 'evil.exe', size: 100 }).ok, false);
});

test('header-footer: input bytes are never mutated', async () => {
  const input = sixPage();
  const before = sha256(input);
  await addHeaderFooter(Buffer.from(input), baseOpts);
  assert.equal(sha256(input), before);
});

test('header-footer: limits match the PDF editor tooling', async () => {
  assert.equal(PDF_HEADER_FOOTER_MAX_FILE_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_HEADER_FOOTER_MAX_PAGES, PDF_EDITOR_MAX_PAGES);
  assert.ok(pdfHeaderFooterMaxRequestBytes() > 0);
  assert.equal(validatePdfHeaderFooterUpload(null).ok, false);
  const over = validatePdfHeaderFooterUpload({ name: 'a.pdf', size: PDF_HEADER_FOOTER_MAX_FILE_BYTES + 1 });
  assert.equal(over.ok, false);
  const huge = Buffer.alloc(PDF_HEADER_FOOTER_MAX_FILE_BYTES + 1);
  await assert.rejects(addHeaderFooter(huge, baseOpts), new RegExp(`exceeds ${PDF_HEADER_FOOTER_MAX_FILE_MB} MB`));
  const big = await PDFDocument.create();
  for (let i = 0; i < PDF_HEADER_FOOTER_MAX_PAGES + 1; i++) big.addPage([200, 200]);
  await assert.rejects(
    addHeaderFooter(Buffer.from(await big.save()), baseOpts),
    new RegExp(`max ${PDF_HEADER_FOOTER_MAX_PAGES}`)
  );
});

test('header-footer: server wires admin-only routes', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/header-footer', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/header-footer', requireApiAuth, requireAdmin"), 'API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-header-footer.js'"), 'dedicated pdf-header-footer library used');
  assert.ok(SERVER_SRC.includes('isPdfHeaderFooterAvailable()'), 'production gate enforced');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/header-footer'"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'header-footer handler never logs');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker|canvas/i.test(handler), 'no shell/native workflows');
  const libCode = HEADER_FOOTER_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
});

test('header-footer: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfHeaderFooterAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfHeaderFooterAvailable({}), true);
  assert.equal(isPdfHeaderFooterAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfHeaderFooterAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
});

test('header-footer: admin page renders picker + text + scope UI', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-header-footer.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfHeaderFooterAvailable: true,
    pdfHeaderFooterMaxFileMb: 50
  });
  for (const hook of [
    'pdf-header-footer-root', 'pdf-header-footer-file', 'pdf-header-footer-header',
    'pdf-header-footer-footer', 'pdf-header-footer-align', 'pdf-header-footer-size',
    'pdf-header-footer-scope-all', 'pdf-header-footer-scope-range', 'pdf-header-footer-selection',
    'pdf-header-footer-submit', 'pdf-header-footer-status', 'pdf-header-footer-result',
    'pdf-header-footer-progress', 'pdf-header-footer-clear', 'pdf-header-footer-pick', 'pdf-header-footer-fileinfo'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-header-footer\.js(\?v=\d+)?"/, 'client loads as ES module');
  assert.match(html, /\{page\}.*\{total\}/, 'token syntax documented');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-header-footer.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfHeaderFooterAvailable: false,
    pdfHeaderFooterMaxFileMb: 50
  });
  assert.match(disabled, /pdf-header-footer-disabled/, 'disabled notice when unavailable');
});

test('header-footer: client posts file+texts+scope', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-header-footer.js'), 'utf8');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/header-footer'"), 'posts to header-footer API');
  assert.ok(src.includes("form.append('pdf'"), 'uploads the PDF');
  assert.ok(src.includes("form.append('header'"), 'sends header');
  assert.ok(src.includes("form.append('footer'"), 'sends footer');
  assert.ok(src.includes("form.append('scope'"), 'sends the scope');
  assert.ok(src.includes('GlobalWorkerOptions.workerSrc'), 'vendored pdf.js worker, no CDN');
  assert.ok(!src.includes('console.log'), 'client never logs');
});

test('header-footer: admin nav links the tool under PDF', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/header-footer/, 'nav links the tool');
  assert.match(nav, /Header\/Footer/, 'nav label present');
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  assert.ok(nav.indexOf('href="/admin/pdf-tools/header-footer"') > pdfLabelIdx, 'link sits under the PDF group');
  const onPage = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/pdf-tools/header-footer' });
  assert.match(onPage, /<a href="\/admin\/pdf-tools\/header-footer" class="nav-link active"/, 'item highlights');
});
