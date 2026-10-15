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
  getPdfMetadata,
  setPdfMetadata,
  validatePdfMetadataUpload,
  validatePdfMetadataFields,
  metadataDownloadName,
  isPdfMetadataAvailable,
  pdfMetadataMaxRequestBytes,
  PDF_METADATA_FIELDS,
  PDF_METADATA_MAX_FILE_MB,
  PDF_METADATA_MAX_FILE_BYTES,
  PDF_METADATA_MAX_PAGES
} from '../src/library/pdf-metadata.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const METADATA_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-metadata.js', import.meta.url)), 'utf8');

const plainMeta = () => readFileSync(path.join(FIXTURES_DIR, 'compress-rich-plain.pdf'));
const alreadyEnc = () => readFileSync(path.join(FIXTURES_DIR, 'unlock-rich-rc4.pdf'));
const sha256 = b => createHash('sha256').update(b).digest('hex');

async function opLists(bytes) {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    out.push((await (await doc.getPage(n)).getOperatorList()).fnArray.join(','));
  }
  await task.destroy();
  return { pages: doc.numPages, ops: out };
}

test('metadata: reads current metadata', async () => {
  const meta = await getPdfMetadata(plainMeta());
  assert.equal(meta.title, 'Compress Fixture');
  assert.equal(meta.author, 'Spike Author');
  assert.ok(Array.isArray(meta.keywords), 'keywords come back as an array');
  assert.deepEqual(Object.keys(meta).sort(), [...PDF_METADATA_FIELDS].sort());
});

test('metadata: edits fields and preserves everything else', async () => {
  const input = plainMeta();
  const before = await opLists(input);
  const out = Buffer.from(await setPdfMetadata(Buffer.from(input), {
    title: 'New Title', author: 'New Author', subject: 'New Subject',
    keywords: 'alpha, beta ,gamma', creator: 'MetaTool', producer: 'MetaTool 2.0'
  }));
  const meta = await getPdfMetadata(out);
  assert.equal(meta.title, 'New Title');
  assert.equal(meta.author, 'New Author');
  assert.equal(meta.subject, 'New Subject');
  assert.deepEqual(meta.keywords, ['alpha', 'beta', 'gamma']);
  assert.equal(meta.creator, 'MetaTool');
  assert.equal(meta.producer, 'MetaTool 2.0');
  const after = await opLists(out);
  assert.deepEqual(after, before, 'content streams identical — only metadata changed');
  assert.equal((await PDFDocument.load(out)).getPageCount(), before.pages);
});

test('metadata: empty string clears a field', async () => {
  const out = Buffer.from(await setPdfMetadata(Buffer.from(plainMeta()), { title: '' }));
  const meta = await getPdfMetadata(out);
  assert.ok(meta.title === '' || meta.title === undefined, 'title cleared');
  assert.equal(meta.author, 'Spike Author', 'other fields preserved');
});

test('metadata: field validation', () => {
  assert.deepEqual(validatePdfMetadataFields({ title: 'Hi' }), { ok: true, fields: { title: 'Hi' } });
  assert.deepEqual(validatePdfMetadataFields({}), { ok: true, fields: {} });
  assert.deepEqual(validatePdfMetadataFields({ keywords: ['a', 'b'] }), { ok: true, fields: { keywords: 'a, b' } });
  assert.equal(validatePdfMetadataFields({ title: 42 }).ok, false);
  assert.equal(validatePdfMetadataFields({ title: 'a\nb' }).ok, false);
  assert.equal(validatePdfMetadataFields({ title: 'x'.repeat(501) }).ok, false);
  assert.equal(validatePdfMetadataFields({ bogus: 'x' }).ok, false, 'unknown fields rejected');
  assert.deepEqual(PDF_METADATA_FIELDS, ['title', 'author', 'subject', 'keywords', 'creator', 'producer']);
  assert.equal(metadataDownloadName('Report Q3.pdf'), 'Report_Q3-metadata.pdf');
  assert.equal(metadataDownloadName('../../evil.pdf'), 'evil-metadata.pdf');
});

