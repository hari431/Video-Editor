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
  unlockPdf,
  validatePdfUnlockUpload,
  validatePdfUnlockPassword,
  unlockDownloadName,
  isPdfUnlockAvailable,
  pdfUnlockMaxRequestBytes,
  PDF_UNLOCK_MAX_FILE_MB,
  PDF_UNLOCK_MAX_FILE_BYTES,
  PDF_UNLOCK_MAX_PAGES
} from '../src/library/pdf-unlock.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const UNLOCK_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-unlock.js', import.meta.url)), 'utf8');
const EDITOR_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-editor.js', import.meta.url)), 'utf8');
const MERGE_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-merge.js', import.meta.url)), 'utf8');

const TEST_PASSWORD = 'unlock-test-password';
// Encrypted test fixture (generated once with PyMuPDF, RC4-128): 2 pages
// (595x842 + 300x400) with known text "Hello Unlock World" /
// "Second line alpha" / "Second page content". Test-only password above.
const ENC_B64 = 'JVBERi0xLjcKJcK1wrYKJSBXcml0dGVuIGJ5IE11UERGIDEuMjguMgoKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFIvSW5mbzw8L1Byb2R1Y2VyPDhFNjVCMUFBNjU4MjI5MzIzMENGQjFDMD4+Pj4+CmVuZG9iagoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0NvdW50IDIvS2lkc1s0IDAgUiA5IDAgUl0+PgplbmRvYmoKCjMgMCBvYmoKPDwvRm9udDw8L2hlbHYgNSAwIFI+Pj4+CmVuZG9iagoKNCAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDU5NSA4NDJdL1JvdGF0ZSAwL1Jlc291cmNlcyAzIDAgUi9QYXJlbnQgMiAwIFIvQ29udGVudHNbNiAwIFIgNyAwIFJdPj4KZW5kb2JqCgo1IDAgb2JqCjw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYS9FbmNvZGluZy9XaW5BbnNpRW5jb2Rpbmc+PgplbmRvYmoKCjYgMCBvYmoKPDwvTGVuZ3RoIDg0Pj4Kc3RyZWFtCuPaVoaUls5GN+J3rwx68EttAgE8SKOm6grMuimok7NtIbIbFMxK90zlOvPCmVE+zYleWWppkOD4YKPl9m9i6z2DPs+XJ+o1n3Ax4WavxutVQXYsxQplbmRzdHJlYW0KZW5kb2JqCgo3IDAgb2JqCjw8L0xlbmd0aCA4Mj4+CnN0cmVhbQoNGyg77ncK0E/KEvp3IXgnXur/cFDGk77WiLdjhJjhZ5MZebhZfqCeUFYMdKOD9PT6zinztQgPTecTbv2LTk4rd4S3dTzVl1zk6GlGfkSvqSoGCmVuZHN0cmVhbQplbmRvYmoKCjggMCBvYmoKPDwvRm9udDw8L2hlbHYgNSAwIFI+Pj4+CmVuZG9iagoKOSAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDMwMCA0MDBdL1JvdGF0ZSAwL1Jlc291cmNlcyA4IDAgUi9QYXJlbnQgMiAwIFIvQ29udGVudHNbMTAgMCBSXT4+CmVuZG9iagoKMTAgMCBvYmoKPDwvTGVuZ3RoIDg2Pj4Kc3RyZWFtCicQxqnuRP/FRRMwWvjcYYLrDVXa/jVrtSAoStqcvQgnnn32N9lMBlCqJt9UpnrXOO68zfNvjwyYWL++WEa+QhfIjd5YJysDe+mr+UTBOCidKbxnTSSBCmVuZHN0cmVhbQplbmRvYmoKCnhyZWYKMCAxMQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwNDIgMDAwMDAgbiAKMDAwMDAwMDEzMiAwMDAwMCBuIAowMDAwMDAwMTkwIDAwMDAwIG4gCjAwMDAwMDAyMzEgMDAwMDAgbiAKMDAwMDAwMDM0NCAwMDAwMCBuIAowMDAwMDAwNDMzIDAwMDAwIG4gCjAwMDAwMDA1NjYgMDAwMDAgbiAKMDAwMDAwMDY5NyAwMDAwMCBuIAowMDAwMDAwNzM4IDAwMDAwIG4gCjAwMDAwMDA4NDYgMDAwMDAgbiAKCnRyYWlsZXIKPDwvU2l6ZSAxMS9Sb290IDEgMCBSL0lEWzxDMjkyMTRDMzhFMDUzNEMyODY2RDYyNUVDMjg4QzI4Qz48QTdENThDODlCNjREMkQzMURFNTE5RUM4NDczRDBGNTI+XS9FbmNyeXB0PDwvRmlsdGVyL1N0YW5kYXJkL1IgMy9WIDIvTGVuZ3RoIDEyOC9QIC00L0VuY3J5cHRNZXRhZGF0YSB0cnVlL088MERDQTc1NkY4MjZEOUE5NzBGNUQ4MkExMTNDQjhEOERDNkQ5NzBCMzg2QzdCMTUzMTc2NzM0NkZDOURFMDUxMD4vVTw5MkZCRTlGREM5Q0I4REVFRUUzNDg4MThFNjBDNzcwNTI4QkY0RTVFNEU3NThBNDE2NDAwNEU1NkZGRkEwMTA4Pj4+Pj4Kc3RhcnR4cmVmCjk4MgolJUVPRgo=';
const encPdf = () => Buffer.from(ENC_B64, 'base64');

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
// Realistic encrypted fixtures: rich PDFs with Unicode text, vectors, a PNG
// image, freetext/highlight annotations, a text form field and metadata —
// RC4-128 and AES-256 variants — plus an AES-256 file that retains PDF 1.5
// object streams (created via a qpdf lock). All use TEST_PASSWORD.
const richRc4 = () => readFileSync(path.join(FIXTURES_DIR, 'unlock-rich-rc4.pdf'));
const richAes = () => readFileSync(path.join(FIXTURES_DIR, 'unlock-rich-aes256.pdf'));
const objstmQpdf = () => readFileSync(path.join(FIXTURES_DIR, 'unlock-objstm-qpdf.pdf'));

