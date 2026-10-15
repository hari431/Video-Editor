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
  flattenPdf,
  validatePdfFlattenUpload,
  flattenDownloadName,
  isPdfFlattenAvailable,
  pdfFlattenMaxRequestBytes,
  PDF_FLATTEN_MAX_FILE_MB,
  PDF_FLATTEN_MAX_FILE_BYTES,
  PDF_FLATTEN_MAX_PAGES
} from '../src/library/pdf-flatten.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const FLATTEN_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-flatten.js', import.meta.url)), 'utf8');

const plainPage = () => readFileSync(path.join(FIXTURES_DIR, 'split-6page-plain.pdf'));
const alreadyEnc = () => readFileSync(path.join(FIXTURES_DIR, 'unlock-rich-rc4.pdf'));
const sha256 = b => createHash('sha256').update(b).digest('hex');

// Build a filled form PDF in-test (no fixture needed).
async function makeFormPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('Static content here', { x: 50, y: 750, size: 14, font });
  const form = doc.getForm();
  const nameField = form.createTextField('hero.name');
  nameField.setText('Mario');
  nameField.addToPage(page, { x: 50, y: 700, width: 200, height: 24 });
  const flying = form.createCheckBox('hero.flying');
  flying.check();
  flying.addToPage(page, { x: 50, y: 660 });
  return Buffer.from(await doc.save());
}

async function pageAnalysis(bytes) {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  const annots = await page.getAnnotations();
  await task.destroy();
  return {
    text: tc.items.map(i => i.str).join(' '),
    annots: annots.map(a => a.annotationType || a.subtype).join(',')
  };
}

test('flatten: form fields baked in, values visible, fields gone', async () => {
  const input = await makeFormPdf();
  const before = await PDFDocument.load(input);
  assert.deepEqual(before.getForm().getFields().map(f => f.getName()).sort(), ['hero.flying', 'hero.name']);
  const result = await flattenPdf(Buffer.from(input));
  assert.deepEqual(result.flattened.sort(), ['hero.flying', 'hero.name']);
  assert.equal(result.hadForm, true);
  const after = await PDFDocument.load(result.bytes);
  assert.equal(after.getForm().getFields().length, 0, 'no fillable fields remain');
  assert.equal(after.getPageCount(), 1);
  const analysis = await pageAnalysis(result.bytes);
  assert.ok(analysis.text.includes('Mario'), 'filled value baked into visible text');
  assert.ok(analysis.text.includes('Static content here'), 'static content preserved');
  assert.equal(analysis.annots, '', 'widget annotations consumed by flatten');
});

test('flatten: document without fields returns unchanged', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('No fields here', { x: 50, y: 750, size: 14, font });
  const input = Buffer.from(await doc.save());
  const result = await flattenPdf(Buffer.from(input));
  assert.deepEqual(result.flattened, []);
  assert.equal(result.hadForm, false);
  assert.equal(sha256(result.bytes), sha256(input), 'bytes identical when nothing to flatten');
});

test('flatten: real-world form field flattens (split fixture field f2)', async () => {
  const input = plainPage();
  const result = await flattenPdf(Buffer.from(input));
  assert.deepEqual(result.flattened, ['f2']);
  assert.equal(result.hadForm, true);
  const after = await PDFDocument.load(result.bytes);
  assert.equal(after.getForm().getFields().length, 0, 'field removed');
});

test('flatten: invalid input rejected', async () => {
  await assert.rejects(flattenPdf(Buffer.from('not a pdf')), /could not be read/);
  await assert.rejects(flattenPdf(Buffer.alloc(0)), /empty/);
  await assert.rejects(flattenPdf(Buffer.from(alreadyEnc())), /password-protected/);
  assert.equal(validatePdfFlattenUpload({ name: 'evil.exe', size: 100 }).ok, false);
  assert.match(validatePdfFlattenUpload({ name: 'evil.exe', size: 100 }).error, /\.pdf/);
  assert.equal(flattenDownloadName('Report Q3.pdf'), 'Report_Q3-flattened.pdf');
  assert.equal(flattenDownloadName('../../evil.pdf'), 'evil-flattened.pdf');
});

