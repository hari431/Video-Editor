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
import { createPdfToolkit, PdfPasswordError } from 'pdfstudio';
import {
  protectPdf,
  validatePdfProtectUpload,
  validatePdfProtectPasswords,
  protectDownloadName,
  isPdfProtectAvailable,
  pdfProtectMaxRequestBytes,
  PDF_PROTECT_MAX_FILE_MB,
  PDF_PROTECT_MAX_FILE_BYTES,
  PDF_PROTECT_MAX_PAGES
} from '../src/library/pdf-protect.js';
import {
  PDF_EDITOR_MAX_FILE_MB,
  PDF_EDITOR_MAX_PAGES
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const PROTECT_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-protect.js', import.meta.url)), 'utf8');
const EDITOR_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-editor.js', import.meta.url)), 'utf8');
const MERGE_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-merge.js', import.meta.url)), 'utf8');
const UNLOCK_LIB_SRC = readFileSync(fileURLToPath(new URL('../src/library/pdf-unlock.js', import.meta.url)), 'utf8');

const TEST_PW = 'protect-test-password';
// Rich plain fixture: 2 pages with Unicode text, vectors, a PNG image,
// freetext/highlight annotations, a filled text field and metadata.
const plainRich = () => readFileSync(path.join(FIXTURES_DIR, 'protect-rich-plain.pdf'));
// Already-encrypted fixture (RC4, password 'unlock-test-password').
const alreadyEnc = () => readFileSync(path.join(FIXTURES_DIR, 'unlock-rich-rc4.pdf'));

const sha256 = b => createHash('sha256').update(b).digest('hex');

// Structural view of a PDF via pdf.js (same lens as the unlock suite).
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

// 1. successful password protection
test('protect: password protects a plain PDF', async () => {
  const out = Buffer.from(await protectPdf(Buffer.from(plainRich()), TEST_PW));
  assert.equal(out.slice(0, 5).toString('latin1'), '%PDF-');
  assert.ok(out.length > 1000, 'non-trivial output');
});

// 2. output is actually encrypted
test('protect: output is genuinely encrypted (AES-256)', async () => {
  const out = Buffer.from(await protectPdf(Buffer.from(plainRich()), TEST_PW));
  await assert.rejects(PDFDocument.load(out), /encrypted/);
  const toolkit = await createPdfToolkit();
  assert.equal(await toolkit.isEncrypted(out), true);
  const info = await toolkit.getInfo(out, { password: TEST_PW });
  assert.equal(info.encrypted, true);
  assert.equal(info.encryption.bits, 256);
});

// 3. output requires the password
test('protect: output cannot be opened without the password', async () => {
  const out = Buffer.from(await protectPdf(Buffer.from(plainRich()), TEST_PW));
  const toolkit = await createPdfToolkit();
  await assert.rejects(toolkit.getInfo(out), PdfPasswordError);
  await assert.rejects(pdfjsLib.getDocument({ data: new Uint8Array(out) }).promise);
});

// 4. correct password opens the protected PDF
test('protect: correct password opens the protected PDF', async () => {
  const out = Buffer.from(await protectPdf(Buffer.from(plainRich()), TEST_PW));
  const toolkit = await createPdfToolkit();
  const back = Buffer.from(await toolkit.unlock(new Uint8Array(out), { password: TEST_PW }));
  assert.ok(back.length > 1000);
  const text = (await jsAnalyze(back, undefined)).pages.map(p => p.text).join('\n');
  assert.match(text, /Spike Unlock Fidelity Check/);
});

// 5. incorrect password fails
test('protect: incorrect password fails to open the output', async () => {
  const out = Buffer.from(await protectPdf(Buffer.from(plainRich()), TEST_PW));
  const toolkit = await createPdfToolkit();
  await assert.rejects(toolkit.unlock(new Uint8Array(out), { password: 'wrong-pw' }), PdfPasswordError);
});

// 6. password mismatch validation
test('protect: mismatched passwords are rejected', () => {
  assert.equal(validatePdfProtectPasswords('secret-1', 'secret-2').ok, false);
  assert.match(validatePdfProtectPasswords('secret-1', 'secret-2').error, /do not match/);
  assert.deepEqual(validatePdfProtectPasswords('same-pw', 'same-pw'), { ok: true, password: 'same-pw' });
});

// 7. missing password validation
test('protect: missing password is rejected', async () => {
  assert.match(validatePdfProtectPasswords('', '').error, /Enter a password/);
  assert.match(validatePdfProtectPasswords(undefined, undefined).error, /Enter a password/);
  assert.match(validatePdfProtectPasswords(TEST_PW, '').error, /do not match/);
  await assert.rejects(protectPdf(Buffer.from(plainRich()), ''), /Enter a password/);
  assert.equal(validatePdfProtectPasswords('x'.repeat(1025), 'x'.repeat(1025)).ok, false);
});

// 8. original input bytes remain unchanged
test('protect: input bytes are never mutated', async () => {
  const input = plainRich();
  const before = sha256(input);
  const lenBefore = input.length;
  await protectPdf(Buffer.from(input), TEST_PW);
  assert.equal(sha256(input), before);
  assert.equal(input.length, lenBefore);
});

// 9+10. pages/dimensions + full content fidelity via round-trip
test('protect: round-trip preserves pages, dimensions and all content', async () => {
  const input = plainRich();
  const out = Buffer.from(await protectPdf(Buffer.from(input), TEST_PW));
  const toolkit = await createPdfToolkit();
  const back = Buffer.from(await toolkit.unlock(new Uint8Array(out), { password: TEST_PW }));
  const orig = await jsAnalyze(input, undefined);
  const rt = await jsAnalyze(back, undefined);
  assert.equal(rt.numPages, orig.numPages);
  assert.deepEqual(rt.pages.map(p => [p.w, p.h]), [[595, 842], [300, 400]], 'page dimensions preserved');
  assert.ok(orig.pages[0].text.length > 0, 'fixture has extractable text');
  for (const needle of ['Spike Unlock Fidelity Check', 'caf\u00e9', 'CJK', 'Second page content']) {
    assert.ok(rt.pages.some(p => p.text.includes(needle)), `text preserved: ${needle}`);
  }
  assert.deepEqual(rt.pages.map(p => p.text), orig.pages.map(p => p.text), 'extracted text identical');
  assert.ok(orig.pages[0].images > 0, 'fixture contains an image');
  assert.deepEqual(rt.pages.map(p => p.images), orig.pages.map(p => p.images), 'images preserved');
  assert.deepEqual(rt.pages.map(p => p.opFns), orig.pages.map(p => p.opFns), 'vector/content streams identical');
  assert.deepEqual(rt.pages.map(p => p.annots), orig.pages.map(p => p.annots), 'annotations preserved');
  assert.ok(rt.pages[0].annots.includes('Ada Lovelace'), 'form field value preserved');
  const dOrig = await PDFDocument.load(input);
  const dBack = await PDFDocument.load(back);
  assert.equal(dBack.getTitle(), dOrig.getTitle(), 'metadata title preserved');
  assert.equal(dBack.getAuthor(), dOrig.getAuthor(), 'metadata author preserved');
});

// 11. invalid/non-PDF input (incl. already-encrypted files)
test('protect: invalid, non-PDF and already-encrypted input rejected', async () => {
  await assert.rejects(protectPdf(Buffer.from('not a pdf at all'), TEST_PW), /could not be read/);
  await assert.rejects(protectPdf(Buffer.alloc(0), TEST_PW), /empty/);
  await assert.rejects(protectPdf(Buffer.from(alreadyEnc()), TEST_PW), /already password-protected/);
  assert.equal(validatePdfProtectUpload({ name: 'evil.exe', size: 100 }).ok, false);
  assert.match(validatePdfProtectUpload({ name: 'evil.exe', size: 100 }).error, /\.pdf/);
});

// 12. file-size/page limits consistent with the PDF tooling
test('protect: size and page limits match the PDF editor tooling', async () => {
  assert.equal(PDF_PROTECT_MAX_FILE_MB, PDF_EDITOR_MAX_FILE_MB);
  assert.equal(PDF_PROTECT_MAX_PAGES, PDF_EDITOR_MAX_PAGES);
  assert.ok(pdfProtectMaxRequestBytes() > 0);
  assert.equal(validatePdfProtectUpload(null).ok, false);
  assert.equal(validatePdfProtectUpload({ name: 'a.pdf', size: 0 }).ok, false);
  const over = validatePdfProtectUpload({ name: 'a.pdf', size: PDF_PROTECT_MAX_FILE_BYTES + 1 });
  assert.equal(over.ok, false);
  assert.match(over.error, new RegExp(String(PDF_PROTECT_MAX_FILE_MB)));
  const huge = Buffer.alloc(PDF_PROTECT_MAX_FILE_BYTES + 1);
  await assert.rejects(protectPdf(huge, TEST_PW), new RegExp(`exceeds ${PDF_PROTECT_MAX_FILE_MB} MB`));
  const big = await PDFDocument.create();
  const font = await big.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < PDF_PROTECT_MAX_PAGES + 1; i++) {
    big.addPage([200, 200]).drawText('x', { x: 10, y: 10, size: 8, font });
  }
  await assert.rejects(
    protectPdf(Buffer.from(await big.save()), TEST_PW),
    new RegExp(`max ${PDF_PROTECT_MAX_PAGES}`)
  );
});