async function makePlainPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('Plain content here', { x: 50, y: 750, size: 14, font });
  return Buffer.from(await doc.save());
}

async function extractText(bytes, password) {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes), password });
  const doc = await task.promise;
  let out = '';
  for (let n = 1; n <= doc.numPages; n++) {
    const tc = await (await doc.getPage(n)).getTextContent();
    out += tc.items.map(i => i.str).join(' ') + '\n';
  }
  await task.destroy();
  return out;
}

const sha256 = b => createHash('sha256').update(b).digest('hex');

// Structural view of a PDF via pdf.js: decoded text, content-stream operator
// sequence, image-paint operations and annotations per page. Used to prove
// the unlock preserves the original structure instead of rebuilding it.
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

// 1. unprotected PDF behavior (no password, and password supplied but ignored)
test('unlock: unprotected PDF unlocks with or without a password', async () => {
  const plain = await makePlainPdf();
  for (const pw of ['', undefined, 'anything']) {
    const out = await unlockPdf(Buffer.from(plain), pw);
    assert.equal(Buffer.from(out.slice(0, 5)).toString('latin1'), '%PDF-');
    const doc = await PDFDocument.load(out);
    assert.equal(doc.getPageCount(), 1);
    assert.equal(doc.isEncrypted, false);
  }
  const text = await extractText(await unlockPdf(Buffer.from(plain), ''), undefined);
  assert.match(text, /Plain content here/);
  const passthrough = await unlockPdf(Buffer.from(plain), '');
  assert.equal(sha256(passthrough), sha256(plain), 'unencrypted input passes through byte-identical (no rebuild)');
});

// 2. correctly supplied password
test('unlock: correct password produces an equivalent unlocked PDF', async () => {
  const out = await unlockPdf(encPdf(), TEST_PASSWORD);
  assert.equal(Buffer.from(out.slice(0, 5)).toString('latin1'), '%PDF-');
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 2);
  assert.deepEqual([doc.getPage(0).getSize().width, doc.getPage(0).getSize().height], [595, 842]);
  assert.deepEqual([doc.getPage(1).getSize().width, doc.getPage(1).getSize().height], [300, 400]);
});

// 3. incorrect password
test('unlock: incorrect password yields a clear error (no guessing)', async () => {
  await assert.rejects(unlockPdf(encPdf(), 'wrong-password'), /Incorrect password/);
  await assert.rejects(unlockPdf(encPdf(), TEST_PASSWORD + 'x'), /Incorrect password/);
});