test('flatten: input bytes are never mutated', async () => {
  const input = await makeFormPdf();
  const before = sha256(input);
  await flattenPdf(Buffer.from(input));
  assert.equal(sha256(input), before);
});

test('flatten: limits match the PDF editor tooling', async () => {
  assert.equal(PDF_FLATTEN_MAX_FILE_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_FLATTEN_MAX_PAGES, PDF_EDITOR_MAX_PAGES);
  assert.ok(pdfFlattenMaxRequestBytes() > 0);
  assert.equal(validatePdfFlattenUpload(null).ok, false);
  const over = validatePdfFlattenUpload({ name: 'a.pdf', size: PDF_FLATTEN_MAX_FILE_BYTES + 1 });
  assert.equal(over.ok, false);
  const huge = Buffer.alloc(PDF_FLATTEN_MAX_FILE_BYTES + 1);
  await assert.rejects(flattenPdf(huge), new RegExp(`exceeds ${PDF_FLATTEN_MAX_FILE_MB} MB`));
  const big = await PDFDocument.create();
  for (let i = 0; i < PDF_FLATTEN_MAX_PAGES + 1; i++) big.addPage([200, 200]);
  await assert.rejects(
    flattenPdf(Buffer.from(await big.save())),
    new RegExp(`max ${PDF_FLATTEN_MAX_PAGES}`)
  );
});

test('flatten: server wires admin-only routes', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/flatten', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/flatten', requireApiAuth, requireAdmin"), 'API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-flatten.js'"), 'dedicated pdf-flatten library used');
  assert.ok(SERVER_SRC.includes('isPdfFlattenAvailable()'), 'production gate enforced');
  assert.ok(SERVER_SRC.includes('X-Flattened-Count'), 'flattened count exposed via headers');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/flatten'"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'flatten handler never logs');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker|canvas/i.test(handler), 'no shell/native workflows');
  const libCode = FLATTEN_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(libCode.includes('.flatten('), 'form flattening engine used');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
});

test('flatten: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfFlattenAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfFlattenAvailable({}), true);
  assert.equal(isPdfFlattenAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfFlattenAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
});

test('flatten: admin page renders picker + status UI', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-flatten.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfFlattenAvailable: true,
    pdfFlattenMaxFileMb: 50
  });
  for (const hook of [
    'pdf-flatten-root', 'pdf-flatten-file', 'pdf-flatten-submit', 'pdf-flatten-status',
    'pdf-flatten-result', 'pdf-flatten-progress', 'pdf-flatten-clear',
    'pdf-flatten-pick', 'pdf-flatten-fileinfo'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-flatten\.js(\?v=\d+)?"/, 'client loads as ES module');
  assert.match(html, /Markup annotations.*preserved as-is/, 'annotation scope stated in the UI');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-flatten.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfFlattenAvailable: false,
    pdfFlattenMaxFileMb: 50
  });
  assert.match(disabled, /pdf-flatten-disabled/, 'disabled notice when unavailable');
});

test('flatten: client posts file and reports counts', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-flatten.js'), 'utf8');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/flatten'"), 'posts to flatten API');
  assert.ok(src.includes("form.append('pdf'"), 'uploads the PDF');
  assert.ok(src.includes('X-Flattened-Count'), 'reads flattened-count header');
  assert.ok(src.includes('GlobalWorkerOptions.workerSrc'), 'vendored pdf.js worker, no CDN');
  assert.ok(!src.includes('console.log'), 'client never logs');
});

test('flatten: admin nav links the tool under PDF', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/flatten/, 'nav links the tool');
  assert.match(nav, /Flatten PDF/, 'nav label present');
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  assert.ok(nav.indexOf('href="/admin/pdf-tools/flatten"') > pdfLabelIdx, 'link sits under the PDF group');
  const onPage = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin/pdf-tools/flatten' });
  assert.match(onPage, /<a href="\/admin\/pdf-tools\/flatten" class="nav-link active"/, 'item highlights');
});
