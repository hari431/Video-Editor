import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  isPdfEditorAvailable,
  validatePdfEditSpec,
  renderPdfExport,
  displayedToUnrotated,
  isAllowedPdfInput,
  isAllowedPdfImage,
  normalizePdfColor,
  pdfEditorMaxRequestBytes,
  PDF_EDITOR_MAX_FILES,
  PDF_EDITOR_MAX_PAGES,
  PDF_EDITOR_MAX_FILE_MB
} from '../src/library/pdf-editor.js';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));
const SERVER_SRC = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');

// 1x1 transparent PNG (overlay-image fixture, no binary files needed).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function baseSpec(overrides = {}) {
  return {
    version: 1,
    files: [{ name: 'a.pdf' }, { name: 'b.pdf' }],
    images: [],
    pages: [
      { file: 0, page: 0, rotate: 0, markups: [] },
      { file: 1, page: 1, rotate: 90, markups: [] }
    ],
    pageNumbers: null,
    watermark: null,
    ...overrides
  };
}

async function makePdf(pages = [{ w: 595, h: 842 }]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const { w, h } of pages) {
    const page = doc.addPage([w, h]);
    page.drawText('source content', { x: 50, y: h - 50, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

test('pdf editor gate: available locally, disabled in production or via flag', () => {
  assert.equal(isPdfEditorAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isPdfEditorAvailable({}), true);
  assert.equal(isPdfEditorAvailable({ NODE_ENV: 'production' }), false);
  assert.equal(isPdfEditorAvailable({ NODE_ENV: 'development', PDF_EDITOR_ENABLED: 'false' }), false);
  assert.equal(isPdfEditorAvailable({ NODE_ENV: 'production', PDF_EDITOR_ENABLED: 'true' }), false);
});

test('pdf allowlists (.pdf in, exe out; png/jpg images)', () => {
  assert.equal(isAllowedPdfInput('doc.pdf'), true);
  assert.equal(isAllowedPdfInput('doc.PDF'), true);
  assert.equal(isAllowedPdfInput('doc.exe'), false);
  assert.equal(isAllowedPdfInput('doc.docx'), false);
  assert.equal(isAllowedPdfInput('noext'), false);
  assert.equal(isAllowedPdfImage('a.png'), true);
  assert.equal(isAllowedPdfImage('a.jpg'), true);
  assert.equal(isAllowedPdfImage('a.jpeg'), true);
  assert.equal(isAllowedPdfImage('a.webp'), false);
  assert.equal(isAllowedPdfImage('a.pdf'), false);
  assert.equal(normalizePdfColor('#fff'), '#FFFFFF');
  assert.equal(normalizePdfColor('red'), null);
  assert.ok(pdfEditorMaxRequestBytes() > 0);
});

test('validatePdfEditSpec: accepts a full spec and normalizes colors', () => {
  const r = validatePdfEditSpec(baseSpec({
    pages: [
      {
        file: 0, page: 0, rotate: 0,
        markups: [
          { kind: 'text', text: 'Hello', x: 0.1, y: 0.1, size: 0.04, color: '#fff', align: 'left', opacity: 1 },
          { kind: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.1, fill: '#ffffff', fillOpacity: 1, stroke: null, strokeWidth: 0 },
          { kind: 'path', points: [[0, 0], [0.5, 0.5]], stroke: '#0000ff', strokeWidth: 2, opacity: 1 }
        ]
      }
    ],
    pageNumbers: { start: 1, position: 'bottom-center', margin: 0.04, fontSize: 11, color: '#000' },
    watermark: { text: 'DRAFT', fontSize: 64, color: '#888', opacity: 0.25, angle: -45 }
  }));
  assert.equal(r.ok, true);
  assert.equal(r.spec.pages[0].markups[0].color, '#FFFFFF');
  assert.equal(r.spec.pageNumbers.position, 'bottom-center');
  assert.equal(r.spec.watermark.text, 'DRAFT');
});

test('validatePdfEditSpec: rejects bad refs, geometry, caps', () => {
  assert.match(validatePdfEditSpec(null).error, /Invalid/);
  assert.match(validatePdfEditSpec({ ...baseSpec(), version: 9 }).error, /version/);
  assert.match(validatePdfEditSpec(baseSpec({ files: [] })).error, /1–/);
  assert.match(validatePdfEditSpec(baseSpec({ pages: [] })).error, /1–/);
  assert.match(validatePdfEditSpec(baseSpec({ pages: [{ file: 5, page: 0, rotate: 0, markups: [] }] })).error, /file/);
  assert.match(validatePdfEditSpec(baseSpec({ pages: [{ file: 0, page: 0, rotate: 45, markups: [] }] })).error, /rotate/);
  assert.match(
    validatePdfEditSpec(baseSpec({ pages: [{ file: 0, page: 0, rotate: 0, markups: [{ kind: 'text' }] }] })).error,
    /text/
  );
  assert.match(
    validatePdfEditSpec(baseSpec({ pages: [{ file: 0, page: 0, rotate: 0, markups: [{ kind: 'image', x: 0, y: 0, w: 0.2, file: 3 }] }] })).error,
    /image/
  );
  const many = Array.from({ length: PDF_EDITOR_MAX_PAGES + 1 }, (_, i) => ({ file: 0, page: 0, rotate: 0, markups: [] }));
  assert.match(validatePdfEditSpec(baseSpec({ pages: many })).error, /1–500/);
  assert.match(
    validatePdfEditSpec(baseSpec({
      pages: [{
        file: 0, page: 0, rotate: 0,
        markups: [{ kind: 'rect', x: 0, y: 0, w: 0.1, h: 0.1, fill: null, stroke: null, fillOpacity: 1, strokeWidth: 0 }]
      }]
    })).error,
    /fill and\/or a stroke/
  );
  assert.match(
    validatePdfEditSpec(baseSpec({ watermark: { text: 'a\nb' } })).error, /single line/
  );
  assert.match(validatePdfEditSpec(baseSpec({ pageNumbers: { position: 'middle' } })).error, /position/);
  assert.match(
    validatePdfEditSpec(baseSpec({
      pages: [{
        file: 0, page: 0, rotate: 0, markups: [],
        edits: [{ box: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, text: '', font: 'Helvetica' }]
      }]
    })).error,
    /single line/
  );
  assert.match(
    validatePdfEditSpec(baseSpec({
      pages: [{
        file: 0, page: 0, rotate: 0, markups: [],
        edits: [{ box: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, text: 'valid', font: 'UnknownFont' }]
      }]
    })).error,
    /Helvetica, TimesRoman or Courier/
  );
  void PDF_EDITOR_MAX_FILES;
});

test('displayedToUnrotated inverts the viewer rotation', () => {
  assert.deepEqual(displayedToUnrotated(0.2, 0.3, 0), [0.2, 0.3]);
  assert.deepEqual(displayedToUnrotated(0.2, 0.3, 90), [0.7, 0.2]);
  assert.deepEqual(displayedToUnrotated(0.2, 0.3, 180), [0.8, 0.7]);
  assert.deepEqual(displayedToUnrotated(0.2, 0.3, 270), [0.3, 0.8]);
  // Round-trip: mapping twice returns the start point.
  for (const r of [90, 180, 270]) {
    const [ux, uy] = displayedToUnrotated(0.25, 0.6, r);
    const back = displayedToUnrotated(ux, uy, (360 - r) % 360);
    assert.deepEqual(back, [0.25, 0.6]);
  }
});

test('renderPdfExport: merge + rotate + markups + numbers + watermark round-trip', async () => {
  const a = await makePdf([{ w: 595, h: 842 }]);
  const b = await makePdf([{ w: 300, h: 300 }, { w: 400, h: 600 }]);
  const spec = baseSpec({
    images: [{ name: 'dot.png' }],
    pages: [
      {
        file: 1, page: 1, rotate: 0,
        markups: [
          { kind: 'text', text: 'Hello', x: 0.1, y: 0.1, size: 0.05, color: '#FF0000', align: 'left', opacity: 1 },
          { kind: 'rect', x: 0.2, y: 0.2, w: 0.3, h: 0.1, fill: '#FFFFFF', fillOpacity: 1, stroke: null, strokeWidth: 0 },
          { kind: 'rect', x: 0.2, y: 0.4, w: 0.3, h: 0.05, fill: '#FFFF00', fillOpacity: 0.35, stroke: null, strokeWidth: 0 },
          { kind: 'ellipse', x: 0.5, y: 0.5, w: 0.2, h: 0.1, fill: null, fillOpacity: 1, stroke: '#0000FF', strokeWidth: 2 },
          { kind: 'line', x1: 0, y1: 0, x2: 0.5, y2: 0.5, stroke: '#000000', strokeWidth: 2, opacity: 1 },
          { kind: 'path', points: [[0.1, 0.1], [0.2, 0.3], [0.4, 0.4]], stroke: '#00FF00', strokeWidth: 2, opacity: 1 },
          { kind: 'image', x: 0.6, y: 0.6, w: 0.2, file: 0, opacity: 1 }
        ],
        edits: [
          { box: { x: 0.1, y: 0.05, w: 0.4, h: 0.04 }, text: 'Replaced Title', font: 'TimesRoman', bold: true, italic: false, size: 0.035, color: '#0000FF', align: 'left', bg: '#FFFFFF', fitScale: 1 }
        ]
      },
      { file: 0, page: 0, rotate: 90, markups: [] }
    ],
    pageNumbers: { start: 7, position: 'bottom-right', margin: 0.04, fontSize: 11, color: '#000000' },
    watermark: { text: 'DRAFT', fontSize: 48, color: '#888888', opacity: 0.25, angle: -45 }
  });
  // Route flow: validate first, then render from the NORMALIZED spec
  // (must retain the images binding).
  const checked = validatePdfEditSpec(spec);
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.spec.images, [{ name: 'dot.png' }]);
  const out = await renderPdfExport({ pdfBytesList: [a, b], imageBytesList: [TINY_PNG], spec: checked.spec });
  assert.ok(out.length > 1000, 'non-trivial output');
  assert.equal(Buffer.from(out.slice(0, 5)).toString('latin1'), '%PDF-', 'valid PDF header');
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 2);
  // Page order follows the spec (b p2 first, a p1 second), sizes preserved.
  assert.deepEqual([doc.getPage(0).getSize().width, doc.getPage(0).getSize().height], [400, 600]);
  assert.deepEqual([doc.getPage(1).getSize().width, doc.getPage(1).getSize().height], [595, 842]);
  assert.equal(doc.getPage(1).getRotation().angle, 90);
  // Inputs untouched: sources still load with original page counts.
  assert.equal((await PDFDocument.load(a)).getPageCount(), 1);
  assert.equal((await PDFDocument.load(b)).getPageCount(), 2);
});

test('renderPdfExport: rejects mismatched files, bad refs, bad images', async () => {
  const a = await makePdf();
  await assert.rejects(
    renderPdfExport({ pdfBytesList: [a], imageBytesList: [], spec: baseSpec() }),
    /do not match/
  );
  const b = await makePdf();
  await assert.rejects(
    renderPdfExport({
      pdfBytesList: [a, b],
      imageBytesList: [],
      spec: baseSpec({ pages: [{ file: 0, page: 9, rotate: 0, markups: [] }] })
    }),
    /only 1 pages/
  );
  await assert.rejects(
    renderPdfExport({ pdfBytesList: [Buffer.from('not a pdf'), b], imageBytesList: [], spec: baseSpec() }),
    /could not be read/
  );
  await assert.rejects(
    renderPdfExport({
      pdfBytesList: [a, b],
      imageBytesList: [Buffer.from('not an image')],
      spec: baseSpec({
        images: [{ name: 'x.bin' }],
        pages: [{ file: 0, page: 0, rotate: 0, markups: [{ kind: 'image', x: 0, y: 0, w: 0.2, file: 0, opacity: 1 }] }]
      })
    }),
    /PNG or JPG/
  );
  await assert.rejects(
    renderPdfExport({ pdfBytesList: [a, b], imageBytesList: [], spec: { version: 1 } }),
    /files/
  );
});

test('pdf editor page renders the editing UI', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfEditorAvailable: true
  });
  for (const hook of [
    'pdf-editor-root', 'pdf-editor-file', 'pdf-editor-image', 'pdf-editor-canvas',
    'pdf-editor-overlay', 'pdf-editor-page-list', 'pdf-editor-inspector',
    'pdf-editor-export', 'pdf-editor-tool-text', 'pdf-editor-tool-pen',
    'pdf-editor-tool-highlight', 'pdf-editor-tool-whiteout', 'pdf-editor-tool-select'
  ]) {
    assert.match(html, new RegExp(hook), `hook present: ${hook}`);
  }
  assert.match(html, /type="module" src="\/admin-pdf-editor\.js(\?v=\d+)?"/, 'client loads as ES module');
  assert.match(html, /pdf-editor-project/, 'project model module referenced');
  assert.match(html, /data-max-file-mb="50"/, 'default 50 MB cap exposed');
  const disabled = await ejs.renderFile(path.join(VIEWS_DIR, 'admin-pdf-editor.ejs'), {
    user: { name: 'Owner', email: 'owner@example.com', app_role: 'OWNER' },
    pdfEditorAvailable: false
  });
  assert.match(disabled, /pdf-editor-disabled/, 'disabled notice when unavailable');
});