// 4. invalid/non-PDF input
test('unlock: invalid and non-PDF input rejected gracefully', async () => {
  await assert.rejects(unlockPdf(Buffer.from('not a pdf at all'), 'x'), /could not be read/);
  await assert.rejects(unlockPdf(Buffer.alloc(0), 'x'), /empty/);
  assert.equal(validatePdfUnlockUpload({ name: 'evil.exe', size: 100 }).ok, false);
  assert.match(validatePdfUnlockUpload({ name: 'evil.exe', size: 100 }).error, /\.pdf/);
});

// 5. missing password
test('unlock: missing password on a protected PDF asks for it; unprotected works', async () => {
  await assert.rejects(unlockPdf(encPdf(), ''), /password-protected.*password/i);
  await assert.rejects(unlockPdf(encPdf(), undefined), /password-protected.*password/i);
  await assert.rejects(unlockPdf(Buffer.from(richAes()), ''), /password-protected.*password/i);
  assert.deepEqual(validatePdfUnlockPassword(''), { ok: true, password: '' });
  assert.deepEqual(validatePdfUnlockPassword(undefined), { ok: true, password: '' });
  assert.equal(validatePdfUnlockPassword('x'.repeat(1025)).ok, false);
});

// 6. output is actually readable without the password
test('unlock: output needs no password and keeps the text content', async () => {
  const out = Buffer.from(await unlockPdf(encPdf(), TEST_PASSWORD));
  // pdf-lib default load (no ignoreEncryption): proves the output is NOT encrypted.
  const doc = await PDFDocument.load(out);
  assert.equal(doc.isEncrypted, false);
  assert.equal(doc.getPageCount(), 2);
  const text = await extractText(out, undefined);
  assert.match(text, /Hello Unlock World/);
  assert.match(text, /Second line alpha/);
  assert.match(text, /Second page content/);
});

// 4+5+6+7+8+9+10. structural fidelity on the rich RC4 fixture
test('unlock: correct password preserves all content (RC4 rich fixture)', async () => {
  const input = richRc4();
  const before = sha256(input);
  const out = Buffer.from(await unlockPdf(Buffer.from(input), TEST_PASSWORD));
  assert.equal(sha256(input), before, 'input unchanged');
  assert.notEqual(sha256(out), before, 'output is a new decrypted file, not a copy');
  const doc = await PDFDocument.load(out);
  assert.equal(doc.isEncrypted, false);
  assert.equal(doc.getPageCount(), 2);
  const orig = await jsAnalyze(input, TEST_PASSWORD);
  const unlocked = await jsAnalyze(out, undefined);
  assert.deepEqual(unlocked.pages.map(p => [p.w, p.h]), orig.pages.map(p => [p.w, p.h]), 'page dimensions preserved');
  assert.deepEqual([unlocked.pages[0].w, unlocked.pages[0].h], [595, 842]);
  assert.deepEqual([unlocked.pages[1].w, unlocked.pages[1].h], [300, 400]);
  assert.ok(orig.pages[0].text.length > 0, 'fixture has extractable text');
  for (const needle of ['Spike Unlock Fidelity Check', 'caf\u00e9', 'CJK', 'Second page content']) {
    assert.ok(unlocked.pages.some(p => p.text.includes(needle)), `text preserved: ${needle}`);
  }
  // Full-text equality (stronger than needles): the source itself embeds CJK
  // glyphs pdf.js renders as placeholders, so identical extraction — artifacts
  // included — proves the content streams survived byte-for-byte.
  assert.deepEqual(unlocked.pages.map(p => p.text), orig.pages.map(p => p.text), 'extracted text identical to original');
  assert.ok(orig.pages[0].images > 0, 'fixture contains an image');
  assert.deepEqual(unlocked.pages.map(p => p.images), orig.pages.map(p => p.images), 'images preserved');
  assert.ok(orig.pages[0].opFns.length > 0, 'fixture has content streams');
  assert.deepEqual(unlocked.pages.map(p => p.opFns), orig.pages.map(p => p.opFns), 'vector/content streams identical');
  assert.ok(orig.pages[0].annots.length > 0, 'fixture has annotations');
  assert.deepEqual(unlocked.pages.map(p => p.annots), orig.pages.map(p => p.annots), 'annotations preserved');
  assert.ok(unlocked.pages[0].annots.includes('Ada Lovelace'), 'form field value preserved');
  assert.equal(doc.getTitle(), 'Spike Fixture Title', 'metadata title preserved');
  assert.equal(doc.getAuthor(), 'Spike Author', 'metadata author preserved');
  assert.equal(doc.getSubject(), 'Spike Subject', 'metadata subject preserved');
});