test('protect: download name is `<original>-protected.pdf` and header-safe', () => {
  assert.equal(protectDownloadName('Report Q3.pdf'), 'Report_Q3-protected.pdf');
  assert.equal(protectDownloadName('../../evil.pdf'), 'evil-protected.pdf');
  assert.equal(protectDownloadName('x'), 'x-protected.pdf');
  assert.equal(protectDownloadName(''), 'document-protected.pdf');
  for (const n of [protectDownloadName('a/b\\c.pdf'), protectDownloadName('q"uote.pdf')]) {
    assert.match(n, /^[A-Za-z0-9._-]+\.pdf$/);
  }
});

// 13. admin-only server wiring (editor, merge and unlock intact)
test('protect: server wires admin-only routes (editor, merge and unlock untouched)', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/protect', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/protect', requireApiAuth, requireAdmin"), 'API route is admin-only');
  assert.ok(SERVER_SRC.includes("from './library/pdf-protect.js'"), 'dedicated pdf-protect library used');
  assert.ok(SERVER_SRC.includes('protectDownloadName'), 'original-based download name used');
  assert.ok(SERVER_SRC.includes('confirmPassword'), 'confirmation validated server-side');
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-editor', requireAuth, requireAdmin"), 'editor page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-editor/export', requireApiAuth, requireAdmin"), 'editor export route intact');
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/merge', requireAuth, requireAdmin"), 'merge page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/merge', requireApiAuth, requireAdmin"), 'merge API route intact');
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-tools/unlock', requireAuth, requireAdmin"), 'unlock page route intact');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-tools/unlock', requireApiAuth, requireAdmin"), 'unlock API route intact');
  assert.ok(!EDITOR_LIB_SRC.includes('protectPdf'), 'editor library has no protect code');
  assert.ok(!MERGE_LIB_SRC.includes('protectPdf'), 'merge library has no protect code');
  assert.ok(!UNLOCK_LIB_SRC.includes('protectPdf'), 'unlock library has no protect code');
  const handler = SERVER_SRC.slice(
    SERVER_SRC.indexOf("app.post('/api/admin/pdf-tools/protect'"),
    SERVER_SRC.indexOf('export { app }')
  );
  assert.ok(!/console\.(log|warn|error|info)/.test(handler), 'protect handler never logs (password cannot leak)');
  assert.ok(!/shell|spawn|execFile|Ghostscript|docker/i.test(handler), 'no shell/binary workflows in the handler');
  const libCode = PROTECT_LIB_SRC.replace(/\/\/.*$/gm, '');
  assert.ok(libCode.includes("from 'pdfstudio'"), 'qpdf-WASM engine used');
  assert.ok(!/child_process|spawn|exec/i.test(libCode), 'no shell in the library');
  assert.ok(!/\.writeFileSync|createWriteStream|mkdtemp|tmpdir/i.test(libCode), 'no temp-file workflows');
});