test('admin nav links the PDF editor; item page shows Edit PDF to admins only', async () => {
  const nav = await ejs.renderFile(path.join(VIEWS_DIR, 'partials', 'admin-nav.ejs'), { currentUrl: '/admin' });
  assert.match(nav, /\/admin\/pdf-editor/, 'nav links the PDF editor');
  assert.match(nav, /Local PDF Editor/, 'nav label present');

  const itemLocals = overrides => ({
    user: { name: 'Owner', email: 'o@x.com', app_role: 'OWNER' },
    itemPath: 'Guidewire/x/doc.pdf',
    fileName: 'doc.pdf',
    prettyTitle: n => n,
    categoryForPath: () => 'Guidewire',
    typeLabel: 'PDF',
    sizeText: '1 KB',
    type: 'pdf',
    viewable: true,
    canRenderInBrowser: true,
    fileHref: '/file/Guidewire/x/doc.pdf',
    downloadHref: '/download/Guidewire/x/doc.pdf',
    showDownloadButton: true,
    discussions: [],
    relatedItems: [],
    likeCount: 0,
    liked: false,
    hasNotes: false,
    userNote: null,
    pinnedRefs: [],
    pinGen: null,
    ...overrides
  });
  const adminHtml = await ejs.renderFile(path.join(VIEWS_DIR, 'item.ejs'), itemLocals({}));
  assert.match(adminHtml, /data-testid="edit-pdf-link"/, 'admin sees Edit PDF');
  assert.ok(adminHtml.includes('href="/admin/pdf-editor?path=Guidewire%2Fx%2Fdoc.pdf"'), 'link carries encoded path');
  assert.match(adminHtml, /<iframe/, 'preview iframe unchanged');
  const userHtml = await ejs.renderFile(path.join(VIEWS_DIR, 'item.ejs'), itemLocals({
    user: { name: 'U', email: 'u@x.com', app_role: 'USER' }
  }));
  assert.doesNotMatch(userHtml, /edit-pdf-link/, 'no Edit PDF for normal users');
  const imgHtml = await ejs.renderFile(path.join(VIEWS_DIR, 'item.ejs'), itemLocals({ type: 'image' }));
  assert.doesNotMatch(imgHtml, /edit-pdf-link/, 'no Edit PDF for non-PDF types');
});