// AES-256 variant unlocks with identical fidelity
test('unlock: AES-256 fixture unlocks with identical fidelity', async () => {
  const out = Buffer.from(await unlockPdf(Buffer.from(richAes()), TEST_PASSWORD));
  const doc = await PDFDocument.load(out);
  assert.equal(doc.isEncrypted, false);
  assert.equal(doc.getPageCount(), 2);
  const a = await jsAnalyze(out, undefined);
  const b = await jsAnalyze(Buffer.from(await unlockPdf(Buffer.from(richRc4()), TEST_PASSWORD)), undefined);
  assert.deepEqual(a.pages.map(p => p.opFns), b.pages.map(p => p.opFns), 'AES and RC4 outputs structurally identical');
  assert.ok(a.pages.some(p => p.text.includes('Spike Unlock Fidelity Check')));
  assert.ok(a.pages.some(p => p.text.includes('caf\u00e9')), 'Unicode preserved through AES unlock');
  assert.deepEqual(a.pages.map(p => p.text), b.pages.map(p => p.text), 'AES text identical to RC4 text');
});

// 11. object-stream encrypted PDF
test('unlock: object-stream encrypted PDF unlocks losslessly', async () => {
  const input = objstmQpdf();
  assert.ok(input.toString('latin1').includes('/ObjStm'), 'fixture genuinely uses object streams');
  const out = Buffer.from(await unlockPdf(Buffer.from(input), TEST_PASSWORD));
  const doc = await PDFDocument.load(out);
  assert.equal(doc.isEncrypted, false);
  assert.equal(doc.getPageCount(), 2);
  const orig = await jsAnalyze(input, TEST_PASSWORD);
  const unlocked = await jsAnalyze(out, undefined);
  assert.deepEqual(unlocked.pages.map(p => [p.w, p.h]), [[595, 842], [300, 400]], 'page dimensions preserved');
  assert.deepEqual(unlocked.pages.map(p => p.opFns), orig.pages.map(p => p.opFns), 'content streams identical');
  assert.deepEqual(unlocked.pages.map(p => p.images), orig.pages.map(p => p.images), 'images preserved');
  assert.ok(unlocked.pages.some(p => p.text.includes('Object-stream fixture')));
  assert.equal(doc.getTitle(), 'ObjStm Title', 'metadata preserved');
  await assert.rejects(unlockPdf(Buffer.from(input), 'wrong'), /Incorrect password/);
});

// 7. original file remains untouched
test('unlock: input bytes are never mutated', async () => {
  const input = encPdf();
  const before = sha256(input);
  const lenBefore = input.length;
  await unlockPdf(input, TEST_PASSWORD);
  assert.equal(sha256(input), before);
  assert.equal(input.length, lenBefore);
});

// 8. file-size/page-count limits consistent with the PDF tooling
test('unlock: size and page limits match the PDF editor tooling', async () => {
  assert.equal(PDF_UNLOCK_MAX_FILE_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_UNLOCK_MAX_PAGES, PDF_EDITOR_MAX_PAGES);
  assert.ok(pdfUnlockMaxRequestBytes() > 0);
  assert.equal(validatePdfUnlockUpload(null).ok, false);
  assert.equal(validatePdfUnlockUpload({ name: 'a.pdf', size: 0 }).ok, false);
  const over = validatePdfUnlockUpload({ name: 'a.pdf', size: PDF_UNLOCK_MAX_FILE_BYTES + 1 });
  assert.equal(over.ok, false);
  assert.match(over.error, new RegExp(String(PDF_UNLOCK_MAX_FILE_MB)));
  const huge = Buffer.alloc(PDF_UNLOCK_MAX_FILE_BYTES + 1);
  await assert.rejects(unlockPdf(huge, ''), new RegExp(`exceeds ${PDF_UNLOCK_MAX_FILE_MB} MB`));
  const big = await PDFDocument.create();
  for (let i = 0; i < PDF_UNLOCK_MAX_PAGES + 1; i++) big.addPage([200, 200]);
  await assert.rejects(
    unlockPdf(Buffer.from(await big.save()), ''),
    new RegExp(`max ${PDF_UNLOCK_MAX_PAGES}`)
  );
});

