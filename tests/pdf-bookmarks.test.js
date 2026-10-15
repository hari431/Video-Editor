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
  getPdfBookmarks,
  setPdfBookmarks,
  validatePdfBookmarksUpload,
  validatePdfBookmarksMode,
  parseBookmarkEntries,
  bookmarksDownloadName,
  isPdfBookmarksAvailable,
  pdfBookmarksMaxRequestBytes,
  PDF_BOOKMARKS_MODES,
  PDF_BOOKMARKS_MAX_FILE_MB,
  PDF_BOOKMARKS_MAX_FILE_BYTES,
  PDF_BOOKMARKS_MAX_PAGES
} from '../src/library/pdf-bookmarks.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const BOOKMARKS_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-bookmarks.js', import.meta.url)), 'utf8');

const sixPage = () => readFileSync(path.join(FIXTURES_DIR, 'split-6page-plain.pdf'));
const alreadyEnc = () => readFileSync(path.join(FIXTURES_DIR, 'unlock-rich-rc4.pdf'));
const sha256 = b => createHash('sha256').update(b).digest('hex');

async function outlineOf(bytes) {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const outline = await doc.getOutline();
  const flat = [];
  const walk = async (items) => {
    for (const it of items || []) {
      let page = null;
      try {
        if (it.dest) page = (await doc.getPageIndex(it.dest[0])) + 1;
      } catch { page = null; }
      flat.push({ title: it.title, page });
      await walk(it.items);
    }
  };
  await walk(outline);
  await task.destroy();
  return flat;
}

async function opLists(bytes) {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    out.push((await (await doc.getPage(n)).getOperatorList()).fnArray.join(','));
  }
  await task.destroy();
  return out;
}

test('bookmarks: creates bookmarks resolving to the right pages', async () => {
  const out = Buffer.from(await setPdfBookmarks(Buffer.from(sixPage()), {
    entriesText: 'Cover | 1\nMiddle | 3\nEnd | 6', mode: 'replace'
  }));
  assert.deepEqual(await outlineOf(out), [
    { title: 'Cover', page: 1 },
    { title: 'Middle', page: 3 },
    { title: 'End', page: 6 }
  ]);
  const before = await opLists(sixPage());
  const after = await opLists(out);
  assert.deepEqual(after, before, 'page content untouched');
});

test('bookmarks: append preserves existing entries', async () => {
  const first = Buffer.from(await setPdfBookmarks(Buffer.from(sixPage()), {
    entriesText: 'Cover | 1\nMiddle | 3', mode: 'replace'
  }));
  const second = Buffer.from(await setPdfBookmarks(first, {
    entriesText: 'Appendix | 5', mode: 'append'
  }));
  assert.deepEqual((await outlineOf(second)).map(o => o.title), ['Cover', 'Middle', 'Appendix']);
  assert.deepEqual((await outlineOf(second)).map(o => o.page), [1, 3, 5]);
  const listed = await getPdfBookmarks(second);
  assert.deepEqual(listed, [
    { title: 'Cover', page: 1 },
    { title: 'Middle', page: 3 },
    { title: 'Appendix', page: 5 }
  ]);
});

test('bookmarks: reading a file without bookmarks returns empty', async () => {
  assert.deepEqual(await getPdfBookmarks(sixPage()), []);
});

test('bookmarks: entry parsing and validation', () => {
  assert.deepEqual(parseBookmarkEntries('Cover | 1\nEnd|6', 6),
    { ok: true, entries: [{ title: 'Cover', pageIndex: 0 }, { title: 'End', pageIndex: 5 }] });
  assert.deepEqual(parseBookmarkEntries('\n  Intro | 2 \n', 6),
    { ok: true, entries: [{ title: 'Intro', pageIndex: 1 }] });
  assert.equal(parseBookmarkEntries('', 6).ok, false);
  assert.equal(parseBookmarkEntries('   \n  ', 6).ok, false);
  assert.equal(parseBookmarkEntries('NoPipe 3', 6).ok, false);
  assert.equal(parseBookmarkEntries('T | x', 6).ok, false);
  assert.equal(parseBookmarkEntries('T | 0', 6).ok, false);
  assert.equal(parseBookmarkEntries('T | 7', 6).ok, false);
  assert.equal(parseBookmarkEntries(' | 2', 6).ok, false, 'empty title rejected');
  assert.equal(parseBookmarkEntries('T | 1 | 2', 6).ok, false, 'double pipe rejected');
  assert.deepEqual(validatePdfBookmarksMode(''), { ok: true, mode: 'append' });
  assert.deepEqual(validatePdfBookmarksMode('replace'), { ok: true, mode: 'replace' });
  assert.equal(validatePdfBookmarksMode('merge').ok, false);
  assert.deepEqual(PDF_BOOKMARKS_MODES, ['append', 'replace']);
  assert.equal(bookmarksDownloadName('Report Q3.pdf'), 'Report_Q3-bookmarks.pdf');
  assert.equal(bookmarksDownloadName('../../evil.pdf'), 'evil-bookmarks.pdf');
});