// 14. production availability gate
test('protect: availability gate mirrors the other PDF utilities', () => {
  assert.equal(isPdfProtectAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfProtectAvailable({}), true);
  assert.equal(isPdfProtectAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfProtectAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
  assert.ok(SERVER_SRC.includes('isPdfProtectAvailable()'), 'production gate enforced');
});

test('protect: admin page renders file + password/confirm UI with progress', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-protect.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfProtectAvailable: true,
    pdfProtectMaxFileMb: 50
  });
  for (const hook of [
    'pdf-protect-root', 'pdf-protect-file', 'pdf-protect-password', 'pdf-protect-confirm',
    'pdf-protect-submit', 'pdf-protect-status', 'pdf-protect-progress', 'pdf-protect-clear',
    'pdf-protect-pick', 'pdf-protect-fileinfo'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="password"/, 'password inputs are masked');
  assert.match(html, /type="module" src="\/admin-pdf-protect\.js(\?v=\d+)?"/, 'client loads as ES module');
  assert.match(html, /data-max-file-mb="50"/, '50 MB cap exposed');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-protect.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfProtectAvailable: false,
    pdfProtectMaxFileMb: 50
  });
  assert.match(disabled, /pdf-protect-disabled/, 'disabled notice when unavailable');
});

test('protect: client posts file+passwords with match check, clears passwords', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-protect.js'), 'utf8');
  assert.ok(src.includes("fetch('/api/admin/pdf-tools/protect'"), 'posts to protect API');
  assert.ok(src.includes("form.append('pdf'"), 'uploads the PDF');
  assert.ok(src.includes("form.append('password'"), 'sends the password');
  assert.ok(src.includes("form.append('confirmPassword'"), 'sends the confirmation');
  assert.ok(src.includes('do not match') || src.includes('Passwords do not match'), 'client-side mismatch check');
  assert.ok(src.includes('clearPasswords'), 'passwords cleared after attempt');
  assert.ok(src.includes('pdfProtectProgress') && src.includes('setProgressVisible'), 'loading/progress state');
  assert.ok(src.includes('GlobalWorkerOptions.workerSrc'), 'vendored pdf.js worker, no CDN');
  assert.ok(!src.includes('console.log'), 'client never logs (password cannot leak)');
});

test('protect: admin nav links the protect tool', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-tools\/protect/, 'nav links the protect tool');
  assert.match(nav, /Protect PDF/, 'nav label present');
});