test('pdf editor preview controls are wired (thumbnails, zoom, page navigation)', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-editor.js'), 'utf8');
  // Main canvas + thumbnail strip both render through pdf.js.
  assert.equal(src.split('pdfPage.render({ canvasContext:').length - 1, 2, 'main + thumbnail renders');
  assert.ok(src.includes('getViewport({ scale:'), 'viewport-scaled rendering');
  assert.ok(src.includes("stepPage(-1)") && src.includes("stepPage(1)"), 'prev/next navigation');
  assert.ok(src.includes('zoom = Math.min(3') && src.includes('zoom = Math.max(0.4'), 'zoom clamps');
  assert.ok(src.includes("pdfjsLib.getDocument({ data:"), 'sources load from local bytes');
  assert.ok(src.includes("GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs'"), 'vendored worker, no CDN');
});

test('pdf editor canvas repaints live during drags (no stale overlay, no ghost smearing)', () => {
  const src = readFileSync(path.join(PUBLIC_DIR, 'admin-pdf-editor.js'), 'utf8');
  assert.ok(src.includes('function paintOverlay()'), 'unconditional repaint exists');
  const drawDef = src.slice(src.indexOf('function drawOverlay()'), src.indexOf('function paintOverlay()'));
  assert.ok(drawDef.includes("drag.kind === 'gesture'"), 'guarded entry keeps frozen mid-gesture');
  assert.ok(drawDef.includes('paintOverlay()'), 'guarded entry delegates to the repaint');
  const moveIdx = src.indexOf("drag.mode === 'move'");
  const moveBlock = src.slice(moveIdx, src.indexOf("if (drag.mode === 'draw')"));
  assert.ok(moveBlock.includes('paintOverlay()'), 'move/resize repaints live');
  assert.ok(!moveBlock.includes('drawOverlay()'), 'move/resize never uses the frozen path');
  const drawIdx = src.indexOf("if (drag.mode === 'draw')");
  const drawBlock = src.slice(drawIdx, src.indexOf('function onOverlayUp'));
  const paintPos = drawBlock.indexOf('paintOverlay()');
  const ghostPos = drawBlock.indexOf('drawMarkupShape(ctx, ghost');
  assert.ok(paintPos !== -1 && ghostPos !== -1 && paintPos < ghostPos, 'ghost draws on a fresh repaint');
});

test('server wires admin-only PDF routes with a production gate (isolated from video editor)', () => {
  assert.ok(SERVER_SRC.includes("app.get('/admin/pdf-editor', requireAuth, requireAdmin"), 'page route is admin-only');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/pdf-editor/export', requireApiAuth, requireAdmin"), 'export route is admin-only');
  assert.ok(SERVER_SRC.includes('isPdfEditorAvailable()'), 'production gate enforced');
  assert.ok(SERVER_SRC.includes("from './library/pdf-editor.js'"), 'dedicated pdf-editor library used');
  assert.ok(!/pdf-lib|PDFDocument/.test(SERVER_SRC.match(/from '\.\/library\/video-editor\.js'[^;]*;/)?.[0] || ''), 'video editor untouched by pdf imports');
  assert.match(SERVER_SRC, /pdfEditorMaxRequestBytes/, 'upload caps enforced');
  assert.match(SERVER_SRC, /X-Export-Filename/, 'download streamed with filename header');
  void PDF_EDITOR_MAX_FILE_MB;
});