test('bookmarks: invalid input rejected', async () => {
  await assert.rejects(setPdfBookmarks(Buffer.from('not a pdf'), { entriesText: 'A | 1', mode: 'replace' }), /could not be read/);
  await assert.rejects(setPdfBookmarks(Buffer.alloc(0), { entriesText: 'A | 1', mode: 'replace' }), /empty/);
  await assert.rejects(setPdfBookmarks(Buffer.from(alreadyEnc()), { entriesText: 'A | 1', mode: 'replace' }), /password-protected/);
  await assert.rejects(getPdfBookmarks(Buffer.from('not a pdf')), /could not be read/);
  await assert.rejects(getPdfBookmarks(Buffer.from(alreadyEnc())), /password-protected/);
  await assert.rejects(setPdfBookmarks(Buffer.from(sixPage()), { entriesText: '', mode: 'replace' }), /at least one bookmark/);
  await assert.rejects(setPdfBookmarks(Buffer.from(sixPage()), { entriesText: 'A | 99', mode: 'replace' }), /out of range/);
  assert.equal(validatePdfBookmarksUpload({ name: 'evil.exe', size: 100 }).ok, false);
});

test('bookmarks: input bytes are never mutated', async () => {
  const input = sixPage();
  const before = sha256(input);
  await setPdfBookmarks(Buffer.from(input), { entriesText: 'Cover | 1', mode: 'replace' });
  assert.equal(sha256(input), before);
});

test('bookmarks: limits match the PDF editor tooling', async () => {
  assert.equal(PDF_BOOKMARKS_MAX_FILE_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_BOOKMARKS_MAX_PAGES, PDF_EDITOR_MAX_PAGES);
  assert.ok(pdfBookmarksMaxRequestBytes() > 0);
  assert.equal(validatePdfBookmarksUpload(null).ok, false);
  const over = validatePdfBookmarksUpload({ name: 'a.pdf', size: PDF_BOOKMARKS_MAX_FILE_BYTES + 1 });
  assert.equal(over.ok, false);
  const huge = Buffer.alloc(PDF_BOOKMARKS_MAX_FILE_BYTES + 1);
  await assert.rejects(setPdfBookmarks(huge, { entriesText: 'A | 1', mode: 'replace' }), new RegExp(`exceeds ${PDF_BOOKMARKS_MAX_FILE_MB} MB`));
  const big = await PDFDocument.create();
  for (let i = 0; i < PDF_BOOKMARKS_MAX_PAGES + 1; i++) big.addPage([200, 200]);
  await assert.rejects(
    setPdfBookmarks(Buffer.from(await big.save()), { entriesText: 'A | 1', mode: 'replace' }),
    new RegExp(`max ${PDF_BOOKMARKS_MAX_PAGES}`)
  );
});

test('bookmarks: server wires admin-only routes', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/bookmarks', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/bookmarks/info', requireApiAuth, requireAdmin"), 'info API route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/bookmarks/apply', requireApiAuth, requireAdmin"), 'apply API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-bookmarks.js'"), 'dedicated pdf-bookmarks library used');
  assert.ok(SERVER_SRC.includes('isPdfBookmarksAvailable()'), 'production gate enforced');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/bookmarks/"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'bookmarks handlers never log');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker|canvas/i.test(handler), 'no shell/native workflows');
  const libCode = BOOKMARKS_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
});

test('bookmarks: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfBookmarksAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfBookmarksAvailable({}), true);
  assert.equal(isPdfBookmarksAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfBookmarksAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
});

test('bookmarks: admin page renders picker + entries + mode UI', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-bookmarks.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfBookmarksAvailable: true,
    pdfBookmarksMaxFileMb: 50
  });
  for (const hook of [
    'pdf-bookmarks-root', 'pdf-bookmarks-file', 'pdf-bookmarks-entries', 'pdf-bookmarks-mode',
    'pdf-bookmarks-existing', 'pdf-bookmarks-submit', 'pdf-bookmarks-status', 'pdf-bookmarks-result',
    'pdf-bookmarks-progress', 'pdf-bookmarks-clear', 'pdf-bookmarks-pick', 'pdf-bookmarks-fileinfo'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-bookmarks\.js(\?v=\d+)?"/, 'client loads as ES module');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-bookmarks.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfBookmarksAvailable: false,
    pdfBookmarksMaxFileMb: 50
  });
  assert.match(disabled, /pdf-bookmarks-disabled/, 'disabled notice when unavailable');
});

test('bookmarks: client loads outline and posts entries', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-bookmarks.js'), 'utf8');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/bookmarks/info'"), 'loads current outline');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/bookmarks/apply'"), 'posts entries');
  assert.ok(src.includes("form.append('pdf'"), 'uploads the PDF');
  assert.ok(src.includes("form.append('entries'"), 'sends entries');
  assert.ok(!src.includes('console.log'), 'client never logs');
});

test('bookmarks: admin nav links the tool under PDF', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/bookmarks/, 'nav links the tool');
  assert.match(nav, /Bookmarks/, 'nav label present');
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  assert.ok(nav.indexOf('href="/admin/pdf-tools/bookmarks"') > pdfLabelIdx, 'link sits under the PDF group');
  const onPage = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/pdf-tools/bookmarks' });
  assert.match(onPage, /<a href="\/admin\/pdf-tools\/bookmarks" class="nav-link active"/, 'item highlights');
});