test('unlock: download name is `<original>-unlocked.pdf` and header-safe', () => {
  assert.equal(unlockDownloadName('Report Q3.pdf'), 'Report_Q3-unlocked.pdf');
  assert.equal(unlockDownloadName('../../evil.pdf'), 'evil-unlocked.pdf');
  assert.equal(unlockDownloadName('x'), 'x-unlocked.pdf');
  assert.equal(unlockDownloadName(''), 'document-unlocked.pdf');
  for (const n of [unlockDownloadName('a/b\\c.pdf'), unlockDownloadName('q"uote.pdf')]) {
    assert.match(n, /^[A-Za-z0-9._-]+\.pdf$/);
  }
});

// 9. admin-only server wiring (editor + merge intact)
test('unlock: server wires admin-only routes (editor and merge untouched)', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/unlock', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/unlock', requireApiAuth, requireAdmin"), 'API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-unlock.js'"), 'dedicated pdf-unlock library used');
  assert.ok(SERVER_SRC.includes('unlockDownloadName'), 'original-based download name used');
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-editor', requireAuth, requireAdmin"), 'editor page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-editor/export', requireApiAuth, requireAdmin"), 'editor export route intact');
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/merge', requireAuth, requireAdmin"), 'merge page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/merge', requireApiAuth, requireAdmin"), 'merge API route intact');
  assert.ok(!EDITOR_LIB_SRC.includes('unlockPdf'), 'editor library has no unlock code');
  assert.ok(!MERGE_LIB_SRC.includes('unlockPdf'), 'merge library has no unlock code');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/unlock'"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'unlock handler never logs (password cannot leak)');
  assert.ok(/single attempt|never guessing/i.test(UNLOCK_LIB_SRC), 'single-attempt (no guessing) policy documented in the library');
  const libCode = UNLOCK_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(libCode.includes("from 'pdfstudio'"), 'qpdf-WASM engine used for decryption');
  assert.ok(!libCode.includes('pdfjs-dist'), 'pdf.js extraction approach removed');
  assert.ok(!libCode.includes('drawText') && !libCode.includes('getTextContent'), 'no text-rebuild reconstruction');
  assert.ok(!libCode.includes('PDFDocument'), 'no pdf-lib load/rebuild of the document');
  assert.ok(!libCode.includes('ignoreEncryption'), 'no fake unlock via ignoreEncryption');
});

// 10. production availability gate
test('unlock: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfUnlockAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfUnlockAvailable({}), true);
  assert.equal(isPdfUnlockAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfUnlockAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
  assert.ok(SERVER_SRC.includes('isPdfUnlockAvailable()'), 'production gate enforced');
});

test('unlock: admin page renders file + password UI with progress', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-unlock.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfUnlockAvailable: true,
    pdfUnlockMaxFileMb: 50
  });
  for (const hook of [
    'pdf-unlock-root', 'pdf-unlock-file', 'pdf-unlock-password', 'pdf-unlock-submit',
    'pdf-unlock-status', 'pdf-unlock-progress', 'pdf-unlock-clear',
    'pdf-unlock-pick', 'pdf-unlock-fileinfo'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="password"/, 'password input is masked');
  assert.match(html, /type="module" src="\/admin-pdf-unlock\.js(\?v=\d+)?"/, 'client loads as ES module');
  assert.match(html, /data-max-file-mb="50"/, '50 MB cap exposed');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-unlock.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfUnlockAvailable: false,
    pdfUnlockMaxFileMb: 50
  });
  assert.match(disabled, /pdf-unlock-disabled/, 'disabled notice when unavailable');
});

test('unlock: client posts file+password once, shows progress, clears password', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-unlock.js'), 'utf8');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/unlock'"), 'posts to unlock API');
  assert.ok(src.includes("form.append('pdf'"), 'uploads the PDF');
  assert.ok(src.includes("form.append('password'"), 'sends the password');
  assert.ok(src.includes('pdfUnlockPassword') || src.includes('pdf-unlock-password'), 'password field wired');
  assert.ok(src.includes("pw.value = ''") || src.includes('clearPassword'), 'password cleared after attempt');
  assert.ok(src.includes('pdfUnlockProgress') && src.includes('setProgressVisible'), 'loading/progress state');
  assert.ok(src.includes('pdf-unlock-status') || src.includes('pdfUnlockStatus'), 'status state');
  assert.ok(src.includes('GlobalWorkerOptions.workerSrc'), 'vendored pdf.js worker, no CDN');
  assert.ok(!src.includes('console.log'), 'client never logs (password cannot leak)');
});

test('unlock: admin nav links the unlock tool', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/unlock/, 'nav links the unlock tool');
  assert.match(nav, /Unlock PDF/, 'nav label present');
});