test('metadata: invalid input rejected', async () => {
  await assert.rejects(getPdfMetadata(Buffer.from('not a pdf')), /could not be read/);
  await assert.rejects(setPdfMetadata(Buffer.alloc(0), { title: 'x' }), /empty/);
  await assert.rejects(getPdfMetadata(Buffer.from(alreadyEnc())), /password-protected/);
  await assert.rejects(setPdfMetadata(Buffer.from(alreadyEnc()), { title: 'x' }), /password-protected/);
  await assert.rejects(setPdfMetadata(Buffer.from(plainMeta()), { title: 'x'.repeat(501) }), /at most 500/);
  assert.equal(validatePdfMetadataUpload({ name: 'evil.exe', size: 100 }).ok, false);
});

test('metadata: input bytes are never mutated', async () => {
  const input = plainMeta();
  const before = sha256(input);
  await setPdfMetadata(Buffer.from(input), { title: 'Changed' });
  assert.equal(sha256(input), before);
});

test('metadata: limits match the PDF editor tooling', async () => {
  assert.equal(PDF_METADATA_MAX_FILE_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_METADATA_MAX_PAGES, PDF_EDITOR_MAX_PAGES);
  assert.ok(pdfMetadataMaxRequestBytes() > 0);
  assert.equal(validatePdfMetadataUpload(null).ok, false);
  const over = validatePdfMetadataUpload({ name: 'a.pdf', size: PDF_METADATA_MAX_FILE_BYTES + 1 });
  assert.equal(over.ok, false);
  const huge = Buffer.alloc(PDF_METADATA_MAX_FILE_BYTES + 1);
  await assert.rejects(getPdfMetadata(huge), new RegExp(`exceeds ${PDF_METADATA_MAX_FILE_MB} MB`));
  const big = await PDFDocument.create();
  for (let i = 0; i < PDF_METADATA_MAX_PAGES + 1; i++) big.addPage([200, 200]);
  await assert.rejects(
    getPdfMetadata(Buffer.from(await big.save())),
    new RegExp(`max ${PDF_METADATA_MAX_PAGES}`)
  );
});

test('metadata: server wires admin-only routes', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/metadata', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/metadata/info', requireApiAuth, requireAdmin"), 'info API route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/metadata/apply', requireApiAuth, requireAdmin"), 'apply API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-metadata.js'"), 'dedicated pdf-metadata library used');
  assert.ok(SERVER_SRC.includes('isPdfMetadataAvailable()'), 'production gate enforced');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/metadata/"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'metadata handlers never log');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker|canvas/i.test(handler), 'no shell/native workflows');
  const libCode = METADATA_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
});

test('metadata: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfMetadataAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfMetadataAvailable({}), true);
  assert.equal(isPdfMetadataAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfMetadataAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
});

test('metadata: admin page renders picker + form UI', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-metadata.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfMetadataAvailable: true,
    pdfMetadataMaxFileMb: 50
  });
  for (const hook of [
    'pdf-metadata-root', 'pdf-metadata-file', 'pdf-metadata-title', 'pdf-metadata-author',
    'pdf-metadata-subject', 'pdf-metadata-keywords', 'pdf-metadata-creator', 'pdf-metadata-producer',
    'pdf-metadata-submit', 'pdf-metadata-status', 'pdf-metadata-result',
    'pdf-metadata-progress', 'pdf-metadata-clear', 'pdf-metadata-pick', 'pdf-metadata-fileinfo'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-metadata\.js(\?v=\d+)?"/, 'client loads as ES module');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-metadata.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfMetadataAvailable: false,
    pdfMetadataMaxFileMb: 50
  });
  assert.match(disabled, /pdf-metadata-disabled/, 'disabled notice when unavailable');
});

test('metadata: client loads info and posts edits', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-metadata.js'), 'utf8');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/metadata/info'"), 'loads current metadata');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/metadata/apply'"), 'posts edits');
  assert.ok(src.includes("form.append('pdf'"), 'uploads the PDF');
  assert.ok(!src.includes('console.log'), 'client never logs');
});

test('metadata: admin nav links the tool under PDF', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/metadata/, 'nav links the tool');
  assert.match(nav, /PDF Metadata/, 'nav label present');
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  assert.ok(nav.indexOf('href="/admin/pdf-tools/metadata"') > pdfLabelIdx, 'link sits under the PDF group');
  const onPage = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/pdf-tools/metadata' });
  assert.match(onPage, /<a href="\/admin\/pdf-tools\/metadata" class="nav-link active"/, 'item highlights');
});
